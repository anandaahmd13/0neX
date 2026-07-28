import { spawn } from 'node:child_process'

const CLAUDE_COMMAND = process.env.CLAUDE_CLI_COMMAND ?? 'claude'
const RUN_TIMEOUT_MS = Number(process.env.GATEWAY_RUN_TIMEOUT_MS ?? process.env.CLAUDE_RUN_TIMEOUT_MS ?? 120_000)
const KILL_GRACE_MS = Number(process.env.GATEWAY_KILL_GRACE_MS ?? process.env.CLAUDE_KILL_GRACE_MS ?? 3_000)
const BASE_ARGS = ['--output-format', 'stream-json', '--verbose']

function terminateTree(child, signal) {
  if (!child?.pid) return

  if (process.platform === 'win32') {
    // Windows tidak meneruskan signal ke descendants. taskkill /T /F menjamin
    // tool process yang diluncurkan Claude ikut berhenti.
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {})
      killer.unref()
    } catch {
      child.kill('SIGTERM')
    }
    return
  }

  try {
    // Provider di-spawn sebagai process-group leader pada POSIX.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Proses sudah berhenti.
    }
  }
}

function killChild(child) {
  if (!child?.pid) return
  terminateTree(child, 'SIGTERM')
  if (process.platform === 'win32') return

  const timer = setTimeout(() => terminateTree(child, 'SIGKILL'), KILL_GRACE_MS)
  timer.unref?.()
}

function extractText(event) {
  if (event == null || event.type === 'result') return ''
  if (event.type === 'system') {
    if (event.subtype === 'thinking_tokens') return ''
    return `system: ${event.subtype ?? ''}`.trim()
  }

  const content = event.message?.content ?? event.content
  if (!Array.isArray(content)) return JSON.stringify(event)

  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push(`[thinking] ${block.thinking}`)
    } else if (block?.type === 'tool_use') {
      const input = block.input ? ` ${JSON.stringify(block.input)}` : ''
      parts.push(`tool_use: ${block.name ?? '?'}${input}`)
    } else if (block?.type === 'tool_result') {
      const result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
      parts.push(`tool_result: ${result}`)
    }
  }
  return parts.join('\n')
}

function extractUsage(event) {
  const raw = event?.usage ?? event?.result?.usage
  if (!raw || typeof raw !== 'object') return null
  const inputTokens = Number(raw.input_tokens ?? raw.inputTokens ?? 0)
  const outputTokens = Number(raw.output_tokens ?? raw.outputTokens ?? 0)
  const cacheReadTokens = Number(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? 0)
  const cacheWriteTokens = Number(raw.cache_creation_input_tokens ?? raw.cacheWriteInputTokens ?? 0)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

function providerArgs(request, resume) {
  const mode = resume ? ['--resume', request.sessionId] : ['--session-id', request.sessionId]
  const args = ['-p', request.prompt, ...mode, ...BASE_ARGS]
  if (request.model) args.push('--model', request.model)
  if (request.systemPrompt) args.push('--append-system-prompt', request.systemPrompt)
  if (request.toolPolicy === 'none') args.push('--tools', '')
  if (request.toolPolicy === 'read-only') args.push('--permission-mode', 'plan')
  return args
}

export const claudeCliProvider = {
  id: 'claude-cli',
  label: 'Claude Code CLI',
  capabilities: {
    streaming: true,
    sessions: true,
    cancellation: true,
    tools: true,
  },

  start(request, handlers) {
    let child = null
    let runTimer = null
    let stopped = false
    let cancelled = false
    let timedOut = false
    let usage = null

    function clearAttempt() {
      if (runTimer) clearTimeout(runTimer)
      runTimer = null
      child = null
    }

    function startAttempt(resume, attempt) {
      if (stopped) return
      let emitted = false
      let healTo = null
      let stdoutBuffer = ''
      let stderrBuffer = ''

      try {
        child = spawn(CLAUDE_COMMAND, providerArgs(request, resume), {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          // Detached membuat process group terpisah pada POSIX, sehingga
          // cancel/timeout bisa menghentikan CLI beserta seluruh tool child.
          detached: process.platform !== 'win32',
          windowsHide: true,
        })
      } catch (error) {
        stopped = true
        clearAttempt()
        // Provider.start() harus sempat mengembalikan controller sebelum
        // callback terminal mengosongkan activeRun di gateway server.
        queueMicrotask(() => handlers.onError(`Gagal menjalankan Claude CLI: ${error.message}`))
        return
      }

      function detectHeal(line) {
        if (attempt >= 1 || emitted) return false
        if (resume && line.includes('No conversation found with session ID')) {
          healTo = false
          return true
        }
        if (!resume && line.includes('is already in use')) {
          healTo = true
          return true
        }
        return false
      }

      function emitLine(line) {
        if (stopped) return
        const trimmed = line.trim()
        if (!trimmed || detectHeal(trimmed)) return
        try {
          const event = JSON.parse(trimmed)
          usage = extractUsage(event) ?? usage
          const text = extractText(event)
          if (text) {
            emitted = true
            handlers.onChunk(text)
          }
        } catch {
          emitted = true
          handlers.onChunk(line)
        }
      }

      function emitErrorLine(line) {
        if (stopped || !line.trim() || detectHeal(line)) return
        handlers.onChunk(line, 'error')
      }

      runTimer = setTimeout(() => {
        timedOut = true
        handlers.onChunk(`Run timeout (${Math.round(RUN_TIMEOUT_MS / 1000)}s) - proses dihentikan`, 'error')
        killChild(child)
      }, RUN_TIMEOUT_MS)
      runTimer.unref?.()

      child.once('error', (error) => {
        if (stopped) return
        stopped = true
        clearAttempt()
        handlers.onError(
          error?.code === 'ENOENT'
            ? 'Claude CLI tidak ditemukan. Pastikan perintah `claude` tersedia di PATH.'
            : `Gagal menjalankan Claude CLI: ${error.message}`,
        )
      })

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (data) => {
        stdoutBuffer += data
        let newline
        while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
          emitLine(stdoutBuffer.slice(0, newline))
          stdoutBuffer = stdoutBuffer.slice(newline + 1)
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (data) => {
        stderrBuffer += data
        let newline
        while ((newline = stderrBuffer.indexOf('\n')) !== -1) {
          emitErrorLine(stderrBuffer.slice(0, newline))
          stderrBuffer = stderrBuffer.slice(newline + 1)
        }
      })

      child.once('close', (code) => {
        if (stopped) return
        if (stdoutBuffer.trim()) emitLine(stdoutBuffer)
        if (stderrBuffer.trim()) emitErrorLine(stderrBuffer)
        clearAttempt()

        if (healTo !== null && attempt < 1 && !cancelled && !timedOut) {
          handlers.onChunk(
            healTo
              ? 'Sesi sudah ada - menyambungkan konteks lama'
              : 'Sesi lama tidak ditemukan - memulai konteks baru',
          )
          startAttempt(healTo, attempt + 1)
          return
        }

        stopped = true
        handlers.onDone({
          code,
          sessionId: request.sessionId,
          usage,
          reason: cancelled ? 'cancelled' : timedOut ? 'timeout' : code === 0 ? 'completed' : 'failed',
        })
      })
    }

    startAttempt(request.resume, 0)

    return {
      cancel() {
        if (stopped || cancelled) return
        cancelled = true
        handlers.onChunk('Dibatalkan oleh user')
        killChild(child)
      },
      dispose() {
        if (stopped) return
        stopped = true
        killChild(child)
        clearAttempt()
      },
    }
  },
}

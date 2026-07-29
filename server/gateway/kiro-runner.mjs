import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { AcpTransportError, createNdjsonRpcTransport } from './kiro-transport.mjs'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_KILL_GRACE_MS = 3_000
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000
const CLIENT_INFO = { name: '0nex-gateway', title: '0neX Gateway', version: '1.0.0' }

export class KiroRunnerError extends Error {
  constructor(message, { code = 'KIRO_RUNNER_ERROR', cause } = {}) {
    super(message, { cause })
    this.name = 'KiroRunnerError'
    this.code = code
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function authType(auth) {
  const type = auth?.type ?? auth?.mode ?? 'account-session'
  if (type !== 'account-session' && type !== 'api-key') {
    throw new KiroRunnerError(`Unsupported Kiro auth type: ${String(type)}`, {
      code: 'KIRO_INVALID_AUTH',
    })
  }
  return type
}

function authSecret(auth) {
  return auth?.secret ?? auth?.apiKey
}

function sanitizeText(value, secrets = []) {
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  let text = String(value ?? '').replaceAll(ansiColor, '')
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(String(secret), '[redacted]')
  }
  text = text.replaceAll(/(KIRO_API_KEY\s*[=:]\s*)\S+/gi, '$1[redacted]')
  return text.trim().slice(0, 1_000)
}

function mapSpawnError(error, executable) {
  if (error?.code === 'ENOENT') {
    return new KiroRunnerError(
      `Kiro CLI tidak ditemukan. Pastikan executable ${JSON.stringify(executable)} tersedia.`,
      { code: 'KIRO_CLI_NOT_FOUND', cause: error },
    )
  }
  return new KiroRunnerError('Gagal menjalankan Kiro CLI.', {
    code: 'KIRO_SPAWN_FAILED',
    cause: error,
  })
}

function terminateChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill(signal)
  } catch {
    // Process already exited.
  }
}

function parseJsonOutput(stdout, operation) {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new KiroRunnerError(`Kiro CLI ${operation} tidak mengembalikan JSON.`, {
      code: 'KIRO_MALFORMED_OUTPUT',
    })
  }
  try {
    return JSON.parse(trimmed)
  } catch (cause) {
    throw new KiroRunnerError(`Kiro CLI ${operation} mengembalikan JSON yang tidak valid.`, {
      code: 'KIRO_MALFORMED_OUTPUT',
      cause,
    })
  }
}

function collectModelIds(value, ids, seen = new Set()) {
  if (typeof value === 'string') {
    const id = value.trim()
    if (id) ids.add(id)
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) collectModelIds(item, ids, seen)
    return
  }

  const explicitId = value.id ?? value.modelId ?? value.model_id
  if (typeof explicitId === 'string' && explicitId.trim()) ids.add(explicitId.trim())

  // Only traverse known model-list containers. Object keys and display names
  // are never treated as model IDs, avoiding fabricated IDs.
  for (const key of ['models', 'data', 'items', 'availableModels', 'available_models']) {
    if (Object.hasOwn(value, key)) collectModelIds(value[key], ids, seen)
  }
}

export function parseKiroModelList(value) {
  const ids = new Set()
  collectModelIds(value, ids)
  return [...ids]
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!content || typeof content !== 'object') return ''
  if (content.type === 'text' && typeof content.text === 'string') return content.text
  if (typeof content.text === 'string') return content.text
  if (Array.isArray(content)) return content.map(contentText).join('')
  return ''
}

function updateKind(update) {
  return String(update?.sessionUpdate ?? update?.type ?? '').replaceAll(/[_-]/g, '').toLowerCase()
}

function composePrompt(prompt, systemPrompt) {
  if (!systemPrompt) return String(prompt ?? '')
  // ACP v1 exposes user content but no system-role content. Preserve the
  // caller's instruction separately and explicitly instead of putting it in
  // process arguments (where prompts may leak through process listings).
  return `<system-instructions>\n${systemPrompt}\n</system-instructions>\n\n${String(prompt ?? '')}`
}

function permissionDenial(params) {
  const options = Array.isArray(params?.options) ? params.options : []
  const reject = options.find((option) => option?.kind === 'reject_always')
    ?? options.find((option) => option?.kind === 'reject_once')
  return reject
    ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

export function createKiroRunner(options = {}) {
  const spawnFn = options.spawn ?? nodeSpawn
  const inheritedEnv = { ...(options.env ?? process.env) }
  const executable = options.executable ?? inheritedEnv.KIRO_CLI_COMMAND ?? 'kiro-cli'
  const dataDir = resolve(options.dataDir ?? inheritedEnv.GATEWAY_DATA_DIR ?? '.data/gateway')
  const timeoutMs = positiveNumber(
    options.timeoutMs ?? inheritedEnv.GATEWAY_RUN_TIMEOUT_MS ?? inheritedEnv.KIRO_RUN_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  )
  const killGraceMs = positiveNumber(
    options.killGraceMs ?? inheritedEnv.GATEWAY_KILL_GRACE_MS ?? inheritedEnv.KIRO_KILL_GRACE_MS,
    DEFAULT_KILL_GRACE_MS,
  )
  const maxOutputBytes = positiveNumber(
    options.maxOutputBytes ?? inheritedEnv.GATEWAY_MAX_OUTPUT_BYTES ?? inheritedEnv.KIRO_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
  )

  async function environmentFor(auth = { type: 'account-session' }) {
    const type = authType(auth)
    const env = { ...inheritedEnv }
    delete env.KIRO_CLI_COMMAND

    if (type === 'account-session') {
      // Make the requested auth context deterministic if the gateway itself
      // happens to run with an API key in its environment.
      delete env.KIRO_API_KEY
      return env
    }

    const secret = authSecret(auth)
    if (typeof secret !== 'string' || !secret.trim()) {
      throw new KiroRunnerError('Kiro API-key auth membutuhkan secret.', {
        code: 'KIRO_API_KEY_REQUIRED',
      })
    }

    // Kiro prefers an active browser session over KIRO_API_KEY. A private HOME
    // prevents global ~/.kiro state from overriding the explicit connection.
    const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 24)
    const home = join(dataDir, 'kiro', 'api-key', fingerprint)
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(join(home, '.config'), { recursive: true, mode: 0o700 }),
      mkdir(join(home, '.local', 'share'), { recursive: true, mode: 0o700 }),
      mkdir(join(home, '.local', 'state'), { recursive: true, mode: 0o700 }),
      mkdir(join(home, '.cache'), { recursive: true, mode: 0o700 }),
    ])
    env.HOME = home
    env.USERPROFILE = home
    env.XDG_CONFIG_HOME = join(home, '.config')
    env.XDG_DATA_HOME = join(home, '.local', 'share')
    env.XDG_STATE_HOME = join(home, '.local', 'state')
    env.XDG_CACHE_HOME = join(home, '.cache')
    env.KIRO_API_KEY = secret
    return env
  }

  async function runCommand(args, { auth, cwd, operation }) {
    const env = await environmentFor(auth)
    const secrets = [authSecret(auth)]
    return new Promise((resolvePromise, rejectPromise) => {
      let child
      let stdout = ''
      let stderr = ''
      let outputBytes = 0
      let settled = false
      let timedOut = false
      let timer = null

      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (error) rejectPromise(error)
        else resolvePromise(value)
      }

      try {
        child = spawnFn(executable, args, {
          cwd: cwd ? resolve(cwd) : undefined,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        })
      } catch (error) {
        finish(mapSpawnError(error, executable))
        return
      }

      const terminateWithFallback = () => {
        terminateChild(child, 'SIGTERM')
        const killer = setTimeout(() => terminateChild(child, 'SIGKILL'), killGraceMs)
        killer.unref?.()
      }

      timer = setTimeout(() => {
        timedOut = true
        terminateWithFallback()
      }, timeoutMs)
      timer.unref?.()

      child.once('error', (error) => finish(mapSpawnError(error, executable)))
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')

      const consume = (target, chunk) => {
        outputBytes += Buffer.byteLength(chunk)
        if (outputBytes > maxOutputBytes) {
          terminateWithFallback()
          finish(new KiroRunnerError(`Kiro CLI output melebihi batas ${maxOutputBytes} byte.`, {
            code: 'KIRO_MAX_OUTPUT',
          }))
          return target
        }
        return target + chunk
      }
      child.stdout.on('data', (chunk) => { stdout = consume(stdout, chunk) })
      child.stderr.on('data', (chunk) => { stderr = consume(stderr, chunk) })
      child.once('close', (code) => {
        if (timedOut) {
          finish(new KiroRunnerError(`Kiro CLI ${operation} timeout setelah ${timeoutMs}ms.`, {
            code: 'KIRO_TIMEOUT',
          }))
          return
        }
        if (settled) return
        if (code !== 0) {
          const detail = sanitizeText(stderr, secrets)
          finish(new KiroRunnerError(
            `Kiro CLI ${operation} gagal${detail ? `: ${detail}` : ` (exit ${code})`}.`,
            { code: 'KIRO_COMMAND_FAILED' },
          ))
          return
        }
        finish(null, stdout)
      })
    })
  }

  async function whoami({ auth = { type: 'account-session' }, cwd } = {}) {
    const stdout = await runCommand(['whoami', '--format', 'json'], { auth, cwd, operation: 'whoami' })
    return parseJsonOutput(stdout, 'whoami')
  }

  async function checkAuth(options = {}) {
    try {
      const identity = await whoami(options)
      return { authenticated: true, identity }
    } catch (error) {
      if (error?.code === 'KIRO_COMMAND_FAILED') {
        return { authenticated: false, identity: null, error: error.message }
      }
      throw error
    }
  }

  async function listModels({ auth = { type: 'account-session' }, cwd } = {}) {
    const stdout = await runCommand(
      ['chat', '--list-models', '--format', 'json'],
      { auth, cwd, operation: 'model listing' },
    )
    return parseKiroModelList(parseJsonOutput(stdout, 'model listing'))
  }

  function startHeadless(request, handlers = {}) {
    const onChunk = handlers.onChunk ?? (() => {})
    const onDone = handlers.onDone ?? (() => {})
    const onError = handlers.onError ?? (() => {})
    let child = null
    let terminal = false
    let cancelled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let runTimer = null
    let killTimer = null
    let resolveDone
    const done = new Promise((resolvePromise) => { resolveDone = resolvePromise })

    const clearRunTimer = () => {
      if (runTimer) clearTimeout(runTimer)
      runTimer = null
    }

    const terminateWithFallback = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      terminateChild(child, 'SIGTERM')
      killTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), killGraceMs)
      killTimer.unref?.()
    }

    const finish = (reason, error = null) => {
      if (terminal) return
      terminal = true
      clearRunTimer()
      const safeError = error
        ? new KiroRunnerError(
            sanitizeText(error.message, [authSecret(request?.auth)]) || 'Kiro headless gagal.',
            { code: error.code, cause: error },
          )
        : null
      const payload = {
        sessionId: null,
        reason,
        stopReason: reason === 'completed' ? 'end_turn' : null,
        ...(safeError ? { error: safeError } : {}),
      }
      if (reason === 'completed') {
        const text = stdout.trim()
        if (text) onChunk(text)
        onDone(payload)
      } else if (reason === 'cancelled' || reason === 'disposed') {
        onDone(payload)
      } else {
        onError(safeError?.message ?? 'Kiro headless gagal.', safeError)
      }
      resolveDone(payload)
    }

    const launch = async () => {
      try {
        if (!request || typeof request !== 'object' || typeof request.prompt !== 'string' || !request.prompt.trim()) {
          throw new KiroRunnerError('Kiro headless membutuhkan prompt.', { code: 'KIRO_INVALID_REQUEST' })
        }
        if (authType(request.auth) !== 'api-key') {
          throw new KiroRunnerError('Kiro headless membutuhkan API key.', {
            code: 'KIRO_API_KEY_REQUIRED',
          })
        }
        const cwd = resolve(
          request.cwd ?? options.headlessCwd ?? join(dataDir, 'kiro', 'headless'),
        )
        await mkdir(cwd, { recursive: true, mode: 0o700 })
        const env = await environmentFor(request.auth)
        if (terminal) return

        child = spawnFn(executable, [
          'chat',
          '--no-interactive',
          'Jawab permintaan pada standard input. Jangan gunakan tool.',
        ], {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        })
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdin.on('error', (error) => {
          if (!terminal) finish('failed', new KiroRunnerError('Kiro headless stdin tertutup.', {
            code: 'KIRO_HEADLESS_STDIN_CLOSED',
            cause: error,
          }))
        })
        child.once('error', (error) => {
          if (!terminal) finish('failed', mapSpawnError(error, executable))
        })

        const consume = (target, chunk) => {
          outputBytes += Buffer.byteLength(chunk)
          if (outputBytes > maxOutputBytes) {
            terminateWithFallback()
            finish('failed', new KiroRunnerError(`Kiro CLI output melebihi batas ${maxOutputBytes} byte.`, {
              code: 'KIRO_MAX_OUTPUT',
            }))
            return target
          }
          return target + chunk
        }
        child.stdout.on('data', (chunk) => { stdout = consume(stdout, chunk) })
        child.stderr.on('data', (chunk) => { stderr = consume(stderr, chunk) })
        child.once('close', (code) => {
          if (terminal) return
          if (cancelled) {
            finish('cancelled')
            return
          }
          if (timedOut) {
            finish('timeout', new KiroRunnerError(`Kiro headless timeout setelah ${timeoutMs}ms.`, {
              code: 'KIRO_TIMEOUT',
            }))
            return
          }
          if (code !== 0) {
            const detail = sanitizeText(stderr, [authSecret(request.auth)])
            finish('failed', new KiroRunnerError(
              `Kiro headless gagal${detail ? `: ${detail}` : ` (exit ${code})`}.`,
              { code: 'KIRO_COMMAND_FAILED' },
            ))
            return
          }
          finish('completed')
        })

        runTimer = setTimeout(() => {
          if (terminal) return
          timedOut = true
          terminateWithFallback()
        }, timeoutMs)
        runTimer.unref?.()

        child.stdin.end(composePrompt(request.prompt, request.systemPrompt))
      } catch (error) {
        if (!terminal) {
          finish('failed', error instanceof KiroRunnerError
            ? error
            : mapSpawnError(error, executable))
        }
      }
    }

    queueMicrotask(launch)

    return {
      done,
      cancel() {
        if (terminal) return
        cancelled = true
        terminateWithFallback()
        finish('cancelled')
      },
      dispose() {
        if (terminal) return
        terminateWithFallback()
        finish('disposed')
      },
    }
  }

  function start(request, handlers = {}) {
    const onChunk = handlers.onChunk ?? (() => {})
    const onSession = handlers.onSession ?? (() => {})
    const onDone = handlers.onDone ?? (() => {})
    const onError = handlers.onError ?? (() => {})
    const allowTools = request?.allowTools ?? options.allowTools ?? false
    let child = null
    let transport = null
    let activeSessionId = request?.resume ? request.sessionId : null
    let stopped = false
    let cancelled = false
    let timedOut = false
    let terminal = false
    let promptActive = false
    let runTimer = null
    let killTimer = null
    let turnEndReason = null
    let stderr = ''
    let resolveDone
    const done = new Promise((resolvePromise) => { resolveDone = resolvePromise })

    const clearTimers = () => {
      if (runTimer) clearTimeout(runTimer)
      if (killTimer) clearTimeout(killTimer)
      runTimer = null
      killTimer = null
    }

    const scheduleKill = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      terminateChild(child, 'SIGTERM')
      killTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), killGraceMs)
      killTimer.unref?.()
    }

    const closeProcess = () => {
      transport?.close()
      scheduleKill()
    }

    const finishDone = (result = {}) => {
      if (terminal) return
      terminal = true
      stopped = true
      clearTimers()
      const payload = {
        sessionId: activeSessionId ?? request?.sessionId ?? null,
        reason: cancelled ? 'cancelled' : timedOut ? 'timeout' : result.stopReason ?? turnEndReason ?? 'end_turn',
        stopReason: result.stopReason ?? turnEndReason ?? null,
      }
      onDone(payload)
      resolveDone(payload)
      closeProcess()
    }

    const finishError = (error) => {
      if (terminal) return
      terminal = true
      stopped = true
      clearTimers()
      const rawError = error instanceof KiroRunnerError
        ? error
        : error instanceof AcpTransportError
          ? new KiroRunnerError(error.message, { code: error.code, cause: error })
          : new KiroRunnerError('Kiro runner gagal.', { cause: error })
      const safeError = new KiroRunnerError(
        sanitizeText(rawError.message, [authSecret(request?.auth)]) || 'Kiro runner gagal.',
        { code: rawError.code, cause: rawError },
      )
      onError(safeError.message, safeError)
      resolveDone({ sessionId: activeSessionId, reason: timedOut ? 'timeout' : 'failed', error: safeError })
      closeProcess()
    }

    const cancelForUnsupportedTool = () => {
      if (terminal) return
      transport?.notify('session/cancel', { sessionId: activeSessionId })
      finishError(new KiroRunnerError(
        'Kiro meminta eksekusi tool, tetapi runner ini berjalan dalam mode inference-only.',
        { code: 'KIRO_TOOLS_UNSUPPORTED' },
      ))
    }

    const handleNotification = (message) => {
      if (message.method !== 'session/update' && message.method !== 'session/notification') return
      // session/load may replay the complete conversation before it resolves.
      // Only forward updates belonging to the newly submitted prompt turn.
      if (!promptActive) return

      const update = message.params?.update ?? message.params
      const kind = updateKind(update)
      if (kind === 'agentmessagechunk') {
        const text = contentText(update.content)
        if (text) onChunk(text)
        return
      }
      if (kind === 'turnend') {
        turnEndReason = update.stopReason ?? update.reason ?? 'end_turn'
        finishDone({ stopReason: turnEndReason })
        return
      }
      if (kind === 'toolcall' || kind === 'toolcallupdate') {
        handlers.onToolCall?.(update)
        const status = String(update.status ?? '').toLowerCase()
        if (!allowTools && (status === 'in_progress' || status === 'completed')) {
          cancelForUnsupportedTool()
        }
      }
    }

    const handleClientRequest = async (message) => {
      if (message.method === 'session/request_permission') {
        if (!allowTools) return permissionDenial(message.params)
        if (typeof handlers.onPermissionRequest !== 'function') return permissionDenial(message.params)
        const decision = await handlers.onPermissionRequest(message.params)
        if (decision?.outcome) return decision
        if (typeof decision === 'string') {
          return { outcome: { outcome: 'selected', optionId: decision } }
        }
        return permissionDenial(message.params)
      }
      throw new KiroRunnerError(`Unsupported ACP client method: ${message.method}`, {
        code: 'KIRO_ACP_UNSUPPORTED_METHOD',
      })
    }

    const launch = async () => {
      try {
        if (!request || typeof request !== 'object') {
          throw new KiroRunnerError('Kiro start membutuhkan request.', { code: 'KIRO_INVALID_REQUEST' })
        }
        if (typeof request.prompt !== 'string') {
          throw new KiroRunnerError('Kiro prompt harus berupa string.', { code: 'KIRO_INVALID_REQUEST' })
        }
        if (request.resume && !request.sessionId) {
          throw new KiroRunnerError('Resume Kiro membutuhkan sessionId.', { code: 'KIRO_SESSION_REQUIRED' })
        }
        const cwd = resolve(request.cwd ?? options.cwd ?? process.cwd())
        if (!isAbsolute(cwd)) {
          throw new KiroRunnerError('Kiro cwd harus absolute.', { code: 'KIRO_INVALID_CWD' })
        }
        const env = await environmentFor(request.auth)
        if (stopped) return

        try {
          child = spawnFn(executable, ['acp'], {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
          })
        } catch (error) {
          throw mapSpawnError(error, executable)
        }

        child.once('error', (error) => finishError(mapSpawnError(error, executable)))
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => {
          stderr += chunk
          if (Buffer.byteLength(stderr) > maxOutputBytes) {
            finishError(new KiroRunnerError(`Kiro CLI output melebihi batas ${maxOutputBytes} byte.`, {
              code: 'KIRO_MAX_OUTPUT',
            }))
          }
        })
        child.once('close', (code, signal) => {
          if (terminal) return
          if (cancelled) {
            finishDone({ stopReason: 'cancelled' })
            return
          }
          const secret = authSecret(request.auth)
          const detail = sanitizeText(stderr, [secret])
          finishError(new KiroRunnerError(
            `Kiro ACP berhenti sebelum turn selesai (code ${code ?? 'null'}, signal ${signal ?? 'none'})${detail ? `: ${detail}` : ''}.`,
            { code: 'KIRO_ACP_CLOSED' },
          ))
        })

        transport = (options.createTransport ?? createNdjsonRpcTransport)(child, {
          maxOutputBytes,
          onNotification: handleNotification,
          onRequest: handleClientRequest,
          onError: finishError,
        })

        runTimer = setTimeout(() => {
          if (terminal) return
          timedOut = true
          transport?.notify('session/cancel', { sessionId: activeSessionId })
          finishError(new KiroRunnerError(`Kiro ACP timeout setelah ${timeoutMs}ms.`, {
            code: 'KIRO_TIMEOUT',
          }))
        }, timeoutMs)
        runTimer.unref?.()

        const initialized = await transport.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: CLIENT_INFO,
        })
        if (terminal || stopped) return
        if (initialized?.protocolVersion !== 1) {
          throw new KiroRunnerError(
            `Kiro ACP protocol version ${String(initialized?.protocolVersion)} tidak didukung.`,
            { code: 'KIRO_ACP_VERSION' },
          )
        }

        if (request.resume) {
          if (!initialized?.agentCapabilities?.loadSession) {
            throw new KiroRunnerError('Kiro ACP tidak mendukung session/load.', {
              code: 'KIRO_LOAD_UNSUPPORTED',
            })
          }
          await transport.request('session/load', {
            sessionId: request.sessionId,
            cwd,
            mcpServers: [],
          })
          if (terminal || stopped) return
          activeSessionId = request.sessionId
          onSession(activeSessionId)
        } else {
          const created = await transport.request('session/new', { cwd, mcpServers: [] })
          if (terminal || stopped) return
          if (typeof created?.sessionId !== 'string' || !created.sessionId) {
            throw new KiroRunnerError('Kiro ACP session/new tidak mengembalikan sessionId.', {
              code: 'KIRO_INVALID_SESSION',
            })
          }
          activeSessionId = created.sessionId
          onSession(activeSessionId)
        }

        if (request.model) {
          await transport.request('session/set_model', {
            sessionId: activeSessionId,
            modelId: request.model,
          })
          if (terminal || stopped) return
        }

        promptActive = true
        const result = await transport.request('session/prompt', {
          sessionId: activeSessionId,
          prompt: [{ type: 'text', text: composePrompt(request.prompt, request.systemPrompt) }],
        })
        if (!terminal) finishDone(result ?? {})
      } catch (error) {
        if (!terminal) finishError(error)
      }
    }

    queueMicrotask(launch)

    return {
      done,
      get sessionId() {
        return activeSessionId
      },
      cancel() {
        if (terminal || cancelled) return
        cancelled = true
        stopped = true
        if (transport && activeSessionId) {
          transport.notify('session/cancel', { sessionId: activeSessionId })
          killTimer = setTimeout(() => {
            if (!terminal) scheduleKill()
          }, killGraceMs)
          killTimer.unref?.()
        } else {
          finishDone({ stopReason: 'cancelled' })
        }
      },
      dispose() {
        if (terminal) return
        stopped = true
        const cancellationSent = Boolean(
          transport && activeSessionId
          && transport.notify('session/cancel', { sessionId: activeSessionId }),
        )
        terminal = true
        clearTimers()
        const payload = { sessionId: activeSessionId, reason: 'disposed' }
        resolveDone(payload)
        if (cancellationSent) {
          // Let the agent consume session/cancel before signal fallback.
          killTimer = setTimeout(closeProcess, killGraceMs)
          killTimer.unref?.()
        } else {
          closeProcess()
        }
      },
    }
  }

  return { checkAuth, whoami, listModels, startHeadless, start }
}

export const kiroRunner = createKiroRunner()

import { kiroRunner } from '../kiro-runner.mjs'

function configuredAuth(env) {
  const apiKey = typeof env?.KIRO_API_KEY === 'string' ? env.KIRO_API_KEY.trim() : ''
  if (!apiKey) {
    throw new Error('KIRO_API_KEY wajib diisi untuk provider Kiro Playground')
  }
  return { type: 'api-key', secret: apiKey }
}

function mapCompletion(result = {}) {
  const rawReason = result.reason ?? result.stopReason ?? 'end_turn'
  let reason = 'completed'
  if (rawReason === 'cancelled' || rawReason === 'disposed') reason = 'cancelled'
  else if (rawReason === 'timeout') reason = 'timeout'
  else if (rawReason === 'failed') reason = 'failed'

  return {
    code: reason === 'completed' ? 0 : null,
    reason,
    sessionId: result.sessionId ?? null,
    usage: null,
  }
}

function toolStatus(update) {
  const title = typeof update?.title === 'string' && update.title.trim()
    ? update.title.trim()
    : 'Tool Kiro'
  const status = typeof update?.status === 'string' && update.status.trim()
    ? ` (${update.status.trim()})`
    : ''
  return `${title}${status} ditolak: Playground belum punya UI izin tool; tidak ada tool yang di-auto-approve.`
}

export function createKiroCliProvider({ runner = kiroRunner, env = process.env } = {}) {
  return {
    id: 'kiro-cli',
    label: 'Kiro CLI',
    capabilities: {
      streaming: true,
      sessions: true,
      cancellation: true,
      tools: false,
    },

    start(request, handlers) {
      let terminal = false
      const controller = runner.start({
        ...request,
        auth: configuredAuth(env),
        // Tanpa UI permission interaktif, semua policy tetap deny-by-default.
        // `none` eksplisit inference-only; read-only/standard tidak boleh berubah
        // menjadi trust-all atau approval diam-diam.
        allowTools: false,
      }, {
        onSession(sessionId) {
          if (!terminal) handlers.onSession?.(sessionId)
        },
        onChunk(text) {
          if (!terminal) handlers.onChunk(text)
        },
        onToolCall(update) {
          if (!terminal) handlers.onChunk(toolStatus(update), 'error')
        },
        onError(message, error) {
          if (terminal) return
          terminal = true
          handlers.onError(message, error)
        },
      })

      controller.done.then(
        (result) => {
          if (terminal) return
          terminal = true
          handlers.onDone(mapCompletion(result))
        },
        (error) => {
          if (terminal) return
          terminal = true
          handlers.onError(error?.message ?? 'Kiro CLI gagal.', error)
        },
      )

      return {
        cancel() {
          if (!terminal) controller.cancel()
        },
        dispose() {
          if (terminal) return
          terminal = true
          controller.dispose()
        },
      }
    },
  }
}

export const kiroCliProvider = createKiroCliProvider()

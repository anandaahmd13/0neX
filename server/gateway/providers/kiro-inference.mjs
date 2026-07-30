import { createKiroHttpClient } from '../kiro-http.mjs'

function completion(reason, usage = null) {
  return {
    code: reason === 'completed' ? 0 : null,
    reason,
    sessionId: null,
    usage,
  }
}

function publicError(error) {
  if (error?.code === 'KIRO_AUTH_REJECTED') return 'Kiro API key ditolak oleh runtime Kiro.'
  if (error?.code === 'KIRO_TIMEOUT') return 'Runtime Kiro melewati batas waktu.'
  if (error?.code === 'KIRO_RATE_LIMITED') return 'Runtime Kiro sedang membatasi permintaan.'
  if (error?.code === 'KIRO_CANCELLED') return 'Permintaan Kiro dibatalkan.'
  return error?.message || 'Runtime Kiro gagal menyelesaikan permintaan.'
}

export function createKiroInferenceProvider({
  id = 'kiro-inference',
  label = 'Kiro HTTPS Inference',
  client = createKiroHttpClient(),
  getConnection = async () => null,
} = {}) {
  return {
    id,
    label,
    capabilities: {
      streaming: true,
      sessions: false,
      cancellation: true,
      tools: false,
    },

    start(request, handlers) {
      const abortController = new AbortController()
      let terminal = false
      let cancelled = false

      const done = (result) => {
        if (terminal) return
        terminal = true
        handlers.onDone(result)
      }
      const fail = (error) => {
        if (terminal) return
        if (cancelled || error?.code === 'KIRO_CANCELLED') {
          done(completion('cancelled'))
          return
        }
        terminal = true
        handlers.onError(publicError(error), error)
      }

      Promise.resolve().then(async () => {
        const connection = await getConnection(request.connectionId)
        if (!connection || connection.kind !== 'kiro-cli' || !connection.enabled) {
          throw Object.assign(new Error('Pilih connection Kiro aktif untuk Playground.'), {
            code: 'KIRO_CONNECTION_REQUIRED',
          })
        }
        if (!connection.apiKey) {
          throw Object.assign(new Error('Connection Kiro tidak memiliki API key tersimpan.'), {
            code: 'KIRO_API_KEY_REQUIRED',
          })
        }

        const model = request.model || 'auto'
        if (!model || !connection.models.includes(model)) {
          throw Object.assign(new Error(`Model Kiro tidak aktif: ${model || '(belum dipilih)'}`), {
            code: 'KIRO_MODEL_NOT_ACTIVE',
          })
        }

        const result = await client.generate({
          apiKey: connection.apiKey,
          region: connection.region,
          profileArn: connection.profileArn,
          model,
          conversationId: request.sessionId,
          systemPrompt: request.systemPrompt,
          messages: [{ role: 'user', text: request.prompt }],
          signal: abortController.signal,
          onChunk(text) {
            if (!terminal) handlers.onChunk(text)
          },
        })
        done(completion('completed', result.usage))
      }).catch(fail)

      return {
        cancel() {
          if (terminal || cancelled) return
          cancelled = true
          abortController.abort()
        },
        dispose() {
          if (terminal) return
          terminal = true
          abortController.abort()
        },
      }
    },
  }
}

export function createKiroInferenceAlias(options = {}) {
  return createKiroInferenceProvider({
    ...options,
    id: 'kiro-cli',
    label: 'Kiro HTTPS',
  })
}

export const kiroInferenceProvider = createKiroInferenceProvider()
export const kiroInferenceAlias = createKiroInferenceAlias()

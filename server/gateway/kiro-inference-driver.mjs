import { randomUUID } from 'node:crypto'

function invalidKiroRequest(message, code = 'kiro_unsupported_request') {
  return Object.assign(new Error(message), { status: 400, code, retryable: false })
}

function textMessageContent(content, index) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    throw invalidKiroRequest(`messages[${index}].content harus berupa teks`, 'kiro_text_only')
  }
  const parts = []
  for (const part of content) {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') {
      throw invalidKiroRequest('Kiro hanya mendukung content part bertipe text; multimodal tidak didukung', 'kiro_text_only')
    }
    parts.push(part.text)
  }
  return parts.join('')
}

function roleSeparated(messages) {
  return messages.map(({ role, text }) => `[${role}]\n${text}`).join('\n\n')
}

export function parseKiroInferenceRequest(body, limits) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidKiroRequest('Body chat Kiro harus berupa object', 'invalid_request')
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalidKiroRequest('messages wajib berupa array non-kosong', 'invalid_messages')
  }
  if (body.n !== undefined && body.n !== 1) {
    throw invalidKiroRequest('Kiro hanya mendukung n=1', 'kiro_single_choice_only')
  }
  for (const field of ['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls']) {
    if (body[field] !== undefined) {
      throw invalidKiroRequest(
        `Kiro HTTPS tidak mendukung OpenAI ${field}. Gunakan provider kiro-agent untuk tools ACP/MCP.`,
        'kiro_tools_unsupported',
      )
    }
  }
  if (body.response_format !== undefined) {
    throw invalidKiroRequest('Kiro tidak mendukung jaminan response_format', 'kiro_response_format_unsupported')
  }
  if (body.audio !== undefined) {
    throw invalidKiroRequest('Kiro tidak mendukung output audio', 'kiro_audio_unsupported')
  }
  if (body.modalities !== undefined) {
    if (!Array.isArray(body.modalities) || body.modalities.some((modality) => modality !== 'text')) {
      throw invalidKiroRequest('Kiro hanya mendukung modality text', 'kiro_text_only')
    }
  }

  const system = []
  const conversation = []
  for (let index = 0; index < body.messages.length; index += 1) {
    const message = body.messages[index]
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw invalidKiroRequest(`messages[${index}] harus berupa object`, 'invalid_messages')
    }
    const role = message.role
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) {
      throw invalidKiroRequest(`Role ${String(role)} tidak didukung Kiro`, 'kiro_role_unsupported')
    }
    if (message.tool_calls !== undefined || message.function_call !== undefined) {
      throw invalidKiroRequest(
        'Kiro HTTPS tidak mendukung riwayat OpenAI tool call. Gunakan provider kiro-agent untuk tools ACP/MCP.',
        'kiro_tools_unsupported',
      )
    }
    const entry = { role, text: textMessageContent(message.content, index) }
    if (role === 'system' || role === 'developer') system.push(entry)
    else conversation.push(entry)
  }

  const prompt = roleSeparated(conversation)
  const systemPrompt = roleSeparated(system)
  if (!prompt.trim()) throw invalidKiroRequest('Chat Kiro membutuhkan pesan user atau assistant berisi teks', 'invalid_messages')
  if (prompt.length > limits.maxPromptLength) {
    throw invalidKiroRequest(`Prompt melebihi batas ${limits.maxPromptLength} karakter`, 'prompt_too_long')
  }
  if (systemPrompt.length > limits.maxSystemPromptLength) {
    throw invalidKiroRequest(`System prompt melebihi batas ${limits.maxSystemPromptLength} karakter`, 'system_prompt_too_long')
  }
  return { messages: conversation, systemPrompt }
}

function mapKiroHttpError(error) {
  const known = {
    KIRO_AUTH_REJECTED: [401, 'kiro_auth_failed', 'Kiro API key ditolak oleh runtime Kiro', false],
    KIRO_RATE_LIMITED: [429, 'kiro_rate_limited', 'Runtime Kiro sedang membatasi permintaan', true],
    KIRO_TIMEOUT: [504, 'kiro_timeout', 'Runtime Kiro melewati batas waktu', true],
    KIRO_UNREACHABLE: [503, 'kiro_unavailable', 'Runtime Kiro tidak dapat dihubungi', true],
    KIRO_INVALID_REQUEST: [502, 'kiro_invalid_upstream_request', 'Runtime Kiro menolak format permintaan', false],
    KIRO_MALFORMED_STREAM: [502, 'kiro_malformed_stream', 'Runtime Kiro mengirim stream yang tidak valid', true],
    KIRO_MAX_OUTPUT: [502, 'kiro_max_output', 'Respons Kiro melebihi batas output', true],
    KIRO_API_KEY_REQUIRED: [500, 'kiro_auth_configuration', 'Konfigurasi autentikasi Kiro tidak valid', false],
  }
  const [status, code, message, retryable] = known[error?.code]
    ?? [Number(error?.status) || 502, 'kiro_failed', 'Runtime Kiro gagal menyelesaikan permintaan', true]
  return Object.assign(new Error(message), { status, code, retryable })
}

function openAiUsage(usage) {
  if (!usage) return null
  return {
    prompt_tokens: Number(usage.inputTokens) || 0,
    completion_tokens: Number(usage.outputTokens) || 0,
    total_tokens: Number(usage.totalTokens) || 0,
    ...(Number(usage.cacheReadTokens) > 0
      ? { prompt_tokens_details: { cached_tokens: Number(usage.cacheReadTokens) } }
      : {}),
  }
}

function sseData(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

export function createKiroInferenceDriver({ client, limits }) {
  if (!client || typeof client.generate !== 'function') {
    throw new TypeError('Kiro inference driver membutuhkan HTTP client')
  }
  if (!limits) throw new TypeError('Kiro inference driver membutuhkan limits')

  return {
    id: 'kiro-inference',
    kinds: ['kiro-cli'],

    validateCandidate({ connection, upstreamModel }) {
      if (!connection.models.includes(upstreamModel)) {
        throw invalidKiroRequest(
          `Model Kiro tidak aktif: ${upstreamModel}`,
          'kiro_model_not_active',
        )
      }
    },

    async attempt({ resource, connection, upstreamModel, body, request, response, headers, requestId }) {
      if (resource !== 'chat/completions') {
        throw invalidKiroRequest(
          `Kiro tidak mendukung endpoint /v1/${resource}`,
          `kiro_${resource.replace('/', '_')}_unsupported`,
        )
      }
      if (connection.authMode !== 'api-key' || !connection.apiKey) {
        throw invalidKiroRequest(
          'Connection Kiro membutuhkan API key tersimpan',
          'kiro_api_key_required',
        )
      }
      this.validateCandidate({ connection, upstreamModel })

      const { messages, systemPrompt } = parseKiroInferenceRequest(body, limits)
      const completionId = `chatcmpl_${randomUUID()}`
      const created = Math.floor(Date.now() / 1000)
      const model = body.model
      const chunks = []
      const abortController = new AbortController()
      let responseStarted = false
      let finished = false
      let disconnected = false

      const startStream = () => {
        if (responseStarted || disconnected) return
        responseStarted = true
        response.writeHead(200, {
          ...headers,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-request-id': requestId,
        })
        sseData(response, {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })
      }

      const disconnect = () => {
        if (finished || response.writableEnded) return
        disconnected = true
        abortController.abort()
      }
      const detach = () => {
        request.off('aborted', disconnect)
        response.off('close', disconnect)
      }
      request.once('aborted', disconnect)
      response.once('close', disconnect)

      let usage = null
      try {
        const result = await client.generate({
          apiKey: connection.apiKey,
          region: connection.region,
          profileArn: connection.profileArn,
          model: upstreamModel,
          messages,
          systemPrompt,
          signal: abortController.signal,
          onOpen() {
            if (body.stream === true) startStream()
          },
          onChunk(text) {
            if (disconnected) return
            if (body.stream === true) {
              startStream()
              sseData(response, {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
              })
            } else {
              chunks.push(text)
            }
          },
        })
        usage = result.usage
      } catch (error) {
        if (disconnected || error?.code === 'KIRO_CANCELLED') {
          finished = true
          detach()
          return { done: true, status: 499, usage: null, errorCategory: 'client_disconnected' }
        }
        const mapped = mapKiroHttpError(error)
        finished = true
        detach()
        if (!responseStarted) throw mapped
        sseData(response, {
          error: {
            message: mapped.message,
            type: 'gateway_error',
            code: mapped.code,
          },
        })
        response.end('data: [DONE]\n\n')
        return {
          done: true,
          status: mapped.status,
          usage: null,
          errorCategory: mapped.code,
        }
      }

      finished = true
      detach()
      if (body.stream === true) {
        startStream()
        const finish = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }
        if (body.stream_options?.include_usage === true && usage) finish.usage = openAiUsage(usage)
        sseData(response, finish)
        response.end('data: [DONE]\n\n')
      } else {
        const payload = {
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: chunks.join('') },
            finish_reason: 'stop',
          }],
        }
        if (usage) payload.usage = openAiUsage(usage)
        sendJson(response, 200, payload, { ...headers, 'x-request-id': requestId })
      }
      return { done: true, status: 200, usage, errorCategory: null }
    },
  }
}

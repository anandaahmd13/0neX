import { randomUUID } from 'node:crypto'
import { assertPublicHost } from './net-guard.mjs'
import { DEFAULT_KIRO_REGION, normalizeKiroRegion } from './connection-store.mjs'

const GENERATE_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse'
const MAX_ERROR_LENGTH = 300
const MIN_FRAME_LENGTH = 16

export class KiroHttpError extends Error {
  constructor(message, {
    code = 'KIRO_HTTP_ERROR',
    status = 502,
    retryable = status === 429 || status >= 500,
    cause,
  } = {}) {
    super(message, { cause })
    this.name = 'KiroHttpError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

export function kiroRuntimeUrl(region = DEFAULT_KIRO_REGION) {
  return `https://runtime.${normalizeKiroRegion(region)}.kiro.dev/generateAssistantResponse`
}

function cleanErrorText(value) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > MAX_ERROR_LENGTH ? `${flat.slice(0, MAX_ERROR_LENGTH)}…` : flat
}

function requestError(status) {
  if (status === 401 || status === 403) {
    return new KiroHttpError('Kiro API key ditolak oleh runtime Kiro.', {
      code: 'KIRO_AUTH_REJECTED',
      status: 401,
      retryable: false,
    })
  }
  if (status === 429) {
    return new KiroHttpError('Runtime Kiro sedang membatasi permintaan.', {
      code: 'KIRO_RATE_LIMITED',
      status: 429,
      retryable: true,
    })
  }
  if (status === 400 || status === 422) {
    return new KiroHttpError('Runtime Kiro menolak format permintaan.', {
      code: 'KIRO_INVALID_REQUEST',
      status: 502,
      retryable: false,
    })
  }
  return new KiroHttpError(`Runtime Kiro gagal (HTTP ${status}).`, {
    code: 'KIRO_UPSTREAM_ERROR',
    status: status >= 500 ? 502 : status,
    retryable: status >= 500,
  })
}

function textOf(message) {
  return typeof message?.text === 'string' ? message.text : ''
}

/**
 * Bentuk payload minimal GenerateAssistantResponse. System/developer dikirim
 * sebagai systemPrompt; turn user/assistant sebelumnya tetap menjadi history,
 * dan user turn terakhir menjadi currentMessage seperti kontrak Kiro.
 */
export function buildKiroRequest({ messages, systemPrompt = '', profileArn, model = 'auto', conversationId } = {}) {
  const conversation = Array.isArray(messages) ? messages : []
  const history = []
  let currentMessage = null

  for (const message of conversation) {
    if (message?.role === 'user') {
      const item = {
        userInputMessage: {
          content: textOf(message) || 'continue',
          modelId: model,
          origin: 'AI_EDITOR',
        },
      }
      history.push(item)
      currentMessage = item
    } else if (message?.role === 'assistant') {
      history.push({ assistantResponseMessage: { content: textOf(message) || '...' } })
    }
  }

  if (currentMessage) {
    const index = history.lastIndexOf(currentMessage)
    history.splice(index, 1)
  } else {
    currentMessage = {
      userInputMessage: {
        content: 'continue',
        modelId: model,
        origin: 'AI_EDITOR',
      },
    }
  }

  const payload = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: conversationId || randomUUID(),
      currentMessage,
      history,
    },
  }
  if (profileArn) payload.profileArn = profileArn
  if (systemPrompt) payload.systemPrompt = systemPrompt
  return payload
}

function parseHeaders(frame, headersLength) {
  const headers = {}
  let offset = 12
  const end = 12 + headersLength
  while (offset < end) {
    const nameLength = frame[offset]
    offset += 1
    if (!nameLength || offset + nameLength + 1 > end) {
      throw new KiroHttpError('Runtime Kiro mengirim header event-stream yang rusak.', {
        code: 'KIRO_MALFORMED_STREAM',
      })
    }
    const name = frame.subarray(offset, offset + nameLength).toString('utf8')
    offset += nameLength
    const type = frame[offset]
    offset += 1
    if (type !== 7 || offset + 2 > end) {
      throw new KiroHttpError('Runtime Kiro mengirim tipe header event-stream yang tidak didukung.', {
        code: 'KIRO_MALFORMED_STREAM',
      })
    }
    const valueLength = frame.readUInt16BE(offset)
    offset += 2
    if (offset + valueLength > end) {
      throw new KiroHttpError('Runtime Kiro mengirim nilai header event-stream yang terpotong.', {
        code: 'KIRO_MALFORMED_STREAM',
      })
    }
    headers[name] = frame.subarray(offset, offset + valueLength).toString('utf8')
    offset += valueLength
  }
  return headers
}

function parseFrame(frame) {
  const headersLength = frame.readUInt32BE(4)
  if (headersLength > frame.length - MIN_FRAME_LENGTH) {
    throw new KiroHttpError('Runtime Kiro mengirim frame event-stream yang tidak valid.', {
      code: 'KIRO_MALFORMED_STREAM',
    })
  }
  const headers = parseHeaders(frame, headersLength)
  const payloadBuffer = frame.subarray(12 + headersLength, frame.length - 4)
  let payload = null
  if (payloadBuffer.length) {
    try {
      payload = JSON.parse(payloadBuffer.toString('utf8'))
    } catch (cause) {
      throw new KiroHttpError('Runtime Kiro mengirim payload event-stream yang bukan JSON.', {
        code: 'KIRO_MALFORMED_STREAM',
        cause,
      })
    }
  }
  return { headers, payload }
}

export function createKiroEventStreamParser({ onEvent = () => {}, maxFrameBytes = 2_000_000 } = {}) {
  let buffer = Buffer.alloc(0)
  let finished = false

  return {
    push(chunk) {
      if (finished) throw new KiroHttpError('Parser event-stream Kiro sudah selesai.', { code: 'KIRO_MALFORMED_STREAM' })
      const next = Buffer.from(chunk)
      buffer = buffer.length ? Buffer.concat([buffer, next]) : next
      while (buffer.length >= MIN_FRAME_LENGTH) {
        const totalLength = buffer.readUInt32BE(0)
        if (totalLength < MIN_FRAME_LENGTH || totalLength > maxFrameBytes) {
          throw new KiroHttpError('Runtime Kiro mengirim ukuran frame event-stream yang tidak valid.', {
            code: totalLength > maxFrameBytes ? 'KIRO_MAX_OUTPUT' : 'KIRO_MALFORMED_STREAM',
          })
        }
        if (buffer.length < totalLength) return
        const frame = buffer.subarray(0, totalLength)
        buffer = buffer.subarray(totalLength)
        onEvent(parseFrame(frame))
      }
    },
    finish() {
      finished = true
      if (buffer.length !== 0) {
        throw new KiroHttpError('Runtime Kiro menutup event-stream di tengah frame.', {
          code: 'KIRO_MALFORMED_STREAM',
        })
      }
    },
  }
}

function eventContent(event) {
  const type = event.headers[':event-type'] ?? ''
  const payload = event.payload ?? {}
  if (type === 'assistantResponseEvent') {
    return payload.content ?? payload.assistantResponseEvent?.content ?? ''
  }
  if (type === 'codeEvent') return payload.content ?? payload.codeEvent?.content ?? ''
  return ''
}

function eventUsage(event) {
  if (event.headers[':event-type'] !== 'metricsEvent') return null
  const metrics = event.payload?.metricsEvent ?? event.payload
  if (!metrics || typeof metrics !== 'object') return null
  const inputTokens = Number(metrics.inputTokens ?? 0)
  const outputTokens = Number(metrics.outputTokens ?? 0)
  const cacheReadTokens = Number(metrics.cacheReadInputTokens ?? metrics.cache_read_input_tokens ?? 0)
  const cacheWriteTokens = Number(metrics.cacheCreationInputTokens ?? metrics.cache_creation_input_tokens ?? 0)
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].some((value) => value > 0)) return null
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

export function createKiroHttpClient({
  fetchImpl = globalThis.fetch,
  assertHost = assertPublicHost,
  timeoutMs = 120_000,
  maxOutputBytes = 2_000_000,
} = {}) {
  async function generate({
    apiKey,
    region,
    profileArn,
    messages,
    systemPrompt,
    model = 'auto',
    conversationId,
    signal,
    onOpen = () => {},
    onChunk = () => {},
    onUsage = () => {},
  } = {}) {
    const secret = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (!secret) {
      throw new KiroHttpError('Kiro API key wajib diisi.', {
        code: 'KIRO_API_KEY_REQUIRED',
        status: 500,
        retryable: false,
      })
    }

    const endpoint = kiroRuntimeUrl(region)
    await assertHost(new URL(endpoint).hostname)
    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = () => controller.abort(signal?.reason)
    if (signal?.aborted) abortFromCaller()
    else signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    timer.unref?.()

    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/vnd.amazon.eventstream',
          'x-amz-target': GENERATE_TARGET,
          authorization: `Bearer ${secret}`,
          tokentype: 'API_KEY',
          'x-amzn-codewhisperer-optout': 'true',
          'x-amzn-kiro-agent-mode': 'vibe',
          'amz-sdk-request': 'attempt=1; max=1',
          'amz-sdk-invocation-id': randomUUID(),
        },
        body: JSON.stringify(buildKiroRequest({
          messages,
          systemPrompt,
          profileArn,
          model,
          conversationId,
        })),
        signal: controller.signal,
      })
      if (!response.ok) throw requestError(response.status)
      onOpen(response)

      let outputBytes = 0
      let usage = null
      const parser = createKiroEventStreamParser({
        maxFrameBytes: maxOutputBytes,
        onEvent(event) {
          const nextUsage = eventUsage(event)
          if (nextUsage) {
            usage = nextUsage
            onUsage(nextUsage)
          }
          const content = eventContent(event)
          if (!content) return
          outputBytes += Buffer.byteLength(content, 'utf8')
          if (outputBytes > maxOutputBytes) {
            throw new KiroHttpError('Respons Kiro melebihi batas output.', {
              code: 'KIRO_MAX_OUTPUT',
              status: 502,
            })
          }
          onChunk(content)
        },
      })
      for await (const chunk of response.body ?? []) parser.push(chunk)
      parser.finish()
      return { usage }
    } catch (cause) {
      if (cause instanceof KiroHttpError) throw cause
      if (cause?.name === 'AbortError' || controller.signal.aborted) {
        throw new KiroHttpError(
          timedOut ? 'Runtime Kiro melewati batas waktu.' : 'Permintaan Kiro dibatalkan.',
          {
            code: timedOut ? 'KIRO_TIMEOUT' : 'KIRO_CANCELLED',
            status: timedOut ? 504 : 499,
            retryable: timedOut,
            cause,
          },
        )
      }
      throw new KiroHttpError(`Gagal menghubungi runtime Kiro: ${cleanErrorText(cause?.message)}`, {
        code: 'KIRO_UNREACHABLE',
        status: 503,
        retryable: true,
        cause,
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  return { generate }
}

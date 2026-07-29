import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildKiroRequest,
  createKiroEventStreamParser,
  createKiroHttpClient,
  kiroRuntimeUrl,
} from '../server/gateway/kiro-http.mjs'

const SECRET = 'ksk_transport_secret_that_must_not_leak'

function stringHeader(name, value) {
  const nameBytes = Buffer.from(name)
  const valueBytes = Buffer.from(value)
  const result = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length)
  let offset = 0
  result[offset++] = nameBytes.length
  nameBytes.copy(result, offset)
  offset += nameBytes.length
  result[offset++] = 7
  result.writeUInt16BE(valueBytes.length, offset)
  offset += 2
  valueBytes.copy(result, offset)
  return result
}

function eventFrame(type, payload) {
  const headers = Buffer.concat([
    stringHeader(':message-type', 'event'),
    stringHeader(':event-type', type),
    stringHeader(':content-type', 'application/json'),
  ])
  const body = Buffer.from(JSON.stringify(payload))
  const totalLength = 12 + headers.length + body.length + 4
  const frame = Buffer.alloc(totalLength)
  frame.writeUInt32BE(totalLength, 0)
  frame.writeUInt32BE(headers.length, 4)
  // CRC fields are not used for routing or payload extraction.
  headers.copy(frame, 12)
  body.copy(frame, 12 + headers.length)
  return frame
}

function streamResponse(chunks, status = 200) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }), {
    status,
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  })
}

test('runtime URL follows the saved Kiro region', () => {
  assert.equal(
    kiroRuntimeUrl('eu-central-1'),
    'https://runtime.eu-central-1.kiro.dev/generateAssistantResponse',
  )
  assert.throws(() => kiroRuntimeUrl('ap-southeast-1'), /region/i)
})

test('request payload keeps history, latest user turn, profile, and system prompt', () => {
  const payload = buildKiroRequest({
    profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/OK',
    model: 'auto',
    conversationId: 'conversation-1',
    systemPrompt: '[system]\nBe concise.',
    messages: [
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'answer' },
      { role: 'user', text: 'last' },
    ],
  })

  assert.equal(payload.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/OK')
  assert.equal(payload.systemPrompt, '[system]\nBe concise.')
  assert.equal(payload.conversationState.conversationId, 'conversation-1')
  assert.equal(payload.conversationState.currentMessage.userInputMessage.content, 'last')
  assert.deepEqual(payload.conversationState.history, [
    { userInputMessage: { content: 'first', modelId: 'auto', origin: 'AI_EDITOR' } },
    { assistantResponseMessage: { content: 'answer' } },
  ])
})

test('AWS EventStream parser handles fragmented and coalesced frames', () => {
  const events = []
  const parser = createKiroEventStreamParser({ onEvent: (event) => events.push(event) })
  const first = eventFrame('assistantResponseEvent', { content: 'hel' })
  const second = eventFrame('assistantResponseEvent', { content: 'lo' })
  const combined = Buffer.concat([first, second])

  parser.push(combined.subarray(0, 7))
  parser.push(combined.subarray(7, first.length + 3))
  parser.push(combined.subarray(first.length + 3))
  parser.finish()

  assert.deepEqual(events.map((event) => event.headers[':event-type']), [
    'assistantResponseEvent',
    'assistantResponseEvent',
  ])
  assert.deepEqual(events.map((event) => event.payload.content), ['hel', 'lo'])
})

test('HTTP client sends connection auth and emits content incrementally with usage', async () => {
  const calls = []
  const content1 = eventFrame('assistantResponseEvent', { content: 'hello ' })
  const content2 = eventFrame('assistantResponseEvent', { content: 'world' })
  const metrics = eventFrame('metricsEvent', {
    inputTokens: 8,
    outputTokens: 3,
    cacheReadInputTokens: 2,
  })
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return streamResponse([
      content1.subarray(0, 11),
      Buffer.concat([content1.subarray(11), content2, metrics]),
    ])
  }
  const chunks = []
  const client = createKiroHttpClient({ fetchImpl, assertHost: async () => {} })
  const result = await client.generate({
    apiKey: SECRET,
    region: 'eu-central-1',
    profileArn: 'arn:aws:codewhisperer:eu-central-1:1:profile/OK',
    messages: [{ role: 'user', text: 'ping' }],
    onChunk: (chunk) => chunks.push(chunk),
  })

  assert.deepEqual(chunks, ['hello ', 'world'])
  assert.deepEqual(result.usage, {
    inputTokens: 8,
    outputTokens: 3,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    totalTokens: 13,
  })
  assert.equal(calls[0].url, 'https://runtime.eu-central-1.kiro.dev/generateAssistantResponse')
  assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`)
  assert.equal(
    calls[0].init.headers['x-amz-target'],
    'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
  )
  assert.equal(calls[0].init.headers.tokentype, 'API_KEY')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.profileArn, 'arn:aws:codewhisperer:eu-central-1:1:profile/OK')
  assert.equal(body.conversationState.currentMessage.userInputMessage.content, 'ping')
})

test('HTTP errors and truncated streams are safe and categorized', async () => {
  const rejected = createKiroHttpClient({
    fetchImpl: async () => new Response(`rejected ${SECRET}`, { status: 403 }),
    assertHost: async () => {},
  })
  await assert.rejects(
    () => rejected.generate({ apiKey: SECRET, messages: [{ role: 'user', text: 'x' }] }),
    (error) => {
      assert.equal(error.code, 'KIRO_AUTH_REJECTED')
      assert.equal(error.status, 401)
      assert.equal(error.message.includes(SECRET), false)
      return true
    },
  )

  const frame = eventFrame('assistantResponseEvent', { content: 'partial' })
  const truncated = createKiroHttpClient({
    fetchImpl: async () => streamResponse([frame.subarray(0, frame.length - 2)]),
    assertHost: async () => {},
  })
  await assert.rejects(
    () => truncated.generate({ apiKey: SECRET, messages: [{ role: 'user', text: 'x' }] }),
    (error) => error.code === 'KIRO_MALFORMED_STREAM',
  )
})

test('caller abort cancels the upstream request', async () => {
  let upstreamAborted = false
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    const abort = () => {
      upstreamAborted = true
      reject(new DOMException('aborted', 'AbortError'))
    }
    if (init.signal.aborted) abort()
    else init.signal.addEventListener('abort', abort, { once: true })
  })
  const controller = new AbortController()
  const client = createKiroHttpClient({ fetchImpl, assertHost: async () => {}, timeoutMs: 10_000 })
  const pending = client.generate({
    apiKey: SECRET,
    messages: [{ role: 'user', text: 'wait' }],
    signal: controller.signal,
  })
  controller.abort()

  await assert.rejects(pending, (error) => error.code === 'KIRO_CANCELLED')
  assert.equal(upstreamAborted, true)
})

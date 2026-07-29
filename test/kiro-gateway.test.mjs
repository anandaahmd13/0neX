import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { createGatewayServer } from '../server/gateway-server.mjs'

const MASTER_KEY = '0123456789abcdef0123456789abcdef'
const ORIGIN = 'http://localhost:5199'
const WS_TOKEN = 'gateway-ws-kiro-test'
const ADMIN_TOKEN = 'gateway-admin-test'
const API_TOKEN = 'gateway-api-test'
const DEFAULT_SECRET = 'ksk_connection_https_fixture'
const USAGE = Object.freeze({
  inputTokens: 8,
  outputTokens: 3,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  totalTokens: 14,
})

function profileArn(region, apiKey) {
  const credential = apiKey.includes('rotated') ? 'rotated' : 'primary'
  return `arn:aws:codewhisperer:${region}:123456789012:profile/${credential}`
}

function createFakeKiroBearerValidator() {
  const calls = []
  return {
    calls,
    async validateApiKey({ apiKey, region = 'us-east-1' }) {
      calls.push({ apiKey, region })
      if (apiKey.includes('rejected')) {
        throw Object.assign(new Error('upstream rejected credential'), {
          code: 'KIRO_BEARER_REJECTED',
          status: 401,
        })
      }
      return {
        region,
        profileArn: profileArn(region, apiKey),
        email: 'kiro-user@example.com',
        validatedAt: new Date(1_750_000_000_000 + calls.length * 1_000).toISOString(),
      }
    },
  }
}

function createFakeKiroHttpClient() {
  const calls = []
  return {
    calls,
    async generate(options) {
      const call = {
        apiKey: options.apiKey,
        region: options.region,
        profileArn: options.profileArn,
        model: options.model,
        conversationId: options.conversationId,
        systemPrompt: options.systemPrompt,
        messages: options.messages,
        signal: options.signal,
        aborted: false,
      }
      calls.push(call)
      options.onOpen?.({ status: 200 })

      const input = (options.messages ?? []).map((message) => message.text).join('\n')
      if (input.includes('WAIT_FOR_CANCEL')) {
        return new Promise((resolve, reject) => {
          const abort = () => {
            call.aborted = true
            reject(Object.assign(new Error('request aborted'), {
              name: 'AbortError',
              code: 'KIRO_CANCELLED',
              status: 499,
            }))
          }
          if (options.signal?.aborted) abort()
          else options.signal?.addEventListener('abort', abort, { once: true })
        })
      }

      const chunks = input.includes('STREAM_RESPONSE')
        ? ['streamed ', 'over HTTPS']
        : ['hello ', 'over HTTPS']
      for (const chunk of chunks) {
        await Promise.resolve()
        options.onChunk?.(chunk)
      }
      options.onUsage?.(USAGE)
      return { usage: { ...USAGE } }
    },
  }
}

async function setupGateway(t) {
  const root = await mkdtemp(join(tmpdir(), '0nex-kiro-gateway-'))
  const gatewayDataDir = join(root, 'gateway-data')
  const kiroBearerValidator = createFakeKiroBearerValidator()
  const kiroHttpClient = createFakeKiroHttpClient()
  const gateway = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: gatewayDataDir,
    wsToken: WS_TOKEN,
    apiKey: API_TOKEN,
    adminToken: ADMIN_TOKEN,
    masterKey: MASTER_KEY,
    allowedOrigins: [ORIGIN],
    allowInsecureLocalhost: true,
    kiroBearerValidator,
    kiroHttpClient,
    env: {
      ...process.env,
      GATEWAY_RATE_CAPACITY: '0',
      GATEWAY_RATE_REFILL_PER_SEC: '0',
    },
  })
  const address = await gateway.listen()
  t.after(() => gateway.close())
  return {
    gatewayDataDir,
    kiroBearerValidator,
    kiroHttpClient,
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/?token=${WS_TOKEN}`,
  }
}

function authHeaders(token, body = false) {
  return {
    origin: ORIGIN,
    authorization: `Bearer ${token}`,
    ...(body ? { 'content-type': 'application/json' } : {}),
  }
}

async function jsonRequest(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...authHeaders(token, init.body !== undefined),
      ...init.headers,
    },
  })
  const payload = await response.json()
  return { response, payload }
}

async function createKiroConnection(baseUrl, overrides = {}) {
  const result = await jsonRequest(`${baseUrl}/admin/connections`, ADMIN_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      id: 'kiro-main',
      name: 'Kiro Main',
      kind: 'kiro-cli',
      authMode: 'api-key',
      apiKey: DEFAULT_SECRET,
      region: 'us-east-1',
      models: ['auto'],
      enabled: true,
      ...overrides,
    }),
  })
  assert.equal(result.response.status, 201, JSON.stringify(result.payload))
  return result.payload.data
}

function connect(url) {
  const socket = new WebSocket(url, { origin: ORIGIN })
  const queued = []
  const waiters = []

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const index = waiters.findIndex((waiter) => waiter.predicate(message))
    if (index === -1) queued.push(message)
    else {
      const [waiter] = waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    }
  })

  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  function next(predicate, timeoutMs = 2_000) {
    const index = queued.findIndex(predicate)
    if (index !== -1) return Promise.resolve(queued.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null }
      waiter.timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter)
        if (waiterIndex !== -1) waiters.splice(waiterIndex, 1)
        reject(new Error('Timeout menunggu pesan WebSocket'))
      }, timeoutMs)
      waiters.push(waiter)
    })
  }

  return { socket, opened, next }
}

function runMessage(overrides = {}) {
  return {
    type: 'run',
    providerId: 'kiro-cli',
    prompt: 'hello',
    sessionId: 'correlation-session',
    resume: false,
    agent: {
      id: 'agt_kiro',
      model: '',
      systemPrompt: 'answer briefly',
      toolPolicy: 'none',
    },
    ...overrides,
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timeout menunggu kondisi test')
}

function parseSse(text) {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^data: /, ''))
}

test('Kiro Playground requires a selected connection and streams with its stored credential', async (t) => {
  const { baseUrl, wsUrl, kiroHttpClient } = await setupGateway(t)
  const created = await createKiroConnection(baseUrl)
  const client = connect(wsUrl)
  t.after(() => client.socket.close())
  await client.opened

  const hello = await client.next((message) => message.type === 'hello')
  const kiro = hello.providers.find((provider) => provider.id === 'kiro-cli')
  assert.equal(kiro.label, 'Kiro HTTPS')
  assert.deepEqual(kiro.capabilities, {
    streaming: true,
    sessions: false,
    cancellation: true,
    tools: false,
  })

  client.socket.send(JSON.stringify(runMessage({ sessionId: 'missing-connection' })))
  await client.next((message) => message.type === 'session' && message.sessionId === 'missing-connection')
  const missing = await client.next((message) => message.type === 'error')
  assert.match(missing.text, /Pilih connection Kiro aktif/)
  assert.equal(kiroHttpClient.calls.length, 0)

  client.socket.send(JSON.stringify(runMessage({ connectionId: created.id })))
  await client.next((message) => message.type === 'session' && message.sessionId === 'correlation-session')
  const first = await client.next((message) => message.type === 'chunk')
  const second = await client.next((message) => message.type === 'chunk')
  assert.deepEqual([first.text, second.text], ['hello ', 'over HTTPS'])
  const done = await client.next((message) => message.type === 'done')
  assert.deepEqual(done, {
    type: 'done',
    providerId: 'kiro-cli',
    code: 0,
    reason: 'completed',
    sessionId: null,
    usage: USAGE,
  })

  assert.equal(kiroHttpClient.calls.length, 1)
  const inference = kiroHttpClient.calls[0]
  assert.equal(inference.apiKey, DEFAULT_SECRET)
  assert.equal(inference.region, 'us-east-1')
  assert.equal(inference.profileArn, profileArn('us-east-1', DEFAULT_SECRET))
  assert.equal(inference.model, 'auto')
  assert.equal(inference.conversationId, 'correlation-session')
  assert.equal(inference.systemPrompt, 'answer briefly')
  assert.deepEqual(inference.messages, [{ role: 'user', text: 'hello' }])
})

test('Kiro Playground cancellation aborts HTTPS inference', async (t) => {
  const { baseUrl, wsUrl, kiroHttpClient } = await setupGateway(t)
  await createKiroConnection(baseUrl)
  const client = connect(wsUrl)
  t.after(() => client.socket.close())
  await client.opened
  await client.next((message) => message.type === 'hello')

  client.socket.send(JSON.stringify(runMessage({
    connectionId: 'kiro-main',
    prompt: 'WAIT_FOR_CANCEL',
  })))
  await client.next((message) => message.type === 'session')
  await waitFor(() => kiroHttpClient.calls.length === 1)
  client.socket.send(JSON.stringify({ type: 'cancel' }))

  const done = await client.next((message) => message.type === 'done')
  assert.equal(done.reason, 'cancelled')
  assert.equal(done.code, null)
  assert.equal(done.sessionId, null)
  assert.equal(done.usage, null)
  assert.equal(kiroHttpClient.calls[0].signal.aborted, true)
  assert.equal(kiroHttpClient.calls[0].aborted, true)
})

test('Kiro /v1 chat returns OpenAI non-stream and stream shapes with usage', async (t) => {
  const { baseUrl, kiroBearerValidator, kiroHttpClient } = await setupGateway(t)
  const created = await createKiroConnection(baseUrl)
  assert.equal(created.kind, 'kiro-cli')
  assert.equal(created.authMode, 'api-key')
  assert.equal(created.hasApiKey, true)
  assert.equal(created.credentialType, 'bearer')
  assert.equal(created.region, 'us-east-1')
  assert.equal(created.profileArn, profileArn('us-east-1', DEFAULT_SECRET))
  assert.equal(created.email, 'kiro-user@example.com')
  assert.equal(typeof created.validatedAt, 'string')
  assert.equal('apiKey' in created, false)
  assert.deepEqual(kiroBearerValidator.calls, [{ apiKey: DEFAULT_SECRET, region: 'us-east-1' }])

  const models = await jsonRequest(`${baseUrl}/v1/models`, API_TOKEN)
  assert.equal(models.response.status, 200)
  assert.deepEqual(models.payload.data.map((model) => model.id), ['kiro-main/auto'])

  const completion = await jsonRequest(`${baseUrl}/v1/chat/completions`, API_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      model: 'kiro-main/auto',
      messages: [
        { role: 'system', content: 'Follow system.' },
        { role: 'developer', content: 'Follow developer.' },
        { role: 'user', content: 'First question.' },
        { role: 'assistant', content: 'Earlier answer.' },
        { role: 'user', content: [{ type: 'text', text: 'Final question.' }] },
      ],
    }),
  })
  assert.equal(completion.response.status, 200)
  assert.match(completion.response.headers.get('x-request-id') ?? '', /^req_/)
  assert.match(completion.payload.id, /^chatcmpl_/)
  assert.equal(completion.payload.object, 'chat.completion')
  assert.equal(completion.payload.model, 'kiro-main/auto')
  assert.equal(typeof completion.payload.created, 'number')
  assert.deepEqual(completion.payload.choices, [{
    index: 0,
    message: { role: 'assistant', content: 'hello over HTTPS' },
    finish_reason: 'stop',
  }])
  assert.deepEqual(completion.payload.usage, {
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 2 },
  })

  const nonStreamCall = kiroHttpClient.calls[0]
  assert.equal(nonStreamCall.apiKey, DEFAULT_SECRET)
  assert.equal(nonStreamCall.region, 'us-east-1')
  assert.equal(nonStreamCall.profileArn, profileArn('us-east-1', DEFAULT_SECRET))
  assert.equal(nonStreamCall.systemPrompt, '[system]\nFollow system.\n\n[developer]\nFollow developer.')
  assert.deepEqual(nonStreamCall.messages, [
    { role: 'user', text: 'First question.' },
    { role: 'assistant', text: 'Earlier answer.' },
    { role: 'user', text: 'Final question.' },
  ])

  const streamed = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders(API_TOKEN, true),
    body: JSON.stringify({
      model: 'kiro-main/auto',
      messages: [{ role: 'user', content: 'STREAM_RESPONSE' }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  assert.equal(streamed.status, 200)
  assert.match(streamed.headers.get('content-type') ?? '', /text\/event-stream/)
  const events = parseSse(await streamed.text())
  assert.equal(events.at(-1), '[DONE]')
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event))
  assert.equal(chunks.every((chunk) => chunk.object === 'chat.completion.chunk'), true)
  assert.deepEqual(chunks[0].choices, [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])
  assert.deepEqual(chunks.slice(1, -1).map((chunk) => chunk.choices[0].delta.content), [
    'streamed ',
    'over HTTPS',
  ])
  assert.deepEqual(chunks.at(-1).choices, [{ index: 0, delta: {}, finish_reason: 'stop' }])
  assert.deepEqual(chunks.at(-1).usage, {
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 2 },
  })
  assert.equal(chunks.slice(0, -1).some((chunk) => 'usage' in chunk), false)
})

test('Kiro region, profile ARN, and rotated credential flow through validation and inference', async (t) => {
  const { baseUrl, kiroBearerValidator, kiroHttpClient } = await setupGateway(t)
  await createKiroConnection(baseUrl)

  const regional = await jsonRequest(`${baseUrl}/admin/connections/kiro-main`, ADMIN_TOKEN, {
    method: 'PATCH',
    body: JSON.stringify({ region: 'eu-central-1' }),
  })
  assert.equal(regional.response.status, 200, JSON.stringify(regional.payload))
  assert.equal(regional.payload.data.region, 'eu-central-1')
  assert.equal(regional.payload.data.profileArn, profileArn('eu-central-1', DEFAULT_SECRET))
  assert.deepEqual(kiroBearerValidator.calls.at(-1), {
    apiKey: DEFAULT_SECRET,
    region: 'eu-central-1',
  })

  const rotatedSecret = 'ksk_rotated_https_fixture'
  const rotated = await jsonRequest(`${baseUrl}/admin/connections/kiro-main`, ADMIN_TOKEN, {
    method: 'PATCH',
    body: JSON.stringify({ apiKey: rotatedSecret }),
  })
  assert.equal(rotated.response.status, 200, JSON.stringify(rotated.payload))
  assert.equal(rotated.payload.data.region, 'eu-central-1')
  assert.equal(rotated.payload.data.profileArn, profileArn('eu-central-1', rotatedSecret))
  assert.equal('apiKey' in rotated.payload.data, false)
  assert.deepEqual(kiroBearerValidator.calls.at(-1), {
    apiKey: rotatedSecret,
    region: 'eu-central-1',
  })

  const completion = await jsonRequest(`${baseUrl}/v1/chat/completions`, API_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      model: 'kiro-main/auto',
      messages: [{ role: 'user', content: 'use rotated credential' }],
    }),
  })
  assert.equal(completion.response.status, 200)
  assert.equal(kiroHttpClient.calls.length, 1)
  assert.equal(kiroHttpClient.calls[0].apiKey, rotatedSecret)
  assert.equal(kiroHttpClient.calls[0].region, 'eu-central-1')
  assert.equal(kiroHttpClient.calls[0].profileArn, profileArn('eu-central-1', rotatedSecret))
})

test('unsupported Kiro OpenAI features fail before HTTPS inference', async (t) => {
  const { baseUrl, kiroHttpClient } = await setupGateway(t)
  await createKiroConnection(baseUrl)

  const cases = [
    {
      path: '/v1/chat/completions',
      body: {
        model: 'kiro-main/auto',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'lookup' } }],
      },
      code: 'kiro_tools_unsupported',
    },
    {
      path: '/v1/chat/completions',
      body: {
        model: 'kiro-main/auto',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x' } }] }],
      },
      code: 'kiro_text_only',
    },
    {
      path: '/v1/chat/completions',
      body: {
        model: 'kiro-main/auto',
        messages: [{ role: 'user', content: 'hi' }],
        n: 2,
      },
      code: 'kiro_single_choice_only',
    },
    {
      path: '/v1/chat/completions',
      body: {
        model: 'kiro-main/auto',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema' },
      },
      code: 'kiro_response_format_unsupported',
    },
    {
      path: '/v1/completions',
      body: { model: 'kiro-main/auto', prompt: 'hi' },
      code: 'kiro_completions_unsupported',
    },
    {
      path: '/v1/embeddings',
      body: { model: 'kiro-main/auto', input: 'hi' },
      code: 'kiro_embeddings_unsupported',
    },
  ]

  for (const entry of cases) {
    const result = await jsonRequest(`${baseUrl}${entry.path}`, API_TOKEN, {
      method: 'POST',
      body: JSON.stringify(entry.body),
    })
    assert.equal(result.response.status, 400, JSON.stringify(result.payload))
    assert.equal(result.payload.error.type, 'invalid_request_error')
    assert.equal(result.payload.error.code, entry.code)
  }
  assert.deepEqual(kiroHttpClient.calls, [])
})

test('rejected Kiro validation is atomic for creates and credential rotations', async (t) => {
  const { baseUrl, gatewayDataDir, kiroBearerValidator, kiroHttpClient } = await setupGateway(t)

  const rejectedCreate = await jsonRequest(`${baseUrl}/admin/connections`, ADMIN_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      id: 'kiro-rejected',
      name: 'Rejected Kiro',
      kind: 'kiro-cli',
      authMode: 'api-key',
      apiKey: 'ksk_rejected_create_secret',
      region: 'us-east-1',
      models: ['auto'],
      enabled: true,
    }),
  })
  assert.equal(rejectedCreate.response.status, 401)
  assert.equal(rejectedCreate.payload.error.code, 'kiro_auth_failed')
  const afterRejectedCreate = await jsonRequest(`${baseUrl}/admin/connections`, ADMIN_TOKEN)
  assert.deepEqual(afterRejectedCreate.payload.data, [])

  await createKiroConnection(baseUrl, { region: 'eu-central-1' })
  const connectionPath = join(gatewayDataDir, 'connections.json')
  const beforeRotation = await readFile(connectionPath, 'utf8')

  const rejectedRotation = await jsonRequest(`${baseUrl}/admin/connections/kiro-main`, ADMIN_TOKEN, {
    method: 'PATCH',
    body: JSON.stringify({
      name: 'Must Not Persist',
      apiKey: 'ksk_rejected_rotation_secret',
      region: 'us-east-1',
    }),
  })
  assert.equal(rejectedRotation.response.status, 401)
  assert.equal(rejectedRotation.payload.error.code, 'kiro_auth_failed')
  assert.equal(await readFile(connectionPath, 'utf8'), beforeRotation)

  const afterRejectedRotation = await jsonRequest(`${baseUrl}/admin/connections`, ADMIN_TOKEN)
  assert.equal(afterRejectedRotation.payload.data.length, 1)
  assert.equal(afterRejectedRotation.payload.data[0].name, 'Kiro Main')
  assert.equal(afterRejectedRotation.payload.data[0].region, 'eu-central-1')
  assert.equal(afterRejectedRotation.payload.data[0].profileArn, profileArn('eu-central-1', DEFAULT_SECRET))

  const completion = await jsonRequest(`${baseUrl}/v1/chat/completions`, API_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      model: 'kiro-main/auto',
      messages: [{ role: 'user', content: 'verify atomic credential' }],
    }),
  })
  assert.equal(completion.response.status, 200)
  assert.equal(kiroHttpClient.calls[0].apiKey, DEFAULT_SECRET)
  assert.equal(kiroHttpClient.calls[0].region, 'eu-central-1')
  assert.equal(kiroBearerValidator.calls.some((call) => call.apiKey === 'ksk_rejected_create_secret'), true)
  assert.equal(kiroBearerValidator.calls.some((call) => call.apiKey === 'ksk_rejected_rotation_secret'), true)
})

test('Kiro secret is never exposed by APIs or persisted in plaintext', async (t) => {
  const { baseUrl, gatewayDataDir } = await setupGateway(t)
  const secret = 'ksk_gateway_https_super_secret'
  const created = await createKiroConnection(baseUrl, {
    id: 'kiro-keyed',
    name: 'Kiro Keyed',
    apiKey: secret,
  })
  assert.equal(created.hasApiKey, true)
  assert.equal('apiKey' in created, false)
  assert.equal(JSON.stringify(created).includes(secret), false)

  const listed = await jsonRequest(`${baseUrl}/admin/connections`, ADMIN_TOKEN)
  assert.equal(JSON.stringify(listed.payload).includes(secret), false)
  assert.equal('apiKey' in listed.payload.data[0], false)

  const tested = await jsonRequest(`${baseUrl}/admin/connections/kiro-keyed/test`, ADMIN_TOKEN, {
    method: 'POST',
  })
  assert.equal(tested.response.status, 200)
  assert.deepEqual(tested.payload.data.models, ['auto'])
  assert.equal(tested.payload.data.credentialType, 'bearer')
  assert.equal(JSON.stringify(tested.payload).includes(secret), false)

  const completion = await jsonRequest(`${baseUrl}/v1/chat/completions`, API_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      model: 'kiro-keyed/auto',
      messages: [{ role: 'user', content: 'do not expose credentials' }],
    }),
  })
  assert.equal(completion.response.status, 200)
  assert.equal(JSON.stringify(completion.payload).includes(secret), false)

  const persistedText = await readFile(join(gatewayDataDir, 'connections.json'), 'utf8')
  assert.equal(persistedText.includes(secret), false)
  const persisted = JSON.parse(persistedText).connections[0]
  assert.equal('apiKey' in persisted, false)
  assert.equal(typeof persisted.encryptedApiKey, 'object')
  assert.equal(typeof persisted.encryptedApiKey.ciphertext, 'string')
})

test('aborting a Kiro /v1 stream aborts HTTPS inference', async (t) => {
  const { baseUrl, kiroHttpClient } = await setupGateway(t)
  await createKiroConnection(baseUrl)

  const abortController = new AbortController()
  const streamed = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders(API_TOKEN, true),
    body: JSON.stringify({
      model: 'kiro-main/auto',
      messages: [{ role: 'user', content: 'WAIT_FOR_CANCEL' }],
      stream: true,
    }),
    signal: abortController.signal,
  })
  assert.equal(streamed.status, 200)
  const reader = streamed.body.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  assert.match(Buffer.from(first.value).toString('utf8'), /chat\.completion\.chunk/)
  await waitFor(() => kiroHttpClient.calls.length === 1)

  abortController.abort()
  await assert.rejects(reader.read(), /abort/i)
  await waitFor(() => kiroHttpClient.calls[0].aborted)
  assert.equal(kiroHttpClient.calls[0].signal.aborted, true)
})

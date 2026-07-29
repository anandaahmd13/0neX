import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import WebSocket from 'ws'
import { createGatewayServer } from '../server/gateway-server.mjs'
import { createKiroRunner } from '../server/gateway/kiro-runner.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(TEST_DIR, 'fixtures', 'kiro-cli-fixture.mjs')
const MASTER_KEY = '0123456789abcdef0123456789abcdef'
const ORIGIN = 'http://localhost:5199'
const WS_TOKEN = 'gateway-ws-kiro-test'

async function setupGateway(t, mode = 'normal', { playgroundApiKey = 'ksk_playground_fixture' } = {}) {
  const root = await mkdtemp(join(tmpdir(), '0nex-kiro-gateway-'))
  const recordFile = join(root, 'fixture.jsonl')
  const runnerDataDir = join(root, 'runner-data')
  const gatewayDataDir = join(root, 'gateway-data')
  const runnerEnv = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    KIRO_FIXTURE_MODE: mode,
    KIRO_FIXTURE_RECORD: recordFile,
  }
  const kiroRunner = createKiroRunner({
    executable: FIXTURE,
    env: runnerEnv,
    dataDir: runnerDataDir,
    timeoutMs: 2_000,
    killGraceMs: 30,
    maxOutputBytes: 100_000,
  })
  const gateway = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: gatewayDataDir,
    wsToken: WS_TOKEN,
    apiKey: 'gateway-api-test',
    adminToken: 'gateway-admin-test',
    masterKey: MASTER_KEY,
    allowedOrigins: [ORIGIN],
    allowInsecureLocalhost: true,
    kiroRunner,
    env: { ...process.env, KIRO_API_KEY: playgroundApiKey },
  })
  const address = await gateway.listen()
  t.after(() => gateway.close())
  return {
    recordFile,
    runnerDataDir,
    gatewayDataDir,
    baseUrl: `http://127.0.0.1:${address.port}`,
    url: `ws://127.0.0.1:${address.port}/?token=${WS_TOKEN}`,
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

async function createKiroConnection(baseUrl, body) {
  const result = await jsonRequest(`${baseUrl}/admin/connections`, 'gateway-admin-test', {
    method: 'POST',
    body: JSON.stringify({
      id: 'kiro-main',
      name: 'Kiro Main',
      kind: 'kiro-cli',
      authMode: 'api-key',
      apiKey: 'ksk_connection_fixture',
      models: ['auto'],
      enabled: true,
      ...body,
    }),
  })
  assert.equal(result.response.status, 201, JSON.stringify(result.payload))
  return result.payload.data
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  throw new Error('Timeout menunggu kondisi fixture')
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

async function fixtureRecords(path) {
  const raw = await readFile(path, 'utf8')
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('Kiro Playground runs headless with buffered output and no resumable session', async (t) => {
  const { url, recordFile } = await setupGateway(t)
  const client = connect(url)
  t.after(() => client.socket.close())
  await client.opened

  const hello = await client.next((message) => message.type === 'hello')
  assert.equal(hello.providers.some((provider) => provider.id === 'claude-cli'), true)
  const kiro = hello.providers.find((provider) => provider.id === 'kiro-cli')
  assert.deepEqual(kiro.capabilities, {
    streaming: false,
    sessions: false,
    cancellation: true,
    tools: false,
  })

  client.socket.send(JSON.stringify(runMessage()))
  const correlation = await client.next(
    (message) => message.type === 'session' && message.sessionId === 'correlation-session',
  )
  assert.equal(correlation.providerId, 'kiro-cli')
  const chunk = await client.next((message) => message.type === 'chunk')
  assert.equal(chunk.text, 'hello from fixture')
  const done = await client.next((message) => message.type === 'done')
  assert.deepEqual(done, {
    type: 'done',
    providerId: 'kiro-cli',
    code: 0,
    reason: 'completed',
    sessionId: null,
    usage: null,
  })

  const records = await fixtureRecords(recordFile)
  assert.equal(records.some((entry) => entry.type === 'rpc'), false)
  const spawn = records.find((entry) => entry.type === 'spawn')
  assert.deepEqual(spawn.args.slice(0, 2), ['chat', '--no-interactive'])
  assert.equal(spawn.apiKeyPresent, true)
  assert.equal(records.find((entry) => entry.type === 'headless-input').input, [
    '<system-instructions>',
    'answer briefly',
    '</system-instructions>',
    '',
    'hello',
  ].join('\n'))

  client.socket.send(JSON.stringify(runMessage({ sessionId: '../unsafe-session', resume: true })))
  const unsafe = await client.next((message) => message.type === 'error')
  assert.match(unsafe.text, /sessionId.*separator path/)
})

test('Kiro Playground requires KIRO_API_KEY and does not spawn CLI when missing', async (t) => {
  const { url, recordFile } = await setupGateway(t, 'normal', { playgroundApiKey: '' })
  const client = connect(url)
  t.after(() => client.socket.close())
  await client.opened
  await client.next((message) => message.type === 'hello')

  client.socket.send(JSON.stringify(runMessage()))
  await client.next(
    (message) => message.type === 'session' && message.sessionId === 'correlation-session',
  )
  const error = await client.next((message) => message.type === 'error')
  assert.match(error.text, /KIRO_API_KEY wajib diisi/)
  await assert.rejects(readFile(recordFile, 'utf8'), { code: 'ENOENT' })
})

test('Kiro Playground cancellation terminates the headless process', async (t) => {
  const { url, recordFile } = await setupGateway(t, 'cancel')
  const client = connect(url)
  t.after(() => client.socket.close())
  await client.opened
  await client.next((message) => message.type === 'hello')

  client.socket.send(JSON.stringify(runMessage()))
  await client.next(
    (message) => message.type === 'session' && message.sessionId === 'correlation-session',
  )
  await waitFor(async () => {
    try {
      return (await fixtureRecords(recordFile)).some((entry) => entry.type === 'headless-input')
    } catch {
      return false
    }
  })
  client.socket.send(JSON.stringify({ type: 'cancel' }))

  const done = await client.next((message) => message.type === 'done')
  assert.equal(done.reason, 'cancelled')
  assert.equal(done.code, null)
  assert.equal(done.sessionId, null)
  assert.equal(done.usage, null)

  await waitFor(async () => {
    const records = await fixtureRecords(recordFile)
    return records.some((entry) => entry.type === 'signal' && entry.signal === 'SIGTERM')
  })
})

test('Kiro HTTP connection validates auth and serves buffered OpenAI chat with Auto model', async (t) => {
  const { baseUrl, recordFile, gatewayDataDir } = await setupGateway(t)
  const created = await createKiroConnection(baseUrl)
  assert.equal(created.kind, 'kiro-cli')
  assert.equal(created.authMode, 'api-key')
  assert.equal(created.hasApiKey, true)
  assert.equal('baseUrl' in created, false)
  assert.equal('apiKey' in created, false)

  const tested = await jsonRequest(`${baseUrl}/admin/connections/kiro-main/test`, 'gateway-admin-test', {
    method: 'POST',
  })
  assert.equal(tested.response.status, 200)
  assert.deepEqual(tested.payload.data, {
    ok: true,
    models: ['auto'],
  })

  const models = await jsonRequest(`${baseUrl}/v1/models`, 'gateway-api-test')
  assert.equal(models.response.status, 200)
  assert.deepEqual(models.payload.data.map((model) => model.id), [
    'kiro-main/auto',
  ])

  const completion = await jsonRequest(`${baseUrl}/v1/chat/completions`, 'gateway-api-test', {
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
  assert.equal(completion.payload.object, 'chat.completion')
  assert.equal(completion.payload.model, 'kiro-main/auto')
  assert.deepEqual(completion.payload.choices, [{
    index: 0,
    message: { role: 'assistant', content: 'hello from fixture' },
    finish_reason: 'stop',
  }])
  assert.equal('usage' in completion.payload, false)

  const streamed = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders('gateway-api-test', true),
    body: JSON.stringify({
      model: 'kiro-main/auto',
      messages: [{ role: 'user', content: 'Stream this.' }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  assert.equal(streamed.status, 200)
  assert.match(streamed.headers.get('content-type') ?? '', /text\/event-stream/)
  const streamText = await streamed.text()
  assert.match(streamText, /"object":"chat\.completion\.chunk"/)
  assert.match(streamText, /"content":"hello from fixture"/)
  assert.match(streamText, /"finish_reason":"stop"/)
  assert.match(streamText, /data: \[DONE\]\n\n$/)
  assert.equal(streamText.includes('usage'), false)

  const records = await fixtureRecords(recordFile)
  const inputs = records
    .filter((entry) => entry.type === 'headless-input')
    .map((entry) => entry.input)
  assert.equal(inputs[0], [
    '<system-instructions>',
    '[system]\nFollow system.\n\n[developer]\nFollow developer.',
    '</system-instructions>',
    '',
    '[user]\nFirst question.\n\n[assistant]\nEarlier answer.\n\n[user]\nFinal question.',
  ].join('\n'))
  const headlessSpawn = records.find(
    (entry) => entry.type === 'spawn' && entry.args.includes('--no-interactive'),
  )
  assert.equal(
    await realpath(headlessSpawn.cwd),
    await realpath(join(gatewayDataDir, 'kiro', 'inference', 'kiro-main')),
  )
  assert.notEqual(headlessSpawn.cwd, process.cwd())
  assert.equal(records.filter((entry) => entry.type === 'spawn').every((entry) => entry.apiKeyPresent), true)
})

test('Kiro HTTP connection rejects unsupported OpenAI features without invoking runner', async (t) => {
  const { baseUrl, recordFile } = await setupGateway(t)
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
    const result = await jsonRequest(`${baseUrl}${entry.path}`, 'gateway-api-test', {
      method: 'POST',
      body: JSON.stringify(entry.body),
    })
    assert.equal(result.response.status, 400, JSON.stringify(result.payload))
    assert.equal(result.payload.error.type, 'invalid_request_error')
    assert.equal(result.payload.error.code, entry.code)
  }

  await assert.rejects(readFile(recordFile, 'utf8'), { code: 'ENOENT' })
})

test('Kiro API-key connection isolates and redacts its secret across admin, runner, and logs', async (t) => {
  const { baseUrl, recordFile, runnerDataDir, gatewayDataDir } = await setupGateway(t)
  const secret = 'ksk_gateway_fixture_super_secret'
  const created = await createKiroConnection(baseUrl, {
    id: 'kiro-keyed',
    name: 'Kiro Keyed',
    authMode: 'api-key',
    apiKey: secret,
    models: ['auto'],
  })
  assert.equal(created.hasApiKey, true)
  assert.equal(JSON.stringify(created).includes(secret), false)
  assert.equal('apiKey' in created, false)

  const tested = await jsonRequest(`${baseUrl}/admin/connections/kiro-keyed/test`, 'gateway-admin-test', {
    method: 'POST',
  })
  assert.equal(tested.response.status, 200)
  assert.equal(JSON.stringify(tested.payload).includes(secret), false)

  const completion = await jsonRequest(`${baseUrl}/v1/chat/completions`, 'gateway-api-test', {
    method: 'POST',
    body: JSON.stringify({
      model: 'kiro-keyed/auto',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(completion.response.status, 200)
  assert.equal(JSON.stringify(completion.payload).includes(secret), false)

  const rawRecords = await readFile(recordFile, 'utf8')
  assert.equal(rawRecords.includes(secret), false)
  const records = await fixtureRecords(recordFile)
  const spawns = records.filter((entry) => entry.type === 'spawn')
  assert.equal(spawns.length >= 2, true)
  assert.equal(spawns.every((entry) => entry.apiKeyPresent), true)
  assert.equal(spawns.every((entry) => entry.args.every((arg) => !arg.includes(secret))), true)
  assert.equal(spawns.every((entry) => entry.home.startsWith(join(runnerDataDir, 'kiro', 'api-key') + '/')), true)
  const persisted = await readFile(join(gatewayDataDir, 'connections.json'), 'utf8')
  assert.equal(persisted.includes(secret), false)
})

test('Kiro HTTP stream abort terminates the headless process', async (t) => {
  const { baseUrl, recordFile } = await setupGateway(t, 'cancel')
  await createKiroConnection(baseUrl)

  const abortController = new AbortController()
  const streamed = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders('gateway-api-test', true),
    body: JSON.stringify({
      model: 'kiro-main/auto',
      messages: [{ role: 'user', content: 'wait' }],
      stream: true,
    }),
    signal: abortController.signal,
  })
  assert.equal(streamed.status, 200)
  const reader = streamed.body.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  await waitFor(async () => {
    try {
      return (await fixtureRecords(recordFile)).some((entry) => entry.type === 'headless-input')
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  })
  abortController.abort()
  await assert.rejects(reader.read(), /abort/i)

  await waitFor(async () => {
    const records = await fixtureRecords(recordFile)
    return records.some((entry) => entry.type === 'signal' && entry.signal === 'SIGTERM')
  })
})

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGatewayServer } from '../server/gateway-server.mjs'
import { parseGatewayModel } from '../server/gateway/openai-compatible.mjs'

const MASTER_KEY = '0123456789abcdef0123456789abcdef'
const API_KEY = 'gateway-api-test'
const ADMIN_TOKEN = 'gateway-admin-test'
const ORIGIN = 'http://localhost:5199'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address())
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function jsonRequest(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const payload = await response.json()
  return { response, payload }
}

test('gateway model parser preserves nested upstream model IDs', () => {
  assert.deepEqual(parseGatewayModel('openrouter/anthropic/claude-sonnet-4'), {
    connectionId: 'openrouter',
    upstreamModel: 'anthropic/claude-sonnet-4',
  })
  assert.throws(() => parseGatewayModel('missing-prefix'), /format/)
})

test('gateway refuses to start without a valid master key', () => {
  assert.throws(
    () => createGatewayServer({ port: 0, masterKey: 'short', apiKey: API_KEY, adminToken: ADMIN_TOKEN }),
    /GATEWAY_MASTER_KEY/,
  )
})

test('admin surface rejects requests without an allowed Origin and supports session login', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), '0nex-gateway-auth-test-'))
  const gateway = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    wsToken: 'gateway-ws-test',
    apiKey: API_KEY,
    adminToken: ADMIN_TOKEN,
    masterKey: MASTER_KEY,
    dashboardPassword: 'dashboard-secret',
    allowedOrigins: [ORIGIN],
    allowInsecureLocalhost: true,
  })
  const address = await gateway.listen()
  t.after(() => gateway.close())
  const baseUrl = `http://127.0.0.1:${address.port}`

  // Tanpa Origin (curl/SDK) admin ditolak walau bawa admin token.
  const noOrigin = await fetch(`${baseUrl}/admin/connections`, {
    headers: { authorization: ['Bea', 'rer '].join('') + ADMIN_TOKEN },
  })
  assert.equal(noOrigin.status, 403)

  // Dengan Origin diizinkan + admin token → lolos (jalur skrip/CI).
  const withToken = await jsonRequest(`${baseUrl}/admin/connections`, ADMIN_TOKEN)
  assert.equal(withToken.response.status, 200)

  // Login salah password ditolak.
  const badLogin = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'salah' }),
  })
  assert.equal(badLogin.status, 401)

  // Login benar → set cookie sesi httpOnly.
  const login = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'dashboard-secret' }),
  })
  assert.equal(login.status, 200)
  const setCookie = login.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /gw_session=/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  const cookie = setCookie.split(';')[0]

  // Cookie sesi bisa dipakai akses admin tanpa bearer token.
  const viaCookie = await fetch(`${baseUrl}/admin/connections`, {
    headers: { origin: ORIGIN, cookie },
  })
  assert.equal(viaCookie.status, 200)

  // Cookie sampah ditolak.
  const forged = await fetch(`${baseUrl}/admin/connections`, {
    headers: { origin: ORIGIN, cookie: 'gw_session=payload.tandatanganpalsu' },
  })
  assert.equal(forged.status, 401)
})

test('OpenAI-compatible and admin routes work end-to-end', async (t) => {
  const upstreamRequests = []
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://upstream.local')
    if (url.pathname === '/v1/models') {
      assert.equal(request.headers.authorization, 'Bearer sk-upstream-secret')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'model-a' }, { id: 'org/model-b' }] }))
      return
    }

    if (url.pathname === '/v1/chat/completions') {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      upstreamRequests.push({ body, authorization: request.headers.authorization })
      assert.equal(request.headers.authorization, 'Bearer sk-upstream-secret')
      assert.equal(body.model, body.stream ? 'org/model-b' : 'model-a')

      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ id: 'chat-2', choices: [{ delta: { content: 'hi' } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ id: 'chat-2', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }

      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'chat-1',
        object: 'chat.completion',
        model: 'model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }))
      return
    }

    response.writeHead(404).end()
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))

  const dataDir = await mkdtemp(join(tmpdir(), '0nex-gateway-api-test-'))
  const gateway = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    wsToken: 'gateway-ws-test',
    apiKey: API_KEY,
    adminToken: ADMIN_TOKEN,
    masterKey: MASTER_KEY,
    allowedOrigins: [ORIGIN],
    allowInsecureLocalhost: true,
  })
  const gatewayAddress = await gateway.listen()
  t.after(() => gateway.close())
  const baseUrl = `http://127.0.0.1:${gatewayAddress.port}`
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}/v1`

  const unauthorized = await jsonRequest(`${baseUrl}/admin/connections`, 'wrong-token')
  assert.equal(unauthorized.response.status, 401)

  const forbiddenOrigin = await fetch(`${baseUrl}/v1/models`, {
    headers: { origin: 'https://evil.example', authorization: `Bearer ${API_KEY}` },
  })
  assert.equal(forbiddenOrigin.status, 403)

  const created = await jsonRequest(`${baseUrl}/admin/connections`, ADMIN_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      id: 'local-provider',
      name: 'Local Provider',
      baseUrl: upstreamBaseUrl,
      apiKey: 'sk-upstream-secret',
      models: ['model-a', 'org/model-b'],
      enabled: true,
    }),
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.payload.data.hasApiKey, true)
  assert.equal('apiKey' in created.payload.data, false)

  const tested = await jsonRequest(`${baseUrl}/admin/connections/local-provider/test`, ADMIN_TOKEN, {
    method: 'POST',
  })
  assert.equal(tested.response.status, 200)
  assert.deepEqual(tested.payload.data.models, ['model-a', 'org/model-b'])

  const models = await jsonRequest(`${baseUrl}/v1/models`, API_KEY)
  assert.equal(models.response.status, 200)
  assert.deepEqual(models.payload.data.map((model) => model.id), [
    'local-provider/model-a',
    'local-provider/org/model-b',
  ])

  const completion = await jsonRequest(`${baseUrl}/v1/chat/completions`, API_KEY, {
    method: 'POST',
    body: JSON.stringify({
      model: 'local-provider/model-a',
      messages: [{ role: 'user', content: 'hello secret prompt' }],
    }),
  })
  assert.equal(completion.response.status, 200)
  assert.equal(completion.payload.choices[0].message.content, 'hello')

  const streamed = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'local-provider/org/model-b',
      messages: [{ role: 'user', content: 'stream this secret prompt' }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  assert.equal(streamed.status, 200)
  const streamText = await streamed.text()
  assert.match(streamText, /data: \[DONE\]/)
  assert.match(streamText, /"total_tokens":10/)

  const usage = await jsonRequest(`${baseUrl}/admin/usage?range=24h`, ADMIN_TOKEN)
  assert.equal(usage.response.status, 200)
  assert.equal(usage.payload.data.summary.requests, 2)
  assert.equal(usage.payload.data.summary.successes, 2)
  assert.equal(usage.payload.data.summary.totalTokens, 16)
  assert.equal(usage.payload.data.summary.knownTokenRequests, 2)
  assert.equal(upstreamRequests.length, 2)

  const usageFile = await gateway.usageStore.readRecent()
  assert.equal(JSON.stringify(usageFile).includes('secret prompt'), false)
})

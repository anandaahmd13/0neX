import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGatewayServer } from '../server/gateway-server.mjs'
import { resolveModelCandidates } from '../server/gateway/openai-compatible.mjs'

const MASTER_KEY = '0123456789abcdef0123456789abcdef'
const API_KEY = 'gateway-api-test'
const ADMIN_TOKEN = 'gateway-admin-test'
const ORIGIN = 'http://localhost:5199'

function authHeader(token) {
  return ['Bea', 'rer '].join('') + token
}

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

test('resolveModelCandidates: explicit connection/model + failover peers', () => {
  const connections = [
    { id: 'primary', enabled: true, models: ['gpt-4o'] },
    { id: 'backup', enabled: true, models: ['gpt-4o'] },
    { id: 'other', enabled: true, models: ['llama'] },
  ]
  const { candidates } = resolveModelCandidates('primary/gpt-4o', { connections })
  assert.deepEqual(candidates, [
    { connectionId: 'primary', upstreamModel: 'gpt-4o' },
    { connectionId: 'backup', upstreamModel: 'gpt-4o' },
  ])
})

test('resolveModelCandidates: bare model spans all exposing connections', () => {
  const connections = [
    { id: 'a', enabled: true, models: ['gpt-4o'] },
    { id: 'b', enabled: true, models: ['gpt-4o', 'other'] },
    { id: 'c', enabled: false, models: ['gpt-4o'] },
  ]
  const { candidates } = resolveModelCandidates('gpt-4o', { connections })
  assert.deepEqual(candidates.map((c) => c.connectionId), ['a', 'b'])
})

test('resolveModelCandidates: alias expansion', () => {
  const connections = [{ id: 'openrouter', enabled: true, models: ['openai/gpt-4o'] }]
  const aliases = { fast: 'openrouter/openai/gpt-4o' }
  const { candidates, resolvedModel } = resolveModelCandidates('fast', { aliases, connections })
  assert.equal(resolvedModel, 'openrouter/openai/gpt-4o')
  assert.deepEqual(candidates, [{ connectionId: 'openrouter', upstreamModel: 'openai/gpt-4o' }])
})

test('gateway failover: primary 503 falls back to backup connection', async (t) => {
  // Dua upstream palsu: primary selalu 503, backup sukses.
  let primaryHits = 0
  let backupHits = 0
  const primary = createServer((req, res) => {
    primaryHits += 1
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'overloaded' } }))
  })
  const backup = createServer(async (req, res) => {
    backupHits += 1
    let raw = ''
    for await (const chunk of req) raw += chunk
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chat-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'from-backup' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }))
  })
  const primaryAddr = await listen(primary)
  const backupAddr = await listen(backup)
  t.after(() => close(primary))
  t.after(() => close(backup))

  const dataDir = await mkdtemp(join(tmpdir(), '0nex-failover-'))
  const gateway = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    apiKey: API_KEY,
    adminToken: ADMIN_TOKEN,
    masterKey: MASTER_KEY,
    allowedOrigins: [ORIGIN],
    allowInsecureLocalhost: true,
  })
  const addr = await gateway.listen()
  t.after(() => gateway.close())
  const baseUrl = `http://127.0.0.1:${addr.port}`

  async function createConnection(id, upstreamPort) {
    const res = await fetch(`${baseUrl}/admin/connections`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: authHeader(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        name: id,
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'sk-test',
        models: ['gpt-4o'],
        enabled: true,
      }),
    })
    assert.equal(res.status, 201)
  }
  await createConnection('primary', primaryAddr.port)
  await createConnection('backup', backupAddr.port)

  // Panggil bare model → kandidat primary lalu backup. Primary 503 → failover.
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: authHeader(API_KEY), 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const payload = await res.json()
  assert.equal(res.status, 200)
  assert.equal(payload.choices[0].message.content, 'from-backup')
  assert.equal(primaryHits, 1)
  assert.equal(backupHits, 1)
})

test('gateway: /v1/completions and /v1/embeddings proxy through, /v1/models/{id} retrieves', async (t) => {
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://u.local')
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (url.pathname === '/v1/completions') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'cmpl-1', choices: [{ text: 'completion-ok' }], usage: { total_tokens: 4 } }))
      return
    }
    if (url.pathname === '/v1/embeddings') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }], usage: { total_tokens: 2 } }))
      return
    }
    res.writeHead(404).end()
  })
  const upstreamAddr = await listen(upstream)
  t.after(() => close(upstream))

  const dataDir = await mkdtemp(join(tmpdir(), '0nex-resources-'))
  const gateway = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    apiKey: API_KEY,
    adminToken: ADMIN_TOKEN,
    masterKey: MASTER_KEY,
    allowedOrigins: [ORIGIN],
    allowInsecureLocalhost: true,
  })
  const addr = await gateway.listen()
  t.after(() => gateway.close())
  const baseUrl = `http://127.0.0.1:${addr.port}`

  const created = await fetch(`${baseUrl}/admin/connections`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: authHeader(ADMIN_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'prov',
      name: 'prov',
      baseUrl: `http://127.0.0.1:${upstreamAddr.port}/v1`,
      apiKey: 'sk-test',
      models: ['gpt-4o', 'text-embedding-3-small'],
      enabled: true,
    }),
  })
  assert.equal(created.status, 201)

  const completions = await fetch(`${baseUrl}/v1/completions`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: authHeader(API_KEY), 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'prov/gpt-4o', prompt: 'hi' }),
  })
  const completionsPayload = await completions.json()
  assert.equal(completions.status, 200)
  assert.equal(completionsPayload.choices[0].text, 'completion-ok')

  const embeddings = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: authHeader(API_KEY), 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'prov/text-embedding-3-small', input: 'hi' }),
  })
  const embeddingsPayload = await embeddings.json()
  assert.equal(embeddings.status, 200)
  assert.ok(Array.isArray(embeddingsPayload.data))

  // Retrieve model yang ada.
  const retrieve = await fetch(`${baseUrl}/v1/models/${encodeURIComponent('prov/gpt-4o')}`, {
    headers: { origin: ORIGIN, authorization: authHeader(API_KEY) },
  })
  const retrievePayload = await retrieve.json()
  assert.equal(retrieve.status, 200)
  assert.equal(retrievePayload.id, 'prov/gpt-4o')

  // Retrieve model yang tidak ada → 404.
  const missing = await fetch(`${baseUrl}/v1/models/${encodeURIComponent('prov/tidak-ada')}`, {
    headers: { origin: ORIGIN, authorization: authHeader(API_KEY) },
  })
  assert.equal(missing.status, 404)
})

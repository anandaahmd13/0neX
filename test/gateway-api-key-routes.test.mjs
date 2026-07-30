import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGatewayServer } from '../server/gateway-server.mjs'

const MASTER_KEY = '0123456789abcdef0123456789abcdef'
const BOOTSTRAP_KEY = 'gateway-bootstrap-test'
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

async function admin(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  return { response, payload: await response.json().catch(() => null) }
}

async function callV1(baseUrl, path, key, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  return { response, payload: await response.json().catch(() => null) }
}

/** Upstream OpenAI-compatible tiruan: cukup untuk /v1/models dan chat. */
function stubUpstream() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://upstream.local')
    if (url.pathname === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'model-a' }] }))
      return
    }
    if (url.pathname === '/v1/chat/completions') {
      for await (const _chunk of request) { /* buang body */ }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'chat-1',
        object: 'chat.completion',
        model: 'model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }))
      return
    }
    response.writeHead(404).end()
  })
}

async function startGateway(t, overrides = {}) {
  const upstream = stubUpstream()
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))

  const dataDir = await mkdtemp(join(tmpdir(), '0nex-gateway-keys-route-'))
  const gateway = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    wsToken: 'gateway-ws-test',
    apiKey: BOOTSTRAP_KEY,
    adminToken: ADMIN_TOKEN,
    masterKey: MASTER_KEY,
    allowedOrigins: [ORIGIN],
    allowInsecureLocalhost: true,
    ...overrides,
  })
  const address = await gateway.listen()
  t.after(() => gateway.close())
  const baseUrl = `http://127.0.0.1:${address.port}`

  const created = await admin(baseUrl, '/admin/connections', {
    method: 'POST',
    body: JSON.stringify({
      id: 'local-provider',
      name: 'Local Provider',
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      apiKey: 'sk-upstream-secret',
      models: ['model-a'],
      enabled: true,
    }),
  })
  assert.equal(created.response.status, 201)
  return { gateway, baseUrl }
}

test('admin api-key CRUD issues plaintext once and never returns it again', async (t) => {
  const { baseUrl } = await startGateway(t)

  const empty = await admin(baseUrl, '/admin/api-keys')
  assert.equal(empty.response.status, 200)
  assert.deepEqual(empty.payload.data.keys, [])
  assert.deepEqual(empty.payload.data.scopes, ['models:read', 'chat:write'])

  const created = await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'OpenCode Laptop', scopes: ['models:read', 'chat:write'] }),
  })
  assert.equal(created.response.status, 201)
  const secret = created.payload.data.secret
  assert.match(secret, /^onex_sk_/)
  assert.match(created.payload.data.id, /^key_[a-f0-9]{16}$/)

  // Listing tidak boleh memuat plaintext lagi.
  const listed = await admin(baseUrl, '/admin/api-keys')
  assert.equal(listed.payload.data.keys.length, 1)
  assert.equal('secret' in listed.payload.data.keys[0], false)
  assert.equal(JSON.stringify(listed.payload).includes(secret), false)
  assert.equal(listed.payload.data.keys[0].maskedKey.includes('…'), true)

  // Rename + expiry lewat PATCH.
  const patched = await admin(baseUrl, `/admin/api-keys/${created.payload.data.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'OpenCode Desktop', scopes: ['models:read'] }),
  })
  assert.equal(patched.response.status, 200)
  assert.equal(patched.payload.data.name, 'OpenCode Desktop')
  assert.deepEqual(patched.payload.data.scopes, ['models:read'])

  // Validasi input ditolak dengan 400, bukan 500.
  const invalid = await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bad', scopes: ['admin:*'] }),
  })
  assert.equal(invalid.response.status, 400)

  const missing = await admin(baseUrl, '/admin/api-keys/key_0000000000000000', {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Nope' }),
  })
  assert.equal(missing.response.status, 404)

  // Admin API tetap wajib origin dashboard.
  const noOrigin = await fetch(`${baseUrl}/admin/api-keys`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  assert.equal(noOrigin.status, 403)
})

test('managed keys authenticate /v1 alongside the bootstrap key and enforce scopes', async (t) => {
  const { baseUrl } = await startGateway(t)

  const full = (await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'Full Access' }),
  })).payload.data
  const readOnly = (await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'Models Only', scopes: ['models:read'] }),
  })).payload.data

  // Bootstrap key dari env tetap berlaku.
  assert.equal((await callV1(baseUrl, '/v1/models', BOOTSTRAP_KEY)).response.status, 200)

  // Managed key penuh: baca model + inference.
  assert.equal((await callV1(baseUrl, '/v1/models', full.secret)).response.status, 200)
  const chat = await callV1(baseUrl, '/v1/chat/completions', full.secret, {
    method: 'POST',
    body: JSON.stringify({
      model: 'local-provider/model-a',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  assert.equal(chat.response.status, 200)
  assert.equal(chat.payload.choices[0].message.content, 'ok')

  // Scope models:read tidak boleh dipakai untuk inference.
  assert.equal((await callV1(baseUrl, '/v1/models', readOnly.secret)).response.status, 200)
  const denied = await callV1(baseUrl, '/v1/chat/completions', readOnly.secret, {
    method: 'POST',
    body: JSON.stringify({
      model: 'local-provider/model-a',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  assert.equal(denied.response.status, 403)
  assert.equal(denied.payload.error.code, 'insufficient_scope')

  // Key sampah ditolak.
  const bogus = await callV1(baseUrl, '/v1/models', 'onex_sk_bogus')
  assert.equal(bogus.response.status, 401)
  assert.equal(bogus.payload.error.code, 'invalid_api_key')
})

test('revoke, disable, expiry, and rotate take effect on /v1 immediately', async (t) => {
  const { baseUrl } = await startGateway(t)

  const revoked = (await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'To Revoke' }),
  })).payload.data
  assert.equal((await callV1(baseUrl, '/v1/models', revoked.secret)).response.status, 200)

  const revokeResult = await admin(baseUrl, `/admin/api-keys/${revoked.id}?mode=revoke`, {
    method: 'DELETE',
  })
  assert.equal(revokeResult.response.status, 200)
  assert.equal(typeof revokeResult.payload.data.revokedAt, 'string')
  assert.equal((await callV1(baseUrl, '/v1/models', revoked.secret)).response.status, 401)
  // mode=revoke menyimpan record untuk jejak audit.
  assert.equal((await admin(baseUrl, '/admin/api-keys')).payload.data.keys.length, 1)

  const disabled = (await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'To Disable' }),
  })).payload.data
  await admin(baseUrl, `/admin/api-keys/${disabled.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  })
  const disabledCall = await callV1(baseUrl, '/v1/models', disabled.secret)
  assert.equal(disabledCall.response.status, 401)
  assert.equal(disabledCall.payload.error.code, 'api_key_disabled')

  const expired = (await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'Already Expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
  })).payload.data
  const expiredCall = await callV1(baseUrl, '/v1/models', expired.secret)
  assert.equal(expiredCall.response.status, 401)
  assert.equal(expiredCall.payload.error.code, 'api_key_expired')

  const rotatable = (await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'To Rotate' }),
  })).payload.data
  const rotated = await admin(baseUrl, `/admin/api-keys/${rotatable.id}/rotate`, { method: 'POST' })
  assert.equal(rotated.response.status, 200)
  assert.notEqual(rotated.payload.data.secret, rotatable.secret)
  assert.equal((await callV1(baseUrl, '/v1/models', rotatable.secret)).response.status, 401)
  assert.equal((await callV1(baseUrl, '/v1/models', rotated.payload.data.secret)).response.status, 200)

  // DELETE tanpa mode menghapus record sepenuhnya.
  const hardDeleted = await admin(baseUrl, `/admin/api-keys/${rotatable.id}`, { method: 'DELETE' })
  assert.equal(hardDeleted.response.status, 200)
  const remaining = (await admin(baseUrl, '/admin/api-keys')).payload.data.keys.map((key) => key.id)
  assert.equal(remaining.includes(rotatable.id), false)
})

test('usage dashboard attributes requests to the calling key', async (t) => {
  const { baseUrl } = await startGateway(t)

  const key = (await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'Attributed Key' }),
  })).payload.data

  const body = JSON.stringify({
    model: 'local-provider/model-a',
    messages: [{ role: 'user', content: 'hi' }],
  })
  await callV1(baseUrl, '/v1/chat/completions', key.secret, { method: 'POST', body })
  await callV1(baseUrl, '/v1/chat/completions', key.secret, { method: 'POST', body })
  await callV1(baseUrl, '/v1/chat/completions', BOOTSTRAP_KEY, { method: 'POST', body })

  const usage = await admin(baseUrl, '/admin/usage?range=24h')
  assert.equal(usage.response.status, 200)
  assert.equal(usage.payload.data.summary.requests, 3)

  const rows = new Map(usage.payload.data.keyBreakdown.map((row) => [row.keyId, row]))
  assert.equal(rows.get(key.id).requests, 2)
  assert.equal(rows.get(key.id).keyName, 'Attributed Key')
  assert.equal(rows.get(null).requests, 1)
  assert.equal(rows.get(null).keyName, 'Bootstrap (GATEWAY_API_KEY)')

  // GET /admin/usage juga men-flush counter pemakaian key.
  const keys = (await admin(baseUrl, '/admin/api-keys')).payload.data.keys
  const record = keys.find((item) => item.id === key.id)
  assert.equal(record.requestCount, 2)
  assert.equal(typeof record.lastUsedAt, 'string')
})

test('per-key rate limit applies on top of the global limit', async (t) => {
  const { baseUrl } = await startGateway(t)

  const key = (await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Tight Limit',
      rateLimit: { capacity: 2, refillPerSec: 0.01 },
    }),
  })).payload.data

  const body = JSON.stringify({
    model: 'local-provider/model-a',
    messages: [{ role: 'user', content: 'hi' }],
  })
  const first = await callV1(baseUrl, '/v1/chat/completions', key.secret, { method: 'POST', body })
  const second = await callV1(baseUrl, '/v1/chat/completions', key.secret, { method: 'POST', body })
  const third = await callV1(baseUrl, '/v1/chat/completions', key.secret, { method: 'POST', body })

  assert.equal(first.response.status, 200)
  assert.equal(second.response.status, 200)
  assert.equal(third.response.status, 429)
  assert.equal(third.payload.error.code, 'rate_limited')
  assert.equal(typeof third.response.headers.get('retry-after'), 'string')

  // Key lain tidak terkena bucket key yang sudah habis.
  const other = (await admin(baseUrl, '/admin/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'Unlimited' }),
  })).payload.data
  const otherCall = await callV1(baseUrl, '/v1/chat/completions', other.secret, { method: 'POST', body })
  assert.equal(otherCall.response.status, 200)
})

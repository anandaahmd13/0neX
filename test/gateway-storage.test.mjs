import assert from 'node:assert/strict'
import { createCipheriv, scryptSync } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConnectionStore, normalizeBaseUrl } from '../server/gateway/connection-store.mjs'
import { decryptSecret, encryptSecret } from '../server/gateway/secrets.mjs'
import { isPrivateAddress } from '../server/gateway/net-guard.mjs'
import { UsageStore } from '../server/gateway/usage-store.mjs'

const MASTER_KEY = '0123456789abcdef0123456789abcdef'

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), '0nex-gateway-test-'))
}

test('secret encryption round-trips without plaintext leakage', () => {
  const encrypted = encryptSecret('sk-private-value', MASTER_KEY)
  assert.equal(decryptSecret(encrypted, MASTER_KEY), 'sk-private-value')
  assert.equal(JSON.stringify(encrypted).includes('sk-private-value'), false)
  assert.throws(
    () => decryptSecret(encrypted, 'abcdef0123456789abcdef0123456789'),
    /tidak bisa didekripsi/,
  )
})

test('encryptSecret uses per-secret random salt (version 2) and still reads legacy v1', () => {
  const a = encryptSecret('sk-rahasia', MASTER_KEY)
  const b = encryptSecret('sk-rahasia', MASTER_KEY)
  assert.equal(a.version, 2)
  assert.equal(typeof a.salt, 'string')
  assert.notEqual(a.salt, b.salt) // salt acak per-secret
  assert.notEqual(a.iv, b.iv)
  assert.equal(decryptSecret(a, MASTER_KEY), 'sk-rahasia')

  // Blob legacy v1 (salt global hardcoded) tetap bisa didekripsi (kompat mundur).
  const LEGACY_SALT = '0nex-personal-ai-gateway-v1'
  const legacyIv = Buffer.alloc(12, 7)
  const legacyKey = scryptSync(MASTER_KEY, LEGACY_SALT, 32)
  const cipher = createCipheriv('aes-256-gcm', legacyKey, legacyIv)
  const ciphertext = Buffer.concat([cipher.update('sk-legacy', 'utf8'), cipher.final()])
  const legacyV1 = {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: legacyIv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  assert.equal(decryptSecret(legacyV1, MASTER_KEY), 'sk-legacy')
})

test('SSRF guard: normalizeBaseUrl rejects internal IP literals', () => {
  assert.equal(isPrivateAddress('169.254.169.254'), true)
  assert.equal(isPrivateAddress('10.0.0.5'), true)
  assert.equal(isPrivateAddress('192.168.1.1'), true)
  assert.equal(isPrivateAddress('172.16.0.1'), true)
  assert.equal(isPrivateAddress('100.64.0.1'), true)
  assert.equal(isPrivateAddress('8.8.8.8'), false)

  for (const url of [
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/v1',
    'https://192.168.1.1/v1',
    'https://[::1]/v1',
  ]) {
    assert.throws(() => normalizeBaseUrl(url, { allowInsecureLocalhost: false }), /internal|HTTPS/i)
  }

  // Host publik tetap diterima.
  assert.equal(
    normalizeBaseUrl('https://api.openai.com/v1', { allowInsecureLocalhost: false }),
    'https://api.openai.com/v1',
  )
  // Localhost diizinkan hanya saat allowInsecureLocalhost aktif (dev/test).
  assert.equal(
    normalizeBaseUrl('http://127.0.0.1:9876/v1', { allowInsecureLocalhost: true }),
    'http://127.0.0.1:9876/v1',
  )
})

test('connection store persists encrypted keys and returns public projections', async () => {
  const dataDir = await temporaryDirectory()
  const store = new ConnectionStore({
    dataDir,
    masterKey: MASTER_KEY,
    allowInsecureLocalhost: true,
  })

  const created = await store.create({
    id: 'local-provider',
    name: 'Local Provider',
    baseUrl: 'http://127.0.0.1:9876/v1/',
    apiKey: 'sk-store-secret',
    models: ['model-a', 'org/model-b'],
    enabled: true,
  })
  assert.equal(created.hasApiKey, true)
  assert.equal('apiKey' in created, false)
  assert.equal('encryptedApiKey' in created, false)
  assert.equal(created.baseUrl, 'http://127.0.0.1:9876/v1')

  const raw = await readFile(join(dataDir, 'connections.json'), 'utf8')
  assert.equal(raw.includes('sk-store-secret'), false)

  const reloaded = new ConnectionStore({
    dataDir,
    masterKey: MASTER_KEY,
    allowInsecureLocalhost: true,
  })
  assert.equal((await reloaded.getWithSecret('local-provider')).apiKey, 'sk-store-secret')

  const updated = await reloaded.update('local-provider', {
    name: 'Updated Provider',
    models: ['model-c'],
  })
  assert.equal(updated.name, 'Updated Provider')
  assert.deepEqual(updated.models, ['model-c'])
  assert.equal((await reloaded.getWithSecret('local-provider')).apiKey, 'sk-store-secret')

  await reloaded.delete('local-provider')
  assert.deepEqual(await reloaded.list(), [])
})

test('usage store aggregates metadata without storing prompt or completion', async () => {
  const dataDir = await temporaryDirectory()
  const store = new UsageStore({ dataDir })

  await store.append({
    requestId: 'req_1',
    timestamp: new Date().toISOString(),
    connectionId: 'provider-a',
    model: 'model-a',
    stream: false,
    status: 200,
    success: true,
    latencyMs: 42,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    prompt: 'must-not-be-saved',
    completion: 'also-must-not-be-saved',
  })
  await store.append({
    requestId: 'req_2',
    timestamp: new Date().toISOString(),
    connectionId: 'provider-a',
    model: 'model-a',
    stream: true,
    status: 502,
    success: false,
    latencyMs: 58,
    usage: null,
    errorCategory: 'upstream_server',
  })

  const raw = await readFile(join(dataDir, 'usage.jsonl'), 'utf8')
  assert.equal(raw.includes('must-not-be-saved'), false)
  assert.equal(raw.includes('also-must-not-be-saved'), false)

  const aggregate = await store.aggregate('24h')
  assert.equal(aggregate.summary.requests, 2)
  assert.equal(aggregate.summary.successes, 1)
  assert.equal(aggregate.summary.totalTokens, 15)
  assert.equal(aggregate.summary.knownTokenRequests, 1)
  assert.equal(aggregate.breakdown[0].requests, 2)
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  API_KEY_SCOPES,
  ApiKeyStore,
  KEY_PREFIX,
  maskApiKey,
} from '../server/gateway/api-key-store.mjs'
import { UsageStore } from '../server/gateway/usage-store.mjs'

const MASTER_KEY = '0123456789abcdef0123456789abcdef'

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), '0nex-api-key-test-'))
}

async function freshStore(overrides = {}) {
  const dataDir = await temporaryDirectory()
  return {
    dataDir,
    store: new ApiKeyStore({ dataDir, masterKey: MASTER_KEY, ...overrides }),
  }
}

test('api key store refuses to build without a usable master key', async () => {
  const dataDir = await temporaryDirectory()
  assert.throws(() => new ApiKeyStore({ dataDir, masterKey: 'short' }), /GATEWAY_MASTER_KEY/)
})

test('create returns plaintext once and persists only a keyed hash', async () => {
  const { dataDir, store } = await freshStore()

  const created = await store.create({ name: 'OpenCode Laptop', scopes: ['models:read', 'chat:write'] })
  assert.match(created.secret, new RegExp(`^${KEY_PREFIX}[A-Za-z0-9_-]{20,}$`))
  assert.deepEqual(created.scopes, ['models:read', 'chat:write'])
  assert.equal(created.enabled, true)
  assert.equal(created.requestCount, 0)
  assert.equal(created.maskedKey, maskApiKey(created.secret))
  assert.equal(created.maskedKey.includes('…'), true)

  // Plaintext tidak boleh tersimpan di disk, dan hash-nya tidak boleh polos SHA.
  const raw = await readFile(join(dataDir, 'api-keys.json'), 'utf8')
  assert.equal(raw.includes(created.secret), false)
  assert.match(raw, /"hash": "[0-9a-f]{64}"/)

  // Listing tidak pernah membocorkan plaintext lagi.
  const [listed] = await store.list()
  assert.equal('secret' in listed, false)
  assert.equal('hash' in listed, false)
  assert.equal(listed.maskedKey, created.maskedKey)
})

test('verify accepts a live key and rejects unknown, revoked, disabled, and expired keys', async () => {
  const { store } = await freshStore()
  const created = await store.create({ name: 'Live Key' })

  const ok = await store.verify(created.secret)
  assert.equal(ok.ok, true)
  assert.equal(ok.key.id, created.id)

  assert.deepEqual(await store.verify('not-a-managed-key'), { ok: false, reason: 'not_found' })
  assert.deepEqual(await store.verify(`${KEY_PREFIX}bogus`), { ok: false, reason: 'not_found' })

  const disabledKey = await store.create({ name: 'Disabled Key' })
  await store.update(disabledKey.id, { enabled: false })
  assert.equal((await store.verify(disabledKey.secret)).reason, 'disabled')

  const revokedKey = await store.create({ name: 'Revoked Key' })
  await store.revoke(revokedKey.id)
  const revoked = await store.verify(revokedKey.secret)
  assert.equal(revoked.ok, false)
  assert.equal(revoked.reason, 'not_found')

  const expiring = await store.create({
    name: 'Expiring Key',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  assert.equal((await store.verify(expiring.secret)).ok, true)

  const later = new ApiKeyStore({
    dataDir: store.filePath.replace(/\/api-keys\.json$/, ''),
    masterKey: MASTER_KEY,
    now: () => Date.now() + 120_000,
  })
  assert.equal((await later.verify(expiring.secret)).reason, 'expired')
})

test('hash is keyed by master key so a leaked file is useless without it', async () => {
  const { dataDir, store } = await freshStore()
  const created = await store.create({ name: 'Keyed Hash' })

  const wrongMaster = new ApiKeyStore({
    dataDir,
    masterKey: 'ffffffffffffffffffffffffffffffff',
  })
  assert.equal((await wrongMaster.verify(created.secret)).reason, 'not_found')

  const rightMaster = new ApiKeyStore({ dataDir, masterKey: MASTER_KEY })
  assert.equal((await rightMaster.verify(created.secret)).ok, true)
})

test('rotate issues a new secret and invalidates the previous one', async () => {
  const { store } = await freshStore()
  const created = await store.create({ name: 'Rotate Me', scopes: ['chat:write'] })

  const rotated = await store.rotate(created.id)
  assert.equal(rotated.id, created.id)
  assert.notEqual(rotated.secret, created.secret)
  assert.deepEqual(rotated.scopes, ['chat:write'])
  assert.equal(typeof rotated.rotatedAt, 'string')

  assert.equal((await store.verify(created.secret)).ok, false)
  assert.equal((await store.verify(rotated.secret)).ok, true)
})

test('scope, expiry, and rate limit inputs are validated', async () => {
  const { store } = await freshStore()

  await assert.rejects(store.create({ name: '' }), /Nama API key wajib diisi/)
  await assert.rejects(store.create({ name: 'Bad Scope', scopes: ['admin:everything'] }), /Scope tidak dikenal/)
  await assert.rejects(store.create({ name: 'No Scope', scopes: [] }), /Minimal satu scope/)
  await assert.rejects(store.create({ name: 'Bad Date', expiresAt: 'kapan-kapan' }), /expiresAt harus tanggal ISO/)
  await assert.rejects(
    store.create({ name: 'Bad Limit', rateLimit: { capacity: 0, refillPerSec: 1 } }),
    /rateLimit\.capacity/,
  )
  await assert.rejects(
    store.create({ name: 'Bad Refill', rateLimit: { capacity: 10, refillPerSec: -2 } }),
    /rateLimit\.refillPerSec/,
  )

  // Default scope = seluruh scope kanonik, urutannya stabil.
  const defaulted = await store.create({ name: 'Default Scopes' })
  assert.deepEqual(defaulted.scopes, [...API_KEY_SCOPES])

  const limited = await store.create({
    name: 'Limited',
    scopes: ['chat:write', 'models:read'],
    rateLimit: { capacity: 5, refillPerSec: 0.5 },
  })
  assert.deepEqual(limited.scopes, [...API_KEY_SCOPES])
  assert.deepEqual(limited.rateLimit, { capacity: 5, refillPerSec: 0.5 })

  await assert.rejects(store.update('key_missing', { name: 'x' }), /tidak ditemukan/)
  await assert.rejects(store.rotate('key_missing'), /tidak ditemukan/)
  await assert.rejects(store.revoke('key_missing'), /tidak ditemukan/)
  await assert.rejects(store.delete('key_missing'), /tidak ditemukan/)
})

test('usage counters buffer in memory and flush to disk', async () => {
  const { dataDir, store } = await freshStore()
  const created = await store.create({ name: 'Counted' })

  store.touch(created.id)
  store.touch(created.id)
  assert.equal((await store.get(created.id)).requestCount, 0)

  await store.flushUsage()
  const flushed = await store.get(created.id)
  assert.equal(flushed.requestCount, 2)
  assert.equal(typeof flushed.lastUsedAt, 'string')

  // Counter bertahan lintas restart proses.
  const reloaded = new ApiKeyStore({ dataDir, masterKey: MASTER_KEY })
  assert.equal((await reloaded.get(created.id)).requestCount, 2)

  // Flush tanpa pemakaian baru tidak melakukan apa pun.
  assert.equal(await store.flushUsage(), false)
})

test('delete removes the record and its pending usage', async () => {
  const { store } = await freshStore()
  const created = await store.create({ name: 'Temporary' })
  store.touch(created.id)

  const removed = await store.delete(created.id)
  assert.equal(removed.id, created.id)
  assert.deepEqual(await store.list(), [])
  assert.equal(store.pendingUsage.size, 0)
  assert.equal((await store.verify(created.secret)).reason, 'not_found')
})

test('usage store records keyId and aggregates per-key breakdown', async () => {
  const dataDir = await temporaryDirectory()
  const usage = new UsageStore({ dataDir })

  await usage.append({
    requestId: 'req_1',
    connectionId: 'kiro-main',
    keyId: 'key_abc',
    keyName: 'OpenCode Laptop',
    model: 'auto',
    status: 200,
    success: true,
    latencyMs: 10,
    usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
  })
  await usage.append({
    requestId: 'req_2',
    connectionId: 'kiro-main',
    keyId: 'key_abc',
    keyName: 'OpenCode Laptop',
    model: 'auto',
    status: 500,
    success: false,
    latencyMs: 20,
    usage: null,
    errorCategory: 'upstream_server',
  })
  // Tanpa keyId → jalur bootstrap GATEWAY_API_KEY.
  await usage.append({
    requestId: 'req_3',
    connectionId: 'kiro-main',
    model: 'auto',
    status: 200,
    success: true,
    latencyMs: 30,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

  const aggregate = await usage.aggregate('24h')
  assert.equal(aggregate.summary.requests, 3)

  const byKey = new Map(aggregate.keyBreakdown.map((row) => [row.keyId, row]))
  assert.equal(byKey.get('key_abc').requests, 2)
  assert.equal(byKey.get('key_abc').keyName, 'OpenCode Laptop')
  assert.equal(byKey.get('key_abc').successRate, 50)
  assert.equal(byKey.get('key_abc').totalTokens, 10)
  assert.equal(byKey.get(null).requests, 1)
  assert.equal(byKey.get(null).keyName, 'Bootstrap (GATEWAY_API_KEY)')

  // Telemetry tetap metadata-only.
  const raw = await readFile(join(dataDir, 'usage.jsonl'), 'utf8')
  assert.equal(raw.includes('onex_sk_'), false)
})

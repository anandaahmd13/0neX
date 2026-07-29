import assert from 'node:assert/strict'
import { createCipheriv, scryptSync } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

test('connection store migrates legacy records and defaults new input to openai-http', async () => {
  const dataDir = await temporaryDirectory()
  const encryptedApiKey = encryptSecret('sk-legacy-provider', MASTER_KEY)
  await writeFile(join(dataDir, 'connections.json'), `${JSON.stringify({
    version: 1,
    connections: [{
      id: 'legacy-provider',
      name: 'Legacy Provider',
      baseUrl: 'https://api.example.com/v1',
      models: ['legacy/model'],
      enabled: true,
      encryptedApiKey,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }],
  })}\n`, { mode: 0o600 })

  const store = new ConnectionStore({ dataDir, masterKey: MASTER_KEY })
  const [legacy] = await store.list()
  assert.equal(legacy.kind, 'openai-http')
  assert.equal(legacy.hasApiKey, true)
  assert.equal((await store.getWithSecret('legacy-provider')).apiKey, 'sk-legacy-provider')

  const created = await store.create({
    id: 'new-provider',
    name: 'New Provider',
    baseUrl: 'https://new.example.com/v1',
    apiKey: 'sk-new-provider',
    models: [],
  })
  assert.equal(created.kind, 'openai-http')
  assert.equal(created.hasApiKey, true)
  assert.equal('authMode' in created, false)
})

test('Kiro connections persist active and available models and redact secrets', async () => {
  const dataDir = await temporaryDirectory()
  const store = new ConnectionStore({ dataDir, masterKey: MASTER_KEY })

  await assert.rejects(
    store.create({
      id: 'kiro-account',
      name: 'Kiro Account',
      kind: 'kiro-cli',
      authMode: 'account-session',
      apiKey: 'must-not-be-stored-for-account-mode',
      models: ['kiro-auto'],
    }),
    /hanya mendukung authMode api-key/,
  )

  await assert.rejects(
    store.create({
      id: 'kiro-missing-key',
      name: 'Kiro Missing Key',
      kind: 'kiro-cli',
      authMode: 'api-key',
      models: [],
    }),
    /API key wajib diisi/,
  )
  await assert.rejects(
    store.create({
      id: 'kiro-bad-mode',
      name: 'Kiro Bad Mode',
      kind: 'kiro-cli',
      authMode: 'browser-magic',
      models: [],
    }),
    /authMode Kiro/,
  )

  const secret = 'ksk_store_super_secret'
  const keyed = await store.create({
    id: 'kiro-keyed',
    name: 'Kiro Keyed',
    kind: 'kiro-cli',
    authMode: 'api-key',
    apiKey: secret,
    models: ['ignored-model'],
  })
  assert.equal(keyed.hasApiKey, true)
  assert.equal(keyed.region, 'us-east-1')
  assert.deepEqual(keyed.models, ['ignored-model'])
  assert.deepEqual(keyed.availableModels, ['ignored-model'])
  assert.equal('apiKey' in keyed, false)
  assert.equal('encryptedApiKey' in keyed, false)
  assert.equal('baseUrl' in keyed, false)
  assert.equal((await store.getWithSecret('kiro-keyed')).apiKey, secret)
  assert.equal((await readFile(join(dataDir, 'connections.json'), 'utf8')).includes(secret), false)

  const regional = await store.create({
    id: 'kiro-eu',
    name: 'Kiro Europe',
    kind: 'kiro-cli',
    authMode: 'api-key',
    apiKey: 'ksk_europe',
    region: 'eu-central-1',
    models: ['auto'],
  })
  assert.equal(regional.region, 'eu-central-1')
  assert.equal((await store.getWithSecret('kiro-eu')).region, 'eu-central-1')

  await assert.rejects(
    store.create({
      id: 'kiro-invalid-region',
      name: 'Kiro Invalid Region',
      kind: 'kiro-cli',
      authMode: 'api-key',
      apiKey: 'ksk_invalid_region',
      region: 'ap-southeast-1',
      models: ['auto'],
    }),
    /region.*us-east-1.*eu-central-1/i,
  )

  const updated = await store.update('kiro-keyed', {
    name: 'Blank Preserves',
    apiKey: '   ',
    models: ['ignored-model'],
  })
  assert.deepEqual(updated.models, ['ignored-model'])
  assert.equal((await store.getWithSecret('kiro-keyed')).apiKey, secret)

  await assert.rejects(
    store.update('kiro-keyed', { authMode: 'account-session' }),
    /hanya mendukung authMode api-key/,
  )
  assert.equal((await store.getWithSecret('kiro-keyed')).apiKey, secret)

  const keyedAgain = await store.update('kiro-keyed', {
    authMode: 'api-key',
    apiKey: 'ksk_replacement',
  })
  assert.equal(keyedAgain.hasApiKey, true)
  assert.equal((await store.getWithSecret('kiro-keyed')).apiKey, 'ksk_replacement')

  // Identitas hasil validasi bearer (profile ARN + email) bukan secret, jadi
  // boleh tersimpan apa adanya dan tampil di projection publik.
  const identified = await store.update('kiro-keyed', { apiKey: 'ksk_identity_probe' }, {
    validatedAt: '2026-07-29T00:00:00.000Z',
    identity: {
      profileArn: 'arn:aws:codewhisperer:us-east-1:111122223333:profile/AAAA',
      email: 'owner@example.com',
    },
  })
  assert.equal(identified.profileArn, 'arn:aws:codewhisperer:us-east-1:111122223333:profile/AAAA')
  assert.equal(identified.email, 'owner@example.com')
  assert.equal(identified.validatedAt, '2026-07-29T00:00:00.000Z')

  const clearedIdentity = await store.update('kiro-keyed', { apiKey: 'ksk_without_identity' }, {
    validatedAt: '2026-07-29T01:00:00.000Z',
    identity: { profileArn: null, email: null },
  })
  assert.equal('profileArn' in clearedIdentity, false)
  assert.equal('email' in clearedIdentity, false)

  const restoredIdentity = await store.update('kiro-keyed', {}, {
    validatedAt: '2026-07-29T02:00:00.000Z',
    identity: {
      profileArn: 'arn:aws:codewhisperer:us-east-1:111122223333:profile/AAAA',
      email: 'owner@example.com',
    },
  })
  assert.equal(restoredIdentity.profileArn, 'arn:aws:codewhisperer:us-east-1:111122223333:profile/AAAA')

  // Update lain tidak boleh menghapus identitas yang sudah tervalidasi.
  const renamed = await store.update('kiro-keyed', { name: 'Kiro Identity Kept' })
  assert.equal(renamed.profileArn, 'arn:aws:codewhisperer:us-east-1:111122223333:profile/AAAA')
  assert.equal(renamed.email, 'owner@example.com')

  // Identitas milik kiro-cli saja; connection HTTP tidak boleh membawanya.
  const httpConnection = await store.create({
    id: 'http-no-identity',
    name: 'HTTP No Identity',
    kind: 'openai-http',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-http-secret',
    models: ['gpt-4o'],
  }, {
    identity: { profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/NOPE', email: 'x@y.z' },
  })
  assert.equal('profileArn' in httpConnection, false)
  assert.equal('email' in httpConnection, false)

  await assert.rejects(
    store.create({
      id: 'wrong-kind',
      name: 'Wrong Kind',
      kind: 'other',
      models: [],
    }),
    /kind harus/,
  )
})

test('legacy empty Kiro model records fall back to Auto until discovery refreshes them', async () => {
  const dataDir = await temporaryDirectory()
  await writeFile(join(dataDir, 'connections.json'), `${JSON.stringify({
    version: 2,
    connections: [{
      id: 'kiro-empty-legacy',
      name: 'Kiro Empty Legacy',
      kind: 'kiro-cli',
      authMode: 'api-key',
      models: [],
      enabled: true,
      encryptedApiKey: encryptSecret('ksk_empty_legacy', MASTER_KEY),
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }],
  })}\n`, { mode: 0o600 })

  const store = new ConnectionStore({ dataDir, masterKey: MASTER_KEY })
  const [connection] = await store.list()
  assert.deepEqual(connection.models, ['auto'])
  assert.deepEqual(connection.availableModels, ['auto'])
})

test('legacy Kiro records without region project and decrypt as us-east-1', async () => {
  const dataDir = await temporaryDirectory()
  const encryptedApiKey = encryptSecret('ksk_legacy_kiro', MASTER_KEY)
  await writeFile(join(dataDir, 'connections.json'), `${JSON.stringify({
    version: 2,
    connections: [{
      id: 'kiro-legacy',
      name: 'Kiro Legacy',
      kind: 'kiro-cli',
      authMode: 'api-key',
      models: ['auto'],
      enabled: true,
      encryptedApiKey,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }],
  })}\n`, { mode: 0o600 })

  const store = new ConnectionStore({ dataDir, masterKey: MASTER_KEY })
  const [connection] = await store.list()
  assert.equal(connection.region, 'us-east-1')
  assert.equal((await store.getWithSecret('kiro-legacy')).region, 'us-east-1')
})

test('switching connection kinds only preserves compatible secrets', async () => {
  const dataDir = await temporaryDirectory()
  const store = new ConnectionStore({ dataDir, masterKey: MASTER_KEY })
  await store.create({
    id: 'switchable',
    name: 'Switchable',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-openai-secret',
    models: ['model-a'],
  })

  await assert.rejects(
    store.update('switchable', {
      kind: 'kiro-cli',
      authMode: 'api-key',
      models: ['ignored-model'],
    }),
    /API key wajib diisi saat beralih/,
  )

  const kiro = await store.update('switchable', {
    kind: 'kiro-cli',
    authMode: 'api-key',
    apiKey: 'ksk-fresh-kiro',
    models: ['ignored-model'],
  })
  assert.equal(kiro.hasApiKey, true)
  assert.equal('baseUrl' in kiro, false)
  assert.deepEqual(kiro.models, ['ignored-model'])
  assert.deepEqual(kiro.availableModels, ['ignored-model'])

  await assert.rejects(
    store.update('switchable', {
      kind: 'openai-http',
      baseUrl: 'https://api.example.com/v1',
    }),
    /API key wajib diisi saat beralih/,
  )

  const openai = await store.update('switchable', {
    kind: 'openai-http',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-fresh-openai',
    models: ['model-a'],
  })
  assert.equal(openai.kind, 'openai-http')
  assert.equal(openai.hasApiKey, true)
  assert.equal('authMode' in openai, false)
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

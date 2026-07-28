import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConnectionStore } from '../server/gateway/connection-store.mjs'
import { decryptSecret, encryptSecret } from '../server/gateway/secrets.mjs'
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

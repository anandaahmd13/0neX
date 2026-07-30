import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { McpStore } from '../server/gateway/mcp-store.mjs'

const MASTER_KEY = '0123456789abcdef0123456789abcdef'

async function setup(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), '0nex-mcp-store-'))
  const store = new McpStore({
    dataDir,
    masterKey: MASTER_KEY,
    allowInsecureLocalhost: true,
    ...options,
  })
  return { dataDir, store }
}

test('MCP store encrypts secrets and only returns safe metadata', async () => {
  const { dataDir, store } = await setup()
  const secret = 'github-secret-must-not-leak'
  const created = await store.create({
    id: 'github-tools',
    name: 'GitHub tools',
    transport: 'stdio',
    command: process.execPath,
    args: ['server.mjs'],
    env: { GITHUB_TOKEN: secret },
    enabled: true,
    trusted: true,
    readOnly: true,
  })

  assert.equal(created.hasSecrets, true)
  assert.equal('env' in created, false)
  const raw = await readFile(join(dataDir, 'mcp-servers.json'), 'utf8')
  assert.equal(raw.includes(secret), false)
  assert.match(raw, /encryptedSecrets/)
  assert.deepEqual(await store.list(), [created])

  assert.deepEqual(await store.resolveForRun(['github-tools'], { policy: 'read-only' }), [{
    name: 'GitHub tools',
    command: process.execPath,
    args: ['server.mjs'],
    env: [{ name: 'GITHUB_TOKEN', value: secret }],
  }])
})

test('MCP selection requires enabled, trusted, and policy-compatible servers', async () => {
  const { store } = await setup()
  await store.create({
    id: 'write-tools',
    name: 'Write tools',
    transport: 'stdio',
    command: 'node',
    trusted: true,
    readOnly: false,
  })
  await store.create({
    id: 'untrusted',
    name: 'Untrusted',
    transport: 'stdio',
    command: 'node',
    trusted: false,
  })
  await store.create({
    id: 'disabled',
    name: 'Disabled',
    transport: 'stdio',
    command: 'node',
    trusted: true,
    enabled: false,
  })

  assert.deepEqual(await store.resolveForRun(['write-tools'], { policy: 'none' }), [])
  await assert.rejects(
    store.resolveForRun(['write-tools'], { policy: 'read-only' }),
    /tidak ditandai read-only/,
  )
  await assert.rejects(
    store.resolveForRun(['untrusted'], { policy: 'standard' }),
    /belum enabled dan trusted/,
  )
  await assert.rejects(
    store.resolveForRun(['disabled'], { policy: 'standard' }),
    /belum enabled dan trusted/,
  )
  assert.equal((await store.resolveForRun(['write-tools'], { policy: 'standard' }))[0].name, 'Write tools')
})

test('MCP update preserves secrets unless replaced or explicitly cleared', async () => {
  const { store } = await setup()
  await store.create({
    id: 'remote',
    name: 'Remote',
    transport: 'http',
    url: 'http://localhost:3001/mcp',
    headers: { Authorization: 'Bearer original' },
    trusted: true,
  })

  const updated = await store.update('remote', { name: 'Remote renamed' })
  assert.equal(updated.hasSecrets, true)
  assert.deepEqual((await store.resolveForRun(['remote'], { policy: 'standard' }))[0].headers, [{
    name: 'Authorization',
    value: 'Bearer original',
  }])

  const cleared = await store.update('remote', { clearSecrets: true })
  assert.equal(cleared.hasSecrets, false)
  assert.deepEqual((await store.resolveForRun(['remote'], { policy: 'standard' }))[0].headers, [])
})

test('MCP remote URLs enforce HTTPS and reject private IP targets', async () => {
  const secure = await setup({ allowInsecureLocalhost: false })
  await assert.rejects(
    secure.store.create({
      id: 'plain-http', name: 'Plain', transport: 'http', url: 'http://example.com/mcp',
    }),
    /harus memakai HTTPS/,
  )
  await assert.rejects(
    secure.store.create({
      id: 'private-ip', name: 'Private', transport: 'sse', url: 'https://127.0.0.2/mcp',
    }),
    /alamat jaringan internal/,
  )
  const created = await secure.store.create({
    id: 'public-https', name: 'Public', transport: 'http', url: 'https://example.com/mcp',
  })
  assert.equal(created.url, 'https://example.com/mcp')
})

test('MCP store validates duplicates and deletes records', async () => {
  const { store } = await setup()
  await store.create({ id: 'server', name: 'Server', transport: 'stdio', command: 'node' })
  await assert.rejects(
    store.create({ id: 'server', name: 'Duplicate', transport: 'stdio', command: 'node' }),
    /sudah ada/,
  )
  assert.equal((await store.delete('server')).id, 'server')
  assert.deepEqual(await store.list(), [])
})

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
const KIRO_FIXTURE = join(TEST_DIR, 'fixtures', 'kiro-cli-fixture.mjs')
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
  const validator = {
    calls,
    models: ['auto', 'claude-sonnet-5'],
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
        profileArn: apiKey.includes('no-identity') ? null : profileArn(region, apiKey),
        email: apiKey.includes('no-identity') ? null : 'kiro-user@example.com',
        models: [...validator.models],
        validatedAt: new Date(1_750_000_000_000 + calls.length * 1_000).toISOString(),
      }
    },
  }
  return validator
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

async function setupGateway(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), '0nex-kiro-gateway-'))
  const gatewayDataDir = join(root, 'gateway-data')
  const kiroBearerValidator = createFakeKiroBearerValidator()
  const kiroHttpClient = createFakeKiroHttpClient()
  const kiroRecordFile = join(root, 'kiro-acp.jsonl')
  const kiroRunner = overrides.kiroFixtureMode
    ? createKiroRunner({
        executable: process.execPath,
        executableArgs: [KIRO_FIXTURE],
        env: {
          ...process.env,
          KIRO_FIXTURE_MODE: overrides.kiroFixtureMode,
          KIRO_FIXTURE_RECORD: kiroRecordFile,
          KIRO_FIXTURE_TOOL_PATH: overrides.kiroFixtureToolPath,
        },
        dataDir: gatewayDataDir,
        timeoutMs: 2_000,
        killGraceMs: 30,
        maxOutputBytes: 100_000,
      })
    : overrides.kiroRunner ?? {
        async probe() {
          return {
            available: false,
            code: 'KIRO_CLI_NOT_FOUND',
            reason: 'fixture runtime unavailable',
            supports: { acp: false, loadSession: false, mcpTransports: [] },
          }
        },
      }
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
    kiroRunner,
    kiroAcpCwd: overrides.kiroAcpCwd,
    workspaces: overrides.workspaces,
    providers: overrides.providers,
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
    kiroRecordFile,
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

async function issueWsTicket(baseUrl) {
  const result = await jsonRequest(`${baseUrl}/admin/ws-ticket`, ADMIN_TOKEN, {
    method: 'POST',
  })
  assert.equal(result.response.status, 201, JSON.stringify(result.payload))
  assert.match(result.payload.data.ticket, /^wst_/)
  return result.payload.data.ticket
}

function ticketUrl(wsUrl, ticket) {
  const url = new URL(wsUrl)
  url.searchParams.delete('token')
  url.searchParams.set('ticket', ticket)
  return url.toString()
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

async function fixtureRecords(path) {
  const raw = await readFile(path, 'utf8')
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function fixtureRpcMessages(entries) {
  return entries.filter((entry) => entry.type === 'rpc').map((entry) => entry.message)
}

test('WebSocket tickets are one-time and cannot be replayed', async (t) => {
  const { baseUrl, wsUrl } = await setupGateway(t)
  const ticket = await issueWsTicket(baseUrl)
  const authorizedUrl = ticketUrl(wsUrl, ticket)
  const first = connect(authorizedUrl)
  t.after(() => first.socket.close())
  await first.opened
  const hello = await first.next((message) => message.type === 'hello')
  assert.equal(hello.protocolVersion, 2)

  const replay = new WebSocket(authorizedUrl, { origin: ORIGIN })
  const rejected = await new Promise((resolve) => {
    replay.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    replay.once('error', () => resolve(401))
  })
  assert.equal(rejected, 401)
  replay.terminate()
})

test('ticketed WebSocket rejects forged and replayed permission responses', async (t) => {
  let releaseProvider
  const release = new Promise((resolve) => { releaseProvider = resolve })
  const permissionProvider = {
    id: 'permission-fixture',
    label: 'Permission Fixture',
    capabilities: { streaming: true, sessions: false, cancellation: true, tools: true },
    start(request, handlers) {
      let disposed = false
      Promise.resolve().then(async () => {
        const decision = await handlers.onPermissionRequest({
          toolCall: { toolCallId: 'tool-1', title: 'Read config', kind: 'read' },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
        })
        await release
        if (!disposed) {
          handlers.onDone({
            code: 0,
            reason: 'completed',
            sessionId: request.sessionId,
            permissionDecision: decision,
          })
        }
      })
      return {
        cancel() {},
        dispose() { disposed = true },
      }
    },
  }
  const { baseUrl, wsUrl } = await setupGateway(t, { providers: [permissionProvider] })
  const ticket = await issueWsTicket(baseUrl)
  const client = connect(ticketUrl(wsUrl, ticket))
  t.after(() => client.socket.close())
  await client.opened
  await client.next((message) => message.type === 'hello')

  const runId = 'run-permission'
  client.socket.send(JSON.stringify(runMessage({
    runId,
    providerId: permissionProvider.id,
    agent: { id: 'agt_permission', model: '', systemPrompt: '', toolPolicy: 'standard' },
  })))
  const permission = await client.next((message) => message.type === 'permission_request')
  assert.equal(permission.runId, runId)
  assert.deepEqual(permission.options.map((option) => option.optionId), ['allow', 'reject'])

  client.socket.send(JSON.stringify({
    type: 'permission_response',
    runId: 'run-forged',
    requestId: permission.requestId,
    optionId: 'allow',
  }))
  assert.equal(
    (await client.next((message) => message.code === 'permission_run_mismatch')).runId,
    runId,
  )

  client.socket.send(JSON.stringify({
    type: 'permission_response',
    runId,
    requestId: permission.requestId,
    optionId: 'not-offered',
  }))
  await client.next((message) => message.code === 'permission_option_invalid')

  const accepted = {
    type: 'permission_response',
    runId,
    requestId: permission.requestId,
    optionId: 'allow',
  }
  client.socket.send(JSON.stringify(accepted))
  client.socket.send(JSON.stringify(accepted))
  await client.next((message) => message.code === 'permission_already_settled')

  releaseProvider()
  const done = await client.next((message) => message.type === 'done')
  assert.deepEqual(done.permissionDecision, {
    outcome: { outcome: 'selected', optionId: 'allow' },
  })
})

test('Kiro Agent probes ACP and supports new and resumed sessions over ticketed WebSocket v2', async (t) => {
  const { baseUrl, wsUrl, kiroRecordFile } = await setupGateway(t, {
    kiroFixtureMode: 'normal',
    kiroAcpCwd: TEST_DIR,
  })
  const ticket = await issueWsTicket(baseUrl)
  const client = connect(ticketUrl(wsUrl, ticket))
  t.after(() => client.socket.close())
  await client.opened

  const hello = await client.next((message) => message.type === 'hello')
  assert.equal(hello.protocolVersion, 2)
  assert.equal(hello.seq, 1)
  const provider = hello.providers.find((entry) => entry.id === 'kiro-agent')
  assert.deepEqual(provider, {
    id: 'kiro-agent',
    label: 'Kiro Agent (ACP)',
    capabilities: {
      streaming: true,
      sessions: true,
      cancellation: true,
      tools: true,
      toolPolicies: ['none', 'read-only', 'standard'],
      available: true,
      runtime: { version: '1.0.0', acpProtocolVersion: 1, mcpTransports: ['stdio'] },
    },
  })

  const firstRunId = 'run-new-session'
  client.socket.send(JSON.stringify(runMessage({
    runId: firstRunId,
    providerId: 'kiro-agent',
    sessionId: 'new-correlation',
    agent: {
      id: 'agt_kiro',
      model: '',
      systemPrompt: 'answer briefly',
      toolPolicy: 'none',
    },
  })))
  const initialSession = await client.next(
    (message) => message.type === 'session' && message.sessionId === 'new-correlation',
  )
  assert.equal(initialSession.runId, firstRunId)
  const created = await client.next(
    (message) => message.type === 'session' && message.sessionId === 'fixture-new-session',
  )
  assert.equal(created.providerId, 'kiro-agent')
  assert.equal(created.runId, firstRunId)
  assert.deepEqual([
    (await client.next((message) => message.type === 'message_delta')).text,
    (await client.next((message) => message.type === 'message_delta')).text,
  ], ['hello ', 'from fixture'])
  const firstDone = await client.next((message) => message.type === 'done')
  assert.equal(firstDone.providerId, 'kiro-agent')
  assert.equal(firstDone.runId, firstRunId)
  assert.equal(firstDone.reason, 'completed')
  assert.equal(firstDone.sessionId, 'fixture-new-session')
  assert.equal(firstDone.stopReason, 'end_turn')

  const resumedRunId = 'run-resumed-session'
  client.socket.send(JSON.stringify(runMessage({
    runId: resumedRunId,
    providerId: 'kiro-agent',
    sessionId: 'existing-session',
    resume: true,
    agent: {
      id: 'agt_kiro',
      model: '',
      systemPrompt: '',
      toolPolicy: 'none',
    },
  })))
  const resumedSession = await client.next(
    (message) => message.type === 'session' && message.sessionId === 'existing-session',
  )
  assert.equal(resumedSession.runId, resumedRunId)
  await client.next((message) => message.type === 'message_delta')
  await client.next((message) => message.type === 'message_delta')
  const resumedDone = await client.next((message) => message.type === 'done')
  assert.equal(resumedDone.runId, resumedRunId)
  assert.equal(resumedDone.reason, 'completed')
  assert.equal(resumedDone.sessionId, 'existing-session')

  const entries = await fixtureRecords(kiroRecordFile)
  const processes = entries.filter((entry) => entry.type === 'spawn')
  assert.equal(processes.length, 3)
  assert.equal(processes.every((entry) => entry.args[0] === 'acp'), true)
  const methods = fixtureRpcMessages(entries).map((message) => message.method)
  assert.deepEqual(methods, [
    'initialize',
    'initialize', 'session/new', 'session/prompt',
    'initialize', 'session/load', 'session/prompt',
  ])
})

test('Kiro Agent sends selected encrypted MCP config using the exact ACP schema', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), '0nex-kiro-mcp-workspace-'))
  const secret = 'mcp-secret-must-stay-server-side'
  const { baseUrl, wsUrl, kiroRecordFile, gatewayDataDir } = await setupGateway(t, {
    kiroFixtureMode: 'normal',
    kiroAcpCwd: workspace,
    workspaces: [{ id: 'mcp-workspace', name: 'MCP workspace', root: workspace }],
  })

  const created = await jsonRequest(`${baseUrl}/admin/mcp-servers`, ADMIN_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      id: 'fixture-mcp',
      name: 'Fixture MCP',
      transport: 'stdio',
      command: process.execPath,
      args: ['fixture-server.mjs'],
      env: { FIXTURE_TOKEN: secret },
      enabled: true,
      trusted: true,
      readOnly: true,
    }),
  })
  assert.equal(created.response.status, 201, JSON.stringify(created.payload))
  assert.equal(created.payload.data.hasSecrets, true)
  assert.equal('env' in created.payload.data, false)
  const persisted = await readFile(join(gatewayDataDir, 'mcp-servers.json'), 'utf8')
  assert.equal(persisted.includes(secret), false)

  const ticket = await issueWsTicket(baseUrl)
  const client = connect(ticketUrl(wsUrl, ticket))
  t.after(() => client.socket.close())
  await client.opened
  await client.next((message) => message.type === 'hello')
  client.socket.send(JSON.stringify(runMessage({
    runId: 'run-mcp-config',
    providerId: 'kiro-agent',
    workspaceId: 'mcp-workspace',
    prompt: 'use the selected MCP server',
    agent: {
      id: 'agt_kiro',
      model: '',
      systemPrompt: '',
      toolPolicy: 'standard',
      mcpServerIds: ['fixture-mcp'],
    },
  })))
  await client.next((message) => message.type === 'done')

  const entries = await fixtureRecords(kiroRecordFile)
  const sessionNew = fixtureRpcMessages(entries).find((message) => message.method === 'session/new')
  assert.deepEqual(sessionNew.params.mcpServers, [{
    name: 'Fixture MCP',
    command: process.execPath,
    args: ['fixture-server.mjs'],
    env: [{ name: 'FIXTURE_TOKEN', value: secret }],
  }])
})

test('Kiro Agent writes inside the selected workspace after allow-once permission', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), '0nex-kiro-workspace-'))
  const target = join(workspace, 'generated.txt')
  const { baseUrl, wsUrl, kiroRecordFile } = await setupGateway(t, {
    kiroFixtureMode: 'tool-write',
    kiroAcpCwd: workspace,
    kiroFixtureToolPath: target,
    workspaces: [{ id: 'workspace-test', name: 'Workspace test', root: workspace }],
  })

  const listed = await jsonRequest(`${baseUrl}/admin/workspaces`, ADMIN_TOKEN)
  assert.equal(listed.response.status, 200)
  assert.deepEqual(listed.payload.data, [{ id: 'workspace-test', name: 'Workspace test' }])

  const ticket = await issueWsTicket(baseUrl)
  const client = connect(ticketUrl(wsUrl, ticket))
  t.after(() => client.socket.close())
  await client.opened
  await client.next((message) => message.type === 'hello')

  const runId = 'run-tool-write'
  client.socket.send(JSON.stringify(runMessage({
    runId,
    providerId: 'kiro-agent',
    workspaceId: 'workspace-test',
    prompt: 'write the generated file',
    agent: { id: 'agt_kiro', model: '', systemPrompt: '', toolPolicy: 'standard' },
  })))

  const permission = await client.next((message) => message.type === 'permission_request')
  assert.equal(permission.runId, runId)
  assert.equal(permission.toolCall.kind, 'write')
  await assert.rejects(readFile(target, 'utf8'), (error) => error.code === 'ENOENT')

  client.socket.send(JSON.stringify({
    type: 'permission_response',
    runId,
    requestId: permission.requestId,
    optionId: 'allow',
  }))
  const toolUpdate = await client.next(
    (message) => message.type === 'tool_call_update' && message.toolCall.status === 'completed',
  )
  assert.equal(toolUpdate.toolCall.toolCallId, 'tool-write-1')
  assert.equal(
    (await client.next((message) => message.type === 'message_delta')).text,
    'write completed',
  )
  const done = await client.next((message) => message.type === 'done')
  assert.equal(done.reason, 'completed')
  assert.equal(await readFile(target, 'utf8'), 'written through ACP\n')

  const entries = await fixtureRecords(kiroRecordFile)
  const runInitialize = fixtureRpcMessages(entries)
    .filter((message) => message.method === 'initialize')
    .at(-1)
  assert.deepEqual(runInitialize.params.clientCapabilities, {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  })
  const created = fixtureRpcMessages(entries).find((message) => message.method === 'session/new')
  assert.equal(await realpath(created.params.cwd), await realpath(workspace))
})

test('Kiro Agent cancellation reaches the ACP subprocess', async (t) => {
  const { baseUrl, wsUrl, kiroRecordFile } = await setupGateway(t, {
    kiroFixtureMode: 'cancel',
    kiroAcpCwd: TEST_DIR,
  })
  const ticket = await issueWsTicket(baseUrl)
  const client = connect(ticketUrl(wsUrl, ticket))
  t.after(() => client.socket.close())
  await client.opened
  const hello = await client.next((message) => message.type === 'hello')
  assert.equal(hello.protocolVersion, 2)

  const runId = 'run-cancel-session'
  client.socket.send(JSON.stringify(runMessage({
    runId,
    providerId: 'kiro-agent',
    sessionId: 'cancel-session',
    prompt: 'wait',
    agent: { id: 'agt_kiro', model: '', systemPrompt: '', toolPolicy: 'none' },
  })))
  await client.next(
    (message) => message.type === 'message_delta' && message.text === 'waiting for cancel',
  )
  client.socket.send(JSON.stringify({ type: 'cancel', runId }))
  const done = await client.next((message) => message.type === 'done')
  assert.equal(done.providerId, 'kiro-agent')
  assert.equal(done.runId, runId)
  assert.equal(done.reason, 'cancelled')
  assert.equal(done.code, null)

  await waitFor(async () => {
    const entries = await fixtureRecords(kiroRecordFile)
    return entries.some((entry) => entry.type === 'cancel')
  })
  const entries = await fixtureRecords(kiroRecordFile)
  assert.equal(
    fixtureRpcMessages(entries).some((message) => message.method === 'session/cancel'),
    true,
  )
})

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

test('canonical Kiro inference provider coexists with the legacy kiro-cli alias', async (t) => {
  const { baseUrl, wsUrl, kiroHttpClient } = await setupGateway(t)
  await createKiroConnection(baseUrl)
  const client = connect(wsUrl)
  t.after(() => client.socket.close())
  await client.opened

  const hello = await client.next((message) => message.type === 'hello')
  const canonical = hello.providers.find((provider) => provider.id === 'kiro-inference')
  const legacy = hello.providers.find((provider) => provider.id === 'kiro-cli')
  assert.equal(canonical.label, 'Kiro HTTPS Inference')
  assert.equal(legacy.label, 'Kiro HTTPS')
  assert.deepEqual(canonical.capabilities, legacy.capabilities)

  client.socket.send(JSON.stringify(runMessage({
    providerId: 'kiro-inference',
    connectionId: 'kiro-main',
    sessionId: 'canonical-inference',
  })))
  const session = await client.next((message) => message.type === 'session')
  assert.equal(session.providerId, 'kiro-inference')
  assert.equal(session.sessionId, 'canonical-inference')
  await client.next((message) => message.type === 'chunk')
  await client.next((message) => message.type === 'chunk')
  const done = await client.next((message) => message.type === 'done')
  assert.equal(done.providerId, 'kiro-inference')
  assert.equal(done.reason, 'completed')
  assert.equal(kiroHttpClient.calls.length, 1)
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
  assert.deepEqual(created.models, ['auto', 'claude-sonnet-5'])
  assert.deepEqual(created.availableModels, ['auto', 'claude-sonnet-5'])
  assert.equal('apiKey' in created, false)
  assert.deepEqual(kiroBearerValidator.calls, [{ apiKey: DEFAULT_SECRET, region: 'us-east-1' }])

  const models = await jsonRequest(`${baseUrl}/v1/models`, API_TOKEN)
  assert.equal(models.response.status, 200)
  assert.deepEqual(models.payload.data.map((model) => model.id), [
    'kiro-main/auto',
    'kiro-main/claude-sonnet-5',
  ])

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

test('Kiro model catalog preserves activation choices and gates explicit inference', async (t) => {
  const { baseUrl, kiroBearerValidator, kiroHttpClient } = await setupGateway(t)
  await createKiroConnection(baseUrl)

  const deactivated = await jsonRequest(`${baseUrl}/admin/connections/kiro-main`, ADMIN_TOKEN, {
    method: 'PATCH',
    body: JSON.stringify({ models: ['auto'] }),
  })
  assert.equal(deactivated.response.status, 200, JSON.stringify(deactivated.payload))
  assert.deepEqual(deactivated.payload.data.models, ['auto'])
  assert.deepEqual(deactivated.payload.data.availableModels, ['auto', 'claude-sonnet-5'])

  const inactiveModels = await jsonRequest(`${baseUrl}/v1/models`, API_TOKEN)
  assert.deepEqual(inactiveModels.payload.data.map((model) => model.id), ['kiro-main/auto'])

  const rejected = await jsonRequest(`${baseUrl}/v1/chat/completions`, API_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      model: 'kiro-main/claude-sonnet-5',
      messages: [{ role: 'user', content: 'must not reach upstream' }],
    }),
  })
  assert.equal(rejected.response.status, 400, JSON.stringify(rejected.payload))
  assert.equal(rejected.payload.error.code, 'kiro_model_not_active')
  assert.equal(kiroHttpClient.calls.length, 0)

  const liveTest = await jsonRequest(
    `${baseUrl}/admin/connections/kiro-main/models/claude-sonnet-5/test`,
    ADMIN_TOKEN,
    { method: 'POST' },
  )
  assert.equal(liveTest.response.status, 200, JSON.stringify(liveTest.payload))
  assert.equal(liveTest.payload.data.model, 'kiro-main/claude-sonnet-5')
  assert.equal(kiroHttpClient.calls[0].model, 'claude-sonnet-5')
  assert.equal(kiroHttpClient.calls[0].systemPrompt, undefined)
  assert.deepEqual(kiroHttpClient.calls[0].messages, [
    { role: 'user', text: 'Reply with OK only.' },
  ])

  kiroBearerValidator.models = ['auto', 'claude-sonnet-5', 'claude-opus-5']
  const refreshed = await jsonRequest(`${baseUrl}/admin/connections/kiro-main/test`, ADMIN_TOKEN, {
    method: 'POST',
  })
  assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.payload))
  assert.deepEqual(refreshed.payload.data.models, ['auto', 'claude-sonnet-5', 'claude-opus-5'])
  assert.deepEqual(refreshed.payload.data.activeModels, ['auto'])

  const listed = await jsonRequest(`${baseUrl}/admin/connections`, ADMIN_TOKEN)
  assert.deepEqual(listed.payload.data[0].models, ['auto'])
  assert.deepEqual(listed.payload.data[0].availableModels, [
    'auto',
    'claude-sonnet-5',
    'claude-opus-5',
  ])

  const activated = await jsonRequest(`${baseUrl}/admin/connections/kiro-main`, ADMIN_TOKEN, {
    method: 'PATCH',
    body: JSON.stringify({ models: ['auto', 'claude-sonnet-5'] }),
  })
  assert.equal(activated.response.status, 200, JSON.stringify(activated.payload))

  const completion = await jsonRequest(`${baseUrl}/v1/chat/completions`, API_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      model: 'kiro-main/claude-sonnet-5',
      messages: [{ role: 'user', content: 'use the selected model' }],
    }),
  })
  assert.equal(completion.response.status, 200, JSON.stringify(completion.payload))
  assert.equal(completion.payload.model, 'kiro-main/claude-sonnet-5')
  assert.equal(kiroHttpClient.calls.at(-1).model, 'claude-sonnet-5')
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
  assert.deepEqual(tested.payload.data.models, ['auto', 'claude-sonnet-5'])
  assert.deepEqual(tested.payload.data.activeModels, ['auto', 'claude-sonnet-5'])
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

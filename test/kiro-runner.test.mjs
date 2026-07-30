import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createKiroRunner, parseKiroModelList } from '../server/gateway/kiro-runner.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(TEST_DIR, 'fixtures', 'kiro-cli-fixture.mjs')

async function setup(mode = 'normal', overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), '0nex-kiro-runner-'))
  const dataDir = join(root, 'gateway-data')
  const recordFile = join(root, 'fixture.jsonl')
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'normal-home'),
    USERPROFILE: join(root, 'normal-home'),
    KIRO_API_KEY: 'inherited-key-that-must-not-win',
    KIRO_FIXTURE_MODE: mode,
    KIRO_FIXTURE_RECORD: recordFile,
    ...overrides.env,
  }
  const customExecutable = overrides.executable !== undefined
  const runner = createKiroRunner({
    executable: customExecutable ? overrides.executable : process.execPath,
    executableArgs: customExecutable ? [] : [FIXTURE],
    env,
    dataDir,
    timeoutMs: overrides.timeoutMs ?? 2_000,
    killGraceMs: overrides.killGraceMs ?? 30,
    maxOutputBytes: overrides.maxOutputBytes ?? 100_000,
  })
  return { root, dataDir, recordFile, env, runner }
}

async function records(path) {
  const raw = await readFile(path, 'utf8')
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function rpcMessages(entries) {
  return entries.filter((entry) => entry.type === 'rpc').map((entry) => entry.message)
}

async function runStart(runner, request) {
  const chunks = []
  const errors = []
  const completed = []
  const sessions = []
  const controller = runner.start(request, {
    onSession: (sessionId) => sessions.push(sessionId),
    onChunk: (chunk) => chunks.push(chunk),
    onDone: (result) => completed.push(result),
    onError: (message, error) => errors.push({ message, error }),
  })
  const result = await controller.done
  return { controller, chunks, errors, completed, sessions, result }
}

async function runHeadless(runner, request) {
  const chunks = []
  const errors = []
  const completed = []
  const controller = runner.startHeadless(request, {
    onChunk: (chunk) => chunks.push(chunk),
    onDone: (result) => completed.push(result),
    onError: (message, error) => errors.push({ message, error }),
  })
  const result = await controller.done
  return { controller, chunks, errors, completed, result }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  throw new Error('Timeout menunggu kondisi fixture')
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

test('parseKiroModelList only returns explicit IDs from known containers', () => {
  assert.deepEqual(parseKiroModelList({
    models: [{ id: 'model-a', name: 'A' }, { modelId: 'model-b' }, 'model-c', { name: 'display only' }],
    data: [{ model_id: 'model-d' }],
    unrelated: { id: 'not-a-model' },
  }), ['model-a', 'model-b', 'model-c', 'model-d'])
})

test('probe performs a real ACP initialize handshake and reports runtime capabilities', async () => {
  const { runner, recordFile } = await setup()

  const status = await runner.probe({
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  })

  assert.deepEqual(status, {
    available: true,
    executable: process.execPath,
    version: '1.0.0',
    acpProtocolVersion: 1,
    supports: {
      acp: true,
      loadSession: true,
      mcpTransports: [],
    },
  })
  const entries = await records(recordFile)
  assert.deepEqual(entries[0].args, ['acp'])
  assert.equal(entries[0].cwd, TEST_DIR)
  assert.deepEqual(rpcMessages(entries).map((message) => message.method), ['initialize'])
})

test('probe reports a missing executable without throwing', async () => {
  const { runner } = await setup('normal', {
    executable: join(tmpdir(), 'definitely-missing-kiro-cli-probe'),
  })

  const status = await runner.probe({ auth: { type: 'account-session' } })
  assert.equal(status.available, false)
  assert.equal(status.code, 'KIRO_CLI_NOT_FOUND')
  assert.match(status.reason, /tidak ditemukan/)
  assert.deepEqual(status.supports, {
    acp: false,
    loadSession: false,
    mcpTransports: [],
  })
})

test('whoami/checkAuth and model listing use real CLI subprocesses', async () => {
  const { runner, recordFile, env } = await setup()

  const identity = await runner.whoami({ auth: { type: 'account-session' } })
  assert.equal(identity.authMethod, 'account-session')
  assert.deepEqual(await runner.checkAuth({ auth: { type: 'account-session' } }), {
    authenticated: true,
    identity: {
      authenticated: true,
      authMethod: 'account-session',
      user: 'fixture-user',
    },
  })
  assert.deepEqual(await runner.listModels({ auth: { type: 'account-session' } }), [
    'kiro-auto',
    'claude-sonnet-4',
    'kiro-fast',
    'raw-model-id',
  ])

  const entries = await records(recordFile)
  assert.deepEqual(entries.map((entry) => entry.args), [
    ['whoami', '--format', 'json'],
    ['whoami', '--format', 'json'],
    ['chat', '--list-models', '--format', 'json'],
  ])
  for (const entry of entries) {
    assert.equal(entry.home, env.HOME)
    assert.equal(entry.apiKeyPresent, false)
  }
})

test('api-key auth gets isolated HOME and never puts its secret in args or parent env', async () => {
  const { runner, dataDir, recordFile } = await setup()
  const secret = 'ksk_fixture_super_secret'
  const parentValue = process.env.KIRO_API_KEY

  const identity = await runner.whoami({ auth: { type: 'api-key', secret } })
  assert.equal(identity.authMethod, 'api-key')
  assert.equal(process.env.KIRO_API_KEY, parentValue)

  const raw = await readFile(recordFile, 'utf8')
  assert.equal(raw.includes(secret), false)
  const [spawnRecord] = await records(recordFile)
  assert.equal(spawnRecord.apiKeyPresent, true)
  assert.deepEqual(spawnRecord.args, ['whoami', '--format', 'json'])
  assert.equal(spawnRecord.args.some((arg) => arg.includes(secret)), false)
  assert.equal(spawnRecord.home.startsWith(join(dataDir, 'kiro', 'api-key') + sep), true)
  assert.equal(spawnRecord.userProfile, spawnRecord.home)
  await access(spawnRecord.home)
})

test('authentication failures redact API-key secrets', async () => {
  const { runner } = await setup('command-fail')
  const secret = 'ksk_failure_must_be_redacted'

  const result = await runner.checkAuth({ auth: { type: 'api-key', secret } })
  assert.equal(result.authenticated, false)
  assert.equal(result.error.includes(secret), false)
  assert.match(result.error, /\[redacted\]/)
})

test('headless API-key mode keeps prompt out of args and buffers stdout', async () => {
  const { runner, recordFile, dataDir } = await setup()
  const secret = 'ksk_headless_secret'
  const prompt = 'sensitive prompt from stdin'
  const execution = await runHeadless(runner, {
    prompt,
    systemPrompt: 'answer briefly',
    auth: { type: 'api-key', secret },
  })

  assert.deepEqual(execution.chunks, ['hello from fixture'])
  assert.equal(execution.errors.length, 0)
  assert.equal(execution.completed.length, 1)
  assert.equal(execution.result.reason, 'completed')
  assert.equal(execution.result.sessionId, null)

  const entries = await records(recordFile)
  const spawn = entries.find((entry) => entry.type === 'spawn')
  const input = entries.find((entry) => entry.type === 'headless-input')
  assert.deepEqual(spawn.args, [
    'chat',
    '--no-interactive',
    'Jawab permintaan pada standard input. Jangan gunakan tool.',
  ])
  assert.equal(spawn.args.some((arg) => arg.includes(prompt) || arg.includes(secret)), false)
  assert.equal(spawn.apiKeyPresent, true)
  assert.equal(spawn.home.startsWith(join(dataDir, 'kiro', 'api-key') + sep), true)
  assert.equal(await realpath(spawn.cwd), await realpath(join(dataDir, 'kiro', 'headless')))
  assert.equal(input.input, '<system-instructions>\nanswer briefly\n</system-instructions>\n\nsensitive prompt from stdin')
  assert.equal(JSON.stringify(entries).includes(secret), false)
})

test('validation and inference inject the selected AWS region only through child env', async () => {
  const { runner, recordFile } = await setup()
  const secret = 'ksk_regional_secret'

  await runner.validateApiKey({
    apiKey: secret,
    region: 'eu-central-1',
  })
  await runHeadless(runner, {
    prompt: 'regional inference',
    auth: { type: 'api-key', secret, region: 'eu-central-1' },
  })

  const entries = await records(recordFile)
  const spawns = entries.filter((entry) => entry.type === 'spawn')
  assert.equal(spawns.length, 2)
  for (const spawn of spawns) {
    assert.equal(spawn.awsRegion, 'eu-central-1')
    assert.equal(spawn.awsDefaultRegion, 'eu-central-1')
    assert.equal(spawn.args.some((arg) => arg.includes('eu-central-1') || arg.includes(secret)), false)
  }
})

test('validateApiKey reaches headless AWS flow and rejects invalid bearer credentials', async () => {
  const valid = await setup()
  assert.deepEqual(
    await valid.runner.validateApiKey({ apiKey: 'ksk_valid_fixture' }),
    { authenticated: true, credentialType: 'bearer' },
  )
  const validEntries = await records(valid.recordFile)
  assert.equal(
    validEntries.some((entry) => entry.type === 'headless-input' && entry.input === 'Reply with OK only. Do not use tools.'),
    true,
  )

  const rejected = await setup('auth-reject')
  const secret = 'ksk_rejected_runner_secret'
  assert.equal(
    (await rejected.runner.whoami({ auth: { type: 'api-key', secret } })).authenticated,
    true,
  )
  await assert.rejects(
    rejected.runner.validateApiKey({ apiKey: secret }),
    (error) => error.code === 'KIRO_AUTH_REJECTED'
      && !error.message.includes(secret)
      && /ditolak oleh AWS/.test(error.message),
  )
  assert.equal((await readFile(rejected.recordFile, 'utf8')).includes(secret), false)
})

test('headless mode requires an API key and redacts command failures', async () => {
  const missing = await setup()
  const missingRun = await runHeadless(missing.runner, {
    prompt: 'hello',
    auth: { type: 'account-session' },
  })
  assert.equal(missingRun.result.reason, 'failed')
  assert.equal(missingRun.result.error.code, 'KIRO_API_KEY_REQUIRED')

  const failing = await setup('headless-fail')
  const secret = 'ksk_headless_failure_secret'
  const failedRun = await runHeadless(failing.runner, {
    prompt: 'hello',
    auth: { type: 'api-key', secret },
  })
  assert.equal(failedRun.result.reason, 'failed')
  assert.equal(failedRun.result.error.code, 'KIRO_COMMAND_FAILED')
  assert.equal(failedRun.errors[0].message.includes(secret), false)
  assert.match(failedRun.errors[0].message, /\[redacted\]/)
})

test('headless cancel terminates a child running on the gateway host', async () => {
  const { runner, recordFile } = await setup('cancel', { killGraceMs: 20 })
  const controller = runner.startHeadless({
    prompt: 'wait',
    auth: { type: 'api-key', secret: 'ksk_cancel' },
  })
  await waitFor(async () => {
    try {
      return (await records(recordFile)).some((entry) => entry.type === 'headless-input')
    } catch {
      return false
    }
  })
  const spawn = (await records(recordFile)).find((entry) => entry.type === 'spawn')
  controller.cancel()
  const result = await controller.done
  assert.equal(result.reason, 'cancelled')
  await waitFor(() => !processIsRunning(spawn.pid))
})

test('new session initializes ACP, sets model, streams fragmented chunks, and completes', async () => {
  const { runner, recordFile } = await setup()
  const cwd = resolve(TEST_DIR)
  const execution = await runStart(runner, {
    sessionId: 'caller-id-is-not-used-for-new',
    resume: false,
    model: 'claude-sonnet-4',
    prompt: 'hello',
    systemPrompt: 'answer briefly',
    toolPolicy: 'none',
    auth: { type: 'account-session' },
    cwd,
  })

  assert.deepEqual(execution.chunks, ['hello ', 'from fixture'])
  assert.equal(execution.errors.length, 0)
  assert.equal(execution.completed.length, 1)
  assert.equal(execution.result.sessionId, 'fixture-new-session')
  assert.equal(execution.result.reason, 'end_turn')
  assert.deepEqual(execution.sessions, ['fixture-new-session'])

  const messages = rpcMessages(await records(recordFile))
  assert.deepEqual(messages.map((message) => message.method), [
    'initialize',
    'session/new',
    'session/set_model',
    'session/prompt',
  ])
  assert.equal(messages[0].params.protocolVersion, 1)
  assert.deepEqual(messages[0].params.clientCapabilities, {})
  assert.deepEqual(messages[1].params, { cwd, mcpServers: [] })
  assert.deepEqual(messages[2].params, {
    sessionId: 'fixture-new-session',
    modelId: 'claude-sonnet-4',
  })
  assert.deepEqual(messages[3].params.prompt, [{
    type: 'text',
    text: '<system-instructions>\nanswer briefly\n</system-instructions>\n\nhello',
  }])
})

test('forwards structured ACP events and reports unknown extensions diagnostically', async () => {
  const { runner } = await setup('structured-events')
  const thoughts = []
  const plans = []
  const diagnostics = []
  const chunks = []
  const controller = runner.start({
    resume: false,
    prompt: 'inspect the workspace',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  }, {
    onChunk: (chunk) => chunks.push(chunk),
    onThought: (text, update) => thoughts.push({ text, update }),
    onPlan: (plan) => plans.push(plan),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  })

  const result = await controller.done
  assert.equal(result.reason, 'end_turn')
  assert.deepEqual(chunks, ['hello ', 'from fixture'])
  assert.equal(thoughts[0].text, 'thinking safely')
  assert.equal(thoughts[0].update.sessionUpdate, 'agent_thought_chunk')
  assert.deepEqual(plans[0].entries, [{ content: 'inspect files', status: 'pending' }])
  assert.deepEqual(diagnostics, [{
    type: 'unknown_session_update',
    update: {
      sessionUpdate: 'future_extension',
      value: 42,
    },
  }])
})

test('normalizes legacy Kiro event casing as a compatibility fallback', async () => {
  const { runner } = await setup('legacy-events')
  const execution = await runStart(runner, {
    resume: false,
    prompt: 'legacy events',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  })

  assert.deepEqual(execution.chunks, ['hello ', 'from fixture'])
  assert.equal(execution.result.reason, 'end_turn')
})

test('resume uses session/load and preserves requested session ID', async () => {
  const { runner, recordFile } = await setup()
  const execution = await runStart(runner, {
    sessionId: 'existing-session',
    resume: true,
    prompt: 'continue',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  })

  assert.equal(execution.result.sessionId, 'existing-session')
  assert.equal(execution.result.reason, 'end_turn')
  assert.deepEqual(execution.sessions, ['existing-session'])
  const messages = rpcMessages(await records(recordFile))
  assert.deepEqual(messages.map((message) => message.method), [
    'initialize',
    'session/load',
    'session/prompt',
  ])
  assert.equal(messages[1].params.sessionId, 'existing-session')
})

test('resume ignores replayed history from session/load', async () => {
  const { runner } = await setup('load-replay')
  const execution = await runStart(runner, {
    sessionId: 'existing-session',
    resume: true,
    prompt: 'continue',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  })

  assert.deepEqual(execution.chunks, ['hello ', 'from fixture'])
  assert.equal(execution.chunks.includes('old replayed output'), false)
  assert.equal(execution.result.reason, 'end_turn')
})

test('TurnEnd completes a run when session/prompt response is absent', async () => {
  const { runner } = await setup('turnend-only')
  const execution = await runStart(runner, {
    resume: false,
    prompt: 'finish from notification',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  })

  assert.deepEqual(execution.chunks, ['hello ', 'from fixture'])
  assert.equal(execution.errors.length, 0)
  assert.equal(execution.result.reason, 'end_turn')
  assert.equal(execution.result.stopReason, 'end_turn')
})

test('cancel sends session/cancel and reports a cancelled turn', async () => {
  const { runner, recordFile } = await setup('cancel')
  const chunks = []
  const controller = runner.start({
    resume: false,
    prompt: 'wait',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  }, {
    onChunk: (chunk) => {
      chunks.push(chunk)
      if (chunk === 'waiting for cancel') controller.cancel()
    },
  })

  const result = await controller.done
  assert.deepEqual(chunks, ['waiting for cancel'])
  assert.equal(result.reason, 'cancelled')
  const entries = await records(recordFile)
  assert.equal(rpcMessages(entries).some((message) => message.method === 'session/cancel'), true)
  assert.equal(entries.some((entry) => entry.type === 'cancel' && entry.sessionId === 'fixture-new-session'), true)
})

test('dispose sends session/cancel before process termination', async () => {
  const { runner, recordFile } = await setup('cancel', { killGraceMs: 20 })
  let controller
  controller = runner.start({
    resume: false,
    prompt: 'wait',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  }, {
    onChunk: (chunk) => {
      if (chunk === 'waiting for cancel') controller.dispose()
    },
  })

  const result = await controller.done
  assert.equal(result.reason, 'disposed')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  const entries = await records(recordFile)
  assert.equal(rpcMessages(entries).some((message) => message.method === 'session/cancel'), true)
  assert.equal(entries.some((entry) => entry.type === 'cancel' && entry.sessionId === 'fixture-new-session'), true)
})

test('inference-only mode rejects permission requests instead of granting tools', async () => {
  const { runner, recordFile } = await setup('permission')
  const execution = await runStart(runner, {
    resume: false,
    prompt: 'try a tool',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  })

  assert.equal(execution.errors.length, 0)
  assert.deepEqual(execution.chunks, ['permission denied safely'])
  const entries = await records(recordFile)
  const permission = entries.find((entry) => entry.type === 'permission-response')?.message
  assert.deepEqual(permission.result, {
    outcome: { outcome: 'selected', optionId: 'reject' },
  })
})

test('inference-only mode fails clearly if a tool starts without permission', async () => {
  const { runner, recordFile } = await setup('active-tool')
  const execution = await runStart(runner, {
    resume: false,
    prompt: 'start a tool',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  })

  assert.equal(execution.result.reason, 'failed')
  assert.equal(execution.result.error.code, 'KIRO_TOOLS_UNSUPPORTED')
  assert.match(execution.errors[0].message, /inference-only/)
  const messages = rpcMessages(await records(recordFile))
  assert.equal(messages.some((message) => message.method === 'session/cancel'), true)
})

test('malformed command output and oversized output return stable errors', async () => {
  const malformed = await setup('malformed-command')
  await assert.rejects(
    malformed.runner.listModels({ auth: { type: 'account-session' } }),
    (error) => error.code === 'KIRO_MALFORMED_OUTPUT' && !error.message.includes('not-json'),
  )

  const oversized = await setup('oversized-command', { maxOutputBytes: 100 })
  await assert.rejects(
    oversized.runner.listModels({ auth: { type: 'account-session' } }),
    (error) => error.code === 'KIRO_MAX_OUTPUT',
  )
})

test('oversized command output force-kills a child that ignores SIGTERM', async () => {
  const { runner, recordFile } = await setup('oversized-command-hang', {
    maxOutputBytes: 100,
    killGraceMs: 20,
  })
  await assert.rejects(
    runner.listModels({ auth: { type: 'account-session' } }),
    (error) => error.code === 'KIRO_MAX_OUTPUT',
  )

  const entries = await records(recordFile)
  const spawn = entries.find((entry) => entry.type === 'spawn')
  await waitFor(() => !processIsRunning(spawn.pid))
})

test('missing executable and command timeout are mapped deterministically', async () => {
  const missing = await setup('normal', { executable: join(tmpdir(), 'definitely-missing-kiro-cli') })
  await assert.rejects(
    missing.runner.whoami({ auth: { type: 'account-session' } }),
    (error) => error.code === 'KIRO_CLI_NOT_FOUND',
  )

  const timeout = await setup('timeout', { timeoutMs: 40, killGraceMs: 20 })
  await assert.rejects(
    timeout.runner.whoami({ auth: { type: 'account-session' } }),
    (error) => error.code === 'KIRO_TIMEOUT',
  )
})

test('malformed ACP and ACP timeout terminate the subprocess safely', async () => {
  const malformed = await setup('malformed-acp')
  const malformedRun = await runStart(malformed.runner, {
    resume: false,
    prompt: 'hello',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  })
  assert.equal(malformedRun.result.reason, 'failed')
  assert.equal(malformedRun.result.error.code, 'KIRO_ACP_MALFORMED_JSON')

  const timeout = await setup('acp-timeout', { timeoutMs: 40, killGraceMs: 20 })
  const timedRun = await runStart(timeout.runner, {
    resume: false,
    prompt: 'hello',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  })
  assert.equal(timedRun.result.reason, 'timeout')
  assert.equal(timedRun.result.error.code, 'KIRO_TIMEOUT')
})

test('broken ACP stdin returns a controlled error instead of crashing on EPIPE', async () => {
  const { runner } = await setup('broken-stdin', { timeoutMs: 2_000, killGraceMs: 20 })
  const execution = await runStart(runner, {
    resume: false,
    prompt: 'hello',
    auth: { type: 'account-session' },
    cwd: TEST_DIR,
  })

  assert.equal(execution.result.reason, 'failed')
  assert.equal(execution.result.error.code, 'KIRO_ACP_CLOSED')
  assert.equal(execution.errors.length, 1)
})

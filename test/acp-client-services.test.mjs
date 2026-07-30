import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createAcpClientServices,
  createToolPolicyGuard,
} from '../server/gateway/acp-client-services.mjs'

async function setup(policy = 'none', overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), '0nex-acp-services-'))
  const outside = await mkdtemp(join(tmpdir(), '0nex-acp-outside-'))
  const guard = createToolPolicyGuard(policy)
  const services = createAcpClientServices({
    workspaceRoot: root,
    policy,
    guard,
    baseEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KIRO_API_KEY: 'must-not-reach-terminal',
      AWS_SECRET_ACCESS_KEY: 'must-not-reach-terminal',
    },
    killGraceMs: 20,
    ...overrides,
  })
  return { root, outside, guard, services }
}

function grant(guard, kind, action = 'allow') {
  const params = {
    toolCall: { toolCallId: `tool-${kind}`, kind },
    options: [
      { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ],
  }
  guard.recordPermission(params, {
    outcome: { outcome: 'selected', optionId: action },
  })
}

function request(method, params) {
  return { jsonrpc: '2.0', id: 1, method, params }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timeout menunggu kondisi test')
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

test('read-only policy exposes only file reads with ranges', async () => {
  const { root, services } = await setup('read-only')
  const path = join(root, 'notes.txt')
  await writeFile(path, 'one\ntwo\nthree\n', 'utf8')

  assert.deepEqual(services.capabilities, {
    fs: { readTextFile: true, writeTextFile: false },
  })
  assert.deepEqual(await services.handle(request('fs/read_text_file', {
    path,
    line: 2,
    limit: 1,
  })), { content: 'two\n' })

  await assert.rejects(
    services.handle(request('fs/write_text_file', { path, content: 'changed' })),
    (error) => error.code === 'ACP_TOOL_DENIED',
  )
  await assert.rejects(
    services.handle(request('terminal/create', { command: process.execPath })),
    (error) => error.code === 'ACP_TOOL_DENIED',
  )
  services.dispose()
})

test('filesystem rejects traversal, symlink escape, invalid UTF-8, and oversized files', async () => {
  const { root, outside, services } = await setup('read-only', { maxFileBytes: 8 })
  const outsideFile = join(outside, 'secret.txt')
  const link = join(root, 'escape.txt')
  const invalid = join(root, 'invalid.txt')
  const oversized = join(root, 'large.txt')
  await writeFile(outsideFile, 'secret', 'utf8')
  await symlink(outsideFile, link)
  await writeFile(invalid, Buffer.from([0xff, 0xfe]))
  await writeFile(oversized, '123456789', 'utf8')

  for (const [path, code] of [
    [outsideFile, 'ACP_PATH_OUTSIDE_WORKSPACE'],
    [link, 'ACP_PATH_OUTSIDE_WORKSPACE'],
    [invalid, 'ACP_INVALID_UTF8'],
    [oversized, 'ACP_FILE_TOO_LARGE'],
  ]) {
    await assert.rejects(
      services.handle(request('fs/read_text_file', { path })),
      (error) => error.code === code,
    )
  }
  services.dispose()
})

test('standard policy consumes write permission once and writes atomically', async () => {
  const { root, guard, services } = await setup('standard')
  const path = join(root, 'config.json')
  grant(guard, 'write')

  assert.equal(await services.handle(request('fs/write_text_file', {
    path,
    content: '{"safe":true}\n',
  })), null)
  assert.equal(await readFile(path, 'utf8'), '{"safe":true}\n')

  await assert.rejects(
    services.handle(request('fs/write_text_file', { path, content: 'second write' })),
    (error) => error.code === 'ACP_PERMISSION_REQUIRED',
  )
  services.dispose()
})

test('terminal lifecycle uses no shell, redacts parent secrets, and truncates at UTF-8 boundaries', async () => {
  const { root, guard, services } = await setup('standard', { maxOutputBytes: 32 })
  grant(guard, 'execute')
  const script = [
    "process.stdout.write('prefix-' + '🙂'.repeat(20))",
    "process.stdout.write('\\nsecret=' + String(process.env.KIRO_API_KEY))",
    "process.stdout.write('\\ncwd=' + process.cwd())",
  ].join(';')
  const created = await services.handle(request('terminal/create', {
    command: process.execPath,
    args: ['-e', script],
    cwd: root,
    outputByteLimit: 24,
    env: [{ name: 'NODE_ENV', value: 'test' }],
  }))
  assert.match(created.terminalId, /^term_/)

  const exit = await services.handle(request('terminal/wait_for_exit', {
    terminalId: created.terminalId,
  }))
  assert.deepEqual(exit, { exitCode: 0, signal: null })
  const output = await services.handle(request('terminal/output', {
    terminalId: created.terminalId,
  }))
  assert.equal(output.truncated, true)
  assert.equal(Buffer.byteLength(output.output, 'utf8') <= 24, true)
  assert.equal(output.output.includes('must-not-reach-terminal'), false)
  assert.doesNotMatch(output.output, /�/u)
  assert.deepEqual(output.exitStatus, { exitCode: 0, signal: null })
  assert.equal(await services.handle(request('terminal/release', {
    terminalId: created.terminalId,
  })), null)
  await assert.rejects(
    services.handle(request('terminal/output', { terminalId: created.terminalId })),
    (error) => error.code === 'ACP_TERMINAL_NOT_FOUND',
  )
  services.dispose()
})

test('terminal rejects secret env names and release cleans up a running process', async () => {
  const { root, guard, services } = await setup('standard')
  grant(guard, 'execute')
  await assert.rejects(
    services.handle(request('terminal/create', {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
      env: [{ name: 'KIRO_API_KEY', value: 'leak' }],
    })),
    (error) => error.code === 'ACP_TERMINAL_ENV_DENIED',
  )

  grant(guard, 'execute')
  const created = await services.handle(request('terminal/create', {
    command: process.execPath,
    args: ['-e', "process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000)"],
    cwd: root,
  }))
  let pid = null
  await waitFor(async () => {
    const output = await services.handle(request('terminal/output', { terminalId: created.terminalId }))
    pid = Number(output.output.trim())
    return Number.isInteger(pid) && pid > 0
  })
  assert.equal(processIsRunning(pid), true)
  await services.handle(request('terminal/kill', { terminalId: created.terminalId }))
  await services.handle(request('terminal/wait_for_exit', { terminalId: created.terminalId }))
  await services.handle(request('terminal/release', { terminalId: created.terminalId }))
  await waitFor(() => !processIsRunning(pid))
  services.dispose()
})

test('disposing services terminates every active terminal', async () => {
  const { root, guard, services } = await setup('standard')
  grant(guard, 'execute')
  const created = await services.handle(request('terminal/create', {
    command: process.execPath,
    args: ['-e', "process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000)"],
    cwd: root,
  }))
  let pid = null
  await waitFor(async () => {
    const output = await services.handle(request('terminal/output', { terminalId: created.terminalId }))
    pid = Number(output.output.trim())
    return Number.isInteger(pid) && pid > 0
  })
  services.dispose()
  await waitFor(() => !processIsRunning(pid))
})

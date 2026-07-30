import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const DEFAULT_MAX_FILE_BYTES = 2_000_000
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000
const DEFAULT_MAX_TERMINALS = 4
const TERMINAL_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR',
  'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'TZ',
  'NODE_ENV', 'NO_COLOR', 'FORCE_COLOR', 'CI',
])
const TOOL_ACTIONS = new Set(['fs.read', 'fs.write', 'terminal.create'])

export class AcpClientServiceError extends Error {
  constructor(message, { code = 'ACP_CLIENT_SERVICE_ERROR', cause } = {}) {
    super(message, { cause })
    this.name = 'AcpClientServiceError'
    this.code = code
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function assertContained(root, target) {
  const rel = relative(root, target)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return
  throw new AcpClientServiceError('Path berada di luar workspace.', { code: 'ACP_PATH_OUTSIDE_WORKSPACE' })
}

async function existingPath(root, requestedPath) {
  if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) {
    throw new AcpClientServiceError('ACP path harus absolute.', { code: 'ACP_INVALID_PATH' })
  }
  let target
  try {
    target = await realpath(requestedPath)
  } catch (cause) {
    throw new AcpClientServiceError('Path tidak ditemukan.', { code: 'ACP_PATH_NOT_FOUND', cause })
  }
  assertContained(root, target)
  return target
}

async function writablePath(root, requestedPath) {
  if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) {
    throw new AcpClientServiceError('ACP path harus absolute.', { code: 'ACP_INVALID_PATH' })
  }
  const absolute = resolve(requestedPath)
  const parent = await existingPath(root, dirname(absolute))
  assertContained(root, parent)
  let existing = null
  try {
    existing = await lstat(absolute)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (existing?.isSymbolicLink()) {
    throw new AcpClientServiceError('Write melalui symbolic link ditolak.', { code: 'ACP_SYMLINK_WRITE_DENIED' })
  }
  if (existing) {
    const resolvedExisting = await realpath(absolute)
    assertContained(root, resolvedExisting)
    if (!existing.isFile()) {
      throw new AcpClientServiceError('Target write bukan file.', { code: 'ACP_INVALID_PATH' })
    }
  }
  return join(parent, absolute.slice(dirname(absolute).length + 1))
}

function selectedOption(decision, params) {
  const optionId = decision?.outcome?.outcome === 'selected'
    ? decision.outcome.optionId
    : null
  if (!optionId) return null
  return (params?.options ?? []).find((option) => option?.optionId === optionId) ?? null
}

function actionsForToolCall(toolCall) {
  const kind = String(toolCall?.kind ?? '').toLowerCase()
  if (kind === 'read' || kind === 'search' || kind === 'fetch') return ['fs.read']
  if (kind === 'edit' || kind === 'write' || kind === 'delete' || kind === 'move') return ['fs.write']
  if (kind === 'execute') return ['terminal.create']
  return []
}

export function createToolPolicyGuard(policy = 'none') {
  const grants = new Map()

  function recordPermission(params, decision) {
    if (policy !== 'standard') return
    const option = selectedOption(decision, params)
    if (!option || !String(option.kind).startsWith('allow')) return
    for (const action of actionsForToolCall(params?.toolCall)) {
      grants.set(action, (grants.get(action) ?? 0) + 1)
    }
  }

  function authorize(action) {
    if (!TOOL_ACTIONS.has(action)) {
      throw new AcpClientServiceError(`Tool action tidak dikenal: ${action}`, { code: 'ACP_TOOL_DENIED' })
    }
    if (policy === 'read-only' && action === 'fs.read') return
    if (policy !== 'standard') {
      throw new AcpClientServiceError(`Tool action ditolak oleh policy ${policy}.`, { code: 'ACP_TOOL_DENIED' })
    }
    const count = grants.get(action) ?? 0
    if (count <= 0) {
      throw new AcpClientServiceError('Tool action membutuhkan permission allow-once.', {
        code: 'ACP_PERMISSION_REQUIRED',
      })
    }
    if (count === 1) grants.delete(action)
    else grants.set(action, count - 1)
  }

  return { policy, recordPermission, authorize }
}

function terminateProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try { child.kill(signal) } catch { /* already exited */ }
  }
}

function trimUtf8Start(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return value
  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

function safeTerminalEnv(baseEnv, requested = []) {
  const env = {}
  for (const name of TERMINAL_ENV_ALLOWLIST) {
    if (typeof baseEnv[name] === 'string') env[name] = baseEnv[name]
  }
  if (!Array.isArray(requested)) {
    throw new AcpClientServiceError('terminal env harus berupa array.', { code: 'ACP_INVALID_TERMINAL' })
  }
  for (const variable of requested) {
    const name = variable?.name
    const value = variable?.value
    if (!TERMINAL_ENV_ALLOWLIST.has(name) || typeof value !== 'string') {
      throw new AcpClientServiceError(`Environment variable terminal ditolak: ${String(name)}`, {
        code: 'ACP_TERMINAL_ENV_DENIED',
      })
    }
    env[name] = value
  }
  return env
}

export function createAcpClientServices({
  workspaceRoot,
  policy = 'none',
  guard = createToolPolicyGuard(policy),
  spawn = nodeSpawn,
  baseEnv = process.env,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxTerminals = DEFAULT_MAX_TERMINALS,
  killGraceMs = 1_000,
} = {}) {
  let root
  try {
    root = realpathSync(resolve(workspaceRoot ?? ''))
  } catch (cause) {
    throw new AcpClientServiceError('Workspace root tidak dapat diakses.', {
      code: 'WORKSPACE_UNAVAILABLE',
      cause,
    })
  }
  const fileLimit = positiveInteger(maxFileBytes, DEFAULT_MAX_FILE_BYTES)
  const outputLimit = positiveInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
  const terminalLimit = positiveInteger(maxTerminals, DEFAULT_MAX_TERMINALS)
  const terminals = new Map()
  let disposed = false

  const capabilities = policy === 'none'
    ? {}
    : {
        fs: {
          readTextFile: true,
          writeTextFile: policy === 'standard',
        },
        ...(policy === 'standard' ? { terminal: true } : {}),
      }

  function terminalRecord(terminalId) {
    const record = terminals.get(terminalId)
    if (!record) {
      throw new AcpClientServiceError(`Terminal tidak ditemukan: ${String(terminalId)}`, {
        code: 'ACP_TERMINAL_NOT_FOUND',
      })
    }
    return record
  }

  async function readTextFile(params) {
    guard.authorize('fs.read')
    const target = await existingPath(root, params?.path)
    const metadata = await stat(target)
    if (!metadata.isFile()) {
      throw new AcpClientServiceError('Target read bukan file.', { code: 'ACP_INVALID_PATH' })
    }
    if (metadata.size > fileLimit) {
      throw new AcpClientServiceError(`File melebihi batas ${fileLimit} byte.`, { code: 'ACP_FILE_TOO_LARGE' })
    }
    const buffer = await readFile(target)
    let content
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch (cause) {
      throw new AcpClientServiceError('File bukan UTF-8 valid.', { code: 'ACP_INVALID_UTF8', cause })
    }
    const line = params?.line === undefined ? 1 : Number(params.line)
    const limit = params?.limit === undefined ? null : Number(params.limit)
    if (!Number.isInteger(line) || line < 1 || (limit !== null && (!Number.isInteger(limit) || limit < 1))) {
      throw new AcpClientServiceError('line/limit file tidak valid.', { code: 'ACP_INVALID_FILE_RANGE' })
    }
    if (line === 1 && limit === null) return { content }
    const lines = content.split(/(?<=\n)/u)
    return { content: lines.slice(line - 1, limit === null ? undefined : line - 1 + limit).join('') }
  }

  async function writeTextFile(params) {
    guard.authorize('fs.write')
    if (typeof params?.content !== 'string') {
      throw new AcpClientServiceError('content write harus string.', { code: 'ACP_INVALID_FILE_CONTENT' })
    }
    if (Buffer.byteLength(params.content, 'utf8') > fileLimit) {
      throw new AcpClientServiceError(`Content melebihi batas ${fileLimit} byte.`, { code: 'ACP_FILE_TOO_LARGE' })
    }
    const target = await writablePath(root, params.path)
    const temporary = join(dirname(target), `.onex-${randomBytes(8).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, params.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
    } finally {
      await unlink(temporary).catch(() => {})
    }
    return null
  }

  async function createTerminal(params) {
    guard.authorize('terminal.create')
    if (terminals.size >= terminalLimit) {
      throw new AcpClientServiceError(`Terminal aktif melebihi batas ${terminalLimit}.`, {
        code: 'ACP_TERMINAL_LIMIT',
      })
    }
    if (typeof params?.command !== 'string' || !params.command.trim()) {
      throw new AcpClientServiceError('terminal command wajib string non-kosong.', {
        code: 'ACP_INVALID_TERMINAL',
      })
    }
    const args = params.args ?? []
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new AcpClientServiceError('terminal args harus string array.', { code: 'ACP_INVALID_TERMINAL' })
    }
    const cwd = params.cwd === undefined ? root : await existingPath(root, params.cwd)
    const cwdMetadata = await stat(cwd)
    if (!cwdMetadata.isDirectory()) {
      throw new AcpClientServiceError('terminal cwd bukan directory.', { code: 'ACP_INVALID_TERMINAL' })
    }
    const requestedLimit = positiveInteger(params.outputByteLimit, outputLimit)
    const byteLimit = Math.min(requestedLimit, outputLimit)
    const env = safeTerminalEnv(baseEnv, params.env)
    const terminalId = `term_${randomBytes(12).toString('base64url')}`
    let child
    try {
      child = spawn(params.command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (cause) {
      throw new AcpClientServiceError('Gagal menjalankan terminal command.', {
        code: 'ACP_TERMINAL_SPAWN_FAILED',
        cause,
      })
    }
    let resolveExit
    const exited = new Promise((resolvePromise) => { resolveExit = resolvePromise })
    const record = {
      id: terminalId,
      child,
      output: '',
      truncated: false,
      exitStatus: null,
      exited,
      resolveExit,
      killTimer: null,
    }
    const append = (chunk) => {
      record.output += chunk
      if (Buffer.byteLength(record.output, 'utf8') > byteLimit) {
        record.truncated = true
        record.output = trimUtf8Start(record.output, byteLimit)
      }
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (cause) => {
      if (record.exitStatus) return
      record.exitStatus = { exitCode: null, signal: null }
      record.spawnError = cause
      resolveExit(record.exitStatus)
    })
    child.once('close', (exitCode, signal) => {
      if (record.killTimer) clearTimeout(record.killTimer)
      if (!record.exitStatus) {
        record.exitStatus = { exitCode: exitCode ?? null, signal: signal ?? null }
        resolveExit(record.exitStatus)
      }
    })
    terminals.set(terminalId, record)
    return { terminalId }
  }

  function terminalOutput(params) {
    const record = terminalRecord(params?.terminalId)
    return {
      output: record.output,
      truncated: record.truncated,
      ...(record.exitStatus ? { exitStatus: record.exitStatus } : {}),
    }
  }

  async function waitForExit(params) {
    const record = terminalRecord(params?.terminalId)
    return record.exitStatus ?? record.exited
  }

  function terminateTerminal(record) {
    if (record.exitStatus) return
    terminateProcess(record.child, 'SIGTERM')
    if (record.killTimer) clearTimeout(record.killTimer)
    record.killTimer = setTimeout(() => terminateProcess(record.child, 'SIGKILL'), killGraceMs)
    record.killTimer.unref?.()
  }

  function killTerminal(params) {
    terminateTerminal(terminalRecord(params?.terminalId))
    return null
  }

  function releaseTerminal(params) {
    const record = terminalRecord(params?.terminalId)
    terminals.delete(record.id)
    terminateTerminal(record)
    return null
  }

  async function handle(message) {
    if (disposed) {
      throw new AcpClientServiceError('ACP client services sudah ditutup.', { code: 'ACP_SERVICES_CLOSED' })
    }
    switch (message.method) {
      case 'fs/read_text_file': return readTextFile(message.params)
      case 'fs/write_text_file': return writeTextFile(message.params)
      case 'terminal/create': return createTerminal(message.params)
      case 'terminal/output': return terminalOutput(message.params)
      case 'terminal/wait_for_exit': return waitForExit(message.params)
      case 'terminal/kill': return killTerminal(message.params)
      case 'terminal/release': return releaseTerminal(message.params)
      default:
        throw new AcpClientServiceError(`ACP client method tidak didukung: ${message.method}`, {
          code: 'KIRO_ACP_UNSUPPORTED_METHOD',
        })
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const record of terminals.values()) terminateTerminal(record)
    terminals.clear()
  }

  return { capabilities, guard, handle, dispose }
}

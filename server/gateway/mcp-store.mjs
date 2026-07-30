import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { isIP } from 'node:net'
import { decryptSecret, encryptSecret } from './secrets.mjs'
import { assertPublicHost, isPrivateAddress } from './net-guard.mjs'

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const TRANSPORTS = new Set(['stdio', 'http', 'sse'])
const MAX_SERVERS = 100
const MAX_ARGS = 100
const MAX_SECRET_ENTRIES = 100

function cleanText(value, label, maxLength = 500) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} wajib diisi`)
  const text = value.trim()
  if (text.length > maxLength) throw new Error(`${label} maksimal ${maxLength} karakter`)
  return text
}

function normalizeId(value) {
  const id = cleanText(value, 'MCP server ID', 100).toLowerCase()
  if (!ID_PATTERN.test(id)) throw new Error('MCP server ID tidak valid')
  return id
}

function normalizeStringArray(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ARGS || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} harus berupa string array dengan maksimal ${MAX_ARGS} item`)
  }
  return value.map(String)
}

function normalizeSecrets(value, label) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} harus object`)
  const entries = Object.entries(value)
  if (entries.length > MAX_SECRET_ENTRIES) throw new Error(`${label} maksimal ${MAX_SECRET_ENTRIES} item`)
  const result = {}
  for (const [rawName, rawValue] of entries) {
    const name = cleanText(rawName, `${label} name`, 200)
    if (typeof rawValue !== 'string' || rawValue.length > 10_000) {
      throw new Error(`${label}.${name} harus string maksimal 10000 karakter`)
    }
    result[name] = rawValue
  }
  return result
}

function normalizeRemoteUrl(value, { allowInsecureLocalhost = false } = {}) {
  let url
  try {
    url = new URL(cleanText(value, 'MCP URL', 2_000))
  } catch {
    throw new Error('MCP URL tidak valid')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const localhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && localhost && url.protocol === 'http:')) {
    throw new Error('MCP URL harus memakai HTTPS')
  }
  if (url.username || url.password || url.hash) throw new Error('MCP URL tidak boleh berisi credential atau fragment')
  if (isIP(hostname) && isPrivateAddress(hostname) && !(allowInsecureLocalhost && localhost)) {
    throw new Error(`MCP URL mengarah ke alamat jaringan internal: ${hostname}`)
  }
  return url.toString()
}

function normalizeInput(input, options = {}) {
  const transport = input?.transport ?? 'stdio'
  if (!TRANSPORTS.has(transport)) throw new Error('MCP transport harus stdio, http, atau sse')
  const common = {
    id: normalizeId(input?.id),
    name: cleanText(input?.name, 'Nama MCP server', 100),
    transport,
    enabled: input?.enabled !== false,
    trusted: input?.trusted === true,
    readOnly: input?.readOnly === true,
  }
  if (transport === 'stdio') {
    return {
      ...common,
      command: cleanText(input?.command, 'MCP command', 1_000),
      args: normalizeStringArray(input?.args, 'MCP args'),
    }
  }
  return {
    ...common,
    url: normalizeRemoteUrl(input?.url, options),
  }
}

function normalizeStored(record, options) {
  const normalized = normalizeInput(record, options)
  return {
    ...normalized,
    ...(record.encryptedSecrets ? { encryptedSecrets: record.encryptedSecrets } : {}),
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date().toISOString(),
  }
}

function publicServer(record) {
  const { encryptedSecrets: _encryptedSecrets, ...safe } = record
  return { ...safe, hasSecrets: Boolean(record.encryptedSecrets) }
}

function suppliedSecrets(input) {
  const env = normalizeSecrets(input?.env, 'MCP env')
  const headers = normalizeSecrets(input?.headers, 'MCP headers')
  if (!env && !headers) return null
  return { env: env ?? {}, headers: headers ?? {} }
}

function namedValues(value = {}) {
  return Object.entries(value).map(([name, entry]) => ({ name, value: entry }))
}

async function resolveExecutable(command, pathValue = process.env.PATH) {
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes('/') || command.includes('\\')
      ? [resolve(command)]
      : String(pathValue ?? '').split(delimiter).filter(Boolean).map((directory) => resolve(directory, command))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`MCP executable tidak ditemukan: ${command}`)
}

export class McpStore {
  constructor({
    dataDir,
    masterKey,
    allowInsecureLocalhost = false,
    assertHost = assertPublicHost,
    pathValue = process.env.PATH,
  } = {}) {
    if (typeof masterKey !== 'string' || masterKey.length < 16) {
      throw new Error('GATEWAY_MASTER_KEY wajib diisi minimal 16 karakter')
    }
    this.filePath = join(dataDir, 'mcp-servers.json')
    this.masterKey = masterKey
    this.allowInsecureLocalhost = allowInsecureLocalhost
    this.assertHost = assertHost
    this.pathValue = pathValue
    this.servers = null
    this.writeQueue = Promise.resolve()
  }

  async ensureLoaded() {
    if (this.servers) return
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
      this.servers = Array.isArray(parsed.servers)
        ? parsed.servers.map((record) => normalizeStored(record, this))
        : []
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Gagal membaca MCP store: ${error.message}`)
      this.servers = []
    }
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    const payload = JSON.stringify({ version: 1, servers: this.servers }, null, 2)
    await writeFile(temporaryPath, `${payload}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }

  mutate(operation) {
    const result = this.writeQueue.then(async () => {
      await this.ensureLoaded()
      const value = await operation()
      await this.persist()
      return value
    })
    this.writeQueue = result.catch(() => {})
    return result
  }

  async list() {
    await this.ensureLoaded()
    return this.servers.map(publicServer)
  }

  create(input) {
    return this.mutate(() => {
      if (this.servers.length >= MAX_SERVERS) throw new Error(`Maksimal ${MAX_SERVERS} MCP server`)
      const normalized = normalizeInput(input, this)
      if (this.servers.some((record) => record.id === normalized.id)) {
        throw new Error(`MCP server sudah ada: ${normalized.id}`)
      }
      const secrets = suppliedSecrets(input)
      const timestamp = new Date().toISOString()
      const record = {
        ...normalized,
        ...(secrets ? { encryptedSecrets: encryptSecret(JSON.stringify(secrets), this.masterKey) } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      this.servers.push(record)
      return publicServer(record)
    })
  }

  update(id, input = {}) {
    return this.mutate(() => {
      const index = this.servers.findIndex((record) => record.id === id)
      if (index === -1) throw Object.assign(new Error(`MCP server tidak ditemukan: ${id}`), { status: 404 })
      const current = this.servers[index]
      const normalized = normalizeInput({ ...current, ...input, id: current.id }, this)
      const secrets = suppliedSecrets(input)
      const record = {
        ...current,
        ...normalized,
        ...(secrets ? { encryptedSecrets: encryptSecret(JSON.stringify(secrets), this.masterKey) } : {}),
        updatedAt: new Date().toISOString(),
      }
      if (input.clearSecrets === true) delete record.encryptedSecrets
      this.servers[index] = record
      return publicServer(record)
    })
  }

  delete(id) {
    return this.mutate(() => {
      const index = this.servers.findIndex((record) => record.id === id)
      if (index === -1) throw Object.assign(new Error(`MCP server tidak ditemukan: ${id}`), { status: 404 })
      const [removed] = this.servers.splice(index, 1)
      return publicServer(removed)
    })
  }

  async resolveForRun(ids, { policy = 'none' } = {}) {
    await this.ensureLoaded()
    if (policy === 'none') return []
    const requested = Array.isArray(ids) ? [...new Set(ids)] : []
    if (requested.length > 50 || requested.some((id) => typeof id !== 'string' || !ID_PATTERN.test(id))) {
      throw new Error('mcpServerIds tidak valid')
    }
    return Promise.all(requested.map(async (id) => {
      const record = this.servers.find((entry) => entry.id === id)
      if (!record) throw new Error(`MCP server tidak ditemukan: ${id}`)
      if (!record.enabled || !record.trusted) throw new Error(`MCP server belum enabled dan trusted: ${id}`)
      if (policy === 'read-only' && !record.readOnly) {
        throw new Error(`MCP server tidak ditandai read-only: ${id}`)
      }
      let secrets = { env: {}, headers: {} }
      if (record.encryptedSecrets) {
        secrets = JSON.parse(decryptSecret(record.encryptedSecrets, this.masterKey))
      }
      if (record.transport === 'stdio') {
        return {
          name: record.name,
          command: await resolveExecutable(record.command, this.pathValue),
          args: [...record.args],
          env: namedValues(secrets.env),
        }
      }
      const url = new URL(record.url)
      await this.assertHost(url.hostname.replace(/^\[|\]$/g, ''), {
        allowLocalhost: this.allowInsecureLocalhost,
      })
      return {
        type: record.transport,
        name: record.name,
        url: record.url,
        headers: namedValues(secrets.headers),
      }
    }))
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isIP } from 'node:net'
import { decryptSecret, encryptSecret } from './secrets.mjs'
import { isPrivateAddress } from './net-guard.mjs'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const MODEL_PATTERN = /^[^\s/][^\s]{0,199}$/
const CONNECTION_KINDS = new Set(['openai-http', 'kiro-cli'])
const KIRO_AUTH_MODES = new Set(['account-session', 'api-key'])
export const DEFAULT_KIRO_REGION = 'us-east-1'
export const KIRO_REGIONS = Object.freeze([DEFAULT_KIRO_REGION, 'eu-central-1'])
const KIRO_REGION_SET = new Set(KIRO_REGIONS)

function cleanText(value, label, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} wajib diisi`)
  const result = value.trim()
  if (result.length > maxLength) throw new Error(`${label} maksimal ${maxLength} karakter`)
  return result
}

function normalizeModels(value) {
  if (!Array.isArray(value)) throw new Error('models harus berupa array')
  const models = [...new Set(value.map((model) => cleanText(model, 'Model')))]
  if (models.length > 200) throw new Error('Maksimal 200 model per connection')
  for (const model of models) {
    if (!MODEL_PATTERN.test(model)) throw new Error(`Model tidak valid: ${model}`)
  }
  return models
}

function normalizeKind(value) {
  const kind = value ?? 'openai-http'
  if (!CONNECTION_KINDS.has(kind)) {
    throw new Error('kind harus openai-http atau kiro-cli')
  }
  return kind
}

function normalizeAuthMode(value) {
  const authMode = value ?? 'api-key'
  if (!KIRO_AUTH_MODES.has(authMode)) {
    throw new Error('authMode Kiro harus account-session atau api-key')
  }
  return authMode
}

/**
 * Identitas hasil validasi bearer: profile ARN CodeWhisperer + email dari klaim
 * JWT. Keduanya bukan secret, jadi boleh disimpan apa adanya dan dikirim ke
 * browser. Nilai kosong/tidak valid dibuang, bukan dilempar sebagai error.
 */
function normalizeKiroIdentity(identity) {
  if (!identity || typeof identity !== 'object') return {}
  const result = {}
  if (typeof identity.profileArn === 'string' && identity.profileArn.trim()) {
    result.profileArn = cleanText(identity.profileArn, 'Profile ARN', 2048)
  }
  if (typeof identity.email === 'string' && identity.email.trim()) {
    result.email = cleanText(identity.email, 'Email', 320)
  }
  return result
}

export function normalizeKiroRegion(value) {
  const region = value === undefined || value === null || value === ''
    ? DEFAULT_KIRO_REGION
    : cleanText(value, 'Kiro region', 50)
  if (!KIRO_REGION_SET.has(region)) {
    throw new Error(`Kiro region harus ${KIRO_REGIONS.join(' atau ')}`)
  }
  return region
}

export function normalizeBaseUrl(value, { allowInsecureLocalhost = false } = {}) {
  let url
  try {
    url = new URL(cleanText(value, 'Base URL', 500))
  } catch {
    throw new Error('Base URL tidak valid')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const local =
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && local && url.protocol === 'http:')) {
    throw new Error('Base URL harus memakai HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL tidak boleh berisi credential, query, atau fragment')
  }

  // Anti-SSRF: kalau host berupa literal IP internal, tolak sekarang juga
  // (kecuali localhost saat allowInsecureLocalhost aktif untuk dev/test).
  // Host berupa nama domain diverifikasi via DNS saat fetch (lihat net-guard).
  if (isIP(hostname) && isPrivateAddress(hostname) && !(allowInsecureLocalhost && local)) {
    throw new Error(`Base URL mengarah ke alamat jaringan internal: ${hostname}`)
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

export function validateConnectionInput(input, options = {}) {
  const id = cleanText(input?.id, 'ID connection', 63).toLowerCase()
  if (!ID_PATTERN.test(id)) {
    throw new Error('ID connection hanya boleh huruf kecil, angka, dan tanda hubung')
  }

  const kind = normalizeKind(input?.kind)
  const common = {
    id,
    name: cleanText(input?.name, 'Nama connection', 100),
    kind,
    models: normalizeModels(input?.models ?? []),
    enabled: input?.enabled !== false,
  }

  if (kind === 'kiro-cli') {
    const authMode = normalizeAuthMode(input?.authMode)
    if (authMode !== 'api-key') {
      throw new Error('Connection Kiro baru hanya mendukung authMode api-key')
    }
    return {
      ...common,
      authMode,
      region: normalizeKiroRegion(input?.region),
      models: ['auto'],
    }
  }

  return {
    ...common,
    baseUrl: normalizeBaseUrl(input?.baseUrl, options),
  }
}

function normalizeStoredConnection(connection) {
  const kind = normalizeKind(connection?.kind)
  if (kind === 'kiro-cli') {
    const {
      baseUrl: _baseUrl,
      encryptedApiKey,
      profileArn: _profileArn,
      email: _email,
      ...rest
    } = connection
    const authMode = normalizeAuthMode(
      connection.authMode ?? (encryptedApiKey ? 'api-key' : 'account-session'),
    )
    return {
      ...rest,
      kind,
      authMode,
      region: normalizeKiroRegion(connection.region),
      ...normalizeKiroIdentity(connection),
      models: ['auto'],
      ...(authMode === 'api-key' && encryptedApiKey ? { encryptedApiKey } : {}),
    }
  }
  const {
    authMode: _authMode,
    region: _region,
    profileArn: _profileArn,
    email: _email,
    ...rest
  } = connection
  return { ...rest, kind }
}

function publicConnection(connection) {
  const { encryptedApiKey: _encryptedApiKey, ...safe } = normalizeStoredConnection(connection)
  return {
    ...safe,
    hasApiKey: Boolean(connection.encryptedApiKey),
    ...(connection.kind === 'kiro-cli' ? { credentialType: 'bearer' } : {}),
  }
}

function usesSecret(connection) {
  return connection.kind === 'openai-http'
    || (connection.kind === 'kiro-cli' && connection.authMode === 'api-key')
}

function compatibleSecret(current, next) {
  if (!current.encryptedApiKey || current.kind !== next.kind) return false
  if (next.kind === 'openai-http') return true
  return current.authMode === 'api-key' && next.authMode === 'api-key'
}

function suppliedApiKey(input) {
  return typeof input?.apiKey === 'string' && input.apiKey.trim()
    ? cleanText(input.apiKey, 'API key', 10_000)
    : null
}

export class ConnectionStore {
  constructor({ dataDir, masterKey, allowInsecureLocalhost = false }) {
    this.filePath = join(dataDir, 'connections.json')
    this.masterKey = masterKey
    this.allowInsecureLocalhost = allowInsecureLocalhost
    this.connections = null
    this.writeQueue = Promise.resolve()
  }

  async ensureLoaded() {
    if (this.connections) return
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
      this.connections = Array.isArray(parsed.connections)
        ? parsed.connections.map(normalizeStoredConnection)
        : []
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Gagal membaca connection store: ${error.message}`)
      this.connections = []
    }
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    const payload = JSON.stringify({ version: 2, connections: this.connections }, null, 2)
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
    return this.connections.map(publicConnection)
  }

  async get(id) {
    await this.ensureLoaded()
    const connection = this.connections.find((item) => item.id === id) ?? null
    return connection ? publicConnection(connection) : null
  }

  async getWithSecret(id) {
    await this.ensureLoaded()
    const connection = this.connections.find((item) => item.id === id)
    if (!connection) return null
    return {
      ...publicConnection(connection),
      apiKey: connection.encryptedApiKey
        ? decryptSecret(connection.encryptedApiKey, this.masterKey)
        : undefined,
    }
  }

  create(input, { validatedAt, identity } = {}) {
    return this.mutate(() => {
      const normalized = validateConnectionInput(input, {
        allowInsecureLocalhost: this.allowInsecureLocalhost,
      })
      if (this.connections.some((item) => item.id === normalized.id)) {
        throw new Error(`Connection sudah ada: ${normalized.id}`)
      }

      const apiKey = suppliedApiKey(input)
      if (usesSecret(normalized) && !apiKey) {
        throw new Error(normalized.kind === 'kiro-cli'
          ? 'API key wajib diisi untuk authMode api-key'
          : 'API key wajib diisi')
      }
      const now = new Date().toISOString()
      const connection = {
        ...normalized,
        ...(usesSecret(normalized) && apiKey
          ? { encryptedApiKey: encryptSecret(apiKey, this.masterKey) }
          : {}),
        ...(normalized.kind === 'kiro-cli' && validatedAt ? { validatedAt } : {}),
        ...(normalized.kind === 'kiro-cli' ? normalizeKiroIdentity(identity) : {}),
        createdAt: now,
        updatedAt: now,
      }
      this.connections.push(connection)
      return publicConnection(connection)
    })
  }

  update(id, input, { validatedAt, identity } = {}) {
    return this.mutate(() => {
      const index = this.connections.findIndex((item) => item.id === id)
      if (index === -1) throw new Error(`Connection tidak ditemukan: ${id}`)
      const current = normalizeStoredConnection(this.connections[index])
      const requestedKind = input?.kind ?? current.kind
      const merged = { ...current, ...input, id: current.id, kind: requestedKind }
      if (requestedKind === 'kiro-cli' && input?.authMode === undefined) {
        merged.authMode = current.kind === 'kiro-cli' ? current.authMode : 'api-key'
      }
      const normalized = validateConnectionInput(merged, {
        allowInsecureLocalhost: this.allowInsecureLocalhost,
      })

      const apiKey = suppliedApiKey(input)
      let encryptedApiKey
      if (usesSecret(normalized)) {
        if (apiKey) encryptedApiKey = encryptSecret(apiKey, this.masterKey)
        else if (compatibleSecret(current, normalized)) encryptedApiKey = current.encryptedApiKey
        else {
          throw new Error(normalized.kind === 'kiro-cli'
            ? 'API key wajib diisi saat beralih ke authMode api-key'
            : 'API key wajib diisi saat beralih ke openai-http')
        }
      }

      const connection = {
        ...current,
        ...normalized,
        encryptedApiKey,
        ...(normalized.kind === 'kiro-cli' && validatedAt ? { validatedAt } : {}),
        ...(normalized.kind === 'kiro-cli' ? normalizeKiroIdentity(identity) : {}),
        updatedAt: new Date().toISOString(),
      }
      if (normalized.kind === 'kiro-cli') delete connection.baseUrl
      else {
        delete connection.authMode
        delete connection.validatedAt
        delete connection.profileArn
        delete connection.email
      }
      if (!encryptedApiKey) delete connection.encryptedApiKey
      this.connections[index] = connection
      return publicConnection(connection)
    })
  }

  delete(id) {
    return this.mutate(() => {
      const index = this.connections.findIndex((item) => item.id === id)
      if (index === -1) throw new Error(`Connection tidak ditemukan: ${id}`)
      const [removed] = this.connections.splice(index, 1)
      return publicConnection(removed)
    })
  }
}

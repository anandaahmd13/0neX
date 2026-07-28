import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decryptSecret, encryptSecret } from './secrets.mjs'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const MODEL_PATTERN = /^[^\s/][^\s]{0,199}$/

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

export function normalizeBaseUrl(value, { allowInsecureLocalhost = false } = {}) {
  let url
  try {
    url = new URL(cleanText(value, 'Base URL', 500))
  } catch {
    throw new Error('Base URL tidak valid')
  }

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && local && url.protocol === 'http:')) {
    throw new Error('Base URL harus memakai HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL tidak boleh berisi credential, query, atau fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

export function validateConnectionInput(input, options = {}) {
  const id = cleanText(input?.id, 'ID connection', 63).toLowerCase()
  if (!ID_PATTERN.test(id)) {
    throw new Error('ID connection hanya boleh huruf kecil, angka, dan tanda hubung')
  }

  return {
    id,
    name: cleanText(input?.name, 'Nama connection', 100),
    baseUrl: normalizeBaseUrl(input?.baseUrl, options),
    models: normalizeModels(input?.models ?? []),
    enabled: input?.enabled !== false,
  }
}

function publicConnection(connection) {
  const { encryptedApiKey: _encryptedApiKey, ...safe } = connection
  return { ...safe, hasApiKey: Boolean(connection.encryptedApiKey) }
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
      this.connections = Array.isArray(parsed.connections) ? parsed.connections : []
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Gagal membaca connection store: ${error.message}`)
      this.connections = []
    }
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    const payload = JSON.stringify({ version: 1, connections: this.connections }, null, 2)
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
      apiKey: decryptSecret(connection.encryptedApiKey, this.masterKey),
    }
  }

  create(input) {
    return this.mutate(() => {
      const normalized = validateConnectionInput(input, {
        allowInsecureLocalhost: this.allowInsecureLocalhost,
      })
      if (this.connections.some((item) => item.id === normalized.id)) {
        throw new Error(`Connection sudah ada: ${normalized.id}`)
      }
      const apiKey = cleanText(input.apiKey, 'API key', 10_000)
      const now = new Date().toISOString()
      const connection = {
        ...normalized,
        encryptedApiKey: encryptSecret(apiKey, this.masterKey),
        createdAt: now,
        updatedAt: now,
      }
      this.connections.push(connection)
      return publicConnection(connection)
    })
  }

  update(id, input) {
    return this.mutate(() => {
      const index = this.connections.findIndex((item) => item.id === id)
      if (index === -1) throw new Error(`Connection tidak ditemukan: ${id}`)
      const current = this.connections[index]
      const normalized = validateConnectionInput(
        { ...current, ...input, id: current.id },
        { allowInsecureLocalhost: this.allowInsecureLocalhost },
      )
      const encryptedApiKey = input.apiKey
        ? encryptSecret(cleanText(input.apiKey, 'API key', 10_000), this.masterKey)
        : current.encryptedApiKey
      const connection = {
        ...current,
        ...normalized,
        encryptedApiKey,
        updatedAt: new Date().toISOString(),
      }
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

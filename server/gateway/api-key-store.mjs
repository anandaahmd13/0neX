import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Store API key gateway (client-facing) yang dibuat lewat dashboard.
 *
 * Model keamanannya:
 *  - Plaintext key hanya ada sekali, di respons POST /admin/api-keys.
 *  - Disk hanya menyimpan HMAC-SHA256(plaintext, masterKey) — bukan plaintext,
 *    bukan hash tanpa kunci. Keyed hash dipilih supaya lookup tetap O(1)
 *    (deterministik) tapi file yang bocor tanpa GATEWAY_MASTER_KEY tidak bisa
 *    di-brute force offline dengan rainbow table.
 *  - Perbandingan hash tetap timing-safe.
 *
 * GATEWAY_API_KEY dari env tetap berlaku sebagai bootstrap/emergency key dan
 * TIDAK dikelola di sini.
 */

export const KEY_PREFIX = 'onex_sk_'
export const API_KEY_SCOPES = Object.freeze(['models:read', 'chat:write'])
const SCOPE_SET = new Set(API_KEY_SCOPES)
const SECRET_BYTES = 32
const NAME_MAX = 100
const MAX_KEYS = 200

function cleanText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} wajib diisi`)
  const result = value.trim()
  if (result.length > maxLength) throw new Error(`${label} maksimal ${maxLength} karakter`)
  return result
}

function normalizeScopes(value) {
  if (value === undefined || value === null) return [...API_KEY_SCOPES]
  if (!Array.isArray(value)) throw new Error('scopes harus berupa array')
  const scopes = [...new Set(value.map((scope) => String(scope ?? '').trim()).filter(Boolean))]
  if (!scopes.length) throw new Error('Minimal satu scope wajib dipilih')
  for (const scope of scopes) {
    if (!SCOPE_SET.has(scope)) {
      throw new Error(`Scope tidak dikenal: ${scope}. Pilihan: ${API_KEY_SCOPES.join(', ')}`)
    }
  }
  // Urutkan mengikuti urutan kanonik supaya output stabil.
  return API_KEY_SCOPES.filter((scope) => scopes.includes(scope))
}

function normalizeExpiresAt(value) {
  if (value === undefined || value === null || value === '') return null
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(timestamp)) throw new Error('expiresAt harus tanggal ISO yang valid')
  return new Date(timestamp).toISOString()
}

/**
 * Rate limit opsional per key. null = pakai limit global gateway.
 */
function normalizeRateLimit(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('rateLimit harus berupa object { capacity, refillPerSec }')
  }
  const capacity = Number(value.capacity)
  const refillPerSec = Number(value.refillPerSec)
  if (!Number.isFinite(capacity) || capacity <= 0 || capacity > 100_000) {
    throw new Error('rateLimit.capacity harus angka 1..100000')
  }
  if (!Number.isFinite(refillPerSec) || refillPerSec <= 0 || refillPerSec > 10_000) {
    throw new Error('rateLimit.refillPerSec harus angka > 0 dan <= 10000')
  }
  return { capacity, refillPerSec }
}

export function generateApiKeySecret() {
  return `${KEY_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`
}

export function looksLikeManagedKey(value) {
  return typeof value === 'string' && value.startsWith(KEY_PREFIX)
}

/**
 * Bagian key yang aman ditampilkan berulang kali di dashboard:
 * onex_sk_ + 6 karakter pertama + "…" + 4 karakter terakhir.
 */
export function maskApiKey(secret) {
  const body = String(secret ?? '').slice(KEY_PREFIX.length)
  if (body.length <= 10) return `${KEY_PREFIX}${body}`
  return `${KEY_PREFIX}${body.slice(0, 6)}…${body.slice(-4)}`
}

function hashSecret(secret, masterKey) {
  return createHmac('sha256', masterKey).update(String(secret)).digest('hex')
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function publicKey(record) {
  return {
    id: record.id,
    name: record.name,
    maskedKey: record.maskedKey,
    scopes: [...record.scopes],
    enabled: record.enabled !== false,
    expiresAt: record.expiresAt ?? null,
    rateLimit: record.rateLimit ? { ...record.rateLimit } : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt ?? null,
    requestCount: Number(record.requestCount) || 0,
    revokedAt: record.revokedAt ?? null,
    rotatedAt: record.rotatedAt ?? null,
    expired: Boolean(record.expiresAt) && Date.parse(record.expiresAt) <= Date.now(),
  }
}

function normalizeStored(record) {
  return {
    id: String(record.id),
    name: String(record.name ?? 'API Key'),
    hash: String(record.hash ?? ''),
    maskedKey: String(record.maskedKey ?? `${KEY_PREFIX}…`),
    scopes: normalizeScopes(Array.isArray(record.scopes) ? record.scopes : undefined),
    enabled: record.enabled !== false,
    expiresAt: record.expiresAt ?? null,
    rateLimit: record.rateLimit ?? null,
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date().toISOString(),
    lastUsedAt: record.lastUsedAt ?? null,
    requestCount: Number(record.requestCount) || 0,
    revokedAt: record.revokedAt ?? null,
    rotatedAt: record.rotatedAt ?? null,
  }
}

export class ApiKeyStore {
  constructor({ dataDir, masterKey, now = Date.now } = {}) {
    if (typeof masterKey !== 'string' || masterKey.length < 16) {
      throw new Error('GATEWAY_MASTER_KEY wajib diisi minimal 16 karakter')
    }
    this.filePath = join(dataDir, 'api-keys.json')
    this.masterKey = masterKey
    this.now = now
    this.keys = null
    this.writeQueue = Promise.resolve()
    // Buffer statistik pemakaian (lastUsedAt/requestCount) agar tiap request
    // /v1 tidak memaksa tulis disk. Di-flush berkala oleh pemanggil.
    this.pendingUsage = new Map()
  }

  async ensureLoaded() {
    if (this.keys) return
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
      this.keys = Array.isArray(parsed.keys) ? parsed.keys.map(normalizeStored) : []
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Gagal membaca API key store: ${error.message}`)
      this.keys = []
    }
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    const payload = JSON.stringify({ version: 1, keys: this.keys }, null, 2)
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
    return this.keys.map(publicKey)
  }

  async get(id) {
    await this.ensureLoaded()
    const record = this.keys.find((item) => item.id === id)
    return record ? publicKey(record) : null
  }

  /**
   * Buat key baru. Plaintext dikembalikan sekali di field `secret` dan tidak
   * pernah bisa diambil lagi setelah ini.
   */
  create(input = {}) {
    return this.mutate(() => {
      if (this.keys.length >= MAX_KEYS) throw new Error(`Maksimal ${MAX_KEYS} API key`)
      const name = cleanText(input.name, 'Nama API key', NAME_MAX)
      const scopes = normalizeScopes(input.scopes)
      const expiresAt = normalizeExpiresAt(input.expiresAt)
      const rateLimit = normalizeRateLimit(input.rateLimit)
      const secret = generateApiKeySecret()
      const timestamp = new Date(this.now()).toISOString()
      const record = {
        id: `key_${randomBytes(8).toString('hex')}`,
        name,
        hash: hashSecret(secret, this.masterKey),
        maskedKey: maskApiKey(secret),
        scopes,
        enabled: input.enabled !== false,
        expiresAt,
        rateLimit,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastUsedAt: null,
        requestCount: 0,
        revokedAt: null,
        rotatedAt: null,
      }
      this.keys.push(record)
      return { ...publicKey(record), secret }
    })
  }

  update(id, input = {}) {
    return this.mutate(() => {
      const record = this.keys.find((item) => item.id === id)
      if (!record) throw Object.assign(new Error(`API key tidak ditemukan: ${id}`), { status: 404 })
      if (input.name !== undefined) record.name = cleanText(input.name, 'Nama API key', NAME_MAX)
      if (input.scopes !== undefined) record.scopes = normalizeScopes(input.scopes)
      if (input.expiresAt !== undefined) record.expiresAt = normalizeExpiresAt(input.expiresAt)
      if (input.rateLimit !== undefined) record.rateLimit = normalizeRateLimit(input.rateLimit)
      if (input.enabled !== undefined) record.enabled = input.enabled !== false
      record.updatedAt = new Date(this.now()).toISOString()
      return publicKey(record)
    })
  }

  /**
   * Rotate: terbitkan secret baru untuk key yang sama (id, nama, scope tetap).
   * Secret lama langsung tidak valid karena hash-nya ditimpa.
   */
  rotate(id) {
    return this.mutate(() => {
      const record = this.keys.find((item) => item.id === id)
      if (!record) throw Object.assign(new Error(`API key tidak ditemukan: ${id}`), { status: 404 })
      const secret = generateApiKeySecret()
      const timestamp = new Date(this.now()).toISOString()
      record.hash = hashSecret(secret, this.masterKey)
      record.maskedKey = maskApiKey(secret)
      record.rotatedAt = timestamp
      record.updatedAt = timestamp
      record.revokedAt = null
      record.enabled = true
      return { ...publicKey(record), secret }
    })
  }

  revoke(id) {
    return this.mutate(() => {
      const record = this.keys.find((item) => item.id === id)
      if (!record) throw Object.assign(new Error(`API key tidak ditemukan: ${id}`), { status: 404 })
      const timestamp = new Date(this.now()).toISOString()
      record.enabled = false
      record.revokedAt = timestamp
      record.updatedAt = timestamp
      // Hash dikosongkan supaya secret lama benar-benar tidak bisa dipakai lagi
      // bahkan kalau record di-enable manual.
      record.hash = ''
      return publicKey(record)
    })
  }

  delete(id) {
    return this.mutate(() => {
      const index = this.keys.findIndex((item) => item.id === id)
      if (index === -1) throw Object.assign(new Error(`API key tidak ditemukan: ${id}`), { status: 404 })
      const [removed] = this.keys.splice(index, 1)
      this.pendingUsage.delete(id)
      return publicKey(removed)
    })
  }

  /**
   * Verifikasi plaintext key. Return { ok, key?, reason? } dengan reason:
   * not_found | revoked | disabled | expired.
   */
  async verify(secret) {
    if (!looksLikeManagedKey(secret)) return { ok: false, reason: 'not_found' }
    await this.ensureLoaded()
    const hash = hashSecret(secret, this.masterKey)
    const record = this.keys.find((item) => item.hash && safeEqualHex(item.hash, hash))
    if (!record) return { ok: false, reason: 'not_found' }
    if (record.revokedAt) return { ok: false, reason: 'revoked', key: publicKey(record) }
    if (record.enabled === false) return { ok: false, reason: 'disabled', key: publicKey(record) }
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now()) {
      return { ok: false, reason: 'expired', key: publicKey(record) }
    }
    return { ok: true, key: publicKey(record) }
  }

  /**
   * Catat pemakaian di memori. Dipanggil per request /v1 (murah), lalu
   * di-flush ke disk secara berkala lewat flushUsage().
   */
  touch(id) {
    if (!id) return
    const entry = this.pendingUsage.get(id) ?? { count: 0, lastUsedAt: null }
    entry.count += 1
    entry.lastUsedAt = new Date(this.now()).toISOString()
    this.pendingUsage.set(id, entry)
  }

  async flushUsage() {
    if (!this.pendingUsage.size) return false
    const pending = new Map(this.pendingUsage)
    this.pendingUsage.clear()
    return this.mutate(() => {
      let changed = false
      for (const [id, entry] of pending) {
        const record = this.keys.find((item) => item.id === id)
        if (!record) continue
        record.requestCount = (Number(record.requestCount) || 0) + entry.count
        record.lastUsedAt = entry.lastUsedAt
        changed = true
      }
      return changed
    })
  }
}

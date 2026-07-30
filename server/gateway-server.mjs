import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { ConnectionStore, validateConnectionInput } from './gateway/connection-store.mjs'
import {
  createSseUsageParser,
  parseGatewayModel,
  resolveModelCandidates,
  safeUpstreamError,
  upstreamHeaders,
  upstreamUrl,
} from './gateway/openai-compatible.mjs'
import { getProvider, listProviders, registerProvider } from './gateway/provider-registry.mjs'
import { claudeCliProvider } from './gateway/providers/claude-cli.mjs'
import {
  createKiroInferenceAlias,
  createKiroInferenceProvider,
  kiroInferenceAlias,
  kiroInferenceProvider,
} from './gateway/providers/kiro-inference.mjs'
import { UsageStore } from './gateway/usage-store.mjs'
import { createSessionManager, parseCookies, serializeSessionCookie } from './gateway/session.mjs'
import { assertPublicHost } from './gateway/net-guard.mjs'
import { createKiroBearerValidator } from './gateway/kiro-bearer.mjs'
import { RateLimiter } from './gateway/rate-limiter.mjs'
import { PricingTable } from './gateway/pricing.mjs'
import { loadAliases } from './gateway/aliases.mjs'
import { createKiroHttpClient } from './gateway/kiro-http.mjs'
import { createConnectionDriverRegistry } from './gateway/connection-driver-registry.mjs'
import { createKiroInferenceDriver } from './gateway/kiro-inference-driver.mjs'
import { API_KEY_SCOPES, ApiKeyStore, looksLikeManagedKey } from './gateway/api-key-store.mjs'

for (const provider of [claudeCliProvider, kiroInferenceProvider, kiroInferenceAlias]) {
  try {
    registerProvider(provider)
  } catch (error) {
    if (!error.message.includes('duplikat')) throw error
  }
}

const DEFAULT_ORIGINS = [
  'http://localhost:5199',
  'http://127.0.0.1:5199',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const TOOL_POLICIES = new Set(['none', 'read-only', 'standard'])

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''))
  const b = Buffer.from(String(right ?? ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearerToken(request) {
  const value = request.headers.authorization ?? ''
  return value.startsWith('Bearer ') ? value.slice(7) : ''
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function hasUnsafeSessionCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      character === '/' || character === '\\' || /\s/u.test(character)
      || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    ) return true
  }
  return false
}

function parseSessionId(value) {
  if (value === undefined || value === null || value === '') return randomUUID()
  if (typeof value !== 'string') throw new Error('sessionId harus berupa string')
  if (value.length > 200) throw new Error('sessionId melebihi batas 200 karakter')
  if (hasUnsafeSessionCharacter(value)) {
    throw new Error('sessionId mengandung whitespace, karakter kontrol, atau separator path')
  }
  return value
}

function parseRun(message, limits, providerForId = getProvider) {
  const prompt = cleanText(message.prompt, limits.maxPromptLength + 1)
  if (!prompt) throw new Error('Prompt kosong')
  if (prompt.length > limits.maxPromptLength) {
    throw new Error(`Prompt melebihi batas ${limits.maxPromptLength} karakter`)
  }

  const providerId = cleanText(message.providerId || 'claude-cli', 100)
  const provider = providerForId(providerId)
  if (!provider) throw new Error(`Provider tidak tersedia: ${providerId}`)

  const sessionId = parseSessionId(message.sessionId)
  const connectionId = cleanText(message.connectionId, 100)
  if (connectionId && !SAFE_ID_PATTERN.test(connectionId)) {
    throw new Error('connectionId tidak valid')
  }

  const agent = message.agent && typeof message.agent === 'object' ? message.agent : {}
  const agentId = cleanText(agent.id || 'personal-assistant', 100)
  if (!SAFE_ID_PATTERN.test(agentId)) throw new Error('agent.id tidak valid')
  const model = cleanText(agent.model, 100)
  if (model && !SAFE_ID_PATTERN.test(model)) throw new Error('Model tidak valid')
  const systemPrompt = cleanText(agent.systemPrompt, limits.maxSystemPromptLength + 1)
  if (systemPrompt.length > limits.maxSystemPromptLength) {
    throw new Error(`System prompt melebihi batas ${limits.maxSystemPromptLength} karakter`)
  }

  return {
    provider,
    request: {
      prompt,
      sessionId,
      connectionId,
      resume: message.resume === true,
      model,
      systemPrompt,
      toolPolicy: TOOL_POLICIES.has(agent.toolPolicy) ? agent.toolPolicy : 'standard',
      agentId,
    },
  }
}

function sendSocket(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

function apiError(response, status, message, code, headers = {}) {
  sendJson(
    response,
    status,
    { error: { message, type: status >= 500 ? 'gateway_error' : 'invalid_request_error', code } },
    headers,
  )
}

async function readJson(request, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error(`Body melebihi batas ${maxBytes} byte`), { status: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('Body bukan JSON valid'), { status: 400 })
  }
}

function corsHeaders(origin, allowedOrigins) {
  if (!origin || !allowedOrigins.has(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    // Cookie sesi dashboard butuh credentials diizinkan; origin sudah di-allowlist ketat.
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  }
}

async function readUpstreamJson(response, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > maxBytes) throw new Error(`Respons upstream melebihi batas ${maxBytes} byte`)
    chunks.push(Buffer.from(chunk))
  }
  const buffer = Buffer.concat(chunks)
  try {
    return { buffer, payload: JSON.parse(buffer.toString('utf8')) }
  } catch {
    return { buffer, payload: null }
  }
}

function categoryForStatus(status) {
  if (status === 401 || status === 403) return 'upstream_auth'
  if (status === 408 || status === 504) return 'upstream_timeout'
  if (status === 429) return 'upstream_rate_limit'
  return status >= 500 ? 'upstream_server' : 'upstream_request'
}

/**
 * Petakan error validator bearer HTTPS ke status admin API. Pesan validator
 * sudah teredaksi, jadi aman diteruskan; yang tidak dikenali dijadikan 502
 * generik supaya detail upstream tidak bocor.
 */
function mapKiroBearerError(error) {
  // Pesan ditulis di sini, bukan diambil dari error upstream. Teks upstream bisa
  // memuat kembali API key yang dikirim, jadi tidak pernah dipantulkan ke client.
  const known = {
    KIRO_BEARER_KEY_REQUIRED: [400, 'kiro_api_key_required', 'Kiro API key wajib diisi'],
    KIRO_BEARER_INVALID_REGION: [400, 'kiro_invalid_region', 'Region Kiro tidak didukung'],
    KIRO_BEARER_REJECTED: [401, 'kiro_auth_failed', 'Kiro API key ditolak CodeWhisperer. Periksa key dan region-nya'],
    KIRO_BEARER_TIMEOUT: [504, 'kiro_timeout', 'Validasi Kiro API key melewati batas waktu'],
    KIRO_BEARER_UNREACHABLE: [504, 'kiro_unreachable', 'Gagal menghubungi CodeWhisperer'],
    KIRO_BEARER_HTTP_ERROR: [502, 'kiro_failed', 'CodeWhisperer menolak permintaan validasi'],
  }
  const [status, code, message] = known[error?.code]
    ?? [error?.status ?? 502, 'kiro_failed', 'Validasi Kiro API key gagal']
  return Object.assign(new Error(message), { status, code, retryable: status >= 500 })
}

export function createGatewayServer(options = {}) {
  const env = options.env ?? process.env
  const host = options.host ?? env.GATEWAY_WS_HOST ?? env.WS_HOST ?? '127.0.0.1'
  const port = Number(options.port ?? env.GATEWAY_WS_PORT ?? env.WS_PORT ?? 8788)
  const wsToken = options.wsToken ?? env.GATEWAY_TOKEN ?? env.CLAUDE_BRIDGE_TOKEN ?? randomBytes(24).toString('hex')
  const apiKey = options.apiKey ?? env.GATEWAY_API_KEY ?? randomBytes(24).toString('hex')
  const adminToken = options.adminToken ?? env.GATEWAY_ADMIN_TOKEN ?? randomBytes(24).toString('hex')
  const generatedTokens = {
    ws: !options.wsToken && !env.GATEWAY_TOKEN && !env.CLAUDE_BRIDGE_TOKEN,
    api: !options.apiKey && !env.GATEWAY_API_KEY,
    admin: !options.adminToken && !env.GATEWAY_ADMIN_TOKEN,
  }
  const allowedOrigins = new Set(
    options.allowedOrigins ??
      env.ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ??
      DEFAULT_ORIGINS,
  )
  const limits = {
    maxClients: Number(env.GATEWAY_MAX_CLIENTS ?? env.CLAUDE_MAX_CLIENTS ?? 4),
    maxPromptLength: Number(env.GATEWAY_MAX_PROMPT_LEN ?? env.CLAUDE_MAX_PROMPT_LEN ?? 20_000),
    maxSystemPromptLength: Number(env.GATEWAY_MAX_SYSTEM_PROMPT_LEN ?? 12_000),
    maxOutputBytes: Number(env.GATEWAY_MAX_OUTPUT_BYTES ?? 2_000_000),
    maxBodyBytes: Number(env.GATEWAY_MAX_BODY_BYTES ?? 1_000_000),
    upstreamTimeoutMs: Number(env.GATEWAY_UPSTREAM_TIMEOUT_MS ?? 120_000),
    // Rate limit token bucket: kapasitas burst + laju refill per detik, per
    // kombinasi (API key + connection). 0 = nonaktif.
    rateCapacity: Number(env.GATEWAY_RATE_CAPACITY ?? 60),
    rateRefillPerSec: Number(env.GATEWAY_RATE_REFILL_PER_SEC ?? 1),
  }
  const dataDir = resolve(options.dataDir ?? env.GATEWAY_DATA_DIR ?? '.data/gateway')
  const masterKey = options.masterKey ?? env.GATEWAY_MASTER_KEY

  // Fail fast: master key wajib ada sebelum server melayani request apa pun.
  // Tanpa ini, gateway boot mulus tapi baru meledak saat menulis connection —
  // kelihatan sehat padahal separuh mati.
  if (typeof masterKey !== 'string' || masterKey.length < 16) {
    throw new Error('GATEWAY_MASTER_KEY wajib diisi minimal 16 karakter sebelum gateway bisa start')
  }

  const allowInsecureLocalhost = options.allowInsecureLocalhost ?? env.NODE_ENV !== 'production'
  const connectionStore = options.connectionStore ?? new ConnectionStore({
    dataDir,
    masterKey,
    allowInsecureLocalhost,
  })
  // Tabel harga (opsional file override) untuk menghitung biaya USD dari usage.
  const pricingTable = options.pricingTable ?? new PricingTable()
  if (!options.pricingTable) {
    // Muat override file secara async; sampai selesai pakai default.
    PricingTable.load({ dataDir, pricingFile: env.GATEWAY_PRICING_FILE })
      .then((loaded) => { Object.assign(pricingTable.prices, loaded.prices) })
      .catch(() => {})
  }

  // Peta alias model → target (mendukung failover lintas connection).
  const aliases = options.aliases ? { ...options.aliases } : {}
  if (!options.aliases) {
    loadAliases({ dataDir, aliasFile: env.GATEWAY_ALIASES_FILE, envValue: env.GATEWAY_ALIASES })
      .then((loaded) => { Object.assign(aliases, loaded) })
      .catch(() => {})
  }
  const usageStore = options.usageStore ?? new UsageStore({ dataDir, pricingTable })
  // API key gateway yang dibuat lewat dashboard. GATEWAY_API_KEY dari env tetap
  // hidup sebagai bootstrap/emergency key dan tidak tersimpan di store ini.
  const apiKeyStore = options.apiKeyStore ?? new ApiKeyStore({ dataDir, masterKey })
  // Statistik pemakaian key di-buffer di memori, lalu di-flush berkala supaya
  // request /v1 tidak menulis disk satu per satu.
  const apiKeyUsageFlusher = setInterval(() => {
    apiKeyStore.flushUsage().catch(() => {})
  }, 30_000)
  apiKeyUsageFlusher.unref?.()
  const fetchImpl = options.fetchImpl ?? fetch
  const skipKiroHostGuard = Boolean(options.fetchImpl || options.kiroFetchImpl)
  const kiroHttpClient = options.kiroHttpClient ?? createKiroHttpClient({
    fetchImpl: options.kiroFetchImpl ?? fetchImpl,
    assertHost: skipKiroHostGuard ? async () => {} : assertPublicHost,
    timeoutMs: limits.upstreamTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
  })
  // Validasi dan inference berbagi transport HTTPS, region, dan credential
  // connection. Binary Kiro hanya akan hidup pada provider ACP terpisah.
  const kiroBearerValidator = options.kiroBearerValidator ?? createKiroBearerValidator({
    fetchImpl: options.kiroFetchImpl ?? fetchImpl,
    assertHost: skipKiroHostGuard ? async () => {} : assertPublicHost,
  })
  const kiroProviderOptions = {
    client: kiroHttpClient,
    getConnection: (id) => id ? connectionStore.getWithSecret(id) : null,
  }
  const providers = options.providers ?? [
    claudeCliProvider,
    createKiroInferenceProvider(kiroProviderOptions),
    createKiroInferenceAlias(kiroProviderOptions),
  ]
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]))
  const providerForId = (id) => providerMap.get(id) ?? null
  const providerSummaries = providers.map(({ id, label, capabilities }) => ({ id, label, capabilities }))
  const connectionDrivers = options.connectionDrivers ?? [
    {
      id: 'openai-http',
      kinds: ['openai-http'],
      retryableByStatus: true,
      attempt: attemptUpstream,
    },
    createKiroInferenceDriver({ client: kiroHttpClient, limits }),
  ]
  const connectionDriverRegistry = options.connectionDriverRegistry
    ?? createConnectionDriverRegistry(connectionDrivers)

  // Rate limiter per (API key + connection). Nonaktif bila refill/capacity <= 0.
  const rateLimiterEnabled = limits.rateCapacity > 0 && limits.rateRefillPerSec > 0
  const rateLimiter = rateLimiterEnabled
    ? new RateLimiter({ capacity: limits.rateCapacity, refillPerSec: limits.rateRefillPerSec })
    : null
  const rateSweeper = rateLimiter ? setInterval(() => rateLimiter.sweep(), 600_000) : null
  rateSweeper?.unref?.()

  // Anti-SSRF saat fetch: verifikasi host upstream tidak me-resolve ke jaringan
  // internal. Menutup celah DNS rebinding yang lolos dari cek literal-IP di
  // normalizeBaseUrl. Bisa dilewati lewat fetchImpl kustom (test).
  async function guardUpstream(baseUrl) {
    if (options.fetchImpl) return
    try {
      await assertPublicHost(new URL(baseUrl).hostname, { allowLocalhost: allowInsecureLocalhost })
    } catch (error) {
      throw Object.assign(new Error(error.message), { status: 400, code: 'ssrf_blocked' })
    }
  }

  // Sesi dashboard: cookie httpOnly bertanda tangan HMAC. Rahasianya diturunkan
  // dari admin token + master key, jadi tidak perlu env var tambahan dan tetap
  // stabil lintas restart selama kedua nilai itu tidak berubah.
  const sessions = createSessionManager({ secret: `${adminToken}:${masterKey}` })
  const dashboardPassword = options.dashboardPassword ?? env.GATEWAY_DASHBOARD_PASSWORD ?? adminToken

  function verifyOrigin(origin) {
    return !origin || allowedOrigins.has(origin)
  }

  async function validateKiroBearer({ apiKey, region }) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw Object.assign(new Error('Kiro/CodeWhisperer API key wajib diisi'), {
        status: 400,
        code: 'kiro_api_key_required',
      })
    }
    try {
      return await kiroBearerValidator.validateApiKey({ apiKey, region })
    } catch (error) {
      throw mapKiroBearerError(error)
    }
  }

  /**
   * Auth untuk /v1/*. Dua jalur:
   *  - Bootstrap/emergency key dari GATEWAY_API_KEY (env). Selalu penuh scope,
   *    tidak punya record, keyId null di telemetry.
   *  - Managed key `onex_sk_…` yang dibuat lewat dashboard: dicek hash-nya,
   *    lalu scope/expiry/revoke/rate limit-nya diberlakukan.
   *
   * Return { ok: true, auth } atau { ok: false, status, message, code }.
   */
  async function authorizeApiRequest(request) {
    const presented = bearerToken(request)
    if (!presented) {
      return { ok: false, status: 401, message: 'API key gateway tidak valid', code: 'invalid_api_key' }
    }

    // Bootstrap key dulu supaya tetap berfungsi meski store bermasalah.
    if (!looksLikeManagedKey(presented) && safeEqual(presented, apiKey)) {
      return {
        ok: true,
        auth: {
          keyId: null,
          keyName: 'Bootstrap (GATEWAY_API_KEY)',
          scopes: [...API_KEY_SCOPES],
          rateLimit: null,
          bootstrap: true,
        },
      }
    }

    let verified
    try {
      verified = await apiKeyStore.verify(presented)
    } catch {
      return { ok: false, status: 500, message: 'API key store tidak bisa dibaca', code: 'api_key_store_error' }
    }
    if (!verified.ok) {
      const reasons = {
        revoked: [401, 'API key gateway sudah dicabut', 'api_key_revoked'],
        disabled: [401, 'API key gateway sedang dinonaktifkan', 'api_key_disabled'],
        expired: [401, 'API key gateway sudah kedaluwarsa', 'api_key_expired'],
      }
      const [status, message, code] = reasons[verified.reason]
        ?? [401, 'API key gateway tidak valid', 'invalid_api_key']
      return { ok: false, status, message, code }
    }

    return {
      ok: true,
      auth: {
        keyId: verified.key.id,
        keyName: verified.key.name,
        scopes: verified.key.scopes,
        rateLimit: verified.key.rateLimit,
        bootstrap: false,
      },
    }
  }

  function requireScope(auth, scope) {
    if (auth.scopes.includes(scope)) return null
    return {
      status: 403,
      message: `API key tidak punya scope ${scope}`,
      code: 'insufficient_scope',
    }
  }

  // Rate limiter per key (opsional, dari record key). Dipisah dari limiter
  // global supaya limit per key tidak saling mencuri token.
  const perKeyLimiters = new Map()
  function perKeyLimiterFor(auth) {
    if (!auth.rateLimit) return null
    const existing = perKeyLimiters.get(auth.keyId)
    if (
      existing
      && existing.capacity === auth.rateLimit.capacity
      && existing.refillPerSec === auth.rateLimit.refillPerSec
    ) return existing.limiter
    const limiter = new RateLimiter({
      capacity: auth.rateLimit.capacity,
      refillPerSec: auth.rateLimit.refillPerSec,
    })
    perKeyLimiters.set(auth.keyId, { ...auth.rateLimit, limiter })
    return limiter
  }

  // Admin surface menerima dua jalur auth:
  //  - Bearer admin token  → skrip/CI (server-to-server, tidak lewat browser).
  //  - Cookie sesi httpOnly → dashboard di browser, tanpa membocorkan token apa pun ke bundle.
  function isAdminAuthorized(request) {
    if (safeEqual(bearerToken(request), adminToken)) return true
    const cookies = parseCookies(request.headers.cookie)
    return sessions.verify(cookies[sessions.cookieName]) !== null
  }

  // Status yang layak di-failover ke connection kandidat berikutnya.
  function isFailoverStatus(status) {
    return status === 429 || status === 408 || (status >= 500 && status <= 599)
  }

  // Satu percobaan fetch ke satu connection. Melempar { retryable } agar
  // pemanggil bisa memutuskan lanjut failover atau tidak.
  async function attemptUpstream({ resource, connection, upstreamModel, body, response, headers, requestId }) {
    await guardUpstream(connection.baseUrl)
    const controller = new AbortController()
    const upstreamTimer = setTimeout(() => controller.abort(), limits.upstreamTimeoutMs)
    try {
      const upstream = await fetchImpl(upstreamUrl(connection.baseUrl, resource), {
        method: 'POST',
        headers: upstreamHeaders(connection.apiKey),
        body: JSON.stringify({ ...body, model: upstreamModel }),
        signal: controller.signal,
      })
      const status = upstream.status

      if (!upstream.ok) {
        const { payload } = await readUpstreamJson(upstream, limits.maxOutputBytes)
        return {
          done: false,
          status,
          usage: null,
          errorCategory: categoryForStatus(status),
          retryable: isFailoverStatus(status),
          errorPayload: safeUpstreamError(status, payload),
        }
      }

      const isStream = body.stream === true || upstream.headers.get('content-type')?.includes('text/event-stream')
      if (!isStream) {
        const { buffer, payload } = await readUpstreamJson(upstream, limits.maxOutputBytes)
        response.writeHead(status, {
          ...headers,
          'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
          'content-length': buffer.length,
          'x-request-id': requestId,
        })
        response.end(buffer)
        return { done: true, status, usage: payload?.usage ?? null, errorCategory: null }
      }

      response.writeHead(status, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': requestId,
      })
      let usage = null
      const parser = createSseUsageParser((nextUsage) => { usage = nextUsage })
      let outputBytes = 0
      for await (const chunk of upstream.body) {
        outputBytes += chunk.byteLength
        if (outputBytes > limits.maxOutputBytes) throw new Error(`Respons upstream melebihi batas ${limits.maxOutputBytes} byte`)
        parser.push(chunk)
        response.write(Buffer.from(chunk))
      }
      parser.finish()
      response.end()
      return { done: true, status, usage, errorCategory: null }
    } finally {
      clearTimeout(upstreamTimer)
    }
  }

  // Proxy generik untuk resource OpenAI-compatible (chat/completions,
  // completions, embeddings). Melakukan resolusi model+alias dan failover
  // ke connection kandidat berikutnya saat kena 429/5xx.
  async function proxyResource(request, response, body, headers, resource, auth = null) {
    const requestId = `req_${randomUUID()}`
    const startedAt = Date.now()
    let usage = null
    let status = 500
    let errorCategory = null
    let lastConnectionId = null
    let lastUpstreamModel = null

    try {
      const connections = await connectionStore.list()
      const { resolvedModel, candidates } = resolveModelCandidates(body.model, { aliases, connections })
      const separator = resolvedModel.indexOf('/')
      const explicitConnectionId = separator > 0 ? resolvedModel.slice(0, separator) : ''
      const explicit = connections.find((connection) => connection.id === explicitConnectionId)
      const explicitDriver = connectionDriverRegistry.forConnection(explicit)
      explicitDriver?.validateCandidate?.({
        connection: explicit,
        upstreamModel: candidates[0].upstreamModel,
      })

      let lastError = null
      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i]
        const connection = await connectionStore.getWithSecret(candidate.connectionId)
        if (!connection || !connection.enabled) continue
        if (
          connection.models.length
          && !connection.models.includes(candidate.upstreamModel)
        ) continue

        lastConnectionId = candidate.connectionId
        lastUpstreamModel = candidate.upstreamModel
        const hasMore = i < candidates.length - 1

        const driver = connectionDriverRegistry.forConnection(connection)
        if (!driver) {
          throw Object.assign(new Error(`Connection kind tidak didukung: ${connection.kind}`), {
            status: 400,
            code: 'unsupported_connection_kind',
            retryable: false,
          })
        }

        let result
        try {
          result = await driver.attempt({
            resource,
            connection,
            upstreamModel: candidate.upstreamModel,
            body,
            request,
            response,
            headers,
            requestId,
          })
        } catch (error) {
          status = Number(error.status) || (error.name === 'AbortError' ? 504 : 502)
          errorCategory = error.name === 'AbortError'
            ? 'upstream_timeout'
            : error.code ?? 'gateway_failure'
          lastError = error
          const retryable = error.retryable
            ?? (driver.retryableByStatus === true && isFailoverStatus(status))
          if (retryable && hasMore && !response.headersSent) continue
          throw error
        }

        status = result.status
        errorCategory = result.errorCategory
        usage = result.usage

        if (result.done) return
        // Upstream mengembalikan error status.
        if (result.retryable && hasMore && !response.headersSent) {
          lastError = result.errorPayload
          continue
        }
        // Tidak retryable atau kandidat habis → teruskan error ke client.
        sendJson(response, result.status, result.errorPayload, headers)
        return
      }

      // Semua kandidat gagal/terlewati.
      if (!response.headersSent) {
        if (lastError && typeof lastError === 'object' && 'error' in lastError) {
          sendJson(response, status || 502, lastError, headers)
        } else {
          apiError(response, status || 502, 'Semua connection kandidat gagal', 'all_candidates_failed', headers)
        }
      }
    } catch (error) {
      status = Number(error.status) || (error.name === 'AbortError' ? 504 : 502)
      errorCategory = error.name === 'AbortError' ? 'upstream_timeout' : error.code ?? 'gateway_failure'
      if (!response.headersSent) apiError(response, status, error.message, error.code ?? errorCategory, headers)
      else response.destroy()
    } finally {
      if (lastConnectionId) {
        try {
          await usageStore.append({
            requestId,
            connectionId: lastConnectionId,
            keyId: auth?.keyId ?? null,
            keyName: auth?.keyName ?? null,
            model: lastUpstreamModel,
            stream: body.stream === true,
            status,
            success: status >= 200 && status < 300,
            latencyMs: Date.now() - startedAt,
            usage,
            errorCategory,
          })
        } catch (error) {
          console.error(`[gateway] gagal menyimpan telemetry ${requestId}: ${error.message}`)
        }
      }
    }
  }

  const httpServer = createServer(async (request, response) => {
    const origin = request.headers.origin
    const headers = corsHeaders(origin, allowedOrigins)
    if (!verifyOrigin(origin)) {
      apiError(response, 403, 'Origin tidak diizinkan', 'origin_forbidden')
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers)
      response.end()
      return
    }

    let url
    try {
      url = new URL(request.url, 'http://gateway.local')
    } catch {
      apiError(response, 400, 'URL tidak valid', 'invalid_url', headers)
      return
    }

    try {
      if (url.pathname.startsWith('/v1/')) {
        const authResult = await authorizeApiRequest(request)
        if (!authResult.ok) {
          apiError(response, authResult.status, authResult.message, authResult.code, headers)
          return
        }
        const auth = authResult.auth
        // Statistik pemakaian key (buffered, di-flush berkala).
        apiKeyStore.touch(auth.keyId)

        // Scope: pembacaan katalog model vs. pemakaian inference dipisah.
        const requiredScope = request.method === 'GET' && url.pathname.startsWith('/v1/models')
          ? 'models:read'
          : 'chat:write'
        const scopeError = requireScope(auth, requiredScope)
        if (scopeError) {
          apiError(response, scopeError.status, scopeError.message, scopeError.code, headers)
          return
        }

        if (request.method === 'GET' && url.pathname === '/v1/models') {
          const connections = (await connectionStore.list()).filter((item) => item.enabled)
          const data = connections.flatMap((connection) => connection.models.map((model) => ({
            id: `${connection.id}/${model}`,
            object: 'model',
            created: Math.floor(Date.parse(connection.createdAt) / 1000),
            owned_by: connection.id,
          })))
          // Alias juga muncul sebagai model virtual yang bisa dipanggil client.
          for (const alias of Object.keys(aliases)) {
            data.push({ id: alias, object: 'model', created: 0, owned_by: 'alias' })
          }
          sendJson(response, 200, { object: 'list', data }, headers)
          return
        }
        // GET /v1/models/{id} — retrieve satu model (id = connection/model atau alias).
        const modelMatch = url.pathname.match(/^\/v1\/models\/(.+)$/)
        if (request.method === 'GET' && modelMatch) {
          const id = decodeURIComponent(modelMatch[1])
          if (aliases[id]) {
            sendJson(response, 200, { id, object: 'model', created: 0, owned_by: 'alias' }, headers)
            return
          }
          try {
            const { connectionId, upstreamModel } = parseGatewayModel(id)
            const connection = await connectionStore.get(connectionId)
            if (connection && connection.enabled &&
              (!connection.models.length || connection.models.includes(upstreamModel))) {
              sendJson(response, 200, {
                id,
                object: 'model',
                created: Math.floor(Date.parse(connection.createdAt) / 1000),
                owned_by: connection.id,
              }, headers)
              return
            }
          } catch {
            // format id salah → jatuh ke 404 di bawah
          }
          apiError(response, 404, `Model tidak ditemukan: ${id}`, 'model_not_found', headers)
          return
        }

        // Resource proxy OpenAI-compatible dengan rate limit + failover + alias.
        const resourceRoutes = {
          '/v1/chat/completions': 'chat/completions',
          '/v1/completions': 'completions',
          '/v1/embeddings': 'embeddings',
        }
        const resource = resourceRoutes[url.pathname]
        if (request.method === 'POST' && resource) {
          const body = await readJson(request, limits.maxBodyBytes)
          // Rate limit per (API key + connection kandidat pertama). Resolusi model
          // dipakai untuk menentukan connection; kalau gagal, pakai key generik.
          let rateKey = 'unknown'
          if (rateLimiter || auth.rateLimit) {
            try {
              const { candidates } = resolveModelCandidates(body.model, {
                aliases,
                connections: await connectionStore.list(),
              })
              rateKey = candidates[0]?.connectionId ?? 'unknown'
            } catch {
              // model invalid/tak tersedia → tetap rate limit agar bukan jalur bypass.
            }
          }
          // Limit khusus milik key (kalau di-set di dashboard) diperiksa lebih
          // dulu; batas global tetap berlaku sebagai plafon.
          const keyLimiter = perKeyLimiterFor(auth)
          for (const [limiter, bucketKey, label] of [
            [keyLimiter, `key:${auth.keyId}`, auth.keyName ?? 'API key'],
            [rateLimiter, `v1:${auth.keyId ?? 'bootstrap'}:${rateKey}`, rateKey],
          ]) {
            if (!limiter) continue
            const { allowed, retryAfterMs } = limiter.take(bucketKey)
            if (!allowed) {
              const retryAfter = Math.ceil(retryAfterMs / 1000)
              apiError(response, 429, `Rate limit terlampaui untuk ${label}, coba lagi dalam ${retryAfter}s`, 'rate_limited', {
                ...headers,
                'retry-after': String(retryAfter),
              })
              return
            }
          }
          await proxyResource(request, response, body, headers, resource, auth)
          return
        }
        apiError(response, 404, 'Endpoint tidak ditemukan', 'not_found', headers)
        return
      }

      if (url.pathname.startsWith('/admin/')) {
        // Admin surface eksklusif browser: tolak request tanpa Origin (curl/SDK),
        // karena allowlist origin hanya efektif kalau header-nya wajib ada di sini.
        if (!origin || !allowedOrigins.has(origin)) {
          apiError(response, 403, 'Admin API hanya menerima request dari origin dashboard yang diizinkan', 'origin_forbidden', headers)
          return
        }

        // Login: tukar password dashboard dengan cookie sesi httpOnly.
        if (request.method === 'POST' && url.pathname === '/admin/login') {
          const loginBody = await readJson(request, limits.maxBodyBytes)
          if (!safeEqual(loginBody?.password, dashboardPassword)) {
            apiError(response, 401, 'Password dashboard salah', 'invalid_credentials', headers)
            return
          }
          const token = sessions.issue('admin')
          sendJson(response, 200, { data: { ok: true } }, {
            ...headers,
            'set-cookie': serializeSessionCookie(sessions.cookieName, token, { ttlMs: sessions.ttlMs }),
          })
          return
        }
        if (request.method === 'POST' && url.pathname === '/admin/logout') {
          sendJson(response, 200, { data: { ok: true } }, {
            ...headers,
            'set-cookie': serializeSessionCookie(sessions.cookieName, '', { clear: true }),
          })
          return
        }
        if (request.method === 'GET' && url.pathname === '/admin/session') {
          const cookies = parseCookies(request.headers.cookie)
          sendJson(response, 200, { data: { authenticated: sessions.verify(cookies[sessions.cookieName]) !== null } }, headers)
          return
        }

        if (!isAdminAuthorized(request)) {
          apiError(response, 401, 'Sesi admin tidak valid', 'invalid_admin_token', headers)
          return
        }
        if (request.method === 'GET' && url.pathname === '/admin/connections') {
          sendJson(response, 200, { data: await connectionStore.list() }, headers)
          return
        }
        // Import bearer credential Kiro tanpa `kiro-cli`: validasi lewat HTTPS
        // ke CodeWhisperer, lalu simpan connection kalau (dan hanya kalau)
        // validasi lolos.
        if (request.method === 'POST' && url.pathname === '/admin/connections/kiro/api-key') {
          const input = await readJson(request, limits.maxBodyBytes)
          const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
          if (!apiKey) {
            apiError(response, 400, 'Kiro API key wajib diisi', 'kiro_api_key_required', headers)
            return
          }

          let identity
          try {
            identity = await kiroBearerValidator.validateApiKey({
              apiKey,
              region: input?.region,
            })
          } catch (error) {
            throw mapKiroBearerError(error)
          }

          const id = typeof input?.id === 'string' && input.id.trim()
            ? input.id.trim().toLowerCase()
            : `kiro-${randomBytes(4).toString('hex')}`

          sendJson(response, 201, {
            data: await connectionStore.create({
              id,
              name: typeof input?.name === 'string' && input.name.trim()
                ? input.name
                : identity.email ?? 'Kiro API Key',
              kind: 'kiro-cli',
              authMode: 'api-key',
              apiKey,
              region: identity.region,
              models: identity.models,
              enabled: input?.enabled !== false,
            }, {
              validatedAt: identity.validatedAt,
              identity: { profileArn: identity.profileArn, email: identity.email },
              availableModels: identity.models,
            }),
          }, headers)
          return
        }
        if (request.method === 'POST' && url.pathname === '/admin/connections') {
          const input = await readJson(request, limits.maxBodyBytes)
          const normalized = validateConnectionInput(input, { allowInsecureLocalhost })
          const identity = normalized.kind === 'kiro-cli'
            ? await validateKiroBearer({
                apiKey: input.apiKey,
                region: normalized.region,
              })
            : undefined
          const createInput = identity
            ? { ...input, models: identity.models }
            : input
          sendJson(response, 201, {
            data: await connectionStore.create(createInput, {
              validatedAt: identity?.validatedAt,
              identity,
              availableModels: identity?.models,
            }),
          }, headers)
          return
        }
        const connectionMatch = url.pathname.match(/^\/admin\/connections\/([a-z0-9-]+)$/)
        if (connectionMatch && request.method === 'PATCH') {
          const current = await connectionStore.getWithSecret(connectionMatch[1])
          if (!current) throw Object.assign(new Error('Connection tidak ditemukan'), { status: 404 })
          const input = await readJson(request, limits.maxBodyBytes)
          const normalized = validateConnectionInput({ ...current, ...input, id: current.id }, {
            allowInsecureLocalhost,
          })
          const candidateKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
          let identity
          if (normalized.kind === 'kiro-cli') {
            const regionChanged = current.kind !== 'kiro-cli' || normalized.region !== current.region
            if (candidateKey || regionChanged) {
              identity = await validateKiroBearer({
                apiKey: candidateKey || (current.kind === 'kiro-cli' ? current.apiKey : ''),
                region: normalized.region,
              })
            }
          }
          sendJson(response, 200, {
            data: await connectionStore.update(connectionMatch[1], input, {
              validatedAt: identity?.validatedAt,
              identity,
              availableModels: identity?.models,
            }),
          }, headers)
          return
        }
        if (connectionMatch && request.method === 'DELETE') {
          sendJson(response, 200, { data: await connectionStore.delete(connectionMatch[1]) }, headers)
          return
        }
        const modelTestMatch = url.pathname.match(
          /^\/admin\/connections\/([a-z0-9-]+)\/models\/([^/]+)\/test$/,
        )
        if (modelTestMatch && request.method === 'POST') {
          const connection = await connectionStore.getWithSecret(modelTestMatch[1])
          if (!connection) throw Object.assign(new Error('Connection tidak ditemukan'), { status: 404 })
          if (connection.kind !== 'kiro-cli') {
            throw Object.assign(new Error('Test model individual hanya tersedia untuk Kiro'), {
              status: 400,
              code: 'kiro_model_test_only',
            })
          }
          const model = decodeURIComponent(modelTestMatch[2])
          if (!connection.availableModels.includes(model)) {
            throw Object.assign(new Error(`Model Kiro tidak tersedia: ${model}`), {
              status: 404,
              code: 'model_not_available',
            })
          }

          const chunks = []
          const result = await kiroHttpClient.generate({
            apiKey: connection.apiKey,
            region: connection.region,
            profileArn: connection.profileArn,
            model,
            messages: [{ role: 'user', text: 'Reply with OK only.' }],
            onChunk(text) { chunks.push(text) },
          })
          sendJson(response, 200, {
            data: {
              ok: true,
              model: `${connection.id}/${model}`,
              output: chunks.join(''),
              usage: result.usage,
            },
          }, headers)
          return
        }
        const testMatch = url.pathname.match(/^\/admin\/connections\/([a-z0-9-]+)\/test$/)
        if (testMatch && request.method === 'POST') {
          const connection = await connectionStore.getWithSecret(testMatch[1])
          if (!connection) throw Object.assign(new Error('Connection tidak ditemukan'), { status: 404 })

          if (connection.kind === 'kiro-cli') {
            const identity = await validateKiroBearer({
              apiKey: connection.apiKey,
              region: connection.region,
            })
            const refreshed = await connectionStore.update(connection.id, {}, {
              validatedAt: identity.validatedAt,
              identity,
              availableModels: identity.models,
            })
            sendJson(response, 200, {
              data: {
                ok: true,
                models: identity.models,
                activeModels: refreshed.models,
                credentialType: 'bearer',
                validatedAt: identity.validatedAt,
              },
            }, headers)
            return
          }

          await guardUpstream(connection.baseUrl)
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), limits.upstreamTimeoutMs)
          let upstream
          let payload
          try {
            upstream = await fetchImpl(upstreamUrl(connection.baseUrl, 'models'), {
              headers: upstreamHeaders(connection.apiKey),
              signal: controller.signal,
            })
            ;({ payload } = await readUpstreamJson(upstream, limits.maxOutputBytes))
          } catch (error) {
            if (error.name === 'AbortError') {
              throw Object.assign(new Error('Connection test timeout'), {
                status: 504,
                code: 'upstream_timeout',
              })
            }
            throw error
          } finally {
            clearTimeout(timer)
          }
          if (!upstream.ok) {
            sendJson(response, upstream.status, safeUpstreamError(upstream.status, payload), headers)
            return
          }
          sendJson(response, 200, {
            data: {
              ok: true,
              models: Array.isArray(payload?.data)
                ? payload.data.map((model) => model?.id).filter((id) => typeof id === 'string')
                : [],
            },
          }, headers)
          return
        }
        // --- API key gateway (client-facing) ---
        // Plaintext hanya dikembalikan sekali, di respons create/rotate.
        if (url.pathname === '/admin/api-keys') {
          if (request.method === 'GET') {
            sendJson(response, 200, {
              data: { keys: await apiKeyStore.list(), scopes: [...API_KEY_SCOPES] },
            }, headers)
            return
          }
          if (request.method === 'POST') {
            const input = await readJson(request, limits.maxBodyBytes)
            sendJson(response, 201, { data: await apiKeyStore.create(input) }, headers)
            return
          }
        }
        const apiKeyMatch = url.pathname.match(/^\/admin\/api-keys\/(key_[a-f0-9]{16})$/)
        if (apiKeyMatch && request.method === 'PATCH') {
          const input = await readJson(request, limits.maxBodyBytes)
          sendJson(response, 200, { data: await apiKeyStore.update(apiKeyMatch[1], input) }, headers)
          return
        }
        if (apiKeyMatch && request.method === 'DELETE') {
          // ?mode=revoke menyimpan record (jejak audit) tapi mematikan key;
          // default menghapus record sepenuhnya.
          const revokeOnly = url.searchParams.get('mode') === 'revoke'
          sendJson(response, 200, {
            data: revokeOnly
              ? await apiKeyStore.revoke(apiKeyMatch[1])
              : await apiKeyStore.delete(apiKeyMatch[1]),
          }, headers)
          return
        }
        const rotateMatch = url.pathname.match(/^\/admin\/api-keys\/(key_[a-f0-9]{16})\/rotate$/)
        if (rotateMatch && request.method === 'POST') {
          sendJson(response, 200, { data: await apiKeyStore.rotate(rotateMatch[1]) }, headers)
          return
        }

        if (request.method === 'GET' && url.pathname === '/admin/usage') {
          // Pastikan hitungan pemakaian key terbaru ikut terlihat di dashboard.
          await apiKeyStore.flushUsage().catch(() => {})
          sendJson(response, 200, { data: await usageStore.aggregate(url.searchParams.get('range') ?? '7d') }, headers)
          return
        }
        apiError(response, 404, 'Admin endpoint tidak ditemukan', 'not_found', headers)
        return
      }

      // Health check ringan, tanpa membocorkan daftar endpoint atau banner.
      if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
        sendJson(response, 200, { status: 'ok' }, headers)
        return
      }

      // Catch-all: 404 polos. Tidak lagi mengembalikan banner + daftar endpoint
      // di sembarang path (menghindari fingerprinting tanpa auth).
      apiError(response, 404, 'Not found', 'not_found', headers)
    } catch (error) {
      apiError(response, Number(error.status) || 400, error.message, error.code ?? 'invalid_request', headers)
    }
  })

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient({ origin, req }, done) {
      if (!verifyOrigin(origin)) {
        done(false, 403, 'Origin tidak diizinkan')
        return
      }
      let token = ''
      try {
        token = new URL(req.url, 'http://localhost').searchParams.get('token') ?? ''
      } catch {
        // URL invalid ditolak sebagai token kosong.
      }
      if (!safeEqual(token, wsToken)) {
        done(false, 401, 'Token tidak valid')
        return
      }
      done(true)
    },
  })

  wss.on('connection', (socket) => {
    if (wss.clients.size > limits.maxClients) {
      sendSocket(socket, { type: 'error', text: `Gateway penuh (maks ${limits.maxClients} koneksi)` })
      socket.close()
      return
    }

    let activeRun = null
    sendSocket(socket, { type: 'hello', protocolVersion: 1, providers: providerSummaries })

    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        sendSocket(socket, { type: 'error', text: 'Pesan bukan JSON valid' })
        return
      }
      if (message?.type === 'cancel') {
        if (activeRun?.controller) activeRun.controller.cancel()
        else sendSocket(socket, { type: 'error', text: 'Tidak ada run yang aktif' })
        return
      }
      if (message?.type !== 'run') {
        sendSocket(socket, { type: 'error', text: `Tipe pesan tidak didukung: ${message?.type ?? 'unknown'}` })
        return
      }
      if (activeRun) {
        sendSocket(socket, { type: 'error', text: 'Masih ada run yang aktif' })
        return
      }

      let parsed
      try {
        parsed = parseRun(message, limits, providerForId)
      } catch (error) {
        sendSocket(socket, { type: 'error', text: error.message })
        return
      }

      const { provider, request } = parsed
      const runState = { controller: null, outputBytes: 0, terminal: false }
      activeRun = runState
      sendSocket(socket, { type: 'session', sessionId: request.sessionId, providerId: provider.id, agentId: request.agentId })
      try {
        const controller = provider.start(request, {
          onSession(sessionId) {
            if (activeRun !== runState || runState.terminal) return
            sendSocket(socket, { type: 'session', sessionId, providerId: provider.id, agentId: request.agentId })
          },
          onChunk(text, level) {
            if (activeRun !== runState || runState.terminal) return
            runState.outputBytes += Buffer.byteLength(text, 'utf8')
            if (runState.outputBytes > limits.maxOutputBytes) {
              runState.terminal = true
              sendSocket(socket, { type: 'error', text: `Output melebihi batas ${limits.maxOutputBytes} byte` })
              runState.controller?.dispose()
              if (activeRun === runState) activeRun = null
              return
            }
            sendSocket(socket, { type: 'chunk', text, level })
          },
          onDone(result) {
            if (activeRun !== runState || runState.terminal) return
            runState.terminal = true
            sendSocket(socket, { type: 'done', providerId: provider.id, ...result })
            if (activeRun === runState) activeRun = null
          },
          onError(text) {
            if (activeRun !== runState || runState.terminal) return
            runState.terminal = true
            sendSocket(socket, { type: 'error', text })
            if (activeRun === runState) activeRun = null
          },
        })
        runState.controller = controller
        if (runState.terminal) controller?.dispose?.()
      } catch (error) {
        runState.terminal = true
        if (activeRun === runState) activeRun = null
        sendSocket(socket, { type: 'error', text: `Provider gagal dimulai: ${error.message}` })
      }
    })

    const disposeActiveRun = () => {
      const runState = activeRun
      activeRun = null
      runState?.controller?.dispose()
    }
    socket.on('close', disposeActiveRun)
    socket.on('error', disposeActiveRun)
  })

  return {
    httpServer,
    wss,
    connectionStore,
    usageStore,
    apiKeyStore,
    config: { host, port, allowedOrigins, generatedTokens, wsToken, apiKey, adminToken, dataDir },
    listen() {
      return new Promise((resolveListen, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject)
          resolveListen(httpServer.address())
        })
      })
    },
    close() {
      if (rateSweeper) clearInterval(rateSweeper)
      clearInterval(apiKeyUsageFlusher)
      // Jangan sampai hitungan pemakaian key yang masih di buffer hilang saat shutdown.
      apiKeyStore.flushUsage().catch(() => {})
      for (const client of wss.clients) client.terminate()
      return new Promise((resolveClose, reject) => {
        wss.close(() => httpServer.close((error) => (error ? reject(error) : resolveClose())))
      })
    },
  }
}

async function startFromCli() {
  const gateway = createGatewayServer()
  const address = await gateway.listen()
  const displayHost = typeof address === 'object' ? address.address : gateway.config.host
  const displayPort = typeof address === 'object' ? address.port : gateway.config.port
  console.log(`[gateway] listening on http://${displayHost}:${displayPort} (HTTP + WebSocket)`)
  console.log(`[gateway] providers: ${listProviders().map((provider) => provider.id).join(', ')}`)
  console.log(`[gateway] data: ${gateway.config.dataDir}`)
  console.log(`[gateway] origin allowlist: ${[...gateway.config.allowedOrigins].join(', ')}`)
  for (const [name, generated] of Object.entries(gateway.config.generatedTokens)) {
    if (generated) console.log(`[gateway] ${name} token (auto): ${gateway.config[`${name}Token`] ?? gateway.config.apiKey}`)
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntrypoint) {
  startFromCli().catch((error) => {
    console.error(`[gateway] gagal start: ${error.message}`)
    process.exitCode = 1
  })
}

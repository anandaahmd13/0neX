import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { ConnectionStore } from './gateway/connection-store.mjs'
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
import { UsageStore } from './gateway/usage-store.mjs'
import { createSessionManager, parseCookies, serializeSessionCookie } from './gateway/session.mjs'
import { assertPublicHost } from './gateway/net-guard.mjs'
import { RateLimiter } from './gateway/rate-limiter.mjs'
import { PricingTable } from './gateway/pricing.mjs'
import { loadAliases } from './gateway/aliases.mjs'

try {
  registerProvider(claudeCliProvider)
} catch (error) {
  if (!error.message.includes('duplikat')) throw error
}

const DEFAULT_ORIGINS = [
  'http://localhost:5199',
  'http://127.0.0.1:5199',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

function parseRun(message, limits) {
  const prompt = cleanText(message.prompt, limits.maxPromptLength + 1)
  if (!prompt) throw new Error('Prompt kosong')
  if (prompt.length > limits.maxPromptLength) {
    throw new Error(`Prompt melebihi batas ${limits.maxPromptLength} karakter`)
  }

  const providerId = cleanText(message.providerId || 'claude-cli', 100)
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Provider tidak tersedia: ${providerId}`)

  const sessionId = cleanText(message.sessionId, 100) || randomUUID()
  if (!UUID_PATTERN.test(sessionId)) throw new Error('sessionId bukan UUID valid')

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
  const fetchImpl = options.fetchImpl ?? fetch

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
  async function proxyResource(request, response, body, headers, resource) {
    const requestId = `req_${randomUUID()}`
    const startedAt = Date.now()
    let usage = null
    let status = 500
    let errorCategory = null
    let lastConnectionId = null
    let lastUpstreamModel = null

    try {
      const connections = await connectionStore.list()
      const { candidates } = resolveModelCandidates(body.model, { aliases, connections })

      let lastError = null
      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i]
        const connection = await connectionStore.getWithSecret(candidate.connectionId)
        if (!connection || !connection.enabled) continue
        if (connection.models.length && !connection.models.includes(candidate.upstreamModel)) continue

        lastConnectionId = candidate.connectionId
        lastUpstreamModel = candidate.upstreamModel
        const hasMore = i < candidates.length - 1

        let result
        try {
          result = await attemptUpstream({
            resource,
            connection,
            upstreamModel: candidate.upstreamModel,
            body,
            response,
            headers,
            requestId,
          })
        } catch (error) {
          // Error jaringan/timeout: coba kandidat berikutnya kalau belum kirim header.
          status = error.name === 'AbortError' ? 504 : 502
          errorCategory = error.name === 'AbortError' ? 'upstream_timeout' : 'gateway_failure'
          lastError = error
          if (hasMore && !response.headersSent) continue
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
        if (!safeEqual(bearerToken(request), apiKey)) {
          apiError(response, 401, 'API key gateway tidak valid', 'invalid_api_key', headers)
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
          if (rateLimiter) {
            let rateKey = 'unknown'
            try {
              const { candidates } = resolveModelCandidates(body.model, {
                aliases,
                connections: await connectionStore.list(),
              })
              rateKey = candidates[0]?.connectionId ?? 'unknown'
            } catch {
              // model invalid/tak tersedia → tetap rate limit agar bukan jalur bypass.
            }
            const { allowed, retryAfterMs } = rateLimiter.take(`v1:${rateKey}`)
            if (!allowed) {
              const retryAfter = Math.ceil(retryAfterMs / 1000)
              apiError(response, 429, `Rate limit terlampaui untuk ${rateKey}, coba lagi dalam ${retryAfter}s`, 'rate_limited', {
                ...headers,
                'retry-after': String(retryAfter),
              })
              return
            }
          }
          await proxyResource(request, response, body, headers, resource)
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
        if (request.method === 'POST' && url.pathname === '/admin/connections') {
          sendJson(response, 201, { data: await connectionStore.create(await readJson(request, limits.maxBodyBytes)) }, headers)
          return
        }
        const connectionMatch = url.pathname.match(/^\/admin\/connections\/([a-z0-9-]+)$/)
        if (connectionMatch && request.method === 'PATCH') {
          sendJson(response, 200, {
            data: await connectionStore.update(connectionMatch[1], await readJson(request, limits.maxBodyBytes)),
          }, headers)
          return
        }
        if (connectionMatch && request.method === 'DELETE') {
          sendJson(response, 200, { data: await connectionStore.delete(connectionMatch[1]) }, headers)
          return
        }
        const testMatch = url.pathname.match(/^\/admin\/connections\/([a-z0-9-]+)\/test$/)
        if (testMatch && request.method === 'POST') {
          const connection = await connectionStore.getWithSecret(testMatch[1])
          if (!connection) throw Object.assign(new Error('Connection tidak ditemukan'), { status: 404 })
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
        if (request.method === 'GET' && url.pathname === '/admin/usage') {
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
    let outputBytes = 0
    sendSocket(socket, { type: 'hello', protocolVersion: 1, providers: listProviders() })

    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        sendSocket(socket, { type: 'error', text: 'Pesan bukan JSON valid' })
        return
      }
      if (message?.type === 'cancel') {
        if (activeRun) activeRun.cancel()
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
        parsed = parseRun(message, limits)
      } catch (error) {
        sendSocket(socket, { type: 'error', text: error.message })
        return
      }

      outputBytes = 0
      const { provider, request } = parsed
      sendSocket(socket, { type: 'session', sessionId: request.sessionId, providerId: provider.id, agentId: request.agentId })
      try {
        activeRun = provider.start(request, {
          onChunk(text, level) {
            outputBytes += Buffer.byteLength(text, 'utf8')
            if (outputBytes > limits.maxOutputBytes) {
              sendSocket(socket, { type: 'error', text: `Output melebihi batas ${limits.maxOutputBytes} byte` })
              activeRun?.dispose()
              activeRun = null
              return
            }
            sendSocket(socket, { type: 'chunk', text, level })
          },
          onDone(result) {
            sendSocket(socket, { type: 'done', providerId: provider.id, ...result })
            activeRun = null
          },
          onError(text) {
            sendSocket(socket, { type: 'error', text })
            activeRun = null
          },
        })
      } catch (error) {
        activeRun = null
        sendSocket(socket, { type: 'error', text: `Provider gagal dimulai: ${error.message}` })
      }
    })

    socket.on('close', () => {
      activeRun?.dispose()
      activeRun = null
    })
    socket.on('error', () => {
      activeRun?.dispose()
      activeRun = null
    })
  })

  return {
    httpServer,
    wss,
    connectionStore,
    usageStore,
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

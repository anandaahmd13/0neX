import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { ConnectionStore } from './gateway/connection-store.mjs'
import {
  createSseUsageParser,
  parseGatewayModel,
  safeUpstreamError,
  upstreamHeaders,
  upstreamUrl,
} from './gateway/openai-compatible.mjs'
import { getProvider, listProviders, registerProvider } from './gateway/provider-registry.mjs'
import { claudeCliProvider } from './gateway/providers/claude-cli.mjs'
import { UsageStore } from './gateway/usage-store.mjs'

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
  }
  const dataDir = resolve(options.dataDir ?? env.GATEWAY_DATA_DIR ?? '.data/gateway')
  const connectionStore = options.connectionStore ?? new ConnectionStore({
    dataDir,
    masterKey: options.masterKey ?? env.GATEWAY_MASTER_KEY,
    allowInsecureLocalhost: options.allowInsecureLocalhost ?? env.NODE_ENV !== 'production',
  })
  const usageStore = options.usageStore ?? new UsageStore({ dataDir })
  const fetchImpl = options.fetchImpl ?? fetch

  function verifyOrigin(origin) {
    return !origin || allowedOrigins.has(origin)
  }

  async function proxyChat(request, response, body, headers) {
    const requestId = `req_${randomUUID()}`
    const startedAt = Date.now()
    let parsedModel
    let connection
    let usage = null
    let status = 500
    let errorCategory = null
    let upstreamTimer = null

    try {
      parsedModel = parseGatewayModel(body.model)
      connection = await connectionStore.getWithSecret(parsedModel.connectionId)
      if (!connection || !connection.enabled) {
        throw Object.assign(new Error(`Connection tidak tersedia: ${parsedModel.connectionId}`), { status: 404, code: 'connection_not_found' })
      }
      if (connection.models.length && !connection.models.includes(parsedModel.upstreamModel)) {
        throw Object.assign(new Error(`Model tidak diizinkan pada connection ${connection.id}`), { status: 400, code: 'model_not_allowed' })
      }

      const controller = new AbortController()
      upstreamTimer = setTimeout(() => controller.abort(), limits.upstreamTimeoutMs)
      const upstream = await fetchImpl(upstreamUrl(connection.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: upstreamHeaders(connection.apiKey),
        body: JSON.stringify({ ...body, model: parsedModel.upstreamModel }),
        signal: controller.signal,
      })
      status = upstream.status

      if (!upstream.ok) {
        const { payload } = await readUpstreamJson(upstream, limits.maxOutputBytes)
        errorCategory = categoryForStatus(upstream.status)
        sendJson(response, upstream.status, safeUpstreamError(upstream.status, payload), headers)
        return
      }

      const isStream = body.stream === true || upstream.headers.get('content-type')?.includes('text/event-stream')
      if (!isStream) {
        const { buffer, payload } = await readUpstreamJson(upstream, limits.maxOutputBytes)
        usage = payload?.usage ?? null
        response.writeHead(upstream.status, {
          ...headers,
          'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
          'content-length': buffer.length,
          'x-request-id': requestId,
        })
        response.end(buffer)
        return
      }

      response.writeHead(upstream.status, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': requestId,
      })
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
    } catch (error) {
      status = Number(error.status) || (error.name === 'AbortError' ? 504 : 502)
      errorCategory = error.name === 'AbortError' ? 'upstream_timeout' : error.code ?? 'gateway_failure'
      if (!response.headersSent) apiError(response, status, error.message, error.code ?? errorCategory, headers)
      else response.destroy()
    } finally {
      if (upstreamTimer) clearTimeout(upstreamTimer)
      if (parsedModel) {
        try {
          await usageStore.append({
            requestId,
            connectionId: parsedModel.connectionId,
            model: parsedModel.upstreamModel,
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
          sendJson(response, 200, {
            object: 'list',
            data: connections.flatMap((connection) => connection.models.map((model) => ({
              id: `${connection.id}/${model}`,
              object: 'model',
              created: Math.floor(Date.parse(connection.createdAt) / 1000),
              owned_by: connection.id,
            }))),
          }, headers)
          return
        }
        if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
          await proxyChat(request, response, await readJson(request, limits.maxBodyBytes), headers)
          return
        }
        apiError(response, 404, 'Endpoint tidak ditemukan', 'not_found', headers)
        return
      }

      if (url.pathname.startsWith('/admin/')) {
        if (!safeEqual(bearerToken(request), adminToken)) {
          apiError(response, 401, 'Admin token tidak valid', 'invalid_admin_token', headers)
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

      sendJson(response, 200, {
        name: '0neX Personal AI Gateway',
        status: 'ok',
        endpoints: ['/v1/models', '/v1/chat/completions'],
      }, headers)
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

// Dashboard berbicara ke gateway lewat same-origin (dev: Vite proxy meneruskan
// /admin & /v1 ke gateway; prod: gateway menyajikan bundle di origin yang sama).
// Autentikasi memakai cookie sesi httpOnly — TIDAK ADA token admin di bundle browser.
const HTTP_BASE = (import.meta.env.VITE_GATEWAY_HTTP_URL as string | undefined)?.replace(/\/+$/, '') ?? ''

export type ConnectionKind = 'openai-http' | 'kiro-cli'
export type KiroRegion = 'us-east-1' | 'eu-central-1'

export interface GatewayConnection {
  id: string
  name: string
  kind: ConnectionKind
  baseUrl?: string
  credentialType?: 'bearer'
  region?: KiroRegion
  /** ARN profile CodeWhisperer hasil validasi bearer. Bukan secret. */
  profileArn?: string
  /** Email dari klaim JWT bearer, kalau key-nya memang JWT. Bukan secret. */
  email?: string
  validatedAt?: string
  models: string[]
  /** Katalog terbaru dari discovery Kiro; models adalah subset yang aktif. */
  availableModels?: string[]
  enabled: boolean
  hasApiKey: boolean
  createdAt: string
  updatedAt: string
}

export interface ConnectionInput {
  id: string
  name: string
  kind: ConnectionKind
  baseUrl?: string
  apiKey?: string
  region?: KiroRegion
  models: string[]
  enabled: boolean
}

/**
 * Payload import bearer Kiro. Hanya apiKey yang wajib; id/name diturunkan oleh
 * gateway dari hasil validasi kalau tidak diisi.
 */
export interface KiroApiKeyImport {
  apiKey: string
  region?: KiroRegion
  id?: string
  name?: string
  enabled?: boolean
}

export interface ConnectionTestResult {
  ok: boolean
  models: string[]
  activeModels?: string[]
  credentialType?: 'bearer'
  validatedAt?: string
}

export interface KiroModelTestResult {
  ok: boolean
  model: string
  output: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  } | null
}

export type UsageRange = '24h' | '7d' | '30d'

export interface GatewayUsageEvent {
  requestId: string
  timestamp: string
  connectionId: string
  model: string
  stream: boolean
  status: number
  success: boolean
  latencyMs: number
  usage: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
  } | null
  errorCategory: string | null
}

export interface GatewayUsageData {
  range: UsageRange
  summary: {
    requests: number
    successes: number
    successRate: number
    averageLatencyMs: number
    totalTokens: number
    knownTokenRequests: number
    totalCostUsd: number
  }
  breakdown: Array<{
    connectionId: string
    model: string
    requests: number
    successRate: number
    averageLatencyMs: number
    totalTokens: number
    knownTokenRequests: number
    totalCostUsd: number
  }>
  timeSeries: Array<{ timestamp: string; requests: number }>
  recent: GatewayUsageEvent[]
}

interface ApiEnvelope<T> {
  data: T
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${HTTP_BASE}${path}`, {
    ...init,
    // Kirim cookie sesi ke gateway.
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  const payload = (await response.json().catch(() => null)) as
    | ApiEnvelope<T>
    | { error?: { message?: string } }
    | null
  if (!response.ok) {
    const message = payload && 'error' in payload ? payload.error?.message : null
    throw new Error(message || `Gateway mengembalikan HTTP ${response.status}`)
  }
  if (!payload || !('data' in payload)) throw new Error('Respons Gateway tidak valid')
  return payload.data
}

export const gatewayHttpBase = HTTP_BASE || window.location.origin

export const gatewayApi = {
  login: (password: string) =>
    request<{ ok: boolean }>('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => request<{ ok: boolean }>('/admin/logout', { method: 'POST' }),
  session: () => request<{ authenticated: boolean }>('/admin/session'),
  listConnections: () => request<GatewayConnection[]>('/admin/connections'),
  createConnection: (input: ConnectionInput) =>
    request<GatewayConnection>('/admin/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /**
   * Import bearer credential Kiro. Gateway memvalidasi key ke CodeWhisperer
   * lewat HTTPS (tanpa kiro-cli) sebelum menyimpannya terenkripsi.
   */
  importKiroApiKey: (input: KiroApiKeyImport) =>
    request<GatewayConnection>('/admin/connections/kiro/api-key', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateConnection: (id: string, input: Partial<ConnectionInput>) =>
    request<GatewayConnection>(`/admin/connections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteConnection: (id: string) =>
    request<GatewayConnection>(`/admin/connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  testConnection: (id: string) =>
    request<ConnectionTestResult>(`/admin/connections/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
  testKiroModel: (id: string, model: string) =>
    request<KiroModelTestResult>(
      `/admin/connections/${encodeURIComponent(id)}/models/${encodeURIComponent(model)}/test`,
      { method: 'POST' },
    ),
  getUsage: (range: UsageRange) => request<GatewayUsageData>(`/admin/usage?range=${range}`),
}

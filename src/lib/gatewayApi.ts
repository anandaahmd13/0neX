// Dashboard berbicara ke gateway lewat same-origin (dev: Vite proxy meneruskan
// /admin & /v1 ke gateway; prod: gateway menyajikan bundle di origin yang sama).
// Autentikasi memakai cookie sesi httpOnly — TIDAK ADA token admin di bundle browser.
const HTTP_BASE = (import.meta.env.VITE_GATEWAY_HTTP_URL as string | undefined)?.replace(/\/+$/, '') ?? ''

export interface GatewayConnection {
  id: string
  name: string
  baseUrl: string
  models: string[]
  enabled: boolean
  hasApiKey: boolean
  createdAt: string
  updatedAt: string
}

export interface ConnectionInput {
  id: string
  name: string
  baseUrl: string
  apiKey?: string
  models: string[]
  enabled: boolean
}

export interface ConnectionTestResult {
  ok: boolean
  models: string[]
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
  }
  breakdown: Array<{
    connectionId: string
    model: string
    requests: number
    successRate: number
    averageLatencyMs: number
    totalTokens: number
    knownTokenRequests: number
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
  getUsage: (range: UsageRange) => request<GatewayUsageData>(`/admin/usage?range=${range}`),
}

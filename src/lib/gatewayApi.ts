const HTTP_BASE =
  (import.meta.env.VITE_GATEWAY_HTTP_URL as string | undefined)?.replace(/\/+$/, '') ??
  'http://localhost:8788'
const ADMIN_TOKEN = (import.meta.env.VITE_GATEWAY_ADMIN_TOKEN as string | undefined) ?? ''

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
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
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

export const gatewayHttpBase = HTTP_BASE

export const gatewayApi = {
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
  getUsage: (range: UsageRange) =>
    request<GatewayUsageData>(`/admin/usage?range=${range}`),
}

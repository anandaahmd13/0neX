import { useCallback, useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { PageTitle } from '../components/PageTitle'
import { CheckIcon, ClockIcon, PlusIcon, PulseIcon, TokenIcon, TrashIcon } from '../components/icons'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { StatCard } from '../components/ui/StatCard'
import {
  gatewayApi,
  gatewayHttpBase,
  type ConnectionInput,
  type GatewayApiKey,
  type GatewayApiKeyScope,
  type GatewayConnection,
  type GatewayMcpServer,
  type GatewayMcpServerInput,
  type GatewayUsageData,
  type KiroRegion,
  type McpTransport,
  type UsageRange,
} from '../lib/gatewayApi'
import { fmtCompact, fmtInt, fmtTime, fmtUsd } from '../lib/format'
import { useToast } from '../lib/toast'
import { cn } from '../lib/cn'

type Tab = 'overview' | 'connections' | 'mcp' | 'api-keys'

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'connections', label: 'Connections' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'api-keys', label: 'API Keys' },
]

const emptyForm: ConnectionInput = {
  id: '',
  name: '',
  kind: 'openai-http',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  models: [],
  enabled: true,
}

const emptyKiroForm: ConnectionInput = {
  id: 'kiro-main',
  name: 'Kiro Personal',
  kind: 'kiro-cli',
  apiKey: '',
  region: 'us-east-1',
  models: [],
  enabled: true,
}

const fieldClass =
  'w-full rounded-lg border-2 border-ink bg-cream px-3 py-2 text-sm outline-none placeholder:text-ink/40 focus:bg-paper disabled:opacity-60'

function modelsToText(models: string[]): string {
  return models.join('\n')
}

function textToModels(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((model) => model.trim()).filter(Boolean))]
}

export function Gateway() {
  const [tab, setTab] = useState<Tab>('overview')
  const [range, setRange] = useState<UsageRange>('7d')
  const [usage, setUsage] = useState<GatewayUsageData | null>(null)
  const [connections, setConnections] = useState<GatewayConnection[]>([])
  const [loadingUsage, setLoadingUsage] = useState(true)
  const [loadingConnections, setLoadingConnections] = useState(true)
  const [usageError, setUsageError] = useState('')
  const [connectionsError, setConnectionsError] = useState('')

  const loadUsage = useCallback(async () => {
    setLoadingUsage(true)
    setUsageError('')
    try {
      setUsage(await gatewayApi.getUsage(range))
    } catch (error) {
      setUsageError(error instanceof Error ? error.message : 'Gagal membaca usage')
    } finally {
      setLoadingUsage(false)
    }
  }, [range])

  const loadConnections = useCallback(async () => {
    setLoadingConnections(true)
    setConnectionsError('')
    try {
      setConnections(await gatewayApi.listConnections())
    } catch (error) {
      setConnectionsError(error instanceof Error ? error.message : 'Gagal membaca connections')
    } finally {
      setLoadingConnections(false)
    }
  }, [])

  useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  return (
    <div className="space-y-6">
      <PageTitle
        title="Personal AI Gateway"
        subtitle="Endpoint AI di domain lo, lengkap dengan provider connections dan usage aktual."
      />

      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase tracking-wider text-ink/50">Gateway endpoint</div>
            <code className="mt-1 block truncate text-sm font-bold">{gatewayHttpBase}/v1</code>
          </div>
          <div className="flex flex-wrap gap-2">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  'cursor-pointer rounded-lg border-2 border-ink px-3 py-1.5 text-xs font-bold',
                  tab === item.id ? 'bg-mustard shadow-hard-sm' : 'bg-paper hover:bg-sky-soft',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      {tab === 'overview' && (
        <UsageOverview
          usage={usage}
          loading={loadingUsage}
          error={usageError}
          range={range}
          onRange={setRange}
          onRetry={() => void loadUsage()}
        />
      )}
      {tab === 'connections' && (
        <ConnectionsPanel
          connections={connections}
          loading={loadingConnections}
          error={connectionsError}
          onReload={() => void loadConnections()}
          onChanged={loadConnections}
        />
      )}

      {tab === 'mcp' && <McpServersPanel />}
      {tab === 'api-keys' && <ApiKeysPanel />}
    </div>
  )
}

function UsageOverview({
  usage,
  loading,
  error,
  range,
  onRange,
  onRetry,
}: {
  usage: GatewayUsageData | null
  loading: boolean
  error: string
  range: UsageRange
  onRange: (range: UsageRange) => void
  onRetry: () => void
}) {
  if (loading && !usage) return <StateCard message="Membaca telemetry Gateway..." />
  if (error && !usage) return <ErrorCard message={error} onRetry={onRetry} />
  if (!usage) return <StateCard message="Belum ada telemetry." />

  const { summary } = usage
  const unknownTokens = summary.requests - summary.knownTokenRequests

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-2">
          {(['24h', '7d', '30d'] as UsageRange[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onRange(value)}
              className={cn(
                'cursor-pointer rounded-md border-2 border-ink px-2.5 py-1 text-xs font-bold',
                range === value ? 'bg-sky' : 'bg-paper',
              )}
            >
              {value}
            </button>
          ))}
        </div>
        {loading && <span className="text-xs font-bold text-ink/50">Refreshing...</span>}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Requests" value={fmtInt(summary.requests)} hint={`range ${usage.range}`} icon={<PulseIcon />} accent="sky" />
        <StatCard
          label="Known tokens"
          value={fmtCompact(summary.totalTokens)}
          hint={unknownTokens ? `${unknownTokens} request tanpa usage` : 'semua request terukur'}
          icon={<TokenIcon />}
          accent="mustard"
        />
        <StatCard
          label="Est. biaya"
          value={fmtUsd(summary.totalCostUsd)}
          hint="berdasar tabel harga"
          icon={<TokenIcon />}
          accent="ok"
        />
        <StatCard label="Success rate" value={`${summary.successRate.toFixed(1)}%`} hint={`${summary.successes} sukses`} icon={<CheckIcon />} accent="ok" />
        <StatCard label="Avg latency" value={`${Math.round(summary.averageLatencyMs)}ms`} hint="end-to-end upstream" icon={<ClockIcon />} accent="mustard" />
      </div>

      <Card>
        <CardHeader title="Request dari waktu ke waktu" />
        <CardBody>
          {usage.timeSeries.length === 0 ? (
            <EmptyText text="Belum ada request pada range ini." />
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={usage.timeSeries} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                  <XAxis dataKey="timestamp" tickFormatter={(value: string) => fmtTime(value)} tick={{ fontSize: 10 }} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <Tooltip labelFormatter={(value) => fmtTime(String(value))} />
                  <Area type="monotone" dataKey="requests" stroke="#1a1a1a" strokeWidth={2.5} fill="#8bd3dd" fillOpacity={0.55} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Model & connection" />
          {usage.breakdown.length === 0 ? (
            <CardBody><EmptyText text="Belum ada breakdown model." /></CardBody>
          ) : (
            <div className="divide-y-2 divide-ink">
              {usage.breakdown.slice(0, 10).map((row) => (
                <div key={`${row.connectionId}/${row.model}`} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-bold">{row.model}</div>
                    <div className="text-xs text-ink/50">{row.connectionId} · {row.successRate.toFixed(1)}% sukses</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-bold tabular-nums">{fmtInt(row.requests)} req</div>
                    <div className="text-xs text-ink/50">{fmtCompact(row.totalTokens)} tok · {fmtUsd(row.totalCostUsd)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="API key pemakai" />
          {usage.keyBreakdown.length === 0 ? (
            <CardBody><EmptyText text="Belum ada request dari API key mana pun." /></CardBody>
          ) : (
            <div className="divide-y-2 divide-ink">
              {usage.keyBreakdown.slice(0, 10).map((row) => (
                <div key={row.keyId ?? 'bootstrap'} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-bold">{row.keyName ?? row.keyId ?? 'Unknown key'}</div>
                    <div className="text-xs text-ink/50">
                      {row.successRate.toFixed(1)}% sukses
                      {row.lastUsedAt && ` · terakhir ${fmtTime(row.lastUsedAt)}`}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-bold tabular-nums">{fmtInt(row.requests)} req</div>
                    <div className="text-xs text-ink/50">{fmtCompact(row.totalTokens)} tok · {fmtUsd(row.totalCostUsd)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Request terbaru" />
          {usage.recent.length === 0 ? (
            <CardBody><EmptyText text="Belum ada request Gateway." /></CardBody>
          ) : (
            <div className="divide-y-2 divide-ink">
              {usage.recent.slice(0, 10).map((event) => (
                <div key={event.requestId} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-bold">{event.model}</div>
                    <div className="text-xs text-ink/50">{fmtTime(event.timestamp)} · {event.latencyMs}ms</div>
                  </div>
                  <Badge color={event.success ? 'ok' : 'danger'}>{event.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

function ConnectionsPanel({
  connections,
  loading,
  error,
  onReload,
  onChanged,
}: {
  connections: GatewayConnection[]
  loading: boolean
  error: string
  onReload: () => void
  onChanged: () => Promise<void>
}) {
  const { push } = useToast()
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ConnectionInput>(emptyForm)
  const [modelsText, setModelsText] = useState('')
  const [kiroOpen, setKiroOpen] = useState(false)
  const [kiroEditingId, setKiroEditingId] = useState<string | null>(null)
  const [kiroForm, setKiroForm] = useState<ConnectionInput>(emptyKiroForm)
  const [kiroError, setKiroError] = useState('')
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [busyModel, setBusyModel] = useState<string | null>(null)

  function openCreate() {
    setEditingId(null)
    setForm({ ...emptyForm })
    setModelsText('')
    setFormOpen(true)
  }

  function openKiroCreate() {
    setKiroEditingId(null)
    setKiroForm({ ...emptyKiroForm })
    setKiroError('')
    setKiroOpen(true)
  }

  function openEdit(connection: GatewayConnection, discoveredModels?: string[]) {
    if (connection.kind === 'kiro-cli') {
      setKiroEditingId(connection.id)
      setKiroForm({
        id: connection.id,
        name: connection.name,
        kind: 'kiro-cli',
        apiKey: '',
        region: connection.region ?? 'us-east-1',
        models: connection.models,
        enabled: connection.enabled,
      })
      setKiroError('')
      setKiroOpen(true)
      return
    }

    const models = discoveredModels ?? connection.models
    setEditingId(connection.id)
    setForm({
      id: connection.id,
      name: connection.name,
      kind: 'openai-http',
      baseUrl: connection.baseUrl,
      apiKey: '',
      models,
      enabled: connection.enabled,
    })
    setModelsText(modelsToText(models))
    setFormOpen(true)
  }

  function closeForm() {
    setForm((current) => ({ ...current, apiKey: '' }))
    setModelsText('')
    setEditingId(null)
    setFormOpen(false)
  }

  function closeKiro() {
    setKiroForm((current) => ({ ...current, apiKey: '' }))
    setKiroError('')
    setKiroEditingId(null)
    setKiroOpen(false)
  }

  async function submit() {
    const payload: ConnectionInput = {
      ...form,
      kind: 'openai-http',
      models: textToModels(modelsText),
    }
    if (!editingId && !payload.apiKey?.trim()) {
      push('API key wajib untuk connection baru', 'error')
      return
    }
    setSaving(true)
    try {
      if (editingId) {
        const updatePayload: Partial<ConnectionInput> = { ...payload }
        if (!updatePayload.apiKey?.trim()) delete updatePayload.apiKey
        await gatewayApi.updateConnection(editingId, updatePayload)
      } else {
        await gatewayApi.createConnection(payload)
      }
      closeForm()
      push(editingId ? 'Connection diperbarui' : 'Connection ditambahkan', 'success')
      await onChanged()
    } catch (error) {
      push(error instanceof Error ? error.message : 'Gagal menyimpan connection', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function submitKiro() {
    if (!kiroEditingId && !kiroForm.apiKey?.trim()) return
    setSaving(true)
    setKiroError('')
    try {
      if (kiroEditingId) {
        const updatePayload: Partial<ConnectionInput> = {
          name: kiroForm.name,
          kind: 'kiro-cli',
          region: kiroForm.region,
          enabled: kiroForm.enabled,
        }
        if (kiroForm.apiKey?.trim()) updatePayload.apiKey = kiroForm.apiKey
        await gatewayApi.updateConnection(kiroEditingId, updatePayload)
      } else {
        // Connection Kiro baru dibuat lewat jalur import bearer: gateway
        // memvalidasi key ke CodeWhisperer via HTTPS (tanpa kiro-cli), lalu
        // menyimpan profile ARN + email hasil validasi.
        await gatewayApi.importKiroApiKey({
          apiKey: kiroForm.apiKey ?? '',
          region: kiroForm.region,
          id: kiroForm.id?.trim() || undefined,
          name: kiroForm.name?.trim() || undefined,
          enabled: kiroForm.enabled,
        })
      }
      closeKiro()
      await onChanged()
      push('AWS validated · bearer credential stored', 'success')
    } catch (error) {
      setKiroError(error instanceof Error ? error.message : 'AWS validation failed')
    } finally {
      setSaving(false)
    }
  }

  async function remove(connection: GatewayConnection) {
    if (!window.confirm(`Hapus connection “${connection.name}”?`)) return
    try {
      await gatewayApi.deleteConnection(connection.id)
      push('Connection dihapus', 'success')
      await onChanged()
    } catch (error) {
      push(error instanceof Error ? error.message : 'Gagal menghapus connection', 'error')
    }
  }

  async function test(connection: GatewayConnection) {
    setTestingId(connection.id)
    try {
      const result = await gatewayApi.testConnection(connection.id)
      push(
        connection.kind === 'kiro-cli'
          ? `Discovery refreshed · ${result.models.length} model tersedia, ${result.activeModels?.length ?? connection.models.length} aktif`
          : `Connection sehat · ${result.models.length} model ditemukan`,
        'success',
      )
      if (connection.kind === 'kiro-cli') await onChanged()
      else if (result.models.length) openEdit(connection, result.models)
    } catch (error) {
      push(error instanceof Error ? error.message : 'Connection test gagal', 'error')
    } finally {
      setTestingId(null)
    }
  }

  async function setModelActive(connection: GatewayConnection, model: string, active: boolean) {
    const key = `${connection.id}/${model}`
    setBusyModel(key)
    try {
      const models = active
        ? [...new Set([...connection.models, model])]
        : connection.models.filter((candidate) => candidate !== model)
      await gatewayApi.updateConnection(connection.id, { models })
      push(active ? `Model ${model} diaktifkan` : `Model ${model} dinonaktifkan`, 'success')
      await onChanged()
    } catch (error) {
      push(error instanceof Error ? error.message : 'Gagal memperbarui model', 'error')
    } finally {
      setBusyModel(null)
    }
  }

  async function testModel(connection: GatewayConnection, model: string) {
    const key = `${connection.id}/${model}`
    setBusyModel(key)
    try {
      const result = await gatewayApi.testKiroModel(connection.id, model)
      push(`Model ${model} berhasil · ${result.output.trim() || 'tanpa output'}`, 'success')
    } catch (error) {
      push(error instanceof Error ? error.message : `Test model ${model} gagal`, 'error')
    } finally {
      setBusyModel(null)
    }
  }

  async function copyModelId(connection: GatewayConnection, model: string) {
    const fullId = `${connection.id}/${model}`
    try {
      await navigator.clipboard.writeText(fullId)
      push(`${fullId} disalin`, 'success')
    } catch {
      push('Browser tidak mengizinkan akses clipboard', 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-brand text-xl font-bold">Provider connections</h2>
          <p className="mt-1 text-xs text-ink/60">Provider credentials disimpan server-side dan tidak pernah dikirim balik ke browser.</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={openKiroCreate}>Connect Kiro</Button>
          <Button size="sm" onClick={openCreate}><PlusIcon width={15} height={15} />Tambah HTTP</Button>
        </div>
      </div>

      {error && <ErrorCard message={error} onRetry={onReload} />}
      {loading && connections.length === 0 ? (
        <StateCard message="Membaca provider connections..." />
      ) : connections.length === 0 ? (
        <Card><CardBody><EmptyText text="Belum ada connection. Tambahkan provider credential pertama lo." /></CardBody></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {connections.map((connection) => (
            <Card key={connection.id}>
              <CardHeader
                title={connection.name}
                action={<Badge color={connection.enabled ? 'ok' : 'idle'}>{connection.enabled ? 'Enabled' : 'Disabled'}</Badge>}
              />
              <CardBody className="space-y-4">
                <div>
                  <code className="text-sm font-bold">{connection.id}</code>
                  <div className="mt-1 break-all text-xs text-ink/60">
                    {connection.kind === 'kiro-cli'
                      ? `Kiro/CodeWhisperer · bearer credential · ${connection.models.length} aktif dari ${connection.availableModels?.length ?? connection.models.length} tersedia`
                      : connection.baseUrl}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge color="mustard">
                    {connection.kind === 'kiro-cli'
                      ? connection.credentialType === 'bearer' ? 'Bearer credential' : 'Kiro bearer'
                      : 'OpenAI HTTP'}
                  </Badge>
                  <Badge color="sky">{connection.models.length} model</Badge>
                  <Badge color="neutral">
                    {connection.kind === 'kiro-cli'
                      ? connection.hasApiKey ? 'bearer credential stored' : 'credential missing'
                      : connection.hasApiKey ? 'key tersimpan' : 'tanpa key'}
                  </Badge>
                  {connection.kind === 'kiro-cli' && (
                    <>
                      <Badge color="sky">{connection.region ?? 'us-east-1'}</Badge>
                      <Badge color={connection.validatedAt ? 'ok' : 'idle'}>
                        {connection.validatedAt
                          ? `AWS validated · ${fmtTime(connection.validatedAt)}`
                          : 'AWS validation pending'}
                      </Badge>
                      {connection.email && <Badge color="neutral">{connection.email}</Badge>}
                    </>
                  )}
                </div>
                {connection.kind === 'kiro-cli' && connection.profileArn && (
                  <div className="overflow-x-auto rounded-lg border-2 border-dashed border-ink/30 bg-cream p-2">
                    <span className="text-xs opacity-70">CodeWhisperer profile</span>
                    <div className="font-mono text-xs break-all">{connection.profileArn}</div>
                  </div>
                )}
                {connection.kind === 'kiro-cli' ? (
                  <div className="rounded-lg border-2 border-dashed border-ink/30 bg-cream p-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-xs font-bold uppercase tracking-wider">Available Models</span>
                      <span className="text-[10px] font-bold text-ink/50">
                        {connection.models.length} active / {(connection.availableModels ?? connection.models).length} available
                      </span>
                    </div>
                    <div className="max-h-64 space-y-2 overflow-y-auto">
                      {(connection.availableModels ?? connection.models).map((model) => {
                        const active = connection.models.includes(model)
                        const key = `${connection.id}/${model}`
                        return (
                          <div key={model} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink/20 bg-paper p-2">
                            <div className="min-w-0">
                              <code className="block truncate text-xs font-bold">{key}</code>
                              <span className={cn('text-[10px] font-bold uppercase', active ? 'text-ok' : 'text-ink/40')}>
                                {active ? 'Active' : 'Inactive'}
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyModel === key}
                                onClick={() => void testModel(connection, model)}
                              >
                                {busyModel === key ? 'Testing...' : 'Test'}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => void copyModelId(connection, model)}>
                                Copy
                              </Button>
                              <Button
                                variant={active ? 'danger' : 'secondary'}
                                size="sm"
                                disabled={busyModel === key}
                                onClick={() => void setModelActive(connection, model, !active)}
                              >
                                {active ? '× Delete' : 'Add'}
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                      {(connection.availableModels ?? connection.models).length === 0 && (
                        <p className="py-3 text-center text-xs text-ink/50">Katalog kosong. Refresh discovery untuk mencoba lagi.</p>
                      )}
                    </div>
                  </div>
                ) : connection.models.length > 0 ? (
                  <div className="max-h-24 overflow-y-auto rounded-lg border-2 border-dashed border-ink/30 bg-cream p-2 font-mono text-xs">
                    {connection.models.map((model) => <div key={model}>{connection.id}/{model}</div>)}
                  </div>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" size="sm" disabled={testingId === connection.id} onClick={() => void test(connection)}>
                    {testingId === connection.id
                      ? 'Testing...'
                      : connection.kind === 'kiro-cli' ? 'Validate against AWS' : 'Test & discover'}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => openEdit(connection)}>Edit</Button>
                  <Button variant="danger" size="sm" onClick={() => void remove(connection)}><TrashIcon width={14} height={14} />Hapus</Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {formOpen && (
        <Card>
          <CardHeader title={editingId ? `Edit ${editingId}` : 'Connection HTTP baru'} />
          <CardBody className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1 text-xs font-bold">
                <span>ID connection</span>
                <input className={fieldClass} value={form.id} disabled={Boolean(editingId)} placeholder="openrouter" onChange={(event) => setForm((current) => ({ ...current, id: event.target.value.toLowerCase() }))} />
              </label>
              <label className="space-y-1 text-xs font-bold">
                <span>Nama</span>
                <input className={fieldClass} value={form.name} placeholder="OpenRouter Personal" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
              </label>
            </div>
            <label className="block space-y-1 text-xs font-bold">
              <span>Base URL</span>
              <input className={fieldClass} value={form.baseUrl ?? ''} placeholder="https://openrouter.ai/api/v1" onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} />
            </label>
            <label className="block space-y-1 text-xs font-bold">
              <span>API key {editingId && <span className="font-normal text-ink/50">— leave blank to preserve the stored key</span>}</span>
              <input type="password" autoComplete="new-password" className={fieldClass} value={form.apiKey ?? ''} placeholder="sk-..." onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} />
            </label>
            <label className="block space-y-1 text-xs font-bold">
              <span>Model upstream — satu per baris</span>
              <textarea className={fieldClass} rows={5} value={modelsText} placeholder="gpt-4.1\ngpt-4.1-mini" onChange={(event) => setModelsText(event.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-sm font-bold">
              <input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />
              Connection aktif
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeForm}>Batal</Button>
              <Button onClick={() => void submit()} disabled={saving}>
                {saving ? 'Menyimpan...' : 'Save connection'}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {kiroOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) closeKiro()
        }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="kiro-modal-title"
            className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border-2 border-ink bg-paper shadow-hard"
          >
            <div className="border-b-2 border-ink px-4 py-3">
              <h3 id="kiro-modal-title" className="font-brand text-lg font-bold">
                {kiroEditingId ? 'Edit Kiro credential' : 'Connect Kiro'}
              </h3>
              <p className="mt-1 text-xs text-ink/60">AWS-validated bearer credential · model discovered automatically</p>
            </div>
            <div className="space-y-4 p-4 sm:p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-bold">
                  <span>ID connection</span>
                  <input className={fieldClass} value={kiroForm.id} disabled={Boolean(kiroEditingId)} placeholder="kiro-main" onChange={(event) => setKiroForm((current) => ({ ...current, id: event.target.value.toLowerCase() }))} />
                </label>
                <label className="space-y-1 text-xs font-bold">
                  <span>Name</span>
                  <input className={fieldClass} value={kiroForm.name} placeholder="Kiro Personal" onChange={(event) => setKiroForm((current) => ({ ...current, name: event.target.value }))} />
                </label>
              </div>

              <div className="space-y-1 text-xs font-bold">
                <label htmlFor="kiro-api-key">
                  API Key * {kiroEditingId && <span className="font-normal text-ink/50">— leave blank to preserve the stored key</span>}
                </label>
                <input
                  id="kiro-api-key"
                  type="password"
                  autoComplete="new-password"
                  className={fieldClass}
                  value={kiroForm.apiKey ?? ''}
                  placeholder="Paste your Kiro API key..."
                  onChange={(event) => setKiroForm((current) => ({ ...current, apiKey: event.target.value }))}
                />
                <p className="font-normal text-ink/60">
                  Generate an API key from Kiro Portal → API Keys. API-key authentication requires an eligible paid plan.{' '}
                  <a className="font-bold underline" href="https://app.kiro.dev" target="_blank" rel="noreferrer">Open Kiro Portal</a>
                </p>
              </div>

              <div className="space-y-1 text-xs font-bold">
                <label htmlFor="kiro-region">AWS Region</label>
                <select
                  id="kiro-region"
                  className={fieldClass}
                  value={kiroForm.region ?? 'us-east-1'}
                  onChange={(event) => setKiroForm((current) => ({ ...current, region: event.target.value as KiroRegion }))}
                >
                  <option value="us-east-1">us-east-1</option>
                  <option value="eu-central-1">eu-central-1</option>
                </select>
              </div>

              <div className="rounded-lg border-2 border-ink bg-sky-soft p-3 text-xs leading-relaxed">
                Paste a long-lived Kiro/CodeWhisperer API key. It is validated against AWS and stored directly as a bearer credential (no refresh).
              </div>

              <label className="flex items-center gap-2 text-sm font-bold">
                <input type="checkbox" checked={kiroForm.enabled} onChange={(event) => setKiroForm((current) => ({ ...current, enabled: event.target.checked }))} />
                Connection enabled
              </label>

              {kiroError && (
                <div role="alert" className="rounded-lg border-2 border-ink bg-danger p-3 text-sm font-semibold">
                  {kiroError}
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={closeKiro} disabled={saving}>Cancel</Button>
                <Button
                  onClick={() => void submitKiro()}
                  disabled={saving || (!kiroEditingId && !kiroForm.apiKey?.trim())}
                >
                  {saving
                    ? 'Validating against AWS...'
                    : kiroEditingId ? 'Validate & update' : 'Add API Key'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface McpDraft {
  id: string
  name: string
  transport: McpTransport
  command: string
  argsText: string
  url: string
  envText: string
  headersText: string
  enabled: boolean
  trusted: boolean
  readOnly: boolean
  clearSecrets: boolean
}

const emptyMcpDraft: McpDraft = {
  id: '',
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  url: '',
  envText: '',
  headersText: '',
  enabled: true,
  trusted: false,
  readOnly: false,
  clearSecrets: false,
}

function parseSecretLines(value: string, label: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined
  const entries: Array<[string, string]> = []
  for (const line of value.split('\n')) {
    if (!line.trim()) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`${label} harus memakai format NAMA=nilai, satu per baris.`)
    const name = line.slice(0, separator).trim()
    if (!name) throw new Error(`${label} punya nama kosong.`)
    entries.push([name, line.slice(separator + 1)])
  }
  return Object.fromEntries(entries)
}

function McpServersPanel() {
  const { push } = useToast()
  const [servers, setServers] = useState<GatewayMcpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<McpDraft>({ ...emptyMcpDraft })
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setServers(await gatewayApi.listMcpServers())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Gagal membaca MCP servers')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function openCreate() {
    setEditingId(null)
    setDraft({ ...emptyMcpDraft })
    setFormError('')
    setFormOpen(true)
  }

  function openEdit(server: GatewayMcpServer) {
    setEditingId(server.id)
    setDraft({
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command ?? '',
      argsText: (server.args ?? []).join('\n'),
      url: server.url ?? '',
      // Secret bersifat write-only; edit selalu dimulai kosong.
      envText: '',
      headersText: '',
      enabled: server.enabled,
      trusted: server.trusted,
      readOnly: server.readOnly,
      clearSecrets: false,
    })
    setFormError('')
    setFormOpen(true)
  }

  function closeForm() {
    setDraft({ ...emptyMcpDraft })
    setEditingId(null)
    setFormError('')
    setFormOpen(false)
  }

  async function submit() {
    if (!draft.id.trim() || !draft.name.trim()) {
      setFormError('ID dan nama MCP server wajib diisi.')
      return
    }
    if (draft.transport === 'stdio' && !draft.command.trim()) {
      setFormError('Command wajib untuk transport stdio.')
      return
    }
    if (draft.transport !== 'stdio' && !draft.url.trim()) {
      setFormError('URL wajib untuk transport HTTP/SSE.')
      return
    }

    let env: Record<string, string> | undefined
    let headers: Record<string, string> | undefined
    try {
      env = parseSecretLines(draft.envText, 'Environment secret')
      headers = parseSecretLines(draft.headersText, 'Header secret')
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'Format secret tidak valid.')
      return
    }

    const payload: GatewayMcpServerInput = {
      id: draft.id.trim().toLowerCase(),
      name: draft.name.trim(),
      transport: draft.transport,
      enabled: draft.enabled,
      trusted: draft.trusted,
      readOnly: draft.readOnly,
      ...(draft.transport === 'stdio'
        ? {
            command: draft.command.trim(),
            args: draft.argsText.split('\n').map((arg) => arg.trim()).filter(Boolean),
            ...(env ? { env } : {}),
          }
        : {
            url: draft.url.trim(),
            ...(headers ? { headers } : {}),
          }),
      ...(editingId && draft.clearSecrets ? { clearSecrets: true } : {}),
    }

    setSaving(true)
    setFormError('')
    try {
      if (editingId) await gatewayApi.updateMcpServer(editingId, payload)
      else await gatewayApi.createMcpServer(payload)
      closeForm()
      push(editingId ? 'MCP server diperbarui' : 'MCP server ditambahkan', 'success')
      await load()
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'Gagal menyimpan MCP server')
    } finally {
      setSaving(false)
    }
  }

  async function toggle(server: GatewayMcpServer, field: 'enabled' | 'trusted' | 'readOnly') {
    setBusyId(server.id)
    try {
      await gatewayApi.updateMcpServer(server.id, { [field]: !server[field] })
      await load()
    } catch (caught) {
      push(caught instanceof Error ? caught.message : 'Gagal memperbarui MCP server', 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(server: GatewayMcpServer) {
    if (!window.confirm(`Hapus MCP server “${server.name}”?`)) return
    setBusyId(server.id)
    try {
      await gatewayApi.deleteMcpServer(server.id)
      push('MCP server dihapus', 'success')
      await load()
    } catch (caught) {
      push(caught instanceof Error ? caught.message : 'Gagal menghapus MCP server', 'error')
    } finally {
      setBusyId(null)
    }
  }

  if (loading && servers.length === 0) return <StateCard message="Membaca MCP servers..." />
  if (error && servers.length === 0) return <ErrorCard message={error} onRetry={() => void load()} />

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-bold">MCP servers untuk agent</div>
            <p className="mt-1 text-xs text-ink/60">
              Hanya server enabled + trusted yang bisa dipilih. Env dan header secret dienkripsi server-side dan tidak pernah dirender balik.
            </p>
          </div>
          <Button onClick={openCreate}><PlusIcon width={15} height={15} />Tambah MCP</Button>
        </CardBody>
      </Card>

      {error && <ErrorCard message={error} onRetry={() => void load()} />}
      {servers.length === 0 ? (
        <Card><CardBody><EmptyText text="Belum ada MCP server. Tambahkan stdio, HTTP, atau SSE." /></CardBody></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {servers.map((server) => {
            const busy = busyId === server.id
            return (
              <Card key={server.id}>
                <CardHeader
                  title={server.name}
                  action={<Badge color={server.enabled ? 'ok' : 'idle'}>{server.enabled ? 'Enabled' : 'Disabled'}</Badge>}
                />
                <CardBody className="space-y-4">
                  <div>
                    <code className="text-sm font-bold">{server.id}</code>
                    <div className="mt-1 break-all text-xs text-ink/60">
                      {server.transport === 'stdio'
                        ? `${server.command ?? '-'} ${(server.args ?? []).join(' ')}`.trim()
                        : server.url}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge color="sky">{server.transport}</Badge>
                    <Badge color={server.trusted ? 'ok' : 'warn'}>{server.trusted ? 'Trusted' : 'Belum trusted'}</Badge>
                    <Badge color={server.readOnly ? 'sky' : 'neutral'}>{server.readOnly ? 'Read-only' : 'Write allowed'}</Badge>
                    {server.hasSecrets && <Badge color="neutral">Secret tersimpan</Badge>}
                  </div>
                  <p className="text-[10px] font-semibold text-ink/50">Diperbarui {fmtTime(server.updatedAt)}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggle(server, 'enabled')}>
                      {server.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggle(server, 'trusted')}>
                      {server.trusted ? 'Cabut trust' : 'Trust'}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggle(server, 'readOnly')}>
                      {server.readOnly ? 'Izinkan write' : 'Jadikan read-only'}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => openEdit(server)}>Edit</Button>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(server)}>
                      <TrashIcon width={14} height={14} />Hapus
                    </Button>
                  </div>
                </CardBody>
              </Card>
            )
          })}
        </div>
      )}

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) closeForm()
        }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-modal-title"
            className="max-h-[calc(100vh-2rem)] w-full max-w-2xl overflow-y-auto rounded-xl border-2 border-ink bg-paper p-5 shadow-hard"
          >
            <div className="space-y-4">
              <div>
                <h2 id="mcp-modal-title" className="font-brand text-lg font-bold">
                  {editingId ? `Edit MCP ${editingId}` : 'Tambah MCP server'}
                </h2>
                <p className="mt-1 text-xs text-ink/60">Secret baru bersifat write-only. Kosongkan untuk mempertahankan secret lama.</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-bold">
                  <span>ID server</span>
                  <input className={fieldClass} value={draft.id} disabled={Boolean(editingId)} placeholder="filesystem" onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
                </label>
                <label className="space-y-1 text-xs font-bold">
                  <span>Nama</span>
                  <input className={fieldClass} value={draft.name} placeholder="Filesystem workspace" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                </label>
              </div>

              <label className="block space-y-1 text-xs font-bold">
                <span>Transport</span>
                <select className={fieldClass} value={draft.transport} onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value as McpTransport }))}>
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                  <option value="sse">sse</option>
                </select>
              </label>

              {draft.transport === 'stdio' ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="space-y-1 text-xs font-bold">
                    <span>Command</span>
                    <input className={fieldClass} value={draft.command} placeholder="npx" onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} />
                  </label>
                  <label className="space-y-1 text-xs font-bold">
                    <span>Args — satu per baris</span>
                    <textarea className={fieldClass} rows={4} value={draft.argsText} placeholder={'-y\n@modelcontextprotocol/server-filesystem'} onChange={(event) => setDraft((current) => ({ ...current, argsText: event.target.value }))} />
                  </label>
                </div>
              ) : (
                <label className="block space-y-1 text-xs font-bold">
                  <span>URL HTTPS</span>
                  <input className={fieldClass} type="url" value={draft.url} placeholder="https://mcp.example.com" onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} />
                </label>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-bold">
                  <span>Environment secret — NAMA=nilai</span>
                  <textarea
                    className={fieldClass}
                    rows={4}
                    value={draft.envText}
                    disabled={draft.transport !== 'stdio'}
                    autoComplete="off"
                    placeholder="API_TOKEN=..."
                    onChange={(event) => setDraft((current) => ({ ...current, envText: event.target.value }))}
                  />
                </label>
                <label className="space-y-1 text-xs font-bold">
                  <span>Header secret — NAMA=nilai</span>
                  <textarea
                    className={fieldClass}
                    rows={4}
                    value={draft.headersText}
                    disabled={draft.transport === 'stdio'}
                    autoComplete="off"
                    placeholder="Authorization=Bearer ..."
                    onChange={(event) => setDraft((current) => ({ ...current, headersText: event.target.value }))}
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-4 text-sm font-bold">
                <label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />Enabled</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={draft.trusted} onChange={(event) => setDraft((current) => ({ ...current, trusted: event.target.checked }))} />Trusted</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={draft.readOnly} onChange={(event) => setDraft((current) => ({ ...current, readOnly: event.target.checked }))} />Read-only</label>
                {editingId && (
                  <label className="flex items-center gap-2 text-danger"><input type="checkbox" checked={draft.clearSecrets} onChange={(event) => setDraft((current) => ({ ...current, clearSecrets: event.target.checked }))} />Hapus secret tersimpan</label>
                )}
              </div>

              {formError && <div role="alert" className="rounded-lg border-2 border-ink bg-danger p-3 text-sm font-semibold">{formError}</div>}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={closeForm} disabled={saving}>Batal</Button>
                <Button onClick={() => void submit()} disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan MCP server'}</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const ALL_SCOPES: GatewayApiKeyScope[] = ['models:read', 'chat:write']

interface ApiKeyDraft {
  name: string
  scopes: GatewayApiKeyScope[]
  expiresAt: string
  rateCapacity: string
  rateRefillPerSec: string
}

const emptyKeyDraft: ApiKeyDraft = {
  name: '',
  scopes: [...ALL_SCOPES],
  expiresAt: '',
  rateCapacity: '',
  rateRefillPerSec: '',
}

function keyStatus(key: GatewayApiKey): { label: string; color: 'ok' | 'danger' | 'warn' } {
  if (key.revokedAt) return { label: 'revoked', color: 'danger' }
  if (key.expired) return { label: 'expired', color: 'danger' }
  if (!key.enabled) return { label: 'disabled', color: 'warn' }
  return { label: 'active', color: 'ok' }
}

/**
 * Gateway → API Keys. Key yang dibuat di sini dipakai OpenCode/client lain di
 * /v1/*. Plaintext-nya cuma muncul sekali (saat create/rotate); server hanya
 * menyimpan hash. GATEWAY_API_KEY dari env tetap jadi bootstrap/emergency key.
 */
function ApiKeysPanel() {
  const { push } = useToast()
  const [keys, setKeys] = useState<GatewayApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [draft, setDraft] = useState<ApiKeyDraft>(emptyKeyDraft)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Plaintext hasil create/rotate. Ditahan di state sampai user menutupnya.
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setKeys((await gatewayApi.listApiKeys()).keys)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Gagal membaca API keys')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function toggleScope(scope: GatewayApiKeyScope) {
    setDraft((current) => ({
      ...current,
      scopes: current.scopes.includes(scope)
        ? current.scopes.filter((item) => item !== scope)
        : [...current.scopes, scope],
    }))
  }

  async function submit() {
    if (!draft.name.trim()) {
      setFormError('Nama API key wajib diisi.')
      return
    }
    if (draft.scopes.length === 0) {
      setFormError('Pilih minimal satu scope.')
      return
    }
    const capacity = Number(draft.rateCapacity)
    const refillPerSec = Number(draft.rateRefillPerSec)
    const wantsRateLimit = draft.rateCapacity.trim() !== '' || draft.rateRefillPerSec.trim() !== ''
    if (wantsRateLimit && (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(refillPerSec) || refillPerSec <= 0)) {
      setFormError('Rate limit butuh burst dan refill berupa angka lebih dari 0.')
      return
    }

    setSaving(true)
    setFormError('')
    try {
      const created = await gatewayApi.createApiKey({
        name: draft.name.trim(),
        scopes: draft.scopes,
        expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null,
        rateLimit: wantsRateLimit ? { capacity, refillPerSec } : null,
      })
      setRevealed({ name: created.name, secret: created.secret })
      setFormOpen(false)
      setDraft({ ...emptyKeyDraft })
      await load()
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'Gagal membuat API key')
    } finally {
      setSaving(false)
    }
  }

  async function rotate(key: GatewayApiKey) {
    if (!window.confirm(`Rotate "${key.name}"? Key lama langsung berhenti bekerja.`)) return
    setBusyId(key.id)
    try {
      const rotated = await gatewayApi.rotateApiKey(key.id)
      setRevealed({ name: rotated.name, secret: rotated.secret })
      await load()
    } catch (caught) {
      push(caught instanceof Error ? caught.message : 'Gagal rotate API key', 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function setEnabled(key: GatewayApiKey, enabled: boolean) {
    setBusyId(key.id)
    try {
      await gatewayApi.updateApiKey(key.id, { enabled })
      await load()
    } catch (caught) {
      push(caught instanceof Error ? caught.message : 'Gagal memperbarui API key', 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function revoke(key: GatewayApiKey) {
    if (!window.confirm(`Revoke "${key.name}"? Client yang memakainya langsung kena 401.`)) return
    setBusyId(key.id)
    try {
      await gatewayApi.revokeApiKey(key.id)
      await load()
    } catch (caught) {
      push(caught instanceof Error ? caught.message : 'Gagal revoke API key', 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(key: GatewayApiKey) {
    if (!window.confirm(`Hapus record "${key.name}" permanen?`)) return
    setBusyId(key.id)
    try {
      await gatewayApi.deleteApiKey(key.id)
      await load()
    } catch (caught) {
      push(caught instanceof Error ? caught.message : 'Gagal menghapus API key', 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret)
      push('API key tersalin ke clipboard', 'success')
    } catch {
      push('Clipboard ditolak browser; salin manual.', 'error')
    }
  }

  if (loading && keys.length === 0) return <StateCard message="Membaca API keys..." />
  if (error && keys.length === 0) return <ErrorCard message={error} onRetry={() => void load()} />

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-bold">API keys untuk client</div>
            <div className="mt-1 text-xs text-ink/60">
              Dipakai OpenCode dan client lain sebagai <code>Authorization: Bearer</code> di {gatewayHttpBase}/v1.
              Server hanya menyimpan hash-nya, jadi plaintext cuma tampil sekali.
            </div>
          </div>
          <Button onClick={() => { setDraft({ ...emptyKeyDraft }); setFormError(''); setFormOpen(true) }}>
            <PlusIcon /> Create API Key
          </Button>
        </CardBody>
      </Card>

      {revealed && (
        <Card className="bg-mustard">
          <CardBody className="space-y-3">
            <div>
              <div className="font-bold">Simpan key ini sekarang</div>
              <div className="mt-1 text-xs">
                Plaintext untuk <strong>{revealed.name}</strong> tidak akan ditampilkan lagi. Kalau hilang, rotate keynya.
              </div>
            </div>
            <code className="block break-all rounded-lg border-2 border-ink bg-paper px-3 py-2 text-sm font-bold">
              {revealed.secret}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copySecret(revealed.secret)}>Copy</Button>
              <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>Saya sudah simpan</Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Keys" />
        {keys.length === 0 ? (
          <CardBody><EmptyText text="Belum ada API key. Bikin satu untuk tiap client." /></CardBody>
        ) : (
          <div className="divide-y-2 divide-ink">
            {keys.map((key) => {
              const status = keyStatus(key)
              const busy = busyId === key.id
              return (
                <div key={key.id} className="space-y-3 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold">{key.name}</span>
                        <Badge color={status.color}>{status.label}</Badge>
                      </div>
                      <code className="mt-1 block break-all text-xs text-ink/60">{key.maskedKey}</code>
                      <div className="mt-1 text-xs text-ink/50">
                        {key.scopes.join(' · ')}
                        {key.rateLimit && ` · limit ${key.rateLimit.capacity} burst / ${key.rateLimit.refillPerSec}/s`}
                        {key.expiresAt && ` · expires ${fmtTime(key.expiresAt)}`}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-ink/50">
                      <div className="font-bold tabular-nums text-ink">{fmtInt(key.requestCount)} req</div>
                      <div>{key.lastUsedAt ? `terakhir ${fmtTime(key.lastUsedAt)}` : 'belum dipakai'}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void rotate(key)}>
                      {busy ? 'Working...' : 'Rotate'}
                    </Button>
                    {!key.revokedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void setEnabled(key, !key.enabled)}
                      >
                        {key.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    )}
                    {!key.revokedAt && (
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void revoke(key)}>
                        Revoke
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(key)}>
                      <TrashIcon /> Delete
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="api-key-modal-title"
            className="w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border-2 border-ink bg-paper p-5 shadow-hard"
          >
            <div className="space-y-4">
              <h2 id="api-key-modal-title" className="text-lg font-bold">Create API Key</h2>

              <div>
                <label htmlFor="api-key-name" className="mb-1 block text-xs font-bold uppercase tracking-wider text-ink/60">
                  Nama
                </label>
                <input
                  id="api-key-name"
                  className={fieldClass}
                  placeholder="OpenCode Laptop"
                  value={draft.name}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </div>

              <fieldset>
                <legend className="mb-1 text-xs font-bold uppercase tracking-wider text-ink/60">Scope</legend>
                <div className="space-y-1">
                  {ALL_SCOPES.map((scope) => (
                    <label key={scope} className="flex items-center gap-2 text-sm font-bold">
                      <input
                        type="checkbox"
                        checked={draft.scopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      <code>{scope}</code>
                      <span className="text-xs font-normal text-ink/50">
                        {scope === 'models:read' ? 'baca katalog /v1/models' : 'pakai /v1/chat/completions'}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div>
                <label htmlFor="api-key-expires" className="mb-1 block text-xs font-bold uppercase tracking-wider text-ink/60">
                  Expiration date (opsional)
                </label>
                <input
                  id="api-key-expires"
                  type="date"
                  className={fieldClass}
                  value={draft.expiresAt}
                  onChange={(event) => setDraft((current) => ({ ...current, expiresAt: event.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="api-key-burst" className="mb-1 block text-xs font-bold uppercase tracking-wider text-ink/60">
                    Rate burst (opsional)
                  </label>
                  <input
                    id="api-key-burst"
                    type="number"
                    min="1"
                    className={fieldClass}
                    placeholder="60"
                    value={draft.rateCapacity}
                    onChange={(event) => setDraft((current) => ({ ...current, rateCapacity: event.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="api-key-refill" className="mb-1 block text-xs font-bold uppercase tracking-wider text-ink/60">
                    Refill / detik
                  </label>
                  <input
                    id="api-key-refill"
                    type="number"
                    min="0"
                    step="0.1"
                    className={fieldClass}
                    placeholder="1"
                    value={draft.rateRefillPerSec}
                    onChange={(event) => setDraft((current) => ({ ...current, rateRefillPerSec: event.target.value }))}
                  />
                </div>
              </div>

              <div className="rounded-lg border-2 border-ink bg-sky-soft p-3 text-xs leading-relaxed">
                Plaintext key ditampilkan sekali setelah dibuat. Server menyimpan hash saja, jadi key tidak bisa dilihat ulang — hanya di-rotate atau di-revoke.
              </div>

              {formError && (
                <div role="alert" className="rounded-lg border-2 border-ink bg-danger p-3 text-sm font-semibold">
                  {formError}
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>Cancel</Button>
                <Button onClick={() => void submit()} disabled={saving || !draft.name.trim()}>
                  {saving ? 'Creating...' : 'Create API Key'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StateCard({ message }: { message: string }) {
  return <Card><CardBody className="py-12 text-center text-sm font-semibold text-ink/60">{message}</CardBody></Card>
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="bg-danger">
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="font-bold">Gateway tidak bisa dihubungi</div><div className="mt-1 text-xs">{message}</div></div>
        <Button variant="ghost" size="sm" onClick={onRetry}>Coba lagi</Button>
      </CardBody>
    </Card>
  )
}

function EmptyText({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-ink/50">{text}</p>
}

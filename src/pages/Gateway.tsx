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
  type GatewayConnection,
  type GatewayUsageData,
  type KiroRegion,
  type UsageRange,
} from '../lib/gatewayApi'
import { fmtCompact, fmtInt, fmtTime, fmtUsd } from '../lib/format'
import { useToast } from '../lib/toast'
import { cn } from '../lib/cn'

type Tab = 'overview' | 'connections'

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'connections', label: 'Connections' },
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

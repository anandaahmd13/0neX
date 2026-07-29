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
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)

  function openCreate() {
    setEditingId(null)
    setForm({ ...emptyForm })
    setModelsText('')
    setFormOpen(true)
  }

  function openEdit(connection: GatewayConnection, discoveredModels?: string[]) {
    const models = connection.kind === 'kiro-cli' ? ['auto'] : (discoveredModels ?? connection.models)
    setEditingId(connection.id)
    setForm({
      id: connection.id,
      name: connection.name,
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      authMode: connection.kind === 'kiro-cli' ? 'api-key' : connection.authMode,
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

  function changeKind(kind: ConnectionInput['kind']) {
    setForm((current) => kind === 'kiro-cli'
      ? { ...current, kind, baseUrl: undefined, authMode: 'api-key', apiKey: '', models: ['auto'] }
      : {
          ...current,
          kind,
          baseUrl: current.baseUrl || 'https://api.openai.com/v1',
          authMode: undefined,
          apiKey: '',
          models: [],
        })
    setModelsText(kind === 'kiro-cli' ? 'auto' : '')
  }

  async function submit() {
    const payload: ConnectionInput = {
      ...form,
      models: form.kind === 'kiro-cli' ? ['auto'] : textToModels(modelsText),
      baseUrl: form.kind === 'openai-http' ? form.baseUrl : undefined,
      authMode: form.kind === 'kiro-cli' ? 'api-key' : undefined,
    }
    const requiresApiKey = payload.kind === 'openai-http' || payload.authMode === 'api-key'
    if (!editingId && requiresApiKey && !payload.apiKey) {
      push(payload.kind === 'kiro-cli' ? 'Kiro API key wajib untuk mode API key' : 'API key wajib untuk connection baru', 'error')
      return
    }
    setSaving(true)
    try {
      if (editingId) {
        const updatePayload: Partial<ConnectionInput> = { ...payload }
        if (!updatePayload.apiKey) delete updatePayload.apiKey
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
          ? 'Kiro API key valid · model Auto siap'
          : `Connection sehat · ${result.models.length} model ditemukan`,
        'success',
      )
      if (result.models.length) openEdit(connection, result.models)
    } catch (error) {
      push(error instanceof Error ? error.message : 'Connection test gagal', 'error')
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-brand text-xl font-bold">Provider connections</h2>
          <p className="mt-1 text-xs text-ink/60">API key terenkripsi di server dan tidak pernah dikirim balik ke browser.</p>
        </div>
        <Button size="sm" onClick={openCreate}><PlusIcon width={15} height={15} />Tambah</Button>
      </div>

      {error && <ErrorCard message={error} onRetry={onReload} />}
      {loading && connections.length === 0 ? (
        <StateCard message="Membaca provider connections..." />
      ) : connections.length === 0 ? (
        <Card><CardBody><EmptyText text="Belum ada connection. Tambahkan akun provider OpenAI-compatible pertama lo." /></CardBody></Card>
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
                      ? 'Kiro CLI Headless · API key · model Auto'
                      : connection.baseUrl}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge color="mustard">{connection.kind === 'kiro-cli' ? 'Kiro CLI' : 'OpenAI HTTP'}</Badge>
                  <Badge color="sky">{connection.models.length} model</Badge>
                  <Badge color="neutral">{connection.hasApiKey ? 'key tersimpan' : 'tanpa key'}</Badge>
                </div>
                {connection.models.length > 0 && (
                  <div className="max-h-24 overflow-y-auto rounded-lg border-2 border-dashed border-ink/30 bg-cream p-2 font-mono text-xs">
                    {connection.models.map((model) => <div key={model}>{connection.id}/{model}</div>)}
                  </div>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" size="sm" disabled={testingId === connection.id} onClick={() => void test(connection)}>
                    {testingId === connection.id
                      ? 'Testing...'
                      : connection.kind === 'kiro-cli' ? 'Test API key' : 'Test & discover'}
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
          <CardHeader title={editingId ? `Edit ${editingId}` : 'Connection baru'} />
          <CardBody className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1 text-xs font-bold">
                <span>Tipe connection</span>
                <select
                  className={fieldClass}
                  value={form.kind}
                  disabled={Boolean(editingId)}
                  onChange={(event) => changeKind(event.target.value as ConnectionInput['kind'])}
                >
                  <option value="openai-http">OpenAI-compatible HTTP</option>
                  <option value="kiro-cli">Kiro CLI Headless (host gateway)</option>
                </select>
              </label>
              {form.kind === 'kiro-cli' && (
                <div className="space-y-1 text-xs font-bold">
                  <span>Autentikasi Kiro</span>
                  <div className={`${fieldClass} bg-sky-soft`}>API key Kiro</div>
                </div>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1 text-xs font-bold">
                <span>ID connection</span>
                <input className={fieldClass} value={form.id} disabled={Boolean(editingId)} placeholder={form.kind === 'kiro-cli' ? 'kiro' : 'openrouter'} onChange={(event) => setForm((current) => ({ ...current, id: event.target.value.toLowerCase() }))} />
              </label>
              <label className="space-y-1 text-xs font-bold">
                <span>Nama</span>
                <input className={fieldClass} value={form.name} placeholder={form.kind === 'kiro-cli' ? 'Kiro Personal' : 'OpenRouter Personal'} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
              </label>
            </div>
            {form.kind === 'openai-http' && (
              <label className="block space-y-1 text-xs font-bold">
                <span>Base URL</span>
                <input className={fieldClass} value={form.baseUrl ?? ''} placeholder="https://openrouter.ai/api/v1" onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} />
              </label>
            )}
            <label className="block space-y-1 text-xs font-bold">
              <span>{form.kind === 'kiro-cli' ? 'Kiro API key' : 'API key'} {editingId && <span className="font-normal text-ink/50">— kosongkan untuk mempertahankan key lama</span>}</span>
              <input type="password" autoComplete="new-password" className={fieldClass} value={form.apiKey ?? ''} placeholder={form.kind === 'kiro-cli' ? 'ksk_...' : 'sk-...'} onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} />
            </label>
            {form.kind === 'kiro-cli' ? (
              <div className="space-y-1 text-xs font-bold">
                <span>Model</span>
                <div className={`${fieldClass} bg-sky-soft font-mono`}>auto</div>
                <p className="font-normal text-ink/55">Kiro headless memilih model Auto; model lain tidak bisa dipilih lewat API key.</p>
              </div>
            ) : (
              <label className="block space-y-1 text-xs font-bold">
                <span>Model upstream — satu per baris</span>
                <textarea className={fieldClass} rows={5} value={modelsText} placeholder="gpt-4.1\ngpt-4.1-mini" onChange={(event) => setModelsText(event.target.value)} />
              </label>
            )}
            <label className="flex items-center gap-2 text-sm font-bold">
              <input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />
              Connection aktif
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeForm}>Batal</Button>
              <Button onClick={() => void submit()} disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan connection'}</Button>
            </div>
          </CardBody>
        </Card>
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

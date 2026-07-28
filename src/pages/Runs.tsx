import { useEffect, useMemo, useState } from 'react'
import { Card, CardHeader, CardBody } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge, RunStatusBadge } from '../components/ui/Badge'
import { PageTitle } from '../components/PageTitle'
import { SendIcon, ClockIcon, TokenIcon, SearchIcon } from '../components/icons'
import { workflows } from '../data/mock'
import type { Run, RunStatus } from '../types'
import { fmtTime, fmtDuration, fmtInt } from '../lib/format'
import { useLogStream } from '../lib/useLogStream'
import type { StreamStatus } from '../lib/useLogStream'
import { useRuns } from '../lib/runs'
import { newRunId } from '../lib/execWorkflow'
import { cn } from '../lib/cn'

const runFilters: { key: RunStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'Semua' },
  { key: 'running', label: 'Running' },
  { key: 'success', label: 'Sukses' },
  { key: 'failed', label: 'Gagal' },
  { key: 'queued', label: 'Antri' },
]

export function Runs() {
  const { runs, addRun } = useRuns()
  const [selectedId, setSelectedId] = useState<string | null>(runs[0]?.id ?? null)
  const [task, setTask] = useState('')
  const [workflow, setWorkflow] = useState(workflows[0].name)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RunStatus | 'all'>('all')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return runs.filter((r) => {
      if (filter !== 'all' && r.status !== filter) return false
      if (!q) return true
      return (
        r.task.toLowerCase().includes(q) ||
        r.workflow.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q)
      )
    })
  }, [runs, query, filter])

  // Jaga selectedId tetap valid saat list berubah.
  useEffect(() => {
    if (selectedId && runs.some((r) => r.id === selectedId)) return
    setSelectedId(runs[0]?.id ?? null)
  }, [runs, selectedId])

  const selected = runs.find((r) => r.id === selectedId) ?? null

  function submit() {
    const trimmed = task.trim()
    if (!trimmed) return
    const now = new Date()
    const newRun: Run = {
      id: newRunId(),
      task: trimmed,
      workflow,
      status: 'queued',
      startedAt: now.toISOString(),
      durationMs: 0,
      tokensUsed: 0,
      agentsInvolved: [],
      output: '',
      logs: [
        {
          ts: now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          level: 'info',
          agent: 'Orchestrator',
          message: 'Run masuk antrian — menunggu slot',
        },
      ],
    }
    addRun(newRun)
    setSelectedId(newRun.id)
    setTask('')
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Runs" subtitle="Kirim task ke orchestrator, pantau output & log-nya." />

      {/* Task composer */}
      <Card>
        <CardHeader title="Kirim task baru" />
        <CardBody className="space-y-3">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Deskripsikan task buat agent lo… contoh: 'Riset kompetitor X dan bikin ringkasan'"
            rows={3}
            className="w-full resize-none rounded-lg border-2 border-ink bg-cream px-3 py-2 text-sm outline-none placeholder:text-ink/40 focus:bg-paper"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-ink/60">Workflow:</span>
              <select
                value={workflow}
                onChange={(e) => setWorkflow(e.target.value)}
                className="rounded-lg border-2 border-ink bg-paper px-2 py-1.5 text-sm font-semibold outline-none"
              >
                {workflows.map((w) => (
                  <option key={w.id}>{w.name}</option>
                ))}
              </select>
            </label>
            <Button variant="primary" onClick={submit} disabled={!task.trim()}>
              <SendIcon width={16} height={16} />
              Jalankan
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* Search + filter */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink/40">
            <SearchIcon width={16} height={16} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari run…"
            className="w-full rounded-lg border-2 border-ink bg-paper py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-ink/40 focus:bg-cream"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {runFilters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-lg border-2 border-ink px-2.5 py-1.5 text-xs font-semibold transition-all',
                filter === f.key
                  ? 'bg-mustard shadow-hard-sm'
                  : 'bg-paper hover:bg-sky-soft',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Split: list + detail */}
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* List */}
        <div className="space-y-3">
          {filtered.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-ink/40 bg-paper/50 p-6 text-center text-sm text-ink/50">
              {runs.length === 0
                ? 'Belum ada run. Kirim task atau jalankan workflow.'
                : 'Nggak ada run yang cocok sama filter/pencarian.'}
            </div>
          ) : (
            filtered.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={cn(
                  'w-full rounded-xl border-2 border-ink p-3 text-left transition-all',
                  r.id === selectedId
                    ? 'bg-mustard shadow-hard'
                    : 'bg-paper shadow-hard-sm hover:bg-sky-soft',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {r.task}
                  </span>
                  <RunStatusBadge status={r.status} />
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-ink/50">
                  <span className="font-mono">{r.id}</span>· {r.workflow}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail */}
        {selected ? (
          <RunDetail run={selected} />
        ) : (
          <Card className="flex items-center justify-center p-12 text-sm text-ink/50">
            Pilih run buat lihat detail & log-nya.
          </Card>
        )}
      </div>
    </div>
  )
}

const streamMeta: Record<StreamStatus, { label: string; dot: string }> = {
  live: { label: 'LIVE · WebSocket', dot: 'bg-ok' },
  simulated: { label: 'SIMULASI', dot: 'bg-mustard' },
  connecting: { label: 'MENYAMBUNG…', dot: 'bg-sky' },
  closed: { label: '', dot: '' },
}

function RunDetail({ run }: { run: Run }) {
  // Gateway menulis log aktual langsung ke Runs store. Stream mock hanya
  // dipakai oleh run workflow lama, supaya aktivitas Gateway tidak tertutup
  // log simulasi dari port 8787.
  const streaming = run.status === 'running' && run.source !== 'gateway'
  const { logs: liveLogs, status: streamStatus } = useLogStream({
    enabled: streaming,
    seed: run.logs,
    agents: run.agentsInvolved.length ? run.agentsInvolved : ['Orchestrator'],
  })

  // Run yang jalan → pakai log streamed; selain itu → log historis.
  const logs = streaming ? liveLogs : run.logs
  const meta = streamMeta[streamStatus]

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={run.id}
        action={<RunStatusBadge status={run.status} />}
      />
      <CardBody className="space-y-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-ink/40">
            Task
          </div>
          <div className="mt-1 text-sm font-semibold">{run.task}</div>
        </div>

        {/* Meta chips */}
        <div className="flex flex-wrap gap-2">
          <Badge color="sky">{run.workflow}</Badge>
          <Badge color="neutral">
            <ClockIcon width={13} height={13} />
            {run.status === 'queued' ? 'antri' : fmtDuration(run.durationMs)}
          </Badge>
          <Badge color="neutral">
            <TokenIcon width={13} height={13} />
            {fmtInt(run.tokensUsed)} tok
          </Badge>
          <Badge color="neutral">{fmtTime(run.startedAt)}</Badge>
        </div>

        {run.agentsInvolved.length > 0 && (
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink/40">
              Agent terlibat
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {run.agentsInvolved.map((a) => (
                <Badge key={a} color="mustard">
                  {a}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Logs terminal */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <div className="text-[10px] font-bold uppercase tracking-wider text-ink/40">
              Log
            </div>
            {streaming && meta.label && (
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-ink/50">
                <span
                  className={cn(
                    'inline-block h-2 w-2 rounded-full border border-ink',
                    meta.dot,
                    streamStatus !== 'closed' && 'animate-pulse',
                  )}
                />
                {meta.label}
              </div>
            )}
          </div>
          <div className="term max-h-64 overflow-y-auto rounded-lg border-2 border-ink p-3 font-mono text-xs leading-relaxed">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="term-dim shrink-0">{log.ts}</span>
                <span className="term-accent shrink-0">[{log.agent}]</span>
                <span
                  className={cn(
                    'break-words',
                    log.level === 'error'
                      ? 'term-error'
                      : log.level === 'warn'
                        ? 'term-warn'
                        : log.level === 'debug'
                          ? 'term-dim'
                          : '',
                  )}
                >
                  {log.message}
                </span>
              </div>
            ))}
            {streaming && (
              <div className="term-dim2 mt-1 flex items-center gap-2">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-ok" />
                streaming…
              </div>
            )}
          </div>
        </div>

        {/* Output */}
        {run.output && (
          <div>
            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-ink/40">
              Output
            </div>
            <div className="rounded-lg border-2 border-ink bg-sky-soft p-3 text-sm">
              {run.output}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

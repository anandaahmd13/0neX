import { useState } from 'react'
import { Card, CardHeader, CardBody } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge, RunStatusBadge } from '../components/ui/Badge'
import { PageTitle } from '../components/PageTitle'
import { SendIcon, ClockIcon, TokenIcon } from '../components/icons'
import { runs as seedRuns, workflows } from '../data/mock'
import type { Run } from '../types'
import { fmtTime, fmtDuration, fmtInt } from '../lib/format'
import { cn } from '../lib/cn'

export function Runs() {
  const [runList, setRunList] = useState<Run[]>(seedRuns)
  const [selectedId, setSelectedId] = useState(seedRuns[0].id)
  const [task, setTask] = useState('')
  const [workflow, setWorkflow] = useState(workflows[0].name)

  const selected = runList.find((r) => r.id === selectedId)!

  function submit() {
    const trimmed = task.trim()
    if (!trimmed) return
    const now = new Date()
    const newRun: Run = {
      id: 'run_' + Math.random().toString(16).slice(2, 6),
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
    setRunList([newRun, ...runList])
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

      {/* Split: list + detail */}
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* List */}
        <div className="space-y-3">
          {runList.map((r) => (
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
          ))}
        </div>

        {/* Detail */}
        <RunDetail run={selected} />
      </div>
    </div>
  )
}

function RunDetail({ run }: { run: Run }) {
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
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-ink/40">
            Log
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border-2 border-ink bg-ink p-3 font-mono text-xs leading-relaxed text-cream">
            {run.logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-cream/40">{log.ts}</span>
                <span className="shrink-0 text-sky">[{log.agent}]</span>
                <span
                  className={cn(
                    'break-words',
                    log.level === 'error'
                      ? 'text-danger'
                      : log.level === 'warn'
                        ? 'text-mustard'
                        : log.level === 'debug'
                          ? 'text-cream/50'
                          : 'text-cream',
                  )}
                >
                  {log.message}
                </span>
              </div>
            ))}
            {run.status === 'running' && (
              <div className="mt-1 flex items-center gap-2 text-cream/60">
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

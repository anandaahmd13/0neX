import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge, AgentStatusBadge } from '../components/ui/Badge'
import { PageTitle } from '../components/PageTitle'
import {
  PlusIcon,
  TokenIcon,
  PulseIcon,
  ClockIcon,
  CheckIcon,
  SearchIcon,
} from '../components/icons'
import { agents } from '../data/mock'
import type { Agent, AgentStatus } from '../types'
import { fmtCompact, fmtInt } from '../lib/format'
import { useToast } from '../lib/toast'
import { cn } from '../lib/cn'

const filters: { key: AgentStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'Semua' },
  { key: 'active', label: 'Aktif' },
  { key: 'idle', label: 'Idle' },
  { key: 'paused', label: 'Paused' },
  { key: 'error', label: 'Error' },
]

export function Agents() {
  const { push } = useToast()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<AgentStatus | 'all'>('all')
  const [query, setQuery] = useState('')

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return agents.filter((a) => {
      if (filter !== 'all' && a.status !== filter) return false
      if (!q) return true
      return (
        a.name.toLowerCase().includes(q) ||
        a.role.toLowerCase().includes(q) ||
        a.model.toLowerCase().includes(q) ||
        a.tools.some((t) => t.toLowerCase().includes(q))
      )
    })
  }, [filter, query])

  return (
    <div className="space-y-6">
      <PageTitle
        title="Agents"
        subtitle={`${agents.length} agent terdaftar di orchestrator lo.`}
        action={
          <Button
            variant="primary"
            onClick={() => push('Bikin agent baru belum tersedia di demo', 'info')}
          >
            <PlusIcon width={16} height={16} />
            Agent baru
          </Button>
        }
      />

      {/* Search + filter */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink/40">
            <SearchIcon width={16} height={16} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari agent, role, model, tool…"
            className="w-full rounded-lg border-2 border-ink bg-paper py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-ink/40 focus:bg-cream"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-lg border-2 border-ink px-3 py-1.5 text-sm font-semibold transition-all',
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

      {/* Grid / empty state */}
      {list.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-ink/40 bg-paper/50 p-12 text-center">
          <div className="font-brand text-2xl font-bold text-ink/40">
            Nggak ada agent
          </div>
          <p className="mt-1 text-sm text-ink/50">
            Coba ganti filter atau kata kunci pencarian.
          </p>
          {(query || filter !== 'all') && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-4"
              onClick={() => {
                setQuery('')
                setFilter('all')
              }}
            >
              Reset filter
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              onRun={() => navigate(`/playground?agent=${a.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function AgentCard({ agent, onRun }: { agent: Agent; onRun: () => void }) {
  return (
    <Card hover className="flex flex-col">
      <div className="flex items-start justify-between border-b-2 border-ink p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg border-2 border-ink bg-sky-soft shadow-hard-sm">
            <span className="font-brand text-base font-bold">
              {agent.name.charAt(0)}
            </span>
          </div>
          <div>
            <div className="font-brand text-lg font-bold leading-tight">
              {agent.name}
            </div>
            <div className="text-xs text-ink/50">{agent.role}</div>
          </div>
        </div>
        <AgentStatusBadge status={agent.status} />
      </div>

      <div className="flex flex-1 flex-col p-4">
        <p className="text-sm text-ink/70">{agent.description}</p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge color="sky">{agent.model || 'Auto'}</Badge>
          <Badge color="mustard">{agent.providerId}</Badge>
          <Badge color="neutral">tools: {agent.toolPolicy}</Badge>
          {agent.tools.slice(0, 3).map((t) => (
            <Badge key={t} color="neutral">
              {t}
            </Badge>
          ))}
          {agent.tools.length > 3 && (
            <Badge color="neutral">+{agent.tools.length - 3}</Badge>
          )}
        </div>

        {/* Metrics */}
        <div className="mt-4 grid grid-cols-2 gap-2 border-t-2 border-dashed border-ink/30 pt-4">
          <Metric icon={<TokenIcon width={15} height={15} />} label="Token" value={fmtCompact(agent.tokensUsed)} />
          <Metric icon={<PulseIcon width={15} height={15} />} label="Request" value={fmtInt(agent.requests)} />
          <Metric icon={<CheckIcon width={15} height={15} />} label="Success" value={`${agent.successRate}%`} />
          <Metric icon={<ClockIcon width={15} height={15} />} label="Latency" value={`${(agent.avgLatencyMs / 1000).toFixed(1)}s`} />
        </div>

        <div className="mt-auto flex gap-2 pt-4">
          <Button variant="secondary" size="sm" className="flex-1" onClick={onRun}>
            Jalankan
          </Button>
          <Button variant="ghost" size="sm" className="flex-1">
            Konfigurasi
          </Button>
        </div>
      </div>
    </Card>
  )
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-ink/50">{icon}</span>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-ink/40">{label}</div>
        <div className="text-sm font-bold tabular-nums">{value}</div>
      </div>
    </div>
  )
}

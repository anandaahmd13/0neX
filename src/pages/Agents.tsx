import { useState } from 'react'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge, AgentStatusBadge } from '../components/ui/Badge'
import { PageTitle } from '../components/PageTitle'
import { PlusIcon, TokenIcon, PulseIcon, ClockIcon, CheckIcon } from '../components/icons'
import { agents } from '../data/mock'
import type { Agent, AgentStatus } from '../types'
import { fmtCompact, fmtInt } from '../lib/format'
import { cn } from '../lib/cn'

const filters: { key: AgentStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'Semua' },
  { key: 'active', label: 'Aktif' },
  { key: 'idle', label: 'Idle' },
  { key: 'paused', label: 'Paused' },
  { key: 'error', label: 'Error' },
]

export function Agents() {
  const [filter, setFilter] = useState<AgentStatus | 'all'>('all')
  const list = agents.filter((a) => filter === 'all' || a.status === filter)

  return (
    <div className="space-y-6">
      <PageTitle
        title="Agents"
        subtitle={`${agents.length} agent terdaftar di orchestrator lo.`}
        action={
          <Button variant="primary">
            <PlusIcon width={16} height={16} />
            Agent baru
          </Button>
        }
      />

      {/* Filter pills */}
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

      {/* Grid */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.map((a) => (
          <AgentCard key={a.id} agent={a} />
        ))}
      </div>
    </div>
  )
}

function AgentCard({ agent }: { agent: Agent }) {
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
          <Badge color="sky">{agent.model}</Badge>
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
          <Button variant="secondary" size="sm" className="flex-1">
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

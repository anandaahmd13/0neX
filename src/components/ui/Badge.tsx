import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import type { AgentStatus, RunStatus } from '../../types'

const tone: Record<string, string> = {
  ok: 'bg-ok',
  warn: 'bg-mustard',
  danger: 'bg-danger',
  idle: 'bg-idle',
  sky: 'bg-sky',
  neutral: 'bg-paper',
}

export function Badge({
  children,
  color = 'neutral',
  className,
}: {
  children: ReactNode
  color?: keyof typeof tone
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border-2 border-ink px-2 py-0.5 text-xs font-semibold',
        tone[color],
        className,
      )}
    >
      {children}
    </span>
  )
}

const agentStatusMap: Record<AgentStatus, { color: keyof typeof tone; label: string }> = {
  active: { color: 'ok', label: 'Aktif' },
  idle: { color: 'idle', label: 'Idle' },
  error: { color: 'danger', label: 'Error' },
  paused: { color: 'warn', label: 'Paused' },
}

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const { color, label } = agentStatusMap[status]
  return (
    <Badge color={color}>
      <span className="inline-block h-2 w-2 rounded-full border border-ink bg-ink/70" />
      {label}
    </Badge>
  )
}

const runStatusMap: Record<RunStatus, { color: keyof typeof tone; label: string }> = {
  running: { color: 'sky', label: 'Running' },
  success: { color: 'ok', label: 'Sukses' },
  failed: { color: 'danger', label: 'Gagal' },
  queued: { color: 'idle', label: 'Antri' },
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const { color, label } = runStatusMap[status]
  return <Badge color={color}>{label}</Badge>
}

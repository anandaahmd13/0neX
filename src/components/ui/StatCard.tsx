import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

interface StatCardProps {
  label: string
  value: string
  hint?: string
  icon?: ReactNode
  /** top accent bar color */
  accent?: 'mustard' | 'sky' | 'ok' | 'danger'
}

const accents = {
  mustard: 'bg-mustard',
  sky: 'bg-sky',
  ok: 'bg-ok',
  danger: 'bg-danger',
}

export function StatCard({ label, value, hint, icon, accent = 'mustard' }: StatCardProps) {
  return (
    <div className="overflow-hidden rounded-xl border-2 border-ink bg-paper shadow-hard">
      <div className={cn('h-2 border-b-2 border-ink', accents[accent])} />
      <div className="p-4">
        <div className="flex items-start justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-ink/60">
            {label}
          </span>
          {icon && <span className="text-ink/70">{icon}</span>}
        </div>
        <div className="mt-2 text-3xl font-bold tabular-nums">{value}</div>
        {hint && <div className="mt-1 text-xs text-ink/50">{hint}</div>}
      </div>
    </div>
  )
}

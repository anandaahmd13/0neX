import type { ReactNode } from 'react'

export function PageTitle({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-brand text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-ink/60">{subtitle}</p>
      </div>
      {action}
    </div>
  )
}

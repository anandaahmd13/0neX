import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  hover?: boolean
}

export function Card({ children, hover, className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border-2 border-ink bg-paper shadow-hard',
        hover && 'press cursor-pointer',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  action,
}: {
  title: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between border-b-2 border-ink px-4 py-3">
      <h3 className="text-xs font-bold uppercase tracking-wider">{title}</h3>
      {action}
    </div>
  )
}

export function CardBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={cn('p-4', className)}>{children}</div>
}

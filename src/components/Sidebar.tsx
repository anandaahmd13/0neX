import { NavLink } from 'react-router-dom'
import { cn } from '../lib/cn'
import {
  DashboardIcon,
  AgentsIcon,
  WorkflowIcon,
  RunsIcon,
  CloseIcon,
} from './icons'

const nav = [
  { to: '/', label: 'Dashboard', icon: DashboardIcon, end: true },
  { to: '/agents', label: 'Agents', icon: AgentsIcon, end: false },
  { to: '/workflows', label: 'Workflows', icon: WorkflowIcon, end: false },
  { to: '/runs', label: 'Runs', icon: RunsIcon, end: false },
]

export function Sidebar({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return (
    <>
      {/* Mobile scrim */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-ink/30 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          'fixed z-40 flex h-full w-64 flex-col border-r-2 border-ink bg-cream transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Brand */}
        <div className="flex items-center justify-between border-b-2 border-ink px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border-2 border-ink bg-mustard shadow-hard-sm">
              <span className="font-brand text-sm font-bold">0X</span>
            </div>
            <span className="font-brand text-xl font-bold tracking-tight">0neX</span>
          </div>
          <button
            className="rounded-md border-2 border-ink bg-paper p-1 lg:hidden"
            onClick={onClose}
            aria-label="Tutup menu"
          >
            <CloseIcon width={16} height={16} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-1.5 p-3">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg border-2 px-3 py-2.5 text-sm font-semibold transition-all',
                  isActive
                    ? 'border-ink bg-mustard shadow-hard-sm'
                    : 'border-transparent hover:border-ink hover:bg-paper',
                )
              }
            >
              <Icon width={18} height={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Footer status */}
        <div className="border-t-2 border-ink p-3">
          <div className="rounded-lg border-2 border-ink bg-sky-soft p-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-ink bg-ok" />
              </span>
              Orchestrator online
            </div>
            <p className="mt-1 text-[11px] text-ink/60">4 agent aktif · 2 run jalan</p>
          </div>
        </div>
      </aside>
    </>
  )
}

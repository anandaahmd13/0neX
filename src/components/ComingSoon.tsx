import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { LockIcon } from './icons'
import { Button } from './ui/Button'

/** Fitur yang masih dikunci. Hapus path-nya di sini kalau fiturnya udah siap rilis. */
const LOCKED = new Set(['/agents', '/workflows', '/runs', '/playground'])

/** Blur + kunci seluruh shell (sidebar, topbar, konten) pada route yang belum rilis. */
export function ComingSoon({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  if (!LOCKED.has(pathname)) return <>{children}</>

  return (
    <>
      {/* inert: shell-nya ikut keblur, jadi interaksinya dimatikan sekalian biar nggak bisa di-tab. */}
      <div inert className="pointer-events-none select-none blur-[6px] saturate-50">
        {children}
      </div>

      <div className="fixed inset-0 z-50 flex items-center justify-center bg-cream/50 p-4">
        <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-ink bg-paper px-8 py-7 text-center shadow-hard">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg border-2 border-ink bg-mustard shadow-hard-sm">
            <LockIcon width={22} height={22} />
          </div>
          <div>
            <div className="font-brand text-xl font-bold tracking-tight">Feature is coming soon</div>
            <p className="mt-1 text-sm text-ink/60">Fitur ini masih dikunci. Nantikan update berikutnya.</p>
          </div>
          {/* Sidebar ikut inert, jadi sediakan jalan keluar di sini. */}
          <Link to="/">
            <Button variant="primary" size="sm">Balik ke Dashboard</Button>
          </Link>
        </div>
      </div>
    </>
  )
}

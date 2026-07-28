import { useState } from 'react'
import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { Button } from './ui/Button'
import { MenuIcon, GitIcon, SunIcon, MoonIcon } from './icons'
import { useTheme } from '../lib/theme'

const PROMO =
  '0neX — AI Helper · orkestrasi banyak AI agent dalam satu tempat · bikin, jalanin & pantau workflow agent lo 🚀'

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const { theme, toggle } = useTheme()

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Promo marquee bar (tukeria signature) */}
      <div className="overflow-hidden border-b-2 border-ink bg-mustard">
        <div className="flex whitespace-nowrap py-1.5 text-sm font-medium">
          <Marquee text={PROMO} />
          <Marquee text={PROMO} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <Sidebar open={open} onClose={() => setOpen(false)} />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className="flex items-center justify-between border-b-2 border-ink bg-cream px-4 py-3 lg:px-6">
            <div className="flex items-center gap-3">
              <button
                className="rounded-md border-2 border-ink bg-paper p-1.5 shadow-hard-sm lg:hidden"
                onClick={() => setOpen(true)}
                aria-label="Buka menu"
              >
                <MenuIcon width={18} height={18} />
              </button>
              <div className="hidden items-center gap-2 sm:flex">
                <span className="rounded-md border-2 border-ink bg-sky-soft px-2 py-0.5 text-xs font-semibold">
                  v0.3
                </span>
                <span className="text-sm text-ink/60">
                  Personal AI Gateway
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={toggle}
                aria-label={theme === 'dark' ? 'Mode terang' : 'Mode gelap'}
                title={theme === 'dark' ? 'Mode terang' : 'Mode gelap'}
                className="press flex h-8 w-8 items-center justify-center rounded-lg border-2 border-ink bg-paper shadow-hard-sm"
              >
                {theme === 'dark' ? (
                  <SunIcon width={16} height={16} />
                ) : (
                  <MoonIcon width={16} height={16} />
                )}
              </button>
              <Button variant="ghost" size="sm">
                <GitIcon width={16} height={16} />
                <span className="hidden sm:inline">Docs</span>
              </Button>
              <Button variant="secondary" size="sm">
                Cek key
              </Button>
              <Button variant="primary" size="sm">
                + Agent baru
              </Button>
            </div>
          </header>

          {/* Page content */}
          <main className="min-h-0 flex-1 overflow-y-auto bg-cream bg-grid p-4 lg:p-6">
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        </div>
      </div>
    </div>
  )
}

function Marquee({ text }: { text: string }) {
  return (
    <span className="animate-[marquee_22s_linear_infinite] px-4">{text}</span>
  )
}

import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { LockIcon } from '../components/icons'
import { useAuth } from '../lib/auth'

interface LocationState {
  from?: { pathname: string }
}

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as LocationState)?.from?.pathname ?? '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email, password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login gagal')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-cream bg-grid p-4">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-ink bg-mustard shadow-hard">
            <span className="font-brand text-lg font-bold">0X</span>
          </div>
          <span className="font-brand text-3xl font-bold tracking-tight">
            0neX
          </span>
        </div>

        <div className="rounded-2xl border-2 border-ink bg-paper p-6 shadow-hard-lg">
          <div className="mb-1 flex items-center gap-2">
            <LockIcon width={18} height={18} />
            <h1 className="font-brand text-xl font-bold">Masuk</h1>
          </div>
          <p className="mb-5 text-sm text-ink/60">
            Login buat akses orchestrator lo.
          </p>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="mb-1 block text-xs font-bold uppercase tracking-wider text-ink/60"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@0nex.dev"
                required
                className="w-full rounded-lg border-2 border-ink bg-cream px-3 py-2.5 text-sm outline-none placeholder:text-ink/40 focus:bg-paper"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1 block text-xs font-bold uppercase tracking-wider text-ink/60"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full rounded-lg border-2 border-ink bg-cream px-3 py-2.5 text-sm outline-none placeholder:text-ink/40 focus:bg-paper"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-lg border-2 border-ink bg-danger px-3 py-2 text-sm font-semibold text-ink"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={submitting}
            >
              {submitting ? 'Masuk…' : 'Masuk'}
            </Button>
          </form>

          <div className="mt-5 rounded-lg border-2 border-dashed border-ink/40 bg-sky-soft p-3 text-xs text-ink/70">
            Password diverifikasi di server gateway (cookie sesi httpOnly). Default
            memakai <span className="font-mono">GATEWAY_DASHBOARD_PASSWORD</span>.
          </div>
        </div>

        <p className="mt-4 text-center text-[11px] text-ink/40">
          Sesi divalidasi server — tidak ada token admin di browser.
        </p>
      </div>
    </div>
  )
}

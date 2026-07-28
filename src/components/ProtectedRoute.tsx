import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth'

/**
 * Bungkus route yang butuh login. Kalau belum auth → redirect ke /login
 * sambil bawa lokasi asal biar bisa balik ke sana setelah login.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-cream bg-grid">
        <div className="rounded-lg border-2 border-ink bg-paper px-4 py-2 text-sm font-semibold shadow-hard-sm">
          Memuat…
        </div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}

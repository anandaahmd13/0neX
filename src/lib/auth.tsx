import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { gatewayApi } from './gatewayApi'

/*
  Auth dashboard didukung server: login menukar password dengan cookie sesi
  httpOnly yang diterbitkan gateway (HMAC, tidak bisa dibaca/ditempa dari JS).
  Tidak ada token admin di bundle browser, dan status sesi diverifikasi ke server.
*/

export interface User {
  name: string
}

interface AuthCtx {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Cek sesi ke server saat mount (cookie httpOnly tidak terbaca dari JS).
  useEffect(() => {
    let active = true
    gatewayApi
      .session()
      .then((result) => {
        if (active && result.authenticated) setUser({ name: 'Admin' })
      })
      .catch(() => {
        // gateway belum jalan / belum login — biarkan sebagai unauthenticated
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const login = useCallback(async (_email: string, password: string) => {
    await gatewayApi.login(password)
    setUser({ name: 'Admin' })
  }, [])

  const logout = useCallback(() => {
    gatewayApi.logout().catch(() => {})
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthCtx {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth harus dipakai di dalam AuthProvider')
  return ctx
}

// Password dashboard default = GATEWAY_DASHBOARD_PASSWORD (fallback: admin token).
// Tidak ada kredensial rahasia yang di-hardcode di sini lagi.
export const DEMO_CREDS = { email: 'admin@0nex.dev', password: '' }

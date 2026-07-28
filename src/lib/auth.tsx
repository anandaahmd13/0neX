import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import type { ReactNode } from 'react'

/*
  ⚠️ DEMO AUTH — client-side only.
  Ini BUKAN security beneran: kredensial dicek di browser dan "session"
  cuma flag di localStorage. Nggak ada backend, token server, atau proteksi
  data apa pun. Buat produksi, autentikasi HARUS divalidasi di server
  (session cookie httpOnly / JWT yang diverifikasi backend). Ini murni
  buat gating UI di demo.
*/

export interface User {
  email: string
  name: string
}

interface AuthCtx {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

const STORAGE_KEY = '0nex.auth'

// Kredensial demo — sengaja di-hardcode buat showcase, bukan rahasia.
const DEMO_EMAIL = 'admin@0nex.dev'
const DEMO_PASSWORD = 'orchestrate'

const AuthContext = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Restore session dari localStorage saat mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (raw) setUser(JSON.parse(raw) as User)
    } catch {
      // abaikan payload rusak
    }
    setLoading(false)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    // Simulasi latensi jaringan biar UX-nya kerasa nyata.
    await new Promise((r) => setTimeout(r, 450))
    const normalized = email.trim().toLowerCase()
    if (normalized !== DEMO_EMAIL || password !== DEMO_PASSWORD) {
      throw new Error('Email atau password salah')
    }
    const u: User = { email: normalized, name: 'Admin' }
    setUser(u)
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(u))
    } catch {
      // abaikan
    }
  }, [])

  const logout = useCallback(() => {
    setUser(null)
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // abaikan
    }
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

export const DEMO_CREDS = { email: DEMO_EMAIL, password: DEMO_PASSWORD }

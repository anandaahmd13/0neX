import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * useState yang otomatis di-persist ke localStorage.
 * Aman buat SSR/no-window dan JSON parse yang gagal (fallback ke initial).
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  const [state, setState] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    try {
      const raw = window.localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  // Simpan snapshot key agar reset bisa hapus entri yang benar.
  const keyRef = useRef(key)
  keyRef.current = key

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state))
    } catch {
      // storage penuh / diblokir — abaikan, state tetap in-memory.
    }
  }, [key, state])

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(keyRef.current)
    } catch {
      // abaikan
    }
    setState(initial)
    // initial sengaja tidak masuk deps: dianggap stabil per-mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return [state, setState, reset]
}

import { useCallback, useState } from 'react'

// Satu "pane" = satu percakapan Claude yang berdiri sendiri. sessionId-nya
// stabil dan di-persist, jadi konteks bisa dilanjutin lintas reload (bridge
// nyambungin lewat `--resume <sessionId>`). transcript = riwayat output yang
// dirender di pane; turns = jumlah giliran yang udah kelar (nentuin run
// berikutnya create atau resume).
export interface Pane {
  id: string
  sessionId: string
  title: string
  transcript: string[]
  turns: number
  createdAt: number
}

const KEY = 'onex.claude.panes'
// Batas pane biar UI + resource kebendung. Bridge juga batasin koneksi
// concurrent (MAX_CLIENTS), tapi socket ditutup tiap run kelar jadi ini murni
// batas UX.
export const MAX_PANES = 4
// Cap baris transcript per pane biar localStorage nggak tumbuh tanpa batas.
const MAX_LINES = 2000

function load(): Pane[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Saring bentuk minimal — data lama/korup nggak boleh bikin crash.
    return (parsed as Pane[]).filter(
      (p) => p && typeof p.id === 'string' && typeof p.sessionId === 'string',
    )
  } catch {
    return []
  }
}

function save(panes: Pane[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(panes))
  } catch {
    // localStorage penuh / disabled — persist best-effort, abaikan.
  }
}

function makePane(): Pane {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    title: 'Sesi baru',
    transcript: [],
    turns: 0,
    createdAt: Date.now(),
  }
}

/**
 * Kelola daftar pane yang persisted di localStorage. Tiap operasi nulis balik
 * ke storage biar reload mulus (pane + sessionId + transcript tetap ada).
 */
export function usePanes() {
  const [panes, setPanes] = useState<Pane[]>(load)

  // Simpen + kembaliin array baru (dipakai di dalam setPanes updater).
  const persist = useCallback((next: Pane[]) => {
    save(next)
    return next
  }, [])

  const addPane = useCallback(() => {
    setPanes((prev) =>
      prev.length >= MAX_PANES ? prev : persist([...prev, makePane()]),
    )
  }, [persist])

  const removePane = useCallback(
    (id: string) => {
      setPanes((prev) => persist(prev.filter((p) => p.id !== id)))
    },
    [persist],
  )

  const appendOutput = useCallback(
    (id: string, lines: string[]) => {
      if (lines.length === 0) return
      setPanes((prev) =>
        persist(
          prev.map((p) =>
            p.id === id
              ? { ...p, transcript: [...p.transcript, ...lines].slice(-MAX_LINES) }
              : p,
          ),
        ),
      )
    },
    [persist],
  )

  const bumpTurn = useCallback(
    (id: string) => {
      setPanes((prev) =>
        persist(prev.map((p) => (p.id === id ? { ...p, turns: p.turns + 1 } : p))),
      )
    },
    [persist],
  )

  const setTitle = useCallback(
    (id: string, title: string) => {
      setPanes((prev) =>
        persist(prev.map((p) => (p.id === id ? { ...p, title } : p))),
      )
    },
    [persist],
  )

  // Reset pane jadi percakapan baru: sessionId baru + transcript kosong. Slot
  // pane-nya tetap (nggak nutup), cuma konteksnya yang di-mulai dari nol.
  const resetPane = useCallback(
    (id: string) => {
      setPanes((prev) =>
        persist(
          prev.map((p) =>
            p.id === id
              ? {
                  ...p,
                  sessionId: crypto.randomUUID(),
                  transcript: [],
                  turns: 0,
                  title: 'Sesi baru',
                }
              : p,
          ),
        ),
      )
    },
    [persist],
  )

  return {
    panes,
    addPane,
    removePane,
    appendOutput,
    bumpTurn,
    setTitle,
    resetPane,
  }
}

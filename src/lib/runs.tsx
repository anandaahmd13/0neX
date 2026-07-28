import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { runs as seedRuns } from '../data/mock'
import type { LogEntry, Run } from '../types'

/*
  Store run bersama — dipakai halaman Runs (buat nampilin) dan Workflows
  (buat mendorong run hasil eksekusi). Persist ke localStorage biar run
  bertahan antar-reload dan lintas halaman.
*/

const STORAGE_KEY = '0nex.runs'

interface RunsCtx {
  runs: Run[]
  addRun: (run: Run) => void
  updateRun: (id: string, fn: (r: Run) => Run) => void
  appendLog: (id: string, entry: LogEntry) => void
  reset: () => void
}

const RunsContext = createContext<RunsCtx | null>(null)

function loadInitial(): Run[] {
  if (typeof window === 'undefined') return seedRuns
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Run[]
      return parsed.map((run) => {
        if (run.source !== 'gateway' || run.status !== 'running') return run
        return {
          ...run,
          status: 'failed',
          output: run.output || 'Gateway run terputus saat aplikasi ditutup atau dimuat ulang.',
          logs: [
            ...run.logs,
            {
              ts: new Date().toLocaleTimeString('id-ID', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }),
              level: 'warn',
              agent: 'Gateway',
              message: 'Run direkonsiliasi sebagai gagal setelah aplikasi dimuat ulang',
            },
          ],
        }
      })
    }
  } catch {
    // abaikan payload rusak
  }
  return seedRuns
}

export function RunsProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<Run[]>(loadInitial)

  // Persist tiap perubahan (debounce ringan lewat microtask cukup).
  const runsRef = useRef(runs)
  runsRef.current = runs
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(runs))
    } catch {
      // storage penuh / diblokir — abaikan
    }
  }, [runs])

  const addRun = useCallback((run: Run) => {
    setRuns((prev) => [run, ...prev])
  }, [])

  const updateRun = useCallback((id: string, fn: (r: Run) => Run) => {
    setRuns((prev) => prev.map((r) => (r.id === id ? fn(r) : r)))
  }, [])

  const appendLog = useCallback((id: string, entry: LogEntry) => {
    setRuns((prev) =>
      prev.map((r) => (r.id === id ? { ...r, logs: [...r.logs, entry] } : r)),
    )
  }, [])

  const reset = useCallback(() => {
    setRuns(seedRuns)
  }, [])

  return (
    <RunsContext.Provider
      value={{ runs, addRun, updateRun, appendLog, reset }}
    >
      {children}
    </RunsContext.Provider>
  )
}

export function useRuns(): RunsCtx {
  const ctx = useContext(RunsContext)
  if (!ctx) throw new Error('useRuns harus dipakai di dalam RunsProvider')
  return ctx
}

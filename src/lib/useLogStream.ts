import { useEffect, useRef, useState } from 'react'
import type { LogEntry } from '../types'

export type StreamStatus = 'connecting' | 'live' | 'simulated' | 'closed'

interface Options {
  /** Aktifkan streaming. Set false buat run yang udah selesai. */
  enabled: boolean
  /** Seed log awal (log historis run). */
  seed?: LogEntry[]
  /** Nama agent buat baris simulasi. */
  agents?: string[]
}

// URL WS server. Override lewat VITE_WS_URL saat build/dev.
const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ?? 'ws://localhost:8787'

// Berapa lama nunggu koneksi WS sebelum jatuh ke mode simulasi.
const CONNECT_TIMEOUT_MS = 1500

const SIM_MESSAGES: Array<Pick<LogEntry, 'level' | 'message'>> = [
  { level: 'info', message: 'Memanggil tool: web_search' },
  { level: 'debug', message: 'Menerima 8 hasil, memfilter relevansi' },
  { level: 'info', message: 'Menyusun konteks dari sumber teratas' },
  { level: 'info', message: 'Memanggil model — menunggu completion' },
  { level: 'debug', message: 'Token streamed: 1.2k / batch' },
  { level: 'warn', message: 'Rate limit mendekati ambang, throttling' },
  { level: 'info', message: 'Menyimpan artefak sementara ke cache' },
  { level: 'info', message: 'Validasi output terhadap schema' },
]

function nowTs(): string {
  return new Date().toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * Streaming log real-time.
 * - Coba konek ke WS server (status 'live').
 * - Kalau gagal / timeout, fallback ke simulasi lokal (status 'simulated')
 *   biar demo statis (tanpa backend) tetap kelihatan hidup.
 */
export function useLogStream({ enabled, seed = [], agents = ['Agent'] }: Options) {
  const [logs, setLogs] = useState<LogEntry[]>(seed)
  const [status, setStatus] = useState<StreamStatus>('closed')
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  useEffect(() => {
    if (!enabled) {
      setStatus('closed')
      return
    }

    setLogs(seed)
    setStatus('connecting')

    let ws: WebSocket | null = null
    let simTimer: ReturnType<typeof setInterval> | null = null
    let connectTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    const pickAgent = () =>
      agentsRef.current[
        Math.floor(Math.random() * agentsRef.current.length)
      ] ?? 'Agent'

    function startSimulation() {
      if (disposed || simTimer) return
      setStatus('simulated')
      let i = 0
      simTimer = setInterval(() => {
        const base = SIM_MESSAGES[i % SIM_MESSAGES.length]
        i++
        setLogs((prev) => [
          ...prev,
          { ts: nowTs(), agent: pickAgent(), ...base },
        ])
      }, 1400)
    }

    try {
      ws = new WebSocket(WS_URL)

      connectTimer = setTimeout(() => {
        // Belum kebuka dalam batas waktu → pakai simulasi.
        if (ws && ws.readyState !== WebSocket.OPEN) {
          try {
            ws.close()
          } catch {
            // abaikan
          }
          startSimulation()
        }
      }, CONNECT_TIMEOUT_MS)

      ws.onopen = () => {
        if (connectTimer) clearTimeout(connectTimer)
        if (disposed) return
        setStatus('live')
      }

      ws.onmessage = (ev) => {
        try {
          const entry = JSON.parse(ev.data) as LogEntry
          setLogs((prev) => [...prev, entry])
        } catch {
          // baris non-JSON → bungkus sebagai info
          setLogs((prev) => [
            ...prev,
            { ts: nowTs(), level: 'info', agent: pickAgent(), message: String(ev.data) },
          ])
        }
      }

      ws.onerror = () => {
        if (connectTimer) clearTimeout(connectTimer)
        startSimulation()
      }

      ws.onclose = () => {
        if (disposed) return
        // Kalau nutup padahal belum sempat live, fallback ke simulasi.
        if (!simTimer) startSimulation()
      }
    } catch {
      startSimulation()
    }

    return () => {
      disposed = true
      if (connectTimer) clearTimeout(connectTimer)
      if (simTimer) clearInterval(simTimer)
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        try {
          ws.close()
        } catch {
          // abaikan
        }
      }
    }
    // seed sengaja di-exclude: re-seed cukup saat enabled toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  return { logs, status }
}

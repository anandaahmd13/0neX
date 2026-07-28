import { useCallback, useEffect, useRef, useState } from 'react'

export type ClaudeStatus = 'idle' | 'connecting' | 'running' | 'done' | 'error'

// URL bridge Claude Code. Override lewat VITE_CLAUDE_WS_URL saat build/dev.
const WS_URL =
  (import.meta.env.VITE_CLAUDE_WS_URL as string | undefined) ??
  'ws://localhost:8788'

interface ChunkMsg {
  type: 'chunk'
  text: string
  level?: 'error'
}
interface DoneMsg {
  type: 'done'
  code: number | null
}
interface ErrorMsg {
  type: 'error'
  text: string
}
type ServerMsg = ChunkMsg | DoneMsg | ErrorMsg

/**
 * Konek ke bridge Claude Code, kirim prompt, dan kumpulin chunk yang masuk
 * jadi array baris output. Tiap panggilan run() bikin koneksi WS baru dan
 * nutup yang lama. Koneksi dibersihin saat unmount.
 */
export function useClaudeStream() {
  const [output, setOutput] = useState<string[]>([])
  const [status, setStatus] = useState<ClaudeStatus>('idle')
  const wsRef = useRef<WebSocket | null>(null)

  const cleanup = useCallback(() => {
    const ws = wsRef.current
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close()
      } catch {
        // abaikan
      }
      wsRef.current = null
    }
  }, [])

  const run = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim()
      if (!trimmed) return

      cleanup()
      setOutput([])
      setStatus('connecting')

      let ws: WebSocket
      try {
        ws = new WebSocket(WS_URL)
      } catch {
        setStatus('error')
        setOutput(['Gagal bikin koneksi ke bridge Claude Code'])
        return
      }
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('running')
        ws.send(JSON.stringify({ type: 'run', prompt: trimmed }))
      }

      ws.onmessage = (ev) => {
        let msg: ServerMsg
        try {
          msg = JSON.parse(ev.data) as ServerMsg
        } catch {
          setOutput((prev) => [...prev, String(ev.data)])
          return
        }

        if (msg.type === 'chunk') {
          const prefix = msg.level === 'error' ? '[stderr] ' : ''
          // Pecah teks multi-baris jadi baris terpisah biar rapi di panel.
          const lines = msg.text.split('\n').map((l) => prefix + l)
          setOutput((prev) => [...prev, ...lines])
        } else if (msg.type === 'done') {
          setStatus('done')
        } else if (msg.type === 'error') {
          setOutput((prev) => [...prev, `[error] ${msg.text}`])
          setStatus('error')
        }
      }

      ws.onerror = () => {
        setStatus('error')
        setOutput((prev) => [
          ...prev,
          '[error] Nggak bisa nyambung ke bridge — jalankan `pnpm claude-bridge` dulu',
        ])
      }

      ws.onclose = () => {
        // Kalau nutup pas masih running (belum dapet done), tandai error.
        setStatus((s) => (s === 'running' || s === 'connecting' ? 'error' : s))
      }
    },
    [cleanup],
  )

  useEffect(() => cleanup, [cleanup])

  return { run, output, status, cleanup }
}

import { useCallback, useEffect, useRef, useState } from 'react'

export type ClaudeStatus = 'idle' | 'connecting' | 'running' | 'done' | 'error'

// URL bridge Claude Code. Override lewat VITE_CLAUDE_WS_URL saat build/dev.
const WS_BASE =
  (import.meta.env.VITE_CLAUDE_WS_URL as string | undefined) ??
  'ws://localhost:8788'

// Token handshake — bridge nolak koneksi tanpa token yang cocok. Ambil dari
// env; kalau kosong, koneksi bakal ditolak dan UI nampilin error yang jelas.
const WS_TOKEN = (import.meta.env.VITE_CLAUDE_WS_TOKEN as string | undefined) ?? ''

/** Susun URL WS lengkap dengan token di query string. */
function buildWsUrl(): string {
  try {
    const u = new URL(WS_BASE)
    if (WS_TOKEN) u.searchParams.set('token', WS_TOKEN)
    return u.toString()
  } catch {
    // WS_BASE nggak valid — balikin apa adanya, biar error muncul saat connect.
    return WS_BASE
  }
}

interface SessionMsg {
  type: 'session'
  sessionId: string
}
interface ChunkMsg {
  type: 'chunk'
  text: string
  level?: 'error'
}
interface DoneMsg {
  type: 'done'
  code: number | null
  sessionId?: string
}
interface ErrorMsg {
  type: 'error'
  text: string
}
type ServerMsg = SessionMsg | ChunkMsg | DoneMsg | ErrorMsg

/** Opsi sesi buat satu run. */
export interface RunOptions {
  // UUID sesi (stabil per-pane). Kosong = bridge yang bikinin.
  sessionId?: string
  // true = lanjutin konteks sesi (`--resume`); false/undefined = bikin baru.
  resume?: boolean
}

/**
 * Callback per-run. Dipisah dari state hook biar tiap pemanggil (mis. tiap
 * pane) bisa nampung output-nya sendiri tanpa hook ikut nyimpen.
 */
export interface RunHandlers {
  // sessionId yang beneran dipakai bridge (echo balik) — simpen buat resume.
  onSession?: (sessionId: string) => void
  // Satu potong output. `text` bisa multi-baris; `level` 'error' = dari stderr.
  onChunk?: (text: string, level?: 'error') => void
  // Run selesai normal (proses claude exit / dibatalkan).
  onDone?: (code: number | null) => void
  // Error dari bridge (validasi, spawn gagal, timeout, koneksi putus).
  onError?: (text: string) => void
}

/**
 * Konek ke bridge Claude Code buat SATU run, stream output-nya lewat callback,
 * lalu tutup socket saat selesai. Model per-run (bukan socket persisten) bikin
 * pane yang lagi idle nggak nahan slot koneksi bridge (MAX_CLIENTS).
 *
 * Satu instance hook = satu run aktif. Panggil run() lagi bakal nutup run
 * sebelumnya. `status` di-expose buat nyetir UI (badge, tombol Stop).
 */
export function useClaudeStream() {
  const [status, setStatus] = useState<ClaudeStatus>('idle')
  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<RunHandlers>({})

  const cleanup = useCallback(() => {
    const ws = wsRef.current
    if (ws) {
      // Null-in handler dulu biar onclose nggak firing pas kita nutup sengaja.
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
    (prompt: string, opts: RunOptions = {}, handlers: RunHandlers = {}) => {
      const trimmed = prompt.trim()
      if (!trimmed) return

      cleanup()
      handlersRef.current = handlers
      setStatus('connecting')

      let ws: WebSocket
      try {
        ws = new WebSocket(buildWsUrl())
      } catch {
        setStatus('error')
        handlers.onError?.('Gagal bikin koneksi ke bridge Claude Code')
        return
      }
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('running')
        ws.send(
          JSON.stringify({
            type: 'run',
            prompt: trimmed,
            sessionId: opts.sessionId,
            resume: opts.resume === true,
          }),
        )
      }

      ws.onmessage = (ev) => {
        const h = handlersRef.current
        let msg: ServerMsg
        try {
          msg = JSON.parse(ev.data) as ServerMsg
        } catch {
          // Bukan JSON — perlakukan sebagai chunk mentah.
          h.onChunk?.(String(ev.data))
          return
        }

        if (msg.type === 'session') {
          h.onSession?.(msg.sessionId)
        } else if (msg.type === 'chunk') {
          h.onChunk?.(msg.text, msg.level)
        } else if (msg.type === 'done') {
          setStatus('done')
          h.onDone?.(msg.code)
          cleanup() // run kelar — lepas slot bridge.
        } else if (msg.type === 'error') {
          setStatus('error')
          h.onError?.(msg.text)
          // Error selalu ngakhirin attempt run ini (validasi gagal, spawn
          // gagal, atau timeout yang lagi di-kill) — lepas socket.
          cleanup()
        }
      }

      ws.onerror = () => {
        setStatus('error')
        handlersRef.current.onError?.(
          'Nggak bisa nyambung ke bridge — jalankan `pnpm claude-bridge` dulu',
        )
      }

      ws.onclose = () => {
        // Nutup pas masih connecting/running (belum dapet done) = anggap error.
        setStatus((s) => (s === 'running' || s === 'connecting' ? 'error' : s))
      }
    },
    [cleanup],
  )

  /**
   * Batalin run yang lagi jalan. Kirim { type: "cancel" }; bridge kill proses
   * dan balikin { done } (yang nge-set status 'done' + nutup socket). Kalau
   * socket udah nggak kebuka, cukup rapihin status lokal.
   */
  const stop = useCallback(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cancel' }))
    } else {
      setStatus((s) => (s === 'running' || s === 'connecting' ? 'idle' : s))
    }
  }, [])

  useEffect(() => cleanup, [cleanup])

  return { run, stop, status, cleanup }
}

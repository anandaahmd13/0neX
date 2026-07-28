import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentToolPolicy, ProviderId } from '../types'

export type GatewayStatus = 'idle' | 'connecting' | 'running' | 'done' | 'error'

const WS_BASE =
  (import.meta.env.VITE_GATEWAY_WS_URL as string | undefined) ??
  (import.meta.env.VITE_CLAUDE_WS_URL as string | undefined) ??
  'ws://localhost:8788'
const WS_TOKEN =
  (import.meta.env.VITE_GATEWAY_WS_TOKEN as string | undefined) ??
  (import.meta.env.VITE_CLAUDE_WS_TOKEN as string | undefined) ??
  ''

function buildWsUrl(): string {
  try {
    const url = new URL(WS_BASE)
    if (WS_TOKEN) url.searchParams.set('token', WS_TOKEN)
    return url.toString()
  } catch {
    return WS_BASE
  }
}

export interface GatewayUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

export interface GatewayResult {
  code: number | null
  sessionId?: string
  providerId?: string
  reason: 'completed' | 'cancelled' | 'timeout' | 'failed'
  usage?: GatewayUsage | null
}

interface HelloMessage {
  type: 'hello'
  protocolVersion: number
}
interface SessionMessage {
  type: 'session'
  sessionId: string
  providerId: string
  agentId: string
}
interface ChunkMessage {
  type: 'chunk'
  text: string
  level?: 'error'
}
interface DoneMessage extends GatewayResult {
  type: 'done'
}
interface ErrorMessage {
  type: 'error'
  text: string
}
type ServerMessage = HelloMessage | SessionMessage | ChunkMessage | DoneMessage | ErrorMessage

export interface GatewayAgentConfig {
  id: string
  model: string
  systemPrompt: string
  toolPolicy: AgentToolPolicy
}

export interface RunOptions {
  providerId: ProviderId
  agent: GatewayAgentConfig
  sessionId?: string
  resume?: boolean
}

export interface RunHandlers {
  onSession?: (sessionId: string) => void
  onChunk?: (text: string, level?: 'error') => void
  onDone?: (result: GatewayResult) => void
  onError?: (text: string) => void
}

export function useGatewayStream() {
  const [status, setStatus] = useState<GatewayStatus>('idle')
  const socketRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<RunHandlers>({})
  const activeRef = useRef(false)

  const cleanup = useCallback(() => {
    const socket = socketRef.current
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
    try {
      socket.close()
    } catch {
      // Socket sudah tertutup.
    }
    socketRef.current = null
  }, [])

  const run = useCallback(
    (prompt: string, options: RunOptions, handlers: RunHandlers = {}) => {
      const trimmed = prompt.trim()
      if (!trimmed) return

      cleanup()
      handlersRef.current = handlers
      activeRef.current = true
      setStatus('connecting')
      let terminal = false
      let socket: WebSocket

      const fail = (message: string) => {
        if (terminal) return
        terminal = true
        activeRef.current = false
        setStatus('error')
        handlersRef.current.onError?.(message)
        cleanup()
      }

      try {
        socket = new WebSocket(buildWsUrl())
      } catch {
        fail('Gagal membuat koneksi ke Personal AI Gateway')
        return
      }
      socketRef.current = socket

      socket.onopen = () => {
        setStatus('running')
        socket.send(
          JSON.stringify({
            type: 'run',
            prompt: trimmed,
            providerId: options.providerId,
            agent: options.agent,
            sessionId: options.sessionId,
            resume: options.resume === true,
          }),
        )
      }

      socket.onmessage = (event) => {
        let message: ServerMessage
        try {
          message = JSON.parse(String(event.data)) as ServerMessage
        } catch {
          handlersRef.current.onChunk?.(String(event.data))
          return
        }

        if (message.type === 'hello') return
        if (message.type === 'session') {
          handlersRef.current.onSession?.(message.sessionId)
          return
        }
        if (message.type === 'chunk') {
          handlersRef.current.onChunk?.(message.text, message.level)
          return
        }
        if (message.type === 'error') {
          fail(message.text)
          return
        }

        terminal = true
        activeRef.current = false
        setStatus('done')
        handlersRef.current.onDone?.({
          code: message.code,
          sessionId: message.sessionId,
          providerId: message.providerId,
          reason: message.reason,
          usage: message.usage,
        })
        cleanup()
      }

      socket.onerror = () => {
        fail('Tidak bisa terhubung ke Gateway - jalankan `pnpm gateway` dulu')
      }
      socket.onclose = () => {
        if (!terminal) fail('Koneksi Gateway terputus sebelum run selesai')
      }
    },
    [cleanup],
  )

  const stop = useCallback(() => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'cancel' }))
      return
    }
    if (socket?.readyState === WebSocket.CONNECTING && activeRef.current) {
      activeRef.current = false
      handlersRef.current.onDone?.({ code: null, reason: 'cancelled' })
      cleanup()
      setStatus('done')
      return
    }
    setStatus((current) =>
      current === 'running' || current === 'connecting' ? 'idle' : current,
    )
  }, [cleanup])

  useEffect(
    () => () => {
      if (activeRef.current) {
        activeRef.current = false
        handlersRef.current.onDone?.({ code: null, reason: 'cancelled' })
      }
      cleanup()
    },
    [cleanup],
  )

  return { run, stop, status, cleanup }
}

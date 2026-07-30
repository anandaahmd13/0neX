import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentToolPolicy, ProviderId } from '../types'
import { gatewayApi } from './gatewayApi'

export type GatewayStatus = 'idle' | 'connecting' | 'running' | 'done' | 'error'

const WS_BASE =
  (import.meta.env.VITE_GATEWAY_WS_URL as string | undefined) ??
  (import.meta.env.VITE_CLAUDE_WS_URL as string | undefined) ??
  'ws://localhost:8788'

function buildWsUrl(ticket: string): string {
  try {
    const url = new URL(WS_BASE)
    url.searchParams.delete('token')
    url.searchParams.set('ticket', ticket)
    return url.toString()
  } catch {
    return WS_BASE
  }
}

function newRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `run_${Date.now().toString(36)}`
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

export interface GatewayPermissionOption {
  optionId: string
  kind: string
  name: string
}

export interface GatewayPermissionRequest {
  runId: string
  requestId: string
  toolCall: unknown
  options: GatewayPermissionOption[]
  expiresAt: number
}

interface SequencedMessage {
  runId?: string
  seq?: number
}
interface HelloMessage extends SequencedMessage {
  type: 'hello'
  protocolVersion: number
}
interface SessionMessage extends SequencedMessage {
  type: 'session'
  sessionId: string
  providerId: string
  agentId: string
}
interface ChunkMessage extends SequencedMessage {
  type: 'chunk' | 'message_delta' | 'thought_delta'
  text: string
  level?: 'error'
}
type PermissionMessage = GatewayPermissionRequest & SequencedMessage & {
  type: 'permission_request'
}
interface DoneMessage extends GatewayResult, SequencedMessage {
  type: 'done'
}
interface ErrorMessage extends SequencedMessage {
  type: 'error'
  text: string
  code?: string
}
interface IgnoredStructuredMessage extends SequencedMessage {
  type: 'plan' | 'tool_call' | 'tool_call_update' | 'diagnostic'
}
type ServerMessage =
  | HelloMessage
  | SessionMessage
  | ChunkMessage
  | PermissionMessage
  | DoneMessage
  | ErrorMessage
  | IgnoredStructuredMessage

export interface GatewayAgentConfig {
  id: string
  model: string
  systemPrompt: string
  toolPolicy: AgentToolPolicy
}

export interface RunOptions {
  providerId: ProviderId
  agent: GatewayAgentConfig
  connectionId?: string
  sessionId?: string
  resume?: boolean
}

export interface RunHandlers {
  onSession?: (sessionId: string) => void
  onChunk?: (text: string, level?: 'error') => void
  onPermissionRequest?: (
    request: GatewayPermissionRequest,
  ) => Promise<string | null> | string | null
  onDone?: (result: GatewayResult) => void
  onError?: (text: string) => void
}

export function useGatewayStream() {
  const [status, setStatus] = useState<GatewayStatus>('idle')
  const socketRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<RunHandlers>({})
  const activeRef = useRef(false)
  const generationRef = useRef(0)
  const runIdRef = useRef<string | null>(null)

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
      const generation = ++generationRef.current
      const runId = newRunId()
      runIdRef.current = runId
      handlersRef.current = handlers
      activeRef.current = true
      setStatus('connecting')
      let terminal = false
      let socket: WebSocket | null = null

      const fail = (message: string) => {
        if (terminal || generation !== generationRef.current) return
        terminal = true
        activeRef.current = false
        setStatus('error')
        handlersRef.current.onError?.(message)
        cleanup()
      }

      void gatewayApi.issueWsTicket().then(({ ticket }) => {
        if (!activeRef.current || generation !== generationRef.current) return
        try {
          socket = new WebSocket(buildWsUrl(ticket))
        } catch {
          fail('Gagal membuat koneksi ke Personal AI Gateway')
          return
        }
        socketRef.current = socket

        socket.onopen = () => {
          if (generation !== generationRef.current) return
          setStatus('running')
          socket?.send(
            JSON.stringify({
              type: 'run',
              runId,
              prompt: trimmed,
              providerId: options.providerId,
              agent: options.agent,
              connectionId: options.connectionId,
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
          if (message.runId && message.runId !== runId) return
          if (message.type === 'session') {
            handlersRef.current.onSession?.(message.sessionId)
            return
          }
          if (message.type === 'chunk' || message.type === 'message_delta') {
            handlersRef.current.onChunk?.(message.text, message.level)
            return
          }
          if (message.type === 'thought_delta') {
            handlersRef.current.onChunk?.(`[thinking] ${message.text}`)
            return
          }
          if (message.type === 'permission_request') {
            void Promise.resolve(handlersRef.current.onPermissionRequest?.(message) ?? null)
              .then((optionId) => {
                const reject = message.options.find((option) => option.kind.startsWith('reject'))
                const selected = optionId && message.options.some((option) => option.optionId === optionId)
                  ? optionId
                  : reject?.optionId
                if (!selected || socket?.readyState !== WebSocket.OPEN) return
                socket.send(JSON.stringify({
                  type: 'permission_response',
                  runId,
                  requestId: message.requestId,
                  optionId: selected,
                }))
              })
              .catch(() => {})
            return
          }
          if (message.type === 'plan' || message.type === 'tool_call'
            || message.type === 'tool_call_update' || message.type === 'diagnostic') return
          if (message.type === 'error') {
            fail(message.text)
            return
          }
          if (message.type !== 'done') return

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
      }).catch((error) => {
        fail(error instanceof Error ? error.message : 'Gagal meminta WebSocket ticket')
      })
    },
    [cleanup],
  )

  const stop = useCallback(() => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'cancel', runId: runIdRef.current }))
      return
    }
    if (activeRef.current) {
      generationRef.current += 1
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
      generationRef.current += 1
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

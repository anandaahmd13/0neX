import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentToolPolicy, GatewayProvider, ProviderId } from '../types'
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

export interface GatewayPlanEvent {
  plan: unknown
}

export interface GatewayToolEvent {
  toolCall: unknown
}

export interface GatewayDiagnosticEvent {
  diagnostic: unknown
}

interface SequencedMessage {
  runId?: string
  seq?: number
}
interface HelloMessage extends SequencedMessage {
  type: 'hello'
  protocolVersion: number
  providers: GatewayProvider[]
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
interface PlanMessage extends SequencedMessage, GatewayPlanEvent {
  type: 'plan'
}
interface ToolMessage extends SequencedMessage, GatewayToolEvent {
  type: 'tool_call' | 'tool_call_update'
}
interface DiagnosticMessage extends SequencedMessage, GatewayDiagnosticEvent {
  type: 'diagnostic'
}
interface DoneMessage extends GatewayResult, SequencedMessage {
  type: 'done'
}
interface ErrorMessage extends SequencedMessage {
  type: 'error'
  text: string
  code?: string
}
type ServerMessage =
  | HelloMessage
  | SessionMessage
  | ChunkMessage
  | PermissionMessage
  | PlanMessage
  | ToolMessage
  | DiagnosticMessage
  | DoneMessage
  | ErrorMessage

export interface GatewayAgentConfig {
  id: string
  model: string
  systemPrompt: string
  toolPolicy: AgentToolPolicy
  mcpServerIds?: string[]
}

export interface RunOptions {
  providerId: ProviderId
  agent: GatewayAgentConfig
  connectionId?: string
  workspaceId?: string
  sessionId?: string
  resume?: boolean
}

export interface RunHandlers {
  onSession?: (sessionId: string) => void
  onChunk?: (text: string, level?: 'error') => void
  onThought?: (text: string) => void
  onPlan?: (event: GatewayPlanEvent) => void
  onToolCall?: (event: GatewayToolEvent) => void
  onToolCallUpdate?: (event: GatewayToolEvent) => void
  onDiagnostic?: (event: GatewayDiagnosticEvent) => void
  onPermissionRequest?: (
    request: GatewayPermissionRequest,
  ) => Promise<string | null> | string | null
  onPermissionCancelled?: () => void
  onDone?: (result: GatewayResult) => void
  onError?: (text: string) => void
}

export function useGatewayStream() {
  const [status, setStatus] = useState<GatewayStatus>('idle')
  const [providers, setProviders] = useState<GatewayProvider[]>([])
  const [providersError, setProvidersError] = useState('')
  const socketRef = useRef<WebSocket | null>(null)
  const discoverySocketRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<RunHandlers>({})
  const activeRef = useRef(false)
  const generationRef = useRef(0)
  const runIdRef = useRef<string | null>(null)

  const cancelPendingPermission = useCallback(() => {
    handlersRef.current.onPermissionCancelled?.()
  }, [])

  const cleanup = useCallback(() => {
    cancelPendingPermission()
    const socket = socketRef.current
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
    try {
      socket.close()
    } catch {
      // Socket sudah tertutup.
    }
    socketRef.current = null
  }, [cancelPendingPermission])

  useEffect(() => {
    let active = true
    void gatewayApi.issueWsTicket().then(({ ticket }) => {
      if (!active) return
      const socket = new WebSocket(buildWsUrl(ticket))
      discoverySocketRef.current = socket
      socket.onmessage = (event) => {
        if (!active) return
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage
          if (message.type !== 'hello') return
          setProviders(message.providers)
          setProvidersError('')
          socket.close()
        } catch {
          setProvidersError('Gateway mengirim capability provider yang tidak valid')
        }
      }
      socket.onerror = () => {
        if (active) setProvidersError('Tidak bisa membaca capability provider Gateway')
      }
    }).catch((error) => {
      if (active) {
        setProvidersError(error instanceof Error ? error.message : 'Gagal meminta capability provider')
      }
    })
    return () => {
      active = false
      const socket = discoverySocketRef.current
      if (socket) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
        socket.close()
        discoverySocketRef.current = null
      }
    }
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
        cancelPendingPermission()
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
              workspaceId: options.workspaceId,
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

          if (message.type === 'hello') {
            setProviders(message.providers)
            setProvidersError('')
            return
          }
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
            handlersRef.current.onThought?.(message.text)
            return
          }
          if (message.type === 'plan') {
            handlersRef.current.onPlan?.({ plan: message.plan })
            return
          }
          if (message.type === 'tool_call') {
            handlersRef.current.onToolCall?.({ toolCall: message.toolCall })
            return
          }
          if (message.type === 'tool_call_update') {
            handlersRef.current.onToolCallUpdate?.({ toolCall: message.toolCall })
            return
          }
          if (message.type === 'diagnostic') {
            handlersRef.current.onDiagnostic?.({ diagnostic: message.diagnostic })
            return
          }
          if (message.type === 'permission_request') {
            const handler = handlersRef.current.onPermissionRequest
            if (!handler) return
            void Promise.resolve(handler(message)).then((optionId) => {
              if (
                !optionId
                || !message.options.some((option) => option.optionId === optionId)
                || socket?.readyState !== WebSocket.OPEN
              ) return
              socket.send(JSON.stringify({
                type: 'permission_response',
                runId,
                requestId: message.requestId,
                optionId,
              }))
            }).catch(() => {})
            return
          }
          if (message.type === 'error') {
            fail(message.text)
            return
          }
          if (message.type !== 'done') return

          terminal = true
          activeRef.current = false
          cancelPendingPermission()
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
    [cancelPendingPermission, cleanup],
  )

  const stop = useCallback(() => {
    cancelPendingPermission()
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
  }, [cancelPendingPermission, cleanup])

  useEffect(
    () => () => {
      generationRef.current += 1
      cancelPendingPermission()
      if (activeRef.current) {
        activeRef.current = false
        handlersRef.current.onDone?.({ code: null, reason: 'cancelled' })
      }
      cleanup()
    },
    [cancelPendingPermission, cleanup],
  )

  return { run, stop, status, providers, providersError, cleanup }
}

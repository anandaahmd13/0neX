import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageTitle } from '../components/PageTitle'
import { Badge } from '../components/ui/Badge'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { CloseIcon, PlusIcon, SendIcon, StopIcon, TrashIcon } from '../components/icons'
import { agents } from '../data/mock'
import { newRunId } from '../lib/execWorkflow'
import { gatewayApi } from '../lib/gatewayApi'
import type { GatewayConnection } from '../lib/gatewayApi'
import { useGatewayStream } from '../lib/useGatewayStream'
import type { GatewayStatus } from '../lib/useGatewayStream'
import { usePanes, MAX_PANES } from '../lib/usePanes'
import type { Pane } from '../lib/usePanes'
import { useRuns } from '../lib/runs'
import { cn } from '../lib/cn'
import type { Agent, Run } from '../types'

const statusMeta: Record<GatewayStatus, { label: string; dot: string }> = {
  idle: { label: 'Idle', dot: 'bg-ink/30' },
  connecting: { label: 'Menyambung', dot: 'bg-sky' },
  running: { label: 'Running', dot: 'bg-mustard' },
  done: { label: 'Selesai', dot: 'bg-ok' },
  error: { label: 'Error', dot: 'bg-danger' },
}

function lineClass(line: string): string {
  if (line.startsWith('> ')) return 'text-mustard font-bold'
  if (line.startsWith('[stderr]') || line.startsWith('[error]')) return 'term-error'
  if (line.startsWith('system:') || line.startsWith('[gateway]')) return 'term-dim2'
  return ''
}

function nowTime(): string {
  return new Date().toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

interface PaneCardProps {
  pane: Pane
  agent: Agent
  kiroConnections: GatewayConnection[]
  connectionsError: string
  canClose: boolean
  onRemove: (id: string) => void
  onReset: (id: string) => void
  onAppend: (id: string, lines: string[]) => void
  onSession: (id: string, sessionId: string) => void
  onBump: (id: string) => void
  onTitle: (id: string, title: string) => void
  onAgent: (id: string, agentId: string) => void
  onConnection: (id: string, connectionId: string) => void
  onModel: (id: string, modelId: string) => void
}

function PaneCard({
  pane,
  agent,
  kiroConnections,
  connectionsError,
  canClose,
  onRemove,
  onReset,
  onAppend,
  onSession,
  onBump,
  onTitle,
  onAgent,
  onConnection,
  onModel,
}: PaneCardProps) {
  const [prompt, setPrompt] = useState('')
  const { run, stop, status } = useGatewayStream()
  const { addRun, appendLog, updateRun } = useRuns()
  const terminalRef = useRef<HTMLDivElement>(null)
  const busy = status === 'connecting' || status === 'running'
  const persistentSession = agent.providerId !== 'kiro-cli'
  const meta = statusMeta[status]
  const selectedConnection = kiroConnections.find(
    (connection) => connection.id === pane.connectionId,
  )
  const availableModels = selectedConnection?.models ?? []

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight
  }, [pane.transcript])

  function handleRun() {
    const task = prompt.trim()
    if (!task || busy) return
    if (agent.providerId === 'kiro-cli' && !pane.connectionId) {
      onAppend(pane.id, ['[error] Pilih connection Kiro aktif sebelum mengirim prompt.'])
      return
    }
    if (
      agent.providerId === 'kiro-cli'
      && (!pane.modelId || !availableModels.includes(pane.modelId))
    ) {
      onAppend(pane.id, ['[error] Pilih model Kiro aktif sebelum mengirim prompt.'])
      return
    }

    const startedAt = new Date()
    const runId = newRunId()
    let output = ''
    const gatewayRun: Run = {
      id: runId,
      task,
      workflow: `Personal Gateway / ${agent.providerId}`,
      source: 'gateway',
      status: 'running',
      startedAt: startedAt.toISOString(),
      durationMs: 0,
      tokensUsed: 0,
      agentsInvolved: [agent.name],
      output: '',
      logs: [
        {
          ts: nowTime(),
          level: 'info',
          agent: agent.name,
          message: `Memulai ${agent.providerId} dengan model ${agent.providerId === 'kiro-cli' ? pane.modelId : agent.model || 'Auto'}`,
        },
      ],
    }
    addRun(gatewayRun)
    onAppend(pane.id, [`> ${task}`])
    if (pane.turns === 0) onTitle(pane.id, task.slice(0, 60))

    run(
      task,
      {
        providerId: agent.providerId,
        connectionId: agent.providerId === 'kiro-cli' ? pane.connectionId : undefined,
        agent: {
          id: agent.id,
          model: agent.providerId === 'kiro-cli' ? pane.modelId : agent.model,
          systemPrompt: agent.systemPrompt,
          toolPolicy: agent.toolPolicy,
        },
        sessionId: pane.sessionId,
        resume: persistentSession && pane.turns > 0,
      },
      {
        onSession: (sessionId) => {
          if (persistentSession) onSession(pane.id, sessionId)
        },
        onChunk: (text, level) => {
          const prefix = level === 'error' ? '[stderr] ' : ''
          const lines = text.split('\n').map((line) => prefix + line)
          onAppend(pane.id, lines)
          output += `${output ? '\n' : ''}${text}`
          if (level === 'error') {
            appendLog(runId, {
              ts: nowTime(),
              level: 'warn',
              agent: agent.name,
              message: text,
            })
          }
        },
        onDone: (result) => {
          const success = result.code === 0 && result.reason === 'completed'
          if (success) onBump(pane.id)
          appendLog(runId, {
            ts: nowTime(),
            level: success ? 'info' : 'warn',
            agent: agent.name,
            message: success ? 'Gateway run selesai' : `Gateway run berakhir: ${result.reason}`,
          })
          updateRun(runId, (current) => ({
            ...current,
            status: success ? 'success' : 'failed',
            durationMs: Date.now() - startedAt.getTime(),
            tokensUsed: result.usage?.totalTokens ?? 0,
            output: output || (success ? 'Selesai tanpa output teks.' : `Run ${result.reason}.`),
          }))
        },
        onError: (message) => {
          onAppend(pane.id, [`[error] ${message}`])
          appendLog(runId, {
            ts: nowTime(),
            level: 'error',
            agent: agent.name,
            message,
          })
          updateRun(runId, (current) => ({
            ...current,
            status: 'failed',
            durationMs: Date.now() - startedAt.getTime(),
            output: output || message,
          }))
        },
      },
    )
    setPrompt('')
  }

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={pane.title}
        action={
          <div className="flex items-center gap-1.5">
            <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-ink/60">
              <span
                className={cn(
                  'inline-block h-2 w-2 rounded-full border border-ink',
                  meta.dot,
                  busy && 'animate-pulse',
                )}
              />
              {meta.label}
            </span>
            <button
              onClick={() => onReset(pane.id)}
              disabled={busy}
              title={persistentSession ? 'Reset konteks' : 'Bersihkan output'}
              className="press flex cursor-pointer items-center gap-1 rounded-md border-2 border-ink bg-cream px-1.5 py-1 text-[10px] font-bold uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-50"
            >
              <TrashIcon width={12} height={12} />
              {persistentSession ? 'Reset' : 'Bersihkan'}
            </button>
            {canClose && (
              <button
                onClick={() => onRemove(pane.id)}
                disabled={busy}
                title="Tutup sesi"
                className="press cursor-pointer rounded-md border-2 border-ink bg-cream p-1 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CloseIcon width={12} height={12} />
              </button>
            )}
          </div>
        }
      />
      <CardBody className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={agent.id}
            onChange={(event) => onAgent(pane.id, event.target.value)}
            disabled={busy}
            className="min-w-0 flex-1 rounded-lg border-2 border-ink bg-cream px-2 py-1.5 text-xs font-bold outline-none disabled:opacity-60"
            aria-label="Pilih agent"
          >
            {agents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} - {candidate.model || 'Auto'}
              </option>
            ))}
          </select>
          <Badge color="sky">{agent.providerId}</Badge>
          <Badge color="neutral">tools: {agent.toolPolicy}</Badge>
        </div>

        {agent.providerId === 'kiro-cli' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={`kiro-connection-${pane.id}`} className="text-[10px] font-bold uppercase tracking-wider text-ink/60">
                Connection Kiro
              </label>
              <select
                id={`kiro-connection-${pane.id}`}
                value={pane.connectionId}
                onChange={(event) => onConnection(pane.id, event.target.value)}
                disabled={busy || kiroConnections.length === 0}
                className="w-full rounded-lg border-2 border-ink bg-cream px-2 py-1.5 text-xs font-bold outline-none disabled:opacity-60"
              >
                <option value="">Pilih connection tersimpan</option>
                {kiroConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name} · {connection.region ?? 'us-east-1'}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor={`kiro-model-${pane.id}`} className="text-[10px] font-bold uppercase tracking-wider text-ink/60">
                Model Kiro
              </label>
              <select
                id={`kiro-model-${pane.id}`}
                value={pane.modelId}
                onChange={(event) => onModel(pane.id, event.target.value)}
                disabled={busy || !selectedConnection || availableModels.length === 0}
                className="w-full rounded-lg border-2 border-ink bg-cream px-2 py-1.5 text-xs font-bold outline-none disabled:opacity-60"
              >
                <option value="">Pilih model aktif</option>
                {availableModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </div>
            {connectionsError ? (
              <p className="text-xs font-bold text-danger sm:col-span-2">{connectionsError}</p>
            ) : kiroConnections.length === 0 ? (
              <p className="text-xs text-ink/60 sm:col-span-2">Tambahkan dan aktifkan connection Kiro di AI Gateway dulu.</p>
            ) : selectedConnection && availableModels.length === 0 ? (
              <p className="text-xs font-bold text-danger sm:col-span-2">Connection ini belum memiliki model aktif.</p>
            ) : null}
          </div>
        )}

        <details className="rounded-lg border-2 border-dashed border-ink/30 bg-cream px-3 py-2 text-xs">
          <summary className="cursor-pointer font-bold">Konfigurasi agent</summary>
          <div className="mt-2 space-y-1 text-ink/60">
            <p>Model: {agent.providerId === 'kiro-cli' ? pane.modelId || 'Belum dipilih' : agent.model || 'Auto'}</p>
            <p>System prompt: {agent.systemPrompt}</p>
          </div>
        </details>

        <div
          ref={terminalRef}
          className="term h-72 overflow-y-auto rounded-lg border-2 border-ink p-3 font-mono text-xs leading-relaxed"
        >
          {pane.transcript.length === 0 ? (
            <span className="term-dim">Mulai percakapan dengan {agent.name}.</span>
          ) : (
            pane.transcript.map((line, index) => (
              <div
                key={`${index}-${line.slice(0, 12)}`}
                className={cn('whitespace-pre-wrap break-words', lineClass(line))}
              >
                {line}
              </div>
            ))
          )}
          {busy && (
            <div className="term-dim2 mt-1 flex items-center gap-2">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-ok" />
              streaming...
            </div>
          )}
        </div>

        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              handleRun()
            }
          }}
          rows={2}
          disabled={busy}
          placeholder={pane.turns > 0 ? 'Lanjutkan percakapan...' : `Ketik prompt untuk ${agent.name}...`}
          className="w-full resize-none rounded-lg border-2 border-ink bg-cream px-3 py-2 font-mono text-sm outline-none placeholder:text-ink/40 focus:bg-paper disabled:opacity-60"
        />

        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-ink/50">
            sesi {pane.sessionId.slice(0, 8)} / {pane.turns} giliran
          </span>
          {busy ? (
            <Button variant="ghost" size="sm" onClick={stop}>
              <StopIcon width={14} height={14} />
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={handleRun}
              disabled={
                !prompt.trim()
                || (agent.providerId === 'kiro-cli'
                  && (!pane.connectionId || !pane.modelId || !availableModels.includes(pane.modelId)))
              }
            >
              <SendIcon width={14} height={14} />
              Kirim
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

export function Playground() {
  const {
    panes,
    addPane,
    removePane,
    appendOutput,
    setSession,
    bumpTurn,
    setTitle,
    resetPane,
    setAgent,
    setConnection,
    setModel,
  } = usePanes()
  const [searchParams, setSearchParams] = useSearchParams()
  const [kiroConnections, setKiroConnections] = useState<GatewayConnection[]>([])
  const [connectionsError, setConnectionsError] = useState('')
  const consumedAgent = useRef(false)
  const full = panes.length >= MAX_PANES

  useEffect(() => {
    let active = true
    gatewayApi.listConnections().then(
      (connections) => {
        if (!active) return
        setKiroConnections(
          connections.filter(
            (connection) => connection.kind === 'kiro-cli' && connection.enabled && connection.hasApiKey,
          ),
        )
        setConnectionsError('')
      },
      (error) => {
        if (!active) return
        setConnectionsError(error instanceof Error ? error.message : 'Gagal membaca connection Kiro')
      },
    )
    return () => { active = false }
  }, [])

  useEffect(() => {
    for (const pane of panes) {
      const agent = agents.find((candidate) => candidate.id === pane.agentId)
      if (agent?.providerId !== 'kiro-cli') continue

      if (!pane.connectionId && kiroConnections.length === 1) {
        setConnection(pane.id, kiroConnections[0].id)
        continue
      }

      const connection = kiroConnections.find((candidate) => candidate.id === pane.connectionId)
      if (!connection) continue
      if (connection.models.length === 0) {
        if (pane.modelId) setModel(pane.id, '')
        continue
      }
      if (!pane.modelId || !connection.models.includes(pane.modelId)) {
        setModel(
          pane.id,
          connection.models.includes('auto') ? 'auto' : connection.models[0],
        )
      }
    }
  }, [kiroConnections, panes, setConnection, setModel])

  useEffect(() => {
    if (consumedAgent.current) return
    const requestedId = searchParams.get('agent')
    if (!requestedId || !agents.some((agent) => agent.id === requestedId)) return
    consumedAgent.current = true
    if (panes.length === 0) addPane(requestedId)
    else setAgent(panes[0].id, requestedId)
    setSearchParams({}, { replace: true })
  }, [addPane, panes, searchParams, setAgent, setSearchParams])

  return (
    <div className="space-y-6">
      <PageTitle
        title="AI Playground"
        subtitle="Claude berjalan via CLI lokal; Kiro streaming via HTTPS dengan credential connection tersimpan."
        action={
          <Button variant="primary" size="sm" onClick={() => addPane()} disabled={full}>
            <PlusIcon width={16} height={16} />
            Tambah sesi
          </Button>
        }
      />

      <div className="flex items-center gap-2">
        <Badge color="ok">CLI + HTTPS</Badge>
        <span className="text-xs font-bold uppercase tracking-wider text-ink/60">
          {panes.length} / {MAX_PANES} sesi
        </span>
      </div>

      {panes.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-ink/60">
              Belum ada sesi. Credential provider tetap tersimpan aman di server.
            </p>
            <Button variant="primary" onClick={() => addPane()}>
              <PlusIcon width={16} height={16} />
              Mulai sesi
            </Button>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {panes.map((pane) => {
            const agent = agents.find((candidate) => candidate.id === pane.agentId) ?? agents[0]
            return (
              <PaneCard
                key={pane.id}
                pane={pane}
                agent={agent}
                kiroConnections={kiroConnections}
                connectionsError={connectionsError}
                canClose={panes.length > 1}
                onRemove={removePane}
                onReset={resetPane}
                onAppend={appendOutput}
                onSession={setSession}
                onBump={bumpTurn}
                onTitle={setTitle}
                onAgent={setAgent}
                onConnection={setConnection}
                onModel={setModel}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

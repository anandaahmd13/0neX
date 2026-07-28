import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { PageTitle } from '../components/PageTitle'
import { PlusIcon, BoltIcon, TrashIcon, PlayIcon, StopIcon } from '../components/icons'
import { workflows as seedWorkflows } from '../data/mock'
import type { LogEntry, Run, Workflow, WorkflowNode, NodeKind } from '../types'
import { fmtInt, fmtTime } from '../lib/format'
import { usePersistentState } from '../lib/usePersistentState'
import { useRuns } from '../lib/runs'
import { runWorkflow } from '../lib/execWorkflow'
import type { NodeRunStatus } from '../lib/execWorkflow'
import { useToast } from '../lib/toast'
import { cn } from '../lib/cn'

const NODE_W = 150
const NODE_H = 64
const CANVAS_W = 980
const CANVAS_H = 420

const kindStyle: Record<NodeKind, { bg: string; tag: string }> = {
  trigger: { bg: 'bg-sky', tag: 'TRIGGER' },
  agent: { bg: 'bg-mustard', tag: 'AGENT' },
  tool: { bg: 'bg-paper', tag: 'TOOL' },
  output: { bg: 'bg-ok', tag: 'OUTPUT' },
}

const kindDefaults: Record<NodeKind, { label: string; sublabel: string }> = {
  trigger: { label: 'Trigger baru', sublabel: 'manual' },
  agent: { label: 'Agent baru', sublabel: 'claude-opus-4.8' },
  tool: { label: 'Tool baru', sublabel: 'tool call' },
  output: { label: 'Output baru', sublabel: 'sink' },
}

let uid = 0
const newId = () => `n_${Date.now().toString(36)}_${(uid++).toString(36)}`

export function Workflows() {
  const [wfList, setWfList] = usePersistentState<Workflow[]>(
    '0nex.workflows',
    seedWorkflows,
  )
  const [activeId, setActiveId] = useState(wfList[0]?.id ?? '')
  const active = wfList.find((w) => w.id === activeId) ?? wfList[0]
  const { addRun, updateRun } = useRuns()
  const { push } = useToast()
  const navigate = useNavigate()

  // Update satu workflow (immutable) di dalam list.
  const patchActive = useCallback(
    (fn: (w: Workflow) => Workflow) => {
      setWfList((list) => list.map((w) => (w.id === active.id ? fn(w) : w)))
    },
    [active?.id, setWfList],
  )

  function resetToSeed() {
    setWfList(seedWorkflows)
    setActiveId(seedWorkflows[0].id)
  }

  function addWorkflow() {
    const wf: Workflow = {
      id: newId(),
      name: `Workflow ${wfList.length + 1}`,
      description: 'Workflow baru — mulai dengan menambah node.',
      runs: 0,
      lastRun: new Date().toISOString(),
      nodes: [
        { id: newId(), kind: 'trigger', label: 'Trigger', sublabel: 'manual', x: 60, y: 180 },
      ],
      edges: [],
    }
    setWfList((list) => [...list, wf])
    setActiveId(wf.id)
  }

  if (!active) {
    return (
      <div className="space-y-6">
        <PageTitle title="Workflows" subtitle="Belum ada workflow." />
        <Button variant="primary" onClick={resetToSeed}>
          Muat ulang contoh
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="Workflows"
        subtitle="Rangkai agent jadi alur kerja. Drag node buat mindahin, tarik dari titik kanan ke node lain buat nyambungin."
        action={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={resetToSeed}>
              Reset
            </Button>
            <Button variant="primary" onClick={addWorkflow}>
              <PlusIcon width={16} height={16} />
              Workflow baru
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Workflow list */}
        <div className="space-y-3">
          {wfList.map((w) => (
            <button
              key={w.id}
              onClick={() => setActiveId(w.id)}
              className={cn(
                'w-full rounded-xl border-2 border-ink p-4 text-left transition-all',
                w.id === active.id
                  ? 'bg-mustard shadow-hard'
                  : 'bg-paper shadow-hard-sm hover:bg-sky-soft',
              )}
            >
              <div className="font-brand text-base font-bold leading-tight">
                {w.name}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-ink/60">
                {w.description}
              </p>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-ink/50">
                <BoltIcon width={12} height={12} />
                {fmtInt(w.runs)} run · {fmtTime(w.lastRun)}
              </div>
            </button>
          ))}
        </div>

        {/* Builder */}
        <WorkflowBuilder
          key={active.id}
          workflow={active}
          onChange={patchActive}
          onRunComplete={(run) => {
            addRun(run)
            // Update jumlah run + lastRun di kartu workflow.
            setWfList((list) =>
              list.map((w) =>
                w.id === active.id
                  ? { ...w, runs: w.runs + 1, lastRun: run.startedAt }
                  : w,
              ),
            )
            push(
              run.status === 'success'
                ? `Workflow "${active.name}" selesai — run tercatat`
                : `Run "${active.name}" dihentikan`,
              run.status === 'success' ? 'success' : 'warn',
            )
          }}
          onRunStart={(run) => addRun(run)}
          onRunTick={updateRun}
          onViewRun={() => navigate('/runs')}
        />
      </div>
    </div>
  )
}

type DragState =
  | { mode: 'move'; nodeId: string; dx: number; dy: number }
  | { mode: 'connect'; from: string; x: number; y: number }
  | null

interface BuilderProps {
  workflow: Workflow
  onChange: (fn: (w: Workflow) => Workflow) => void
  onRunStart: (run: Run) => void
  onRunTick: (id: string, fn: (r: Run) => Run) => void
  onRunComplete: (run: Run) => void
  onViewRun: () => void
}

function WorkflowBuilder({
  workflow,
  onChange,
  onRunStart,
  onRunTick,
  onRunComplete,
  onViewRun,
}: BuilderProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [addKind, setAddKind] = useState<NodeKind>('agent')

  // ── State eksekusi ──
  const [running, setRunning] = useState(false)
  const [nodeStatus, setNodeStatus] = useState<Record<string, NodeRunStatus>>({})
  const [activeNode, setActiveNode] = useState<string | null>(null)
  const [execLogs, setExecLogs] = useState<LogEntry[]>([])
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false })
  const logEndRef = useRef<HTMLDivElement>(null)

  const nodeById = (id: string) => workflow.nodes.find((n) => n.id === id)

  // Auto-scroll log ke bawah saat ada baris baru.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [execLogs])

  async function runNow() {
    if (running) return
    if (workflow.nodes.length === 0) return
    setRunning(true)
    setExecLogs([])
    setActiveNode(null)
    // Reset semua node ke idle.
    const init: Record<string, NodeRunStatus> = {}
    workflow.nodes.forEach((n) => (init[n.id] = 'idle'))
    setNodeStatus(init)

    const abort = { aborted: false }
    abortRef.current = abort

    // Bikin run "running" dulu biar langsung nongol di halaman Runs.
    const runId = `run_${Date.now().toString(36)}_${Math.random()
      .toString(16)
      .slice(2, 5)}`
    const startedAtIso = new Date().toISOString()
    onRunStart({
      id: runId,
      task: `Eksekusi workflow: ${workflow.name}`,
      workflow: workflow.name,
      status: 'running',
      startedAt: startedAtIso,
      durationMs: 0,
      tokensUsed: 0,
      agentsInvolved: [],
      logs: [],
      output: '',
    })

    const finalRun = await runWorkflow({
      workflow,
      runId,
      startedAtIso,
      stepMs: 650,
      signal: abort,
      onEvent: (ev) => {
        setNodeStatus(ev.nodeStatus)
        setActiveNode(ev.activeNode)
        if (ev.log) {
          setExecLogs((prev) => [...prev, ev.log!])
          // Sinkronkan log ke run di store biar live di halaman Runs.
          const entry = ev.log
          onRunTick(runId, (r) => ({ ...r, logs: [...r.logs, entry] }))
        }
      },
    })

    // Tulis hasil final ke run yang sama (replace, bukan tambah baru).
    onRunTick(runId, () => finalRun)
    onRunComplete(finalRun)
    setRunning(false)
    setActiveNode(null)
  }

  function stopRun() {
    abortRef.current.aborted = true
  }

  // Konversi koordinat pointer ke koordinat canvas.
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: clientX - rect.left + (canvasRef.current?.scrollLeft ?? 0),
      y: clientY - rect.top + (canvasRef.current?.scrollTop ?? 0),
    }
  }, [])

  // Global pointer move/up saat drag/connect aktif.
  useEffect(() => {
    if (!drag) return

    function onMove(e: PointerEvent) {
      const p = toCanvas(e.clientX, e.clientY)
      if (drag!.mode === 'move') {
        const nx = Math.max(0, Math.min(CANVAS_W - NODE_W, p.x - drag!.dx))
        const ny = Math.max(0, Math.min(CANVAS_H - NODE_H, p.y - drag!.dy))
        onChange((w) => ({
          ...w,
          nodes: w.nodes.map((n) =>
            n.id === drag!.nodeId ? { ...n, x: nx, y: ny } : n,
          ),
        }))
      } else {
        setDrag({ ...drag!, x: p.x, y: p.y })
      }
    }

    function onUp(e: PointerEvent) {
      if (drag!.mode === 'connect') {
        // Hit-test geometris di koordinat canvas — nggak bergantung ke
        // paint/clip (elementFromPoint gagal kalau node ke-clip overflow
        // atau ketutup SVG overlay).
        const p = toCanvas(e.clientX, e.clientY)
        onChange((w) => {
          const target = w.nodes.find(
            (n) =>
              n.id !== drag!.from &&
              p.x >= n.x &&
              p.x <= n.x + NODE_W &&
              p.y >= n.y &&
              p.y <= n.y + NODE_H,
          )
          if (!target) return w
          const exists = w.edges.some(
            (ed) => ed.from === drag!.from && ed.to === target.id,
          )
          if (exists) return w
          return {
            ...w,
            edges: [...w.edges, { from: drag!.from, to: target.id }],
          }
        })
      }
      setDrag(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [drag, onChange, toCanvas])

  // Hapus node terpilih via keyboard.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        deleteNode(selected)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  function startMove(e: React.PointerEvent, node: WorkflowNode) {
    e.stopPropagation()
    setSelected(node.id)
    const p = toCanvas(e.clientX, e.clientY)
    setDrag({ mode: 'move', nodeId: node.id, dx: p.x - node.x, dy: p.y - node.y })
  }

  function startConnect(e: React.PointerEvent, node: WorkflowNode) {
    e.stopPropagation()
    const p = toCanvas(e.clientX, e.clientY)
    setDrag({ mode: 'connect', from: node.id, x: p.x, y: p.y })
  }

  function deleteNode(id: string) {
    onChange((w) => ({
      ...w,
      nodes: w.nodes.filter((n) => n.id !== id),
      edges: w.edges.filter((ed) => ed.from !== id && ed.to !== id),
    }))
    setSelected((s) => (s === id ? null : s))
  }

  function deleteEdge(from: string, to: string) {
    onChange((w) => ({
      ...w,
      edges: w.edges.filter((ed) => !(ed.from === from && ed.to === to)),
    }))
  }

  function addNode() {
    const def = kindDefaults[addKind]
    const node: WorkflowNode = {
      id: newId(),
      kind: addKind,
      label: def.label,
      sublabel: def.sublabel,
      // Taruh di area kosong dengan sedikit offset acak biar nggak numpuk.
      x: 120 + Math.round(Math.random() * 360),
      y: 60 + Math.round(Math.random() * 240),
    }
    onChange((w) => ({ ...w, nodes: [...w.nodes, node] }))
    setSelected(node.id)
  }

  function renameNode(id: string, label: string) {
    onChange((w) => ({
      ...w,
      nodes: w.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
    }))
  }

  const selectedNode = selected ? nodeById(selected) : undefined

  return (
    <Card>
      <CardHeader
        title={workflow.name}
        action={
          <div className="flex items-center gap-2">
            <Badge color="neutral">{workflow.nodes.length} node</Badge>
            {running ? (
              <Button variant="danger" size="sm" onClick={stopRun}>
                <StopIcon width={14} height={14} />
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={runNow}
                disabled={workflow.nodes.length === 0}
              >
                <PlayIcon width={14} height={14} />
                Jalankan
              </Button>
            )}
          </div>
        }
      />

      {/* Toolbar tambah node */}
      <div className="flex flex-wrap items-center gap-2 border-b-2 border-ink px-4 py-2.5">
        <span className="text-xs font-bold uppercase tracking-wider text-ink/50">
          Tambah:
        </span>
        <select
          value={addKind}
          onChange={(e) => setAddKind(e.target.value as NodeKind)}
          className="rounded-lg border-2 border-ink bg-paper px-2 py-1 text-xs font-semibold outline-none"
        >
          <option value="trigger">Trigger</option>
          <option value="agent">Agent</option>
          <option value="tool">Tool</option>
          <option value="output">Output</option>
        </select>
        <Button variant="secondary" size="sm" onClick={addNode}>
          <PlusIcon width={14} height={14} />
          Node
        </Button>

        {selectedNode && (
          <div className="ml-auto flex items-center gap-2">
            <input
              value={selectedNode.label}
              onChange={(e) => renameNode(selectedNode.id, e.target.value)}
              className="w-40 rounded-lg border-2 border-ink bg-cream px-2 py-1 text-xs font-semibold outline-none focus:bg-paper"
              placeholder="Nama node"
            />
            <Button
              variant="danger"
              size="sm"
              onClick={() => deleteNode(selectedNode.id)}
            >
              <TrashIcon width={14} height={14} />
              Hapus
            </Button>
          </div>
        )}
      </div>

      {/* Canvas */}
      <div
        ref={canvasRef}
        className="relative overflow-auto bg-grid"
        style={{ maxHeight: 460 }}
        onPointerDown={() => setSelected(null)}
      >
        <div
          className="relative select-none"
          style={{ width: CANVAS_W, height: CANVAS_H, touchAction: 'none' }}
        >
          {/* Edges */}
          <svg
            className="absolute inset-0"
            width={CANVAS_W}
            height={CANVAS_H}
          >
            <defs>
              <marker
                id="wf-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>

            {workflow.edges.map((e, i) => {
              const from = nodeById(e.from)
              const to = nodeById(e.to)
              if (!from || !to) return null
              const x1 = from.x + NODE_W
              const y1 = from.y + NODE_H / 2
              const x2 = to.x
              const y2 = to.y + NODE_H / 2
              const mx = (x1 + x2) / 2
              const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 6} ${y2}`
              return (
                <g key={i} className="text-ink">
                  {/* Jalur tebal transparan buat area klik yang lebih gede */}
                  <path
                    d={d}
                    stroke="transparent"
                    strokeWidth={14}
                    fill="none"
                    style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                    onClick={() => deleteEdge(e.from, e.to)}
                  >
                    <title>Klik buat hapus koneksi</title>
                  </path>
                  <path
                    d={d}
                    stroke="currentColor"
                    strokeWidth={2.2}
                    fill="none"
                    markerEnd="url(#wf-arrow)"
                    style={{ pointerEvents: 'none' }}
                  />
                </g>
              )
            })}

            {/* Garis koneksi sementara saat nge-drag */}
            {drag?.mode === 'connect' &&
              (() => {
                const from = nodeById(drag.from)
                if (!from) return null
                const x1 = from.x + NODE_W
                const y1 = from.y + NODE_H / 2
                return (
                  <path
                    d={`M ${x1} ${y1} L ${drag.x} ${drag.y}`}
                    stroke="#faae2a"
                    strokeWidth={2.5}
                    strokeDasharray="6 4"
                    fill="none"
                  />
                )
              })()}
          </svg>

          {/* Nodes */}
          {workflow.nodes.map((n) => (
            <NodeBox
              key={n.id}
              node={n}
              selected={selected === n.id}
              runStatus={nodeStatus[n.id] ?? 'idle'}
              active={activeNode === n.id}
              onMoveStart={(e) => startMove(e, n)}
              onConnectStart={(e) => startConnect(e, n)}
            />
          ))}
        </div>
      </div>

      {/* Panel log eksekusi — muncul saat/ setelah run */}
      {(running || execLogs.length > 0) && (
        <div className="border-t-2 border-ink">
          <div className="flex items-center justify-between px-4 py-2">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-ink/50">
              <span
                className={cn(
                  'inline-block h-2 w-2 rounded-full border border-ink',
                  running ? 'animate-pulse bg-ok' : 'bg-idle',
                )}
              />
              {running ? 'Eksekusi berjalan' : 'Log eksekusi terakhir'}
            </div>
            <button
              onClick={onViewRun}
              className="text-[11px] font-semibold text-ink/60 underline-offset-2 hover:underline"
            >
              Lihat di Runs →
            </button>
          </div>
          <div className="term max-h-40 overflow-y-auto border-t-2 border-ink p-3 font-mono text-xs leading-relaxed">
            {execLogs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="term-dim shrink-0">{log.ts}</span>
                <span className="term-accent shrink-0">[{log.agent}]</span>
                <span
                  className={cn(
                    'break-words',
                    log.level === 'error'
                      ? 'term-error'
                      : log.level === 'warn'
                        ? 'term-warn'
                        : log.level === 'debug'
                          ? 'term-dim'
                          : '',
                  )}
                >
                  {log.message}
                </span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      <div className="border-t-2 border-ink px-4 py-2 text-[11px] text-ink/50">
        Tip: klik <b>Jalankan</b> buat eksekusi workflow (node nyala sesuai
        urutan) · drag badan node buat mindahin · tarik titik kuning ke node
        lain buat nyambungin · klik garis buat hapus koneksi · pilih node lalu
        Delete buat hapus.
      </div>
    </Card>
  )
}

function NodeBox({
  node,
  selected,
  runStatus,
  active,
  onMoveStart,
  onConnectStart,
}: {
  node: WorkflowNode
  selected: boolean
  runStatus: NodeRunStatus
  active: boolean
  onMoveStart: (e: React.PointerEvent) => void
  onConnectStart: (e: React.PointerEvent) => void
}) {
  const style = kindStyle[node.kind]

  // Highlight ring berdasarkan status eksekusi.
  const statusRing =
    runStatus === 'running'
      ? 'ring-2 ring-sky shadow-hard-lg'
      : runStatus === 'done'
        ? 'ring-2 ring-ok'
        : runStatus === 'error'
          ? 'ring-2 ring-danger'
          : selected
            ? 'ring-2 ring-ink shadow-hard-lg'
            : ''

  return (
    <div
      data-node-id={node.id}
      onPointerDown={onMoveStart}
      className={cn(
        'absolute flex cursor-grab flex-col justify-center rounded-lg border-2 border-ink px-3 shadow-hard-sm transition-all active:cursor-grabbing',
        style.bg,
        statusRing,
        active && 'scale-[1.04]',
        runStatus === 'idle' && !selected ? '' : '',
      )}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <div className="flex items-center justify-between">
        <div className="text-[9px] font-bold uppercase tracking-widest text-ink/50">
          {style.tag}
        </div>
        {runStatus !== 'idle' && (
          <span
            className={cn(
              'flex h-3.5 w-3.5 items-center justify-center rounded-full border border-ink text-[8px] font-bold',
              runStatus === 'running'
                ? 'animate-pulse bg-sky'
                : runStatus === 'done'
                  ? 'bg-ok'
                  : 'bg-danger',
            )}
            title={runStatus}
          >
            {runStatus === 'done' ? '✓' : runStatus === 'error' ? '✕' : ''}
          </span>
        )}
      </div>
      <div className="truncate text-sm font-bold leading-tight">
        {node.label}
      </div>
      <div className="truncate text-[11px] text-ink/60">{node.sublabel}</div>

      {/* Port input (kiri) */}
      <span className="absolute -left-2 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-ink bg-cream" />

      {/* Port output (kanan) — drag dari sini buat connect */}
      <span
        onPointerDown={(e) => {
          e.stopPropagation()
          onConnectStart(e)
        }}
        title="Tarik ke node lain buat nyambungin"
        className="absolute -right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-ink bg-mustard hover:scale-125"
      />
    </div>
  )
}

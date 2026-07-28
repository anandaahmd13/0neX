import type { LogEntry, NodeKind, Run, Workflow } from '../types'

/*
  Engine eksekusi workflow (simulasi client-side).
  Traverse node secara topologis mulai dari trigger, ngikutin edge. Tiap
  node "dijalankan" dengan delay biar progress-nya kelihatan, sambil
  ngirim update status per-node + baris log. Di akhir bikin Run final.

  Ini simulasi (belum ada backend eksekusi beneran), tapi urutannya
  mengikuti graph asli yang digambar user, bukan hardcoded.
*/

export type NodeRunStatus = 'idle' | 'running' | 'done' | 'error'

export interface ExecEvent {
  /** Status per-node saat ini (id → status). */
  nodeStatus: Record<string, NodeRunStatus>
  /** Node yang lagi aktif (buat highlight), null kalau selesai. */
  activeNode: string | null
  /** Log terbaru yang baru ditambah (buat streaming). */
  log?: LogEntry
  /** True kalau eksekusi kelar. */
  done: boolean
}

const uid = () =>
  `run_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 5)}`

function nowTs(): string {
  return new Date().toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// Pesan log per jenis node.
const nodeLog: Record<NodeKind, (label: string) => string> = {
  trigger: (l) => `Trigger "${l}" aktif — memulai pipeline`,
  agent: (l) => `Agent "${l}" memproses input & memanggil model`,
  tool: (l) => `Menjalankan tool "${l}"`,
  output: (l) => `Menulis hasil ke output "${l}"`,
}

/**
 * Urutan eksekusi topologis: mulai dari node trigger (atau node tanpa
 * incoming edge), lalu telusuri edge secara BFS. Node yang nggak
 * terjangkau tetap dimasukin di akhir biar nggak ada yang keskip.
 */
export function execOrder(wf: Workflow): string[] {
  const incoming = new Map<string, number>()
  wf.nodes.forEach((n) => incoming.set(n.id, 0))
  wf.edges.forEach((e) => {
    if (incoming.has(e.to)) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)
  })

  const adj = new Map<string, string[]>()
  wf.edges.forEach((e) => {
    const arr = adj.get(e.from) ?? []
    arr.push(e.to)
    adj.set(e.from, arr)
  })

  // Titik masuk: node kind trigger dulu, lalu node lain tanpa incoming edge.
  const roots = wf.nodes
    .filter((n) => (incoming.get(n.id) ?? 0) === 0)
    .sort((a, b) => (a.kind === 'trigger' ? -1 : 0) - (b.kind === 'trigger' ? -1 : 0))
    .map((n) => n.id)

  const visited = new Set<string>()
  const order: string[] = []
  const queue = [...roots]

  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      if (!visited.has(next)) queue.push(next)
    }
  }

  // Node sisa yang belum terjangkau (graph terputus).
  for (const n of wf.nodes) {
    if (!visited.has(n.id)) order.push(n.id)
  }

  return order
}

interface RunOptions {
  workflow: Workflow
  /** ID run yang dipakai (biar konsisten start→finish). Default auto. */
  runId?: string
  /** Timestamp mulai (ISO). Default sekarang. */
  startedAtIso?: string
  /** Delay antar-node (ms). Default 700. */
  stepMs?: number
  /** Callback tiap ada event (status / log / selesai). */
  onEvent: (ev: ExecEvent) => void
  /** Sinyal batal. */
  signal?: { aborted: boolean }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Jalankan workflow secara bertahap. Mengembalikan Run final.
 * Memanggil onEvent tiap perubahan biar UI bisa nge-highlight node & log.
 */
export async function runWorkflow({
  workflow,
  runId,
  startedAtIso,
  stepMs = 700,
  onEvent,
  signal,
}: RunOptions): Promise<Run> {
  const order = execOrder(workflow)
  const nodeStatus: Record<string, NodeRunStatus> = {}
  workflow.nodes.forEach((n) => (nodeStatus[n.id] = 'idle'))

  const logs: LogEntry[] = []
  const agentsInvolved = new Set<string>()
  const startedAt = startedAtIso ? new Date(startedAtIso) : new Date()
  let tokens = 0

  const emit = (activeNode: string | null, log?: LogEntry, done = false) => {
    if (log) logs.push(log)
    onEvent({ nodeStatus: { ...nodeStatus }, activeNode, log, done })
  }

  emit(null, {
    ts: nowTs(),
    level: 'info',
    agent: 'Orchestrator',
    message: `Menjalankan workflow "${workflow.name}" — ${order.length} langkah`,
  })

  for (const id of order) {
    if (signal?.aborted) break
    const node = workflow.nodes.find((n) => n.id === id)
    if (!node) continue

    // Node mulai jalan.
    nodeStatus[id] = 'running'
    const agent =
      node.kind === 'agent' ? node.label : 'Orchestrator'
    if (node.kind === 'agent') agentsInvolved.add(node.label)
    emit(id, {
      ts: nowTs(),
      level: node.kind === 'tool' ? 'debug' : 'info',
      agent,
      message: nodeLog[node.kind](node.label),
    })

    await delay(stepMs)
    if (signal?.aborted) {
      nodeStatus[id] = 'error'
      break
    }

    // Simulasi token yang kepakai per node agent/tool.
    if (node.kind === 'agent') tokens += 12_000 + Math.round(Math.random() * 40_000)
    if (node.kind === 'tool') tokens += 1_500 + Math.round(Math.random() * 6_000)

    nodeStatus[id] = 'done'
    emit(id, {
      ts: nowTs(),
      level: 'info',
      agent,
      message: `"${node.label}" selesai ✓`,
    })
  }

  const aborted = signal?.aborted ?? false
  const finishedAt = new Date()
  const durationMs = finishedAt.getTime() - startedAt.getTime()

  const outputNode = workflow.nodes.find((n) => n.kind === 'output')
  const output = aborted
    ? 'Run dibatalkan sebelum selesai.'
    : `Workflow selesai. ${order.length} node dieksekusi${
        outputNode ? `, hasil dikirim ke "${outputNode.label}"` : ''
      }.`

  const finalLog: LogEntry = {
    ts: nowTs(),
    level: aborted ? 'warn' : 'info',
    agent: 'Orchestrator',
    message: aborted ? 'Eksekusi dihentikan' : 'Semua langkah kelar 🎉',
  }
  emit(null, finalLog, true)

  const run: Run = {
    id: runId ?? uid(),
    task: `Eksekusi workflow: ${workflow.name}`,
    workflow: workflow.name,
    status: aborted ? 'failed' : 'success',
    startedAt: startedAt.toISOString(),
    durationMs,
    tokensUsed: tokens,
    agentsInvolved: [...agentsInvolved],
    logs,
    output,
  }
  return run
}

export { uid as newRunId }

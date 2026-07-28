import { useState } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { PageTitle } from '../components/PageTitle'
import { PlusIcon, BoltIcon } from '../components/icons'
import { workflows } from '../data/mock'
import type { Workflow, WorkflowNode, NodeKind } from '../types'
import { fmtInt, fmtTime } from '../lib/format'
import { cn } from '../lib/cn'

const NODE_W = 150
const NODE_H = 64

const kindStyle: Record<NodeKind, { bg: string; tag: string }> = {
  trigger: { bg: 'bg-sky', tag: 'TRIGGER' },
  agent: { bg: 'bg-mustard', tag: 'AGENT' },
  tool: { bg: 'bg-paper', tag: 'TOOL' },
  output: { bg: 'bg-ok', tag: 'OUTPUT' },
}

export function Workflows() {
  const [activeId, setActiveId] = useState(workflows[0].id)
  const active = workflows.find((w) => w.id === activeId)!

  return (
    <div className="space-y-6">
      <PageTitle
        title="Workflows"
        subtitle="Rangkai agent jadi alur kerja. Drag node buat nyusun pipeline."
        action={
          <Button variant="primary">
            <PlusIcon width={16} height={16} />
            Workflow baru
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Workflow list */}
        <div className="space-y-3">
          {workflows.map((w) => (
            <button
              key={w.id}
              onClick={() => setActiveId(w.id)}
              className={cn(
                'w-full rounded-xl border-2 border-ink p-4 text-left transition-all',
                w.id === activeId
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

        {/* Canvas */}
        <Card>
          <CardHeader
            title={active.name}
            action={
              <div className="flex gap-2">
                <Badge color="neutral">{active.nodes.length} node</Badge>
                <Button variant="secondary" size="sm">
                  Jalankan
                </Button>
              </div>
            }
          />
          <WorkflowCanvas workflow={active} />
        </Card>
      </div>
    </div>
  )
}

function WorkflowCanvas({ workflow }: { workflow: Workflow }) {
  const width = 980
  const height = 360
  const nodeById = (id: string) => workflow.nodes.find((n) => n.id === id)!

  return (
    <div className="overflow-x-auto bg-grid p-2">
      <div className="relative" style={{ width, height }}>
        {/* Edges */}
        <svg
          className="absolute inset-0"
          width={width}
          height={height}
          style={{ pointerEvents: 'none' }}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#1a1a1a" />
            </marker>
          </defs>
          {workflow.edges.map((e, i) => {
            const from = nodeById(e.from)
            const to = nodeById(e.to)
            const x1 = from.x + NODE_W
            const y1 = from.y + NODE_H / 2
            const x2 = to.x
            const y2 = to.y + NODE_H / 2
            const mx = (x1 + x2) / 2
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 6} ${y2}`}
                stroke="#1a1a1a"
                strokeWidth={2.2}
                fill="none"
                markerEnd="url(#arrow)"
              />
            )
          })}
        </svg>

        {/* Nodes */}
        {workflow.nodes.map((n) => (
          <NodeBox key={n.id} node={n} />
        ))}
      </div>
    </div>
  )
}

function NodeBox({ node }: { node: WorkflowNode }) {
  const style = kindStyle[node.kind]
  return (
    <div
      className={cn(
        'absolute flex flex-col justify-center rounded-lg border-2 border-ink px-3 shadow-hard-sm',
        style.bg,
      )}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <div className="text-[9px] font-bold uppercase tracking-widest text-ink/50">
        {style.tag}
      </div>
      <div className="truncate text-sm font-bold leading-tight">{node.label}</div>
      <div className="truncate text-[11px] text-ink/60">{node.sublabel}</div>
    </div>
  )
}

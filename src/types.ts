// Domain types for 0neX — AI agent orchestration platform.

export type AgentStatus = 'active' | 'idle' | 'error' | 'paused'

export interface Agent {
  id: string
  name: string
  role: string
  model: string
  status: AgentStatus
  description: string
  tools: string[]
  tokensUsed: number
  requests: number
  successRate: number
  avgLatencyMs: number
  createdAt: string
}

export type RunStatus = 'running' | 'success' | 'failed' | 'queued'

export interface LogEntry {
  ts: string
  level: 'info' | 'warn' | 'error' | 'debug'
  agent: string
  message: string
}

export interface Run {
  id: string
  task: string
  workflow: string
  status: RunStatus
  startedAt: string
  durationMs: number
  tokensUsed: number
  agentsInvolved: string[]
  logs: LogEntry[]
  output: string
}

export type NodeKind = 'trigger' | 'agent' | 'tool' | 'output'

export interface WorkflowNode {
  id: string
  kind: NodeKind
  label: string
  sublabel: string
  x: number
  y: number
}

export interface WorkflowEdge {
  from: string
  to: string
}

export interface Workflow {
  id: string
  name: string
  description: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  runs: number
  lastRun: string
}

export interface TimePoint {
  label: string
  value: number
}

import { useCallback, useState } from 'react'

export interface Pane {
  id: string
  sessionId: string
  agentId: string
  connectionId: string
  title: string
  transcript: string[]
  turns: number
  createdAt: number
}

const STORAGE_KEY = 'onex.gateway.panes'
const LEGACY_STORAGE_KEY = 'onex.claude.panes'
const DEFAULT_AGENT_ID = 'agt_coder'
export const MAX_PANES = 4
const MAX_LINES = 2000

function load(): Pane[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((pane) => pane && typeof pane.id === 'string' && typeof pane.sessionId === 'string')
      .map((pane) => ({
        ...pane,
        agentId: typeof pane.agentId === 'string' ? pane.agentId : DEFAULT_AGENT_ID,
        connectionId: typeof pane.connectionId === 'string' ? pane.connectionId : '',
        transcript: Array.isArray(pane.transcript) ? pane.transcript.slice(-MAX_LINES) : [],
        turns: typeof pane.turns === 'number' ? pane.turns : 0,
      })) as Pane[]
  } catch {
    return []
  }
}

function save(panes: Pane[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(panes))
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // Persistence bersifat best-effort.
  }
}

function makePane(agentId = DEFAULT_AGENT_ID): Pane {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    agentId,
    connectionId: '',
    title: 'Sesi baru',
    transcript: [],
    turns: 0,
    createdAt: Date.now(),
  }
}

export function usePanes() {
  const [panes, setPanes] = useState<Pane[]>(load)

  const persist = useCallback((next: Pane[]) => {
    save(next)
    return next
  }, [])

  const addPane = useCallback(
    (agentId?: string) => {
      setPanes((previous) =>
        previous.length >= MAX_PANES
          ? previous
          : persist([...previous, makePane(agentId)]),
      )
    },
    [persist],
  )

  const removePane = useCallback(
    (id: string) => setPanes((previous) => persist(previous.filter((pane) => pane.id !== id))),
    [persist],
  )

  const appendOutput = useCallback(
    (id: string, lines: string[]) => {
      if (!lines.length) return
      setPanes((previous) =>
        persist(
          previous.map((pane) =>
            pane.id === id
              ? { ...pane, transcript: [...pane.transcript, ...lines].slice(-MAX_LINES) }
              : pane,
          ),
        ),
      )
    },
    [persist],
  )

  const setSession = useCallback(
    (id: string, sessionId: string) => {
      if (!sessionId) return
      setPanes((previous) =>
        persist(
          previous.map((pane) =>
            pane.id === id ? { ...pane, sessionId } : pane,
          ),
        ),
      )
    },
    [persist],
  )

  const bumpTurn = useCallback(
    (id: string) =>
      setPanes((previous) =>
        persist(
          previous.map((pane) =>
            pane.id === id ? { ...pane, turns: pane.turns + 1 } : pane,
          ),
        ),
      ),
    [persist],
  )

  const setTitle = useCallback(
    (id: string, title: string) =>
      setPanes((previous) =>
        persist(previous.map((pane) => (pane.id === id ? { ...pane, title } : pane))),
      ),
    [persist],
  )

  const resetPane = useCallback(
    (id: string) =>
      setPanes((previous) =>
        persist(
          previous.map((pane) =>
            pane.id === id
              ? {
                  ...pane,
                  sessionId: crypto.randomUUID(),
                  transcript: [],
                  turns: 0,
                  title: 'Sesi baru',
                }
              : pane,
          ),
        ),
      ),
    [persist],
  )

  const setAgent = useCallback(
    (id: string, agentId: string) =>
      setPanes((previous) =>
        persist(
          previous.map((pane) =>
            pane.id === id && pane.agentId !== agentId
              ? {
                  ...pane,
                  agentId,
                  connectionId: '',
                  sessionId: crypto.randomUUID(),
                  transcript: [],
                  turns: 0,
                  title: 'Sesi baru',
                }
              : pane,
          ),
        ),
      ),
    [persist],
  )

  const setConnection = useCallback(
    (id: string, connectionId: string) =>
      setPanes((previous) =>
        persist(
          previous.map((pane) =>
            pane.id === id && pane.connectionId !== connectionId
              ? {
                  ...pane,
                  connectionId,
                  sessionId: crypto.randomUUID(),
                  transcript: [],
                  turns: 0,
                  title: 'Sesi baru',
                }
              : pane,
          ),
        ),
      ),
    [persist],
  )

  return {
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
  }
}

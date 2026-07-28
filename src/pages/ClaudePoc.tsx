import { useEffect, useRef, useState } from 'react'
import { Card, CardHeader, CardBody } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { PageTitle } from '../components/PageTitle'
import { SendIcon, StopIcon, PlusIcon, CloseIcon, TrashIcon } from '../components/icons'
import { useClaudeStream } from '../lib/useClaudeStream'
import type { ClaudeStatus } from '../lib/useClaudeStream'
import { usePanes, MAX_PANES } from '../lib/usePanes'
import type { Pane } from '../lib/usePanes'
import { cn } from '../lib/cn'

const statusMeta: Record<ClaudeStatus, { label: string; dot: string }> = {
  idle: { label: 'Idle', dot: 'bg-ink/30' },
  connecting: { label: 'Menyambung…', dot: 'bg-sky' },
  running: { label: 'Running', dot: 'bg-mustard' },
  done: { label: 'Selesai', dot: 'bg-ok' },
  error: { label: 'Error', dot: 'bg-danger' },
}

// Klasifikasi baris transcript buat styling. Prefix di-set saat nulis (prompt
// user, chunk stderr/error, atau baris meta dari bridge).
function lineClass(line: string): string {
  if (line.startsWith('❯ ')) return 'text-mustard font-bold'
  if (line.startsWith('[stderr]') || line.startsWith('[error]')) return 'term-error'
  if (line.startsWith('↻ ') || line.startsWith('⏹ ') || line.startsWith('system:'))
    return 'term-dim2'
  return ''
}

interface PaneCardProps {
  pane: Pane
  canClose: boolean
  onRemove: (id: string) => void
  onReset: (id: string) => void
  onAppend: (id: string, lines: string[]) => void
  onBump: (id: string) => void
  onTitle: (id: string, title: string) => void
}

/**
 * Satu pane percakapan Claude. Punya instance useClaudeStream sendiri (satu run
 * aktif per pane) + prompt lokal. Konteks nyambung via pane.sessionId: run
 * pertama (turns=0) bikin sesi, run berikutnya (turns>0) resume.
 */
function PaneCard({
  pane,
  canClose,
  onRemove,
  onReset,
  onAppend,
  onBump,
  onTitle,
}: PaneCardProps) {
  const [prompt, setPrompt] = useState('')
  const { run, stop, status } = useClaudeStream()
  const termRef = useRef<HTMLDivElement>(null)
  const busy = status === 'connecting' || status === 'running'
  const meta = statusMeta[status]

  // Auto-scroll ke bawah tiap transcript nambah.
  useEffect(() => {
    const el = termRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [pane.transcript])

  function handleRun() {
    const trimmed = prompt.trim()
    if (!trimmed || busy) return
    const isFirst = pane.turns === 0
    onAppend(pane.id, [`❯ ${trimmed}`])
    if (isFirst) onTitle(pane.id, trimmed.slice(0, 60))
    run(
      trimmed,
      { sessionId: pane.sessionId, resume: pane.turns > 0 },
      {
        onChunk: (text, level) => {
          const prefix = level === 'error' ? '[stderr] ' : ''
          onAppend(pane.id, text.split('\n').map((l) => prefix + l))
        },
        onError: (text) => onAppend(pane.id, [`[error] ${text}`]),
        onDone: () => onBump(pane.id),
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
              title="Mulai sesi baru (reset konteks)"
              className="press flex cursor-pointer items-center gap-1 rounded-md border-2 border-ink bg-cream px-1.5 py-1 text-[10px] font-bold uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-50"
            >
              <TrashIcon width={12} height={12} />
              Reset
            </button>
            {canClose && (
              <button
                onClick={() => onRemove(pane.id)}
                disabled={busy}
                title="Tutup pane"
                className="press cursor-pointer rounded-md border-2 border-ink bg-cream p-1 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CloseIcon width={12} height={12} />
              </button>
            )}
          </div>
        }
      />
      <CardBody className="flex flex-1 flex-col gap-3">
        <div
          ref={termRef}
          className="term h-72 overflow-y-auto rounded-lg border-2 border-ink p-3 font-mono text-xs leading-relaxed"
        >
          {pane.transcript.length === 0 ? (
            <span className="term-dim">
              Mulai percakapan — konteks bakal nyambung tiap giliran…
            </span>
          ) : (
            pane.transcript.map((line, i) => (
              <div key={i} className={cn('whitespace-pre-wrap break-words', lineClass(line))}>
                {line}
              </div>
            ))
          )}
          {busy && (
            <div className="term-dim2 mt-1 flex items-center gap-2">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-ok" />
              streaming…
            </div>
          )}
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter buat kirim cepat.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              handleRun()
            }
          }}
          rows={2}
          disabled={busy}
          placeholder={pane.turns > 0 ? 'Lanjutin percakapan…' : 'Ketik prompt buat Claude…'}
          className="w-full resize-none rounded-lg border-2 border-ink bg-cream px-3 py-2 font-mono text-sm outline-none placeholder:text-ink/40 focus:bg-paper disabled:opacity-60"
        />

        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-ink/50">
            sesi {pane.sessionId.slice(0, 8)} · {pane.turns} giliran
          </span>
          {busy ? (
            <Button variant="ghost" size="sm" onClick={() => stop()}>
              <StopIcon width={14} height={14} />
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={handleRun}
              disabled={!prompt.trim()}
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

export function ClaudePoc() {
  const { panes, addPane, removePane, appendOutput, bumpTurn, setTitle, resetPane } =
    usePanes()
  const full = panes.length >= MAX_PANES

  return (
    <div className="space-y-6">
      <PageTitle
        title="Claude Code POC"
        subtitle="Multi-pane, tiap pane punya sesi sendiri — konteks nyambung lintas giliran & reload."
      />

      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-ink/60">
          {panes.length} / {MAX_PANES} pane
        </span>
        <Button variant="primary" size="sm" onClick={addPane} disabled={full}>
          <PlusIcon width={16} height={16} />
          Tambah Pane
        </Button>
      </div>

      {panes.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-ink/60">
              Belum ada sesi. Bikin pane buat mulai ngobrol sama Claude Code.
            </p>
            <Button variant="primary" onClick={addPane}>
              <PlusIcon width={16} height={16} />
              Mulai sesi baru
            </Button>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {panes.map((pane) => (
            <PaneCard
              key={pane.id}
              pane={pane}
              canClose={panes.length > 1}
              onRemove={removePane}
              onReset={resetPane}
              onAppend={appendOutput}
              onBump={bumpTurn}
              onTitle={setTitle}
            />
          ))}
        </div>
      )}
    </div>
  )
}

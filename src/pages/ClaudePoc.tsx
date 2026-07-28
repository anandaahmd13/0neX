import { useEffect, useRef, useState } from 'react'
import { Card, CardHeader, CardBody } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { PageTitle } from '../components/PageTitle'
import { SendIcon, StopIcon } from '../components/icons'
import { useClaudeStream } from '../lib/useClaudeStream'
import type { ClaudeStatus } from '../lib/useClaudeStream'
import { cn } from '../lib/cn'

const DEFAULT_PROMPT =
  'Tulis fungsi TypeScript buat cek palindrom, plus 3 unit test'

const statusMeta: Record<ClaudeStatus, { label: string; dot: string }> = {
  idle: { label: 'Idle', dot: 'bg-ink/30' },
  connecting: { label: 'Menyambung…', dot: 'bg-sky' },
  running: { label: 'Running', dot: 'bg-mustard' },
  done: { label: 'Selesai', dot: 'bg-ok' },
  error: { label: 'Error', dot: 'bg-danger' },
}

export function ClaudePoc() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const { run, stop, output, status } = useClaudeStream()
  const termRef = useRef<HTMLDivElement>(null)

  const busy = status === 'connecting' || status === 'running'

  // Auto-scroll ke bawah tiap ada chunk baru.
  useEffect(() => {
    const el = termRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])

  const meta = statusMeta[status]

  return (
    <div className="space-y-6">
      <PageTitle
        title="Claude Code POC"
        subtitle="Panggil Claude Code CLI headless, streaming output real-time lewat WebSocket."
      />

      <Card>
        <CardHeader title="Prompt" />
        <CardBody className="space-y-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            disabled={busy}
            placeholder="Ketik prompt buat Claude Code…"
            className="w-full resize-none rounded-lg border-2 border-ink bg-cream px-3 py-2 font-mono text-sm outline-none placeholder:text-ink/40 focus:bg-paper disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink/60">
              <span
                className={cn(
                  'inline-block h-2.5 w-2.5 rounded-full border border-ink',
                  meta.dot,
                  busy && 'animate-pulse',
                )}
              />
              {meta.label}
            </div>
            {busy ? (
              <Button variant="ghost" onClick={() => stop()}>
                <StopIcon width={16} height={16} />
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => run(prompt)}
                disabled={!prompt.trim()}
              >
                <SendIcon width={16} height={16} />
                Jalankan Claude
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Card className="flex flex-col">
        <CardHeader title="Output" />
        <CardBody>
          <div
            ref={termRef}
            className="term max-h-[28rem] min-h-[12rem] overflow-y-auto rounded-lg border-2 border-ink p-3 font-mono text-xs leading-relaxed"
          >
            {output.length === 0 ? (
              <span className="term-dim">
                Output Claude Code bakal muncul di sini…
              </span>
            ) : (
              output.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    'whitespace-pre-wrap break-words',
                    line.startsWith('[stderr]') || line.startsWith('[error]')
                      ? 'term-error'
                      : '',
                  )}
                >
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
        </CardBody>
      </Card>
    </div>
  )
}

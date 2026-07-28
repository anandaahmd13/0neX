import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { cn } from './cn'

export type ToastKind = 'info' | 'success' | 'error' | 'warn'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastCtx {
  toasts: Toast[]
  push: (message: string, kind?: ToastKind) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastCtx | null>(null)

const AUTO_DISMISS_MS = 3500

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId.current++
      setToasts((prev) => [...prev, { id, kind, message }])
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={{ toasts, push, dismiss }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

const kindStyle: Record<ToastKind, string> = {
  info: 'bg-sky',
  success: 'bg-ok',
  error: 'bg-danger',
  warn: 'bg-mustard',
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-xs flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-lg border-2 border-ink px-3 py-2.5 text-left text-sm font-semibold text-ink shadow-hard transition-all',
            kindStyle[t.kind],
          )}
        >
          <span className="mt-0.5 shrink-0 font-mono text-xs">
            {t.kind === 'success'
              ? '✓'
              : t.kind === 'error'
                ? '✕'
                : t.kind === 'warn'
                  ? '!'
                  : 'i'}
          </span>
          <span className="min-w-0 flex-1">{t.message}</span>
        </button>
      ))}
    </div>
  )
}

export function useToast(): ToastCtx {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast harus dipakai di dalam ToastProvider')
  return ctx
}

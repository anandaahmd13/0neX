import { randomUUID } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 30_000

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function cancellation() {
  return { outcome: { outcome: 'cancelled' } }
}

function safeOptions(options) {
  if (!Array.isArray(options)) return []
  return options
    .filter((option) => option && typeof option.optionId === 'string' && option.optionId)
    .map((option) => ({
      optionId: option.optionId,
      kind: typeof option.kind === 'string' ? option.kind : 'unknown',
      name: typeof option.name === 'string' ? option.name : option.optionId,
    }))
}

export function createPermissionBroker({
  runId,
  policy = 'none',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  send,
  now = Date.now,
} = {}) {
  const effectiveTimeoutMs = positiveNumber(timeoutMs, DEFAULT_TIMEOUT_MS)
  const pending = new Map()
  const settled = new Set()
  let closed = false

  function request(params = {}) {
    if (closed || policy !== 'standard') return Promise.resolve(cancellation())
    const options = safeOptions(params.options)
    if (options.length === 0) return Promise.resolve(cancellation())

    const requestId = `perm_${randomUUID()}`
    const expiresAt = now() + effectiveTimeoutMs
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const entry = pending.get(requestId)
        if (!entry) return
        pending.delete(requestId)
        settled.add(requestId)
        entry.resolve(cancellation())
      }, effectiveTimeoutMs)
      timer.unref?.()
      pending.set(requestId, {
        resolve,
        timer,
        optionIds: new Set(options.map((option) => option.optionId)),
      })
      send?.({
        type: 'permission_request',
        runId,
        requestId,
        toolCall: params.toolCall ?? null,
        options,
        expiresAt,
      })
    })
  }

  function respond(message = {}) {
    if (closed) return { ok: false, code: 'permission_broker_closed' }
    if (message.runId !== runId) return { ok: false, code: 'permission_run_mismatch' }
    if (settled.has(message.requestId)) return { ok: false, code: 'permission_already_settled' }
    const entry = pending.get(message.requestId)
    if (!entry) return { ok: false, code: 'permission_not_found' }
    if (!entry.optionIds.has(message.optionId)) {
      return { ok: false, code: 'permission_option_invalid' }
    }

    pending.delete(message.requestId)
    settled.add(message.requestId)
    clearTimeout(entry.timer)
    entry.resolve({ outcome: { outcome: 'selected', optionId: message.optionId } })
    return { ok: true }
  }

  function close() {
    if (closed) return
    closed = true
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timer)
      settled.add(requestId)
      entry.resolve(cancellation())
    }
    pending.clear()
  }

  return { request, respond, close }
}

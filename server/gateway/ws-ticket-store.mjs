import { randomBytes } from 'node:crypto'

const DEFAULT_TTL_MS = 30_000
const MAX_TICKETS = 1_000

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function createWsTicketStore({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const lifetimeMs = positiveNumber(ttlMs, DEFAULT_TTL_MS)
  const tickets = new Map()

  function sweep(timestamp = now()) {
    for (const [ticket, record] of tickets) {
      if (record.expiresAt <= timestamp) tickets.delete(ticket)
    }
    while (tickets.size > MAX_TICKETS) tickets.delete(tickets.keys().next().value)
  }

  function issue({ origin, subject = 'admin' } = {}) {
    if (typeof origin !== 'string' || !origin) {
      throw new TypeError('WebSocket ticket membutuhkan origin')
    }
    sweep()
    const ticket = `wst_${randomBytes(32).toString('base64url')}`
    const expiresAt = now() + lifetimeMs
    tickets.set(ticket, { origin, subject: String(subject), expiresAt })
    return { ticket, expiresAt }
  }

  function consume(ticket, { origin } = {}) {
    if (typeof ticket !== 'string' || !ticket) return null
    const timestamp = now()
    sweep(timestamp)
    const record = tickets.get(ticket)
    if (!record) return null
    // Consumption is destructive even on an origin mismatch. A leaked ticket
    // cannot be probed repeatedly until the legitimate browser uses it.
    tickets.delete(ticket)
    if (record.expiresAt <= timestamp || record.origin !== origin) return null
    return { subject: record.subject, origin: record.origin, expiresAt: record.expiresAt }
  }

  function clear() {
    tickets.clear()
  }

  return { issue, consume, sweep, clear, ttlMs: lifetimeMs }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { createWsTicketStore } from '../server/gateway/ws-ticket-store.mjs'

test('WebSocket tickets are origin-bound and one-time', () => {
  let timestamp = 1_000
  const store = createWsTicketStore({ ttlMs: 500, now: () => timestamp })
  const issued = store.issue({ origin: 'https://dashboard.example', subject: 'admin' })

  assert.match(issued.ticket, /^wst_/)
  assert.equal(issued.expiresAt, 1_500)
  assert.deepEqual(store.consume(issued.ticket, { origin: 'https://dashboard.example' }), {
    subject: 'admin',
    origin: 'https://dashboard.example',
    expiresAt: 1_500,
  })
  assert.equal(store.consume(issued.ticket, { origin: 'https://dashboard.example' }), null)
})

test('origin mismatch burns a ticket and expired tickets fail closed', () => {
  let timestamp = 1_000
  const store = createWsTicketStore({ ttlMs: 100, now: () => timestamp })
  const mismatch = store.issue({ origin: 'https://allowed.example' })
  assert.equal(store.consume(mismatch.ticket, { origin: 'https://evil.example' }), null)
  assert.equal(store.consume(mismatch.ticket, { origin: 'https://allowed.example' }), null)

  const expired = store.issue({ origin: 'https://allowed.example' })
  timestamp = 1_101
  assert.equal(store.consume(expired.ticket, { origin: 'https://allowed.example' }), null)
})

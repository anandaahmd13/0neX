import assert from 'node:assert/strict'
import test from 'node:test'
import { createPermissionBroker } from '../server/gateway/ws-permission-broker.mjs'

const PARAMS = {
  toolCall: { toolCallId: 'tool-1', title: 'Read config', kind: 'read' },
  options: [
    { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
  ],
}

test('permission broker selects only an offered option for the active run', async () => {
  const sent = []
  const broker = createPermissionBroker({
    runId: 'run-1',
    policy: 'standard',
    timeoutMs: 500,
    now: () => 100,
    send: (event) => sent.push(event),
  })
  const decision = broker.request(PARAMS)
  const request = sent[0]

  assert.equal(request.type, 'permission_request')
  assert.equal(request.runId, 'run-1')
  assert.equal(request.expiresAt, 600)
  assert.equal(broker.respond({
    runId: 'other-run',
    requestId: request.requestId,
    optionId: 'allow',
  }).code, 'permission_run_mismatch')
  assert.equal(broker.respond({
    runId: 'run-1',
    requestId: request.requestId,
    optionId: 'forged',
  }).code, 'permission_option_invalid')
  assert.deepEqual(broker.respond({
    runId: 'run-1',
    requestId: request.requestId,
    optionId: 'allow',
  }), { ok: true })
  assert.deepEqual(await decision, {
    outcome: { outcome: 'selected', optionId: 'allow' },
  })
  assert.equal(broker.respond({
    runId: 'run-1',
    requestId: request.requestId,
    optionId: 'allow',
  }).code, 'permission_already_settled')
})

test('permission broker rejects by policy, timeout, and disconnect', async () => {
  const denied = createPermissionBroker({ runId: 'none', policy: 'none' })
  assert.deepEqual(await denied.request(PARAMS), { outcome: { outcome: 'cancelled' } })

  const timedEvents = []
  const timed = createPermissionBroker({
    runId: 'timed',
    policy: 'standard',
    timeoutMs: 10,
    send: (event) => timedEvents.push(event),
  })
  const timeoutDecision = timed.request(PARAMS)
  assert.deepEqual(await timeoutDecision, { outcome: { outcome: 'cancelled' } })
  assert.equal(timed.respond({
    runId: 'timed',
    requestId: timedEvents[0].requestId,
    optionId: 'allow',
  }).code, 'permission_already_settled')

  const disconnected = createPermissionBroker({ runId: 'closed', policy: 'standard' })
  const disconnectDecision = disconnected.request(PARAMS)
  disconnected.close()
  assert.deepEqual(await disconnectDecision, { outcome: { outcome: 'cancelled' } })
})

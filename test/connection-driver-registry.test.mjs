import assert from 'node:assert/strict'
import test from 'node:test'
import { createConnectionDriverRegistry } from '../server/gateway/connection-driver-registry.mjs'

function driver(id, kinds = [id]) {
  return { id, kinds, async attempt() {} }
}

test('connection driver registry resolves connection kinds', () => {
  const openai = driver('openai-http')
  const kiro = driver('kiro-inference', ['kiro-cli'])
  const registry = createConnectionDriverRegistry([openai, kiro])

  assert.equal(registry.forConnection({ kind: 'openai-http' }), openai)
  assert.equal(registry.forConnection({ kind: 'kiro-cli' }), kiro)
  assert.equal(registry.forConnection({ kind: 'unknown' }), null)
  assert.deepEqual(registry.list(), [openai, kiro])
})

test('connection driver registry rejects invalid and duplicate registrations', () => {
  assert.throws(
    () => createConnectionDriverRegistry([{ id: 'broken' }]),
    /harus punya id dan attempt/,
  )
  assert.throws(
    () => createConnectionDriverRegistry([
      driver('first', ['shared']),
      driver('second', ['shared']),
    ]),
    /sudah ditangani/,
  )
})

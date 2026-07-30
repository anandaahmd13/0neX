import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  AcpTransportError,
  createNdjsonRpcTransport,
} from '../server/gateway/kiro-transport.mjs'

class ControlledStdin extends EventEmitter {
  constructor({ backpressure = false } = {}) {
    super()
    this.writable = true
    this.backpressure = backpressure
    this.writes = []
  }

  write(value, callback) {
    this.writes.push(String(value))
    queueMicrotask(() => callback?.())
    if (this.backpressure) {
      this.backpressure = false
      return false
    }
    return true
  }

  end() {
    this.writable = false
  }
}

function createChild(options = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stdin = new ControlledStdin(options)
  return child
}

function writtenMessages(child) {
  return child.stdin.writes
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function send(child, message) {
  child.stdout.write(`${JSON.stringify(message)}\n`)
}

test('queues writes while stdin is backpressured and resumes on drain', async () => {
  const child = createChild({ backpressure: true })
  const transport = createNdjsonRpcTransport(child, { requestTimeoutMs: 500 })

  const first = transport.request('first', { value: 1 })
  const second = transport.request('second', { value: 2 })
  assert.deepEqual(writtenMessages(child).map((message) => message.method), ['first'])

  child.stdin.emit('drain')
  assert.deepEqual(writtenMessages(child).map((message) => message.method), ['first', 'second'])

  send(child, { jsonrpc: '2.0', id: 0, result: 'one' })
  send(child, { jsonrpc: '2.0', id: 1, result: 'two' })
  assert.deepEqual(await Promise.all([first, second]), ['one', 'two'])
  transport.close()
})

test('times out each request independently and ignores a late response', async () => {
  const child = createChild()
  const transport = createNdjsonRpcTransport(child, { requestTimeoutMs: 20 })

  const request = transport.request('slow', {})
  await assert.rejects(
    request,
    (error) => error instanceof AcpTransportError
      && error.code === 'KIRO_ACP_REQUEST_TIMEOUT'
      && /slow/.test(error.message),
  )

  send(child, { jsonrpc: '2.0', id: 0, result: 'late' })
  const next = transport.request('next', {})
  send(child, { jsonrpc: '2.0', id: 1, result: 'ok' })
  assert.equal(await next, 'ok')
  transport.close()
})

test('preserves remote JSON-RPC error code and data', async () => {
  const child = createChild()
  const transport = createNdjsonRpcTransport(child, { requestTimeoutMs: 500 })
  const request = transport.request('session/prompt', {})

  send(child, {
    jsonrpc: '2.0',
    id: 0,
    error: {
      code: -32042,
      message: 'model unavailable',
      data: { retryable: true },
    },
  })

  await assert.rejects(request, (error) => {
    assert.equal(error.code, 'KIRO_ACP_REMOTE_ERROR')
    assert.equal(error.remoteCode, -32042)
    assert.deepEqual(error.remoteData, { retryable: true })
    return true
  })
  transport.close()
})

test('rejects responses containing both result and error', async () => {
  const child = createChild()
  const errors = []
  const transport = createNdjsonRpcTransport(child, {
    requestTimeoutMs: 500,
    onError: (error) => errors.push(error),
  })
  const request = transport.request('invalid-response', {})

  send(child, {
    jsonrpc: '2.0',
    id: 0,
    result: null,
    error: { code: -32000, message: 'ambiguous' },
  })

  await assert.rejects(request, (error) => error.code === 'KIRO_ACP_INVALID_MESSAGE')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'KIRO_ACP_INVALID_MESSAGE')
  transport.close()
})

test('does not write an async client response after transport close', async () => {
  const child = createChild()
  let resolveRequest
  const transport = createNdjsonRpcTransport(child, {
    onRequest: () => new Promise((resolve) => { resolveRequest = resolve }),
  })

  send(child, {
    jsonrpc: '2.0',
    id: 99,
    method: 'client/slow',
    params: {},
  })
  await new Promise((resolve) => setImmediate(resolve))
  transport.close()
  resolveRequest({ accepted: true })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(writtenMessages(child), [])
})

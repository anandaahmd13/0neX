const JSON_RPC_VERSION = '2.0'

export class AcpTransportError extends Error {
  constructor(message, { code = 'KIRO_ACP_ERROR', cause } = {}) {
    super(message, { cause })
    this.name = 'AcpTransportError'
    this.code = code
  }
}

/**
 * ACP's stdio transport is UTF-8 JSON-RPC 2.0 with one compact JSON value per
 * newline. Keeping framing here makes fragmented and coalesced stdout chunks
 * independent from the runner lifecycle.
 */
export class NdjsonRpcTransport {
  constructor(child, {
    maxOutputBytes = 2_000_000,
    onNotification = () => {},
    onRequest = async (message) => {
      throw new AcpTransportError(`Unsupported ACP client method: ${message.method}`, {
        code: 'KIRO_ACP_UNSUPPORTED_METHOD',
      })
    },
    onError = () => {},
  } = {}) {
    this.child = child
    this.maxOutputBytes = maxOutputBytes
    this.onNotification = onNotification
    this.onRequest = onRequest
    this.onError = onError
    this.buffer = ''
    this.outputBytes = 0
    this.nextId = 0
    this.pending = new Map()
    this.closed = false
    this.failed = false

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#consume(chunk))
    child.stdout.on('end', () => this.#flush())
    child.stdin.on('error', (cause) => {
      if (this.closed) return
      this.#fail(new AcpTransportError('Kiro ACP stdin closed unexpectedly.', {
        code: 'KIRO_ACP_CLOSED',
        cause,
      }))
    })
    child.once('close', (code, signal) => {
      this.closed = true
      const error = new AcpTransportError(
        `Kiro ACP process closed before completing a request (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`,
        { code: 'KIRO_ACP_CLOSED' },
      )
      this.#rejectPending(error)
    })
  }

  request(method, params) {
    if (this.closed || this.failed) {
      return Promise.reject(new AcpTransportError('Kiro ACP transport is closed.', {
        code: 'KIRO_ACP_CLOSED',
      }))
    }

    const id = this.nextId++
    const promise = new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject, method })
    })

    try {
      this.#write({ jsonrpc: JSON_RPC_VERSION, id, method, params })
    } catch (error) {
      this.pending.delete(String(id))
      return Promise.reject(error)
    }
    return promise
  }

  notify(method, params) {
    if (this.closed || this.failed) return false
    try {
      this.#write({ jsonrpc: JSON_RPC_VERSION, method, params })
      return true
    } catch {
      return false
    }
  }

  close(error = new AcpTransportError('Kiro ACP transport was disposed.', { code: 'KIRO_ACP_CLOSED' })) {
    if (this.closed) return
    this.closed = true
    this.#rejectPending(error)
    try {
      this.child.stdin.end()
    } catch {
      // Child already exited.
    }
  }

  #write(message) {
    if (!this.child.stdin?.writable) {
      throw new AcpTransportError('Kiro ACP stdin is not writable.', { code: 'KIRO_ACP_CLOSED' })
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (cause) => {
      if (!cause || this.closed) return
      this.#fail(new AcpTransportError('Kiro ACP stdin closed unexpectedly.', {
        code: 'KIRO_ACP_CLOSED',
        cause,
      }))
    })
  }

  #consume(chunk) {
    if (this.failed) return
    this.outputBytes += Buffer.byteLength(chunk)
    if (this.outputBytes > this.maxOutputBytes) {
      this.#fail(new AcpTransportError(
        `Kiro ACP output exceeded ${this.maxOutputBytes} bytes.`,
        { code: 'KIRO_MAX_OUTPUT' },
      ))
      return
    }

    this.buffer += chunk
    let newline
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.#parseLine(line)
      if (this.failed) return
    }
  }

  #flush() {
    if (!this.failed && this.buffer.trim()) this.#parseLine(this.buffer)
    this.buffer = ''
  }

  #parseLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return

    let message
    try {
      message = JSON.parse(trimmed)
    } catch (cause) {
      this.#fail(new AcpTransportError('Kiro ACP returned malformed JSON.', {
        code: 'KIRO_ACP_MALFORMED_JSON',
        cause,
      }))
      return
    }

    if (Array.isArray(message)) {
      if (message.length === 0) {
        this.#fail(new AcpTransportError('Kiro ACP returned an empty JSON-RPC batch.', {
          code: 'KIRO_ACP_INVALID_MESSAGE',
        }))
        return
      }
      for (const item of message) this.#handle(item)
      return
    }
    this.#handle(message)
  }

  #handle(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== JSON_RPC_VERSION) {
      this.#fail(new AcpTransportError('Kiro ACP returned an invalid JSON-RPC message.', {
        code: 'KIRO_ACP_INVALID_MESSAGE',
      }))
      return
    }

    const hasId = Object.hasOwn(message, 'id')
    const isResponse = hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
    if (isResponse) {
      const pending = this.pending.get(String(message.id))
      if (!pending) return
      this.pending.delete(String(message.id))
      if (message.error) {
        const detail = typeof message.error.message === 'string' ? message.error.message : 'Unknown ACP error'
        pending.reject(new AcpTransportError(`Kiro ACP ${pending.method} failed: ${detail}`, {
          code: 'KIRO_ACP_REMOTE_ERROR',
        }))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method !== 'string') {
      this.#fail(new AcpTransportError('Kiro ACP returned an invalid JSON-RPC message.', {
        code: 'KIRO_ACP_INVALID_MESSAGE',
      }))
      return
    }

    if (hasId) {
      Promise.resolve()
        .then(() => this.onRequest(message))
        .then(
          (result) => this.#writeResponse(message.id, { result: result ?? null }),
          (error) => this.#writeResponse(message.id, {
            error: {
              code: error?.code === 'KIRO_ACP_UNSUPPORTED_METHOD' ? -32601 : -32000,
              message: error?.message ?? 'ACP client request failed',
            },
          }),
        )
      return
    }

    try {
      this.onNotification(message)
    } catch (cause) {
      this.#fail(new AcpTransportError('Failed to process a Kiro ACP notification.', {
        code: 'KIRO_ACP_NOTIFICATION_ERROR',
        cause,
      }))
    }
  }

  #writeResponse(id, body) {
    if (this.closed || this.failed) return
    try {
      this.#write({ jsonrpc: JSON_RPC_VERSION, id, ...body })
    } catch (error) {
      this.#fail(error)
    }
  }

  #fail(error) {
    if (this.failed) return
    this.failed = true
    this.#rejectPending(error)
    this.onError(error)
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export function createNdjsonRpcTransport(child, options) {
  return new NdjsonRpcTransport(child, options)
}

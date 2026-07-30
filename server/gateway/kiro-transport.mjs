const JSON_RPC_VERSION = '2.0'
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export class AcpTransportError extends Error {
  constructor(message, {
    code = 'KIRO_ACP_ERROR',
    cause,
    remoteCode,
    remoteData,
  } = {}) {
    super(message, { cause })
    this.name = 'AcpTransportError'
    this.code = code
    if (remoteCode !== undefined) this.remoteCode = remoteCode
    if (remoteData !== undefined) this.remoteData = remoteData
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * ACP's stdio transport is UTF-8 JSON-RPC 2.0 with one compact JSON value per
 * newline. Keeping framing here makes fragmented and coalesced stdout chunks
 * independent from the runner lifecycle.
 */
export class NdjsonRpcTransport {
  constructor(child, {
    maxOutputBytes = 2_000_000,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
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
    this.requestTimeoutMs = positiveNumber(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
    this.onNotification = onNotification
    this.onRequest = onRequest
    this.onError = onError
    this.buffer = ''
    this.outputBytes = 0
    this.nextId = 0
    this.pending = new Map()
    this.writeQueue = []
    this.backpressured = false
    this.drainListener = null
    this.closed = false
    this.failed = false

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#consume(chunk))
    child.stdout.on('end', () => this.#flush())
    child.stdin.on('error', (cause) => {
      if (this.closed || this.failed) return
      this.#fail(new AcpTransportError('Kiro ACP stdin closed unexpectedly.', {
        code: 'KIRO_ACP_CLOSED',
        cause,
      }))
    })
    child.once('close', (code, signal) => {
      if (this.closed) return
      this.closed = true
      this.#discardWrites()
      const error = new AcpTransportError(
        `Kiro ACP process closed before completing a request (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`,
        { code: 'KIRO_ACP_CLOSED' },
      )
      this.#rejectPending(error)
    })
  }

  request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed || this.failed) {
      return Promise.reject(new AcpTransportError('Kiro ACP transport is closed.', {
        code: 'KIRO_ACP_CLOSED',
      }))
    }
    if (typeof method !== 'string' || !method) {
      return Promise.reject(new AcpTransportError('Kiro ACP request method harus berupa string.', {
        code: 'KIRO_ACP_INVALID_REQUEST',
      }))
    }

    const id = this.nextId++
    const key = String(id)
    const effectiveTimeoutMs = positiveNumber(timeoutMs, this.requestTimeoutMs)
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(key)
        if (!pending) return
        this.pending.delete(key)
        pending.reject(new AcpTransportError(
          `Kiro ACP ${method} timeout setelah ${effectiveTimeoutMs}ms.`,
          { code: 'KIRO_ACP_REQUEST_TIMEOUT' },
        ))
      }, effectiveTimeoutMs)
      timer.unref?.()
      this.pending.set(key, { resolve, reject, method, timer })
    })

    try {
      this.#write({ jsonrpc: JSON_RPC_VERSION, id, method, params })
    } catch (error) {
      const pending = this.pending.get(key)
      if (pending) clearTimeout(pending.timer)
      this.pending.delete(key)
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
    this.#discardWrites()
    this.#rejectPending(error)
    try {
      this.child.stdin.end()
    } catch {
      // Child already exited.
    }
  }

  #write(message) {
    if (this.closed || this.failed || !this.child.stdin?.writable) {
      throw new AcpTransportError('Kiro ACP stdin is not writable.', { code: 'KIRO_ACP_CLOSED' })
    }

    let line
    try {
      line = `${JSON.stringify(message)}\n`
    } catch (cause) {
      throw new AcpTransportError('Kiro ACP request tidak dapat diserialisasi.', {
        code: 'KIRO_ACP_INVALID_REQUEST',
        cause,
      })
    }
    this.writeQueue.push(line)
    this.#pumpWrites()
  }

  #pumpWrites() {
    if (this.closed || this.failed || this.backpressured) return

    while (this.writeQueue.length > 0 && !this.closed && !this.failed) {
      const line = this.writeQueue.shift()
      let accepted
      try {
        accepted = this.child.stdin.write(line, (cause) => {
          if (!cause || this.closed || this.failed) return
          this.#fail(new AcpTransportError('Kiro ACP stdin closed unexpectedly.', {
            code: 'KIRO_ACP_CLOSED',
            cause,
          }))
        })
      } catch (cause) {
        this.#fail(new AcpTransportError('Kiro ACP stdin closed unexpectedly.', {
          code: 'KIRO_ACP_CLOSED',
          cause,
        }))
        return
      }

      if (!accepted) {
        this.backpressured = true
        this.drainListener = () => {
          this.drainListener = null
          this.backpressured = false
          this.#pumpWrites()
        }
        this.child.stdin.once('drain', this.drainListener)
        return
      }
    }
  }

  #discardWrites() {
    this.writeQueue = []
    this.backpressured = false
    if (this.drainListener) {
      this.child.stdin.off?.('drain', this.drainListener)
      this.drainListener = null
    }
  }

  #consume(chunk) {
    if (this.failed || this.closed) return
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
      if (this.failed || this.closed) return
    }
  }

  #flush() {
    if (!this.failed && !this.closed && this.buffer.trim()) this.#parseLine(this.buffer)
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
      for (const item of message) {
        this.#handle(item)
        if (this.failed || this.closed) return
      }
      return
    }
    this.#handle(message)
  }

  #handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== JSON_RPC_VERSION) {
      this.#fail(new AcpTransportError('Kiro ACP returned an invalid JSON-RPC message.', {
        code: 'KIRO_ACP_INVALID_MESSAGE',
      }))
      return
    }

    const hasId = Object.hasOwn(message, 'id')
    const hasResult = Object.hasOwn(message, 'result')
    const hasError = Object.hasOwn(message, 'error')
    if (hasResult || hasError) {
      if (!hasId || hasResult === hasError || typeof message.method === 'string') {
        this.#fail(new AcpTransportError('Kiro ACP returned an invalid JSON-RPC response.', {
          code: 'KIRO_ACP_INVALID_MESSAGE',
        }))
        return
      }
      if (hasError && (
        !message.error
        || typeof message.error !== 'object'
        || !Number.isInteger(message.error.code)
        || typeof message.error.message !== 'string'
      )) {
        this.#fail(new AcpTransportError('Kiro ACP returned an invalid JSON-RPC error response.', {
          code: 'KIRO_ACP_INVALID_MESSAGE',
        }))
        return
      }

      const key = String(message.id)
      const pending = this.pending.get(key)
      if (!pending) return
      this.pending.delete(key)
      clearTimeout(pending.timer)
      if (hasError) {
        pending.reject(new AcpTransportError(
          `Kiro ACP ${pending.method} failed: ${message.error.message}`,
          {
            code: 'KIRO_ACP_REMOTE_ERROR',
            remoteCode: message.error.code,
            remoteData: message.error.data,
          },
        ))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method !== 'string' || !message.method || (hasId && message.id === null)) {
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
    if (this.failed || this.closed) return
    this.failed = true
    this.#discardWrites()
    this.#rejectPending(error)
    try {
      this.onError(error)
    } catch {
      // The transport error remains authoritative.
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export function createNdjsonRpcTransport(child, options) {
  return new NdjsonRpcTransport(child, options)
}

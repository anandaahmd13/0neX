const CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

export function parseGatewayModel(value) {
  if (typeof value !== 'string') throw new Error('model wajib berupa string')
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('model harus memakai format connection-id/upstream-model')
  }

  const connectionId = value.slice(0, separator)
  const upstreamModel = value.slice(separator + 1)
  if (!CONNECTION_ID_PATTERN.test(connectionId) || /\s/.test(upstreamModel)) {
    throw new Error('model gateway tidak valid')
  }
  return { connectionId, upstreamModel }
}

export function upstreamUrl(baseUrl, resource) {
  return `${baseUrl.replace(/\/+$/, '')}/${resource.replace(/^\/+/, '')}`
}

export function upstreamHeaders(apiKey) {
  return {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  }
}

export function safeUpstreamError(status, payload) {
  const upstreamMessage =
    payload && typeof payload === 'object'
      ? payload.error?.message ?? payload.message
      : null
  return {
    error: {
      message:
        typeof upstreamMessage === 'string' && upstreamMessage.trim()
          ? upstreamMessage.trim().slice(0, 500)
          : `Upstream provider mengembalikan HTTP ${status}`,
      type: 'upstream_error',
      code: `upstream_${status}`,
    },
  }
}

export function createSseUsageParser(onUsage) {
  const decoder = new TextDecoder()
  let buffer = ''

  function inspectLine(line) {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    try {
      const event = JSON.parse(data)
      if (event?.usage) onUsage(event.usage)
    } catch {
      // Chunk SSE non-JSON tidak mengubah stream yang diteruskan ke client.
    }
  }

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        inspectLine(buffer.slice(0, newline).replace(/\r$/, ''))
        buffer = buffer.slice(newline + 1)
      }
    },
    finish() {
      buffer += decoder.decode()
      if (buffer) inspectLine(buffer.replace(/\r$/, ''))
      buffer = ''
    },
  }
}

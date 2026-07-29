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

/**
 * Resolusi model request menjadi daftar kandidat { connectionId, upstreamModel }
 * yang siap dicoba berurutan (failover).
 *
 * Urutan:
 *   1. Ekspansi alias (aliases[model]) bila ada.
 *   2. Kalau hasil berformat "connection/model" → kandidat tunggal eksplisit,
 *      plus kandidat lain (connection berbeda) yang juga mengekspos upstreamModel
 *      sama, sebagai cadangan failover.
 *   3. Kalau hasil "bare-model" (tanpa "/") → semua connection aktif yang
 *      mengekspos model itu, diurutkan: connection yang models-nya eksplisit
 *      mencantumkan model didahulukan.
 *
 * @param {string} model            Nilai body.model dari client.
 * @param {object} opts
 * @param {Record<string,string>} opts.aliases   Peta alias → target.
 * @param {Array<{id,enabled,models}>} opts.connections  Proyeksi publik connection.
 * @returns {{ resolvedModel: string, candidates: Array<{connectionId, upstreamModel}> }}
 */
export function resolveModelCandidates(model, { aliases = {}, connections = [] } = {}) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('model wajib berupa string')
  const resolved = aliases[model.trim()] ?? model.trim()
  const enabled = connections.filter((c) => c.enabled !== false)
  const separator = resolved.indexOf('/')

  // Kasus bare-model: tidak ada connection prefix.
  // (Anggap bare bila tidak ada "/" ATAU prefix sebelum "/" bukan connection yang dikenal.)
  const maybeConnectionId = separator > 0 ? resolved.slice(0, separator) : ''
  const knownConnection = enabled.some((c) => c.id === maybeConnectionId)

  if (separator <= 0 || !knownConnection) {
    // Bare model → cari semua connection yang mengekspos model ini.
    const bare = resolved
    const exposing = enabled.filter((c) => Array.isArray(c.models) && c.models.includes(bare))
    // Connection tanpa daftar model (allow-all) juga jadi kandidat, di urutan belakang.
    const allowAll = enabled.filter((c) => !Array.isArray(c.models) || c.models.length === 0)
    const ordered = [...exposing, ...allowAll]
    if (!ordered.length) {
      throw Object.assign(new Error(`Tidak ada connection yang mengekspos model: ${bare}`), {
        status: 404,
        code: 'model_not_available',
      })
    }
    const seen = new Set()
    const candidates = []
    for (const c of ordered) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      candidates.push({ connectionId: c.id, upstreamModel: bare })
    }
    return { resolvedModel: bare, candidates }
  }

  // Eksplisit connection/model.
  const { connectionId, upstreamModel } = parseGatewayModel(resolved)
  const candidates = [{ connectionId, upstreamModel }]
  // Failover: connection lain yang juga mengekspos upstreamModel sama.
  for (const c of enabled) {
    if (c.id === connectionId) continue
    if (Array.isArray(c.models) && c.models.includes(upstreamModel)) {
      candidates.push({ connectionId: c.id, upstreamModel })
    }
  }
  return { resolvedModel: resolved, candidates }
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

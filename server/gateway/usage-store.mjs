import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const RANGE_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const inputTokens = finiteNumber(raw.prompt_tokens ?? raw.input_tokens ?? raw.inputTokens)
  const outputTokens = finiteNumber(raw.completion_tokens ?? raw.output_tokens ?? raw.outputTokens)
  const totalTokens = finiteNumber(raw.total_tokens ?? raw.totalTokens)
  const cacheReadTokens = finiteNumber(
    raw.cache_read_input_tokens ?? raw.cacheReadTokens ?? raw.prompt_tokens_details?.cached_tokens,
  )
  const cacheWriteTokens = finiteNumber(raw.cache_creation_input_tokens ?? raw.cacheWriteTokens)

  if (inputTokens === null && outputTokens === null && totalTokens === null) return null
  return { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens }
}

export class UsageStore {
  constructor({
    dataDir,
    maxReadBytes = 5_000_000,
    maxEvents = 10_000,
    // Rotasi: saat file > maxFileBytes, buang separuh event terlama dan tulis
    // ulang. Mencegah usage.jsonl tumbuh tanpa batas.
    maxFileBytes = 8_000_000,
    pricingTable = null,
  } = {}) {
    this.filePath = join(dataDir, 'usage.jsonl')
    this.maxReadBytes = maxReadBytes
    this.maxEvents = maxEvents
    this.maxFileBytes = maxFileBytes
    this.pricingTable = pricingTable
    this.writeQueue = Promise.resolve()
    this.bytesSinceRotationCheck = 0
  }

  append(event) {
    const safeEvent = {
      requestId: String(event.requestId),
      timestamp: event.timestamp ?? new Date().toISOString(),
      connectionId: String(event.connectionId),
      // Key gateway mana yang memakai token. null = bootstrap key dari
      // GATEWAY_API_KEY (tidak punya record di api-key store).
      keyId: event.keyId ? String(event.keyId).slice(0, 100) : null,
      keyName: event.keyName ? String(event.keyName).slice(0, 100) : null,
      model: String(event.model),
      stream: event.stream === true,
      status: Number(event.status) || 500,
      success: event.success === true,
      latencyMs: Math.max(0, Number(event.latencyMs) || 0),
      usage: normalizeUsage(event.usage),
      errorCategory: event.errorCategory ? String(event.errorCategory).slice(0, 100) : null,
    }
    const line = `${JSON.stringify(safeEvent)}\n`
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 })
      this.bytesSinceRotationCheck += Buffer.byteLength(line, 'utf8')
      // Periksa rotasi secara berkala, bukan tiap tulisan, agar murah.
      if (this.bytesSinceRotationCheck >= this.maxFileBytes / 4) {
        this.bytesSinceRotationCheck = 0
        await this._rotateIfNeeded()
      }
      return safeEvent
    })
    this.writeQueue = operation.catch(() => {})
    return operation
  }

  async _rotateIfNeeded() {
    let handle
    let size
    try {
      handle = await open(this.filePath, 'r')
      size = (await handle.stat()).size
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    } finally {
      await handle?.close()
    }
    if (size <= this.maxFileBytes) return

    // Baca semua event valid, simpan hanya separuh (atau maxEvents) terbaru,
    // lalu tulis ulang secara atomik.
    const raw = await readFile(this.filePath, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const keep = lines.slice(-Math.min(this.maxEvents, Math.ceil(lines.length / 2)))
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, keep.length ? `${keep.join('\n')}\n` : '', {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, this.filePath)
  }

  async readRecent() {
    await this.writeQueue
    let handle
    try {
      handle = await open(this.filePath, 'r')
      const fileStat = await handle.stat()
      const length = Math.min(fileStat.size, this.maxReadBytes)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, fileStat.size - length)
      let text = buffer.toString('utf8')
      if (length < fileStat.size) text = text.slice(text.indexOf('\n') + 1)
      return text
        .split('\n')
        .filter(Boolean)
        .slice(-this.maxEvents)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    } finally {
      await handle?.close()
    }
  }

  _costFor(model, usage) {
    if (!this.pricingTable) return null
    return this.pricingTable.costFor(model, usage)
  }

  async aggregate(range = '7d') {
    const normalizedRange = RANGE_MS[range] ? range : '7d'
    const cutoff = Date.now() - RANGE_MS[normalizedRange]
    const events = (await this.readRecent()).filter(
      (event) => Date.parse(event.timestamp) >= cutoff,
    )

    const groups = new Map()
    const keyGroups = new Map()
    const timeBuckets = new Map()
    let successes = 0
    let latencyTotal = 0
    let knownTokenRequests = 0
    let totalTokens = 0
    let totalCostUsd = 0

    for (const event of events) {
      if (event.success) successes += 1
      latencyTotal += Number(event.latencyMs) || 0
      const cost = this._costFor(event.model, event.usage)
      if (cost != null) totalCostUsd += cost
      if (event.usage?.totalTokens != null) {
        knownTokenRequests += 1
        totalTokens += event.usage.totalTokens
      }

      const key = `${event.connectionId}\u0000${event.model}`
      const group = groups.get(key) ?? {
        connectionId: event.connectionId,
        model: event.model,
        requests: 0,
        successes: 0,
        totalTokens: 0,
        knownTokenRequests: 0,
        latencyTotal: 0,
        totalCostUsd: 0,
      }
      group.requests += 1
      group.successes += event.success ? 1 : 0
      group.latencyTotal += Number(event.latencyMs) || 0
      if (cost != null) group.totalCostUsd += cost
      if (event.usage?.totalTokens != null) {
        group.totalTokens += event.usage.totalTokens
        group.knownTokenRequests += 1
      }
      groups.set(key, group)

      // Breakdown per API key gateway: menjawab "key/client mana yang memakai
      // token". keyId null = bootstrap key dari GATEWAY_API_KEY.
      const keyId = event.keyId ?? 'bootstrap'
      const keyGroup = keyGroups.get(keyId) ?? {
        keyId: event.keyId ?? null,
        keyName: event.keyName ?? (event.keyId ? null : 'Bootstrap (GATEWAY_API_KEY)'),
        requests: 0,
        successes: 0,
        totalTokens: 0,
        knownTokenRequests: 0,
        latencyTotal: 0,
        totalCostUsd: 0,
        lastUsedAt: null,
      }
      keyGroup.requests += 1
      keyGroup.successes += event.success ? 1 : 0
      keyGroup.latencyTotal += Number(event.latencyMs) || 0
      if (cost != null) keyGroup.totalCostUsd += cost
      if (event.usage?.totalTokens != null) {
        keyGroup.totalTokens += event.usage.totalTokens
        keyGroup.knownTokenRequests += 1
      }
      if (event.keyName) keyGroup.keyName = event.keyName
      if (!keyGroup.lastUsedAt || event.timestamp > keyGroup.lastUsedAt) {
        keyGroup.lastUsedAt = event.timestamp
      }
      keyGroups.set(keyId, keyGroup)

      const date = new Date(event.timestamp)
      const bucket = normalizedRange === '24h'
        ? `${date.toISOString().slice(0, 13)}:00:00.000Z`
        : `${date.toISOString().slice(0, 10)}T00:00:00.000Z`
      timeBuckets.set(bucket, (timeBuckets.get(bucket) ?? 0) + 1)
    }

    return {
      range: normalizedRange,
      summary: {
        requests: events.length,
        successes,
        successRate: events.length ? (successes / events.length) * 100 : 0,
        averageLatencyMs: events.length ? latencyTotal / events.length : 0,
        totalTokens,
        knownTokenRequests,
        totalCostUsd,
      },
      breakdown: [...groups.values()]
        .map((group) => ({
          connectionId: group.connectionId,
          model: group.model,
          requests: group.requests,
          successRate: group.requests ? (group.successes / group.requests) * 100 : 0,
          averageLatencyMs: group.requests ? group.latencyTotal / group.requests : 0,
          totalTokens: group.totalTokens,
          knownTokenRequests: group.knownTokenRequests,
          totalCostUsd: group.totalCostUsd,
        }))
        .sort((left, right) => right.requests - left.requests),
      keyBreakdown: [...keyGroups.values()]
        .map((group) => ({
          keyId: group.keyId,
          keyName: group.keyName,
          requests: group.requests,
          successRate: group.requests ? (group.successes / group.requests) * 100 : 0,
          averageLatencyMs: group.requests ? group.latencyTotal / group.requests : 0,
          totalTokens: group.totalTokens,
          knownTokenRequests: group.knownTokenRequests,
          totalCostUsd: group.totalCostUsd,
          lastUsedAt: group.lastUsedAt,
        }))
        .sort((left, right) => right.requests - left.requests),
      timeSeries: [...timeBuckets.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([timestamp, requests]) => ({ timestamp, requests })),
      recent: [...events].reverse().slice(0, 50),
    }
  }
}

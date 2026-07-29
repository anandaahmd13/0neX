import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Harga per 1 juta token (USD). Dipakai untuk menghitung biaya dari metadata
 * usage. Bisa di-override lewat file JSON GATEWAY_PRICING_FILE:
 *   { "gpt-4o": { "input": 2.5, "output": 10 }, ... }
 * Pencocokan: exact model dulu, lalu prefix terpanjang (mis. "gpt-4o-mini").
 */
const DEFAULT_PRICES = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'o3': { input: 2, output: 8 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-opus-4': { input: 15, output: 75 },
}

export class PricingTable {
  constructor(prices = DEFAULT_PRICES) {
    this.prices = { ...prices }
  }

  static async load({ dataDir, pricingFile } = {}) {
    const table = new PricingTable()
    const path = pricingFile ?? (dataDir ? join(dataDir, 'pricing.json') : null)
    if (!path) return table
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        for (const [model, price] of Object.entries(parsed)) {
          const input = Number(price?.input)
          const output = Number(price?.output)
          if (Number.isFinite(input) && Number.isFinite(output)) {
            table.prices[model] = { input, output }
          }
        }
      }
    } catch {
      // Tidak ada file / JSON rusak → pakai default saja.
    }
    return table
  }

  priceFor(model) {
    if (this.prices[model]) return this.prices[model]
    let best = null
    let bestLen = -1
    for (const key of Object.keys(this.prices)) {
      if (model.startsWith(key) && key.length > bestLen) {
        best = this.prices[key]
        bestLen = key.length
      }
    }
    return best
  }

  /**
   * Biaya USD dari usage yang sudah dinormalisasi (inputTokens/outputTokens
   * per 1e6). Return null bila harga tak diketahui atau token tak lengkap.
   */
  costFor(model, usage) {
    if (!usage) return null
    const price = this.priceFor(model)
    if (!price) return null
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    if (input === 0 && output === 0) return null
    return (input * price.input + output * price.output) / 1_000_000
  }
}

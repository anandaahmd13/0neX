import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RateLimiter } from '../server/gateway/rate-limiter.mjs'
import { PricingTable } from '../server/gateway/pricing.mjs'
import { UsageStore } from '../server/gateway/usage-store.mjs'

test('rate limiter: burst up to capacity then refuses, refills over time', () => {
  let clock = 1_000_000
  const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1, now: () => clock })

  // 3 token pertama lolos (burst = kapasitas).
  assert.equal(limiter.take('k').allowed, true)
  assert.equal(limiter.take('k').allowed, true)
  assert.equal(limiter.take('k').allowed, true)

  // Token ke-4 ditolak, dengan retryAfter > 0.
  const blocked = limiter.take('k')
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfterMs > 0)

  // Kunci berbeda punya bucket sendiri.
  assert.equal(limiter.take('lain').allowed, true)

  // Setelah 2 detik, 2 token terisi ulang.
  clock += 2_000
  assert.equal(limiter.take('k').allowed, true)
  assert.equal(limiter.take('k').allowed, true)
  assert.equal(limiter.take('k').allowed, false)
})

test('rate limiter: sweep removes idle buckets', () => {
  let clock = 0
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: () => clock })
  limiter.take('a')
  assert.equal(limiter.buckets.size, 1)
  clock += 4_000_000 // > 1 jam
  limiter.sweep(3_600_000)
  assert.equal(limiter.buckets.size, 0)
})

test('pricing table: exact + prefix match, unknown returns null', () => {
  const table = new PricingTable()
  // exact match
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
  assert.equal(table.costFor('gpt-4o', usage), 2.5 + 10)
  // prefix match: gpt-4o-mini punya entry sendiri (harus pilih yang terpanjang)
  assert.equal(table.costFor('gpt-4o-mini', { inputTokens: 1_000_000, outputTokens: 0 }), 0.15)
  // model tak dikenal → null
  assert.equal(table.costFor('model-antah-berantah', usage), null)
  // usage kosong → null
  assert.equal(table.costFor('gpt-4o', null), null)
  assert.equal(table.costFor('gpt-4o', { inputTokens: 0, outputTokens: 0 }), null)
})

test('pricing table: file override merges over defaults', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), '0nex-pricing-'))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dataDir, 'pricing.json'), JSON.stringify({
    'custom-model': { input: 1, output: 2 },
    'gpt-4o': { input: 5, output: 20 }, // override default
  }))
  const table = await PricingTable.load({ dataDir })
  assert.equal(table.costFor('custom-model', { inputTokens: 1_000_000, outputTokens: 0 }), 1)
  assert.equal(table.costFor('gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 }), 5)
})

test('usage store: aggregate includes totalCostUsd from pricing table', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), '0nex-usage-cost-'))
  const store = new UsageStore({ dataDir, pricingTable: new PricingTable() })
  await store.append({
    requestId: 'r1',
    connectionId: 'c1',
    model: 'gpt-4o',
    status: 200,
    success: true,
    latencyMs: 10,
    usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
  })
  const agg = await store.aggregate('24h')
  assert.equal(agg.summary.totalCostUsd, 12.5)
  assert.equal(agg.breakdown[0].totalCostUsd, 12.5)
})

test('usage store: rotates when file exceeds maxFileBytes, keeping recent events', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), '0nex-usage-rotate-'))
  // maxFileBytes kecil supaya rotasi terpicu cepat.
  const store = new UsageStore({ dataDir, maxFileBytes: 4_000, maxEvents: 1_000 })
  for (let i = 0; i < 200; i += 1) {
    await store.append({
      requestId: `r${i}`,
      connectionId: 'c1',
      model: 'gpt-4o',
      status: 200,
      success: true,
      latencyMs: 5,
      usage: null,
    })
  }
  const filePath = join(dataDir, 'usage.jsonl')
  const size = (await stat(filePath)).size
  // File harus jauh lebih kecil dari kalau semua 200 event ditulis penuh.
  assert.ok(size <= 4_000 * 2, `ukuran file ${size} melebihi ekspektasi rotasi`)

  // Event terbaru harus tetap ada.
  const raw = await readFile(filePath, 'utf8')
  assert.ok(raw.includes('"r199"'), 'event terbaru hilang setelah rotasi')
})

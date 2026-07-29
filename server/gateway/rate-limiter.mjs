/**
 * Token bucket in-memory per kunci (API key + connection). Cocok untuk
 * personal gateway single-process. Refill kontinu berbasis waktu, jadi burst
 * pendek diizinkan sampai kapasitas lalu melandai ke laju steady.
 */
export class RateLimiter {
  constructor({ capacity = 60, refillPerSec = 1, now = Date.now } = {}) {
    this.capacity = Math.max(1, capacity)
    this.refillPerSec = Math.max(0, refillPerSec)
    this.now = now
    this.buckets = new Map()
  }

  _bucket(key) {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { tokens: this.capacity, updated: this.now() }
      this.buckets.set(key, bucket)
    }
    return bucket
  }

  /**
   * Ambil satu token. Return { allowed, retryAfterMs }.
   */
  take(key, cost = 1) {
    const bucket = this._bucket(key)
    const nowMs = this.now()
    const elapsedSec = (nowMs - bucket.updated) / 1000
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec)
    bucket.updated = nowMs

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost
      return { allowed: true, retryAfterMs: 0 }
    }
    const deficit = cost - bucket.tokens
    const retryAfterMs = this.refillPerSec > 0 ? Math.ceil((deficit / this.refillPerSec) * 1000) : 60_000
    return { allowed: false, retryAfterMs }
  }

  /**
   * Buang bucket yang sudah lama tidak dipakai agar Map tidak tumbuh selamanya.
   */
  sweep(maxIdleMs = 3_600_000) {
    const cutoff = this.now() - maxIdleMs
    for (const [key, bucket] of this.buckets) {
      if (bucket.updated < cutoff) this.buckets.delete(key)
    }
  }
}

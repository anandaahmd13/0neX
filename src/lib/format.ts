/** Compact number: 12_930_000 → "12.93M" */
export function fmtCompact(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/** Thousands separator with dots (id-ID style). */
export function fmtInt(n: number): string {
  return n.toLocaleString('id-ID')
}

/** USD cost: kecil → 4 desimal ($0.0123), besar → 2 desimal ($12.30). */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0'
  if (n < 1) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

/** Milliseconds → human duration. */
export function fmtDuration(ms: number): string {
  if (ms === 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

/** ISO timestamp → "27 Jul, 09:14" */
export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

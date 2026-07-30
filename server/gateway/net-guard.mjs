import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/**
 * Tolak target yang mengarah ke jaringan internal (anti-SSRF).
 * Mencakup loopback, private RFC1918, link-local (termasuk metadata cloud
 * 169.254.169.254), CGNAT, dan padanan IPv6-nya.
 */

function ipv4ToParts(address) {
  return address.split('.').map((part) => Number(part))
}

export function isPrivateIpv4(address) {
  const [a, b] = ipv4ToParts(address)
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // loopback
  if (a === 0) return true // "this" network
  if (a === 169 && b === 254) return true // link-local + metadata cloud
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0) return true // 192.0.0.0/24 (IETF protocol)
  if (a >= 224) return true // multicast + reserved
  return false
}

export function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (normalized === '::1' || normalized === '::') return true // loopback / unspecified
  if (normalized.startsWith('fe80')) return true // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true // unique local fc00::/7
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — periksa bagian IPv4-nya.
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIpv4(mapped[1])
  return false
}

export function isPrivateAddress(address) {
  const family = isIP(address)
  if (family === 4) return isPrivateIpv4(address)
  if (family === 6) return isPrivateIpv6(address)
  return false
}

/**
 * Verifikasi hostname aman untuk dihubungi. Kalau literal IP, cek langsung;
 * kalau nama domain, resolusi DNS dulu dan tolak bila ADA satu saja jawaban
 * yang mengarah ke ruang alamat internal (mitigasi DNS rebinding sederhana).
 */
function isLoopbackAddress(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (normalized === '::1') return true
  if (isIP(normalized) !== 4) return false
  return normalized.split('.')[0] === '127'
}

export async function assertPublicHost(hostname, {
  allowLocalhost = false,
  lookupFn = lookup,
} = {}) {
  const family = isIP(hostname)
  if (family) {
    if (isPrivateAddress(hostname) && !(allowLocalhost && isLoopbackAddress(hostname))) {
      throw new Error(`Host ${hostname} mengarah ke alamat jaringan internal`)
    }
    return
  }

  const lower = hostname.toLowerCase()
  const localhostName = lower === 'localhost' || lower.endsWith('.localhost')
  if (localhostName) {
    if (allowLocalhost) return
    throw new Error('Host localhost tidak diizinkan')
  }

  let records
  try {
    records = await lookupFn(hostname, { all: true })
  } catch {
    throw new Error(`Gagal resolve host: ${hostname}`)
  }
  if (!records.length) throw new Error(`Host tidak punya alamat: ${hostname}`)
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error(`Host ${hostname} me-resolve ke alamat internal ${record.address}`)
    }
  }
}

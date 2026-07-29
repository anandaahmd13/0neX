import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'gw_session'
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000 // 12 jam

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function sign(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url')
}

/**
 * Session token stateless: payload base64url + HMAC-SHA256.
 * Tidak menyimpan apa pun di disk; cukup verifikasi tanda tangan + kedaluwarsa.
 */
export function createSessionManager({ secret, ttlMs = DEFAULT_TTL_MS } = {}) {
  const signingSecret =
    typeof secret === 'string' && secret.length >= 16 ? secret : randomBytes(32).toString('hex')

  function issue(subject) {
    const payload = { sub: String(subject ?? 'admin'), exp: Date.now() + ttlMs }
    const payloadB64 = base64url(JSON.stringify(payload))
    return `${payloadB64}.${sign(payloadB64, signingSecret)}`
  }

  function verify(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null
    const [payloadB64, signature] = token.split('.', 2)
    if (!payloadB64 || !signature) return null

    const expected = sign(payloadB64, signingSecret)
    const a = Buffer.from(signature)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null

    try {
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
      if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
      return payload
    } catch {
      return null
    }
  }

  return { issue, verify, ttlMs, cookieName: COOKIE_NAME }
}

export function parseCookies(header) {
  const jar = {}
  if (typeof header !== 'string') return jar
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    if (key) jar[key] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return jar
}

export function serializeSessionCookie(name, value, { ttlMs, clear = false } = {}) {
  const attributes = [
    `${name}=${clear ? '' : value}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
  ]
  if (clear) attributes.push('Max-Age=0')
  else if (ttlMs) attributes.push(`Max-Age=${Math.floor(ttlMs / 1000)}`)
  return attributes.join('; ')
}

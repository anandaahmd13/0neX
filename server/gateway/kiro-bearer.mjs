import { assertPublicHost } from './net-guard.mjs'
import { DEFAULT_KIRO_REGION, normalizeKiroRegion } from './connection-store.mjs'

/**
 * Validasi Kiro/CodeWhisperer API key lewat HTTPS langsung, tanpa `kiro-cli`.
 *
 * Jalur ini meniru cara klien resmi memakai bearer credential: satu panggilan
 * `ListAvailableProfiles` ke host CodeWhisperer regional. Region bukan variabel
 * environment — region menentukan hostname DAN profile ARN mana yang dipakai,
 * jadi validasi dan inference tidak boleh memakai region yang berbeda.
 */

const PROFILE_TARGET = 'AmazonCodeWhispererService.ListAvailableProfiles'
const MAX_ERROR_LENGTH = 300

export class KiroBearerError extends Error {
  constructor(message, { code = 'KIRO_BEARER_ERROR', status = 502, cause } = {}) {
    super(message, { cause })
    this.name = 'KiroBearerError'
    this.code = code
    this.status = status
  }
}

export function kiroProfileHost(region = DEFAULT_KIRO_REGION) {
  return `https://codewhisperer.${normalizeKiroRegion(region)}.amazonaws.com`
}

/** Buang secret dari teks error upstream supaya tidak pernah dipantulkan ke caller. */
function redact(text, secret) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const safe = secret ? flat.replaceAll(secret, '[redacted]') : flat
  return safe.length > MAX_ERROR_LENGTH ? `${safe.slice(0, MAX_ERROR_LENGTH)}…` : safe
}

/**
 * Ambil email dari klaim JWT bila bearer-nya memang JWT. Nilai ini cuma label
 * tampilan; kalau key-nya opaque, hasilnya null dan itu bukan error.
 */
export function extractEmailFromBearer(apiKey) {
  const parts = String(apiKey ?? '').split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const email = claims.email ?? claims.preferred_username ?? claims.sub
    return typeof email === 'string' && email.trim() ? email.trim() : null
  } catch {
    return null
  }
}

function profileArnOf(profile) {
  return profile?.arn ?? profile?.profileArn ?? null
}

/**
 * Pilih profile yang region-nya cocok dengan region yang diminta. Segmen ke-4
 * ARN adalah region (`arn:partition:service:region:account:resource`), jadi
 * pencocokan dilakukan di situ, bukan lewat substring bebas.
 */
function selectProfileArn(profiles, region) {
  const arns = profiles.map(profileArnOf).filter((arn) => typeof arn === 'string' && arn)
  return arns.find((arn) => arn.split(':')[3] === region) ?? arns[0] ?? null
}

export function createKiroBearerValidator({
  fetchImpl = globalThis.fetch,
  assertHost = assertPublicHost,
  timeoutMs = 15_000,
} = {}) {
  async function listProfiles({ secret, region }) {
    const endpoint = kiroProfileHost(region)
    // Anti-SSRF: host di-verifikasi sebelum request, bukan sesudahnya.
    await assertHost(new URL(endpoint).hostname)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-amz-json-1.0',
          'x-amz-target': PROFILE_TARGET,
          authorization: `Bearer ${secret}`,
          accept: 'application/json',
        },
        body: JSON.stringify({ maxResults: 10 }),
        signal: controller.signal,
      })
    } catch (cause) {
      const aborted = cause?.name === 'AbortError'
      throw new KiroBearerError(
        aborted
          ? 'Validasi Kiro API key melewati batas waktu.'
          : `Gagal menghubungi CodeWhisperer: ${redact(cause?.message, secret)}`,
        { code: aborted ? 'KIRO_BEARER_TIMEOUT' : 'KIRO_BEARER_UNREACHABLE', status: 504, cause },
      )
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const detail = redact(await response.text().catch(() => ''), secret)
      const rejected = response.status === 401 || response.status === 403
      throw new KiroBearerError(
        rejected
          ? 'Kiro API key ditolak CodeWhisperer. Periksa key dan region-nya.'
          : `CodeWhisperer menolak permintaan (HTTP ${response.status}). ${detail}`.trim(),
        {
          code: rejected ? 'KIRO_BEARER_REJECTED' : 'KIRO_BEARER_HTTP_ERROR',
          status: rejected ? 401 : 502,
        },
      )
    }

    const payload = await response.json().catch(() => null)
    return Array.isArray(payload?.profiles) ? payload.profiles : []
  }

  async function validateApiKey({ apiKey, region } = {}) {
    const secret = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (!secret) {
      throw new KiroBearerError('Kiro API key wajib diisi.', {
        code: 'KIRO_BEARER_KEY_REQUIRED',
        status: 400,
      })
    }

    let resolvedRegion
    try {
      resolvedRegion = normalizeKiroRegion(region)
    } catch (cause) {
      throw new KiroBearerError(cause.message, {
        code: 'KIRO_BEARER_INVALID_REGION',
        status: 400,
        cause,
      })
    }

    const profiles = await listProfiles({ secret, region: resolvedRegion })
    // API-key Kiro tertentu terautentikasi dengan sukses tetapi tidak mendapat
    // profile eksplisit dari ListAvailableProfiles. Dalam kasus itu profileArn
    // sengaja dibiarkan null agar runtime memakai profile default milik token.
    const profileArn = selectProfileArn(profiles, resolvedRegion)

    return {
      region: resolvedRegion,
      profileArn,
      email: extractEmailFromBearer(secret),
      validatedAt: new Date().toISOString(),
    }
  }

  return { validateApiKey }
}

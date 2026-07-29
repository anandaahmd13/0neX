import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 12
const SALT_LENGTH = 16

// Salt legacy untuk membaca blob version 1 (salt global hardcoded).
// Blob baru (version 2) memakai salt acak per-secret yang disimpan di payload.
const LEGACY_SALT = '0nex-personal-ai-gateway-v1'

function assertMasterKey(masterKey) {
  if (typeof masterKey !== 'string' || masterKey.length < 16) {
    throw new Error('GATEWAY_MASTER_KEY wajib diisi minimal 16 karakter')
  }
}

function deriveKey(masterKey, salt) {
  assertMasterKey(masterKey)
  return scryptSync(masterKey, salt, KEY_LENGTH)
}

export function encryptSecret(value, masterKey) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Secret tidak boleh kosong')

  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, deriveKey(masterKey, salt), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

  return {
    version: 2,
    algorithm: ALGORITHM,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export function decryptSecret(payload, masterKey) {
  if (
    !payload ||
    payload.algorithm !== ALGORITHM ||
    typeof payload.iv !== 'string' ||
    typeof payload.tag !== 'string' ||
    typeof payload.ciphertext !== 'string' ||
    (payload.version !== 1 && payload.version !== 2)
  ) {
    throw new Error('Format secret terenkripsi tidak valid')
  }

  // v2: salt acak tersimpan di blob. v1: salt global legacy.
  const salt =
    payload.version === 2 && typeof payload.salt === 'string'
      ? Buffer.from(payload.salt, 'base64')
      : LEGACY_SALT
  if (payload.version === 2 && typeof payload.salt !== 'string') {
    throw new Error('Format secret terenkripsi tidak valid')
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveKey(masterKey, salt),
      Buffer.from(payload.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    if (error.message.startsWith('GATEWAY_MASTER_KEY')) throw error
    throw new Error('Secret tidak bisa didekripsi; periksa GATEWAY_MASTER_KEY')
  }
}

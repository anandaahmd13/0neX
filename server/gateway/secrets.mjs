import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 12
const SALT = '0nex-personal-ai-gateway-v1'

function deriveKey(masterKey) {
  if (typeof masterKey !== 'string' || masterKey.length < 16) {
    throw new Error('GATEWAY_MASTER_KEY wajib diisi minimal 16 karakter')
  }
  return scryptSync(masterKey, SALT, KEY_LENGTH)
}

export function encryptSecret(value, masterKey) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Secret tidak boleh kosong')

  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, deriveKey(masterKey), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

  return {
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export function decryptSecret(payload, masterKey) {
  if (
    !payload ||
    payload.version !== 1 ||
    payload.algorithm !== ALGORITHM ||
    typeof payload.iv !== 'string' ||
    typeof payload.tag !== 'string' ||
    typeof payload.ciphertext !== 'string'
  ) {
    throw new Error('Format secret terenkripsi tidak valid')
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveKey(masterKey),
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

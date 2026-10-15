// ponytail: copied from filecoin-pin src/common/encryption.ts; folds into filecoin-pin in v1
import * as fee from 'filecoin-encryption-envelope'

const SALT_BYTES = 16
const MAX_ITERATIONS = 10_000_000

export function validateKdfMetadata(appMetadata: unknown): {
  salt: Uint8Array<ArrayBuffer>
  iterations: number
} {
  const { kdf, salt, iterations } = (appMetadata ?? {}) as Record<string, unknown>
  if (
    kdf !== 'pbkdf2-sha256' ||
    typeof salt !== 'string' ||
    typeof iterations !== 'number' ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_ITERATIONS
  ) {
    throw new Error('missing or unsupported key derivation parameters')
  }
  const saltBytes = decodeBase64(salt)
  if (saltBytes.length !== SALT_BYTES) throw new Error('missing or unsupported key derivation parameters')
  return { salt: saltBytes, iterations }
}

export async function derivePasswordKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    fee.constants.KEY_SIZE * 8
  )
  return new Uint8Array(bits)
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  } catch {
    throw new Error('missing or unsupported key derivation parameters')
  }
}

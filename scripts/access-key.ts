// The one-click link key of an envelope: the same PBKDF2 output the password derives, as `fak1_…`.
import * as fee from 'filecoin-encryption-envelope'
import { encodeAccessKey } from '../src/fragment.ts'
import { derivePasswordKey, validateKdfMetadata } from '../src/password-key.ts'

/** `envelope` needs only the header (its first 64 KiB are enough). */
export async function accessKeyFor(envelope: Uint8Array, password: string): Promise<string> {
  const { appMetadata } = await fee.parse(envelope)
  const { salt, iterations } = validateKdfMetadata(appMetadata)
  return encodeAccessKey(await derivePasswordKey(password, salt, iterations))
}

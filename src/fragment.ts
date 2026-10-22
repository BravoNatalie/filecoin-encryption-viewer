// #v1/<encryptedRootCid>[&k=<access key>]
const FRAGMENT_PATTERN = /^v1\/(b[a-z2-7]{20,120})(?:&k=(fak1_[A-Za-z0-9_-]{43}))?$/
const ACCESS_KEY_PREFIX = 'fak1_'
const KEY_BYTES = 32

export interface FragmentParams {
  cid: string
  /** The 32-byte key of a one-click link. */
  key?: Uint8Array<ArrayBuffer>
}

/** `fak1_` + base64url without padding: the access key of a one-click link. */
export function encodeAccessKey(key: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...key))
  return ACCESS_KEY_PREFIX + base64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** The 32 key bytes, or null for anything that isn't exactly what encodeAccessKey writes. */
export function decodeAccessKey(text: string): Uint8Array<ArrayBuffer> | null {
  if (!text.startsWith(ACCESS_KEY_PREFIX)) return null
  try {
    const base64 = text.slice(ACCESS_KEY_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/')
    const key = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    // Re-encoding rejects non-canonical spellings (stray bits in the last character)
    return key.length === KEY_BYTES && encodeAccessKey(key) === text ? key : null
  } catch {
    return null
  }
}

/** Parse the share link fragment; anything outside the codec above (unknown parameters, a bad `k`) is null. */
export function parseFragment(hash: string): FragmentParams | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const match = FRAGMENT_PATTERN.exec(raw)
  if (!match) return null
  const [, cid, accessKey] = match
  if (accessKey === undefined) return { cid }
  const key = decodeAccessKey(accessKey)
  return key ? { cid, key } : null
}

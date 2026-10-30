// #v1/<encryptedRootCid>&d=<payload>[&k=<access key>], exactly as filecoin-pin's formatShareLink writes it
// ponytail: `d` then `k`, in that order only; parse the parameters as a set if another writer ever orders them differently
const FRAGMENT_PATTERN = /^v1\/(b[a-z2-7]{20,120})&d=([A-Za-z0-9_-]{1,8192})(?:&k=(fak1_[A-Za-z0-9_-]{43}))?$/
const ACCESS_KEY_PREFIX = 'fak1_'
const KEY_BYTES = 32

export interface FragmentParams {
  cid: string
  /** The keysmith payload: a Delivery (CBOR array) or a plain piece grant (CBOR map). Not checked here. */
  payload: Uint8Array<ArrayBuffer>
  /** The Access key, when the link carries it: the 32-byte secp256k1 private key the payload is wrapped to. */
  key?: Uint8Array<ArrayBuffer>
}

const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

// Null for anything that isn't exactly what encodeBase64Url writes (re-encoding rejects stray bits in the last character)
function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bytes = Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0))
    return encodeBase64Url(bytes) === text ? bytes : null
  } catch {
    return null
  }
}

/** `fak1_` + base64url without padding of the 32-byte private key. */
export function encodeAccessKey(key: Uint8Array): string {
  return ACCESS_KEY_PREFIX + encodeBase64Url(key)
}

/** The 32 key bytes, or null for anything that isn't exactly what encodeAccessKey writes. */
export function decodeAccessKey(text: string): Uint8Array<ArrayBuffer> | null {
  if (!text.startsWith(ACCESS_KEY_PREFIX)) return null
  const key = decodeBase64Url(text.slice(ACCESS_KEY_PREFIX.length))
  return key?.length === KEY_BYTES ? key : null
}

/** Parse the share link fragment; anything outside the codec above (unknown parameters, a bad `d` or `k`) is null. */
export function parseFragment(hash: string): FragmentParams | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const match = FRAGMENT_PATTERN.exec(raw)
  if (!match) return null
  const [, cid, data, accessKey] = match
  const payload = decodeBase64Url(data)
  if (!payload) return null
  if (accessKey === undefined) return { cid, payload }
  const key = decodeAccessKey(accessKey)
  return key ? { cid, payload, key } : null
}

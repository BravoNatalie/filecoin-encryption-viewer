const FRAGMENT_PATTERN = /^v1\/(b[a-z2-7]{20,120})$/

export interface FragmentParams {
  cid: string
}

/** Parse `#v1/<cid>`; v0 accepts only that form and rejects provider and key parameters. */
export function parseFragment(hash: string): FragmentParams | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const cid = FRAGMENT_PATTERN.exec(raw)?.[1]
  return cid ? { cid } : null
}

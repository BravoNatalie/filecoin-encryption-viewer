// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessKeyFor } from '../scripts/access-key.ts'
import { openProtectedArchive } from '../src/car-archive.js'
import { decodeAccessKey, encodeAccessKey } from '../src/fragment.js'
import { expectSameBytes } from './fixtures/bytes.js'
import { FAST_ITERATIONS, PASSWORD, SALT, makeShare } from './fixtures/make-share.js'
import { serveRange } from './fixtures/serve-range.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'
const files = [
  { path: 'docs/a.txt', content: new TextEncoder().encode('alpha text') },
  { path: 'docs/b.txt', content: new TextEncoder().encode('beta text') },
]

async function waitFor<T>(find: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const found = find()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for the page')
}

const app = () => document.getElementById('app') as HTMLElement

async function openPage(hash: string): Promise<void> {
  vi.resetModules()
  document.body.innerHTML = '<div id="app"></div>'
  window.location.hash = hash
  await import('../src/main.js')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function independentPbkdf2(): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASSWORD), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: FAST_ITERATIONS },
    base,
    256
  )
  return new Uint8Array(bits)
}

describe('access key from an envelope', () => {
  it('is the PBKDF2 key the share was encrypted with, as fak1_', async () => {
    const share = await makeShare(files)
    const text = await accessKeyFor(share.subarray(0, 64 * 1024), PASSWORD)
    expect(text).toMatch(/^fak1_[A-Za-z0-9_-]{43}$/)
    expectSameBytes(decodeAccessKey(text) as Uint8Array, await independentPbkdf2())
  })

  it('opens the share directly, with no key derivation, and zeroes the key on close', async () => {
    const share = await makeShare(files)
    const key = decodeAccessKey(await accessKeyFor(share, PASSWORD)) as Uint8Array
    const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits')

    const archive = await openProtectedArchive(CID, key, serveRange(share).fetch)

    expect(deriveBits).not.toHaveBeenCalled()
    expect(archive.list().map((entry) => entry.path)).toContain('docs/a.txt')
    await archive.close()
    expectSameBytes(key, new Uint8Array(32))
  })
})

describe('one-click link in the page', () => {
  it('opens without the prompt or PBKDF2, and removes the key from the address bar first', async () => {
    const share = await makeShare(files)
    const stub = serveRange(share)
    vi.stubGlobal('fetch', stub.fetch)
    const keyText = await accessKeyFor(share, PASSWORD)
    const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    await openPage(`#v1/${CID}&k=${keyText}`)
    await waitFor(() => app().querySelector('button.tree-file'))

    expect(app().querySelector('#pw-input')).toBeNull()
    expect(deriveBits).not.toHaveBeenCalled()
    expect(replaceState).toHaveBeenCalledWith(null, '', `#v1/${CID}`)
    expect(window.location.hash).toBe(`#v1/${CID}`)
    expect(window.location.hash).not.toContain('fak1_')
    expect(document.body.innerHTML).not.toContain(keyText)
  })

  it('falls back to the password prompt with a message when the key does not work, then opens with the password', async () => {
    const share = await makeShare(files)
    vi.stubGlobal('fetch', serveRange(share).fetch)
    const wrongKey = encodeAccessKey(crypto.getRandomValues(new Uint8Array(32)))

    await openPage(`#v1/${CID}&k=${wrongKey}`)
    const input = await waitFor(() => app().querySelector<HTMLInputElement>('#pw-input'))

    const error = app().querySelector('#error') as HTMLElement
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe("The key in this link didn't work. Enter the Access key you received instead.")
    expect(window.location.hash).toBe(`#v1/${CID}`)

    input.value = PASSWORD
    app()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    await waitFor(() => app().querySelector('button.tree-file'))
  })

  it('treats an all-zero key like a wrong key: fallback message, then the password opens it', async () => {
    vi.stubGlobal('fetch', serveRange(await makeShare(files)).fetch)

    await openPage(`#v1/${CID}&k=fak1_${'A'.repeat(43)}`)
    const input = await waitFor(() => app().querySelector<HTMLInputElement>('#pw-input'))

    expect(app().querySelector('#error')?.textContent).toBe(
      "The key in this link didn't work. Enter the Access key you received instead."
    )
    input.value = PASSWORD
    app()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    await waitFor(() => app().querySelector('button.tree-file'))
  })

  it('still shows the plain prompt for a link without a key', async () => {
    vi.stubGlobal('fetch', serveRange(await makeShare(files)).fetch)
    await openPage(`#v1/${CID}`)
    const input = await waitFor(() => app().querySelector<HTMLInputElement>('#pw-input'))
    expect(input).not.toBeNull()
    expect((app().querySelector('#error') as HTMLElement).hidden).toBe(true)
  })
})

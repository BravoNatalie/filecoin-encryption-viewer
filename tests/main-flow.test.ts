// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { PASSWORD, makeShare } from './fixtures/make-share.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'

async function waitFor<T>(find: () => T | null | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = find()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for the page')
}

const app = () => document.getElementById('app') as HTMLElement
const fileButton = (name: string) =>
  Array.from(app().querySelectorAll<HTMLButtonElement>('button.tree-file')).find((b) => b.textContent?.includes(name))

it('goes back from a file to the tree without fetching or deriving the key again', async () => {
  const share = await makeShare([
    { path: 'docs/a.txt', content: new TextEncoder().encode('alpha text') },
    { path: 'docs/b.txt', content: new TextEncoder().encode('beta text') },
  ])
  const fetchSpy = vi.fn(async () => new Response(share as BodyInit))
  vi.stubGlobal('fetch', fetchSpy)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }))
  const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits')

  document.body.innerHTML = '<div id="app"></div>'
  window.location.hash = `#v1/${CID}`
  await import('../src/main.js')

  const input = await waitFor(() => app().querySelector<HTMLInputElement>('#pw-input'))
  input.value = PASSWORD
  app()
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  const first = await waitFor(() => fileButton('a.txt'))

  first.click()
  await waitFor(() => app().querySelector('pre'))
  expect(app().querySelector('pre')?.textContent).toBe('alpha text')

  app().querySelector<HTMLButtonElement>('#back-btn')?.click()
  const second = await waitFor(() => fileButton('b.txt'))
  second.click()
  await waitFor(() => app().querySelector('pre')?.textContent === 'beta text')

  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(deriveBits).toHaveBeenCalledTimes(1)

  // Download all (.zip) reuses the open archive too
  app().querySelector<HTMLButtonElement>('#back-btn')?.click()
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const downloadAll = await waitFor(() => app().querySelector<HTMLButtonElement>('#download-all'))
  downloadAll.click()
  await waitFor(() => app().querySelector('#zip-status')?.textContent === 'Zip ready.')

  expect(click).toHaveBeenCalledOnce()
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(deriveBits).toHaveBeenCalledTimes(1)
})

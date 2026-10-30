// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { ACCESS_KEY_TEXT, LINK_DATA, makeShare } from './fixtures/make-share.js'
import { serveRange } from './fixtures/serve-range.js'

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

it('goes back from a file to the tree without fetching or opening the share again', async () => {
  const share = await makeShare([
    { path: 'docs/a.txt', content: new TextEncoder().encode('alpha text') },
    { path: 'docs/b.txt', content: new TextEncoder().encode('beta text') },
  ])
  const stub = serveRange(share)
  vi.stubGlobal('fetch', stub.fetch)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }))

  document.body.innerHTML = '<div id="app"></div>'
  window.location.hash = `#v1/${CID}&d=${LINK_DATA}`
  await import('../src/main.js')

  const input = await waitFor(() => app().querySelector<HTMLInputElement>('#access-key'))
  input.value = ACCESS_KEY_TEXT
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

  expect(stub.requests).toHaveLength(1)

  // Download all (.zip) reuses the open archive too
  app().querySelector<HTMLButtonElement>('#back-btn')?.click()
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const downloadAll = await waitFor(() => app().querySelector<HTMLButtonElement>('#download-all'))
  downloadAll.click()
  await waitFor(() => app().querySelector('#zip-status')?.textContent === 'Zip ready.')

  expect(click).toHaveBeenCalledOnce()
  expect(stub.requests).toHaveLength(1)
})

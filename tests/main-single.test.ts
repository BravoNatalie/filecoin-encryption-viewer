// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { PASSWORD, makeShare } from './fixtures/make-share.js'
import { serveRange } from './fixtures/serve-range.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'

it('opens a single-file share directly, with no tree, back button or Download all', async () => {
  const share = await makeShare([{ path: 'note.txt', content: new TextEncoder().encode('just one file') }])
  vi.stubGlobal('fetch', serveRange(share).fetch)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }))

  document.body.innerHTML = '<div id="app"></div>'
  window.location.hash = `#v1/${CID}`
  await import('../src/main.js')

  const app = document.getElementById('app') as HTMLElement
  const input = app.querySelector('#pw-input') as HTMLInputElement
  input.value = PASSWORD
  app.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  for (let attempt = 0; attempt < 200 && !app.querySelector('pre'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  expect(app.querySelector('pre')?.textContent).toBe('just one file')
  expect(app.querySelector('#download-all')).toBeNull()
  expect(app.querySelector('#back-btn')).toBeNull()
})

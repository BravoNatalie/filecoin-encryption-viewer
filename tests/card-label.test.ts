// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { ProtectedEntry } from '../src/car-archive.js'
import { renderContent } from '../src/render.js'
import { showAccessKeyPrompt, showMissingLink, showProtectedArchive, showSaveEntry } from '../src/ui.js'

const entries: ProtectedEntry[] = [
  { path: 'share/', directory: true, size: 0, contentType: 'inode/directory' },
  { path: 'share/a.txt', directory: false, size: 5, contentType: 'application/octet-stream' },
]

let container: HTMLElement
const label = () => document.getElementById('card-label') as HTMLElement

beforeEach(() => {
  document.body.innerHTML = '<div id="card-label"></div><div id="app"></div>'
  container = document.getElementById('app') as HTMLElement
})

it('shows the label as the page h1 on the tree screen only', () => {
  showProtectedArchive(
    container,
    entries,
    async () => {},
    new Map(),
    async () => {}
  )
  expect(label().querySelector('h1')?.textContent).toBe('Encrypted share')
  expect(container.classList.contains('tree-card')).toBe(true)
  expect(container.querySelector('#download-all')?.getAttribute('aria-label')).toBe('Download all files as a zip')
  expect(container.querySelector('#download-all')?.textContent).toContain('Download all')
  expect(container.textContent).toContain('1 file · 5 B')

  showSaveEntry(container, entries[1], async () => 'saved')
  expect(label().childElementCount).toBe(0)
  expect(container.classList.contains('tree-card')).toBe(false)

  showProtectedArchive(container, entries, async () => {})
  expect(label().childElementCount).toBe(1)
  showMissingLink(container)
  expect(label().childElementCount).toBe(0)
  expect(container.classList.contains('tree-card')).toBe(false)

  showProtectedArchive(container, entries, async () => {})
  showAccessKeyPrompt(container, async () => {})
  expect(label().childElementCount).toBe(0)
  expect(container.classList.contains('tree-card')).toBe(false)

  showProtectedArchive(container, entries, async () => {})
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }))
  renderContent(container, new TextEncoder().encode('hi'), 'text/plain', 'a.txt')
  expect(label().childElementCount).toBe(0)
  expect(container.classList.contains('tree-card')).toBe(false)
})

it('shows progress only in the status line while building', async () => {
  let release: () => void = () => {}
  showProtectedArchive(
    container,
    entries,
    async () => {},
    new Map(),
    (onProgress) =>
      new Promise<void>((resolve) => {
        onProgress(1, 2)
        release = resolve
      })
  )
  const button = container.querySelector('#download-all') as HTMLButtonElement
  button.click()
  await Promise.resolve()
  expect(button.textContent).toContain('Preparing…')
  expect(container.querySelector('#zip-status')?.textContent).toBe('Adding files: 1 of 2')
  release()
  await vi.waitFor(() => expect(container.querySelector('#zip-status')?.textContent).toBe('Zip ready.'))
  expect(button.textContent).toContain('Download all')
})

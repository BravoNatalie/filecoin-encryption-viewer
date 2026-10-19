// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { ProtectedEntry } from '../src/car-archive.js'
import { renderContent } from '../src/render.js'
import type { SaveResult } from '../src/save.js'
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

it('shows the label as the page h1 on tree and file screens, and not on the prompt or incomplete link', () => {
  showProtectedArchive(
    container,
    entries,
    async () => {},
    new Map(),
    async () => 'saved'
  )
  expect(label().querySelector('h1')?.textContent).toBe('Encrypted share')
  expect(container.classList.contains('label-card')).toBe(true)
  expect(container.querySelector('#download-all')?.getAttribute('aria-label')).toBe('Download all files as a zip')
  expect(container.querySelector('#download-all')?.textContent).toContain('Download all')
  expect(container.textContent).toContain('1 folder · 1 file · 5 B')

  expect(container.querySelector('.eyebrow')).toBeNull()

  // File views and the save screen put the label outside the card too, without an in-card eyebrow
  const hasLabel = () => label().querySelector('h1')?.textContent === 'Encrypted share'
  const isLabelCard = () => container.classList.contains('label-card')
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }))

  showMissingLink(container)
  expect(hasLabel()).toBe(false)
  expect(isLabelCard()).toBe(false)

  showSaveEntry(container, entries[1], async () => 'saved')
  expect([hasLabel(), isLabelCard(), container.querySelector('.eyebrow')]).toEqual([true, true, null])

  const pdf = new TextEncoder().encode('%PDF-1.4 test')
  const views: [Uint8Array, string][] = [
    [new TextEncoder().encode('hi'), 'text/plain'],
    [new TextEncoder().encode('<p>hi</p>'), 'text/html'],
    [new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg'],
    [new Uint8Array([0, 0, 0, 0x18]), 'video/mp4'],
    [pdf, 'application/pdf'],
    [new Uint8Array([1, 2, 3]), 'application/octet-stream'],
  ]
  for (const [data, type] of views) {
    showMissingLink(container)
    renderContent(container, data, type, 'file', 'file')
    expect([type, hasLabel(), isLabelCard(), container.querySelector('.eyebrow')]).toEqual([type, true, true, null])
  }

  // The prompt and the incomplete-link screen keep their own in-card layout
  showAccessKeyPrompt(container, async () => {})
  expect(label().childElementCount).toBe(0)
  expect(isLabelCard()).toBe(false)
  showProtectedArchive(container, entries, async () => {})
  showMissingLink(container)
  expect(label().childElementCount).toBe(0)
  expect(isLabelCard()).toBe(false)
  expect(container.querySelector('.eyebrow')).not.toBeNull()
})

it('shows progress only in the status line while building', async () => {
  let release: () => void = () => {}
  showProtectedArchive(
    container,
    entries,
    async () => {},
    new Map(),
    (onProgress) =>
      new Promise<SaveResult>((resolve) => {
        onProgress(1, 2)
        release = () => resolve('saved')
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

it('sets tree-card on the folder tree and clears it on file views and other screens', () => {
  showProtectedArchive(container, entries, async () => {})
  expect(container.classList.contains('tree-card')).toBe(true)

  renderContent(container, new TextEncoder().encode('hi'), 'text/plain', 'a.txt')
  expect(container.classList.contains('tree-card')).toBe(false)

  showProtectedArchive(container, entries, async () => {})
  showSaveEntry(container, entries[1], async () => 'saved')
  expect(container.classList.contains('tree-card')).toBe(false)

  showProtectedArchive(container, entries, async () => {})
  showMissingLink(container)
  expect(container.classList.contains('tree-card')).toBe(false)
})

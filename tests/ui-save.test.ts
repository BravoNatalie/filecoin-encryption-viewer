// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import type { ProtectedEntry } from '../src/car-archive.js'
import { showSaveEntry } from '../src/ui.js'

const entry: ProtectedEntry = {
  path: 'sample/docs/big.bin',
  directory: false,
  size: 12_000_000,
  contentType: 'application/octet-stream',
}

it('shows the file name as the heading, with type and size, for large files', () => {
  const container = document.createElement('div')
  showSaveEntry(container, entry, async () => 'saved', false, 'application/pdf')
  const heading = container.querySelector('#save-entry-name') as HTMLElement
  expect(heading.tagName).toBe('H1')
  expect(heading.textContent).toBe('big.bin')
  expect(heading.title).toBe('sample/docs/big.bin')
  expect(container.textContent).toContain('PDF · 12 MB')
  expect(container.textContent).not.toContain('Preview unavailable')
  expect(container.querySelector('#save-entry')?.textContent).toBe('Download file')
})

it('keeps "Preview unavailable" as a note, not the heading', () => {
  const container = document.createElement('div')
  showSaveEntry(container, entry, async () => 'saved', true)
  expect(container.querySelector('#save-entry-name')?.textContent).toBe('big.bin')
  expect(container.querySelector('.note')?.textContent).toBe('Preview unavailable.')
  expect(container.textContent).toContain('Unknown file type · 12 MB')
  expect(container.querySelector('#save-entry')?.textContent).toBe('Download instead')
})

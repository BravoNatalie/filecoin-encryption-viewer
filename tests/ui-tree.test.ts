// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtectedEntry } from '../src/car-archive.js'
import { addBackButton, showProtectedArchive } from '../src/ui.js'

const dir = (path: string): ProtectedEntry => ({
  path: `${path}/`,
  directory: true,
  size: 0,
  contentType: 'inode/directory',
})
const file = (path: string, size = 10): ProtectedEntry => ({
  path,
  directory: false,
  size,
  contentType: 'application/octet-stream',
})

const entries = [
  dir('share'),
  file('share/b.txt', 2048),
  file('share/A.txt'),
  dir('share/zeta'),
  dir('share/alpha'),
  file('share/alpha/x.bin', 12_000_000),
  dir('share/alpha/one'),
  dir('share/alpha/one/two'),
  dir('share/alpha/one/two/three'),
  file('share/alpha/one/two/three/deep.txt'),
]

let container: HTMLElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.replaceChildren(container)
})

describe('showProtectedArchive tree', () => {
  it('lists folders before files, case-insensitively, with sizes and titles', () => {
    showProtectedArchive(container, entries, async () => {})
    const rootList = container.querySelector('details ul') as HTMLElement
    const names = Array.from(rootList.children).map((item) => item.querySelector('.tree-name')?.textContent)
    expect(names).toEqual(['alpha', 'zeta', 'A.txt', 'b.txt'])
    expect(container.querySelector('.tree-name[title="A.txt"]')).not.toBeNull()
    expect(container.querySelector('button.tree-file .tree-size')?.textContent).toBeTruthy()
    expect(container.textContent).toContain('12 MB')
    expect(container.querySelectorAll('svg[aria-hidden="true"]').length).toBeGreaterThan(3)
  })

  it('opens folders down to depth 2 and collapses deeper ones', () => {
    showProtectedArchive(container, entries, async () => {})
    const open = (name: string) =>
      Array.from(container.querySelectorAll('details')).find((d) => d.querySelector('.tree-name')?.textContent === name)
        ?.open
    expect(open('share')).toBe(true)
    expect(open('alpha')).toBe(true)
    expect(open('one')).toBe(true)
    expect(open('two')).toBe(false)
  })

  it('restores folder state passed back in', () => {
    const state = new Map<string, boolean>([['share/alpha', false]])
    showProtectedArchive(container, entries, async () => {}, state)
    const alpha = Array.from(container.querySelectorAll('details')).find(
      (d) => d.querySelector('.tree-name')?.textContent === 'alpha'
    )
    expect(alpha?.open).toBe(false)
  })

  it('calls onSelect with the entry when a file is clicked', async () => {
    const onSelect = vi.fn(async () => {})
    showProtectedArchive(container, entries, onSelect)
    ;(container.querySelector('button.tree-file') as HTMLButtonElement).click()
    await Promise.resolve()
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('adds a back button that calls the handler', () => {
    const onBack = vi.fn()
    addBackButton(container, onBack)
    const button = container.querySelector('#back-btn') as HTMLButtonElement
    expect(button.textContent).toBe('← All files')
    button.click()
    expect(onBack).toHaveBeenCalledOnce()
  })
})

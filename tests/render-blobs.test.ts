// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isBinaryPreviewType, renderContent, revokePdfObjectUrls } from '../src/render.js'

const text = (value: string) => new TextEncoder().encode(value)
// JPEG magic bytes are enough: the type is passed in, as main.ts does after sniffing
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])

let blobs: Map<string, Blob>
let container: HTMLElement

beforeEach(() => {
  blobs = new Map()
  const createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:test-${blobs.size + 1}`
    blobs.set(url, blob)
    return url
  })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
  document.body.innerHTML = '<div id="app"></div>'
  container = document.getElementById('app') as HTMLElement
})
afterEach(() => {
  revokePdfObjectUrls()
  vi.unstubAllGlobals()
})

const downloadLinks = () => Array.from(container.querySelectorAll<HTMLAnchorElement>('a[download]'))

describe('blob types', () => {
  it.each([
    ['text/html', '<html><script>alert(1)</script></html>'],
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['application/xml', '<?xml version="1.0"?><a/>'],
    ['text/xml', '<a/>'],
    ['application/xhtml+xml', '<html xmlns="http://www.w3.org/1999/xhtml"/>'],
    ['text/plain', 'hello'],
    ['application/octet-stream', 'bytes'],
  ])('%s: every Download link is an octet-stream blob', (type, body) => {
    renderContent(container, text(body), type, 'file')

    expect(downloadLinks().length).toBeGreaterThan(0)
    for (const link of downloadLinks()) {
      expect(blobs.get(link.getAttribute('href') ?? '')?.type).toBe('application/octet-stream')
    }
    expect([...blobs.values()].every((blob) => blob.type === 'application/octet-stream')).toBe(true)
  })

  it('shows SVG as source text, never as an <img>', () => {
    renderContent(container, text('<svg><script>alert(1)</script></svg>'), 'image/svg+xml', 'logo.svg')

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe('<svg><script>alert(1)</script></svg>')
    expect(isBinaryPreviewType('image/svg+xml')).toBe(false)
  })

  it('keeps the real type for a JPEG preview, with a separate octet-stream Download', () => {
    renderContent(container, jpeg, 'image/jpeg', 'photo.jpg')

    const src = container.querySelector('img')?.getAttribute('src') ?? ''
    expect(blobs.get(src)?.type).toBe('image/jpeg')
    expect(blobs.get(downloadLinks()[0].getAttribute('href') ?? '')?.type).toBe('application/octet-stream')
  })

  it('keeps application/pdf for the new-tab link', () => {
    renderContent(container, text('%PDF-1.4\n'), 'application/pdf', 'a.pdf')

    const open = container.querySelector('a.pdf-open')?.getAttribute('href') ?? ''
    expect(blobs.get(open)?.type).toBe('application/pdf')
    expect(blobs.get(downloadLinks()[0].getAttribute('href') ?? '')?.type).toBe('application/octet-stream')
  })

  it('does not preview raster types outside the allowlist', () => {
    expect(isBinaryPreviewType('image/x-icon')).toBe(false)
    expect(isBinaryPreviewType('image/webp')).toBe(true)
  })
})

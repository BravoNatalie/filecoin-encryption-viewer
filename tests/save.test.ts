import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_DOCUMENT_PREVIEW_BYTES } from '../src/decrypt.js'
import { TooLargeError } from '../src/errors.js'
import { saveEntry } from '../src/save.js'

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('saveEntry', () => {
  it('pipes a large entry directly into the Chromium file writer', async () => {
    const written: number[] = []
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(...chunk)
      },
    })
    const createWritable = vi.fn(async () => writable)
    const picker = vi.fn(async () => ({ createWritable }))
    vi.stubGlobal('showSaveFilePicker', picker)
    const open = vi.fn(async () => byteStream(new Uint8Array([1, 2]), new Uint8Array([3, 4])))

    await expect(
      saveEntry(
        {
          size: MAX_DOCUMENT_PREVIEW_BYTES + 1,
          contentType: 'application/octet-stream',
          open,
        },
        'archive.bin'
      )
    ).resolves.toBe('saved')

    expect(picker).toHaveBeenCalledWith({ suggestedName: 'archive.bin' })
    expect(createWritable).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledOnce()
    expect(written).toEqual([1, 2, 3, 4])
  })

  describe('without the file picker API', () => {
    const MIB = 1024 * 1024

    function stubDownload() {
      vi.stubGlobal('showSaveFilePicker', undefined)
      const link = { href: '', download: '', hidden: false, click: vi.fn(), remove: vi.fn() }
      vi.stubGlobal('document', { createElement: () => link, body: { append: vi.fn() } })
      const createObjectURL = vi.fn((_blob: Blob) => 'blob:file')
      vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
      return { link, createObjectURL }
    }

    it('builds the Blob from the parts, above the old 8 MiB limit', async () => {
      const { link, createObjectURL } = stubDownload()
      vi.stubGlobal('navigator', { userAgentData: { mobile: false } })
      const open = vi.fn(async () => byteStream(new Uint8Array([1, 2]), new Uint8Array([3, 4])))

      await expect(
        saveEntry({ size: MAX_DOCUMENT_PREVIEW_BYTES + 1, contentType: 'application/octet-stream', open }, 'big.bin')
      ).resolves.toBe('saved')

      const blob = createObjectURL.mock.calls[0][0]
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
      expect(link.download).toBe('big.bin')
    })

    it.each([
      ['desktop', { userAgentData: { mobile: false } }, 1024 * MIB + 1],
      ['mobile (userAgentData)', { userAgentData: { mobile: true } }, 256 * MIB + 1],
    ])('refuses above the %s cap without opening the entry', async (_name, navigator, size) => {
      stubDownload()
      vi.stubGlobal('navigator', navigator)
      const open = vi.fn(async () => byteStream(new Uint8Array([1])))

      await expect(
        saveEntry({ size, contentType: 'application/octet-stream', open }, 'big.bin')
      ).rejects.toBeInstanceOf(TooLargeError)
      expect(open).not.toHaveBeenCalled()
    })

    it('treats a touch-only pointer as mobile when userAgentData is missing', async () => {
      stubDownload()
      vi.stubGlobal('navigator', {})
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }))
      const open = vi.fn(async () => byteStream(new Uint8Array([1])))

      await expect(
        saveEntry({ size: 300 * MIB, contentType: 'application/octet-stream', open }, 'big.bin')
      ).rejects.toBeInstanceOf(TooLargeError)
    })

    it('stops reading when the stream outgrows the cap although the declared size was missing', async () => {
      stubDownload()
      vi.stubGlobal('navigator', { userAgentData: { mobile: false } })
      const cancel = vi.fn()
      const open = vi.fn(
        async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue({ length: 1024 * MIB + 1 } as Uint8Array)
            },
            cancel,
          })
      )

      await expect(
        saveEntry({ size: 0, contentType: 'application/octet-stream', open }, 'x.fee')
      ).rejects.toBeInstanceOf(TooLargeError)
      expect(cancel).toHaveBeenCalled()
    })
  })

  it('revokes the bounded fallback download URL', async () => {
    vi.stubGlobal('showSaveFilePicker', undefined)
    const click = vi.fn()
    const remove = vi.fn()
    const append = vi.fn()
    const link = { href: '', download: '', hidden: false, click, remove }
    vi.stubGlobal('document', {
      createElement: () => link as unknown as HTMLAnchorElement,
      body: { append },
    })
    const createObjectURL = vi.fn(() => 'blob:bounded-entry')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })

    const open = vi.fn(async () => byteStream(new Uint8Array([7, 8, 9])))
    await expect(saveEntry({ size: 3, contentType: 'image/png', open }, 'small.png')).resolves.toBe('saved')

    expect(click).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:bounded-entry')
  })
})

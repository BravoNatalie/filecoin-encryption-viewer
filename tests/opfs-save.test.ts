import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooLargeError } from '../src/errors.js'
import { exactBytes, removeStagedFiles } from '../src/opfs-save.js'
import { revokeStagedUrl, saveEntry } from '../src/save.js'
import { expectSameBytes } from './fixtures/bytes.js'
import { stubDownload, stubOpfs } from './fixtures/fake-opfs.js'

const MIB = 1024 * 1024

// A file made of subarray views over shared buffers, like the archive's batches
function viewStream(data: Uint8Array, viewSize = 100_000, batch = 400_000): ReadableStream<Uint8Array> {
  const chunks: Uint8Array[] = []
  for (let start = 0; start < data.length; start += batch) {
    const buffer = data.slice(start, start + batch)
    for (let at = 0; at < buffer.length; at += viewSize) chunks.push(buffer.subarray(at, at + viewSize))
  }
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

const sample = new Uint8Array(1_000_000).map((_, index) => (index * 7) % 251)
const entry = (size = sample.length) => ({
  size,
  contentType: 'application/octet-stream',
  open: vi.fn(async () => viewStream(sample)),
})
const stagedBytes = async (files: Map<string, Uint8Array[]>) => {
  const [parts] = [...files.values()]
  return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
}

afterEach(() => {
  revokeStagedUrl()
  vi.unstubAllGlobals()
})

describe('exactBytes', () => {
  it('copies views and passes whole buffers through', () => {
    const whole = new Uint8Array([1, 2, 3])
    expect(exactBytes(whole)).toBe(whole)
    const view = new Uint8Array([1, 2, 3, 4]).subarray(1, 3)
    const copy = exactBytes(view)
    expect(copy.buffer.byteLength).toBe(2)
    expect([...copy]).toEqual([2, 3])
  })
})

describe('saveEntry order', () => {
  it('uses the picker when there is one', async () => {
    const { files } = stubOpfs()
    const { createObjectURL } = stubDownload()
    const written: number[] = []
    const picker = vi.fn(async () => ({
      createWritable: async () => new WritableStream<Uint8Array>({ write: (chunk) => void written.push(chunk.length) }),
    }))
    vi.stubGlobal('showSaveFilePicker', picker)

    await saveEntry(entry(), 'a.bin')

    expect(picker).toHaveBeenCalledOnce()
    expect(files.size).toBe(0)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('stages in OPFS when there is no picker, and the bytes match', async () => {
    const { files } = stubOpfs({ webkit: true })
    const { link, createObjectURL, revokeObjectURL } = stubDownload()

    await expect(saveEntry(entry(), 'a.bin')).resolves.toBe('saved')

    expect([...files.keys()]).toHaveLength(1)
    expect([...files.keys()][0]).toMatch(/^foc-viewer-save-.+\.part$/)
    expectSameBytes(await stagedBytes(files), sample)
    expect(link.download).toBe('a.bin')
    expect(link.click).toHaveBeenCalledOnce()
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(File)
    // nothing is deleted or revoked right after the click
    expect(files.size).toBe(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('falls back to the Blob when getDirectory throws', async () => {
    const { files } = stubOpfs({ throwOnGetDirectory: true })
    const { createObjectURL } = stubDownload()
    await saveEntry(entry(), 'a.bin')
    expect(files.size).toBe(0)
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob).toBeInstanceOf(Blob)
    expectSameBytes(new Uint8Array(await blob.arrayBuffer()), sample)
  })

  it('falls back to the Blob when createWritable is missing', async () => {
    const { files } = stubOpfs({ noCreateWritable: true })
    const { createObjectURL } = stubDownload()
    await saveEntry(entry(), 'a.bin')
    expect(files.size).toBe(0)
    expect(createObjectURL.mock.calls[0][0]).not.toBeInstanceOf(File)
  })
})

describe('staging failures', () => {
  it('removes the partial file on a quota error and falls back to the Blob when small enough', async () => {
    const { files, removed } = stubOpfs({ quota: 300_000 })
    const { createObjectURL } = stubDownload()
    const source = entry()

    await expect(saveEntry(source, 'a.bin')).resolves.toBe('saved')

    expect(removed).toHaveLength(1)
    expect(files.size).toBe(0)
    expect(source.open).toHaveBeenCalledTimes(2)
    expectSameBytes(new Uint8Array(await createObjectURL.mock.calls[0][0].arrayBuffer()), sample)
  })

  it('shows the too-large error when the file does not fit the Blob cap either', async () => {
    const { files } = stubOpfs({ quota: 300_000 })
    const { createObjectURL } = stubDownload()
    const source = { ...entry(), size: 600 * MIB }

    await expect(saveEntry(source, 'a.bin')).rejects.toBeInstanceOf(TooLargeError)

    expect(files.size).toBe(0)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('removes the partial file and rethrows when the source stream fails', async () => {
    const { files } = stubOpfs()
    stubDownload()
    const failing = {
      size: 10,
      contentType: 'x',
      open: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(5))
            controller.error(new Error('source broke'))
          },
        }),
    }
    await expect(saveEntry(failing, 'a.bin')).rejects.toThrow('source broke')
    expect(files.size).toBe(0)
  })
})

describe('cleanup and progress', () => {
  it('deletes the previous staged file at the start of the next save, and revokes its URL', async () => {
    const { files } = stubOpfs()
    const { revokeObjectURL } = stubDownload()
    await saveEntry(entry(), 'a.bin')
    const first = [...files.keys()][0]

    await saveEntry(entry(), 'b.bin')

    expect(files.has(first)).toBe(false)
    expect(files.size).toBe(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:file')
  })

  it('sweeps leftovers at startup but only the staged ones', async () => {
    const { files } = stubOpfs()
    files.set('foc-viewer-save-old.part', [])
    files.set('other.txt', [])

    await removeStagedFiles()

    expect([...files.keys()]).toEqual(['other.txt'])
  })

  it('reports increasing progress up to the full size', async () => {
    stubOpfs()
    stubDownload()
    const seen: number[] = []
    await saveEntry(entry(), 'a.bin', (written) => seen.push(written))
    expect(seen.length).toBeGreaterThan(1)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(seen.at(-1)).toBe(sample.length)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooLargeError } from '../src/errors.js'
import { exactBytes, removeOwnStagedFiles, removeStagedFiles } from '../src/opfs-save.js'
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

afterEach(async () => {
  await removeOwnStagedFiles() // this tab's staged-file state is module-level
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

  it('keeps a file whose save is still writing when another save starts in the same tab', async () => {
    const { files, held } = stubOpfs()
    stubDownload()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        c.enqueue(new Uint8Array([1, 2]))
      },
    })
    const first = saveEntry({ size: 4, contentType: 'x', open: async () => slow }, 'a.bin')
    await vi.waitFor(() => expect(held.size).toBe(1))
    const [firstName] = held

    await saveEntry(entry(), 'b.bin')

    expect(files.has(firstName)).toBe(true)
    controller.enqueue(new Uint8Array([3, 4]))
    controller.close()
    await first
    expect([...(files.get(firstName) ?? [])].flatMap((part) => [...part])).toEqual([1, 2, 3, 4])
  })

  it('startup sweep skips a file another tab holds a lock on, and deletes an unlocked one', async () => {
    const { files, held } = stubOpfs()
    files.set('foc-viewer-save-open-in-another-tab.part', [])
    files.set('foc-viewer-save-left-by-a-closed-tab.part', [])
    held.add('foc-viewer-save-open-in-another-tab.part')

    await removeStagedFiles()

    expect([...files.keys()]).toEqual(['foc-viewer-save-open-in-another-tab.part'])
  })

  it('releases the lock of its previous file when it deletes it', async () => {
    const { files, held } = stubOpfs()
    stubDownload()
    await saveEntry(entry(), 'a.bin')
    const [first] = held
    expect(held.size).toBe(1)

    await saveEntry(entry(), 'b.bin')

    expect(files.has(first)).toBe(false)
    expect(held.has(first)).toBe(false)
    expect(held.size).toBe(1)
  })

  it('without Web Locks only deletes its own finished files, never other tabs', async () => {
    const { files } = stubOpfs({ noLocks: true })
    stubDownload()
    files.set('foc-viewer-save-other-tab.part', [])
    await saveEntry(entry(), 'a.bin')
    const own = [...files.keys()].find((name) => name !== 'foc-viewer-save-other-tab.part')

    await removeStagedFiles()
    await saveEntry(entry(), 'b.bin')

    expect(files.has('foc-viewer-save-other-tab.part')).toBe(true)
    expect(files.has(own ?? '')).toBe(false)
  })

  it(
    'saves without a lock when Web Locks rejects, and still cleans up its own file later',
    { timeout: 2000 },
    async () => {
      const { files } = stubOpfs({ rejectLocks: true })
      stubDownload()
      await saveEntry(entry(), 'a.bin')
      const first = [...files.keys()][0]
      expectSameBytes(await stagedBytes(files), sample)

      await saveEntry(entry(), 'b.bin')

      expect(files.has(first)).toBe(false)
      expect(files.size).toBe(1)
    }
  )

  it('revokes the URLs of overlapping saves, not just the last one', async () => {
    stubOpfs()
    const { createObjectURL, revokeObjectURL } = stubDownload()
    let n = 0
    createObjectURL.mockImplementation(() => `blob:save-${++n}`)
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        c.enqueue(new Uint8Array([1]))
      },
    })
    const first = saveEntry({ size: 2, contentType: 'x', open: async () => slow }, 'a.bin')
    await vi.waitFor(() => expect(controller).toBeDefined())

    await saveEntry(entry(), 'b.bin') // finishes first: blob:save-1
    controller.enqueue(new Uint8Array([2]))
    controller.close()
    await first // finishes second: blob:save-2
    expect(revokeObjectURL).not.toHaveBeenCalled()

    revokeStagedUrl() // the next save's start, or pagehide
    expect(revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual(['blob:save-1', 'blob:save-2'])
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

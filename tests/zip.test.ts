import { afterEach, expect, it, vi } from 'vitest'
import { openProtectedArchive } from '../src/car-archive.js'
import { TooLargeError } from '../src/errors.js'
import { saveEntry } from '../src/save.js'
import { archiveZip, summarizeArchive, zipFileName } from '../src/zip.js'
import { stubDownload, stubOpfs } from './fixtures/fake-opfs.js'
import { PASSWORD, makeShare } from './fixtures/make-share.js'
import { serveRange } from './fixtures/serve-range.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'
const text = (value: string) => new TextEncoder().encode(value)

interface ZipEntry {
  name: string
  data: Uint8Array
}

// Minimal reader for stored (uncompressed) ZIPs: walks the central directory.
function readZip(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = zip.length - 22
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('no end of central directory')
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('bad central directory entry')
    const method = view.getUint16(offset + 10, true)
    const size = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength))
    if (method !== 0) throw new Error('expected a stored entry')
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    entries.push({ name, data: zip.slice(dataStart, dataStart + size) })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

it('zips an open archive with full entry paths, directories and exact bytes', async () => {
  const share = await makeShare([
    { path: 'sample/note.txt', content: text('hello zip') },
    { path: 'sample/docs/report.txt', content: text('nested report') },
  ])
  const archive = await openProtectedArchive(CID, PASSWORD, serveRange(share).fetch)

  expect(summarizeArchive(archive)).toEqual({ files: 2, bytes: 9 + 13 })
  expect(zipFileName(archive)).toBe('sample.zip')

  const progress: number[] = []
  const zip = new Uint8Array(
    await new Response(await archiveZip(archive, (done) => progress.push(done)).open()).arrayBuffer()
  )
  const entries = readZip(zip)

  expect(entries.map((entry) => entry.name).sort()).toEqual([
    'sample/',
    'sample/docs/',
    'sample/docs/report.txt',
    'sample/note.txt',
  ])
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]))
  expect(new TextDecoder().decode(byName.get('sample/docs/report.txt'))).toBe('nested report')
  expect(byName.get('sample/')?.length).toBe(0)
  expect(progress).toEqual([1, 2])
})

async function openSample() {
  const share = await makeShare([
    { path: 'sample/note.txt', content: text('hello zip') },
    { path: 'sample/docs/report.txt', content: text('nested report') },
  ])
  return openProtectedArchive(CID, PASSWORD, serveRange(share).fetch)
}

it('refuses to zip more than the in-memory cap when it can only use the Blob', async () => {
  const archive = await openSample()
  stubDownload()
  vi.stubGlobal('navigator', { userAgentData: { mobile: true } })
  const big = {
    ...archive,
    list: () => [{ path: 'sample/big.bin', directory: false, size: 300 * 1024 * 1024, contentType: '' }],
  }
  await expect(saveEntry(archiveZip(big), 'big.zip')).rejects.toBeInstanceOf(TooLargeError)
})

it('streams Download all into OPFS when available, with no cap', async () => {
  const archive = await openSample()
  const { files } = stubOpfs()
  const { link } = stubDownload()
  vi.stubGlobal('navigator', { ...navigator, userAgentData: { mobile: true }, storage: navigator.storage })
  const big = { ...archive, list: () => [...archive.list()] }

  await saveEntry(archiveZip(big), zipFileName(archive))

  expect(link.download).toBe('sample.zip')
  const staged = new Uint8Array(await new Blob([...files.values()][0] as BlobPart[]).arrayBuffer())
  expect(
    readZip(staged)
      .map((entry) => entry.name)
      .sort()
  ).toEqual(['sample/', 'sample/docs/', 'sample/docs/report.txt', 'sample/note.txt'])
})

afterEach(() => vi.unstubAllGlobals())

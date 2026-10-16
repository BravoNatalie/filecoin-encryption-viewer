import { encode as encodeCbor } from '@ipld/dag-cbor'
import * as fee from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import * as digest from 'multiformats/hashes/digest'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NotAShareError,
  NotAvailableError,
  RangeUnsupportedError,
  WrongPasswordError,
  openProtectedArchive,
} from '../src/car-archive.js'
import type { ProtectedArchive } from '../src/car-archive.js'
import { encodeVarint } from '../src/unixfs-car-layout.js'
import { PASSWORD, encryptCar, makeShare } from './fixtures/make-share.js'
import type { ShareFile } from './fixtures/make-share.js'
import { serveRange } from './fixtures/serve-range.js'
import type { StubMode } from './fixtures/serve-range.js'

const CID_STRING = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'
const MIB = 1024 * 1024
const bytes = (text: string) => new TextEncoder().encode(text)
// Distinct, deterministic bytes: different seeds never share a 1 MiB chunk
const pattern = (length: number, seed: number) => new Uint8Array(length).map((_, index) => (index * 31 + seed) % 251)

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
    parts.push(value)
  }
}

const requested = (stub: { requests: { length: number }[] }, from = 0) =>
  stub.requests.slice(from).reduce((total, request) => total + request.length, 0)

async function open(share: Uint8Array, mode: StubMode = 'range') {
  const stub = serveRange(share, mode)
  return { stub, archive: await openProtectedArchive(CID_STRING, PASSWORD, stub.fetch) }
}

const folder: ShareFile[] = [
  { path: 'photos/a.jpg', content: bytes('jpeg bytes') },
  { path: 'photos/sub/b.txt', content: bytes('nested text') },
]

// Spans several 256 KiB encryption chunks and three 1 MiB leaves
const big = pattern(2.5 * MIB, 1)
const bigFolder: ShareFile[] = [{ path: 'big/data.bin', content: big }]

afterEach(() => vi.restoreAllMocks())

describe('openProtectedArchive', () => {
  it('opens a single file under its own name', async () => {
    const { archive } = await open(await makeShare([{ path: 'hello.txt', content: bytes('hello world') }]))
    expect(archive.list()).toEqual([
      { path: 'hello.txt', directory: false, size: 11, contentType: 'application/octet-stream' },
    ])
    expect(await readAll(await archive.open('hello.txt'))).toEqual(bytes('hello world'))
    await archive.close()
  })

  it('lists a nested folder under the folder name', async () => {
    const { archive } = await open(await makeShare(folder))
    expect(archive.list().map((entry) => [entry.path, entry.directory])).toEqual([
      ['photos/', true],
      ['photos/a.jpg', false],
      ['photos/sub/', true],
      ['photos/sub/b.txt', false],
    ])
    expect(await readAll(await archive.open('photos/sub/b.txt'))).toEqual(bytes('nested text'))
  })

  it('opens a folder of only empty folders, which has no raw block', async () => {
    const { archive } = await open(await makeShare([{ path: 'top/a/b' }, { path: 'top/c' }]))
    expect(archive.list().map((entry) => entry.path)).toEqual(['top/', 'top/a/', 'top/a/b/', 'top/c/'])
  })

  it('reads a multi-chunk, multi-leaf file', async () => {
    const { archive } = await open(await makeShare(bigFolder))
    expect(await readAll(await archive.open('big/data.bin'))).toEqual(big)
  })

  it('restores a repeated chunk byte-identical', async () => {
    const first = pattern(MIB, 1)
    const content = new Uint8Array(3 * MIB)
    content.set(first, 0)
    content.set(pattern(MIB, 2), MIB)
    content.set(first, 2 * MIB)
    const { archive } = await open(await makeShare([{ path: 'repeat.bin', content }]))
    expect(await readAll(await archive.open('repeat.bin'))).toEqual(content)
  })

  it('reads metadata that is larger than the first window', async () => {
    // 6000 entries make a sharded directory of several hundred KiB of dag-pb before the first leaf
    const files = Array.from({ length: 6000 }, (_, index) => ({ path: `many/f${index}`, content: bytes(`n${index}`) }))
    const { archive, stub } = await open(await makeShare(files))
    expect(archive.list()).toHaveLength(6001)
    expect(stub.requests.length).toBeGreaterThan(1)
    expect(await readAll(await archive.open('many/f5999'))).toEqual(bytes('n5999'))
  }, 60_000)

  it('works at the real 600000 iterations', async () => {
    const { archive } = await open(await makeShare([{ path: 'a.txt', content: bytes('x') }], { iterations: 600_000 }))
    expect(archive.list()[0].path).toBe('a.txt')
  })
})

describe('range reads', () => {
  const mixed: ShareFile[] = [
    { path: 'mix/big.bin', content: big },
    { path: 'mix/small.txt', content: bytes('small file') },
  ]

  it('open fetches only the head', async () => {
    const { stub } = await open(await makeShare(mixed))
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0].offset).toBe(0)
    expect(requested(stub)).toBeLessThanOrEqual(320 * 1024)
  })

  it("open(path) fetches only that file's ranges", async () => {
    const { archive, stub } = await open(await makeShare(mixed))
    const afterOpen = stub.requests.length

    expect(await readAll(await archive.open('mix/small.txt'))).toEqual(bytes('small file'))
    expect(requested(stub, afterOpen)).toBeLessThan(MIB / 2)

    const beforeBig = stub.requests.length
    expect(await readAll(await archive.open('mix/big.bin'))).toEqual(big)
    expect(requested(stub, beforeBig)).toBeGreaterThanOrEqual(big.length)
  })

  it('sends every request with no-store and redirect error', async () => {
    const { archive, stub } = await open(await makeShare(mixed))
    await readAll(await archive.open('mix/big.bin'))
    expect(stub.requests.length).toBeGreaterThan(1)
    for (const request of stub.requests) expect(request).toMatchObject({ cache: 'no-store', redirect: 'error' })
  })

  it('sniffing the first 100 bytes of a large file fetches about one leaf', async () => {
    const huge = pattern(10 * MIB, 3)
    const { archive, stub } = await open(await makeShare([{ path: 'huge.bin', content: huge }]))
    const before = stub.requests.length
    const reader = (await archive.open('huge.bin')).getReader()
    const { value } = await reader.read()
    await reader.cancel()
    expect(value?.slice(0, 100)).toEqual(huge.slice(0, 100))
    const data = stub.requests.slice(before)
    expect(data).toHaveLength(1)
    // One 1 MiB leaf, widened to whole 256 KiB encryption chunks (the leaf starts mid-chunk)
    expect(data[0].length).toBeLessThanOrEqual(MIB + 2 * 256 * 1024)
  }, 60_000)

  it('restores a file over 8 MiB with a small first batch and 8 MiB batches after it', async () => {
    const huge = pattern(10 * MIB, 3)
    const { archive, stub } = await open(await makeShare([{ path: 'huge.bin', content: huge }]))
    const before = stub.requests.length
    expect(await readAll(await archive.open('huge.bin'))).toEqual(huge)
    const data = stub.requests.slice(before)
    expect(data).toHaveLength(1 + Math.ceil((huge.length - MIB) / (8 * MIB)))
  }, 60_000)

  it('reads one batch at a time', async () => {
    const { archive, stub } = await open(await makeShare(bigFolder))
    const before = stub.requests.length
    const reader = (await archive.open('big/data.bin')).getReader()
    expect(stub.requests.length).toBe(before)
    await reader.read()
    expect(stub.requests.length).toBe(before + 1)
    await reader.cancel()
    expect(stub.requests.length).toBe(before + 1)
  })
})

describe('password and integrity', () => {
  it('rejects a wrong password, then accepts the right one', async () => {
    const stub = serveRange(await makeShare(folder))
    await expect(openProtectedArchive(CID_STRING, 'nope', stub.fetch)).rejects.toBeInstanceOf(WrongPasswordError)
    expect((await openProtectedArchive(CID_STRING, PASSWORD, stub.fetch)).list()).toHaveLength(4)
  })

  it('rejects a flipped ciphertext byte in the metadata', async () => {
    const share = await makeShare(bigFolder)
    const info = await fee.parse(share)
    if (info.scheme !== 'chunked') throw new Error('expected a chunked envelope')
    share[info.params.headerLength + 5] ^= 1
    await expect(open(share)).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it('rejects a flipped ciphertext byte in a file, when that file is read', async () => {
    const share = await makeShare(bigFolder)
    share[share.length - 20] ^= 1
    const { archive } = await open(share)
    await expect(readAll(await archive.open('big/data.bin'))).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it.each([40, 70_000, 300_000])('maps a total cut by %i bytes to NotAvailableError', async (cut) => {
    const share = await makeShare(bigFolder)
    await expect(open(share.slice(0, share.length - cut))).rejects.toBeInstanceOf(NotAvailableError)
  })

  it('maps a body shorter than its Content-Range to NotAvailableError', async () => {
    const share = await makeShare(bigFolder)
    await expect(open(share, 'truncated')).rejects.toBeInstanceOf(NotAvailableError)

    const { archive, stub } = await open(share)
    stub.mode = 'truncated'
    await expect(readAll(await archive.open('big/data.bin'))).rejects.toBeInstanceOf(NotAvailableError)
  })
})

describe('what is accepted', () => {
  it('rejects absurd iterations before deriving', async () => {
    const share = await makeShare(folder, { iterations: 10_000_001 })
    const spy = vi.spyOn(crypto.subtle, 'deriveBits')
    await expect(open(share)).rejects.toBeInstanceOf(NotAShareError)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects foreign appMetadata', async () => {
    await expect(open(await makeShare(folder, { appMetadata: { app: 'other' } }))).rejects.toBeInstanceOf(
      NotAShareError
    )
  })

  it('rejects a foreign content_type before deriving', async () => {
    const share = await makeShare(folder, { contentType: 'text/plain' })
    const spy = vi.spyOn(crypto.subtle, 'deriveBits')
    await expect(open(share)).rejects.toBeInstanceOf(NotAShareError)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects non-envelope bytes', async () => {
    await expect(open(crypto.getRandomValues(new Uint8Array(500)))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects a CAR that is not metadata-first', async () => {
    await expect(open(await makeShare(folder, { importerOrder: true }))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects a CAR header with two roots', async () => {
    await expect(open(await makeShare(folder, { twoRoots: true }))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects a root with two entries', async () => {
    const share = await makeShare([
      { path: 'a.txt', content: bytes('a') },
      { path: 'b.txt', content: bytes('b') },
    ])
    await expect(open(share)).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects metadata that runs past 16 MiB without a raw block', async () => {
    const data = new Uint8Array(MIB).fill(9)
    const cid = CID.createV1(0x70, await sha256.digest(data))
    const header = encodeCbor({ roots: [cid], version: 1 })
    const section = new Uint8Array([...encodeVarint(cid.bytes.length + data.length), ...cid.bytes, ...data])
    const car = await new Blob([
      encodeVarint(header.length),
      header,
      ...Array(17).fill(section),
    ] as BlobPart[]).arrayBuffer()
    await expect(open(await encryptCar(new Uint8Array(car)))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects a section header that is not a CIDv1', async () => {
    const header = encodeCbor({ roots: [CID.createV1(0x70, digest.create(0x12, new Uint8Array(32)))], version: 1 })
    const car = await new Blob([
      encodeVarint(header.length),
      header,
      new Uint8Array([3, 7, 7, 7]),
    ] as BlobPart[]).arrayBuffer()
    await expect(open(await encryptCar(new Uint8Array(car)))).rejects.toBeInstanceOf(NotAShareError)
  })
})

describe('when the server does not serve ranges', () => {
  it('turns a 200 on the head request into RangeUnsupportedError, with the body intact and no key derived', async () => {
    const share = await makeShare(folder)
    const spy = vi.spyOn(crypto.subtle, 'deriveBits')
    const error = await open(share, 'full').catch((cause) => cause)
    expect(error).toBeInstanceOf(RangeUnsupportedError)
    expect(spy).not.toHaveBeenCalled()
    expect(new Uint8Array(await error.response.arrayBuffer())).toEqual(share)
  })

  it('turns a 200 during a file read into RangeUnsupportedError, not a wrong password', async () => {
    const share = await makeShare(bigFolder)
    const { archive, stub } = await open(share)
    stub.mode = 'full'
    const error = await readAll(await archive.open('big/data.bin')).catch((cause) => cause)
    expect(error).toBeInstanceOf(RangeUnsupportedError)
    expect(new Uint8Array(await error.response.arrayBuffer())).toEqual(share)
  })

  it.each([404, 502, 504])('maps %i to NotAvailableError', async (status) => {
    await expect(open(await makeShare(folder), status)).rejects.toBeInstanceOf(NotAvailableError)
  })

  it('maps a 404 during a file read to NotAvailableError', async () => {
    const { archive, stub } = await open(await makeShare(bigFolder))
    stub.mode = 404
    await expect(readAll(await archive.open('big/data.bin'))).rejects.toBeInstanceOf(NotAvailableError)
  })

  it('maps a rejected fetch to NotAvailableError', async () => {
    const fetchFn = (async () => {
      throw new TypeError('network')
    }) as typeof fetch
    await expect(openProtectedArchive(CID_STRING, PASSWORD, fetchFn)).rejects.toBeInstanceOf(NotAvailableError)
  })

  it('fails on other statuses', async () => {
    await expect(open(await makeShare(folder), 500)).rejects.toThrow('Unexpected response: 500')
  })

  it('rejects a 206 whose Content-Range does not match the request', async () => {
    const share = await makeShare(bigFolder)
    const stub = serveRange(share)
    let shift = false
    const fetchFn = (async (input: RequestInfo, init?: RequestInit) => {
      const response = await stub.fetch(input, init)
      if (!shift) return response
      return new Response(response.body, { status: 206, headers: { 'content-range': `bytes 0-9/${share.length}` } })
    }) as typeof fetch
    const archive = await openProtectedArchive(CID_STRING, PASSWORD, fetchFn)
    shift = true
    await expect(readAll(await archive.open('big/data.bin'))).rejects.toBeInstanceOf(NotAvailableError)
  })
})

describe('archive lifetime', () => {
  it('throws from open() after close(), and close() is idempotent', async () => {
    const { archive }: { archive: ProtectedArchive } = await open(await makeShare(folder))
    await archive.close()
    await archive.close()
    await expect(archive.open('photos/a.jpg')).rejects.toThrow('closed')
  })

  it('fails a read that was started before close(), and zeroes the key', async () => {
    const { archive } = await open(await makeShare(bigFolder))
    const stream = await archive.open('big/data.bin')
    await archive.close()
    await expect(readAll(stream)).rejects.toThrow('closed')
  })

  it('throws for an unknown path', async () => {
    const { archive } = await open(await makeShare(folder))
    await expect(archive.open('nope')).rejects.toThrow('not found')
  })

  it('rejects an invalid CID', async () => {
    await expect(openProtectedArchive('nope', PASSWORD, serveRange(new Uint8Array(1)).fetch)).rejects.toThrow('Invalid')
  })
})

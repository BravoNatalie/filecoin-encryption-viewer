import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NotAShareError,
  NotAvailableError,
  TooLargeError,
  WrongPasswordError,
  openProtectedArchive,
} from '../src/car-archive.js'
import type { ProtectedArchive } from '../src/car-archive.js'
import { PASSWORD, makeShare } from './fixtures/make-share.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'
const bytes = (text: string) => new TextEncoder().encode(text)

function serve(body: Uint8Array, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body as BodyInit, { status: 200, ...init })) as typeof fetch
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const folder = [
  { path: 'photos/a.jpg', content: bytes('jpeg bytes') },
  { path: 'photos/sub/b.txt', content: bytes('nested text') },
]

// > 256 KiB so the share spans several encryption chunks
const bigFolder = [{ path: 'big/data.bin', content: new Uint8Array(600_000).map((_, index) => index % 251) }]

afterEach(() => vi.restoreAllMocks())

describe('openProtectedArchive', () => {
  it('opens a single file under its own name', async () => {
    const share = await makeShare([{ path: 'hello.txt', content: bytes('hello world') }])
    const archive = await openProtectedArchive(CID, PASSWORD, serve(share))
    expect(archive.list()).toEqual([
      {
        path: 'hello.txt',
        directory: false,
        size: 11,
        contentType: 'application/octet-stream',
      },
    ])
    expect(await readAll(await archive.open('hello.txt'))).toEqual(bytes('hello world'))
    await archive.close()
  })

  it('lists a nested folder under the folder name', async () => {
    const archive = await openProtectedArchive(CID, PASSWORD, serve(await makeShare(folder)))
    expect(archive.list().map((entry) => [entry.path, entry.directory])).toEqual([
      ['photos/', true],
      ['photos/a.jpg', false],
      ['photos/sub/', true],
      ['photos/sub/b.txt', false],
    ])
    expect(await readAll(await archive.open('photos/sub/b.txt'))).toEqual(bytes('nested text'))
  })

  it('reads a multi-block file', async () => {
    const big = new Uint8Array(700_000).map((_, index) => index % 251)
    const archive = await openProtectedArchive(
      CID,
      PASSWORD,
      serve(await makeShare([{ path: 'big.bin', content: big }]))
    )
    expect(await readAll(await archive.open('big.bin'))).toEqual(big)
  })

  it('works at the real 600000 iterations', async () => {
    const share = await makeShare([{ path: 'a.txt', content: bytes('x') }], {
      iterations: 600_000,
    })
    const archive = await openProtectedArchive(CID, PASSWORD, serve(share))
    expect(archive.list()[0].path).toBe('a.txt')
  })

  it('rejects a wrong password, then accepts the right one', async () => {
    const fetchFn = serve(await makeShare(folder))
    await expect(openProtectedArchive(CID, 'nope', fetchFn)).rejects.toBeInstanceOf(WrongPasswordError)
    expect((await openProtectedArchive(CID, PASSWORD, fetchFn)).list()).toHaveLength(4)
  })

  it.each([
    ['near the end', (length: number) => length - 20],
    ['in the middle', (length: number) => Math.floor(length / 2)],
  ])('rejects a flipped ciphertext byte %s', async (_name, index) => {
    const share = await makeShare(bigFolder)
    share[index(share.length)] ^= 1
    await expect(openProtectedArchive(CID, PASSWORD, serve(share))).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it.each([40, 70_000, 300_000])('maps a body cut by %i bytes to NotAvailableError', async (cut) => {
    const share = await makeShare(bigFolder)
    await expect(openProtectedArchive(CID, PASSWORD, serve(share.slice(0, share.length - cut)))).rejects.toBeInstanceOf(
      NotAvailableError
    )
  })

  it('cancels the download when the CAR is rejected before the stream ends', async () => {
    const share = await makeShare(bigFolder, { twoRoots: true })
    const cancel = vi.fn()
    // Delivers everything but never closes, so only a cancel can stop the read
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(share)
      },
      cancel,
    })
    const fetchFn = (async () => new Response(body, { status: 200 })) as typeof fetch
    await expect(openProtectedArchive(CID, PASSWORD, fetchFn)).rejects.toBeInstanceOf(NotAShareError)
    expect(cancel).toHaveBeenCalled()
  })

  it('rejects absurd iterations before deriving', async () => {
    const share = await makeShare(folder, { iterations: 10_000_001 })
    const spy = vi.spyOn(crypto.subtle, 'deriveBits')
    await expect(openProtectedArchive(CID, PASSWORD, serve(share))).rejects.toBeInstanceOf(NotAShareError)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects foreign appMetadata', async () => {
    const share = await makeShare(folder, { appMetadata: { app: 'other' } })
    await expect(openProtectedArchive(CID, PASSWORD, serve(share))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects non-envelope bytes', async () => {
    const junk = crypto.getRandomValues(new Uint8Array(500))
    await expect(openProtectedArchive(CID, PASSWORD, serve(junk))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects a root with two entries', async () => {
    const share = await makeShare([
      { path: 'a.txt', content: bytes('a') },
      { path: 'b.txt', content: bytes('b') },
    ])
    await expect(openProtectedArchive(CID, PASSWORD, serve(share))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects plaintext over the cap while streaming', async () => {
    const share = await makeShare([{ path: 'big.bin', content: new Uint8Array(10_000).fill(1) }])
    await expect(openProtectedArchive(CID, PASSWORD, serve(share), 5_000)).rejects.toBeInstanceOf(TooLargeError)
  })

  it('rejects an oversized Content-Length before reading the body', async () => {
    const response = new Response('x', {
      status: 200,
      headers: { 'content-length': '999999999' },
    })
    const text = vi.spyOn(response, 'body', 'get')
    await expect(openProtectedArchive(CID, PASSWORD, (async () => response) as typeof fetch)).rejects.toBeInstanceOf(
      TooLargeError
    )
    expect(text).not.toHaveBeenCalled()
  })

  it.each([404, 502, 504])('maps %i to NotAvailableError', async (status) => {
    const fetchFn = (async () => new Response('', { status })) as typeof fetch
    await expect(openProtectedArchive(CID, PASSWORD, fetchFn)).rejects.toBeInstanceOf(NotAvailableError)
  })

  it('maps a rejected fetch to NotAvailableError', async () => {
    const fetchFn = (async () => {
      throw new TypeError('network')
    }) as typeof fetch
    await expect(openProtectedArchive(CID, PASSWORD, fetchFn)).rejects.toBeInstanceOf(NotAvailableError)
  })

  it('fails on other statuses', async () => {
    const fetchFn = (async () => new Response('', { status: 500 })) as typeof fetch
    await expect(openProtectedArchive(CID, PASSWORD, fetchFn)).rejects.toThrow('Unexpected response: 500')
  })

  it('throws from open() after close(), and close() is idempotent', async () => {
    const archive: ProtectedArchive = await openProtectedArchive(CID, PASSWORD, serve(await makeShare(folder)))
    await archive.close()
    await archive.close()
    await expect(archive.open('photos/a.jpg')).rejects.toThrow('closed')
  })

  it('throws for an unknown path', async () => {
    const archive = await openProtectedArchive(CID, PASSWORD, serve(await makeShare(folder)))
    await expect(archive.open('nope')).rejects.toThrow('not found')
  })
})

import { encode as encodeCbor } from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { expect, it } from 'vitest'
import { NotAShareError, TooManyEntriesError, openProtectedArchive } from '../src/car-archive.js'
import { unlockErrorMessage } from '../src/ui.js'
import { LayoutLimitError, encodeVarint, layout } from '../src/unixfs-car-layout.js'
import { PASSWORD, encryptCar, importFiles, makeShare } from './fixtures/make-share.js'
import { serveRange } from './fixtures/serve-range.js'

const CID_STRING = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'

interface Block {
  cid: CID
  bytes: Uint8Array
}

async function node(data: Uint8Array, links: { Name: string; Hash: CID; Tsize: number }[]): Promise<Block> {
  const bytes = dagPb.encode(dagPb.prepare({ Data: data, Links: links }))
  return { cid: CID.createV1(0x70, await sha256.digest(bytes)), bytes }
}

// A share whose CAR holds only these dag-pb nodes (root first); small, but the DAG it describes is huge
async function shareOf(blocks: Block[]): Promise<Uint8Array> {
  const header = encodeCbor({ roots: [blocks[0].cid], version: 1 })
  const sections = blocks.map(({ cid, bytes }) => [encodeVarint(cid.bytes.length + bytes.length), cid.bytes, bytes])
  const car = await new Blob([encodeVarint(header.length), header, ...sections.flat()] as BlobPart[]).arrayBuffer()
  return encryptCar(new Uint8Array(car))
}

async function expectFastRejection(
  share: Uint8Array,
  expected: typeof NotAShareError | typeof TooManyEntriesError,
  cause: RegExp
): Promise<void> {
  const startedAt = performance.now()
  const error = await openProtectedArchive(CID_STRING, PASSWORD, serveRange(share).fetch).catch((cause) => cause)
  expect(error).toBeInstanceOf(expected)
  expect(error.cause.message).toMatch(cause)
  expect(performance.now() - startedAt).toBeLessThan(2000)
}

it('stops a directory chain that links twice to the next one (2^30 paths) fast, at the entry limit', async () => {
  const dir = new UnixFS({ type: 'directory' }).marshal()
  const chain: Block[] = [await node(dir, [])]
  for (let depth = 0; depth < 30; depth++) {
    const next = chain[0]
    chain.unshift(
      await node(dir, [
        { Name: 'a', Hash: next.cid, Tsize: 0 },
        { Name: 'b', Hash: next.cid, Tsize: 0 },
      ])
    )
  }
  await expectFastRejection(await shareOf(chain), TooManyEntriesError, /too many entries/)
})

it('rejects a file tree that repeats the same child many times fast', async () => {
  const leaf = CID.createV1(0x55, await sha256.digest(new Uint8Array([1])))
  const file = (sizes: bigint[]) => new UnixFS({ type: 'file', blockSizes: sizes }).marshal()
  const chain: Block[] = [await node(file([]), [])]
  let child: CID = leaf
  let size = 1n
  for (let depth = 0; depth < 30; depth++) {
    const block = await node(file([size, size]), [
      { Name: '', Hash: child, Tsize: Number(size) },
      { Name: '', Hash: child, Tsize: Number(size) },
    ])
    chain.push(block)
    child = block.cid
    size *= 2n
  }
  const root = await node(new UnixFS({ type: 'directory' }).marshal(), [{ Name: 'f', Hash: child, Tsize: 0 }])
  await expectFastRejection(await shareOf([root, ...chain.slice(1).reverse()]), NotAShareError, /visit budget/)
})

it('rejects deeply nested long names fast, before the paths grow into gigabytes', async () => {
  const dir = new UnixFS({ type: 'directory' }).marshal()
  let chain: Block = await node(dir, [])
  const blocks = [chain]
  for (let depth = 0; depth < 300; depth++) {
    chain = await node(dir, [{ Name: 'n'.repeat(255), Hash: chain.cid, Tsize: 0 }])
    blocks.unshift(chain)
  }
  const startedAt = performance.now()
  const error = await openProtectedArchive(CID_STRING, PASSWORD, serveRange(await shareOf(blocks)).fetch).catch(
    (cause) => cause
  )
  expect(error).toBeInstanceOf(TooManyEntriesError)
  expect(error.cause.message).toContain('path too long')
  expect(performance.now() - startedAt).toBeLessThan(2000)
})

const open = (share: Uint8Array) => openProtectedArchive(CID_STRING, PASSWORD, serveRange(share).fetch)
const one = (name: string) => [{ path: name, content: new TextEncoder().encode('x') }]

it('accepts a 1024-byte name and rejects a 1025-byte one, counting UTF-8 bytes', async () => {
  const placed = async (name: string) => {
    const { root, blocks } = await importFiles(one(name))
    const nodes = new Map(blocks.filter((block) => block.cid.code === 0x70).map((b) => [b.cid.toString(), b]))
    return () => layout(root, nodes)
  }
  expect(await placed('a'.repeat(1024))).not.toThrow()
  expect(await placed('a'.repeat(1025))).toThrow('unsafe entry name')
  expect(await placed('é'.repeat(512))).not.toThrow()
  expect(await placed('é'.repeat(513))).toThrow('unsafe entry name')
})

it('opens a share with a long non-Latin name (200 CJK characters, about 600 bytes)', async () => {
  const name = '漢'.repeat(200)
  expect(new TextEncoder().encode(name).length).toBe(600)
  const archive = await open(await makeShare(one(name)))
  expect(archive.list()[0].path).toBe(name)
})

it('throws a plain Error, not a LayoutLimitError, when the visit budget is exceeded', async () => {
  const { root, blocks } = await importFiles(
    Array.from({ length: 20 }, (_, index) => ({ path: `d/f${index}`, content: new Uint8Array([index]) }))
  )
  const nodes = new Map(blocks.filter((block) => block.cid.code === 0x70).map((block) => [block.cid.toString(), block]))
  const error = (() => {
    try {
      layout(root, nodes, { maxVisits: 10 })
    } catch (cause) {
      return cause
    }
  })()
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(LayoutLimitError)
  expect((error as Error).message).toContain('visit budget')
})

it('stops inside layout() once there are more entries than allowed', async () => {
  const { root, blocks } = await importFiles(
    Array.from({ length: 60 }, (_, index) => ({ path: `d/f${index}`, content: new Uint8Array([index]) }))
  )
  const nodes = new Map(blocks.filter((block) => block.cid.code === 0x70).map((block) => [block.cid.toString(), block]))
  expect(() => layout(root, nodes, { maxEntries: 50 })).toThrow(LayoutLimitError)
  expect(layout(root, nodes, { maxEntries: 100 }).files.size).toBe(60)
})

it('reports a real share with more than 10,000 entries as too big, not as not-a-share', async () => {
  const files = Array.from({ length: 10_001 }, (_, index) => ({ path: `many/f${index}`, content: new Uint8Array([1]) }))
  const error = await open(await makeShare(files)).catch((cause) => cause)
  expect(error).toBeInstanceOf(TooManyEntriesError)
  expect(error).not.toBeInstanceOf(NotAShareError)
  expect(unlockErrorMessage(error)).toBe(
    'This share has too many files, or folders nested too deeply, to open in the browser. Use `filecoin-pin decrypt`.'
  )
}, 30_000)

it('reports a real share of deduplicated folders as too big: identical subtrees and empty folders repeat links', async () => {
  // 6000 identical folders (one dag-pb node linked 6000 times) of 2 identical files each, plus empty folders
  const same = new Uint8Array([1])
  const files = [
    ...Array.from({ length: 6000 }, (_, index) => [
      { path: `many/d${index}/a.txt`, content: same },
      { path: `many/d${index}/b.txt`, content: same },
    ]).flat(),
    { path: 'many/empty1' },
    { path: 'many/empty2' },
    { path: 'many/empty3' },
  ]
  await expect(open(await makeShare(files))).rejects.toBeInstanceOf(TooManyEntriesError)
}, 30_000)

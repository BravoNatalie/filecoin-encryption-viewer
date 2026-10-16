import { CarWriter } from '@ipld/car'
import * as fee from 'filecoin-encryption-envelope'
import { importer } from 'ipfs-unixfs-importer'
import type { CID } from 'multiformats/cid'
import { CAR_CONTENT_TYPE, DAG_PB_CODEC, layout } from '../../src/unixfs-car-layout.ts'
import type { MetadataNode } from '../../src/unixfs-car-layout.ts'

export const PASSWORD = 'correct horse battery staple'
export const SALT = new Uint8Array(16).fill(7)
export const FAST_ITERATIONS = 1000

export interface ShareFile {
  path: string
  // Omitted for an empty folder
  content?: Uint8Array
}

export interface MakeShareOptions {
  iterations?: number
  appMetadata?: Record<string, unknown>
  password?: string
  // CAR header with two roots
  twoRoots?: boolean
  // Public content_type of the envelope; defaults to the CAR type
  contentType?: string
  // Leave the blocks in the importer's order (leaves first) instead of metadata-first
  importerOrder?: boolean
}

interface Block {
  cid: CID
  bytes: Uint8Array
}

// Same shape as `filecoin-pin add --encrypt`: a wrapping directory around the shared file or folder, written
// metadata-first. Several top-level paths build a root with more than one entry (negative tests).
export async function makeShare(files: ShareFile[], options: MakeShareOptions = {}): Promise<Uint8Array> {
  return encryptCar(await buildCar(files, options), options)
}

/** Encrypts any plaintext as a share, for CARs a normal build can't produce. */
export async function encryptCar(car: Uint8Array, options: MakeShareOptions = {}): Promise<Uint8Array> {
  const iterations = options.iterations ?? FAST_ITERATIONS
  const key = await pbkdf2(options.password ?? PASSWORD, SALT, iterations)
  const appMetadata = options.appMetadata ?? {
    kdf: 'pbkdf2-sha256',
    iterations,
    salt: btoa(String.fromCharCode(...SALT)),
  }
  const encrypted = new Blob([car as BlobPart]).stream().pipeThrough(
    fee.encrypt({
      cek: key,
      contentLength: car.length,
      contentType: options.contentType ?? CAR_CONTENT_TYPE,
      appMetadata: appMetadata as fee.AppMetadata,
    })
  )
  return new Uint8Array(await new Response(encrypted).arrayBuffer())
}

/** The plaintext CAR, exported so layout tests can compare offsets with the real bytes. */
export async function buildCar(files: ShareFile[], options: MakeShareOptions = {}): Promise<Uint8Array> {
  const { root, blocks } = await importFiles(files)
  const ordered = options.importerOrder ? blocks : metadataFirst(root, blocks)

  const { writer, out } = CarWriter.create(options.twoRoots ? [root, root] : [root])
  const collected = (async () => {
    const parts: Uint8Array[] = []
    for await (const part of out) parts.push(part)
    return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
  })()
  for (const block of ordered) await writer.put(block)
  await writer.close()
  return collected
}

export async function importFiles(files: ShareFile[]): Promise<{ root: CID; blocks: Block[] }> {
  const blocks = new Map<string, Block>()
  const blockstore = {
    put(cid: CID, bytes: Uint8Array): CID {
      blocks.set(cid.toString(), { cid, bytes })
      return cid
    },
  }
  let root: CID | undefined
  for await (const result of importer(files, blockstore as never, {
    wrapWithDirectory: true,
    profile: 'unixfs-v1-2025',
  }))
    root = result.cid
  if (!root) throw new Error('empty import')
  return { root, blocks: [...blocks.values()] }
}

// Header, dag-pb nodes in layout order, then leaves in file order: the order the CLI writes.
function metadataFirst(root: CID, blocks: Block[]): Block[] {
  const byCid = new Map(blocks.map((block) => [block.cid.toString(), block]))
  const nodes = new Map<string, MetadataNode>(
    blocks.filter((block) => block.cid.code === DAG_PB_CODEC).map((block) => [block.cid.toString(), block])
  )
  const placed = layout(root, nodes)
  return [...placed.metadata, ...placed.leaves].map(({ cid }) => {
    const block = byCid.get(cid.toString())
    if (!block) throw new Error(`missing block ${cid}`)
    return block
  })
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256)
  return new Uint8Array(bits)
}

import { CarWriter } from '@ipld/car'
import * as fee from 'filecoin-encryption-envelope'
import { importer } from 'ipfs-unixfs-importer'
import type { CID } from 'multiformats/cid'

export const PASSWORD = 'correct horse battery staple'
export const SALT = new Uint8Array(16).fill(7)
export const FAST_ITERATIONS = 1000

export interface ShareFile {
  path: string
  content: Uint8Array
}

export interface MakeShareOptions {
  iterations?: number
  appMetadata?: Record<string, unknown>
  password?: string
  // CAR header with two roots, for the early-abort test
  twoRoots?: boolean
}

// Same shape as `filecoin-pin add --encrypt`: a wrapping directory around the shared file or folder.
// Several top-level paths build a root with more than one entry (negative tests).
export async function makeShare(files: ShareFile[], options: MakeShareOptions = {}): Promise<Uint8Array> {
  const iterations = options.iterations ?? FAST_ITERATIONS
  const car = await buildCar(files, options.twoRoots)
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
      appMetadata: appMetadata as fee.AppMetadata,
    })
  )
  return new Uint8Array(await new Response(encrypted).arrayBuffer())
}

async function buildCar(files: ShareFile[], twoRoots = false): Promise<Uint8Array> {
  const blocks = new Map<CID, Uint8Array>()
  const blockstore = {
    put(cid: CID, bytes: Uint8Array): CID {
      blocks.set(cid, bytes)
      return cid
    },
  }
  let root: CID | undefined
  for await (const result of importer(files, blockstore as never, {
    wrapWithDirectory: true,
  }))
    root = result.cid
  if (!root) throw new Error('empty import')

  const { writer, out } = CarWriter.create(twoRoots ? [root, root] : [root])
  const collected = (async () => {
    const parts: Uint8Array[] = []
    for await (const part of out) parts.push(part)
    return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
  })()
  for (const [cid, bytes] of blocks) await writer.put({ cid, bytes })
  await writer.close()
  return collected
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256)
  return new Uint8Array(bits)
}

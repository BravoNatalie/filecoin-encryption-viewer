import { CarBlockIterator } from '@ipld/car'
import * as fee from 'filecoin-encryption-envelope'
import { exporter } from 'ipfs-unixfs-exporter'
import type { ReadableStorage, UnixFSEntry } from 'ipfs-unixfs-exporter'
import type { CID } from 'multiformats/cid'
import { derivePasswordKey, validateKdfMetadata } from './password-key.js'

const CID_PATTERN = /^b[a-z2-7]{20,120}$/
const MAX_ARCHIVE_ENTRIES = 10_000
const ENVELOPE_OVERHEAD_BYTES = 64 * 1024
// ponytail: in-memory, cap 256 MiB; follow-up = CarIndexer + decryptRange blockstore
export const MAX_SHARE_BYTES = 256 * 1024 * 1024

export interface ProtectedEntry {
  readonly path: string
  readonly directory: boolean
  readonly size: number
  readonly contentType: string
}

export interface ProtectedArchive {
  list(): readonly ProtectedEntry[]
  open(path: string): Promise<ReadableStream<Uint8Array>>
  close(): Promise<void>
}

export class NotAvailableError extends Error {
  override name = 'NotAvailableError'
}
export class TooLargeError extends Error {
  override name = 'TooLargeError'
}
export class WrongPasswordError extends Error {
  override name = 'WrongPasswordError'
}
export class NotAShareError extends Error {
  override name = 'NotAShareError'
  constructor(options?: ErrorOptions) {
    super("This link doesn't point to a filecoin-pin encrypted share", options)
  }
}

export async function openProtectedArchive(
  cid: string,
  password: string,
  fetchFn: typeof fetch = fetch,
  maxBytes = MAX_SHARE_BYTES
): Promise<ProtectedArchive> {
  if (!CID_PATTERN.test(cid)) throw new Error('Invalid encrypted Root CID')

  const body = await fetchShare(cid, fetchFn, maxBytes)
  const blocks = new Map<string, Uint8Array>()
  let key: Uint8Array | undefined
  try {
    const plaintext = body.pipeThrough(
      fee.decrypt(async ({ appMetadata }) => {
        const { salt, iterations } = validateKdfMetadata(appMetadata)
        key = await derivePasswordKey(password, salt, iterations)
        return key
      })
    )
    const root = await readCar(plaintext.pipeThrough(capBytes(maxBytes)), blocks)
    return await buildArchive(root, blocks)
  } catch (error) {
    blocks.clear()
    throw mapError(error)
  } finally {
    key?.fill(0)
  }
}

async function fetchShare(cid: string, fetchFn: typeof fetch, maxBytes: number): Promise<ReadableStream<Uint8Array>> {
  let response: Response
  try {
    response = await fetchFn(`https://${cid}.ipfs.dweb.link/`, {
      redirect: 'error',
    })
  } catch (error) {
    throw new NotAvailableError('Share is not available yet', { cause: error })
  }
  if ([404, 502, 504].includes(response.status)) throw new NotAvailableError('Share is not available yet')
  if (response.status !== 200) throw new Error(`Unexpected response: ${response.status}`)

  const length = Number(response.headers.get('content-length'))
  if (length > maxBytes + (maxBytes >> 10) + ENVELOPE_OVERHEAD_BYTES) throw new TooLargeError('Share is too large')
  if (!response.body) throw new Error('Response has no body')
  return response.body
}

const { errors } = fee

// Decision per fee.errors class. Unlisted classes (InvalidKeyError, InvalidPlaintextError, CryptoOperationError,
// InvalidRangeError, base EnvelopeError) are programmer or platform errors and propagate unchanged.
function mapError(error: unknown): unknown {
  if (error instanceof errors.AuthenticationError) {
    return new WrongPasswordError('Wrong password, or the share was modified', { cause: error })
  }
  if (
    error instanceof errors.InvalidCiphertextLengthError ||
    error instanceof errors.InvalidPlaintextLengthError ||
    error instanceof errors.InvalidSourceLengthError
  ) {
    return new NotAvailableError('The download was incomplete, try again', { cause: error })
  }
  if (
    error instanceof errors.KeyResolutionError ||
    error instanceof errors.MalformedEnvelopeError ||
    error instanceof errors.UnsupportedSchemeError ||
    error instanceof errors.CriticalHeaderError ||
    error instanceof errors.InvalidChunkSizeError ||
    error instanceof errors.ChunkCountExceededError ||
    error instanceof errors.InvalidNonceError ||
    error instanceof errors.NoUsableRecipientError ||
    error instanceof errors.RecipientUnwrapError ||
    error instanceof errors.RecipientAttemptLimitError ||
    (error instanceof Error && error.message === 'missing or unsupported key derivation parameters')
  ) {
    return new NotAShareError({ cause: error })
  }
  return error
}

function capBytes(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength
      if (total > maxBytes) throw new TooLargeError('Share is too large')
      controller.enqueue(chunk)
    },
  })
}

// ReadableStream is not async-iterable in every supported browser
async function* iterate(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        return
      }
      yield value
    }
  } catch (error) {
    finished = true // the stream already errored; nothing to cancel
    throw error
  } finally {
    // Consumer stopped early: cancel so the download stops
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function readCar(stream: ReadableStream<Uint8Array>, blocks: Map<string, Uint8Array>): Promise<CID> {
  const chunks = iterate(stream)
  try {
    const car = await CarBlockIterator.fromIterable(chunks)
    const roots = await car.getRoots()
    if (roots.length !== 1) throw new NotAShareError()
    // Not hash-checked: FEE has already authenticated every byte
    for await (const block of car) blocks.set(block.cid.toString(), block.bytes)
    return roots[0]
  } finally {
    // No-op after a full read; on early exit this runs iterate()'s finally, which cancels the download
    await chunks.return(undefined)
  }
}

async function buildArchive(root: CID, blocks: Map<string, Uint8Array>): Promise<ProtectedArchive> {
  const blockstore = {
    *get(cid: CID): Generator<Uint8Array> {
      const bytes = blocks.get(cid.toString())
      if (!bytes) throw new NotAShareError()
      yield bytes
    },
  }
  const files = new Map<string, CID>()
  const entries: ProtectedEntry[] = []

  const rootEntry = await exporter(root, blockstore)
  if (rootEntry.type !== 'directory') throw new NotAShareError()
  const children: UnixFSEntry[] = []
  const names: string[] = []
  for await (const child of rootEntry.entries()) {
    if (names.length === 1) throw new NotAShareError()
    names.push(child.name)
    children.push(await exporter(child.cid, blockstore))
  }
  if (children.length !== 1) throw new NotAShareError()

  async function add(entry: UnixFSEntry, path: string): Promise<void> {
    if (entries.length >= MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Protected archive has more than ${MAX_ARCHIVE_ENTRIES} entries`)
    }
    if (entry.type === 'directory') {
      entries.push(frozen(`${path}/`, true, 0))
      for await (const child of entry.entries()) {
        assertSafeName(child.name)
        await add(await exporter(child.cid, blockstore), `${path}/${child.name}`)
      }
      return
    }
    if (entry.type !== 'file' && entry.type !== 'raw') throw new NotAShareError()
    files.set(path, entry.cid)
    entries.push(frozen(path, false, Number(entry.size)))
  }

  assertSafeName(names[0])
  await add(children[0], names[0])
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return createArchive(Object.freeze(entries), files, blocks, blockstore)
}

function frozen(path: string, directory: boolean, size: number): ProtectedEntry {
  return Object.freeze({
    path,
    directory,
    size,
    contentType: directory ? 'inode/directory' : 'application/octet-stream',
  })
}

function assertSafeName(name: string): void {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new NotAShareError()
}

function createArchive(
  entries: readonly ProtectedEntry[],
  files: Map<string, CID>,
  blocks: Map<string, Uint8Array>,
  blockstore: ReadableStorage
): ProtectedArchive {
  let closed = false
  return {
    list: () => entries,
    async open(path) {
      if (closed) throw new Error('Protected archive is closed')
      const cid = files.get(path)
      if (!cid) throw new Error(`Protected archive file not found: ${path}`)
      const file = await exporter(cid, blockstore)
      if (file.type !== 'file' && file.type !== 'raw') throw new Error(`Protected archive file not found: ${path}`)
      const chunks = file.content()
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await chunks.next()
          if (done) controller.close()
          else controller.enqueue(value)
        },
        cancel: async () => {
          await chunks.return()
        },
      })
    },
    async close() {
      closed = true
      blocks.clear()
      files.clear()
    },
  }
}

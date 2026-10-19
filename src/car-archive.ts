import { decode as decodeCbor } from '@ipld/dag-cbor'
import * as fee from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import {
  NotAShareError,
  NotAvailableError,
  RangeUnsupportedError,
  TooLargeError,
  TooManyEntriesError,
  WrongPasswordError,
} from './errors.js'
import { derivePasswordKey, validateKdfMetadata } from './password-key.js'
import { openRangeSource } from './range-source.js'
import {
  CAR_CONTENT_TYPE,
  DAG_PB_CODEC,
  LayoutLimitError,
  RAW_CODEC,
  decodeVarint,
  layout,
} from './unixfs-car-layout.js'
import type { FileLeaf, FilePlacement, MetadataNode } from './unixfs-car-layout.js'

export {
  TooManyEntriesError,
  NotAShareError,
  NotAvailableError,
  RangeUnsupportedError,
  TooLargeError,
  WrongPasswordError,
}

const CID_PATTERN = /^b[a-z2-7]{20,120}$/
const MAX_ARCHIVE_ENTRIES = 10_000
const FIRST_WINDOW_BYTES = 256 * 1024
const MAX_METADATA_BYTES = 16 * 1024 * 1024
const MAX_BATCH_BYTES = 8 * 1024 * 1024
// A 64 GiB share is ~65k leaves plus at most 10k entries; this only stops crafted DAGs with exponentially many paths
const MAX_LAYOUT_VISITS = 1_000_000

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

// What every read needs: the envelope, its key and the chunked-envelope params from fee.parse
interface Reader {
  source: fee.RandomAccessSource
  key: Uint8Array
  params: fee.ChunkedEnvelopeParams
}

export async function openProtectedArchive(
  cid: string,
  password: string,
  fetchFn: typeof fetch = fetch
): Promise<ProtectedArchive> {
  if (!CID_PATTERN.test(cid)) throw new Error('Invalid encrypted Root CID')

  let key: Uint8Array | undefined
  try {
    const source = await openRangeSource(`https://${cid}.ipfs.dweb.link/`, fetchFn)
    const info = await fee.parse(source)
    if (info.scheme !== 'chunked' || info.contentType !== CAR_CONTENT_TYPE || !info.params.plaintextLength) {
      throw new NotAShareError()
    }
    const { salt, iterations } = validateKdfMetadata(info.appMetadata)
    key = await derivePasswordKey(password, salt, iterations)
    // From here the archive owns the key; close() zeroes it
    return await buildArchive({ source, key, params: info.params })
  } catch (error) {
    key?.fill(0)
    throw mapError(error)
  }
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

async function buildArchive(reader: Reader): Promise<ProtectedArchive> {
  const { files, dirs } = await readLayout(reader)

  // The wrapper holds exactly one entry: the shared file or folder
  const paths = [...dirs, ...files.keys()]
  if (new Set(paths.map((path) => path.split('/')[0])).size !== 1 || paths.some((path) => path.includes('\\'))) {
    throw new NotAShareError()
  }
  const entries = [
    ...dirs.map((path) => frozen(`${path}/`, true, 0)),
    ...[...files].map(([path, file]) => frozen(path, false, file.size)),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return createArchive(Object.freeze(entries), files, reader)
}

function frozen(path: string, directory: boolean, size: number): ProtectedEntry {
  return Object.freeze({
    path,
    directory,
    size,
    contentType: directory ? 'inode/directory' : 'application/octet-stream',
  })
}

interface Prefix {
  root?: CID
  headerLength: number
  pos: number
  nodes: Map<string, MetadataNode>
  sections: { cid: CID; offset: number; len: number }[]
}

// Reads the CAR up to its first raw block, then lets layout() place everything. Anything that isn't what
// `add --encrypt` writes (metadata-first, canonical header, one root) is NotAShareError.
async function readLayout(reader: Reader) {
  const prefix = await readPrefix(reader)
  const { root } = prefix
  if (!root) throw new NotAShareError()

  let placed: ReturnType<typeof layout>
  try {
    placed = layout(root, prefix.nodes, { maxVisits: MAX_LAYOUT_VISITS, maxEntries: MAX_ARCHIVE_ENTRIES })
  } catch (cause) {
    if (cause instanceof LayoutLimitError) throw new TooManyEntriesError('Too many entries', { cause })
    throw new NotAShareError({ cause })
  }
  const inOrder =
    placed.header.length === prefix.headerLength &&
    placed.metadata.length === prefix.sections.length &&
    placed.metadata.every(
      (node, index) =>
        node.cid.equals(prefix.sections[index].cid) &&
        node.offset === prefix.sections[index].offset &&
        node.len === prefix.sections[index].len
    )
  if (!inOrder || placed.total !== reader.params.plaintextLength) throw new NotAShareError()
  return placed
}

// Consecutive decryptRange windows from plaintext offset 0, each continuing where the last ended, doubling in size.
// Stops at the first raw section header or at the end of the plaintext (a folder of empty folders has no raw block).
async function readPrefix(reader: Reader): Promise<Prefix> {
  const total = reader.params.plaintextLength ?? 0
  const prefix: Prefix = { headerLength: 0, pos: 0, nodes: new Map(), sections: [] }
  let buffer = new Uint8Array(0)
  let window = FIRST_WINDOW_BYTES
  for (;;) {
    const { stream, rangeLength } = await fee.decryptRange(
      reader.source,
      reader.key,
      { offset: buffer.length, length: window },
      { params: reader.params }
    )
    const next = new Uint8Array(buffer.length + rangeLength)
    next.set(buffer)
    next.set(await readExact(stream, rangeLength), buffer.length)
    buffer = next

    if (parseSections(buffer, prefix)) return prefix
    if (buffer.length >= total) {
      if (prefix.pos !== buffer.length) throw new NotAShareError()
      return prefix
    }
    if (buffer.length >= MAX_METADATA_BYTES) throw new NotAShareError()
    window = Math.min(window * 2, MAX_METADATA_BYTES - buffer.length)
  }
}

// Advances `prefix` over whatever complete sections `buffer` holds. True once the next section is a raw block.
function parseSections(buffer: Uint8Array, prefix: Prefix): boolean {
  try {
    if (!prefix.root) {
      const header = decodeVarint(buffer)
      if (!header || buffer.length < header[1] + header[0]) return false
      const { roots, version } = decodeCbor(buffer.subarray(header[1], header[1] + header[0])) as {
        roots?: unknown[]
        version?: unknown
      }
      const root = roots?.length === 1 ? CID.asCID(roots[0]) : null
      if (!root || version !== 1) throw new NotAShareError()
      prefix.root = root
      prefix.headerLength = prefix.pos = header[1] + header[0]
    }
    for (;;) {
      const section = decodeVarint(buffer, prefix.pos)
      if (!section) return false
      const [len, varintLength] = section
      const start = prefix.pos + varintLength
      if (len > MAX_METADATA_BYTES || buffer.length - start < 2) {
        if (len > MAX_METADATA_BYTES) throw new NotAShareError()
        return false
      }
      // CIDv1: version byte, then the codec (both below 0x80 for the codecs the profile uses)
      if (buffer[start] !== 1) throw new NotAShareError()
      const codec = buffer[start + 1]
      if (codec === RAW_CODEC) return true
      if (codec !== DAG_PB_CODEC) throw new NotAShareError()
      if (buffer.length < start + len) return false

      const [cid, bytes] = CID.decodeFirst(buffer.subarray(start, start + len))
      prefix.nodes.set(cid.toString(), { cid, bytes })
      prefix.sections.push({ cid, offset: prefix.pos, len: varintLength + len })
      prefix.pos = start + len
    }
  } catch (cause) {
    throw cause instanceof NotAShareError ? cause : new NotAShareError({ cause })
  }
}

function createArchive(
  entries: readonly ProtectedEntry[],
  files: Map<string, FilePlacement>,
  reader: Reader
): ProtectedArchive {
  let closed = false
  return {
    list: () => entries,
    async open(path) {
      if (closed) throw new Error('Protected archive is closed')
      const file = files.get(path)
      if (!file) throw new Error(`Protected archive file not found: ${path}`)
      return readFile(file, reader, () => closed)
    },
    async close() {
      closed = true
      reader.key.fill(0)
      files.clear()
    },
  }
}

// Leaves are contiguous in the CAR unless a repeated chunk points back to its first occurrence, so a file is a few
// long reads. Each batch spans at most MAX_BATCH_BYTES of CAR (a lone leaf may be larger).
function groupBatches(leaves: FileLeaf[]): FileLeaf[][] {
  const batches: FileLeaf[][] = []
  let batch: FileLeaf[] = []
  for (const item of leaves) {
    if (item.len === 0) continue
    const last = batch.at(-1)
    if (
      last &&
      (item.leaf.offset !== last.leaf.dataOffset + last.len || end(item) - batch[0].leaf.dataOffset > MAX_BATCH_BYTES)
    ) {
      batches.push(batch)
      batch = []
    }
    batch.push(item)
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

const end = (item: FileLeaf) => item.leaf.dataOffset + item.len

// One batch in flight: a batch is decrypted only when the consumer has drained the previous one.
function readFile(file: FilePlacement, reader: Reader, isClosed: () => boolean): ReadableStream<Uint8Array> {
  const batches = groupBatches(file.leaves)
  let next = 0
  let cancelled = false
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (isClosed()) throw new Error('Protected archive is closed')
        const batch = batches[next++]
        if (!batch) return controller.close()
        const offset = batch[0].leaf.dataOffset
        const length = end(batch[batch.length - 1]) - offset
        let data: Uint8Array
        try {
          const { stream } = await fee.decryptRange(
            reader.source,
            reader.key,
            { offset, length },
            { params: reader.params }
          )
          data = await readExact(stream, length)
        } catch (error) {
          throw mapError(error)
        }
        if (cancelled) return
        // FEE authenticated every chunk, so no hash check here
        for (const item of batch) {
          controller.enqueue(data.subarray(item.leaf.dataOffset - offset, end(item) - offset))
        }
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 }
  )
}

// ReadableStream is not async-iterable in every supported browser
async function readExact(stream: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length)
  const reader = stream.getReader()
  let filled = 0
  while (filled < length) {
    const { done, value } = await reader.read()
    if (done) break
    out.set(value, filled)
    filled += value.length
  }
  if (filled !== length) throw new errors.InvalidSourceLengthError('The range ended early')
  return out
}

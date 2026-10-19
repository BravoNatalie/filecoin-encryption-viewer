// Staging a save in the origin private file system (Firefox 111+, Safari 26+): the browser keeps the file on disk,
// so memory stays near baseline where a Blob of the same size would peak at 3-4x.
// The browser objects are read from globals, so tests can stub them.
const PREFIX = 'foc-viewer-save-'

interface OpfsWritable {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}
interface OpfsFileHandle {
  createWritable(): Promise<OpfsWritable>
  getFile(): Promise<File>
}
export interface OpfsDirectory {
  getFileHandle(name: string, options: { create: boolean }): Promise<OpfsFileHandle>
  removeEntry(name: string): Promise<void>
  keys(): AsyncIterable<string>
}

/** A failure of the storage itself (quota, disk, writable), as opposed to a failure of the source stream. */
export class StagingError extends Error {
  override name = 'StagingError'
}

/** The OPFS root, or undefined when this browser can't stage files (including private contexts that throw). */
export async function openOpfsRoot(): Promise<OpfsDirectory | undefined> {
  const storage = globalThis.navigator?.storage
  const Handle = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle
  if (typeof storage?.getDirectory !== 'function' || !Handle || !('createWritable' in Handle.prototype))
    return undefined
  try {
    return (await storage.getDirectory()) as unknown as OpfsDirectory
  } catch {
    // WebKit's private and ephemeral contexts throw UnknownError here
    return undefined
  }
}

// WebKit 26.4 writes the whole underlying ArrayBuffer of a view and ignores byteOffset/byteLength, so a subarray
// (as the archive and client-zip enqueue) must be copied to an exactly sized buffer first.
export function exactBytes(chunk: Uint8Array): Uint8Array {
  return chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk : chunk.slice()
}

/**
 * Deletes every staged file. Best effort and silent.
 * ponytail: the file of the last save stays until the next save, the next startup, or pagehide, because the page
 * can't observe when the browser has finished copying the download. Upgrade: delete when the download is done.
 */
export async function removeStagedFiles(root?: OpfsDirectory): Promise<void> {
  try {
    const dir = root ?? (await openOpfsRoot())
    if (!dir) return
    const names: string[] = []
    for await (const name of dir.keys()) if (name.startsWith(PREFIX)) names.push(name)
    await Promise.all(names.map((name) => dir.removeEntry(name).catch(() => undefined)))
  } catch {
    // nothing to clean up, or the browser refused
  }
}

async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    throw new StagingError('Could not stage the file', { cause })
  }
}

/**
 * Writes `stream` into a new staged file and returns it. Any failure removes the partial file first; failures of
 * the storage are StagingError, failures of the stream pass through unchanged.
 */
export async function stageStream(
  root: OpfsDirectory,
  stream: ReadableStream<Uint8Array>,
  onProgress?: (written: number) => void
): Promise<File> {
  const name = `${PREFIX}${crypto.randomUUID()}.part`
  const reader = stream.getReader()
  let writable: OpfsWritable | undefined
  try {
    const handle = await storage(() => root.getFileHandle(name, { create: true }))
    writable = await storage(() => handle.createWritable())
    const target = writable
    let written = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await storage(() => target.write(exactBytes(value)))
      written += value.length
      onProgress?.(written)
    }
    await storage(() => target.close())
    return await storage(() => handle.getFile())
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    await writable?.abort?.().catch(() => undefined)
    await root.removeEntry(name).catch(() => undefined)
    throw error
  }
}

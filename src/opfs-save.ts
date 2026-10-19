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

// Staged files this tab created. Each holds a Web Lock named after the file from creation until this tab deletes it,
// so other tabs (whose startup sweep and next-save cleanup list the directory) can tell it is in use.
const ownFiles = new Map<string, { release: () => void; done: boolean }>()

async function holdLock(name: string): Promise<void> {
  const locks = globalThis.navigator?.locks
  if (!locks) {
    ownFiles.set(name, { release: () => undefined, done: false })
    return
  }
  await new Promise<void>((held) => {
    locks
      .request(name, () => {
        return new Promise<void>((release) => {
          ownFiles.set(name, { release: () => release(), done: false })
          held()
        })
      })
      .catch(() => {
        // Web Locks refused (storage-blocked or sandboxed context): carry on as if there were none
        if (!ownFiles.has(name)) ownFiles.set(name, { release: () => undefined, done: false })
        held()
      })
  })
}

async function removeOwn(dir: OpfsDirectory, name: string): Promise<void> {
  ownFiles.get(name)?.release()
  ownFiles.delete(name)
  await dir.removeEntry(name).catch(() => undefined)
}

/**
 * Deletes staged files that are not in use. Best effort and silent. Always: this tab's own finished files (release
 * the lock, then delete). With Web Locks also: files nobody holds a lock on, left by closed tabs. Without Web Locks
 * other tabs' files are never touched, because there is no way to tell they are in use.
 * ponytail: a finished save's file stays until the next save, the next startup, or pagehide, because the page can't
 * observe when the browser has finished copying the download. Upgrade: delete when the download is done.
 */
export async function removeStagedFiles(root?: OpfsDirectory): Promise<void> {
  try {
    const dir = root ?? (await openOpfsRoot())
    if (!dir) return
    for (const [name, file] of [...ownFiles]) if (file.done) await removeOwn(dir, name)

    const locks = globalThis.navigator?.locks
    if (!locks) return
    // List first, then query: a file created after the listing is not deleted, and one listed has its lock held
    // (the lock is taken before the file exists), so it shows up in the query.
    const names: string[] = []
    for await (const name of dir.keys()) if (name.startsWith(PREFIX)) names.push(name)
    const { held = [], pending = [] } = await locks.query()
    const inUse = new Set([...held, ...pending].map((lock) => lock.name))
    await Promise.all(
      names
        .filter((name) => !inUse.has(name) && !ownFiles.has(name))
        .map((name) => dir.removeEntry(name).catch(() => undefined))
    )
  } catch {
    // nothing to clean up, or the browser refused
  }
}

/** pagehide: this tab is going away, so delete everything it staged, finished or not. Best effort. */
export async function removeOwnStagedFiles(): Promise<void> {
  try {
    const dir = await openOpfsRoot()
    if (!dir) return
    await Promise.all([...ownFiles.keys()].map((name) => removeOwn(dir, name)))
  } catch {
    // the page is closing anyway
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
    await holdLock(name)
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
    const file = await storage(() => handle.getFile())
    const own = ownFiles.get(name)
    if (own) own.done = true
    return file
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    await writable?.abort?.().catch(() => undefined)
    await removeOwn(root, name)
    throw error
  }
}

import { downloadZip } from 'client-zip'
import type { ProtectedArchive } from './car-archive.js'

/** File count and total size of the files in an open archive (directories excluded). */
export function summarizeArchive(archive: ProtectedArchive): { files: number; bytes: number } {
  const files = archive.list().filter((entry) => !entry.directory)
  return { files: files.length, bytes: files.reduce((total, entry) => total + entry.size, 0) }
}

/** `<root folder>.zip`, from the first path segment of the share. */
export function zipFileName(archive: ProtectedArchive): string {
  const root = archive.list()[0]?.path.split('/')[0]
  return `${root || 'share'}.zip`
}

/**
 * Zips the already-open archive (names are the full entry paths, directories included), reading
 * each file lazily from memory: no fetch and no decryption happen here.
 */
export function buildArchiveZip(archive: ProtectedArchive, onProgress?: (done: number, total: number) => void) {
  const total = summarizeArchive(archive).files
  async function* entries() {
    let done = 0
    for (const entry of archive.list()) {
      if (entry.directory) {
        yield { name: entry.path }
        continue
      }
      yield { name: entry.path, input: await archive.open(entry.path) }
      onProgress?.(++done, total)
    }
  }
  return downloadZip(entries()).blob()
}

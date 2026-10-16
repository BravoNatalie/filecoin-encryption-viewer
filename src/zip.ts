import { downloadZip } from 'client-zip'
import type { ProtectedArchive } from './car-archive.js'
import { TooLargeError } from './errors.js'
import { saveFallbackCap } from './save.js'

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
 * Zips the open archive (names are the full entry paths, directories included), reading each file
 * lazily, one at a time. The zip is built in memory, so it has the same cap as the save fallback.
 */
export function buildArchiveZip(archive: ProtectedArchive, onProgress?: (done: number, total: number) => void) {
  const { files: total, bytes } = summarizeArchive(archive)
  if (bytes > saveFallbackCap()) throw new TooLargeError('These files are too large to zip in this browser')
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

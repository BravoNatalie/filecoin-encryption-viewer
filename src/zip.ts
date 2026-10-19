import { downloadZip } from 'client-zip'
import type { ProtectedArchive } from './car-archive.js'
import type { SaveableEntry } from './save.js'

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
 * The zip of the open archive as a saveable entry (names are the full entry paths, directories included). Files are
 * read lazily, one at a time, and the zip streams out as it is built. `size` is the files' total, a close estimate.
 */
export function archiveZip(
  archive: ProtectedArchive,
  onProgress?: (done: number, total: number) => void
): SaveableEntry {
  const { files: total, bytes } = summarizeArchive(archive)
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
  return {
    size: bytes,
    contentType: 'application/zip',
    open: async () => {
      const { body } = downloadZip(entries())
      if (!body) throw new Error('The zip has no body')
      return body
    },
  }
}

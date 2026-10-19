import { vi } from 'vitest'

export interface FakeOpfsOptions {
  // Like WebKit 26.4: write() stores the whole underlying ArrayBuffer of a view
  webkit?: boolean
  // write() throws a QuotaExceededError once this many bytes are stored
  quota?: number
  // getDirectory() throws, like WebKit's private contexts
  throwOnGetDirectory?: boolean
  // FileSystemFileHandle has no createWritable (older browsers)
  noCreateWritable?: boolean
}

/** Stubs navigator.storage and FileSystemFileHandle with an in-memory directory; returns the files by name. */
export function stubOpfs(options: FakeOpfsOptions = {}) {
  const files = new Map<string, Uint8Array[]>()
  const removed: string[] = []

  const directory = {
    async getFileHandle(name: string, { create }: { create: boolean }) {
      if (create) files.set(name, [])
      return {
        async createWritable() {
          const parts = files.get(name) as Uint8Array[]
          let stored = 0
          return {
            async write(chunk: Uint8Array) {
              const data = options.webkit ? new Uint8Array(chunk.buffer) : chunk.slice()
              if (options.quota !== undefined && stored + data.length > options.quota) {
                throw new DOMException('quota', 'QuotaExceededError')
              }
              stored += data.length
              parts.push(data)
            },
            async close() {},
            async abort() {},
          }
        },
        async getFile() {
          return new File((files.get(name) ?? []) as BlobPart[], name)
        },
      }
    },
    async removeEntry(name: string) {
      files.delete(name)
      removed.push(name)
    },
    async *keys() {
      yield* [...files.keys()]
    },
  }

  vi.stubGlobal('navigator', {
    userAgentData: { mobile: false },
    storage: {
      getDirectory: async () => {
        if (options.throwOnGetDirectory) throw new DOMException('private', 'UnknownError')
        return directory
      },
    },
  })
  vi.stubGlobal(
    'FileSystemFileHandle',
    options.noCreateWritable
      ? class {}
      : class {
          createWritable() {}
        }
  )
  return { files, removed, getDirectory: (navigator.storage as { getDirectory: () => Promise<unknown> }).getDirectory }
}

/** Stubs the anchor click and object URLs of the download; returns what was downloaded. */
export function stubDownload() {
  vi.stubGlobal('showSaveFilePicker', undefined)
  const link = { href: '', download: '', hidden: false, click: vi.fn(), remove: vi.fn() }
  vi.stubGlobal('document', { createElement: () => link, body: { append: vi.fn() } })
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:file')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  return { link, createObjectURL, revokeObjectURL }
}

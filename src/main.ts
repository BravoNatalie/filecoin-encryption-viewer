import type { ProtectedArchive, ProtectedEntry } from './car-archive.js'
import { openProtectedArchive } from './car-archive.js'
import { MAX_BINARY_PREVIEW_BYTES, MAX_DOCUMENT_PREVIEW_BYTES, readEntryPrefix, readInlineEntry } from './decrypt.js'
import { RangeUnsupportedError } from './errors.js'
import { parseFragment } from './fragment.js'
import {
  detectContentType,
  isBinaryPreviewType,
  renderContent,
  revokePdfObjectUrls,
  revokeRenderedObjectUrls,
} from './render.js'
import { saveEntry } from './save.js'
import {
  addBackButton,
  showAccessKeyPrompt,
  showMissingLink,
  showProtectedArchive,
  showRangeUnsupported,
  showSaveEntry,
} from './ui.js'
import { buildArchiveZip, zipFileName } from './zip.js'

function getContainer(): HTMLElement {
  const element = document.getElementById('app')
  if (!element) throw new Error('Viewer root is missing')
  return element
}

const container = getContainer()
let activeArchive: ProtectedArchive | undefined
const folderState = new Map<string, boolean>()

async function closeArchive(archive: ProtectedArchive): Promise<void> {
  if (activeArchive === archive) activeArchive = undefined
  await archive.close()
}

const fileName = (entry: ProtectedEntry) => entry.path.split('/').at(-1) ?? 'Decrypted file'

async function openAndRender(archive: ProtectedArchive, entry: ProtectedEntry, closeAfterOpen = false): Promise<void> {
  if (entry.directory) return
  try {
    if (entry.size <= MAX_DOCUMENT_PREVIEW_BYTES) {
      const data = await readInlineEntry(await archive.open(entry.path), entry.size, MAX_DOCUMENT_PREVIEW_BYTES)
      renderContent(container, data, await detectContentType(data), fileName(entry), entry.path)
      if (closeAfterOpen) await closeArchive(archive)
      return
    }

    const detectedType = await detectContentType(await readEntryPrefix(await archive.open(entry.path)))
    if (entry.size <= MAX_BINARY_PREVIEW_BYTES) {
      if (isBinaryPreviewType(detectedType)) {
        const data = await readInlineEntry(await archive.open(entry.path), entry.size, MAX_BINARY_PREVIEW_BYTES)
        renderContent(container, data, detectedType, fileName(entry), entry.path)
        if (closeAfterOpen) await closeArchive(archive)
        return
      }
    }

    showSaveEntry(
      container,
      entry,
      async () => {
        const result = await saveEntry(
          {
            size: entry.size,
            contentType: entry.contentType,
            open: () => archive.open(entry.path),
          },
          entry.path.split('/').at(-1) ?? 'decrypted-content'
        )
        if (result === 'saved' && closeAfterOpen) await closeArchive(archive)
        return result
      },
      false,
      detectedType
    )
  } catch (error) {
    if (closeAfterOpen) await closeArchive(archive)
    throw error
  }
}

// The server answered a Range request with the whole encrypted file: offer the body already in flight as encrypted.fee.
function showRangeIgnored(response: Response): void {
  const length = Number(response.headers.get('content-length'))
  const size = length > 0 ? length : undefined
  showRangeUnsupported(container, size, () =>
    saveEntry(
      {
        size: size ?? 0,
        contentType: 'application/octet-stream',
        open: async () => {
          if (!response.body || response.bodyUsed) throw new Error('The encrypted file was already read')
          return response.body
        },
      },
      'encrypted.fee'
    )
  )
}

// Folder shares keep the archive open: every file view gets a way back to the tree, with no new fetch.
async function openEntry(archive: ProtectedArchive, entry: ProtectedEntry): Promise<void> {
  const startedAt = performance.now()
  try {
    await openAndRender(archive, entry)
  } catch (error) {
    if (!(error instanceof RangeUnsupportedError)) throw error
    showRangeIgnored(error.response)
    return
  }
  if (import.meta.env.DEV) devLog(`open ${entry.path} (${entry.size} bytes): ${elapsed(startedAt)}`)
  addBackButton(container, () => showTree(archive))
}

function showTree(archive: ProtectedArchive): void {
  revokeRenderedObjectUrls(container)
  container.classList.remove('wide')
  showProtectedArchive(
    container,
    archive.list(),
    (entry) => openEntry(archive, entry),
    folderState,
    (onProgress) => downloadAll(archive, onProgress)
  )
}

// Zips the open archive in memory and hands it to the browser as a normal download.
async function downloadAll(
  archive: ProtectedArchive,
  onProgress: (done: number, total: number) => void
): Promise<void> {
  const url = URL.createObjectURL(await buildArchiveZip(archive, onProgress))
  const link = document.createElement('a')
  link.href = url
  link.download = zipFileName(archive)
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// Dev only (stripped from production builds, see scripts/check-dist.mjs): serve a local share.
const elapsed = (since: number) => `${Math.round(performance.now() - since)} ms`
const devLog = (message: string) => console.log(`[foc-viewer dev] ${message}`)

// Serves the range requests from the dev harness and logs each one (offset, length, time until headers).
// ?ignore-range makes the harness answer 200 with the whole file, to see the "can't be opened" state.
function devFetch(): typeof fetch {
  const url = `/__dev-share${new URLSearchParams(window.location.search).has('ignore-range') ? '?ignore-range' : ''}`
  return async (_input, init) => {
    const startedAt = performance.now()
    const response = await fetch(url, init)
    const range = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/)
    const what = range ? `offset ${range[1]}, length ${Number(range[2]) - Number(range[1]) + 1}` : 'no range'
    devLog(`range request (${what}) -> ${response.status}: ${elapsed(startedAt)}`)
    return response
  }
}

// openProtectedArchive derives the key internally, so time the Web Crypto call itself.
function devTimeKeyDerivation(): void {
  const original = crypto.subtle.deriveBits.bind(crypto.subtle)
  crypto.subtle.deriveBits = async (...args: Parameters<typeof original>) => {
    const startedAt = performance.now()
    try {
      return await original(...args)
    } finally {
      devLog(`key derivation (PBKDF2): ${elapsed(startedAt)}`)
    }
  }
}
if (import.meta.env.DEV) devTimeKeyDerivation()

async function unlockArchive(cid: string, accessKey: string): Promise<void> {
  try {
    await unlock(cid, accessKey)
  } catch (error) {
    if (!(error instanceof RangeUnsupportedError)) throw error
    showRangeIgnored(error.response)
  }
}

async function unlock(cid: string, accessKey: string): Promise<void> {
  const startedAt = performance.now()
  const archive = import.meta.env.DEV
    ? await openProtectedArchive(cid, accessKey, devFetch())
    : await openProtectedArchive(cid, accessKey)
  if (import.meta.env.DEV) devLog(`archive ready (head + metadata + decrypt + listing): ${elapsed(startedAt)}`)
  await activeArchive?.close()
  activeArchive = archive
  const entries = archive.list()
  if (entries.length === 1 && !entries[0].directory) {
    await openAndRender(archive, entries[0], true)
    return
  }
  const listingStartedAt = performance.now()
  folderState.clear()
  showTree(archive)
  if (import.meta.env.DEV) {
    devLog(`render tree (${entries.length} entries): ${elapsed(listingStartedAt)}`)
    devLog(`unlock total: ${elapsed(startedAt)}`)
  }
}

function init(): void {
  const fragment = parseFragment(window.location.hash)
  if (!fragment) {
    showMissingLink(container)
    return
  }

  showAccessKeyPrompt(container, (accessKey) => unlockArchive(fragment.cid, accessKey))
}

window.addEventListener(
  'pagehide',
  () => {
    const archive = activeArchive
    activeArchive = undefined
    void archive?.close()
    revokePdfObjectUrls()
  },
  { once: true }
)

init()

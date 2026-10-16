import type { ProtectedArchive, ProtectedEntry } from './car-archive.js'
import { openProtectedArchive } from './car-archive.js'
import { MAX_BINARY_PREVIEW_BYTES, MAX_DOCUMENT_PREVIEW_BYTES, readEntryPrefix, readInlineEntry } from './decrypt.js'
import { parseFragment } from './fragment.js'
import {
  detectContentType,
  isBinaryPreviewType,
  renderContent,
  revokePdfObjectUrls,
  revokeRenderedObjectUrls,
} from './render.js'
import { saveEntry } from './save.js'
import { addBackButton, showAccessKeyPrompt, showMissingLink, showProtectedArchive, showSaveEntry } from './ui.js'
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

// Folder shares keep the archive open: every file view gets a way back to the tree, with no new fetch.
async function openEntry(archive: ProtectedArchive, entry: ProtectedEntry): Promise<void> {
  const startedAt = performance.now()
  await openAndRender(archive, entry)
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

// Dev only (stripped from production builds, see scripts/check-dist.mjs): serve a local share
// and allow ?devcap=<bytes> to exercise the too-large state.
const elapsed = (since: number) => `${Math.round(performance.now() - since)} ms`
const devLog = (message: string) => console.log(`[foc-viewer dev] ${message}`)

// Times the request (until headers), first byte and last byte of the body.
function devTimedFetch(startedAt: number): typeof fetch {
  return async (_input, init) => {
    const response = await fetch('/__dev-share', init)
    devLog(`fetch response headers: ${elapsed(startedAt)}`)
    if (!response.body) return response
    let sawFirstByte = false
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (!sawFirstByte) devLog(`first byte: ${elapsed(startedAt)}`)
          sawFirstByte = true
          controller.enqueue(chunk)
        },
        flush() {
          devLog(`last byte (download complete): ${elapsed(startedAt)}`)
        },
      })
    )
    return new Response(body, response)
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

function devMaxBytes(): number | undefined {
  const cap = Number(new URLSearchParams(window.location.search).get('devcap'))
  return cap > 0 ? cap : undefined
}

async function unlockArchive(cid: string, accessKey: string): Promise<void> {
  const startedAt = performance.now()
  const archive = import.meta.env.DEV
    ? await openProtectedArchive(cid, accessKey, devTimedFetch(startedAt), devMaxBytes())
    : await openProtectedArchive(cid, accessKey)
  if (import.meta.env.DEV) devLog(`archive ready (fetch + decrypt + CAR parse + listing): ${elapsed(startedAt)}`)
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

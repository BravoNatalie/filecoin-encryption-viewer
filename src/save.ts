import { TooLargeError } from './errors.js'
import { StagingError, openOpfsRoot, removeStagedFiles, stageStream } from './opfs-save.js'

export interface SaveableEntry {
  readonly size: number
  readonly contentType: string
  open(): Promise<ReadableStream<Uint8Array>>
}

interface SaveFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>
}

interface SavePickerHost {
  showSaveFilePicker?: (options: {
    suggestedName: string
  }) => Promise<SaveFileHandle>
}

// measured: a 1 GB fallback save peaked at 3-4x the file size in Firefox/WebKit
const SAVE_CAP_DESKTOP = 512 * 1024 * 1024
const SAVE_CAP_MOBILE = 256 * 1024 * 1024

// Largest file the in-memory Blob fallback (no showSaveFilePicker) will build.
// mobile is a heuristic (userAgentData, else a touch-only pointer); a wrong guess only moves the cap
export function saveFallbackCap(): number {
  const mobile =
    (globalThis.navigator as (Navigator & { userAgentData?: { mobile?: boolean } }) | undefined)?.userAgentData
      ?.mobile ??
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
  return mobile ? SAVE_CAP_MOBILE : SAVE_CAP_DESKTOP
}

/** `cancelled`: the user dismissed the save picker. */
export type SaveResult = 'saved' | 'cancelled'

// Overlapping saves in one tab each add a URL; all are revoked at the next save's start or on pagehide
const saveUrls = new Set<string>()

/** Revokes the object URLs of earlier saves; they outlive the click because the browser copies the file lazily. */
export function revokeStagedUrl(): void {
  for (const url of saveUrls) URL.revokeObjectURL(url)
  saveUrls.clear()
}

function downloadUrl(blob: Blob, suggestedName: string): void {
  const url = URL.createObjectURL(blob)
  saveUrls.add(url)
  clickDownload(url, suggestedName)
}

/**
 * Saves `entry` with the best option available: the file picker (streams to disk), else OPFS staging (on disk, no
 * cap), else an in-memory Blob up to saveFallbackCap(). `onProgress` gets the bytes written while staging.
 */
export async function saveEntry(
  entry: SaveableEntry,
  suggestedName: string,
  onProgress?: (written: number) => void
): Promise<SaveResult> {
  const picker = (globalThis as typeof globalThis & SavePickerHost).showSaveFilePicker
  if (picker) {
    let handle: SaveFileHandle
    try {
      handle = await picker({ suggestedName })
    } catch (error) {
      // Dismissing the picker rejects with AbortError; that is a choice, not a failure
      if ((error as { name?: string } | undefined)?.name === 'AbortError') return 'cancelled'
      throw error
    }
    await (await entry.open()).pipeTo(await handle.createWritable())
    return 'saved'
  }

  revokeStagedUrl() // only URLs of saves that started earlier exist yet
  const root = await openOpfsRoot()
  if (root) {
    await removeStagedFiles(root)
    try {
      const file = await stageStream(root, await entry.open(), onProgress)
      downloadUrl(file, suggestedName)
      return 'saved'
    } catch (error) {
      // A storage failure (quota, disk) falls through to the Blob path below; anything else is the caller's
      if (!(error instanceof StagingError)) throw error
    }
  }

  const cap = saveFallbackCap()
  if (entry.size > cap) throw new TooLargeError('This file is too large to save in this browser')
  const parts = await readParts(await entry.open(), cap)
  // octet-stream: a typed blob (html, svg) opened from the download link would run its scripts on this origin.
  // Revoked at the next save or pagehide, not right after the click: some Safari versions fail a download whose URL
  // was revoked at once.
  downloadUrl(new Blob(parts as BlobPart[], { type: 'application/octet-stream' }), suggestedName)
  return 'saved'
}

function clickDownload(url: string, suggestedName: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = suggestedName
  link.hidden = true
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
  }
}

// The parts go straight into a Blob, so the browser can keep them outside the JS heap; the size is checked
// while reading too, because a declared size can be missing.
async function readParts(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array[]> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    total += value.length
    if (total > cap) {
      await reader.cancel()
      throw new TooLargeError('This file is too large to save in this browser')
    }
    parts.push(value)
  }
}

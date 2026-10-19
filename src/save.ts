import { TooLargeError } from './errors.js'

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
// ponytail: mobile is a heuristic (userAgentData, else a touch-only pointer); a wrong guess only moves the cap
export function saveFallbackCap(): number {
  const mobile =
    (globalThis.navigator as (Navigator & { userAgentData?: { mobile?: boolean } }) | undefined)?.userAgentData
      ?.mobile ??
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
  return mobile ? SAVE_CAP_MOBILE : SAVE_CAP_DESKTOP
}

export async function saveEntry(entry: SaveableEntry, suggestedName: string): Promise<'saved'> {
  const picker = (globalThis as typeof globalThis & SavePickerHost).showSaveFilePicker
  if (picker) {
    const handle = await picker({ suggestedName })
    await (await entry.open()).pipeTo(await handle.createWritable())
    return 'saved'
  }

  const cap = saveFallbackCap()
  if (entry.size > cap) throw new TooLargeError('This file is too large to save in this browser')
  const parts = await readParts(await entry.open(), cap)
  const objectUrl = URL.createObjectURL(new Blob(parts as BlobPart[], { type: entry.contentType }))
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = suggestedName
  link.hidden = true
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    URL.revokeObjectURL(objectUrl)
  }
  return 'saved'
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

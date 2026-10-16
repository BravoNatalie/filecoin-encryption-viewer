import type { RandomAccessSource } from 'filecoin-encryption-envelope'
import { NotAvailableError, RangeUnsupportedError } from './errors.js'

// Covers the envelope header plus the first metadata window, so opening costs one request when the metadata is small
const HEAD_BYTES = 320 * 1024
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/

// ponytail: requests are sequential; add bounded read-ahead if previews feel slow
/**
 * A random-access view of the envelope behind `url`, read with Range requests. `size` comes from the first
 * response's Content-Range, and the head bytes it carried are reused, so the header parse costs no extra request.
 */
export async function openRangeSource(url: string, fetchFn: typeof fetch): Promise<RandomAccessSource> {
  const first = await requestRange(url, fetchFn, 0, HEAD_BYTES)
  const head = await readAll(first.body).catch((error) => {
    throw new NotAvailableError('The download was interrupted', { cause: error })
  })
  if (first.start !== 0 || first.end >= HEAD_BYTES || head.length !== first.end + 1) {
    throw new NotAvailableError('The server answered with a different range than requested')
  }
  const size = first.total

  return {
    size,
    async openRange(offset, length) {
      if (offset + length <= head.length) return streamOf(head.subarray(offset, offset + length))
      const response = await requestRange(url, fetchFn, offset, length)
      if (response.start !== offset || response.end !== offset + length - 1 || response.total !== size) {
        throw new NotAvailableError('The server answered with a different range than requested')
      }
      return response.body
    },
  }
}

async function requestRange(url: string, fetchFn: typeof fetch, offset: number, length: number) {
  let response: Response
  try {
    // no-store: inbrowser.link's service worker otherwise answers later Range requests with a cached full 200
    response = await fetchFn(url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      cache: 'no-store',
      redirect: 'error',
    })
  } catch (error) {
    throw new NotAvailableError('Share is not available yet', { cause: error })
  }
  // The content exists but can't be read in parts; the caller keeps the response so its body can still be saved
  if (response.status === 200) throw new RangeUnsupportedError(response)
  if ([404, 502, 504].includes(response.status)) throw new NotAvailableError('Share is not available yet')
  if (response.status !== 206) throw new Error(`Unexpected response: ${response.status}`)

  const range = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '')
  if (!range || !response.body) throw new NotAvailableError('The server sent an invalid range response')
  return { start: Number(range[1]), end: Number(range[2]), total: Number(range[3]), body: response.body }
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    length += value.length
  }
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

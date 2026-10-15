import { filetypemime } from 'magic-bytes.js'
import { clearCardLabel } from './card-label.js'
import { fileTypeLabel } from './file-type.js'
import { formatBytes } from './format.js'
import { createLockedHtmlFrame } from './sandbox.js'

const activeObjectUrls = new WeakMap<HTMLElement, string[]>()

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function revokeRenderedObjectUrls(container: HTMLElement): void {
  for (const objectUrl of activeObjectUrls.get(container) ?? []) URL.revokeObjectURL(objectUrl)
  activeObjectUrls.delete(container)
}

export async function detectContentType(data: Uint8Array): Promise<string> {
  const mimes = filetypemime(Array.from(data.slice(0, 100)))
  if (mimes.length > 0) return mimes[0]

  const prefix = new TextDecoder().decode(data.slice(0, 15)).trimStart().toLowerCase()
  if (prefix.startsWith('<!doctype') || prefix.startsWith('<html')) return 'text/html'

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return 'text/plain'
  } catch {
    return 'application/octet-stream'
  }
}

export function isBinaryPreviewType(contentType: string): boolean {
  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('video/') ||
    contentType === 'application/pdf'
  )
}

// Eyebrow, file name (full path in the tooltip) and a "<type> · <size>" line, shared by every file view.
function fileHeader(name: string, title: string, contentType: string, size: number): string {
  return `
      <p class="eyebrow">Encrypted share</p>
      <h1 class="file-title" title="${escapeHtml(title)}">${escapeHtml(name)}</h1>
      <p class="lede-left">${fileTypeLabel(contentType)} · ${formatBytes(size)}</p>`
}

// A column: heading, the sandboxed page at card width, then the download action.
function renderHtml(container: HTMLElement, data: Uint8Array, displayName: string, title: string): void {
  const objectUrl = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'text/html' }))
  activeObjectUrls.set(container, [objectUrl])
  container.classList.add('wide')
  container.innerHTML = `
    <div class="content-wrapper">${fileHeader(displayName, title, 'text/html', data.byteLength)}
      <div id="html-preview"></div>
      <a class="btn-secondary" href="${objectUrl}" download="${escapeHtml(displayName)}">Download</a>
    </div>
  `
  container.querySelector('#html-preview')?.replaceChildren(createLockedHtmlFrame(new TextDecoder().decode(data)))
}

export function renderContent(
  container: HTMLElement,
  data: Uint8Array,
  contentType: string,
  displayName = 'Decrypted file',
  title = displayName
): void {
  revokeRenderedObjectUrls(container)
  clearCardLabel()
  container.classList.remove('wide')
  if (contentType === 'text/html') {
    renderHtml(container, data, displayName, title)
    return
  }

  const blob = new Blob([data as Uint8Array<ArrayBuffer>], {
    type: contentType,
  })
  const objectUrl = URL.createObjectURL(blob)
  activeObjectUrls.set(container, [objectUrl])
  const filename = 'decrypted-content'
  const header = fileHeader(displayName, title, contentType, data.byteLength)

  if (contentType.startsWith('image/')) {
    container.classList.add('wide')
    container.innerHTML = `
      <div class="content-wrapper">${header}
        <img src="${objectUrl}" alt="Decrypted image" style="max-width:100%;max-height:90vh;display:block;margin:0 auto;" />
        <a class="btn-secondary" href="${objectUrl}" download="${escapeHtml(filename)}">Download</a>
      </div>
    `
    return
  }

  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
    const tag = contentType.startsWith('audio/') ? 'audio' : 'video'
    container.classList.add('wide')
    container.innerHTML = `
      <div class="content-wrapper">${header}
        <${tag} controls preload="metadata" src="${objectUrl}"></${tag}>
        <a class="btn-secondary" href="${objectUrl}" download="${escapeHtml(filename)}">Download</a>
      </div>
    `
    return
  }

  if (contentType === 'application/pdf') {
    container.innerHTML = `
      <div class="content-wrapper">${header}
        <embed src="${objectUrl}" type="application/pdf" width="100%" height="600px" />
        <a class="btn-secondary" href="${objectUrl}" download="${escapeHtml(filename)}.pdf">Download</a>
      </div>
    `
    return
  }

  if (contentType === 'text/plain') {
    const text = new TextDecoder().decode(data)
    container.innerHTML = `
      <div class="content-wrapper">${header}
        <pre>${escapeHtml(text)}</pre>
        <a class="btn-secondary" href="${objectUrl}" download="${escapeHtml(filename)}.txt">Download</a>
      </div>
    `
    return
  }

  container.innerHTML = `
    <div class="content-wrapper">${header}
      <a class="btn-primary" href="${objectUrl}" download="${escapeHtml(filename)}">Download file</a>
    </div>
  `
}

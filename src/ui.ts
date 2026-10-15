import type { ProtectedEntry } from './car-archive.js'
import { NotAShareError, NotAvailableError, TooLargeError, WrongPasswordError } from './car-archive.js'
import { clearCardLabel, setCardLabel } from './card-label.js'
import { fileTypeLabel } from './file-type.js'
import { formatBytes } from './format.js'

const HERO_URL = new URL('../assets/secure-sharing-hero.webp', import.meta.url).href

const hero = (small = false) =>
  `<img class="hero${small ? ' small' : ''}" src="${HERO_URL}" alt="" width="600" height="404" decoding="async" />`

const ICON =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
const LOCK_ICON = `<svg ${ICON}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>`
const SHIELD_ICON = `<svg ${ICON}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>`

// The Filecoin ƒ mark, adapted from filecoin-pay-explorer's filecoin-logo.svg (circle and mask removed)
const FILECOIN_ICON = `<svg viewBox="9.4 5.3 21.5 29.3" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"><path d="M21.9 17.6l-.6 3.2 5.7.8-.4 1.5-5.6-.8c-.4 1.3-.6 2.7-1.1 3.9-.5 1.4-1 2.8-1.6 4.1-.8 1.7-2.2 2.9-4.1 3.2-1.1.2-2.3.1-3.2-.6-.3-.2-.6-.6-.6-.9 0-.4.2-.9.5-1.1.2-.1.7 0 1 .1.3.3.6.7.8 1.1.6.8 1.4.9 2.2.3.9-.8 1.4-1.9 1.7-3 .6-2.4 1.2-4.7 1.7-7.1v-.4l-5.3-.8.2-1.5 5.5.8.7-3.1-5.7-.9.2-1.6 5.9.8c.2-.6.3-1.1.5-1.6.5-1.8 1-3.6 2.2-5.2 1.2-1.6 2.6-2.6 4.7-2.5.9 0 1.8.3 2.4 1 .1.1.3.3.3.5 0 .4 0 .9-.3 1.2-.4.3-.9.2-1.3-.2-.3-.3-.5-.6-.8-.9-.6-.8-1.5-.9-2.2-.2-.5.5-1 1.2-1.3 1.9-.7 2.1-1.2 4.3-1.9 6.5l5.5.8-.4 1.5-5.3-.8" /></svg>`

const features = () => `
  <ul class="features">
    <li><span class="feature-icon">${LOCK_ICON}</span>End-to-end<br />encryption</li>
    <li><span class="feature-icon">${FILECOIN_ICON}</span>Filecoin<br />network</li>
    <li><span class="feature-icon">${SHIELD_ICON}</span>Your privacy<br />matters</li>
  </ul>`

const EMPTY_PASSWORD_ERROR = 'Enter the password you received from the sender.'

export function unlockErrorMessage(cause: unknown): string {
  if (cause instanceof WrongPasswordError) {
    return 'That password could not decrypt this share, or the share was modified. Check it and try again.'
  }
  if (cause instanceof NotAvailableError) {
    return "This share isn't available yet, or the download was interrupted. Try again in a few minutes."
  }
  if (cause instanceof TooLargeError) {
    return 'This share is too large to open in the browser. Use `filecoin-pin decrypt` instead.'
  }
  if (cause instanceof NotAShareError) {
    return "This link doesn't point to a filecoin-pin encrypted share."
  }
  return 'Something went wrong opening this share. Try again.'
}

export function showAccessKeyPrompt(container: HTMLElement, onSubmit: (password: string) => Promise<void>): void {
  clearCardLabel()
  container.innerHTML = `
    <form class="password-form">
      ${hero()}
      <p class="eyebrow center">Encrypted share</p>
      <h1 class="big center">Unlock this share</h1>
      <p class="lede center">
        <span>The content is encrypted and stored on Filecoin.</span>
        <span>Use the password the sender gave you separately.</span>
        <span>Decryption happens in your browser.</span>
      </p>
      ${features()}
      <label for="pw-input">Password</label>
      <div class="password-input">
        <input type="password" id="pw-input" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Enter password" />
        <button class="password-toggle" id="password-toggle" type="button" aria-label="Show password" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M2.7 12s3.4-5.2 9.3-5.2S21.3 12 21.3 12s-3.4 5.2-9.3 5.2S2.7 12 2.7 12Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
            <circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.7" />
          </svg>
        </button>
      </div>
      <button class="btn-primary" id="view-btn" type="submit">Unlock</button>
      <p class="error" id="error" role="alert" hidden></p>
      <p class="hint">${LOCK_ICON}Only someone with the password can unlock this share.</p>
    </form>
  `

  const form = container.querySelector('form') as HTMLFormElement
  const passwordInput = container.querySelector('#pw-input') as HTMLInputElement
  const button = container.querySelector('#view-btn') as HTMLButtonElement
  const passwordToggle = container.querySelector('#password-toggle') as HTMLButtonElement
  const error = container.querySelector('#error') as HTMLParagraphElement
  passwordInput.focus()

  passwordToggle.addEventListener('click', () => {
    const showPassword = passwordInput.type === 'password'
    const { selectionStart, selectionEnd } = passwordInput
    passwordInput.type = showPassword ? 'text' : 'password'
    passwordToggle.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password')
    passwordToggle.setAttribute('aria-pressed', String(showPassword))
    passwordInput.focus()
    if (selectionStart !== null && selectionEnd !== null) {
      passwordInput.setSelectionRange(selectionStart, selectionEnd)
    }
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (button.disabled) return

    if (!passwordInput.value) {
      error.textContent = EMPTY_PASSWORD_ERROR
      error.hidden = false
      return
    }

    button.disabled = true
    button.textContent = 'Decrypting…'
    error.hidden = true
    try {
      await onSubmit(passwordInput.value)
    } catch (cause) {
      error.textContent = unlockErrorMessage(cause)
      error.hidden = false
      if (cause instanceof WrongPasswordError) passwordInput.select()
    } finally {
      button.disabled = false
      button.textContent = 'Unlock'
    }
  })
}

export function showMissingLink(container: HTMLElement): void {
  clearCardLabel()
  container.innerHTML = `
    <div class="missing-link center">
      ${hero(true)}
      <p class="eyebrow">Encrypted share</p>
      <h1>This link is incomplete.</h1>
      <p class="lede">Ask the sender for the full protected-share link and open it again.</p>
    </div>
  `
}

interface ArchiveTreeNode {
  name: string
  path: string
  entry?: ProtectedEntry
  children: Map<string, ArchiveTreeNode>
}

const AUTO_OPEN_DEPTH = 2
const ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"'
const FOLDER_ICON = `<svg ${ICON_ATTRS}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>`
const FILE_ICON = `<svg ${ICON_ATTRS}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>`

function buildArchiveTree(entries: readonly ProtectedEntry[]): Map<string, ArchiveTreeNode> {
  const roots = new Map<string, ArchiveTreeNode>()
  for (const entry of entries) {
    const path = entry.directory ? entry.path.slice(0, -1) : entry.path
    const segments = path.split('/')
    let level = roots
    for (const [index, segment] of segments.entries()) {
      let node = level.get(segment)
      if (!node) {
        node = { name: segment, path: segments.slice(0, index + 1).join('/'), children: new Map() }
        level.set(segment, node)
      }
      if (index === segments.length - 1) node.entry = entry
      level = node.children
    }
  }
  return roots
}

const isDirectory = (node: ArchiveTreeNode) => node.children.size > 0 || node.entry?.directory === true

// Folders first, then files; case-insensitive
function sortNodes(nodes: Map<string, ArchiveTreeNode>): ArchiveTreeNode[] {
  return [...nodes.values()].sort(
    (left, right) =>
      Number(isDirectory(right)) - Number(isDirectory(left)) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
}

function createName(name: string): HTMLSpanElement {
  const label = document.createElement('span')
  label.className = 'tree-name'
  label.textContent = name
  label.title = name
  return label
}

function createFileItem(
  node: ArchiveTreeNode,
  entry: ProtectedEntry,
  onSelect: (entry: ProtectedEntry) => Promise<void>,
  error: HTMLParagraphElement
): HTMLLIElement {
  const item = document.createElement('li')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'tree-file'
  button.insertAdjacentHTML('afterbegin', FILE_ICON)
  const size = document.createElement('span')
  size.className = 'tree-size'
  size.textContent = formatBytes(entry.size)
  button.append(createName(node.name), size)
  button.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    error.hidden = true
    try {
      await onSelect(entry)
    } catch {
      error.textContent = 'This file could not be opened.'
      error.hidden = false
    } finally {
      if (button.isConnected) button.disabled = false
    }
  })
  item.append(button)
  return item
}

function createFolderItem(
  node: ArchiveTreeNode,
  depth: number,
  onSelect: (entry: ProtectedEntry) => Promise<void>,
  error: HTMLParagraphElement,
  folderState: Map<string, boolean>
): HTMLLIElement {
  const item = document.createElement('li')
  const details = document.createElement('details')
  details.open = folderState.get(node.path) ?? depth <= AUTO_OPEN_DEPTH
  details.addEventListener('toggle', () => folderState.set(node.path, details.open))
  const summary = document.createElement('summary')
  summary.insertAdjacentHTML('afterbegin', FOLDER_ICON)
  summary.append(createName(node.name))
  details.append(summary)
  details.append(createTreeList(node.children, depth + 1, onSelect, error, folderState))
  item.append(details)
  return item
}

function createTreeList(
  nodes: Map<string, ArchiveTreeNode>,
  depth: number,
  onSelect: (entry: ProtectedEntry) => Promise<void>,
  error: HTMLParagraphElement,
  folderState: Map<string, boolean>
): HTMLUListElement {
  const list = document.createElement('ul')
  for (const node of sortNodes(nodes)) {
    if (isDirectory(node)) list.append(createFolderItem(node, depth, onSelect, error, folderState))
    else if (node.entry) list.append(createFileItem(node, node.entry, onSelect, error))
  }
  return list
}

/**
 * Renders the share as a nested tree. `folderState` remembers which folders the user opened or
 * closed, so a caller can pass the same map again to restore the tree after leaving a file view.
 */
export function showProtectedArchive(
  container: HTMLElement,
  entries: readonly ProtectedEntry[],
  onSelect: (entry: ProtectedEntry) => Promise<void>,
  folderState: Map<string, boolean> = new Map(),
  onDownloadAll?: (onProgress: (done: number, total: number) => void) => Promise<void>
): void {
  setCardLabel('Encrypted share')
  container.innerHTML = `
    <div class="content-wrapper">
      ${treeHeaderMarkup(entries, Boolean(onDownloadAll) && entries.length > 0)}
      <div id="archive-tree" aria-label="Protected files"></div>
      <p class="error" id="archive-error" role="alert" hidden></p>
    </div>
  `

  const tree = container.querySelector('#archive-tree') as HTMLDivElement
  const error = container.querySelector('#archive-error') as HTMLParagraphElement
  if (entries.length === 0) {
    tree.textContent = 'This protected folder is empty.'
    return
  }
  tree.append(createTreeList(buildArchiveTree(entries), 0, onSelect, error, folderState))
  if (onDownloadAll) wireDownloadAll(container, onDownloadAll)
}

const DOWNLOAD_ICON = `<svg ${ICON_ATTRS}><path d="M12 4v11" /><path d="M7 10.5l5 5 5-5" /><path d="M5 20h14" /></svg>`

// File count on the left, compact zip action on the right. The page's <h1> is the label above the card.
function treeHeaderMarkup(entries: readonly ProtectedEntry[], withDownloadAll: boolean): string {
  const files = entries.filter((entry) => !entry.directory)
  const bytes = files.reduce((total, entry) => total + entry.size, 0)
  const summary =
    entries.length > 0
      ? `<p class="tree-summary">${files.length} ${files.length === 1 ? 'file' : 'files'} · ${formatBytes(bytes)}</p>`
      : ''
  const action = withDownloadAll
    ? `<button type="button" class="btn-compact" id="download-all" aria-label="Download all files as a zip">${DOWNLOAD_ICON}<span class="btn-label">Download all</span></button>`
    : ''
  return `
      <div class="tree-head">
        <div class="tree-head-row">
          ${summary}
          ${action}
        </div>
        ${withDownloadAll ? '<p class="zip-status" id="zip-status" role="status"></p>' : ''}
      </div>`
}

function wireDownloadAll(
  container: HTMLElement,
  onDownloadAll: (onProgress: (done: number, total: number) => void) => Promise<void>
): void {
  const button = container.querySelector('#download-all') as HTMLButtonElement | null
  const status = container.querySelector('#zip-status') as HTMLParagraphElement | null
  const label = button?.querySelector('.btn-label')
  if (!button || !status || !label) return
  button.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    label.textContent = 'Preparing…'
    status.textContent = ''
    try {
      await onDownloadAll((done, total) => {
        status.textContent = `Adding files: ${done} of ${total}`
      })
      status.textContent = 'Zip ready.'
    } catch {
      status.textContent = 'The zip could not be created. Try again.'
    } finally {
      button.disabled = false
      label.textContent = 'Download all'
    }
  })
}

/** Puts an "All files" button at the top of the current card; the caller decides what going back does. */
export function addBackButton(container: HTMLElement, onBack: () => void): void {
  const button = document.createElement('button')
  button.type = 'button'
  button.id = 'back-btn'
  button.className = 'back-btn'
  button.textContent = '← All files'
  button.addEventListener('click', onBack)
  container.prepend(button)
}

export function showSaveEntry(
  container: HTMLElement,
  entry: ProtectedEntry,
  onSave: () => Promise<'saved' | 'unsupported'>,
  previewFailed = false,
  detectedType: string | undefined = undefined
): void {
  const actionLabel = previewFailed ? 'Download instead' : 'Download file'
  clearCardLabel()
  container.innerHTML = `
    <div class="content-wrapper">
      <p class="eyebrow">Encrypted share</p>
      <h1 class="file-title" id="save-entry-name"></h1>
      <p class="lede-left">${fileTypeLabel(detectedType)} · ${formatBytes(entry.size)}</p>
      ${previewFailed ? '<p class="lede-left note">Preview unavailable.</p>' : ''}
      <button class="btn-primary" id="save-entry" type="button">${actionLabel}</button>
      <p class="hint" id="save-status" role="status"></p>
      <p class="error" id="save-error" role="alert" hidden></p>
    </div>
  `

  const name = container.querySelector('#save-entry-name') as HTMLHeadingElement
  const button = container.querySelector('#save-entry') as HTMLButtonElement
  const status = container.querySelector('#save-status') as HTMLParagraphElement
  const error = container.querySelector('#save-error') as HTMLParagraphElement
  name.textContent = entry.path.split('/').at(-1) ?? entry.path
  name.title = entry.path
  button.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    button.textContent = 'Saving…'
    error.hidden = true
    status.textContent = ''
    try {
      const result = await onSave()
      if (result === 'unsupported') {
        error.textContent = 'Open this protected link in Chromium to download a file this large.'
        error.hidden = false
      } else {
        status.textContent = 'Saved.'
      }
    } catch {
      error.textContent = 'This file could not be saved.'
      error.hidden = false
    } finally {
      button.disabled = false
      button.textContent = actionLabel
    }
  })
}

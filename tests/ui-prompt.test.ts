// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WrongAccessKeyError } from '../src/car-archive.js'
import { encodeAccessKey } from '../src/fragment.js'
import { showAccessKeyPrompt } from '../src/ui.js'
import { expectSameBytes } from './fixtures/bytes.js'

let container: HTMLElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.replaceChildren(container)
})

const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const KEY = encodeAccessKey(KEY_BYTES)

function submit(text: string): void {
  ;(container.querySelector('#access-key') as HTMLInputElement).value = text
  ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
    new Event('submit', { cancelable: true, bubbles: true })
  )
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const error = () => container.querySelector('#error') as HTMLParagraphElement
const button = () => container.querySelector('#view-btn') as HTMLButtonElement

describe('Access key prompt', () => {
  it('says Access key in the label, placeholder and toggle', () => {
    showAccessKeyPrompt(container, async () => {})
    expect(container.querySelector('label')?.textContent).toBe('Access key')
    const input = container.querySelector('#access-key') as HTMLInputElement
    expect(input.getAttribute('placeholder')).toBe('fak1_…')
    expect(input.type).toBe('password')
    const toggle = container.querySelector('#key-toggle') as HTMLButtonElement
    expect(toggle.getAttribute('aria-label')).toBe('Show Access key')
    toggle.click()
    expect(toggle.getAttribute('aria-label')).toBe('Hide Access key')
    expect(input.type).toBe('text')
  })

  it('rejects an empty submit without calling onSubmit', () => {
    const onSubmit = vi.fn(async () => {})
    showAccessKeyPrompt(container, onSubmit)
    submit('')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(error().hidden).toBe(false)
    expect(error().textContent).toBe('Enter the Access key you received from the sender.')
  })

  it.each([KEY, `  ${KEY.slice(0, 20)}\n  ${KEY.slice(20)}  `])('passes the key bytes of %j', async (text) => {
    const onSubmit = vi.fn(async (_key: Uint8Array) => {})
    showAccessKeyPrompt(container, onSubmit)
    submit(text)
    await flush()
    expect(onSubmit).toHaveBeenCalledOnce()
    expectSameBytes(onSubmit.mock.calls[0][0], KEY_BYTES)
  })

  it.each([
    ['fgr1_AAAA', "That's a group key Grant, not an Access key."],
    [`https://viewer.example/#v1/bafy&d=AAAA&k=${KEY}`, "That's a Share link, not an Access key."],
    [KEY.slice('fak1_'.length), 'An Access key starts with fak1_'],
    ['correct horse battery staple', 'An Access key starts with fak1_'],
    [KEY.slice(0, -1), 'This Access key is incomplete. Copy it again.'],
    [`${KEY}AA`, 'This Access key is incomplete. Copy it again.'],
    [`${KEY.slice(0, -1)}!`, 'This Access key is incomplete. Copy it again.'],
  ])('refuses %j locally, without calling onSubmit', (text, message) => {
    const onSubmit = vi.fn(async () => {})
    showAccessKeyPrompt(container, onSubmit)
    submit(text)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(error().hidden).toBe(false)
    expect(error().textContent).toBe(message)
  })

  it('shows the wrong-Access-key message and re-enables the button', async () => {
    showAccessKeyPrompt(container, async () => {
      throw new WrongAccessKeyError('x')
    })
    submit(KEY)
    expect(button().disabled).toBe(true)
    expect(button().textContent).toBe('Decrypting…')
    await flush()
    expect(error().hidden).toBe(false)
    expect(error().textContent).toBe("That Access key doesn't open this share. Check it and try again.")
    expect(button().disabled).toBe(false)
    expect(button().textContent).toBe('Unlock')
  })
})

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WrongPasswordError } from '../src/car-archive.js'
import { showAccessKeyPrompt } from '../src/ui.js'

let container: HTMLElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.replaceChildren(container)
})

function submit(password: string): void {
  ;(container.querySelector('#pw-input') as HTMLInputElement).value = password
  ;(container.querySelector('form') as HTMLFormElement).dispatchEvent(
    new Event('submit', { cancelable: true, bubbles: true })
  )
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const error = () => container.querySelector('#error') as HTMLParagraphElement
const button = () => container.querySelector('#view-btn') as HTMLButtonElement

describe('password prompt', () => {
  it('says Access key in the label, placeholder and toggle', () => {
    showAccessKeyPrompt(container, async () => {})
    expect(container.querySelector('label')?.textContent).toBe('Access key')
    expect(container.querySelector('#pw-input')?.getAttribute('placeholder')).toBe('Enter Access key')
    expect(container.querySelector('#pw-input')?.hasAttribute('maxlength')).toBe(false)
    const toggle = container.querySelector('#password-toggle') as HTMLButtonElement
    expect(toggle.getAttribute('aria-label')).toBe('Show Access key')
    toggle.click()
    expect(toggle.getAttribute('aria-label')).toBe('Hide Access key')
  })

  it('rejects an empty submit without calling onSubmit', () => {
    const onSubmit = vi.fn(async () => {})
    showAccessKeyPrompt(container, onSubmit)
    submit('')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(error().hidden).toBe(false)
    expect(error().textContent).toBe('Enter the Access key you received from the sender.')
  })

  it.each(['a', ' padded pass phrase ', 'pässwörd-🔑-日本語'.repeat(40)])('passes %j unchanged', async (password) => {
    const onSubmit = vi.fn(async () => {})
    showAccessKeyPrompt(container, onSubmit)
    submit(password)
    await flush()
    expect(onSubmit).toHaveBeenCalledWith(password)
  })

  it('shows the wrong-password message and re-enables the button', async () => {
    showAccessKeyPrompt(container, async () => {
      throw new WrongPasswordError('x')
    })
    submit('nope')
    expect(button().disabled).toBe(true)
    expect(button().textContent).toBe('Decrypting…')
    await flush()
    expect(error().hidden).toBe(false)
    expect(error().textContent).toContain('That Access key could not decrypt this share')
    expect(button().disabled).toBe(false)
    expect(button().textContent).toBe('Unlock')
  })
})

import { describe, expect, it } from 'vitest'
import { NotAShareError, NotAvailableError, TooLargeError, WrongPasswordError } from '../src/car-archive.js'
import { unlockErrorMessage } from '../src/ui.js'

describe('unlockErrorMessage', () => {
  it('maps WrongPasswordError', () => {
    expect(unlockErrorMessage(new WrongPasswordError('x'))).toBe(
      'That password could not decrypt this share, or the share was modified. Check it and try again.'
    )
  })

  it('maps NotAvailableError', () => {
    expect(unlockErrorMessage(new NotAvailableError('x'))).toBe(
      "This share isn't available yet, or the download was interrupted. Try again in a few minutes."
    )
  })

  it('maps TooLargeError', () => {
    expect(unlockErrorMessage(new TooLargeError('x'))).toBe(
      'This share is too large to open in the browser. Use `filecoin-pin decrypt` instead.'
    )
  })

  it('maps NotAShareError', () => {
    expect(unlockErrorMessage(new NotAShareError())).toBe("This link doesn't point to a filecoin-pin encrypted share.")
  })

  it('maps anything else to the generic message', () => {
    expect(unlockErrorMessage(new Error('boom'))).toBe('Something went wrong opening this share. Try again.')
    expect(unlockErrorMessage('nope')).toBe('Something went wrong opening this share. Try again.')
  })
})

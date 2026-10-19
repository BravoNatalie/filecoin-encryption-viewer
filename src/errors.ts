export class NotAvailableError extends Error {
  override name = 'NotAvailableError'
}
export class TooLargeError extends Error {
  override name = 'TooLargeError'
}
/** A real share with more entries, or deeper paths, than the Viewer will list. */
export class TooManyEntriesError extends Error {
  override name = 'TooManyEntriesError'
}
export class WrongPasswordError extends Error {
  override name = 'WrongPasswordError'
}
export class NotAShareError extends Error {
  override name = 'NotAShareError'
  constructor(options?: ErrorOptions) {
    super("This link doesn't point to a filecoin-pin encrypted share", options)
  }
}

/** The server answered a Range request with a 200. `response` is unread, so its body can still be saved. */
export class RangeUnsupportedError extends Error {
  override name = 'RangeUnsupportedError'
  response: Response
  constructor(response: Response) {
    super('The server ignored the Range request')
    this.response = response
  }
}

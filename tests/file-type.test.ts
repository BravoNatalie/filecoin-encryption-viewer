import { describe, expect, it } from 'vitest'
import { fileTypeLabel } from '../src/file-type.js'

describe('fileTypeLabel', () => {
  it.each([
    ['application/pdf', 'PDF'],
    ['image/jpeg', 'JPEG image'],
    ['image/png', 'PNG image'],
    ['video/mp4', 'MP4 video'],
    ['text/plain', 'Text'],
    ['text/html', 'HTML page'],
    ['application/zip', 'ZIP archive'],
    ['image/avif', 'Image'],
    ['application/octet-stream', 'Unknown file type'],
    ['application/x-whatever', 'Unknown file type'],
    [undefined, 'Unknown file type'],
  ])('labels %s as %s', (type, label) => {
    expect(fileTypeLabel(type)).toBe(label)
  })
})

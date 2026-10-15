import { describe, expect, it } from 'vitest'
import { formatBytes } from '../src/format.js'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [812, '812 B'],
    [1536, '1.5 KB'],
    [999, '999 B'],
    [2_000_000, '2.0 MB'],
    [12_000_000, '12 MB'],
    [3_000_000_000, '3.0 GB'],
  ])('formats %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})

import { expect } from 'vitest'

// toEqual compares byte arrays element by element, which takes seconds on MiB-sized data and prints a huge diff.
export function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length, 'byte length').toBe(expected.length)
  if (Buffer.compare(actual, expected) === 0) return
  const offset = actual.findIndex((byte, index) => byte !== expected[index])
  expect.fail(`bytes differ at offset ${offset}: got ${actual[offset]}, expected ${expected[offset]}`)
}

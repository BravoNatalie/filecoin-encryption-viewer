import { pbkdf2Sync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { derivePasswordKey, validateKdfMetadata } from '../src/password-key.js'

const salt = new Uint8Array(16).fill(7)
const saltB64 = btoa(String.fromCharCode(...salt))
const valid = { kdf: 'pbkdf2-sha256', iterations: 1000, salt: saltB64 }

describe('derivePasswordKey', () => {
  it('matches PBKDF2-SHA256 known answer', async () => {
    const key = await derivePasswordKey('pässword', salt, 1000)
    expect(Buffer.from(key).toString('hex')).toBe(pbkdf2Sync('pässword', salt, 1000, 32, 'sha256').toString('hex'))
    expect(key).toHaveLength(32)
  })
})

describe('validateKdfMetadata', () => {
  it('accepts valid metadata', () => {
    expect(validateKdfMetadata(valid)).toEqual({ salt, iterations: 1000 })
    expect(validateKdfMetadata({ ...valid, iterations: 10_000_000 }).iterations).toBe(10_000_000)
  })

  it.each([
    ['undefined', undefined],
    ['wrong kdf', { ...valid, kdf: 'scrypt' }],
    ['missing salt', { ...valid, salt: undefined }],
    ['non-base64 salt', { ...valid, salt: '***' }],
    ['short salt', { ...valid, salt: btoa('short') }],
    ['long salt', { ...valid, salt: btoa('x'.repeat(17)) }],
    ['zero iterations', { ...valid, iterations: 0 }],
    ['too many iterations', { ...valid, iterations: 10_000_001 }],
    ['fractional iterations', { ...valid, iterations: 1.5 }],
    ['string iterations', { ...valid, iterations: '1000' }],
  ])('rejects %s', (_name, metadata) => {
    expect(() => validateKdfMetadata(metadata)).toThrow('missing or unsupported key derivation parameters')
  })
})

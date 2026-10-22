import { describe, expect, it } from 'vitest'
import { decodeAccessKey, encodeAccessKey, parseFragment } from '../src/fragment.js'
import { expectSameBytes } from './fixtures/bytes.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index)
const KEY = 'fak1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

describe('parseFragment', () => {
  it('parses v1/<cid> with and without the leading #', () => {
    expect(parseFragment(`#v1/${CID}`)).toEqual({ cid: CID })
    expect(parseFragment(`v1/${CID}`)).toEqual({ cid: CID })
  })

  it('parses a one-click link', () => {
    const withKey = parseFragment(`#v1/${CID}&k=${KEY}`)
    expect(withKey?.cid).toBe(CID)
    expectSameBytes(withKey?.key as Uint8Array, KEY_BYTES)
  })

  it.each([
    '',
    '#',
    '#v1/',
    '#v1/bafy',
    `#cid=${CID}`,
    `#v1/${CID}?pw=secret`,
    `#v1/${CID}/`,
    `#v2/${CID}`,
    `#V1/${CID}`,
    `#v1/${CID.toUpperCase()}`,
    `#v1/${encodeURIComponent(CID.replace('b', '%'))}`,
    `#v1%2F${CID}`,
    ` #v1/${CID}`,
    `#v1/${CID} `,
    `#v1/${CID}\n`,
    '#v1/../../etc/passwd',
    `#v1/../${CID}`,
    `#v1/${CID}?p=`,
    `#v1/${CID}?p=12`,
    `#v1/${CID}?p=4,9`,
    `#v1/${CID}?p=12,34&k=${KEY}`,
    `#v1/${CID}?k=${KEY}`,
    `#v1/${CID}?k=${KEY}&p=4`,
    `#v1/${CID}&p=4`,
    `#v1/${CID}&k=${KEY.replace('fak1_', 'fak2_')}`,
    `#v1/${CID}&k=${encodeAccessKey(new Uint8Array(31))}`,
    `#v1/${CID}&k=${encodeAccessKey(new Uint8Array(33))}`,
    `#v1/${CID}&k=${KEY}=`,
    `#v1/${CID}&k=${KEY.slice(0, -1)}+`,
    `#v1/${CID}&k=${KEY.slice(0, -1)}/`,
    `#v1/${CID}&k=${KEY.slice(0, -1)}B`,
    `#v1/${CID}&k=`,
    `#v1/${CID}&k=fak1_`,
    `#v1/${CID}&k=secret`,
    `#v1/${CID}&k=${KEY}&extra=1`,
    `#v1/${CID}&k=${KEY}&k=${KEY}`,
  ])('rejects unsafe or unsupported fragment %j', (hash) => {
    expect(parseFragment(hash)).toBeNull()
  })
})

describe('access key encoding', () => {
  it('matches a known answer', () => {
    expect(encodeAccessKey(KEY_BYTES)).toBe(KEY)
  })

  it('round-trips random keys, with no padding and only base64url characters', () => {
    for (let round = 0; round < 50; round++) {
      const key = crypto.getRandomValues(new Uint8Array(32))
      const text = encodeAccessKey(key)
      expect(text).toMatch(/^fak1_[A-Za-z0-9_-]{43}$/)
      expectSameBytes(decodeAccessKey(text) as Uint8Array, key)
    }
  })
})

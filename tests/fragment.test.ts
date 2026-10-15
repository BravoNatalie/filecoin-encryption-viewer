import { describe, expect, it } from 'vitest'
import { parseFragment } from '../src/fragment.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'

describe('parseFragment', () => {
  it('parses v1/<cid> with and without the leading #', () => {
    expect(parseFragment(`#v1/${CID}`)).toEqual({ cid: CID })
    expect(parseFragment(`v1/${CID}`)).toEqual({ cid: CID })
  })

  it.each([
    '',
    '#',
    '#v1/',
    '#v1/bafy',
    `#cid=${CID}`,
    `#v1/${CID}?p=4,9`,
    `#v1/${CID}?p=4,9&k=fak1_secret`,
    `#v1/${CID}?k=secret`,
    `#v1/${CID}&k=secret`,
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
  ])('rejects unsafe or unsupported fragment %j', (hash) => {
    expect(parseFragment(hash)).toBeNull()
  })
})

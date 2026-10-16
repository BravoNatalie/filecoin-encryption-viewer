import { expect, it } from 'vitest'
import { layout } from '../src/unixfs-car-layout.js'
import type { MetadataNode } from '../src/unixfs-car-layout.js'
import { buildCar, importFiles } from './fixtures/make-share.js'

const bytes = (text: string) => new TextEncoder().encode(text)

// Pins the copied layout code: if filecoin-pin changes the format, these offsets move.
it('places the blocks of a two-file folder at known offsets', async () => {
  const files = [
    { path: 'pins/a.txt', content: bytes('alpha') },
    { path: 'pins/b.txt', content: bytes('beta beta') },
  ]
  const { root, blocks } = await importFiles(files)
  const nodes = new Map<string, MetadataNode>(
    blocks.filter((block) => block.cid.code === 0x70).map((block) => [block.cid.toString(), block])
  )
  const placed = layout(root, nodes)

  expect(placed.header.length).toBe(59)
  expect(placed.metadata.map(({ offset, len }) => [offset, len])).toEqual([
    [59, 89],
    [148, 140],
  ])
  expect([...placed.files].map(([path, file]) => [path, file.size])).toEqual([
    ['pins/a.txt', 5],
    ['pins/b.txt', 9],
  ])
  expect(placed.dirs).toEqual(['pins'])
  expect(placed.leaves.map(({ offset, dataOffset, len }) => [offset, dataOffset, len])).toEqual([
    [288, 325, 5],
    [330, 367, 9],
  ])
  expect(placed.total).toBe(376)
  expect(placed.total).toBe((await buildCar(files)).length)
})

// Builds dev/share.fee the way `filecoin-pin add --encrypt` would, for `pnpm dev`.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { encodeAccessKey } from '../src/fragment.ts'
import { accessKey, delivery, makeShare, plainGrant } from '../tests/fixtures/make-share.ts'
import type { ShareFile } from '../tests/fixtures/make-share.ts'

const DEV_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'

const { positionals } = parseArgs({ allowPositionals: true })
const [input] = positionals
if (!input) {
  console.error('usage: pnpm dev:share <file-or-folder>')
  process.exit(1)
}

const root = resolve(input)
const parent = dirname(root)
const files = (await stat(root)).isDirectory() ? await collect(root) : [await toShareFile(root)]
if (files.length === 0) {
  console.error('nothing to share: the folder has no files')
  process.exit(1)
}

const share = await makeShare(files)
const out = resolve(import.meta.dirname, '../dev/share.fee')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, share)

console.log(`Shared "${basename(root)}" (${files.length} file${files.length === 1 ? '' : 's'}) -> dev/share.fee`)
const key = encodeAccessKey(accessKey())
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
for (const [kind, payload] of [
  ['Plain grant (session-key mode)', await plainGrant()],
  ['Delivery (owner mode, expires in 1 hour)', await delivery()],
] as const) {
  const link = `http://localhost:5173/#v1/${DEV_CID}&d=${b64(payload)}`
  console.log(`\n${kind}`)
  console.log(`  Link:       ${link}`)
  console.log(`  Access key: ${key}`)
  console.log(`  With key:   ${link}&k=${key}`)
}

async function toShareFile(path: string): Promise<ShareFile> {
  return { path: relative(parent, path).split('\\').join('/'), content: new Uint8Array(await readFile(path)) }
}

async function collect(dir: string): Promise<ShareFile[]> {
  const found: ShareFile[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await collect(path)))
    else if (entry.isFile()) found.push(await toShareFile(path))
  }
  return found
}

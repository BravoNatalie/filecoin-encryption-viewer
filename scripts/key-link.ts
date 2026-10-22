// Prints the access key of an envelope (and, with --viewer and --cid, the full one-click link). Dev helper, not in the build.
import { open } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { accessKeyFor } from './access-key.ts'

const HEADER_BYTES = 64 * 1024

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    password: { type: 'string', default: 'dev-password' },
    viewer: { type: 'string' },
    cid: { type: 'string' },
  },
})
const [file] = positionals
if (!file) {
  console.error(
    'usage: pnpm key-link <envelope-file> [--password <pw>] [--viewer <viewer-cid>] [--cid <encryptedRootCid>]'
  )
  process.exit(1)
}

const handle = await open(file)
const header = new Uint8Array(HEADER_BYTES)
const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0)
await handle.close()

const key = await accessKeyFor(header.subarray(0, bytesRead), values.password)
console.log(key)
if (values.viewer && values.cid) {
  console.log(`https://${values.viewer}.ipfs.inbrowser.link/#v1/${values.cid}&k=${key}`)
}

// Fails the build if dev-harness code or a relaxed CSP reached dist/index.html, or if anything besides it was emitted.
import { readFileSync, readdirSync } from 'node:fs'

const CSP = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const csp = (html) => html.match(CSP)?.[1]

const source = csp(read('../index.html'))
const dist = read('../dist/index.html')
const problems = []

if (!source) problems.push('source index.html has no CSP meta')
if (csp(dist) !== source) problems.push(`dist CSP differs from source:\n  dist:   ${csp(dist)}\n  source: ${source}`)
const extra = readdirSync(new URL('../dist/', import.meta.url)).filter((name) => name !== 'index.html')
if (extra.length > 0)
  problems.push(`dist has files besides index.html (the build must be one file): ${extra.join(', ')}`)
for (const marker of ['__dev-share', 'devcap', '[foc-viewer dev]']) {
  if (dist.includes(marker)) problems.push(`dist/index.html contains dev marker "${marker}"`)
}

if (problems.length > 0) {
  console.error(`check-dist FAILED:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log('check-dist OK: one file, CSP identical to source, no dev markers')

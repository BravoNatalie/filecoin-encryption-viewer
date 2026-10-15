import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const DEV_SHARE_PATH = '/__dev-share'
const DEV_SHARE_FILE = resolve(import.meta.dirname, 'dev/share.fee')

// Dev server only: relax the CSP enough for Vite's scripts, HMR and fonts, and serve the local test share.
// apply: 'serve' keeps all of it out of `vite build`; scripts/check-dist.mjs enforces that.
function devHarness(): Plugin {
  return {
    name: 'dev-harness',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /(http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/,
        (_match, open, csp, close) => {
          const extra: Record<string, string> = {
            'script-src': "'self'",
            'font-src': "'self'",
            'img-src': "'self'",
            'connect-src': "'self' ws:",
          }
          const relaxed = Object.entries(extra).reduce(
            (policy, [directive, sources]) => policy.replace(new RegExp(`${directive} `), `${directive} ${sources} `),
            csp
          )
          return `${open}${relaxed}${close}`
        }
      )
    },
    configureServer(server) {
      server.middlewares.use(DEV_SHARE_PATH, async (_req, res) => {
        try {
          const body = await readFile(DEV_SHARE_FILE)
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader('Content-Length', body.length)
          res.end(body)
        } catch {
          res.statusCode = 404
          res.end()
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [viteSingleFile(), devHarness()],
  build: {
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html',
    },
  },
})

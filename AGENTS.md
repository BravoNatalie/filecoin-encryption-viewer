# AGENTS.md

A single-file browser viewer for password-encrypted Filecoin Onchain Cloud shares (`filecoin-pin add --encrypt`). See README.md for the format, behaviour and limits.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build && pnpm exec biome check .
pnpm dev:share <file-or-folder>   # writes dev/share.fee, then: pnpm dev
```

All four checks must pass before work is done. `pnpm build` runs `scripts/check-dist.mjs`, which fails if the built CSP differs from `index.html` or any dev code leaks into `dist/index.html`.

## Layout

- `src/`: one module per concern; README.md "Modules" lists them.
- `tests/`: vitest in the `node` environment. The fixtures in `tests/fixtures/` build real metadata-first shares (`make-share.ts`), serve them with Range (`serve-range.ts`), and fake OPFS and Web Locks (`fake-opfs.ts`).

## Rules

- **The build is one self-contained HTML file.** No external requests except Range requests to `https://*.ipfs.dweb.link`. Don't add dependencies lightly, and keep everything inline.
- **Don't change the CSP** in `index.html` without a reason recorded next to it. `'self'` in `connect-src` is required for Firefox.
- **Security invariants:**
  - every Download link is an `application/octet-stream` blob;
  - typed blobs only for previewable raster images, audio, video and PDF;
  - HTML only in the sandboxed iframe;
  - SVG and XML as text.
- **Range invariants:**
  - every request uses `cache: 'no-store'` and must get a `206`;
  - **never request byte 0** (see `range-source.ts`);
  - cancel the body of any response you throw away.
- **OPFS:**
  - write exactly sized buffers only (`exactBytes`), because WebKit writes a view's whole underlying buffer;
  - never delete a staged file that's locked.
- **Copied files:** `password-key.ts` and `unixfs-car-layout.ts` are copied from filecoin-pin and marked with `ponytail:` notes. Keep them in step with filecoin-pin, and note any deliberate difference in the file header.
- **Tests:** compare large byte arrays with `expectSameBytes` (`tests/fixtures/bytes.ts`), not `toEqual`, which takes seconds per MiB. Give a test its own timeout only when it does real work.
- **Style:** Biome (`biome.json`, line width 120). Small, boring code. Mark deliberate shortcuts with a `ponytail:` comment naming the limit and the upgrade path.
- **Don't commit** `dev/`, `dist/` or local test folders. They're gitignored.

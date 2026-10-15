# foc-viewer

A single-file browser viewer for password-encrypted shares made with `filecoin-pin add --encrypt`. The build output is one self-contained `dist/index.html`, published once to IPFS and opened through [inbrowser.link](https://inbrowser.link). Decryption happens entirely in the recipient's browser. There's no server, no analytics and no storage, and the password never leaves the page.

## Origin

Taken from Jenni's [`packages/foc-viewer`](https://github.com/jennijuju/foc-encryption-demo/tree/7d5119b/packages/foc-viewer) in `jennijuju/foc-encryption-demo` at commit `7d5119b`. The rendering, sandbox, save and folder UI come from there. The archive format and the key handling have been ported to filecoin-pin's encryption format.

## Usage

```text
https://<viewer-cid>.ipfs.inbrowser.link/#v1/<encrypted-root-cid>
```

The fragment carries only the Encrypted root CID. The password is sent to the recipient on a separate channel and typed into the page. A link that carries anything else after `#v1/<cid>`, is rejected with an incomplete-link message.

The viewer fetches `https://<encrypted-root-cid>.ipfs.dweb.link/`. inbrowser.link's service worker intercepts that request and serves it from the storage providers through IPNI, so the viewer only works when opened at an inbrowser.link origin. A share opened before IPNI has caught up shows "not available yet".

## Encryption format

The format is defined by filecoin-pin `add --encrypt`:

```text
outer CAR (public, IPNI)  ── UnixFS file, root = Encrypted root CID
  └─ FEE envelope (chunked scheme, filecoin-encryption-envelope)
       └─ inner CAR, root = a wrapping directory with exactly one entry:
            the shared file, or the shared folder, under its own name
```

- The key is PBKDF2-SHA256 over the password. The envelope's authenticated `appMetadata` is exactly `{ "kdf": "pbkdf2-sha256", "iterations": 600000, "salt": "<base64 of 16 bytes>" }`.
- The viewer validates these fields before deriving anything, and rejects more than 10,000,000 iterations.
- File and folder names exist only inside the ciphertext. The on-chain piece name is `encrypted.fee`.

The key derivation is a copy of filecoin-pin's (`src/common/encryption.ts`). A known-answer test and a shared golden envelope keep the two in step.

## Content rendering

The viewer downloads the share once, decrypts it in memory and lists what's inside. Shares above 256 MiB of plaintext show "Too large for the browser, use `filecoin-pin decrypt`".

| Entry | Rendering |
|---|---|
| Self-contained HTML or text up to 8 MiB | Static markup in an opaque-origin iframe; scripts, handlers, refresh, forms, embedded contexts, anchors, SVG animation and navigation/resource URLs are removed |
| Image, PDF, audio or video up to 64 MiB | Inline browser preview with an explicit download action |
| Any larger entry | Explicit save through the File System Access API on Chromium; other browsers show a compatibility message |

The type is detected from a bounded sniff of the decrypted bytes, never from the file name. A single-file share opens straight into its file. A folder share shows a tree under the folder's real name.

## Development

Requires Node 24 and pnpm 10.7.0 (`packageManager`).

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm typecheck
pnpm build
```

### Test locally

`pnpm dev` alone has nothing to open. Make a local share first, then start the dev server:

```sh
pnpm dev:share ./some-folder   # or a single file; add --password <pw> to change dev-password
pnpm dev
```

Open the printed URL (`http://localhost:5173/#v1/<cid>`). The dev server answers the share request from `dev/share.fee` and relaxes the page CSP for Vite; neither exists in `pnpm build`, which fails if either leaks into `dist/index.html`.

| State | How to trigger |
|---|---|
| Wrong password | Enter anything other than the printed password |
| Not available | Delete `dev/share.fee`, then submit |
| Too large | Add `?devcap=100` (any cap below the share's size) before the `#` (`http://localhost:5173/?devcap=100#v1/<cid>`) |
| Incomplete link | Use any other fragment, for example `#nope` |

The real path (the inbrowser.link service worker fetching `https://<cid>.ipfs.dweb.link/`) can only be tested on the published Viewer.

## Verifiable build

Recipients trust this page with their password, so anyone should be able to check that a Viewer CID was built from this source. The build is reproducible: lockfile, pinned Node and pnpm, and no timestamps in the output.

```sh
git checkout <commit>
pnpm install --frozen-lockfile
pnpm build
filecoin-pin add dist/index.html --dry-run   # prints the root CID without uploading
```

| Commit | Viewer CID |
|---|---|
| _not published yet_ | |

## Modules

1. `fragment.ts` parses `#v1/<cid>` fragments.
2. `password-key.ts` validates the key-derivation metadata and derives the key from the password.
3. `car-archive.ts` fetches the share, decrypts the envelope, reads the inner CAR and lists its single entry.
4. `decrypt.ts` bounds inline entry collection.
5. `sandbox.ts` creates the locked HTML iframe.
6. `save.ts` streams large entries to Chromium without a whole-file Blob.
7. `render.ts` renders bounded content.
8. `ui.ts` owns the password prompt and retry, the folder tree, and the save, too-large and not-available states.
9. `main.ts` connects the link, password, archive, entry and renderer paths.

## Credits

- Fonts: Funnel Sans (body) and Aspekta (headings), under the SIL Open Font License 1.1. See `assets/fonts/OFL.txt`.
- The Filecoin Onchain Cloud logo icon, the colour tokens and the Filecoin ƒ mark (adapted from `filecoin-logo.svg`) come from [filecoin-pay-explorer](https://github.com/FilOzone/filecoin-pay-explorer).

## License

MIT

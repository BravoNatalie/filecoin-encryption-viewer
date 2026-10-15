<p align="center">
  <img src="assets/secure-sharing-hero.webp" alt="Secure sharing" width="280" />
</p>

<h1 align="center">foc-viewer</h1>

<p align="center">
  Open password-encrypted Filecoin Onchain Cloud shares in your browser. Decryption never leaves the page.
</p>

<p align="center">
  <a href="#usage">Usage</a> ·
  <a href="#test-locally">Test locally</a> ·
  <a href="#verifiable-build">Verifiable build</a> ·
  <a href="#credits">Credits</a>
</p>

A single-file browser viewer for password-encrypted shares made with `filecoin-pin add --encrypt`. The build output is one self-contained `dist/index.html`, published once to IPFS and opened through [inbrowser.link](https://inbrowser.link). Decryption happens entirely in the recipient's browser. There's no server, no analytics and no storage, and the password never leaves the page.

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/unlock-dark.png" />
        <img src="docs/screenshots/unlock.png" alt="Password prompt" width="420" />
      </picture>
      <br />
      <sub>The password prompt</sub>
    </td>
    <td align="center" width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/files-dark.png" />
        <img src="docs/screenshots/files.png" alt="Shared folder" width="420" />
      </picture>
      <br />
      <sub>A shared folder, with "Download all"</sub>
    </td>
  </tr>
</table>

## Origin

Taken from Jenni's [`packages/foc-viewer`](https://github.com/jennijuju/foc-encryption-demo/tree/7d5119b/packages/foc-viewer) in `jennijuju/foc-encryption-demo` at commit `7d5119b`. The rendering, sandbox, save and folder UI come from there. The archive format and the key handling have been ported to filecoin-pin's encryption format.

## Usage

```text
https://<viewer-cid>.ipfs.inbrowser.link/#v1/<encrypted-root-cid>
```

The fragment carries only the Encrypted root CID. The password is sent to the recipient on a separate channel and typed into the page. A link that carries anything else after `#v1/<cid>` is rejected with an incomplete-link message.

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

- **Single file:** opens straight into its file.
- **Folder:** shown as a tree under the folder's real name, with sizes. Folders open and close natively, and folders at depth 2 or shallower start open.
- **"← All files":** every file view of a folder share has this button. It returns to the tree from the already-open archive, with no new fetch and no new decryption, and remembers which folders were open.
- **"Download all":** builds a ZIP of the whole folder in the browser from the open archive (no re-decryption) and downloads it as `<folder>.zip`.
- **File views:** each starts with the file name, a type label and the size ("PDF document · 4.9 KB"), then the preview, then a Download button.

| Entry | Rendering |
|---|---|
| Self-contained HTML or text up to 8 MiB | HTML: static markup in an opaque-origin iframe; scripts, handlers, refresh, forms, embedded contexts, anchors, SVG animation and navigation/resource URLs are removed. Text: shown as plain text |
| Image, audio or video up to 64 MiB | Inline browser preview with a Download button |
| PDF up to 64 MiB | Download button; the inline preview is a known issue (see below) |
| Unknown type | A download card: file name, "Unknown file type · size" and a Download button |
| Any larger entry | A save screen with the type and size. Explicit save through the File System Access API on Chromium; other browsers show a compatibility message |

The type is detected from a bounded sniff of the decrypted bytes, never from the file name.

## Known issues

- PDF inline preview is blocked by the page CSP in Chrome; a fix is pending.

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

Open the printed URL (`http://localhost:5173/#v1/<cid>`). The dev server answers the share request from `dev/share.fee` and relaxes the page CSP for Vite; neither exists in `pnpm build`, which fails if either leaks into `dist/index.html`. In dev, the console also logs `[foc-viewer dev]` timings for each unlock and file open.

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
3. `car-archive.ts` fetches the share, decrypts the envelope, reads the inner CAR and lists its entries.
4. `decrypt.ts` bounds inline entry collection.
5. `sandbox.ts` creates the locked HTML iframe.
6. `save.ts` streams large entries to Chromium without a whole-file Blob.
7. `render.ts` renders bounded content and the file views.
8. `file-type.ts` maps sniffed MIME types to friendly labels, and `format.ts` formats byte sizes.
9. `zip.ts` builds the "Download all" ZIP from the open archive (with [`client-zip`](https://github.com/Touffy/client-zip)).
10. `card-label.ts` manages the label above the card and the tighter card padding on the folder tree screen.
11. `ui.ts` owns the password prompt and retry, the folder tree, and the save, too-large and not-available states.
12. `main.ts` connects the link, password, archive, entry and renderer paths.

## Credits

- Fonts: Funnel Sans (body) and Aspekta (headings), under the SIL Open Font License 1.1. See `assets/fonts/OFL.txt`.

## License

MIT

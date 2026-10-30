# @filen/spellcheck

On-device spellchecking for the Filen apps: [spellbook](https://github.com/helix-editor/spellbook) (Rust, MPL-2.0, a port of Hunspell's algorithms) compiled to WebAssembly, Hunspell dictionaries (18, covering 12 languages), and the worker and page code that run them. Nothing leaves the device.

## Layout

| Path | What |
| --- | --- |
| `crate/` | The Rust crate: `Speller` (safe API, what native bindings wrap) and a C ABI for wasm, no wasm-bindgen. `src/boundary.rs` is the whole boundary in safe Rust (`forbid(unsafe_code)`): the module owns a capped scratch region the caller writes into and an output region it reads from, dictionaries are integer ids never reused, every length and id is checked and answered with an error code. `src/wasm.rs` only forwards the exports; the crate has no `unsafe` block. |
| `rust-toolchain.toml` | The pinned toolchain and the `wasm32-unknown-unknown` target. |
| `scripts/build-wasm.mjs` | `pnpm run build:wasm`: cargo release build, copied to `dist/filen_spellcheck.wasm` (gitignored). |
| `scripts/build-dictionaries.ts` | `pnpm run build:dictionaries [--offline]`: downloads the pinned upstream files (verified), builds the dictionaries into `.dictionaries/` (gitignored) and checks every output against the manifest; `--update` (maintainers) rewrites the manifest and notices. See `dictionaries/README.md`. |
| `dictionaries/` | Committed: `manifest.json` (pinned sources, expected output sizes and SHA-256, licences, holders, modifications) and each dictionary's licence and readme files. The 49 MB of built `.aff`/`.dic` are never committed. |
| `src/engine.ts` | The wasm module from JavaScript (platform-free). |
| `src/worker.ts` | The worker side: loads dictionaries (fetch, gzip inflated straight into wasm memory, SHA-256 verified, Cache Storage), checks and suggests. |
| `src/host.ts` | The page side: verdict cache per dictionary, batched checks in one worker, suggestions in a second worker it terminates when a slow request is superseded or overruns; idle workers end (wasm memory never shrinks). |
| `src/languages.ts` | Language tag (OOXML `w:lang`, BCP 47) to dictionary. |
| `src/userDictionary.ts` | The synced user dictionary's format and merge (last-writer-wins per word). |

Document spelling (which words, which language, the marks, replace / ignore all / add to dictionary) lives in `@filen/office/core/docx/spelling` and talks to a `SpellingChecker`; on web, `packages/filen-web/src/features/spellcheck` implements it with this package and stores the user dictionary at `.filen/office/user-dictionary.v1.json`.

## Building

Needs [rustup](https://rustup.rs). Inside this package cargo uses the toolchain `rust-toolchain.toml` pins, and rustup installs it and the `wasm32-unknown-unknown` target on first use (`rustup toolchain install` does it explicitly). The web app's Vite plugin (`packages/filen-web/vite/spellcheck-assets-plugin.ts`) builds the module and the dictionaries at build start and on the dev server's first request, so `pnpm run build` / `pnpm dev` in filen-web need cargo and, once, network access to raw.githubusercontent.com.

```sh
pnpm run build:wasm   # dist/filen_spellcheck.wasm
pnpm run build:dictionaries   # .dictionaries/ (downloads ~49 MB once; a no-op when built)
pnpm run test:rust    # crate unit tests (host target); every shipped dictionary too once built
pnpm run lint:rust    # rustfmt + clippy, pedantic (host and wasm32)
pnpm run test:miri    # the boundary's tests under Miri (nightly with the miri component; about 20 min, not in CI)
pnpm test             # TypeScript tests (builds the wasm first); shipped-dictionary tests need .dictionaries/
FILEN_SPELLCHECK_DICTIONARIES=1 pnpm test   # also rebuilds the dictionaries from scratch and compares
```

Native mobile bindings (uniffi) are not built yet: they wrap `Speller` and need the iOS and Android targets added to `rust-toolchain.toml`.

# @filen/encoding-detect

Legacy text encoding detection for the Filen apps: [chardetng](https://github.com/hsivonen/chardetng) (Rust, Apache-2.0 OR MIT, Firefox's detector) compiled to WebAssembly. Asked only for bytes that are not Unicode (no BOM, not UTF-16, not UTF-8), it names the legacy codepage they most likely are, from their first MiB. Nothing leaves the device.

## Layout

| Path                     | What                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crate/`                 | The Rust crate: `guess` (safe API) and a C ABI for wasm, no wasm-bindgen. `src/boundary.rs` is the boundary in safe Rust (`forbid(unsafe_code)`): the module owns a 1 MiB scratch region the caller writes into and an output region it reads the encoding's name from; every length is checked and answered with an error code. `src/wasm.rs` only forwards the exports. |
| `rust-toolchain.toml`    | The pinned toolchain and the `wasm32-unknown-unknown` target (the same as @filen/spellcheck's).                                                                                                                                                                                                                                                                           |
| `scripts/build-wasm.mjs` | `pnpm run build:wasm`: cargo release build, copied to `dist/filen_encoding_detect.wasm` (gitignored).                                                                                                                                                                                                                                                                     |
| `src/index.ts`           | The wasm module from JavaScript (platform-free): `EncodingDetector.instantiate(module)`, `guess(bytes, last)`.                                                                                                                                                                                                                                                            |

On web, `packages/filen-web/vite/encoding-detect-plugin.ts` builds and serves the module, and `src/features/preview/lib/encodingGuess.ts` loads it on the first text file that is not Unicode.

## Building

Needs [rustup](https://rustup.rs); cargo uses the toolchain `rust-toolchain.toml` pins.

```sh
pnpm run build:wasm   # dist/filen_encoding_detect.wasm
pnpm run test:rust    # crate unit tests (host target)
pnpm run lint:rust    # rustfmt + clippy, pedantic (host and wasm32)
pnpm test             # TypeScript tests (builds the wasm first)
```

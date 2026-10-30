# filen-ts

The TypeScript side of [Filen](https://filen.io), an end-to-end encrypted cloud storage provider.
This repository holds the web, mobile and desktop apps and the packages they share: common
logic, the office document engines, the spellchecker and the assistant's model evaluation.

Everything below the UI — networking, encryption, authentication, transfer concurrency, retries —
belongs to the Rust SDK ([`filen-rs`](https://github.com/FilenCloudDienste/filen-rs)), consumed as
threaded wasm in the browser, as a native module on React Native and as a Node-API addon on
desktop. None of that is reimplemented in TypeScript, and new code here shouldn't start.

## Packages

| Package                                                 | What it is                                                                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`filen-web`](packages/filen-web)                       | The browser app — Drive, Notes, Chats and the office editors. Vite and React, with the SDK running in a cross-origin-isolated worker.                                                   |
| [`filen-mobile`](packages/filen-mobile)                 | The iOS and Android app. Expo and React Native, plus an iOS File Provider extension and an Android Documents Provider that are built from Rust at prebuild time.                        |
| [`filen-desktop`](packages/filen-desktop)               | The Electron desktop app: the web app plus sync, rclone network drives and, on macOS 14 and later, Filen in Finder (a File Provider extension). Updates installed 3.x clients in place. |
| [`filen-shared`](packages/filen-shared)                 | Logic shared by the apps (drive, notes, chats, assistant tools, link policy, desktop protocol and more). Consumed from the workspace, never published.                                  |
| [`filen-office`](packages/filen-office)                 | Document engines and headless editors (DOCX, spreadsheets, PDF, markdown, code) used by the apps.                                                                                       |
| [`filen-spellcheck`](packages/filen-spellcheck)         | On-device spellchecking: a Rust crate compiled to wasm plus Hunspell dictionaries.                                                                                                      |
| [`filen-assistant-eval`](packages/filen-assistant-eval) | Evaluation harness for the assistant's local models and prompt-injection defences. Not shipped.                                                                                         |

Every package has a README covering the setup it actually needs. The mobile one is not
optional reading: that build wants a Rust toolchain, cargo-ndk, meson/ninja/nasm and the usual
Xcode and Android SDK setup on top of Node.

## Clone

`filen-mobile` pulls in three git submodules — the Rust monorepo and the two provider extensions.
Clone recursively, or its prebuild fails in ways that do not point back here:

```bash
git clone --recursive https://github.com/FilenCloudDienste/filen-ts
```

Already cloned flat:

```bash
git submodule update --init --recursive
```

`filen-desktop` has two of its own, `filen-ios-file-provider/` and `filen-rs/`, the sources of its macOS
File Provider extension. On macOS, `pnpm run dist` builds the extension from them (Xcode, plus the Rust
toolchain filen-rs pins with the `aarch64-apple-darwin` and `x86_64-apple-darwin` targets); set
`FILEN_DESKTOP_FP_APPEX` to a built `FilenFileProvider.appex` to skip that. Without either, the macOS
package fails. Only those two:

```bash
git submodule update --init -- packages/filen-desktop/filen-ios-file-provider packages/filen-desktop/filen-rs
```

## Installing

This is a pnpm workspace. One install at the root covers every package:

```bash
pnpm install
```

Run a package's scripts from its own directory, or from anywhere with a filter:

```bash
cd packages/filen-web && pnpm run dev
pnpm --filter @filen/web run dev
```

Node 24 and pnpm 12 are the floor; `packageManager` in the root `package.json` pins the exact pnpm
version, and pnpm downloads that version itself when the local one differs. `@filen/shared` is
linked from the workspace — a change there is visible to the clients immediately.

## CI

Lint, typecheck and tests (`lint.yml`, `typecheck.yml`, `tests.yml`) run per package on every push
and pull request that touches it (only tests for `filen-assistant-eval`); the web e2e suite runs nightly and on dispatch, and CodeQL on
`main` and weekly.

The mobile builds are the interesting ones. iOS and Android both build on every push to `main`
without publishing, and a `filen-mobile@<version>` tag additionally ships them to TestFlight and
Google Play. The tag is only a trigger — the version that gets built comes from `app.config.ts`,
and a run whose tag disagrees with it fails before building anything.

The web app deploys to staging on every push to `main` that touches it, and to production from a
`filen-web@<version>` tag. Desktop packaging is smoke-tested on every change to it, and a
`filen-desktop@<version>` tag builds, signs and install-tests every platform before publishing to the
update feed.

Both apps' translations are generated in CI from their English source catalogs. Edit the English
strings; never the translated files.

## Security

Please don't open a public issue for a security problem. [SECURITY.md](SECURITY.md) has the
details — reports go to [support.filen.io](https://support.filen.io).

## License

AGPL-3.0. See [LICENSE](LICENSE).

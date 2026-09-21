# filen-ts

The TypeScript side of [Filen](https://filen.io), an end-to-end encrypted cloud storage provider.
This repository holds the web app, the mobile app, the desktop shell, and the small utility
package the three of them share.

Everything below the UI — networking, encryption, authentication, transfer concurrency, retries —
belongs to the Rust SDK ([`filen-rs`](https://github.com/FilenCloudDienste/filen-rs)), consumed as
threaded wasm in the browser and as a native module on React Native. None of that is reimplemented
in TypeScript, and new code here shouldn't start.

## Packages

| Package                                   | What it is                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`filen-web`](packages/filen-web)         | The browser app — Drive, Notes and Chats. Vite and React, with the SDK running in a cross-origin-isolated worker.                                                |
| [`filen-mobile`](packages/filen-mobile)   | The iOS and Android app. Expo and React Native, plus an iOS File Provider extension and an Android Documents Provider that are built from Rust at prebuild time. |
| [`filen-desktop`](packages/filen-desktop) | An Electron shell for the web app. Early scaffolding: the window exists, the wiring does not.                                                                    |
| [`filen-shared`](packages/filen-shared)   | Code shared by the apps — semaphore, serialization, date formatting, note and checklist parsing. Consumed from the workspace, never published.                   |

Each package has a README covering the setup its platform actually needs. The mobile one is not
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

## Installing

This is a pnpm workspace. One install at the root covers all four packages:

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

Lint, typecheck and tests run on every push and pull request that touches `filen-web`,
`filen-mobile` or `filen-shared`; CodeQL runs on `main` and weekly.

The mobile builds are the interesting ones. iOS and Android both build on every push to `main`
without publishing, and a `filen-mobile@<version>` tag additionally ships them to TestFlight and
Google Play. The tag is only a trigger — the version that gets built comes from `app.config.ts`,
and a run whose tag disagrees with it fails before building anything.

Both apps' translations are generated in CI from their English source catalogs. Edit the English
strings; never the translated files.

## Security

Please don't open a public issue for a security problem. [SECURITY.md](SECURITY.md) has the
details — reports go to [support.filen.io](https://support.filen.io).

## License

AGPL-3.0. See [LICENSE](LICENSE).

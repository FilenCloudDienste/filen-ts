# @filen/desktop

The Filen desktop app (4.x): an Electron shell around the [filen-web](../filen-web) build. On top of the web app it adds sync (the `@filen/sdk-rs` Node-API addon in a utility process), network drives and servers through rclone, and, on macOS 14 and later, Filen in Finder (a File Provider extension). It updates installed 3.x clients in place through the same update feed.

Agent-facing notes (packaging internals, the 3.x migration, signing order) are in [CLAUDE.md](CLAUDE.md).

## Requirements

| Tool  | Version                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------- |
| Node  | >= 24                                                                                           |
| pnpm  | >= 12                                                                                           |
| macOS | Xcode and the Rust toolchain `filen-rs` pins, for the File Provider (see [Building](#building)) |

## Development

Install once at the repo root (`pnpm install`); these run from this directory.

| Command             | Description                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run dev`      | Stage this machine's addons, bundle, then run filen-web's Vite dev server with Electron on top: the page hot-reloads, main and preload need a restart           |
| `pnpm run dev:dist` | Same staging and bundle, then Electron serving the built `../filen-web/dist` (or `FILEN_DESKTOP_WEB_DIST`) with the deployment's headers. Build filen-web first |
| `pnpm run build`    | Bundle main, preload and the native host into `dist/` (esbuild)                                                                                                 |

## Building

`pnpm run dist` packages the app for the host OS into `release/` (extra arguments go to electron-builder, e.g. `pnpm run dist -- --mac dir`). It needs a filen-web build and never publishes.

On macOS the package includes the File Provider extension, built from the `filen-ios-file-provider/` and `filen-rs/` submodules with Xcode and the Rust toolchain `filen-rs` pins (`aarch64-apple-darwin` and `x86_64-apple-darwin` targets):

```bash
git submodule update --init -- packages/filen-desktop/filen-ios-file-provider packages/filen-desktop/filen-rs
```

Set `FILEN_DESKTOP_FP_APPEX` to an already built `FilenFileProvider.appex` to skip that build. Without the submodules or the override, the macOS package fails.

## Verify

| Command              | Description                                         |
| -------------------- | --------------------------------------------------- |
| `pnpm run lint`      | ESLint plus a Prettier format check                 |
| `pnpm run typecheck` | `tsc -b --noEmit` over the solution `tsconfig.json` |
| `pnpm test`          | Unit tests (Vitest, `src/tests/*.test.ts`)          |
| `pnpm run verify`    | All three, as CI runs them                          |

## Release

A `filen-desktop@<version>` tag matching `package.json`'s version runs [`release-desktop.yml`](../../.github/workflows/release-desktop.yml): signed builds for every platform, install tests, then the update feed. [`build-desktop.yml`](../../.github/workflows/build-desktop.yml) packs an unsigned Linux build on every change.

## Layout

| Path                   | What                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/`            | Electron main: window, tray, menu, updater, session vault, app lock, 3.x migration, `mounts/` (rclone), `sync/`, `fileProvider/` |
| `src/native/`          | The native host: a utility process running the sync engine on the sdk-rs addon                                                   |
| `src/preload/`         | The preload exposing `window.desktop`; its contract is `@filen/shared/desktop`                                                   |
| `src/shared/`          | IPC channel names and the main ↔ native-host protocol                                                                            |
| `native/fileProvider/` | Swift Node-API addon for the File Provider                                                                                       |
| `scripts/`             | Build, dev, staging, packaging and update-feed scripts; `scripts/ci/` holds the install tests                                    |
| `electron-builder.ts`  | Packaging config                                                                                                                 |

The renderer is filen-web itself; desktop-only UI lives there behind `window.desktop`.

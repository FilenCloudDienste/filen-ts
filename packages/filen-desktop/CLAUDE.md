# filen-desktop

The Filen desktop app (4.x): Electron 45 around the filen-web build, plus sync (the `@filen/sdk-rs` Node-API addon in a utility process), rclone network drives and, on macOS 14 and later, Filen in Finder (a File Provider extension). It replaces the 3.x client in place through the same update feed.

## Commands

| Command                                                                     | What it does                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run dev`                                                              | Stages this machine's sync addon (`scripts/stageNapi.ts --dev`) and File Provider addon (`scripts/buildFpAddon.ts --dev`), bundles, then `scripts/dev.ts`: filen-web's Vite dev server plus Electron proxying to it, so the page hot-reloads. Main, preload and native host do not; restart for those. |
| `pnpm run dev:dist`                                                         | Same staging and bundle, then Electron serving the built `../filen-web/dist` (or `FILEN_DESKTOP_WEB_DIST`) with the deployment's headers, CSP included. Build filen-web first.                                                                                                                         |
| `pnpm run build`                                                            | esbuild bundles into `dist/`: `main.js`, `native.js` (ESM) and `preload.cjs` (the sandboxed preload cannot load ESM).                                                                                                                                                                                  |
| `pnpm run dist`                                                             | Full package for the host OS into `release/` (`scripts/dist.ts`); extra args go to electron-builder (`pnpm run dist -- --mac dir`). Needs a filen-web build. Never publishes.                                                                                                                          |
| `pnpm run verify`                                                           | `lint` (eslint + prettier) → `typecheck` (`tsc -b --noEmit`; never a bare `tsc --noEmit`, `tsconfig.json` is a solution file) → `test` (vitest, `src/tests/*.test.ts`).                                                                                                                                |
| `node scripts/checkPackage.ts <mac\|win\|linux> <x64\|arm64>... [--signed]` | Checks the unpacked apps in `release/` (web build, addons, rclone, File Provider extension, update config, signatures with `--signed`). CI runs it after every package.                                                                                                                                |

## Layout

```
src/main/       Electron main: window, tray, menu, updater, session vault, app lock, 3.x migration,
                mounts/ (rclone), fileProvider/ (Filen in Finder), sync/, native/ (supervises the native host)
src/native/     the native host: utility process running the sync engine on the sdk-rs addon
src/preload/    the preload exposing `window.desktop`; the contract is `@filen/shared/desktop`
src/shared/     IPC channel names and the main ↔ native-host protocol
native/fileProvider/  Swift Node-API addon for the File Provider (built per arch to build/native/mac-<arch>/filen-fp.node)
scripts/        build, dev, staging, packaging, feed and package checks; scripts/ci/ holds the e2e tests (e2e.ts)
electron-builder.ts   packaging config; everything 3.x clients can observe (appId, names, feed URL) is frozen
```

The renderer is filen-web itself; desktop-only UI lives there behind `window.desktop`.

## Gotchas

- Unpackaged runs are named "Filen Dev" with userData `@filen/desktop-dev`, so they get their own safeStorage keychain/keyring entry ("Filen Dev Safe Storage") and never touch a real installation (`appIdentity` in `src/main/lifecycle.ts`). Packaged builds keep the 3.x name and userData (`Filen`, `@filen/desktop`) for the migration and the keychain.
- 3.x migration: on first run `src/main/migration.ts` imports the old client's session, PIN, preferences and mounts (`legacyData.ts`, `legacyOrigin.ts`, `mounts/legacyMounts.ts`), then wipes the old secrets; a marker file in userData records progress. `desktop-e2e.yml` tests the real 3.0.53 → 4.x update path.
- Submodules `filen-ios-file-provider/` and `filen-rs/` are the sources of the macOS File Provider extension; they are other repositories, never edit them here. On macOS, `pnpm run dist` builds the extension from them (`scripts/buildFileProvider.ts`: `build-rust.sh --macos`, then the `FilenFileProviderMac` Xcode target; skipped while both are clean at the last-built commits). Set `FILEN_DESKTOP_FP_APPEX` to a built `FilenFileProvider.appex` to skip that; without either, a macOS package fails in `beforePack`.
- The extension is copied into `Contents/PlugIns` in `afterPack` but signed in the custom `mac.sign` (`signMac`, `scripts/fileProviderAppex.ts`): the Electron fuses step runs after `afterPack` and re-signs the whole bundle, so signing there would be lost. The extension is signed first with its own entitlements, then the app.
- `scripts/stageNapi.ts` copies the sync addon from `@filen/sdk-rs`'s platform packages (or `FILEN_DESKTOP_NAPI_DIR`, a filen-rs `build:napi` output); `FILEN_DESKTOP_NAPI` overrides it in development. rclone is staged by `scripts/stageRclone.ts` (pinned in `build/rclone/versions.json`); in development mounts need that staged copy or `FILEN_DESKTOP_RCLONE`.
- Releases: a `filen-desktop@<version>` tag matching `package.json` runs `release-desktop.yml` (signed builds, feed checks, e2e tests, CDN feed). `build-desktop.yml` packs an unsigned Linux directory on every change. `desktop-e2e.yml` also runs every night (macOS Developer-ID signed, Windows unsigned, nothing notarized) and by hand.
- `scripts/ci/` installs, resets and uninstalls the real app (`Target.reset()` deletes Filen's userData): it refuses to run outside GitHub Actions unless `FILEN_E2E_DISPOSABLE_MACHINE=destroy-filen-data` is set on a machine without Filen. Never run it on a development machine.

# filen-mobile

Encrypted cloud storage mobile app: Expo 58 / React Native 0.88 (bridgeless, new architecture, built from source) / React 19.3 / Hermes V1.
All server communication, encryption and auth go through the Rust SDK (`@filen/sdk-rs`, exact pin in `package.json`). Setup, toolchain and native build steps: `README.md`.

## Commands

- `pnpm run verify` = `lint` (eslint, max-warnings 0) → `typecheck` (`typecheck.mjs`) → `test` (vitest). Check exit codes.
- `pnpm run start` (Metro, cache cleared), `pnpm run ios` / `pnpm run android` (plus `:device`, `:release` variants). No Expo Go, no EAS.
- `pnpm run prebuild:clean` regenerates `ios/` and `android/` (builds the provider Rust crates; slow). `pnpm run clean` = `.expo/`; `pnpm run superclean` (`clean.ts --deep`) also wipes DerivedData and `~/.gradle/`.
- Ask before running a native build or prebuild.

## Build gotchas

- **Never start Metro with `CI` set** (`CI=1`): Expo disables file watching and edits never reach the app.
- **Shell locale with a region modifier** (`LANG=en_US@rg=…`): CocoaPods fails in prebuild's `pod install`; prefix `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`. The Gradle JVM is pinned to UTF-8 by `plugins/withGradleMemory.ts` (`-Dfile.encoding=UTF-8`); run `./gradlew --stop` after a locale change.
- **Hermes unzip**: `gradle/hermes-unzip.init.gradle.kts` strips the `meta-hermes-<sha>/` prefix GitHub now serves Hermes tarballs under. CI passes it with `-I`; locally put it in `~/.gradle/init.d/`. Temporary: drop it once react-native ships facebook/react-native#59589.
- Prebuild needs Rust (targets on the nightly `filen-rs/rust-toolchain.toml` pins), cargo-ndk 4.x (CI pins 4.1.2; filen-rs `heif-decoder` reads its `ANDROID_ABI`) and meson + ninja (+ nasm for the x86_64 Android slice). The Android workflows install all three tools, the iOS ones meson + ninja.

## Architecture

Feature-based layout: `src/features/<feature>/` owns each product domain end to end. `src/routes/` (expo-router) is thin; `src/components/`, `src/lib/`, `src/stores/`, `src/queries/`, `src/hooks/` are shared/infra only.

```
Entry:  src/entry.ts → expo-router (root ./src/routes)
Setup:  src/global.ts (polyfills from src/lib/polyfills/, console→logger tee, global error + rejection capture)
        src/lib/setup.ts (auth check → transfer config + thumbnails restore → SDK clients, secureStore,
        sqlite, restoreQueries, i18n, theme in parallel → warm-seed drive caches)
State:  Zustand (feature store/ + src/stores/)          → UI state
        TanStack Query (feature queries/ + src/queries/) → server data, persisted to the SQLite kv
        src/lib/secureStore.ts                            → encrypted secrets (expo-secure-store + MMKV fallback)
        src/lib/events.ts                                 → typed EventEmitter for transient cross-component events
SDK:    src/lib/auth.ts (authed + unauthed clients), src/lib/sdkUnwrap.ts (unwrapDirMeta/unwrapFileMeta),
        src/lib/signals.ts (wrapAbortSignalForSdk, composite/pause signals), src/lib/sdkErrors.ts
```

A feature contains as needed: `screens/` · `components/` · `hooks/` · `queries/` (`useX.query.ts`) · `store/` (`useX.store.ts`) · `<feature>.ts` lib singleton(s) · `socketHandlers.ts` · `utils.ts` · `constants.ts` · `types.ts`.

- `drive`: File browser, item ops and context variants (favorites/recents/trash/links/sharedIn/sharedOut/offline/linked), select, item info, versions. `drive.ts` is a facade over `driveTrash`, `driveDirectory`, `driveMetadata`, `driveShare`, `drivePublicLink`; search in `driveSearch.ts`, downloads in `driveDownload.ts`.
- `copy`: SDK copy jobs with progress and cancel (`copyRunner.ts`, `store/useCopyJobs.store.ts`).
- `photos`: Photo timeline grid (1–5 columns, `photosGridTiles.ts`) and bulk actions.
- `notes`: CRUD, content, tags, participants, history, export, offline notes (`notesOffline.ts`), in-flight sync.
- `chats`: Messages, typing, read state, chat lifecycle, in-flight message sync, unread counts.
- `contacts`: Requests, block/unblock, delete, programmatic contact selection (`contactsSelect.ts`).
- `audio`: Playback queue (loop `none`/`track`/`queue`), metadata and cover cache (`audioCache.ts`), playlists.
- `cameraUpload`: Media auto-upload, background task, dedup ledger (`cameraUploadState.ts`, MD5-based), album picker, error surface.
- `transfers`: Uploads/downloads with pause/resume/abort (`transfers.ts`, `transferCore.ts`), Android foreground service (react-native-notify-kit).
- `offline`: Offline file store and sync (`offline.ts`, `offlineSync.ts`).
- `events`: Account activity log + detail.
- `publicLink`: Public link preview.
- `incomingShare`: OS share-sheet target + intent handler.
- `settings`: More tab and all settings screens; File/Documents Provider bridge (`fileProvider.ts`, `authFileKey.ts`), biometric, privacy screen, start screen, transfer config, diagnostics.
- `auth`: Login and register screens. The SDK client lifecycle is infra (`src/lib/auth.ts`).

`socketHandlers.ts` exist for drive, chats, notes and contacts; `src/components/shell/socket.tsx` owns the connection and dispatches to them.

## Conventions

- **Per-file hooks**: `useX.query.ts` / `useX.store.ts` in the owning feature's `queries/` / `store/`, never consolidated.
- **No barrels**: `index.tsx` may be a directory's main component; no `index.ts` re-export aggregators.
- **Screen entry**: `screen.tsx` or `screens/<name>.tsx`; some routes render `@/features/<x>/components` (its `index.tsx`).
- **Imports**: `@/` aliases only (relative imports are a lint error); cross-feature imports use full `@/features/...` paths.
- **Silent libs**: infra and feature lib singletons expose state and leave alerts/toasts to UI (drive ops still raise some errors themselves).
- **Singletons**: services with mutable runtime state are class singletons (`const x = new X(); export default x`, the constructor is the test isolation seam); stateless namespaces are plain objects or module functions. Prefer the latter for new code unless state is held.
- **Project decisions override the generic Expo skills**: no Expo Go, no EAS; icons from `@expo/vector-icons`; no expo-blur (crashes Android nested in its BlurTargetView); storage via `src/lib/sqlite.ts` kv + `src/lib/secureStore.ts`; no reanimated `entering`/`exiting` inside FlashList rows.
- Style: no semicolons, double quotes, tabs, no trailing commas; avoid non-null `!` (convention, not lint-enforced).

### ESLint guardrails (`eslint.config.mjs`)

- Store hooks need a selector: a bare `useXStore()` is an error.
- Navigation via `import { router } from "@/lib/router"` (dedupes double-fired navigation); never `router`/`useRouter` from expo-router.
- Document picking via `@/lib/documentPicker`; never `expo-document-picker` directly.
- No `crypto.randomUUID` (Hermes lacks it; use expo-crypto).
- No `export *` inside `src/features/`. Files under `src/routes/` may not import feature `store`/`queries` (`_layout.tsx` and `+native-intent.ts` exempt).
- `react-hooks/preserve-manual-memoization` and `react-hooks/hooks` are errors (React Compiler is on).
- Ignored: `plugins/`, `scripts/`, `src/tests/`, native dirs and the submodules, so `typecheck` is the only static gate there.

### i18n

- Only edit the English source `src/locales/en/*.ts` (typed; `t()` rejects unregistered keys at compile time).
- Never hand-edit `src/locales/<lang>.json` (27 catalogs) or `src/locales/.en-snapshot.json`: CI (`i18n-translate.yml` → `scripts/translate-i18n.ts`, see `scripts/README.md`) fills them and advances the snapshot.
- The `authCatalog` test diffs catalogs against the snapshot, not live `en`, so a new English key is green locally. Plural keys (`_one`/`_other`) are registered in `INTENTIONAL_PLURAL_KEYS` (`src/tests/authCatalog.test.ts`).

## Submodules and native code

Git submodules under this package; other repositories, never edit them here:

- `filen-rs/`: Rust monorepo, source of `@filen/sdk-rs` and of `filen-mobile-native-cache`, the crate both provider extensions build against.
- `filen-ios-file-provider/`: Swift iOS File Provider extension. `plugins/withFileProvider.ts` builds the Rust xcframework, adds the extension target and copies the provider's `NSExtensionFileProviderActions` / `NSExtensionFileProviderAllowsUserControlledEviction` from its own `FilenFileProviderExtension/Info.plist` (the single source).
- `filen-android-documents-provider/`: Kotlin Documents Provider. `plugins/withAndroidRustBuild.ts` builds the `.so` files with cargo-ndk, generates uniffi Kotlin bindings, copies `FilenDocumentsProvider.kt` and `AuthKeystore.kt` into `io/filen/app/` and injects the `<provider>`. Its targets and `buildArchs` share `ANDROID_ABIS` in `app.config.ts`.

Other plugins in `plugins/`: `withBlake3SymbolRename.ts` (renames the BLAKE3 C reference symbol in the `FileHash` and `QuickCrypto` pods so it doesn't collide with sdk-rs's Rust `blake3` at link time), `withGradleMemory.ts`, `withAndroidSigning.ts` (reads `../credentials.json`), `withAndroidDebugSuffix.ts` (`.debug` application id), `withAndroidLocaleConfig.ts` (from `SUPPORTED_LANGUAGES`), `withAndroidApplicationAttributes.ts`, `withAndroidNetworkSecurityConfig.ts`. Local Expo modules live in `modules/` (`file-provider-domain`, `filen-auth-key`, `filen-exif`).

`src/features/settings/fileProvider.ts` writes the sealed `auth.json` both extensions read (iOS app group container, Android `filesDir`), with config from `authedSdkClient.toSdkConfig()`; `modules/file-provider-domain/README.md` covers the iOS domain contract.

Versions, SDK levels, deployment target, permissions and the plugin list are in `app.config.ts`; read it rather than trusting a copy.

## Navigation

`src/routes/` mirrors the URL tree. Screen routes are one-line re-exports (`export { default } from "@/features/<feature>/screens/<name>"`) or small wrappers; real logic lives only in `_layout.tsx` files, `+native-intent.ts` (deep links) and the start-screen redirects (`index.tsx`, `tabs/index.tsx`). Five native tabs (`expo-router/native-tabs`, definitions in `src/components/shell/tabs.ts`): drive, photos, notes, chats, more. Modal routes are `MODAL_SCREEN_NAMES` in `src/routes/_layout.tsx`. Route params are packed with the JSON serializer; programmatic selection (`selectDriveItems`, `selectContacts`) is event-driven.

## Key directories

```
src/features/         product domains (above)
src/routes/           expo-router tree
src/components/       shared UI: ui/ primitives (ListRow, Header, Menu, VirtualList (FlashList), settingsGroup, …),
                      drivePreview/, textEditor/ (CodeMirror + Quill DOM editors), pdfPreview/ and docxPreview/
                      (Expo DOM components), floatingBar/, itemIcons/, shell/, plus root-mounted shell components
                      (http, biometric, privacyScreen, offlineBanner, accountReminders, pathname)
src/lib/              infra modules (below); src/lib/polyfills/
src/hooks/  src/stores/  src/queries/   shared hooks, shell stores, file-access queries + query client
src/providers/        style (Uniwind theme) and action sheet providers
src/locales/          i18n catalogs
src/tests/            vitest tests; src/tests/mocks/ shared mock modules
modules/  plugins/  scripts/            local Expo modules, config plugins, scripts (scripts/README.md)
```

## Infra invariants (`src/lib/`)

- **Storage paths**: only `storageRoots.ts` constructs cache/offline/tmp/log paths. Plain-file areas anchor on the iOS app-group base; SQLite (`sqlite.db`, SDK cache) lives in the private sandbox (a lock held in the shared container at suspension is a 0xdead10cc kill). Pre-relocation DBs are deliberately abandoned in place.
- **SQLite** (`sqlite.ts`): single WITHOUT ROWID `kv` table for the query cache, camera-upload ledger and file-kind verdicts; WAL; single-process invariant (see `initQueries`). No AppState checkpoint hook: checkpointing at backgrounding races suspension.
- **Session caches** (`cache.ts`): plain Maps of uuid → DriveItem and SDK views, rebuilt per process; never mirrored to SQLite (decrypted metadata stays in memory).
- **Query persistence** (`src/queries/client.ts`): batched 1 s trailing debounce, rows over 1 MB at most every 30 s, full flush on background. `UNCACHED_QUERY_KEYS` lists what is never persisted.
- **Thumbnails** (`thumbnails*.ts`): every image thumbnail is an SDK decode (`thumbnailsSdk.ts`, box and quality constants there), not behind the semaphore; video (`thumbnailsVideo.ts`) is the only JS/expo path and the only one behind `Semaphore(MAX_CONCURRENT)`. Eligibility is one answer: `getThumbnailKind` in `thumbnailsHelpers.ts`.
- **Preview type**: `previewType.ts` `getPreviewType` is the one displayability classifier (over `@filen/shared` `resolveFileKind`); content verdicts for ambiguous containers come from `fileKindVerdicts.ts` (rows shared in shape with web via `@filen/shared`). RAW camera files (`SDK_RAW_PREVIEW_EXTENSIONS`) preview via the JPEG the SDK extracts (`rawPreviewCache.ts`), never as an expo-image input.
- **Logger** (`logger.ts`): async on-disk NDJSON; a log call must never throw. Prod persists warn/error, debug/info are an in-memory breadcrumb ring. No redaction layer by design (decrypted names/paths are kept; the user is warned at export). `purge()` at logout. babel strips `console.log/info/debug/trace` in production but keeps warn/error for the tee (`babel.config.js`); the WebView console comes back via `src/hooks/useDomEvents/domConsoleProxy.ts`. Viewer: `logViewer` route.
- **Online state**: `useIsOnline` (bridged to TanStack `onlineManager` by `src/queries/onlineStatus.ts`); never read NetInfo in components. `reconnect.ts` kicks camera upload, offline sync, notes/chats sync and offline notes on every offline→online flip.
- **Root overlays**: any new global side-effect gates on `useAppStore.biometricUnlocked === true` AND AppState `active` (biometric lock and `privacyScreen.tsx` paint above everything).
- `utils.ts` holds few helpers; check `@filen/shared` (sanitizeFileName, contact names, sorting, file kinds, …) before adding one.

## SDK integration

The RN app runs the uniffi bindings (`node_modules/@filen/sdk-rs/src/generated/filen_sdk_rs.ts`); the root `sdk-rs.d.ts` is filen-web's wasm surface. Verify API claims against the generated `.ts`.

```typescript
const { authedSdkClient } = await auth.getSdkClients()
const signal = wrapAbortSignalForSdk(abortController.signal) // src/lib/signals.ts
const unwrapped = unwrapDirMeta(dir) // src/lib/sdkUnwrap.ts; variants carry meta, uuid, undecryptable, shared/root
const item = unwrappedDirIntoDriveItem(unwrapped)
normalizeFilePathForSdk(path) // src/lib/paths.ts; also ForExpo / ForBlobUtil
const sdkError = unwrapSdkError(error) // FilenSdkError | null
const getFileUrl = useHttpStore(s => s.getFileUrl) // nullable until the HTTP provider runs
```

`DriveItem` (`src/types.ts`) is a `{ type, data }` union of directory, file, sharedDirectory, sharedRootDirectory, sharedFile and sharedRootFile.

## Testing

- Vitest, node environment, `src/tests/*.test.ts` (`.tsx` when rendering). Hook/store-render tests start with `// @vitest-environment happy-dom` and use `@testing-library/react`.
- `vitest.config.ts` aliases `react-native` (`src/tests/mocks/reactNative.ts`), `expo-file-system`, `@/modules/filen-exif` and `uniffi-bindgen-react-native` to mocks, and stubs `require("….svg")`. Other modules are mocked per file with `vi.mock`, whose factories may reuse `src/tests/mocks/*`.
- Lib-singleton tests follow `chats.test.ts`: `vi.hoisted` mocks, `vi.mock("@/lib/auth")`, `vi.mock("@filen/sdk-rs", ...)` enum stubs; tests never call the SDK.
- `@/components/ui/view` pulls native deps esbuild can't transform; `vi.mock` it when a tested module imports it.
- `vitest run` strips types, so a green test can still fail `typecheck`.

## Patches

`patchedDependencies` in the root `pnpm-workspace.yaml`, files in the root `patches/`; edit with `pnpm patch <name>@<version>` + `pnpm patch-commit`. A stale patch fails `pnpm install`. JS-level hunks (dom-webview, expo-file-system) must patch `build/*.js`: Metro never resolves the packages' `src/`. Why each patch exists, and when it can be dropped, is the comment above its entry in `patchedDependencies`.

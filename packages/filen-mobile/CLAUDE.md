# filen-mobile

Encrypted cloud storage mobile app — Expo 56 / React Native 0.85.3 (bridgeless/new-arch) / React 19 / Hermes.
All server communication, encryption, and auth handled by Rust SDK (`@filen/sdk-rs@0.4.27`, exact pin).

## Architecture

Feature-based layout: `src/features/<feature>/` owns each product domain end-to-end.
`src/routes/` (expo-router) is thin, `src/components/` is shared-only, `src/lib|stores|queries|hooks/` are infra/shared-only.

```
Entry:  src/entry.ts → expo-router
Setup:  src/global.ts (DOMException/Buffer/crypto polyfills, console→logger tee, global error+rejection capture, NetInfo)
        src/lib/setup.ts (auth check → SDK init → SQLite → restore query cache)

State:  Zustand stores (per feature store/ + shared src/stores/)  → UI-only state (selections, input focus, etc.)
        TanStack Query (per feature queries/ + shared src/queries/) → server data, persisted to SQLite via custom JSON serializer
        Secure Store (src/lib/secureStore.ts) → encrypted secrets (expo-secure-store + MMKV fallback)
        Events (src/lib/events.ts)        → transient cross-component events (EventEmitter3)

SDK:    src/lib/auth.ts manages JsClientInterface (authed) + UnauthJsClientInterface
        src/lib/utils.ts wraps SDK types → unwrapDirMeta(), unwrapFileMeta(), wrapAbortSignalForSdk()

Native: Three git submodules at packages/filen-mobile/, integrated via custom Expo plugins —
        see "Submodules" section below.
```

## Features (src/features/)

14 features, each owning its domain. A feature contains (as needed):
`screens/` (screen bodies) · `components/` · `hooks/` · `queries/` (per-file `useX.query.ts`) ·
`store/` (per-file `useX.store.ts`) · `<feature>.ts` (the feature's lib singleton(s) — silent, no UI) ·
`socketHandlers.ts` (the feature's slice of socket events) · `utils.ts` (pure helpers) ·
`constants.ts` · `types.ts`.

| Feature         | Owns                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drive`         | File/dir browser, ops (favorite, rename, move, delete, trash, restore, share, search, setDirColor, createDirectory, updateTimestamps), context variants (favorites/recents/trash/links/sharedIn/sharedOut/offline), select/move/copy, item info, versions, color picker, linked file. Lib: `drive.ts`, `driveDownload.ts`; also `driveSortPreference.ts`, `driveSelectors.ts`. Socket: `handleDriveEvent`. |
| `photos`        | Photo grid timeline (5 per row, creationDesc sort), photo bulk actions.                                                                                                                                                                                                                                                                                                                                    |
| `notes`         | CRUD, content editing, tags, participants, history, export (single .txt / bulk .zip via JSZip), in-flight content sync. Lib: `notes.ts`, `notesSelectors.ts`. Socket: `handleNoteEvent`.                                                                                                                                                                                                                   |
| `chats`         | Send/edit/delete messages, typing indicators, mark read, create/leave/delete chats, in-flight message sync, unread counts. Lib: `chats.ts` (Semaphore-protected refetch). Socket: `handleChatEvent`.                                                                                                                                                                                                       |
| `contacts`      | Requests (accept/deny/cancel/send), block/unblock, delete; programmatic contact selection. Lib: `contacts.ts`, `contactsSelect.ts`.                                                                                                                                                                                                                                                                        |
| `audio`         | Audio playback / playlist queue management with loop modes (track/list/off); metadata + cover art cache; playlists screens. Lib: `audio.ts` (singleton).                                                                                                                                                                                                                                                   |
| `cameraUpload`  | Auto media sync, EXIF dates, dedup via xxHash32 (2-iteration collision resolution — append creationTime, then hash(name+creationTime)), same-title album disambiguation, sanitization of `/` in titles/ids, compression, error surface, album picker. Lib: `cameraUpload.ts`, `cameraUploadState.ts` (write-through hash/abort dedup ledger in the SQLite kv). |
| `transfers`     | Upload/download with progress, pause/resume, abort, error tracking, duplicate prevention via active ID sets; floating + full-list UI; Android foreground service. Lib: `transfers.ts`, `foregroundService.ts`.                                                                                                                                                                                             |
| `offline`       | Offline file cache: store, sync, list, index management (FileOrDirectoryOfflineMeta). Lib: `offline.ts`.                                                                                                                                                                                                                                                                                                   |
| `events`        | Account activity log + event detail.                                                                                                                                                                                                                                                                                                                                                                       |
| `publicLink`    | Public link preview screen.                                                                                                                                                                                                                                                                                                                                                                                |
| `incomingShare` | OS share-sheet target + incoming-intent handler.                                                                                                                                                                                                                                                                                                                                                           |
| `settings`      | More tab + account, security (+ biometric/twoFactor), fileProvider (File/Documents Provider toggle), appearance, advanced, fileProvider bridge. Lib: `fileProvider.ts`, `startScreen.ts`.                                                                                                                                                                                                                  |
| `auth`          | Login + register screens. (The SDK client lifecycle lives in `src/lib/auth.ts` — infra, not this feature.)                                                                                                                                                                                                                                                                                                 |

Note: `socketHandlers.ts` exists for `drive`/`chats`/`notes`/`contacts`
(`handleDriveEvent`/`handleChatEvent`/`handleNoteEvent`/`handleContactEvent`); the shell
`socket.tsx` dispatcher delegates to each.

## Conventions

- **Per-file hooks**: query/store hooks keep their `useX.query.ts` / `useX.store.ts` naming, relocated into the owning feature's `queries/` / `store/` — NOT consolidated into one file.
- **No barrels**: `index.tsx` may be a folder's main component, but there are NO barrel `index.ts` re-export aggregators. Import the specific module directly.
- **Screen entry**: a feature screen entry is `screen.tsx` (single-screen features) or `screens/<name>.tsx`.
- **Cross-feature imports** use full `@/features/...` paths. Relative imports are forbidden repo-wide (ESLint).
- **Silent feature libs**: a feature's `<feature>.ts` singleton(s) expose state and never fire alerts/toasts — UI owns UX.

### i18n / localization workflow

- **Only ever edit the English source**: add/change user-facing strings in `src/locales/en/*.ts` (real keys, merged into `typeof en`; `t()` rejects unregistered keys at compile time).
- **NEVER hand-edit the translated catalogs** `src/locales/<lang>.json` (25 languages) or `src/locales/.en-snapshot.json`. Translation runs in **CI** (`scripts/translate-i18n.ts`, DELTA mode vs the snapshot via the Anthropic API), which fills the locale JSONs and advances the snapshot. Manually adding/placeholdering locale keys (or bumping the snapshot) corrupts that pipeline.
- The `authCatalog` completeness test diffs the locale JSONs against `.en-snapshot.json` (the keys already translated), NOT the live `en` catalog — so adding an English key is **green locally** (CI then fills the locales + advances the snapshot). Never hand-edit the JSONs or snapshot to "fix" i18n.
- Plural keys (`_one`/`_other`) still get registered in `src/tests/authCatalog.test.ts` `INTENTIONAL_PLURAL_KEYS`.

### ESLint guardrails (eslint.config.mjs)

- **Selector-required store hooks**: a bare `useXStore()` (zero args) is an error — must pass a selector (`useXStore(s => s.foo)` or `useShallow(...)`). Project-wide.
- **No feature barrels**: `export * from ...` is banned inside `src/features/`.
- **Thin routes**: files under `src/routes/` may not import `@/features/*/store` or `@/features/*/queries` (logic belongs in the feature's screen/hook). `_layout.tsx` and `+native-intent.ts` are exempt.
- **No relative imports** (existing rule) enforces the `@/features/...` cross-feature import style.

## Submodules

Three git submodules live directly under `packages/filen-mobile/` (pinned SHAs in repo-root `.gitmodules`):

| Submodule                           | Role                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filen-rs/`                         | Rust monorepo. Source of the npm-shipped `@filen/sdk-rs` AND of `filen-mobile-native-cache` — a separate crate the iOS File Provider Extension and Android Documents Provider build against.                                                                                                                                      |
| `filen-ios-file-provider/`          | Swift source for the iOS File Provider Extension. `withFileProvider.ts` plugin copies these files into the prebuilt Xcode project + builds the Rust xcframework + wires up the extension target.                                                                                                                                  |
| `filen-android-documents-provider/` | Kotlin source for the Android Documents Provider (`io.filen.app.FilenDocumentsProvider`). `withAndroidRustBuild.ts` plugin builds the `.so` files via cargo-ndk, generates uniffi Kotlin bindings, copies the Kotlin class into `app/src/main/java/io/filen/app/`, and injects the `<provider>` element into AndroidManifest.xml. |

Building the native cache requires **cargo-ndk 4.x** — as of filen-rs `d454f4d` (`heif-decoder/build.rs`) the build reads cargo-ndk 4.x's `ANDROID_ABI` env var; the previously-pinned 3.5.4 sets the old `CARGO_NDK_ANDROID_TARGET` and no longer propagates the heif-decoder ABI (this reverses the earlier bbqsrc/cargo-ndk#181 workaround).

`src/features/settings/fileProvider.ts` is the TS bridge that writes `auth.json` to the shared location both extensions read from (iOS app group container; Android `filesDir`). Mirrored boolean state lives in secureStore under `FILE_PROVIDER_ENABLED_SECURE_STORE_KEY` for fast reactive UI reads.

`auth.json`'s SDK config (`masterKeys`, `publicKey`, `apiKey`, `privateKey`, etc.) is populated from `authedSdkClient.toSdkConfig()` since SDK 0.4.21 exposes the full shape. The extensions should now resolve `queryRoots()` against a fully-authenticated SDK — pending end-to-end verification on real devices (iOS Files app / Android Documents picker).

## Navigation (expo-router)

`src/routes/` mirrors the URL tree but is THIN: each screen route is a one-line
`export { default } from "@/features/<feature>/screens/<name>"`, or a tiny wrapper that renders
a feature component. The drive context-variant routes (favorites/recents/trash/links/sharedIn/
sharedOut/offline/linkedDir) render `<Drive />` from `@/features/drive`. Only `_layout.tsx` files
(providers + Stack registration) and `+native-intent.ts` (deep-link handling) hold real logic.

5 tabs: drive (`tabs/drive/[uuid]`), photos, notes, chats, more

Modal routes (top-level under `routes/`): `note/[uuid]`, `chat/[uuid]`, `transfers`, `contacts`, `driveItemInfo`,
`driveSelect/[uuid]`, `changeDirectoryColor`, `notesTags`, `trash`, `recents`,
`favorites/[uuid]`, `links/[uuid]`, `sharedIn/[uuid]`, `sharedOut/[uuid]`, `offline/[uuid]`,
`drivePreview` (containedTransparentModal gallery preview), `account`, `security` (+ `/biometric`, `/twoFactor`),
`fileProvider`, `appearance`, `advanced`, `logViewer`, `events` (+ `eventInfo`), `playlists` (+ `[uuid]`), `selectPlaylists`,
`cameraUpload` (+ `/albums`, + `cameraUploadErrors`), `fileVersions`, `publicLink`, `linkedFile`,
`linkedDir/[uuid]`, `incomingShare`, `chatParticipants`, `noteParticipants`, `noteHistory`, `register`.

```
routes/                       ← thin re-exports / wrappers into src/features/
├── _layout.tsx               root Stack + all modal screens (real logic)
├── +native-intent.ts         deep-link handling (real logic)
├── index.tsx                 redirect → auth or drive based on auth state
├── tabs/
│   ├── _layout.tsx           NativeTabs (expo-router/unstable-native-tabs)
│   ├── drive/[uuid].tsx      folder browser  → <Drive /> (features/drive)
│   ├── photos/index.tsx      photo grid       → features/photos screen
│   ├── notes/index.tsx       note list        → features/notes screen
│   ├── chats/index.tsx       chat list        → features/chats screen
│   └── more/index.tsx        settings menu    → features/settings screen
├── auth/, register/          → features/auth screens
├── note/[uuid], chat/[uuid]  → features/notes, features/chats editors
├── drivePreview/             → features/drive (full-screen gallery)
├── driveItemInfo, driveSelect/[uuid], changeDirectoryColor, fileVersions, linkedFile, linkedDir/[uuid]
│                             → features/drive screens / wrappers
├── trash, recents, favorites/[uuid], links/[uuid],
├── sharedIn/[uuid], sharedOut/[uuid], offline/[uuid]
│                             ↑ all render <Drive /> in different contexts
├── notesTags, noteParticipants, noteHistory   → features/notes
├── chatParticipants          → features/chats
├── contacts                  → features/contacts
├── transfers                 → features/transfers
├── playlists/, selectPlaylists  → features/audio
├── cameraUpload/             → features/cameraUpload
├── events/                   → features/events
├── publicLink/               → features/publicLink
├── incomingShare/            → features/incomingShare
├── logViewer/                → features/settings (in-app NDJSON log viewer; pushed from advanced via /logViewer)
└── account, security/, fileProvider/, appearance, advanced  → features/settings
```

Route params are packed with JSON serializer (DriveItem, DrivePath, SelectOptions).
Programmatic selection: `selectDriveItems(options)`, `selectContacts(options)` → event-driven.

## Key Directories

```
src/features/       feature-based product domains (see Features above) — owns screens/components/hooks/queries/store/lib per feature
src/routes/         expo-router tree — thin re-exports into src/features/ (see Navigation above)
src/components/      SHARED, feature-agnostic UI only (see below)
src/stores/         shared/shell-only Zustand stores
src/queries/        shared/infra-only TanStack Query hooks + client setup
src/lib/            infra-only logic modules (see below)
src/lib/polyfills/  DOMException, Buffer, console, crypto polyfills loaded in global.ts
src/hooks/          shared cross-feature custom hooks
src/providers/      Style provider (Tailwind/Uniwind theme), ActionSheet provider
src/assets/         Custom emojis (CDN-backed), app icons, splash images
src/tests/          Vitest tests + mocks for native modules
```

## Shared Components (src/components/)

Feature-agnostic only. Feature-specific UI moved into `src/features/<feature>/components/`.

| Dir / file      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/`           | Base primitives (View, Text, Image, Header, Menu, VirtualList, ZoomableView, Button, Checkbox, …) + `settingsGroup`. See "UI Base" below.                                                                                                                                                                                                                                                                                                    |
| `textEditor/`   | CodeMirror (markdown/code) + Quill (richtext) editors via WebView. Shared by notes.                                                                                                                                                                                                                                                                                                                                                          |
| `drivePreview/` | Pinch-to-dismiss gallery + per-type renderers (image/video/audio/pdf/docx/text).                                                                                                                                                                                                                                                                                                                                                             |
| `itemIcons/`    | `FileIcon` (40+ extension mappings) + `DirectoryIcon` (colored SVG, DirColor enum).                                                                                                                                                                                                                                                                                                                                                          |
| `floatingBar/`  | Bottom bar above tabs: `index` + `audioSlot` + `transfersSlot` + `animatedProgressBar` + `separator`.                                                                                                                                                                                                                                                                                                                                        |
| `participants/` | Shared `participantRow` / `participantList` used by both notes and chats.                                                                                                                                                                                                                                                                                                                                                                    |
| `docxPreview/`  | WebView-based `.docx` renderer.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `shell/`        | App-shell background/overlay components (subscribe to one concern, render no rows). `socket.tsx` keeps the WebSocket connection lifecycle + a dispatcher delegating to per-feature `socketHandlers.ts`. Shell also holds http, biometric, privacyCover, offlineBanner, accountReminders, pathname, dismissStack, cannotDecryptScreen. (foregroundService moved to features/transfers; incomingShareHandler moved to features/incomingShare.) |

## Lib Modules (src/lib/) — infra only

Feature-specific libs (drive/notes/chats/contacts/audio/cameraUpload/offline/transfers/fileProvider/startScreen)
all MOVED into their features. What remains is infrastructure shared across features:

| Module                    | Purpose                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.ts`                 | SDK client init, login/logout, `useIsAuthed()` / `useSdkClients()` / `useStringifiedClient()` hooks. Calls `fileProvider.disable()` + cleanup on logout. (Stays infra — the auth _feature_ is just login/register screens.) |
| `bulkOps.ts`              | Shared bulk-operation helpers (multi-item ops).                                                                                                                                                                             |
| `decryption.ts`           | Shared decryption helpers.                                                                                                                                                                                                  |
| `thumbnails.ts`           | Thumbnail generation: images (ImageManipulator resize) + videos (HTTP provider → expo-video), Semaphore(3) concurrency, max 3 failures per item. Availability is a disk-derived Set (`hasThumbnail`), seeded once at boot by `restore()` and kept coherent by the generate/invalidate/clear paths. |
| `sort.ts`                 | ItemSorter (name/size/mime/date, dirs-first, numeric-aware) + NotesSorter (pinned/archived/time-bucketed groups).                                                                                                           |
| `cache.ts`                | Session-scoped in-memory uuid caches (plain Maps): uuid→DriveItem + the type-derived SDK views (normal/shared-with-context/linked) + chat attachment layouts + **rootUuid**. Rebuilt per process by fetches/mutations and the boot warm-seed from restored listing queries; NO SQLite mirror (decrypted metadata stays in memory). |
| `fileCache.ts`            | File download cache (dedup keyed by `type:data`) with metadata index. Replaces ad-hoc download paths.                                                                                                                       |
| `sandboxCache.ts`         | OS sandbox cache wrapper (excludes filen-tmp/) — keeps measurable distinction between user-cleanable cache and active in-flight files.                                                                                      |
| `clearBarrier.ts`         | Synchronization primitive: many concurrent readers, exclusive clear() — used to safely wipe caches without racing in-flight reads.                                                                                          |
| `fsUtils.ts`              | File-system traversal (`walkLocalDirectory`) + cache size measurement helpers.                                                                                                                                              |
| `storageRoots.ts`         | Single source of truth for on-disk storage paths + version constants. Plain-file areas (offline/fileCache/audioCache/thumbnails/logs) anchor on the iOS app-group base; the SQLite roots (sqlite.db, sdkCache) anchor on the PRIVATE sandbox base — <container>/Library on iOS (a lock held on a shared-container DB at suspension is a 0xdead10cc kill; Documents is Files-app-visible); pre-relocation DBs are abandoned in place. Also anchors tmp + LOGS_DIRECTORY (diagnostic logger sink, v1; wiped on logout).                                                                                                                   |
| `tmp.ts`                  | Transient staging directory (filen-tmp/) for in-flight uploads, exports, and decode targets. `newTmpFile(name)`/`newTmpDir(name)`.                                                                                          |
| `secureStore.ts`          | Encrypted KV (expo-secure-store + MMKV fallback), AES-256-GCM encryption, event-driven cache invalidation. Exports `useSecureStore<T>(key, initialValue)` hook.                                                             |
| `sqlite.ts`               | SQLite KV (single WITHOUT-ROWID `kv` table) for query-cache + camera-upload-ledger persistence — 8KB pages, WAL + synchronous NORMAL, 4MB cache, 128MB mmap (single-process invariant — see INIT_QUERIES comment), incremental autovacuum, secure_delete FAST, post-logout full vacuum + WAL-truncate scrub. Lives in the app's PRIVATE sandbox, NOT the iOS app-group container (idle WAL lock at suspension there = 0xdead10cc); The pre-relocation group-container DB is deliberately ABANDONED in place (no migration, no cleanup — the KV is rebuildable; accepted one-time costs: query-cache cold start, camera-upload ledger rebuild, pending in-flight edits dropped). Deliberately NO background-maintenance AppState hook — checkpointing at backgrounding races suspension.  |
| `serializer.ts`           | Shared JSON serializer setup (UniffiEnum, BigInt, TypedArray) used by sqlite/route params.                                                                                                                                  |
| `utils.ts`                | SDK type unwrapping, path normalization (SDK/Expo/BlobUtil), sanitizeFileName, getPreviewType, PauseSignal, composite signals.                                                                                              |
| `exif.ts`                 | EXIF date parsing (DateTimeOriginal/Digitized/DateTime + SubSec + Offset) + orientation from raw bytes (JPEG/TIFF/HEIC/WebP).                                                                                               |
| `time.ts`                 | Fast date/time formatting (Hermes-optimized, no Intl.DateTimeFormat), locale-aware YMD/MDY/DMY.                                                                                                                             |
| `i18n.ts` / `language.ts` | Localization runtime + language preference (typed catalog under `src/locales/`).                                                                                                                                            |
| `theme.ts`                | Theme tokens / theme preference.                                                                                                                                                                                            |
| `events.ts`               | Typed EventEmitter (secureStore, actionSheet, driveSelect, contactsSelect, chatConversationDeleted, noteContentEdited, etc.).                                                                                               |
| `logger.ts`               | Async, non-blocking, privacy-aware on-disk diagnostic logger (class singleton). Hot path = level-gate + one cheap push; redaction/JSON/file-append/rotation happen batched off-path at flush. warn/error (+ uncaught errors/rejections) persist to rotating NDJSON; info/debug live only in a bounded in-memory breadcrumb ring, dragged to disk as context in front of a persisted error. ~10MB cap. Prod gate (warn/error only) armed in the constructor. `purge()` on logout (terminal disable + wipe). `readEntries()` feeds the in-app viewer. A log call MUST NEVER throw. |
| `logRedaction.ts`         | SECRETS-ONLY redaction at flush. By product decision logs KEEP decrypted names/paths/queries (what makes bugs findable; user warned at export); only secret material (master keys, apiKey, privateKey, auth blobs, 64-hex/long high-entropy strings) is masked. Handles bigint/circular/binary/UniFFI/throwing-getters without throwing. |
| `errorHandlers.ts`        | `installGlobalErrorHandlers()` (from `global.ts`): chains RN `ErrorUtils` for uncaught errors + enables the Hermes rejection tracker in PRODUCTION (RN only wires it in `__DEV__`). Both route to the logger + `flushNow()`. |
| `prompts.ts`              | Native alert/input dialogs (@blazejkustra/react-native-alert).                                                                                                                                                              |
| `alerts.tsx`              | Toast notifications (Burnt) and error banners (Notifier) with FilenSdkError unwrapping.                                                                                                                                     |
| `reconnect.ts`            | Online-transition handler — on offline→online flip, kicks `cameraUpload.sync()`, `offline.sync()`, `notesSync.executeNow()`, `chatsSync.syncNow()`.                                                                         |
| `setup.ts`                | App init: auth check → SDK → SecureStore → SQLite → restore queries → restore cache (Semaphore-protected).                                                                                                                  |

`src/lib/polyfills/` — loaded in order from `src/global.ts`: DOMException → buffer → crypto → console. `console.ts` is a TEE, not a plain replacement: every leveled `console.*` is forwarded into the diagnostic logger (`logger.captureConsole`, redacted at flush), then in dev only forwarded to the native console (prod native stays silent but the output is captured to disk). warn/error args are run through SDK-error unwrapping first.

## Hooks (src/hooks/) — shared cross-feature

Feature-specific hooks (useChatUnreadCount, useDriveUpload, useDriveSearch, usePhotoBulkActions, …)
moved into their features. Shared ones:

| Hook                   | Signature                                  | Purpose                                                                                                            |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `useDrivePath`         | `() => DrivePath`                          | Parses route + URL params → {type, uuid, selectOptions}                                                            |
| `useIsOnline`          | `() => boolean`                            | Reactive sync with TanStack `onlineManager` — single source of truth for online state                              |
| `useIsAppActive`       | `() => boolean`                            | AppState listener (active/background/inactive)                                                                     |
| `useViewLayout`        | `(ref) => {layout, onLayout}`              | Tracks View dimensions via onLayout/measureInWindow                                                                |
| `useFloatingBarOffset` | `() => number`                             | Floating-bar offset above tabs (iOS 49pt + safe area, Android 80dp)                                                |
| `useDeviceDiskSpace`   | `() => …`                                  | Device free/total disk space                                                                                       |
| `useMediaPermissions`  | `({shouldRequest?}) => {loading, granted}` | Media library + image picker permissions w/ AppState refresh. Module also exports `hasAllNeededMediaPermissions()` |
| `useEffectOnce`        | `(effect) => void`                         | Runs effect callback once per component lifetime                                                                   |
| `useDomEvents/`        | (subdir)                                   | `useDomDomEvents` (WebView↔Native) + `useNativeDomEvents` (Native↔DOM for Expo DOM components)                     |

Note: `useNetInfo` and `useHeaderHeight` were removed in favor of `useIsOnline` (which routes through onlineManager) and inline `@react-navigation/elements` reads respectively.

## Stores (src/stores/) — shared/shell only

Feature stores moved into `src/features/<feature>/store/`. What remains is shared/shell state:

| Store             | Key State                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `useApp`          | `pathname`, `biometricUnlocked: boolean \| null`                                                   |
| `useSocket`       | `state: "connected" \| "disconnected" \| "reconnecting"`                                           |
| `useHttp`         | `port: number \| null`, `getFileUrl: (file: AnyFile) => string` (subscribeWithSelector middleware) |
| `useDrivePreview` | `currentItem`, `items`, `headerHeight`, `drivePath`, scroll index (gallery state)                  |
| `useRichtext`     | formats: QuillFormats (state of the shared `components/textEditor`)                                |
| `useTextEditor`   | ready: boolean (state of the shared `components/textEditor`)                                       |

(`useFileVersions` → `features/drive/store/`, `useChecklist` → `features/notes/store/` — relocated to their owning feature.)

`createSelectionSlice` — shared Zustand slice factory for `selectedItems` (composed by per-feature selection stores).

## Queries (src/queries/) — shared/infra only

Feature queries (drive items, chats, notes, contacts, events, audio metadata, …) moved into
`src/features/<feature>/queries/`. The file-access queries stayed shared (used by drive/photos/chats/preview).

All use `BASE_QUERY_KEY` prefix, `fetchData` pattern, SQLite persistence via custom JSON serializer.
Default: refetchOnMount/Reconnect/Focus: "always", staleTime: 0, gcTime: 365 days, networkMode: "always".
Eternal variant: staleTime/gcTime: Infinity, no refetch (for unchanging data).

| Query                         | Params | Returns                                                                         |
| ----------------------------- | ------ | ------------------------------------------------------------------------------- |
| `useFileUrlQuery`             | {item} | HTTP URL via Http provider (use this for serving file bytes to webview/players) |
| `useFileUriQuery`             | {item} | Local file URI (cached or freshly downloaded)                                   |
| `useFileTextQuery`            | {item} | UTF-8 text body                                                                 |
| `useFileBase64Query`          | {item} | base64 string body                                                              |
| `useAccountQuery`             | —      | account / user info (incl. `didExportMasterKeys`)                               |
| `useLocalAuthenticationQuery` | —      | `{hasHardware, isEnrolled}` device biometric capability                         |
| `useMediaPermissionsQuery`    | —      | media library permission status                                                 |

`client.ts` exports: `QueryUpdater` class (get/set cache), `queryUpdater` singleton, and `useDefaultQueryParams`.
`onlineStatus.ts` adapts NetInfo → TanStack `onlineManager`.
`fileSource.ts` — shared resolver feeding the file-access queries.
Uncached queries: `["drivePreviewTextContent"]`.

## Types (src/types.ts)

```typescript
DriveItem = DriveItemFile | DriveItemDirectory | DriveItemFileShared
          | DriveItemDirectorySharedNonRoot | DriveItemDirectorySharedRoot
// Each = SDK type & { size: bigint, uuid: string, decryptedMeta: Decrypted*Meta | null }
// Discriminated by `type` field

DriveItemFileExtracted = file | sharedFile only
DriveItemDirectoryExtracted = all dir/root types
```

## Component Patterns

### UI Base (`components/ui/`)

- `View` / `KeyboardAvoidingView` / `KeyboardAwareScrollView` / `KeyboardStickyView` — Uniwind-wrapped
- `BlurView` / `LiquidGlassView` / `CrossGlassContainerView` — glassmorphism (expo-blur + expo-glass-effect)
- `Text` — Uniwind + foreground color default (react-native-boost)
- `Image` — Uniwind-wrapped expo-image
- `PressableOpacity` / `PressableScale` / `AndroidIconButton` — haptic via Pressto
- `Header` — stack header with typed items: text, menu, button, custom, loader
- `Menu` — iOS (react-native-ios-context-menu) + Android (@react-native-menu/menu)
- `VirtualList` — FlashList wrapper with search bar, pull-to-refresh, grid mode, header height caching
- `ZoomableView` — pinch/pan/double-tap zoom with worklet-driven gestures, pinch-to-dismiss
- `FullScreenLoadingModal` — event-driven overlay, `runWithLoading(fn)` utility
- `settingsGroup` — grouped settings rows scaffold (used by features/settings)
- `SafeAreaView`, `AnimatedView`, `Button`, `Checkbox`, `ListEmpty`, `Avatar`, `Measure`

### Drive (`features/drive/components/`)

- Main `Drive` component: item list with sorting/selection, search (local + debounced global)
- `Item`: thumbnail + metadata row + context menu + selection checkbox + offline/favorite badges
- `Thumbnail`: lazy generation via thumbnails lib, retry logic (max 3), abort on background
- `Menu`: 15+ actions (download, share, favorite, rename, move, trash, versions, color, etc.)
- `DriveSelectToolbar`: floating bar for move/copy destination selection
- `DateComponent` + `Size`: formatted metadata subcomponents

### Item Icons (`components/itemIcons/`)

- `FileIcon`: 40+ extension-to-icon mappings
- `DirectoryIcon`: colored SVG generation with DirColor enum, `directoryColorToHex()`, `shadeColor()`

### Chats (`features/chats/components/`)

- Chat list with search, selection, create/leave/delete/mute actions
- Message bubbles with grouping (same author < 1 min), edited badges, context menus
- `Regexed`: regex-parsed message content (links, @mentions, custom emojis, embeds)
- Input with @mention autocomplete, custom emoji picker, file sharing
- `ChatSync`: persists/restores in-flight messages via SQLite

### Notes (`features/notes/components/`)

- Note list with tag filtering, grouped by pinned/favorited/time-bucket/archived/trashed
- Content editors delegate to TextEditor (markdown/richtext/code) or Checklist component
- Tag management with rename/delete/favorite
- `NotesSync`: persists/restores in-flight content edits via SQLite

### Text Editors (`components/textEditor/`)

- `TextEditor`: wrapper selecting editor by note type
- `TextEditorDOM` / `codeMirror.ts`: CodeMirror via WebView (markdown/code, 20+ language syntaxes)
- `RichText/` subdir: Quill.js via WebView (bold/italic/underline/headers/lists/code/links)
- `markdownPreviewButton.tsx`: format action buttons

### Drive Preview (`components/drivePreview/`)

- `gallery` + `galleryItem` + `header` — pinch-to-dismiss image/video/audio gallery
- `previewAudio` / `previewVideo` / `previewImage` / `previewPdf` / `previewDocx` / `previewText` — per-type renderers

### Participants (`components/participants/`)

- `participantRow` / `participantList` — shared participant UI used by both notes and chats

### Docx Preview (`components/docxPreview/`)

- WebView-based renderer for `.docx`

### Floating Bar (`components/floatingBar/`)

- `index` + `audioSlot` + `transfersSlot` + `animatedProgressBar` + `separator` — bottom bar above tabs showing active transfers and audio playback

### Shell components (`components/shell/`)

Mounted by the root `_layout.tsx`. Pattern: subscribe to a single concern, never render their own UI rows.

- `socket.tsx` — WebSocket connection lifecycle + dispatcher → delegates per-feature events to `handleDriveEvent`/`handleChatEvent`/`handleNoteEvent`/`handleContactEvent`
- `http.tsx` — HTTP provider lifecycle (start on foreground, stop on background) for file serving
- `pathname.tsx` — syncs router pathname to `useApp` store
- `biometric.tsx` — full-screen lock overlay (`BiometricInner` + `Locked` countdown)
- `privacyCover.tsx` — app-switcher screenshot redactor
- `offlineBanner.tsx` — global offline indicator (single source of truth via `useIsOnline`)
- `accountReminders.tsx` — reminder badges (e.g. master keys not exported)
- `cannotDecryptScreen.tsx` — fallback when decryption fails
- `dismissStack.tsx` — utility component for closing nested modal stacks

(Feature-owned background components: `foregroundService` → features/transfers (Android FGS for active transfers, notifee); `incomingShareHandler` → features/incomingShare (OS share-sheet items); notes/chats in-flight `sync` → their features.)

### Transfers (`features/transfers/components/`)

- Floating progress indicator: active count, speed (bps), progress bar
- Full transfers list in modal route

## Config

- **TypeScript**: strict (all flags), path aliases `@/` and `#/` → `src/`, `@/modules/` → `modules/`
- **ESLint**: flat config (v9), react-compiler: error, no relative imports (enforced), TanStack Query plugin, exhaustive-deps with `useMemoDeep`/`useCallbackDeep`. Feature-architecture guardrails: selector-required store hooks, no `export *` barrels in `src/features/`, thin-route import restrictions (see "ESLint guardrails" above). Submodule trees (`filen-rs/`, `filen-ios-file-provider/`, `filen-android-documents-provider/`) and `plugins/` are ignored.
- **Styling**: Tailwind CSS v4 + Uniwind, global.css with dark theme (OLED black #000000), iOS system color palette
- **Metro**: crypto/stream/path polyfills, Uniwind CSS + TS type generation
- **Babel**: babel-preset-expo + react-native-worklets/plugin. In production also `transform-remove-console` with `exclude: ["error", "warn"]` — strips `console.log/info/debug/trace` call sites (keeps prod lean) but KEEPS `console.warn`/`console.error` so they reach the diagnostic-logger tee. Removing the exclude would silently disable warn/error capture in prod. Applies to the WebView bundle too — `domConsoleProxy.ts` overrides via `globalThis.console` (immune to the plugin).
- **Testing**: Vitest (node env), path alias `@` → `./src`, react-native + expo-\* modules mocked under `src/tests/mocks/`. Submodule trees excluded.
- **iOS**: deployment target **26.0**, app group `group.io.filen.app`, iCloud, 26 localizations, UIBackgroundModes: audio/fetch/processing, Apple team `7YTW5D2K7P`
- **Android**: min SDK **31** (Android 12; can lower to 26 with no code change, or 24 with a DocumentsProvider rework — hard dep floor is API 24), target SDK **36**, compile SDK 36, build tools 36.0.0; 23 permissions (incl. MANAGE_DOCUMENTS for the documents provider, ACTION_OPEN_DOCUMENT/\_TREE for incoming intents); Hermes; predictiveBackGestureEnabled: false; allowBackup: false
- **Stock Expo plugins** (in app.config.ts plugins array): expo-plugin-ios-static-libraries (op-sqlite), expo-build-properties, expo-router (typed routes + React compiler), expo-splash-screen, expo-video, expo-audio, expo-media-library, expo-document-picker, expo-image-picker, expo-local-authentication, expo-sqlite, expo-localization, expo-background-task, expo-secure-store, expo-navigation-bar, expo-asset, expo-sharing (with iOS app-group activation rules), expo-web-browser, expo-image, react-native-edge-to-edge, react-native-document-scanner-plugin, @config-plugins/react-native-blob-util
- **Custom Expo plugins** (`packages/filen-mobile/plugins/`):
    - `withFileProvider.ts` — iOS File Provider Extension target + Rust xcframework build (cargo + uniffi-bindgen-swift + xcodebuild)
    - `withAndroidRustBuild.ts` — Android `.so` build via cargo-ndk + uniffi-bindgen Kotlin + manifest `<provider>` injection
    - `withAndroidArchitectures.ts` — pins `reactNativeArchitectures` to the ABIs the Rust cache targets (`arm64-v8a,x86_64`)
    - `withAndroidLargeHeapAndHardwareAcceleration.ts` — manifest tweaks
    - `withAndroidNetworkSecurityConfig.ts` — restrictive network security policy
    - `withGradleMemory.ts` — `org.gradle.jvmargs` for big native builds
    - `withNotifeeForegroundServiceType.ts` — notifee FGS type for transfers
- **Scripts**: `npm run verify` = lint + typecheck + test; `npm run clean` = `.expo/`; `npm run superclean` = `.expo/` + DerivedData + `.gradle/` + Rust target dirs; `npm run prebuild:clean` = clean + expo prebuild --clean; `npm run prebuild:ci:{ios,android}` = superclean + prebuild for one platform
- **patch-package**: applied via `scripts/postinstall.sh`. Patches in `patches/` — notable: xcode 3.0.1 (file-provider `addResourceFile` null guard), expo-video 57 (Android PiP-exit reparent crash), @blazejkustra/react-native-alert 1.0.0 (Android: non-login prompt dialogs excluded from autofill — their password-variation input types made Google Password Manager pop on plain text prompts, upstreamable), expo-screen-orientation 57.0.0 (iOS: missing dispatch barriers on controller register/unregister — plain `sync` writes on the registry's concurrent queue race the barrier-less reader loop and corrupt the controllers array, crashing at AppContext teardown; upstreamable), @react-native-menu/menu 2.0.0 (Android: MenuView installs a TouchDelegate on its parent covering its hit rect + hitSlop and never uninstalls it — after the view unmounts, taps in the old rect are forwarded to the DETACHED view, whose gesture detector still shows the popup anchored at the window origin (a top-left menu; hit via the note header's saving-spinner swap). Detach now clears the parent delegate and prepareMenu bails on a detached anchor; upstreamable), @kishannareshpal/expo-pdf 0.3.2 (adds a `maxZoom` prop; Android: registers the viewer's DefaultLinkHandler so embedded PDF links work — internal destinations jump, external URIs open via the system, matching iOS PDFKit's native behavior; upstreamable), expo-sharing 57.0.6 (Android: a stale `pendingPromise` — the chooser's activity result was never delivered, seen on newer Android sharesheets — permanently rejected every later share with ERR_SHARING_IN_PROGRESS; settle-and-clear at `shareAsync` entry instead of throwing, upstreamable; paired with the JS settle watchdog in `src/lib/share.ts`), expo-image-manipulator 57 (Android: `isActive` guard against double continuation resume from re-fired Glide callbacks, upstreamable), plus expo-media-library and other version-bumped patches. (The former react-native-screens `isHiddenBySearchBar` patch was merged upstream and retired at 4.26.x.)
- **cargo-ndk** 4.x for prebuild (reads `ANDROID_ABI` per filen-rs `d454f4d`; the old 3.5.4 pin no longer propagates the heif-decoder ABI, reversing the earlier bbqsrc/cargo-ndk#181 workaround — see README)

## SDK Integration Patterns

```typescript
// Get authed SDK client
const { authedSdkClient } = await auth.getSdkClients()

// Wrap abort signals for SDK calls
const signal = wrapAbortSignalForSdk(abortController.signal)

// Composite signals for multi-step operations
const composite = createCompositeAbortSignal(signal1, signal2)

// Unwrap SDK tagged union types
const unwrapped = unwrapDirMeta(dir) // → { meta, uuid, shared, linked, root, dir }
const unwrapped = unwrapFileMeta(file) // → { meta, shared, linked, root, file }

// Convert to app DriveItem type
const item = unwrappedDirIntoDriveItem(unwrapped)
const item = unwrappedFileIntoDriveItem(unwrapped)

// Normalize paths for SDK vs Expo vs BlobUtil
normalizeFilePathForSdk(path) // → "/decoded/path"
normalizeFilePathForExpo(path) // → "file:///encoded/path"

// Handle SDK errors
const sdkError = unwrapSdkError(error) // → FilenSdkError | null

// HTTP provider for file serving (video thumbnails, previews)
const { port, getFileUrl } = useHttpStore()
const url = getFileUrl(anyFile) // → http://localhost:{port}/...
```

## Import Rules

- **Always use `@/` aliases** — relative imports are forbidden by ESLint. Cross-feature imports use full `@/features/...` paths.
- **Inline type imports**: `import { type Foo, Bar } from "..."` (not `import type`)
- **No trailing commas**, **no semicolons**, **double quotes**, **tabs**
- **No non-null assertion `!`** — handle null explicitly or use explicit `as Type` when the type is known to be non-null

## Key Architectural Patterns

- **Feature-based layout** — each product domain lives under `src/features/<feature>/` (screens/components/hooks/queries/store + its lib singleton(s) + socketHandlers). Routes are thin re-exports; `src/components|lib|stores|queries|hooks` are shared/infra only.
- **Module singletons** for feature/infra services — each exported as a single ready-to-use value, never instantiated by callers. Shape follows state: services holding real mutable runtime state (auth, chats, audio, offline, transfers, cameraUpload, cache, secureStore, sqlite, fileCache, thumbnails, QueryPersisterKv, …) are **class singletons** (`class X {} export default new X()` — the constructor is also the per-test isolation seam); stateless namespaces (alerts, prompts, queryUpdater, actionSheet, sandboxCache, contacts, notes, drive, setup, sorters, …) are **plain objects / module functions** (no class). New code: prefer a plain object / free functions unless the service holds mutable runtime state, in which case use a class singleton.
- **SDK delegation** — no crypto/API/networking reimplementation in JS; everything routes through `@filen/sdk-rs`
- **Silent infrastructure** — `src/lib/*` and feature `<feature>.ts` singletons expose state, never fire banners/toasts. UX belongs in UI components.
- **Diagnostic logging** — `src/lib/logger.ts` is an async, never-throwing on-disk NDJSON logger wired at `src/global.ts` (console tee + `installGlobalErrorHandlers()`) and torn down at logout (`logger.purge()` in `auth.ts`). Prod = warn/error only (debug/info are in-memory breadcrumbs), armed in the logger constructor; babel strips debug/info console call sites. Logs KEEP names/paths but never secrets (`logRedaction.ts`). Surfaced via the `logViewer` route + `exportLogs()` in advanced settings; WebView console is proxied back via `hooks/useDomEvents/domConsoleProxy.ts`. From app code use `logger.warn/error(tag, msg, data)`; `console.*` is also captured.
- **Optimistic updates** via query updaters for instant UI feedback
- **Concurrency control** via Semaphores + composite abort/pause signals
- **Event-driven cache invalidation** via typed EventEmitter
- **Session-scoped uuid caches** (`cache.ts`) — plain Maps rebuilt per process from fetches, optimistic mutations, and the boot warm-seed of restored listing queries; never mirrored to SQLite. Durable state lives with its owning feature: the camera-upload ledger writes through to the kv in `cameraUploadState.ts`, thumbnails on disk, listings in the query persister
- **custom JSON serialization** with UniffiEnum extension for query/cache persistence
- **Focus-aware queries** — refetch on screen focus, pause off-screen re-renders
- **Online state via `useIsOnline`** — single source of truth bridged to TanStack `onlineManager` via `queries/onlineStatus.ts`. Don't read NetInfo directly in components.
- **Reconnect handler** (`src/lib/reconnect.ts`) — kicks deferred sync of camera upload, offline cache, notes, chats on every offline→online transition
- **Root overlay coordination** — Biometric/PrivacyCover lock paint; any new global side-effect must gate on `useAppStore.biometricUnlocked === true` AND `AppState === "active"` before firing
- **Storage roots** — `src/lib/storageRoots.ts` is the only place that constructs cache/offline/tmp paths. Reference its constants; don't compute paths inline.
- **Per-feature socket handlers** — the shell `socket.tsx` owns the connection lifecycle + dispatcher; per-feature `socketHandlers.ts` own their slice of events.

```

```

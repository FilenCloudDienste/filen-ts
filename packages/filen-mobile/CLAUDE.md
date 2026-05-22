# filen-mobile

Encrypted cloud storage mobile app — Expo 55 / React Native 0.83.6 / React 19 / Hermes.
All server communication, encryption, and auth handled by Rust SDK (`@filen/sdk-rs@^0.4.21`).

## Architecture

```
Entry:  src/entry.ts → expo-router
Setup:  src/global.ts (crypto polyfill, Buffer, NetInfo, console replacement)
        src/lib/setup.ts (auth check → SDK init → SQLite → restore query cache)

State:  Zustand stores (src/stores/)     → UI-only state (selections, input focus, etc.)
        TanStack Query (src/queries/)     → server data, persisted to SQLite via msgpackr
        Secure Store (src/lib/secureStore.ts) → encrypted secrets (expo-secure-store + MMKV fallback)
        Events (src/lib/events.ts)        → transient cross-component events (EventEmitter3)

SDK:    src/lib/auth.ts manages JsClientInterface (authed) + UnauthJsClientInterface
        src/lib/utils.ts wraps SDK types → unwrapDirMeta(), unwrapFileMeta(), wrapAbortSignalForSdk()

Native: Three git submodules at packages/filen-mobile/, integrated via custom Expo plugins —
        see "Submodules" section below.
```

## Submodules

Three git submodules live directly under `packages/filen-mobile/` (pinned SHAs in repo-root `.gitmodules`):

| Submodule | Role |
|-|-|
| `filen-rs/` | Rust monorepo. Source of the npm-shipped `@filen/sdk-rs` AND of `filen-mobile-native-cache` — a separate crate the iOS File Provider Extension and Android Documents Provider build against. |
| `filen-ios-file-provider/` | Swift source for the iOS File Provider Extension. `withFileProvider.ts` plugin copies these files into the prebuilt Xcode project + builds the Rust xcframework + wires up the extension target. |
| `filen-android-documents-provider/` | Kotlin source for the Android Documents Provider (`io.filen.app.FilenDocumentsProvider`). `withAndroidRustBuild.ts` plugin builds the `.so` files via cargo-ndk, generates uniffi Kotlin bindings, copies the Kotlin class into `app/src/main/java/io/filen/app/`, and injects the `<provider>` element into AndroidManifest.xml. |

Building the native cache requires **cargo-ndk pinned to 3.5.4** (see README — 4.x has bbqsrc/cargo-ndk#181 which breaks the heif-decoder ABI propagation).

`src/lib/fileProvider.ts` is the TS bridge that writes `auth.json` to the shared location both extensions read from (iOS app group container; Android `filesDir`). Mirrored boolean state lives in secureStore under `FILE_PROVIDER_ENABLED_SECURE_STORE_KEY` for fast reactive UI reads.

`auth.json`'s SDK config (`masterKeys`, `publicKey`, `apiKey`, `privateKey`, etc.) is populated from `authedSdkClient.toSdkConfig()` since SDK 0.4.21 exposes the full shape. The extensions should now resolve `queryRoots()` against a fully-authenticated SDK — pending end-to-end verification on real devices (iOS Files app / Android Documents picker).

## Navigation (expo-router)

5 tabs: drive (`tabs/drive/[uuid]`), photos, notes, chats, more

Modal routes (top-level under `routes/`): `note/[uuid]`, `chat/[uuid]`, `transfers`, `contacts`, `driveItemInfo`,
`driveSelect/[uuid]`, `changeDirectoryColor`, `notesTags`, `trash`, `recents`,
`favorites/[uuid]`, `links/[uuid]`, `sharedIn/[uuid]`, `sharedOut/[uuid]`, `offline/[uuid]`,
`drivePreview` (containedTransparentModal gallery preview), `account`, `security` (+ `/biometric`, `/twoFactor`),
`fileProvider`, `appearance`, `advanced`, `events` (+ `eventInfo`), `playlists` (+ `[uuid]`), `selectPlaylists`,
`cameraUpload` (+ `/albums`, + `cameraUploadErrors`), `fileVersions`, `publicLink`, `linkedFile`,
`linkedDir/[uuid]`, `incomingShare`, `chatParticipants`, `noteParticipants`, `noteHistory`, `register`.

```
routes/
├── _layout.tsx              root Stack + all modal screens
├── index.tsx                redirect → auth or drive based on auth state
├── transfers.tsx            pageSheet modal
├── auth/                    login flow
│   ├── _layout.tsx          redirects to drive if already authed
│   └── login.tsx
├── register/                registration flow
├── tabs/
│   ├── _layout.tsx          NativeTabs (expo-router/unstable-native-tabs)
│   ├── drive/[uuid].tsx     folder browser (renders <Drive />)
│   ├── photos/index.tsx     photo grid (5 per row, creationDesc sort)
│   ├── notes/index.tsx      note list (renders <Notes />)
│   ├── chats/index.tsx      chat list (renders <Chats />)
│   └── more/index.tsx       settings menu with links to modal routes
├── account/                 account info + master keys export
├── security/                index + biometric + twoFactor sub-screens
├── fileProvider/            File / Documents Provider toggle (with biometric mutex)
├── appearance/              theme + display settings
├── advanced/                advanced settings (cache, debug toggles)
├── events/                  activity log (+ eventInfo for details)
├── playlists/               music playlist list + [uuid] detail
├── selectPlaylists/         add-to-playlist modal
├── cameraUpload/            index + albums picker (+ cameraUploadErrors)
├── publicLink/              public link preview
├── linkedFile/, linkedDir/  linked-item viewers
├── incomingShare/           system share-sheet target
├── chatParticipants/, noteParticipants/, noteHistory/
├── fileVersions/            file version history
├── chat/[uuid].tsx          conversation view with messages + input
├── note/[uuid].tsx          note editor (markdown/richtext/code/checklist)
├── drivePreview/            full-screen gallery (images/video/audio/text/pdf/docx)
├── driveItemInfo/           file/folder metadata sheet
├── changeDirectoryColor/    folder color picker (reanimated-color-picker)
├── contacts/                contact management + selection modal
├── driveSelect/[uuid].tsx   item selection for move/copy + DriveSelectToolbar
├── trash/, recents/, favorites/[uuid].tsx, links/[uuid].tsx,
├── sharedIn/[uuid].tsx, sharedOut/[uuid].tsx, offline/[uuid].tsx
│                            ↑ all reuse <Drive /> in different contexts
└── notesTags/               tag management (renders <Notes />)
```

Route params are packed with msgpackr + base64 (DriveItem, DrivePath, SelectOptions).
Programmatic selection: `selectDriveItems(options)`, `selectContacts(options)` → event-driven.

## Key Directories

```
src/routes/         expo-router screens (see Navigation above)
src/components/     UI components (drive/, chats/, notes/, textEditor/, ui/, itemIcons/, drivePreview/, floatingBar/, cameraUpload/, docxPreview/)
src/stores/         Zustand stores (one per feature domain)
src/queries/        TanStack Query hooks + client setup
src/lib/            Core logic modules (see below)
src/lib/polyfills/  DOMException, Buffer, console, crypto polyfills loaded in global.ts
src/hooks/          Custom hooks
src/providers/      Style provider (Tailwind/Uniwind theme), ActionSheet provider
src/assets/         Custom emojis (CDN-backed), app icons, splash images
src/tests/          Vitest tests + mocks for native modules
```

## Lib Modules (src/lib/)

| Module | Purpose |
|-|-|
| `auth.ts` | SDK client init, login/logout, `useIsAuthed()` / `useSdkClients()` / `useStringifiedClient()` hooks. Calls `fileProvider.disable()` + cleanup on logout. |
| `drive.ts` | File ops: favorite, rename, move, delete, trash, restore, share, search, setDirColor, createDirectory, updateTimestamps |
| `transfers.ts` | Upload/download with progress, pause/resume, abort, error tracking, duplicate prevention via active ID sets |
| `offline.ts` | Offline file cache: store, sync, list, index management (FileOrDirectoryOfflineMeta) |
| `chats.ts` | Send/edit/delete messages, typing indicators, mark read, create/leave/delete chats, Semaphore-protected refetch |
| `notes.ts` | CRUD, content editing, tags, participants, history, export (single .txt / bulk .zip via JSZip) |
| `contacts.ts` | Requests (accept/deny/cancel/send), block/unblock, delete |
| `cameraUpload.ts` | Auto media sync, EXIF dates, dedup via xxHash32 (6-iteration collision resolution), same-title album disambiguation (sort all device albums by id, suffix later siblings with `(albumId)`), sanitization of `/` in titles/ids, compression |
| `thumbnails.ts` | Thumbnail generation: images (ImageManipulator resize) + videos (HTTP provider → expo-video), Semaphore(3) concurrency, max 3 failures per item |
| `cache.ts` | PersistentMap<V> (extends Map with debounced SQLite persistence): uuid→DriveItem, uuid→dir/note/chat, availableThumbnails, **rootUuid** |
| `secureStore.ts` | Encrypted KV (expo-secure-store + MMKV fallback), AES-256-GCM encryption, event-driven cache invalidation. Exports `useSecureStore<T>(key, initialValue)` hook. |
| `sqlite.ts` | SQLite KV for query persistence, WAL mode, 32MB mmap, 8MB cache, app group directory (iOS) |
| `msgpack.ts` | Custom msgpackr with UniffiEnum extension (type 0x75), BigInt support, Symbol preservation |
| `serializer.ts` | Shared msgpackr serializer setup (UniffiEnum, BigInt, TypedArray) used by sqlite/cache/route params |
| `utils.ts` | SDK type unwrapping, path normalization (SDK/Expo/BlobUtil), sanitizeFileName, getPreviewType, PauseSignal, composite signals |
| `sort.ts` | ItemSorter (name/size/mime/date, dirs-first, numeric-aware) + NotesSorter (pinned/archived/time-bucketed groups) |
| `driveSortPreference.ts` | Per-directory + global sort preference persistence (secureStore-backed) |
| `time.ts` | Fast date/time formatting (Hermes-optimized, no Intl.DateTimeFormat), locale-aware YMD/MDY/DMY |
| `events.ts` | Typed EventEmitter (secureStore, actionSheet, driveSelect, contactsSelect, chatConversationDeleted, noteContentEdited, etc.) |
| `prompts.ts` | Native alert/input dialogs (@blazejkustra/react-native-alert) |
| `alerts.tsx` | Toast notifications (Burnt) and error banners (Notifier) with FilenSdkError unwrapping |
| `setup.ts` | App init: auth check → SDK → SecureStore → SQLite → restore queries → restore cache (Semaphore-protected) |
| `fileProvider.ts` | iOS/Android document provider bridge: writes `auth.json` (full SDK config from `authedSdkClient.toSdkConfig()`) to the iOS app group container / Android `filesDir`. Mirrors `providerEnabled` to secureStore under `FILE_PROVIDER_ENABLED_SECURE_STORE_KEY` for reactive UI. |
| `reconnect.ts` | Online-transition handler — on offline→online flip, kicks `cameraUpload.sync()`, `offline.sync()`, `notesSync.executeNow()`, `chatsSync.syncNow()` |
| `memo.ts` | Custom memo/useCallback/useMemo with deep equality (react-fast-compare) in prod, standard React in dev |
| `exif.ts` | EXIF date parsing (DateTimeOriginal/Digitized/DateTime + SubSec + Offset) + orientation from raw bytes (JPEG/TIFF/HEIC/WebP) |
| `tmp.ts` | Transient staging directory (filen-tmp/) for in-flight uploads, exports, and decode targets. `newTmpFile(name)`/`newTmpDir(name)`. |
| `storageRoots.ts` | Single source of truth for on-disk storage paths + version constants. Anchors all cache/offline/tmp dirs. |
| `audio.ts` | Audio playback / playlist queue management with loop modes (track/list/off). Singleton, drives playlists tab. |
| `audioCache.ts` | Music metadata + cover art cache, version-tracked + persisted |
| `fileCache.ts` | File download cache (dedup keyed by `type:data`) with metadata index. Replaces ad-hoc download paths. |
| `sandboxCache.ts` | OS sandbox cache wrapper (excludes filen-tmp/) — keeps measurable distinction between user-cleanable cache and active in-flight files |
| `fsUtils.ts` | File-system traversal (`walkLocalDirectory`) + cache size measurement helpers |
| `clearBarrier.ts` | Synchronization primitive: many concurrent readers, exclusive clear() — used to safely wipe caches without racing in-flight reads |
| `backgroundTask.ts` | Expo background task registration for camera upload sync |
| `foregroundService.ts` | Android foreground service notifications for active transfers (notifee) |
| `startScreen.ts` | Default-tab preference (drive/photos/notes/chats/more) read at boot |

`src/lib/polyfills/` — DOMException, Buffer, console-replacement, crypto loaded in order from `src/global.ts`.

## Hooks (src/hooks/)

| Hook | Signature | Purpose |
|-|-|-|
| `useDrivePath` | `() => DrivePath` | Parses route + URL params → {type, uuid, selectOptions} |
| `useIsOnline` | `() => boolean` | Reactive sync with TanStack `onlineManager` — single source of truth for online state |
| `useIsAppActive` | `() => boolean` | AppState listener (active/background/inactive) |
| `useViewLayout` | `(ref) => {layout, onLayout}` | Tracks View dimensions via onLayout/measureInWindow |
| `useFloatingBarOffset` | `() => number` | Floating-bar offset above tabs (iOS 49pt + safe area, Android 80dp) |
| `useChatUnreadCount` | `(chat) => number` | Unread messages for a single chat |
| `useChatsUnreadCount` | `() => number` | Total unread across all chats, refetches on app resume |
| `useMediaPermissions` | `({shouldRequest?}) => {loading, granted}` | Media library + image picker permissions w/ AppState refresh. Module also exports `hasAllNeededMediaPermissions()` |
| `useEffectOnce` | `(effect) => void` | Runs effect callback once per component lifetime |
| `useDomEvents/` | (subdir) | `useDomDomEvents` (WebView↔Native) + `useNativeDomEvents` (Native↔DOM for Expo DOM components) |

Note: `useNetInfo` and `useHeaderHeight` were removed in favor of `useIsOnline` (which routes through onlineManager) and inline `@react-navigation/elements` reads respectively.

## Stores (src/stores/)

| Store | Key State |
|-|-|
| `useApp` | `pathname`, `biometricUnlocked: boolean \| null` |
| `useDrive` | `selectedItems: DriveItem[]` |
| `useDriveSelect` | `selectedItems: DriveItem[]` (for move/copy modal) |
| `useDrivePreview` | `currentItem`, `items`, `headerHeight`, `drivePath`, scroll index (gallery state) |
| `useTransfers` | `transfers[]` (progress, speed, errors, abort/pause controls) + stats (aggregated metrics with interval timer) |
| `useChats` | inputViewLayout, inputSelection, suggestionsVisible, inputFocused, typing, inflightMessages, inflightErrors, selectedChats |
| `useNotes` | inflightContent, activeNote, activeTag, selectedNotes, selectedTags |
| `useContacts` | `selectedContacts: ContactListItem[]` |
| `useOffline` | `syncing: boolean` |
| `useCameraUpload` | `syncing`, `errors[]` |
| `usePhotos` | visible date range for the photo timeline |
| `usePlaylists` | selected playlists array |
| `useIncomingShare` | processing flag for incoming OS share intents |
| `useSocket` | `state: "connected" \| "disconnected" \| "reconnecting"` |
| `useHttp` | `port: number \| null`, `getFileUrl: (file: AnyFile) => string` (subscribeWithSelector middleware) |
| `useChecklist` | parsed: Checklist, inputRefs, initialIds, ids |
| `useRichtext` | formats: QuillFormats |
| `useTextEditor` | ready: boolean |

## Queries (src/queries/)

All use `BASE_QUERY_KEY` prefix, `fetchData` pattern, SQLite persistence via msgpackr.
Default: refetchOnMount/Reconnect/Focus: "always", staleTime: 0, gcTime: 365 days, networkMode: "always".
Eternal variant: staleTime/gcTime: Infinity, no refetch (for unchanging data).

| Query | Params | Returns |
|-|-|-|
| `useDriveItemsQuery` | path: {type, uuid} | DriveItem[] (8 path types: drive/favorites/recents/sharedIn/sharedOut/trash/links/offline) |
| `useDirectorySizeQuery` | {uuid, type} | {size, files, dirs} |
| `useDriveItemVersionsQuery` | {uuid} | FileVersion[] |
| `useDriveItemStoredOfflineQuery` | {uuid, type} | boolean |
| `useDriveItemPublicLinkStatusQuery` | {uuid, type} | public-link status for a drive item |
| `useFileUrlQuery` | {item} | HTTP URL via Http provider (use this for serving file bytes to webview/players) |
| `useFileUriQuery` | {item} | Local file URI (cached or freshly downloaded) |
| `useFileTextQuery` | {item} | UTF-8 text body |
| `useFileBase64Query` | {item} | base64 string body |
| `useChatsQuery` | — | Chat[] |
| `useChatMessagesQuery` | {uuid} | ChatMessageWithInflightId[] |
| `useChatsUnreadQuery` | — | BigInt (total unread) |
| `useChatMessageLinksQuery` | {message} | URLs extracted from a message body |
| `useNotesWithContentQuery` | — | (Note & {content})[] |
| `useNoteContentQuery` | {uuid} | string |
| `useNoteHistoryQuery` | {uuid} | NoteHistory[] |
| `useNotesTagsQuery` | — | NoteTag[] |
| `useContactsQuery` | — | {contacts, blocked} |
| `useContactRequestsQuery` | — | {incoming, outgoing} |
| `useAccountQuery` | — | account / user info (incl. `didExportMasterKeys`) |
| `useEventsQuery` | — | account event log (activity stream) |
| `useAudioMetadataQuery` | {file} | title/artist/album/duration/picture extracted from audio |
| `useCacheSizesQuery` | — | aggregated sizes: thumbnails, fileCache, audioCache, sandbox, offline |
| `useCameraUploadAlbumsQuery` | — | device albums via `MediaLibrary.getAlbumsAsync({includeSmartAlbums: true})` |
| `useLocalAuthenticationQuery` | — | `{hasHardware, isEnrolled}` device biometric capability |
| `useMediaPermissionsQuery` | — | media library permission status |
| `usePlaylistsQuery` | — | audio playlist list + metadata |

`client.ts` exports: `QueryUpdater` class (get/set cache), `queryUpdater` singleton, `useDefaultQueryParams`,
`useFocusNotifyOnChangeProps`, `useQueryFocusAware`, `useRefreshOnFocus`. `onlineStatus.ts` adapts NetInfo → TanStack `onlineManager`.
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
- `SafeAreaView`, `AnimatedView`, `Button`, `Checkbox`, `ListEmpty`, `Avatar`, `Measure`

### Drive (`components/drive/`)
- Main `Drive` component: item list with sorting/selection, search (local + debounced global)
- `Item`: thumbnail + metadata row + context menu + selection checkbox + offline/favorite badges
- `Thumbnail`: lazy generation via thumbnails lib, retry logic (max 3), abort on background
- `Menu`: 15+ actions (download, share, favorite, rename, move, trash, versions, color, etc.)
- `DriveSelectToolbar`: floating bar for move/copy destination selection
- `DateComponent` + `Size`: formatted metadata subcomponents

### Item Icons (`components/itemIcons/`)
- `FileIcon`: 40+ extension-to-icon mappings
- `DirectoryIcon`: colored SVG generation with DirColor enum, `directoryColorToHex()`, `shadeColor()`

### Chats (`components/chats/`)
- Chat list with search, selection, create/leave/delete/mute actions
- Message bubbles with grouping (same author < 1 min), edited badges, context menus
- `Regexed`: regex-parsed message content (links, @mentions, custom emojis, embeds)
- Input with @mention autocomplete, custom emoji picker, file sharing
- `ChatSync`: persists/restores in-flight messages via SQLite

### Notes (`components/notes/`)
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

### Camera Upload (`components/cameraUpload/`)
- Sync status surface, error list

### Docx Preview (`components/docxPreview/`)
- WebView-based renderer for `.docx`

### Floating Bar (`components/floatingBar/`)
- `index` + `audioSlot` + `transfersSlot` + `animatedProgressBar` + `separator` — bottom bar above tabs showing active transfers and audio playback

### Background / Root-layout components
Mounted by the root `_layout.tsx`. Pattern: subscribe to a single concern, never render their own UI rows.
- `socket.tsx` — WebSocket event listener → syncs chat/note/contact events to queries/stores
- `http.tsx` — HTTP provider lifecycle (start on foreground, stop on background) for file serving
- `notes/sync.tsx`, `chats/sync.tsx` — in-flight content persistence + retry on AppState change
- `pathname.tsx` — syncs router pathname to `useApp` store
- `biometric.tsx` — full-screen lock overlay (`BiometricInner` + `Locked` countdown)
- `privacyCover.tsx` — app-switcher screenshot redactor
- `offlineBanner.tsx` — global offline indicator (single source of truth via `useIsOnline`)
- `accountReminders.tsx` — reminder badges (e.g. master keys not exported)
- `foregroundService.tsx` — Android foreground service for active transfers (notifee)
- `incomingShareHandler.tsx` — handles OS share-sheet incoming items
- `dismissStack.tsx` — utility component for closing nested modal stacks

### Transfers (`components/transfers.tsx`)
- Floating progress indicator: active count, speed (bps), progress bar
- Full transfers list in modal route

## Config

- **TypeScript**: strict (all flags), path aliases `@/` and `#/` → `src/`, `@/modules/` → `modules/`
- **ESLint**: flat config (v9), react-compiler: error, no relative imports (enforced), TanStack Query plugin, exhaustive-deps with `useMemoDeep`/`useCallbackDeep`. Submodule trees (`filen-rs/`, `filen-ios-file-provider/`, `filen-android-documents-provider/`) and `plugins/` are ignored.
- **Styling**: Tailwind CSS v4 + Uniwind, global.css with dark theme (OLED black #000000), iOS system color palette
- **Metro**: crypto/stream/path polyfills, Uniwind CSS + TS type generation
- **Babel**: babel-preset-expo + react-native-worklets/plugin
- **Testing**: Vitest (node env), path alias `@` → `./src`, react-native + expo-* modules mocked under `src/tests/mocks/`. Submodule trees excluded.
- **iOS**: deployment target **26.0**, app group `group.io.filen.app`, iCloud, 26 localizations, UIBackgroundModes: audio/fetch/processing, Apple team `7YTW5D2K7P`
- **Android**: min SDK **33**, target SDK **36**, compile SDK 36, build tools 36.0.0; 23 permissions (incl. MANAGE_DOCUMENTS for the documents provider, ACTION_OPEN_DOCUMENT/_TREE for incoming intents); Hermes; predictiveBackGestureEnabled: false; allowBackup: false
- **Stock Expo plugins** (in app.config.ts plugins array): expo-plugin-ios-static-libraries (op-sqlite), expo-build-properties, expo-router (typed routes + React compiler), expo-splash-screen, expo-video, expo-audio, expo-media-library, expo-document-picker, expo-image-picker, expo-local-authentication, expo-sqlite, expo-localization, expo-background-task, expo-secure-store, expo-navigation-bar, expo-asset, expo-sharing (with iOS app-group activation rules), expo-web-browser, expo-image, react-native-edge-to-edge, react-native-document-scanner-plugin, @config-plugins/react-native-blob-util
- **Custom Expo plugins** (`packages/filen-mobile/plugins/`):
  - `withOPSQLiteAppGroup.ts` — points op-sqlite at the iOS app group container for cross-process DB access
  - `withFileProvider.ts` — iOS File Provider Extension target + Rust xcframework build (cargo + uniffi-bindgen-swift + xcodebuild)
  - `withAndroidRustBuild.ts` — Android `.so` build via cargo-ndk + uniffi-bindgen Kotlin + manifest `<provider>` injection
  - `withAndroidArchitectures.ts` — pins `reactNativeArchitectures` to the ABIs the Rust cache targets (`arm64-v8a,x86_64`)
  - `withAndroidLargeHeapAndHardwareAcceleration.ts` — manifest tweaks
  - `withAndroidNetworkSecurityConfig.ts` — restrictive network security policy
  - `withGradleMemory.ts` — `org.gradle.jvmargs` for big native builds
  - `withNotifeeForegroundServiceType.ts` — notifee FGS type for transfers
- **Scripts**: `npm run verify` = lint + typecheck + test; `npm run clean` = `.expo/`; `npm run superclean` = `.expo/` + DerivedData + `.gradle/` + Rust target dirs; `npm run prebuild:clean` = clean + expo prebuild --clean; `npm run prebuild:ci:{ios,android}` = superclean + prebuild for one platform
- **patch-package**: applied via `scripts/postinstall.sh`. Patches in `patches/` cover xcode 3.0.1 (file-provider `addResourceFile` null guard) and expo-media-library version-bumped patches.
- **cargo-ndk** pinned to 3.5.4 for prebuild (bbqsrc/cargo-ndk#181 — see README)

## SDK Integration Patterns

```typescript
// Get authed SDK client
const { authedSdkClient } = await auth.getSdkClients()

// Wrap abort signals for SDK calls
const signal = wrapAbortSignalForSdk(abortController.signal)

// Composite signals for multi-step operations
const composite = createCompositeAbortSignal(signal1, signal2)

// Unwrap SDK tagged union types
const unwrapped = unwrapDirMeta(dir)  // → { meta, uuid, shared, linked, root, dir }
const unwrapped = unwrapFileMeta(file) // → { meta, shared, linked, root, file }

// Convert to app DriveItem type
const item = unwrappedDirIntoDriveItem(unwrapped)
const item = unwrappedFileIntoDriveItem(unwrapped)

// Normalize paths for SDK vs Expo vs BlobUtil
normalizeFilePathForSdk(path)   // → "/decoded/path"
normalizeFilePathForExpo(path)  // → "file:///encoded/path"

// Handle SDK errors
const sdkError = unwrapSdkError(error) // → FilenSdkError | null

// HTTP provider for file serving (video thumbnails, previews)
const { port, getFileUrl } = useHttpStore()
const url = getFileUrl(anyFile) // → http://localhost:{port}/...
```

## Import Rules

- **Always use `@/` aliases** — relative imports are forbidden by ESLint
- **Inline type imports**: `import { type Foo, Bar } from "..."` (not `import type`)
- **No trailing commas**, **no semicolons**, **double quotes**, **tabs**
- **No non-null assertion `!`** — handle null explicitly or use explicit `as Type` when the type is known to be non-null

## Key Architectural Patterns

- **Singleton factories** for all lib services (auth, drive, chats, notes, contacts, transfers, audio, fileCache, etc.) — exported as instance, never instantiated by callers
- **SDK delegation** — no crypto/API/networking reimplementation in JS; everything routes through `@filen/sdk-rs`
- **Silent infrastructure** — `src/lib/*` modules expose state, never fire banners/toasts. UX belongs in UI components.
- **Optimistic updates** via query updaters for instant UI feedback
- **Concurrency control** via Semaphores + composite abort/pause signals
- **Event-driven cache invalidation** via typed EventEmitter
- **Debounced persistence** for in-memory PersistentMap caches to SQLite
- **msgpackr serialization** with UniffiEnum extension for query/cache persistence
- **Focus-aware queries** — refetch on screen focus, pause off-screen re-renders
- **Online state via `useIsOnline`** — single source of truth bridged to TanStack `onlineManager` via `queries/onlineStatus.ts`. Don't read NetInfo directly in components.
- **Reconnect handler** (`src/lib/reconnect.ts`) — kicks deferred sync of camera upload, offline cache, notes, chats on every offline→online transition
- **Root overlay coordination** — Biometric/PrivacyCover lock paint; any new global side-effect must gate on `useAppStore.biometricUnlocked === true` AND `AppState === "active"` before firing
- **Storage roots** — `src/lib/storageRoots.ts` is the only place that constructs cache/offline/tmp paths. Reference its constants; don't compute paths inline.

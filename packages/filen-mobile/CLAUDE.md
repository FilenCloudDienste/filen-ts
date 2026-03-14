# filen-mobile

Encrypted cloud storage mobile app — Expo 55 / React Native 0.83.2 / React 19 / Hermes.
All server communication, encryption, and auth handled by Rust SDK (`@filen/sdk-rs@^0.4.4`).

## Architecture

```
Entry:  src/entry.ts → expo-router
Setup:  src/global.ts (crypto polyfill, Buffer, NetInfo)
        src/lib/setup.ts (auth check → SDK init → SQLite → restore query cache)

State:  Zustand stores (src/stores/)     → UI-only state (selections, input focus, etc.)
        TanStack Query (src/queries/)     → server data, persisted to SQLite via msgpackr
        Secure Store (src/lib/secureStore.ts) → encrypted secrets (expo-secure-store + MMKV fallback)
        Events (src/lib/events.ts)        → transient cross-component events (EventEmitter3)

SDK:    src/lib/auth.ts manages JsClientInterface (authed) + UnauthJsClientInterface
        src/lib/utils.ts wraps SDK types → unwrapDirMeta(), unwrapFileMeta(), wrapAbortSignalForSdk()
```

## Navigation (expo-router)

5 tabs: drive (`tabs/drive/[uuid]`), photos, notes, chats, more

Modal routes: `note/[uuid]`, `chat/[uuid]`, `transfers`, `contacts`, `driveItemInfo`,
`driveSelect/[uuid]`, `changeDirectoryColor`, `notesTags`, `trash`, `recents`,
`favorites/[uuid]`, `links/[uuid]`, `sharedIn/[uuid]`, `sharedOut/[uuid]`, `offline/[uuid]`,
`drivePreview` (containedTransparentModal with gallery preview)

```
routes/
├── _layout.tsx              root Stack + all modal screens
├── index.tsx                redirect → auth or drive based on auth state
├── transfers.tsx            pageSheet modal
├── auth/                    login flow
│   ├── _layout.tsx          redirects to drive if already authed
│   └── login.tsx
├── tabs/
│   ├── _layout.tsx          NativeTabs (expo-router/unstable-native-tabs)
│   ├── drive/[uuid].tsx     folder browser (renders <Drive />)
│   ├── photos/index.tsx     photo grid (5 per row, creationDesc sort)
│   ├── notes/index.tsx      note list (renders <Notes />)
│   ├── chats/index.tsx      chat list (renders <Chats />)
│   └── more/index.tsx       settings menu with links to modal routes
├── chat/[uuid].tsx          conversation view with messages + input
├── note/[uuid].tsx          note editor (markdown/richtext/code/checklist)
├── drivePreview/            full-screen gallery (images/video/audio/text)
├── driveItemInfo/           file/folder metadata sheet
├── changeDirectoryColor/    folder color picker (reanimated-color-picker)
├── contacts/                contact management + selection modal
├── driveSelect/[uuid].tsx   item selection for move/copy + DriveSelectToolbar
├── trash/                   reuses <Drive /> in trash context
├── recents/                 reuses <Drive /> in recents context
├── favorites/[uuid].tsx     reuses <Drive /> in favorites context
├── links/[uuid].tsx         reuses <Drive /> in links context
├── sharedIn/[uuid].tsx      reuses <Drive /> in sharedIn context
├── sharedOut/[uuid].tsx     reuses <Drive /> in sharedOut context
├── offline/[uuid].tsx       reuses <Drive /> in offline context + sync indicator
└── notesTags/               tag management (renders <Notes />)
```

Route params are packed with msgpackr + base64 (DriveItem, DrivePath, SelectOptions).
Programmatic selection: `selectDriveItems(options)`, `selectContacts(options)` → event-driven.

## Key Directories

```
src/routes/         expo-router screens
src/components/     UI components (drive/, chats/, notes/, textEditor/, ui/, itemIcons/)
src/stores/         Zustand stores (one per feature domain)
src/queries/        TanStack Query hooks + client setup
src/lib/            Core logic modules (see below)
src/hooks/          Custom hooks (useDrivePath, useNetInfo, useViewLayout, etc.)
src/providers/      Style provider (Tailwind/Uniwind theme), ActionSheet provider
src/assets/         Custom emojis (CDN-backed), app icons, splash images
```

## Lib Modules (src/lib/)

| Module | Purpose |
|-|-|
| `auth.ts` | SDK client init, login/logout, `useIsAuthed()` / `useSdkClients()` / `useStringifiedClient()` hooks |
| `drive.ts` | File ops: favorite, rename, move, delete, trash, restore, share, search, setDirColor, createDirectory, updateTimestamps |
| `transfers.ts` | Upload/download with progress, pause/resume, abort, error tracking, duplicate prevention via active ID sets |
| `offline.ts` | Offline file cache: store, sync, list, index management (FileOrDirectoryOfflineMeta) |
| `chats.ts` | Send/edit/delete messages, typing indicators, mark read, create/leave/delete chats, Semaphore-protected refetch |
| `notes.ts` | CRUD, content editing, tags, participants, history, export (single .txt / bulk .zip via JSZip) |
| `contacts.ts` | Requests (accept/deny/cancel/send), block/unblock, delete |
| `cameraUpload.ts` | Auto media sync, EXIF dates, dedup via xxHash32 (6-iteration collision resolution), compression |
| `thumbnails.ts` | Thumbnail generation: images (ImageManipulator resize) + videos (HTTP provider → expo-video), Semaphore(3) concurrency, max 3 failures per item |
| `cache.ts` | PersistentMap<V> (extends Map with debounced SQLite persistence): uuid→DriveItem, uuid→dir/note/chat, availableThumbnails |
| `secureStore.ts` | Encrypted KV (expo-secure-store + MMKV fallback), AES-256-GCM encryption, event-driven cache invalidation |
| `sqlite.ts` | SQLite KV for query persistence, WAL mode, 32MB mmap, 8MB cache, app group directory (iOS) |
| `msgpack.ts` | Custom msgpackr with UniffiEnum extension (type 0x75), BigInt support, Symbol preservation |
| `utils.ts` | SDK type unwrapping, path normalization (SDK/Expo/BlobUtil), sanitizeFileName, getPreviewType, PauseSignal, composite signals |
| `sort.ts` | ItemSorter (name/size/mime/date, dirs-first, numeric-aware) + NotesSorter (pinned/archived/time-bucketed groups) |
| `time.ts` | Fast date/time formatting (Hermes-optimized, no Intl.DateTimeFormat), locale-aware YMD/MDY/DMY |
| `events.ts` | Typed EventEmitter (secureStore, actionSheet, driveSelect, contactsSelect, chatConversationDeleted, noteContentEdited, etc.) |
| `prompts.ts` | Native alert/input dialogs (@blazejkustra/react-native-alert) |
| `alerts.tsx` | Toast notifications (Burnt) and error banners (Notifier) with FilenSdkError unwrapping |
| `setup.ts` | App init: auth check → SDK → SecureStore → SQLite → restore queries → restore cache (Semaphore-protected) |
| `fileProvider.ts` | iOS/Android document provider bridge: writes auth.json config to app group for native file providers |
| `memo.ts` | Custom memo/useCallback/useMemo with deep equality (react-fast-compare) in prod, standard React in dev |
| `exif.ts` | EXIF date parsing (DateTimeOriginal/Digitized/DateTime + SubSec + Offset) + orientation from raw bytes (JPEG/TIFF/HEIC/WebP) |

## Hooks (src/hooks/)

| Hook | Signature | Purpose |
|-|-|-|
| `useDrivePath` | `() => DrivePath` | Parses route + URL params → {type, uuid, selectOptions} |
| `useNetInfo` | `() => {hasInternet, isConnected, isInternetReachable, isWifiEnabled}` | Wraps @react-native-community/netinfo |
| `useViewLayout` | `(ref) => {layout, onLayout}` | Tracks View dimensions via onLayout/measureInWindow |
| `useHeaderHeight` | `(cacheKey?) => number` | Header height from @react-navigation/elements, optionally cached to SecureStore |
| `useChatUnreadCount` | `(chat) => number` | Unread messages for a single chat |
| `useChatsUnreadCount` | `() => number` | Total unread across all chats, refetches on app resume |
| `useDomDomEvents` | `(onMessage?) => {postMessage, onNativeMessage}` | WebView↔Native messaging for DOM components |
| `useNativeDomEvents` | `({onMessage, ref}) => {onDomMessage, postMessage}` | Native↔DOM messaging for Expo DOM integration |
| `useEffectOnce` | `(effect) => void` | Runs effect callback once per component lifetime |

## Stores (src/stores/)

| Store | Key State |
|-|-|
| `useApp` | pathname |
| `useDrive` | selectedItems: DriveItem[] |
| `useDriveSelect` | selectedItems: DriveItem[] (for move/copy modal) |
| `useTransfers` | transfers[] (progress, speed, errors, abort/pause controls) + stats (aggregated metrics with interval timer) |
| `useChats` | inputViewLayout, inputSelection, suggestionsVisible, inputFocused, typing, inflightMessages, inflightErrors, selectedChats |
| `useNotes` | inflightContent, activeNote, activeTag, selectedNotes, selectedTags |
| `useContacts` | selectedContacts: ContactListItem[] |
| `useOffline` | syncing: boolean |
| `useCameraUpload` | syncing, errors |
| `useSocket` | state: "connected" \| "disconnected" \| "reconnecting" |
| `useHttp` | port: number \| null, getFileUrl: (file: AnyFile) => string (subscribeWithSelector middleware) |
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
| `useChatsQuery` | — | Chat[] |
| `useChatMessagesQuery` | {uuid} | ChatMessageWithInflightId[] |
| `useChatsUnreadQuery` | — | BigInt (total unread) |
| `useChatPublicLinkQuery` | {link} | Chat[] |
| `useNotesWithContentQuery` | — | (Note & {content})[] |
| `useNoteContentQuery` | {uuid} | string |
| `useNoteHistoryQuery` | {uuid} | NoteHistory[] |
| `useNotesTagsQuery` | — | NoteTag[] |
| `useContactsQuery` | — | {contacts, blocked} |
| `useContactRequestsQuery` | — | {incoming, outgoing} |

`client.ts` exports: `QueryUpdater` class (get/set cache), `queryUpdater` singleton, `useDefaultQueryParams`,
`useFocusNotifyOnChangeProps`, `useQueryFocusAware`, `useRefreshOnFocus`, `onlineStatus` (NetInfo→onlineManager).
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
- `Menu` — iOS (react-native-ios-context-menu) + Android (@react-native-menu/menu), 25 icon types
- `VirtualList` — FlashList wrapper with search bar, pull-to-refresh, grid mode, header height caching
- `ZoomableView` — pinch/pan/double-tap zoom with worklet-driven gestures, pinch-to-dismiss
- `FullScreenLoadingModal` — event-driven overlay, `runWithLoading(fn)` utility
- `SafeAreaView`, `AnimatedView`, `Button`, `Checkbox`

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
- `TextEditorDOM`: CodeMirror via WebView (markdown/code, 20+ language syntaxes)
- `RichTextEditorDOM`: Quill.js via WebView (bold/italic/underline/headers/lists/code/links)
- `RichTextEditorToolbar`: format action buttons synced to Quill state via `useRichtext` store

### Background Components (in root layout)
- `Socket`: WebSocket event listener → syncs chat/note/contact events to queries/stores
- `Http`: HTTP provider lifecycle (start on foreground, stop on background) for file serving
- `NotesSync` + `ChatSync`: in-flight content persistence
- `Pathname`: syncs router pathname to `useApp` store

### Transfers (`components/transfers.tsx`)
- Floating progress indicator: active count, speed (bps), progress bar
- Full transfers list in modal route

## Config

- **TypeScript**: strict (all flags), path aliases `@/` and `#/` → `src/`, `@/modules/` → `modules/`
- **ESLint**: flat config (v9), react-compiler: error, no relative imports (enforced), TanStack Query plugin, exhaustive-deps with `useMemoDeep`/`useCallbackDeep`
- **Styling**: Tailwind CSS v4 + Uniwind, global.css with dark theme (OLED black #000000), iOS system color palette
- **Metro**: crypto/stream/path polyfills, Uniwind CSS + TS type generation
- **Babel**: babel-preset-expo + react-native-worklets/plugin
- **Testing**: Vitest (node env), path alias @ → ./src, react-native mocked
- **iOS**: deployment target 18.0, app group `group.io.filen.app`, iCloud, 26 localizations, UIBackgroundModes: audio/fetch/processing
- **Android**: SDK 31-36, 21 permissions, Hermes, predictive back disabled
- **Expo plugins**: expo-build-properties, expo-router (typed routes + React compiler), expo-splash-screen, expo-video, expo-sqlite, expo-localization, expo-background-task, expo-audio, expo-secure-store, expo-navigation-bar, react-native-edge-to-edge
- **Scripts**: `npm run verify` = lint + typecheck + test; `npm run clean` = .expo/; `npm run superclean` = .expo/ + DerivedData + .gradle + ./rust/

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

## Key Architectural Patterns

- **Singleton factories** for all lib services (auth, drive, chats, notes, contacts, transfers, etc.)
- **SDK delegation** — no crypto/API reimplementation in JS
- **Optimistic updates** via query updaters for instant UI feedback
- **Concurrency control** via Semaphores + composite abort/pause signals
- **Event-driven cache invalidation** via typed EventEmitter
- **Debounced persistence** for in-memory PersistentMap caches to SQLite
- **msgpackr serialization** with UniffiEnum extension for query/cache persistence
- **Focus-aware queries** — refetch on screen focus, pause off-screen re-renders

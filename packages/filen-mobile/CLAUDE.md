# filen-mobile

Encrypted cloud storage mobile app — Expo 55 / React Native 0.83.2 / React 19 / Hermes.
All server communication, encryption, and auth handled by Rust SDK (`@filen/sdk-rs@^0.4.0`).

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
`favorites/[uuid]`, `links/[uuid]`, `sharedIn/[uuid]`, `sharedOut/[uuid]`, `offline/[uuid]`

## Key Directories

```
src/routes/         expo-router screens
src/components/     UI components (drive/, chats/, notes/, textEditor/, ui/, itemIcons/)
src/stores/         Zustand stores (one per feature domain)
src/queries/        TanStack Query hooks + client setup
src/lib/            Core logic modules (see below)
src/hooks/          Custom hooks (useDrivePath, useNetInfo, useViewLayout, etc.)
src/providers/      Style provider (Tailwind/Uniwind theme), ActionSheet provider
src/assets/         Custom emojis, file type SVG icons
```

## Lib Modules (src/lib/)

| Module | Purpose |
|-|-|
| `auth.ts` | SDK client init, login, `useIsAuthed()` hook |
| `drive.ts` | File ops: favorite, rename, move, delete, trash, restore, share, search |
| `transfers.ts` | Upload/download with progress, pause/resume, abort, error tracking |
| `offline.ts` | Offline file cache: store, sync, list, index management |
| `chats.ts` | Send/edit/delete messages, typing indicators, mark read |
| `notes.ts` | CRUD, content editing, tags, participants, history, export |
| `contacts.ts` | Requests, block/unblock, add/remove |
| `cameraUpload.ts` | Auto media sync, EXIF dates, dedup via xxHash32, compression |
| `cache.ts` | In-memory caches: uuid→DriveItem, uuid→dir/note/chat |
| `secureStore.ts` | Encrypted KV (expo-secure-store + MMKV), event-driven cache invalidation |
| `sqlite.ts` | SQLite KV for query persistence, WAL mode |
| `utils.ts` | SDK type unwrapping, path normalization, abort/pause signal wrappers |
| `sort.ts` | Item sorting by name/size/date with locale-aware comparison |
| `time.ts` | Fast date/time formatting (Hermes-optimized, no Intl.DateTimeFormat) |
| `events.ts` | Typed EventEmitter (secureStore, actionSheet, driveSelect, etc.) |
| `prompts.ts` | Native alert/input dialogs |
| `alerts.tsx` | Toast notifications (Burnt) and error banners (Notifier) |
| `setup.ts` | App init: auth check → SDK → SQLite → restore queries |
| `fileProvider.ts` | iOS/Android document provider integration |
| `memo.ts` | Custom memo/useCallback/useMemo with deep equality (react-fast-compare) |
| `exif.ts` | EXIF date parsing from media assets |

## Stores (src/stores/)

| Store | Key State |
|-|-|
| `useApp` | pathname |
| `useDrive` | selectedItems |
| `useDriveSelect` | selectedItems (for move/copy modal) |
| `useTransfers` | transfers[] (progress, speed, errors, abort/pause controls) |
| `useChats` | inputLayout, typing, inflightMessages, inflightErrors, selectedChats |
| `useNotes` | inflightContent, activeNote, activeTag, selectedNotes, selectedTags |
| `useContacts` | selectedContacts |
| `useOffline` | syncing |
| `useCameraUpload` | syncing, errors |
| `useSocket` | state (connected/disconnected/reconnecting) |
| `useChecklist` | parsed items, inputRefs, ids |
| `useRichtext` | active Quill formats |
| `useTextEditor` | ready |

## Queries (src/queries/)

All use `BASE_QUERY_KEY` prefix, `fetchData` pattern, SQLite persistence.

| Query | Params | Returns |
|-|-|-|
| `useDriveItems` | path (type, uuid) | DriveItem[] |
| `useDirectorySize` | uuid, type | { size, files, dirs } |
| `useDriveItemVersions` | uuid | FileVersion[] |
| `useDriveItemStoredOffline` | uuid, type | boolean |
| `useChats` | — | Chat[] |
| `useChatMessages` | uuid | ChatMessage[] (with inflightId) |
| `useChatsUnread` | — | unread count |
| `useChatPublicLink` | link | link metadata |
| `useNotesWithContent` | — | (Note & { content })[] |
| `useNoteContent` | uuid | string |
| `useNoteHistory` | uuid | NoteHistory[] |
| `useNotesTags` | — | NoteTag[] |
| `useContacts` | — | { contacts, blocked } |
| `useContactRequests` | — | { incoming, outgoing } |

`client.ts` also exports: `queryUpdater()` for manual cache updates, `useFocusNotifyOnChangeProps` / `useQueryFocusAware` for focus-aware refetching.

## Component Patterns

- **UI base** (`components/ui/`): view, text, header, button, pressables (haptic via Pressto), image (expo-image), avatar, checkbox, menu, virtualList (FlashList wrapper)
- **Drive** (`components/drive/`): item list with sorting/selection, item row with date/size, context menu (rename, delete, favorite, share, move, offline, info)
- **Chats** (`components/chats/`): chat list, message bubbles, input with mentions, sync component
- **Notes** (`components/notes/`): note list with tags, content editors (markdown/rich/checklist), tag management
- **Text editors** (`components/textEditor/`): CodeMirror (markdown), Quill (rich text), checklist — all via WebView DOM components
- **Background** (in root layout): Socket, NotesSync, ChatsSync, Pathname tracker

## Config

- **TypeScript**: strict, path aliases `@/` and `#/` → `src/`
- **ESLint**: flat config (v9), react-compiler: error, no relative imports (enforced), TanStack Query plugin
- **Styling**: Tailwind CSS v4 + Uniwind, global.css with dark theme (OLED black #000000)
- **Metro**: buffer/crypto/stream/path polyfills, Uniwind CSS integration
- **Babel**: babel-preset-expo + react-native-worklets/plugin
- **Testing**: Vitest (node env), path alias @ → ./src
- **iOS**: deployment target 18.0, app group for file provider, iCloud enabled
- **Android**: SDK 31-36, 21 permissions, Hermes

## SDK Integration Patterns

```typescript
// Get authed SDK client
const client = await auth.getSdkClients()

// Wrap abort signals for SDK calls
const signal = wrapAbortSignalForSdk(abortController.signal)

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
```

## Import Rules

- **Always use `@/` aliases** — relative imports are forbidden by ESLint
- **Inline type imports**: `import { type Foo, Bar } from "..."` (not `import type`)
- **No trailing commas**, **no semicolons**, **double quotes**, **tabs**

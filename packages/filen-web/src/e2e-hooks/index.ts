import { type } from "arktype"
import * as Comlink from "comlink"
import { createNotePreviewFromContentText } from "@filen/utils"
import type { StringifiedClient, File, Note, NoteType, DirMeta, FileMeta } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { stringifyEnvelope } from "@/lib/serialize"
import { kvGetJson, kvHas, kvSetJson } from "@/lib/storage/adapter"
import { comboFor, setUserCombo } from "@/lib/keymap/registry"
import { whenBootReady } from "@/lib/sdk/boot"
import { readThumbnailBlob } from "@/features/drive/lib/thumbCache"
import { inflightContentSchema } from "@/features/notes/lib/sync.logic"
import { latestInflightContent } from "@/features/notes/hooks/useNoteEditor.logic"
import { enqueueChatMessage } from "@/features/chats/lib/sync"
import { inflightChatMessagesSchema } from "@/features/chats/lib/sync.logic"
import { chatsQueryUpsert, chatsQueryGet } from "@/features/chats/queries/chats"
import { isScratchDebrisName } from "@/e2e-hooks/scratchDebris"

// Test-only hooks, loaded ONLY when the app is built with VITE_E2E=1 (a dynamic import behind that
// env condition in main.tsx, so a normal build dead-code-eliminates this whole module — proven by
// the no-flag build grep). Nothing here ships to production.
//
// The e2e harness never types credentials or the session blob into the UI: it logs in once
// (`mint`), stores the resulting blob to a file, and re-seeds it on later loads via sessionStorage,
// which bootSdk drains into kv before its own resumeSession (@/lib/sdk/boot). The blob carries
// a bigint (`StringifiedClient.userId`), so it always travels as an envelope STRING (@/lib/serialize),
// never raw JSON.

// Test kv probes go through the normal adapter, which requires an arktype schema on read.
const stringSchema = type("string")

// Age gate shared by the debris sweeps below. Without `minAgeMs` everything matched is removed (an
// in-test teardown sweeps what it just created); with it, only items older than that window are — the
// pre-run cleanup passes one so a CONCURRENTLY running suite's live fixtures can never match.
function olderThan(minAgeMs: number | undefined): (timestamp: bigint) => boolean {
	if (minAgeMs === undefined) {
		return () => true
	}

	const cutoff = Date.now() - minAgeMs

	return timestamp => Number(timestamp) <= cutoff
}

interface E2eHooks {
	// Logs in and returns the session blob as an envelope string (bigint-safe, ready to persist).
	// Documented fallback for auth-setup's real-form login (see auth.setup.ts) — kept working in case
	// the form path ever proves too flaky to drive from Playwright.
	mint: (email: string, password: string) => Promise<string>
	// Re-stringifies the WORKER'S currently-live client (not the kv copy — see dumpSession) into the
	// same envelope-string shape mint returns. Used by auth-setup to harvest the session after driving
	// the real login form, so the harness gets genuine UI coverage from the one login the budget allows.
	dumpSession: () => Promise<string>
	// A single authenticated read against the API — proves an injected session actually authenticates.
	probeAuthedRead: () => Promise<boolean>
	kvSet: (key: string, value: string) => Promise<void>
	kvGet: (key: string) => Promise<string | null>
	// Raw existence check, independent of schema — kvGet/kvGetJson return null for BOTH "absent" and
	// "present but the wrong shape for the schema this hook happens to validate with", which makes
	// kvGet useless for proving a key is genuinely gone (e.g. asserting a wipe) unless the caller also
	// holds that exact schema. Used by auth.spec's logout test to check the session key without
	// depending on sessionSchema.
	kvHas: (key: string) => Promise<boolean>
	setUserCombo: (actionId: string, combo: string) => Promise<void>
	comboFor: (actionId: string) => string
	// Raw (non-enveloped) client blob for handing straight to the service worker's own
	// SW_MSG_INIT_CLIENT handshake from inside a page.evaluate callback — bigint fields survive the
	// postMessage structured clone there, unlike the JSON-only Playwright<->page bridge dumpSession is
	// stringified for. Used by the sw zip e2e case, which drives the SW protocol directly rather than
	// through a real Download click (Chromium's File System Access API would otherwise take the fsa
	// branch, the one path that can never reach the sw route under test).
	rawStringifiedClient: () => Promise<StringifiedClient>
	// Uploads one small real file through the real worker path (no UI) and returns the resulting File
	// record — gives the sw zip e2e case real, live-downloadable ZipItems without depending on whatever
	// the shared e2e account happens to already hold. `parentUuid` defaults to the drive root; callers
	// nesting inside a scratch directory (net-zero on the shared account) pass its uuid explicitly.
	createTestFile: (name: string, content: string, parentUuid?: string | null) => Promise<File>
	// Trashes a File this hook created — keeps the shared e2e account net-zero after a test run.
	trashTestFile: (file: File) => Promise<void>
	// Permanently removes a note by uuid — trashes then deletes — keeping the shared e2e account
	// net-zero after a UI-driven create smoke test, bypassing the trash/delete menu UI for a faster,
	// more direct teardown. No-op when the uuid isn't found.
	deleteTestNoteByUuid: (uuid: string) => Promise<void>
	// Creates a note, switches it to `noteType` (a no-op for the SDK's own "text" default), writes
	// `content` with a matching preview, and renames it to `title` — the worker seam every read-only
	// reader test drives content through, bypassing the editor UI so a test can seed content directly
	// without depending on keystroke timing or the sync debounce. `title` is a distinctive string a spec can locate in the
	// sidebar via the search box (rather than depending on the SDK's own default title, which carries
	// no test-chosen identity). Returns the final Note row for the caller to navigate to and later pass
	// to deleteTestNoteByUuid for net-zero teardown.
	createTestNoteWithContent: (noteType: NoteType, content: string, title: string) => Promise<Note>
	// Fresh server read of a note's content by uuid, bypassing every client cache — lists notes, finds
	// the uuid, decrypts its content. The editor-persistence e2e cases poll this to prove a typed edit
	// actually reached the server after the debounce fired. Null when the uuid isn't found.
	readTestNoteContentByUuid: (uuid: string) => Promise<string | null>
	// Writes a note's content by uuid through THIS page's own SDK client — a genuine REMOTE edit from the
	// perspective of a second page sharing the same account (the realtime e2e drives one page's editor and
	// the other page's write). No-op when the uuid isn't found.
	setTestNoteContentByUuid: (uuid: string, content: string) => Promise<void>
	// Renames a note by uuid through THIS page's own SDK client — the metadata counterpart of
	// setTestNoteContentByUuid, used to prove a titleEdited socket event lands live on the other page's
	// sidebar row + editor header. No-op when the uuid isn't found.
	renameTestNoteByUuid: (uuid: string, title: string) => Promise<void>
	// The latest DURABLE (OPFS) outbox content for a note, read straight from the kv store the sync
	// outbox persists to — proves the immediate-persist landed on disk BEFORE a reload, the crux of the
	// kill-path proof (survives window close). Null when nothing is persisted for the uuid.
	readPersistedInflightContent: (uuid: string) => Promise<string | null>
	// Every note uuid currently on the account — the seam for the specs' leak guard: a UI-create test
	// that fails BEFORE it learns its new note's uuid (a slow create's waitForURL timeout) can still
	// sweep exactly what it created by diffing this snapshot before/after (serial mode guarantees any
	// new uuid belongs to the running test). Default-titled notes never match the debris prefixes, so
	// the cleanup-setup sweep cannot catch this class.
	listTestNoteUuids: () => Promise<string[]>
	// Defensive sweep, same rationale as e2e/setup/cleanup.setup.ts's drive-side scratch-debris sweep:
	// the FREE e2e account's note cap is a hard 10 (server-enforced `note_limit_reached`), far tighter
	// than drive's storage quota, so ANY spec that dies before its own teardown compounds into real,
	// suite-wide failures far sooner than a stray drive item would. Trashes+deletes every note whose
	// title starts with `prefix`. Returns the count removed.
	// `minAgeMs` age-gates the match against `Note.createdTimestamp` — see olderThan.
	sweepTestNotesByTitlePrefix: (prefix: string, minAgeMs?: number) => Promise<number>
	// Tag counterpart: a spec that dies between creating its tag and deleting it leaves the tag behind
	// (tags survive their notes — deleting a note never deletes the tags on it). Returns the count.
	// `minAgeMs` age-gates the match against `NoteTag.createdTimestamp` — see olderThan.
	sweepTestTagsByNamePrefix: (prefix: string, minAgeMs?: number) => Promise<number>
	// Drive-side counterpart to the note/tag sweeps above, and for the same reason: doing this through
	// the UI meant rendering a debris-heavy listing, defeating a virtualizer with a tall viewport, and
	// driving a select/confirm/toast cycle per row inside a wall-clock budget that was not enforced
	// inside a round. Every write-lane spec brackets itself with a scratch directory, so a run leaves
	// ~22 of them plus the fixture tree behind; a UI sweep could not keep up, and said so in a log line
	// nothing read. `target` picks the surface: "root" moves matches to trash, "trash" deletes them
	// permanently. Matching is isScratchDebrisName — the SAME anchored predicate the UI sweep used, so
	// the safety argument is unchanged. Returns the count removed.
	// `minAgeMs` age-gates the match against the row's own `timestamp` (server-set at creation, and
	// unchanged by a trash, so the trash listing carries the same value) — see olderThan.
	sweepTestDriveDebris: (target: "root" | "trash", limit: number, minAgeMs?: number) => Promise<number>
	// Reads one cached thumbnail's on-disk size + write time, found by file name inside a parent
	// directory. The only way to prove a repaint after a real page reload came from the existing OPFS
	// cache entry rather than a fresh generation: a regenerate rewrites the file (a new
	// lastModified), a cache hit never touches the write path. Null when the file or its cache entry
	// doesn't exist.
	thumbnailFileStat: (parentUuid: string, name: string) => Promise<{ size: number; lastModified: number } | null>
	// Creates a ZERO-participant self-chat (createChat([]) — backend-accepted) and immediately renames
	// it "e2e-chat-<ts>" so a leak is sweepable by prefix. The one way to get a real conversation on the
	// zero-contacts shared account; the send outbox's real round-trip + kill-path replay are proven
	// against it. Returns the renamed Chat's uuid for teardown.
	createTestSelfChat: () => Promise<string>
	// Permanently removes a conversation by uuid (owner delete) — keeps the shared account net-zero.
	// No-op when the uuid isn't found.
	deleteTestChatByUuid: (uuid: string) => Promise<void>
	// Every conversation uuid currently on the account — the leak-guard seam (diff before/after a
	// create, sweep any new uuid under serial mode).
	listTestChatUuids: () => Promise<string[]>
	// Fresh server read (bypassing every client cache — a full listChats) of a conversation's last
	// message text by uuid. The real-send + kill-path cases poll this to prove a queued message
	// actually reached the server. Null when the uuid isn't found or the chat has no message yet.
	readTestChatLastMessage: (uuid: string) => Promise<string | null>
	// Fresh server read (bypassing every client cache) of every message text in a conversation, via a
	// full listMessagesBefore(now + 1h). The kill-path proof counts how many copies of a text landed —
	// the temporal-dedupe "exactly one" assertion. Empty array when the uuid isn't found.
	readTestChatMessageTexts: (uuid: string) => Promise<string[]>
	// Drives the SEND OUTBOX transport directly, bypassing the composer UI: resolves the chat + the
	// current user, then enqueues through the same optimistic-persist-then-push path the composer
	// itself uses. Returns the persist result. This is the outbox intake the durability + kill-path proofs
	// exercise. No-op-false when the uuid isn't found.
	enqueueTestChatMessage: (chatUuid: string, content: string) => Promise<boolean>
	// The DURABLE (OPFS) send-outbox contents for a chat, read straight from the kv store the outbox
	// persists to — proves the immediate-persist landed on disk BEFORE a reload (the survives-close
	// crux). Returns the queued message texts, or null when nothing is persisted for the uuid.
	readPersistedInflightChatMessages: (chatUuid: string) => Promise<string[] | null>
	// Defensive sweep (cleanup.setup.ts): deletes every conversation whose name starts with `prefix`.
	// Returns the count removed.
	// `minAgeMs` age-gates the match against `Chat.created` — see olderThan.
	sweepTestChatsByNamePrefix: (prefix: string, minAgeMs?: number) => Promise<number>
	// Fires a realtime typing signal ("down"/"up") for a chat — the seam a second page drives so the
	// first page's typing indicator can be exercised end-to-end. No-op when the uuid isn't found.
	sendTestTypingSignal: (chatUuid: string, signalType: "up" | "down") => Promise<void>
}

declare global {
	interface Window {
		__filenE2E?: E2eHooks
	}
}

export function installE2eHooks(): void {
	window.__filenE2E = {
		mint: async (email, password) => {
			await whenBootReady()

			return stringifyEnvelope(await sdkApi.login({ email, password }))
		},
		dumpSession: async () => {
			await whenBootReady()

			return stringifyEnvelope(await sdkApi.toStringified())
		},
		probeAuthedRead: () => sdkApi.probeAuthedRead(),
		kvSet: (key, value) => kvSetJson(key, value),
		kvGet: key => kvGetJson(key, stringSchema),
		kvHas: key => kvHas(key),
		setUserCombo: (actionId, combo) => setUserCombo(actionId, combo),
		comboFor: actionId => comboFor(actionId),
		rawStringifiedClient: async () => {
			await whenBootReady()

			return sdkApi.toStringified()
		},
		createTestFile: async (name, content, parentUuid = null) => {
			await whenBootReady()

			return sdkApi.uploadFile(
				parentUuid,
				crypto.randomUUID(),
				new File([content], name, { type: "text/plain" }),
				Comlink.proxy(() => undefined)
			)
		},
		trashTestFile: async file => {
			await sdkApi.trashFile(file)
		},
		deleteTestNoteByUuid: async uuid => {
			await whenBootReady()

			const note = (await sdkApi.listNotes()).find(n => n.uuid === uuid)

			if (note === undefined) {
				return
			}

			// deleteNote is permanent; trash first so a note in any lifecycle state is removable.
			await sdkApi.deleteNote(await sdkApi.trashNote(note))
		},
		createTestNoteWithContent: async (noteType, content, title) => {
			await whenBootReady()

			let note = await sdkApi.createNote()

			// The SDK creates every note as "text" by default — only switch when a different type was
			// asked for. `knownContent` is omitted: the fresh note has no content yet, so there is
			// nothing meaningful to pass, and the SDK resolves it itself.
			if (noteType !== "text") {
				note = await sdkApi.setNoteType(note, noteType)
			}

			const previewType = noteType === "rich" || noteType === "checklist" ? noteType : "other"

			note = await sdkApi.setNoteContent(note, content, createNotePreviewFromContentText(previewType, content))
			note = await sdkApi.setNoteTitle(note, title)

			return note
		},
		readTestNoteContentByUuid: async uuid => {
			await whenBootReady()

			const note = (await sdkApi.listNotes()).find(n => n.uuid === uuid)

			if (note === undefined) {
				return null
			}

			return (await sdkApi.getNoteContent(note)) ?? null
		},
		setTestNoteContentByUuid: async (uuid, content) => {
			await whenBootReady()

			const note = (await sdkApi.listNotes()).find(n => n.uuid === uuid)

			if (note === undefined) {
				return
			}

			const previewType = note.noteType === "rich" || note.noteType === "checklist" ? note.noteType : "other"

			await sdkApi.setNoteContent(note, content, createNotePreviewFromContentText(previewType, content))
		},
		renameTestNoteByUuid: async (uuid, title) => {
			await whenBootReady()

			const note = (await sdkApi.listNotes()).find(n => n.uuid === uuid)

			if (note === undefined) {
				return
			}

			await sdkApi.setNoteTitle(note, title)
		},
		readPersistedInflightContent: async uuid => {
			await whenBootReady()

			const outbox = await kvGetJson("inflightNoteContent", inflightContentSchema)

			if (outbox === null) {
				return null
			}

			return latestInflightContent(outbox[uuid])
		},
		listTestNoteUuids: async () => {
			await whenBootReady()

			return (await sdkApi.listNotes()).map(note => note.uuid)
		},
		sweepTestNotesByTitlePrefix: async (prefix, minAgeMs) => {
			await whenBootReady()

			const isOldEnough = olderThan(minAgeMs)
			const matches = (await sdkApi.listNotes()).filter(n => (n.title ?? "").startsWith(prefix) && isOldEnough(n.createdTimestamp))

			for (const note of matches) {
				// deleteNote is permanent; trash first so a note in any lifecycle state is removable.
				// Sequential (not Promise.all): a bulk sweep racing many notes through the same worker
				// gains nothing from parallelism here and is easier to reason about mid-failure.
				await sdkApi.deleteNote(await sdkApi.trashNote(note))
			}

			return matches.length
		},
		sweepTestTagsByNamePrefix: async (prefix, minAgeMs) => {
			await whenBootReady()

			const isOldEnough = olderThan(minAgeMs)
			const matches = (await sdkApi.listNoteTags()).filter(
				tag => (tag.name ?? "").startsWith(prefix) && isOldEnough(tag.createdTimestamp)
			)

			for (const tag of matches) {
				// Sequential for the same reason as the note sweep above.
				await sdkApi.deleteNoteTag(tag)
			}

			return matches.length
		},
		sweepTestDriveDebris: async (target, limit, minAgeMs) => {
			await whenBootReady()

			// A row whose meta did not decode carries no name to match, so it can never be debris by this
			// predicate — and must never be swept on a guess.
			const nameOf = (meta: DirMeta | FileMeta): string => (meta.type === "decoded" ? meta.data.name : "")
			const listing = await sdkApi.listDirectory({ kind: target })
			// Batched: the caller re-invokes until a short batch comes back, so a backlog is drained
			// across several calls and each one stays bounded. The first real run of this cleared 1,224
			// trash rows the UI sweep had never been able to reach — a single unbounded call would have
			// run for as long as that took, with the project timeout as its only limit.
			const isOldEnough = olderThan(minAgeMs)
			const matched = [
				...listing.dirs
					.filter(d => isScratchDebrisName(nameOf(d.meta)) && isOldEnough(d.timestamp))
					.map(d => ({ kind: "dir" as const, item: d })),
				...listing.files
					.filter(f => isScratchDebrisName(nameOf(f.meta)) && isOldEnough(f.timestamp))
					.map(f => ({ kind: "file" as const, item: f }))
			].slice(0, limit)

			// Sequential, like the note sweep: these all serialise on the account-wide drive lock
			// anyway, so firing them together only makes a mid-failure state harder to read. Each
			// removal is independently guarded — one undeletable row must not strand the rest, which is
			// the whole reason the previous UI sweep kept running out of budget.
			let removed = 0

			for (const entry of matched) {
				try {
					if (entry.kind === "dir") {
						await (target === "trash" ? sdkApi.deleteDirectoryPermanently(entry.item) : sdkApi.trashDirectory(entry.item))
					} else {
						await (target === "trash" ? sdkApi.deleteFilePermanently(entry.item) : sdkApi.trashFile(entry.item))
					}

					removed++
				} catch {
					// Left for the next run; the caller reports the shortfall. One undeletable row must
					// never strand the rest — that is what kept the old sweep permanently behind.
				}
			}

			return removed
		},
		thumbnailFileStat: async (parentUuid, name) => {
			await whenBootReady()

			// listDirectory returns raw SDK File records, not app-level DriveItems — meta arrives as the
			// tagged union (mirrors features/drive/lib/item.ts's own narrowItem extraction) rather than the
			// pre-narrowed decryptedMeta field the drive UI reads.
			const { files } = await sdkApi.listDirectory({ kind: "uuid", uuid: parentUuid })
			const file = files.find(f => f.meta.type === "decoded" && f.meta.data.name === name)

			if (file === undefined) {
				return null
			}

			const blob = await readThumbnailBlob(file.uuid)

			if (blob === null) {
				return null
			}

			// size/lastModified live on the runtime File the store's own getFile() returns; the read
			// side's own return type widens it to Blob, so the extra field is asserted here rather than
			// imported (avoids shadowing this file's own SDK File type import above).
			const stat = blob as Blob & { lastModified: number }

			return { size: stat.size, lastModified: stat.lastModified }
		},
		createTestSelfChat: async () => {
			await whenBootReady()

			// Zero participants is backend-accepted; rename immediately so a leaked conversation is
			// sweepable by the "e2e-chat-" prefix.
			const chat = await sdkApi.createChat([])
			const renamed = await sdkApi.renameChat(chat, `e2e-chat-${String(Date.now())}`)

			// Seed the list cache so enqueueTestChatMessage can resolve the chat WITHOUT a network read
			// (the kill-path drives the outbox while offline, where listChats would hang).
			chatsQueryUpsert(renamed)

			return renamed.uuid
		},
		deleteTestChatByUuid: async uuid => {
			await whenBootReady()

			const chat = (await sdkApi.listChats()).find(c => c.uuid === uuid)

			if (chat === undefined) {
				return
			}

			await sdkApi.deleteChat(chat)
		},
		listTestChatUuids: async () => {
			await whenBootReady()

			return (await sdkApi.listChats()).map(chat => chat.uuid)
		},
		readTestChatLastMessage: async uuid => {
			await whenBootReady()

			const chat = (await sdkApi.listChats()).find(c => c.uuid === uuid)

			return chat?.lastMessage?.message ?? null
		},
		readTestChatMessageTexts: async uuid => {
			await whenBootReady()

			const chat = (await sdkApi.listChats()).find(c => c.uuid === uuid)

			if (chat === undefined) {
				return []
			}

			const messages = await sdkApi.listMessagesBefore(chat, BigInt(Date.now() + 3_600_000))

			return messages.map(message => message.message ?? "")
		},
		enqueueTestChatMessage: async (chatUuid, content) => {
			await whenBootReady()

			// Prefer the list cache (offline-safe — the kill-path enqueues while offline); fall back to a
			// network read only when the cache misses.
			const chat = chatsQueryGet()?.find(c => c.uuid === chatUuid) ?? (await sdkApi.listChats()).find(c => c.uuid === chatUuid)

			if (chat === undefined) {
				return false
			}

			const user = await sdkApi.getUserInfo()

			return enqueueChatMessage({
				chat,
				content,
				sender: { id: user.id, email: user.email, avatarUrl: user.avatarUrl, nickName: user.nickName }
			})
		},
		readPersistedInflightChatMessages: async chatUuid => {
			await whenBootReady()

			const outbox = await kvGetJson("inflightChatMessages", inflightChatMessagesSchema)

			if (outbox === null) {
				return null
			}

			const group = outbox[chatUuid]

			if (group === undefined) {
				return null
			}

			return group.messages.map(message => message.message ?? "")
		},
		sweepTestChatsByNamePrefix: async (prefix, minAgeMs) => {
			await whenBootReady()

			const isOldEnough = olderThan(minAgeMs)
			const matches = (await sdkApi.listChats()).filter(chat => (chat.name ?? "").startsWith(prefix) && isOldEnough(chat.created))

			for (const chat of matches) {
				// Sequential, same rationale as the note/tag sweeps above.
				await sdkApi.deleteChat(chat)
			}

			return matches.length
		},
		sendTestTypingSignal: async (chatUuid, signalType) => {
			await whenBootReady()

			const chat = chatsQueryGet()?.find(c => c.uuid === chatUuid) ?? (await sdkApi.listChats()).find(c => c.uuid === chatUuid)

			if (chat === undefined) {
				return
			}

			await sdkApi.sendTypingSignal(chat, signalType)
		}
	}
}

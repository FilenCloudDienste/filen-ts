import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { Note, NoteParticipant, SocketEvent } from "@filen/sdk-rs"

// sdkApi is mocked to the ops the handlers use: the list read (the "new" handler refetches it), the content
// read of "Load theirs", and the conflicted copy's writes.
const { listNotes, getNoteContent, duplicateNote, setNoteTitle, setNoteContent, trashNote, deleteNote } = vi.hoisted(() => ({
	listNotes: vi.fn<() => Promise<Note[]>>(() => Promise.resolve([])),
	getNoteContent: vi.fn<(note: Note) => Promise<string | undefined>>(),
	duplicateNote: vi.fn<(note: Note) => Promise<{ original: Note; duplicated: Note }>>(),
	setNoteTitle: vi.fn<(note: Note, title: string) => Promise<Note>>(),
	setNoteContent: vi.fn<(note: Note, content: string, preview: string) => Promise<Note>>(),
	trashNote: vi.fn<(note: Note) => Promise<Note>>(),
	deleteNote: vi.fn<(note: Note) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { listNotes, getNoteContent, duplicateNote, setNoteTitle, setNoteContent, trashNote, deleteNote }
}))

// The sync outbox singleton — mocked so the reload action's seam calls are observable and sync.ts's heavy
// deps stay out of node. The store it reads (useNotesInflight) is NOT mocked (the editing test is real).
const { dropEntry, clearRejections, flushToDisk, enqueueAnswer, executeNow } = vi.hoisted(() => ({
	dropEntry: vi.fn<(uuid: string) => void>(),
	clearRejections: vi.fn<(uuid: string) => void>(),
	flushToDisk: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
	enqueueAnswer: vi.fn<(note: Note, content: string, theirsHash: string | null) => Promise<boolean>>(() => Promise.resolve(true)),
	executeNow: vi.fn<() => void>()
}))

vi.mock("@/features/notes/lib/sync", () => ({ sync: { dropEntry, clearRejections, flushToDisk, enqueueAnswer, executeNow } }))

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))

vi.mock("sonner", () => ({ toast }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }))

vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: logError, info: vi.fn(), debug: vi.fn() } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { fetchNotes, NOTES_QUERY_KEY } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import useNotesInflightStore, { beginEditingSession, type InflightContent } from "@/features/notes/store/useNotesInflight"
import { setNoteAnswerBroadcast, useNotesRemoteEditStore } from "@/features/notes/store/useNoteRemoteEdit"
import { handleNoteEvent, keepMineOverRemoteEdit, reloadRemoteEdit, saveRemoteEditMineAsCopy } from "@/features/notes/lib/socketHandlers"
import { forgetNotePushes, isOwnNotePush, rememberNotePush, setNotePushBroadcast } from "@/features/notes/lib/pushEchoes"
import { heldNotes, releaseAllNoteHolds } from "@/features/notes/lib/remoteEditHolds"
import {
	forgetTabEditors,
	seedTabEditor,
	tabEditorChanged,
	tabEditorDirty,
	tabEditorPushed,
	tabEditorSynced
} from "@/features/notes/lib/tabEditors"
import { hashNoteContent } from "@filen/shared"

function makeNote(uuid: string, overrides: Partial<Note> = {}): Note {
	return {
		uuid: uuid as Note["uuid"],
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		title: `note-${uuid}`,
		...overrides
	}
}

function participant(userId: bigint): NoteParticipant {
	return {
		userId,
		isOwner: false,
		email: `u${userId.toString()}@x.io`,
		nickName: `u${userId.toString()}`,
		permissionsWrite: false,
		addedTimestamp: 0n
	}
}

function noteEvt(inner: Extract<SocketEvent, { type: "note" }>["inner"]): Extract<SocketEvent, { type: "note" }> {
	return { type: "note", inner, noteMessageId: 0n }
}

function seedNotes(notes: Note[]): void {
	testQueryClient.setQueryData(NOTES_QUERY_KEY, notes)
}

function getNotes(): Note[] {
	return testQueryClient.getQueryData<Note[]>(NOTES_QUERY_KEY) ?? []
}

function setStore(content: InflightContent): void {
	useNotesInflightStore.setState({ inflightContent: content })
}

function setAccountId(id: bigint): void {
	testQueryClient.setQueryData(ACCOUNT_QUERY_KEY, { id })
}

beforeEach(() => {
	testQueryClient.clear()
	setStore({})
	useNotesInflightStore.setState({ editingSessions: {} })
	useNotesRemoteEditStore.setState({ remoteEdited: {}, openNote: null })
	releaseAllNoteHolds()
	forgetNotePushes()
	forgetTabEditors()
	vi.clearAllMocks()
})

// This tab's editor for the note shows `seed`, built on the cloud's `synced`, and was typed into.
function showEditor(uuid: string, seed: string, synced: string | undefined, ...typed: string[]): void {
	seedTabEditor(uuid, `${uuid}:1`, seed, synced)

	for (const value of typed) {
		beginEditingSession(uuid)
		tabEditorChanged(uuid, value)
	}
}

const unmounts: (() => void)[] = []

// A mounted notes list without React: the observer makes the query active (so a refetch actually
// reads), and staleTime Infinity keeps the seeded cache from being re-read on mount.
function mountList(): void {
	const observer = new QueryObserver<Note[]>(testQueryClient, {
		queryKey: NOTES_QUERY_KEY,
		queryFn: fetchNotes,
		staleTime: Infinity,
		retry: false
	})

	unmounts.push(observer.subscribe(() => undefined))
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

afterEach(() => {
	for (const unmount of unmounts.splice(0)) {
		unmount()
	}

	vi.restoreAllMocks()
})

describe("note socket handlers — metadata", () => {
	it("archived sets archive:true on the row", () => {
		seedNotes([makeNote("a")])
		handleNoteEvent(noteEvt({ type: "archived", note: "a" as never }))

		expect(getNotes()[0]?.archive).toBe(true)
	})

	it("restored clears archive+trash", () => {
		seedNotes([makeNote("a", { archive: true, trash: true })])
		handleNoteEvent(noteEvt({ type: "restored", note: "a" as never }))

		expect(getNotes()[0]).toMatchObject({ archive: false, trash: false })
	})

	it("deleted removes the row", () => {
		seedNotes([makeNote("a"), makeNote("b")])
		handleNoteEvent(noteEvt({ type: "deleted", note: "a" as never }))

		expect(getNotes().map(n => n.uuid)).toEqual(["b"])
	})

	it("titleEdited patches the title from the Decrypted arm", () => {
		seedNotes([makeNote("a", { title: "old" })])
		handleNoteEvent(noteEvt({ type: "titleEdited", note: "a" as never, newTitle: { Decrypted: "new" } }))

		expect(getNotes()[0]?.title).toBe("new")
	})

	it("titleEdited skips (and logs) an Encrypted title, leaving the row unchanged", () => {
		seedNotes([makeNote("a", { title: "old" })])
		handleNoteEvent(noteEvt({ type: "titleEdited", note: "a" as never, newTitle: { Encrypted: "cipher" } }))

		expect(getNotes()[0]?.title).toBe("old")
		expect(logWarn).toHaveBeenCalled()
	})

	it("participantNew adds/replaces a participant by userId", () => {
		seedNotes([makeNote("a", { participants: [participant(1n)] })])
		handleNoteEvent(noteEvt({ type: "participantNew", note: "a" as never, participant: participant(2n) }))

		expect(
			getNotes()[0]
				?.participants.map(p => p.userId)
				.sort()
		).toEqual([1n, 2n])
	})

	it("participantRemoved filters a participant by userId", () => {
		seedNotes([makeNote("a", { participants: [participant(1n), participant(2n)] })])
		handleNoteEvent(noteEvt({ type: "participantRemoved", note: "a" as never, userId: 1n }))

		expect(getNotes()[0]?.participants.map(p => p.userId)).toEqual([2n])
	})

	it("participantPermissions flips permissionsWrite on the matching participant", () => {
		seedNotes([makeNote("a", { participants: [participant(1n)] })])
		handleNoteEvent(noteEvt({ type: "participantPermissions", note: "a" as never, userId: 1n, permissionsWrite: true }))

		expect(getNotes()[0]?.participants[0]?.permissionsWrite).toBe(true)
	})

	it("new reads a mounted list through the query and takes the server's list", async () => {
		seedNotes([makeNote("a")])
		mountList()
		listNotes.mockResolvedValueOnce([makeNote("a", { pinned: true }), makeNote("b")])

		handleNoteEvent(noteEvt({ type: "new", note: "b" as never }))
		await vi.waitFor(() => {
			expect(getNotes().map(n => n.uuid)).toEqual(["a", "b"])
		})

		expect(getNotes()[0]?.pinned).toBe(true)
		expect(listNotes).toHaveBeenCalledTimes(1)
	})

	// The list is only read once someone opens it, and that first read is fresher than one taken now.
	it("new reads nothing while the list has never been read", async () => {
		handleNoteEvent(noteEvt({ type: "new", note: "b" as never }))
		await settle()

		expect(listNotes).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryData(NOTES_QUERY_KEY)).toBeUndefined()
	})

	it("new only marks an unmounted list stale — its next mount reads", async () => {
		seedNotes([makeNote("a")])

		handleNoteEvent(noteEvt({ type: "new", note: "b" as never }))
		await settle()

		expect(listNotes).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryState(NOTES_QUERY_KEY)?.isInvalidated).toBe(true)
	})

	it("new leaves the cache as it was when the read fails", async () => {
		seedNotes([makeNote("a")])
		mountList()
		listNotes.mockRejectedValueOnce(new Error("offline"))

		handleNoteEvent(noteEvt({ type: "new", note: "b" as never }))
		await settle()

		expect(listNotes).toHaveBeenCalledTimes(1)
		expect(getNotes().map(n => n.uuid)).toEqual(["a"])
	})

	// The create race: the read `new` started is snapshotted while the note is still in its just-created
	// state ("text", default title). The type and title edits that follow arrive before it lands, with no
	// row to patch yet, and must not leave that snapshot as the cached row — the outbox pushes the cached
	// type with the next content save.
	it.each([
		["an echo of this account's own setNoteType", 7],
		["another user's setNoteType", 99]
	])("new: a read that predates %s is replaced by one that starts after it", async (_label, editorId) => {
		seedNotes([makeNote("a")])
		setAccountId(7n)
		mountList()
		const stale = deferred<Note[]>()
		const fresh = deferred<Note[]>()
		listNotes.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)

		handleNoteEvent(noteEvt({ type: "new", note: "b" as never }))
		handleNoteEvent(
			noteEvt({
				type: "contentEdited",
				note: "b" as never,
				content: { Decrypted: "" },
				noteType: "md",
				editorId,
				editedTimestamp: 2n
			})
		)

		expect(listNotes).toHaveBeenCalledTimes(2)

		fresh.resolve([makeNote("a"), makeNote("b", { noteType: "md" })])
		await settle()
		stale.resolve([makeNote("a"), makeNote("b", { noteType: "text" })])
		await settle()

		expect(getNotes()[1]).toMatchObject({ uuid: "b", noteType: "md" })
	})

	it("new: a title edit landing before its read is patched over a read that starts after it", async () => {
		seedNotes([makeNote("a")])
		mountList()
		const stale = deferred<Note[]>()
		const fresh = deferred<Note[]>()
		listNotes.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)

		handleNoteEvent(noteEvt({ type: "new", note: "b" as never }))
		handleNoteEvent(noteEvt({ type: "titleEdited", note: "b" as never, newTitle: { Decrypted: "Shopping list" } }))

		expect(listNotes).toHaveBeenCalledTimes(2)

		stale.resolve([makeNote("a"), makeNote("b", { title: "2026-01-01 12:00:00" })])
		await settle()
		fresh.resolve([makeNote("a"), makeNote("b", { title: "Shopping list" })])
		await settle()

		expect(getNotes()[1]).toMatchObject({ uuid: "b", title: "Shopping list" })
	})
})

describe("note socket handlers — contentEdited", () => {
	const contentEdited = (uuid: string, editorId: number) =>
		noteEvt({
			type: "contentEdited",
			note: uuid as never,
			content: { Decrypted: "server text" },
			noteType: "text",
			editorId,
			editedTimestamp: 999n
		})

	it("suppresses the echo of this browser's own push", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		beginEditingSession("a")
		rememberNotePush("a", hashNoteContent("server text"))
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleNoteEvent(contentEdited("a", 7))

		expect(getNotes()[0]?.editedTimestamp).toBe(1n)
		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect(invalidate).not.toHaveBeenCalled()
	})

	it("takes a push's echo once: the same content saved again on another device of this account is its edit", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		showEditor("a", "old", "old", "server text")
		rememberNotePush("a", hashNoteContent("server text"))
		tabEditorPushed("a", hashNoteContent("server text"))
		tabEditorChanged("a", "server text, and more")

		handleNoteEvent(contentEdited("a", 7))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()

		handleNoteEvent(contentEdited("a", 7))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toEqual({ theirs: "server text" })
	})

	it("takes this account's edit of content this browser never pushed for another device's, and asks", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		showEditor("a", "old", "old", "typed")

		handleNoteEvent(contentEdited("a", 7))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toEqual({ theirs: "server text" })
	})

	it("reloads a clean note edited on another device of this account, announcing it when on screen", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		useNotesRemoteEditStore.getState().setOpenNote("a")
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleNoteEvent(contentEdited("a", 7))

		expect(getNotes()[0]?.editedTimestamp).toBe(999n)
		expect(invalidate).toHaveBeenCalledWith({ queryKey: noteContentQueryKey("a") })
		expect(toast).toHaveBeenCalledTimes(1)
	})

	it("reloads a clean note that is not on screen without a word", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		useNotesRemoteEditStore.getState().setOpenNote("b")

		handleNoteEvent(contentEdited("a", 99))

		expect(toast).not.toHaveBeenCalled()
	})

	it("takes this account's content it cannot decrypt for its own echo", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		beginEditingSession("a")

		handleNoteEvent(
			noteEvt({
				type: "contentEdited",
				note: "a" as never,
				content: { Encrypted: "x" },
				noteType: "text",
				editorId: 7,
				editedTimestamp: 999n
			})
		)

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
	})

	it("does not ask when the content that arrived is what the editor already holds", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		setStore({ a: [{ timestamp: Date.now(), content: "server text", note: makeNote("a") }] })

		handleNoteEvent(contentEdited("a", 99))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
	})

	it("clean note (no inflight): patches the row and invalidates the content query", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleNoteEvent(contentEdited("a", 99))

		expect(getNotes()[0]?.editedTimestamp).toBe(999n)
		expect(getNotes()[0]?.preview).toBe("server text")
		expect(invalidate).toHaveBeenCalledWith({ queryKey: noteContentQueryKey("a") })
		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
	})

	it("dirty note (inflight): sets the remote-edit flag and does NOT invalidate while inflight", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		setStore({ a: [{ timestamp: Date.now(), content: "local", note: makeNote("a") }] })
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleNoteEvent(contentEdited("a", 99))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toEqual({ theirs: "server text" })
		expect(invalidate).not.toHaveBeenCalled()
		expect(getNotes()[0]?.editedTimestamp).toBe(1n)
	})

	it("dirty note (typed text the cloud does not hold, outbox already drained): prompts instead of reseeding", () => {
		// A push empties the outbox entry, so the queue alone reads a note still being typed into as clean.
		// Reseeding there remounts the live editor under the caret and drops the text typed since.
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		testQueryClient.setQueryData(noteContentQueryKey("a"), "old", { updatedAt: 1 })
		showEditor("a", "old", "old", "typed")
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleNoteEvent(contentEdited("a", 99))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toEqual({ theirs: "server text" })
		expect(invalidate).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryState(noteContentQueryKey("a"))?.dataUpdatedAt).toBe(1)
		expect(getNotes()[0]?.editedTimestamp).toBe(1n)
	})

	it("clean note under an open editing session (its typing pushed): takes their version and says so", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		useNotesRemoteEditStore.getState().setOpenNote("a")
		testQueryClient.setQueryData(noteContentQueryKey("a"), "old", { updatedAt: 1 })
		showEditor("a", "old", "old", "x")
		tabEditorSynced("a", "x", hashNoteContent("x"))
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleNoteEvent(contentEdited("a", 99))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect(getNotes()[0]?.editedTimestamp).toBe(999n)
		// Written from the event, no read: the new dataUpdatedAt reseeds the editor although the session
		// keeps the query disabled.
		expect(testQueryClient.getQueryData(noteContentQueryKey("a"))).toBe("server text")
		expect(testQueryClient.getQueryState(noteContentQueryKey("a"))?.dataUpdatedAt).toBeGreaterThan(1)
		expect(invalidate).not.toHaveBeenCalled()
		expect(getNoteContent).not.toHaveBeenCalled()
		expect(toast).toHaveBeenCalledTimes(1)
	})

	it("clean note under an open session whose content did not decrypt: ends the session and reads it", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		showEditor("a", "old", "old")
		beginEditingSession("a")
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleNoteEvent(
			noteEvt({
				type: "contentEdited",
				note: "a" as never,
				content: { Encrypted: "x" },
				noteType: "text",
				editorId: 99,
				editedTimestamp: 999n
			})
		)

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect(useNotesInflightStore.getState().editingSessions["a"]).toBeUndefined()
		expect(invalidate).toHaveBeenCalledWith({ queryKey: noteContentQueryKey("a") })
	})

	it("skips (and logs) a note not in the list cache without reading when no list read is in flight", async () => {
		seedNotes([])
		setAccountId(7n)
		mountList()

		handleNoteEvent(contentEdited("gone", 99))
		await settle()

		expect(logWarn).toHaveBeenCalled()
		expect(listNotes).not.toHaveBeenCalled()
	})

	it("re-reads the list for an echo whose type differs from the cached row, never patching it", async () => {
		seedNotes([makeNote("a", { noteType: "md" })])
		setAccountId(7n)
		rememberNotePush("a", hashNoteContent("server text"))
		mountList()

		handleNoteEvent(contentEdited("a", 7))
		await settle()

		expect(listNotes).toHaveBeenCalledTimes(1)
	})

	it("reads nothing for an echo when no list read is in flight", async () => {
		seedNotes([makeNote("a")])
		setAccountId(7n)
		rememberNotePush("a", hashNoteContent("server text"))
		mountList()

		handleNoteEvent(contentEdited("a", 7))
		await settle()

		expect(listNotes).not.toHaveBeenCalled()
	})
})

// Two tabs of this browser on one note: the leader pushes for both, and each hears the echo as its own.
describe("note socket handlers — this browser's pushes, heard by the tabs showing the note", () => {
	const echo = (content: string) =>
		noteEvt({
			type: "contentEdited",
			note: "a" as never,
			content: { Decrypted: content },
			noteType: "text",
			editorId: 7,
			editedTimestamp: 999n
		})

	beforeEach(() => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		useNotesRemoteEditStore.getState().setOpenNote("a")
	})

	it("a tab with nothing typed takes another tab's push and reseeds its editor, silently", () => {
		testQueryClient.setQueryData(noteContentQueryKey("a"), "old", { updatedAt: 1 })
		showEditor("a", "old", "old")
		rememberNotePush("a", hashNoteContent("tab 2 text"))

		handleNoteEvent(echo("tab 2 text"))

		expect(testQueryClient.getQueryData(noteContentQueryKey("a"))).toBe("tab 2 text")
		expect(testQueryClient.getQueryState(noteContentQueryKey("a"))?.dataUpdatedAt).toBeGreaterThan(1)
		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		// This browser's own typing: a toast at every pause of it would only be noise.
		expect(toast).not.toHaveBeenCalled()
	})

	it("the leader tab reseeds too, though its push already wrote the content into its cache", () => {
		// The push loop writes the pushed text into the leader's cache keeping dataUpdatedAt, so the leader's
		// editor, seeded before, still shows the older text.
		testQueryClient.setQueryData(noteContentQueryKey("a"), "tab 2 text", { updatedAt: 1 })
		showEditor("a", "old", "old", "old, typed", "old")
		tabEditorSynced("a", "old", hashNoteContent("old"))
		rememberNotePush("a", hashNoteContent("tab 2 text"))

		handleNoteEvent(echo("tab 2 text"))

		expect(testQueryClient.getQueryState(noteContentQueryKey("a"))?.dataUpdatedAt).toBeGreaterThan(1)
		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
	})

	it("a tab that typed something else is asked, as for another device's edit", () => {
		testQueryClient.setQueryData(noteContentQueryKey("a"), "old", { updatedAt: 1 })
		showEditor("a", "old", "old", "tab 1 text")
		rememberNotePush("a", hashNoteContent("tab 2 text"))

		handleNoteEvent(echo("tab 2 text"))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toEqual({ theirs: "tab 2 text" })
		expect(testQueryClient.getQueryState(noteContentQueryKey("a"))?.dataUpdatedAt).toBe(1)
		expect(tabEditorDirty("a")).toBe(true)
	})

	it("the tab that typed it builds on it, typing on meanwhile: no question, the cache follows, the editor stays", () => {
		testQueryClient.setQueryData(noteContentQueryKey("a"), "old", { updatedAt: 1 })
		showEditor("a", "old", "old", "mine")
		rememberNotePush("a", hashNoteContent("mine"))
		// A follower hears the leader's push by hash.
		tabEditorPushed("a", hashNoteContent("mine"))
		tabEditorChanged("a", "mine, and more")

		handleNoteEvent(echo("mine"))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect(testQueryClient.getQueryData(noteContentQueryKey("a"))).toBe("mine")
		expect(testQueryClient.getQueryState(noteContentQueryKey("a"))?.dataUpdatedAt).toBe(1)
		expect(toast).not.toHaveBeenCalled()
		expect(tabEditorDirty("a")).toBe(true)
	})

	it("the tab that typed it is clean once it is heard back", () => {
		testQueryClient.setQueryData(noteContentQueryKey("a"), "old", { updatedAt: 1 })
		showEditor("a", "old", "old", "mine")
		rememberNotePush("a", hashNoteContent("mine"))

		handleNoteEvent(echo("mine"))

		expect(tabEditorDirty("a")).toBe(false)
		expect(testQueryClient.getQueryState(noteContentQueryKey("a"))?.dataUpdatedAt).toBe(1)
	})

	it("a tab not showing the note leaves its cache to the next open", () => {
		testQueryClient.setQueryData(noteContentQueryKey("a"), "old", { updatedAt: 1 })
		rememberNotePush("a", hashNoteContent("tab 2 text"))

		handleNoteEvent(echo("tab 2 text"))

		expect(testQueryClient.getQueryData(noteContentQueryKey("a"))).toBe("old")
	})
})

describe("note socket handlers — reload/keep actions", () => {
	it("a pending remote edit on the open note holds its pushes until it is answered, and tells the other tabs", async () => {
		const broadcast = vi.fn<(uuid: string) => void>()

		setNoteAnswerBroadcast(broadcast)
		useNotesRemoteEditStore.getState().setOpenNote("a")
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })

		expect((await heldNotes()).has("a")).toBe(true)

		useNotesRemoteEditStore.getState().clearRemoteEdited("a")
		await settle()

		expect((await heldNotes()).has("a")).toBe(false)
		expect(broadcast).toHaveBeenCalledWith("a")
		setNoteAnswerBroadcast(null)
		useNotesRemoteEditStore.getState().setOpenNote(null)
	})

	it("a remote edit on a note not on screen holds nothing: no dialog there could release it", async () => {
		useNotesRemoteEditStore.getState().setOpenNote("b")
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toEqual({ theirs: "server text" })
		expect((await heldNotes()).has("a")).toBe(false)
		useNotesRemoteEditStore.getState().setOpenNote(null)
	})

	it("an answer from another tab drops the question and the hold without echoing it back", async () => {
		const broadcast = vi.fn<(uuid: string) => void>()

		setNoteAnswerBroadcast(broadcast)
		useNotesRemoteEditStore.getState().setOpenNote("a")
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })
		useNotesRemoteEditStore.getState().dropRemoteEdited("a")
		await settle()

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect((await heldNotes()).has("a")).toBe(false)
		expect(broadcast).not.toHaveBeenCalled()
		setNoteAnswerBroadcast(null)
		useNotesRemoteEditStore.getState().setOpenNote(null)
	})

	it("load theirs queues their content from the event over the local edits and reseeds the editor from it", async () => {
		setStore({ a: [{ timestamp: Date.now(), content: "local", note: makeNote("a") }] })
		testQueryClient.setQueryData(noteContentQueryKey("a"), "old", { updatedAt: 1 })
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		await reloadRemoteEdit(makeNote("a"))

		expect(dropEntry).toHaveBeenCalledWith("a")
		expect(clearRejections).toHaveBeenCalledWith("a")
		expect(enqueueAnswer).toHaveBeenCalledWith(expect.objectContaining({ uuid: "a" }), "server text", hashNoteContent("server text"))
		expect(getNoteContent).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryData(noteContentQueryKey("a"))).toBe("server text")
		expect(testQueryClient.getQueryState(noteContentQueryKey("a"))?.dataUpdatedAt).toBeGreaterThan(1)
		expect(invalidate).not.toHaveBeenCalled()
		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		await settle()
		expect((await heldNotes()).has("a")).toBe(false)
	})

	it("load theirs reads their content when the event carried none", async () => {
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: undefined })
		getNoteContent.mockResolvedValueOnce("read text")

		await reloadRemoteEdit(makeNote("a"))

		expect(enqueueAnswer).toHaveBeenCalledWith(expect.objectContaining({ uuid: "a" }), "read text", hashNoteContent("read text"))
		expect(testQueryClient.getQueryData(noteContentQueryKey("a"))).toBe("read text")
	})

	it("load theirs falls back to a refetch when their content cannot be read", async () => {
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: undefined })
		getNoteContent.mockRejectedValueOnce(new Error("offline"))
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		await reloadRemoteEdit(makeNote("a"))

		expect(enqueueAnswer).not.toHaveBeenCalled()
		expect(dropEntry).toHaveBeenCalledWith("a")
		expect(flushToDisk).toHaveBeenCalledTimes(1)
		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect(invalidate).toHaveBeenCalledWith({ queryKey: noteContentQueryKey("a") })
	})

	it("reload ends the editing session", async () => {
		beginEditingSession("a")
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })

		await reloadRemoteEdit(makeNote("a"))

		expect(useNotesInflightStore.getState().editingSessions["a"]).toBeUndefined()
	})

	it("keep with unsynced edits queues them afresh on their content, so no overwrite is reported", async () => {
		setStore({ a: [{ timestamp: Date.now(), content: "local", note: makeNote("a"), baseContentHash: "stale" }] })
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })

		await keepMineOverRemoteEdit(makeNote("a"))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect(dropEntry).toHaveBeenCalledWith("a")
		expect(enqueueAnswer).toHaveBeenCalledWith(expect.objectContaining({ uuid: "a" }), "local", hashNoteContent("server text"))
		expect(dropEntry.mock.invocationCallOrder[0]).toBeLessThan(enqueueAnswer.mock.invocationCallOrder[0] ?? 0)
		expect(executeNow).toHaveBeenCalledTimes(1)
	})

	it("keep with typed text the cloud does not hold queues this tab's text, whatever the content cache holds", async () => {
		// A follower tab's cache is only written by the push's echo: it can still hold the text before.
		testQueryClient.setQueryData(noteContentQueryKey("a"), "old")
		showEditor("a", "old", "old", "mine")
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })

		await keepMineOverRemoteEdit(makeNote("a"))

		expect(enqueueAnswer).toHaveBeenCalledWith(expect.objectContaining({ uuid: "a" }), "mine", hashNoteContent("server text"))
		expect(executeNow).toHaveBeenCalledTimes(1)
	})

	// This tab's push can land before their save and its response arrive after their event: nothing is
	// unsynced, yet the cloud holds theirs.
	it("keep with nothing unsynced left still makes mine the newest version", async () => {
		testQueryClient.setQueryData(noteContentQueryKey("a"), "mine")
		showEditor("a", "old", "old", "mine")
		tabEditorSynced("a", "mine", hashNoteContent("mine"))
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })

		await keepMineOverRemoteEdit(makeNote("a"))

		expect(enqueueAnswer).toHaveBeenCalledWith(expect.objectContaining({ uuid: "a" }), "mine", hashNoteContent("server text"))
		expect(executeNow).toHaveBeenCalledTimes(1)
	})

	it("keep with mine equal to the version asked about queues nothing", async () => {
		showEditor("a", "old", "old", "server text")
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })

		await keepMineOverRemoteEdit(makeNote("a"))

		expect(enqueueAnswer).not.toHaveBeenCalled()
		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
	})

	it("keep reads the version asked about when the event carried none, and queues nothing when mine equals it", async () => {
		showEditor("a", "old", "old", "same")
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: undefined })
		getNoteContent.mockResolvedValueOnce("same")

		await keepMineOverRemoteEdit(makeNote("a"))

		expect(getNoteContent).toHaveBeenCalledTimes(1)
		expect(enqueueAnswer).not.toHaveBeenCalled()
	})
})

describe("note socket handlers — save mine as copy", () => {
	it("writes the copy as this browser's own push, lists the note the last write returned, and loads theirs", async () => {
		testQueryClient.setQueryData(noteContentQueryKey("a"), "mine")
		seedNotes([makeNote("a")])
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })
		duplicateNote.mockResolvedValueOnce({ original: makeNote("a"), duplicated: makeNote("c") })
		setNoteTitle.mockResolvedValueOnce(makeNote("c", { title: "copy" }))
		setNoteContent.mockResolvedValueOnce(makeNote("c", { title: "copy", preview: "mine", editedTimestamp: 5n }))
		const broadcast = vi.fn()
		setNotePushBroadcast(broadcast)

		const outcome = await saveRemoteEditMineAsCopy(makeNote("a"), "copy")

		expect(outcome.status).toBe("success")
		expect(broadcast).toHaveBeenCalledWith("c", hashNoteContent("mine"))
		expect(setNoteContent).toHaveBeenCalledWith(expect.objectContaining({ uuid: "c", title: "copy" }), "mine", expect.any(String))
		expect(getNotes().find(n => n.uuid === ("c" as Note["uuid"]))).toMatchObject({
			title: "copy",
			preview: "mine",
			editedTimestamp: 5n
		})
		expect(testQueryClient.getQueryData(noteContentQueryKey("c"))).toBe("mine")
		expect(isOwnNotePush("c", hashNoteContent("mine"))).toBe(true)
		expect(enqueueAnswer).toHaveBeenCalledWith(expect.objectContaining({ uuid: "a" }), "server text", hashNoteContent("server text"))
		expect(trashNote).not.toHaveBeenCalled()
	})

	it("deletes a copy that failed partway, and leaves the dialog up", async () => {
		testQueryClient.setQueryData(noteContentQueryKey("a"), "mine")
		seedNotes([makeNote("a")])
		useNotesRemoteEditStore.getState().setRemoteEdited("a", { theirs: "server text" })
		duplicateNote.mockResolvedValueOnce({ original: makeNote("a"), duplicated: makeNote("c") })
		setNoteTitle.mockResolvedValueOnce(makeNote("c", { title: "copy" }))
		setNoteContent.mockRejectedValueOnce(new Error("offline"))
		trashNote.mockResolvedValueOnce(makeNote("c", { title: "copy", trash: true }))
		deleteNote.mockResolvedValueOnce(undefined)

		const outcome = await saveRemoteEditMineAsCopy(makeNote("a"), "copy")

		expect(outcome.status).toBe("error")
		expect(trashNote).toHaveBeenCalledWith(expect.objectContaining({ uuid: "c", title: "copy" }))
		expect(deleteNote).toHaveBeenCalledWith(expect.objectContaining({ uuid: "c", trash: true }))
		expect(getNotes().map(n => n.uuid)).toEqual(["a"])
		expect(enqueueAnswer).not.toHaveBeenCalled()
		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toEqual({ theirs: "server text" })
	})

	it("lists a partial copy that could not be deleted", async () => {
		testQueryClient.setQueryData(noteContentQueryKey("a"), "mine")
		seedNotes([makeNote("a")])
		duplicateNote.mockResolvedValueOnce({ original: makeNote("a"), duplicated: makeNote("c") })
		setNoteTitle.mockRejectedValueOnce(new Error("offline"))
		trashNote.mockRejectedValueOnce(new Error("offline"))

		const outcome = await saveRemoteEditMineAsCopy(makeNote("a"), "copy")

		expect(outcome.status).toBe("error")
		expect(getNotes().map(n => n.uuid)).toEqual(["a", "c"])
	})
})

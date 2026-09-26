import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { Note, NoteParticipant, SocketEvent } from "@filen/sdk-rs"

// sdkApi is mocked to the one op the list query reads with (the "new" handler refetches it).
const { listNotes } = vi.hoisted(() => ({ listNotes: vi.fn<() => Promise<Note[]>>(() => Promise.resolve([])) }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listNotes } }))

// The sync outbox singleton — mocked so the reload action's seam calls are observable and sync.ts's heavy
// deps stay out of node. The store it reads (useNotesInflight) is NOT mocked (the editing test is real).
const { dropEntry, clearRejections, flushToDisk } = vi.hoisted(() => ({
	dropEntry: vi.fn<(uuid: string) => void>(),
	clearRejections: vi.fn<(uuid: string) => void>(),
	flushToDisk: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true))
}))

vi.mock("@/features/notes/lib/sync", () => ({ sync: { dropEntry, clearRejections, flushToDisk } }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }))

vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: logError, info: vi.fn(), debug: vi.fn() } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { fetchNotes, NOTES_QUERY_KEY } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import useNotesInflightStore, { beginEditingSession, type InflightContent } from "@/features/notes/store/useNotesInflight"
import { useNotesRemoteEditStore } from "@/features/notes/store/useNoteRemoteEdit"
import { handleNoteEvent, reloadRemoteEdit, dismissRemoteEdit } from "@/features/notes/lib/socketHandlers"

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
	useNotesRemoteEditStore.setState({ remoteEdited: {} })
	vi.clearAllMocks()
})

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

	it("suppresses an echo authored by the current user (editorId === own id)", () => {
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleNoteEvent(contentEdited("a", 7))

		expect(getNotes()[0]?.editedTimestamp).toBe(1n)
		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect(invalidate).not.toHaveBeenCalled()
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

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBe(true)
		expect(invalidate).not.toHaveBeenCalled()
		expect(getNotes()[0]?.editedTimestamp).toBe(1n)
	})

	it("dirty note (editor session, outbox already drained): prompts instead of invalidating", () => {
		// The regression this guards: a push empties the outbox entry, so a note the user is still typing
		// into reads as inflight-free. Invalidating there refetches, advances the content query's
		// dataUpdatedAt and remounts the live editor — the caret goes with it, and every keystroke after
		// that lands on document.body.
		seedNotes([makeNote("a", { editedTimestamp: 1n })])
		setAccountId(7n)
		beginEditingSession("a")
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		handleNoteEvent(contentEdited("a", 99))

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBe(true)
		expect(invalidate).not.toHaveBeenCalled()
		expect(getNotes()[0]?.editedTimestamp).toBe(1n)
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
		mountList()

		handleNoteEvent(contentEdited("a", 7))
		await settle()

		expect(listNotes).toHaveBeenCalledTimes(1)
	})

	it("reads nothing for an echo when no list read is in flight", async () => {
		seedNotes([makeNote("a")])
		setAccountId(7n)
		mountList()

		handleNoteEvent(contentEdited("a", 7))
		await settle()

		expect(listNotes).not.toHaveBeenCalled()
	})
})

describe("note socket handlers — reload/keep actions", () => {
	it("reload drops the entry, clears rejections, flushes, clears the flag, and invalidates content", async () => {
		setStore({ a: [{ timestamp: Date.now(), content: "local", note: makeNote("a") }] })
		useNotesRemoteEditStore.getState().setRemoteEdited("a")
		const invalidate = vi.spyOn(testQueryClient, "invalidateQueries")

		await reloadRemoteEdit(makeNote("a"))

		expect(dropEntry).toHaveBeenCalledWith("a")
		expect(clearRejections).toHaveBeenCalledWith("a")
		expect(flushToDisk).toHaveBeenCalledTimes(1)
		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect(invalidate).toHaveBeenCalledWith({ queryKey: noteContentQueryKey("a") })
	})

	it("reload ends the editing session so the re-enabled content query can actually refetch", async () => {
		beginEditingSession("a")

		await reloadRemoteEdit(makeNote("a"))

		expect(useNotesInflightStore.getState().editingSessions["a"]).toBeUndefined()
	})

	it("keep clears the flag and leaves the outbox untouched", () => {
		useNotesRemoteEditStore.getState().setRemoteEdited("a")

		dismissRemoteEdit("a")

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect(dropEntry).not.toHaveBeenCalled()
	})
})

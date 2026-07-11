import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note, NoteParticipant, SocketEvent } from "@filen/sdk-rs"

// sdkApi is mocked to the one op the "new" handler calls (list refetch).
const { listNotes } = vi.hoisted(() => ({ listNotes: vi.fn<() => Promise<Note[]>>(() => Promise.resolve([])) }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listNotes } }))

// The sync outbox singleton — mocked so the reload action's seam calls are observable and sync.ts's heavy
// deps stay out of node. The store it reads (useNotesInflight) is NOT mocked (hasInflight is real).
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
import { NOTES_QUERY_KEY } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import useNotesInflightStore, { type InflightContent } from "@/features/notes/store/useNotesInflight"
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
	useNotesRemoteEditStore.setState({ remoteEdited: {} })
	vi.clearAllMocks()
})

afterEach(() => {
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

	it("new refetches the list and replaces the cache", async () => {
		seedNotes([makeNote("a")])
		listNotes.mockResolvedValueOnce([makeNote("a"), makeNote("b")])

		handleNoteEvent(noteEvt({ type: "new", note: "b" as never }))
		await vi.waitFor(() => {
			expect(getNotes().map(n => n.uuid)).toEqual(["a", "b"])
		})

		expect(listNotes).toHaveBeenCalledTimes(1)
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

	it("skips silently when the note is not in the list cache", () => {
		seedNotes([])
		setAccountId(7n)

		handleNoteEvent(contentEdited("gone", 99))

		expect(logWarn).toHaveBeenCalled()
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

	it("keep clears the flag and leaves the outbox untouched", () => {
		useNotesRemoteEditStore.getState().setRemoteEdited("a")

		dismissRemoteEdit("a")

		expect(useNotesRemoteEditStore.getState().remoteEdited["a"]).toBeUndefined()
		expect(dropEntry).not.toHaveBeenCalled()
	})
})

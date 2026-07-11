import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note, NoteType, UserInfo, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Mock boundary matching notesQueries.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest.
const {
	createNote,
	setNoteTypeOp,
	duplicateNoteOp,
	getNoteContent,
	setNotePinned,
	setNoteFavorited,
	archiveNoteOp,
	restoreNoteOp,
	trashNoteOp,
	deleteNoteOp,
	removeNoteParticipant,
	setNoteTitleOp
} = vi.hoisted(() => ({
	createNote: vi.fn(),
	setNoteTypeOp: vi.fn(),
	duplicateNoteOp: vi.fn(),
	getNoteContent: vi.fn(),
	setNotePinned: vi.fn(),
	setNoteFavorited: vi.fn(),
	archiveNoteOp: vi.fn(),
	restoreNoteOp: vi.fn(),
	trashNoteOp: vi.fn(),
	deleteNoteOp: vi.fn(),
	removeNoteParticipant: vi.fn(),
	setNoteTitleOp: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		createNote,
		setNoteType: setNoteTypeOp,
		duplicateNote: duplicateNoteOp,
		getNoteContent,
		setNotePinned,
		setNoteFavorited,
		archiveNote: archiveNoteOp,
		restoreNote: restoreNoteOp,
		trashNote: trashNoteOp,
		deleteNote: deleteNoteOp,
		removeNoteParticipant,
		setNoteTitle: setNoteTitleOp
	}
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

// getDefaultNoteType is exercised for real by notesMdSplitPreferences.test.ts's sibling coverage —
// here it's stubbed so createNote's own default-type-application branch is directly controllable.
const { getDefaultNoteTypeMock } = vi.hoisted(() => ({ getDefaultNoteTypeMock: vi.fn<() => Promise<NoteType>>() }))

vi.mock("@/features/notes/lib/preferences", () => ({
	getDefaultNoteType: getDefaultNoteTypeMock,
	DEFAULT_NOTE_TYPE: "text"
}))

import { queryClient as testQueryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { NOTES_QUERY_KEY, notesQueryGet } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import {
	isNoteOwner,
	createNote as createNoteAction,
	duplicateNote,
	togglePinned,
	toggleFavorited,
	archiveNote,
	restoreNote,
	trashNote,
	deleteNote,
	leaveNote,
	setNoteTitle,
	setNoteType
} from "@/features/notes/lib/actions"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
	getDefaultNoteTypeMock.mockResolvedValue("text")
})

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: testUuid("note"),
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "note title",
		preview: "note preview",
		trash: false,
		archive: false,
		createdTimestamp: 1_700_000_000_000n,
		editedTimestamp: 1_700_000_000_000n,
		participants: [],
		...overrides
	}
}

function setCurrentUser(id: bigint): void {
	testQueryClient.setQueryData<UserInfo>(ACCOUNT_QUERY_KEY, { id } as UserInfo)
}

describe("isNoteOwner", () => {
	it("is true when the given userId matches the note's ownerId", () => {
		expect(isNoteOwner(mockNote({ ownerId: 5n }), 5n)).toBe(true)
	})

	it("is false when the given userId does not match", () => {
		expect(isNoteOwner(mockNote({ ownerId: 5n }), 6n)).toBe(false)
	})

	it("is false when userId is undefined (no resolved account yet)", () => {
		expect(isNoteOwner(mockNote({ ownerId: 5n }), undefined)).toBe(false)
	})
})

describe("createNote", () => {
	it("creates as text and upserts into the cache when the default-type preference is text", async () => {
		const note = mockNote()
		createNote.mockResolvedValueOnce(note)

		const outcome = await createNoteAction()

		expect(outcome).toEqual({ status: "success", item: note })
		expect(createNote).toHaveBeenCalledExactlyOnceWith(undefined)
		expect(setNoteTypeOp).not.toHaveBeenCalled()
		expect(notesQueryGet()).toEqual([note])
	})

	it("passes an explicit title through to createNote", async () => {
		createNote.mockResolvedValueOnce(mockNote())

		await createNoteAction("My title")

		expect(createNote).toHaveBeenCalledExactlyOnceWith("My title")
	})

	it("applies the persisted default type with a second setNoteType call when it differs from text", async () => {
		const created = mockNote({ noteType: "text" })
		const retyped = mockNote({ noteType: "md" })
		createNote.mockResolvedValueOnce(created)
		getDefaultNoteTypeMock.mockResolvedValueOnce("md")
		setNoteTypeOp.mockResolvedValueOnce(retyped)

		const outcome = await createNoteAction()

		expect(setNoteTypeOp).toHaveBeenCalledExactlyOnceWith(created, "md")
		expect(outcome).toEqual({ status: "success", item: retyped })
		expect(notesQueryGet()).toEqual([retyped])
	})

	it("returns an error outcome on rejection, without touching the cache", async () => {
		createNote.mockRejectedValueOnce(new Error("note_limit_reached"))

		const outcome = await createNoteAction()

		expect(outcome.status).toBe("error")
		expect(notesQueryGet()).toBeUndefined()
	})
})

describe("duplicateNote", () => {
	it("copies cached content into both the original and duplicated cache entries", async () => {
		const original = mockNote({ uuid: testUuid("orig") })
		const duplicated = mockNote({ uuid: testUuid("dup") })
		testQueryClient.setQueryData(noteContentQueryKey(original.uuid), "existing content")
		duplicateNoteOp.mockResolvedValueOnce({ original, duplicated })

		const outcome = await duplicateNote(original)

		expect(outcome).toEqual({ status: "success", item: duplicated })
		expect(getNoteContent).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryData(noteContentQueryKey(original.uuid))).toBe("existing content")
		expect(testQueryClient.getQueryData(noteContentQueryKey(duplicated.uuid))).toBe("existing content")
		expect(notesQueryGet()).toEqual(expect.arrayContaining([original, duplicated]))
	})

	it("fetches content when the original's cache is cold", async () => {
		const original = mockNote({ uuid: testUuid("orig") })
		const duplicated = mockNote({ uuid: testUuid("dup") })
		duplicateNoteOp.mockResolvedValueOnce({ original, duplicated })
		getNoteContent.mockResolvedValueOnce("fetched content")

		await duplicateNote(original)

		expect(getNoteContent).toHaveBeenCalledExactlyOnceWith(original)
		expect(testQueryClient.getQueryData(noteContentQueryKey(duplicated.uuid))).toBe("fetched content")
	})

	it("returns an error outcome on rejection", async () => {
		duplicateNoteOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await duplicateNote(mockNote())

		expect(outcome.status).toBe("error")
	})
})

describe("togglePinned / toggleFavorited", () => {
	it("togglePinned flips the current flag and upserts the result", async () => {
		const note = mockNote({ pinned: false })
		const updated = { ...note, pinned: true }
		setNotePinned.mockResolvedValueOnce(updated)

		const outcome = await togglePinned(note)

		expect(setNotePinned).toHaveBeenCalledExactlyOnceWith(note, true)
		expect(outcome).toEqual({ status: "success", item: updated })
		expect(notesQueryGet()).toEqual([updated])
	})

	it("toggleFavorited flips the current flag and upserts the result", async () => {
		const note = mockNote({ favorite: true })
		const updated = { ...note, favorite: false }
		setNoteFavorited.mockResolvedValueOnce(updated)

		const outcome = await toggleFavorited(note)

		expect(setNoteFavorited).toHaveBeenCalledExactlyOnceWith(note, false)
		expect(outcome).toEqual({ status: "success", item: updated })
	})
})

describe("archiveNote (owner-gated)", () => {
	it("archives when the current user owns the note", async () => {
		setCurrentUser(1n)
		const note = mockNote({ ownerId: 1n })
		const updated = { ...note, archive: true }
		archiveNoteOp.mockResolvedValueOnce(updated)

		const outcome = await archiveNote(note)

		expect(archiveNoteOp).toHaveBeenCalledExactlyOnceWith(note)
		expect(outcome).toEqual({ status: "success", item: updated })
	})

	it("refuses without calling the worker when the current user does not own the note", async () => {
		setCurrentUser(2n)
		const note = mockNote({ ownerId: 1n })

		const outcome = await archiveNote(note)

		expect(outcome.status).toBe("error")
		expect(archiveNoteOp).not.toHaveBeenCalled()
	})

	it("no-ops (success, no worker call) when already archived or trashed", async () => {
		setCurrentUser(1n)
		const archived = mockNote({ ownerId: 1n, archive: true })
		const trashed = mockNote({ ownerId: 1n, trash: true })

		await expect(archiveNote(archived)).resolves.toEqual({ status: "success", item: archived })
		await expect(archiveNote(trashed)).resolves.toEqual({ status: "success", item: trashed })
		expect(archiveNoteOp).not.toHaveBeenCalled()
	})
})

describe("restoreNote", () => {
	it("restores an archived note", async () => {
		const note = mockNote({ archive: true })
		const updated = { ...note, archive: false }
		restoreNoteOp.mockResolvedValueOnce(updated)

		const outcome = await restoreNote(note)

		expect(restoreNoteOp).toHaveBeenCalledExactlyOnceWith(note)
		expect(outcome).toEqual({ status: "success", item: updated })
	})

	it("no-ops when neither archived nor trashed", async () => {
		const note = mockNote()

		const outcome = await restoreNote(note)

		expect(outcome).toEqual({ status: "success", item: note })
		expect(restoreNoteOp).not.toHaveBeenCalled()
	})
})

describe("trashNote", () => {
	it("trashes and UPSERTS (never removes) the note — trashed notes stay in the flat list", async () => {
		const note = mockNote()
		const updated = { ...note, trash: true }
		trashNoteOp.mockResolvedValueOnce(updated)
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [note])

		const outcome = await trashNote(note)

		expect(outcome).toEqual({ status: "success", item: updated })
		expect(notesQueryGet()).toEqual([updated])
	})

	it("no-ops when already trashed", async () => {
		const note = mockNote({ trash: true })

		await expect(trashNote(note)).resolves.toEqual({ status: "success", item: note })
		expect(trashNoteOp).not.toHaveBeenCalled()
	})
})

describe("deleteNote", () => {
	it("removes the note from the cache and clears its content cache on success", async () => {
		const note = mockNote()
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [note])
		testQueryClient.setQueryData(noteContentQueryKey(note.uuid), "content")
		deleteNoteOp.mockResolvedValueOnce(undefined)

		const outcome = await deleteNote(note)

		expect(outcome).toEqual({ status: "success" })
		expect(notesQueryGet()).toEqual([])
		expect(testQueryClient.getQueryData(noteContentQueryKey(note.uuid))).toBeUndefined()
	})

	it("calls beforeCacheRemoval AFTER the SDK confirms but BEFORE the cache patch — nav-race guard", async () => {
		const note = mockNote()
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [note])
		const order: string[] = []
		deleteNoteOp.mockImplementationOnce(() => {
			order.push("sdk")
			return Promise.resolve(undefined)
		})

		await deleteNote(note, {
			beforeCacheRemoval: () => {
				order.push("beforeCacheRemoval")
				// The note must still be in the cache at this point — the caller's chance to navigate
				// away from it before it disappears.
				expect(notesQueryGet()).toEqual([note])
			}
		})

		order.push("afterCall")
		expect(order).toEqual(["sdk", "beforeCacheRemoval", "afterCall"])
		expect(notesQueryGet()).toEqual([])
	})

	it("never calls beforeCacheRemoval and leaves the cache untouched on rejection", async () => {
		const note = mockNote()
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [note])
		deleteNoteOp.mockRejectedValueOnce(new Error("fail"))
		const beforeCacheRemoval = vi.fn()

		const outcome = await deleteNote(note, { beforeCacheRemoval })

		expect(outcome.status).toBe("error")
		expect(beforeCacheRemoval).not.toHaveBeenCalled()
		expect(notesQueryGet()).toEqual([note])
	})
})

describe("leaveNote", () => {
	it("removes the current user as a participant and strips the note from the cache", async () => {
		setCurrentUser(7n)
		const note = mockNote({ ownerId: 1n })
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [note])
		removeNoteParticipant.mockResolvedValueOnce(note)

		const outcome = await leaveNote(note)

		expect(removeNoteParticipant).toHaveBeenCalledExactlyOnceWith(note, 7n)
		expect(outcome).toEqual({ status: "success" })
		expect(notesQueryGet()).toEqual([])
	})

	it("errors without calling the worker when there is no resolved current user", async () => {
		const note = mockNote()

		const outcome = await leaveNote(note)

		expect(outcome.status).toBe("error")
		expect(removeNoteParticipant).not.toHaveBeenCalled()
	})
})

describe("setNoteTitle", () => {
	it("no-ops on an empty/whitespace title", async () => {
		const note = mockNote({ title: "Original" })

		await expect(setNoteTitle(note, "   ")).resolves.toEqual({ status: "success", item: note })
		expect(setNoteTitleOp).not.toHaveBeenCalled()
	})

	it("no-ops when the trimmed title is unchanged", async () => {
		const note = mockNote({ title: "Original" })

		await expect(setNoteTitle(note, "  Original  ")).resolves.toEqual({ status: "success", item: note })
		expect(setNoteTitleOp).not.toHaveBeenCalled()
	})

	it("renames with the trimmed value and upserts the result", async () => {
		const note = mockNote({ title: "Original" })
		const updated = { ...note, title: "Renamed" }
		setNoteTitleOp.mockResolvedValueOnce(updated)

		const outcome = await setNoteTitle(note, "  Renamed  ")

		expect(setNoteTitleOp).toHaveBeenCalledExactlyOnceWith(note, "Renamed")
		expect(outcome).toEqual({ status: "success", item: updated })
	})
})

describe("setNoteType", () => {
	it("no-ops when the requested type matches the current one", async () => {
		const note = mockNote({ noteType: "text" })

		await expect(setNoteType(note, "text")).resolves.toEqual({ status: "success", item: note })
		expect(setNoteTypeOp).not.toHaveBeenCalled()
	})

	it("passes cached content as knownContent when present", async () => {
		const note = mockNote({ noteType: "text" })
		testQueryClient.setQueryData(noteContentQueryKey(note.uuid), "cached body")
		const updated = { ...note, noteType: "md" as const }
		setNoteTypeOp.mockResolvedValueOnce(updated)

		const outcome = await setNoteType(note, "md")

		expect(setNoteTypeOp).toHaveBeenCalledExactlyOnceWith(note, "md", "cached body")
		expect(outcome).toEqual({ status: "success", item: updated })
	})

	it("passes undefined knownContent when the content cache is cold", async () => {
		const note = mockNote({ noteType: "text" })
		setNoteTypeOp.mockResolvedValueOnce({ ...note, noteType: "code" as const })

		await setNoteType(note, "code")

		expect(setNoteTypeOp).toHaveBeenCalledExactlyOnceWith(note, "code", undefined)
	})
})

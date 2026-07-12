import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note, NoteTag, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Mock boundary matching notesActions.test.ts / notesTags.test.ts: the real sdk client module
// imports a Vite `?worker`, unresolvable under node vitest.
const {
	setNotePinnedOp,
	setNoteFavoritedOp,
	duplicateNoteOp,
	getNoteContent,
	setNoteTypeOp,
	archiveNoteOp,
	restoreNoteOp,
	trashNoteOp,
	deleteNoteOp,
	removeNoteParticipant,
	addTagToNoteOp,
	removeTagFromNoteOp
} = vi.hoisted(() => ({
	setNotePinnedOp: vi.fn(),
	setNoteFavoritedOp: vi.fn(),
	duplicateNoteOp: vi.fn(),
	getNoteContent: vi.fn(),
	setNoteTypeOp: vi.fn(),
	archiveNoteOp: vi.fn(),
	restoreNoteOp: vi.fn(),
	trashNoteOp: vi.fn(),
	deleteNoteOp: vi.fn(),
	removeNoteParticipant: vi.fn(),
	addTagToNoteOp: vi.fn(),
	removeTagFromNoteOp: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		setNotePinned: setNotePinnedOp,
		setNoteFavorited: setNoteFavoritedOp,
		duplicateNote: duplicateNoteOp,
		getNoteContent,
		setNoteType: setNoteTypeOp,
		archiveNote: archiveNoteOp,
		restoreNote: restoreNoteOp,
		trashNote: trashNoteOp,
		deleteNote: deleteNoteOp,
		removeNoteParticipant,
		addTagToNote: addTagToNoteOp,
		removeTagFromNote: removeTagFromNoteOp
	}
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { notesQueryGet } from "@/features/notes/queries/notes"
import {
	setPinnedNotes,
	setFavoritedNotes,
	setTypeNotes,
	duplicateNotes,
	archiveNotes,
	restoreNotes,
	trashNotes,
	deleteNotesPermanently,
	leaveNotes,
	setTagOnNotes
} from "@/features/notes/lib/bulk"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
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
		encryptionKey: "key",
		title: "title",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 1_700_000_000_000n,
		editedTimestamp: 1_700_000_000_000n,
		participants: [],
		...overrides
	}
}

function mockTag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: testUuid("tag"),
		name: "tag",
		favorite: false,
		editedTimestamp: 1_700_000_000_000n,
		createdTimestamp: 1_700_000_000_000n,
		...overrides
	}
}

function setCurrentUser(id: bigint): void {
	testQueryClient.setQueryData(ACCOUNT_QUERY_KEY, { id })
}

describe("setPinnedNotes / setFavoritedNotes — explicit-target dispatch", () => {
	it("drives every selected note to the SAME target value, not each note's own opposite", async () => {
		const pinned = mockNote({ uuid: testUuid("a"), pinned: true })
		const alreadyUnpinned = mockNote({ uuid: testUuid("b"), pinned: false })
		setNotePinnedOp.mockImplementation((note: Note, pinnedValue: boolean) => Promise.resolve({ ...note, pinned: pinnedValue }))

		await setPinnedNotes([pinned, alreadyUnpinned], false)

		// `pinned` differs from the target (false) — setNotePinned's guard lets it through to the SDK.
		expect(setNotePinnedOp).toHaveBeenCalledWith(pinned, false)
		// `alreadyUnpinned` already matches the target — setNotePinned's own idempotency guard no-ops it
		// before ever reaching the SDK.
		expect(setNotePinnedOp).not.toHaveBeenCalledWith(alreadyUnpinned, expect.anything())
	})

	it("setFavoritedNotes fans out to every selected note and upserts the results", async () => {
		const noteA = mockNote({ uuid: testUuid("a"), favorite: false })
		const noteB = mockNote({ uuid: testUuid("b"), favorite: false })
		setNoteFavoritedOp.mockImplementation((note: Note) => Promise.resolve({ ...note, favorite: true }))

		const outcome = await setFavoritedNotes([noteA, noteB], true)

		expect(outcome.succeeded).toHaveLength(2)
		expect(outcome.failed).toHaveLength(0)
		expect(notesQueryGet()).toEqual(
			expect.arrayContaining([
				{ ...noteA, favorite: true },
				{ ...noteB, favorite: true }
			])
		)
	})
})

describe("duplicateNotes / setTypeNotes", () => {
	it("duplicateNotes reuses duplicateNote per selected note and upserts the duplicate into the cache", async () => {
		const original = mockNote({ uuid: testUuid("orig") })
		const duplicated = mockNote({ uuid: testUuid("dup") })
		getNoteContent.mockResolvedValueOnce("content")
		duplicateNoteOp.mockResolvedValueOnce({ original, duplicated })

		const outcome = await duplicateNotes([original])

		expect(duplicateNoteOp).toHaveBeenCalledExactlyOnceWith(original)
		// runBulk's `succeeded` echoes back the ORIGINAL input item (the unit it dispatched over), not
		// duplicateNote's own return value — mirrors every other bulk helper here and drive's own
		// trashItems/restoreItems precedent. The actual duplicate lands in the cache instead.
		expect(outcome.succeeded).toEqual([original])
		expect(notesQueryGet()).toEqual(expect.arrayContaining([duplicated]))
	})

	it("setTypeNotes converts every selected note to the given type in the cache", async () => {
		const noteA = mockNote({ uuid: testUuid("a"), noteType: "text" })
		const noteB = mockNote({ uuid: testUuid("b"), noteType: "text" })
		setNoteTypeOp.mockImplementation((note: Note) => Promise.resolve({ ...note, noteType: "md" }))

		const outcome = await setTypeNotes([noteA, noteB], "md")

		expect(setNoteTypeOp).toHaveBeenCalledTimes(2)
		expect(outcome.succeeded).toEqual([noteA, noteB])
		expect(notesQueryGet()?.map(n => n.noteType)).toEqual(["md", "md"])
	})
})

describe("archiveNotes / restoreNotes / trashNotes — partial-success aggregation", () => {
	it("a rejected item lands in `failed`, others still succeed", async () => {
		setCurrentUser(1n)
		const okNote = mockNote({ uuid: testUuid("a"), ownerId: 1n })
		const failNote = mockNote({ uuid: testUuid("b"), ownerId: 1n })
		archiveNoteOp.mockImplementation((note: Note) =>
			note.uuid === failNote.uuid ? Promise.reject(new Error("owner_only")) : Promise.resolve({ ...note, archive: true })
		)

		const outcome = await archiveNotes([okNote, failNote])

		// runBulk's `succeeded` echoes back the ORIGINAL input item, not archiveNote's own return value.
		expect(outcome.succeeded).toEqual([okNote])
		expect(outcome.failed).toHaveLength(1)
		expect(outcome.failed[0]?.item).toBe(failNote)
		expect(notesQueryGet()).toEqual(expect.arrayContaining([{ ...okNote, archive: true }]))
	})

	it("restoreNotes calls restoreNote per selected note and upserts the restored note into the cache", async () => {
		const note = mockNote({ archive: true })
		restoreNoteOp.mockResolvedValueOnce({ ...note, archive: false })

		const outcome = await restoreNotes([note])

		expect(restoreNoteOp).toHaveBeenCalledExactlyOnceWith(note)
		expect(outcome.succeeded).toEqual([note])
		expect(notesQueryGet()).toEqual([{ ...note, archive: false }])
	})

	it("trashNotes calls trashNote per selected note, no beforeCacheRemoval plumbing needed", async () => {
		const note = mockNote()
		trashNoteOp.mockResolvedValueOnce({ ...note, trash: true })

		const outcome = await trashNotes([note])

		expect(trashNoteOp).toHaveBeenCalledExactlyOnceWith(note)
		expect(outcome.succeeded).toEqual([note])
		expect(notesQueryGet()).toEqual([{ ...note, trash: true }])
	})
})

describe("deleteNotesPermanently / leaveNotes — per-note beforeCacheRemoval", () => {
	it("deleteNotesPermanently fires beforeCacheRemoval once per successfully deleted note", async () => {
		const noteA = mockNote({ uuid: testUuid("a"), trash: true })
		const noteB = mockNote({ uuid: testUuid("b"), trash: true })
		deleteNoteOp.mockResolvedValue(undefined)
		const beforeCacheRemoval = vi.fn()

		await deleteNotesPermanently([noteA, noteB], { beforeCacheRemoval })

		expect(beforeCacheRemoval).toHaveBeenCalledWith(noteA)
		expect(beforeCacheRemoval).toHaveBeenCalledWith(noteB)
		expect(beforeCacheRemoval).toHaveBeenCalledTimes(2)
	})

	it("leaveNotes calls removeNoteParticipant with the current user's id per selected note", async () => {
		setCurrentUser(9n)
		const note = mockNote({ ownerId: 1n })
		removeNoteParticipant.mockResolvedValueOnce(note)

		const outcome = await leaveNotes([note])

		expect(removeNoteParticipant).toHaveBeenCalledExactlyOnceWith(note, 9n)
		expect(outcome.succeeded).toEqual([note])
	})

	it("leaveNotes fails the item (no crash) when there is no resolved current user", async () => {
		const note = mockNote()

		const outcome = await leaveNotes([note])

		expect(outcome.failed).toHaveLength(1)
		expect(removeNoteParticipant).not.toHaveBeenCalled()
	})
})

describe("setTagOnNotes — checked true adds, checked false removes", () => {
	it("checked=true calls addTagToNote for every selected note", async () => {
		const tag = mockTag()
		const noteA = mockNote({ uuid: testUuid("a"), tags: [] })
		const noteB = mockNote({ uuid: testUuid("b"), tags: [] })
		addTagToNoteOp.mockImplementation((note: Note, t: NoteTag) => Promise.resolve({ note: { ...note, tags: [t] }, tag: t }))

		const outcome = await setTagOnNotes([noteA, noteB], tag, true)

		expect(addTagToNoteOp).toHaveBeenCalledTimes(2)
		expect(removeTagFromNoteOp).not.toHaveBeenCalled()
		expect(outcome.succeeded).toHaveLength(2)
	})

	it("checked=false calls removeTagFromNote for every selected note", async () => {
		const tag = mockTag()
		const note = mockNote({ tags: [tag] })
		removeTagFromNoteOp.mockResolvedValueOnce({ ...note, tags: [] })

		const outcome = await setTagOnNotes([note], tag, false)

		expect(removeTagFromNoteOp).toHaveBeenCalledExactlyOnceWith(note, tag)
		expect(addTagToNoteOp).not.toHaveBeenCalled()
		expect(outcome.succeeded).toEqual([note])
		expect(notesQueryGet()).toEqual([{ ...note, tags: [] }])
	})
})

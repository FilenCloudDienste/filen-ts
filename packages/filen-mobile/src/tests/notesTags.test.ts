import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted mocks (must be defined before any imports)
// ---------------------------------------------------------------------------

const { mockGetSdkClients, mockNotesWithContentQueryUpdate, mockNotesTagsQueryUpdate } = vi.hoisted(() => ({
	mockGetSdkClients: vi.fn(),
	mockNotesWithContentQueryUpdate: vi.fn(),
	mockNotesTagsQueryUpdate: vi.fn()
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/features/notes/queries/useNotesQuery", () => ({
	notesQueryUpdate: mockNotesWithContentQueryUpdate
}))

vi.mock("@/features/notes/queries/useNotesTags.query", () => ({
	notesTagsQueryUpdate: mockNotesTagsQueryUpdate
}))

vi.mock("@/features/notes/utils", () => ({
	wrapSdkNote: vi.fn((n: unknown) => n),
	wrapSdkNoteTag: vi.fn((t: unknown) => t)
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { stripTagFromNotes, deleteTag } from "@/features/notes/notesTags"
import { type NoteTag } from "@/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTag(uuid: string): NoteTag {
	return {
		uuid,
		name: `tag-${uuid}`,
		favorite: false,
		editedTimestamp: BigInt(0),
		createdTimestamp: BigInt(0),
		undecryptable: false
	}
}

function makeNote(uuid: string, tagUuids: string[]) {
	return {
		uuid,
		tags: tagUuids.map(makeTag),
		content: "",
		title: `note-${uuid}`
	}
}

// ---------------------------------------------------------------------------
// Unit tests for the pure helper
// ---------------------------------------------------------------------------

describe("stripTagFromNotes", () => {
	it("removes the tag from every note that has it", () => {
		const tagA = "tag-a"
		const tagB = "tag-b"
		const notes = [
			makeNote("n1", [tagA, tagB]),
			makeNote("n2", [tagA]),
			makeNote("n3", [tagB])
		]

		const result = stripTagFromNotes(notes, tagA)

		expect(result[0]!.tags.map(t => t.uuid)).toEqual([tagB])
		expect(result[1]!.tags).toEqual([])
		expect(result[2]!.tags.map(t => t.uuid)).toEqual([tagB])
	})

	it("leaves notes that never had the tag unchanged (same reference)", () => {
		const tagA = "tag-a"
		const tagB = "tag-b"
		const notes = [makeNote("n1", [tagB])]

		const result = stripTagFromNotes(notes, tagA)

		expect(result[0]).toBe(notes[0])
	})

	it("returns an empty array unchanged", () => {
		expect(stripTagFromNotes([], "any")).toEqual([])
	})

	it("does not mutate the input array", () => {
		const tag = "tag-x"
		const notes = [makeNote("n1", [tag])]
		const originalTags = [...notes[0]!.tags]

		stripTagFromNotes(notes, tag)

		expect(notes[0]!.tags).toEqual(originalTags)
	})
})

// ---------------------------------------------------------------------------
// Integration: deleteTag calls both query updaters
// ---------------------------------------------------------------------------

describe("deleteTag", () => {
	const mockDeleteNoteTag = vi.fn().mockResolvedValue(undefined)

	beforeEach(() => {
		vi.clearAllMocks()
		mockGetSdkClients.mockResolvedValue({
			authedSdkClient: {
				deleteNoteTag: mockDeleteNoteTag
			}
		})
	})

	it("calls notesTagsQueryUpdate to remove the tag from the tags list", async () => {
		const tag = makeTag("tag-del")

		await deleteTag({ tag })

		expect(mockNotesTagsQueryUpdate).toHaveBeenCalledOnce()
		const { updater } = mockNotesTagsQueryUpdate.mock.calls[0]![0]
		const prev = [tag, makeTag("other")]
		expect(updater(prev).map((t: NoteTag) => t.uuid)).toEqual(["other"])
	})

	it("calls notesWithContentQueryUpdate to strip the tag from all notes", async () => {
		const tag = makeTag("tag-del")
		const notes = [makeNote("n1", ["tag-del", "keep"]), makeNote("n2", ["keep"])]

		await deleteTag({ tag })

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()
		const { updater } = mockNotesWithContentQueryUpdate.mock.calls[0]![0]
		const result = updater(notes)
		expect(result[0].tags.map((t: NoteTag) => t.uuid)).toEqual(["keep"])
		expect(result[1].tags.map((t: NoteTag) => t.uuid)).toEqual(["keep"])
	})

	it("calls notesWithContentQueryUpdate even when no notes contain the tag", async () => {
		const tag = makeTag("tag-del")

		await deleteTag({ tag })

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledOnce()
		const { updater } = mockNotesWithContentQueryUpdate.mock.calls[0]![0]
		const notes = [makeNote("n1", ["other"])]
		const result = updater(notes)
		expect(result[0]).toBe(notes[0])
	})
})

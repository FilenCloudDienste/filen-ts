import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note, NoteTag, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const { createNoteTagOp, renameNoteTagOp, deleteNoteTagOp, setNoteTagFavoritedOp, addTagToNoteOp, removeTagFromNoteOp } = vi.hoisted(
	() => ({
		createNoteTagOp: vi.fn(),
		renameNoteTagOp: vi.fn(),
		deleteNoteTagOp: vi.fn(),
		setNoteTagFavoritedOp: vi.fn(),
		addTagToNoteOp: vi.fn(),
		removeTagFromNoteOp: vi.fn()
	})
)

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		createNoteTag: createNoteTagOp,
		renameNoteTag: renameNoteTagOp,
		deleteNoteTag: deleteNoteTagOp,
		setNoteTagFavorited: setNoteTagFavoritedOp,
		addTagToNote: addTagToNoteOp,
		removeTagFromNote: removeTagFromNoteOp
	}
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { NOTES_QUERY_KEY, notesQueryGet } from "@/features/notes/queries/notes"
import { NOTE_TAGS_QUERY_KEY, noteTagsQueryGet } from "@/features/notes/queries/noteTags"
import {
	createNoteTag,
	renameNoteTag,
	deleteNoteTag,
	setNoteTagFavorited,
	addTagToNote,
	removeTagFromNote
} from "@/features/notes/lib/tags"

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

describe("createNoteTag — reserved-name rejection", () => {
	it.each(["all", "favorites", "pinned", "All", "FAVORITES", "  pinned  "])("rejects %j without calling the worker", async name => {
		const outcome = await createNoteTag(name)

		expect(outcome.status).toBe("error")
		expect(createNoteTagOp).not.toHaveBeenCalled()
	})

	it("creates a non-reserved, trimmed name and upserts the tags cache", async () => {
		const tag = mockTag({ name: "work" })
		createNoteTagOp.mockResolvedValueOnce(tag)

		const outcome = await createNoteTag("  work  ")

		expect(createNoteTagOp).toHaveBeenCalledExactlyOnceWith("work")
		expect(outcome).toEqual({ status: "success", item: tag })
		expect(noteTagsQueryGet()).toEqual([tag])
	})

	it("returns an error outcome on rejection", async () => {
		createNoteTagOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await createNoteTag("work")

		expect(outcome.status).toBe("error")
	})
})

describe("renameNoteTag", () => {
	it("rejects a reserved name without calling the worker", async () => {
		const outcome = await renameNoteTag(mockTag(), "Favorites")

		expect(outcome.status).toBe("error")
		expect(renameNoteTagOp).not.toHaveBeenCalled()
	})

	it("renames the tag and patches its name onto every cached note row carrying it", async () => {
		const tag = mockTag({ uuid: testUuid("t"), name: "old" })
		const renamed = { ...tag, name: "new" }
		const noteWithTag = mockNote({ uuid: testUuid("a"), tags: [tag] })
		const noteWithoutTag = mockNote({ uuid: testUuid("b"), tags: [] })
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [noteWithTag, noteWithoutTag])
		renameNoteTagOp.mockResolvedValueOnce(renamed)

		const outcome = await renameNoteTag(tag, "new")

		expect(outcome).toEqual({ status: "success", item: renamed })
		expect(noteTagsQueryGet()).toEqual([renamed])
		expect(notesQueryGet()).toEqual([{ ...noteWithTag, tags: [renamed] }, noteWithoutTag])
	})
})

describe("deleteNoteTag", () => {
	it("removes the tag from the tags cache and strips it from every cached note row", async () => {
		const tag = mockTag({ uuid: testUuid("t") })
		const otherTag = mockTag({ uuid: testUuid("other") })
		const noteWithTag = mockNote({ uuid: testUuid("a"), tags: [tag, otherTag] })
		const noteWithoutTag = mockNote({ uuid: testUuid("b"), tags: [otherTag] })
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [noteWithTag, noteWithoutTag])
		testQueryClient.setQueryData(NOTE_TAGS_QUERY_KEY, [tag, otherTag])
		deleteNoteTagOp.mockResolvedValueOnce(undefined)

		const outcome = await deleteNoteTag(tag)

		expect(outcome).toEqual({ status: "success" })
		expect(noteTagsQueryGet()).toEqual([otherTag])
		expect(notesQueryGet()).toEqual([
			{ ...noteWithTag, tags: [otherTag] },
			{ ...noteWithoutTag, tags: [otherTag] }
		])
	})

	it("returns an error outcome on rejection, without patching either cache", async () => {
		const tag = mockTag()
		testQueryClient.setQueryData(NOTE_TAGS_QUERY_KEY, [tag])
		deleteNoteTagOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await deleteNoteTag(tag)

		expect(outcome.status).toBe("error")
		expect(noteTagsQueryGet()).toEqual([tag])
	})
})

describe("setNoteTagFavorited", () => {
	it("no-ops when the requested state matches the current one", async () => {
		const tag = mockTag({ favorite: true })

		await expect(setNoteTagFavorited(tag, true)).resolves.toEqual({ status: "success", item: tag })
		expect(setNoteTagFavoritedOp).not.toHaveBeenCalled()
	})

	it("favorites and upserts the result", async () => {
		const tag = mockTag({ favorite: false })
		const updated = { ...tag, favorite: true }
		setNoteTagFavoritedOp.mockResolvedValueOnce(updated)

		const outcome = await setNoteTagFavorited(tag, true)

		expect(setNoteTagFavoritedOp).toHaveBeenCalledExactlyOnceWith(tag, true)
		expect(outcome).toEqual({ status: "success", item: updated })
	})
})

describe("addTagToNote — idempotent", () => {
	it("is a no-op (no worker call) when the note already carries the tag", async () => {
		const tag = mockTag()
		const note = mockNote({ tags: [tag] })

		const outcome = await addTagToNote(note, tag)

		expect(outcome).toEqual({ status: "success", item: note })
		expect(addTagToNoteOp).not.toHaveBeenCalled()
	})

	it("adds the tag and patches both the note and tag caches", async () => {
		const tag = mockTag()
		const note = mockNote({ tags: [] })
		const updatedNote = { ...note, tags: [tag] }
		addTagToNoteOp.mockResolvedValueOnce({ note: updatedNote, tag })

		const outcome = await addTagToNote(note, tag)

		expect(addTagToNoteOp).toHaveBeenCalledExactlyOnceWith(note, tag)
		expect(outcome).toEqual({ status: "success", item: updatedNote })
		expect(notesQueryGet()).toEqual([updatedNote])
		expect(noteTagsQueryGet()).toEqual([tag])
	})
})

describe("removeTagFromNote — idempotent", () => {
	it("is a no-op (no worker call) when the note does not carry the tag", async () => {
		const tag = mockTag()
		const note = mockNote({ tags: [] })

		const outcome = await removeTagFromNote(note, tag)

		expect(outcome).toEqual({ status: "success", item: note })
		expect(removeTagFromNoteOp).not.toHaveBeenCalled()
	})

	it("removes the tag and upserts the result", async () => {
		const tag = mockTag()
		const note = mockNote({ tags: [tag] })
		const updated = { ...note, tags: [] }
		removeTagFromNoteOp.mockResolvedValueOnce(updated)

		const outcome = await removeTagFromNote(note, tag)

		expect(removeTagFromNoteOp).toHaveBeenCalledExactlyOnceWith(note, tag)
		expect(outcome).toEqual({ status: "success", item: updated })
		expect(notesQueryGet()).toEqual([updated])
	})
})

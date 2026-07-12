import { beforeEach, describe, expect, it } from "vitest"
import type { Note, UuidStr } from "@filen/sdk-rs"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// Selection logic is keyed only by uuid, so a minimal fixture is enough — mirrors
// useDriveStore.test.ts's own directoryItem() fixture rationale.
function mockNote(uuid: UuidStr): Note {
	return {
		uuid,
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		trash: false,
		archive: false,
		createdTimestamp: 1_700_000_000_000n,
		editedTimestamp: 1_700_000_000_000n,
		participants: []
	}
}

beforeEach(() => {
	useNotesSelectionStore.setState({ selectedNotes: [] })
})

describe("toggleSelectedNote", () => {
	it("adds a note that is not yet selected", () => {
		const note = mockNote(testUuid("a"))

		useNotesSelectionStore.getState().toggleSelectedNote(note)

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([note])
	})

	it("removes an already-selected note, matched by uuid", () => {
		const note = mockNote(testUuid("a"))

		useNotesSelectionStore.setState({ selectedNotes: [note] })
		useNotesSelectionStore.getState().toggleSelectedNote(note)

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([])
	})

	it("toggling the same note twice restores the original selection", () => {
		const note = mockNote(testUuid("a"))

		useNotesSelectionStore.getState().toggleSelectedNote(note)
		useNotesSelectionStore.getState().toggleSelectedNote(note)

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([])
	})

	it("does not mutate the previous array (returns a new reference)", () => {
		const prev = useNotesSelectionStore.getState().selectedNotes

		useNotesSelectionStore.getState().toggleSelectedNote(mockNote(testUuid("a")))

		expect(useNotesSelectionStore.getState().selectedNotes).not.toBe(prev)
	})

	it("only affects the matching uuid, leaving other selected notes untouched", () => {
		const noteA = mockNote(testUuid("a"))
		const noteB = mockNote(testUuid("b"))

		useNotesSelectionStore.setState({ selectedNotes: [noteA, noteB] })
		useNotesSelectionStore.getState().toggleSelectedNote(noteA)

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteB])
	})
})

describe("setSelectedNotes", () => {
	it("accepts a plain array and replaces the selection", () => {
		const note = mockNote(testUuid("a"))

		useNotesSelectionStore.getState().setSelectedNotes([note])

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([note])
	})

	it("accepts an updater function that reads the previous selection", () => {
		const noteA = mockNote(testUuid("a"))
		const noteB = mockNote(testUuid("b"))

		useNotesSelectionStore.setState({ selectedNotes: [noteA] })
		useNotesSelectionStore.getState().setSelectedNotes(prev => [...prev, noteB])

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA, noteB])
	})
})

describe("removeFromSelection", () => {
	it("removes only the given uuids", () => {
		const noteA = mockNote(testUuid("a"))
		const noteB = mockNote(testUuid("b"))

		useNotesSelectionStore.setState({ selectedNotes: [noteA, noteB] })
		useNotesSelectionStore.getState().removeFromSelection([testUuid("a")])

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteB])
	})

	it("is a no-op (same array reference) when none of the given uuids are selected", () => {
		const noteA = mockNote(testUuid("a"))

		useNotesSelectionStore.setState({ selectedNotes: [noteA] })

		const prev = useNotesSelectionStore.getState().selectedNotes

		useNotesSelectionStore.getState().removeFromSelection([testUuid("z")])

		expect(useNotesSelectionStore.getState().selectedNotes).toBe(prev)
	})
})

describe("clearSelectedNotes", () => {
	it("empties a non-empty selection", () => {
		useNotesSelectionStore.setState({ selectedNotes: [mockNote(testUuid("a"))] })
		useNotesSelectionStore.getState().clearSelectedNotes()

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([])
	})
})

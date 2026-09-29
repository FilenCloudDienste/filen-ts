import { beforeEach, describe, expect, it } from "vitest"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"
import { describeSelectionStoreContract } from "@/tests/contracts/selection"
import { testUuid } from "@/tests/support/uuid"
import { mockNote } from "@/tests/fixtures/notes"

beforeEach(() => {
	useNotesSelectionStore.setState({ selectedNotes: [] })
})

describeSelectionStoreContract({
	makeItem: uuid => mockNote({ uuid }),
	selected: () => useNotesSelectionStore.getState().selectedNotes,
	seed: selectedNotes => {
		useNotesSelectionStore.setState({ selectedNotes })
	},
	toggle: note => {
		useNotesSelectionStore.getState().toggleSelectedNote(note)
	},
	set: next => {
		useNotesSelectionStore.getState().setSelectedNotes(next)
	},
	remove: uuids => {
		useNotesSelectionStore.getState().removeFromSelection(uuids)
	},
	clear: () => {
		useNotesSelectionStore.getState().clearSelectedNotes()
	}
})

describe("setSelectedNotes", () => {
	it("collapses a uuid that appears more than once in the given array to a single entry", () => {
		// The tags view renders the same note once per expanded tag group it belongs to, so a
		// select-all or a shift-click range spanning two of those rows can hand this in with the same
		// note object twice — the store must not let that inflate the selection count or double-dispatch
		// a bulk action against the same note.
		const noteA = mockNote({ uuid: testUuid("a") })
		const noteB = mockNote({ uuid: testUuid("b") })

		useNotesSelectionStore.getState().setSelectedNotes([noteA, noteB, noteA])

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA, noteB])
	})

	it("also dedupes when the duplicate arrives through the updater-function form", () => {
		const noteA = mockNote({ uuid: testUuid("a") })

		useNotesSelectionStore.setState({ selectedNotes: [noteA] })
		useNotesSelectionStore.getState().setSelectedNotes(prev => [...prev, noteA])

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA])
	})
})

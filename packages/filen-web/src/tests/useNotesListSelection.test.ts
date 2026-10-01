// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useNotesListSelection } from "@/features/notes/hooks/useNotesListSelection"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"
import { clickEvent, describeClickSelectionContract } from "@/tests/contracts/selection"
import { testUuid } from "@/tests/support/uuid"
import { mockNote } from "@/tests/fixtures/notes"

const noteA = mockNote({ uuid: testUuid("a") })
const noteB = mockNote({ uuid: testUuid("b") })
const noteC = mockNote({ uuid: testUuid("c") })
const noteD = mockNote({ uuid: testUuid("d") })
const noteE = mockNote({ uuid: testUuid("e") })
const notes = [noteA, noteB, noteC, noteD, noteE]

beforeEach(() => {
	useNotesSelectionStore.setState({ selectedNotes: [] })
})

describeClickSelectionContract({
	items: notes,
	render: () =>
		renderHook(() =>
			useNotesListSelection({ notes, resetKey: "notes", selectionCount: useNotesSelectionStore(state => state.selectedNotes.length) })
		).result,
	selected: () => useNotesSelectionStore.getState().selectedNotes,
	seed: selectedNotes => {
		useNotesSelectionStore.setState({ selectedNotes })
	}
})

describe("useNotesListSelection — Shift+click range", () => {
	it("a range spanning two rows for the SAME note (tags view: one note under two expanded tags) selects it once", () => {
		// Mirrors what notesSidebar.tsx actually feeds this hook in the tags view — selectableNotesFromRows
		// gives a note its own row (and so its own index) under every expanded tag it belongs to, so the
		// row array can carry the same Note object at two different positions.
		const notesWithDuplicateRow = [noteA, noteB, noteA]
		const { result } = renderHook(() => useNotesListSelection({ notes: notesWithDuplicateRow, resetKey: "notes", selectionCount: 0 }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent(), "mouse")
		})
		act(() => {
			result.current.handlePointerSelect(2, clickEvent({ shiftKey: true }), "mouse")
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA, noteB])
	})
})

describe("useNotesListSelection — resetKey change clears the selection", () => {
	it("clears the selection when resetKey changes across a re-render", () => {
		const { result, rerender } = renderHook(({ resetKey }) => useNotesListSelection({ notes, resetKey, selectionCount: 0 }), {
			initialProps: { resetKey: "notes" }
		})

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }), "mouse")
		})
		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA])

		act(() => {
			rerender({ resetKey: "tags" })
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([])
	})

	it("a shift-click after a resetKey change ranges from the fresh anchor, not a stale one", () => {
		const { result, rerender } = renderHook(({ resetKey }) => useNotesListSelection({ notes, resetKey, selectionCount: 0 }), {
			initialProps: { resetKey: "notes" }
		})

		act(() => {
			result.current.handlePointerSelect(3, clickEvent(), "mouse")
		})
		act(() => {
			rerender({ resetKey: "tags" })
		})
		act(() => {
			result.current.handlePointerSelect(1, clickEvent({ shiftKey: true }), "mouse")
		})

		// The anchor reset to null on the resetKey change, which resolveCursorIndex falls back to 0 for
		// — so the range runs from index 0, not the stale index-3 anchor.
		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA, noteB])
	})
})

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { MouseEvent as ReactMouseEvent } from "react"
import type { Note, UuidStr } from "@filen/sdk-rs"
import { useNotesListSelection } from "@/features/notes/hooks/useNotesListSelection"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

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

function clickEvent(modifiers: Partial<Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">> = {}): ReactMouseEvent {
	return { shiftKey: false, metaKey: false, ctrlKey: false, ...modifiers } as ReactMouseEvent
}

const noteA = mockNote(testUuid("a"))
const noteB = mockNote(testUuid("b"))
const noteC = mockNote(testUuid("c"))
const noteD = mockNote(testUuid("d"))
const noteE = mockNote(testUuid("e"))
const notes = [noteA, noteB, noteC, noteD, noteE]

beforeEach(() => {
	useNotesSelectionStore.setState({ selectedNotes: [] })
})

describe("useNotesListSelection — plain click", () => {
	it("replaces the selection with just the clicked note, regardless of prior selection", () => {
		const { result } = renderHook(() => useNotesListSelection({ notes, resetKey: "notes" }))

		// Build up a prior multi-selection through the hook itself — mounting with the store
		// pre-seeded externally would immediately clear it (the hook's own mount effect resets any
		// inherited selection, mirroring useDriveListboxNav's identical "a fresh mount never inherits a
		// stale selection" rule).
		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }))
		})
		act(() => {
			result.current.handlePointerSelect(1, clickEvent({ ctrlKey: true }))
		})
		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA, noteB])

		act(() => {
			result.current.handlePointerSelect(2, clickEvent())
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteC])
	})

	it("is a no-op when the index has no matching note", () => {
		const { result } = renderHook(() => useNotesListSelection({ notes, resetKey: "notes" }))

		act(() => {
			result.current.handlePointerSelect(99, clickEvent())
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([])
	})
})

describe("useNotesListSelection — Ctrl/Cmd+click toggles", () => {
	it("adds an unselected note to the selection", () => {
		const { result } = renderHook(() => useNotesListSelection({ notes, resetKey: "notes" }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }))
		})
		act(() => {
			result.current.handlePointerSelect(2, clickEvent({ metaKey: true }))
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA, noteC])
	})

	it("removes an already-selected note, leaving the rest untouched", () => {
		const { result } = renderHook(() => useNotesListSelection({ notes, resetKey: "notes" }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }))
		})
		act(() => {
			result.current.handlePointerSelect(1, clickEvent({ ctrlKey: true }))
		})
		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA, noteB])

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }))
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteB])
	})
})

describe("useNotesListSelection — Shift+click range", () => {
	it("extends a range from the last plain-click/ctrl-click anchor to the shift-clicked index", () => {
		const { result } = renderHook(() => useNotesListSelection({ notes, resetKey: "notes" }))

		act(() => {
			result.current.handlePointerSelect(1, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect(3, clickEvent({ shiftKey: true }))
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteB, noteC, noteD])
	})

	it("range is ascending regardless of which side (anchor or target) is later in the list", () => {
		const { result } = renderHook(() => useNotesListSelection({ notes, resetKey: "notes" }))

		act(() => {
			result.current.handlePointerSelect(3, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect(1, clickEvent({ shiftKey: true }))
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteB, noteC, noteD])
	})

	it("a second shift-click re-anchors from the ORIGINAL (non-shift) anchor, not the previous shift target", () => {
		const { result } = renderHook(() => useNotesListSelection({ notes, resetKey: "notes" }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect(2, clickEvent({ shiftKey: true }))
		})
		act(() => {
			result.current.handlePointerSelect(4, clickEvent({ shiftKey: true }))
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual(notes)
	})

	it("a range spanning two rows for the SAME note (tags view: one note under two expanded tags) selects it once", () => {
		// Mirrors what notesSidebar.tsx actually feeds this hook in the tags view — selectableNotesFromRows
		// gives a note its own row (and so its own index) under every expanded tag it belongs to, so the
		// row array can carry the same Note object at two different positions.
		const notesWithDuplicateRow = [noteA, noteB, noteA]
		const { result } = renderHook(() => useNotesListSelection({ notes: notesWithDuplicateRow, resetKey: "notes" }))

		act(() => {
			result.current.handlePointerSelect(0, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect(2, clickEvent({ shiftKey: true }))
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA, noteB])
	})
})

describe("useNotesListSelection — resetKey change clears the selection", () => {
	it("clears the selection when resetKey changes across a re-render", () => {
		const { result, rerender } = renderHook(({ resetKey }) => useNotesListSelection({ notes, resetKey }), {
			initialProps: { resetKey: "notes" }
		})

		act(() => {
			result.current.handlePointerSelect(0, clickEvent({ ctrlKey: true }))
		})
		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA])

		act(() => {
			rerender({ resetKey: "tags" })
		})

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([])
	})

	it("mounting fresh never inherits a selection already sitting in the store from elsewhere", () => {
		useNotesSelectionStore.setState({ selectedNotes: [noteA] })

		renderHook(() => useNotesListSelection({ notes, resetKey: "notes" }))

		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([])
	})

	it("a shift-click after a resetKey change ranges from the fresh anchor, not a stale one", () => {
		const { result, rerender } = renderHook(({ resetKey }) => useNotesListSelection({ notes, resetKey }), {
			initialProps: { resetKey: "notes" }
		})

		act(() => {
			result.current.handlePointerSelect(3, clickEvent())
		})
		act(() => {
			rerender({ resetKey: "tags" })
		})
		act(() => {
			result.current.handlePointerSelect(1, clickEvent({ shiftKey: true }))
		})

		// The anchor reset to null on the resetKey change, which resolveCursorIndex falls back to 0 for
		// — so the range runs from index 0, not the stale index-3 anchor.
		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([noteA, noteB])
	})
})

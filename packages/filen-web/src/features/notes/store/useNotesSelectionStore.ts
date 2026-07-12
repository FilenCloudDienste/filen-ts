import { create } from "zustand"
import type { Note } from "@filen/sdk-rs"

// Add if absent (by uuid), remove if present — mirrors useDriveStore's own toggleInArray. Returns a
// new array; the input is never mutated.
function toggleInArray<T>(items: T[], item: T, getId: (item: T) => string): T[] {
	const id = getId(item)
	const index = items.findIndex(existing => getId(existing) === id)

	if (index >= 0) {
		return [...items.slice(0, index), ...items.slice(index + 1)]
	}

	return [...items, item]
}

const noteId = (note: Note): string => note.uuid

interface NotesSelectionState {
	selectedNotes: Note[]
	setSelectedNotes: (next: Note[] | ((prev: Note[]) => Note[])) => void
	toggleSelectedNote: (note: Note) => void
	removeFromSelection: (uuids: string[]) => void
	clearSelectedNotes: () => void
}

// The notes-list multi-selection store — a port of useDriveStore's own selection shape onto notes.
// Kept as its own small store (not a generic "selection" store parameterized over item type) for the
// same reason useDriveStore isn't: each surface's selection is read by a different set of components
// with a different re-render footprint, and a shared store would over-notify every subscriber on every
// domain's change.
export const useNotesSelectionStore = create<NotesSelectionState>(set => ({
	selectedNotes: [],
	setSelectedNotes: next => {
		set(state => ({
			selectedNotes: typeof next === "function" ? next(state.selectedNotes) : next
		}))
	},
	toggleSelectedNote: note => {
		set(state => ({
			selectedNotes: toggleInArray(state.selectedNotes, note, noteId)
		}))
	},
	removeFromSelection: uuids => {
		set(state => {
			const toRemove = new Set(uuids)
			const next = state.selectedNotes.filter(note => !toRemove.has(noteId(note)))

			// Avoid a needless state update (and re-render) when nothing was actually selected.
			if (next.length === state.selectedNotes.length) {
				return state
			}

			return { selectedNotes: next }
		})
	},
	clearSelectedNotes: () => {
		set({ selectedNotes: [] })
	}
}))

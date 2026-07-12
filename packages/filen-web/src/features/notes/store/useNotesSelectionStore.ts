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

// The notes sidebar can render the SAME note more than once — the tags view gives a note its own row
// under every expanded tag it carries, so a select-all or a shift-click range spanning two of those
// rows walks the same note twice. Collapsing here (the single place every multi-note write funnels
// through) keeps the selection count and every downstream bulk dispatch honest, no matter which
// caller handed in the duplicate.
function dedupeByUuid(notes: Note[]): Note[] {
	const seen = new Set<string>()
	const deduped: Note[] = []

	for (const note of notes) {
		if (!seen.has(note.uuid)) {
			seen.add(note.uuid)
			deduped.push(note)
		}
	}

	return deduped
}

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
			selectedNotes: dedupeByUuid(typeof next === "function" ? next(state.selectedNotes) : next)
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

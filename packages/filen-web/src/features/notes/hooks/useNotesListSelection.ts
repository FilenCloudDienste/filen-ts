import type { Note } from "@filen/sdk-rs"
import { useListPointerSelection, type ListPointerSelection, type ListPointerSelectionActions } from "@/lib/useListPointerSelection"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"

export interface UseNotesListSelectionParams {
	// Every note row across whichever sidebar view is active (notesSidebar.tsx's flattened `rows`,
	// note-kind entries only), in render order.
	notes: readonly Note[]
	// A fresh view must never inherit the previous one's selection/anchor — keyed on the sidebar's
	// view mode (mirrors drive's [variant, splat] reset in useDriveListboxNav), so switching between
	// the notes and tags views clears any active selection (mobile parity, notesHeaderMenuBuilders.ts's
	// own view-mode-switch clear).
	resetKey: string
}

const NOTES_SELECTION_ACTIONS: ListPointerSelectionActions<Note> = {
	set: notes => {
		useNotesSelectionStore.getState().setSelectedNotes(notes)
	},
	toggle: note => {
		useNotesSelectionStore.getState().toggleSelectedNote(note)
	},
	clear: () => {
		useNotesSelectionStore.getState().clearSelectedNotes()
	}
}

// Plain click on a row still lets its Link navigate (see noteRow.tsx).
export function useNotesListSelection({ notes, resetKey }: UseNotesListSelectionParams): ListPointerSelection {
	return useListPointerSelection({ items: notes, actions: NOTES_SELECTION_ACTIONS, resetKey })
}

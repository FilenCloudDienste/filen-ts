import type { Note } from "@filen/sdk-rs"
import { sortNotes } from "@/features/notes/lib/sort"

export interface NotesIndexRedirectInput {
	// undefined while the stored value is still being read.
	storedUuid: string | null | undefined
	notes: readonly Note[] | undefined
	pending: boolean
}

// Where bare /notes goes: the last opened note while it still exists, else the first note in sidebar
// order; null when there is nothing to open, undefined while undecided.
export function notesIndexRedirectTarget({ storedUuid, notes, pending }: NotesIndexRedirectInput): string | null | undefined {
	if (pending) {
		return undefined
	}

	if (notes === undefined || notes.length === 0) {
		return null
	}

	if (storedUuid === undefined) {
		return undefined
	}

	if (storedUuid !== null && notes.some(note => note.uuid === storedUuid)) {
		return storedUuid
	}

	return sortNotes(notes)[0]?.uuid ?? null
}

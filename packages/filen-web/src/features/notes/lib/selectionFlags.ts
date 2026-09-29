import type { Note } from "@filen/sdk-rs"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"

// The set a "select all" builds from — every currently-visible note except the undecryptable ones
// (a ghost row that can never be acted on shouldn't inflate the selection count), mirroring drive's
// selectableForSelectAll. A note the tags view renders once per expanded tag is left duplicated here:
// useNotesSelectionStore.setSelectedNotes collapses it on write.
export function selectableNotesForSelectAll(notes: readonly Note[]): Note[] {
	return notes.filter(note => !isNoteUndecryptable(note))
}

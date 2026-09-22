import type { Note } from "@filen/sdk-rs"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"

// The set a "select all" builds from — every currently-visible note except the undecryptable ones
// (a ghost row that can never be acted on shouldn't inflate the selection count), mirroring drive's
// selectableForSelectAll. `notes` may carry the same uuid more than once (the tags view renders a
// note once per expanded tag it belongs to), so this also collapses back to one entry per distinct
// note — the count "select all" reports must match what the user actually sees selected, not the
// number of rows that note happens to occupy.
export function selectableNotesForSelectAll(notes: readonly Note[]): Note[] {
	const seen = new Set<string>()
	const result: Note[] = []

	for (const note of notes) {
		if (isNoteUndecryptable(note) || seen.has(note.uuid)) {
			continue
		}

		seen.add(note.uuid)
		result.push(note)
	}

	return result
}

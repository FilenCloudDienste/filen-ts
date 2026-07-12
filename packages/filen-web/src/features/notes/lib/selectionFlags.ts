import type { Note } from "@filen/sdk-rs"
import { isNoteOwner } from "@/features/notes/lib/actions"
import { isNoteUndecryptable } from "@/features/notes/lib/sort"

// Aggregated flags for a Notes multi-selection, computed in a single pass — the bulk-action bar's
// only source of gating truth. Mirrors features/drive/lib/selectionFlags.ts's own
// DriveSelectionFlags/aggregateDriveSelectionFlags shape, widened with the ownership/write-access/
// lifecycle facts a note (unlike a drive item) needs: archive/trash are two independent booleans
// here (a drive item only ever has one "removed" state, trash), and every selected note's
// relationship to the CURRENT user (owner vs. write-access participant vs. read-only participant)
// gates a different subset of bulk actions.
export interface NoteSelectionFlags {
	count: number
	includesFavorited: boolean
	includesPinned: boolean
	// True iff any selected note has `archive: true`. Gates the bulk Archive action (must be
	// entirely absent from the selection for Archive to make sense).
	includesArchived: boolean
	// True iff any selected note has `trash: true`. Gates bulk Archive/Trash.
	includesTrashed: boolean
	// True iff any selected note's metadata never decrypted for this account — every bulk action
	// needing decrypted metadata (pin/favorite/type/tags/duplicate/export) is suppressed whole-selection
	// wide, matching noteMenuActions' own per-note reduction to pure-uuid actions.
	includesUndecryptable: boolean
	// True iff the current user owns every selected note. Gates Archive/Trash/Delete/Restore —
	// lifecycle transitions are owner-only, mirroring noteMenuActions' per-note ARCHIVE/TRASH gate.
	everyOwned: boolean
	everyTrashed: boolean
	// True iff every selected note is archived OR trashed (no active note in the mix) — gates bulk
	// Restore, which would otherwise be a silent no-op on an active note.
	everyArchivedOrTrashed: boolean
	// True iff the current user has write access (owner OR a participant with permissionsWrite) to
	// every selected note. Gates bulk type-change specifically — mobile's own bulk gate.
	hasWriteAccessToAll: boolean
	// True iff the current user is a participant (not owner) on every selected note. Gates bulk
	// Leave — only a non-owner can leave; an owner trashes/deletes instead.
	participantOfEveryAndNotOwner: boolean
}

const EMPTY_NOTE_SELECTION_FLAGS: NoteSelectionFlags = Object.freeze({
	count: 0,
	includesFavorited: false,
	includesPinned: false,
	includesArchived: false,
	includesTrashed: false,
	includesUndecryptable: false,
	everyOwned: false,
	everyTrashed: false,
	everyArchivedOrTrashed: false,
	hasWriteAccessToAll: false,
	participantOfEveryAndNotOwner: false
})

export function aggregateNoteSelectionFlags(notes: readonly Note[], currentUserId: bigint | undefined): NoteSelectionFlags {
	if (notes.length === 0 || currentUserId === undefined) {
		return EMPTY_NOTE_SELECTION_FLAGS
	}

	let includesFavorited = false
	let includesPinned = false
	let includesArchived = false
	let includesTrashed = false
	let includesUndecryptable = false
	let everyOwned = true
	let everyTrashed = true
	let everyArchivedOrTrashed = true
	let hasWriteAccessToAll = true
	let participantOfEveryAndNotOwner = true

	for (const note of notes) {
		if (note.favorite) {
			includesFavorited = true
		}

		if (note.pinned) {
			includesPinned = true
		}

		if (note.archive) {
			includesArchived = true
		}

		if (note.trash) {
			includesTrashed = true
		}

		if (isNoteUndecryptable(note)) {
			includesUndecryptable = true
		}

		if (!note.trash) {
			everyTrashed = false
		}

		if (!note.archive && !note.trash) {
			everyArchivedOrTrashed = false
		}

		const owner = isNoteOwner(note, currentUserId)
		const participant = note.participants.find(p => p.userId === currentUserId)
		const hasWrite = owner || (participant?.permissionsWrite ?? false)

		if (!owner) {
			everyOwned = false
		}

		if (!hasWrite) {
			hasWriteAccessToAll = false
		}

		if (owner || participant === undefined) {
			participantOfEveryAndNotOwner = false
		}
	}

	return {
		count: notes.length,
		includesFavorited,
		includesPinned,
		includesArchived,
		includesTrashed,
		includesUndecryptable,
		everyOwned,
		everyTrashed,
		everyArchivedOrTrashed,
		hasWriteAccessToAll,
		participantOfEveryAndNotOwner
	}
}

// The set a "select all" builds from — every currently-visible note except the undecryptable ones
// (a ghost row that can never be acted on shouldn't inflate the selection count), mirroring drive's
// selectableForSelectAll.
export function selectableNotesForSelectAll(notes: readonly Note[]): Note[] {
	return notes.filter(note => !isNoteUndecryptable(note))
}

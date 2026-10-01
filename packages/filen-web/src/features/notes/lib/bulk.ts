import type { Note, NoteTag, NoteType } from "@filen/sdk-rs"
import { runBulkOutcomes, type BulkOutcome, type BulkProgress } from "@/lib/actions/bulk"
import {
	setNotePinned,
	setNoteFavorited,
	duplicateNote,
	setNoteType,
	archiveNote,
	restoreNote,
	trashNote,
	deleteNote,
	leaveNote,
	type DeleteNoteOptions
} from "@/features/notes/lib/actions"
import { addTagToNote, removeTagFromNote } from "@/features/notes/lib/tags"

// Bulk-action layer for the notes multi-selection bar — every helper reuses the exact single-note
// op + cache patch from lib/actions.ts/lib/tags.ts (never a duplicated SDK call), fanned out through
// runBulkOutcomes for the same partial-success semantics every other bulk surface uses. `onSettled`
// counts the run for its activity toast.

// ── Pin / favorite / type ────────────────────────────────────────────────

// Explicit-target (not per-note toggle): every selected note is driven to the SAME `pinned`/
// `favorited` value — the bulk bar computes that target from the selection's own majority flag
// (`!flags.includesPinned`/`!flags.includesFavorited`, mobile's SET semantics), never each note's
// individual current state.
export function setPinnedNotes(notes: readonly Note[], pinned: boolean, onSettled?: BulkProgress): Promise<BulkOutcome<Note>> {
	return runBulkOutcomes(notes, note => setNotePinned(note, pinned), onSettled)
}

export function setFavoritedNotes(notes: readonly Note[], favorited: boolean, onSettled?: BulkProgress): Promise<BulkOutcome<Note>> {
	return runBulkOutcomes(notes, note => setNoteFavorited(note, favorited), onSettled)
}

export function setTypeNotes(notes: readonly Note[], noteType: NoteType, onSettled?: BulkProgress): Promise<BulkOutcome<Note>> {
	return runBulkOutcomes(notes, note => setNoteType(note, noteType), onSettled)
}

// ── Duplicate / lifecycle ────────────────────────────────────────────────

export function duplicateNotes(notes: readonly Note[], onSettled?: BulkProgress): Promise<BulkOutcome<Note>> {
	return runBulkOutcomes(notes, note => duplicateNote(note), onSettled)
}

export function archiveNotes(notes: readonly Note[], onSettled?: BulkProgress): Promise<BulkOutcome<Note>> {
	return runBulkOutcomes(notes, note => archiveNote(note), onSettled)
}

export function restoreNotes(notes: readonly Note[], onSettled?: BulkProgress): Promise<BulkOutcome<Note>> {
	return runBulkOutcomes(notes, note => restoreNote(note), onSettled)
}

// Bulk trash needs no nav-away guard (trashNote upserts the note in place, trash:true — it stays
// visible/routable, same as the single-item action), unlike delete/leave below which remove the
// note from the cache outright.
export function trashNotes(notes: readonly Note[], onSettled?: BulkProgress): Promise<BulkOutcome<Note>> {
	return runBulkOutcomes(notes, note => trashNote(note), onSettled)
}

export interface BulkDeleteOrLeaveOptions {
	// Fired per-note, BEFORE that note leaves the cache — mirrors DeleteNoteOptions.beforeCacheRemoval,
	// threaded through so the caller (useNoteDialogHost) can navigate away first if the CURRENTLY
	// routed note happens to be among those permanently deleted/left in this batch.
	beforeCacheRemoval?: (note: Note) => void
}

export function deleteNotesPermanently(
	notes: readonly Note[],
	opts?: BulkDeleteOrLeaveOptions,
	onSettled?: BulkProgress
): Promise<BulkOutcome<Note>> {
	return runBulkOutcomes<Note>(
		notes,
		note => {
			const noteOpts: DeleteNoteOptions = { beforeCacheRemoval: () => opts?.beforeCacheRemoval?.(note) }

			return deleteNote(note, noteOpts)
		},
		onSettled
	)
}

export function leaveNotes(notes: readonly Note[], opts?: BulkDeleteOrLeaveOptions, onSettled?: BulkProgress): Promise<BulkOutcome<Note>> {
	return runBulkOutcomes<Note>(
		notes,
		note => {
			const noteOpts: DeleteNoteOptions = { beforeCacheRemoval: () => opts?.beforeCacheRemoval?.(note) }

			return leaveNote(note, noteOpts)
		},
		onSettled
	)
}

// ── Tags ──────────────────────────────────────────────────────────────────

// Drives every selected note's membership of `tag` to the SAME `checked` target — the bulk tags
// submenu's tri-state checkbox (checked only when EVERY selected note already carries the tag)
// toggles the whole selection to the opposite of that.
export function setTagOnNotes(
	notes: readonly Note[],
	tag: NoteTag,
	checked: boolean,
	onSettled?: BulkProgress
): Promise<BulkOutcome<Note>> {
	return runBulkOutcomes(notes, note => (checked ? addTagToNote(note, tag) : removeTagFromNote(note, tag)), onSettled)
}

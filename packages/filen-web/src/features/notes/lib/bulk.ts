import type { Note, NoteTag, NoteType } from "@filen/sdk-rs"
import { type ErrorDTO } from "@/lib/sdk/errors"
import { runBulk, type BulkOutcome } from "@/features/drive/lib/bulk"
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
// drive's generic runBulk for the same partial-success semantics every other bulk surface uses.

// Adapts any never-throwing outcome-returning helper above into runBulk's throw-on-failure per-item
// contract — mirrors features/contacts/lib/actions.ts's runContactsBulk exactly, generalized to also
// accept an ActionOutcome<Note> (whose success arm carries `item`, structurally still assignable to
// the narrower shape below).
function runNotesBulk<T>(
	items: readonly T[],
	perItem: (item: T) => Promise<{ status: "success" } | { status: "error"; dto: ErrorDTO }>
): Promise<BulkOutcome<T>> {
	return runBulk([...items], async item => {
		const outcome = await perItem(item)

		if (outcome.status === "error") {
			// Mirrors runOp/runContactsBulk: a plain ErrorDTO thrown intact is what runBulk's per-item
			// catch (and the BulkFailure.error it produces) expects to receive.
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberate, see above
			throw outcome.dto
		}
	})
}

// ── Pin / favorite / type ────────────────────────────────────────────────

// Explicit-target (not per-note toggle): every selected note is driven to the SAME `pinned`/
// `favorited` value — the bulk bar computes that target from the selection's own majority flag
// (`!flags.includesPinned`/`!flags.includesFavorited`, mobile's SET semantics), never each note's
// individual current state.
export function setPinnedNotes(notes: readonly Note[], pinned: boolean): Promise<BulkOutcome<Note>> {
	return runNotesBulk(notes, note => setNotePinned(note, pinned))
}

export function setFavoritedNotes(notes: readonly Note[], favorited: boolean): Promise<BulkOutcome<Note>> {
	return runNotesBulk(notes, note => setNoteFavorited(note, favorited))
}

export function setTypeNotes(notes: readonly Note[], noteType: NoteType): Promise<BulkOutcome<Note>> {
	return runNotesBulk(notes, note => setNoteType(note, noteType))
}

// ── Duplicate / lifecycle ────────────────────────────────────────────────

export function duplicateNotes(notes: readonly Note[]): Promise<BulkOutcome<Note>> {
	return runNotesBulk(notes, note => duplicateNote(note))
}

export function archiveNotes(notes: readonly Note[]): Promise<BulkOutcome<Note>> {
	return runNotesBulk(notes, note => archiveNote(note))
}

export function restoreNotes(notes: readonly Note[]): Promise<BulkOutcome<Note>> {
	return runNotesBulk(notes, note => restoreNote(note))
}

// Bulk trash needs no nav-away guard (trashNote upserts the note in place, trash:true — it stays
// visible/routable, same as the single-item action), unlike delete/leave below which remove the
// note from the cache outright.
export function trashNotes(notes: readonly Note[]): Promise<BulkOutcome<Note>> {
	return runNotesBulk(notes, note => trashNote(note))
}

export interface BulkDeleteOrLeaveOptions {
	// Fired per-note, BEFORE that note leaves the cache — mirrors DeleteNoteOptions.beforeCacheRemoval,
	// threaded through so the caller (useNoteDialogHost) can navigate away first if the CURRENTLY
	// routed note happens to be among those permanently deleted/left in this batch.
	beforeCacheRemoval?: (note: Note) => void
}

export function deleteNotesPermanently(notes: readonly Note[], opts?: BulkDeleteOrLeaveOptions): Promise<BulkOutcome<Note>> {
	return runNotesBulk<Note>(notes, note => {
		const noteOpts: DeleteNoteOptions = { beforeCacheRemoval: () => opts?.beforeCacheRemoval?.(note) }

		return deleteNote(note, noteOpts)
	})
}

export function leaveNotes(notes: readonly Note[], opts?: BulkDeleteOrLeaveOptions): Promise<BulkOutcome<Note>> {
	return runNotesBulk<Note>(notes, note => {
		const noteOpts: DeleteNoteOptions = { beforeCacheRemoval: () => opts?.beforeCacheRemoval?.(note) }

		return leaveNote(note, noteOpts)
	})
}

// ── Tags ──────────────────────────────────────────────────────────────────

// Drives every selected note's membership of `tag` to the SAME `checked` target — the bulk tags
// submenu's tri-state checkbox (checked only when EVERY selected note already carries the tag)
// toggles the whole selection to the opposite of that.
export function setTagOnNotes(notes: readonly Note[], tag: NoteTag, checked: boolean): Promise<BulkOutcome<Note>> {
	return runNotesBulk(notes, note => (checked ? addTagToNote(note, tag) : removeTagFromNote(note, tag)))
}

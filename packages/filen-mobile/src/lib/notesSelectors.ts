import type { Note, NoteTag } from "@filen/sdk-rs"

/**
 * Aggregated boolean flags for a Notes selection, computed in a single pass.
 *
 * Used by the Notes list header to enable/disable / relabel bulk-action menu
 * entries. Replaces the prior pattern of K independent `useShallow(state =>
 * state.selectedNotes.some(...))` subscriptions (one per flag) — that walked
 * the selection array K times per change. This walks once.
 *
 * The empty-selection case returns a shared frozen {@link EMPTY_NOTE_FLAGS}
 * constant so no garbage is generated when the menu re-renders with an empty
 * selection.
 */
export type NoteSelectionFlags = {
	count: number
	includesFavorited: boolean
	includesPinned: boolean
	includesTrashed: boolean
	everyOwned: boolean
	everyArchived: boolean
	everyTrashed: boolean
	hasWriteAccessToAll: boolean
	/**
	 * True iff every selected note has the current user as a participant AND
	 * the current user is NOT the owner of any selected note. Used to gate
	 * the "Leave" action (only participants leave; owners trash/delete).
	 */
	participantOfEveryAndNotOwner: boolean
}

export const EMPTY_NOTE_FLAGS: NoteSelectionFlags = Object.freeze({
	count: 0,
	includesFavorited: false,
	includesPinned: false,
	includesTrashed: false,
	everyOwned: false,
	everyArchived: false,
	everyTrashed: false,
	hasWriteAccessToAll: false,
	participantOfEveryAndNotOwner: false
}) as NoteSelectionFlags

export function aggregateNoteSelectionFlags(notes: readonly Note[], userId: bigint | undefined): NoteSelectionFlags {
	if (notes.length === 0 || userId === undefined) {
		return EMPTY_NOTE_FLAGS
	}

	let includesFavorited = false
	let includesPinned = false
	let includesTrashed = false
	let everyOwned = true
	let everyArchived = true
	let everyTrashed = true
	let hasWriteAccessToAll = true
	let participantOfEveryAndNotOwner = true

	for (let i = 0; i < notes.length; i++) {
		const n = notes[i]!

		if (n.favorite) {
			includesFavorited = true
		}

		if (n.pinned) {
			includesPinned = true
		}

		if (n.trash) {
			includesTrashed = true
		}

		if (!n.archive) {
			everyArchived = false
		}

		if (!n.trash) {
			everyTrashed = false
		}

		const isOwner = n.ownerId === userId
		const participant = n.participants.find(p => p.userId === userId)
		const hasWrite = isOwner || (participant?.permissionsWrite ?? false)

		if (!isOwner) {
			everyOwned = false
		}

		if (!hasWrite) {
			hasWriteAccessToAll = false
		}

		if (isOwner || participant === undefined) {
			participantOfEveryAndNotOwner = false
		}
	}

	return {
		count: notes.length,
		includesFavorited,
		includesPinned,
		includesTrashed,
		everyOwned,
		everyArchived,
		everyTrashed,
		hasWriteAccessToAll,
		participantOfEveryAndNotOwner
	}
}

export type NoteTagSelectionFlags = {
	count: number
	includesFavorited: boolean
}

export const EMPTY_NOTE_TAG_FLAGS: NoteTagSelectionFlags = Object.freeze({
	count: 0,
	includesFavorited: false
}) as NoteTagSelectionFlags

export function aggregateNoteTagSelectionFlags(tags: readonly NoteTag[]): NoteTagSelectionFlags {
	if (tags.length === 0) {
		return EMPTY_NOTE_TAG_FLAGS
	}

	let includesFavorited = false

	for (let i = 0; i < tags.length; i++) {
		if (tags[i]!.favorite) {
			includesFavorited = true
		}
	}

	return {
		count: tags.length,
		includesFavorited
	}
}

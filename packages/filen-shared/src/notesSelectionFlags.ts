// Single-pass aggregation of a Notes multi-selection into the gating booleans that drive which bulk
// actions the selection allows. Structurally typed against the note shape (not a generated SDK
// type) so the same function serves both the uniffi and wasm surfaces; `isUndecryptable` is
// injected because the two apps derive it differently — one stamps a boolean at fetch time, the
// other computes it from `encryptionKey` — and injecting it keeps this module free of any SDK
// import.
export interface NoteSelectionFlags {
	count: number
	includesFavorited: boolean
	includesPinned: boolean
	// True iff any selected note has `archive: true`.
	includesArchived: boolean
	// True iff any selected note has `trash: true`.
	includesTrashed: boolean
	// True iff any selected note's metadata never decrypted for this account.
	includesUndecryptable: boolean
	// True iff the current user owns every selected note.
	everyOwned: boolean
	everyTrashed: boolean
	// True iff every selected note is archived OR trashed (no active note in the mix) — gates bulk
	// Restore, which would otherwise be a silent no-op on an active note.
	everyArchivedOrTrashed: boolean
	// True iff the current user has write access (owner OR a participant with permissionsWrite) to
	// every selected note.
	hasWriteAccessToAll: boolean
	// True iff every selected note has the current user as a participant AND the current user is
	// NOT the owner of any selected note. Gates the "Leave" action.
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

export function aggregateNoteSelectionFlags<
	T extends {
		favorite: boolean
		pinned: boolean
		archive: boolean
		trash: boolean
		ownerId: bigint
		participants: readonly { userId: bigint; permissionsWrite: boolean }[]
	}
>(notes: readonly T[], userId: bigint | undefined, isUndecryptable: (note: T) => boolean): NoteSelectionFlags {
	if (notes.length === 0 || userId === undefined) {
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

		if (isUndecryptable(note)) {
			includesUndecryptable = true
		}

		if (!note.trash) {
			everyTrashed = false
		}

		if (!note.archive && !note.trash) {
			everyArchivedOrTrashed = false
		}

		// Look up the participant once and reuse it for both the write-access and leave-gate checks.
		const isOwner = note.ownerId === userId
		const participant = note.participants.find(p => p.userId === userId)
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

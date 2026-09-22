// Which bulk actions a Notes multi-selection permits — the single decision matrix both apps'
// bulk-action UI (menu buttons on mobile, a floating bar on web) gate their eleven metadata/
// lifecycle entries on. Descriptors, icons and labels stay per-app; this module only answers
// yes/no per action id. The two offline-caching entries mobile also offers (mark/remove kept-
// on-device) have no web counterpart and are gated by the caller directly off
// `includesUndecryptable`, outside this matrix.
//
// State machine a note moves through:
//   active   (!archive, !trash) → archive | trash
//   archived (archive, !trash)  → restore | trash
//   trashed  (trash)            → restore | delete
// Gating only ever enables an action when EVERY selected note is in a state where that action
// is valid — the write path guards each op individually so a mixed-state slip is a silent
// no-op, but the UI hides the action instead of offering a no-op.
export interface NoteBulkFlagsCore {
	count: number
	// True iff any selected note's metadata never decrypted for this account.
	includesUndecryptable: boolean
	// True iff any selected note has `archive: true`.
	includesArchived: boolean
	// True iff any selected note has `trash: true`.
	includesTrashed: boolean
	// True iff the current user owns every selected note.
	everyOwned: boolean
	// True iff every selected note is archived OR trashed (no active note in the mix).
	everyArchivedOrTrashed: boolean
	everyTrashed: boolean
	// True iff the current user has write access (owner OR a participant with permissionsWrite) to
	// every selected note.
	hasWriteAccessToAll: boolean
	// True iff every selected note has the current user as a participant AND the current user is
	// NOT the owner of any selected note.
	participantOfEveryAndNotOwner: boolean
}

export interface NoteBulkActionAvailability {
	pin: boolean
	favorite: boolean
	type: boolean
	tags: boolean
	duplicate: boolean
	export: boolean
	archive: boolean
	restore: boolean
	trash: boolean
	delete: boolean
	leave: boolean
}

const UNAVAILABLE: NoteBulkActionAvailability = Object.freeze({
	pin: false,
	favorite: false,
	type: false,
	tags: false,
	duplicate: false,
	export: false,
	archive: false,
	restore: false,
	trash: false,
	delete: false,
	leave: false
})

export function noteBulkActionAvailability(flags: NoteBulkFlagsCore): NoteBulkActionAvailability {
	if (flags.count === 0) {
		return UNAVAILABLE
	}

	// Pin/favorite/type/tags/duplicate/export need decrypted metadata, suppressed selection-wide by
	// includesUndecryptable; type additionally needs write access to every selected note.
	const decrypted = !flags.includesUndecryptable

	return {
		pin: decrypted,
		favorite: decrypted,
		type: decrypted && flags.hasWriteAccessToAll,
		tags: decrypted,
		duplicate: decrypted,
		export: decrypted,
		// Archive: every note must be active (no archived, no trashed) and none undecryptable — the
		// per-note menu drops Archive for an undecryptable note too.
		archive: flags.everyOwned && !flags.includesArchived && !flags.includesTrashed && decrypted,
		// Restore: every note must be archived or trashed. For an undecryptable selection the
		// per-note menu only offers Restore once trashed (Archive itself is impossible on an
		// undecryptable note), so restore requires everyTrashed once undecryptable is in the mix.
		restore: flags.everyOwned && flags.everyArchivedOrTrashed && (decrypted || flags.everyTrashed),
		// Trash: none of the selection may already be trashed. Survives includesUndecryptable — a
		// pure-uuid disposition.
		trash: flags.everyOwned && !flags.includesTrashed,
		// Delete permanently: every note must already be trashed.
		delete: flags.everyOwned && flags.everyTrashed,
		// Leave is the non-owner-participant mirror of trash/delete, independent of everyOwned.
		leave: flags.participantOfEveryAndNotOwner
	}
}

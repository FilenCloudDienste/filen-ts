import type { Note, NoteTag } from "@filen/sdk-rs"
import { compareIds, fastLocaleCompare, matchesNameSearch, nameSearchKey } from "@filen/shared"
import type { NoteSearchHits } from "@/features/notes/lib/searchIndex.logic"

// Port of mobile's notesSorter.sort (src/lib/sort.ts) onto the wasm Note shape. `editedTimestamp`
// is a bigint on this surface — every comparison below stays in bigint (`<`/`>`), never Number(): a
// falsy-bigint guard like `!note.editedTimestamp` would wrongly treat 0n (a real, valid timestamp)
// as "missing", and Number(bigint) would needlessly reintroduce a precision-loss path this module
// has no reason to pay for.

// Composite bucket, exactly mirroring mobile: pinned notes occupy 0..2, unpinned 3..5; within each
// half the trash/archive tier adds (none 0 / archive 1 / trash 2). Ascending order on this ONE
// integer reproduces the pinned-then-tier branch pair without a two-key comparator.
function noteBucket(note: Note): number {
	return (note.pinned ? 0 : 3) + (note.trash ? 2 : note.archive ? 1 : 0)
}

// Newest-first by editedTimestamp. Deterministic uuid tiebreak for equal timestamps (including two
// never-edited-since-create notes) — input order is not stable across refetches, so falling through to
// it would reshuffle on every refresh. Plain uuid string compare: note lists are small, no case for
// numeric-uuid extraction the way drive's sort.ts pays for its much larger listings.
export function compareEditedDescThenUuid(a: Note, b: Note): number {
	if (a.editedTimestamp !== b.editedTimestamp) {
		return a.editedTimestamp > b.editedTimestamp ? -1 : 1
	}

	return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0
}

function compareNotes(a: Note, b: Note): number {
	return noteBucket(a) - noteBucket(b) || compareEditedDescThenUuid(a, b)
}

// Bucket → editedTimestamp desc, mirroring mobile's notesSorter.sort. Returns a NEW array, never
// mutates the input.
export function sortNotes(notes: readonly Note[]): Note[] {
	return [...notes].sort(compareNotes)
}

// The text search substring-matches. The label a note goes by lives in lib/displayTitle.ts; an
// undecryptable note has no title, so it searches as empty (its hidden uuid is never substring-matched).
function noteSearchTitle(note: Note): string {
	return note.title ?? ""
}

export function tagDisplayName(tag: NoteTag): string {
	return tag.name ?? tag.uuid
}

// Tags by display name, then uuid: the tags view's name order, used by every other tag list (chips, submenus).
export function compareTagsByName(a: NoteTag, b: NoteTag): number {
	return fastLocaleCompare(tagDisplayName(a), tagDisplayName(b)) || compareIds(a.uuid, b.uuid)
}

// A note whose metadata never decrypted for this account — the SDK leaves `encryptionKey` undefined
// when the note key can't be unwrapped, so title/preview/content stay ciphertext. Mirrors mobile's
// isNoteUndecryptable; the drive + chats surfaces expose the same signal (item.data.undecryptable /
// isChatUndecryptable) so every surface can reduce an undecryptable item to its pure-uuid actions.
export function isNoteUndecryptable(note: Note): boolean {
	return note.encryptionKey === undefined
}

// A tag whose name never decrypted (same key-unwrap failure as a note) — the SDK leaves `name`
// undefined. Mirrors mobile's isTagUndecryptable.
export function isTagUndecryptable(tag: NoteTag): boolean {
	return tag.name === undefined
}

export { isNoteOwner, hasNoteWriteAccess } from "@filen/shared"

// The one search-term normalization every notes filter shares, so body-fetch scoping can never
// disagree with the filter it feeds. NFC as well, so a title stored decomposed still matches a typed query.
export function normalizeSearch(search: string): string {
	return nameSearchKey(search)
}

// Title-only half of the search match: a title hit never needs its body searched. A query equal to the full
// uuid also matches, so an undecryptable note stays findable without phantom single-character hits.
export function noteTitleMatchesSearch(note: Note, normalizedSearch: string): boolean {
	return note.uuid.toLowerCase() === normalizedSearch || matchesNameSearch(noteSearchTitle(note), normalizedSearch)
}

// Search filter over title, then the note's indexed body (`hits`, searchIndex.ts), mirroring mobile's title +
// content search. A note the index holds no text for (not read yet, unreadable, undecryptable, or no index at
// all) falls back to `preview`, the SDK's short summary of the same content. Empty/whitespace query returns the
// list unchanged, same as mobile.
export function filterNotesBySearch(notes: readonly Note[], search: string, hits?: NoteSearchHits): Note[] {
	const normalized = normalizeSearch(search)

	if (normalized.length === 0) {
		return [...notes]
	}

	return notes.filter(note => {
		if (noteTitleMatchesSearch(note, normalized) || hits?.body.has(note.uuid) === true) {
			return true
		}

		if (hits?.indexed.has(note.uuid) === true) {
			return false
		}

		return note.preview !== undefined && matchesNameSearch(note.preview, normalized)
	})
}

// Filter first (search narrows the set the sort then walks), sort second. Filtering before sorting is
// also strictly cheaper — the bucket/timestamp comparator runs over the narrowed set, not the full list.
export function sortAndFilterNotes(notes: readonly Note[], search = "", hits?: NoteSearchHits): Note[] {
	return sortNotes(filterNotesBySearch(notes, search, hits))
}

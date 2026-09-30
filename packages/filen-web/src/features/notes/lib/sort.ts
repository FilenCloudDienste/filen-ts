import type { Note, NoteTag } from "@filen/sdk-rs"

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

// Undecryptable-placeholder handling is a presentation concern (mobile's cannotDecryptPlaceholder)
// left to the component that renders note rows; this module only needs the raw fallback so
// search has stable text to match against.
export function noteDisplayTitle(note: Note): string {
	return note.title ?? note.uuid
}

export function tagDisplayName(tag: NoteTag): string {
	return tag.name ?? tag.uuid
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
// disagree with the filter it feeds.
export function normalizeSearch(search: string): string {
	return search.trim().toLowerCase()
}

// Title-only half of the search match — exported so useNoteSearchBodies.ts can skip fetching a note's
// body when its title already qualifies (a title hit never needs its body checked too), keeping the
// eager content fetch scoped to only the notes that actually need it.
export function noteTitleMatchesSearch(note: Note, normalizedSearch: string): boolean {
	return noteDisplayTitle(note).toLowerCase().includes(normalizedSearch)
}

// Search filter over title + full decrypted body (mirrors mobile's filterNoteListItemsBySearchQuery
// parity: matches title + eagerly-fetched content, not just a short summary). `bodies` is the
// uuid-keyed map of ALREADY-LOWERCASED bodies useNoteSearchBodies.ts eagerly fetches ONLY while a
// search is active (opt-in, per its own doc comment) — a note absent from the map (fetch still in
// flight, or the caller never wired bodies through at all) falls back to `preview`, the SDK's own short summary of the same content, so a
// body-only match briefly reads as "not found" rather than crashing or matching everything. Empty/
// whitespace query returns the list unchanged, same as mobile.
export function filterNotesBySearch(notes: readonly Note[], search: string, bodies?: ReadonlyMap<string, string | undefined>): Note[] {
	const normalized = normalizeSearch(search)

	if (normalized.length === 0) {
		return [...notes]
	}

	return notes.filter(note => {
		if (noteTitleMatchesSearch(note, normalized)) {
			return true
		}

		const bodyText = bodies?.get(note.uuid) ?? note.preview?.toLowerCase()

		return bodyText?.includes(normalized) ?? false
	})
}

// Filter first (search narrows the set the sort then walks), sort second. Filtering before sorting is
// also strictly cheaper — the bucket/timestamp comparator runs over the narrowed set, not the full list.
export function sortAndFilterNotes(notes: readonly Note[], search = "", bodies?: ReadonlyMap<string, string | undefined>): Note[] {
	return sortNotes(filterNotesBySearch(notes, search, bodies))
}

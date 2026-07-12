import { fastLocaleCompare } from "@filen/utils"
import type { Note, NoteHistory, NoteTag } from "@filen/sdk-rs"

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

function compareNotes(a: Note, b: Note): number {
	const bucketDiff = noteBucket(a) - noteBucket(b)

	if (bucketDiff !== 0) {
		return bucketDiff
	}

	if (a.editedTimestamp !== b.editedTimestamp) {
		return a.editedTimestamp > b.editedTimestamp ? -1 : 1
	}

	// Deterministic tiebreak for equal timestamps (including two never-edited-since-create notes) —
	// input order is not stable across refetches, so falling through to it would reshuffle on every
	// refresh. Plain uuid string compare: note lists are small, no case for numeric-uuid extraction
	// the way drive's sort.ts pays for its much larger listings.
	return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0
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

// History dialog's own sort — newest first by editedTimestamp (mobile's sortNoteHistoryNewestFirst),
// bigint-safe throughout like compareNotes above. `id` (also bigint) is the deterministic tiebreak for
// two entries sharing a timestamp — history ids are server-assigned and monotonically increasing, so
// the higher id is the later edit.
export function sortNoteHistory(history: readonly NoteHistory[]): NoteHistory[] {
	return [...history].sort((a, b) => {
		if (a.editedTimestamp !== b.editedTimestamp) {
			return a.editedTimestamp > b.editedTimestamp ? -1 : 1
		}

		return a.id === b.id ? 0 : a.id > b.id ? -1 : 1
	})
}

// Title-only half of the search match — exported so useNoteSearchBodies.ts can skip fetching a note's
// body when its title already qualifies (a title hit never needs its body checked too), keeping the
// eager content fetch scoped to only the notes that actually need it.
export function noteTitleMatchesSearch(note: Note, normalizedSearch: string): boolean {
	return noteDisplayTitle(note).toLowerCase().includes(normalizedSearch)
}

// Search filter over title + full decrypted body (mirrors mobile's filterNoteListItemsBySearchQuery
// parity: matches title + eagerly-fetched content, not just a short summary). `bodies` is the
// uuid-keyed map useNoteSearchBodies.ts eagerly fetches ONLY while a search is active (opt-in, per its
// own doc comment) — a note absent from the map (fetch still in flight, or the caller never wired
// bodies through at all) falls back to `preview`, the SDK's own short summary of the same content, so a
// body-only match briefly reads as "not found" rather than crashing or matching everything. Empty/
// whitespace query returns the list unchanged, same as mobile.
export function filterNotesBySearch(notes: readonly Note[], search: string, bodies?: ReadonlyMap<string, string | undefined>): Note[] {
	const normalized = search.trim().toLowerCase()

	if (normalized.length === 0) {
		return [...notes]
	}

	return notes.filter(note => {
		if (noteTitleMatchesSearch(note, normalized)) {
			return true
		}

		const body = bodies?.get(note.uuid)
		const bodyText = body ?? note.preview

		return bodyText?.toLowerCase().includes(normalized) ?? false
	})
}

// The sidebar's one entry point: filter first (search narrows the set the sort then walks), sort
// second. Filtering before sorting is also strictly cheaper — the bucket/timestamp comparator runs
// over the narrowed set, not the full list.
export function sortAndFilterNotes(notes: readonly Note[], search = "", bodies?: ReadonlyMap<string, string | undefined>): Note[] {
	return sortNotes(filterNotesBySearch(notes, search, bodies))
}

export function filterNoteTagsBySearch(tags: readonly NoteTag[], search: string): NoteTag[] {
	const normalized = search.trim().toLowerCase()

	if (normalized.length === 0) {
		return [...tags]
	}

	return tags.filter(tag => tagDisplayName(tag).toLowerCase().includes(normalized))
}

// Mirrors mobile's notesTagsSortPreference.ts semantics exactly (NOTES_TAGS_SORT_OPTIONS +
// DEFAULT_NOTES_TAGS_SORT_BY = "lastActivityDesc"). The secure-store-backed preference hook itself
// lives elsewhere (this module stays pure/no-React); only the comparator ports here.
export const NOTE_TAGS_SORT_OPTIONS = [
	"lastActivityDesc",
	"lastActivityAsc",
	"nameAsc",
	"nameDesc",
	"notesCountDesc",
	"notesCountAsc"
] as const

export type NoteTagsSortBy = (typeof NOTE_TAGS_SORT_OPTIONS)[number]

export const DEFAULT_NOTE_TAGS_SORT_BY: NoteTagsSortBy = "lastActivityDesc"

// A tag's "last activity": the most recently edited note it contains (the same value mobile's tag
// row displays), falling back to the tag's own edited time when it carries no notes. Unlike
// mobile's uniffi Note (whose editedTimestamp is optional, falling back to createdTimestamp), the
// wasm Note.editedTimestamp is NEVER optional — a `??` fallback there would be dead code under
// this surface's own type. Bigint-safe throughout: only converts to Number once a winner is found
// (safe — timestamps sit nowhere near Number.MAX_SAFE_INTEGER).
export function tagLastActivity(tag: NoteTag, notesForTag: readonly Note[]): number {
	if (notesForTag.length === 0) {
		return Number(tag.editedTimestamp)
	}

	let latest: bigint | undefined

	for (const note of notesForTag) {
		if (latest === undefined || note.editedTimestamp > latest) {
			latest = note.editedTimestamp
		}
	}

	return Number(latest ?? tag.editedTimestamp)
}

// Sort the note tags for the tags view. Returns a NEW array, never mutates the input. `notesByTag`
// maps tag uuid → the notes carrying that tag (built by the caller) and supplies the last-activity +
// note-count keys; name is the stable tiebreaker for activity/count ties (mirrors mobile's
// sortNoteTags 1:1). An unknown sortBy value falls back to the default (lastActivityDesc).
export function sortNoteTags(tags: readonly NoteTag[], sortBy: NoteTagsSortBy, notesByTag: Record<string, readonly Note[]>): NoteTag[] {
	// Precompute keys once per tag so the comparator stays O(1) per comparison instead of re-walking
	// notesByTag on every compare.
	const activity = new Map<string, number>()
	const count = new Map<string, number>()

	for (const tag of tags) {
		const notes = notesByTag[tag.uuid] ?? []

		activity.set(tag.uuid, tagLastActivity(tag, notes))
		count.set(tag.uuid, notes.length)
	}

	const byName = (a: NoteTag, b: NoteTag): number => fastLocaleCompare(tagDisplayName(a), tagDisplayName(b))
	const sorted = [...tags]

	switch (sortBy) {
		case "nameAsc": {
			return sorted.sort(byName)
		}

		case "nameDesc": {
			return sorted.sort((a, b) => byName(b, a))
		}

		case "lastActivityAsc": {
			return sorted.sort((a, b) => {
				const diff = (activity.get(a.uuid) ?? 0) - (activity.get(b.uuid) ?? 0)
				return diff !== 0 ? diff : byName(a, b)
			})
		}

		case "notesCountDesc": {
			return sorted.sort((a, b) => {
				const diff = (count.get(b.uuid) ?? 0) - (count.get(a.uuid) ?? 0)
				return diff !== 0 ? diff : byName(a, b)
			})
		}

		case "notesCountAsc": {
			return sorted.sort((a, b) => {
				const diff = (count.get(a.uuid) ?? 0) - (count.get(b.uuid) ?? 0)
				return diff !== 0 ? diff : byName(a, b)
			})
		}

		// lastActivityDesc + any unrecognized value
		default: {
			return sorted.sort((a, b) => {
				const diff = (activity.get(b.uuid) ?? 0) - (activity.get(a.uuid) ?? 0)
				return diff !== 0 ? diff : byName(a, b)
			})
		}
	}
}

import { fastLocaleCompare } from "./misc"

// Note-tags view sort vocabulary + comparator, shared by mobile (uniffi Note/NoteTag) and web (wasm
// Note/NoteTag). Tag and note are typed structurally — {uuid, editedTimestamp: bigint} — instead of
// against either app's generated SDK type, so this module carries no SDK dependency and is immune to
// uniffi/wasm shape drift on unrelated fields. The tag display name used for the name tiebreak is
// injected: an undecryptable tag renders an i18n placeholder on mobile and the bare uuid on web, and
// injection keeps both correct without this module choosing one.
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

export interface NoteTagsSortEntry {
	uuid: string
	editedTimestamp: bigint
}

// A tag's "last activity": the most recently edited note it contains, falling back to the tag's own
// edited time when it carries no notes. Bigint-safe throughout — converts to Number only once a
// winner is found (timestamps sit nowhere near Number.MAX_SAFE_INTEGER, so the conversion is safe).
export function tagLastActivity<TNote extends NoteTagsSortEntry>(tag: NoteTagsSortEntry, notesForTag: readonly TNote[]): number {
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
// maps tag uuid -> the notes carrying that tag (built by the caller) and supplies the last-activity +
// note-count keys; `getTagDisplayName` supplies the name tiebreak text. An unrecognized sortBy value
// falls back to the default (lastActivityDesc).
export function sortNoteTags<TTag extends NoteTagsSortEntry, TNote extends NoteTagsSortEntry>(
	tags: readonly TTag[],
	sortBy: NoteTagsSortBy,
	notesByTag: Record<string, readonly TNote[]>,
	getTagDisplayName: (tag: TTag) => string
): TTag[] {
	const byName = (a: TTag, b: TTag): number => fastLocaleCompare(getTagDisplayName(a), getTagDisplayName(b))
	const sorted = [...tags]

	if (sortBy === "nameAsc") {
		return sorted.sort(byName)
	}

	if (sortBy === "nameDesc") {
		return sorted.sort((a, b) => byName(b, a))
	}

	// Metric modes; an unrecognized value lands on lastActivityDesc (activity key, sign -1).
	const byCount = sortBy === "notesCountAsc" || sortBy === "notesCountDesc"
	const sign = sortBy === "lastActivityAsc" || sortBy === "notesCountAsc" ? 1 : -1
	// Precompute the one key this mode needs so the comparator stays O(1) per comparison.
	const keys = new Map<string, number>()

	for (const tag of tags) {
		const notes = notesByTag[tag.uuid] ?? []

		keys.set(tag.uuid, byCount ? notes.length : tagLastActivity(tag, notes))
	}

	return sorted.sort((a, b) => {
		const diff = sign * ((keys.get(a.uuid) ?? 0) - (keys.get(b.uuid) ?? 0))

		return diff !== 0 ? diff : byName(a, b)
	})
}

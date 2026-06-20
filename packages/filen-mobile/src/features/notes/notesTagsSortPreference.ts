import { useSecureStore } from "@/lib/secureStore"
import { fastLocaleCompare } from "@filen/utils"
import { tagDisplayName } from "@/lib/decryption"
import { type Note, type NoteTag } from "@/types"

export const NOTES_TAGS_SORT_BY_SECURE_STORE_KEY = "notes.tagsSortBy"

export const NOTES_TAGS_SORT_OPTIONS = ["lastActivityDesc", "lastActivityAsc", "nameAsc", "nameDesc", "notesCountDesc", "notesCountAsc"] as const

export type NotesTagsSortBy = (typeof NOTES_TAGS_SORT_OPTIONS)[number]

// Default: most recently active tags first — matches the "last activity" date the tag row shows.
export const DEFAULT_NOTES_TAGS_SORT_BY: NotesTagsSortBy = "lastActivityDesc"

// The tag's "last activity": the most recently edited note it contains (the same value the tag row
// displays), falling back to the tag's own edited time when it has no notes. Mirrors the note recency
// key the notes sorter uses (editedTimestamp ?? createdTimestamp). Pure — safe for the comparator.
export function tagLastActivity(tag: NoteTag, notesForTag: readonly Note[]): number {
	if (notesForTag.length === 0) {
		return Number(tag.editedTimestamp)
	}

	let latest = 0

	for (let i = 0; i < notesForTag.length; i++) {
		const note = notesForTag[i]

		if (!note) {
			continue
		}

		const ts = Number(note.editedTimestamp ?? note.createdTimestamp)

		if (ts > latest) {
			latest = ts
		}
	}

	return latest
}

/**
 * Sort the note tags for the tags view. Returns a NEW array (never mutates the input). `notesByTag`
 * maps tag uuid → the notes carrying that tag (already built by the screen) and supplies the
 * last-activity + note-count keys. Name is the stable tiebreaker for activity/count ties. An
 * unknown sort value falls back to the default (lastActivityDesc).
 */
export function sortNoteTags(tags: readonly NoteTag[], sortBy: NotesTagsSortBy, notesByTag: Record<string, readonly Note[]>): NoteTag[] {
	// Precompute keys once per tag so the comparator stays O(1) (no repeated reduces over notes).
	const activity = new Map<string, number>()
	const count = new Map<string, number>()

	for (let i = 0; i < tags.length; i++) {
		const tag = tags[i]

		if (!tag) {
			continue
		}

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

		// lastActivityDesc + any unknown value
		default: {
			return sorted.sort((a, b) => {
				const diff = (activity.get(b.uuid) ?? 0) - (activity.get(a.uuid) ?? 0)

				return diff !== 0 ? diff : byName(a, b)
			})
		}
	}
}

export function useNotesTagsSortBy(): [NotesTagsSortBy, (next: NotesTagsSortBy | ((prev: NotesTagsSortBy) => NotesTagsSortBy)) => void] {
	return useSecureStore<NotesTagsSortBy>(NOTES_TAGS_SORT_BY_SECURE_STORE_KEY, DEFAULT_NOTES_TAGS_SORT_BY)
}

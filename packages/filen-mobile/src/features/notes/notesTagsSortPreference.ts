import { useSecureStore } from "@/lib/secureStore"
import { tagDisplayName } from "@/lib/decryption"
import { type Note, type NoteTag } from "@/types"
import {
	NOTE_TAGS_SORT_OPTIONS,
	DEFAULT_NOTE_TAGS_SORT_BY,
	tagLastActivity as sharedTagLastActivity,
	sortNoteTags as sharedSortNoteTags,
	type NoteTagsSortBy
} from "@filen/shared"

export const NOTES_TAGS_SORT_BY_SECURE_STORE_KEY = "notes.tagsSortBy"

export const NOTES_TAGS_SORT_OPTIONS = NOTE_TAGS_SORT_OPTIONS

export type NotesTagsSortBy = NoteTagsSortBy

// Default: most recently active tags first — matches the "last activity" date the tag row shows.
export const DEFAULT_NOTES_TAGS_SORT_BY: NotesTagsSortBy = DEFAULT_NOTE_TAGS_SORT_BY

// The shared comparator wants a defined bigint editedTimestamp; mobile's uniffi Note falls back to
// createdTimestamp when a note was never edited since creation, so resolve that here before handing
// notes to it.
function toActivityEntry(note: Note): { uuid: string; editedTimestamp: bigint } {
	return { uuid: note.uuid, editedTimestamp: note.editedTimestamp ?? note.createdTimestamp }
}

// The tag's "last activity": the most recently edited note it contains (the same value the tag row
// displays), falling back to the tag's own edited time when it has no notes.
export function tagLastActivity(tag: NoteTag, notesForTag: readonly Note[]): number {
	return sharedTagLastActivity(tag, notesForTag.map(toActivityEntry))
}

/**
 * Sort the note tags for the tags view. Returns a NEW array (never mutates the input). `notesByTag`
 * maps tag uuid → the notes carrying that tag (already built by the screen) and supplies the
 * last-activity + note-count keys. Name is the stable tiebreaker for activity/count ties. An
 * unknown sort value falls back to the default (lastActivityDesc).
 */
export function sortNoteTags(tags: readonly NoteTag[], sortBy: NotesTagsSortBy, notesByTag: Record<string, readonly Note[]>): NoteTag[] {
	const activityNotesByTag: Record<string, readonly { uuid: string; editedTimestamp: bigint }[]> = {}

	for (const [uuid, notes] of Object.entries(notesByTag)) {
		activityNotesByTag[uuid] = notes.map(toActivityEntry)
	}

	return sharedSortNoteTags(tags, sortBy, activityNotesByTag, tagDisplayName)
}

export function useNotesTagsSortBy(): [NotesTagsSortBy, (next: NotesTagsSortBy | ((prev: NotesTagsSortBy) => NotesTagsSortBy)) => void] {
	return useSecureStore<NotesTagsSortBy>(NOTES_TAGS_SORT_BY_SECURE_STORE_KEY, DEFAULT_NOTES_TAGS_SORT_BY)
}

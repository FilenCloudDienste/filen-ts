import { useSecureStore } from "@/lib/secureStore"
import { DEFAULT_NOTE_TAGS_SORT_BY, type NoteTagsSortBy } from "@filen/shared"

export const NOTES_TAGS_SORT_BY_SECURE_STORE_KEY = "notes.tagsSortBy"

export type NotesTagsSortBy = NoteTagsSortBy

export function useNotesTagsSortBy(): [NotesTagsSortBy, (next: NotesTagsSortBy | ((prev: NotesTagsSortBy) => NotesTagsSortBy)) => void] {
	return useSecureStore<NotesTagsSortBy>(NOTES_TAGS_SORT_BY_SECURE_STORE_KEY, DEFAULT_NOTE_TAGS_SORT_BY)
}

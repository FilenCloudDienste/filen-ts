import { useSecureStore } from "@/lib/secureStore"
import { DEFAULT_NOTE_TAGS_SORT_BY, type NoteTagsSortBy } from "@filen/shared"

export const NOTES_TAGS_SORT_BY_SECURE_STORE_KEY = "notes.tagsSortBy"

export function useNotesTagsSortBy(): [NoteTagsSortBy, (next: NoteTagsSortBy | ((prev: NoteTagsSortBy) => NoteTagsSortBy)) => void] {
	return useSecureStore<NoteTagsSortBy>(NOTES_TAGS_SORT_BY_SECURE_STORE_KEY, DEFAULT_NOTE_TAGS_SORT_BY)
}

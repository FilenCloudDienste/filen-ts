import { useSecureStore } from "@/lib/secureStore"
import { type NotesViewMode } from "@/features/notes/notesViewModes"

export const NOTES_VIEW_MODE_SECURE_STORE_KEY = "notesViewMode"

export const DEFAULT_NOTES_VIEW_MODE: NotesViewMode = "notes"

export function useNotesViewMode(): [NotesViewMode, (next: NotesViewMode | ((prev: NotesViewMode) => NotesViewMode)) => void] {
	return useSecureStore<NotesViewMode>(NOTES_VIEW_MODE_SECURE_STORE_KEY, DEFAULT_NOTES_VIEW_MODE)
}

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import {
	getNotesViewMode,
	getMdSplitRatio,
	getNoteTagsSortBy,
	getHideCompletedChecklist,
	type NotesViewMode
} from "@/features/notes/lib/preferences"
import type { NoteTagsSortBy } from "@/features/notes/lib/sort"

// The view-mode preference is read as a query for the same reason drive reads its own
// (useViewModePreferencesQuery): keeps every async read on one primitive (caching, refetch) instead of
// a one-off useEffect. Writes stay plain-fn-then-refetch — the caller awaits setNotesViewMode, then
// this query's own `.refetch()`.
export function useNotesViewModeQuery(): UseQueryResult<NotesViewMode> {
	return useQuery({
		queryKey: ["notes", "viewMode"] as const,
		queryFn: getNotesViewMode
	})
}

// Same plain-fn-then-refetch shape as the view mode above — the md reader's drag handle awaits
// setMdSplitRatio then calls this query's own `.refetch()`.
export function useMdSplitRatioQuery(): UseQueryResult<number> {
	return useQuery({
		queryKey: ["notes", "mdSplitRatio"] as const,
		queryFn: getMdSplitRatio
	})
}

// Tags-view sort preference — same write-then-refetch shape: the sort control awaits
// setNoteTagsSortBy, then calls this query's own `.refetch()`.
export function useNoteTagsSortByQuery(): UseQueryResult<NoteTagsSortBy> {
	return useQuery({
		queryKey: ["notes", "tagsSortBy"] as const,
		queryFn: getNoteTagsSortBy
	})
}

// Per-note "hide completed checklist items" preference, keyed into the query cache by uuid so
// switching between two checklist notes' editors never shows a stale toggle state from the other.
// Disabled for an empty uuid (the editor pane's own "no note selected" placeholder never mounts a
// checklist, but this keeps the hook callable unconditionally regardless).
export function useHideCompletedChecklistQuery(noteUuid: string): UseQueryResult<boolean> {
	return useQuery({
		queryKey: ["notes", "hideCompletedChecklist", noteUuid] as const,
		queryFn: () => getHideCompletedChecklist(noteUuid),
		enabled: noteUuid.length > 0
	})
}

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { getNotesViewMode, getMdSplitRatio, type NotesViewMode } from "@/features/notes/lib/preferences"

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

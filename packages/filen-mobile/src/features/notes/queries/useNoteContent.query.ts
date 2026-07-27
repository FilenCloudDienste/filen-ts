import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import queryClient, { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import { sortParams } from "@filen/utils"
import auth from "@/lib/auth"
import logger from "@/lib/logger"
import { notesQueryGet } from "@/features/notes/queries/useNotesQuery"

export const BASE_QUERY_KEY = "useNoteContentQuery"

export type UseNoteContentQueryParams = {
	uuid: string
}

export async function fetchData(
	params: UseNoteContentQueryParams & {
		signal?: AbortSignal
	}
) {
	// The notes list query is the sole substrate for note identity: the screens gate on it before
	// this query runs, and every list writer commits to it synchronously.
	const note = notesQueryGet()?.find(n => n.uuid === params.uuid)

	if (!note) {
		logger.warn("notes-query", "note not in cache during content fetch; returning undefined", { uuid: params.uuid })

		return undefined
	}

	const { authedSdkClient } = await auth.getSdkClients()

	return await authedSdkClient.getNoteContent(
		note,
		params.signal
			? {
					signal: params.signal
				}
			: undefined
	)
}

// The cache key for one note's content. Single source of the key shape — the offline ledger
// (features/notes/notesOffline) has to address the same entry to evict it from both the in-memory
// cache and the persisted store, and a key built by hand there would silently miss on any change here.
export function noteContentQueryKey(params: UseNoteContentQueryParams): unknown[] {
	return [BASE_QUERY_KEY, sortParams(params)]
}

export function useNoteContentQuery(
	params: UseNoteContentQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		// Built from `sortedParams` rather than `params` so the exhaustive-deps rule can see that the
		// key covers everything the queryFn closes over. sortParams is idempotent, so routing the
		// already-sorted object back through the shared builder is a no-op.
		queryKey: noteContentQueryKey(sortedParams),
		queryFn: ({ signal }) =>
			fetchData({
				...sortedParams,
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

// Current dataUpdatedAt of the cached per-note content query, or undefined when the note
// was never fetched. The editor's remount key is this timestamp — callers that update the
// cached content WITHOUT wanting an editor remount (sync's post-push truth write) pass it
// back into noteContentQueryUpdate to keep the key stable.
export function noteContentQueryDataUpdatedAt(params: UseNoteContentQueryParams): number | undefined {
	return queryClient.getQueryState(noteContentQueryKey(params))?.dataUpdatedAt
}

// Non-reactive read of the cached per-note content (undefined when never fetched/written).
// Used by the editor's frozen-seed derivation, which must read sources without subscribing.
export function noteContentQueryGet(params: UseNoteContentQueryParams): Awaited<ReturnType<typeof fetchData>> {
	return queryClient.getQueryData(noteContentQueryKey(params))
}

export function noteContentQueryUpdate({
	updater,
	params,
	dataUpdatedAt
}: {
	params: Parameters<typeof fetchData>[0]
} & {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
	dataUpdatedAt?: number
}): void {
	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>(
		noteContentQueryKey(params),
		prev => {
			const currentData = prev ?? (undefined satisfies Awaited<ReturnType<typeof fetchData>>)

			return typeof updater === "function" ? updater(currentData) : updater
		},
		dataUpdatedAt
	)
}

export default useNoteContentQuery

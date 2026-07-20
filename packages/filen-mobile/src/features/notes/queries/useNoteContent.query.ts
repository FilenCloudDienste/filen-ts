import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import queryClient, { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import { sortParams } from "@filen/utils"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
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
	// The cache map is populated by the notes list fetch. A note present only in the restored or
	// optimistically-updated list query must still resolve, so fall back to it before giving up.
	const note = cache.noteUuidToNote.get(params.uuid) ?? notesQueryGet()?.find(n => n.uuid === params.uuid)

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

export function useNoteContentQuery(
	params: UseNoteContentQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY, sortedParams],
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
	return queryClient.getQueryState([BASE_QUERY_KEY, sortParams(params)])?.dataUpdatedAt
}

// Non-reactive read of the cached per-note content (undefined when never fetched/written).
// Used by the editor's frozen-seed derivation, which must read sources without subscribing.
export function noteContentQueryGet(params: UseNoteContentQueryParams): Awaited<ReturnType<typeof fetchData>> {
	return queryClient.getQueryData([BASE_QUERY_KEY, sortParams(params)])
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
	const sortedParams = sortParams(params)

	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>(
		[BASE_QUERY_KEY, sortedParams],
		prev => {
			const currentData = prev ?? (undefined satisfies Awaited<ReturnType<typeof fetchData>>)

			return typeof updater === "function" ? updater(currentData) : updater
		},
		dataUpdatedAt
	)
}

export default useNoteContentQuery

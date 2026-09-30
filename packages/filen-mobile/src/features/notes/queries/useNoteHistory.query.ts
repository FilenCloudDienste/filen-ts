import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import auth from "@/lib/auth"
import logger from "@/lib/logger"
import { notesQueryGet } from "@/features/notes/queries/useNotesQuery"
import { toSignalOpts } from "@/lib/signals"

export const BASE_QUERY_KEY = "useNoteHistoryQuery"

export type UseNoteHistoryQueryParams = {
	uuid: string
}

export async function fetchData(
	params: UseNoteHistoryQueryParams & {
		signal?: AbortSignal
	}
) {
	// The notes list query is the sole substrate for note identity: the screens gate on it before
	// this query runs, and every list writer commits to it synchronously.
	const note = notesQueryGet()?.find(n => n.uuid === params.uuid)

	if (!note) {
		logger.warn("notes-query", "note not in cache during history fetch; returning empty", { uuid: params.uuid })

		return []
	}

	const { authedSdkClient } = await auth.getSdkClients()

	return await authedSdkClient.getNoteHistory(
		note,
		toSignalOpts(params.signal)
	)
}

export function useNoteHistoryQuery(
	params: UseNoteHistoryQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...options,
		queryKey: [BASE_QUERY_KEY, params],
		queryFn: ({ signal }) =>
			fetchData({
				...params,
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useNoteHistoryQuery

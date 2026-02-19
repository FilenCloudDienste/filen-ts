import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, useDefaultQueryParams, queryUpdater } from "@/queries/client"
import useRefreshOnFocus from "@/queries/useRefreshOnFocus"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import auth from "@/lib/auth"

export const BASE_QUERY_KEY = "useNoteHistoryQuery"

export type UseNoteHistoryQueryParams = {
	uuid: string
}

export async function fetchData(
	params: UseNoteHistoryQueryParams & {
		signal?: AbortSignal
	}
) {
	const note = cache.noteUuidToNote.get(params.uuid)

	if (!note) {
		return []
	}

	const { authedSdkClient } = await auth.getSdkClients()

	return await authedSdkClient.getNoteHistory(
		note,
		params.signal
			? {
					signal: params.signal
				}
			: undefined
	)
}

export function useNoteHistoryQuery(
	params: UseNoteHistoryQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const defaultParams = useDefaultQueryParams(options)
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...defaultParams,
		...options,
		queryKey: [BASE_QUERY_KEY, sortedParams],
		queryFn: ({ signal }) =>
			fetchData({
				...sortedParams,
				signal
			})
	})

	useRefreshOnFocus({
		isEnabled: query.isEnabled,
		refetch: query.refetch
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export function noteHistoryQueryUpdate({
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
			const currentData = prev ?? ([] satisfies Awaited<ReturnType<typeof fetchData>>)

			return typeof updater === "function" ? updater(currentData) : updater
		},
		dataUpdatedAt
	)
}

export default useNoteHistoryQuery

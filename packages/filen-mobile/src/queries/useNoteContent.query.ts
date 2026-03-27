import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import { sortParams } from "@filen/utils"
import auth from "@/lib/auth"
import cache from "@/lib/cache"

export const BASE_QUERY_KEY = "useNoteContentQuery"

export type UseNoteContentQueryParams = {
	uuid: string
}

export async function fetchData(
	params: UseNoteContentQueryParams & {
		signal?: AbortSignal
	}
) {
	const note = cache.noteUuidToNote.get(params.uuid)

	if (!note) {
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

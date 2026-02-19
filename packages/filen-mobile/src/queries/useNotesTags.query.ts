import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, useDefaultQueryParams, queryUpdater } from "@/queries/client"
import useRefreshOnFocus from "@/queries/useRefreshOnFocus"
import auth from "@/lib/auth"

export const BASE_QUERY_KEY = "useNotesTagsQuery"

export async function fetchData(params?: { signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	return await authedSdkClient.listNoteTags(
		params?.signal
			? {
					signal: params.signal
				}
			: undefined
	)
}

export function useNotesTagsQuery(
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const defaultParams = useDefaultQueryParams(options)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...defaultParams,
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) =>
			fetchData({
				signal
			})
	})

	useRefreshOnFocus({
		isEnabled: query.isEnabled,
		refetch: query.refetch
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export function notesTagsQueryUpdate({
	updater
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
}) {
	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY], prev => {
		return typeof updater === "function" ? updater(prev ?? []) : updater
	})
}

export function notesTagsQueryGet() {
	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY])
}

export default useNotesTagsQuery

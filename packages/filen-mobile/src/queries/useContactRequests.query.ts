import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, useDefaultQueryParams, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"

export const BASE_QUERY_KEY = "useContactRequestsQuery"

export async function fetchData(params?: { signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	const [incoming, outgoing] = await Promise.all([
		authedSdkClient.listIncomingContactRequests(
			params?.signal
				? {
						signal: params.signal
					}
				: undefined
		),
		authedSdkClient.listOutgoingContactRequests(
			params?.signal
				? {
						signal: params.signal
					}
				: undefined
		)
	])

	return {
		incoming,
		outgoing
	}
}

export function useContactRequestsQuery(
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

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export function contactRequestsQueryUpdate({
	updater
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
}) {
	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY], prev => {
		return typeof updater === "function"
			? updater(
					prev ?? {
						incoming: [],
						outgoing: []
					}
				)
			: updater
	})
}

export function contactRequestsQueryGet() {
	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY])
}

export default useContactRequestsQuery

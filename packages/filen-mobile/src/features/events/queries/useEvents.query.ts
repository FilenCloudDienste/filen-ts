import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"

export const BASE_QUERY_KEY = "useEvents"

export async function fetchData(params?: { signal?: AbortSignal; timestamp?: bigint }) {
	const { authedSdkClient } = await auth.getSdkClients()

	return authedSdkClient.getUserEvents(
		undefined,
		params?.timestamp,
		params?.signal
			? {
					signal: params.signal
				}
			: undefined
	)
}

export function useEventsQuery(): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery<Awaited<ReturnType<typeof fetchData>>, Error>({
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) =>
			fetchData({
				signal
			})
	})

	return query
}

export function eventsQueryUpdate({
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

export default useEventsQuery

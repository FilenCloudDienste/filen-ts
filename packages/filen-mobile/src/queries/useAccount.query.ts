import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import auth from "@/lib/auth"

export const BASE_QUERY_KEY = "useAccountQuery"

export async function fetchData(signal?: AbortSignal) {
	const { authedSdkClient } = await auth.getSdkClients()

	return await authedSdkClient.getUserInfo(
		signal
			? {
					signal
				}
			: undefined
	)
}

export function useAccountQuery(
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) => fetchData(signal)
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useAccountQuery

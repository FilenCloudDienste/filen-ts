import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"
import fileProvider from "@/lib/fileProvider"

export const BASE_QUERY_KEY = "useFileProviderCacheBudget"

export async function fetchData(): Promise<number> {
	return await fileProvider.cacheBudget()
}

export function useFileProviderCacheBudgetQuery(
	options?: Omit<UseQueryOptions<number, Error>, "queryKey" | "queryFn">
): UseQueryResult<number, Error> {
	return useQuery<number, Error>({
		// Source of truth is auth.json on disk — recompute on mount, don't persist.
		staleTime: 0,
		gcTime: 0,
		networkMode: "always",
		refetchOnMount: "always",
		refetchOnReconnect: false,
		refetchOnWindowFocus: false,
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: () => fetchData()
	})
}

export function invalidateFileProviderCacheBudgetQuery(): Promise<void> {
	return queryClient.invalidateQueries({
		queryKey: [BASE_QUERY_KEY]
	})
}

export default useFileProviderCacheBudgetQuery

import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"
import thumbnails from "@/lib/thumbnails"
import fileCache from "@/lib/fileCache"
import audioCache from "@/lib/audioCache"
import sandboxCache from "@/lib/sandboxCache"
import offline from "@/lib/offline"

export const BASE_QUERY_KEY = "useCacheSizes"

export type CacheSizes = {
	thumbnails: number
	fileCache: number
	audioCache: number
	sandbox: number
	offline: {
		size: number
		files: number
		dirs: number
	}
}

export async function fetchData(): Promise<CacheSizes> {
	const offlineSize = await offline.size()

	return {
		thumbnails: thumbnails.size(),
		fileCache: fileCache.size(),
		audioCache: audioCache.size(),
		sandbox: sandboxCache.size(),
		offline: offlineSize
	}
}

export function useCacheSizesQuery(
	options?: Omit<UseQueryOptions<CacheSizes, Error>, "queryKey" | "queryFn">
): UseQueryResult<CacheSizes, Error> {
	return useQuery<CacheSizes, Error>({
		// Sizes are derived from on-disk state — recompute on mount, don't persist.
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

export function invalidateCacheSizesQuery(): Promise<void> {
	return queryClient.invalidateQueries({
		queryKey: [BASE_QUERY_KEY]
	})
}

export default useCacheSizesQuery

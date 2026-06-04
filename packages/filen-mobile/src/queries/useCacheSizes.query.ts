import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"
import thumbnails from "@/lib/thumbnails"
import fileCache from "@/lib/fileCache"
import audioCache from "@/lib/audioCache"
import sandboxCache from "@/lib/sandboxCache"
import offline from "@/features/offline/offline"

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

// Each size() below walks its cache directory synchronously on the JS thread —
// expo-file-system's File/Directory APIs have no async variant, and offline.size()
// is also a sync walk under an async wrapper. On a cold open of /advanced this
// blocks the modal slide-in for hundreds of ms when caches hold many files.
// Yield up front so React commits the modal mount before the first walk starts,
// and yield again between walks so pending touches/renders get a slot.
function yieldToUI(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0))
}

export async function fetchData(): Promise<CacheSizes> {
	await yieldToUI()

	const offlineSize = await offline.size()
	await yieldToUI()

	const thumbnailsSize = thumbnails.size()
	await yieldToUI()

	const fileCacheSize = fileCache.size()
	await yieldToUI()

	const audioCacheSize = audioCache.size()
	await yieldToUI()

	const sandboxSize = sandboxCache.size()

	return {
		thumbnails: thumbnailsSize,
		fileCache: fileCacheSize,
		audioCache: audioCacheSize,
		sandbox: sandboxSize,
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

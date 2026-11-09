import { useQueries, useQuery } from "@tanstack/react-query"
import { measureRow, originUsage, type CacheRow, type MeasuredRow } from "@/features/settings/lib/localCaches"
import { STORAGE_QUERY_ROOT } from "@/features/settings/lib/storageActions"
import { useMountsStore } from "@/features/mounts/lib/mountsStore"
import { noDiskPersister } from "@/queries/persist"

// A size: undefined while it is measured, null when it could not be.
export type RowSize = number | null | undefined

// Sizes exist only while the page is mounted: measured once (walks cancelled on unmount), never persisted (they would
// land in the cache being measured), and measured again only after a clear.
const SIZE_QUERY_OPTIONS = {
	persister: noDiskPersister,
	staleTime: Infinity,
	gcTime: 0,
	retry: false,
	refetchOnWindowFocus: false,
	refetchOnReconnect: false
} as const

export function useCacheSizes(rows: readonly MeasuredRow[]): Partial<Record<CacheRow, RowSize>> {
	return useQueries({
		queries: rows.map(row => ({
			...SIZE_QUERY_OPTIONS,
			queryKey: [...STORAGE_QUERY_ROOT, row],
			queryFn: ({ signal }: { signal: AbortSignal }) => measureRow(row, signal)
		})),
		combine: results => {
			const sizes: Partial<Record<CacheRow, RowSize>> = {}

			results.forEach((result, index) => {
				const row = rows[index]

				if (row !== undefined) {
					sizes[row] = result.isPending ? undefined : result.isError ? null : result.data
				}
			})

			return sizes
		}
	})
}

export function useOriginUsage(): RowSize {
	const query = useQuery<number | null>({
		...SIZE_QUERY_OPTIONS,
		queryKey: [...STORAGE_QUERY_ROOT, "estimate"],
		queryFn: originUsage
	})

	return query.isPending ? undefined : query.isError ? null : query.data
}

// The drive cache as the shell last reported it; it only knows while its host runs.
export function useNetworkDriveCacheBytes(): number | null {
	return useMountsStore(state => (state.overview?.host.state === "running" ? state.overview.cache.usedBytes : null))
}

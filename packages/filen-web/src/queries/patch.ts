import type { Query, QueryKey } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"

// One lookup by the key's hash: find(), cancelQueries and invalidateQueries each copy and re-hash the
// whole query cache, and socket events patch through here.
export function cachedQuery<T>(queryKey: QueryKey): Query<T> | undefined {
	return queryClient.getQueryCache().get<T>(queryClient.defaultQueryOptions({ queryKey }).queryHash)
}

// Confirm-then-patch (queries/client.ts's zero-useMutation convention) for a query a read may be
// refreshing. A read in flight may have been answered before this write and would land over the patch,
// so it is cancelled first, unless it is the initial fetch: cancelling that would strand the query
// loading with nothing to show. setQueryData then marks the data fresh, which would drop whatever that
// read, or a pending invalidation, was for until the next focus. So when either existed, the query reads
// again after the patch: at once while mounted, on its next mount otherwise. An idle, fresh query costs
// nothing beyond the patch.
export function patchQuery<T>(queryKey: QueryKey, updater: (prev: T | undefined) => T | undefined): void {
	const query = cachedQuery<T>(queryKey)
	const fetching = query !== undefined && query.state.fetchStatus !== "idle"
	const refreshPending = fetching || query?.state.isInvalidated === true

	if (fetching && query.state.data !== undefined) {
		void query.cancel({ revert: true })
	}

	queryClient.setQueryData<T>(queryKey, updater)

	// Through the query itself rather than invalidateQueries, which scans the whole cache: what that does
	// for one exact key, minus the scan.
	if (refreshPending) {
		query.invalidate()

		if (query.isActive()) {
			query.fetch(undefined, { cancelRefetch: true }).catch(() => undefined)
		}
	}
}

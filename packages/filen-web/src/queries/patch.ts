import type { Query, QueryKey, SetDataOptions } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"

// One lookup by the key's hash: find(), cancelQueries and invalidateQueries each copy and re-hash the
// whole query cache, and socket events patch through here.
export function cachedQuery<T>(queryKey: QueryKey): Query<T> | undefined {
	return queryClient.getQueryCache().get<T>(queryClient.defaultQueryOptions({ queryKey }).queryHash)
}

// A read in flight may have been answered before a write and would land over it. Not an initial fetch:
// cancelling that would strand the query loading with nothing to show.
export function cancelInFlightIfCached<T>(query: Query<T>): void {
	if (query.state.fetchStatus !== "idle" && query.state.data !== undefined) {
		void query.cancel({ revert: true })
	}
}

// setQueryData marks the data fresh, which drops a pending invalidation: the change behind it would then
// wait out the stale time, or never be read on a socket-synced query that never goes stale on its own.
export function setQueryDataKeepInvalidated<T>(query: Query<T>, data: T, options?: SetDataOptions): void {
	const invalidated = query.state.isInvalidated

	queryClient.setQueryData<T>(query.queryKey, data, options)

	if (invalidated) {
		query.invalidate()
	}
}

// Confirm-then-patch (queries/client.ts's zero-useMutation convention) for a query a read may be
// refreshing. A read in flight is cancelled first (cancelInFlightIfCached). setQueryData then marks the
// data fresh, which would drop whatever that read, or a pending invalidation, was for until the next
// focus. So when either existed, the query reads again after the patch: at once while mounted, on its next
// mount otherwise. An idle, fresh query costs nothing beyond the patch.
export function patchQuery<T>(queryKey: QueryKey, updater: (prev: T | undefined) => T | undefined): void {
	const query = cachedQuery<T>(queryKey)
	const refreshPending = query !== undefined && (query.state.fetchStatus !== "idle" || query.state.isInvalidated)

	if (query !== undefined) {
		cancelInFlightIfCached(query)
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

// Position-preserving replace of the first match, else append; always a fresh array.
export function replaceOrAppend<T>(list: readonly T[], item: T, matches: (row: T) => boolean): T[] {
	const index = list.findIndex(matches)

	if (index === -1) {
		return [...list, item]
	}

	const next = list.slice()

	next[index] = item

	return next
}

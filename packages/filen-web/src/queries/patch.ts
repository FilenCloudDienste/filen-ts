import type { Query, QueryCache, QueryCacheNotifyEvent, QueryKey, SetDataOptions } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"

// One lookup by the key's hash: find(), cancelQueries and invalidateQueries each copy and re-hash the
// whole query cache, and socket events patch through here.
export function cachedQuery<T>(queryKey: QueryKey): Query<T> | undefined {
	return queryClient.getQueryCache().get<T>(queryClient.defaultQueryOptions({ queryKey }).queryHash)
}

interface PrefixMirror {
	prefix: readonly [string, string]
	queries: Set<Query>
}

const prefixMirrors = new WeakMap<QueryCache, Map<string, PrefixMirror>>()

// findAll({ queryKey: prefix }) minus the scan: findAll copies and matches every query in the cache, and
// socket events look listings up per event. The cache announces each add and remove synchronously, so a
// mirror seeded from findAll and kept by those events holds the same queries in the same (insertion)
// order. Always a fresh array, so callers may patch while iterating.
export function cachedQueriesWithPrefix(prefix: readonly [string, string]): Query[] {
	const cache = queryClient.getQueryCache()
	let mirrors = prefixMirrors.get(cache)

	if (mirrors === undefined) {
		const registered = new Map<string, PrefixMirror>()

		mirrors = registered
		prefixMirrors.set(cache, registered)

		cache.subscribe((event: { type: QueryCacheNotifyEvent["type"]; query: Query }) => {
			const query = event.query

			if (event.type === "added") {
				for (const mirror of registered.values()) {
					if (query.queryKey[0] === mirror.prefix[0] && query.queryKey[1] === mirror.prefix[1]) {
						mirror.queries.add(query)
					}
				}
			} else if (event.type === "removed") {
				for (const mirror of registered.values()) {
					mirror.queries.delete(query)
				}
			}
		})
	}

	const id = `${prefix[0]}\u0000${prefix[1]}`
	let mirror = mirrors.get(id)

	if (mirror === undefined) {
		mirror = { prefix, queries: new Set(cache.findAll({ queryKey: prefix })) }
		mirrors.set(id, mirror)
	}

	return [...mirror.queries]
}

// cancelQueries({ queryKey, exact: true }) for one key, minus the scan.
export function cancelCached(queryKey: QueryKey): void {
	void cachedQuery(queryKey)?.cancel({ revert: true })
}

// invalidateQueries for one key, minus the two scans: an active query reads at once.
export function invalidateCached(queryKey: QueryKey): void {
	const query = cachedQuery(queryKey)

	if (query !== undefined) {
		invalidateAndReadActive(query)
	}
}

function invalidateAndReadActive<T>(query: Query<T>): void {
	query.invalidate()

	if (query.isActive()) {
		query.fetch(undefined, { cancelRefetch: true }).catch(() => undefined)
	}
}

// invalidateQueries for a query refreshed per socket event. A read in flight may predate the event, so it
// reads once more after it settles, once however many events arrive meanwhile: restarting it per event
// would never let a read finish during a burst. An inactive query is only marked, without a cache scan.
export function invalidateJoiningInFlight<T>(query: Query<T>): void {
	const queryKey = query.queryKey

	if (query.state.fetchStatus !== "idle") {
		readAgainAfterCurrentRead(query.queryHash, queryKey)
	} else if (query.isActive()) {
		void queryClient.invalidateQueries({ queryKey, exact: true })
	} else {
		query.invalidate()
	}
}

const readAgainQueued = new Set<string>()

// Whether a read already follows the one in flight, so another would read twice.
export function isReadAgainQueued<T>(query: Query<T>): boolean {
	return readAgainQueued.has(query.queryHash)
}

function readAgainAfterCurrentRead(queryHash: string, queryKey: QueryKey): void {
	if (readAgainQueued.has(queryHash)) {
		return
	}

	readAgainQueued.add(queryHash)

	void queryClient.refetchQueries({ queryKey, exact: true }, { cancelRefetch: false }).finally(() => {
		readAgainQueued.delete(queryHash)

		void queryClient.invalidateQueries({ queryKey, exact: true })
	})
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
// mount otherwise. With readNow false it stays invalidated for the next focus, mount or reconnect instead,
// for a patch repeated per item of a batch. An idle, fresh query costs nothing beyond the patch.
export function patchQuery<T>(queryKey: QueryKey, updater: (prev: T | undefined) => T | undefined, options?: { readNow?: boolean }): void {
	const query = cachedQuery<T>(queryKey)
	const refreshPending = query !== undefined && (query.state.fetchStatus !== "idle" || query.state.isInvalidated)

	if (query !== undefined) {
		cancelInFlightIfCached(query)
	}

	queryClient.setQueryData<T>(queryKey, updater)

	if (refreshPending) {
		if (options?.readNow === false) {
			query.invalidate()
		} else {
			invalidateAndReadActive(query)
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

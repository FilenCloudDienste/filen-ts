import { type Query, type QueryCache, type QueryKey } from "@tanstack/react-query"
import useSocketStore from "@/stores/useSocket.store"

/**
 * "Read in the current socket session": the read began while the socket was up, and it has been up
 * ever since, so every change after the read's snapshot reached the cache as a socket patch. Anything
 * older may have missed events: a persisted row, a read from before a background (which tears the
 * socket listener down) or from before a reconnect.
 */
export function readStartedInCurrentSocketSession(startedAt: number): boolean {
	const socket = useSocketStore.getState()

	return socket.state === "connected" && startedAt >= socket.connectedAt
}

// When each query's last server read began. dataUpdatedAt can't answer this: every setQueryData
// patch and restored row restamps it. Keyed by the Query object, so an entry goes with its query.
const readStartedAt = new WeakMap<object, number>()
const pendingReadStartedAt = new WeakMap<object, number>()

/**
 * Records server reads from the cache's own events: a fetch start, then its non-manual success. The
 * persister answering a fetch from storage restores the stored dataUpdatedAt (a setState) on the way,
 * which marks that fetch as no read. Returns the unsubscribe.
 */
export function trackServerReads(queryCache: QueryCache): () => void {
	return queryCache.subscribe(event => {
		if (event.type !== "updated") {
			return
		}

		switch (event.action.type) {
			case "fetch": {
				pendingReadStartedAt.set(event.query, Date.now())

				break
			}

			case "setState":
			case "error": {
				pendingReadStartedAt.delete(event.query)

				break
			}

			case "success": {
				if (event.action.manual) {
					break
				}

				const startedAt = pendingReadStartedAt.get(event.query)

				if (startedAt !== undefined) {
					readStartedAt.set(event.query, startedAt)
					pendingReadStartedAt.delete(event.query)
				}

				break
			}
		}
	})
}

// A cached value a mount can trust as-is: read by its query during the current socket session, not
// invalidated since, not errored, and (for data some changes of which no socket event carries) no
// older than maxAgeMs.
export function queryReadInCurrentSocketSession<TQueryFnData, TError, TData, TQueryKey extends QueryKey>(
	query: Query<TQueryFnData, TError, TData, TQueryKey>,
	maxAgeMs?: number
): boolean {
	const startedAt = readStartedAt.get(query)

	return (
		startedAt !== undefined &&
		!query.state.isInvalidated &&
		query.state.status !== "error" &&
		(maxAgeMs === undefined || Date.now() - startedAt < maxAgeMs) &&
		readStartedInCurrentSocketSession(startedAt)
	)
}

/**
 * refetchOnMount for a query the socket patches: a mount reuses a read from the current socket
 * session and reads otherwise. Reconnect refetches (refetchOnReconnect) are untouched.
 */
export function socketCoveredRefetchOnMount(
	maxAgeMs?: number
): <TQueryFnData, TError, TData, TQueryKey extends QueryKey>(query: Query<TQueryFnData, TError, TData, TQueryKey>) => boolean | "always" {
	return query => (queryReadInCurrentSocketSession(query, maxAgeMs) ? false : "always")
}

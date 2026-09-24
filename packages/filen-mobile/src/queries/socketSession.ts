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

type PendingRead = {
	startedAt: number
	socketEventSeq: number
	// A patch landed while the read was in flight: its result replaces the patched data.
	patched: boolean
}

const pendingReads = new WeakMap<object, PendingRead>()
// Counts socket data events. A read in flight when one arrives can come back without that change,
// whether the patch was overwritten by its result or had nothing to patch yet (a first read).
let socketEventSeq = 0

export function noteSocketDataEvent(): void {
	socketEventSeq++
}

/**
 * Records server reads from the cache's own events: a fetch start, then its non-manual success. The
 * persister answering a fetch from storage restores the stored dataUpdatedAt (a setState) on the way,
 * which marks that fetch as no read. A read that a patch or a socket event overlapped is no read
 * either, and the one before it no longer describes the data. Returns the unsubscribe.
 */
export function trackServerReads(queryCache: QueryCache): () => void {
	return queryCache.subscribe(event => {
		if (event.type !== "updated") {
			return
		}

		switch (event.action.type) {
			case "fetch": {
				pendingReads.set(event.query, {
					startedAt: Date.now(),
					socketEventSeq,
					patched: false
				})

				break
			}

			case "setState":
			case "error": {
				pendingReads.delete(event.query)

				break
			}

			case "success": {
				const pending = pendingReads.get(event.query)

				if (event.action.manual) {
					if (pending) {
						pending.patched = true
					}

					break
				}

				if (!pending) {
					break
				}

				pendingReads.delete(event.query)

				if (pending.patched || pending.socketEventSeq !== socketEventSeq) {
					readStartedAt.delete(event.query)

					break
				}

				readStartedAt.set(event.query, pending.startedAt)

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

import type { UserEventResult } from "@filen/sdk-rs"

export type OkEventResult = Extract<UserEventResult, { type: "ok" }>

// Pure pagination step, mirrors filen-mobile's computeNextPage (features/events/screens/events.tsx):
// given the already-loaded Ok event ids and a raw next page from the server, returns only the new Ok
// items (Err entries have no stable id, cannot be deduped, and must never be persisted into the cache)
// plus a `terminate` flag. Termination fires when the page delivers zero new decryptable events — an
// empty page, an all-Err page, or a page whose Ok ids were all already seen — which prevents an
// Err-only page from causing an infinite refetch loop.
export function computeNextEventsPage(
	existingOkIds: ReadonlySet<bigint>,
	page: UserEventResult[]
): { newOk: OkEventResult[]; terminate: boolean } {
	const newOk = page.filter((e): e is OkEventResult => e.type === "ok" && !existingOkIds.has(e.id))

	return { newOk, terminate: newOk.length === 0 }
}

// Scroll-triggered pagination's combined guard (eventsList.tsx's handleScroll) — pulled out so the
// offline branch is unit-testable without mounting the virtualized list. Mirrors mobile's
// onEndReached: offline early-returns WITHOUT flipping hasMore, so the very next near-bottom scroll
// after reconnecting resumes pagination instead of the list having been permanently marked
// "no more pages" by a fetch that never ran.
export function shouldSkipEventsScroll(state: { inflight: boolean; hasMore: boolean; queryReady: boolean; isOnline: boolean }): boolean {
	return state.inflight || !state.hasMore || !state.queryReady || !state.isOnline
}

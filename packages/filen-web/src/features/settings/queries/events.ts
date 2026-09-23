import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import type { UserEventResult } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { computeNextEventsPage, mergeFirstEventsPage, selectEventsView, type EventsView } from "@/features/settings/lib/eventsPagination"

// Single flat cache slice (no per-cursor pages), same shape as chatMessages.ts's own single-slice
// convention: `loadOlderEvents` below mutates this one entry in place (append + dedupe) rather than
// tracking pages. The pagination CURSOR (a bigint timestamp) never enters the query key — bigint
// belongs in query DATA only (queries/client.ts's own rule; the default hasher throws on it) — and
// there is no per-cursor cache entry to key by in the first place.
export const EVENTS_QUERY_KEY = ["settings", "events"] as const

// The socket epoch of the latest first-page read, when it ran entirely under a live socket. A persisted
// slice restores with its original read time, the socket can't replay events logged while the app was
// closed or the socket was down, and a read it wasn't up for may predate an event it never delivered.
let readEpoch: number | null = null

// Testable fetch — mirrors fetchAccount/fetchChatMessages: no filter/timestamp on the first page
// fetches the most recent events (wasm defaults per sdk-rs.d.ts's `getUserEvents(filter?,
// timestamp?)`). Merged into the slice read AFTER the await, so a page loadOlderEvents appended
// while this was in flight is kept too.
export async function fetchEvents(): Promise<UserEventResult[]> {
	const epoch = currentSocketEpoch()
	const page = await sdkApi.getUserEvents()

	readEpoch = socketLiveSince(epoch) ? epoch : null

	return mergeFirstEventsPage(eventsQueryGet(), page)
}

// The socket's newEvent marks the slice stale (generalSocketHandlers.ts), so a return to the page or a
// refocus reuses it. Until a read counts (see readEpoch), and again once the socket drops or
// re-authenticates, it refetches like any staleTime-0 query; a network reconnect always does.
export const EVENTS_STALE_TIME = 5 * 60 * 1000

// `select` (a module-level function, so query-core reuses its cached result until the raw data
// identity changes) keeps the sort + Ok/Err partition off the render path — see selectEventsView.
export function useEventsQuery(): UseQueryResult<EventsView> {
	return useQuery({
		queryKey: EVENTS_QUERY_KEY,
		queryFn: fetchEvents,
		select: selectEventsView,
		staleTime: () => (socketLiveSince(readEpoch) ? EVENTS_STALE_TIME : 0),
		refetchOnReconnect: "always"
	})
}

export function eventsQueryGet(): UserEventResult[] | undefined {
	return queryClient.getQueryData<UserEventResult[]>(EVENTS_QUERY_KEY)
}

// Fetches one older page via getUserEvents(undefined, oldestTimestamp) and appends the new Ok items
// (Err entries are discarded — see eventsPagination.ts) into the single cache slice, deduped by id.
// Returns the pagination step's own result so the caller (EventsList) can flip its local `hasMore`
// flag off on `terminate` without re-deriving the dedup logic itself. A first-page refresh in flight
// is left running: it merges into the slice as it stands when it lands, this page included, and
// cancelling it would drop the new event that triggered it.
export async function loadOlderEvents(oldestTimestamp: bigint): Promise<{ newCount: number; terminate: boolean }> {
	const page = await sdkApi.getUserEvents(undefined, oldestTimestamp)
	const current = eventsQueryGet() ?? []
	const existingOkIds = new Set(current.filter(e => e.type === "ok").map(e => e.id))
	const { newOk, terminate } = computeNextEventsPage(existingOkIds, page)

	if (newOk.length > 0) {
		queryClient.setQueryData<UserEventResult[]>(EVENTS_QUERY_KEY, prev => [...(prev ?? []), ...newOk])
	}

	return { newCount: newOk.length, terminate }
}

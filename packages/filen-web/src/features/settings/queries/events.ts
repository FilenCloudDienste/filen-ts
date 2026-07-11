import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import type { UserEventResult } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { computeNextEventsPage } from "@/features/settings/lib/eventsPagination"

// Single flat cache slice (no per-cursor pages), same shape as chatMessages.ts's own single-slice
// convention: `loadOlderEvents` below mutates this one entry in place (append + dedupe) rather than
// tracking pages. The pagination CURSOR (a bigint timestamp) never enters the query key — bigint
// belongs in query DATA only (queries/client.ts's own rule; the default hasher throws on it) — and
// there is no per-cursor cache entry to key by in the first place.
export const EVENTS_QUERY_KEY = ["settings", "events"] as const

// Bare, testable fetch — mirrors fetchAccount/fetchChatMessages: no filter/timestamp on the first
// page fetches the most recent events (wasm defaults per sdk-rs.d.ts's `getUserEvents(filter?,
// timestamp?)`).
export function fetchEvents(): Promise<UserEventResult[]> {
	return sdkApi.getUserEvents()
}

export function useEventsQuery(): UseQueryResult<UserEventResult[]> {
	return useQuery({
		queryKey: EVENTS_QUERY_KEY,
		queryFn: fetchEvents
	})
}

export function eventsQueryGet(): UserEventResult[] | undefined {
	return queryClient.getQueryData<UserEventResult[]>(EVENTS_QUERY_KEY)
}

function cancelInFlightIfCached(): void {
	if (queryClient.getQueryData(EVENTS_QUERY_KEY) !== undefined) {
		void queryClient.cancelQueries({ queryKey: EVENTS_QUERY_KEY })
	}
}

// Fetches one older page via getUserEvents(undefined, oldestTimestamp) and appends the new Ok items
// (Err entries are discarded — see eventsPagination.ts) into the single cache slice, deduped by id.
// Returns the pagination step's own result so the caller (EventsList) can flip its local `hasMore`
// flag off on `terminate` without re-deriving the dedup logic itself.
export async function loadOlderEvents(oldestTimestamp: bigint): Promise<{ newCount: number; terminate: boolean }> {
	const page = await sdkApi.getUserEvents(undefined, oldestTimestamp)
	const current = eventsQueryGet() ?? []
	const existingOkIds = new Set(current.filter(e => e.type === "ok").map(e => e.id))
	const { newOk, terminate } = computeNextEventsPage(existingOkIds, page)

	if (newOk.length > 0) {
		cancelInFlightIfCached()
		queryClient.setQueryData<UserEventResult[]>(EVENTS_QUERY_KEY, prev => [...(prev ?? []), ...newOk])
	}

	return { newCount: newOk.length, terminate }
}

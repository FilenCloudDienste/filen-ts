import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import type { UserEventResult } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { cachedQuery, invalidateJoiningInFlight, setQueryDataKeepInvalidated } from "@/queries/patch"
import { persister } from "@/queries/persist"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { log } from "@/lib/log"
import {
	computeNextEventsPage,
	eventResultKey,
	eventsPageCutoff,
	insertEventResult,
	mergeEventResults,
	mergeFirstEventsPage,
	oldestEventTimestamp,
	selectEventsView,
	type EventsView
} from "@/features/settings/lib/eventsPagination"

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

// Events the slice keeps past a mounted list's own scrolling: the slice is persisted whole and restored
// at every boot, so pages scrolled in once must not ride along forever. A return to the page reuses up
// to this many, and scrolling past them pages the rest in again.
export const EVENTS_SLICE_CAP = 300

// Whether the mounted list has scrolled older pages in. Its slice is left whole until it unmounts: a
// trim under it would cut rows out from under the scroll position.
let listPaged = false

// The newest `cap` events, or the first page whole when it alone is longer. The slice is newest first.
export function capEventsSlice(slice: UserEventResult[], cap: number, keep = 0): UserEventResult[] {
	const limit = Math.max(cap, keep)

	return slice.length <= limit ? slice : slice.slice(0, limit)
}

// Testable fetch — mirrors fetchAccount/fetchChatMessages: no filter/timestamp on the first page
// fetches the most recent events (wasm defaults per sdk-rs.d.ts's `getUserEvents(filter?,
// timestamp?)`). Merged into the slice read AFTER the await, so a page loadOlderEvents appended
// while this was in flight is kept too.
export async function fetchEvents(): Promise<UserEventResult[]> {
	const epoch = currentSocketEpoch()
	const page = await sdkApi.getUserEvents()

	readEpoch = socketLiveSince(epoch) ? epoch : null

	const merged = mergeFirstEventsPage(eventsQueryGet(), page)

	return listPaged ? merged : capEventsSlice(merged, EVENTS_SLICE_CAP, page.length)
}

// The socket's newEvent splices into a mounted list's slice and marks an unmounted one stale
// (generalSocketHandlers.ts), so a return to the page or a refocus reuses it. Until a read counts (see readEpoch), and again once the socket drops or
// re-authenticates, it refetches like any staleTime-0 query; a network reconnect always does.
export const EVENTS_STALE_TIME = 5 * 60 * 1000

// `select` (a module-level function, so query-core reuses its cached result until the raw data
// identity changes) keeps the sort and the raw-event parsing off the render path — see selectEventsView.
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

// The second (of the slice's oldest event) a page could not read past: the next page cuts before it.
let pastSecond: bigint | null = null

// Fetches one older page from the second after `oldestTimestamp` (eventsPageCutoff), or from that second
// itself once a page reached no earlier one, and merges what it adds into the single cache slice, deduped
// by event id, undecodable events included. Returns the pagination step's own result so the caller
// (EventsList) can flip its local `hasMore` flag off on `terminate` without re-deriving the dedup logic
// itself. A first-page refresh in flight is left running: it merges into the slice as it stands when it
// lands, this page included, and cancelling it would drop the new event that triggered it. A page whose
// cursor is no longer the slice's end (a trim or a replacing first page landed meanwhile) is dropped:
// appended, it would leave a gap.
export async function loadOlderEvents(oldestTimestamp: bigint): Promise<{ newCount: number; terminate: boolean }> {
	const second = oldestTimestamp / 1000n
	const past = pastSecond === second
	const page = await sdkApi.getUserEvents(undefined, eventsPageCutoff(oldestTimestamp, past))
	const current = eventsQueryGet() ?? []

	if (oldestEventTimestamp(current) !== oldestTimestamp) {
		return { newCount: 0, terminate: false }
	}

	const step = computeNextEventsPage(new Set(current.map(eventResultKey)), page, oldestTimestamp, past)

	pastSecond = step.pastSecond ? second : null

	if (step.fresh.length > 0) {
		listPaged = true
		queryClient.setQueryData<UserEventResult[]>(EVENTS_QUERY_KEY, prev => mergeEventResults(prev ?? [], step.fresh))
	}

	return { newCount: step.fresh.length, terminate: step.terminate }
}

// Past this many single-event reads in flight, a burst reads page one once instead.
const SPLICE_BURST_LIMIT = 3

let splicesInFlight = 0

// The socket's newEvent for a mounted list: the one event read by its uuid and placed by its time, rather
// than page one again. Keeps the read time and any pending invalidation, so the splice doesn't pass for a
// fresh read. A kind the SDK can't decode rejects, and page one is read instead, where it arrives as an
// undecodable entry.
export async function spliceNewEvent(uuid: string): Promise<void> {
	const query = cachedQuery<UserEventResult[]>(EVENTS_QUERY_KEY)

	if (query?.state.data === undefined) {
		return
	}

	if (splicesInFlight >= SPLICE_BURST_LIMIT) {
		invalidateJoiningInFlight(query)

		return
	}

	splicesInFlight++

	try {
		const event = await sdkApi.getUserEvent(uuid)
		const current = cachedQuery<UserEventResult[]>(EVENTS_QUERY_KEY)
		const slice = current?.state.data

		if (current === undefined || slice === undefined) {
			return
		}

		const next = insertEventResult(slice, { type: "ok", ...event })

		if (next !== slice) {
			setQueryDataKeepInvalidated(current, next, { updatedAt: current.state.dataUpdatedAt })
		}
	} catch (e) {
		log.warn("settings-events", "new event read failed, reading page one", uuid, e)

		const current = cachedQuery<UserEventResult[]>(EVENTS_QUERY_KEY)

		if (current?.state.data !== undefined) {
			invalidateJoiningInFlight(current)
		}
	} finally {
		splicesInFlight--
	}
}

// The list unmounting: what it scrolled in is trimmed back to the cap, in memory and on disk. Only a
// first-page read persists by itself, and until the next one the row on disk would still be restored
// whole at every boot. Splices alone can take an unpaged slice past the cap too. Keeps the read time and
// any pending invalidation, so the trim doesn't pass for a fresh read.
export function releaseEventsSlice(): void {
	listPaged = false
	pastSecond = null

	const query = cachedQuery(EVENTS_QUERY_KEY)
	const slice = eventsQueryGet()

	if (query === undefined || slice === undefined || slice.length <= EVENTS_SLICE_CAP) {
		return
	}

	setQueryDataKeepInvalidated(query, capEventsSlice(slice, EVENTS_SLICE_CAP), { updatedAt: query.state.dataUpdatedAt })

	void persister.persistQuery(query)
}

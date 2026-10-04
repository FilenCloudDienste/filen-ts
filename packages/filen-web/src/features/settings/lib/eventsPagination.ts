import type { UserEventResult } from "@filen/sdk-rs"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"

export type OkEventResult = Extract<UserEventResult, { type: "ok" }>

export type ErrEventResult = Extract<UserEventResult, { type: "err" }>

// What an undecodable event's raw server JSON still says, every field read defensively: the SDK failed
// to decode it, so nothing about its shape is guaranteed.
export interface RawEventFields {
	id?: bigint
	// Milliseconds.
	timestamp?: bigint
	uuid?: string
	type?: string
	ip?: string
	userAgent?: string
}

// One list entry. An undecodable event stays in place as `unknown`, with whatever its raw JSON says.
// `timestamp` is always set: a raw event without one takes its neighbour's, keeping the server's order.
export type EventEntry =
	| { type: "ok"; key: string; timestamp: bigint; event: OkEventResult }
	| { type: "unknown"; key: string; timestamp: bigint; event: ErrEventResult; raw: RawEventFields }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rawInteger(value: unknown): bigint | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
		return BigInt(value)
	}

	if (typeof value === "string" && /^\d{1,20}$/.test(value)) {
		return BigInt(value)
	}

	return undefined
}

function rawString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

// The server sends seconds or millis; below 1e11 can only be seconds (1e11 ms is 1973).
const SECONDS_BELOW = 100_000_000_000n

export function parseRawEvent(raw: string): RawEventFields {
	let value: unknown

	try {
		value = JSON.parse(raw)
	} catch {
		return {}
	}

	if (!isRecord(value)) {
		return {}
	}

	const fields: RawEventFields = {}
	const id = rawInteger(value["id"])
	const timestamp = rawInteger(value["timestamp"])
	const uuid = rawString(value["uuid"])
	const type = rawString(value["type"])
	const info = value["info"]

	if (id !== undefined) {
		fields.id = id
	}

	if (timestamp !== undefined && timestamp > 0n) {
		fields.timestamp = timestamp < SECONDS_BELOW ? timestamp * 1000n : timestamp
	}

	if (uuid !== undefined) {
		fields.uuid = uuid
	}

	if (type !== undefined) {
		fields.type = type
	}

	if (isRecord(info)) {
		const ip = rawString(info["ip"])
		const userAgent = rawString(info["userAgent"])

		if (ip !== undefined) {
			fields.ip = ip
		}

		if (userAgent !== undefined) {
			fields.userAgent = userAgent
		}
	}

	return fields
}

// Parsed once per result object: the slice keeps its objects across merges.
const rawFieldsCache = new WeakMap<ErrEventResult, RawEventFields>()

export function rawEventFields(event: ErrEventResult): RawEventFields {
	let fields = rawFieldsCache.get(event)

	if (fields === undefined) {
		fields = parseRawEvent(event.raw)
		rawFieldsCache.set(event, fields)
	}

	return fields
}

function eventId(event: UserEventResult): bigint | undefined {
	return event.type === "ok" ? event.id : rawEventFields(event).id
}

function knownTimestamp(event: UserEventResult): bigint | undefined {
	return event.type === "ok" ? event.timestamp : rawEventFields(event).timestamp
}

// The dedupe identity, shared by decoded and undecodable events: the server's event id where known.
export function eventResultKey(event: UserEventResult): string {
	if (event.type === "ok") {
		return event.id.toString()
	}

	const raw = rawEventFields(event)

	if (raw.id !== undefined) {
		return raw.id.toString()
	}

	return raw.uuid !== undefined ? `uuid:${raw.uuid}` : `raw:${event.raw}`
}

// Newest first; equal timestamps by id, newest first.
function compareEntries(a: EventEntry, b: EventEntry): number {
	if (a.timestamp !== b.timestamp) {
		return a.timestamp > b.timestamp ? -1 : 1
	}

	const aId = eventId(a.event)
	const bId = eventId(b.event)

	if (aId === undefined || bId === undefined || aId === bId) {
		return 0
	}

	return aId > bId ? -1 : 1
}

// Entries in the slice's own order, a timestamp-less one taking the one before it (the first known one
// when leading).
function entriesInOrder(slice: readonly UserEventResult[]): EventEntry[] {
	let previous = 0n

	for (const event of slice) {
		const timestamp = knownTimestamp(event)

		if (timestamp !== undefined) {
			previous = timestamp

			break
		}
	}

	const entries: EventEntry[] = []

	for (const event of slice) {
		const timestamp = knownTimestamp(event) ?? previous
		const key = eventResultKey(event)

		previous = timestamp

		entries.push(
			event.type === "ok"
				? { type: "ok", key, timestamp, event }
				: { type: "unknown", key, timestamp, event, raw: rawEventFields(event) }
		)
	}

	return entries
}

// Sorted entries for a slice. A timestamp-less entry takes the one before it, so it stays where the
// server put it.
export function toEventEntries(slice: readonly UserEventResult[]): EventEntry[] {
	return entriesInOrder(slice).sort(compareEntries)
}

export function sortEventResults(slice: readonly UserEventResult[]): UserEventResult[] {
	return toEventEntries(slice).map(entry => entry.event)
}

// The oldest timestamp the slice knows: where the next older page is read from.
export function oldestEventTimestamp(slice: readonly UserEventResult[]): bigint | undefined {
	let oldest: bigint | undefined

	for (const event of slice) {
		const timestamp = knownTimestamp(event)

		if (timestamp !== undefined && (oldest === undefined || timestamp < oldest)) {
			oldest = timestamp
		}
	}

	return oldest
}

// The server returns the newest page strictly before a cutoff SECOND. Cutting at the oldest event's own
// second would skip that second's events a full page left out, so the cutoff is the second after it and
// the overlap is deduped. A second holding a page or more can't be read past that way: `pastSecond` cuts
// at the second itself, leaving what of it no page held.
export function eventsPageCutoff(oldest: bigint, pastSecond = false): bigint {
	const second = (oldest / 1000n) * 1000n

	return pastSecond ? second : second + 1000n
}

export interface EventsPageStep {
	fresh: UserEventResult[]
	terminate: boolean
	// The next page cuts past the slice's oldest second (eventsPageCutoff).
	pastSecond: boolean
}

// Pure pagination step: the page's events not yet in the slice, and how paging goes on. It is over on an
// empty page. A page that reached no earlier second was filled by the slice's oldest second (a bulk trash
// or move), so the next one reads past that second; when that read already did, there is nothing older.
export function computeNextEventsPage(
	existingKeys: ReadonlySet<string>,
	page: readonly UserEventResult[],
	oldest: bigint,
	pastSecond = false
): EventsPageStep {
	const fresh = page.filter(event => !existingKeys.has(eventResultKey(event)))

	if (page.length === 0) {
		return { fresh, terminate: true, pastSecond: false }
	}

	const pageOldest = oldestEventTimestamp(page)

	if (pageOldest !== undefined && pageOldest / 1000n < oldest / 1000n) {
		// Nothing new would leave the cursor where it is, and the next page the same.
		return { fresh, terminate: fresh.length === 0, pastSecond: false }
	}

	return { fresh, terminate: pastSecond, pastSecond: true }
}

// A refresh of the first page, merged into the cached slice so the older pages scrolled in survive
// it. Only when the page shares an event with the slice: without one, events between the two may be
// missing, so the page replaces the slice and pagination resumes from its end.
export function mergeFirstEventsPage(current: readonly UserEventResult[] | undefined, page: readonly UserEventResult[]): UserEventResult[] {
	if (current === undefined) {
		return sortEventResults(page)
	}

	const pageKeys = new Set(page.map(eventResultKey))

	if (!current.some(event => pageKeys.has(eventResultKey(event)))) {
		return sortEventResults(page)
	}

	return sortEventResults([...page, ...current.filter(event => !pageKeys.has(eventResultKey(event)))])
}

// An older page merged into the sorted slice in one pass rather than the whole slice sorted again. Ties
// keep the slice's event first, as a stable sort would.
export function mergeEventResults(slice: readonly UserEventResult[], page: readonly UserEventResult[]): UserEventResult[] {
	const current = entriesInOrder(slice)
	const older = toEventEntries(page)
	const merged: UserEventResult[] = []
	let i = 0
	let j = 0

	while (i < current.length && j < older.length) {
		const a = current[i]
		const b = older[j]

		if (a === undefined || b === undefined) {
			break
		}

		if (compareEntries(b, a) < 0) {
			merged.push(b.event)
			j++
		} else {
			merged.push(a.event)
			i++
		}
	}

	for (; i < current.length; i++) {
		const entry = current[i]

		if (entry !== undefined) {
			merged.push(entry.event)
		}
	}

	for (; j < older.length; j++) {
		const entry = older[j]

		if (entry !== undefined) {
			merged.push(entry.event)
		}
	}

	return merged
}

// One event placed into the slice by its time; the slice itself when it already holds it.
export function insertEventResult(slice: UserEventResult[], event: UserEventResult): UserEventResult[] {
	const key = eventResultKey(event)

	if (slice.some(existing => eventResultKey(existing) === key)) {
		return slice
	}

	return sortEventResults([event, ...slice])
}

export interface EventsView {
	// Newest first; undecodable events in place.
	entries: EventEntry[]
	// The cursor for the next older page.
	oldest: bigint | undefined
}

// The list's whole view model, derived ONCE per cache write (wired as the events query's `select`, so
// query-core memoizes it on the raw data identity) instead of per render of a list that re-renders on
// every scroll tick.
export function selectEventsView(data: UserEventResult[]): EventsView {
	return { entries: toEventEntries(data), oldest: oldestEventTimestamp(data) }
}

// Scroll-triggered pagination's combined guard (eventsList.tsx's handleScroll) — pulled out so the
// offline branch is unit-testable without mounting the virtualized list. Mirrors mobile's
// onEndReached: offline early-returns WITHOUT flipping hasMore, so the very next near-bottom scroll
// after reconnecting resumes pagination instead of the list having been permanently marked
// "no more pages" by a fetch that never ran.
export function shouldSkipEventsScroll(state: { inflight: boolean; hasMore: boolean; queryReady: boolean; isOnline: boolean }): boolean {
	return state.inflight || !state.hasMore || !state.queryReady || !state.isOnline
}

export type EventsPageFetchResult = { status: "ok"; terminate: boolean } | { status: "error"; dto: ErrorDTO }

// Wraps one loadOlderEvents call so a fetch failure becomes a typed result instead of an unhandled
// rejection the caller's own try/finally never caught (the bug this closes over) — the previous
// eventsList.tsx had no catch at all, so a pagination failure both silently swallowed the error AND
// left `hasMore` true, meaning the very next near-bottom scroll would just retry into the same
// silent failure forever, with no on-screen signal to the user. `hasMore` is deliberately left for
// the CALLER to decide: on error this returns without an opinion on it, so a transient failure never
// permanently marks the log "fully loaded" the way a `terminate` page legitimately does.
export async function fetchEventsPageSafely(fetchPage: () => Promise<{ terminate: boolean }>): Promise<EventsPageFetchResult> {
	try {
		const { terminate } = await fetchPage()

		return { status: "ok", terminate }
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}
}

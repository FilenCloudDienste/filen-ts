import { describe, expect, it } from "vitest"
import type { UserEventResult } from "@filen/sdk-rs"
import {
	computeNextEventsPage,
	eventResultKey,
	eventsPageCutoff,
	fetchEventsPageSafely,
	insertEventResult,
	mergeEventResults,
	mergeFirstEventsPage,
	oldestEventTimestamp,
	parseRawEvent,
	selectEventsView,
	shouldSkipEventsScroll,
	sortEventResults
} from "@/features/settings/lib/eventsPagination"

// One event per second unless a timestamp is given.
function ok(id: bigint, timestamp: bigint = id * 1000n): UserEventResult {
	return {
		type: "ok",
		id,
		timestamp,
		uuid: "11111111-1111-1111-1111-111111111111",
		kind: { type: "login", ip: "1.2.3.4", userAgent: "ua" }
	}
}

function err(fields: Record<string, unknown> | string = "raw"): UserEventResult {
	return { type: "err", message: "unknown variant", raw: typeof fields === "string" ? fields : JSON.stringify(fields) }
}

function keys(slice: UserEventResult[]): string[] {
	return slice.map(eventResultKey)
}

describe("parseRawEvent", () => {
	it("reads id, timestamp, uuid, type and the device fields of a raw server event", () => {
		expect(
			parseRawEvent(
				JSON.stringify({
					id: 42,
					timestamp: 1_700_000_000,
					uuid: "evt",
					type: "fileArchived",
					info: { ip: "9.9.9.9", userAgent: "Firefox", metadata: "x" }
				})
			)
		).toEqual({ id: 42n, timestamp: 1_700_000_000_000n, uuid: "evt", type: "fileArchived", ip: "9.9.9.9", userAgent: "Firefox" })
	})

	it("keeps a millisecond timestamp and a numeric-string id as they are", () => {
		expect(parseRawEvent('{"id":"18446744073709551615","timestamp":1700000000123}')).toEqual({
			id: 18446744073709551615n,
			timestamp: 1_700_000_000_123n
		})
	})

	it("reads nothing it can't trust, and never throws", () => {
		expect(parseRawEvent("not json")).toEqual({})
		expect(parseRawEvent("[1,2]")).toEqual({})
		expect(parseRawEvent("null")).toEqual({})
		expect(parseRawEvent('{"id":-1,"timestamp":"soon","uuid":7,"type":"","info":"x"}')).toEqual({})
		expect(parseRawEvent('{"id":1.5,"info":{"ip":3,"userAgent":null}}')).toEqual({})
	})
})

describe("eventResultKey", () => {
	it("shares the id space between decoded and undecodable events", () => {
		expect(eventResultKey(ok(7n))).toBe("7")
		expect(eventResultKey(err({ id: 7 }))).toBe("7")
	})

	it("falls back to the raw uuid, then the raw text", () => {
		expect(eventResultKey(err({ uuid: "abc" }))).toBe("uuid:abc")
		expect(eventResultKey(err("garbage"))).toBe("raw:garbage")
	})
})

describe("sortEventResults", () => {
	it("sorts newest first, equal timestamps by id", () => {
		expect(keys(sortEventResults([ok(1n), ok(3n, 5000n), ok(2n, 5000n), ok(9n)]))).toEqual(["9", "3", "2", "1"])
	})

	it("places undecodable events by their raw timestamp", () => {
		expect(keys(sortEventResults([ok(5n), ok(1n), err({ id: 3, timestamp: 3 })]))).toEqual(["5", "3", "1"])
	})

	it("keeps a timestamp-less event where the server put it", () => {
		expect(keys(sortEventResults([ok(5n), err("x"), ok(1n)]))).toEqual(["5", "raw:x", "1"])
		expect(keys(sortEventResults([err("x"), ok(5n), ok(1n)]))).toEqual(["raw:x", "5", "1"])
	})
})

describe("eventsPageCutoff", () => {
	it("is the second after the oldest event's own second", () => {
		expect(eventsPageCutoff(28_000n)).toBe(29_000n)
		expect(eventsPageCutoff(28_999n)).toBe(29_000n)
		expect(eventsPageCutoff(29_000n)).toBe(30_000n)
	})

	it("is the oldest event's own second once that second is read past", () => {
		expect(eventsPageCutoff(28_999n, true)).toBe(28_000n)
	})
})

describe("computeNextEventsPage", () => {
	it("returns only events not already in the slice, the overlapping second's included", () => {
		const sameSecond = ok(27n, 28_000n)
		const { fresh, terminate } = computeNextEventsPage(new Set(["28"]), [ok(28n), sameSecond, ok(26n)], 28_000n)

		expect(fresh).toEqual([sameSecond, ok(26n)])
		expect(terminate).toBe(false)
	})

	it("keeps undecodable events, deduped by their raw id", () => {
		const { fresh } = computeNextEventsPage(new Set(["5"]), [err({ id: 5, timestamp: 5 }), err({ id: 4, timestamp: 4 }), ok(3n)], 6000n)

		expect(keys(fresh)).toEqual(["4", "3"])
	})

	it("terminates on an empty page", () => {
		expect(computeNextEventsPage(new Set(), [], 5000n).terminate).toBe(true)
	})

	it("reads past the slice's oldest second when a page reached no earlier one, even with nothing new", () => {
		expect(computeNextEventsPage(new Set(["1", "2"]), [ok(2n, 1000n), ok(1n)], 1000n)).toEqual({
			fresh: [],
			terminate: false,
			pastSecond: true
		})
	})

	it("keeps paging past a bulk second: a page of that second alone adds its events and reads past it next", () => {
		const bulk = [ok(27n, 28_100n), ok(26n, 28_050n), ok(25n, 28_000n)]
		const step = computeNextEventsPage(new Set(["28"]), [ok(28n, 28_200n), ...bulk], 28_200n)

		expect(step).toEqual({ fresh: bulk, terminate: false, pastSecond: true })

		const past = computeNextEventsPage(new Set(["28", "27", "26", "25"]), [ok(24n, 20_000n)], 28_000n, true)

		expect(past).toEqual({ fresh: [ok(24n, 20_000n)], terminate: false, pastSecond: false })
	})

	it("terminates when a read past the oldest second still reaches no earlier one", () => {
		expect(computeNextEventsPage(new Set(["28"]), [ok(28n)], 28_000n, true).terminate).toBe(true)
	})

	it("terminates when an older page adds nothing: the cursor would not move", () => {
		expect(computeNextEventsPage(new Set(["1"]), [ok(1n)], 5000n).terminate).toBe(true)
	})
})

describe("mergeEventResults", () => {
	it("places an older page behind the slice, interleaving the shared second", () => {
		const slice = sortEventResults([ok(30n), ok(29n), ok(28n, 28_500n)])
		const page = [ok(27n, 28_900n), ok(26n, 28_100n), ok(20n)]

		expect(keys(mergeEventResults(slice, page))).toEqual(["30", "29", "27", "28", "26", "20"])
	})

	it("keeps a timestamp-less event where the server put it", () => {
		expect(keys(mergeEventResults([ok(5n), err("x"), ok(3n)], [ok(2n)]))).toEqual(["5", "raw:x", "3", "2"])
	})

	it("matches sorting the two together", () => {
		const slice = sortEventResults([ok(9n), ok(8n, 7000n), ok(7n), err({ id: 6, timestamp: 6 })])
		const page = [ok(5n, 7000n), ok(4n), err({ id: 3, timestamp: 3 })]

		expect(keys(mergeEventResults(slice, page))).toEqual(keys(sortEventResults([...slice, ...page])))
	})
})

describe("oldestEventTimestamp", () => {
	it("reads decoded and raw timestamps", () => {
		expect(oldestEventTimestamp([ok(5n), err({ id: 2, timestamp: 2 }), err("x")])).toBe(2000n)
		expect(oldestEventTimestamp([err("x")])).toBeUndefined()
	})
})

describe("mergeFirstEventsPage", () => {
	it("takes the page, sorted, when nothing is cached", () => {
		expect(keys(mergeFirstEventsPage(undefined, [ok(2n), ok(3n)]))).toEqual(["3", "2"])
	})

	it("keeps the older cached events behind an overlapping page, once each", () => {
		expect(keys(mergeFirstEventsPage([ok(3n), ok(2n), ok(1n)], [ok(4n), ok(3n)]))).toEqual(["4", "3", "2", "1"])
	})

	it("replaces the slice when the page shares no event with it (events between may be missing)", () => {
		expect(keys(mergeFirstEventsPage([ok(3n), ok(2n)], [ok(9n), ok(8n)]))).toEqual(["9", "8"])
	})

	it("keeps cached undecodable events and dedupes them against the page", () => {
		const merged = mergeFirstEventsPage(
			[err({ id: 3, timestamp: 3 }), ok(2n), err({ id: 1, timestamp: 1 })],
			[ok(4n), err({ id: 3, timestamp: 3 })]
		)

		expect(keys(merged)).toEqual(["4", "3", "2", "1"])
	})
})

describe("insertEventResult", () => {
	it("places the event by its time", () => {
		expect(keys(insertEventResult([ok(5n), ok(3n)], ok(4n)))).toEqual(["5", "4", "3"])
	})

	it("returns the slice itself when it already holds the event", () => {
		const slice = [ok(5n), ok(3n)]

		expect(insertEventResult(slice, ok(5n))).toBe(slice)
	})
})

describe("selectEventsView", () => {
	it("keeps undecodable events in place as unknown entries with their raw fields", () => {
		const view = selectEventsView([ok(2n), err({ id: 3, timestamp: 3, type: "fileArchived", info: { ip: "1.1.1.1" } }), ok(1n)])

		expect(view.entries.map(entry => entry.type)).toEqual(["unknown", "ok", "ok"])
		expect(view.entries[0]).toMatchObject({ type: "unknown", key: "3", timestamp: 3000n, raw: { type: "fileArchived", ip: "1.1.1.1" } })
		expect(view.oldest).toBe(1000n)
	})

	it("never mutates the raw cache array it derives from", () => {
		const data = [ok(1n), ok(7n)]

		selectEventsView(data)

		expect(keys(data)).toEqual(["1", "7"])
	})

	it("returns an empty view for an empty cache", () => {
		expect(selectEventsView([])).toEqual({ entries: [], oldest: undefined })
	})
})

const READY_STATE = { inflight: false, hasMore: true, queryReady: true, isOnline: true }

describe("shouldSkipEventsScroll", () => {
	it("does not skip when everything is ready and online", () => {
		expect(shouldSkipEventsScroll(READY_STATE)).toBe(false)
	})

	it("skips while offline — WITHOUT the caller needing to touch hasMore itself", () => {
		expect(shouldSkipEventsScroll({ ...READY_STATE, isOnline: false })).toBe(true)
	})

	it("skips while a fetch is already in flight", () => {
		expect(shouldSkipEventsScroll({ ...READY_STATE, inflight: true })).toBe(true)
	})

	it("skips once hasMore is false (every page already loaded)", () => {
		expect(shouldSkipEventsScroll({ ...READY_STATE, hasMore: false })).toBe(true)
	})

	it("skips while the events query hasn't succeeded yet", () => {
		expect(shouldSkipEventsScroll({ ...READY_STATE, queryReady: false })).toBe(true)
	})
})

describe("fetchEventsPageSafely", () => {
	it("passes a successful, non-terminating page straight through", async () => {
		const result = await fetchEventsPageSafely(() => Promise.resolve({ terminate: false }))

		expect(result).toEqual({ status: "ok", terminate: false })
	})

	it("passes a successful, terminating page straight through", async () => {
		const result = await fetchEventsPageSafely(() => Promise.resolve({ terminate: true }))

		expect(result).toEqual({ status: "ok", terminate: true })
	})

	it("catches a rejected fetch instead of letting it become an unhandled rejection, normalizing it to an ErrorDTO", async () => {
		const result = await fetchEventsPageSafely(() => Promise.reject(new Error("network down")))

		expect(result.status).toBe("error")
		expect(result.status === "error" && result.dto.message).toBe("network down")
	})
})

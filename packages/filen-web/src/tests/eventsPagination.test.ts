import { describe, expect, it } from "vitest"
import type { UserEventResult } from "@filen/sdk-rs"
import { computeNextEventsPage, shouldSkipEventsScroll, fetchEventsPageSafely } from "@/features/settings/lib/eventsPagination"

function ok(id: bigint): UserEventResult {
	return {
		type: "ok",
		id,
		timestamp: id,
		uuid: "11111111-1111-1111-1111-111111111111",
		kind: { type: "login", ip: "1.2.3.4", userAgent: "ua" }
	}
}

function err(): UserEventResult {
	return { type: "err", message: "bad", raw: "raw" }
}

describe("computeNextEventsPage", () => {
	it("returns only Ok items not already in the existing id set", () => {
		const { newOk, terminate } = computeNextEventsPage(new Set([1n]), [ok(1n), ok(2n), ok(3n)])

		expect(newOk.map(e => e.id)).toEqual([2n, 3n])
		expect(terminate).toBe(false)
	})

	it("discards Err entries entirely — no stable id to dedupe by", () => {
		const { newOk } = computeNextEventsPage(new Set(), [err(), ok(5n), err()])

		expect(newOk).toEqual([ok(5n)])
	})

	it("terminates on an empty page", () => {
		expect(computeNextEventsPage(new Set(), []).terminate).toBe(true)
	})

	it("terminates on an all-Err page (never loops forever on undecryptable-only pages)", () => {
		expect(computeNextEventsPage(new Set(), [err(), err()]).terminate).toBe(true)
	})

	it("terminates when every Ok id in the page was already seen (full dedup)", () => {
		expect(computeNextEventsPage(new Set([1n, 2n]), [ok(1n), ok(2n)]).terminate).toBe(true)
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

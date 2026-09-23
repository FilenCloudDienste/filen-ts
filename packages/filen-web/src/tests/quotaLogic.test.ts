import { describe, expect, it, vi } from "vitest"
import { freeBytes, quotaVerdict, resolveQuotaVerdict, sumBytes, type StorageCounters } from "@/features/drive/lib/quota.logic"

function counters(storageUsed: bigint, maxStorage: bigint): StorageCounters {
	return { storageUsed, maxStorage }
}

describe("freeBytes", () => {
	it("is maxStorage minus storageUsed", () => {
		expect(freeBytes(counters(30n, 100n))).toBe(70n)
	})

	it("floors at zero when storageUsed exceeds maxStorage (a plan downgrade)", () => {
		expect(freeBytes(counters(150n, 100n))).toBe(0n)
	})

	it("is null when the quota is unresolvable", () => {
		expect(freeBytes(counters(30n, 0n))).toBeNull()
		expect(freeBytes(counters(30n, -1n))).toBeNull()
	})
})

describe("quotaVerdict", () => {
	it("fits when the upload is smaller than the free space", () => {
		expect(quotaVerdict(50n, counters(30n, 100n))).toEqual({ status: "fits" })
	})

	it("fits when the upload exactly fills the free space", () => {
		expect(quotaVerdict(70n, counters(30n, 100n))).toEqual({ status: "fits" })
	})

	it("exceeds by a single byte, carrying the needed and free sizes", () => {
		expect(quotaVerdict(71n, counters(30n, 100n))).toEqual({ status: "exceeds", neededBytes: 71n, freeBytes: 70n })
	})

	it("is unknown for an unresolvable quota", () => {
		expect(quotaVerdict(1n << 50n, counters(30n, 0n))).toEqual({ status: "unknown" })
	})

	it("is unknown without account data", () => {
		expect(quotaVerdict(1n, undefined)).toEqual({ status: "unknown" })
	})
})

describe("sumBytes", () => {
	it("sums number and bigint sizes", () => {
		expect(sumBytes([1, 2n, 3])).toBe(6n)
		expect(sumBytes([])).toBe(0n)
	})
})

describe("resolveQuotaVerdict", () => {
	function harness(cached: StorageCounters | undefined, fresh: () => Promise<StorageCounters>) {
		const fetchFresh = vi.fn(fresh)

		return { deps: { cached: () => cached, fetchFresh }, fetchFresh }
	}

	it("trusts a cached fit without a read", async () => {
		const h = harness(counters(0n, 100n), () => Promise.reject(new Error("unexpected read")))

		expect(await resolveQuotaVerdict(h.deps, 100n)).toEqual({ status: "fits" })
		expect(h.fetchFresh).not.toHaveBeenCalled()
	})

	it("does not read for a cached unresolvable quota and never blocks on it", async () => {
		const h = harness(counters(0n, 0n), () => Promise.reject(new Error("unexpected read")))

		expect(await resolveQuotaVerdict(h.deps, 1n << 40n)).toEqual({ status: "unknown" })
		expect(h.fetchFresh).not.toHaveBeenCalled()
	})

	it("reads once when nothing is cached, deciding on the fresh value", async () => {
		const h = harness(undefined, () => Promise.resolve(counters(0n, 10n)))

		expect(await resolveQuotaVerdict(h.deps, 11n)).toEqual({ status: "exceeds", neededBytes: 11n, freeBytes: 10n })
		expect(h.fetchFresh).toHaveBeenCalledOnce()
	})

	it("re-reads a stale cached refusal and proceeds when the fresh value fits", async () => {
		const h = harness(counters(95n, 100n), () => Promise.resolve(counters(20n, 100n)))

		expect(await resolveQuotaVerdict(h.deps, 50n)).toEqual({ status: "fits" })
		expect(h.fetchFresh).toHaveBeenCalledOnce()
	})

	it("re-reads a cached refusal and blocks when the fresh value still does not fit", async () => {
		const h = harness(counters(95n, 100n), () => Promise.resolve(counters(90n, 100n)))

		expect(await resolveQuotaVerdict(h.deps, 50n)).toEqual({ status: "exceeds", neededBytes: 50n, freeBytes: 10n })
		expect(h.fetchFresh).toHaveBeenCalledOnce()
	})

	it("does not block when the fresh read fails", async () => {
		const h = harness(counters(95n, 100n), () => Promise.reject(new Error("offline")))

		expect(await resolveQuotaVerdict(h.deps, 50n)).toEqual({ status: "unknown" })
	})

	it("does not block when the fresh read returns an unresolvable quota", async () => {
		const h = harness(undefined, () => Promise.resolve(counters(0n, 0n)))

		expect(await resolveQuotaVerdict(h.deps, 50n)).toEqual({ status: "unknown" })
	})
})

import { describe, expect, it, vi } from "vitest"
import {
	deriveStorageBreakdown,
	freeBytes,
	quotaVerdict,
	resolveQuotaVerdict,
	storageUsageLevel,
	sumBytes,
	type StorageCounters
} from "@filen/shared"

describe("storageUsageLevel", () => {
	it("is ok below the 75% warn threshold", () => {
		expect(storageUsageLevel(0)).toBe("ok")
		expect(storageUsageLevel(74.9)).toBe("ok")
	})

	it("is warn from 75% up to (not including) the 90% critical threshold", () => {
		expect(storageUsageLevel(75)).toBe("warn")
		expect(storageUsageLevel(89.9)).toBe("warn")
	})

	it("is critical at 90% and above", () => {
		expect(storageUsageLevel(90)).toBe("critical")
		expect(storageUsageLevel(100)).toBe("critical")
	})
})

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

describe("deriveStorageBreakdown", () => {
	it("splits used storage into files + versioned, and the remainder into free", () => {
		expect(deriveStorageBreakdown(600n, 1000n, 200n)).toEqual({
			usedBytes: 600n,
			maxBytes: 1000n,
			filesBytes: 400n,
			versionedBytes: 200n,
			freeBytes: 400n
		})
	})

	it("the three segments always sum to maxStorage", () => {
		const breakdown = deriveStorageBreakdown(733n, 1000n, 111n)

		expect(breakdown.filesBytes + breakdown.versionedBytes + breakdown.freeBytes).toBe(breakdown.maxBytes)
	})

	it("clamps usedBytes to maxStorage when storageUsed exceeds it (plan downgrade)", () => {
		const breakdown = deriveStorageBreakdown(1500n, 1000n, 100n)

		expect(breakdown.usedBytes).toBe(1000n)
		expect(breakdown.freeBytes).toBe(0n)
		expect(breakdown.filesBytes + breakdown.versionedBytes).toBe(1000n)
	})

	it("clamps versionedStorage to the clamped used total rather than going negative", () => {
		const breakdown = deriveStorageBreakdown(500n, 1000n, 5000n)

		expect(breakdown.versionedBytes).toBe(500n)
		expect(breakdown.filesBytes).toBe(0n)
	})

	it("clamps negative inputs to zero", () => {
		expect(deriveStorageBreakdown(-5n, 1000n, -1n)).toEqual({
			usedBytes: 0n,
			maxBytes: 1000n,
			filesBytes: 0n,
			versionedBytes: 0n,
			freeBytes: 1000n
		})
	})

	it("maxStorage <= 0 (unresolved quota) zeros every derived field but the raw used/max pair", () => {
		expect(deriveStorageBreakdown(123n, 0n, 10n)).toEqual({
			usedBytes: 123n,
			maxBytes: 0n,
			filesBytes: 0n,
			versionedBytes: 0n,
			freeBytes: 0n
		})
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
	function harness(cached: StorageCounters | undefined, fresh: () => Promise<StorageCounters>, isCachedFresh?: () => boolean) {
		const fetchFresh = vi.fn(fresh)

		return { deps: { cached: () => cached, fetchFresh, ...(isCachedFresh === undefined ? {} : { isCachedFresh }) }, fetchFresh }
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

	describe("with a freshness check", () => {
		const fresh = () => true
		const stale = () => false

		it("answers from a fresh cache without a read", async () => {
			const fits = harness(counters(0n, 100n), () => Promise.reject(new Error("unexpected read")), fresh)
			const unknown = harness(counters(0n, 0n), () => Promise.reject(new Error("unexpected read")), fresh)

			expect(await resolveQuotaVerdict(fits.deps, 100n)).toEqual({ status: "fits" })
			expect(await resolveQuotaVerdict(unknown.deps, 100n)).toEqual({ status: "unknown" })
			expect(fits.fetchFresh).not.toHaveBeenCalled()
			expect(unknown.fetchFresh).not.toHaveBeenCalled()
		})

		it("still re-reads a fresh cached refusal", async () => {
			const h = harness(counters(95n, 100n), () => Promise.resolve(counters(0n, 100n)), fresh)

			expect(await resolveQuotaVerdict(h.deps, 50n)).toEqual({ status: "fits" })
			expect(h.fetchFresh).toHaveBeenCalledOnce()
		})

		it("reads once past a stale cached fit, deciding on the fresh value", async () => {
			const h = harness(counters(0n, 100n), () => Promise.resolve(counters(90n, 100n)), stale)

			expect(await resolveQuotaVerdict(h.deps, 50n)).toEqual({ status: "exceeds", neededBytes: 50n, freeBytes: 10n })
			expect(h.fetchFresh).toHaveBeenCalledOnce()
		})

		it("reads once past a stale cached unresolvable quota", async () => {
			const h = harness(counters(0n, 0n), () => Promise.resolve(counters(0n, 100n)), stale)

			expect(await resolveQuotaVerdict(h.deps, 50n)).toEqual({ status: "fits" })
			expect(h.fetchFresh).toHaveBeenCalledOnce()
		})

		it("does not block when the read past a stale cache fails", async () => {
			const h = harness(counters(0n, 100n), () => Promise.reject(new Error("offline")), stale)

			expect(await resolveQuotaVerdict(h.deps, 50n)).toEqual({ status: "unknown" })
		})
	})
})

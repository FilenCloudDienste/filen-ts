import { describe, expect, it } from "vitest"
import { deriveStorageBreakdown, storagePercent } from "@/features/settings/lib/storageBreakdown"

describe("deriveStorageBreakdown", () => {
	it("splits used storage into files + versioned, and the remainder into free", () => {
		const breakdown = deriveStorageBreakdown(600n, 1000n, 200n)

		expect(breakdown).toEqual({
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

	it("zero usage and zero versioned storage: all free", () => {
		const breakdown = deriveStorageBreakdown(0n, 1000n, 0n)

		expect(breakdown).toEqual({ usedBytes: 0n, maxBytes: 1000n, filesBytes: 0n, versionedBytes: 0n, freeBytes: 1000n })
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

describe("storagePercent", () => {
	it("computes a plain percentage", () => {
		expect(storagePercent(250n, 1000n)).toBe(25)
	})

	it("clamps to 100 when part exceeds total", () => {
		expect(storagePercent(1500n, 1000n)).toBe(100)
	})

	it("returns 0 for a zero or negative total", () => {
		expect(storagePercent(10n, 0n)).toBe(0)
	})
})

import { describe, it, expect } from "vitest"
import { computeStorageSegments } from "@/features/settings/storageSegments"

describe("computeStorageSegments", () => {
	it("splits used into files + versioned, computes free", () => {
		const r = computeStorageSegments(30_000_000_000n, 400_000_000n, 45_500_000_000_000n)

		expect(r.files).toBe(30_000_000_000 - 400_000_000)
		expect(r.versioned).toBe(400_000_000)
		expect(r.free).toBe(45_500_000_000_000 - 30_000_000_000)
	})

	it("guards maxStorage = 0 — no div-by-zero, free 0, files 0", () => {
		const r = computeStorageSegments(0n, 0n, 0n)

		expect(r.free).toBe(0)
		expect(r.files).toBe(0)
	})

	it("clamps a versioned value that exceeds used (no negative Files)", () => {
		const r = computeStorageSegments(100n, 500n, 1000n)

		expect(r.versioned).toBe(100)
		expect(r.files).toBe(0)
	})

	it("clamps free to 0 on overage (used > max)", () => {
		const r = computeStorageSegments(1200n, 0n, 1000n)

		expect(r.free).toBe(0)
	})
})

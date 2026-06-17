import { describe, it, expect } from "vitest"
import { computeStorageSegments } from "@/features/settings/storageSegments"

describe("computeStorageSegments", () => {
	it("splits used into files + versioned, computes free, and is 'ok' at low usage", () => {
		const r = computeStorageSegments(30_000_000_000n, 400_000_000n, 45_500_000_000_000n)

		expect(r.files).toBe(30_000_000_000 - 400_000_000)
		expect(r.versioned).toBe(400_000_000)
		expect(r.free).toBe(45_500_000_000_000 - 30_000_000_000)
		expect(r.level).toBe("ok")
	})

	it("guards maxStorage = 0 — no div-by-zero, free 0, fraction 0", () => {
		const r = computeStorageSegments(0n, 0n, 0n)

		expect(r.usedFraction).toBe(0)
		expect(r.free).toBe(0)
		expect(r.files).toBe(0)
		expect(r.level).toBe("ok")
	})

	it("clamps a versioned value that exceeds used (no negative Files)", () => {
		const r = computeStorageSegments(100n, 500n, 1000n)

		expect(r.versioned).toBe(100)
		expect(r.files).toBe(0)
	})

	it("crosses to 'warn' at 75% and 'critical' at 90%", () => {
		expect(computeStorageSegments(500n, 0n, 1000n).level).toBe("ok")
		expect(computeStorageSegments(800n, 0n, 1000n).level).toBe("warn")
		expect(computeStorageSegments(950n, 0n, 1000n).level).toBe("critical")
	})

	it("clamps free to 0 and fraction to 1 on overage (used > max)", () => {
		const r = computeStorageSegments(1200n, 0n, 1000n)

		expect(r.free).toBe(0)
		expect(r.usedFraction).toBe(1)
		expect(r.level).toBe("critical")
	})
})

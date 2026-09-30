import { describe, expect, it } from "vitest"
import { storagePercent } from "@/features/settings/lib/storageBreakdown"

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

import { describe, expect, it } from "vitest"
import { storageUsageLevel } from "@filen/shared"

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

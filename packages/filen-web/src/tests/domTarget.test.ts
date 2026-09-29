import { describe, expect, it } from "vitest"
import { hasClosest } from "@/lib/domTarget"

describe("hasClosest", () => {
	it("is false for a null target", () => {
		expect(hasClosest(null)).toBe(false)
	})

	it("is false for a target with no closest method", () => {
		expect(hasClosest({} as unknown as EventTarget)).toBe(false)
	})

	it("is true for a target shaped like a real Element", () => {
		expect(hasClosest({ closest: (_selector: string) => null } as unknown as EventTarget)).toBe(true)
	})
})

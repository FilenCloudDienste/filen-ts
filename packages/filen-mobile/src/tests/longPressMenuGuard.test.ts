import { describe, it, expect } from "vitest"
import { shouldFireGuardedPress, LONG_PRESS_GUARD_MS } from "@/components/ui/longPressMenuGuard"

describe("shouldFireGuardedPress", () => {
	it("fires for a short press (held below the long-press threshold)", () => {
		expect(shouldFireGuardedPress(1000, 1000 + LONG_PRESS_GUARD_MS - 1)).toBe(true)
	})

	it("fires for an instantaneous tap", () => {
		expect(shouldFireGuardedPress(1000, 1000)).toBe(true)
	})

	it("suppresses a press held to the threshold (a long-press that engaged the menu)", () => {
		expect(shouldFireGuardedPress(1000, 1000 + LONG_PRESS_GUARD_MS)).toBe(false)
	})

	it("suppresses a press held well past the threshold", () => {
		expect(shouldFireGuardedPress(1000, 1000 + LONG_PRESS_GUARD_MS + 500)).toBe(false)
	})

	it("honors a custom threshold", () => {
		expect(shouldFireGuardedPress(0, 249, 250)).toBe(true)
		expect(shouldFireGuardedPress(0, 250, 250)).toBe(false)
	})
})

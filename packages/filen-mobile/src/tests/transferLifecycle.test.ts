import { describe, it, expect } from "vitest"
import { shouldCancelForegroundOnBackground } from "@/features/transfers/components/transferLifecycle.utils"

describe("shouldCancelForegroundOnBackground", () => {
	it("cancels on background on iOS", () => {
		expect(shouldCancelForegroundOnBackground("background", "ios", false)).toBe(true)
	})

	it("cancels on background on Android with no foreground service", () => {
		expect(shouldCancelForegroundOnBackground("background", "android", false)).toBe(true)
	})

	it("does NOT cancel on background on Android with a running foreground service", () => {
		expect(shouldCancelForegroundOnBackground("background", "android", true)).toBe(false)
	})

	it("does NOT cancel on the transient 'inactive' state", () => {
		expect(shouldCancelForegroundOnBackground("inactive", "ios", false)).toBe(false)
		expect(shouldCancelForegroundOnBackground("inactive", "android", false)).toBe(false)
	})

	it("does NOT cancel when active", () => {
		expect(shouldCancelForegroundOnBackground("active", "ios", false)).toBe(false)
		expect(shouldCancelForegroundOnBackground("active", "android", true)).toBe(false)
	})
})

import { describe, it, expect } from "vitest"
import { shouldCancelAfterPresentation, shouldCancelForegroundOnBackground } from "@/features/transfers/components/transferLifecycle.utils"

describe("shouldCancelForegroundOnBackground", () => {
	it("cancels on background on iOS", () => {
		expect(shouldCancelForegroundOnBackground("background", "ios", false, false)).toBe(true)
	})

	it("cancels on background on iOS even while a presentation is up: iOS reports those as inactive, so this background is real", () => {
		expect(shouldCancelForegroundOnBackground("background", "ios", false, true)).toBe(true)
	})

	it("cancels on background on Android with no foreground service", () => {
		expect(shouldCancelForegroundOnBackground("background", "android", false, false)).toBe(true)
	})

	it("does NOT cancel on background on Android with a running foreground service", () => {
		expect(shouldCancelForegroundOnBackground("background", "android", true, false)).toBe(false)
	})

	it("does NOT cancel on the background Android reports for an in-app system presentation", () => {
		expect(shouldCancelForegroundOnBackground("background", "android", false, true)).toBe(false)
	})

	it("does NOT cancel on the transient 'inactive' state", () => {
		expect(shouldCancelForegroundOnBackground("inactive", "ios", false, false)).toBe(false)
		expect(shouldCancelForegroundOnBackground("inactive", "android", false, false)).toBe(false)
	})

	it("does NOT cancel when active", () => {
		expect(shouldCancelForegroundOnBackground("active", "ios", false, false)).toBe(false)
		expect(shouldCancelForegroundOnBackground("active", "android", true, false)).toBe(false)
	})
})

describe("shouldCancelAfterPresentation", () => {
	it("cancels only when a background was ignored for the presentation and the app is still in the background", () => {
		expect(shouldCancelAfterPresentation(true, "background", "android", false)).toBe(true)
		expect(shouldCancelAfterPresentation(false, "background", "android", false)).toBe(false)
		expect(shouldCancelAfterPresentation(true, "active", "android", false)).toBe(false)
	})

	it("a foreground service that came up meanwhile still protects the transfers", () => {
		expect(shouldCancelAfterPresentation(true, "background", "android", true)).toBe(false)
	})
})

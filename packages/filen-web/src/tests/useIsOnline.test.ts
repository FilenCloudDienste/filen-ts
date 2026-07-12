// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { onlineManager } from "@tanstack/react-query"
import { useIsOnline } from "@/lib/useIsOnline"

beforeEach(() => {
	// Reset to a known online state before each test — onlineManager is a module-level singleton
	// shared across the whole suite.
	onlineManager.setOnline(true)
})

describe("useIsOnline", () => {
	it("returns true when onlineManager.isOnline() returns true", () => {
		onlineManager.setOnline(true)

		const { result } = renderHook(() => useIsOnline())

		expect(result.current).toBe(true)
	})

	it("returns false when onlineManager.isOnline() returns false", () => {
		onlineManager.setOnline(false)

		const { result } = renderHook(() => useIsOnline())

		expect(result.current).toBe(false)
	})

	it("reactively updates when onlineManager transitions from online to offline", () => {
		onlineManager.setOnline(true)

		const { result } = renderHook(() => useIsOnline())

		expect(result.current).toBe(true)

		act(() => {
			onlineManager.setOnline(false)
		})

		expect(result.current).toBe(false)
	})

	it("reactively updates when onlineManager transitions from offline to online", () => {
		onlineManager.setOnline(false)

		const { result } = renderHook(() => useIsOnline())

		expect(result.current).toBe(false)

		act(() => {
			onlineManager.setOnline(true)
		})

		expect(result.current).toBe(true)
	})

	it("seeds onlineManager from navigator.onLine on module load, even when the tab starts offline", async () => {
		// The module under test seeds onlineManager exactly once, as an import-time side effect —
		// re-triggering that seed requires a fresh module instance (mirrors heicCodec.test.ts's own
		// vi.resetModules() + dynamic re-import pattern). Both "@tanstack/react-query" and
		// "@/lib/useIsOnline" must be re-imported from the SAME post-reset registry so the freshly
		// seeded onlineManager singleton this test reads back is the exact instance the hook module
		// seeded, not the suite's original static-import instance.
		const onLineDescriptor = Object.getOwnPropertyDescriptor(navigator, "onLine")
		Object.defineProperty(navigator, "onLine", { value: false, configurable: true })

		vi.resetModules()
		const [{ onlineManager: freshOnlineManager }] = await Promise.all([import("@tanstack/react-query")])
		await import("@/lib/useIsOnline")

		expect(freshOnlineManager.isOnline()).toBe(false)

		if (onLineDescriptor) {
			Object.defineProperty(navigator, "onLine", onLineDescriptor)
		}
		vi.resetModules()
	})

	it("unsubscribes from onlineManager on unmount", () => {
		// Spy on onlineManager.subscribe to capture the unsubscribe fn useSyncExternalStore stores as
		// its cleanup, then assert it runs on unmount — reading result.current after unmount can't
		// detect a leaked subscription, the value is frozen at the last render either way.
		const unsubscribe = vi.fn()
		const subscribeSpy = vi.spyOn(onlineManager, "subscribe").mockReturnValue(unsubscribe)

		const { unmount } = renderHook(() => useIsOnline())

		expect(subscribeSpy).toHaveBeenCalled()
		expect(unsubscribe).not.toHaveBeenCalled()

		unmount()

		expect(unsubscribe).toHaveBeenCalledTimes(1)

		subscribeSpy.mockRestore()
	})
})

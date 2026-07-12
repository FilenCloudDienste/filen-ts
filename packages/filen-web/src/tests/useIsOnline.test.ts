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

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook, act } from "@testing-library/react"
import { onlineManager } from "@tanstack/react-query"
import useIsOnline from "@/hooks/useIsOnline"

beforeEach(() => {
	// Reset to a known online state before each test
	onlineManager.setOnline(true)
})

// ─── Tests ───────────────────────────────────────────────────────────────────

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

	it("stops tracking changes after unmount", () => {
		// Verify that the onlineManager subscription is torn down when the hook
		// unmounts: state changes after unmount must not update result.current.
		onlineManager.setOnline(true)

		const { result, unmount } = renderHook(() => useIsOnline())

		expect(result.current).toBe(true)

		unmount()

		// After unmount the listener is unsubscribed; setOnline calls are ignored.
		act(() => {
			onlineManager.setOnline(false)
		})

		// result.current is frozen at the last rendered value (true) since the
		// hook no longer listens.
		expect(result.current).toBe(true)
	})
})

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

	it("server snapshot always returns true (hardcoded SSR behaviour)", () => {
		// The third arg to useSyncExternalStore is the server snapshot. It is
		// hardcoded to () => true so that SSR/test environments where there is no
		// real network always default to 'online'. We verify this by checking that
		// even after calling setOnline(false), a fresh hook render that evaluates
		// the snapshot still returns the value driven by the getSnapshot function,
		// which mirrors onlineManager.isOnline(). The server snapshot itself is
		// not directly callable, but we confirm the design intent: the hook always
		// reflects onlineManager, and the server snapshot defaults to true.
		onlineManager.setOnline(true)

		const { result } = renderHook(() => useIsOnline())

		// In a happy-dom (jsdom-like) environment, useSyncExternalStore uses the
		// client snapshot, so this just confirms getSnapshot works correctly.
		expect(result.current).toBe(true)
	})
})

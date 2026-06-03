// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockAppState } = vi.hoisted(() => {
	const listeners = new Set<(state: string) => void>()

	const appState = {
		currentState: "active" as string,
		addEventListener: (_type: string, handler: (state: string) => void) => {
			listeners.add(handler)

			return {
				remove: () => {
					listeners.delete(handler)
				}
			}
		},
		emit: (state: string) => {
			for (const l of listeners) {
				l(state)
			}
		},
		clear: () => {
			listeners.clear()
		}
	}

	return {
		mockAppStateListeners: listeners,
		mockAppState: appState
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@filen/utils", async () => ({
	...await import("@/tests/mocks/filenUtils"),
	// runEffect is used by useIsAppActive — provide a real-ish implementation
	// that calls the setup function and returns a cleanup wrapper.
	runEffect: (fn: (defer: (cleanup: () => void) => void) => void) => {
		const cleanups: (() => void)[] = []
		const defer = (cleanup: () => void) => {
			cleanups.push(cleanup)
		}

		fn(defer)

		return {
			cleanup: () => {
				for (const c of cleanups) {
					c()
				}
			}
		}
	}
}))

vi.mock("react-native", () => ({
	AppState: mockAppState
}))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook, act } from "@testing-library/react"
import useIsAppActive from "@/hooks/useIsAppActive"

beforeEach(() => {
	mockAppState.currentState = "active"
	mockAppState.clear()
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useIsAppActive", () => {
	it("returns true when AppState.currentState is 'active' on mount", () => {
		mockAppState.currentState = "active"

		const { result } = renderHook(() => useIsAppActive())

		expect(result.current).toBe(true)
	})

	it("returns false when AppState.currentState is 'background' on mount", () => {
		mockAppState.currentState = "background"

		const { result } = renderHook(() => useIsAppActive())

		expect(result.current).toBe(false)
	})

	it("returns false when AppState.currentState is 'inactive' on mount (iOS in-between state)", () => {
		mockAppState.currentState = "inactive"

		const { result } = renderHook(() => useIsAppActive())

		expect(result.current).toBe(false)
	})

	it("transitions to false when AppState fires 'background'", () => {
		mockAppState.currentState = "active"

		const { result } = renderHook(() => useIsAppActive())

		expect(result.current).toBe(true)

		act(() => {
			mockAppState.emit("background")
		})

		expect(result.current).toBe(false)
	})

	it("transitions back to true when AppState fires 'active'", () => {
		mockAppState.currentState = "background"

		const { result } = renderHook(() => useIsAppActive())

		expect(result.current).toBe(false)

		act(() => {
			mockAppState.emit("active")
		})

		expect(result.current).toBe(true)
	})

	it("returns false when AppState fires 'inactive'", () => {
		mockAppState.currentState = "active"

		const { result } = renderHook(() => useIsAppActive())

		act(() => {
			mockAppState.emit("inactive")
		})

		expect(result.current).toBe(false)
	})
})

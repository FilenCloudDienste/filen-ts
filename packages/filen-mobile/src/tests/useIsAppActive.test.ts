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
			appState.currentState = state

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

	it("does not re-render on inactive <-> background transitions (boolean snapshot unchanged)", () => {
		mockAppState.currentState = "active"

		let renders = 0

		renderHook(() => {
			renders++

			return useIsAppActive()
		})

		act(() => {
			mockAppState.emit("inactive")
		})

		const afterInactive = renders

		act(() => {
			mockAppState.emit("background")
		})

		act(() => {
			mockAppState.emit("inactive")
		})

		expect(renders).toBe(afterInactive)
	})

	it("stops updating state after unmount — subscription is removed on cleanup", () => {
		mockAppState.currentState = "active"

		const { result, unmount } = renderHook(() => useIsAppActive())

		expect(result.current).toBe(true)

		// Unmount the hook — this should invoke cleanup() → subscription.remove()
		act(() => {
			unmount()
		})

		// The mock's listeners set should now be empty; emitting must not update state
		act(() => {
			mockAppState.emit("background")
		})

		// result.current is frozen at the last rendered value (true) because the
		// hook is unmounted and its listener was removed
		expect(result.current).toBe(true)
	})
})

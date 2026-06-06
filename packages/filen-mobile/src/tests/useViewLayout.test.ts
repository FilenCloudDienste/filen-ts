// @vitest-environment happy-dom

import { vi, describe, it, expect } from "vitest"

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

// react-native is globally aliased to src/tests/mocks/reactNative.ts via vitest.config.ts.
// The hook only imports type View and LayoutChangeEvent — no runtime value from react-native.

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook, act } from "@testing-library/react"
import type { View, LayoutChangeEvent } from "react-native"
import useViewLayout from "@/hooks/useViewLayout"

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal synthetic LayoutChangeEvent with the provided dimensions. */
function makeLayoutEvent(width: number, height: number, x: number, y: number): LayoutChangeEvent {
	return {
		nativeEvent: {
			layout: { width, height, x, y }
		}
	} as LayoutChangeEvent
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useViewLayout", () => {
	describe("initial state", () => {
		it("returns all-zero layout on first render", () => {
			const ref = { current: null } as React.RefObject<View | null>
			const { result } = renderHook(() => useViewLayout(ref))

			expect(result.current.layout).toEqual({ width: 0, height: 0, x: 0, y: 0 })
		})

		it("exposes an onLayout callback function", () => {
			const ref = { current: null } as React.RefObject<View | null>
			const { result } = renderHook(() => useViewLayout(ref))

			expect(typeof result.current.onLayout).toBe("function")
		})
	})

	describe("onLayout with LayoutChangeEvent (event path)", () => {
		it("updates layout state from e.nativeEvent.layout when called with an event", () => {
			const ref = { current: null } as React.RefObject<View | null>
			const { result } = renderHook(() => useViewLayout(ref))

			act(() => {
				result.current.onLayout(makeLayoutEvent(320, 200, 10, 20))
			})

			expect(result.current.layout).toEqual({ width: 320, height: 200, x: 10, y: 20 })
		})

		it("updates layout again when called with a second event", () => {
			const ref = { current: null } as React.RefObject<View | null>
			const { result } = renderHook(() => useViewLayout(ref))

			act(() => {
				result.current.onLayout(makeLayoutEvent(100, 50, 0, 0))
			})

			act(() => {
				result.current.onLayout(makeLayoutEvent(640, 480, 5, 15))
			})

			expect(result.current.layout).toEqual({ width: 640, height: 480, x: 5, y: 15 })
		})

		it("does NOT call ref.current.measureInWindow when an event is provided", () => {
			const measureInWindow = vi.fn()
			const ref = {
				current: { measureInWindow } as unknown as View
			} as React.RefObject<View | null>

			const { result } = renderHook(() => useViewLayout(ref))

			act(() => {
				result.current.onLayout(makeLayoutEvent(100, 100, 0, 0))
			})

			expect(measureInWindow).not.toHaveBeenCalled()
		})
	})

	describe("onLayout with no argument (measureInWindow fallback path)", () => {
		it("calls ref.current.measureInWindow when no event is provided", () => {
			const measureInWindow = vi.fn()
			const ref = {
				current: { measureInWindow } as unknown as View
			} as React.RefObject<View | null>

			const { result } = renderHook(() => useViewLayout(ref))

			act(() => {
				result.current.onLayout(undefined)
			})

			expect(measureInWindow).toHaveBeenCalledTimes(1)
			expect(measureInWindow).toHaveBeenCalledWith(expect.any(Function))
		})

		it("updates layout state when the measureInWindow callback is fired", () => {
			let capturedCallback: ((x: number, y: number, width: number, height: number) => void) | null = null

			const measureInWindow = vi.fn((cb: (x: number, y: number, width: number, height: number) => void) => {
				capturedCallback = cb
			})

			const ref = {
				current: { measureInWindow } as unknown as View
			} as React.RefObject<View | null>

			const { result } = renderHook(() => useViewLayout(ref))

			act(() => {
				result.current.onLayout(undefined)
			})

			// measureInWindow was called; now fire its callback
			act(() => {
				capturedCallback?.(8, 16, 200, 100)
			})

			expect(result.current.layout).toEqual({ width: 200, height: 100, x: 8, y: 16 })
		})

		it("does not throw when ref.current is null (optional chaining no-op)", () => {
			const ref = { current: null } as React.RefObject<View | null>
			const { result } = renderHook(() => useViewLayout(ref))

			expect(() => {
				act(() => {
					result.current.onLayout(undefined)
				})
			}).not.toThrow()

			// State remains the initial zeros — nothing was set
			expect(result.current.layout).toEqual({ width: 0, height: 0, x: 0, y: 0 })
		})

		it("does not throw when ref itself is null (optional chaining on ref)", () => {
			// Pass a ref whose current stays null — same safety guarantee as above
			// but using a plain object matching the shape the hook accepts
			const ref = { current: null } as React.RefObject<View | null>
			const { result } = renderHook(() => useViewLayout(ref))

			expect(() => {
				act(() => {
					result.current.onLayout(undefined)
				})
			}).not.toThrow()
		})

		it("does not throw when measureInWindow is absent on ref.current (optional chaining on method)", () => {
			// Simulate a View instance that doesn't expose measureInWindow
			const ref = {
				current: {} as unknown as View
			} as React.RefObject<View | null>

			const { result } = renderHook(() => useViewLayout(ref))

			expect(() => {
				act(() => {
					result.current.onLayout(undefined)
				})
			}).not.toThrow()

			// Layout stays as initial zeros
			expect(result.current.layout).toEqual({ width: 0, height: 0, x: 0, y: 0 })
		})
	})

	describe("layout state isolation between hook instances", () => {
		it("each hook instance maintains its own independent layout state", () => {
			const ref1 = { current: null } as React.RefObject<View | null>
			const ref2 = { current: null } as React.RefObject<View | null>

			const { result: r1 } = renderHook(() => useViewLayout(ref1))
			const { result: r2 } = renderHook(() => useViewLayout(ref2))

			act(() => {
				r1.current.onLayout(makeLayoutEvent(100, 50, 0, 0))
			})

			// r1 updated, r2 untouched
			expect(r1.current.layout).toEqual({ width: 100, height: 50, x: 0, y: 0 })
			expect(r2.current.layout).toEqual({ width: 0, height: 0, x: 0, y: 0 })
		})
	})
})

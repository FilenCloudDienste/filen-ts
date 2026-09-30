// @vitest-environment happy-dom

import { describe, it, expect } from "vitest"

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook, act } from "@testing-library/react"
import type { LayoutChangeEvent } from "react-native"
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
		it("returns a zero layout on first render", () => {
			const { result } = renderHook(() => useViewLayout())

			expect(result.current.layout).toEqual({ width: 0, height: 0 })
		})

		it("exposes an onLayout callback function", () => {
			const { result } = renderHook(() => useViewLayout())

			expect(typeof result.current.onLayout).toBe("function")
		})
	})

	describe("onLayout", () => {
		it("updates layout state from e.nativeEvent.layout", () => {
			const { result } = renderHook(() => useViewLayout())

			act(() => {
				result.current.onLayout(makeLayoutEvent(320, 200, 10, 20))
			})

			expect(result.current.layout).toEqual({ width: 320, height: 200 })
		})

		it("updates layout again when called with a second event", () => {
			const { result } = renderHook(() => useViewLayout())

			act(() => {
				result.current.onLayout(makeLayoutEvent(100, 50, 0, 0))
			})

			act(() => {
				result.current.onLayout(makeLayoutEvent(640, 480, 5, 15))
			})

			expect(result.current.layout).toEqual({ width: 640, height: 480 })
		})

		it("keeps the same layout object when only the position changes", () => {
			const { result } = renderHook(() => useViewLayout())

			act(() => {
				result.current.onLayout(makeLayoutEvent(100, 50, 0, 0))
			})

			const before = result.current.layout

			act(() => {
				result.current.onLayout(makeLayoutEvent(100, 50, 30, 40))
			})

			expect(result.current.layout).toBe(before)
		})
	})

	describe("layout state isolation between hook instances", () => {
		it("each hook instance maintains its own independent layout state", () => {
			const { result: r1 } = renderHook(() => useViewLayout())
			const { result: r2 } = renderHook(() => useViewLayout())

			act(() => {
				r1.current.onLayout(makeLayoutEvent(100, 50, 0, 0))
			})

			expect(r1.current.layout).toEqual({ width: 100, height: 50 })
			expect(r2.current.layout).toEqual({ width: 0, height: 0 })
		})
	})
})

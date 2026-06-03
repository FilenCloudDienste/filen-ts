// @vitest-environment happy-dom

import { vi, describe, it, expect } from "vitest"

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

// react-native is globally aliased in vitest.config.ts but we need to control Platform.OS per test.
// We import the mock object so we can mutate Platform.OS directly.
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

const mockInsets = { top: 0, right: 0, bottom: 0, left: 0 }

vi.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => mockInsets
}))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook } from "@testing-library/react"
import { Platform } from "@/tests/mocks/reactNative"
import { useFloatingBarOffset } from "@/hooks/useFloatingBarOffset"

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useFloatingBarOffset", () => {
	describe("iOS (Platform.OS = 'ios')", () => {
		it("returns insets.bottom + 49 + 8 on iOS", () => {
			Platform.OS = "ios"
			mockInsets.bottom = 10

			const { result } = renderHook(() => useFloatingBarOffset())

			// 10 + 49 + 8 = 67
			expect(result.current).toBe(67)
		})

		it("returns exactly 57 when insets.bottom=0 on iOS", () => {
			Platform.OS = "ios"
			mockInsets.bottom = 0

			const { result } = renderHook(() => useFloatingBarOffset())

			// 0 + 49 + 8 = 57
			expect(result.current).toBe(57)
		})

		it("returns 91 when insets.bottom=34 on iOS (typical home-indicator device)", () => {
			Platform.OS = "ios"
			mockInsets.bottom = 34

			const { result } = renderHook(() => useFloatingBarOffset())

			// 34 + 49 + 8 = 91
			expect(result.current).toBe(91)
		})
	})

	describe("Android (Platform.OS = 'android')", () => {
		it("returns insets.bottom + 80 + 8 on Android", () => {
			Platform.OS = "android"
			mockInsets.bottom = 10

			const { result } = renderHook(() => useFloatingBarOffset())

			// 10 + 80 + 8 = 98
			expect(result.current).toBe(98)
		})

		it("returns exactly 88 when insets.bottom=0 on Android", () => {
			Platform.OS = "android"
			mockInsets.bottom = 0

			const { result } = renderHook(() => useFloatingBarOffset())

			// 0 + 80 + 8 = 88
			expect(result.current).toBe(88)
		})
	})
})

import { vi, describe, it, expect } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// ─── Module boundary mocks (must precede all imports) ─────────────────────────

// react-native is globally aliased to our minimal mock, but virtualList.tsx
// re-imports specific named exports; stub those too.
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

// Flash-list: ships a native module that can't load in node; return a stub.
vi.mock("@shopify/flash-list", () => ({
	FlashList: () => null
}))

// Unwrapped deps of virtualList.tsx that reference native binaries in node env
vi.mock("react-native-reanimated", () => ({
	FadeOut: {}
}))

vi.mock("@/components/ui/view", () => ({ default: () => null }))

vi.mock("@/components/ui/animated", () => ({ AnimatedView: () => null }))

vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))

vi.mock("uniwind", () => ({
	withUniwind: (component: unknown) => component,
	useResolveClassNames: () => ({ color: "#fff" })
}))

vi.mock("@/hooks/useViewLayout", () => ({
	default: vi.fn(() => ({ layout: { width: 375, height: 812 }, onLayout: vi.fn() }))
}))

// ─── Actual imports ──────────────────────────────────────────────────────────

import { resolveItemsPerRow, resolveScrollEnabled, validateVirtualListProps } from "@/components/ui/virtualList"

// ─── resolveItemsPerRow ───────────────────────────────────────────────────────

describe("resolveItemsPerRow", () => {
	describe("explicit itemsPerRow prop", () => {
		it("returns the explicit value when itemsPerRow is provided", () => {
			const result = resolveItemsPerRow({
				itemsPerRow: 4,
				itemWidth: 100,
				layoutWidth: 320
			})

			expect(result).toBe(4)
		})

		it("returns the explicit value when itemWidth is absent", () => {
			const result = resolveItemsPerRow({
				itemsPerRow: 2,
				layoutWidth: 320
			})

			expect(result).toBe(2)
		})
	})

	describe("single column (itemWidth absent)", () => {
		it("returns 1 when itemWidth is not provided", () => {
			const result = resolveItemsPerRow({ layoutWidth: 320 })

			expect(result).toBe(1)
		})

		it("returns 1 when itemWidth is 0 (before first layout)", () => {
			const result = resolveItemsPerRow({ itemWidth: 0, layoutWidth: 320 })

			expect(result).toBe(1)
		})
	})

	describe("auto column calculation from itemWidth", () => {
		it("computes 3 columns for layoutWidth=320 and itemWidth=100", () => {
			// 320 / 100 = 3.2 → round → 3 → max(1, 3) = 3 → round → 3
			const result = resolveItemsPerRow({
				itemWidth: 100,
				layoutWidth: 320
			})

			expect(result).toBe(3)
		})

		it("computes 4 columns for layoutWidth=375 and itemWidth=100", () => {
			// 375 / 100 = 3.75 → round → 4 → max(1, 4) = 4 → round → 4
			const result = resolveItemsPerRow({
				itemWidth: 100,
				layoutWidth: 375
			})

			expect(result).toBe(4)
		})

		it("computes 5 columns for layoutWidth=500 and itemWidth=100", () => {
			const result = resolveItemsPerRow({
				itemWidth: 100,
				layoutWidth: 500
			})

			expect(result).toBe(5)
		})

		it("clamps to 1 when layoutWidth=0 (avoids division-by-zero producing 0)", () => {
			// 0 / 100 = 0 → round → 0 → max(1, 0) = 1 → round → 1
			const result = resolveItemsPerRow({
				itemWidth: 100,
				layoutWidth: 0
			})

			expect(result).toBe(1)
		})

		it("clamps to 1 when layoutWidth is very small (produces sub-1 column count)", () => {
			// 10 / 100 = 0.1 → round → 0 → max(1, 0) = 1
			const result = resolveItemsPerRow({
				itemWidth: 100,
				layoutWidth: 10
			})

			expect(result).toBe(1)
		})

		it("returns at least 1 even when itemWidth is larger than layoutWidth", () => {
			const result = resolveItemsPerRow({
				itemWidth: 400,
				layoutWidth: 320
			})

			expect(result).toBeGreaterThanOrEqual(1)
		})

		it("falls through to the computation when itemsPerRow=0 (falsy)", () => {
			const result = resolveItemsPerRow({
				itemsPerRow: 0,
				itemWidth: 100,
				layoutWidth: 300
			})

			expect(result).toBe(3)
		})
	})
})

// ─── validateVirtualListProps ─────────────────────────────────────────────────

describe("validateVirtualListProps", () => {
	it("throws when keyExtractor is undefined", () => {
		expect(() =>
			validateVirtualListProps({
				keyExtractor: undefined
			})
		).toThrow("VirtualList requires a keyExtractor prop")
	})

	it("throws when keyExtractor is null", () => {
		expect(() =>
			validateVirtualListProps({
				keyExtractor: null
			})
		).toThrow("VirtualList requires a keyExtractor prop")
	})

	it("does not throw when keyExtractor is a function", () => {
		expect(() =>
			validateVirtualListProps({
				keyExtractor: (_item: unknown, index: number) => String(index)
			})
		).not.toThrow()
	})
})

// ─── resolveScrollEnabled ─────────────────────────────────────────────────────

describe("resolveScrollEnabled", () => {
	it("enables scroll for an EMPTY list when onRefresh is set (pull-to-refresh must work)", () => {
		expect(resolveScrollEnabled({ loading: false, dataLength: 0, hasOnRefresh: true })).toBe(true)
	})

	it("locks an empty list with no onRefresh (nothing to scroll or pull)", () => {
		expect(resolveScrollEnabled({ loading: false, dataLength: 0, hasOnRefresh: false })).toBe(false)
	})

	it("enables scroll when there is data (with or without onRefresh)", () => {
		expect(resolveScrollEnabled({ loading: false, dataLength: 5, hasOnRefresh: false })).toBe(true)
		expect(resolveScrollEnabled({ loading: false, dataLength: 5, hasOnRefresh: true })).toBe(true)
	})

	it("locks the list while loading regardless of data or onRefresh", () => {
		expect(resolveScrollEnabled({ loading: true, dataLength: 5, hasOnRefresh: true })).toBe(false)
		expect(resolveScrollEnabled({ loading: true, dataLength: 0, hasOnRefresh: true })).toBe(false)
	})

	it("treats an undefined loading flag as not-loading", () => {
		expect(resolveScrollEnabled({ dataLength: 0, hasOnRefresh: true })).toBe(true)
	})
})

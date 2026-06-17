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

vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	cn: (...args: unknown[]) => args.filter(Boolean).join(" ")
}))

vi.mock("uniwind", () => ({
	withUniwind: (component: unknown) => component,
	useResolveClassNames: () => ({ color: "#fff" })
}))

vi.mock("@/hooks/useViewLayout", () => ({
	default: vi.fn(() => ({ layout: { width: 375, height: 812 }, onLayout: vi.fn() }))
}))

// ─── Actual imports ──────────────────────────────────────────────────────────

import { resolveItemsPerRow, validateVirtualListProps } from "@/components/ui/virtualList"

// ─── resolveItemsPerRow ───────────────────────────────────────────────────────

describe("resolveItemsPerRow", () => {
	describe("explicit itemsPerRow prop", () => {
		it("returns the explicit value when itemsPerRow is provided", () => {
			const result = resolveItemsPerRow({
				itemsPerRow: 4,
				grid: true,
				itemWidth: 100,
				layoutWidth: 320
			})

			expect(result).toBe(4)
		})

		it("returns the explicit value even when grid=false", () => {
			const result = resolveItemsPerRow({
				itemsPerRow: 3,
				grid: false,
				itemWidth: 100,
				layoutWidth: 320
			})

			expect(result).toBe(3)
		})

		it("returns the explicit value when itemWidth is absent", () => {
			const result = resolveItemsPerRow({
				itemsPerRow: 2,
				grid: true,
				layoutWidth: 320
			})

			expect(result).toBe(2)
		})
	})

	describe("non-grid mode (grid=false or itemWidth absent)", () => {
		it("returns 1 when grid=false regardless of itemWidth and layoutWidth", () => {
			const result = resolveItemsPerRow({
				grid: false,
				itemWidth: 100,
				layoutWidth: 320
			})

			expect(result).toBe(1)
		})

		it("returns 1 when grid=true but itemWidth is not provided", () => {
			const result = resolveItemsPerRow({
				grid: true,
				layoutWidth: 320
			})

			expect(result).toBe(1)
		})

		it("returns 1 when neither grid nor itemWidth is provided", () => {
			const result = resolveItemsPerRow({ layoutWidth: 320 })

			expect(result).toBe(1)
		})

		it("returns 1 when grid=undefined and itemWidth=100", () => {
			const result = resolveItemsPerRow({ itemWidth: 100, layoutWidth: 320 })

			expect(result).toBe(1)
		})
	})

	describe("grid mode column calculation", () => {
		it("computes 3 columns for layoutWidth=320 and itemWidth=100", () => {
			// 320 / 100 = 3.2 → round → 3 → max(1, 3) = 3 → round → 3
			const result = resolveItemsPerRow({
				grid: true,
				itemWidth: 100,
				layoutWidth: 320
			})

			expect(result).toBe(3)
		})

		it("computes 4 columns for layoutWidth=375 and itemWidth=100", () => {
			// 375 / 100 = 3.75 → round → 4 → max(1, 4) = 4 → round → 4
			const result = resolveItemsPerRow({
				grid: true,
				itemWidth: 100,
				layoutWidth: 375
			})

			expect(result).toBe(4)
		})

		it("computes 5 columns for layoutWidth=500 and itemWidth=100", () => {
			const result = resolveItemsPerRow({
				grid: true,
				itemWidth: 100,
				layoutWidth: 500
			})

			expect(result).toBe(5)
		})

		it("clamps to 1 when layoutWidth=0 (avoids division-by-zero producing 0)", () => {
			// 0 / 100 = 0 → round → 0 → max(1, 0) = 1 → round → 1
			const result = resolveItemsPerRow({
				grid: true,
				itemWidth: 100,
				layoutWidth: 0
			})

			expect(result).toBe(1)
		})

		it("clamps to 1 when layoutWidth is very small (produces sub-1 column count)", () => {
			// 10 / 100 = 0.1 → round → 0 → max(1, 0) = 1
			const result = resolveItemsPerRow({
				grid: true,
				itemWidth: 100,
				layoutWidth: 10
			})

			expect(result).toBe(1)
		})

		it("returns at least 1 even when itemWidth is larger than layoutWidth", () => {
			const result = resolveItemsPerRow({
				grid: true,
				itemWidth: 400,
				layoutWidth: 320
			})

			expect(result).toBeGreaterThanOrEqual(1)
		})
	})

	describe("itemsPerRow=0 falls through to grid computation (falsy 0 check)", () => {
		it("falls through to grid=false branch and returns 1 when itemsPerRow=0 and grid=false", () => {
			// itemsPerRow=0 is falsy → not used; falls to !grid||!itemWidth check
			const result = resolveItemsPerRow({
				itemsPerRow: 0,
				grid: false,
				itemWidth: 100,
				layoutWidth: 320
			})

			expect(result).toBe(1)
		})

		it("falls through to grid calculation when itemsPerRow=0 and grid=true", () => {
			// itemsPerRow=0 is falsy; grid=true + itemWidth → compute columns
			const result = resolveItemsPerRow({
				itemsPerRow: 0,
				grid: true,
				itemWidth: 100,
				layoutWidth: 300
			})

			expect(result).toBe(3)
		})
	})
})

// ─── validateVirtualListProps ─────────────────────────────────────────────────

describe("validateVirtualListProps", () => {
	describe("keyExtractor guard", () => {
		it("throws when keyExtractor is undefined", () => {
			expect(() =>
				validateVirtualListProps({
					keyExtractor: undefined,
					grid: false
				})
			).toThrow("VirtualList requires a keyExtractor prop")
		})

		it("throws when keyExtractor is null", () => {
			expect(() =>
				validateVirtualListProps({
					keyExtractor: null,
					grid: false
				})
			).toThrow("VirtualList requires a keyExtractor prop")
		})

		it("does not throw when keyExtractor is a function", () => {
			expect(() =>
				validateVirtualListProps({
					keyExtractor: (_item: unknown, index: number) => String(index),
					grid: false
				})
			).not.toThrow()
		})
	})

	describe("grid mode guard", () => {
		it("throws when grid=true and itemWidth is missing", () => {
			expect(() =>
				validateVirtualListProps({
					keyExtractor: () => "",
					grid: true,
					itemHeight: 100
				})
			).toThrow("VirtualList in grid mode requires itemWidth and itemHeight props")
		})

		it("throws when grid=true and itemHeight is missing", () => {
			expect(() =>
				validateVirtualListProps({
					keyExtractor: () => "",
					grid: true,
					itemWidth: 100
				})
			).toThrow("VirtualList in grid mode requires itemWidth and itemHeight props")
		})

		it("throws when grid=true and both itemWidth and itemHeight are missing", () => {
			expect(() =>
				validateVirtualListProps({
					keyExtractor: () => "",
					grid: true
				})
			).toThrow("VirtualList in grid mode requires itemWidth and itemHeight props")
		})

		it("does not throw when grid=true and both itemWidth and itemHeight are numbers", () => {
			expect(() =>
				validateVirtualListProps({
					keyExtractor: () => "",
					grid: true,
					itemWidth: 100,
					itemHeight: 100
				})
			).not.toThrow()
		})

		it("does not throw when grid=false even without itemWidth and itemHeight", () => {
			expect(() =>
				validateVirtualListProps({
					keyExtractor: () => "",
					grid: false
				})
			).not.toThrow()
		})

		it("does not throw when grid is undefined (non-grid mode)", () => {
			expect(() =>
				validateVirtualListProps({
					keyExtractor: () => ""
				})
			).not.toThrow()
		})
	})
})

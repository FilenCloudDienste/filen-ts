import { describe, it, expect } from "vitest"
import { gridColumnsForWidth } from "@/features/drive/driveGrid"

describe("gridColumnsForWidth", () => {
	it("phones (<600dp) get 3 columns", () => {
		expect(gridColumnsForWidth(320)).toBe(3)
		expect(gridColumnsForWidth(375)).toBe(3)
		expect(gridColumnsForWidth(599)).toBe(3)
	})

	it("small tablets (600-899dp) get 5 columns", () => {
		expect(gridColumnsForWidth(600)).toBe(5)
		expect(gridColumnsForWidth(768)).toBe(5)
		expect(gridColumnsForWidth(899)).toBe(5)
	})

	it("larger tablets (900-1199dp) get 6 columns", () => {
		expect(gridColumnsForWidth(900)).toBe(6)
		expect(gridColumnsForWidth(1024)).toBe(6)
		expect(gridColumnsForWidth(1199)).toBe(6)
	})

	it("very large screens (>=1200dp) get 7 columns", () => {
		expect(gridColumnsForWidth(1200)).toBe(7)
		expect(gridColumnsForWidth(1600)).toBe(7)
	})

	it("never returns fewer than 3 for any non-negative width", () => {
		expect(gridColumnsForWidth(0)).toBe(3)
		expect(gridColumnsForWidth(100)).toBe(3)
	})
})

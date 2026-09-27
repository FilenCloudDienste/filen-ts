import { describe, expect, it } from "vitest"
import {
	MAX_COL_WIDTH,
	MAX_RESIZE_TARGETS,
	MAX_ROW_HEIGHT,
	MIN_SIZE,
	clampSize,
	colWidthToPx,
	fitSize,
	pxToColWidth,
	pxToRowHeight,
	resetTargets,
	resizeTargets,
	restoreSizes,
	rowHeightToPx,
	sheetWithSizes,
	shiftSizes,
	withSizes
} from "@/features/spreadsheet/lib/sizes.logic"
import { DEFAULT_ROW_HEIGHT } from "@/features/spreadsheet/lib/model"

const noneHidden = () => false

describe("units", () => {
	it("round-trips every pixel width and height through Excel's units", () => {
		for (let px = MIN_SIZE; px <= MAX_COL_WIDTH; px++) {
			expect(colWidthToPx(pxToColWidth(px))).toBe(px)
		}

		for (let px = MIN_SIZE; px <= MAX_ROW_HEIGHT; px++) {
			expect(rowHeightToPx(pxToRowHeight(px))).toBe(px)
		}
	})

	it("stores widths at Excel's 1/256-character precision", () => {
		expect((pxToColWidth(100) * 256) % 1).toBe(0)
	})

	it("keeps the limits inside Excel's own (255 characters, 409 points)", () => {
		expect(pxToColWidth(MAX_COL_WIDTH)).toBeLessThanOrEqual(255)
		expect(pxToRowHeight(MAX_ROW_HEIGHT)).toBeLessThanOrEqual(409)
	})

	it("clamps and rounds, and never reaches zero", () => {
		expect(clampSize("cols", 0)).toBe(MIN_SIZE)
		expect(clampSize("cols", 99_999)).toBe(MAX_COL_WIDTH)
		expect(clampSize("rows", 99_999)).toBe(MAX_ROW_HEIGHT)
		expect(clampSize("rows", 30.6)).toBe(31)
	})
})

describe("withSizes", () => {
	it("sets and clears without touching the source map", () => {
		const base = new Map([
			[1, 50],
			[2, 60]
		])
		const next = withSizes(base, [
			[2, null],
			[4, 80]
		])

		expect([...next]).toEqual([
			[1, 50],
			[4, 80]
		])
		expect(base.get(2)).toBe(60)
	})

	it("replaces only the resized axis of a sheet", () => {
		const sheet = { colWidths: new Map([[0, 50]]), rowHeights: new Map([[0, 30]]), name: "s" }
		const next = sheetWithSizes(sheet, "cols", [[1, 70]])

		expect(next.colWidths.get(1)).toBe(70)
		expect(next.rowHeights).toBe(sheet.rowHeights)
		expect(next.name).toBe("s")
	})
})

describe("shiftSizes / restoreSizes", () => {
	const sizes = new Map([
		[1, 40],
		[3, 50],
		[5, 60]
	])

	it("moves sizes past an insertion", () => {
		expect([...shiftSizes(sizes, "insert", 3, 2).sizes]).toEqual([
			[1, 40],
			[5, 50],
			[7, 60]
		])
	})

	it("drops the deleted run, reports it relative to `at`, and pulls the rest back", () => {
		const { sizes: next, removed } = shiftSizes(sizes, "delete", 2, 2)

		expect([...next]).toEqual([
			[1, 40],
			[3, 60]
		])
		expect(removed).toEqual([[1, 50]])
	})

	it("puts a deleted run back where it was", () => {
		const { sizes: deleted, removed } = shiftSizes(sizes, "delete", 2, 2)
		const reinserted = shiftSizes(deleted, "insert", 2, 2).sizes

		expect([...restoreSizes(reinserted, 2, removed)].sort((a, b) => a[0] - b[0])).toEqual([...sizes])
	})
})

describe("resizeTargets", () => {
	const range = { startRow: 0, endRow: 1_048_575, startCol: 2, endCol: 5 }

	it("is just the dragged index outside a whole selection", () => {
		expect(resizeTargets("cols", 9, range, true, noneHidden)).toEqual([9])
		expect(resizeTargets("cols", 3, range, false, noneHidden)).toEqual([3])
	})

	it("is every selected index inside a whole selection, skipping hidden ones", () => {
		expect(resizeTargets("cols", 3, range, true, index => index === 4)).toEqual([2, 3, 5])
	})

	it("falls back to the dragged index when the selection is past the cap", () => {
		expect(resizeTargets("rows", 7, range, true, noneHidden)).toEqual([7])
		expect(range.endRow - range.startRow + 1).toBeGreaterThan(MAX_RESIZE_TARGETS)
	})
})

describe("fitSize", () => {
	it("fits a column to its widest content plus padding", () => {
		expect(fitSize("cols", [30.2, 81.4, 12])).toBe(82 + 14)
	})

	it("fits a row to its tallest content, never below the default", () => {
		expect(fitSize("rows", [16.25])).toBeNull()
		expect(fitSize("rows", [48.1])).toBe(49 + 7)
		expect(49 + 7).toBeGreaterThan(DEFAULT_ROW_HEIGHT)
	})

	it("goes back to the default with nothing to measure", () => {
		expect(fitSize("cols", [])).toBeNull()
		expect(fitSize("rows", [])).toBeNull()
	})
})

describe("resetTargets", () => {
	it("is the selected indices within the used area, skipping hidden ones", () => {
		expect(resetTargets(2, 9, 6, index => index === 3)).toEqual([2, 4, 5])
	})

	it("keeps the first selected index when the selection starts past the used area", () => {
		expect(resetTargets(8, 12, 5, () => false)).toEqual([8])
	})

	it("stops at the cap", () => {
		expect(resetTargets(0, 1_048_575, 1_048_576, () => false)).toHaveLength(MAX_RESIZE_TARGETS)
	})
})

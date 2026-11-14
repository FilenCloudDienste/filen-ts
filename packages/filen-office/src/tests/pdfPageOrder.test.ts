import { describe, expect, it } from "vitest"
import {
	clampCropRect,
	cropRectFromMargins,
	cropScopePages,
	dragCropHandle,
	marginsFromRect,
	nudgeCropRect,
	outsideRects,
	paddedContent
} from "../core/pdfedit/crop"
import {
	deleteOrder,
	extractGroups,
	isPermutation,
	moveBeforeOrder,
	orderPositions,
	rangesToPages,
	selectionPages,
	shiftOrder,
	splitBefore,
	splitEvery
} from "../core/pdfedit/pageOrder"
import { parsePageRangeParts, parsePageRanges } from "../core/pdfedit/pageRanges"

// Page order arithmetic, split plans and crop geometry.

describe("page order", () => {
	it("moves a selection before a page, keeping its order", () => {
		expect(moveBeforeOrder(6, [4, 1], 0)).toEqual([1, 4, 0, 2, 3, 5])
		expect(moveBeforeOrder(6, [0, 1], 6)).toEqual([2, 3, 4, 5, 0, 1])
		expect(moveBeforeOrder(6, [2], 3)).toEqual([0, 1, 2, 3, 4, 5])
		expect(moveBeforeOrder(3, [7, -1, 1], 0)).toEqual([1, 0, 2])
	})

	it("shifts a selection by places, gathering a scattered one, and stops at the ends", () => {
		expect(shiftOrder(5, [2], -1)).toEqual([0, 2, 1, 3, 4])
		expect(shiftOrder(5, [2], 1)).toEqual([0, 1, 3, 2, 4])
		expect(shiftOrder(5, [0], -1)).toBeNull()
		expect(shiftOrder(5, [4], 1)).toBeNull()
		expect(shiftOrder(6, [1, 4], -1)).toEqual([1, 4, 0, 2, 3, 5])
		// A grid row of 3.
		expect(shiftOrder(6, [4], -3)).toEqual([0, 4, 1, 2, 3, 5])
	})

	it("validates, inverts and deletes", () => {
		expect(isPermutation([2, 0, 1], 3)).toBe(true)
		expect(isPermutation([2, 2, 1], 3)).toBe(false)
		expect([...orderPositions([2, 0], 3)]).toEqual([1, -1, 0])
		expect(deleteOrder(5, [3, 1])).toEqual([0, 2, 4])
		expect(selectionPages(4, [3, 3, 1, 9])).toEqual([1, 3])
	})
})

describe("split plans", () => {
	it("cuts every N pages", () => {
		expect(splitEvery(7, 3)).toEqual([
			{ first: 1, last: 3 },
			{ first: 4, last: 6 },
			{ first: 7, last: 7 }
		])
		expect(splitEvery(2, 0)).toEqual([
			{ first: 1, last: 1 },
			{ first: 2, last: 2 }
		])
	})

	it("cuts before pages (selection or bookmarks), the pages before the first cut a part of their own", () => {
		expect(splitBefore(10, [4, 8])).toEqual([
			{ first: 1, last: 3 },
			{ first: 4, last: 7 },
			{ first: 8, last: 10 }
		])
		expect(splitBefore(5, [1, 3, 3])).toEqual([
			{ first: 1, last: 2 },
			{ first: 3, last: 5 }
		])
		expect(splitBefore(3, [])).toEqual([{ first: 1, last: 3 }])
	})

	it("keeps typed parts as typed for splitting by ranges", () => {
		expect(parsePageRangeParts("4-6, 1-3, 2", 9)).toEqual({
			ok: true,
			ranges: [
				{ first: 4, last: 6 },
				{ first: 1, last: 3 },
				{ first: 2, last: 2 }
			]
		})
		expect(parsePageRanges("4-6, 1-3", 9)).toEqual({ ok: true, ranges: [{ first: 1, last: 6 }] })
		expect(parsePageRangeParts("12", 9)).toEqual({ ok: false, error: { kind: "outOfRange", part: "12" } })
	})

	it("groups an extraction into one file, or one per page", () => {
		const ranges = [
			{ first: 2, last: 3 },
			{ first: 6, last: 6 }
		]

		expect(extractGroups(ranges, false)).toEqual([ranges])
		expect(extractGroups(ranges, true)).toEqual([[{ first: 2, last: 2 }], [{ first: 3, last: 3 }], [{ first: 6, last: 6 }]])
		expect(rangesToPages(ranges)).toEqual([1, 2, 5])
	})
})

describe("crop geometry", () => {
	const page = [0, 0, 600, 800] as const

	it("turns margins into a crop and back", () => {
		expect(cropRectFromMargins(page, { left: 10, top: 20, right: 30, bottom: 40 })).toEqual([10, 20, 570, 760])
		expect(cropRectFromMargins(page, { left: 300, top: 0, right: 290, bottom: 0 })).toBeNull()
		expect(marginsFromRect(page, [10, 20, 570, 760])).toEqual({ left: 10, top: 20, right: 30, bottom: 40 })
		expect(clampCropRect(page, [700, -5, 650, 900])).toEqual([582, 0, 600, 800])
	})

	it("pads content inside the page and keeps blank pages", () => {
		expect(paddedContent(page, [100, 100, 200, 200], 8)).toEqual([92, 92, 208, 208])
		expect(paddedContent(page, null, 8)).toBeNull()
	})

	it("splits the outside of a crop into bands", () => {
		expect(outsideRects(page, [100, 200, 500, 600])).toEqual([
			[0, 0, 600, 200],
			[0, 600, 600, 800],
			[0, 200, 100, 600],
			[500, 200, 600, 600]
		])
		expect(outsideRects(page, page)).toEqual([])
	})

	it("picks the pages of a scope", () => {
		expect(cropScopePages({ kind: "current" }, 5, 2, [])).toEqual([2])
		expect(cropScopePages({ kind: "selected" }, 5, 2, [4, 0, 4])).toEqual([0, 4])
		expect(cropScopePages({ kind: "selected" }, 5, 2, [])).toEqual([2])
		expect(cropScopePages({ kind: "odd" }, 5, 0, [])).toEqual([0, 2, 4])
		expect(cropScopePages({ kind: "even" }, 5, 0, [])).toEqual([1, 3])
		expect(cropScopePages({ kind: "range", text: "2-3, 5" }, 5, 0, [])).toEqual([1, 2, 4])
		expect(cropScopePages({ kind: "range", text: "9" }, 5, 0, [])).toBeNull()
	})

	it("moves handles by keys and drags without crossing or leaving the page", () => {
		const rect = [100, 100, 300, 300] as const

		expect(nudgeCropRect(page, rect, "left", "ArrowRight", 10)).toEqual([110, 100, 300, 300])
		expect(nudgeCropRect(page, rect, "move", "ArrowUp", 500)).toEqual([100, 0, 300, 200])
		expect(nudgeCropRect(page, rect, "top", "Enter", 10)).toBeUndefined()
		expect(dragCropHandle(page, rect, "bottomRight", -500, 1000)).toEqual([100, 100, 118, 800])
	})
})

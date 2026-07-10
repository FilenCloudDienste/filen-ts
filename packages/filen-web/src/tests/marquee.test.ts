import { describe, expect, it } from "vitest"
import {
	marqueeAutoScrollVelocity,
	marqueeGridIndices,
	marqueeIndexAtPoint,
	marqueeIndices,
	marqueeListIndices,
	marqueeRectFromPoints,
	type MarqueeContentRect
} from "@/features/drive/lib/marquee.logic"

// Shared list geometry for the tests below.
const ROW = 40
const TILE_W = 176
const TILE_ROW = 244

function rect(top: number, bottom: number, left = 0, right = 1000): MarqueeContentRect {
	return { top, bottom, left, right }
}

describe("marqueeRectFromPoints", () => {
	it("normalizes regardless of drag direction", () => {
		expect(marqueeRectFromPoints(30, 200, 10, 50)).toStrictEqual({ top: 50, bottom: 200, left: 10, right: 30 })
	})

	it("produces a zero-size rect for coincident points", () => {
		expect(marqueeRectFromPoints(5, 5, 5, 5)).toStrictEqual({ top: 5, bottom: 5, left: 5, right: 5 })
	})
})

describe("marqueeListIndices", () => {
	it("selects the rows a mid-content band overlaps", () => {
		// rows 0..9 each 40px; band [50,130) overlaps rows 1 (40-80), 2 (80-120), 3 (120-160)
		expect(marqueeListIndices(rect(50, 130), 10, ROW)).toStrictEqual([1, 2, 3])
	})

	it("excludes a row it only touches on the boundary edge", () => {
		// [0,40) touches row 1's top edge exactly — must not select row 1
		expect(marqueeListIndices(rect(0, 40), 10, ROW)).toStrictEqual([0])
		// a rect starting exactly on row 1's top belongs to row 1, not row 0
		expect(marqueeListIndices(rect(40, 60), 10, ROW)).toStrictEqual([1])
	})

	it("returns empty for a zero-height rect landing exactly on a row boundary", () => {
		expect(marqueeListIndices(rect(40, 40), 10, ROW)).toStrictEqual([])
	})

	it("clamps a rect extending above the content start", () => {
		expect(marqueeListIndices(rect(-100, 50), 10, ROW)).toStrictEqual([0, 1])
	})

	it("clamps a rect extending past the last row", () => {
		expect(marqueeListIndices(rect(340, 100000), 10, ROW)).toStrictEqual([8, 9])
	})

	it("returns empty when the rect sits entirely below the content", () => {
		expect(marqueeListIndices(rect(400, 500), 10, ROW)).toStrictEqual([])
	})

	it("returns empty for an empty listing", () => {
		expect(marqueeListIndices(rect(0, 100), 0, ROW)).toStrictEqual([])
	})
})

describe("marqueeGridIndices", () => {
	// 3 columns across 600px => cellWidth 200, tile 176 centered => inset 12, tile box [12,188] in cell.
	const COLS = 3
	const WIDTH = 600

	it("selects tiles within a band and column span", () => {
		// vertical band covers grid row 0 only; horizontal covers columns 0 and 1
		const r = rect(0, 100, 0, 250)
		expect(marqueeGridIndices(r, 9, COLS, WIDTH, TILE_W, TILE_ROW)).toStrictEqual([0, 1])
	})

	it("selects a full grid row across all columns", () => {
		const r = rect(0, 100, 0, WIDTH)
		expect(marqueeGridIndices(r, 9, COLS, WIDTH, TILE_W, TILE_ROW)).toStrictEqual([0, 1, 2])
	})

	it("misses a column when the rect falls entirely in the between-tile gutter", () => {
		// gutter between tile 0 (ends 188) and tile 1 (starts 212): rect [190,210] hits neither
		const r = rect(0, 100, 190, 210)
		expect(marqueeGridIndices(r, 9, COLS, WIDTH, TILE_W, TILE_ROW)).toStrictEqual([])
	})

	it("spans multiple grid rows", () => {
		// rows 0 (0-244) and 1 (244-488); full width => all of rows 0 and 1
		const r = rect(0, 300, 0, WIDTH)
		expect(marqueeGridIndices(r, 9, COLS, WIDTH, TILE_W, TILE_ROW)).toStrictEqual([0, 1, 2, 3, 4, 5])
	})

	it("skips indices past the item count in a partial last row", () => {
		// 7 items, 3 cols => last row has only index 6; full-width band over rows 0..2
		const r = rect(0, 800, 0, WIDTH)
		expect(marqueeGridIndices(r, 7, COLS, WIDTH, TILE_W, TILE_ROW)).toStrictEqual([0, 1, 2, 3, 4, 5, 6])
	})

	it("handles a single forced column narrower than a tile", () => {
		// width 120 < tile 176, columns forced to 1 => box clamps to cell, any x overlap hits
		const r = rect(0, 100, 0, 120)
		expect(marqueeGridIndices(r, 3, 1, 120, TILE_W, TILE_ROW)).toStrictEqual([0])
	})

	it("returns empty for an empty listing", () => {
		expect(marqueeGridIndices(rect(0, 100, 0, WIDTH), 0, COLS, WIDTH, TILE_W, TILE_ROW)).toStrictEqual([])
	})
})

describe("marqueeIndices dispatch", () => {
	it("routes list mode to the row math", () => {
		expect(marqueeIndices(rect(50, 130), 10, "list", 3, 600, TILE_W, ROW)).toStrictEqual([1, 2, 3])
	})

	it("routes grid mode to the column math", () => {
		expect(marqueeIndices(rect(0, 100, 0, 600), 9, "grid", 3, 600, TILE_W, TILE_ROW)).toStrictEqual([0, 1, 2])
	})
})

describe("marqueeIndexAtPoint", () => {
	it("maps a list point to its row index", () => {
		expect(marqueeIndexAtPoint(0, 95, 10, "list", 1, 1000, TILE_W, ROW)).toBe(2)
	})

	it("returns -1 for a list point past the last row", () => {
		expect(marqueeIndexAtPoint(0, 5000, 10, "list", 1, 1000, TILE_W, ROW)).toBe(-1)
	})

	it("maps a grid point inside a tile box to its index", () => {
		// col 1 tile box [212,388] in 3-col/600 grid; row 0
		expect(marqueeIndexAtPoint(250, 100, 9, "grid", 3, 600, TILE_W, TILE_ROW)).toBe(1)
	})

	it("returns -1 for a grid point in the gutter", () => {
		expect(marqueeIndexAtPoint(200, 100, 9, "grid", 3, 600, TILE_W, TILE_ROW)).toBe(-1)
	})

	it("returns -1 for a negative coordinate", () => {
		expect(marqueeIndexAtPoint(0, -10, 10, "list", 1, 1000, TILE_W, ROW)).toBe(-1)
	})
})

describe("marqueeAutoScrollVelocity", () => {
	const EDGE = 32
	const MAX = 18

	it("is zero away from both edges", () => {
		expect(marqueeAutoScrollVelocity(300, 0, 600, EDGE, MAX)).toBe(0)
	})

	it("scrolls up near the top, scaled by proximity", () => {
		// 16px from top => ratio 0.5 => -9
		expect(marqueeAutoScrollVelocity(16, 0, 600, EDGE, MAX)).toBeCloseTo(-9)
	})

	it("scrolls down near the bottom, scaled by proximity", () => {
		// container [0,600], 16px from bottom (y=584) => ratio 0.5 => +9
		expect(marqueeAutoScrollVelocity(584, 0, 600, EDGE, MAX)).toBeCloseTo(9)
	})

	it("pins to full speed past the top edge", () => {
		expect(marqueeAutoScrollVelocity(-50, 0, 600, EDGE, MAX)).toBe(-MAX)
	})

	it("pins to full speed past the bottom edge", () => {
		expect(marqueeAutoScrollVelocity(700, 0, 600, EDGE, MAX)).toBe(MAX)
	})

	it("respects a non-zero container top offset", () => {
		// container top at 100, height 600 => bottom edge zone starts at 668
		expect(marqueeAutoScrollVelocity(684, 100, 600, EDGE, MAX)).toBeCloseTo(9)
	})
})

import { describe, expect, it } from "vitest"
import {
	TIMELINE_HEADER_HEIGHT,
	buildPhotosTimeline,
	timelineHeaderAt,
	timelineIndexAtPoint,
	timelineKeyTarget,
	timelineMarqueeIndices,
	timelineYearMarks,
	type TimelineDate
} from "@/features/photos/lib/timeline"

const CELL = 100
const GAP = 2
const COLUMNS = 3

function dates(...runs: [year: number, month: number, count: number][]): TimelineDate[] {
	return runs.flatMap(([year, month, count]) => Array.from({ length: count }, () => ({ year, month })))
}

// July 2023: items 0-4 (rows [0-2] [3-4]); June 2023: items 5-6; December 2022: item 7.
const TIMELINE = buildPhotosTimeline(dates([2023, 6, 5], [2023, 5, 2], [2022, 11, 1]), COLUMNS, CELL, GAP)
const CONTENT_WIDTH = COLUMNS * CELL + (COLUMNS - 1) * GAP

describe("buildPhotosTimeline", () => {
	it("puts a header before each month and chunks its tiles by the column count", () => {
		expect(
			TIMELINE.rows.map(row =>
				row.kind === "header" ? `h ${String(row.year)}-${String(row.month)}` : `t ${String(row.start)}-${String(row.end)}`
			)
		).toEqual(["h 2023-6", "t 0-3", "t 3-5", "h 2023-5", "t 5-7", "h 2022-11", "t 7-8"])
	})

	it("maps each item to its tile row", () => {
		expect(TIMELINE.rowOfItem).toEqual([1, 1, 1, 2, 2, 4, 4, 6])
	})

	it("lays rows out back to back with the gap between them", () => {
		expect(TIMELINE.rowStarts.slice(0, 3)).toEqual([0, TIMELINE_HEADER_HEIGHT + GAP, TIMELINE_HEADER_HEIGHT + GAP + CELL + GAP])
		expect(TIMELINE.totalSize).toBe(3 * TIMELINE_HEADER_HEIGHT + 4 * CELL + 6 * GAP)
	})

	it("gives every row a key unique within the timeline", () => {
		expect(new Set(TIMELINE.rows.map(row => row.key)).size).toBe(TIMELINE.rows.length)
	})

	it("is empty for no items", () => {
		const empty = buildPhotosTimeline([], COLUMNS, CELL, GAP)

		expect(empty.rows).toEqual([])
		expect(empty.totalSize).toBe(0)
	})
})

describe("timelineKeyTarget", () => {
	it("moves down across a month header, keeping the column", () => {
		// item 4 is column 1 of July's second row; June's row holds items 5-6.
		expect(timelineKeyTarget("ArrowDown", 4, 8, TIMELINE)).toBe(6)
	})

	it("clamps onto a shorter row's last tile", () => {
		expect(timelineKeyTarget("ArrowDown", 2, 8, TIMELINE)).toBe(4)
		expect(timelineKeyTarget("ArrowDown", 6, 8, TIMELINE)).toBe(7)
	})

	it("moves up across a month header", () => {
		expect(timelineKeyTarget("ArrowUp", 5, 8, TIMELINE)).toBe(3)
		expect(timelineKeyTarget("ArrowUp", 7, 8, TIMELINE)).toBe(5)
	})

	it("walks capture order sideways, across months", () => {
		expect(timelineKeyTarget("ArrowRight", 4, 8, TIMELINE)).toBe(5)
		expect(timelineKeyTarget("ArrowLeft", 5, 8, TIMELINE)).toBe(4)
	})
})

describe("timeline hit-testing", () => {
	const julyRow2Top = TIMELINE.rowStarts[2] ?? 0
	const juneRowTop = TIMELINE.rowStarts[4] ?? 0

	it("selects the tiles a rectangle overlaps across a header, never the header itself", () => {
		const rect = { left: 0, right: CELL / 2, top: julyRow2Top + 10, bottom: juneRowTop + 10 }

		expect(timelineMarqueeIndices(rect, TIMELINE, CONTENT_WIDTH)).toEqual([3, 5])
	})

	it("selects nothing for a rectangle confined to a header", () => {
		const headerTop = TIMELINE.rowStarts[3] ?? 0
		const rect = { left: 0, right: CONTENT_WIDTH, top: headerTop + 2, bottom: headerTop + 20 }

		expect(timelineMarqueeIndices(rect, TIMELINE, CONTENT_WIDTH)).toEqual([])
	})

	it("finds the tile under a point, and nothing over a header, a gutter or an empty cell", () => {
		expect(timelineIndexAtPoint(CELL + GAP + 5, julyRow2Top + 5, TIMELINE, CONTENT_WIDTH)).toBe(4)
		expect(timelineIndexAtPoint(5, 5, TIMELINE, CONTENT_WIDTH)).toBe(-1)
		expect(timelineIndexAtPoint(CELL + 1, julyRow2Top + 5, TIMELINE, CONTENT_WIDTH)).toBe(-1)
		expect(timelineIndexAtPoint(2 * (CELL + GAP) + 5, julyRow2Top + 5, TIMELINE, CONTENT_WIDTH)).toBe(-1)
	})
})

describe("scrubber marks", () => {
	it("marks each year once, at its newest month", () => {
		expect(timelineYearMarks(TIMELINE)).toEqual([
			{ year: 2023, offset: 0 },
			{ year: 2022, offset: TIMELINE.rowStarts[5] }
		])
	})

	it("names the month header at or above an offset", () => {
		expect(timelineHeaderAt(TIMELINE, (TIMELINE.rowStarts[2] ?? 0) + 5)).toMatchObject({ year: 2023, month: 6 })
		expect(timelineHeaderAt(TIMELINE, (TIMELINE.rowStarts[4] ?? 0) + 5)).toMatchObject({ year: 2023, month: 5 })
		expect(timelineHeaderAt(TIMELINE, TIMELINE.totalSize + 100)).toMatchObject({ year: 2022, month: 11 })
	})
})

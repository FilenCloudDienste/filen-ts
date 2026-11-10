import { describe, expect, it } from "vitest"
import { photosGridKeyAction } from "@/features/photos/components/photoGrid.logic"
import { buildPhotosTimeline, timelineMonthTarget, timelinePageTarget, type TimelineDate } from "@/features/photos/lib/timeline"

// 4-column grid of 10 items in one month throughout: rows [0-3] [4-7] [8-9] under one header. Rows are 100 tall with
// a 2px gap under a 40px header, so tile row n starts at 42 + 102n.
const COLUMNS = 4
const COUNT = 10
const JULY: TimelineDate = { year: 2023, month: 6 }
const TIMELINE = buildPhotosTimeline(
	Array.from({ length: COUNT }, () => JULY),
	COLUMNS,
	100,
	2
)
// Two rows' worth of screen.
const VIEWPORT = 210

function action(key: string, activeIndex: number) {
	return photosGridKeyAction(key, activeIndex, COUNT, TIMELINE, VIEWPORT)
}

describe("photosGridKeyAction", () => {
	it("Space toggles the cursor item's selection", () => {
		expect(action(" ", 2)).toEqual({ kind: "toggle" })
	})

	// Enter is photos.open's, a registered action.
	it("leaves Enter alone", () => {
		expect(action("Enter", 2)).toEqual({ kind: "none" })
	})

	it("ArrowRight/ArrowLeft step one tile along the row", () => {
		expect(action("ArrowRight", 2)).toEqual({ kind: "move", target: 3 })
		expect(action("ArrowLeft", 2)).toEqual({ kind: "move", target: 1 })
	})

	it("ArrowDown/ArrowUp step a whole row", () => {
		expect(action("ArrowDown", 2)).toEqual({ kind: "move", target: 6 })
		expect(action("ArrowUp", 6)).toEqual({ kind: "move", target: 2 })
	})

	it("ArrowDown onto a shorter last row lands on its last tile", () => {
		expect(action("ArrowDown", 7)).toEqual({ kind: "move", target: 9 })
	})

	it("past the first or last row, lands on the first or last tile", () => {
		expect(action("ArrowUp", 2)).toEqual({ kind: "move", target: 0 })
		expect(action("ArrowDown", 8)).toEqual({ kind: "move", target: COUNT - 1 })
	})

	it("Home targets the first tile", () => {
		expect(action("Home", 7)).toEqual({ kind: "move", target: 0 })
	})

	it("End targets the last tile", () => {
		expect(action("End", 0)).toEqual({ kind: "move", target: COUNT - 1 })
	})

	it("PageDown and PageUp move a screenful in the same column", () => {
		expect(action("PageDown", 1)).toEqual({ kind: "move", target: 9 })
		// 210px above the last row's top is the month header: the row under it.
		expect(action("PageUp", 9)).toEqual({ kind: "move", target: 1 })
	})

	it("is a no-op for an unhandled key", () => {
		expect(action("Tab", 0)).toEqual({ kind: "none" })
		expect(action("a", 0)).toEqual({ kind: "none" })
	})

	it("is a no-op for every key on an empty grid", () => {
		const empty = buildPhotosTimeline([], COLUMNS, 100, 2)

		for (const key of [" ", "Enter", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]) {
			expect(photosGridKeyAction(key, 0, 0, empty, VIEWPORT)).toEqual({ kind: "none" })
		}
	})
})

// Three months: July 0-5 (rows [0-3] [4-5]), August 6-7, September 8-16 (rows [8-11] [12-15] [16]).
const MONTHS: TimelineDate[] = [
	...Array.from({ length: 6 }, () => JULY),
	...Array.from({ length: 2 }, () => ({ year: 2023, month: 7 })),
	...Array.from({ length: 9 }, () => ({ year: 2023, month: 8 }))
]
const MONTHS_TIMELINE = buildPhotosTimeline(MONTHS, COLUMNS, 100, 2)

describe("timelinePageTarget", () => {
	it("lands on the tile row a screenful away, across a month header", () => {
		// From July's first row (top 42) 250px down is August's row.
		expect(timelinePageTarget("PageDown", 1, MONTHS.length, MONTHS_TIMELINE, 250)).toBe(7)
		// 120px down from July's second row (top 144) is August's header: the row under it.
		expect(timelinePageTarget("PageDown", 4, MONTHS.length, MONTHS_TIMELINE, 120)).toBe(6)
	})

	it("moves one row when a screenful does not leave the row", () => {
		expect(timelinePageTarget("PageDown", 1, MONTHS.length, MONTHS_TIMELINE, 10)).toBe(5)
		expect(timelinePageTarget("PageUp", 5, MONTHS.length, MONTHS_TIMELINE, 10)).toBe(1)
	})

	it("lands on the first or last item within a screenful of either end", () => {
		expect(timelinePageTarget("PageUp", 5, MONTHS.length, MONTHS_TIMELINE, 1_000)).toBe(0)
		expect(timelinePageTarget("PageDown", 5, MONTHS.length, MONTHS_TIMELINE, 10_000)).toBe(MONTHS.length - 1)
	})
})

describe("timelineMonthTarget", () => {
	it("goes to the first item of the next month", () => {
		expect(timelineMonthTarget(2, MONTHS_TIMELINE, 1)).toBe(6)
		expect(timelineMonthTarget(7, MONTHS_TIMELINE, 1)).toBe(8)
	})

	it("goes to the first item of the previous month, from anywhere in this one", () => {
		expect(timelineMonthTarget(16, MONTHS_TIMELINE, -1)).toBe(6)
		expect(timelineMonthTarget(8, MONTHS_TIMELINE, -1)).toBe(6)
		expect(timelineMonthTarget(7, MONTHS_TIMELINE, -1)).toBe(0)
	})

	it("is null past the last or first month", () => {
		expect(timelineMonthTarget(12, MONTHS_TIMELINE, 1)).toBeNull()
		expect(timelineMonthTarget(3, MONTHS_TIMELINE, -1)).toBeNull()
	})
})

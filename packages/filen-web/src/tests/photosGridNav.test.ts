import { describe, expect, it } from "vitest"
import { photosGridKeyAction } from "@/features/photos/components/photoGrid.logic"
import { buildPhotosTimeline, type TimelineDate } from "@/features/photos/lib/timeline"

// 4-column grid of 10 items in one month throughout: rows [0-3] [4-7] [8-9] under one header.
const COLUMNS = 4
const COUNT = 10
const JULY: TimelineDate = { year: 2023, month: 6 }
const TIMELINE = buildPhotosTimeline(
	Array.from({ length: COUNT }, () => JULY),
	COLUMNS,
	100,
	2
)

describe("photosGridKeyAction", () => {
	it("Space toggles the cursor item's selection", () => {
		expect(photosGridKeyAction(" ", 2, COUNT, TIMELINE)).toEqual({ kind: "toggle" })
	})

	it("Enter opens the viewer", () => {
		expect(photosGridKeyAction("Enter", 2, COUNT, TIMELINE)).toEqual({ kind: "open" })
	})

	it("ArrowRight/ArrowLeft step one tile along the row", () => {
		expect(photosGridKeyAction("ArrowRight", 2, COUNT, TIMELINE)).toEqual({ kind: "move", target: 3 })
		expect(photosGridKeyAction("ArrowLeft", 2, COUNT, TIMELINE)).toEqual({ kind: "move", target: 1 })
	})

	it("ArrowDown/ArrowUp step a whole row", () => {
		expect(photosGridKeyAction("ArrowDown", 2, COUNT, TIMELINE)).toEqual({ kind: "move", target: 6 })
		expect(photosGridKeyAction("ArrowUp", 6, COUNT, TIMELINE)).toEqual({ kind: "move", target: 2 })
	})

	it("ArrowDown onto a shorter last row lands on its last tile", () => {
		expect(photosGridKeyAction("ArrowDown", 7, COUNT, TIMELINE)).toEqual({ kind: "move", target: 9 })
	})

	it("past the first or last row, lands on the first or last tile", () => {
		expect(photosGridKeyAction("ArrowUp", 2, COUNT, TIMELINE)).toEqual({ kind: "move", target: 0 })
		expect(photosGridKeyAction("ArrowDown", 8, COUNT, TIMELINE)).toEqual({ kind: "move", target: COUNT - 1 })
	})

	it("Home targets the first tile", () => {
		expect(photosGridKeyAction("Home", 7, COUNT, TIMELINE)).toEqual({ kind: "move", target: 0 })
	})

	it("End targets the last tile", () => {
		expect(photosGridKeyAction("End", 0, COUNT, TIMELINE)).toEqual({ kind: "move", target: COUNT - 1 })
	})

	it("is a no-op for an unhandled key", () => {
		expect(photosGridKeyAction("Tab", 0, COUNT, TIMELINE)).toEqual({ kind: "none" })
		expect(photosGridKeyAction("a", 0, COUNT, TIMELINE)).toEqual({ kind: "none" })
	})

	it("is a no-op for every key on an empty grid", () => {
		const empty = buildPhotosTimeline([], COLUMNS, 100, 2)

		for (const key of [" ", "Enter", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]) {
			expect(photosGridKeyAction(key, 0, 0, empty)).toEqual({ kind: "none" })
		}
	})
})

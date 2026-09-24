import { describe, expect, it } from "vitest"
import { photosGridKeyAction } from "@/features/photos/components/photoGrid.logic"

// 4-column grid of 10 items throughout, mirroring the density the desktop grid actually renders.
const COLUMNS = 4
const COUNT = 10

describe("photosGridKeyAction", () => {
	it("Space toggles the cursor item's selection", () => {
		expect(photosGridKeyAction(" ", 2, COUNT, COLUMNS)).toEqual({ kind: "toggle" })
	})

	it("Enter opens the viewer", () => {
		expect(photosGridKeyAction("Enter", 2, COUNT, COLUMNS)).toEqual({ kind: "open" })
	})

	it("ArrowRight/ArrowLeft step one tile along the row", () => {
		expect(photosGridKeyAction("ArrowRight", 2, COUNT, COLUMNS)).toEqual({ kind: "move", target: 3 })
		expect(photosGridKeyAction("ArrowLeft", 2, COUNT, COLUMNS)).toEqual({ kind: "move", target: 1 })
	})

	it("ArrowDown/ArrowUp step a whole row", () => {
		expect(photosGridKeyAction("ArrowDown", 2, COUNT, COLUMNS)).toEqual({ kind: "move", target: 6 })
		expect(photosGridKeyAction("ArrowUp", 6, COUNT, COLUMNS)).toEqual({ kind: "move", target: 2 })
	})

	it("Home targets the first tile", () => {
		expect(photosGridKeyAction("Home", 7, COUNT, COLUMNS)).toEqual({ kind: "move", target: 0 })
	})

	it("End targets the last tile", () => {
		expect(photosGridKeyAction("End", 0, COUNT, COLUMNS)).toEqual({ kind: "move", target: COUNT - 1 })
	})

	it("is a no-op for an unhandled key", () => {
		expect(photosGridKeyAction("Tab", 0, COUNT, COLUMNS)).toEqual({ kind: "none" })
		expect(photosGridKeyAction("a", 0, COUNT, COLUMNS)).toEqual({ kind: "none" })
	})

	it("is a no-op for every key on an empty grid", () => {
		for (const key of [" ", "Enter", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]) {
			expect(photosGridKeyAction(key, 0, 0, COLUMNS)).toEqual({ kind: "none" })
		}
	})

	it("returns out-of-range move targets raw — the hook clamps them", () => {
		expect(photosGridKeyAction("ArrowDown", 8, COUNT, COLUMNS)).toEqual({ kind: "move", target: 12 })
	})
})

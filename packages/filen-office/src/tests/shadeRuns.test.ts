import { describe, expect, it } from "vitest"
import { DrawingList, IDENTITY, ItemKind } from "../core/drawingml/displayList"
import { drawingData } from "../core/presentation/render/slide"
import { mergeShadedRuns } from "../react/presentation/paint/shadeRuns"

// Consecutive gradient triangles drawn as one item: in order, never across another item, never joining outlines that
// turn opposite ways (one non-zero path would cut holes where they overlap).

function triangle(list: DrawingList, x: number, clockwise = true): void {
	const firstCommand = list.commandCount
	const firstCoord = list.coordCount
	const corners = clockwise ? [x, 0, x + 4, 0, x, 4] : [x, 0, x, 4, x + 4, 0]

	list.moveTo(corners[0] ?? 0, corners[1] ?? 0)
	list.lineTo(corners[2] ?? 0, corners[3] ?? 0)
	list.lineTo(corners[4] ?? 0, corners[5] ?? 0)
	list.close()
	list.addItem(
		ItemKind.PATH,
		IDENTITY,
		x,
		0,
		4,
		4,
		firstCommand,
		firstCoord,
		list.paint({
			kind: "shaded",
			points: Float32Array.from(corners),
			colors: Uint32Array.of(0xff0000ff, 0x00ff00ff, 0x0000ffff),
			ramp: null
		}),
		-1,
		-1,
		-1,
		0,
		0
	)
}

function solid(list: DrawingList, x: number): void {
	const firstCommand = list.commandCount
	const firstCoord = list.coordCount

	list.moveTo(x, 0)
	list.lineTo(x + 4, 0)
	list.lineTo(x, 4)
	list.close()
	list.addItem(
		ItemKind.PATH,
		IDENTITY,
		x,
		0,
		4,
		4,
		firstCommand,
		firstCoord,
		list.paint({ kind: "solid", color: 0x000000ff }),
		-1,
		-1,
		-1,
		0,
		0
	)
}

describe("runs of shaded items", () => {
	it("draws a run of gradient triangles as one item over their outlines, with one mesh of their triangles in order", () => {
		const list = new DrawingList()

		for (let k = 0; k < 20; k++) triangle(list, k * 5)

		const merged = mergeShadedRuns(drawingData(list))
		const paint = merged.paints[merged.itemInts[4] ?? -1]

		expect(merged.itemCount).toBe(1)
		expect(merged.itemInts[2]).toBe(80)
		expect(Array.from(merged.itemFloats.subarray(6, 10))).toEqual([0, 0, 99, 4])
		expect(paint?.kind === "shaded" ? Array.from(paint.points.subarray(6, 12)) : []).toEqual([5, 0, 9, 0, 5, 4])
		expect(mergeShadedRuns(drawingData(list))).not.toBe(merged)
	})

	it("keeps another item between two runs in its place, and outlines that turn the other way apart", () => {
		const list = new DrawingList()

		for (let k = 0; k < 10; k++) triangle(list, k * 5)

		solid(list, 50)

		for (let k = 11; k < 31; k++) triangle(list, k * 5, k < 21)

		const merged = mergeShadedRuns(drawingData(list))

		// The first run, the solid item, ten clockwise triangles and ten turned the other way: four items.
		expect(merged.itemCount).toBe(4)
		expect(merged.paints[merged.itemInts[10 + 4] ?? -1]?.kind).toBe("solid")
	})
})

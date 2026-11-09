import { describe, expect, it } from "vitest"
import { CellFlag, type SheetLayout, type SheetTile } from "../core/sheet/protocol"
import { CfBarFlag, ICON_SETS, iconSetIndex } from "../core/sheet/cf/layers"
import { CF_BAR_DECORATOR, CF_ICON_DECORATOR, iconShape } from "../react/sheet/overlays/cf"
import { placeOverlay, validationEntry } from "../react/sheet/overlays/dvPlacement"
import type { GridDecoration, GridPaintScene } from "../react/sheet/layers"
import type { GridTile } from "../react/sheet/tiles"
import { RecordingCanvas } from "./sheetGridCanvas"

// Conditional formatting's bars and icons as the grid draws them from a tile's layers, and where data validation's
// overlays go.

class PathCanvas extends RecordingCanvas {
	arc(...args: number[]): void {
		this.calls.push({
			op: "arc",
			args,
			fill: this.fillStyle,
			stroke: this.strokeStyle,
			font: this.font,
			lineWidth: this.lineWidth,
			dash: [],
			dashOffset: this.lineDashOffset
		})
	}

	override fill(): void {
		this.calls.push({
			op: "fill",
			args: [],
			fill: this.fillStyle,
			stroke: this.strokeStyle,
			font: this.font,
			lineWidth: this.lineWidth,
			dash: [],
			dashOffset: this.lineDashOffset
		})
	}
}

class GradientCanvas extends RecordingCanvas {
	readonly gradients: { from: number[]; stops: [number, string][] }[] = []
	readonly made: object[] = []

	createLinearGradient(...from: number[]): { addColorStop(offset: number, color: string): void } {
		const record: { from: number[]; stops: [number, string][] } = { from, stops: [] }
		const gradient = {
			addColorStop: (offset: number, color: string) => {
				record.stops.push([offset, color])
			}
		}

		this.gradients.push(record)
		this.made.push(gradient)

		return gradient
	}
}

function tile(layers: SheetTile["layers"]): GridTile {
	return {
		key: 0,
		sheet: 0,
		tileRow: 0,
		tileCol: 0,
		version: 1,
		count: 1,
		positions: Uint16Array.of(0),
		texts: Int32Array.of(-1),
		inputs: Int32Array.of(-1),
		styles: Uint32Array.of(0),
		flags: Uint32Array.of(CellFlag.CF_BAR | CellFlag.CF_ICON),
		strings: [],
		...(layers !== undefined && { layers })
	}
}

const SCENE = { scale: 1, pixelRatio: 1, model: { style: () => ({}) } } as unknown as GridPaintScene

function cell(grid: GridTile): GridDecoration {
	return { row: 0, col: 0, flags: grid.flags[0] ?? 0, tile: grid, entry: 0, box: { x: 10, y: 20, width: 105, height: 21 } }
}

function bars(fill: number, flags: number, axis = Number.NaN): SheetTile["layers"] {
	return {
		cfBars: {
			entries: Uint16Array.of(0),
			starts: Float32Array.of(0),
			ends: Float32Array.of(0.5),
			axes: Float32Array.of(axis),
			fills: Uint32Array.of(fill),
			borders: Int32Array.of(0x112233),
			axisColors: Int32Array.of(Number.isNaN(axis) ? -1 : 0),
			flags: Uint8Array.of(flags)
		}
	}
}

describe("conditional formatting drawn", () => {
	it("draws a solid bar inset from the cell, its border and no gradient", () => {
		const canvas = new RecordingCanvas()

		CF_BAR_DECORATOR.paint(canvas, cell(tile(bars(0x638ec6, 0))), SCENE)

		const rects = canvas.calls.filter(call => call.op === "fillRect")

		// Inset 2 px from the left, top and the gridline; half of the 100 px inside.
		expect(rects).toEqual([expect.objectContaining({ args: [12, 22, 50, 16], fill: "#638ec6" })])
		expect(canvas.calls.some(call => call.op === "rect" && call.stroke === "#112233")).toBe(true)
	})

	it("fades a gradient bar out with one gradient (to the cells beneath, light or dark), and draws the axis dashed", () => {
		const canvas = new GradientCanvas()

		CF_BAR_DECORATOR.paint(canvas, cell(tile(bars(0xff0000, CfBarFlag.GRADIENT, 0.25))), { ...SCENE, pixelRatio: 3 } as GridPaintScene)

		const rects = canvas.calls.filter(call => call.op === "fillRect")

		// One fill for the bar whatever the pixel ratio, from its colour to a tenth of it over the cell (white over
		// a white cell, as Excel draws it).
		expect(rects).toEqual([expect.objectContaining({ args: [12, 22, 50, 16] })])
		expect(canvas.gradients).toEqual([
			{
				from: [12, 0, 62, 0],
				stops: [
					[0, "#ff0000"],
					[1, "rgba(255, 0, 0, 0.1)"]
				]
			}
		])
		expect(rects[0]?.fill).toBe(canvas.made[0])
		expect(canvas.calls.some(call => call.op === "moveTo" && call.args[0] === 37.5)).toBe(true)
	})

	it("fades a negative bar from its axis side", () => {
		const canvas = new GradientCanvas()
		const layers = bars(0xff0000, CfBarFlag.GRADIENT, 0.5)

		;(layers?.cfBars?.starts as Float32Array)[0] = 0.25
		CF_BAR_DECORATOR.paint(canvas, cell(tile(layers)), SCENE)

		expect(canvas.gradients[0]?.from).toEqual([62, 0, 37, 0])
	})

	it("knows an icon for every set's every icon, the lowest value's first", () => {
		for (const [set, name] of ICON_SETS.entries()) {
			const count = Number(name.charAt(0))

			for (let icon = 0; icon < count; icon++) expect(iconShape(set, icon)).not.toBeNull()

			expect(iconShape(set, count)).toBeNull()
		}

		expect(iconShape(iconSetIndex("3Arrows"), 0)).toMatchObject({ kind: "arrow", angle: 90 })
		expect(iconShape(iconSetIndex("3Arrows"), 2)).toMatchObject({ kind: "arrow", angle: -90 })
		expect(iconShape(iconSetIndex("5Quarters"), 4)).toMatchObject({ kind: "circle", fraction: 1 })
	})

	it("draws an icon at the cell's left, at its bottom unless it aligns otherwise", () => {
		const canvas = new PathCanvas()
		const icons = {
			cfIcons: { entries: Uint16Array.of(0), sets: Uint8Array.of(iconSetIndex("3TrafficLights1")), icons: Uint8Array.of(2) }
		}

		CF_ICON_DECORATOR.paint(canvas, cell(tile(icons)), SCENE)

		const arc = canvas.calls.find(call => call.op === "arc")

		// A 16 px icon 2 px in, its bottom 2 px above the cell's.
		expect(arc?.args.slice(0, 2)).toEqual([20, 31])
		expect(canvas.calls.find(call => call.op === "fill")?.fill).toBe("#3e9b4f")
	})
})

describe("data validation's overlays", () => {
	const layout = {
		extensions: {
			validations: {
				ranges: Uint32Array.of(0, 0, 9, 0, 0, 2, 0, 2),
				rules: Uint32Array.of(0, 1),
				entries: [
					{ dropdown: true, promptTitle: null, prompt: null },
					{ dropdown: false, promptTitle: "Tip", prompt: "Type a code" }
				]
			}
		}
	} as unknown as SheetLayout

	it("finds a cell's validation in the layout", () => {
		expect(validationEntry(layout, 5, 0)?.dropdown).toBe(true)
		expect(validationEntry(layout, 0, 2)?.prompt).toBe("Type a code")
		expect(validationEntry(layout, 10, 0)).toBeNull()
		expect(validationEntry(null, 0, 0)).toBeNull()
	})

	it("puts the list's button beside the cell's trailing edge and the message under it", () => {
		const rect = { x: 100, y: 40, width: 64, height: 20 }

		expect(placeOverlay(rect, "button", false, 20)).toEqual({ left: 164, top: 40, height: 19 })
		expect(placeOverlay(rect, "button", true, 20)).toEqual({ left: 80, top: 40, height: 19 })
		expect(placeOverlay(rect, "message", false, 0)).toEqual({ left: 132, top: 64 })
		// While the list is open (it opens from the button's left edge, rightwards): the message ends where the
		// button starts, beside the list.
		expect(placeOverlay(rect, "messageBesideList", false, 50)).toEqual({ left: 114, top: 64 })
		expect(placeOverlay(rect, "messageBesideList", true, 50)).toEqual({ left: 30, top: 64 })
		expect(placeOverlay({ ...rect, x: 4 }, "messageBesideList", false, 200)).toEqual({ left: 0, top: 64 })
	})
})

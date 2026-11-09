// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { recolorPixels } from "../core/drawingml/canvas"
import { DrawingList, IDENTITY, ItemKind, rgba, type DrawingImage, type Stroke } from "../core/drawingml/displayList"
import type { DrawingData } from "../dom/docx/protocol"
import { paintDrawing, type DrawingPaintContext } from "../react/docx/paint/drawing"

function data(list: DrawingList): DrawingData {
	const compact = list.compact()

	return {
		width: compact.width,
		height: compact.height,
		commands: compact.commands,
		coords: compact.coords,
		itemCount: compact.itemCount,
		itemFloats: compact.itemFloats,
		itemInts: compact.itemInts,
		paints: compact.paints,
		strokes: compact.strokes,
		images: compact.images,
		texts: compact.texts,
		shadows: compact.shadows
	}
}

const URL = "blob:https://app/1"

function context(): DrawingPaintContext {
	return { document, idPrefix: "p", imageUrl: image => (image.partName === undefined ? undefined : URL) }
}

function list(): DrawingList {
	const out = new DrawingList()

	out.width = 100
	out.height = 50

	return out
}

function stroke(overrides: Partial<Stroke> = {}): Stroke {
	return {
		width: 6,
		paint: 0,
		dash: "solid",
		customDash: null,
		cap: "flat",
		join: "miter",
		miterLimit: 8,
		compound: "sng",
		inset: false,
		...overrides
	}
}

function image(overrides: Partial<DrawingImage> = {}): DrawingImage {
	return {
		partName: "/ppt/media/image1.png",
		format: "png",
		handling: "native",
		svgPartName: undefined,
		crop: { left: 0, top: 0, right: 0, bottom: 0 },
		alpha: 1,
		grayscale: false,
		biLevel: -1,
		duotone: null,
		brightness: 0,
		contrast: 0,
		colorChange: null,
		...overrides
	}
}

// A 40 x 20 rectangle (closed) or a straight line (open), filled with `fill` and outlined with `line`.
function shape(target: DrawingList, fill: number, line: Stroke, closed: boolean = true): void {
	const command = target.commandCount
	const coord = target.coordCount
	const strokeIndex = target.stroke(line)

	target.moveTo(0, 0)
	target.lineTo(40, 0)

	if (closed) {
		target.lineTo(40, 20)
		target.lineTo(0, 20)
		target.close()
	}

	target.addItem(ItemKind.PATH, IDENTITY, 0, 0, 40, closed ? 20 : 0, command, coord, fill, strokeIndex, -1, -1, 0, 0)
}

// The mask's strokes in paint order as [stroke colour, width], and whether it holds an inside-only group.
function maskOf(svg: SVGSVGElement): { strokes: [string, number][]; inside: boolean } {
	const outline = svg.querySelector("path[mask]")
	const id = outline?.getAttribute("mask")?.slice(5, -1)
	const mask = svg.querySelector(`mask[id="${id}"]`)

	expect(mask).not.toBeNull()

	const strokes = Array.from(mask?.querySelectorAll("path[stroke]") ?? []).map(
		path => [path.getAttribute("stroke") ?? "", Number(path.getAttribute("stroke-width"))] as [string, number]
	)

	return { strokes, inside: mask?.querySelector("g[clip-path]") !== null }
}

describe("compound and inset outlines", () => {
	it("keeps a single centred line one plain stroke", () => {
		const target = list()
		const paint = target.paint({ kind: "solid", color: rgba("000000") })

		shape(target, paint, stroke({ paint }))

		const svg = paintDrawing(data(target), context())

		expect(svg.querySelector("mask")).toBeNull()
		expect(svg.querySelectorAll("path").length).toBe(1)
	})

	it("draws a double line as two bands with an unpainted gap, and keeps the fill unmasked", () => {
		const target = list()
		const black = target.paint({ kind: "solid", color: rgba("000000") })
		const red = target.paint({ kind: "solid", color: rgba("FF0000") })

		shape(target, red, stroke({ paint: black, compound: "dbl" }))

		const svg = paintDrawing(data(target), context())
		const fill = svg.querySelector("path[fill='#ff0000']")
		const outline = svg.querySelector("path[mask]")

		expect(fill?.hasAttribute("mask")).toBe(false)
		expect(fill?.hasAttribute("stroke")).toBe(false)
		expect(outline?.getAttribute("fill")).toBe("none")
		expect(outline?.getAttribute("stroke-width")).toBe("6")
		// 6 wide: lines over 2 px either side of the path, a 2 px gap centred on it.
		expect(maskOf(svg)).toEqual({
			strokes: [
				["#fff", 6],
				["#000", 2]
			],
			inside: false
		})
	})

	it("draws a triple line thin, thick, thin", () => {
		const target = list()
		const black = target.paint({ kind: "solid", color: rgba("000000") })

		shape(target, -1, stroke({ paint: black, compound: "tri" }))

		const { strokes, inside } = maskOf(paintDrawing(data(target), context()))

		expect(inside).toBe(false)
		expect(strokes.map(([color]) => color)).toEqual(["#fff", "#000", "#fff"])
		expect(strokes[0]?.[1]).toBeCloseTo(6, 3)
		expect(strokes[1]?.[1]).toBeCloseTo(4, 3)
		expect(strokes[2]?.[1]).toBeCloseTo(2, 3)
	})

	it("puts the thick line of thickThin outside the path and the thin one inside, and the reverse for thinThick", () => {
		const target = list()
		const black = target.paint({ kind: "solid", color: rgba("000000") })

		shape(target, -1, stroke({ paint: black, compound: "thickThin", width: 8 }))

		const thickThin = paintDrawing(data(target), context())
		const outer = thickThin.querySelector("mask > path[stroke]")
		const inner = Array.from(thickThin.querySelectorAll("mask g[clip-path] > path[stroke]")).map(path => [
			path.getAttribute("stroke"),
			path.getAttribute("stroke-width")
		])

		// Outside: the thick half (4 px) runs from the edge to the path; inside: 2 px of line, then a 2 px gap.
		expect(outer?.getAttribute("stroke-width")).toBe("8")
		expect(inner).toEqual([
			["#fff", "8"],
			["#000", "4"]
		])
		expect(thickThin.querySelector("mask g[clip-path] > path[fill='#000']")).not.toBeNull()

		const other = list()
		const ink = other.paint({ kind: "solid", color: rgba("000000") })

		shape(other, -1, stroke({ paint: ink, compound: "thinThick", width: 8 }))

		const thinThick = paintDrawing(data(other), context())

		expect(
			Array.from(thinThick.querySelectorAll("mask > path[stroke]")).map(path => [
				path.getAttribute("stroke"),
				path.getAttribute("stroke-width")
			])
		).toEqual([
			["#fff", "8"],
			["#000", "4"]
		])
		expect(thinThick.querySelector("mask g[clip-path] > path[stroke]")?.getAttribute("stroke-width")).toBe("8")
	})

	it("draws an inset pen inside a closed path only, and centres it on an open one", () => {
		const target = list()
		const black = target.paint({ kind: "solid", color: rgba("000000") })

		shape(target, -1, stroke({ paint: black, inset: true }))

		const closed = paintDrawing(data(target), context())

		// A pen twice as wide, kept on its inner half.
		expect(closed.querySelector("path[mask]")?.getAttribute("stroke-width")).toBe("12")
		expect(maskOf(closed)).toEqual({ strokes: [["#fff", 12]], inside: true })
		expect(closed.querySelector("mask > path")).toBeNull()

		const open = list()
		const ink = open.paint({ kind: "solid", color: rgba("000000") })

		shape(open, -1, stroke({ paint: ink, inset: true }), false)

		const line = paintDrawing(data(open), context())

		expect(line.querySelector("mask")).toBeNull()
		expect(line.querySelector("path")?.getAttribute("stroke-width")).toBe("6")
	})

	it("gives the mask a user-space region a flat line's stroke fits in", () => {
		const target = list()
		const black = target.paint({ kind: "solid", color: rgba("000000") })

		shape(target, -1, stroke({ paint: black, compound: "dbl" }), false)

		const mask = paintDrawing(data(target), context()).querySelector("mask")

		expect(mask?.getAttribute("maskUnits")).toBe("userSpaceOnUse")
		expect(Number(mask?.getAttribute("height"))).toBeGreaterThan(6)
		expect(Number(mask?.getAttribute("y"))).toBeLessThan(-3)
	})
})

// The filter's colour change run on one pixel, by the Filter Effects definitions of the primitives it uses.
function filterColorChange(filter: Element, pixel: readonly [number, number, number, number]): number[] {
	const funcs = Array.from(filter.querySelectorAll("feComponentTransfer")[0]?.children ?? [])
	const lookup = (func: Element | undefined, value: number): number => {
		const table = (func?.getAttribute("tableValues") ?? "").split(" ").map(Number)
		const c = value / 255
		const k = c >= 1 ? table.length - 1 : Math.floor(c * table.length)

		return table[k] ?? Number.NaN
	}
	const matrix = (filter.querySelector("feColorMatrix")?.getAttribute("values") ?? "").split(" ").map(Number)
	const matched = [lookup(funcs[0], pixel[0]), lookup(funcs[1], pixel[1]), lookup(funcs[2], pixel[2]), pixel[3] / 255]
	const alphaRow = matrix.slice(15, 20)
	const mask = Math.min(
		1,
		Math.max(
			0,
			alphaRow.slice(0, 4).reduce((sum, weight, k) => sum + weight * (matched[k] ?? 0), alphaRow[4] ?? 0)
		)
	)
	const flood = filter.querySelector("feFlood")
	const color = Number.parseInt((flood?.getAttribute("flood-color") ?? "#000000").slice(1), 16)
	const opacity = Number(flood?.getAttribute("flood-opacity"))

	expect([0, 1]).toContain(mask)

	return mask === 1 ? [(color >>> 16) & 255, (color >>> 8) & 255, color & 255, Math.round(pixel[3] * opacity)] : [...pixel]
}

describe("set transparent colour", () => {
	it("filters an image that only changes a colour, exactly as the canvas painter's recolorPixels", () => {
		for (const [from, to] of [
			["FFFFFF", rgba("FFFFFF", 0)],
			["7F3A01", rgba("00FF00", 0.5)]
		] as const) {
			const target = list()
			const picture = target.image(image({ colorChange: [rgba(from), to] }))

			target.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 40, 20, target.commandCount, target.coordCount, -1, -1, picture, -1, 0, 0)

			const svg = paintDrawing(data(target), context())
			const id = svg.querySelector("image")?.getAttribute("filter")?.slice(5, -1)
			const filter = svg.querySelector(`filter[id="${id}"]`)

			expect(filter).not.toBeNull()

			const f = Number.parseInt(from, 16)
			const r = f >>> 16
			const g = (f >>> 8) & 255
			const b = f & 255
			const pixels: [number, number, number, number][] = [
				[r, g, b, 255],
				[r, g, b, 128],
				[r ^ 1, g, b, 255],
				[r, g ^ 1, b, 255],
				[r, g, b ^ 1, 255],
				[0, 0, 0, 255],
				[255, 255, 254, 255],
				[254, 255, 255, 255]
			]
			const expected = new Uint8ClampedArray(pixels.flat())

			recolorPixels(expected, image({ colorChange: [rgba(from), to] }))

			for (let k = 0; k < pixels.length; k++) {
				const pixel = pixels[k]

				if (pixel === undefined || filter === null) continue

				expect(filterColorChange(filter, pixel)).toEqual(Array.from(expected.subarray(k * 4, k * 4 + 4)))
			}
		}
	})

	it("changes the colour before the grey and brightness steps", () => {
		const target = list()
		const picture = target.image(image({ colorChange: [rgba("FFFFFF"), rgba("FFFFFF", 0)], grayscale: true, brightness: 0.2 }))

		target.addItem(ItemKind.IMAGE, IDENTITY, 0, 0, 40, 20, target.commandCount, target.coordCount, -1, -1, picture, -1, 0, 0)

		const filter = paintDrawing(data(target), context()).querySelector("filter")
		const order = Array.from(filter?.children ?? []).map(child => child.tagName)

		expect(order.indexOf("feMerge")).toBeGreaterThan(0)
		expect(order.indexOf("feMerge")).toBeLessThan(order.lastIndexOf("feColorMatrix"))
		expect(filter?.querySelector("feColorMatrix[type='saturate']")).not.toBeNull()
	})
})

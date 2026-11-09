import { describe, expect, it } from "vitest"
import { convertChart } from "../core/drawingml/chart/index"
import { fitPolynomial } from "../core/drawingml/chart/plots"
import { drawingTheme } from "../core/drawingml/color"
import { DrawingList, ItemInt, ItemKind, rgba } from "../core/drawingml/displayList"
import type { PaintContext } from "../core/drawingml/fill"
import { parseXml } from "../core/xml/index"
import { budget, cpuMs } from "./timing"

// Trendlines (§21.2.2.211), error bars (§21.2.2.55) and drop lines (§21.2.2.53).

const SCHEME: Readonly<Record<string, string>> = {
	tx1: "000000",
	bg1: "FFFFFF",
	accent1: "4472C4",
	accent2: "ED7D31",
	accent3: "A5A5A5",
	accent4: "FFC000",
	accent5: "5B9BD5",
	accent6: "70AD47"
}

const EMU = 9525
const RED = rgba("FF0000")
const RED_LINE = '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></c:spPr>'

function convert(plotArea: string) {
	const context: PaintContext = {
		list: new DrawingList(),
		theme: drawingTheme(undefined, name => SCHEME[name]),
		images: () => undefined,
		effects: false
	}
	const part = `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:layout/>${plotArea}</c:plotArea></c:chart></c:chartSpace>`

	return convertChart(context, parseXml(new TextEncoder().encode(part)), 480 * EMU, 320 * EMU)
}

function numbers(values: readonly (number | null)[]): string {
	const points = values.map((value, index) => (value === null ? "" : `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`)).join("")

	return `<c:numRef><c:f>S!A1</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${points}</c:numCache></c:numRef>`
}

function categorySeries(values: readonly (number | null)[], extra: string): string {
	return `<c:ser><c:idx val="0"/><c:order val="0"/>${extra}<c:val>${numbers(values)}</c:val></c:ser>`
}

const AXES =
	'<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>'

const XY_AXES =
	'<c:valAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/><c:crosses val="autoZero"/></c:valAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>'

const line = (body: string, plotExtra: string = ""): string =>
	`<c:lineChart><c:grouping val="standard"/>${body}<c:marker val="1"/>${plotExtra}<c:axId val="1"/><c:axId val="2"/></c:lineChart>${AXES}`
const column = (body: string): string =>
	`<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${body}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`

// Path items stroked in `color`.
function strokedWith(list: DrawingList, color: number): number[] {
	const out: number[] = []

	for (let item = 0; item < list.itemCount; item++) {
		if (list.kind(item) !== ItemKind.PATH) continue

		const stroke = list.strokes[list.itemInt(item, ItemInt.STROKE)]
		const paint = stroke === undefined ? undefined : list.paints[stroke.paint]

		if (paint?.kind === "solid" && paint.color === color) out.push(item)
	}

	return out
}

// The (x, y) pairs of each moveTo-started subpath of a path item.
function subpaths(list: DrawingList, item: number): number[][] {
	const first = list.itemInt(item, ItemInt.FIRST_COMMAND)
	const count = list.itemInt(item, ItemInt.COMMAND_COUNT)
	let coord = list.itemInt(item, ItemInt.FIRST_COORD)
	const out: number[][] = []

	for (let k = first; k < first + count; k++) {
		const command = list.commands[k]

		// moveTo 0, lineTo 1.
		if (command === 0) out.push([])
		if (command === 0 || command === 1) {
			out[out.length - 1]?.push(list.coords[coord] ?? 0, list.coords[coord + 1] ?? 0)
			coord += 2
		}
	}

	return out
}

describe("chart trendlines", () => {
	it("draws a linear trendline through the categories, extended by c:forward", () => {
		const trend = `<c:trendline>${RED_LINE}<c:trendlineType val="linear"/></c:trendline>`
		const plain = convert(line(categorySeries([1, 2, 3], trend)))
		const forward = convert(line(categorySeries([1, 2, 3], trend.replace("</c:trendline>", '<c:forward val="1"/></c:trendline>'))))
		const [item] = strokedWith(plain.list, RED)

		expect(plain.unsupported).toEqual([])
		expect(item).toBeDefined()

		const [segment] = subpaths(plain.list, item ?? -1)

		// One straight segment, rising left to right.
		expect(segment).toHaveLength(4)
		expect(segment?.[2] ?? 0).toBeGreaterThan(segment?.[0] ?? 0)
		expect(segment?.[3] ?? 0).toBeLessThan(segment?.[1] ?? 0)

		const [longer] = subpaths(forward.list, strokedWith(forward.list, RED)[0] ?? -1)

		expect(longer?.[2] ?? 0).toBeGreaterThan(segment?.[2] ?? 0)
	})

	it("draws Office's default trendline: dotted in the series colour", () => {
		const result = convert(
			line(categorySeries([1, 3, 2], '<c:trendline><c:trendlineType val="poly"/><c:order val="2"/></c:trendline>'))
		)
		const dotted = []

		for (let item = 0; item < result.list.itemCount; item++) {
			const stroke = result.list.strokes[result.list.itemInt(item, ItemInt.STROKE)]

			if (stroke?.dash === "sysDot") dotted.push(stroke)
		}

		expect(dotted).toHaveLength(1)
		expect(result.list.paints[dotted[0]?.paint ?? -1]).toEqual({ kind: "solid", color: rgba("4472C4") })
	})

	it("does not draw an exponential trendline over a non-positive value, as Office refuses it", () => {
		const trend = `<c:trendline>${RED_LINE}<c:trendlineType val="exp"/></c:trendline>`

		expect(strokedWith(convert(line(categorySeries([1, 2, 4], trend))).list, RED)).toHaveLength(1)
		expect(strokedWith(convert(line(categorySeries([0, 2, 4], trend))).list, RED)).toHaveLength(0)
	})

	it("draws a moving average from the period's last point on", () => {
		const trend = `<c:trendline>${RED_LINE}<c:trendlineType val="movingAvg"/><c:period val="2"/></c:trendline>`
		const result = convert(line(categorySeries([2, 4, 6, 8], trend)))
		const parts = subpaths(result.list, strokedWith(result.list, RED)[0] ?? -1)

		// Three averages: one subpath of three points.
		expect(parts.flat()).toHaveLength(6)
	})

	it("reports trendline equation and R² labels as not drawn", () => {
		const labelled = '<c:trendline><c:trendlineType val="linear"/><c:dispRSqr val="0"/><c:dispEq val="1"/></c:trendline>'

		expect(convert(column(categorySeries([1, 2, 3], labelled))).unsupported).toEqual(["trendlineLbl"])
	})

	it("fits polynomials exactly, far from the origin and through a fixed intercept", () => {
		const xs = [1000, 1001, 1002, 1003, 1004, 1005]
		const cubic = (x: number) => 0.5 * (x - 1002) ** 3 - 2 * (x - 1002) + 7
		const fit = fitPolynomial(xs, xs.map(cubic), 3, undefined)

		expect(fit?.(1004.5)).toBeCloseTo(cubic(1004.5), 6)

		const quad = (x: number) => 2 * x * x - 3 * x + 5
		const fixed = fitPolynomial([1, 2, 3, 4], [1, 2, 3, 4].map(quad), 2, 5)

		expect(fixed?.(0)).toBe(5)
		expect(fixed?.(6)).toBeCloseTo(quad(6), 9)
		expect(fitPolynomial([1, 2], [1, 2], 2, undefined)).toBeUndefined()
	})

	it("fits a trendline over a large series within budget", () => {
		const values = Array.from({ length: 20000 }, (_, k) => Math.sin(k / 50) * 10 + k / 100)
		const trend = '<c:trendline><c:trendlineType val="poly"/><c:order val="6"/></c:trendline>'
		const plot = `<c:scatterChart><c:scatterStyle val="marker"/><c:ser><c:idx val="0"/><c:order val="0"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>${trend}<c:xVal>${numbers(values.map((_, k) => k))}</c:xVal><c:yVal>${numbers(values)}</c:yVal></c:ser><c:axId val="1"/><c:axId val="2"/></c:scatterChart>${XY_AXES}`
		const start = cpuMs()
		const result = convert(plot)

		expect(cpuMs() - start).toBeLessThan(budget(1500))
		expect(result.list.coords.subarray(0, result.list.coordCount).every(Number.isFinite)).toBe(true)
	})
})

describe("chart error bars", () => {
	const bars = (body: string): string => `<c:errBars>${body}${RED_LINE}</c:errBars>`

	it("draws fixed-value error bars with end caps on each column", () => {
		const result = convert(
			column(categorySeries([1, 2, 3], bars('<c:errBarType val="both"/><c:errValType val="fixedVal"/><c:val val="0.5"/>')))
		)
		const items = strokedWith(result.list, RED)

		expect(result.unsupported).toEqual([])
		expect(items).toHaveLength(1)

		const parts = subpaths(result.list, items[0] ?? -1)

		// A bar and two caps per point.
		expect(parts).toHaveLength(9)

		const lengths = [0, 3, 6].map(k => Math.abs((parts[k]?.[3] ?? 0) - (parts[k]?.[1] ?? 0)))

		expect(lengths[0]).toBeGreaterThan(0)
		expect(lengths[1]).toBeCloseTo(lengths[0] ?? 0, 3)
		expect(lengths[2]).toBeCloseTo(lengths[0] ?? 0, 3)
	})

	it("sizes percentage bars by each value and leaves out the caps under c:noEndCap", () => {
		const result = convert(
			column(
				categorySeries(
					[1, 2, 4],
					bars('<c:errBarType val="plus"/><c:errValType val="percentage"/><c:noEndCap val="1"/><c:val val="50"/>')
				)
			)
		)
		const parts = subpaths(result.list, strokedWith(result.list, RED)[0] ?? -1)
		const lengths = parts.map(part => Math.abs((part[3] ?? 0) - (part[1] ?? 0)))

		expect(parts).toHaveLength(3)
		expect((lengths[1] ?? 0) / (lengths[0] ?? 1)).toBeCloseTo(2, 3)
		expect((lengths[2] ?? 0) / (lengths[0] ?? 1)).toBeCloseTo(4, 3)
	})

	it("centres standard deviation bars on the series mean, as Office does", () => {
		const result = convert(
			line(
				categorySeries(
					[1, 2, 3],
					bars('<c:errBarType val="both"/><c:errValType val="stdDev"/><c:noEndCap val="1"/><c:val val="1"/>')
				)
			)
		)
		const parts = subpaths(result.list, strokedWith(result.list, RED)[0] ?? -1)

		expect(parts).toHaveLength(3)

		// Mean 2, deviation 1: every bar spans 1..3.
		for (const part of parts) {
			expect(part[1]).toBeCloseTo(parts[0]?.[1] ?? 0, 3)
			expect(part[3]).toBeCloseTo(parts[0]?.[3] ?? 0, 3)
		}
	})

	it("applies a single custom amount to every point and widens the value axis to the bars' ends", () => {
		const custom =
			'<c:errBarType val="both"/><c:errValType val="cust"/><c:noEndCap val="1"/><c:plus><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>10</c:v></c:pt></c:numLit></c:plus><c:minus><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>0</c:v></c:pt></c:numLit></c:minus><c:val val="0"/>'
		const result = convert(column(categorySeries([1, 2, 3], bars(custom))))
		const parts = subpaths(result.list, strokedWith(result.list, RED)[0] ?? -1)
		const lengths = parts.map(part => Math.abs((part[3] ?? 0) - (part[1] ?? 0)))

		expect(parts).toHaveLength(3)
		// The axis reaches 13, so no bar is cut at the plot's top: all three are as long.
		expect(lengths[1]).toBeCloseTo(lengths[0] ?? 0, 3)
		expect(lengths[2]).toBeCloseTo(lengths[0] ?? 0, 3)
	})

	it("draws x error bars of a scatter series across", () => {
		const plot = `<c:scatterChart><c:scatterStyle val="marker"/><c:ser><c:idx val="0"/><c:order val="0"/>${bars('<c:errDir val="x"/><c:errBarType val="both"/><c:errValType val="fixedVal"/><c:noEndCap val="1"/><c:val val="1"/>')}<c:xVal>${numbers([2, 4, 6])}</c:xVal><c:yVal>${numbers([1, 2, 3])}</c:yVal></c:ser><c:axId val="1"/><c:axId val="2"/></c:scatterChart>${XY_AXES}`
		const result = convert(plot)
		const parts = subpaths(result.list, strokedWith(result.list, RED)[0] ?? -1)

		expect(parts).toHaveLength(3)

		for (const part of parts) {
			expect(part[1]).toBe(part[3])
			expect(Math.abs((part[2] ?? 0) - (part[0] ?? 0))).toBeGreaterThan(0)
		}
	})
})

describe("chart drop lines", () => {
	it("drops a line from each category's points to the category axis", () => {
		const result = convert(line(categorySeries([1, 3, 2], ""), `<c:dropLines>${RED_LINE}</c:dropLines>`))
		const items = strokedWith(result.list, RED)

		expect(result.unsupported).toEqual([])
		expect(items).toHaveLength(1)

		const parts = subpaths(result.list, items[0] ?? -1)

		expect(parts).toHaveLength(3)

		// Vertical, all ending on the axis line.
		for (const part of parts) {
			expect(part[0]).toBe(part[2])
			expect(part[3]).toBeCloseTo(parts[0]?.[3] ?? 0, 3)
		}
	})
})

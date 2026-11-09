import { describe, expect, it } from "vitest"
import { boxStats, chartexDrawable, histogramBins, quantile, squarify } from "../core/drawingml/chart/chartex"
import { convertChart } from "../core/drawingml/chart/index"
import { drawingTheme } from "../core/drawingml/color"
import { DrawingList, ItemFloat, ItemInt, ItemKind, rgba, type DrawingText } from "../core/drawingml/displayList"
import type { PaintContext } from "../core/drawingml/fill"
import { parseXml, type XmlDocument } from "../core/xml/index"
import { budget, cpuMs } from "./timing"

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

function context(): PaintContext {
	return { list: new DrawingList(), theme: drawingTheme(undefined, name => SCHEME[name]), images: () => undefined, effects: false }
}

function level(values: readonly (string | number)[], format: string = ""): string {
	const points = values.map((value, index) => (value === "" ? "" : `<cx:pt idx="${index}">${value}</cx:pt>`)).join("")

	return `<cx:lvl ptCount="${values.length}"${format === "" ? "" : ` formatCode="${format}"`}>${points}</cx:lvl>`
}

// One cx:data: category levels (leaf first) and values.
function data(id: number, levels: readonly (readonly string[])[], values: readonly number[], type: string = "val"): string {
	const categories =
		levels.length === 0 ? "" : `<cx:strDim type="cat"><cx:f>S!A1</cx:f>${levels.map(names => level(names)).join("")}</cx:strDim>`

	return `<cx:data id="${id}">${categories}<cx:numDim type="${type}"><cx:f>S!B1</cx:f>${level(values, "General")}</cx:numDim></cx:data>`
}

function seriesXml(layout: string, id: number, name: string, inner: string = "", attrs: string = ""): string {
	return `<cx:series layoutId="${layout}"${attrs}><cx:tx><cx:txData><cx:f>S!B1</cx:f><cx:v>${name}</cx:v></cx:txData></cx:tx>${inner}<cx:dataId val="${id}"/></cx:series>`
}

const AXES =
	'<cx:axis id="0"><cx:catScaling gapWidth="0.5"/><cx:tickLabels/></cx:axis><cx:axis id="1"><cx:valScaling/><cx:majorGridlines/><cx:tickLabels/></cx:axis>'

function part(chartData: string, series: string, extra: string = "", axes: string = AXES): XmlDocument {
	return parseXml(
		new TextEncoder().encode(
			`<?xml version="1.0" encoding="UTF-8"?><cx:chartSpace xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chartData>${chartData}</cx:chartData><cx:chart>${extra}<cx:plotArea><cx:plotAreaRegion>${series}</cx:plotAreaRegion>${axes}</cx:plotArea></cx:chart></cx:chartSpace>`
		)
	)
}

function convert(chartData: string, series: string, extra: string = "", axes: string = AXES) {
	const ctx = context()
	const document = part(chartData, series, extra, axes)

	return convertChart(ctx, document, 480 * EMU, 320 * EMU)
}

function texts(list: DrawingList): string[] {
	const out: string[] = []

	for (let item = 0; item < list.itemCount; item++) {
		if (list.kind(item) !== ItemKind.TEXT) continue

		const text = list.texts[list.itemInt(item, ItemInt.REF)] as DrawingText

		if (text.kind === "body") out.push(text.paragraphs.map(p => p.runs.map(r => r.text).join("")).join("\n"))
	}

	return out
}

interface Box {
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
}

// Boxes of the path items filled with `color`.
function filled(list: DrawingList, color: number): Box[] {
	const out: Box[] = []

	for (let item = 0; item < list.itemCount; item++) {
		if (list.kind(item) !== ItemKind.PATH) continue

		const paint = list.paints[list.itemInt(item, ItemInt.FILL)]

		if (paint?.kind !== "solid" || paint.color !== color) continue

		out.push({
			x: list.itemFloat(item, ItemFloat.X),
			y: list.itemFloat(item, ItemFloat.Y),
			w: list.itemFloat(item, ItemFloat.WIDTH),
			h: list.itemFloat(item, ItemFloat.HEIGHT)
		})
	}

	return out
}

const BLUE = rgba("4472C4")
const ORANGE = rgba("ED7D31")
const GRAY = rgba("A5A5A5")

describe("chartexDrawable", () => {
	it("draws a visible series of a drawn layout, not region maps, hidden or Pareto-only series, or c:chartSpace", () => {
		const values = data(0, [["A", "B"]], [1, 2])

		expect(chartexDrawable(part(values, seriesXml("waterfall", 0, "S")))).toBe(true)
		expect(chartexDrawable(part(values, seriesXml("regionMap", 0, "S")))).toBe(false)
		expect(chartexDrawable(part(values, seriesXml("treemap", 0, "S", "", ' hidden="1"')))).toBe(false)
		expect(chartexDrawable(part(values, seriesXml("paretoLine", 0, "S")))).toBe(false)
		expect(chartexDrawable(part(values, ""))).toBe(false)
		expect(
			chartexDrawable(
				parseXml(new TextEncoder().encode('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>'))
			)
		).toBe(false)
	})
})

describe("chartex statistics", () => {
	it("computes quartiles as QUARTILE.EXC and QUARTILE.INC", () => {
		const sorted = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])

		expect(quantile(sorted, 0.25, true)).toBe(2.5)
		expect(quantile(sorted, 0.75, true)).toBe(7.5)
		expect(quantile(sorted, 0.25, false)).toBe(3)
		expect(quantile(sorted, 0.75, false)).toBe(7)
		expect(quantile(sorted, 0.5, true)).toBe(5)
	})

	it("separates outliers beyond 1.5 interquartile ranges", () => {
		const stats = boxStats(Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 100]), true)

		expect(stats).toMatchObject({ low: 1, high: 8, median: 5, outliers: [100] })
	})

	it("bins like Excel's histogram", () => {
		const values = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

		expect(
			histogramBins(values, { size: 3, count: undefined, underflow: undefined, overflow: undefined, right: true }, "General")
		).toEqual([
			{ label: "[1, 4]", count: 4 },
			{ label: "(4, 7]", count: 3 },
			{ label: "(7, 10]", count: 3 }
		])
		// <=3, (3, 5.5], (5.5, 8], >8.
		expect(histogramBins(values, { size: undefined, count: 2, underflow: 3, overflow: 8, right: true }, "General")).toEqual([
			{ label: "≤3", count: 3 },
			{ label: "(3, 5.5]", count: 2 },
			{ label: "(5.5, 8]", count: 3 },
			{ label: ">8", count: 2 }
		])
	})

	it("squarifies areas in proportion to the sizes", () => {
		const rects = squarify([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, w: 6, h: 4 })
		const areas = rects.map(rect => rect.w * rect.h)

		areas.forEach((area, index) => expect(area).toBeCloseTo([6, 6, 4, 3, 2, 2, 1][index] ?? 0, 6))

		for (const rect of rects) {
			expect(rect.x).toBeGreaterThanOrEqual(-1e-9)
			expect(rect.y).toBeGreaterThanOrEqual(-1e-9)
			expect(rect.x + rect.w).toBeLessThanOrEqual(6 + 1e-9)
			expect(rect.y + rect.h).toBeLessThanOrEqual(4 + 1e-9)
		}
	})
})

describe("chartex charts", () => {
	it("draws a waterfall with increases, decreases and totals", () => {
		const series = seriesXml(
			"waterfall",
			0,
			"Cash",
			'<cx:dataLabels pos="outEnd"><cx:visibility seriesName="0" categoryName="0" value="1"/></cx:dataLabels><cx:layoutPr><cx:subtotals><cx:idx val="3"/></cx:subtotals></cx:layoutPr>'
		)
		const result = convert(
			data(0, [["Start", "Up", "Down", "End"]], [100, 50, -30, 120]),
			series,
			'<cx:legend pos="t" align="ctr" overlay="0"/>'
		)

		expect(result).toMatchObject({ supported: true, plots: ["waterfall"], unsupported: [] })

		const increases = filled(result.list, BLUE)
		const decreases = filled(result.list, ORANGE)
		const totals = filled(result.list, GRAY)

		// Two increases and the legend key; one decrease and its key; one total and its key.
		expect(increases).toHaveLength(3)
		expect(decreases).toHaveLength(2)
		expect(totals).toHaveLength(2)

		const [start, up] = increases
		const [down] = decreases
		const [end] = totals

		// "Up" floats on top of "Start", "Down" hangs from the running total, the total stands on zero.
		expect(up?.y ?? 0).toBeLessThan(start?.y ?? 0)
		expect((up?.y ?? 0) + (up?.h ?? 0)).toBeCloseTo(start?.y ?? 0, 2)
		expect(down?.y).toBeCloseTo(up?.y ?? 0, 2)
		expect((end?.y ?? 0) + (end?.h ?? 0)).toBeCloseTo((start?.y ?? 0) + (start?.h ?? 0), 2)
		expect(texts(result.list)).toEqual(expect.arrayContaining(["Start", "End", "100", "-30", "120", "Increase", "Decrease", "Total"]))
	})

	it("draws a funnel of centred bars", () => {
		const result = convert(
			data(0, [["Leads", "Calls", "Deals"]], [400, 200, 100]),
			seriesXml("funnel", 0, "Pipeline", '<cx:dataLabels pos="inEnd"><cx:visibility value="1"/></cx:dataLabels>'),
			"",
			'<cx:axis id="0"><cx:catScaling gapWidth="0.06"/><cx:tickLabels/></cx:axis>'
		)

		expect(result.supported).toBe(true)

		const bars = filled(result.list, BLUE)

		expect(bars).toHaveLength(3)

		const centres = bars.map(bar => bar.x + bar.w / 2)

		expect(centres[1]).toBeCloseTo(centres[0] ?? 0, 2)
		expect(centres[2]).toBeCloseTo(centres[0] ?? 0, 2)
		expect((bars[1]?.w ?? 0) / (bars[0]?.w ?? 1)).toBeCloseTo(0.5, 2)
		expect(texts(result.list)).toEqual(expect.arrayContaining(["Leads", "Deals", "400", "100"]))
	})

	it("draws a histogram from its binning", () => {
		const result = convert(
			data(0, [], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
			seriesXml(
				"clusteredColumn",
				0,
				"Ages",
				'<cx:layoutPr><cx:binning intervalClosed="r"><cx:binSize val="3"/></cx:binning></cx:layoutPr>'
			),
			"",
			'<cx:axis id="0"><cx:catScaling gapWidth="0"/><cx:tickLabels/></cx:axis><cx:axis id="1"><cx:valScaling/><cx:tickLabels/></cx:axis>'
		)

		expect(result.supported).toBe(true)

		const columns = filled(result.list, BLUE)

		expect(columns).toHaveLength(3)
		// Bins of 4, 3 and 3 values, touching (gap width 0).
		expect((columns[1]?.h ?? 0) / (columns[0]?.h ?? 1)).toBeCloseTo(0.75, 2)
		expect(columns[1]?.x).toBeCloseTo((columns[0]?.x ?? 0) + (columns[0]?.w ?? 0), 2)
		expect(texts(result.list)).toEqual(expect.arrayContaining(["[1, 4]", "(4, 7]", "(7, 10]"]))
	})

	it("draws a Pareto chart sorted largest first with its cumulative line", () => {
		const series =
			seriesXml("clusteredColumn", 0, "Count", "<cx:layoutPr><cx:aggregation/></cx:layoutPr>") +
			seriesXml("paretoLine", 0, "Cumulative", "", ' ownerIdx="0"')
		const axes = `${AXES}<cx:axis id="2"><cx:valScaling max="1" min="0"/><cx:units unit="percentage"/><cx:tickLabels/></cx:axis>`
		const result = convert(data(0, [["B", "A", "C", "A"]], [2, 5, 1, 3]), series, "", axes)

		expect(result).toMatchObject({ supported: true, plots: ["clusteredColumn", "paretoLine"], unsupported: [] })

		const columns = filled(result.list, BLUE)

		expect(columns).toHaveLength(3)
		// A (8), B (2), C (1).
		expect(columns[0]?.h).toBeGreaterThan(columns[1]?.h ?? 0)
		expect(columns[1]?.h).toBeGreaterThan(columns[2]?.h ?? 0)

		const labels = texts(result.list)

		expect(labels.indexOf("A")).toBeLessThan(labels.indexOf("B"))
		expect(labels.indexOf("B")).toBeLessThan(labels.indexOf("C"))
		expect(labels).toEqual(expect.arrayContaining(["0%", "100%"]))
	})

	it("draws a box per category and series", () => {
		const values = [1, 2, 3, 4, 5, 6, 7, 8, 100, 10, 20, 30]
		const names = ["X", "X", "X", "X", "X", "X", "X", "X", "X", "Y", "Y", "Y"]
		const result = convert(
			data(0, [names], values),
			seriesXml(
				"boxWhisker",
				0,
				"Scores",
				'<cx:layoutPr><cx:visibility meanMarker="1" outliers="1"/><cx:statistics quartileMethod="exclusive"/></cx:layoutPr>'
			)
		)

		expect(result.supported).toBe(true)
		expect(filled(result.list, BLUE).length).toBeGreaterThanOrEqual(2)
		expect(texts(result.list)).toEqual(expect.arrayContaining(["X", "Y"]))
	})

	it("draws a treemap whose areas follow the values, coloured by branch", () => {
		const leaves = ["a1", "a2", "b1"]
		const branches = ["A", "A", "B"]
		const result = convert(
			data(0, [leaves, branches], [3, 1, 4], "size"),
			seriesXml(
				"treemap",
				0,
				"Sizes",
				'<cx:dataLabels pos="inEnd"><cx:visibility categoryName="1"/></cx:dataLabels><cx:layoutPr><cx:parentLabelLayout val="overlapping"/></cx:layoutPr>'
			),
			"",
			""
		)

		expect(result.supported).toBe(true)

		const a = filled(result.list, BLUE)
		const b = filled(result.list, ORANGE)
		const area = (boxes: readonly Box[]): number => boxes.reduce((sum, box) => sum + box.w * box.h, 0)

		expect(a).toHaveLength(2)
		expect(b).toHaveLength(1)
		expect(area(a) / area(b)).toBeCloseTo(1, 4)
		expect(((a[0]?.w ?? 0) * (a[0]?.h ?? 0)) / ((a[1]?.w ?? 0) * (a[1]?.h ?? 1))).toBeCloseTo(3, 4)
		expect(texts(result.list)).toEqual(expect.arrayContaining(["a1", "b1", "A"]))
	})

	it("draws a sunburst of rings", () => {
		const result = convert(
			data(
				0,
				[
					["a1", "a2", "b1"],
					["A", "A", "B"]
				],
				[3, 1, 4],
				"size"
			),
			seriesXml("sunburst", 0, "Sizes"),
			"",
			""
		)

		expect(result.supported).toBe(true)
		// Two branches in the inner ring, three leaves in the outer.
		expect(filled(result.list, BLUE)).toHaveLength(3)
		expect(filled(result.list, ORANGE)).toHaveLength(2)
	})

	it("reports layouts it does not draw", () => {
		expect(convert(data(0, [["FR"]], [1]), seriesXml("regionMap", 0, "Map"), "", "")).toMatchObject({
			supported: false,
			plots: ["regionMap"],
			unsupported: ["chartex:regionMap"]
		})
	})

	it("bins a large histogram within budget", () => {
		const values = Array.from({ length: 200000 }, (_, k) => (k * 7919) % 1000)
		const document = part(data(0, [], values), seriesXml("clusteredColumn", 0, "Big", "<cx:layoutPr><cx:binning/></cx:layoutPr>"))
		const start = cpuMs()
		const result = convertChart(context(), document, 480 * EMU, 320 * EMU)

		expect(result.supported).toBe(true)
		expect(cpuMs() - start).toBeLessThan(budget(1500))
		expect(result.list.itemCount).toBeLessThan(2000)
	})
})

import { describe, expect, it } from "vitest"
import { computeScale, convertChart, formatNumber, scaleTicks } from "../core/drawingml/chart/index"
import { drawingTheme } from "../core/drawingml/color"
import { DrawingList, ItemFloat, ItemInt, ItemKind, rgba, type DrawingText } from "../core/drawingml/displayList"
import type { PaintContext } from "../core/drawingml/fill"
import { parseXml } from "../core/xml/index"
import { budget } from "./timing"

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

function chartPart(plotArea: string, extra: string = ""): Uint8Array {
	return new TextEncoder().encode(
		`<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:roundedCorners val="0"/><c:chart>${extra}<c:plotArea><c:layout/>${plotArea}</c:plotArea></c:chart></c:chartSpace>`
	)
}

function numbers(values: readonly (number | null)[]): string {
	const points = values.map((value, index) => (value === null ? "" : `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`)).join("")

	return `<c:numRef><c:f>S!A1</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${points}</c:numCache></c:numRef>`
}

function strings(values: readonly string[]): string {
	return `<c:strRef><c:f>S!A1</c:f><c:strCache><c:ptCount val="${values.length}"/>${values.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join("")}</c:strCache></c:strRef>`
}

function series(
	index: number,
	name: string,
	values: readonly (number | null)[],
	categories: readonly string[],
	extra: string = ""
): string {
	return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx>${strings([name])}</c:tx>${extra}<c:cat>${strings(categories)}</c:cat><c:val>${numbers(values)}</c:val></c:ser>`
}

const AXES =
	'<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>'

const CATS = ["A", "B", "C"]

function convert(plotArea: string, extra: string = "", width: number = 480, height: number = 320) {
	const ctx = context()
	const result = convertChart(ctx, parseXml(chartPart(plotArea, extra)), width * EMU, height * EMU)

	return { ...result, list: result.list }
}

function items(list: DrawingList, kind: number): number[] {
	const out: number[] = []

	for (let item = 0; item < list.itemCount; item++) if (list.kind(item) === kind) out.push(item)

	return out
}

function texts(list: DrawingList): string[] {
	return items(list, ItemKind.TEXT).map(item => {
		const text = list.texts[list.itemInt(item, ItemInt.REF)] as DrawingText

		return text.kind === "body" ? text.paragraphs.map(p => p.runs.map(r => r.text).join("")).join("\n") : ""
	})
}

// Path items carrying `paint` as fill.
function filledWith(list: DrawingList, color: number): number[] {
	return items(list, ItemKind.PATH).filter(item => {
		const paint = list.paints[list.itemInt(item, ItemInt.FILL)]

		return paint?.kind === "solid" && paint.color === color
	})
}

describe("chart number formats", () => {
	it("formats the codes charts use", () => {
		expect(formatNumber(4.4000000000000004, "General")).toBe("4.4")
		expect(formatNumber(1234567.891, "#,##0")).toBe("1,234,568")
		expect(formatNumber(0.256, "0%")).toBe("26%")
		expect(formatNumber(0.256, "0.0%")).toBe("25.6%")
		expect(formatNumber(3, "0.00")).toBe("3.00")
		expect(formatNumber(-3.5, "0.0")).toBe("-3.5")
		expect(formatNumber(1500, '"$"#,##0.00')).toBe("$1,500.00")
		expect(formatNumber(12345, "0.00E+00")).toBe("1.23E+04")
		expect(formatNumber(45000, "mmm-yy")).toBe("Mar-23")
		expect(formatNumber(45000, "d/m/yyyy")).toBe("15/3/2023")
		expect(formatNumber(Number.NaN, "General")).toBe("")
	})
})

describe("chart scales", () => {
	it("picks zero-based nice ranges with headroom", () => {
		const scale = computeScale({
			dataMin: 1.8,
			dataMax: 5,
			min: undefined,
			max: undefined,
			major: undefined,
			logBase: 0,
			maxIntervals: 8,
			percent: false
		})

		expect(scale.min).toBe(0)
		expect(scale.max).toBe(6)
		expect(scale.major).toBe(1)
		expect(scaleTicks(scale)).toEqual([0, 1, 2, 3, 4, 5, 6])
	})

	it("honours explicit bounds, negative data and percent ranges", () => {
		expect(
			computeScale({
				dataMin: -7,
				dataMax: 12,
				min: undefined,
				max: undefined,
				major: undefined,
				logBase: 0,
				maxIntervals: 6,
				percent: false
			})
		).toMatchObject({ min: -10, max: 15, major: 5 })
		expect(
			computeScale({
				dataMin: 0,
				dataMax: 1,
				min: undefined,
				max: undefined,
				major: undefined,
				logBase: 0,
				maxIntervals: 10,
				percent: true
			})
		).toMatchObject({ min: 0, max: 1, major: 0.1 })
		expect(
			computeScale({ dataMin: 3, dataMax: 40, min: 2, max: 50, major: 4, logBase: 0, maxIntervals: 6, percent: false })
		).toMatchObject({ min: 2, max: 50, major: 4 })
		expect(
			computeScale({
				dataMin: 3,
				dataMax: 4000,
				min: undefined,
				max: undefined,
				major: undefined,
				logBase: 10,
				maxIntervals: 6,
				percent: false
			})
		).toMatchObject({ min: 1, max: 10000, logBase: 10 })
	})
})

describe("bar charts", () => {
	const plot = (grouping: string, dir: string = "col"): string =>
		`<c:barChart><c:barDir val="${dir}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series(0, "One", [4.3, 2.5, 3.5], CATS)}${series(1, "Two", [2.4, 4.4, 1.8], CATS)}<c:gapWidth val="150"/>${grouping === "clustered" ? "" : '<c:overlap val="100"/>'}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`

	it("draws one path per series with a rectangle per point", () => {
		const { list, supported, plots } = convert(plot("clustered"))

		expect(supported).toBe(true)
		expect(plots).toEqual(["barChart"])

		const first = filledWith(list, rgba("4472C4"))
		const second = filledWith(list, rgba("ED7D31"))

		expect(first).toHaveLength(1)
		expect(second).toHaveLength(1)
		// Three closed rectangles of five commands each.
		expect(list.itemInt(first[0] ?? 0, ItemInt.COMMAND_COUNT)).toBe(15)
		expect(texts(list)).toEqual(["A", "B", "C", "0", "1", "2", "3", "4", "5"])
	})

	it("places bars from the value axis crossing to the value", () => {
		const { list } = convert(plot("clustered"))
		const item = filledWith(list, rgba("4472C4"))[0] ?? 0
		const coords = list.coords.subarray(list.itemInt(item, ItemInt.FIRST_COORD))
		// First rectangle: top edge at 4.3 of a 0..5 axis (5 = 4.3 headroom rule keeps max at 5).
		const bottom = coords[5] ?? 0
		const top = coords[1] ?? 0

		expect(bottom).toBeGreaterThan(top)
		expect(list.itemBounds[item * 4 + 3]).toBeCloseTo(bottom, 3)
	})

	it("stacks and normalises percent-stacked bars", () => {
		const stacked = convert(plot("stacked")).list
		const percent = convert(plot("percentStacked")).list

		expect(texts(stacked)).toContain("8")
		expect(texts(percent)).toEqual(expect.arrayContaining(["0%", "100%"]))
	})

	it("draws horizontal bars with the category axis on the left", () => {
		const { list } = convert(plot("clustered", "bar"))
		const item = filledWith(list, rgba("4472C4"))[0] ?? 0
		const coords = list.coords.subarray(list.itemInt(item, ItemInt.FIRST_COORD))

		// The first rectangle is wider than tall (its length runs along x).
		expect(Math.abs((coords[2] ?? 0) - (coords[0] ?? 0))).toBeGreaterThan(Math.abs((coords[5] ?? 0) - (coords[1] ?? 0)))
	})

	it("treats 3D bars as flat bars and paints overridden points separately", () => {
		const plotArea = `<c:bar3DChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series(0, "One", [1, 2, 3], CATS, '<c:spPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></c:spPr><c:dPt><c:idx val="1"/><c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr></c:dPt>')}<c:axId val="1"/><c:axId val="2"/><c:axId val="3"/></c:bar3DChart>${AXES}`
		const { list } = convert(plotArea)

		expect(filledWith(list, rgba("112233"))).toHaveLength(1)
		expect(filledWith(list, rgba("FF0000"))).toHaveLength(1)
	})

	it("varies colours per point for a single series", () => {
		const plotArea = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="1"/>${series(0, "One", [1, 2, 3], CATS)}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}<c:legend/>`
		const { list } = convert(plotArea, "")

		expect(filledWith(list, rgba("4472C4")).length).toBeGreaterThan(0)
		expect(filledWith(list, rgba("ED7D31")).length).toBeGreaterThan(0)
		expect(filledWith(list, rgba("A5A5A5")).length).toBeGreaterThan(0)
	})

	it("adds data labels, legend and title", () => {
		const plotArea = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series(0, "One", [1, 2, 3], CATS)}<c:dLbls><c:showVal val="1"/></c:dLbls><c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`
		const title =
			'<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:rPr sz="1400"/><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>'
		const ctx = context()
		const part = new TextEncoder().encode(
			`<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>${title}<c:plotArea>${plotArea}</c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`
		)
		const { list } = convertChart(ctx, parseXml(part), 400 * EMU, 300 * EMU)
		const all = texts(list)

		expect(all).toEqual(expect.arrayContaining(["Sales", "One", "1", "2", "3"]))

		// The title sits above the plot; the legend below it.
		const titleItem = items(list, ItemKind.TEXT).find((_, index) => all[index] === "Sales") ?? 0

		expect(list.itemFloat(titleItem, ItemFloat.Y)).toBeLessThan(40)
	})
})

describe("line, area and scatter charts", () => {
	it("draws lines with markers, gaps and smoothing", () => {
		const plotArea = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series(0, "One", [1, null, 3, 4], ["a", "b", "c", "d"], '<c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>')}${series(1, "Two", [2, 3, 1, 2], ["a", "b", "c", "d"], '<c:marker><c:symbol val="none"/></c:marker><c:smooth val="1"/>')}<c:marker val="1"/><c:axId val="1"/><c:axId val="2"/></c:lineChart>${AXES}`
		const { list } = convert(plotArea, '<c:dispBlanksAs val="gap"/>')
		const strokes = items(list, ItemKind.PATH).filter(
			item => list.itemInt(item, ItemInt.FILL) < 0 && list.itemInt(item, ItemInt.STROKE) >= 0
		)
		const commands = (item: number): number[] =>
			Array.from(
				list.commands.subarray(
					list.itemInt(item, ItemInt.FIRST_COMMAND),
					list.itemInt(item, ItemInt.FIRST_COMMAND) + list.itemInt(item, ItemInt.COMMAND_COUNT)
				)
			)
		const lineOne = strokes.find(item => commands(item).filter(command => command === 0).length === 2)
		const lineTwo = strokes.find(item => commands(item).includes(2) && commands(item).length === 4)

		// The gap splits the first line into two subpaths; the second is smoothed into cubics.
		expect(lineOne).toBeDefined()
		expect(lineTwo).toBeDefined()
		// Markers: three circles of the first series.
		expect(filledWith(list, rgba("4472C4"))).toHaveLength(1)
	})

	it("stacks areas onto the previous series", () => {
		const plotArea = `<c:areaChart><c:grouping val="stacked"/>${series(0, "One", [1, 2, 3], CATS)}${series(1, "Two", [1, 1, 1], CATS)}<c:axId val="1"/><c:axId val="2"/></c:areaChart>${AXES}`
		const { list } = convert(plotArea)

		expect(filledWith(list, rgba("4472C4"))).toHaveLength(1)
		expect(filledWith(list, rgba("ED7D31"))).toHaveLength(1)
		expect(texts(list)).toContain("4")
	})

	it("plots scatter series on two value axes", () => {
		const scatter = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:ser><c:idx val="0"/><c:order val="0"/><c:xVal>${numbers([1, 2, 4])}</c:xVal><c:yVal>${numbers([10, 20, 15])}</c:yVal></c:ser><c:axId val="5"/><c:axId val="6"/></c:scatterChart><c:valAx><c:axId val="5"/><c:scaling/><c:axPos val="b"/><c:crossAx val="6"/></c:valAx><c:valAx><c:axId val="6"/><c:scaling/><c:axPos val="l"/><c:crossAx val="5"/></c:valAx>`
		const { list, supported } = convert(scatter)

		expect(supported).toBe(true)
		expect(texts(list)).toEqual(expect.arrayContaining(["0", "4", "25"]))
	})
})

describe("bubble charts", () => {
	const bubble = (scale: string = "", sizes: readonly (number | null)[] = [10, 4, 8], extra: string = "") =>
		`<c:bubbleChart><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx>${strings(["Y-Value 1"])}</c:tx><c:xVal>${numbers([0.7, 1.8, 2.6])}</c:xVal><c:yVal>${numbers([2.7, 3.2, 0.8])}</c:yVal><c:bubbleSize>${numbers(sizes)}</c:bubbleSize></c:ser>${scale}${extra}<c:axId val="5"/><c:axId val="6"/></c:bubbleChart><c:valAx><c:axId val="5"/><c:scaling/><c:axPos val="b"/><c:crossAx val="6"/></c:valAx><c:valAx><c:axId val="6"/><c:scaling/><c:axPos val="l"/><c:crossAx val="5"/></c:valAx>`
	// The circles' diameters, px, largest first.
	const diameters = (list: DrawingList): number[] => {
		const out: number[] = []

		for (const item of filledWith(list, rgba("4472C4"))) {
			const first = list.itemInt(item, ItemInt.FIRST_COORD)
			let end = list.coordCount
			let min = Infinity
			let max = -Infinity

			// The item's coordinates run to the next item's first (a circle's control points stay within its box).
			for (let other = 0; other < list.itemCount; other++) {
				const start = list.itemInt(other, ItemInt.FIRST_COORD)

				if (start > first && start < end) end = start
			}

			for (let k = first; k + 1 < end; k += 2) {
				min = Math.min(min, list.coords[k] ?? Infinity)
				max = Math.max(max, list.coords[k] ?? -Infinity)
			}

			out.push(max - min)
		}

		return out.sort((a, b) => b - a)
	}

	it("draws a circle per point, its area proportional to the bubble size, the largest a quarter of the plot's shorter side", () => {
		const result = convert(bubble())

		expect(result).toMatchObject({ supported: true, plots: ["bubbleChart"], unsupported: [] })

		const [large = 0, middle = 0, small = 0] = diameters(result.list)

		expect(diameters(result.list)).toHaveLength(3)
		expect(middle / large).toBeCloseTo(Math.sqrt(8 / 10), 2)
		expect(small / large).toBeCloseTo(Math.sqrt(4 / 10), 2)
		expect(large).toBeGreaterThan(40)
		expect(large).toBeLessThan(100)
	})

	it("scales bubbles by c:bubbleScale and by width when c:sizeRepresents says so", () => {
		const [full = 0] = diameters(convert(bubble()).list)
		const [scaled = 0] = diameters(convert(bubble('<c:bubbleScale val="50"/>')).list)
		const widths = diameters(convert(bubble("", [10, 4, 8], '<c:sizeRepresents val="w"/>')).list)

		expect(scaled / full).toBeCloseTo(0.5, 2)
		expect((widths[2] ?? 0) / (widths[0] ?? 1)).toBeCloseTo(0.4, 2)
	})

	it("leaves out bubbles of no size or a negative one unless c:showNegBubbles", () => {
		const hidden = convert(bubble("", [10, 0, -8])).list
		const shown = convert(bubble("", [10, 0, -8], '<c:showNegBubbles val="1"/>')).list

		expect(diameters(hidden)).toHaveLength(1)
		// The negative bubble is drawn hollow.
		expect(diameters(shown)).toHaveLength(1)
		expect(items(shown, ItemKind.PATH).length).toBe(items(hidden, ItemKind.PATH).length + 1)
	})
})

describe("surface charts", () => {
	const SURFACE_AXES =
		'<c:catAx><c:axId val="1"/><c:scaling/><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:min val="0"/><c:max val="30"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorUnit val="10"/><c:crossAx val="1"/></c:valAx><c:serAx><c:axId val="3"/><c:scaling/><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:serAx>'
	const surface = (element: string = "surfaceChart", extra: string = "") =>
		`<c:${element}>${extra}${series(0, "Front", [0, 10, 20], CATS)}${series(1, "Back", [10, 20, 30], CATS)}<c:axId val="1"/><c:axId val="2"/><c:axId val="3"/></c:${element}>${SURFACE_AXES}`
	const legend = '<c:legend><c:legendPos val="r"/></c:legend>'

	it("fills each value band of the grid with its colour, names the bands in the legend and the series up the side", () => {
		const result = convert(surface(), legend)
		const list = result.list

		expect(result).toMatchObject({ supported: true, plots: ["surfaceChart"], unsupported: [] })
		// Three bands of 10 from the axis's ticks, each one path in the series colours.
		expect(filledWith(list, rgba("4472C4"))).toHaveLength(2)
		expect(filledWith(list, rgba("ED7D31"))).toHaveLength(2)
		expect(filledWith(list, rgba("A5A5A5"))).toHaveLength(2)
		expect(texts(list)).toEqual(expect.arrayContaining(["0-10", "10-20", "20-30", "Front", "Back", "A", "C"]))
		// The value axis is the bands: its tick labels are not drawn.
		expect(texts(list)).not.toContain("30")
	})

	it("draws a wireframe's band edges as lines instead", () => {
		const list = convert(surface("surfaceChart", '<c:wireframe val="1"/>')).list

		expect(filledWith(list, rgba("ED7D31"))).toHaveLength(0)

		const stroked = items(list, ItemKind.PATH).filter(item => {
			const stroke = list.strokes[list.itemInt(item, ItemInt.STROKE)]
			const paint = stroke === undefined ? undefined : list.paints[stroke.paint]

			return paint?.kind === "solid" && paint.color === rgba("ED7D31")
		})

		expect(stroked).toHaveLength(1)
	})

	it("draws a 3D surface from above and reports it as approximated", () => {
		const result = convert(surface("surface3DChart"))

		expect(result).toMatchObject({ supported: true, unsupported: ["surface3DChart"] })
		expect(filledWith(result.list, rgba("ED7D31"))).toHaveLength(1)
	})
})

describe("pie, doughnut and radar charts", () => {
	it("draws one slice per point with varied colours and percent labels", () => {
		const plotArea = `<c:pieChart><c:varyColors val="1"/>${series(0, "Share", [1, 1, 2], CATS)}<c:dLbls><c:showPercent val="1"/></c:dLbls><c:firstSliceAng val="0"/></c:pieChart>`
		const { list } = convert(plotArea)

		expect(filledWith(list, rgba("4472C4"))).toHaveLength(1)
		expect(filledWith(list, rgba("ED7D31"))).toHaveLength(1)
		expect(filledWith(list, rgba("A5A5A5"))).toHaveLength(1)
		expect(texts(list)).toEqual(expect.arrayContaining(["25%", "50%"]))
	})

	it("draws doughnut rings with a hole", () => {
		const plotArea = `<c:doughnutChart><c:varyColors val="1"/>${series(0, "Share", [3, 1], ["x", "y"])}<c:holeSize val="50"/></c:doughnutChart>`
		const { list } = convert(plotArea, "", 300, 300)
		const slice = filledWith(list, rgba("4472C4"))[0] ?? 0
		const first = list.itemInt(slice, ItemInt.FIRST_COORD)

		// The slice starts on the outer ring (not at the centre).
		expect(Math.hypot((list.coords[first] ?? 0) - 150, (list.coords[first + 1] ?? 0) - 150)).toBeGreaterThan(50)
	})

	it("draws radar webs and series polygons", () => {
		const plotArea = `<c:radarChart><c:radarStyle val="filled"/>${series(0, "One", [1, 2, 3, 2, 1], ["a", "b", "c", "d", "e"])}<c:axId val="1"/><c:axId val="2"/></c:radarChart>${AXES}`
		const { list } = convert(plotArea, "", 400, 400)

		expect(filledWith(list, rgba("4472C4"))).toHaveLength(1)
		expect(texts(list)).toEqual(expect.arrayContaining(["a", "e", "3"]))
	})
})

describe("unsupported and hostile charts", () => {
	it("allocates only the points written and bounds the chart's work", () => {
		let sers = ""

		for (let k = 0; k < 400; k++) {
			sers += `<c:ser><c:idx val="${k}"/><c:order val="${k}"/><c:val><c:numLit><c:ptCount val="262144"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser>`
		}

		const start = performance.now()
		const { list, supported } = convert(`<c:lineChart>${sers}<c:axId val="1"/><c:axId val="2"/></c:lineChart>${AXES}`)

		expect(supported).toBe(true)
		// 255 series at most, one point each.
		expect(list.itemCount).toBeLessThan(2000)
		expect(performance.now() - start).toBeLessThan(budget(2000))
	})

	it("caps per-point data labels", () => {
		const values = Array.from({ length: 6000 }, (_, k) => k)
		const plotArea = `<c:lineChart><c:ser><c:idx val="0"/><c:order val="0"/><c:dLbls><c:showVal val="1"/></c:dLbls><c:val>${numbers(values)}</c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:lineChart>${AXES}`
		const { list } = convert(plotArea)

		// 4096 data labels plus the axis labels.
		expect(list.texts.length).toBeLessThan(4096 + 400)
		expect(list.compact().texts.length).toBe(list.texts.length)
	})

	it("reports charts with nothing drawable", () => {
		expect(convert(`<c:unknownChart>${series(0, "s", [1], ["a"])}</c:unknownChart>`)).toMatchObject({
			supported: false,
			unsupported: ["empty"]
		})

		const missing = convertChart(
			context(),
			parseXml(new TextEncoder().encode('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>')),
			EMU,
			EMU
		)

		expect(missing).toMatchObject({ supported: false, unsupported: ["chart"] })
	})

	it("draws the supported plots of a combination chart", () => {
		const plotArea = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${series(0, "One", [1, 2, 3], CATS)}<c:axId val="1"/><c:axId val="2"/></c:barChart><c:surfaceChart>${series(1, "Two", [1, 2, 3], CATS)}<c:axId val="1"/><c:axId val="2"/></c:surfaceChart>${AXES}`

		expect(convert(plotArea)).toMatchObject({ supported: true, plots: ["barChart", "surfaceChart"], unsupported: [] })
	})

	it("caps point counts and survives junk values", () => {
		const plotArea = `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:val><c:numRef><c:numCache><c:ptCount val="2000000000"/><c:pt idx="0"><c:v>x</c:v></c:pt><c:pt idx="3"><c:v>2</c:v></c:pt><c:pt idx="-4"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`
		const { list, supported } = convert(plotArea)

		expect(supported).toBe(true)
		expect(list.coordCount).toBeLessThan(1 << 22)

		expect(list.coords.subarray(0, list.coordCount).every(Number.isFinite)).toBe(true)
	})
})

describe("stock charts and crowded category axes", () => {
	const RED = rgba("98002E")
	const stock = (extra: string = "") =>
		`<c:stockChart>${series(0, "High", [5, 7, 6], CATS, '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="dash"/><c:size val="5"/></c:marker>')}` +
		`${series(1, "Low", [1, 2, 3], CATS, '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="dash"/><c:size val="5"/></c:marker>')}` +
		`${series(2, "Close", [3, 4, 5], CATS)}` +
		`<c:hiLowLines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="98002E"/></a:solidFill></a:ln></c:spPr></c:hiLowLines>${extra}<c:axId val="1"/><c:axId val="2"/></c:stockChart>${AXES}`

	it("draws a high-low-close chart's high-low lines and its series' own markers, with no default line", () => {
		const result = convert(stock())
		const list = result.list
		const highLow = items(list, ItemKind.PATH).filter(item => {
			const stroke = list.strokes[list.itemInt(item, ItemInt.STROKE)]
			const paint = stroke === undefined ? undefined : list.paints[stroke.paint]

			return paint?.kind === "solid" && paint.color === RED
		})

		expect(result).toMatchObject({ supported: true, unsupported: [] })
		// One path: a segment per category.
		expect(highLow).toHaveLength(1)
		expect(list.itemInt(highLow[0] ?? -1, ItemInt.COMMAND_COUNT)).toBe(6)
		// The close series has neither a written line nor a marker, so it draws nothing.
		const lines = items(list, ItemKind.PATH).filter(
			item => list.itemInt(item, ItemInt.SOURCE) >= 0 && list.itemInt(item, ItemInt.STROKE) >= 0
		)

		expect(lines.length).toBeGreaterThan(0)
	})

	it("counts up-down bars as not drawn", () => {
		expect(convert(stock('<c:upDownBars><c:gapWidth val="150"/></c:upDownBars>')).unsupported).toEqual(["upDownBars"])
	})

	it("shows the automatic title only for a chart of one series, counting plots it does not draw", () => {
		const one = `<c:barChart><c:barDir val="col"/>${series(0, "Cases", [1, 2, 3], CATS)}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`
		const withSurface = one.replace(
			AXES,
			`<c:surfaceChart>${series(1, "Rate", [1, 2, 3], CATS)}<c:axId val="1"/><c:axId val="2"/></c:surfaceChart>${AXES}`
		)
		const auto = '<c:autoTitleDeleted val="0"/>'

		expect(texts(convert(one, auto).list)).toContain("Cases")
		expect(texts(convert(withSurface, auto).list)).not.toContain("Cases")
	})

	it("turns crowded category labels 45° instead of dropping them, unless the file sets their rotation", () => {
		const names = Array.from({ length: 12 }, (_, k) => `Region number ${String(k + 1)}`)
		const plot = (txPr: string) =>
			`<c:barChart><c:barDir val="col"/>${series(
				0,
				"S",
				names.map((_, k) => k + 1),
				names
			)}<c:axId val="1"/><c:axId val="2"/></c:barChart>` + AXES.replace('<c:crossAx val="2"/>', `${txPr}<c:crossAx val="2"/>`)
		const labelsOf = (list: DrawingList) =>
			items(list, ItemKind.TEXT).flatMap(item => {
				const text = list.texts[list.itemInt(item, ItemInt.REF)] as DrawingText

				return text.kind === "body" && /^Region/.test(text.paragraphs[0]?.runs[0]?.text ?? "") ? [text.body.rotation] : []
			})

		expect(labelsOf(convert(plot("")).list)).toEqual(Array.from({ length: 12 }, () => -45))
		// Written level: kept level, so thinned.
		const level = labelsOf(convert(plot('<c:txPr><a:bodyPr rot="0"/><a:lstStyle/><a:p><a:endParaRPr/></a:p></c:txPr>')).list)

		expect(level.every(rotation => rotation === 0)).toBe(true)
		expect(level.length).toBeLessThan(12)
	})

	it("breaks crowded category labels into lines at spaces when every word fits its band", () => {
		const names = ["Hypertensive", "and GP diagnosed with it", "and on BP medication", "and with controlled BP"]
		const plot = `<c:barChart><c:barDir val="col"/>${series(0, "S", [4, 3, 2, 1], names)}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`
		const list = convert(plot, "", 480, 320).list
		const labels = items(list, ItemKind.TEXT).flatMap(item => {
			const text = list.texts[list.itemInt(item, ItemInt.REF)] as DrawingText

			return text.kind === "body" && /^(Hyper|and)/.test(text.paragraphs[0]?.runs[0]?.text ?? "")
				? [{ rotation: text.body.rotation, lines: text.paragraphs.map(p => p.runs.map(r => r.text).join("")) }]
				: []
		})

		expect(labels).toHaveLength(4)
		expect(labels.every(label => label.rotation === 0)).toBe(true)
		expect(labels[2]?.lines.length).toBeGreaterThan(1)
		expect(labels[2]?.lines.join(" ")).toBe("and on BP medication")
	})

	it('treats Excel\'s rot="-60000000" on category labels as automatic rotation', () => {
		const names = Array.from({ length: 12 }, (_, k) => `Region number ${String(k + 1)}`)
		const plot =
			`<c:barChart><c:barDir val="col"/>${series(
				0,
				"S",
				names.map((_, k) => k + 1),
				names
			)}<c:axId val="1"/><c:axId val="2"/></c:barChart>` +
			AXES.replace(
				'<c:crossAx val="2"/>',
				'<c:txPr><a:bodyPr rot="-60000000" vert="horz"/><a:lstStyle/><a:p><a:endParaRPr/></a:p></c:txPr><c:crossAx val="2"/>'
			)
		const list = convert(plot).list
		const rotations = items(list, ItemKind.TEXT).flatMap(item => {
			const text = list.texts[list.itemInt(item, ItemInt.REF)] as DrawingText

			return text.kind === "body" && /^Region/.test(text.paragraphs[0]?.runs[0]?.text ?? "") ? [text.body.rotation] : []
		})

		expect(rotations).toEqual(Array.from({ length: 12 }, () => -45))
	})

	it("centres an axis title with no alignment written along its axis", () => {
		const title =
			'<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:t>Year</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>'
		const left =
			'<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"><a:defRPr/></a:pPr><a:r><a:t>Year</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>'
		const alignOf = (axisTitle: string) => {
			const plot = `<c:barChart><c:barDir val="col"/>${series(0, "S", [1, 2, 3], CATS)}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES.replace('<c:axPos val="b"/>', `<c:axPos val="b"/>${axisTitle}`)}`
			const list = convert(plot).list

			return items(list, ItemKind.TEXT).flatMap(item => {
				const text = list.texts[list.itemInt(item, ItemInt.REF)] as DrawingText

				return text.kind === "body" && text.paragraphs[0]?.runs[0]?.text === "Year" ? [text.paragraphs[0].align] : []
			})
		}

		expect(alignOf(title)).toEqual(["ctr"])
		expect(alignOf(left)).toEqual(["l"])
	})

	it("keeps category labels level when they fit", () => {
		const plot = `<c:barChart><c:barDir val="col"/>${series(0, "S", [1, 2, 3], CATS)}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`
		const list = convert(plot).list
		const rotations = items(list, ItemKind.TEXT).flatMap(item => {
			const text = list.texts[list.itemInt(item, ItemInt.REF)] as DrawingText

			return text.kind === "body" && CATS.includes(text.paragraphs[0]?.runs[0]?.text ?? "") ? [text.body.rotation] : []
		})

		expect(rotations).toEqual([0, 0, 0])
	})
})

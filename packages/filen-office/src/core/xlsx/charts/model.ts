import { D, drawingReader, type DrawingReader } from "../../drawingml/reader"
import type { XmlDocument } from "../../xml/index"

// A chart part as the chart editor shows it (ECMA-376 Part 1 §21.2.2): its plots with their series and the cells
// those read, its axes, title, legend and data labels. Read from the markup, never from a model the writer
// rebuilds: edits (edit.ts) change the elements named here and keep the rest as written.

export type ChartType = "column" | "bar" | "line" | "area" | "pie" | "doughnut" | "scatter" | "radar" | "other"
export type ChartGrouping = "clustered" | "stacked" | "percentStacked" | "standard"
export type ChartLegendPosition = "r" | "l" | "t" | "b" | "tr"
export type ChartLabelPosition = "bestFit" | "b" | "ctr" | "inBase" | "inEnd" | "l" | "outEnd" | "r" | "t"

export interface ChartLabels {
	readonly value: boolean
	readonly category: boolean
	readonly series: boolean
	readonly percent: boolean
	readonly position: ChartLabelPosition | null
}

export interface ChartSeriesInfo {
	// Its place among the chart's series in document order (what commands name).
	readonly index: number
	readonly idx: number
	readonly order: number
	// The name as cached (its cell's text) or as written.
	readonly name: string
	// The formulas (without "="), null where the series has none (a literal or nothing).
	readonly nameRef: string | null
	readonly categories: string | null
	readonly values: string | null
	readonly labels: ChartLabels | null
}

export interface ChartPlotInfo {
	readonly index: number
	// The element (barChart, lineChart...).
	readonly element: string
	readonly type: ChartType
	readonly grouping: ChartGrouping | null
	readonly threeD: boolean
	readonly series: readonly ChartSeriesInfo[]
	readonly axes: readonly number[]
	readonly labels: ChartLabels | null
}

export type ChartAxisKind = "cat" | "val" | "date" | "ser"

export interface ChartAxisInfo {
	readonly id: number
	readonly kind: ChartAxisKind
	readonly position: "b" | "l" | "r" | "t"
	readonly visible: boolean
	readonly min: number | null
	readonly max: number | null
	readonly major: number | null
	readonly minor: number | null
	readonly logBase: number | null
	readonly reversed: boolean
	// Its own number format, null when linked to the source.
	readonly format: string | null
	readonly title: string | null
	readonly majorGridlines: boolean
}

export interface ChartInfo {
	// Plain text of the title, "" for an automatic one; null when the chart has none.
	readonly title: string | null
	readonly legend: ChartLegendPosition | null
	readonly plots: readonly ChartPlotInfo[]
	readonly axes: readonly ChartAxisInfo[]
}

const PLOTS: Readonly<Record<string, { type: ChartType; threeD: boolean }>> = {
	barChart: { type: "column", threeD: false },
	bar3DChart: { type: "column", threeD: true },
	lineChart: { type: "line", threeD: false },
	line3DChart: { type: "line", threeD: true },
	areaChart: { type: "area", threeD: false },
	area3DChart: { type: "area", threeD: true },
	pieChart: { type: "pie", threeD: false },
	pie3DChart: { type: "pie", threeD: true },
	ofPieChart: { type: "pie", threeD: false },
	doughnutChart: { type: "doughnut", threeD: false },
	scatterChart: { type: "scatter", threeD: false },
	radarChart: { type: "radar", threeD: false },
	stockChart: { type: "other", threeD: false },
	surfaceChart: { type: "other", threeD: false },
	surface3DChart: { type: "other", threeD: true },
	bubbleChart: { type: "other", threeD: false }
}

export const PLOT_ELEMENTS: ReadonlySet<string> = new Set(Object.keys(PLOTS))
export const AXIS_ELEMENTS: ReadonlyMap<string, ChartAxisKind> = new Map([
	["catAx", "cat"],
	["valAx", "val"],
	["dateAx", "date"],
	["serAx", "ser"]
])

export function val(reader: DrawingReader, node: number, local: string): string | undefined {
	return reader.attr(reader.child(node, D.C, local), "val")
}

function flag(reader: DrawingReader, node: number, local: string): boolean {
	const child = reader.child(node, D.C, local)

	return child >= 0 && reader.bool(child, "val", true)
}

function numberVal(reader: DrawingReader, node: number, local: string): number | null {
	const text = val(reader, node, local)
	const value = text === undefined ? Number.NaN : Number(text)

	return Number.isFinite(value) ? value : null
}

// The plain text of a c:tx or c:title: its rich paragraphs joined by line breaks, or the cached text of its strRef.
export function plainText(reader: DrawingReader, owner: number): string {
	const tx = reader.child(owner, D.C, "tx")
	const rich = reader.child(tx, D.C, "rich")

	if (rich >= 0)
		return reader
			.children(rich, D.A, "p")
			.map(p =>
				reader
					.children(p, D.A, "r")
					.map(r => reader.text(reader.child(r, D.A, "t")))
					.join("")
			)
			.join("\n")

	const strRef = reader.child(tx, D.C, "strRef")
	const cache = reader.child(strRef, D.C, "strCache")

	return reader
		.children(cache, D.C, "pt")
		.map(pt => reader.text(reader.child(pt, D.C, "v")))
		.join(" ")
}

function formulaOf(reader: DrawingReader, source: number): string | null {
	if (source < 0) return null

	const ref = reader.childOf(source, D.C, new Set(["numRef", "strRef", "multiLvlStrRef"]))
	const formula = reader.child(ref, D.C, "f")

	return formula < 0 ? null : reader.text(formula).trim()
}

function labelsOf(reader: DrawingReader, dLbls: number): ChartLabels | null {
	if (dLbls < 0 || flag(reader, dLbls, "delete")) return null

	const position = val(reader, dLbls, "dLblPos")

	return {
		value: flag(reader, dLbls, "showVal"),
		category: flag(reader, dLbls, "showCatName"),
		series: flag(reader, dLbls, "showSerName"),
		percent: flag(reader, dLbls, "showPercent"),
		position: position === undefined ? null : (position as ChartLabelPosition)
	}
}

function seriesName(reader: DrawingReader, series: number): string {
	const tx = reader.child(series, D.C, "tx")
	const literal = reader.child(tx, D.C, "v")

	return literal >= 0 ? reader.text(literal) : plainText(reader, series)
}

export function chartRoot(reader: DrawingReader): { space: number; chart: number; plotArea: number } {
	const root = reader.document.documentElement()
	const space = root >= 0 && reader.is(root, D.C, "chartSpace") ? root : -1
	const chart = reader.child(space, D.C, "chart")

	return { space, chart, plotArea: reader.child(chart, D.C, "plotArea") }
}

export function plotNodes(reader: DrawingReader, plotArea: number): number[] {
	const out: number[] = []
	const document = reader.document

	for (let child = plotArea < 0 ? -1 : document.firstChildElement(plotArea); child >= 0; child = document.nextSiblingElement(child))
		if (reader.group(child) === D.C && PLOT_ELEMENTS.has(reader.local(child))) out.push(child)

	return out
}

export function axisNodes(reader: DrawingReader, plotArea: number): number[] {
	const out: number[] = []
	const document = reader.document

	for (let child = plotArea < 0 ? -1 : document.firstChildElement(plotArea); child >= 0; child = document.nextSiblingElement(child))
		if (reader.group(child) === D.C && AXIS_ELEMENTS.has(reader.local(child))) out.push(child)

	return out
}

export function readChartInfo(document: XmlDocument): ChartInfo | null {
	const reader = drawingReader(document)
	const { chart, plotArea } = chartRoot(reader)

	if (chart < 0) return null

	const titleNode = reader.child(chart, D.C, "title")
	const legendNode = reader.child(chart, D.C, "legend")
	const legendPosition = val(reader, legendNode, "legendPos") ?? "r"
	let seriesIndex = 0
	const plots = plotNodes(reader, plotArea).map((node, index): ChartPlotInfo => {
		const element = reader.local(node)
		const kind = PLOTS[element] ?? { type: "other" as const, threeD: false }
		const grouping = val(reader, node, "grouping")
		const type = kind.type === "column" && val(reader, node, "barDir") === "bar" ? "bar" : kind.type

		return {
			index,
			element,
			type,
			grouping:
				grouping === "clustered" || grouping === "stacked" || grouping === "percentStacked" || grouping === "standard"
					? grouping
					: type === "column" || type === "bar"
						? "clustered"
						: type === "line" || type === "area"
							? "standard"
							: null,
			threeD: kind.threeD,
			axes: reader.children(node, D.C, "axId").map(axis => reader.number(axis, "val", -1)),
			labels: labelsOf(reader, reader.child(node, D.C, "dLbls")),
			series: reader.children(node, D.C, "ser").map(series => ({
				index: seriesIndex++,
				idx: numberVal(reader, series, "idx") ?? 0,
				order: numberVal(reader, series, "order") ?? 0,
				name: seriesName(reader, series),
				nameRef: formulaOf(reader, reader.child(series, D.C, "tx")),
				categories: formulaOf(reader, reader.child(series, D.C, element === "scatterChart" ? "xVal" : "cat")),
				values: formulaOf(reader, reader.child(series, D.C, element === "scatterChart" ? "yVal" : "val")),
				labels: labelsOf(reader, reader.child(series, D.C, "dLbls"))
			}))
		}
	})
	const axes = axisNodes(reader, plotArea).map((node): ChartAxisInfo => {
		const scaling = reader.child(node, D.C, "scaling")
		const numFmt = reader.child(node, D.C, "numFmt")
		const position = val(reader, node, "axPos")
		const title = reader.child(node, D.C, "title")

		return {
			id: numberVal(reader, node, "axId") ?? -1,
			kind: AXIS_ELEMENTS.get(reader.local(node)) ?? "val",
			position: position === "b" || position === "l" || position === "r" || position === "t" ? position : "l",
			visible: !flag(reader, node, "delete"),
			min: numberVal(reader, scaling, "min"),
			max: numberVal(reader, scaling, "max"),
			major: numberVal(reader, node, "majorUnit"),
			minor: numberVal(reader, node, "minorUnit"),
			logBase: numberVal(reader, scaling, "logBase"),
			reversed: val(reader, scaling, "orientation") === "maxMin",
			format: numFmt >= 0 && !reader.bool(numFmt, "sourceLinked", false) ? (reader.attr(numFmt, "formatCode") ?? null) : null,
			title: title < 0 ? null : plainText(reader, title),
			majorGridlines: reader.child(node, D.C, "majorGridlines") >= 0
		}
	})

	return {
		title: titleNode < 0 ? null : plainText(reader, titleNode),
		legend:
			legendNode < 0 ? null : ((["r", "l", "t", "b", "tr"].includes(legendPosition) ? legendPosition : "r") as ChartLegendPosition),
		plots,
		axes
	}
}

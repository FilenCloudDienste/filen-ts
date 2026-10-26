import { D, type DrawingReader } from "../reader"
import { pointBudget, readSeries, type PointBudget, type SeriesData } from "./data"

// The plot area of a chart part (§21.2.2.145): its plots (c:barChart, c:lineChart...) and axes.

export type PlotKind = "bar" | "line" | "area" | "pie" | "doughnut" | "scatter" | "radar"

const PLOT_KINDS: Readonly<Record<string, PlotKind>> = {
	barChart: "bar",
	bar3DChart: "bar",
	lineChart: "line",
	line3DChart: "line",
	areaChart: "area",
	area3DChart: "area",
	pieChart: "pie",
	pie3DChart: "pie",
	// Bar-of-pie and pie-of-pie draw as a plain pie (the secondary plot is not drawn).
	ofPieChart: "pie",
	doughnutChart: "doughnut",
	scatterChart: "scatter",
	radarChart: "radar",
	// High-low-close (§21.2.2.198): its series as lines over the categories, drawn only as their own spPr and markers
	// say (no default line or marker), with the high-low lines between them. Up-down bars are not drawn.
	stockChart: "line"
}

export const UNSUPPORTED_PLOTS: ReadonlySet<string> = new Set(["surfaceChart", "surface3DChart", "bubbleChart"])

export type Grouping = "standard" | "clustered" | "stacked" | "percentStacked"

export interface Plot {
	readonly kind: PlotKind
	// The element's local name (barChart, pie3DChart...).
	readonly element: string
	readonly node: number
	readonly series: SeriesData[]
	readonly axisIds: readonly number[]
	readonly grouping: Grouping
	// c:barDir="bar": categories run vertically.
	readonly horizontal: boolean
	readonly varyColors: boolean
	readonly gapWidth: number
	readonly overlap: number
	readonly firstSliceAngle: number
	readonly holeSize: number
	// lineChart c:marker, scatterStyle and radarStyle folded into: markers shown by default, lines drawn,
	// areas filled, curves smoothed.
	readonly markers: boolean
	readonly lines: boolean
	readonly filled: boolean
	readonly smooth: boolean
	readonly dataLabels: number
	// c:hiLowLines (§21.2.2.80, line and stock charts): a line per category from its highest to its lowest value; -1.
	readonly hiLowLines: number
}

export type AxisKind = "cat" | "val" | "date" | "ser"
export type AxisSide = "b" | "l" | "r" | "t"

export interface Axis {
	readonly id: number
	readonly node: number
	readonly kind: AxisKind
	readonly side: AxisSide
	readonly deleted: boolean
	readonly reversed: boolean
	readonly min: number | undefined
	readonly max: number | undefined
	readonly major: number | undefined
	readonly logBase: number
	readonly crossAxis: number
	readonly crosses: "autoZero" | "min" | "max"
	readonly crossesAt: number | undefined
	readonly majorGridlines: number
	readonly minorGridlines: number
	// Format code from c:numFmt, undefined when linked to the source.
	readonly format: string | undefined
	readonly labelPosition: "nextTo" | "low" | "high" | "none"
	readonly majorTick: "out" | "in" | "cross" | "none"
	readonly spPr: number
	readonly txPr: number
	readonly title: number
	readonly crossBetween: "between" | "midCat"
	readonly labelSkip: number
}

function value(reader: DrawingReader, node: number, local: string): string | undefined {
	return reader.attr(reader.child(node, D.C, local), "val")
}

function flag(reader: DrawingReader, node: number, local: string, fallback: boolean): boolean {
	const child = reader.child(node, D.C, local)

	// CT_Boolean's val defaults to true.
	return child < 0 ? fallback : reader.bool(child, "val", true)
}

function numberValue(reader: DrawingReader, node: number, local: string): number | undefined {
	const child = reader.child(node, D.C, local)
	const result = child < 0 ? Number.NaN : reader.number(child, "val", Number.NaN)

	return Number.isNaN(result) ? undefined : result
}

function readPlot(reader: DrawingReader, node: number, kind: PlotKind, budget: PointBudget, seriesCount: { count: number }): Plot {
	const element = reader.local(node)
	const groupingText = value(reader, node, "grouping")
	const grouping: Grouping =
		groupingText === "stacked" || groupingText === "percentStacked" || groupingText === "clustered" || groupingText === "standard"
			? groupingText
			: kind === "bar"
				? "clustered"
				: "standard"
	const scatterStyle = value(reader, node, "scatterStyle") ?? "marker"
	const radarStyle = value(reader, node, "radarStyle") ?? "standard"
	const axisIds = reader.children(node, D.C, "axId").map(axis => reader.number(axis, "val", -1))
	let markers = true
	let lines = true
	let filled = kind === "bar" || kind === "area" || kind === "pie" || kind === "doughnut"
	let smooth = false

	if (kind === "line") markers = flag(reader, node, "marker", element === "lineChart")
	if (element === "stockChart") {
		markers = false
		lines = false
	}
	if (kind === "scatter") {
		lines = scatterStyle !== "marker" && scatterStyle !== "none"
		markers = scatterStyle !== "line" && scatterStyle !== "smooth" && scatterStyle !== "none"
		smooth = scatterStyle === "smooth" || scatterStyle === "smoothMarker"
	}
	if (kind === "radar") {
		markers = radarStyle === "marker"
		filled = radarStyle === "filled"
	}

	return {
		kind,
		element,
		node,
		series: readSeries(reader, node, kind === "scatter", budget, seriesCount),
		axisIds,
		grouping,
		horizontal: value(reader, node, "barDir") === "bar",
		varyColors: flag(reader, node, "varyColors", false),
		gapWidth: numberValue(reader, node, "gapWidth") ?? 150,
		overlap: numberValue(reader, node, "overlap") ?? (grouping === "stacked" || grouping === "percentStacked" ? 100 : 0),
		firstSliceAngle: numberValue(reader, node, "firstSliceAng") ?? 0,
		holeSize: kind === "doughnut" ? Math.max(1, Math.min(90, numberValue(reader, node, "holeSize") ?? 50)) : 0,
		markers,
		lines,
		filled,
		smooth,
		dataLabels: reader.child(node, D.C, "dLbls"),
		hiLowLines: kind === "line" ? reader.child(node, D.C, "hiLowLines") : -1
	}
}

const AXIS_KINDS: Readonly<Record<string, AxisKind>> = { catAx: "cat", valAx: "val", dateAx: "date", serAx: "ser" }

function readAxis(reader: DrawingReader, node: number, kind: AxisKind): Axis {
	const scaling = reader.child(node, D.C, "scaling")
	const side = value(reader, node, "axPos")
	const crosses = value(reader, node, "crosses")
	const labelPosition = value(reader, node, "tickLblPos")
	const majorTick = value(reader, node, "majorTickMark")
	const numFmt = reader.child(node, D.C, "numFmt")
	const logBase = numberValue(reader, scaling, "logBase") ?? 0

	return {
		id: numberValue(reader, node, "axId") ?? -1,
		node,
		kind,
		side: side === "b" || side === "l" || side === "r" || side === "t" ? side : kind === "val" ? "l" : "b",
		deleted: flag(reader, node, "delete", false),
		reversed: value(reader, scaling, "orientation") === "maxMin",
		min: numberValue(reader, scaling, "min"),
		max: numberValue(reader, scaling, "max"),
		major: numberValue(reader, node, "majorUnit"),
		logBase: logBase >= 2 && logBase <= 1000 ? logBase : 0,
		crossAxis: numberValue(reader, node, "crossAx") ?? -1,
		crosses: crosses === "min" || crosses === "max" ? crosses : "autoZero",
		crossesAt: numberValue(reader, node, "crossesAt"),
		majorGridlines: reader.child(node, D.C, "majorGridlines"),
		minorGridlines: reader.child(node, D.C, "minorGridlines"),
		format: numFmt >= 0 && !reader.bool(numFmt, "sourceLinked", false) ? reader.attr(numFmt, "formatCode") : undefined,
		labelPosition: labelPosition === "low" || labelPosition === "high" || labelPosition === "none" ? labelPosition : "nextTo",
		majorTick: majorTick === "in" || majorTick === "cross" || majorTick === "none" ? majorTick : "out",
		spPr: reader.child(node, D.C, "spPr"),
		txPr: reader.child(node, D.C, "txPr"),
		title: reader.child(node, D.C, "title"),
		crossBetween: value(reader, node, "crossBetween") === "midCat" ? "midCat" : "between",
		labelSkip: Math.max(0, numberValue(reader, node, "tickLblSkip") ?? 0)
	}
}

export interface PlotArea {
	readonly node: number
	readonly plots: Plot[]
	readonly axes: Map<number, Axis>
	// Plot kinds found (element names) and the ones not drawn.
	readonly found: string[]
	readonly unsupported: string[]
	// Series in every plot, drawn or not (an automatic title shows only for a chart of one series).
	readonly seriesTotal: number
}

export function readPlotArea(reader: DrawingReader, plotArea: number): PlotArea {
	const plots: Plot[] = []
	const axes = new Map<number, Axis>()
	const found: string[] = []
	const unsupported: string[] = []
	const document = reader.document
	const budget = pointBudget()
	const seriesCount = { count: 0 }
	let undrawnSeries = 0

	for (let child = plotArea < 0 ? -1 : document.firstChildElement(plotArea); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.group(child) !== D.C) continue

		const local = document.localName(child)
		const kind = PLOT_KINDS[local]
		const axisKind = AXIS_KINDS[local]

		if (kind !== undefined) {
			found.push(local)
			plots.push(readPlot(reader, child, kind, budget, seriesCount))

			if (reader.child(child, D.C, "upDownBars") >= 0) unsupported.push("upDownBars")
		} else if (axisKind !== undefined) {
			const axis = readAxis(reader, child, axisKind)

			if (!axes.has(axis.id)) axes.set(axis.id, axis)
		} else if (UNSUPPORTED_PLOTS.has(local)) {
			found.push(local)
			unsupported.push(local)
			undrawnSeries += reader.children(child, D.C, "ser").length
		}
	}

	return {
		node: plotArea,
		plots,
		axes,
		found,
		unsupported,
		seriesTotal: plots.reduce((sum, plot) => sum + plot.series.length, undrawnSeries)
	}
}

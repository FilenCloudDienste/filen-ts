import type { Rgba } from "../displayList"
import { D } from "../reader"
import { PX_PER_PT, type ChartBuilder } from "./builder"
import type { SeriesData } from "./data"
import type { Plot } from "./model"
import { backgroundColor, seriesColor } from "./palette"

// How one series (and its overridden points) is painted.

export type MarkerSymbol = "circle" | "dash" | "diamond" | "dot" | "plus" | "square" | "star" | "triangle" | "x"

// Office's automatic marker sequence.
const AUTO_SYMBOLS: readonly MarkerSymbol[] = ["diamond", "square", "triangle", "x", "star", "dot", "dash", "circle", "plus"]
const SYMBOLS: ReadonlySet<string> = new Set(AUTO_SYMBOLS)

export interface MarkerStyle {
	readonly symbol: MarkerSymbol
	// Half the marker size, px.
	readonly radius: number
	readonly fill: number
	readonly stroke: number
}

export interface PointStyle {
	readonly fill: number
	readonly stroke: number
	readonly explosion: number
}

export interface SeriesStyle {
	readonly color: Rgba
	readonly fill: number
	readonly stroke: number
	readonly marker: MarkerStyle | undefined
	readonly explosion: number
	// c:dPt overrides by point index.
	readonly points: ReadonlyMap<number, PointStyle>
	// Per-point colours (c:varyColors on a single-series or pie plot).
	readonly vary: boolean
	readonly pointCount: number
}

// Line width of chart series lines without one of their own: 2.25pt.
const SERIES_LINE = 2.25 * PX_PER_PT

function lineKind(plot: Plot): boolean {
	return plot.kind === "line" || plot.kind === "scatter" || (plot.kind === "radar" && !plot.filled)
}

function readMarker(
	builder: ChartBuilder,
	plot: Plot,
	marker: number,
	color: Rgba,
	autoIndex: number,
	fallback: MarkerStyle | undefined
): MarkerStyle | undefined {
	const reader = builder.reader
	const symbolText = reader.attr(reader.child(marker, D.C, "symbol"), "val")

	if (symbolText === "none" || symbolText === "picture") return undefined
	if (marker < 0 && fallback !== undefined) return fallback
	if (!plot.markers && (marker < 0 || symbolText === undefined)) return undefined

	const symbol =
		symbolText !== undefined && SYMBOLS.has(symbolText)
			? (symbolText as MarkerSymbol)
			: (AUTO_SYMBOLS[autoIndex % AUTO_SYMBOLS.length] ?? "square")
	const size = Math.max(2, Math.min(72, reader.number(reader.child(marker, D.C, "size"), "val", 5)))
	const spPr = reader.child(marker, D.C, "spPr")

	return {
		symbol,
		radius: (size * PX_PER_PT) / 2,
		fill: symbol === "x" || symbol === "plus" || symbol === "star" ? -1 : builder.fill(spPr, color),
		stroke: builder.line(spPr, { color, width: 0.75 * PX_PER_PT, round: false })
	}
}

// Styles of every series of a plot, by series node. `total` is the series count of the whole chart: default
// colours follow c:idx, which runs across the plots of a combination chart.
export function seriesStyles(builder: ChartBuilder, plot: Plot, total: number): Map<number, SeriesStyle> {
	const out = new Map<number, SeriesStyle>()
	const reader = builder.reader
	const single = plot.series.length === 1
	const vary =
		plot.varyColors && (plot.kind === "pie" || plot.kind === "doughnut" || (single && (plot.kind === "bar" || plot.kind === "bubble")))
	const lines = lineKind(plot)
	const background = backgroundColor(builder.theme)

	for (const series of plot.series) {
		const color = seriesColor(builder.theme, builder.style, series.index, total)
		const spPr = series.spPr
		const fill = lines ? -1 : builder.fill(spPr, color)
		let stroke = lines
			? plot.lines
				? builder.line(spPr, { color, width: SERIES_LINE, round: true })
				: builder.line(spPr, undefined)
			: builder.line(
					spPr,
					plot.kind === "pie" || plot.kind === "doughnut" ? { color: background, width: 1, round: false } : undefined
				)
		// 3D lines are ribbons: their colour is a fill, the outline usually none. Drawn flat, the ribbon
		// becomes a line in its fill's colour.
		if (lines && stroke < 0 && plot.element === "line3DChart") {
			stroke = builder.plainStroke(representative(builder, builder.fill(spPr, color), color), SERIES_LINE, true)
		}

		const marker = lines
			? readMarker(builder, plot, reader.child(series.node, D.C, "marker"), color, series.index, undefined)
			: undefined
		const points = new Map<number, PointStyle>()
		const pointCount = series.values.count

		for (const dPt of reader.children(series.node, D.C, "dPt")) {
			const index = reader.number(reader.child(dPt, D.C, "idx"), "val", -1)

			if (index < 0) continue

			const pointSpPr = reader.child(dPt, D.C, "spPr")
			const pointColor = vary ? seriesColor(builder.theme, builder.style, index, pointCount) : color
			const pointFill = lines ? fill : pointSpPr < 0 ? (vary ? builder.solid(pointColor) : fill) : builder.fill(pointSpPr, pointColor)
			const pointStroke = pointSpPr < 0 || reader.child(pointSpPr, D.A, "ln") < 0 ? stroke : builder.line(pointSpPr, undefined)

			points.set(index, {
				fill: pointFill,
				stroke: pointStroke,
				explosion: reader.number(reader.child(dPt, D.C, "explosion"), "val", Number.NaN)
			})
		}

		out.set(series.node, {
			color,
			fill,
			stroke,
			marker,
			explosion: reader.number(reader.child(series.node, D.C, "explosion"), "val", 0),
			points,
			vary,
			pointCount
		})
	}

	return out
}

// One colour standing for a paint (a gradient's middle stop).
function representative(builder: ChartBuilder, paint: number, fallback: Rgba): Rgba {
	const value = paint < 0 ? undefined : builder.list.paints[paint]

	if (value === undefined) return fallback
	if (value.kind === "solid") return value.color
	if (value.kind === "linear" || value.kind === "path") return value.stops.colors[value.stops.colors.length >> 1] ?? fallback
	if (value.kind === "pattern") return value.foreground

	return fallback
}

// The paint of point `index` of a series.
export function pointFill(builder: ChartBuilder, style: SeriesStyle, index: number): number {
	const override = style.points.get(index)

	if (override !== undefined) return override.fill
	if (style.vary) return builder.solid(seriesColor(builder.theme, builder.style, index, style.pointCount))

	return style.fill
}

export function pointStroke(style: SeriesStyle, index: number): number {
	return style.points.get(index)?.stroke ?? style.stroke
}

// Whether a point is painted differently from its series.
export function pointOverridden(style: SeriesStyle, index: number): boolean {
	return style.vary || style.points.has(index)
}

// Appends one marker centred on (x, y).
export function appendMarker(builder: ChartBuilder, symbol: MarkerSymbol, x: number, y: number, r: number): void {
	switch (symbol) {
		case "circle":
			builder.list.moveTo(x + r, y)
			builder.arc(x, y, r, 0, Math.PI * 2)
			builder.list.close()
			break
		case "diamond":
			builder.list.moveTo(x, y - r)
			builder.list.lineTo(x + r, y)
			builder.list.lineTo(x, y + r)
			builder.list.lineTo(x - r, y)
			builder.list.close()
			break
		case "triangle":
			builder.list.moveTo(x, y - r)
			builder.list.lineTo(x + r, y + r)
			builder.list.lineTo(x - r, y + r)
			builder.list.close()
			break
		case "x":
			builder.segment(x - r, y - r, x + r, y + r)
			builder.segment(x - r, y + r, x + r, y - r)
			break
		case "plus":
			builder.segment(x - r, y, x + r, y)
			builder.segment(x, y - r, x, y + r)
			break
		case "star":
			builder.segment(x - r, y - r, x + r, y + r)
			builder.segment(x - r, y + r, x + r, y - r)
			builder.segment(x, y - r, x, y + r)
			break
		case "dash":
			builder.rect(x - r, y - r / 4, r * 2, r / 2)
			break
		case "dot":
			builder.rect(x - r / 4, y - r / 4, r / 2, r / 2)
			break
		default:
			builder.rect(x - r, y - r, r * 2, r * 2)
			break
	}
}

export function seriesName(series: SeriesData, position: number): string {
	return series.name !== "" ? series.name : `Series${position + 1}`
}

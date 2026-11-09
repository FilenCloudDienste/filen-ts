import type { XmlDocument } from "../../xml/index"
import type { DrawingList, TextParagraph } from "../displayList"
import type { PaintContext } from "../fill"
import { D, EMU_PER_PX, drawingReader, type DrawingReader } from "../reader"
import { plainParagraph, readTextBody, type TextDefaults } from "../text"
import {
	autoRotateLabels,
	axisExtent,
	axisState,
	crossingPosition,
	drawAxisLabels,
	drawAxisLine,
	drawGridlines,
	setSpan,
	tickLabels,
	type AxisState
} from "./axes"
import type { ErrorBarData } from "./data"
import { drawChartex } from "./chartex"
import { formatNumber } from "./format"
import { ChartBuilder, PX_PER_PT, estimateHeight, estimateWidth, labelBody, type Rect } from "./builder"
import { emitLabels, type PendingLabel } from "./labels"
import { readPlotArea, type Plot } from "./model"
import { backgroundColor, mutedText, seriesColor, textColor } from "./palette"
import {
	drawBars,
	drawBubbles,
	drawLinesOrAreas,
	drawPie,
	drawRadar,
	drawScatter,
	drawSurface,
	errorSpans,
	plotCategories,
	surfaceTruncated,
	type Blanks,
	type PlotFrame,
	type SurfaceBand
} from "./plots"
import { computeScale, scaleTicks } from "./scale"
import { appendMarker, pointFill, seriesName, seriesStyles, type MarkerStyle, type SeriesStyle } from "./series"

// Legend entries of a per-point (varyColors) legend.
const MAX_LEGEND_ENTRIES = 512

export { formatNumber } from "./format"
export { computeScale, scaleTicks, type Scale } from "./scale"

// Charts (c:chartSpace, ECMA-376 Part 1 §21.2) drawn from the values cached in the chart part into the
// drawing display list: plot area, gridlines, series, axes, data labels, legend and title. Text is placed
// in boxes for the layout engine; its size is only estimated here (see builder.ts). Chartex parts
// (cx:chartSpace) are drawn by chartex.ts.

export interface ChartConversion {
	readonly list: DrawingList
	// Whether anything was drawn; false sends the host to the drawing's fallback picture.
	readonly supported: boolean
	// Plot elements found (barChart, pie3DChart...).
	readonly plots: string[]
	// Plot elements (or "chart" for a part without one) that were not drawn.
	readonly unsupported: string[]
}

// Draw order of plot kinds in a combination chart: areas at the back, then bars, then lines and points.
const PLOT_RANK: Readonly<Record<string, number>> = {
	surface: 0,
	area: 0,
	bar: 1,
	pie: 1,
	doughnut: 1,
	radar: 2,
	bubble: 3,
	line: 3,
	scatter: 4
}

interface Manual {
	readonly x: number | undefined
	readonly y: number | undefined
	readonly w: number | undefined
	readonly h: number | undefined
	readonly edge: boolean
	readonly inner: boolean
}

function manualLayout(reader: DrawingReader, owner: number): Manual | undefined {
	const manual = reader.child(reader.child(owner, D.C, "layout"), D.C, "manualLayout")

	if (manual < 0) return undefined

	const get = (local: string): number | undefined => {
		const value = reader.number(reader.child(manual, D.C, local), "val", Number.NaN)

		return Number.isFinite(value) ? Math.max(-1, Math.min(2, value)) : undefined
	}

	return {
		x: get("x"),
		y: get("y"),
		w: get("w"),
		h: get("h"),
		edge: reader.attr(reader.child(manual, D.C, "xMode"), "val") === "edge",
		inner: reader.attr(reader.child(manual, D.C, "layoutTarget"), "val") === "inner"
	}
}

function chartStyle(reader: DrawingReader, root: number): number {
	const document = reader.document
	const end = document.end(root)

	// c:style may sit inside mc:AlternateContent next to c14:style (whose values are 100 higher).
	for (let node = root + 1; node < document.count && document.start(node) < end; node++) {
		if (reader.local(node) !== "style") continue

		const group = reader.group(node)

		if (group !== D.C && group !== D.C14) continue

		const value = reader.number(node, "val", 2)

		return value > 100 ? value - 100 : value
	}

	return 2
}

interface LegendEntry {
	readonly text: string
	readonly fill: number
	readonly stroke: number
	readonly line: boolean
	readonly marker: MarkerStyle | undefined
}

function legendEntries(
	builder: ChartBuilder,
	plots: readonly Plot[],
	styles: ReadonlyMap<number, SeriesStyle>,
	categories: ReadonlyMap<Plot, string[]>,
	bands: ReadonlyMap<Plot, readonly SurfaceBand[]>
): LegendEntry[] {
	const out: LegendEntry[] = []
	let position = 0

	for (const plot of plots) {
		const plotBands = bands.get(plot)

		// A surface's legend names its value bands.
		if (plotBands !== undefined) {
			for (const band of plotBands)
				out.push({ text: band.label, fill: band.fill, stroke: band.stroke, line: band.fill < 0, marker: undefined })

			position += plot.series.length

			continue
		}

		const lineKind = plot.kind === "line" || plot.kind === "scatter" || (plot.kind === "radar" && !plot.filled)
		const first = plot.series[0]
		const firstStyle = first === undefined ? undefined : styles.get(first.node)

		if (firstStyle?.vary === true && first !== undefined) {
			const names = categories.get(plot) ?? []

			// One entry per point, up to what a legend can show.
			for (let k = 0; k < Math.min(MAX_LEGEND_ENTRIES, Math.max(names.length, first.values.count)); k++) {
				out.push({
					text: names[k] ?? String(k + 1),
					fill: pointFill(builder, firstStyle, k),
					stroke: firstStyle.stroke,
					line: false,
					marker: undefined
				})
			}

			position += plot.series.length

			continue
		}

		for (const series of plot.series) {
			const style = styles.get(series.node)

			if (style !== undefined) {
				out.push({
					text: seriesName(series, position),
					fill: lineKind ? -1 : style.fill,
					stroke: style.stroke,
					line: lineKind,
					marker: style.marker
				})
			}

			position++
		}
	}

	return out
}

interface LegendLayout {
	readonly box: Rect
	readonly side: string
}

function titleParagraphs(
	builder: ChartBuilder,
	title: number,
	defaults: TextDefaults,
	fallback: string
): { paragraphs: TextParagraph[]; rotation: number } {
	const reader = builder.reader
	const tx = reader.child(title, D.C, "tx")
	const rich = reader.child(tx, D.C, "rich")

	if (rich >= 0) {
		const body = readTextBody(reader, builder.theme, rich, defaults)

		return { paragraphs: body.paragraphs, rotation: builder.textRotation(rich) ?? 0 }
	}

	const cached = reader.child(reader.child(reader.child(tx, D.C, "strRef"), D.C, "strCache"), D.C, "pt")
	const text = cached >= 0 ? reader.text(reader.child(cached, D.C, "v")) : fallback

	return { paragraphs: [plainParagraph(text, defaults)], rotation: 0 }
}

function paragraphsHeight(paragraphs: readonly TextParagraph[], fallbackSize: number): number {
	let height = 0

	for (const paragraph of paragraphs) {
		let size = paragraph.runs.length === 0 ? paragraph.endSize : 0
		let lines = 1

		for (const run of paragraph.runs) {
			size = Math.max(size, run.size)

			if (run.lineBreak) lines++
		}

		height += estimateHeight(size || fallbackSize, lines)
	}

	return height
}

function paragraphsWidth(paragraphs: readonly TextParagraph[]): number {
	let widest = 0

	for (const paragraph of paragraphs) {
		let line = 0

		for (const run of paragraph.runs) {
			if (run.lineBreak) {
				widest = Math.max(widest, line)
				line = 0
			} else {
				line += estimateWidth(run.text, run.size)
			}
		}

		widest = Math.max(widest, line)
	}

	return widest
}

// Converts one chart part. `width`/`height` are the frame extent in EMU. `matrix` places the chart in a list that is
// not its own (a chart inside a group): its items go through it, and the list keeps its own size.
export function convertChart(
	context: PaintContext,
	document: XmlDocument,
	width: number,
	height: number,
	list?: DrawingList,
	matrix?: readonly number[]
): ChartConversion {
	const target = list ?? context.list
	const paintContext: PaintContext = target === context.list ? context : { ...context, list: target }
	const W = Math.max(0, width / EMU_PER_PX)
	const H = Math.max(0, height / EMU_PER_PX)

	if (matrix === undefined) {
		target.width = W
		target.height = H
	}

	const reader = drawingReader(document)
	const root = document.documentElement()

	// Office 2016 chart types (waterfall, treemap...) live in a cx:chartSpace part.
	if (root >= 0 && reader.is(root, D.Cx, "chartSpace")) {
		const result = drawChartex(paintContext, reader, root, W, H, matrix)

		return { list: target, ...result }
	}

	const chart = root >= 0 && reader.is(root, D.C, "chartSpace") ? reader.child(root, D.C, "chart") : -1

	if (chart < 0) return { list: target, supported: false, plots: [], unsupported: ["chart"] }

	const theme = context.theme
	const area = readPlotArea(reader, reader.child(chart, D.C, "plotArea"))
	// Plots without series still get the chart frame and title, as Office draws them.
	const drawable = area.plots.filter(plot => plot.series.length > 0)

	if (area.plots.length === 0 || W <= 0 || H <= 0) {
		return {
			list: target,
			supported: false,
			plots: area.found,
			unsupported: area.unsupported.length > 0 ? area.unsupported : ["empty"]
		}
	}

	const date1904 = reader.bool(reader.child(root, D.C, "date1904"), "val", false)
	const base: TextDefaults = { size: 10, color: textColor(theme), font: theme.minorFont.latin, bold: false, italic: false }
	const probe = new ChartBuilder(paintContext, reader, 2, date1904, base)
	const builder = new ChartBuilder(
		paintContext,
		reader,
		chartStyle(reader, root),
		date1904,
		probe.textProps(reader.child(root, D.C, "txPr"), base),
		matrix
	)
	const blanksNode = reader.child(chart, D.C, "dispBlanksAs")
	const blanksValue = blanksNode < 0 ? "gap" : (reader.attr(blanksNode, "val") ?? "zero")
	const blanks: Blanks = blanksValue === "span" || blanksValue === "zero" ? blanksValue : "gap"

	// Chart area.
	const chartSpPr = reader.child(root, D.C, "spPr")
	const rounded = reader.bool(reader.child(root, D.C, "roundedCorners"), "val", reader.child(root, D.C, "roundedCorners") < 0)
	const frame: Rect = { x: 0, y: 0, w: W, h: H }

	builder.begin()

	if (rounded) builder.roundRect(0.5, 0.5, W - 1, H - 1, Math.min(W, H) * 0.06)
	else builder.rect(0.5, 0.5, W - 1, H - 1)

	builder.end(
		builder.fill(chartSpPr, chartSpPr < 0 ? backgroundColor(theme) : undefined),
		builder.line(chartSpPr, chartSpPr < 0 ? { color: mutedText(theme, 0.15), width: 1, round: false } : undefined),
		frame,
		0,
		root
	)

	// Series styles, colours continuing across plots by c:idx.
	let seriesTotal = 0

	for (const plot of drawable) seriesTotal += plot.series.length

	const styles = new Map<number, SeriesStyle>()

	for (const plot of drawable) for (const [node, style] of seriesStyles(builder, plot, seriesTotal)) styles.set(node, style)

	// Axes used by the plots, oriented by the plot that uses them.
	const states = new Map<number, AxisState>()
	const radial = new Set<number>()
	const ranges = new Map<number, { min: number; max: number; percent: boolean }>()
	const plotAxes = new Map<Plot, { category: AxisState | undefined; value: AxisState | undefined }>()
	// Axes a plot uses but does not draw (a surface's value axis: its bands show the values), and surfaces' series axes.
	const unplotted = new Set<number>()
	const surfaceRows = new Map<Plot, AxisState | undefined>()
	const state = (id: number | undefined): AxisState | undefined => {
		if (id === undefined) return undefined

		let existing = states.get(id)

		if (existing === undefined) {
			const axis = area.axes.get(id)

			if (axis === undefined) return undefined

			const rotation = builder.textRotation(axis.txPr)

			existing = axisState(
				axis,
				builder.textProps(axis.txPr),
				rotation === undefined || Math.abs(rotation) > 360 ? 0 : rotation,
				// No rotation, or one beyond a turn: Excel 2013 and later write rot="-60000000" for "automatic".
				rotation === undefined || Math.abs(rotation) > 360
			)
			states.set(id, existing)
		}

		return existing
	}
	const widen = (id: number, value: number, percent: boolean): void => {
		if (!Number.isFinite(value)) return

		const range = ranges.get(id) ?? { min: Infinity, max: -Infinity, percent: false }

		range.min = Math.min(range.min, value)
		range.max = Math.max(range.max, value)
		range.percent ||= percent
		ranges.set(id, range)
	}
	// Automatic axis bounds take in the error bars' ends, as Office scales them.
	const widenErrorBars = (bars: ErrorBarData, data: ArrayLike<number> | null, count: number, id: number): void => {
		const spans = errorSpans(bars, data, count)

		for (let k = 0; k < count; k++) {
			const v = data?.[k] ?? Number.NaN

			widen(id, v + (spans[k * 2] ?? Number.NaN), false)
			widen(id, v + (spans[k * 2 + 1] ?? Number.NaN), false)
		}
	}
	const categories = new Map<Plot, string[]>()

	for (const plot of drawable) {
		if (plot.kind === "pie" || plot.kind === "doughnut") {
			categories.set(plot, plotCategories(plot, date1904, undefined))
			plotAxes.set(plot, { category: undefined, value: undefined })

			continue
		}

		if (plot.kind === "surface") {
			const category = state(plot.axisIds[0])
			const value = state(plot.axisIds[1])
			const rows = state(plot.axisIds[2])

			if (category === undefined || value === undefined) continue

			const names = plotCategories(plot, date1904, category.axis.format)
			let count = names.length

			for (const series of plot.series) {
				count = Math.max(count, series.values.count)

				for (let k = 0; k < series.values.count; k++) widen(value.axis.id, series.values.numbers?.[k] ?? Number.NaN, false)
			}

			// Seen from above: categories across, series up the side, points on the grid lines.
			category.used = true
			category.horizontal = true
			category.between = false
			category.count = Math.max(category.count, count)
			category.categories = names.length >= category.categories.length ? names : category.categories
			value.used = true
			value.horizontal = false
			value.format = value.axis.format ?? plot.series[0]?.values.formatCode ?? "General"
			unplotted.add(value.axis.id)

			if (rows !== undefined) {
				rows.used = true
				rows.horizontal = false
				rows.between = false
				rows.count = plot.series.length
				rows.categories = plot.series.map((series, order) => seriesName(series, order))
			}

			categories.set(plot, names)
			plotAxes.set(plot, { category, value })
			surfaceRows.set(plot, rows)

			continue
		}

		const first = state(plot.axisIds[0])
		const second = state(plot.axisIds[1])
		const xy = plot.kind === "scatter" || plot.kind === "bubble"
		const swap = !xy && first?.axis.kind === "val" && second !== undefined && second.axis.kind !== "val"
		const category = swap ? second : first
		const value = swap ? first : second

		if (category === undefined || value === undefined) continue

		category.used = true
		value.used = true

		if (xy) {
			category.horizontal =
				!(category.axis.side === "l" || category.axis.side === "r") || value.axis.side === "l" || value.axis.side === "r"
			value.horizontal = !category.horizontal
		} else {
			category.horizontal = !plot.horizontal
			value.horizontal = plot.horizontal
		}

		if (plot.kind === "radar") {
			radial.add(category.axis.id)
			radial.add(value.axis.id)
		}

		plotAxes.set(plot, { category, value })

		const names = plotCategories(plot, date1904, category.axis.format)

		categories.set(plot, names)

		const stacked = plot.grouping === "stacked" || plot.grouping === "percentStacked"
		const percent = plot.grouping === "percentStacked"
		let count = 0

		for (const series of plot.series) count = Math.max(count, series.values.count)

		if (xy) {
			for (const series of plot.series) {
				const xs = series.categories.numbers

				for (let k = 0; k < series.values.count; k++) {
					widen(value.axis.id, series.values.numbers?.[k] ?? Number.NaN, false)

					if (category.axis.kind === "val") widen(category.axis.id, xs === null ? k + 1 : (xs[k] ?? Number.NaN), false)
				}

				for (const bars of series.errorBars) {
					if (bars.direction === "x" && category.axis.kind !== "val") continue

					const data = bars.direction === "x" ? xs : series.values.numbers
					const count = bars.direction === "x" ? (xs?.length ?? 0) : series.values.count

					widenErrorBars(bars, data, count, bars.direction === "x" ? category.axis.id : value.axis.id)
				}
			}
		} else if (stacked) {
			const positive = new Float64Array(count)
			const negative = new Float64Array(count)
			const totals = new Float64Array(count)

			for (const series of plot.series) {
				for (let k = 0; k < series.values.count; k++) {
					const v = series.values.numbers?.[k] ?? Number.NaN

					if (!Number.isFinite(v)) continue

					totals[k] = (totals[k] ?? 0) + Math.abs(v)

					if (v >= 0) positive[k] = (positive[k] ?? 0) + v
					else negative[k] = (negative[k] ?? 0) + v
				}
			}

			for (let k = 0; k < count; k++) {
				const total = (totals[k] ?? 0) || 1

				widen(value.axis.id, percent ? (positive[k] ?? 0) / total : (positive[k] ?? 0), percent)
				widen(value.axis.id, percent ? (negative[k] ?? 0) / total : (negative[k] ?? 0), percent)
			}
		} else {
			for (const series of plot.series) {
				for (let k = 0; k < series.values.count; k++) widen(value.axis.id, series.values.numbers?.[k] ?? Number.NaN, false)
				for (const bars of series.errorBars)
					if (bars.direction === "y" || plot.horizontal)
						widenErrorBars(bars, series.values.numbers, series.values.count, value.axis.id)
			}
		}

		if (category.axis.kind !== "val") {
			category.count = Math.max(category.count, count, names.length)
			category.categories = names.length >= category.categories.length ? names : category.categories
			// Bars always sit in bands; lines and areas follow the value axis's c:crossBetween.
			category.between =
				plot.kind === "bar" || plot.kind === "radar" ? true : category.between && value.axis.crossBetween === "between"
		}

		if (value.axis.format === undefined) value.format = percent ? "0%" : (plot.series[0]?.values.formatCode ?? "General")
		else value.format = value.axis.format
	}

	for (const axisStateValue of states.values()) {
		if (axisStateValue.axis.kind === "val" && axisStateValue.axis.format !== undefined)
			axisStateValue.format = axisStateValue.axis.format
		if (axisStateValue.categories.length === 0 && axisStateValue.axis.kind !== "val") {
			axisStateValue.categories = Array.from({ length: axisStateValue.count }, (_, k) => String(k + 1))
		}
	}

	// Value scales from the data ranges and an estimate of the axis length.
	for (const [id, axisStateValue] of states) {
		if (axisStateValue.axis.kind !== "val") continue

		const range = ranges.get(id) ?? { min: 0, max: 1, percent: false }
		const length = axisStateValue.horizontal ? W * 0.7 : H * 0.6
		const spacing = axisStateValue.horizontal ? 72 : estimateHeight(axisStateValue.text.size) * 2

		axisStateValue.scale = computeScale({
			dataMin: range.min === Infinity ? 0 : range.min,
			dataMax: range.max === -Infinity ? 1 : range.max,
			min: axisStateValue.axis.min,
			max: axisStateValue.axis.max,
			major: axisStateValue.axis.major,
			logBase: axisStateValue.axis.logBase,
			maxIntervals: Math.max(2, Math.min(10, Math.floor(length / spacing))),
			percent: range.percent
		})
	}

	// Surface bands: one per interval of the value axis's ticks, coloured by c:bandFmt or the series colours.
	const bands = new Map<Plot, SurfaceBand[]>()

	for (const plot of drawable) {
		const scale = plot.kind === "surface" ? plotAxes.get(plot)?.value?.scale : undefined

		if (scale === undefined) continue

		const value = plotAxes.get(plot)?.value
		const ticks = scaleTicks(scale)
		const list: SurfaceBand[] = []
		const count = Math.max(0, ticks.length - 1)

		for (let k = 0; k < count; k++) {
			const low = ticks[k] ?? 0
			const high = ticks[k + 1] ?? 0
			const color = seriesColor(builder.theme, builder.style, k, count)
			const spPr = plot.bandFormats.get(k) ?? -1
			const format = value?.format ?? "General"

			list.push({
				low,
				high,
				label: `${formatNumber(low, format, date1904)}-${formatNumber(high, format, date1904)}`,
				fill: plot.wireframe ? -1 : builder.fill(spPr, color),
				stroke: plot.wireframe ? builder.line(spPr, { color, width: 1.5 * PX_PER_PT, round: true }) : builder.line(spPr, undefined)
			})
		}

		bands.set(plot, list)
	}

	const pad = Math.max(4, Math.min(10, Math.min(W, H) * 0.03))
	let content: Rect = { x: pad, y: pad, w: Math.max(1, W - pad * 2), h: Math.max(1, H - pad * 2) }

	// Title: c:title, or the series name of a single-series chart whose auto title is not deleted.
	const titleNode = reader.child(chart, D.C, "title")
	const autoDeleted = reader.child(chart, D.C, "autoTitleDeleted")
	const allSeries = drawable.flatMap(plot => plot.series)
	let title: { paragraphs: TextParagraph[]; rotation: number; box: Rect } | undefined

	if (titleNode >= 0 || (autoDeleted >= 0 && !reader.bool(autoDeleted, "val", true) && area.seriesTotal === 1)) {
		const defaults = builder.textProps(reader.child(titleNode, D.C, "txPr"), { ...builder.text, size: 18, bold: true })
		const fallback = allSeries.length === 1 ? seriesName(allSeries[0] as (typeof allSeries)[number], 0) : "Chart Title"
		const text = titleParagraphs(builder, titleNode, defaults, fallback)
		const titleHeight = paragraphsHeight(text.paragraphs, defaults.size)
		const titleWidth = Math.min(content.w, paragraphsWidth(text.paragraphs) + 8)
		const manual = manualLayout(reader, titleNode)
		const box: Rect =
			manual?.x !== undefined && manual.y !== undefined
				? { x: manual.x * W, y: manual.y * H, w: titleWidth, h: titleHeight }
				: { x: content.x + (content.w - titleWidth) / 2, y: content.y, w: titleWidth, h: titleHeight }

		title = { ...text, box }

		const overlay = reader.bool(reader.child(titleNode, D.C, "overlay"), "val", false)

		if (!overlay && manual === undefined)
			content = { x: content.x, y: content.y + titleHeight + pad, w: content.w, h: Math.max(1, content.h - titleHeight - pad) }
	}

	// Legend.
	const legendNode = reader.child(chart, D.C, "legend")
	let legend: { entries: LegendEntry[]; layout: LegendLayout; text: TextDefaults; key: number; row: number } | undefined

	if (legendNode >= 0) {
		const deleted = new Set<number>()

		for (const entry of reader.children(legendNode, D.C, "legendEntry")) {
			if (reader.bool(reader.child(entry, D.C, "delete"), "val", false))
				deleted.add(reader.number(reader.child(entry, D.C, "idx"), "val", -1))
		}

		const entries = legendEntries(builder, drawable, styles, categories, bands).filter((_, index) => !deleted.has(index))
		const text = builder.textProps(reader.child(legendNode, D.C, "txPr"))
		const key = text.size * PX_PER_PT * 0.75
		const row = Math.max(estimateHeight(text.size), key) + 2
		const sideValue = reader.attr(reader.child(legendNode, D.C, "legendPos"), "val") ?? "r"
		const side = sideValue === "l" || sideValue === "t" || sideValue === "b" || sideValue === "tr" ? sideValue : "r"
		const keyWidth = (entry: LegendEntry): number => (entry.line ? key * 2.5 : key)
		const entryWidth = (entry: LegendEntry): number => keyWidth(entry) + 4 + estimateWidth(entry.text, text.size)
		let boxWidth: number
		let boxHeight: number

		if (side === "t" || side === "b") {
			let rows = 1
			let line = 0
			let widest = 0

			for (const entry of entries) {
				const w = entryWidth(entry) + 10

				if (line > 0 && line + w > content.w) {
					rows++
					widest = Math.max(widest, line)
					line = 0
				}

				line += w
			}

			boxWidth = Math.min(content.w, Math.max(widest, line) + 8)
			boxHeight = rows * row + 8
		} else {
			let widest = 0

			for (const entry of entries) widest = Math.max(widest, entryWidth(entry))

			boxWidth = Math.min(content.w * 0.5, widest + 12)
			boxHeight = Math.min(content.h, entries.length * row + 8)
		}

		const manual = manualLayout(reader, legendNode)
		let box: Rect

		if (manual?.x !== undefined && manual.y !== undefined) {
			box = {
				x: manual.x * W,
				y: manual.y * H,
				w: manual.w === undefined ? boxWidth : manual.w * W,
				h: manual.h === undefined ? boxHeight : manual.h * H
			}
		} else if (side === "t") {
			box = { x: content.x + (content.w - boxWidth) / 2, y: content.y, w: boxWidth, h: boxHeight }
		} else if (side === "b") {
			box = { x: content.x + (content.w - boxWidth) / 2, y: content.y + content.h - boxHeight, w: boxWidth, h: boxHeight }
		} else if (side === "l") {
			box = { x: content.x, y: content.y + (content.h - boxHeight) / 2, w: boxWidth, h: boxHeight }
		} else if (side === "tr") {
			box = { x: content.x + content.w - boxWidth, y: content.y, w: boxWidth, h: boxHeight }
		} else {
			box = { x: content.x + content.w - boxWidth, y: content.y + (content.h - boxHeight) / 2, w: boxWidth, h: boxHeight }
		}

		const overlay = reader.bool(reader.child(legendNode, D.C, "overlay"), "val", false)

		// A legend moved by hand keeps its space at its side: Office lays the plot area out as if it were
		// still there.
		if (!overlay && entries.length > 0) {
			const reservedHeight = manual === undefined ? boxHeight : Math.min(content.h * 0.8, box.h)
			const reservedWidth = manual === undefined ? boxWidth : Math.min(content.w * 0.8, box.w)

			if (side === "t") {
				content = {
					x: content.x,
					y: content.y + reservedHeight + pad,
					w: content.w,
					h: Math.max(1, content.h - reservedHeight - pad)
				}
			} else if (side === "b") {
				content = { x: content.x, y: content.y, w: content.w, h: Math.max(1, content.h - reservedHeight - pad) }
			} else if (side === "l") {
				content = {
					x: content.x + reservedWidth + pad,
					y: content.y,
					w: Math.max(1, content.w - reservedWidth - pad),
					h: content.h
				}
			} else {
				content = { x: content.x, y: content.y, w: Math.max(1, content.w - reservedWidth - pad), h: content.h }
			}
		}

		if (entries.length > 0) legend = { entries, layout: { box, side }, text, key, row }
	}

	// Plot area: manual layout, else what is left after the axes' labels.
	const plotAreaNode = area.node
	const manualPlot = manualLayout(reader, plotAreaNode)
	let outer: Rect = content
	let innerTarget = false

	if (manualPlot?.x !== undefined && manualPlot.y !== undefined && manualPlot.w !== undefined && manualPlot.h !== undefined) {
		outer = { x: manualPlot.x * W, y: manualPlot.y * H, w: Math.max(1, manualPlot.w * W), h: Math.max(1, manualPlot.h * H) }
		innerTarget = manualPlot.inner
	}

	let inner = outer

	if (!innerTarget) {
		const reserve = { t: 0, b: 0, l: 0, r: 0 }
		// Vertical axes first: the room they leave is the length horizontal category labels are fitted to.
		const cartesianStates = [...states.entries()]
			.filter(([id]) => !radial.has(id) && !unplotted.has(id))
			.sort(([, a], [, b]) => Number(a.horizontal) - Number(b.horizontal))

		for (const [, axisStateValue] of cartesianStates) {
			if (axisStateValue.horizontal) autoRotateLabels(axisStateValue, Math.max(1, outer.w - reserve.l - reserve.r))

			const extent = axisExtent(builder, axisStateValue)
			const side = axisStateValue.horizontal
				? axisStateValue.axis.side === "t"
					? "t"
					: "b"
				: axisStateValue.axis.side === "r"
					? "r"
					: "l"

			reserve[side] = Math.max(reserve[side], extent)
		}

		// Half a label of room at the ends of horizontal value axes, whose end labels centre on the edge.
		inner = {
			x: outer.x + reserve.l,
			y: outer.y + reserve.t,
			w: Math.max(1, outer.w - reserve.l - reserve.r),
			h: Math.max(1, outer.h - reserve.t - reserve.b)
		}
	}

	if (innerTarget)
		for (const [id, axisStateValue] of states)
			if (!radial.has(id) && axisStateValue.horizontal) autoRotateLabels(axisStateValue, inner.w)

	for (const axisStateValue of states.values()) setSpan(axisStateValue, inner)

	for (const axisStateValue of states.values()) {
		const cross = states.get(axisStateValue.axis.crossAxis)

		axisStateValue.line =
			cross === undefined ? (axisStateValue.horizontal ? inner.y + inner.h : inner.x) : crossingPosition(cross, axisStateValue.axis)
	}

	// A surface's axes meet at its lower left corner (its value axis is not drawn to cross them).
	for (const [plot, rows] of surfaceRows) {
		const category = plotAxes.get(plot)?.category

		if (category !== undefined) category.line = inner.y + inner.h
		if (rows !== undefined) rows.line = inner.x
	}

	// Plot area fill.
	const plotSpPr = reader.child(plotAreaNode, D.C, "spPr")

	if (plotSpPr >= 0) {
		builder.begin()
		builder.rect(inner.x, inner.y, inner.w, inner.h)
		builder.end(builder.fill(plotSpPr, undefined), builder.line(plotSpPr, undefined), inner, 0, plotAreaNode)
	}

	const cartesian = [...states.entries()].filter(([id]) => !radial.has(id) && !unplotted.has(id)).map(([, value]) => value)

	for (const axisStateValue of cartesian) if (axisStateValue.axis.kind === "val") drawGridlines(builder, axisStateValue, inner)
	for (const axisStateValue of cartesian) if (axisStateValue.axis.kind !== "val") drawGridlines(builder, axisStateValue, inner)

	const pending: PendingLabel[] = []
	const ordered = [...drawable].sort((a, b) => (PLOT_RANK[a.kind] ?? 0) - (PLOT_RANK[b.kind] ?? 0))

	for (const plot of ordered) {
		const axes = plotAxes.get(plot)

		if (axes === undefined) continue

		const plotFrame: PlotFrame = {
			builder,
			plot,
			styles,
			inner,
			categoryAxis: axes.category,
			valueAxis: axes.value,
			labels: pending,
			blanks,
			categories: categories.get(plot) ?? []
		}

		switch (plot.kind) {
			case "bar":
				drawBars(plotFrame)
				break
			case "line":
			case "area":
				drawLinesOrAreas(plotFrame)
				break
			case "scatter":
				drawScatter(plotFrame)
				break
			case "bubble":
				drawBubbles(plotFrame)
				break
			case "surface":
				drawSurface(plotFrame, surfaceRows.get(plot), bands.get(plot) ?? [])
				break
			case "pie":
			case "doughnut":
				drawPie(plotFrame)
				break
			case "radar":
				drawRadar(plotFrame)
				break
		}
	}

	for (const axisStateValue of cartesian) drawAxisLine(builder, axisStateValue)
	for (const axisStateValue of cartesian)
		if (tickLabels(axisStateValue).length > 0 || axisStateValue.axis.title >= 0) drawAxisLabels(builder, axisStateValue, inner)

	emitLabels(builder, pending)

	if (legend !== undefined) drawLegend(builder, legendNode, legend)
	if (title !== undefined) builder.label(title.paragraphs, title.box, labelBody("t", title.rotation), titleNode)

	const truncated = drawable.some(surfaceTruncated) ? ["surfaceCells"] : []

	return { list: target, supported: true, plots: area.found, unsupported: [...area.unsupported, ...truncated] }
}

function drawLegend(
	builder: ChartBuilder,
	node: number,
	legend: { entries: LegendEntry[]; layout: LegendLayout; text: TextDefaults; key: number; row: number }
): void {
	const { box, side } = legend.layout
	const spPr = builder.reader.child(node, D.C, "spPr")

	if (spPr >= 0) {
		builder.begin()
		builder.rect(box.x, box.y, box.w, box.h)
		builder.end(builder.fill(spPr, undefined), builder.line(spPr, undefined), box, 0, node)
	}

	const horizontal = side === "t" || side === "b"
	const key = legend.key
	const row = legend.row
	let x = box.x + 4
	let y = box.y + 4

	for (const entry of legend.entries) {
		const keyWidth = entry.line ? key * 2.5 : key
		const textWidth = estimateWidth(entry.text, legend.text.size) + 4

		if (horizontal && x > box.x + 4 && x + keyWidth + 4 + textWidth > box.x + box.w) {
			x = box.x + 4
			y += row
		}

		const middle = y + row / 2

		builder.begin()

		if (entry.line) builder.segment(x, middle, x + keyWidth, middle)
		else builder.rect(x, middle - key / 2, key, key)

		builder.end(entry.fill, entry.stroke, { x, y: middle - key / 2, w: keyWidth, h: key }, 0, node)

		if (entry.marker !== undefined) {
			builder.begin()
			appendMarker(builder, entry.marker.symbol, x + keyWidth / 2, middle, Math.min(entry.marker.radius, key / 2))
			builder.end(entry.marker.fill, entry.marker.stroke, { x, y: middle - key / 2, w: keyWidth, h: key }, 0, node)
		}

		const textBox: Rect = {
			x: x + keyWidth + 4,
			y,
			w: horizontal ? textWidth : Math.max(textWidth, box.x + box.w - (x + keyWidth + 4)),
			h: row
		}

		builder.label([plainParagraph(entry.text, legend.text, "l")], textBox, labelBody("ctr"), node)

		if (horizontal) x += keyWidth + 4 + textWidth + 10
		else y += row
	}
}

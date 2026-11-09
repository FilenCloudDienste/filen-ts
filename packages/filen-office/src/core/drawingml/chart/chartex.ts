import type { TextParagraph } from "../displayList"
import type { PaintContext } from "../fill"
import type { XmlDocument } from "../../xml/index"
import { D, drawingReader, type DrawingReader } from "../reader"
import { plainParagraph, readTextBody, type TextDefaults } from "../text"
import { ChartBuilder, PX_PER_PT, estimateHeight, estimateWidth, labelBody, type LineDefault, type Rect } from "./builder"
import { formatNumber } from "./format"
import { backgroundColor, mutedText, seriesColor, textColor } from "./palette"
import { computeScale, scaleTicks, type Scale } from "./scale"
import { appendMarker } from "./series"

// Office 2016 charts (cx:chartSpace, [MS-ODRAWXML] §2.24 chartex): waterfall, funnel, histogram, Pareto, box and
// whisker, treemap and sunburst, drawn from the values cached in cx:chartData. Region maps need map data and are
// reported, not drawn.

export interface ChartexConversion {
	readonly supported: boolean
	// The layoutIds of the series found.
	readonly plots: string[]
	// "chartex:<layoutId>" for series not drawn.
	readonly unsupported: string[]
}

// Points read from one dimension level, and the leaves a hierarchy chart lays out.
const MAX_POINTS = 1 << 20
// The most boxes a treemap or sunburst draws.
const MAX_CELLS = 20000

const DRAWN: ReadonlySet<string> = new Set(["waterfall", "funnel", "clusteredColumn", "paretoLine", "boxWhisker", "treemap", "sunburst"])

interface Dimension {
	// Category levels, leaf level first (the order cx:lvl elements are written in).
	readonly levels: readonly (readonly string[])[]
	readonly values: Float64Array
	readonly count: number
	readonly format: string
}

interface Labels {
	readonly value: boolean
	readonly category: boolean
	readonly text: TextDefaults
	readonly format: string | undefined
}

interface Series {
	readonly node: number
	readonly layout: string
	readonly name: string
	readonly data: Dimension
	readonly spPr: number
	readonly points: ReadonlyMap<number, number>
	readonly labels: Labels | undefined
	readonly layoutPr: number
	readonly owner: number
	readonly color: number
}

interface Axis {
	readonly node: number
	readonly id: number
	readonly category: boolean
	readonly hidden: boolean
	readonly min: number | undefined
	readonly max: number | undefined
	readonly major: number | undefined
	readonly gap: number | undefined
	readonly gridlines: number
	readonly tickLabels: boolean
	readonly format: string | undefined
	readonly text: TextDefaults
}

function numberAttr(reader: DrawingReader, node: number, local: string): number | undefined {
	const value = reader.number(node, local, Number.NaN)

	return Number.isFinite(value) ? value : undefined
}

function readLevel(reader: DrawingReader, level: number, into: (index: number, text: string) => void): number {
	let count = Math.max(0, Math.min(MAX_POINTS, Math.floor(reader.number(level, "ptCount", 0))))
	const document = reader.document

	for (let pt = document.firstChildElement(level); pt >= 0; pt = document.nextSiblingElement(pt)) {
		if (!reader.is(pt, D.Cx, "pt")) continue

		const index = Math.floor(reader.number(pt, "idx", -1))

		if (index < 0 || index >= MAX_POINTS) continue

		into(index, reader.text(pt))
		count = Math.max(count, index + 1)
	}

	return count
}

function readDimension(reader: DrawingReader, data: number): Dimension {
	const levels: string[][] = []
	let values = new Float64Array(0)
	let count = 0
	let format = "General"
	let valueRank = 0

	for (let child = reader.document.firstChildElement(data); child >= 0; child = reader.document.nextSiblingElement(child)) {
		const numeric = reader.is(child, D.Cx, "numDim")

		if (!numeric && !reader.is(child, D.Cx, "strDim")) continue

		const type = reader.attr(child, "type") ?? (numeric ? "val" : "cat")

		if (type === "cat") {
			for (const level of reader.children(child, D.Cx, "lvl")) {
				const labels: string[] = []
				const code = reader.attr(level, "formatCode") ?? "General"
				const n = readLevel(reader, level, (index, text) => {
					const value = Number(text.trim())

					labels[index] = numeric && text.trim() !== "" && Number.isFinite(value) ? formatNumber(value, code) : text
				})

				count = Math.max(count, n)
				levels.push(labels)
			}

			continue
		}

		// The plotted values: "val", else a hierarchy's "size", else the first other numeric dimension.
		const rank = type === "val" ? 3 : type === "size" ? 2 : numeric ? 1 : 0
		const level = reader.child(child, D.Cx, "lvl")

		if (!numeric || rank <= valueRank || level < 0) continue

		valueRank = rank

		const read: number[] = []
		const n = readLevel(reader, level, (index, text) => {
			const value = Number(text.trim())

			read[index] = text.trim() !== "" && Number.isFinite(value) ? value : Number.NaN
		})

		values = new Float64Array(n).fill(Number.NaN)

		for (let k = 0; k < read.length; k++) values[k] = read[k] ?? Number.NaN

		format = reader.attr(level, "formatCode") ?? "General"
		count = Math.max(count, n)
	}

	return { levels, values, count, format }
}

function readData(reader: DrawingReader, root: number): Map<number, Dimension> {
	const out = new Map<number, Dimension>()

	for (const data of reader.children(reader.child(root, D.Cx, "chartData"), D.Cx, "data"))
		out.set(Math.floor(reader.number(data, "id", 0)), readDimension(reader, data))

	return out
}

function textOf(reader: DrawingReader, tx: number): string {
	return reader.text(reader.child(reader.child(tx, D.Cx, "txData"), D.Cx, "v"))
}

const EMPTY: Dimension = { levels: [], values: new Float64Array(0), count: 0, format: "General" }

function readLabels(builder: ChartBuilder, node: number, hierarchy: boolean, base: TextDefaults): Labels | undefined {
	if (node < 0) return undefined

	const reader = builder.reader
	const visibility = reader.child(node, D.Cx, "visibility")

	return {
		value: reader.bool(visibility, "value", !hierarchy),
		category: reader.bool(visibility, "categoryName", hierarchy),
		text: builder.textProps(reader.child(node, D.Cx, "txPr"), base),
		format: reader.attr(reader.child(node, D.Cx, "numFmt"), "formatCode")
	}
}

function readAxes(builder: ChartBuilder, plotArea: number, base: TextDefaults): Axis[] {
	const reader = builder.reader

	return reader.children(plotArea, D.Cx, "axis").map(node => {
		const catScaling = reader.child(node, D.Cx, "catScaling")
		const valScaling = reader.child(node, D.Cx, "valScaling")
		const gap = numberAttr(reader, catScaling, "gapWidth")

		return {
			node,
			id: Math.floor(reader.number(node, "id", -1)),
			category: catScaling >= 0 || valScaling < 0,
			hidden: reader.bool(node, "hidden", false),
			min: numberAttr(reader, valScaling, "min"),
			max: numberAttr(reader, valScaling, "max"),
			major: numberAttr(reader, valScaling, "majorUnit"),
			gap: gap === undefined ? undefined : Math.max(0, Math.min(5, gap)),
			gridlines: reader.child(node, D.Cx, "majorGridlines"),
			tickLabels: reader.child(node, D.Cx, "tickLabels") >= 0,
			format: reader.attr(reader.child(node, D.Cx, "numFmt"), "formatCode"),
			text: builder.textProps(reader.child(node, D.Cx, "txPr"), base)
		}
	})
}

// The fill of a point: its own c:dataPt spPr, else its series', else `color`.
function fillOf(builder: ChartBuilder, point: number, series: number, color: number): number {
	const own = point < 0 ? -1 : builder.fill(point, undefined)

	return own >= 0 ? own : builder.fill(series, color)
}

function lineOf(builder: ChartBuilder, point: number, series: number, fallback: LineDefault | undefined): number {
	return point >= 0 && builder.reader.child(point, D.A, "ln") >= 0 ? builder.line(point, fallback) : builder.line(series, fallback)
}

// Quartiles ---------------------------------------------------------------------------------------------------------

// The `p` quantile of ascending `sorted` (QUARTILE.EXC with `exclusive`, else QUARTILE.INC), clamped to the data.
export function quantile(sorted: Float64Array, p: number, exclusive: boolean): number {
	const n = sorted.length

	if (n === 0) return Number.NaN
	if (n === 1) return sorted[0] ?? Number.NaN

	const h = Math.max(0, Math.min(n - 1, exclusive ? (n + 1) * p - 1 : (n - 1) * p))
	const low = Math.floor(h)
	const a = sorted[low] ?? 0
	const b = sorted[Math.min(n - 1, low + 1)] ?? a

	return a + (h - low) * (b - a)
}

export interface BoxStats {
	readonly q1: number
	readonly median: number
	readonly q3: number
	readonly mean: number
	// Whisker ends: the furthest values within 1.5 interquartile ranges of the box.
	readonly low: number
	readonly high: number
	readonly outliers: number[]
}

export function boxStats(values: Float64Array, exclusive: boolean): BoxStats | undefined {
	const sorted = values.filter(Number.isFinite).sort()
	const n = sorted.length

	if (n === 0) return undefined

	const q1 = quantile(sorted, 0.25, exclusive)
	const median = quantile(sorted, 0.5, exclusive)
	const q3 = quantile(sorted, 0.75, exclusive)
	const reach = 1.5 * (q3 - q1)
	let low = Infinity
	let high = -Infinity
	let sum = 0
	const outliers: number[] = []

	for (let k = 0; k < n; k++) {
		const v = sorted[k] ?? 0

		sum += v

		if (v < q1 - reach || v > q3 + reach) {
			outliers.push(v)

			continue
		}

		low = Math.min(low, v)
		high = Math.max(high, v)
	}

	return { q1, median, q3, mean: sum / n, low: low === Infinity ? q1 : low, high: high === -Infinity ? q3 : high, outliers }
}

// Histogram bins ----------------------------------------------------------------------------------------------------

export interface Bin {
	readonly label: string
	readonly count: number
}

export interface Binning {
	readonly size: number | undefined
	readonly count: number | undefined
	readonly underflow: number | undefined
	readonly overflow: number | undefined
	// Bins include their right edge ("(a, b]"), else their left ("[a, b)").
	readonly right: boolean
}

const MAX_BINS = 1000

// Bins of the finite values, as Excel lays them out: from the smallest value (or the underflow bin's edge) in steps
// of the bin size, the count's equal widths, or Scott's normal reference rule.
export function histogramBins(values: Float64Array, binning: Binning, format: string): Bin[] {
	let min = Infinity
	let max = -Infinity
	let n = 0
	let sum = 0

	for (const v of values) {
		if (!Number.isFinite(v)) continue

		min = Math.min(min, v)
		max = Math.max(max, v)
		sum += v
		n++
	}

	if (n === 0) return []

	const low = binning.underflow ?? min
	const high = binning.overflow ?? max
	const span = Math.max(0, high - low)
	let size = binning.size !== undefined && binning.size > 0 ? binning.size : undefined

	if (size === undefined && binning.count !== undefined && binning.count >= 1) size = span / Math.floor(binning.count)

	if (size === undefined) {
		const mean = sum / n
		let squares = 0

		for (const v of values) if (Number.isFinite(v)) squares += (v - mean) ** 2

		const deviation = n > 1 ? Math.sqrt(squares / (n - 1)) : 0

		size = (3.5 * deviation) / Math.cbrt(n)
	}

	const count = span > 0 && size > 0 ? Math.max(1, Math.min(MAX_BINS, Math.ceil(span / size - 1e-9))) : 1
	const width = span > 0 && size > 0 ? size : 0
	const counts = new Float64Array(count)
	let under = 0
	let over = 0

	for (const v of values) {
		if (!Number.isFinite(v)) continue

		if (binning.underflow !== undefined && (binning.right ? v <= low : v < low)) {
			under++

			continue
		}

		if (binning.overflow !== undefined && (binning.right ? v > high : v >= high)) {
			over++

			continue
		}

		let index = width > 0 ? (binning.right ? Math.ceil((v - low) / width) - 1 : Math.floor((v - low) / width)) : 0

		index = Math.max(0, Math.min(count - 1, index))
		counts[index] = (counts[index] ?? 0) + 1
	}

	const edge = (v: number): string => formatNumber(Number(v.toPrecision(12)), format)
	const out: Bin[] = []

	if (binning.underflow !== undefined) out.push({ label: `${binning.right ? "≤" : "<"}${edge(low)}`, count: under })

	for (let k = 0; k < count; k++) {
		const a = low + k * width
		const b = k === count - 1 && binning.overflow === undefined ? Math.max(high, a + width) : a + width
		const closedLeft = !binning.right || (k === 0 && binning.underflow === undefined)
		const closedRight = binning.right || (k === count - 1 && binning.overflow === undefined)

		out.push({ label: `${closedLeft ? "[" : "("}${edge(a)}, ${edge(b)}${closedRight ? "]" : ")"}`, count: counts[k] ?? 0 })
	}

	if (binning.overflow !== undefined) out.push({ label: `${binning.right ? ">" : "≥"}${edge(high)}`, count: over })

	return out
}

// Treemap layout ----------------------------------------------------------------------------------------------------

// Squarified treemap (Bruls, Huizing, van Wijk) of descending positive `sizes` over `box`: one rectangle per size.
export function squarify(sizes: readonly number[], box: Rect): Rect[] {
	const out: Rect[] = []
	let total = 0

	for (const size of sizes) total += size

	if (!(total > 0) || box.w <= 0 || box.h <= 0) return sizes.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }))

	const scale = (box.w * box.h) / total
	let x = box.x
	let y = box.y
	let w = box.w
	let h = box.h
	let i = 0

	while (i < sizes.length) {
		const side = Math.max(1e-9, Math.min(w, h))
		let rowSum = 0
		let rowMin = Infinity
		let rowMax = 0
		let best = Infinity
		let j = i

		while (j < sizes.length) {
			const a = (sizes[j] ?? 0) * scale
			const s = rowSum + a
			const mn = Math.min(rowMin, a)
			const mx = Math.max(rowMax, a)
			const worst = Math.max((side * side * mx) / (s * s), (s * s) / (side * side * Math.max(1e-12, mn)))

			if (j > i && worst > best) break

			best = worst
			rowSum = s
			rowMin = mn
			rowMax = mx
			j++
		}

		const thickness = rowSum / side
		let offset = 0

		for (let k = i; k < j; k++) {
			const length = ((sizes[k] ?? 0) * scale) / Math.max(1e-12, thickness)

			out.push(w >= h ? { x, y: y + offset, w: thickness, h: length } : { x: x + offset, y, w: length, h: thickness })
			offset += length
		}

		if (w >= h) {
			x += thickness
			w = Math.max(0, w - thickness)
		} else {
			y += thickness
			h = Math.max(0, h - thickness)
		}

		i = j
	}

	return out
}

interface TreeNode {
	readonly name: string
	value: number
	// The point a leaf was read from (its cx:dataPt), else -1.
	point: number
	readonly children: TreeNode[]
	readonly byName: Map<string, TreeNode>
}

function node(name: string): TreeNode {
	return { name, value: 0, point: -1, children: [], byName: new Map() }
}

// The category hierarchy of a treemap or sunburst: points with positive values, merged by their path from the
// outermost level, children sorted largest first.
function hierarchy(data: Dimension): { root: TreeNode; depth: number } {
	const root = node("")
	let depth = 0
	let leaves = 0

	for (let k = 0; k < data.count && leaves < MAX_CELLS; k++) {
		const value = data.values[k] ?? Number.NaN

		if (!(value > 0)) continue

		let current = root
		let level = 0

		for (let l = data.levels.length - 1; l >= 0; l--) {
			const name = data.levels[l]?.[k] ?? ""

			if (name === "") continue

			let next = current.byName.get(name)

			if (next === undefined) {
				next = node(name)
				current.byName.set(name, next)
				current.children.push(next)
			}

			next.value += value
			current = next
			level++
		}

		if (current === root) {
			const leaf = node(String(k + 1))

			leaf.value = value
			root.children.push(leaf)
			current = leaf
			level = 1
		}

		root.value += value
		current.point = k
		depth = Math.max(depth, level)
		leaves++
	}

	const sort = (parent: TreeNode): void => {
		parent.children.sort((a, b) => b.value - a.value)

		for (const child of parent.children) sort(child)
	}

	sort(root)

	return { root, depth }
}

// Drawing -------------------------------------------------------------------------------------------------------------

interface Legend {
	readonly text: string
	readonly fill: number
	readonly stroke: number
	readonly line: boolean
}

interface Frame {
	readonly builder: ChartBuilder
	readonly series: readonly Series[]
	readonly axes: readonly Axis[]
	readonly area: Rect
	readonly legend: Legend[]
	readonly axisText: TextDefaults
}

function categoryAt(data: Dimension, k: number): string {
	return data.levels[0]?.[k] ?? String(k + 1)
}

function valueLabel(builder: ChartBuilder, text: string, props: TextDefaults, box: Rect, anchor: "t" | "ctr" | "b"): void {
	if (text === "") return

	builder.label([plainParagraph(text, props)], box, labelBody(anchor))
}

function pointLabel(labels: Labels, category: string, value: number, format: string): string {
	const parts: string[] = []

	if (labels.category && category !== "") parts.push(category)
	if (labels.value && Number.isFinite(value)) parts.push(formatNumber(value, labels.format ?? format))

	return parts.join("\n")
}

interface Cartesian {
	readonly inner: Rect
	readonly scale: Scale
	readonly y: (value: number) => number
	readonly band: number
}

function axisFor(axes: readonly Axis[], category: boolean, skip: number = 0): Axis | undefined {
	return axes.filter(axis => axis.category === category)[skip]
}

// A vertical value axis over category bands: gridlines, value labels at the left (and a percent axis at the right),
// category labels below. Returns where values and bands fall.
function cartesian(
	frame: Frame,
	categories: readonly string[],
	dataMin: number,
	dataMax: number,
	format: string,
	percentAxis: Axis | undefined
): Cartesian {
	const { builder, area, axisText } = frame
	const valueAxis = axisFor(frame.axes, false)
	const categoryAxis = axisFor(frame.axes, true)
	const valueText = valueAxis?.text ?? axisText
	const categoryText = categoryAxis?.text ?? axisText
	const showValues = valueAxis !== undefined && !valueAxis.hidden && valueAxis.tickLabels
	const showCategories = categoryAxis === undefined || (!categoryAxis.hidden && categoryAxis.tickLabels)
	const showPercent = percentAxis !== undefined && !percentAxis.hidden && percentAxis.tickLabels
	const lineHeight = estimateHeight(valueText.size)
	const scale = computeScale({
		dataMin: Number.isFinite(dataMin) ? Math.min(0, dataMin) : 0,
		dataMax: Number.isFinite(dataMax) ? Math.max(0, dataMax) : 1,
		min: valueAxis?.min,
		max: valueAxis?.max,
		major: valueAxis?.major,
		logBase: 0,
		maxIntervals: Math.max(2, Math.min(10, Math.floor(area.h / (lineHeight * 2)))),
		percent: false
	})
	const ticks = scaleTicks(scale)
	const valueFormat = valueAxis?.format ?? format
	const tickText = ticks.map(tick => formatNumber(tick, valueFormat))
	let left = 0

	if (showValues) for (const text of tickText) left = Math.max(left, estimateWidth(text, valueText.size) + 6)

	const right = showPercent ? estimateWidth("100%", (percentAxis?.text ?? axisText).size) + 6 : lineHeight / 2
	const count = Math.max(1, categories.length)
	const bandGuess = Math.max(1, (area.w - left - right) / count)
	let lines = 1

	for (const name of categories) if (estimateWidth(name, categoryText.size) > bandGuess) lines = 2

	const bottom = showCategories ? estimateHeight(categoryText.size, lines) + 4 : 0
	const inner: Rect = {
		x: area.x + left,
		y: area.y + lineHeight / 2,
		w: Math.max(1, area.w - left - right),
		h: Math.max(1, area.h - bottom - lineHeight / 2)
	}
	const y = (value: number): number => inner.y + inner.h - ((value - scale.min) / (scale.max - scale.min || 1)) * inner.h
	const band = inner.w / count
	const gridColor = mutedText(builder.theme, 0.15)

	if (valueAxis !== undefined && valueAxis.gridlines >= 0) {
		const stroke = builder.line(builder.reader.child(valueAxis.gridlines, D.Cx, "spPr"), {
			color: gridColor,
			width: 0.75 * PX_PER_PT,
			round: false
		})

		builder.begin()

		for (const tick of ticks) builder.segment(inner.x, y(tick), inner.x + inner.w, y(tick))

		builder.end(-1, stroke, inner, 0, valueAxis.node)
	}

	if (showValues) {
		ticks.forEach((tick, index) => {
			builder.label(
				[plainParagraph(tickText[index] ?? "", valueText, "r")],
				{ x: area.x, y: y(tick) - lineHeight / 2, w: left - 4, h: lineHeight },
				labelBody("ctr"),
				valueAxis.node
			)
		})
	}

	if (showPercent) {
		const text = percentAxis.text

		for (let k = 0; k <= 5; k++) {
			const at = inner.y + inner.h - (k / 5) * inner.h

			builder.label(
				[plainParagraph(`${String(k * 20)}%`, text, "l")],
				{ x: inner.x + inner.w + 4, y: at - lineHeight / 2, w: right - 4, h: lineHeight },
				labelBody("ctr"),
				percentAxis.node
			)
		}
	}

	// The category axis line at zero.
	const zero = y(Math.max(scale.min, Math.min(scale.max, 0)))

	builder.begin()
	builder.segment(inner.x, zero, inner.x + inner.w, zero)
	builder.end(-1, builder.plainStroke(mutedText(builder.theme, 0.25), 0.75 * PX_PER_PT), inner, 0, categoryAxis?.node ?? -1)

	if (showCategories) {
		categories.forEach((name, index) => {
			builder.label(
				[plainParagraph(name, categoryText)],
				{ x: inner.x + index * band, y: inner.y + inner.h + 2, w: band, h: bottom - 2 },
				{ ...labelBody("t"), wrap: lines > 1 },
				categoryAxis?.node ?? -1
			)
		})
	}

	return { inner, scale, y, band }
}

function barWidth(band: number, axis: Axis | undefined, fallback: number): number {
	const gap = axis?.gap ?? fallback

	return band / (1 + gap)
}

function drawWaterfall(frame: Frame, series: Series): void {
	const { builder } = frame
	const reader = builder.reader
	const data = series.data
	const subtotals = new Set<number>()

	for (const idx of reader.children(reader.child(series.layoutPr, D.Cx, "subtotals"), D.Cx, "idx"))
		subtotals.add(Math.floor(reader.number(idx, "val", -1)))

	const connectors = reader.bool(reader.child(series.layoutPr, D.Cx, "visibility"), "connectorLines", true)
	const count = data.count
	const starts = new Float64Array(count)
	const ends = new Float64Array(count)
	let running = 0
	let min = 0
	let max = 0

	for (let k = 0; k < count; k++) {
		const v = data.values[k] ?? Number.NaN
		const value = Number.isFinite(v) ? v : 0

		if (subtotals.has(k)) {
			starts[k] = 0
			ends[k] = value
			running = value
		} else {
			starts[k] = running
			running += value
			ends[k] = running
		}

		min = Math.min(min, starts[k] ?? 0, ends[k] ?? 0)
		max = Math.max(max, starts[k] ?? 0, ends[k] ?? 0)
	}

	const categories = Array.from({ length: count }, (_, k) => categoryAt(data, k))
	const plot = cartesian(frame, categories, min, max, data.format, undefined)
	const width = barWidth(plot.band, axisFor(frame.axes, true), 0.5)
	const theme = builder.theme
	const colors = [seriesColor(theme, 2, 0, 3), seriesColor(theme, 2, 1, 3), seriesColor(theme, 2, 2, 3)]
	const paints = colors.map(color => builder.fill(series.spPr, color))
	const stroke = builder.line(series.spPr, undefined)
	const connector = builder.plainStroke(mutedText(theme, 0.5), 0.75 * PX_PER_PT)

	for (let k = 0; k < count; k++) {
		const start = starts[k] ?? 0
		const end = ends[k] ?? 0
		const kind = subtotals.has(k) ? 2 : end >= start ? 0 : 1
		const x = plot.inner.x + k * plot.band + (plot.band - width) / 2
		const top = plot.y(Math.max(start, end))
		const box: Rect = { x, y: top, w: width, h: Math.max(0.5, plot.y(Math.min(start, end)) - top) }
		const point = series.points.get(k) ?? -1
		const fill = point >= 0 && builder.fill(point, undefined) >= 0 ? builder.fill(point, undefined) : (paints[kind] ?? -1)

		builder.begin()
		builder.rect(box.x, box.y, box.w, box.h)
		builder.end(fill, point >= 0 ? lineOf(builder, point, series.spPr, undefined) : stroke, box, 0, series.node)

		if (connectors && k + 1 < count) {
			builder.begin()
			builder.segment(x + width, plot.y(end), x + plot.band, plot.y(end))
			builder.end(-1, connector, box, 0, series.node)
		}

		if (series.labels !== undefined) {
			const v = data.values[k] ?? Number.NaN
			const text = pointLabel(series.labels, categories[k] ?? "", v, data.format)
			const height = estimateHeight(series.labels.text.size, text.split("\n").length)
			const above = end >= start

			valueLabel(
				builder,
				text,
				series.labels.text,
				{ x: x - plot.band / 2, y: above ? box.y - height : box.y + box.h, w: width + plot.band, h: height },
				above ? "b" : "t"
			)
		}
	}

	frame.legend.push(
		{ text: "Increase", fill: paints[0] ?? -1, stroke, line: false },
		{ text: "Decrease", fill: paints[1] ?? -1, stroke, line: false },
		{ text: "Total", fill: paints[2] ?? -1, stroke, line: false }
	)
}

function drawFunnel(frame: Frame, series: Series): void {
	const { builder, area } = frame
	const data = series.data
	const count = data.count
	const axis = axisFor(frame.axes, true)
	const text = axis?.text ?? frame.axisText
	const showCategories = axis === undefined || (!axis.hidden && axis.tickLabels)
	const categories = Array.from({ length: count }, (_, k) => categoryAt(data, k))
	let left = 0
	let max = 0

	if (showCategories) for (const name of categories) left = Math.max(left, estimateWidth(name, text.size) + 8)

	left = Math.min(area.w * 0.4, left)

	for (let k = 0; k < count; k++) max = Math.max(max, Math.abs(data.values[k] ?? 0) || 0)

	const inner: Rect = { x: area.x + left, y: area.y, w: Math.max(1, area.w - left), h: area.h }
	const band = inner.h / Math.max(1, count)
	const height = barWidth(band, axis, 0.06)
	const color = seriesColor(builder.theme, 2, series.color, 1)
	const stroke = builder.line(series.spPr, undefined)
	const middle = inner.x + inner.w / 2

	for (let k = 0; k < count; k++) {
		const v = data.values[k] ?? Number.NaN
		const w = max > 0 && Number.isFinite(v) ? (Math.abs(v) / max) * inner.w : 0
		const box: Rect = { x: middle - w / 2, y: inner.y + k * band + (band - height) / 2, w, h: height }
		const point = series.points.get(k) ?? -1

		builder.begin()
		builder.rect(box.x, box.y, box.w, box.h)
		builder.end(fillOf(builder, point, series.spPr, color), stroke, box, 0, series.node)

		if (showCategories) {
			builder.label(
				[plainParagraph(categories[k] ?? "", text, "r")],
				{ x: area.x, y: inner.y + k * band, w: left - 6, h: band },
				labelBody("ctr"),
				axis?.node ?? -1
			)
		}

		if (series.labels !== undefined) {
			valueLabel(
				builder,
				pointLabel(series.labels, "", v, data.format),
				{ ...series.labels.text, color: backgroundColor(builder.theme) },
				{ x: middle - inner.w / 2, y: box.y, w: inner.w, h: box.h },
				"ctr"
			)
		}
	}

	frame.legend.push({ text: series.name, fill: builder.fill(series.spPr, color), stroke, line: false })
}

function readBinning(reader: DrawingReader, layoutPr: number): Binning | undefined {
	const binning = reader.child(layoutPr, D.Cx, "binning")

	if (binning < 0) return undefined

	return {
		size: numberAttr(reader, reader.child(binning, D.Cx, "binSize"), "val"),
		count: numberAttr(reader, reader.child(binning, D.Cx, "binCount"), "val"),
		underflow: numberAttr(reader, binning, "underflow"),
		overflow: numberAttr(reader, binning, "overflow"),
		right: reader.attr(binning, "intervalClosed") !== "l"
	}
}

const PERCENT_AXIS: Omit<Axis, "text"> = {
	node: -1,
	id: -1,
	category: false,
	hidden: false,
	min: 0,
	max: 1,
	major: undefined,
	gap: undefined,
	gridlines: -1,
	tickLabels: true,
	format: "0%"
}

function drawColumns(frame: Frame, series: Series, pareto: Series | undefined): void {
	const { builder } = frame
	const reader = builder.reader
	const data = series.data
	const binning = readBinning(reader, series.layoutPr)
	let bins: Bin[]
	let format = data.format

	if (binning !== undefined) {
		bins = histogramBins(data.values.subarray(0, data.count), binning, data.format)
		format = "General"
	} else if (reader.child(series.layoutPr, D.Cx, "aggregation") >= 0) {
		const sums = new Map<string, number>()

		for (let k = 0; k < data.count; k++) {
			const v = data.values[k] ?? Number.NaN
			const name = categoryAt(data, k)

			sums.set(name, (sums.get(name) ?? 0) + (Number.isFinite(v) ? v : 0))
		}

		bins = [...sums].map(([label, count]) => ({ label, count }))
	} else {
		bins = Array.from({ length: data.count }, (_, k) => ({ label: categoryAt(data, k), count: data.values[k] ?? Number.NaN }))
	}

	// A Pareto chart's columns run largest first.
	if (pareto !== undefined) bins.sort((a, b) => (Number.isFinite(b.count) ? b.count : 0) - (Number.isFinite(a.count) ? a.count : 0))

	let min = 0
	let max = 0
	let total = 0

	for (const bin of bins) {
		if (!Number.isFinite(bin.count)) continue

		min = Math.min(min, bin.count)
		max = Math.max(max, bin.count)
		total += bin.count
	}

	const percentAxis = pareto === undefined ? undefined : axisFor(frame.axes, false, 1)
	const plot = cartesian(
		frame,
		bins.map(bin => bin.label),
		min,
		max,
		format,
		pareto === undefined ? undefined : (percentAxis ?? { ...PERCENT_AXIS, text: frame.axisText })
	)
	const width = barWidth(plot.band, axisFor(frame.axes, true), binning === undefined ? 0.5 : 0)
	const color = seriesColor(builder.theme, 2, series.color, 1)
	const fill = builder.fill(series.spPr, color)
	const stroke = builder.line(
		series.spPr,
		binning === undefined ? undefined : { color: backgroundColor(builder.theme), width: 0.75 * PX_PER_PT, round: false }
	)

	bins.forEach((bin, k) => {
		if (!Number.isFinite(bin.count)) return

		const x = plot.inner.x + k * plot.band + (plot.band - width) / 2
		const top = plot.y(Math.max(0, bin.count))
		const box: Rect = { x, y: top, w: width, h: Math.max(0, plot.y(Math.min(0, bin.count)) - top) }
		const point = binning === undefined ? (series.points.get(k) ?? -1) : -1

		builder.begin()
		builder.rect(box.x, box.y, box.w, box.h)
		builder.end(point >= 0 ? fillOf(builder, point, series.spPr, color) : fill, stroke, box, 0, series.node)

		if (series.labels !== undefined) {
			const text = pointLabel({ ...series.labels, category: false }, "", bin.count, format)
			const height = estimateHeight(series.labels.text.size)

			valueLabel(builder, text, series.labels.text, { x: x - plot.band / 2, y: box.y - height, w: width + plot.band, h: height }, "b")
		}
	})

	frame.legend.push({ text: series.name, fill, stroke, line: false })

	if (pareto === undefined || !(total > 0)) return

	const lineColor = seriesColor(builder.theme, 2, pareto.color, 1)
	const line = builder.line(pareto.spPr, { color: lineColor, width: 2.25 * PX_PER_PT, round: true })
	let cumulative = 0

	builder.begin()

	bins.forEach((bin, k) => {
		cumulative += Number.isFinite(bin.count) ? bin.count : 0

		const x = plot.inner.x + (k + 0.5) * plot.band
		const y = plot.inner.y + plot.inner.h - (cumulative / total) * plot.inner.h

		if (k === 0) builder.list.moveTo(x, y)
		else builder.list.lineTo(x, y)
	})

	builder.end(-1, line, plot.inner, 0, pareto.node)
	frame.legend.push({ text: pareto.name, fill: -1, stroke: line, line: true })
}

function drawBoxes(frame: Frame, all: readonly Series[]): void {
	const { builder } = frame
	const reader = builder.reader
	const groups: string[] = []
	const groupIndex = new Map<string, number>()

	for (const series of all) {
		for (let k = 0; k < series.data.count; k++) {
			const name = series.data.levels[0]?.[k] ?? ""

			if (!groupIndex.has(name)) {
				groupIndex.set(name, groups.length)
				groups.push(name)
			}
		}
	}

	if (groups.length === 0) groups.push("")

	// Per series, per category group: its statistics.
	const stats: (BoxStats | undefined)[][] = []
	let min = Infinity
	let max = -Infinity

	for (const series of all) {
		const statistics = reader.child(series.layoutPr, D.Cx, "statistics")
		const exclusive = reader.attr(statistics, "quartileMethod") !== "inclusive"
		const buckets: number[][] = groups.map(() => [])

		for (let k = 0; k < series.data.count; k++) {
			const v = series.data.values[k] ?? Number.NaN

			if (!Number.isFinite(v)) continue

			buckets[groupIndex.get(series.data.levels[0]?.[k] ?? "") ?? 0]?.push(v)
			min = Math.min(min, v)
			max = Math.max(max, v)
		}

		stats.push(buckets.map(bucket => boxStats(Float64Array.from(bucket), exclusive)))
	}

	const first = all[0]
	const plot = cartesian(frame, groups, min, max, first?.data.format ?? "General", undefined)
	const slots = all.length
	const groupWidth = barWidth(plot.band, axisFor(frame.axes, true), 1)
	const slot = groupWidth / Math.max(1, slots)
	const boxWidth = slot * 0.8
	const whisker = builder.plainStroke(mutedText(builder.theme, 0.65), 0.75 * PX_PER_PT)
	const marker = builder.plainStroke(backgroundColor(builder.theme), 1.25 * PX_PER_PT)

	all.forEach((series, s) => {
		const visibility = reader.child(series.layoutPr, D.Cx, "visibility")
		const showMean = reader.bool(visibility, "meanMarker", true)
		const showMeanLine = reader.bool(visibility, "meanLine", false)
		const showOutliers = reader.bool(visibility, "outliers", true)
		const color = seriesColor(builder.theme, 2, series.color, slots)
		const fill = builder.fill(series.spPr, color)
		const stroke = builder.line(series.spPr, { color: mutedText(builder.theme, 0.65), width: 0.75 * PX_PER_PT, round: false })
		const outlier = builder.line(series.spPr, { color, width: 0.75 * PX_PER_PT, round: false })
		const means: { x: number; y: number }[] = []

		stats[s]?.forEach((box, g) => {
			if (box === undefined) return

			const center = plot.inner.x + g * plot.band + (plot.band - groupWidth) / 2 + (s + 0.5) * slot
			const x = center - boxWidth / 2
			const top = plot.y(box.q3)
			const rect: Rect = { x, y: top, w: boxWidth, h: Math.max(0.5, plot.y(box.q1) - top) }

			builder.begin()
			builder.segment(center, plot.y(box.high), center, top)
			builder.segment(center, plot.y(box.q1), center, plot.y(box.low))
			builder.segment(center - boxWidth / 4, plot.y(box.high), center + boxWidth / 4, plot.y(box.high))
			builder.segment(center - boxWidth / 4, plot.y(box.low), center + boxWidth / 4, plot.y(box.low))
			builder.end(-1, whisker, rect, 0, series.node)

			builder.begin()
			builder.rect(rect.x, rect.y, rect.w, rect.h)
			builder.end(fill, stroke, rect, 0, series.node)

			builder.begin()
			builder.segment(x, plot.y(box.median), x + boxWidth, plot.y(box.median))
			builder.end(-1, stroke, rect, 0, series.node)

			if (showMean) {
				builder.begin()
				appendMarker(builder, "x", center, plot.y(box.mean), Math.min(4, boxWidth / 4))
				builder.end(-1, marker, rect, 0, series.node)
			}

			if (showOutliers && box.outliers.length > 0) {
				builder.begin()

				for (const v of box.outliers) appendMarker(builder, "circle", center, plot.y(v), Math.min(3, boxWidth / 4))

				builder.end(-1, outlier, rect, 0, series.node)
			}

			means.push({ x: center, y: plot.y(box.mean) })
		})

		if (showMeanLine && means.length > 1) {
			builder.begin()
			means.forEach((point, k) => (k === 0 ? builder.list.moveTo(point.x, point.y) : builder.list.lineTo(point.x, point.y)))
			builder.end(-1, outlier, plot.inner, 0, series.node)
		}

		frame.legend.push({ text: series.name, fill, stroke, line: false })
	})
}

function hierarchyText(series: Series, base: TextDefaults): TextDefaults {
	return series.labels?.text ?? base
}

function drawTreemap(frame: Frame, series: Series): void {
	const { builder, area } = frame
	const reader = builder.reader
	const { root } = hierarchy(series.data)
	const parentLayout = reader.attr(reader.child(series.layoutPr, D.Cx, "parentLabelLayout"), "val") ?? "overlapping"
	const theme = builder.theme
	const border = builder.plainStroke(backgroundColor(theme), 1)
	const labels = series.labels
	const leafText = { ...hierarchyText(series, frame.axisText), color: backgroundColor(theme) }
	const parentText = { ...leafText, size: leafText.size * 1.4 }
	const tops = root.children.length
	let cells = 0

	const place = (parent: TreeNode, box: Rect, fill: number, depth: number): void => {
		if (cells++ > MAX_CELLS || box.w < 0.5 || box.h < 0.5) return

		if (parent.children.length === 0) {
			const point = parent.point < 0 ? -1 : (series.points.get(parent.point) ?? -1)
			const own = point >= 0 ? builder.fill(point, undefined) : -1

			builder.begin()
			builder.rect(box.x, box.y, box.w, box.h)
			builder.end(own >= 0 ? own : fill, border, box, 0, series.node)

			if (labels !== undefined) {
				const text = pointLabel(labels, parent.name, parent.value, series.data.format)
				const height = estimateHeight(leafText.size, text.split("\n").length)

				if (text !== "" && box.w > 12 && box.h > height + 4)
					builder.label(
						[plainParagraph(text, leafText, "l")],
						{ x: box.x + 3, y: box.y + 3, w: box.w - 6, h: height },
						labelBody("t")
					)
			}

			return
		}

		let inner = box
		const header = estimateHeight(parentText.size) + 4

		if (depth > 0 && parentLayout === "banner" && box.h > header * 2) {
			builder.begin()
			builder.rect(box.x, box.y, box.w, header)
			builder.end(fill, border, { ...box, h: header }, 0, series.node)
			builder.label(
				[plainParagraph(parent.name, parentText, "l")],
				{ x: box.x + 3, y: box.y + 2, w: box.w - 6, h: header - 4 },
				labelBody("ctr")
			)
			inner = { x: box.x, y: box.y + header, w: box.w, h: box.h - header }
		}

		const rects = squarify(
			parent.children.map(child => child.value),
			inner
		)

		parent.children.forEach((child, index) => {
			const rect = rects[index]

			if (rect === undefined) return

			const childFill = depth === 0 ? builder.fill(series.spPr, seriesColor(theme, 2, index, tops)) : fill

			place(child, rect, childFill, depth + 1)

			if (depth === 0 && child.children.length > 0 && parentLayout === "overlapping" && rect.w > 12 && rect.h > header) {
				builder.label(
					[plainParagraph(child.name, parentText, "l")],
					{ x: rect.x + 3, y: rect.y + 2, w: rect.w - 6, h: header - 4 },
					labelBody("t")
				)
			}
		})
	}

	place(root, area, builder.fill(series.spPr, seriesColor(theme, 2, 0, 1)), 0)

	for (let k = 0; k < Math.min(tops, 64); k++) {
		const child = root.children[k]

		if (child !== undefined)
			frame.legend.push({
				text: child.name,
				fill: builder.fill(series.spPr, seriesColor(theme, 2, k, tops)),
				stroke: -1,
				line: false
			})
	}
}

function drawSunburst(frame: Frame, series: Series): void {
	const { builder, area } = frame
	const { root, depth } = hierarchy(series.data)
	const theme = builder.theme

	if (!(root.value > 0) || depth === 0) return

	const cx = area.x + area.w / 2
	const cy = area.y + area.h / 2
	const radius = Math.max(1, Math.min(area.w, area.h) / 2)
	const ring = radius / (depth + 0.35)
	const hole = radius - ring * depth
	const border = builder.plainStroke(backgroundColor(theme), 1)
	const labels = series.labels
	const text = { ...hierarchyText(series, frame.axisText), color: backgroundColor(theme) }
	const lineHeight = estimateHeight(text.size)
	const tops = root.children.length
	let cells = 0

	const place = (parent: TreeNode, a0: number, a1: number, level: number, fill: number): void => {
		let start = a0

		parent.children.forEach((child, index) => {
			if (cells++ > MAX_CELLS) return

			const sweep = ((a1 - a0) * child.value) / (parent.value || 1)
			const end = start + sweep
			const inner = hole + ring * level
			const outer = inner + ring
			const color = level === 0 ? builder.fill(series.spPr, seriesColor(theme, 2, index, tops)) : fill
			const point = child.children.length === 0 && child.point >= 0 ? (series.points.get(child.point) ?? -1) : -1
			const own = point >= 0 ? builder.fill(point, undefined) : -1
			const box: Rect = { x: cx - outer, y: cy - outer, w: outer * 2, h: outer * 2 }
			const list = builder.list

			if (sweep > 1e-6) {
				builder.begin()
				list.moveTo(cx + outer * Math.cos(start), cy + outer * Math.sin(start))
				builder.arc(cx, cy, outer, start, end)

				if (inner > 0) {
					list.lineTo(cx + inner * Math.cos(end), cy + inner * Math.sin(end))
					builder.arc(cx, cy, inner, end, start)
				} else {
					list.lineTo(cx, cy)
				}

				list.close()
				builder.end(own >= 0 ? own : color, border, box, 0, series.node)

				if (labels !== undefined) {
					const label = pointLabel(labels, child.name, child.value, series.data.format)
					const middle = (start + end) / 2
					const at = (inner + outer) / 2
					const room = Math.max(ring, sweep * at)

					if (label !== "" && estimateWidth(label, text.size) <= room * 0.9 && lineHeight <= Math.min(ring, sweep * at)) {
						builder.label(
							[plainParagraph(label, text)],
							{
								x: cx + at * Math.cos(middle) - room / 2,
								y: cy + at * Math.sin(middle) - lineHeight / 2,
								w: room,
								h: lineHeight
							},
							labelBody("ctr")
						)
					}
				}

				place(child, start, end, level + 1, color)
			}

			start = end
		})
	}

	place(root, -Math.PI / 2, (Math.PI * 3) / 2, 0, -1)

	for (let k = 0; k < Math.min(tops, 64); k++) {
		const child = root.children[k]

		if (child !== undefined)
			frame.legend.push({
				text: child.name,
				fill: builder.fill(series.spPr, seriesColor(theme, 2, k, tops)),
				stroke: -1,
				line: false
			})
	}
}

// Title and legend ----------------------------------------------------------------------------------------------------

function titleParagraphs(builder: ChartBuilder, title: number, defaults: TextDefaults): TextParagraph[] {
	const reader = builder.reader
	const tx = reader.child(title, D.Cx, "tx")
	const rich = reader.child(tx, D.Cx, "rich")

	if (rich >= 0) return readTextBody(reader, builder.theme, rich, defaults).paragraphs

	const text = textOf(reader, tx)

	return [plainParagraph(tx < 0 ? "Chart Title" : text, defaults)]
}

function drawLegend(
	builder: ChartBuilder,
	node: number,
	entries: readonly Legend[],
	text: TextDefaults,
	box: Rect,
	horizontal: boolean
): void {
	const key = text.size * PX_PER_PT * 0.75
	const row = Math.max(estimateHeight(text.size), key) + 2
	let x = box.x + 4
	let y = box.y + 4

	for (const entry of entries) {
		const keyWidth = entry.line ? key * 2.5 : key
		const textWidth = estimateWidth(entry.text, text.size) + 4

		if (horizontal && x > box.x + 4 && x + keyWidth + 4 + textWidth > box.x + box.w) {
			x = box.x + 4
			y += row
		}

		const middle = y + row / 2
		const keyBox: Rect = { x, y: middle - key / 2, w: keyWidth, h: key }

		builder.begin()

		if (entry.line) builder.segment(x, middle, x + keyWidth, middle)
		else builder.rect(x, middle - key / 2, key, key)

		builder.end(entry.fill, entry.stroke, keyBox, 0, node)
		builder.label([plainParagraph(entry.text, text, "l")], { x: x + keyWidth + 4, y, w: textWidth, h: row }, labelBody("ctr"), node)

		if (horizontal) x += keyWidth + 4 + textWidth + 10
		else y += row
	}
}

function legendSize(entries: readonly Legend[], text: TextDefaults, room: Rect, horizontal: boolean): { w: number; h: number } {
	const key = text.size * PX_PER_PT * 0.75
	const row = Math.max(estimateHeight(text.size), key) + 2
	const width = (entry: Legend): number => (entry.line ? key * 2.5 : key) + 4 + estimateWidth(entry.text, text.size) + 4

	if (!horizontal) {
		let widest = 0

		for (const entry of entries) widest = Math.max(widest, width(entry))

		return { w: Math.min(room.w * 0.5, widest + 8), h: Math.min(room.h, entries.length * row + 8) }
	}

	let rows = 1
	let line = 0
	let widest = 0

	for (const entry of entries) {
		const w = width(entry) + 10

		if (line > 0 && line + w > room.w - 8) {
			rows++
			widest = Math.max(widest, line)
			line = 0
		}

		line += w
	}

	return { w: Math.min(room.w, Math.max(widest, line) + 8), h: Math.min(room.h * 0.5, rows * row + 8) }
}

function drawn(layout: string): boolean {
	return DRAWN.has(layout) && layout !== "paretoLine"
}

// The plot area's series, the visible ones, and the one whose layout the chart is drawn as.
function seriesOf(reader: DrawingReader, root: number) {
	const region = reader.child(reader.child(reader.child(root, D.Cx, "chart"), D.Cx, "plotArea"), D.Cx, "plotAreaRegion")
	const nodes = reader.children(region, D.Cx, "series")
	const visible = nodes.filter(series => !reader.bool(series, "hidden", false))
	const primary = visible.find(series => (reader.attr(series, "layoutId") ?? "") !== "paretoLine") ?? visible[0]
	const layout = primary === undefined ? "" : (reader.attr(primary, "layoutId") ?? "")

	return { nodes, visible, primary, layout }
}

// Whether drawChartex draws a part (a cx:chartSpace with a visible series of a drawn layout) at a non-empty size,
// read without converting it: hosts choose a chartex mc:Choice over its Fallback by it.
export function chartexDrawable(document: XmlDocument): boolean {
	const reader = drawingReader(document)
	const root = document.documentElement()

	if (root < 0 || !reader.is(root, D.Cx, "chartSpace")) return false

	const { primary, layout } = seriesOf(reader, root)

	return primary !== undefined && drawn(layout)
}

// Converts a cx:chartSpace at `W` x `H` px into the builder's list.
export function drawChartex(
	context: PaintContext,
	reader: DrawingReader,
	root: number,
	W: number,
	H: number,
	matrix?: readonly number[]
): ChartexConversion {
	const chart = reader.child(root, D.Cx, "chart")
	const plotArea = reader.child(chart, D.Cx, "plotArea")
	const { nodes, visible, primary, layout } = seriesOf(reader, root)
	const plots = [...new Set(nodes.map(series => reader.attr(series, "layoutId") ?? ""))]

	if (primary === undefined || W <= 0 || H <= 0) return { supported: false, plots, unsupported: ["empty"] }
	if (!drawn(layout)) return { supported: false, plots, unsupported: [`chartex:${layout}`] }

	const theme = context.theme
	const base: TextDefaults = { size: 10, color: textColor(theme), font: theme.minorFont.latin, bold: false, italic: false }
	const probe = new ChartBuilder(context, reader, 2, false, base)
	const builder = new ChartBuilder(context, reader, 2, false, probe.textProps(reader.child(root, D.Cx, "txPr"), base), matrix)
	const axisText: TextDefaults = {
		...builder.text,
		color: builder.text.color === base.color ? mutedText(theme, 0.65) : builder.text.color
	}
	const data = readData(reader, root)
	const hierarchical = layout === "treemap" || layout === "sunburst"
	const series: Series[] = visible.map((node, position) => {
		const points = new Map<number, number>()

		for (const point of reader.children(node, D.Cx, "dataPt"))
			points.set(Math.floor(reader.number(point, "idx", -1)), reader.child(point, D.Cx, "spPr"))

		const name = textOf(reader, reader.child(node, D.Cx, "tx"))

		return {
			node,
			layout: reader.attr(node, "layoutId") ?? "",
			name: name === "" ? `Series${String(position + 1)}` : name,
			data: data.get(Math.floor(reader.number(reader.child(node, D.Cx, "dataId"), "val", 0))) ?? EMPTY,
			spPr: reader.child(node, D.Cx, "spPr"),
			points,
			labels: readLabels(builder, reader.child(node, D.Cx, "dataLabels"), hierarchical, builder.text),
			layoutPr: reader.child(node, D.Cx, "layoutPr"),
			owner: Math.floor(reader.number(node, "ownerIdx", -1)),
			color: Math.max(0, Math.floor(reader.number(node, "formatIdx", position)))
		}
	})
	// Chart area.
	const spPr = reader.child(root, D.Cx, "spPr")
	const frameBox: Rect = { x: 0, y: 0, w: W, h: H }

	builder.begin()
	builder.rect(0.5, 0.5, W - 1, H - 1)
	builder.end(
		builder.fill(spPr, spPr < 0 ? backgroundColor(theme) : undefined),
		builder.line(spPr, spPr < 0 ? { color: mutedText(theme, 0.15), width: 1, round: false } : undefined),
		frameBox,
		0,
		root
	)

	const pad = Math.max(4, Math.min(10, Math.min(W, H) * 0.03))
	let content: Rect = { x: pad, y: pad, w: Math.max(1, W - pad * 2), h: Math.max(1, H - pad * 2) }
	const titleNode = reader.child(chart, D.Cx, "title")

	if (titleNode >= 0) {
		const defaults = builder.textProps(reader.child(titleNode, D.Cx, "txPr"), { ...builder.text, size: 14, color: axisText.color })
		const paragraphs = titleParagraphs(builder, titleNode, defaults)
		const height = estimateHeight(defaults.size, Math.max(1, paragraphs.length))
		const bottom = reader.attr(titleNode, "pos") === "b"
		const box: Rect = { x: content.x, y: bottom ? content.y + content.h - height : content.y, w: content.w, h: height }

		builder.label(paragraphs, box, labelBody("ctr"), titleNode)

		if (!reader.bool(titleNode, "overlay", false))
			content = {
				x: content.x,
				y: bottom ? content.y : content.y + height + pad,
				w: content.w,
				h: Math.max(1, content.h - height - pad)
			}
	}

	const legendNode = reader.child(chart, D.Cx, "legend")
	const legendText = builder.textProps(reader.child(legendNode, D.Cx, "txPr"), axisText)
	const side = reader.attr(legendNode, "pos") ?? "t"
	const horizontal = side !== "l" && side !== "r"
	const legendOverlay = reader.bool(legendNode, "overlay", false)
	// The legend's room is reserved before the plot is laid out; its entries come from the drawing.
	const reserve = legendNode < 0 ? { w: 0, h: 0 } : legendSize(legendGuess(series, layout), legendText, content, horizontal)
	let area = content

	if (legendNode >= 0 && !legendOverlay) {
		if (side === "b") area = { ...content, h: Math.max(1, content.h - reserve.h - pad) }
		else if (side === "l") area = { ...content, x: content.x + reserve.w + pad, w: Math.max(1, content.w - reserve.w - pad) }
		else if (side === "r") area = { ...content, w: Math.max(1, content.w - reserve.w - pad) }
		else area = { ...content, y: content.y + reserve.h + pad, h: Math.max(1, content.h - reserve.h - pad) }
	}

	const frame: Frame = { builder, series, axes: readAxes(builder, plotArea, axisText), area, legend: [], axisText }
	const first = series.find(entry => entry.node === primary) ?? series[0]
	const unsupported: string[] = []

	if (first === undefined) return { supported: false, plots, unsupported: ["empty"] }

	switch (layout) {
		case "waterfall":
			drawWaterfall(frame, first)
			break
		case "funnel":
			drawFunnel(frame, first)
			break
		case "clusteredColumn": {
			const index = series.indexOf(first)
			const pareto = series.find(entry => entry.layout === "paretoLine" && (entry.owner === index || entry.owner < 0))

			drawColumns(frame, first, pareto)
			break
		}
		case "boxWhisker":
			drawBoxes(
				frame,
				series.filter(entry => entry.layout === "boxWhisker")
			)
			break
		case "treemap":
			drawTreemap(frame, first)
			break
		case "sunburst":
			drawSunburst(frame, first)
			break
	}

	for (const entry of series) {
		if (entry === first || entry.layout === "paretoLine" || (layout === "boxWhisker" && entry.layout === "boxWhisker")) continue

		const name = `chartex:${entry.layout}`

		if (!unsupported.includes(name)) unsupported.push(name)
	}

	if (legendNode >= 0 && frame.legend.length > 0) {
		const size = legendSize(frame.legend, legendText, content, horizontal)
		const box: Rect =
			side === "b"
				? { x: content.x + (content.w - size.w) / 2, y: content.y + content.h - size.h, ...size }
				: side === "l"
					? { x: content.x, y: content.y + (content.h - size.h) / 2, ...size }
					: side === "r"
						? { x: content.x + content.w - size.w, y: content.y + (content.h - size.h) / 2, ...size }
						: { x: content.x + (content.w - size.w) / 2, y: content.y, ...size }

		drawLegend(builder, legendNode, frame.legend, legendText, box, horizontal)
	}

	return { supported: true, plots, unsupported }
}

// The entries a legend will hold, for reserving its room before the plot is drawn.
function legendGuess(series: readonly Series[], layout: string): Legend[] {
	const entry = (text: string): Legend => ({ text, fill: -1, stroke: -1, line: false })

	if (layout === "waterfall") return [entry("Increase"), entry("Decrease"), entry("Total")]

	if (layout === "treemap" || layout === "sunburst") {
		const data = series[0]?.data
		const names = new Set<string>()
		const outer = data?.levels[(data.levels.length || 1) - 1] ?? []

		for (const name of outer) if (name !== "" && names.size < 64) names.add(name)

		return [...names].map(entry)
	}

	return series
		.filter(item => layout === "boxWhisker" || item.layout !== "boxWhisker" || item === series[0])
		.map(item => entry(item.name))
}

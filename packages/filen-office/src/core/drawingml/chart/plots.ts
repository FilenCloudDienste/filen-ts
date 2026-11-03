import { ItemFlag } from "../displayList"
import { D } from "../reader"
import { plainParagraph } from "../text"
import { categoryBand, categoryPosition, crossingValue, valuePosition, axisPosition, type AxisState } from "./axes"
import { estimateHeight, estimateWidth, labelBody, PX_PER_PT, type ChartBuilder, type Rect } from "./builder"
import { cacheLabels, type SeriesData } from "./data"
import { formatNumber } from "./format"
import { labelText, placeLabel, pointConfig, seriesLabels, type PendingLabel } from "./labels"
import type { Plot } from "./model"
import { mutedText } from "./palette"
import { scaleFraction, scaleTicks } from "./scale"
import { appendMarker, pointFill, pointOverridden, pointStroke, seriesName, type SeriesStyle } from "./series"

// Drawing of each plot kind into the builder's list. Every series becomes one path item (plus one per
// point painted differently), so a long series costs one paint and one item, not one per point.

export type Blanks = "gap" | "zero" | "span"

export interface PlotFrame {
	readonly builder: ChartBuilder
	readonly plot: Plot
	readonly styles: ReadonlyMap<number, SeriesStyle>
	readonly inner: Rect
	// Category (or x) and value (or y) axes; undefined for pies.
	readonly categoryAxis: AxisState | undefined
	readonly valueAxis: AxisState | undefined
	readonly labels: PendingLabel[]
	readonly blanks: Blanks
	// Category names shared by the plot (from the first series with categories).
	readonly categories: readonly string[]
}

function clamp(value: number, low: number, high: number): number {
	return value < low ? low : value > high ? high : value
}

function axisClamp(state: AxisState, position: number): number {
	return clamp(position, Math.min(state.from, state.to), Math.max(state.from, state.to))
}

function seriesValue(series: SeriesData, index: number, blanks: Blanks): number {
	const value = series.values.numbers?.[index] ?? Number.NaN

	return Number.isNaN(value) && blanks === "zero" ? 0 : value
}

function valueFormat(series: SeriesData): string {
	return series.values.formatCode
}

// Per-category sums for stacking: positive and negative totals, and the absolute total for percent.
function categoryTotals(plot: Plot, count: number, blanks: Blanks): Float64Array {
	const totals = new Float64Array(count)

	for (const series of plot.series) {
		for (let k = 0; k < count; k++) {
			const value = seriesValue(series, k, blanks)

			if (Number.isFinite(value)) totals[k] = (totals[k] ?? 0) + Math.abs(value)
		}
	}

	return totals
}

export function drawBars(frame: PlotFrame): void {
	const { builder, plot, inner, styles } = frame
	const category = frame.categoryAxis
	const value = frame.valueAxis

	if (category === undefined || value === undefined) return

	const stacked = plot.grouping === "stacked" || plot.grouping === "percentStacked"
	const percent = plot.grouping === "percentStacked"
	const n = stacked ? 1 : Math.max(1, plot.series.length)
	const overlap = stacked ? 1 : clamp(plot.overlap, -100, 100) / 100
	const gap = clamp(plot.gapWidth, 0, 500) / 100
	const band = categoryBand(category)
	const width = band / (n - (n - 1) * overlap + gap)
	const start = (-(n - (n - 1) * overlap) * width) / 2
	const count = category.count
	const base = crossingValue(value, category.axis)
	const positive = new Float64Array(count)
	const negative = new Float64Array(count)
	const totals = percent ? categoryTotals(plot, count, frame.blanks) : null
	const vertical = !plot.horizontal
	const position = { x: 0, y: 0, w: 0, h: 0, end: 0, origin: 0, along: 0 }
	const place = (k: number, offset: number, low: number, high: number): void => {
		const c0 = categoryPosition(category, k) + start + offset
		const p0 = axisClamp(value, valuePosition(value, low))
		const p1 = axisClamp(value, valuePosition(value, high))

		position.origin = p0
		position.end = p1
		position.along = c0 + width / 2

		if (vertical) {
			position.x = Math.min(c0, c0 + width)
			position.w = Math.abs(width)
			position.y = Math.min(p0, p1)
			position.h = Math.abs(p1 - p0)
		} else {
			position.y = Math.min(c0, c0 + width)
			position.h = Math.abs(width)
			position.x = Math.min(p0, p1)
			position.w = Math.abs(p1 - p0)
		}
	}

	plot.series.forEach((series, order) => {
		const style = styles.get(series.node)

		if (style === undefined) return

		const offset = stacked ? 0 : order * width * (1 - overlap)
		const labels = seriesLabels(builder, plot.dataLabels, series.node)
		const special: number[] = []
		const points = Math.min(count, series.values.count)
		const lows = new Float64Array(points)
		const highs = new Float64Array(points).fill(Number.NaN)

		for (let k = 0; k < points; k++) {
			let v = seriesValue(series, k, frame.blanks)

			if (!Number.isFinite(v)) continue
			if (totals !== null) v = (totals[k] ?? 0) === 0 ? 0 : v / (totals[k] ?? 1)

			let low = base
			let high = v

			if (stacked) {
				low = v >= 0 ? (positive[k] ?? 0) : (negative[k] ?? 0)
				high = low + v

				if (v >= 0) positive[k] = high
				else negative[k] = high
			}

			lows[k] = low
			highs[k] = high
		}

		builder.begin()

		for (let k = 0; k < points; k++) {
			if (Number.isNaN(highs[k] ?? Number.NaN)) continue
			if (pointOverridden(style, k)) {
				special.push(k)

				continue
			}

			place(k, offset, lows[k] ?? 0, highs[k] ?? 0)
			builder.rect(position.x, position.y, position.w, position.h)
		}

		builder.end(style.fill, style.stroke, inner, 0, series.node)

		for (const k of special) {
			place(k, offset, lows[k] ?? 0, highs[k] ?? 0)
			builder.begin()
			builder.rect(position.x, position.y, position.w, position.h)
			builder.end(pointFill(builder, style, k), pointStroke(style, k), inner, 0, series.node)
		}

		if (labels === undefined) return

		for (let k = 0; k < points; k++) {
			const config = pointConfig(labels, k, frame.labels)
			const raw = seriesValue(series, k, frame.blanks)

			if (config === undefined || Number.isNaN(highs[k] ?? Number.NaN)) continue

			place(k, offset, lows[k] ?? 0, highs[k] ?? 0)

			const share = totals === null ? Number.NaN : raw / ((totals[k] ?? 0) || 1)
			const text = labelText(config, seriesName(series, order), frame.categories[k] ?? "", raw, valueFormat(series), share)

			if (text === "") continue

			const where = config.position || (stacked ? "ctr" : "outEnd")
			// Direction the bar grows in, in pixels along the value axis.
			const grows = position.end - position.origin >= 0 ? 1 : -1
			const tip = where === "inBase" ? position.origin : where === "ctr" ? (position.origin + position.end) / 2 : position.end
			const outward = where === "outEnd" || where === "inBase" ? grows : -grows
			const side = where === "ctr" ? "ctr" : vertical ? (outward > 0 ? "b" : "t") : outward > 0 ? "r" : "l"

			frame.labels.push(placeLabel(text, config, vertical ? position.along : tip, vertical ? tip : position.along, side, series.node))
		}
	})
}

// Catmull-Rom through the points [from, to) of xs/ys as cubic segments, from the current point.
function smoothRun(builder: ChartBuilder, xs: Float64Array, ys: Float64Array, run: readonly number[]): void {
	for (let r = 0; r + 1 < run.length; r++) {
		const p0 = run[Math.max(0, r - 1)] ?? 0
		const p1 = run[r] ?? 0
		const p2 = run[r + 1] ?? 0
		const p3 = run[Math.min(run.length - 1, r + 2)] ?? 0
		const x1 = xs[p1] ?? 0
		const y1 = ys[p1] ?? 0
		const x2 = xs[p2] ?? 0
		const y2 = ys[p2] ?? 0

		builder.list.cubicTo(
			x1 + ((xs[p2] ?? 0) - (xs[p0] ?? 0)) / 6,
			y1 + ((ys[p2] ?? 0) - (ys[p0] ?? 0)) / 6,
			x2 - ((xs[p3] ?? 0) - (xs[p1] ?? 0)) / 6,
			y2 - ((ys[p3] ?? 0) - (ys[p1] ?? 0)) / 6,
			x2,
			y2
		)
	}
}

// A polyline through finite points; NaN breaks the line (gaps) unless blanks span them.
function polyline(builder: ChartBuilder, xs: Float64Array, ys: Float64Array, smooth: boolean, span: boolean, closed: boolean): void {
	let run: number[] = []
	const flush = (): void => {
		if (run.length === 0) return

		builder.list.moveTo(xs[run[0] ?? 0] ?? 0, ys[run[0] ?? 0] ?? 0)

		if (smooth && run.length > 2) {
			smoothRun(builder, xs, ys, run)
		} else {
			for (let r = 1; r < run.length; r++) builder.list.lineTo(xs[run[r] ?? 0] ?? 0, ys[run[r] ?? 0] ?? 0)
		}

		if (closed) builder.list.close()

		run = []
	}

	for (let k = 0; k < xs.length; k++) {
		if (Number.isFinite(xs[k] ?? Number.NaN) && Number.isFinite(ys[k] ?? Number.NaN)) run.push(k)
		else if (!span) flush()
	}

	flush()
}

function drawMarkers(builder: ChartBuilder, style: SeriesStyle, xs: Float64Array, ys: Float64Array, inner: Rect, source: number): void {
	const marker = style.marker

	if (marker === undefined) return

	builder.begin()

	for (let k = 0; k < xs.length; k++) {
		const x = xs[k] ?? Number.NaN
		const y = ys[k] ?? Number.NaN

		if (Number.isFinite(x) && Number.isFinite(y)) appendMarker(builder, marker.symbol, x, y, marker.radius)
	}

	builder.end(marker.fill, marker.stroke, inner, 0, source)
}

function pointLabels(
	frame: PlotFrame,
	series: SeriesData,
	order: number,
	xs: Float64Array,
	ys: Float64Array,
	shares: Float64Array | null,
	fallback: "r" | "ctr" | "t"
): void {
	const labels = seriesLabels(frame.builder, frame.plot.dataLabels, series.node)

	if (labels === undefined) return

	for (let k = 0; k < xs.length; k++) {
		const config = pointConfig(labels, k, frame.labels)
		const x = xs[k] ?? Number.NaN
		const y = ys[k] ?? Number.NaN
		const raw = series.values.numbers?.[k] ?? Number.NaN

		if (config === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue

		const text = labelText(
			config,
			seriesName(series, order),
			frame.categories[k] ?? "",
			raw,
			valueFormat(series),
			shares?.[k] ?? Number.NaN
		)
		const where = config.position
		const side = where === "t" || where === "b" || where === "l" || where === "r" || where === "ctr" ? where : fallback

		if (text !== "") frame.labels.push(placeLabel(text, config, x, y, side, series.node))
	}
}

function smoothFlag(frame: PlotFrame, series: SeriesData): boolean {
	const node = frame.builder.reader.child(series.node, D.C, "smooth")

	return node < 0 ? frame.plot.smooth : frame.builder.reader.bool(node, "val", true)
}

export function drawLinesOrAreas(frame: PlotFrame): void {
	const { builder, plot, inner, styles } = frame
	const category = frame.categoryAxis
	const value = frame.valueAxis

	if (category === undefined || value === undefined) return

	const count = category.count
	const stacked = plot.grouping === "stacked" || plot.grouping === "percentStacked"
	const percent = plot.grouping === "percentStacked"
	const area = plot.kind === "area"
	// Areas treat blanks as zero; lines follow c:dispBlanksAs.
	const blanks: Blanks = area ? "zero" : frame.blanks
	const totals = percent ? categoryTotals(plot, count, blanks) : null
	const cumulative = new Float64Array(count)
	const base = crossingValue(value, category.axis)
	const baseY = axisClamp(value, valuePosition(value, base))
	const xs = new Float64Array(count)
	// Per category, the series' highest and lowest y (for the high-low lines).
	const tops = plot.hiLowLines >= 0 ? new Float64Array(count).fill(Number.NaN) : null
	const bottoms = plot.hiLowLines >= 0 ? new Float64Array(count).fill(Number.NaN) : null

	for (let k = 0; k < count; k++) xs[k] = categoryPosition(category, k)

	plot.series.forEach((series, order) => {
		const style = styles.get(series.node)

		if (style === undefined) return

		const ys = new Float64Array(count).fill(Number.NaN)
		const previous = area && stacked ? cumulative.slice() : null

		for (let k = 0; k < Math.min(count, series.values.count); k++) {
			let v = seriesValue(series, k, blanks)

			if (!Number.isFinite(v)) continue
			if (totals !== null) v = (totals[k] ?? 0) === 0 ? 0 : v / (totals[k] ?? 1)
			if (stacked) {
				v += cumulative[k] ?? 0
				cumulative[k] = v
			}

			ys[k] = axisClamp(value, valuePosition(value, v))
		}

		if (area) {
			builder.begin()

			let first = -1
			let last = -1

			for (let k = 0; k < count; k++) {
				if (!Number.isFinite(ys[k] ?? Number.NaN)) continue
				if (first < 0) {
					first = k
					builder.list.moveTo(xs[k] ?? 0, previous === null ? baseY : axisClamp(value, valuePosition(value, previous[k] ?? 0)))
				}

				builder.list.lineTo(xs[k] ?? 0, ys[k] ?? 0)
				last = k
			}

			if (first >= 0) {
				for (let k = last; k >= first; k--)
					builder.list.lineTo(xs[k] ?? 0, previous === null ? baseY : axisClamp(value, valuePosition(value, previous[k] ?? 0)))

				builder.list.close()
			}

			builder.end(style.fill, style.stroke, inner, ItemFlag.EVEN_ODD, series.node)
			pointLabels(frame, series, order, xs, ys, null, "ctr")

			return
		}

		builder.begin()
		polyline(builder, xs, ys, smoothFlag(frame, series), blanks === "span", false)
		builder.end(-1, style.stroke, inner, 0, series.node)
		drawMarkers(builder, style, xs, ys, inner, series.node)
		pointLabels(frame, series, order, xs, ys, null, "r")

		if (tops === null || bottoms === null) return

		for (let k = 0; k < count; k++) {
			const y = ys[k] ?? Number.NaN

			if (!Number.isFinite(y)) continue

			const top = tops[k] ?? Number.NaN
			const bottom = bottoms[k] ?? Number.NaN

			tops[k] = Number.isFinite(top) ? Math.min(top, y) : y
			bottoms[k] = Number.isFinite(bottom) ? Math.max(bottom, y) : y
		}
	})

	// High-low lines: from each category's highest value to its lowest.
	if (tops !== null && bottoms !== null) {
		const reader = builder.reader
		const stroke = builder.line(reader.child(plot.hiLowLines, D.C, "spPr"), {
			color: mutedText(builder.theme, 0.75),
			width: 1,
			round: false
		})

		if (stroke >= 0) {
			builder.begin()

			for (let k = 0; k < count; k++) {
				const top = tops[k] ?? Number.NaN
				const bottom = bottoms[k] ?? Number.NaN

				if (Number.isFinite(top) && Number.isFinite(bottom) && top !== bottom) builder.segment(xs[k] ?? 0, top, xs[k] ?? 0, bottom)
			}

			builder.end(-1, stroke, inner, 0, plot.hiLowLines)
		}
	}
}

export function drawScatter(frame: PlotFrame): void {
	const { builder, plot, inner, styles } = frame
	const xAxis = frame.categoryAxis
	const yAxis = frame.valueAxis

	if (xAxis === undefined || yAxis === undefined) return

	plot.series.forEach((series, order) => {
		const style = styles.get(series.node)

		if (style === undefined) return

		const count = series.values.count
		const xs = new Float64Array(count)
		const ys = new Float64Array(count)
		const xNumbers = series.categories.numbers

		for (let k = 0; k < count; k++) {
			// String x values plot at 1, 2, 3... as Office does.
			const x = xNumbers === null ? k + 1 : (xNumbers[k] ?? Number.NaN)
			const y = seriesValue(series, k, frame.blanks)

			xs[k] = Number.isFinite(x) ? axisPosition(xAxis, xAxis.scale === undefined ? x - 1 : x) : Number.NaN
			ys[k] = Number.isFinite(y) ? valuePosition(yAxis, y) : Number.NaN
		}

		builder.begin()
		polyline(builder, xs, ys, smoothFlag(frame, series), frame.blanks === "span", false)
		builder.end(-1, style.stroke, inner, 0, series.node)
		drawMarkers(builder, style, xs, ys, inner, series.node)
		pointLabels(frame, series, order, xs, ys, null, "r")
	})
}

// Bubbles: the largest of the plot is a quarter of its shorter side across at c:bubbleScale 100, the others scaled
// by area (or width); each a circle of its own, the larger drawn first so smaller ones stay visible.
export function drawBubbles(frame: PlotFrame): void {
	const { builder, plot, inner } = frame
	const xAxis = frame.categoryAxis
	const yAxis = frame.valueAxis

	if (xAxis === undefined || yAxis === undefined) return

	let largest = 0

	for (const series of plot.series) {
		const sizes = series.sizes?.numbers

		if (sizes === null || sizes === undefined) continue

		for (const size of sizes)
			if (Number.isFinite(size) && (size > 0 || plot.negativeBubbles)) largest = Math.max(largest, Math.abs(size))
	}

	if (!(largest > 0)) return

	const maxRadius = ((Math.min(inner.w, inner.h) / 4) * plot.bubbleScale) / 100 / 2

	plot.series.forEach((series, order) => {
		const style = frame.styles.get(series.node)
		const sizes = series.sizes?.numbers

		if (style === undefined || sizes === null || sizes === undefined) return

		const count = Math.min(series.values.count, sizes.length)
		const xs = new Float64Array(count)
		const ys = new Float64Array(count)
		const radii = new Float64Array(count)
		const xNumbers = series.categories.numbers
		const drawn: number[] = []

		for (let k = 0; k < count; k++) {
			const x = xNumbers === null ? k + 1 : (xNumbers[k] ?? Number.NaN)
			const y = series.values.numbers?.[k] ?? Number.NaN
			const size = sizes[k] ?? Number.NaN

			xs[k] = Number.isFinite(x) ? axisPosition(xAxis, xAxis.scale === undefined ? x - 1 : x) : Number.NaN
			ys[k] = Number.isFinite(y) ? valuePosition(yAxis, y) : Number.NaN

			if (!Number.isFinite(xs[k] ?? Number.NaN) || !Number.isFinite(ys[k] ?? Number.NaN) || !Number.isFinite(size)) continue
			if (size === 0 || (size < 0 && !plot.negativeBubbles)) continue

			const share = Math.abs(size) / largest

			radii[k] = maxRadius * (plot.sizeByWidth ? share : Math.sqrt(share))
			drawn.push(k)
		}

		drawn.sort((a, b) => (radii[b] ?? 0) - (radii[a] ?? 0) || a - b)

		for (const k of drawn) {
			const x = xs[k] ?? 0
			const y = ys[k] ?? 0
			const r = radii[k] ?? 0
			// A negative bubble is drawn hollow, as Office does.
			const negative = (sizes[k] ?? 0) < 0

			builder.begin()
			builder.list.moveTo(x + r, y)
			builder.arc(x, y, r, 0, Math.PI * 2)
			builder.list.close()
			const stroke = pointStroke(style, k)

			builder.end(
				negative ? -1 : pointFill(builder, style, k),
				negative && stroke < 0 ? builder.plainStroke(style.color, 0.75 * PX_PER_PT, false) : stroke,
				inner,
				0,
				series.node
			)
		}

		pointLabels(frame, series, order, xs, ys, null, "r")
	})
}

export interface SurfaceBand {
	readonly low: number
	readonly high: number
	readonly label: string
	readonly fill: number
	readonly stroke: number
}

// Grid cells of a surface drawn at most; past it the rest of the grid is left out (and reported).
export const MAX_SURFACE_CELLS = 1 << 16

// Corners of a triangle clipped to the values in [low, high], interpolated linearly along its edges
// (Sutherland-Hodgman against the two thresholds); fewer than 3 corners when it misses the band.
function clipToBand(xs: number[], ys: number[], vs: number[], low: number, high: number): { xs: number[]; ys: number[] } {
	let px = xs
	let py = ys
	let pv = vs

	for (const [limit, above] of [
		[low, true],
		[high, false]
	] as const) {
		const nx: number[] = []
		const ny: number[] = []
		const nv: number[] = []

		for (let k = 0; k < pv.length; k++) {
			const j = (k + 1) % pv.length
			const a = pv[k] ?? 0
			const b = pv[j] ?? 0
			const inA = above ? a >= limit : a <= limit
			const inB = above ? b >= limit : b <= limit

			if (inA) {
				nx.push(px[k] ?? 0)
				ny.push(py[k] ?? 0)
				nv.push(a)
			}

			if (inA !== inB) {
				const t = (limit - a) / (b - a)

				nx.push((px[k] ?? 0) + t * ((px[j] ?? 0) - (px[k] ?? 0)))
				ny.push((py[k] ?? 0) + t * ((py[j] ?? 0) - (py[k] ?? 0)))
				nv.push(limit)
			}
		}

		px = nx
		py = ny
		pv = nv

		if (pv.length < 3) break
	}

	return { xs: px, ys: py }
}

// A contour: the series' values over the categories (across) and the series (up), each cell split into two
// triangles whose parts in each value band fill with the band's paint; a wireframe draws the bands' lower edges.
export function drawSurface(frame: PlotFrame, rows: AxisState | undefined, bands: readonly SurfaceBand[]): void {
	const { builder, plot, inner } = frame
	const columns = frame.categoryAxis

	if (columns === undefined || bands.length === 0) return

	const series = plot.series.length === 1 ? [plot.series[0], plot.series[0]] : plot.series
	const rowCount = series.length
	let columnCount = 0

	for (const entry of series) columnCount = Math.max(columnCount, entry?.values.count ?? 0)

	if (rowCount < 2 || columnCount === 0) return

	const wide = columnCount === 1 ? 2 : columnCount
	const columnAt = (i: number): number => (columnCount === 1 ? (i === 0 ? inner.x : inner.x + inner.w) : categoryPosition(columns, i))
	const rowAt = (j: number): number =>
		rows !== undefined && plot.series.length > 1 ? categoryPosition(rows, j) : inner.y + inner.h - (j * inner.h) / (rowCount - 1)
	const valueAt = (i: number, j: number): number => series[j]?.values.numbers?.[columnCount === 1 ? 0 : i] ?? Number.NaN
	const cells = Math.min(MAX_SURFACE_CELLS, (wide - 1) * (rowCount - 1))

	for (let band = 0; band < bands.length; band++) {
		const { low, high, fill, stroke } = bands[band] as SurfaceBand

		builder.begin()

		for (let cell = 0; cell < cells; cell++) {
			const i = cell % (wide - 1)
			const j = Math.floor(cell / (wide - 1))
			const x0 = columnAt(i)
			const x1 = columnAt(i + 1)
			const y0 = rowAt(j)
			const y1 = rowAt(j + 1)
			const v00 = valueAt(i, j)
			const v10 = valueAt(i + 1, j)
			const v01 = valueAt(i, j + 1)
			const v11 = valueAt(i + 1, j + 1)
			const triangles = [
				[x0, y0, v00, x1, y0, v10, x1, y1, v11],
				[x0, y0, v00, x1, y1, v11, x0, y1, v01]
			]

			for (const t of triangles) {
				const vs = [t[2] ?? 0, t[5] ?? 0, t[8] ?? 0]

				// A cell with a missing point is left empty, as Office leaves it.
				if (!vs.every(Number.isFinite)) continue

				const min = Math.min(...vs)
				const max = Math.max(...vs)

				if (fill >= 0) {
					// Values beyond the axis fall in the end bands.
					const bottom = band === 0 ? -Infinity : low
					const top = band === bands.length - 1 ? Infinity : high

					if (max < bottom || min > top) continue

					const part = clipToBand([t[0] ?? 0, t[3] ?? 0, t[6] ?? 0], [t[1] ?? 0, t[4] ?? 0, t[7] ?? 0], vs, bottom, top)

					if (part.xs.length < 3) continue

					builder.list.moveTo(part.xs[0] ?? 0, part.ys[0] ?? 0)

					for (let k = 1; k < part.xs.length; k++) builder.list.lineTo(part.xs[k] ?? 0, part.ys[k] ?? 0)

					builder.list.close()
				} else if (band > 0 && min < low && max > low) {
					// The band's lower edge through the triangle: where two of its edges cross the value.
					const points: number[] = []

					for (let k = 0; k < 3; k++) {
						const a = vs[k] ?? 0
						const b = vs[(k + 1) % 3] ?? 0

						if (a < low === b < low) continue

						const s = (low - a) / (b - a)

						points.push((t[k * 3] ?? 0) + s * ((t[((k + 1) % 3) * 3] ?? 0) - (t[k * 3] ?? 0)))
						points.push((t[k * 3 + 1] ?? 0) + s * ((t[((k + 1) % 3) * 3 + 1] ?? 0) - (t[k * 3 + 1] ?? 0)))
					}

					if (points.length >= 4) builder.segment(points[0] ?? 0, points[1] ?? 0, points[2] ?? 0, points[3] ?? 0)
				}
			}
		}

		builder.end(fill, fill >= 0 ? -1 : stroke, inner, 0, plot.node)
	}
}

// Whether a surface plot has more grid cells than are drawn.
export function surfaceTruncated(plot: Plot): boolean {
	let columns = 0

	for (const series of plot.series) columns = Math.max(columns, series.values.count)

	return plot.kind === "surface" && (Math.max(2, columns) - 1) * (Math.max(2, plot.series.length) - 1) > MAX_SURFACE_CELLS
}

export function drawPie(frame: PlotFrame): void {
	const { builder, plot, inner, styles } = frame
	const rings = plot.kind === "doughnut" ? plot.series : plot.series.slice(0, 1)

	if (rings.length === 0) return

	let maxExplosion = 0

	for (const series of rings) {
		const style = styles.get(series.node)

		if (style === undefined) continue

		maxExplosion = Math.max(maxExplosion, style.explosion)

		for (const point of style.points.values())
			if (Number.isFinite(point.explosion)) maxExplosion = Math.max(maxExplosion, point.explosion)
	}

	const cx = inner.x + inner.w / 2
	const cy = inner.y + inner.h / 2
	const outer = Math.max(1, Math.min(inner.w, inner.h) / 2 / (1 + Math.min(400, maxExplosion) / 100))
	const hole = plot.kind === "doughnut" ? (outer * plot.holeSize) / 100 : 0
	const thickness = (outer - hole) / rings.length
	const startAngle = ((plot.firstSliceAngle - 90) * Math.PI) / 180

	rings.forEach((series, ring) => {
		const style = styles.get(series.node)

		if (style === undefined) return

		const count = series.values.count
		const values = series.values.numbers
		let total = 0

		for (let k = 0; k < count; k++) {
			const v = Math.abs(values?.[k] ?? Number.NaN)

			if (Number.isFinite(v)) total += v
		}

		if (total <= 0) return

		const r1 = hole + thickness * (ring + 1)
		const r0 = plot.kind === "doughnut" ? hole + thickness * ring : 0
		const labels = seriesLabels(builder, plot.dataLabels, series.node)
		let angle = startAngle

		for (let k = 0; k < count; k++) {
			const v = Math.abs(values?.[k] ?? Number.NaN)

			if (!Number.isFinite(v) || v === 0) continue

			const sweep = (v / total) * Math.PI * 2
			const a0 = angle
			const a1 = angle + sweep
			const middle = (a0 + a1) / 2
			const point = style.points.get(k)
			const explosion = point !== undefined && Number.isFinite(point.explosion) ? point.explosion : style.explosion
			const shift = plot.kind === "doughnut" ? 0 : (outer * explosion) / 100
			const x = cx + shift * Math.cos(middle)
			const y = cy + shift * Math.sin(middle)

			angle = a1
			builder.begin()

			if (sweep >= Math.PI * 2 - 1e-9) {
				builder.list.moveTo(x + r1, y)
				builder.arc(x, y, r1, 0, Math.PI * 2)
				builder.list.close()

				if (r0 > 0) {
					builder.list.moveTo(x + r0, y)
					builder.arc(x, y, r0, 0, -Math.PI * 2)
					builder.list.close()
				}
			} else if (r0 > 0) {
				builder.list.moveTo(x + r1 * Math.cos(a0), y + r1 * Math.sin(a0))
				builder.arc(x, y, r1, a0, a1)
				builder.list.lineTo(x + r0 * Math.cos(a1), y + r0 * Math.sin(a1))
				builder.arc(x, y, r0, a1, a0)
				builder.list.close()
			} else {
				builder.list.moveTo(x, y)
				builder.list.lineTo(x + r1 * Math.cos(a0), y + r1 * Math.sin(a0))
				builder.arc(x, y, r1, a0, a1)
				builder.list.close()
			}

			builder.end(pointFill(builder, style, k), pointStroke(style, k), inner, ItemFlag.EVEN_ODD, series.node)

			const config = labels === undefined ? undefined : pointConfig(labels, k, frame.labels)

			if (config === undefined) continue

			const text = labelText(
				config,
				seriesName(series, ring),
				frame.categories[k] ?? "",
				values?.[k] ?? 0,
				valueFormat(series),
				v / total
			)

			if (text === "") continue

			const where = config.position || "bestFit"
			const outside = where === "outEnd" || (where === "bestFit" && sweep < 0.35)
			const radius = outside ? r1 + 6 : where === "inEnd" ? r1 * 0.8 : where === "ctr" ? (r0 + r1) / 2 : r0 + (r1 - r0) * 0.65
			const lx = x + radius * Math.cos(middle)
			const ly = y + radius * Math.sin(middle)
			const side = !outside
				? "ctr"
				: Math.abs(Math.cos(middle)) < 0.3
					? Math.sin(middle) < 0
						? "t"
						: "b"
					: Math.cos(middle) > 0
						? "r"
						: "l"

			frame.labels.push(placeLabel(text, config, lx, ly, side, series.node))
		}
	})
}

// Radar: categories on spokes clockwise from the top, values outward from the centre. The axes are drawn
// here (a web of gridlines, spokes and labels), not by the cartesian axis code.
export function drawRadar(frame: PlotFrame): void {
	const { builder, plot, inner, styles } = frame
	const category = frame.categoryAxis
	const value = frame.valueAxis
	const scale = value?.scale

	if (category === undefined || value === undefined || scale === undefined) return

	const count = Math.max(1, category.count)
	const text = category.text
	const labelSpace = category.axis.deleted || category.axis.labelPosition === "none" ? 4 : estimateHeight(text.size) * 1.5
	const cx = inner.x + inner.w / 2
	const cy = inner.y + inner.h / 2
	const radius = Math.max(1, Math.min(inner.w, inner.h) / 2 - labelSpace)
	const angles = new Float64Array(count)
	const box: Rect = { x: cx - radius, y: cy - radius, w: radius * 2, h: radius * 2 }

	for (let k = 0; k < count; k++) angles[k] = -Math.PI / 2 + (k * Math.PI * 2) / count

	const reach = (v: number): number => radius * clamp(scaleFraction(scale, v), 0, 1)
	const ticks = scaleTicks(scale)
	const gridStroke =
		value.axis.majorGridlines < 0
			? -1
			: builder.line(builder.reader.child(value.axis.majorGridlines, D.C, "spPr"), {
					color: mutedText(builder.theme, 0.15),
					width: 1,
					round: false
				})

	if (gridStroke >= 0) {
		builder.begin()

		for (const tick of ticks) {
			const r = reach(tick)

			if (r <= 0) continue

			for (let k = 0; k <= count; k++) {
				const angle = angles[k % count] ?? 0
				const x = cx + r * Math.cos(angle)
				const y = cy + r * Math.sin(angle)

				if (k === 0) builder.list.moveTo(x, y)
				else builder.list.lineTo(x, y)
			}
		}

		builder.end(-1, gridStroke, box, 0, value.axis.node)
	}

	const spokeStroke = category.axis.deleted
		? -1
		: builder.line(category.axis.spPr, { color: mutedText(builder.theme, 0.15), width: 1, round: false })

	if (spokeStroke >= 0) {
		builder.begin()

		for (let k = 0; k < count; k++)
			builder.segment(cx, cy, cx + radius * Math.cos(angles[k] ?? 0), cy + radius * Math.sin(angles[k] ?? 0))

		builder.end(-1, spokeStroke, box, 0, category.axis.node)
	}

	plot.series.forEach((series, order) => {
		const style = styles.get(series.node)

		if (style === undefined) return

		const xs = new Float64Array(count).fill(Number.NaN)
		const ys = new Float64Array(count).fill(Number.NaN)

		for (let k = 0; k < Math.min(count, series.values.count); k++) {
			const v = seriesValue(series, k, plot.filled ? "zero" : frame.blanks)

			if (!Number.isFinite(v)) continue

			xs[k] = cx + reach(v) * Math.cos(angles[k] ?? 0)
			ys[k] = cy + reach(v) * Math.sin(angles[k] ?? 0)
		}

		builder.begin()
		polyline(builder, xs, ys, false, false, true)
		builder.end(plot.filled ? style.fill : -1, style.stroke, box, ItemFlag.EVEN_ODD, series.node)
		drawMarkers(builder, style, xs, ys, box, series.node)
		pointLabels(frame, series, order, xs, ys, null, "t")
	})

	if (!value.axis.deleted && value.axis.labelPosition !== "none") {
		const valueText = value.text

		for (const tick of ticks) {
			const label = formatNumber(tick, value.format)
			const width = estimateWidth(label, valueText.size) + 4
			const height = estimateHeight(valueText.size)
			const y = cy - reach(tick)

			builder.label(
				[plainParagraph(label, valueText, "r")],
				{ x: cx - 4 - width, y: y - height / 2, w: width, h: height },
				labelBody("ctr"),
				value.axis.node
			)
		}
	}

	if (!category.axis.deleted && category.axis.labelPosition !== "none") {
		for (let k = 0; k < count; k++) {
			const label = category.categories[k] ?? ""

			if (label === "") continue

			const angle = angles[k] ?? 0
			const x = cx + (radius + 4) * Math.cos(angle)
			const y = cy + (radius + 4) * Math.sin(angle)
			const width = estimateWidth(label, text.size) + 4
			const height = estimateHeight(text.size)
			const cos = Math.cos(angle)
			const sin = Math.sin(angle)
			const left = Math.abs(cos) < 0.2 ? x - width / 2 : cos > 0 ? x : x - width
			const top = Math.abs(sin) < 0.2 ? y - height / 2 : sin > 0 ? y : y - height

			builder.label(
				[plainParagraph(label, text, Math.abs(cos) < 0.2 ? "ctr" : cos > 0 ? "l" : "r")],
				{ x: left, y: top, w: width, h: height },
				labelBody("ctr"),
				category.axis.node
			)
		}
	}
}

// The category names of a plot: the first series' categories, formatted with `format` when numeric.
export function plotCategories(plot: Plot, date1904: boolean, format: string | undefined): string[] {
	for (const series of plot.series) {
		if (series.categories.count > 0) return cacheLabels(series.categories, date1904, format)
	}

	return []
}

import { D, type DrawingReader } from "../reader"
import { formatNumber } from "./format"

// Cached chart data (§21.2.2: c:numCache, c:strCache, c:numLit, c:strLit, c:multiLvlStrCache). Charts are
// drawn from the values Office cached in the part; the workbook is never opened.

// Points beyond this index are ignored, so a crafted ptCount cannot allocate gigabytes.
export const MAX_POINTS = 1 << 18
// Points one chart may hold across all its series and categories, and series per chart (Excel's own
// limit is 255): conversion work stays bounded however many series a part declares.
export const MAX_CHART_POINTS = 1 << 20
export const MAX_SERIES = 255

// What is left of a chart's point budget; shared by every cache of one chart.
export interface PointBudget {
	remaining: number
}

export function pointBudget(): PointBudget {
	return { remaining: MAX_CHART_POINTS }
}

export interface CachedValues {
	readonly count: number
	// Numbers by point index, NaN where a point is missing; null for string data.
	readonly numbers: Float64Array | null
	// Strings by point index ("" where missing); null for numeric data.
	readonly strings: readonly string[] | null
	readonly formatCode: string
}

const EMPTY: CachedValues = { count: 0, numbers: null, strings: null, formatCode: "General" }

// The points a cache holds: up to the highest point written (a declared c:ptCount beyond the last point
// is not allocated), within c:ptCount, MAX_POINTS and the chart's remaining budget, which it consumes.
function pointCount(reader: DrawingReader, cache: number, points: readonly number[], budget: PointBudget): number {
	let highest = -1

	points.forEach((pt, position) => {
		highest = Math.max(highest, reader.number(pt, "idx", position))
	})

	const declared = Math.floor(reader.number(reader.child(cache, D.C, "ptCount"), "val", highest + 1))
	const count = Math.max(0, Math.min(MAX_POINTS, budget.remaining, highest + 1, Number.isFinite(declared) ? declared : 0))

	budget.remaining -= count

	return count
}

function readNumbers(reader: DrawingReader, cache: number, budget: PointBudget): CachedValues {
	const points = reader.children(cache, D.C, "pt")
	const count = pointCount(reader, cache, points, budget)
	const numbers = new Float64Array(count).fill(Number.NaN)

	points.forEach((pt, position) => {
		const index = reader.number(pt, "idx", position)

		if (!(index >= 0 && index < count)) return

		const text = reader.text(reader.child(pt, D.C, "v")).trim()
		const value = text === "" ? Number.NaN : Number(text)

		numbers[index] = Number.isFinite(value) ? value : Number.NaN
	})

	return { count, numbers, strings: null, formatCode: reader.text(reader.child(cache, D.C, "formatCode")).trim() || "General" }
}

function readStrings(reader: DrawingReader, cache: number, budget: PointBudget): CachedValues {
	const points = reader.children(cache, D.C, "pt")
	const count = pointCount(reader, cache, points, budget)
	const strings: string[] = new Array<string>(count).fill("")

	points.forEach((pt, position) => {
		const index = reader.number(pt, "idx", position)

		if (index >= 0 && index < count) strings[index] = reader.text(reader.child(pt, D.C, "v"))
	})

	return { count, numbers: null, strings, formatCode: "General" }
}

// The cached values of a data source element (c:tx, c:cat, c:val, c:xVal, c:yVal).
export function readCache(reader: DrawingReader, source: number, budget: PointBudget): CachedValues {
	if (source < 0) return EMPTY

	const numRef = reader.child(source, D.C, "numRef")
	const numCache = numRef >= 0 ? reader.child(numRef, D.C, "numCache") : reader.child(source, D.C, "numLit")

	if (numCache >= 0) return readNumbers(reader, numCache, budget)

	const strRef = reader.child(source, D.C, "strRef")
	const strCache = strRef >= 0 ? reader.child(strRef, D.C, "strCache") : reader.child(source, D.C, "strLit")

	if (strCache >= 0) return readStrings(reader, strCache, budget)

	const multi = reader.child(source, D.C, "multiLvlStrRef")
	const multiCache = reader.child(multi, D.C, "multiLvlStrCache")

	if (multiCache >= 0) {
		// The first level is the innermost (the labels next to the axis).
		const level = reader.child(multiCache, D.C, "lvl")
		return level < 0 ? EMPTY : readStrings(reader, level, budget)
	}

	// c:tx may hold a literal c:v.
	const literal = reader.child(source, D.C, "v")

	return literal >= 0 ? { count: 1, numbers: null, strings: [reader.text(literal)], formatCode: "General" } : EMPTY
}

// Point labels of cached values (category names), formatted for numbers.
export function cacheLabels(values: CachedValues, date1904: boolean, formatCode?: string): string[] {
	if (values.strings !== null) return [...values.strings]

	const out: string[] = []
	const numbers = values.numbers

	if (numbers === null) return out

	for (let k = 0; k < values.count; k++) out.push(formatNumber(numbers[k] ?? Number.NaN, formatCode ?? values.formatCode, date1904))

	return out
}

export interface SeriesData {
	readonly node: number
	// c:idx (default colour slot) and c:order (plot order).
	readonly index: number
	readonly order: number
	readonly name: string
	// Categories, or the x values (c:xVal) of a scatter series.
	readonly categories: CachedValues
	readonly values: CachedValues
	// c:bubbleSize of a bubble series.
	readonly sizes?: CachedValues
	readonly spPr: number
	// c:errBars (§21.2.2.55) and c:trendline nodes (§21.2.2.211) of the series.
	readonly errorBars: readonly ErrorBarData[]
	readonly trendlines: readonly number[]
}

export type ErrorValueType = "cust" | "fixedVal" | "percentage" | "stdDev" | "stdErr"

export interface ErrorBarData {
	readonly node: number
	// c:errDir: along the x or the y values (category plots use only the value direction).
	readonly direction: "x" | "y"
	readonly plus: boolean
	readonly minus: boolean
	readonly valueType: ErrorValueType
	// c:val: the fixed amount, percentage or number of standard deviations.
	readonly value: number
	// c:plus / c:minus amounts of a custom error bar.
	readonly custom: { readonly plus: CachedValues; readonly minus: CachedValues } | undefined
	readonly endCaps: boolean
	readonly spPr: number
}

const NO_ERROR_BARS: readonly ErrorBarData[] = []
const NO_TRENDLINES: readonly number[] = []
const ERROR_VALUE_TYPES: ReadonlySet<string> = new Set(["cust", "fixedVal", "percentage", "stdDev", "stdErr"])

function readErrorBars(reader: DrawingReader, ser: number, budget: PointBudget): readonly ErrorBarData[] {
	const nodes = reader.children(ser, D.C, "errBars")

	if (nodes.length === 0) return NO_ERROR_BARS

	return nodes.map(node => {
		const value = (local: string): string | undefined => reader.attr(reader.child(node, D.C, local), "val")
		const type = value("errBarType") ?? "both"
		const valueType = value("errValType") ?? "fixedVal"
		const resolved = (ERROR_VALUE_TYPES.has(valueType) ? valueType : "fixedVal") as ErrorValueType
		const noEndCap = reader.child(node, D.C, "noEndCap")

		return {
			node,
			direction: value("errDir") === "x" ? "x" : "y",
			plus: type !== "minus",
			minus: type !== "plus",
			valueType: resolved,
			value: reader.number(reader.child(node, D.C, "val"), "val", 0),
			custom:
				resolved === "cust"
					? {
							plus: readCache(reader, reader.child(node, D.C, "plus"), budget),
							minus: readCache(reader, reader.child(node, D.C, "minus"), budget)
						}
					: undefined,
			endCaps: noEndCap < 0 || !reader.bool(noEndCap, "val", true),
			spPr: reader.child(node, D.C, "spPr")
		}
	})
}

// Every c:ser of a plot (the first MAX_SERIES of the chart), sorted by c:order.
export function readSeries(
	reader: DrawingReader,
	plot: number,
	scatter: boolean,
	budget: PointBudget,
	series: { count: number },
	bubble: boolean = false
): SeriesData[] {
	const out: SeriesData[] = []

	reader.children(plot, D.C, "ser").forEach((ser, position) => {
		if (series.count >= MAX_SERIES) return

		series.count++

		const index = reader.number(reader.child(ser, D.C, "idx"), "val", position)
		const tx = reader.child(ser, D.C, "tx")
		const name = readCache(reader, tx, budget)

		out.push({
			node: ser,
			index,
			order: reader.number(reader.child(ser, D.C, "order"), "val", index),
			name: name.strings?.[0] ?? (name.numbers === null ? "" : formatNumber(name.numbers[0] ?? Number.NaN, name.formatCode)),
			categories: readCache(reader, reader.child(ser, D.C, scatter ? "xVal" : "cat"), budget),
			values: readCache(reader, reader.child(ser, D.C, scatter ? "yVal" : "val"), budget),
			...(bubble ? { sizes: readCache(reader, reader.child(ser, D.C, "bubbleSize"), budget) } : {}),
			spPr: reader.child(ser, D.C, "spPr"),
			errorBars: readErrorBars(reader, ser, budget),
			trendlines: reader.child(ser, D.C, "trendline") < 0 ? NO_TRENDLINES : reader.children(ser, D.C, "trendline")
		})
	})

	out.sort((a, b) => a.order - b.order)

	return out
}

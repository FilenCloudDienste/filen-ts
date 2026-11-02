import { appendAll } from "../../arrays"
import type { SheetId, SheetRange } from "../protocol"
import { cellName } from "../refs/cellRef"
import type { XlsxBorderEdge, XlsxColor, XlsxDxf, XlsxFont } from "../../xlsx/model/types"
import { FormulaEvaluator, formulaSheets, ruleTruth, type FormulaHost } from "./formula/evaluate"
import { parseFormula, type AreaRef, type FormulaNode, type ParsedFormula } from "./formula/syntax"
import { FormulaError, Unsupported, compareNumbers, compareValues, type Scalar } from "./formula/values"
import { CfBarFlag, iconCount, iconSetIndex } from "./layers"
import { RangeIndex, intersects } from "./ranges"
import type { CfBlock, CfRule, Cfvo } from "./rules"
import { RangeStatistics, type RangeTotals, valueKey } from "./statistics"

// Conditional formats evaluated for cells, as Excel applies them (support.microsoft.com, "Use conditional formatting
// to highlight information"; ECMA-376 Part 1 §18.3.1.10): every rule whose condition holds applies, the lower
// priority number first winning each property, until a rule with stopIfTrue holds. Statistics over a rule's range
// (top 10, average, duplicates, the scales' minimum and maximum) are kept per band of rows, and an edit reads again
// only the bands it touched (statistics.ts).

// What the rules that hold give one cell.
export interface CfLook {
	font: XlsxFont | null
	fill: { readonly kind: "solid"; readonly rgb: number } | { readonly kind: "dxf"; readonly fill: NonNullable<XlsxDxf["fill"]> } | null
	top: XlsxBorderEdge | null
	bottom: XlsxBorderEdge | null
	left: XlsxBorderEdge | null
	right: XlsxBorderEdge | null
	numFmt: string | null
	bar: CfBarLook | null
	icon: { readonly set: number; readonly icon: number } | null
	hideValue: boolean
}

export interface CfBarLook {
	readonly start: number
	readonly end: number
	readonly axis: number
	readonly fill: number
	readonly border: number
	readonly axisColor: number
	readonly flags: number
}

type ColorOf = (color: XlsxColor | null) => number

// The formulas Excel writes for the rules that test text, blanks, errors and dates, for the rule's first cell
// (written when the file has none).
function impliedFormula(rule: CfRule, cell: string): string | null {
	const text = `"${(rule.text ?? "").replace(/"/gu, '""')}"`

	switch (rule.type) {
		case "containsText":
			return `NOT(ISERROR(SEARCH(${text},${cell})))`
		case "notContainsText":
			return `ISERROR(SEARCH(${text},${cell}))`
		case "beginsWith":
			return `LEFT(${cell},LEN(${text}))=${text}`
		case "endsWith":
			return `RIGHT(${cell},LEN(${text}))=${text}`
		case "containsBlanks":
			return `LEN(TRIM(${cell}))=0`
		case "notContainsBlanks":
			return `LEN(TRIM(${cell}))>0`
		case "containsErrors":
			return `ISERROR(${cell})`
		case "notContainsErrors":
			return `NOT(ISERROR(${cell}))`
		case "timePeriod":
			switch (rule.timePeriod) {
				case "today":
					return `FLOOR(${cell},1)=TODAY()`
				case "yesterday":
					return `FLOOR(${cell},1)=TODAY()-1`
				case "tomorrow":
					return `FLOOR(${cell},1)=TODAY()+1`
				case "last7Days":
					return `AND(TODAY()-FLOOR(${cell},1)<=6,FLOOR(${cell},1)<=TODAY())`
				case "thisWeek":
					return `AND(TODAY()-ROUNDDOWN(${cell},0)<=WEEKDAY(TODAY())-1,ROUNDDOWN(${cell},0)-TODAY()<=7-WEEKDAY(TODAY()))`
				case "lastWeek":
					return `AND(TODAY()-ROUNDDOWN(${cell},0)>=(WEEKDAY(TODAY())),TODAY()-ROUNDDOWN(${cell},0)<(WEEKDAY(TODAY())+7))`
				case "nextWeek":
					return `AND(ROUNDDOWN(${cell},0)-TODAY()>(7-WEEKDAY(TODAY())),ROUNDDOWN(${cell},0)-TODAY()<(15-WEEKDAY(TODAY())))`
				case "thisMonth":
					return `AND(MONTH(${cell})=MONTH(TODAY()),YEAR(${cell})=YEAR(TODAY()))`
				case "lastMonth":
					return `AND(MONTH(${cell})=MONTH(EDATE(TODAY(),0-1)),YEAR(${cell})=YEAR(EDATE(TODAY(),0-1)))`
				case "nextMonth":
					return `AND(MONTH(${cell})=MONTH(EDATE(TODAY(),0+1)),YEAR(${cell})=YEAR(EDATE(TODAY(),0+1)))`
				default:
					return null
			}
		default:
			return null
	}
}

const FORMULA_TYPES: ReadonlySet<string> = new Set([
	"expression",
	"containsText",
	"notContainsText",
	"beginsWith",
	"endsWith",
	"containsBlanks",
	"notContainsBlanks",
	"containsErrors",
	"notContainsErrors",
	"timePeriod"
])

const STATISTIC_TYPES: ReadonlySet<string> = new Set([
	"top10",
	"aboveAverage",
	"uniqueValues",
	"duplicateValues",
	"colorScale",
	"dataBar",
	"iconSet"
])

// Bands of a rule's statistics read at once when asked for; more are read later, sliced.
const SYNC_BANDS = 2

// Ranges a change adds for a rule's cells: its parts, or the rectangle around them when there are many.
const ADDED_PARTS = 64

function addedRanges(index: RangeIndex): readonly SheetRange[] {
	return index.ranges.length <= ADDED_PARTS ? index.ranges : [index.bounds]
}

// What a rule might set that a rule over it could not be calculated for: left undecided below it.
interface Undecided {
	readonly font: Set<string>
	fill: boolean
	top: boolean
	bottom: boolean
	left: boolean
	right: boolean
	numFmt: boolean
	bar: boolean
	icon: boolean
}

// The areas a formula's references reach when it is evaluated for every cell of `ranges` (null: anywhere, for a
// name or a reference made at run time).
function reach(
	node: FormulaNode,
	anchorRow: number,
	anchorCol: number,
	ranges: readonly SheetRange[],
	out: { sheet: string | null; range: SheetRange }[]
): boolean {
	switch (node.kind) {
		case "area":
			for (const range of ranges) out.push({ sheet: node.ref.sheet, range: moved(node.ref, anchorRow, anchorCol, range) })

			return true
		case "name":
			return false
		case "call":
			if (node.name === "INDIRECT" || node.name === "OFFSET") return false

			return node.args.every(arg => reach(arg, anchorRow, anchorCol, ranges, out))
		case "unary":
		case "percent":
			return reach(node.operand, anchorRow, anchorCol, ranges, out)
		case "binary":
			return reach(node.left, anchorRow, anchorCol, ranges, out) && reach(node.right, anchorRow, anchorCol, ranges, out)
		default:
			return true
	}
}

function moved(ref: AreaRef, anchorRow: number, anchorCol: number, range: SheetRange): SheetRange {
	const span = (start: number, end: number, abs: boolean, from: number, to: number, max: number): [number, number] => {
		if (abs) return [start, end]

		const low = start + from
		const high = end + to

		return low < 0 || high >= max ? [0, max - 1] : [low, high]
	}
	const [r1] = span(ref.startRow, ref.startRow, ref.startRowAbs, range.startRow - anchorRow, range.endRow - anchorRow, 1_048_576)
	const [, r2] = span(ref.endRow, ref.endRow, ref.endRowAbs, range.startRow - anchorRow, range.endRow - anchorRow, 1_048_576)
	const [c1] = span(ref.startCol, ref.startCol, ref.startColAbs, range.startCol - anchorCol, range.endCol - anchorCol, 16_384)
	const [, c2] = span(ref.endCol, ref.endCol, ref.endColAbs, range.startCol - anchorCol, range.endCol - anchorCol, 16_384)

	return { startRow: Math.min(r1, r2), startCol: Math.min(c1, c2), endRow: Math.max(r1, r2), endCol: Math.max(c1, c2) }
}

class PreparedRule {
	readonly rule: CfRule
	readonly block: CfBlock
	readonly anchorRow: number
	readonly anchorCol: number
	readonly order: number
	readonly bounds: SheetRange
	// Its ranges by position (shared by the rules of a block).
	readonly index: RangeIndex
	// The rule's formulas as written (or implied), and read once; an Unsupported one leaves the rule unapplied.
	readonly texts: readonly string[]
	readonly formulas: readonly (ParsedFormula | Unsupported)[]
	// Where the formulas read, by upper-case sheet name ("": the rule's own), or null when that is not known ahead.
	readonly reads: ReadonlyMap<string, RangeIndex> | null
	// The rule's ranges as a key: rules over the same cells share their statistics.
	readonly rangesKey: string
	// Formulas that read nothing relative, evaluated once.
	constants: (Scalar | undefined)[] = []

	constructor(rule: CfRule, block: CfBlock, order: number, index: RangeIndex, rangesKey: string) {
		this.rule = rule
		this.block = block
		this.order = order
		this.index = index
		this.rangesKey = rangesKey
		this.bounds = index.bounds
		// Formulas are written for the top-left cell of the rectangle around the ranges (every multi-range rule of the
		// corpus whose formulas say so, 66 of 66; LibreOffice reads them so), not the first range's.
		this.anchorRow = this.bounds.startRow
		this.anchorCol = this.bounds.startCol

		const texts = [...rule.formulas]

		if (FORMULA_TYPES.has(rule.type) && texts.length === 0) {
			const implied = impliedFormula(rule, cellName(this.anchorRow, this.anchorCol))

			if (implied !== null) texts.push(implied)
		}

		for (const cfvo of [
			...(rule.colorScale?.cfvos ?? []),
			...(rule.dataBar === null ? [] : [rule.dataBar.min, rule.dataBar.max]),
			...(rule.iconSet?.cfvos ?? [])
		])
			if (cfvo.type === "formula" && cfvo.value !== null) texts.push(cfvo.value)

		this.texts = texts
		this.formulas = texts.map(text => {
			try {
				return parseFormula(text)
			} catch (error) {
				if (error instanceof Unsupported) return error

				throw error
			}
		})

		const reads: { sheet: string | null; range: SheetRange }[] = []
		let known = true

		for (const formula of this.formulas)
			if (!(formula instanceof Unsupported)) known = reach(formula.root, this.anchorRow, this.anchorCol, block.ranges, reads) && known

		if (!known) {
			this.reads = null

			return
		}

		const bySheet = new Map<string, SheetRange[]>()

		for (const read of reads) {
			const sheet = read.sheet?.toUpperCase() ?? ""
			const list = bySheet.get(sheet)

			if (list === undefined) bySheet.set(sheet, [read.range])
			else list.push(read.range)
		}

		this.reads = new Map([...bySheet].map(([sheet, ranges]) => [sheet, new RangeIndex(ranges)]))
	}
}

function lerp(a: number, b: number, t: number): number {
	const channel = (shift: number): number => Math.round(((a >> shift) & 0xff) + (((b >> shift) & 0xff) - ((a >> shift) & 0xff)) * t)

	return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

export class SheetConditionalFormats {
	readonly sheet: SheetId
	readonly rules: readonly PreparedRule[]
	private readonly evaluator: FormulaEvaluator
	private readonly host: FormulaHost
	// Statistics by ranges key: rules over the same cells share them.
	private readonly statistics = new Map<string, RangeStatistics>()
	// warm() is under way: rules waiting for their statistics are left out of tiles until it is done.
	warming = false
	// Reads statistics later, sliced, and patches the rules' tiles once they are read (null: read them at once). Set
	// by the tile builder for the session it builds in.
	later: ((statistics: RangeStatistics, ranges: readonly SheetRange[]) => void) | null = null
	private readonly reading = new Set<RangeStatistics>()

	// `previous`: the formats this sheet had before an edit rewrote them; their statistics stand in until these are
	// read (a structure edit then shows the last known ranks, not none).
	constructor(sheet: SheetId, blocks: readonly CfBlock[], host: FormulaHost, previous: SheetConditionalFormats | null = null) {
		this.sheet = sheet
		this.host = host
		this.evaluator = new FormulaEvaluator(host)

		const list: PreparedRule[] = []
		const indexes = new Map<string, RangeIndex>()
		const counting = new Set<string>()

		for (const block of blocks) {
			if (block.ranges.length === 0) continue

			const key = block.ranges
				.map(range => `${String(range.startRow)},${String(range.startCol)},${String(range.endRow)},${String(range.endCol)}`)
				.join(" ")
			let index = indexes.get(key)

			if (index === undefined) {
				index = new RangeIndex(block.ranges)
				indexes.set(key, index)
			}

			for (const rule of block.rules) {
				list.push(new PreparedRule(rule, block, list.length, index, key))

				if (rule.type === "uniqueValues" || rule.type === "duplicateValues") counting.add(key)
			}
		}

		const before = new Map<number, PreparedRule>()

		for (const rule of previous?.rules ?? []) before.set(rule.order, rule)

		for (const rule of list) {
			if (!STATISTIC_TYPES.has(rule.rule.type) || this.statistics.has(rule.rangesKey)) continue

			const old = before.get(rule.order)
			const fallback = old?.rule.type === rule.rule.type ? (previous?.statistics.get(old.rangesKey) ?? null) : null

			this.statistics.set(rule.rangesKey, new RangeStatistics(sheet, host, rule.index, counting.has(rule.rangesKey), fallback))
		}

		// By priority, the lower number first; ties keep the file's order.
		list.sort((a, b) => a.rule.priority - b.rule.priority || a.order - b.order)
		this.rules = list
	}

	// The sheets the rules' formulas read (through names too); `all` when one reads a sheet only known at run time
	// (INDIRECT, OFFSET).
	sheetsRead(): { readonly all: boolean; readonly names: ReadonlySet<string> } {
		const names = new Set<string>()
		let all = false

		for (const rule of this.rules) {
			for (const text of rule.texts) {
				const read = formulaSheets(text, this.sheet, this.host)

				all ||= read.all

				for (const name of read.names) names.add(name)
			}
		}

		return { all, names }
	}

	// The rules on a range (a tile), in the order they apply.
	rulesOn(range: SheetRange): PreparedRule[] {
		return this.rules.filter(rule => intersects(rule.bounds, range) && rule.index.any(range))
	}

	// The ranges whose tiles show the rules.
	lookRanges(): SheetRange[] {
		const seen = new Set<RangeIndex>()
		const ranges: SheetRange[] = []

		for (const rule of this.rules) {
			if (seen.has(rule.index)) continue

			seen.add(rule.index)
			appendAll(ranges, addedRanges(rule.index))
		}

		return ranges
	}

	// Drops what the rules computed from cells of `range` on `sheet` (named `sheetName`), adding the ranges whose look
	// may change with them.
	changed(sheet: SheetId, sheetName: string, range: SheetRange, add: (range: SheetRange) => void): void {
		const own = sheet === this.sheet
		const upper = sheetName.toUpperCase()

		const added = new Set<RangeIndex>()

		for (const rule of this.rules) {
			let hit = false

			// The bands of the statistics the change touched are read again when next asked for.
			if (own && this.statistics.get(rule.rangesKey)?.invalidate(range) === true) hit = true

			if (rule.formulas.length > 0) {
				const reads =
					rule.reads === null ||
					(own && rule.reads.get("")?.any(range) === true) ||
					rule.reads.get(upper)?.any(range) === true ||
					rule.formulas.some(formula => !(formula instanceof Unsupported) && formula.volatile)

				if (reads) {
					rule.constants = []
					hit = true
				}
			}

			if (hit && !added.has(rule.index)) {
				added.add(rule.index)

				for (const part of addedRanges(rule.index)) add(part)
			}
		}
	}

	// The formula's value as a scalar for a cell, or Unsupported.
	private formulaValue(rule: PreparedRule, index: number, row: number, col: number): Scalar {
		const formula = rule.formulas[index]

		if (formula === undefined) return null
		if (formula instanceof Unsupported) throw formula

		const constant = !formula.relative && !formula.volatile

		if (constant && rule.constants[index] !== undefined) return rule.constants[index] ?? null

		const value = this.evaluator.scalar(
			this.evaluator.evaluate(formula, { sheet: this.sheet, anchorRow: rule.anchorRow, anchorCol: rule.anchorCol, row, col })
		)

		if (constant) rule.constants[index] = value

		return value
	}

	private statisticsOf(rule: PreparedRule): RangeStatistics {
		const statistics = this.statistics.get(rule.rangesKey)

		if (statistics === undefined) throw new Error("A rule without statistics asked for them")

		return statistics
	}

	private stats(rule: PreparedRule): RangeTotals {
		const statistics = this.statisticsOf(rule)

		return (this.deferred(rule, statistics) ? statistics.known() : null) ?? statistics.ensure()
	}

	private occurrences(rule: PreparedRule, value: Scalar): number {
		const statistics = this.statisticsOf(rule)

		return statistics.occurrences(value, this.deferred(rule, statistics))
	}

	// Whether a rule's statistics are read later (more bands wait than an edit reads at once, and something is known
	// meanwhile); the read is then started.
	private deferred(rule: PreparedRule, statistics: RangeStatistics): boolean {
		const later = this.later

		if (later === null || statistics.pending(SYNC_BANDS) <= SYNC_BANDS || statistics.known() === null) return false

		this.readLater(rule, statistics, later)

		return true
	}

	private readLater(
		rule: PreparedRule,
		statistics: RangeStatistics,
		later: (statistics: RangeStatistics, ranges: readonly SheetRange[]) => void
	): void {
		if (this.reading.has(statistics)) return

		this.reading.add(statistics)

		const ranges: SheetRange[] = []
		const seen = new Set<RangeIndex>()

		for (const other of this.rules) {
			if (other.rangesKey !== rule.rangesKey || seen.has(other.index)) continue

			seen.add(other.index)
			appendAll(ranges, addedRanges(other.index))
		}

		later(statistics, ranges)
	}

	// The read started by readLater is done (or failed).
	readDone(statistics: RangeStatistics): void {
		this.reading.delete(statistics)
	}

	// Whether a rule's statistics can be shown: read, or known while they are read later (whose read is then
	// started). Nothing known yet: the rule waits, and its tiles are patched once they are read.
	private available(rule: PreparedRule): boolean {
		const statistics = this.statistics.get(rule.rangesKey)

		if (statistics === undefined) return true
		if (this.warming) return statistics.complete

		const later = this.later

		if (later === null || statistics.known() !== null || statistics.pending(SYNC_BANDS) <= SYNC_BANDS) return true

		this.readLater(rule, statistics, later)

		return false
	}

	// Computes what the rules over ranges compute from their cells, a band of rows at a time, before a tile needs it
	// (the sheet's first tiles then never wait for a whole column's statistics). The ranges whose tiles left rules
	// out meanwhile are returned.
	*warm(): Generator<void, SheetRange[]> {
		const warmed: SheetRange[] = []
		const seen = new Set<RangeIndex>()

		for (const rule of this.rules) {
			if (!STATISTIC_TYPES.has(rule.rule.type)) continue

			try {
				yield* this.statisticsOf(rule).steps()
			} catch (error) {
				if (!(error instanceof Unsupported)) throw error
			}

			if (!seen.has(rule.index)) {
				seen.add(rule.index)
				appendAll(warmed, addedRanges(rule.index))
			}
		}

		return warmed
	}

	// The value a top/bottom rule's cells reach (ties at it included), as LibreOffice counts them: N items, or
	// N percent of the numbers rounded down; NaN when none qualify.
	private topThreshold(rule: CfRule, totals: RangeTotals): number {
		const count = totals.count

		if (rule.type !== "top10" || count === 0) return Number.NaN

		const limit = rule.percent ? Math.floor((count * rule.rank) / 100) : Math.floor(rule.rank)

		if (limit <= 0) return Number.NaN
		if (limit >= count) return rule.bottom ? totals.max : totals.min

		// The (limit)th best value: everything at least as good as it qualifies.
		return rule.bottom ? totals.nth(limit - 1) : totals.nth(count - limit)
	}

	// A threshold of a scale, a bar or an icon set from its value object (§18.3.1.11): "percent" is that far between
	// the range's lowest and highest number, "percentile" PERCENTILE.INC of its numbers.
	private cfvoValue(rule: PreparedRule, cfvo: Cfvo, stats: RangeTotals, formulaIndex: number): number {
		const min = stats.min
		const max = stats.max
		const given = cfvo.value === null ? Number.NaN : Number(cfvo.value)

		switch (cfvo.type) {
			case "min":
				return min
			case "max":
				return max
			case "autoMin":
				return Math.min(0, min)
			case "autoMax":
				return Math.max(0, max)
			case "num":
				return given
			case "percent":
				return min + ((max - min) * given) / 100
			case "percentile":
				return stats.percentile(given / 100)
			case "formula": {
				const value = this.formulaValue(rule, formulaIndex, rule.anchorRow, rule.anchorCol)

				return typeof value === "number" ? value : Number.NaN
			}
		}
	}

	// The index of a cfvo formula among the rule's parsed formulas.
	private cfvoFormula(rule: PreparedRule, cfvo: Cfvo): number {
		const texts = rule.rule.formulas.length + (FORMULA_TYPES.has(rule.rule.type) && rule.rule.formulas.length === 0 ? 1 : 0)
		const cfvos = [
			...(rule.rule.colorScale?.cfvos ?? []),
			...(rule.rule.dataBar === null ? [] : [rule.rule.dataBar.min, rule.rule.dataBar.max]),
			...(rule.rule.iconSet?.cfvos ?? [])
		].filter(item => item.type === "formula" && item.value !== null)

		return texts + cfvos.indexOf(cfvo)
	}

	// Whether a rule holds for a cell (its value given), and what it adds to the cell's look.
	private apply(
		rule: PreparedRule,
		value: Scalar,
		row: number,
		col: number,
		look: CfLook,
		undecided: Undecided | null,
		colorOf: ColorOf,
		rightToLeft: boolean
	): boolean {
		const r = rule.rule

		switch (r.type) {
			case "cellIs": {
				if (value instanceof FormulaError) return false

				const first = this.formulaValue(rule, 0, row, col)

				if (first instanceof FormulaError) return false

				const order = compareValues(value, first)

				switch (r.operator) {
					case "lessThan":
						return this.dxf(look, undecided, r, order < 0)
					case "lessThanOrEqual":
						return this.dxf(look, undecided, r, order <= 0)
					case "equal":
						return this.dxf(look, undecided, r, order === 0)
					case "notEqual":
						return this.dxf(look, undecided, r, order !== 0)
					case "greaterThanOrEqual":
						return this.dxf(look, undecided, r, order >= 0)
					case "greaterThan":
						return this.dxf(look, undecided, r, order > 0)
					case "between":
					case "notBetween": {
						const second = this.formulaValue(rule, 1, row, col)

						if (second instanceof FormulaError) return false

						const other = compareValues(value, second)
						// Either bound may be the lower (as LibreOffice and Excel read them).
						const inside = (order >= 0 && other <= 0) || (order <= 0 && other >= 0)

						return this.dxf(look, undecided, r, r.operator === "between" ? inside : !inside)
					}
					default:
						return false
				}
			}
			case "top10": {
				if (typeof value !== "number") return false

				const threshold = this.topThreshold(r, this.stats(rule))

				if (Number.isNaN(threshold)) return false

				return this.dxf(look, undecided, r, r.bottom ? value <= threshold : value >= threshold)
			}
			case "aboveAverage": {
				const stats = this.stats(rule)

				if (typeof value !== "number" || Number.isNaN(stats.average)) return false

				const limit = stats.average + (r.aboveAverage ? 1 : -1) * r.stdDev * stats.deviation
				const order = compareNumbers(value, limit)
				const holds = r.aboveAverage ? (r.equalAverage ? order >= 0 : order > 0) : r.equalAverage ? order <= 0 : order < 0

				return this.dxf(look, undecided, r, holds)
			}
			case "uniqueValues":
			case "duplicateValues": {
				if (valueKey(value) === null) return false

				const count = this.occurrences(rule, value)

				return this.dxf(look, undecided, r, r.type === "uniqueValues" ? count === 1 : count > 1)
			}
			case "colorScale": {
				const scale = r.colorScale

				if (scale === null || typeof value !== "number" || scale.cfvos.length < 2 || scale.colors.length < scale.cfvos.length)
					return false

				const stats = this.stats(rule)
				const points = scale.cfvos.map(cfvo => this.cfvoValue(rule, cfvo, stats, this.cfvoFormula(rule, cfvo)))

				if (points.some(point => Number.isNaN(point))) return false

				const colors = scale.colors.map(color => colorOf(color))
				let rgb = colors[0] ?? 0

				if (value >= (points[points.length - 1] ?? 0)) {
					rgb = colors[colors.length - 1] ?? 0
				} else if (value > (points[0] ?? 0)) {
					for (let i = 1; i < points.length; i++) {
						const low = points[i - 1] ?? 0
						const high = points[i] ?? 0

						if (value <= high) {
							rgb = high === low ? (colors[i] ?? 0) : lerp(colors[i - 1] ?? 0, colors[i] ?? 0, (value - low) / (high - low))
							break
						}
					}
				}

				if (look.fill === null && undecided?.fill !== true) look.fill = { kind: "solid", rgb }

				return true
			}
			case "dataBar": {
				const bar = r.dataBar

				if (bar === null || typeof value !== "number") return false

				const stats = this.stats(rule)
				const low = this.cfvoValue(rule, bar.min, stats, this.cfvoFormula(rule, bar.min))
				const high = this.cfvoValue(rule, bar.max, stats, this.cfvoFormula(rule, bar.max))

				if (Number.isNaN(low) || Number.isNaN(high)) return false

				if (look.bar === null && undecided?.bar !== true) {
					look.bar = barLook(bar, value, Math.min(low, high), Math.max(low, high), colorOf, rightToLeft)

					if (!bar.showValue) look.hideValue = true
				}

				return true
			}
			case "iconSet": {
				const set = r.iconSet

				if (set === null || typeof value !== "number") return false

				const stats = this.stats(rule)
				const count = Math.min(iconCount(set.set), set.cfvos.length)
				let index = 0

				for (let i = 1; i < count; i++) {
					const cfvo = set.cfvos[i] as Cfvo
					const threshold = this.cfvoValue(rule, cfvo, stats, this.cfvoFormula(rule, cfvo))

					if (Number.isNaN(threshold)) continue
					const order = compareNumbers(value, threshold)

					if (order > 0 || (cfvo.gte && order === 0)) index = i
				}

				if (set.reverse) index = count - 1 - index

				if (look.icon === null && undecided?.icon !== true) {
					const custom = set.custom?.[set.reverse ? count - 1 - index : index] ?? null
					const name = custom === null ? set.set : custom.set
					const icon = custom === null ? index : custom.id
					const setIndex = iconSetIndex(name)

					if (setIndex >= 0 && icon >= 0 && icon < iconCount(name)) look.icon = { set: setIndex, icon }
					if (!set.showValue) look.hideValue = true
				}

				return true
			}
			default: {
				if (!FORMULA_TYPES.has(r.type)) return false

				return this.dxf(look, undecided, r, ruleTruth(this.formulaValue(rule, 0, row, col)))
			}
		}
	}

	// A rule's look added where the look has nothing yet and nothing is undecided; its holding returned.
	private dxf(look: CfLook, undecided: Undecided | null, rule: CfRule, holds: boolean): boolean {
		if (!holds || rule.dxf === null) return holds

		const dxf = rule.dxf

		if (dxf.font !== undefined) {
			let font: XlsxFont = dxf.font

			if (undecided !== null && undecided.font.size > 0)
				font = Object.fromEntries(Object.entries(font).filter(([key]) => !undecided.font.has(key))) as XlsxFont

			look.font = look.font === null ? font : { ...font, ...look.font }
		}

		if (dxf.fill !== undefined && look.fill === null && undecided?.fill !== true) {
			const fill = dxf.fill
			const shows = fill.kind === "gradient" || fill.pattern !== "none" || fill.fg !== undefined || fill.bg !== undefined

			if (shows) look.fill = { kind: "dxf", fill }
		}

		const border = dxf.border

		if (border !== undefined) {
			if (look.top === null && undecided?.top !== true && border.top?.style !== undefined) look.top = border.top
			if (look.bottom === null && undecided?.bottom !== true && border.bottom?.style !== undefined) look.bottom = border.bottom
			if (look.left === null && undecided?.left !== true && border.left?.style !== undefined) look.left = border.left
			if (look.right === null && undecided?.right !== true && border.right?.style !== undefined) look.right = border.right
		}

		if (look.numFmt === null && undecided?.numFmt !== true && dxf.numFmt !== undefined && dxf.numFmt.code !== "")
			look.numFmt = dxf.numFmt.code

		return holds
	}

	// What a rule that could not be calculated might set, left undecided for the rules below it (never guessed).
	private undecide(rule: CfRule, undecided: Undecided): void {
		switch (rule.type) {
			case "colorScale":
				undecided.fill = true
				return
			case "dataBar":
				undecided.bar = true
				return
			case "iconSet":
				undecided.icon = true
				return
			default:
				break
		}

		const dxf = rule.dxf

		if (dxf === null) return

		if (dxf.font !== undefined) for (const key of Object.keys(dxf.font)) undecided.font.add(key)

		if (dxf.fill !== undefined) undecided.fill = true

		if (dxf.border?.top?.style !== undefined) undecided.top = true
		if (dxf.border?.bottom?.style !== undefined) undecided.bottom = true
		if (dxf.border?.left?.style !== undefined) undecided.left = true
		if (dxf.border?.right?.style !== undefined) undecided.right = true
		if (dxf.numFmt !== undefined && dxf.numFmt.code !== "") undecided.numFmt = true
	}

	// The look of one cell from the rules on it, in the order they apply; null when none holds. `value` is the
	// cell's; `covers[i]` (a tile's cells) says whether rules[i] covers the cell at `cell`.
	look(
		rules: readonly PreparedRule[],
		covers: readonly Uint8Array[],
		cell: number,
		value: Scalar,
		row: number,
		col: number,
		colorOf: ColorOf,
		rightToLeft: boolean
	): CfLook | null {
		let look: CfLook | null = null
		let undecided: Undecided | null = null

		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i] as PreparedRule

			if (covers[i]?.[cell] !== 1) continue
			// Nothing is known of its statistics yet: the tile is patched once they are read.
			if (STATISTIC_TYPES.has(rule.rule.type) && !this.available(rule)) continue

			const next: CfLook = look ?? {
				font: null,
				fill: null,
				top: null,
				bottom: null,
				left: null,
				right: null,
				numFmt: null,
				bar: null,
				icon: null,
				hideValue: false
			}
			let holds: boolean

			try {
				holds = this.apply(rule, value, row, col, next, undecided, colorOf, rightToLeft)
			} catch (error) {
				if (!(error instanceof Unsupported)) throw error

				// A formula not calculated here: the rule is not applied (never guessed), and what it would decide
				// is not decided below it either: whether it stops, and what it would set.
				if (rule.rule.stopIfTrue) break

				undecided ??= {
					font: new Set(),
					fill: false,
					top: false,
					bottom: false,
					left: false,
					right: false,
					numFmt: false,
					bar: false,
					icon: false
				}
				this.undecide(rule.rule, undecided)

				continue
			}

			if (holds) look = next
			if (holds && rule.rule.stopIfTrue) break
		}

		return look
	}
}

function barLook(
	bar: NonNullable<CfRule["dataBar"]>,
	value: number,
	low: number,
	high: number,
	colorOf: ColorOf,
	rightToLeft: boolean
): CfBarLook {
	const clamped = Math.max(low, Math.min(high, value))
	const negative = clamped < 0
	let start = 0
	let end: number
	let axis = Number.NaN
	const axisShown = bar.extended && bar.axisPosition !== "none" && (bar.axisPosition === "middle" || low < 0)

	if (!axisShown) {
		const fraction = high === low ? 1 : (clamped - low) / (high - low)

		end = (bar.minLength + fraction * (bar.maxLength - bar.minLength)) / 100
	} else {
		// The axis where 0 falls between the range's ends (at the middle when asked); bars run from it.
		const scale = Math.max(Math.abs(low), Math.abs(high))

		axis = bar.axisPosition === "middle" ? 0.5 : high <= 0 ? 1 : -low / (high - low)

		const span =
			bar.axisPosition === "middle"
				? scale === 0
					? 0
					: (Math.abs(clamped) / scale) * 0.5
				: clamped >= 0
					? high <= 0
						? 0
						: (clamped / high) * (1 - axis)
					: low >= 0
						? 0
						: (clamped / low) * axis

		start = negative ? axis - span : axis
		end = negative ? axis : axis + span
	}

	// Laid out left to right; the sheet's own direction is the grid's to mirror.
	const mirror = (bar.direction === "leftToRight" && rightToLeft) || (bar.direction === "rightToLeft" && !rightToLeft)

	if (mirror) {
		;[start, end] = [1 - end, 1 - start]

		if (!Number.isNaN(axis)) axis = 1 - axis
	}

	return {
		start,
		end,
		axis,
		fill: colorOf(negative ? bar.negativeFill : bar.color),
		border: bar.border === null ? -1 : colorOf(negative ? bar.negativeBorder : bar.border),
		axisColor: Number.isNaN(axis) || bar.axisColor === null ? -1 : colorOf(bar.axisColor),
		flags: bar.gradient ? CfBarFlag.GRADIENT : 0
	}
}

export type { PreparedRule }

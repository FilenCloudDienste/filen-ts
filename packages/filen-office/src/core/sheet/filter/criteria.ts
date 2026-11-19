import { wildcardMatcher, type WildcardMatcher } from "../find/match"
import type { SheetRgb } from "../protocol"
import { SortType, textSortKey } from "../sort/order"

// What one autofilter column lets through (ECMA-376 Part 1 §18.3.2), as plain data: the values checked in its list,
// up to two custom conditions, the top or bottom items, a dynamic rule (above the average, a period of dates), a cell
// or font colour, or an icon. A row shows when every filtered column lets it through.

export type SheetFilterOperator = "equal" | "notEqual" | "greaterThan" | "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual"

// §18.18.26 ST_DynamicFilterType, "null" excepted.
export type SheetDynamicFilter =
	| "aboveAverage"
	| "belowAverage"
	| "tomorrow"
	| "today"
	| "yesterday"
	| "nextWeek"
	| "thisWeek"
	| "lastWeek"
	| "nextMonth"
	| "thisMonth"
	| "lastMonth"
	| "nextQuarter"
	| "thisQuarter"
	| "lastQuarter"
	| "nextYear"
	| "thisYear"
	| "lastYear"
	| "yearToDate"
	| "Q1"
	| "Q2"
	| "Q3"
	| "Q4"
	| "M1"
	| "M2"
	| "M3"
	| "M4"
	| "M5"
	| "M6"
	| "M7"
	| "M8"
	| "M9"
	| "M10"
	| "M11"
	| "M12"

export const DYNAMIC_FILTERS: ReadonlySet<string> = new Set<SheetDynamicFilter>([
	"aboveAverage",
	"belowAverage",
	"tomorrow",
	"today",
	"yesterday",
	"nextWeek",
	"thisWeek",
	"lastWeek",
	"nextMonth",
	"thisMonth",
	"lastMonth",
	"nextQuarter",
	"thisQuarter",
	"lastQuarter",
	"nextYear",
	"thisYear",
	"lastYear",
	"yearToDate",
	"Q1",
	"Q2",
	"Q3",
	"Q4",
	"M1",
	"M2",
	"M3",
	"M4",
	"M5",
	"M6",
	"M7",
	"M8",
	"M9",
	"M10",
	"M11",
	"M12"
])

// A date (and time) a list lets through, to the grouping's precision (§18.3.2.4 dateGroupItem).
export interface SheetFilterDate {
	readonly grouping: "year" | "month" | "day" | "hour" | "minute" | "second"
	readonly year: number
	readonly month?: number
	readonly day?: number
	readonly hour?: number
	readonly minute?: number
	readonly second?: number
}

export interface SheetFilterCondition {
	readonly operator: SheetFilterOperator
	// As Excel stores it: a number in en-US form ("1.5", a date's serial), or text with * and ? wildcards (~ escapes).
	readonly value: string
}

export type SheetFilterCriteria =
	// The list's checked values (as the cells show them, any case), blank cells, and dates.
	| { readonly kind: "values"; readonly values: readonly string[]; readonly blank: boolean; readonly dates: readonly SheetFilterDate[] }
	// One or two conditions, both (and) or either.
	| { readonly kind: "custom"; readonly and: boolean; readonly conditions: readonly SheetFilterCondition[] }
	| { readonly kind: "top10"; readonly top: boolean; readonly percent: boolean; readonly value: number }
	| { readonly kind: "dynamic"; readonly type: SheetDynamicFilter }
	// The cells whose fill (cell) or font colour is `color`; null for no fill or the automatic font colour.
	| { readonly kind: "color"; readonly cell: boolean; readonly color: SheetRgb | null }
	// Cells conditional formatting gives an icon (shown, never evaluated here).
	| { readonly kind: "icon"; readonly iconSet: string; readonly iconId: number }

// The most conditions a custom filter holds, the longest condition text (Excel's custom AutoFilter dialog), and the
// most values a list writes.
export const MAX_FILTER_CONDITIONS = 2
export const MAX_FILTER_TEXT = 255
export const MAX_FILTER_VALUES = 10_000

// One cell as a filter reads it: its type, its number (a date's serial, a boolean as 0 or 1) and what it shows.
export interface FilterCell {
	readonly type: SortType
	readonly number: number
	readonly text: string
	// The number is a date (its format is a date format).
	readonly date: boolean
}

// What a whole column's rule needs before rows are judged: the top or bottom threshold, the average, a period.
export interface FilterColumnContext {
	// top10: items at or past it pass; NaN when the column has no numbers.
	readonly threshold: number
	// aboveAverage, belowAverage.
	readonly average: number
	// A date period: serials from `from` (inclusive) to `to` (exclusive).
	readonly from: number
	readonly to: number
}

const NO_CONTEXT: FilterColumnContext = { threshold: Number.NaN, average: Number.NaN, from: Number.NaN, to: Number.NaN }

// --- Numbers ---

// A condition's value as a number when it is one in en-US form (Excel stores numbers and date serials so).
export function filterNumber(text: string): number {
	const trimmed = text.trim()

	if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) return Number.NaN

	return Number(trimmed)
}

// --- Conditions ---

interface CompiledCondition {
	readonly operator: SheetFilterOperator
	readonly number: number
	readonly pattern: WildcardMatcher
	readonly key: string
	// Excel writes "Non blanks" as notEqual " ", and "Blanks" as equal "".
	readonly blankTest: "blank" | "nonBlank" | null
}

function compileCondition(condition: SheetFilterCondition): CompiledCondition {
	const blankTest =
		condition.operator === "equal" && condition.value === ""
			? "blank"
			: condition.operator === "notEqual" && (condition.value === " " || condition.value === "")
				? "nonBlank"
				: null

	return {
		operator: condition.operator,
		number: condition.value.includes("*") || condition.value.includes("?") ? Number.NaN : filterNumber(condition.value),
		pattern: wildcardMatcher(condition.value, false, false),
		key: textSortKey(condition.value, false),
		blankTest
	}
}

function ordered(operator: SheetFilterOperator, order: number): boolean {
	switch (operator) {
		case "greaterThan":
			return order > 0
		case "greaterThanOrEqual":
			return order >= 0
		case "lessThan":
			return order < 0
		case "lessThanOrEqual":
			return order <= 0
		case "equal":
			return order === 0
		case "notEqual":
			return order !== 0
	}
}

function meets(condition: CompiledCondition, cell: FilterCell): boolean {
	if (condition.blankTest !== null) return (cell.type === SortType.BLANK) === (condition.blankTest === "blank")
	if (cell.type === SortType.BLANK) return condition.operator === "notEqual"

	const equality = condition.operator === "equal" || condition.operator === "notEqual"

	if (cell.type === SortType.NUMBER && !Number.isNaN(condition.number)) {
		return ordered(condition.operator, cell.number < condition.number ? -1 : cell.number > condition.number ? 1 : 0)
	}

	if (equality) {
		const match = condition.pattern.test(cell.text, true)

		return condition.operator === "equal" ? match : !match
	}

	// Ordered text against text, in sort order; a number against text (or text against a number) never.
	if (cell.type !== SortType.TEXT || !Number.isNaN(condition.number)) return false

	const key = textSortKey(cell.text, false)

	return ordered(condition.operator, key < condition.key ? -1 : key > condition.key ? 1 : 0)
}

// --- Dates ---

// The calendar parts of a serial (the 1900 system's leap-year bug kept: 60 is 1900-02-29), or null.
export interface CalendarParts {
	readonly year: number
	readonly month: number
	readonly day: number
	readonly hour: number
	readonly minute: number
	readonly second: number
}

function dateMatches(item: SheetFilterDate, parts: CalendarParts): boolean {
	if (parts.year !== item.year) return false
	if (item.grouping === "year") return true
	if (parts.month !== item.month) return false
	if (item.grouping === "month") return true
	if (parts.day !== item.day) return false
	if (item.grouping === "day") return true
	if (parts.hour !== item.hour) return false
	if (item.grouping === "hour") return true
	if (parts.minute !== item.minute) return false
	if (item.grouping === "minute") return true

	return parts.second === item.second
}

// --- Columns ---

// A column's criteria, ready to judge its cells: `context` holds what the whole column decides (filterContext).
export class FilterTest {
	private readonly criteria: SheetFilterCriteria
	private readonly context: FilterColumnContext
	private readonly values: ReadonlySet<string>
	private readonly conditions: readonly CompiledCondition[]
	private readonly calendar: (serial: number) => CalendarParts | null

	constructor(criteria: SheetFilterCriteria, context: FilterColumnContext, calendar: (serial: number) => CalendarParts | null) {
		this.criteria = criteria
		this.context = context
		this.calendar = calendar
		this.values = new Set(criteria.kind === "values" ? criteria.values.map(value => value.toLowerCase()) : [])
		this.conditions = criteria.kind === "custom" ? criteria.conditions.map(compileCondition) : []
	}

	// Whether the cell passes. `colorOf` reads the cell's fill (cell true) or font colour, for a colour filter.
	passes(cell: FilterCell, colorOf?: (cell: boolean) => SheetRgb | null): boolean {
		const criteria = this.criteria

		switch (criteria.kind) {
			case "values": {
				if (cell.type === SortType.BLANK) return criteria.blank
				if (this.values.has(cell.text.toLowerCase())) return true
				if (criteria.dates.length === 0 || !cell.date || cell.type !== SortType.NUMBER) return false

				const parts = this.calendar(cell.number)

				return parts !== null && criteria.dates.some(item => dateMatches(item, parts))
			}
			case "custom": {
				if (this.conditions.length === 0) return true

				return criteria.and
					? this.conditions.every(condition => meets(condition, cell))
					: this.conditions.some(condition => meets(condition, cell))
			}
			case "top10":
				if (cell.type !== SortType.NUMBER || Number.isNaN(this.context.threshold)) return false

				return criteria.top ? cell.number >= this.context.threshold : cell.number <= this.context.threshold
			case "dynamic":
				if (cell.type !== SortType.NUMBER) return false

				if (criteria.type === "aboveAverage") return cell.number > this.context.average
				if (criteria.type === "belowAverage") return cell.number < this.context.average

				if (criteria.type.startsWith("Q") || /^M\d/.test(criteria.type)) {
					const parts = this.calendar(cell.number)

					if (parts === null) return false

					return criteria.type.startsWith("Q")
						? Math.floor((parts.month - 1) / 3) + 1 === Number(criteria.type.slice(1))
						: parts.month === Number(criteria.type.slice(1))
				}

				return cell.number >= this.context.from && cell.number < this.context.to
			case "color":
				return colorOf !== undefined && colorOf(criteria.cell) === criteria.color
			case "icon":
				return false
		}
	}
}

// What a column's rule needs from the whole column: `numbers` are its numeric cells (data rows of the range).
// `today` is today's serial (whole days) in the workbook's date system, for the date periods.
export function filterContext(
	criteria: SheetFilterCriteria,
	numbers: ArrayLike<number>,
	today: number,
	date1904: boolean
): FilterColumnContext {
	if (criteria.kind === "top10") {
		const count = numbers.length

		if (count === 0) return NO_CONTEXT

		const sorted = Float64Array.from(numbers).sort()
		// Items, or a percentage of them (at least one), with ties to the threshold included.
		const wanted = Math.max(1, Math.min(count, Math.floor(criteria.percent ? (count * criteria.value) / 100 : criteria.value)))
		const threshold = criteria.top ? (sorted[count - wanted] ?? Number.NaN) : (sorted[wanted - 1] ?? Number.NaN)

		return { ...NO_CONTEXT, threshold }
	}

	if (criteria.kind === "dynamic") {
		if (criteria.type === "aboveAverage" || criteria.type === "belowAverage") {
			let sum = 0

			for (let i = 0; i < numbers.length; i++) sum += numbers[i] ?? 0

			return { ...NO_CONTEXT, average: numbers.length === 0 ? Number.NaN : sum / numbers.length }
		}

		const offset = date1904 ? DATE_1904_OFFSET : 0
		const period = datePeriod(criteria.type, today + offset)

		return period === null ? NO_CONTEXT : { ...NO_CONTEXT, from: period[0] - offset, to: period[1] - offset }
	}

	return NO_CONTEXT
}

// A relative period's serials, [from, to), around `today` (a whole serial in the 1900 system without its leap-year
// bug past 1900-03-01, which is every date a period reaches in practice). Weeks start on Sunday, as Excel's do.
export function datePeriod(type: SheetDynamicFilter, today: number): [number, number] | null {
	const date = serialToDate(today)
	const year = date.getUTCFullYear()
	const month = date.getUTCMonth()
	const weekday = date.getUTCDay()
	const quarter = Math.floor(month / 3)
	const monthStart = (y: number, m: number): number => dateToSerial(Date.UTC(y, m, 1))

	switch (type) {
		case "today":
			return [today, today + 1]
		case "yesterday":
			return [today - 1, today]
		case "tomorrow":
			return [today + 1, today + 2]
		case "thisWeek":
			return [today - weekday, today - weekday + 7]
		case "lastWeek":
			return [today - weekday - 7, today - weekday]
		case "nextWeek":
			return [today - weekday + 7, today - weekday + 14]
		case "thisMonth":
			return [monthStart(year, month), monthStart(year, month + 1)]
		case "lastMonth":
			return [monthStart(year, month - 1), monthStart(year, month)]
		case "nextMonth":
			return [monthStart(year, month + 1), monthStart(year, month + 2)]
		case "thisQuarter":
			return [monthStart(year, quarter * 3), monthStart(year, quarter * 3 + 3)]
		case "lastQuarter":
			return [monthStart(year, quarter * 3 - 3), monthStart(year, quarter * 3)]
		case "nextQuarter":
			return [monthStart(year, quarter * 3 + 3), monthStart(year, quarter * 3 + 6)]
		case "thisYear":
			return [monthStart(year, 0), monthStart(year + 1, 0)]
		case "lastYear":
			return [monthStart(year - 1, 0), monthStart(year, 0)]
		case "nextYear":
			return [monthStart(year + 1, 0), monthStart(year + 2, 0)]
		case "yearToDate":
			return [monthStart(year, 0), today + 1]
		default:
			return null
	}
}

// Days from the 1900 system's serials to the 1904 system's.
export const DATE_1904_OFFSET = 1462
// Serial day 25569 is 1970-01-01 in the 1900 system.
const UNIX_SERIAL = 25_569
const DAY_MS = 86_400_000

function serialToDate(serial: number): Date {
	return new Date((serial - UNIX_SERIAL) * DAY_MS)
}

function dateToSerial(ms: number): number {
	return Math.round(ms / DAY_MS) + UNIX_SERIAL
}

// Today's serial from a clock reading (its local calendar date), in the workbook's date system.
export function todaySerial(now: number, date1904: boolean): number {
	const local = new Date(now)

	return dateToSerial(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate())) - (date1904 ? DATE_1904_OFFSET : 0)
}

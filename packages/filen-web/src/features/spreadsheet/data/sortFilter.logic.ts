import {
	CellFlag,
	dateSerial,
	EN_US_LOCALE,
	FilterButton,
	filterNumber,
	localizedInput,
	localizedNumber,
	MAX_SERIAL_1900,
	MAX_SERIAL_1904,
	serialDate,
	type DateParts,
	type SheetDynamicFilter,
	type SheetFilterCondition,
	type SheetFilterCriteria,
	type SheetFilterDate,
	type SheetFilterItem,
	type SheetFilterOperator,
	type SheetFilterRange,
	type SheetLayout,
	type SheetLocale,
	type SheetRange
} from "@filen/office/core/sheet"
import type { PreviewKey } from "@/lib/i18n"

// What the sort and filter menus decide before they send a command: the range a quick sort orders and whether its
// first row is a header (as Excel guesses it), the criteria a values list or a condition dialog makes, and which
// conditions a column's menu offers.

// --- Sorting ---

export interface SortTarget {
	readonly range: SheetRange
	readonly header: boolean
	// A filter's or table's range: its header row is always a header.
	readonly filtered: boolean
}

// What a cell is to the header guess: empty, text, or another value (a number, a date, a logical value, an error).
export type HeaderCell = "empty" | "text" | "value"

// Excel's guess at "My data has headers" ("Sort data in a range or table": the first row is left out when it is
// formatted or typed differently from the data below): a first row of text over a column whose next row holds a
// value, or whose look differs from the row below it. `cell` reads a cell's kind and look (its render style).
export function guessHeader(
	range: SheetRange,
	cell: (row: number, col: number) => { readonly kind: HeaderCell; readonly style: number }
): boolean {
	if (range.endRow <= range.startRow) return false

	let texts = 0
	let differs = false

	for (let col = range.startCol; col <= Math.min(range.endCol, range.startCol + 255); col++) {
		const top = cell(range.startRow, col)
		const next = cell(range.startRow + 1, col)

		if (top.kind === "value") return false
		if (top.kind !== "text") continue

		texts++

		if (next.kind === "value" || (next.kind !== "empty" && next.style !== top.style)) differs = true
	}

	return texts > 0 && differs
}

// A tile entry's flags as the header guess reads them.
export function headerCellKind(flags: number, text: string): HeaderCell {
	if (text === "" && (flags & (CellFlag.NUMBER | CellFlag.BOOLEAN | CellFlag.ERROR)) === 0) return "empty"

	return (flags & (CellFlag.NUMBER | CellFlag.BOOLEAN | CellFlag.ERROR)) !== 0 ? "value" : "text"
}

// The filter range a cell is in (header or data rows).
export function filterAt(layout: SheetLayout | null, row: number, col: number): SheetFilterRange | null {
	for (const range of layout?.extensions?.filters?.ranges ?? []) {
		const { startRow, endRow, startCol, endCol } = range.range

		if (row >= startRow && row <= endRow && col >= startCol && col <= endCol) return range
	}

	return null
}

// The filter Clear and Reapply act on: the one at the cell, else the sheet's own; its header's first cell.
export function clearTarget(layout: SheetLayout | null, row: number, col: number): { row: number; col: number } | null {
	const at = filterAt(layout, row, col) ?? layout?.extensions?.filters?.ranges.find(range => range.table === null) ?? null

	return at === null ? null : { row: at.range.startRow, col: at.range.startCol }
}

// --- The values list ---

// The criteria a values list makes, or null for none (every value and the blanks checked: the filter goes). Dates
// are named by the largest group checked whole (a year, a month, else the day), as Excel names them when it groups
// dates.
export function listCriteria(
	items: readonly SheetFilterItem[],
	checked: ReadonlySet<number>,
	blank: { readonly present: boolean; readonly checked: boolean }
): SheetFilterCriteria | null {
	if (checked.size === items.length && (!blank.present || blank.checked)) return null

	const values: string[] = []
	const years = new Map<number, { total: number; checked: number; months: Map<number, { total: number; days: number[] }> }>()

	items.forEach((item, index) => {
		const date = item.date

		if (date === undefined) {
			if (checked.has(index)) values.push(item.text)

			return
		}

		let year = years.get(date.year)

		if (year === undefined) {
			year = { total: 0, checked: 0, months: new Map() }
			years.set(date.year, year)
		}

		let month = year.months.get(date.month)

		if (month === undefined) {
			month = { total: 0, days: [] }
			year.months.set(date.month, month)
		}

		year.total++
		month.total++

		if (checked.has(index)) {
			year.checked++
			month.days.push(date.day)
		}
	})

	const dates: SheetFilterDate[] = []

	for (const [year, group] of years) {
		if (group.checked === 0) continue

		if (group.checked === group.total) {
			dates.push({ grouping: "year", year })

			continue
		}

		for (const [month, days] of group.months) {
			if (days.days.length === days.total) dates.push({ grouping: "month", year, month })
			else for (const day of days.days) dates.push({ grouping: "day", year, month, day })
		}
	}

	return { kind: "values", values, blank: blank.present && blank.checked, dates }
}

// One row of the values list: (Select all), a year or a month of the dates tree (with the items under it), an item,
// or (Blanks). Depth is the indent: a year 0, its months 1, their days 2; other values 0.
export type FilterRow =
	| { readonly kind: "all" }
	| { readonly kind: "blank" }
	| {
			readonly kind: "group"
			readonly key: string
			readonly depth: 0 | 1
			readonly year: number
			readonly month?: number
			readonly leaves: readonly number[]
			readonly expanded: boolean
	  }
	| { readonly kind: "item"; readonly index: number; readonly depth: 0 | 2 }

// The list's rows for the items a search shows (`shown`, in sort order): dates as a tree of years and months (open
// where `expanded` names them, or all of them while searching), then the other values, then the blanks. Linear in
// the items shown.
export function filterRows(
	items: readonly SheetFilterItem[],
	shown: readonly number[],
	expanded: ReadonlySet<string>,
	blank: boolean,
	searching: boolean
): FilterRow[] {
	const years = new Map<number, Map<number, number[]>>()
	const others: number[] = []

	for (const index of shown) {
		const date = items[index]?.date

		if (date === undefined) {
			others.push(index)

			continue
		}

		let months = years.get(date.year)

		if (months === undefined) {
			months = new Map()
			years.set(date.year, months)
		}

		const days = months.get(date.month)

		if (days === undefined) months.set(date.month, [index])
		else days.push(index)
	}

	const rows: FilterRow[] = [{ kind: "all" }]

	for (const [year, months] of years) {
		const key = String(year)
		const open = searching || expanded.has(key)
		const leaves: number[] = []

		for (const days of months.values()) leaves.push(...days)

		rows.push({ kind: "group", key, depth: 0, year, leaves, expanded: open })

		if (!open) continue

		for (const [month, days] of months) {
			const monthKey = `${key}-${String(month)}`
			const monthOpen = searching || expanded.has(monthKey)

			rows.push({ kind: "group", key: monthKey, depth: 1, year, month, leaves: days, expanded: monthOpen })

			if (monthOpen) for (const index of days) rows.push({ kind: "item", index, depth: 2 })
		}
	}

	for (const index of others) rows.push({ kind: "item", index, depth: 0 })

	if (blank) rows.push({ kind: "blank" })

	return rows
}

// A group's check: all, some or none of its items checked.
export function groupState(leaves: readonly number[], checked: ReadonlySet<number>): "all" | "some" | "none" {
	let count = 0

	for (const index of leaves) if (checked.has(index)) count++

	return count === 0 ? "none" : count === leaves.length ? "all" : "some"
}

// Which items a search shows: their text holds it, any case.
export function searchItems(items: readonly SheetFilterItem[], search: string): number[] {
	const needle = search.trim().toLowerCase()
	const out: number[] = []

	items.forEach((item, index) => {
		if (needle === "" || item.text.toLowerCase().includes(needle)) out.push(index)
	})

	return out
}

// --- Conditions ---

export type FilterKind = "text" | "number" | "date"

// What a condition dialog's operator means: a stored operator and how the value is wrapped in wildcards.
export type DialogOperator =
	| "equals"
	| "notEquals"
	| "greater"
	| "greaterOrEqual"
	| "less"
	| "lessOrEqual"
	| "beginsWith"
	| "notBeginsWith"
	| "endsWith"
	| "notEndsWith"
	| "contains"
	| "notContains"

const STORED: Readonly<
	Record<DialogOperator, { readonly operator: SheetFilterOperator; readonly before: string; readonly after: string }>
> = {
	equals: { operator: "equal", before: "", after: "" },
	notEquals: { operator: "notEqual", before: "", after: "" },
	greater: { operator: "greaterThan", before: "", after: "" },
	greaterOrEqual: { operator: "greaterThanOrEqual", before: "", after: "" },
	less: { operator: "lessThan", before: "", after: "" },
	lessOrEqual: { operator: "lessThanOrEqual", before: "", after: "" },
	beginsWith: { operator: "equal", before: "", after: "*" },
	notBeginsWith: { operator: "notEqual", before: "", after: "*" },
	endsWith: { operator: "equal", before: "*", after: "" },
	notEndsWith: { operator: "notEqual", before: "*", after: "" },
	contains: { operator: "equal", before: "*", after: "*" },
	notContains: { operator: "notEqual", before: "*", after: "*" }
}

export const TEXT_OPERATORS: readonly DialogOperator[] = [
	"equals",
	"notEquals",
	"greater",
	"greaterOrEqual",
	"less",
	"lessOrEqual",
	"beginsWith",
	"notBeginsWith",
	"endsWith",
	"notEndsWith",
	"contains",
	"notContains"
]
export const NUMBER_OPERATORS: readonly DialogOperator[] = ["equals", "notEquals", "greater", "greaterOrEqual", "less", "lessOrEqual"]

export function operatorKey(operator: DialogOperator, kind: FilterKind): PreviewKey {
	if (kind === "date") {
		switch (operator) {
			case "greater":
				return "previewSheetFilterOpAfter"
			case "greaterOrEqual":
				return "previewSheetFilterOpOnOrAfter"
			case "less":
				return "previewSheetFilterOpBefore"
			case "lessOrEqual":
				return "previewSheetFilterOpOnOrBefore"
			default:
				break
		}
	}

	const keys: Readonly<Record<DialogOperator, PreviewKey>> = {
		equals: "previewSheetFilterOpEquals",
		notEquals: "previewSheetFilterOpNotEquals",
		greater: "previewSheetFilterOpGreater",
		greaterOrEqual: "previewSheetFilterOpGreaterOrEqual",
		less: "previewSheetFilterOpLess",
		lessOrEqual: "previewSheetFilterOpLessOrEqual",
		beginsWith: "previewSheetFilterOpBeginsWith",
		notBeginsWith: "previewSheetFilterOpNotBeginsWith",
		endsWith: "previewSheetFilterOpEndsWith",
		notEndsWith: "previewSheetFilterOpNotEndsWith",
		contains: "previewSheetFilterOpContains",
		notContains: "previewSheetFilterOpNotContains"
	}

	return keys[operator]
}

// A date field's ISO date as a serial in the workbook's date system (the engine's, the 1900 system counting the
// 1900-02-29 it does not have); NaN when it is no date.
export function isoSerial(iso: string, date1904: boolean): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)

	return match === null ? Number.NaN : dateSerial(Number(match[1]), Number(match[2]), Number(match[3]), date1904)
}

const SERIAL_DATE: DateParts = { year: 0, month: 0, day: 0, weekday: 0 }

// A serial as an ISO date (for a date field); "" for one outside the date system (a stored value as large as 1e300 has
// no date, and a far year is no four-digit one a date field takes) and for the 1900 system's 60 (1900-02-29, a day a
// date field does not take). That system's 0 (shown as 1900-01-00) is 1899-12-31, the date isoSerial reads as 0.
export function serialIso(serial: number, date1904: boolean): string {
	if (!(serial >= 0 && serial <= (date1904 ? MAX_SERIAL_1904 : MAX_SERIAL_1900))) return ""

	const { year, month, day } = serialDate(Math.floor(serial), date1904, SERIAL_DATE)

	if (day === 0) return "1899-12-31"
	if (year === 1900 && month === 2 && day === 29) return ""

	return `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

// A number as typed in the user's locale (its grouping, decimal point and percent; en-US's form when the locale's does
// not read it), in the en-US form a filter stores; "" when it does not read as one.
export function storedNumber(text: string, locale: SheetLocale): string {
	const trimmed = text.trim()
	const read = localizedNumber(trimmed, locale) ?? localizedNumber(trimmed, EN_US_LOCALE)

	return read === null || !Number.isFinite(read.value) ? "" : String(read.value)
}

export interface DialogCondition {
	readonly operator: DialogOperator
	readonly value: string
}

// A condition as stored, or null when its value does not read for the column's kind (a number, a date).
export function storedCondition(
	condition: DialogCondition,
	kind: FilterKind,
	date1904: boolean,
	locale: SheetLocale
): SheetFilterCondition | null {
	const stored = STORED[condition.operator]

	if (kind === "number") {
		const value = storedNumber(condition.value, locale)

		return value === "" ? null : { operator: stored.operator, value }
	}

	if (kind === "date") {
		const serial = isoSerial(condition.value, date1904)

		return Number.isNaN(serial) ? null : { operator: stored.operator, value: String(serial) }
	}

	return { operator: stored.operator, value: `${stored.before}${condition.value}${stored.after}` }
}

// The criteria of a condition dialog: one or two conditions, both or either. Equality on a date is its day (a values
// list naming it), as Excel writes it.
export function dialogCriteria(
	conditions: readonly DialogCondition[],
	and: boolean,
	kind: FilterKind,
	date1904: boolean,
	locale: SheetLocale
): SheetFilterCriteria | null {
	if (kind === "date" && conditions.length === 1 && conditions[0]?.operator === "equals") {
		const serial = isoSerial(conditions[0].value, date1904)

		if (Number.isNaN(serial)) return null

		const [year, month, day] = conditions[0].value.split("-").map(Number)

		return { kind: "values", values: [], blank: false, dates: [{ grouping: "day", year: year ?? 0, month: month ?? 1, day: day ?? 1 }] }
	}

	const stored: SheetFilterCondition[] = []

	for (const condition of conditions) {
		const value = storedCondition(condition, kind, date1904, locale)

		if (value === null) return null

		stored.push(value)
	}

	return stored.length === 0 ? null : { kind: "custom", and: stored.length > 1 && and, conditions: stored }
}

// The dialog's conditions read back from stored criteria (a custom filter it can show; numbers as the locale types
// them), or null.
export function dialogConditions(
	criteria: SheetFilterCriteria | null,
	kind: FilterKind,
	date1904: boolean,
	locale: SheetLocale
): { conditions: DialogCondition[]; and: boolean } | null {
	if (criteria?.kind !== "custom") return null

	const conditions: DialogCondition[] = []

	for (const condition of criteria.conditions) {
		const value = condition.value
		const starts = value.startsWith("*")
		const ends = value.endsWith("*") && !value.endsWith("~*")
		const equal = condition.operator === "equal"
		const notEqual = condition.operator === "notEqual"
		let operator: DialogOperator
		let text = value

		if ((equal || notEqual) && kind === "text" && (starts || ends) && value.length > 1) {
			operator =
				starts && ends
					? equal
						? "contains"
						: "notContains"
					: starts
						? equal
							? "endsWith"
							: "notEndsWith"
						: equal
							? "beginsWith"
							: "notBeginsWith"
			text = value.slice(starts ? 1 : 0, ends ? -1 : undefined)
		} else {
			const found = (Object.keys(STORED) as DialogOperator[]).find(
				name => STORED[name].operator === condition.operator && STORED[name].before === "" && STORED[name].after === ""
			)

			operator = found ?? "equals"
		}

		if (kind === "date") {
			const serial = filterNumber(value)

			text = serialIso(serial, date1904)
		} else if (kind === "number") text = localizedInput(value, locale)

		conditions.push({ operator, value: text })
	}

	return { conditions, and: criteria.and }
}

export interface ConditionItem {
	readonly key: PreviewKey
	// Opens the condition dialog with this operator (and a second for "between"), applies at once, or opens Top 10.
	readonly action:
		| { readonly type: "dialog"; readonly first: DialogOperator; readonly second?: DialogOperator }
		| { readonly type: "dynamic"; readonly filter: SheetDynamicFilter }
		| { readonly type: "top10" }
}

export const TEXT_CONDITIONS: readonly ConditionItem[] = [
	{ key: "previewSheetFilterEquals", action: { type: "dialog", first: "equals" } },
	{ key: "previewSheetFilterNotEquals", action: { type: "dialog", first: "notEquals" } },
	{ key: "previewSheetFilterBeginsWith", action: { type: "dialog", first: "beginsWith" } },
	{ key: "previewSheetFilterEndsWith", action: { type: "dialog", first: "endsWith" } },
	{ key: "previewSheetFilterContains", action: { type: "dialog", first: "contains" } },
	{ key: "previewSheetFilterNotContains", action: { type: "dialog", first: "notContains" } }
]

export const NUMBER_CONDITIONS: readonly ConditionItem[] = [
	{ key: "previewSheetFilterEquals", action: { type: "dialog", first: "equals" } },
	{ key: "previewSheetFilterNotEquals", action: { type: "dialog", first: "notEquals" } },
	{ key: "previewSheetFilterGreater", action: { type: "dialog", first: "greater" } },
	{ key: "previewSheetFilterGreaterOrEqual", action: { type: "dialog", first: "greaterOrEqual" } },
	{ key: "previewSheetFilterLess", action: { type: "dialog", first: "less" } },
	{ key: "previewSheetFilterLessOrEqual", action: { type: "dialog", first: "lessOrEqual" } },
	{ key: "previewSheetFilterBetween", action: { type: "dialog", first: "greaterOrEqual", second: "lessOrEqual" } },
	{ key: "previewSheetFilterTop10", action: { type: "top10" } },
	{ key: "previewSheetFilterAboveAverage", action: { type: "dynamic", filter: "aboveAverage" } },
	{ key: "previewSheetFilterBelowAverage", action: { type: "dynamic", filter: "belowAverage" } }
]

export const DATE_CONDITIONS: readonly ConditionItem[] = [
	{ key: "previewSheetFilterEquals", action: { type: "dialog", first: "equals" } },
	{ key: "previewSheetFilterBefore", action: { type: "dialog", first: "less" } },
	{ key: "previewSheetFilterAfter", action: { type: "dialog", first: "greater" } },
	{ key: "previewSheetFilterBetween", action: { type: "dialog", first: "greaterOrEqual", second: "lessOrEqual" } },
	{ key: "previewSheetFilterTomorrow", action: { type: "dynamic", filter: "tomorrow" } },
	{ key: "previewSheetFilterToday", action: { type: "dynamic", filter: "today" } },
	{ key: "previewSheetFilterYesterday", action: { type: "dynamic", filter: "yesterday" } },
	{ key: "previewSheetFilterNextWeek", action: { type: "dynamic", filter: "nextWeek" } },
	{ key: "previewSheetFilterThisWeek", action: { type: "dynamic", filter: "thisWeek" } },
	{ key: "previewSheetFilterLastWeek", action: { type: "dynamic", filter: "lastWeek" } },
	{ key: "previewSheetFilterNextMonth", action: { type: "dynamic", filter: "nextMonth" } },
	{ key: "previewSheetFilterThisMonth", action: { type: "dynamic", filter: "thisMonth" } },
	{ key: "previewSheetFilterLastMonth", action: { type: "dynamic", filter: "lastMonth" } },
	{ key: "previewSheetFilterNextQuarter", action: { type: "dynamic", filter: "nextQuarter" } },
	{ key: "previewSheetFilterThisQuarter", action: { type: "dynamic", filter: "thisQuarter" } },
	{ key: "previewSheetFilterLastQuarter", action: { type: "dynamic", filter: "lastQuarter" } },
	{ key: "previewSheetFilterNextYear", action: { type: "dynamic", filter: "nextYear" } },
	{ key: "previewSheetFilterThisYear", action: { type: "dynamic", filter: "thisYear" } },
	{ key: "previewSheetFilterLastYear", action: { type: "dynamic", filter: "lastYear" } },
	{ key: "previewSheetFilterYearToDate", action: { type: "dynamic", filter: "yearToDate" } }
]

// "All dates in the period": the quarters, then the months, of any year.
export const PERIODS: readonly SheetDynamicFilter[] = [
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
]

export function conditionsFor(kind: FilterKind): readonly ConditionItem[] {
	return kind === "number" ? NUMBER_CONDITIONS : kind === "date" ? DATE_CONDITIONS : TEXT_CONDITIONS
}

export function conditionsKey(kind: FilterKind): PreviewKey {
	return kind === "number" ? "previewSheetFilterNumber" : kind === "date" ? "previewSheetFilterDate" : "previewSheetFilterText"
}

// The sort commands' labels for a column's kind.
export function sortKeys(kind: FilterKind): { readonly ascending: PreviewKey; readonly descending: PreviewKey } {
	return kind === "number"
		? { ascending: "previewSheetSortSmallest", descending: "previewSheetSortLargest" }
		: kind === "date"
			? { ascending: "previewSheetSortOldest", descending: "previewSheetSortNewest" }
			: { ascending: "previewSheetSortAscending", descending: "previewSheetSortDescending" }
}

// Whether a header's button says its column is filtered.
export function isFiltered(range: SheetFilterRange, col: number): boolean {
	return ((range.buttons[col - range.range.startCol] ?? 0) & FilterButton.FILTERED) !== 0
}

// The criteria "Filter by selected cell's value" makes: the cell's text as shown, or its blank.
export function valueCriteria(text: string): SheetFilterCriteria {
	return text === ""
		? { kind: "values", values: [], blank: true, dates: [] }
		: { kind: "values", values: [text], blank: false, dates: [] }
}

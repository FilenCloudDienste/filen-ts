import { XmlEditor, decodeUtf8, encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../xml/index"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetRange } from "../protocol"
import { columnIndex, rangeName } from "../refs/cellRef"
import {
	DYNAMIC_FILTERS,
	MAX_FILTER_CONDITIONS,
	type SheetDynamicFilter,
	type SheetFilterCondition,
	type SheetFilterCriteria,
	type SheetFilterDate,
	type SheetFilterOperator
} from "./criteria"

// An autofilter element (ECMA-376 Part 1 §18.3.1.2 autoFilter; the sheet's, or a table's) read and written back:
// its range, its filter columns (§18.3.2.7) and its sort state (§18.3.1.92). Written by a splice of the element as
// it was: columns and the sort state left alone keep their markup, unknown attributes and children (extLst) stay.

export interface AutoFilterColumn {
	// Offset from the range's first column (colId).
	readonly colId: number
	// null: no criteria (a column with button settings only), or criteria this reader does not know (`unknown`).
	readonly criteria: SheetFilterCriteria | null
	// Criteria of a kind not read here (a newer child, an extension): kept, and no filter is worked out with them.
	readonly unknown: boolean
	readonly hiddenButton: boolean
	readonly showButton: boolean
	// The element as written, null for a new one.
	readonly markup: string | null
	// A colour filter's dxf as written (its colour is the caller's to resolve).
	readonly dxfId?: number
}

export interface AutoFilterSortCondition {
	readonly ref: SheetRange
	readonly descending: boolean
	// sortBy other than "value" (a cell colour, a font colour, an icon), or a custom list: kept, not applied here.
	readonly byValue: boolean
}

export interface AutoFilterSort {
	readonly ref: SheetRange
	readonly caseSensitive: boolean
	// Sorted left to right.
	readonly columnSort: boolean
	readonly conditions: readonly AutoFilterSortCondition[]
	readonly markup: string | null
}

export interface AutoFilter {
	readonly ref: SheetRange
	readonly columns: readonly AutoFilterColumn[]
	readonly sort: AutoFilterSort | null
	// The element as written ("" for a new one), and its namespace prefix ("" for none).
	readonly markup: string
	readonly prefix: string
}

// What a range reference reads as (A1:C10, or one cell), or null.
export function parseA1Range(text: string): SheetRange | null {
	const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/.exec(text.trim())

	if (match === null) return null

	const startCol = columnIndex(match[1] as string)
	const startRow = Number(match[2]) - 1
	const endCol = match[3] === undefined ? startCol : columnIndex(match[3])
	const endRow = match[4] === undefined ? startRow : Number(match[4]) - 1

	if (startRow < 0 || endRow < 0 || startCol >= SHEET_MAX_COLS || endCol >= SHEET_MAX_COLS || endRow >= SHEET_MAX_ROWS) return null

	return {
		startRow: Math.min(startRow, endRow),
		startCol: Math.min(startCol, endCol),
		endRow: Math.max(startRow, endRow),
		endCol: Math.max(startCol, endCol)
	}
}

function bool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback

	return value === "1" || value === "true"
}

function children(document: XmlDocument, node: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) out.push(child)

	return out
}

const OPERATORS: ReadonlySet<string> = new Set(["equal", "notEqual", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"])
const GROUPINGS: ReadonlySet<string> = new Set(["year", "month", "day", "hour", "minute", "second"])

function readDate(document: XmlDocument, node: number): SheetFilterDate | null {
	const grouping = document.attribute(node, "dateTimeGrouping")
	const year = Number(document.attribute(node, "year"))

	if (grouping === undefined || !GROUPINGS.has(grouping) || !Number.isInteger(year)) return null

	const part = (name: string): number | undefined => {
		const value = document.attribute(node, name)

		return value === undefined ? undefined : Number(value)
	}
	const date: {
		grouping: SheetFilterDate["grouping"]
		year: number
		month?: number
		day?: number
		hour?: number
		minute?: number
		second?: number
	} = { grouping: grouping as SheetFilterDate["grouping"], year }

	for (const name of ["month", "day", "hour", "minute", "second"] as const) {
		const value = part(name)

		if (value !== undefined) date[name] = value
	}

	return date
}

// One filterColumn's criteria, or "unknown".
function readCriteria(document: XmlDocument, node: number): { criteria: SheetFilterCriteria | null; dxfId?: number } | "unknown" {
	let found: { criteria: SheetFilterCriteria | null; dxfId?: number } | null = null

	for (const child of children(document, node)) {
		const local = document.localName(child)

		if (local === "extLst") continue
		if (found !== null) return "unknown"

		switch (local) {
			case "filters": {
				const values: string[] = []
				const dates: SheetFilterDate[] = []

				for (const item of children(document, child)) {
					const name = document.localName(item)

					if (name === "filter") values.push(document.attribute(item, "val") ?? "")
					else if (name === "dateGroupItem") {
						const date = readDate(document, item)

						if (date === null) return "unknown"

						dates.push(date)
					} else return "unknown"
				}

				// A calendar other than the Gregorian one names its dates in that calendar.
				const calendar = document.attribute(child, "calendarType")

				if (dates.length > 0 && calendar !== undefined && calendar !== "none" && calendar !== "gregorian") return "unknown"

				found = { criteria: { kind: "values", values, blank: bool(document.attribute(child, "blank"), false), dates } }
				break
			}
			case "customFilters": {
				const conditions: SheetFilterCondition[] = []

				for (const item of children(document, child)) {
					if (document.localName(item) !== "customFilter") return "unknown"

					const operator = document.attribute(item, "operator") ?? "equal"

					if (!OPERATORS.has(operator)) return "unknown"

					conditions.push({ operator: operator as SheetFilterOperator, value: document.attribute(item, "val") ?? "" })
				}

				if (conditions.length === 0 || conditions.length > MAX_FILTER_CONDITIONS) return "unknown"

				found = { criteria: { kind: "custom", and: bool(document.attribute(child, "and"), false), conditions } }
				break
			}
			case "top10": {
				const value = Number(document.attribute(child, "val"))

				if (!Number.isFinite(value) || value <= 0) return "unknown"

				found = {
					criteria: {
						kind: "top10",
						top: bool(document.attribute(child, "top"), true),
						percent: bool(document.attribute(child, "percent"), false),
						value
					}
				}
				break
			}
			case "dynamicFilter": {
				const type = document.attribute(child, "type") ?? ""

				if (!DYNAMIC_FILTERS.has(type)) return "unknown"

				found = { criteria: { kind: "dynamic", type: type as SheetDynamicFilter } }
				break
			}
			case "colorFilter": {
				const dxfId = Number(document.attribute(child, "dxfId") ?? "-1")

				if (!Number.isInteger(dxfId) || dxfId < 0) return "unknown"

				found = { criteria: { kind: "color", cell: bool(document.attribute(child, "cellColor"), true), color: null }, dxfId }
				break
			}
			case "iconFilter":
				found = {
					criteria: {
						kind: "icon",
						iconSet: document.attribute(child, "iconSet") ?? "",
						iconId: Number(document.attribute(child, "iconId") ?? "-1")
					}
				}
				break
			default:
				return "unknown"
		}
	}

	return found ?? { criteria: null }
}

function readSort(document: XmlDocument, node: number): AutoFilterSort | null {
	const ref = parseA1Range(document.attribute(node, "ref") ?? "")

	if (ref === null) return null

	const conditions: AutoFilterSortCondition[] = []

	for (const child of children(document, node)) {
		if (document.localName(child) !== "sortCondition") continue

		const conditionRef = parseA1Range(document.attribute(child, "ref") ?? "")

		if (conditionRef === null) continue

		const sortBy = document.attribute(child, "sortBy") ?? "value"

		conditions.push({
			ref: conditionRef,
			descending: bool(document.attribute(child, "descending"), false),
			byValue: sortBy === "value" && document.attribute(child, "customList") === undefined
		})
	}

	return {
		ref,
		caseSensitive: bool(document.attribute(node, "caseSensitive"), false),
		columnSort: bool(document.attribute(node, "columnSort"), false),
		conditions,
		markup: decodeUtf8(document.raw(node))
	}
}

// Reads an autofilter element; null when it holds no range this reader takes.
export function readAutoFilter(markup: string): AutoFilter | null {
	let document: XmlDocument

	try {
		document = parseXml(encodeUtf8(markup))
	} catch {
		return null
	}

	const root = document.documentElement()
	const ref = parseA1Range(document.attribute(root, "ref") ?? "")

	if (ref === null) return null

	const columns: AutoFilterColumn[] = []
	let sort: AutoFilterSort | null = null

	for (const child of children(document, root)) {
		const local = document.localName(child)

		if (local === "sortState") sort = readSort(document, child)
		if (local !== "filterColumn") continue

		const colId = Number(document.attribute(child, "colId"))

		if (!Number.isInteger(colId) || colId < 0) continue

		const read = readCriteria(document, child)
		const column: {
			colId: number
			criteria: SheetFilterCriteria | null
			unknown: boolean
			hiddenButton: boolean
			showButton: boolean
			markup: string
			dxfId?: number
		} = {
			colId,
			criteria: read === "unknown" ? null : read.criteria,
			unknown: read === "unknown",
			hiddenButton: bool(document.attribute(child, "hiddenButton"), false),
			showButton: bool(document.attribute(child, "showButton"), true),
			markup: decodeUtf8(document.raw(child))
		}

		if (read !== "unknown" && read.dxfId !== undefined) column.dxfId = read.dxfId

		columns.push(column)
	}

	return { ref, columns, sort, markup, prefix: document.prefix(root) }
}

// --- Writing ---

function qualify(prefix: string, local: string): string {
	return prefix === "" ? local : `${prefix}:${local}`
}

function attr(name: string, value: string | number): string {
	return ` ${name}="${escapeAttribute(String(value))}"`
}

function numberText(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)))
}

// The criteria's child element. `extra` adds what only a whole column knows: a top 10's threshold (filterVal), a
// dynamic period's bounds (val, maxVal), a colour's dxf.
export function criteriaMarkup(
	prefix: string,
	criteria: SheetFilterCriteria,
	extra: { readonly filterVal?: number; readonly val?: number; readonly maxVal?: number; readonly dxfId?: number } = {}
): string {
	const q = (local: string): string => qualify(prefix, local)

	switch (criteria.kind) {
		case "values": {
			let inner = ""

			for (const value of criteria.values) inner += `<${q("filter")}${attr("val", value)}/>`

			for (const date of criteria.dates) {
				let parts = attr("year", date.year)

				for (const name of ["month", "day", "hour", "minute", "second"] as const) {
					const value = date[name]

					if (value !== undefined) parts += attr(name, value)
				}

				inner += `<${q("dateGroupItem")}${parts}${attr("dateTimeGrouping", date.grouping)}/>`
			}

			const blank = criteria.blank ? attr("blank", 1) : ""

			return inner === "" ? `<${q("filters")}${blank}/>` : `<${q("filters")}${blank}>${inner}</${q("filters")}>`
		}
		case "custom": {
			let inner = ""

			for (const condition of criteria.conditions)
				inner += `<${q("customFilter")}${condition.operator === "equal" ? "" : attr("operator", condition.operator)}${attr("val", condition.value)}/>`

			return `<${q("customFilters")}${criteria.and ? attr("and", 1) : ""}>${inner}</${q("customFilters")}>`
		}
		case "top10":
			return `<${q("top10")}${criteria.top ? "" : attr("top", 0)}${criteria.percent ? attr("percent", 1) : ""}${attr("val", numberText(criteria.value))}${extra.filterVal === undefined || Number.isNaN(extra.filterVal) ? "" : attr("filterVal", numberText(extra.filterVal))}/>`
		case "dynamic":
			return `<${q("dynamicFilter")}${attr("type", criteria.type)}${extra.val === undefined || Number.isNaN(extra.val) ? "" : attr("val", numberText(extra.val))}${extra.maxVal === undefined || Number.isNaN(extra.maxVal) ? "" : attr("maxVal", numberText(extra.maxVal))}/>`
		case "color":
			return `<${q("colorFilter")}${attr("dxfId", extra.dxfId ?? 0)}${criteria.cell ? "" : attr("cellColor", 0)}/>`
		case "icon":
			return `<${q("iconFilter")}${attr("iconSet", criteria.iconSet)}${attr("iconId", criteria.iconId)}/>`
	}
}

// A filterColumn with new criteria (null: none), its button settings and anything else it held kept.
export function columnMarkup(prefix: string, column: AutoFilterColumn | null, colId: number, criteria: string | null): string {
	const name = qualify(prefix, "filterColumn")

	if (column === null || column.markup === null) return criteria === null ? "" : `<${name}${attr("colId", colId)}>${criteria}</${name}>`

	const document = parseXml(encodeUtf8(column.markup))
	const root = document.documentElement()
	const editor = new XmlEditor(document)
	const kept = children(document, root).filter(child => document.localName(child) === "extLst")

	editor.setAttribute(root, "colId", String(colId))
	editor.setContent(root, (criteria ?? "") + kept.map(child => decodeUtf8(document.raw(child))).join(""))

	const out = decodeUtf8(editor.serialize())

	// A column left with nothing to say goes.
	return criteria === null && kept.length === 0 && !column.hiddenButton && column.showButton ? "" : out
}

export interface SortStateInput {
	readonly ref: SheetRange
	readonly caseSensitive: boolean
	readonly columnSort: boolean
	readonly conditions: readonly { readonly ref: SheetRange; readonly descending: boolean }[]
}

export function sortStateMarkup(prefix: string, sort: SortStateInput): string {
	const name = qualify(prefix, "sortState")
	let inner = ""

	for (const condition of sort.conditions)
		inner += `<${qualify(prefix, "sortCondition")}${condition.descending ? attr("descending", 1) : ""}${attr("ref", rangeName(condition.ref))}/>`

	return `<${name}${sort.columnSort ? attr("columnSort", 1) : ""}${sort.caseSensitive ? attr("caseSensitive", 1) : ""}${attr("ref", rangeName(sort.ref))}>${inner}</${name}>`
}

export interface AutoFilterWrite {
	readonly ref: SheetRange
	// By colId, ascending: each column's markup ("" drops it).
	readonly columns: ReadonlyMap<number, string>
	// undefined keeps the sort state; null removes it.
	readonly sort?: string | null
}

// The element with `write` applied: a new one when `source` is null. Columns not named in `write.columns` go.
export function writeAutoFilter(source: AutoFilter | null, prefix: string, write: AutoFilterWrite): string {
	const name = qualify(source?.prefix ?? prefix, "autoFilter")
	const columns = [...write.columns]
		.sort((a, b) => a[0] - b[0])
		.map(([, markup]) => markup)
		.join("")

	if (source === null || source.markup === "") {
		const inner = columns + (write.sort ?? "")

		return inner === ""
			? `<${name}${attr("ref", rangeName(write.ref))}/>`
			: `<${name}${attr("ref", rangeName(write.ref))}>${inner}</${name}>`
	}

	const document = parseXml(encodeUtf8(source.markup))
	const root = document.documentElement()
	const editor = new XmlEditor(document)
	let sort = ""
	let rest = ""

	for (const child of children(document, root)) {
		const local = document.localName(child)

		if (local === "filterColumn") continue
		if (local === "sortState") sort = decodeUtf8(document.raw(child))
		else rest += decodeUtf8(document.raw(child))
	}

	if (write.sort !== undefined) sort = write.sort ?? ""

	editor.setAttribute(root, "ref", rangeName(write.ref))
	editor.setContent(root, columns + sort + rest)

	const out = decodeUtf8(editor.serialize())

	// Left with no children, the element closes itself (as a new one does).
	return columns + sort + rest === "" ? out.replace(/><\/[^>]+>$/, "/>") : out
}

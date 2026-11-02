import { spliceAll } from "../../arrays"
import {
	DATE_1904_OFFSET,
	FilterTest,
	MAX_FILTER_CONDITIONS,
	MAX_FILTER_TEXT,
	MAX_FILTER_VALUES,
	datePeriod,
	filterContext,
	todaySerial,
	type CalendarParts,
	type FilterCell,
	type SheetFilterCriteria
} from "../../sheet/filter/criteria"
import {
	columnMarkup,
	criteriaMarkup,
	parseA1Range,
	readAutoFilter,
	writeAutoFilter,
	type AutoFilter,
	type AutoFilterColumn
} from "../../sheet/filter/autoFilter"
import { FilterButton, type SheetFilterItem, type SheetFilterLayout, type SheetFilterValues } from "../../sheet/filter/types"
import { serialDate, type DateParts } from "../../sheet/numfmt/index"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetId, type SheetRange, type SheetRefusal, type SheetRgb } from "../../sheet/protocol"
import {
	defineSheetFeature,
	type SheetChangeSink,
	type SheetEditStep,
	type SheetHandled,
	type SheetReadContext
} from "../../sheet/registry"
import { SortType, compareSortValues, textSortKey, type SortValue } from "../../sheet/sort/order"
import { decodeUtf8, parseXml, XmlEditor } from "../../xml/index"
import type { SheetStore } from "../model/store"
import { CellKind, RowFlag, type XlsxDefinedName, type XlsxSheetModel } from "../model/types"
import { RefRefused } from "../refs/catalogue"
import { readTable, type TableInfo } from "../refs/tables"
import { liveRelationships, refState } from "../refs/state"
import { nameWithFormula } from "../refs/plan"
import { dateSerial } from "../../sheet/numfmt/date"
import type { XlsxDocument } from "./document"
import { MAX_HIDDEN_ROWS } from "./hide"
import { CellLog, NO_ROW, cellKeyOf, rowState, type RowState } from "./history"

// Autofilters (ECMA-376 Part 1 §18.3.1.2 autoFilter, §18.3.2): the sheet's own and each table's (§18.5.1.2). A
// column's criteria (criteria.ts) are set or cleared, and every data row of the range is hidden or shown again by
// all of the range's columns at once (§18.3.1.73 row hidden), as Excel applies a filter: rows another filter or the
// user hid inside the range show again when they pass. The sheet's autofilter keeps its _xlnm._FilterDatabase name
// (§18.2.6) on the range, as Excel writes it. Criteria a cell's value cannot decide here (icons from conditional
// formatting, colours under conditional formatting, a kind this reader does not know) are kept as written, and a
// filter over them is refused rather than worked out wrongly.

const TABLE_TYPE = "/table"
const TABLE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"
const FILTER_DATABASE = "_xlnm._FilterDatabase"

// --- Tables ---

export interface FilterTable {
	readonly info: TableInfo
	readonly filter: AutoFilter | null
	// The table's root element's own prefix.
	readonly prefix: string
}

interface ParsedTable {
	readonly bytes: Uint8Array
	readonly table: FilterTable | null
}

// What a session's filters read beside the sheets: each table part's source bytes once loaded (ready), parsed once
// per version of its bytes.
interface FilterCache {
	readonly loaded: Map<SheetId, true | string>
	readonly sources: Map<string, Uint8Array>
	readonly parsed: Map<string, ParsedTable>
	readonly sheetFilters: Map<SheetId, { readonly markup: string; readonly filter: AutoFilter | null }>
}

const caches = new WeakMap<XlsxDocument, FilterCache>()

function cacheOf(document: XlsxDocument): FilterCache {
	let cache = caches.get(document)

	if (cache === undefined) {
		cache = { loaded: new Map(), sources: new Map(), parsed: new Map(), sheetFilters: new Map() }
		caches.set(document, cache)
	}

	return cache
}

function tableRelationships(document: XlsxDocument, model: XlsxSheetModel): { id: string; part: string }[] {
	const out: { id: string; part: string }[] = []

	for (const relationship of liveRelationships(document.workbook, model.part, model.relationships.all))
		if (!relationship.external && relationship.type.endsWith(TABLE_TYPE) && relationship.partName !== undefined)
			out.push({ id: relationship.id, part: relationship.partName })

	return out
}

function parseTable(document: XlsxDocument, sheet: SheetId, relationship: string, part: string, bytes: Uint8Array): FilterTable | null {
	try {
		const contentType = document.workbook.parts.get(part)?.contentType ?? TABLE_CONTENT_TYPE
		const info = readTable(part, contentType, sheet, relationship, bytes, [])
		const xml = parseXml(bytes)
		const root = xml.documentElement()
		let filter: AutoFilter | null = null

		for (let child = xml.firstChildElement(root); child >= 0; child = xml.nextSiblingElement(child)) {
			if (xml.localName(child) !== "autoFilter") continue

			filter = readAutoFilter(decodeUtf8(xml.raw(child)))
		}

		// A table's sort state is the table's child, not its filter's.
		const sortNode = (() => {
			for (let child = xml.firstChildElement(root); child >= 0; child = xml.nextSiblingElement(child))
				if (xml.localName(child) === "sortState") return child

			return -1
		})()

		if (filter !== null && sortNode >= 0) {
			const sort = readAutoFilter(
				`<autoFilter ref="${decodeUtf8(xml.raw(sortNode)).match(/\sref="([^"]*)"/)?.[1] ?? "A1"}">${decodeUtf8(xml.raw(sortNode))}</autoFilter>`
			)?.sort

			if (sort !== undefined && sort !== null) filter = { ...filter, sort }
		}

		return { info, filter, prefix: xml.prefix(root) }
	} catch (error) {
		if (error instanceof RefRefused) return null

		throw error
	}
}

// The sheet's tables as they now are, from bytes already at hand (null: some table part is not loaded yet).
function tablesNow(document: XlsxDocument, model: XlsxSheetModel): FilterTable[] | null {
	const cache = cacheOf(document)
	const state = refState(document.workbook)
	const out: FilterTable[] = []

	for (const { id, part } of tableRelationships(document, model)) {
		const bytes = state.heldPart(part) ?? cache.sources.get(part)

		if (bytes === undefined) return null

		const parsed = cache.parsed.get(part)

		if (parsed !== undefined && parsed.bytes === bytes) {
			if (parsed.table !== null) out.push(parsed.table)

			continue
		}

		const table = parseTable(document, model.id, id, part, bytes)

		cache.parsed.set(part, { bytes, table })

		if (table !== null) out.push(table)
	}

	return out
}

// Loads the sheet's table parts once (the feature's ready hook, and before any command reads them).
export async function loadTables(document: XlsxDocument, model: XlsxSheetModel): Promise<FilterTable[]> {
	const cache = cacheOf(document)
	const state = refState(document.workbook)

	for (const { part } of tableRelationships(document, model)) {
		if (state.heldPart(part) !== undefined || cache.sources.has(part)) continue

		const bytes = await state.partBytes(part)

		if (bytes !== null) cache.sources.set(part, bytes)
	}

	cache.loaded.set(model.id, true)

	return tablesNow(document, model) ?? []
}

// --- The sheet's own autofilter ---

function sheetFilterMarkup(document: XlsxDocument, model: XlsxSheetModel): string {
	const occurrences = refState(document.workbook).sectionMarkup(model, "autoFilter")

	return occurrences[0] ?? ""
}

function sheetFilter(document: XlsxDocument, model: XlsxSheetModel): AutoFilter | null {
	const cache = cacheOf(document)
	let markup: string

	try {
		markup = sheetFilterMarkup(document, model)
	} catch (error) {
		if (error instanceof RefRefused) return null

		throw error
	}

	const known = cache.sheetFilters.get(model.id)

	if (known !== undefined && known.markup === markup) return known.filter

	const filter = markup === "" ? null : readAutoFilter(markup)

	cache.sheetFilters.set(model.id, { markup, filter })

	return filter
}

function prefixOf(model: XlsxSheetModel): string {
	return (model as { readonly prefix?: string }).prefix ?? ""
}

// --- Filters of a sheet ---

// One filter range: the sheet's (table null) or a table's. `range` is the filter's own (a table's without its totals).
export interface FilterTarget {
	readonly table: FilterTable | null
	readonly filter: AutoFilter
	readonly range: SheetRange
}

function within(range: SheetRange, row: number, col: number): boolean {
	return row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol
}

// A table's data rows (between its header and totals rows), or null for none.
export function tableBody(table: FilterTable): SheetRange | null {
	const ref = table.info.ref
	const body = { ...ref, startRow: ref.startRow + Math.max(0, table.info.headerRows), endRow: ref.endRow - table.info.totalsRows }

	return body.startRow > body.endRow ? null : body
}

function tableFilterRange(table: FilterTable): SheetRange | null {
	const ref = table.info.ref

	if (table.info.headerRows <= 0) return null

	return { ...ref, endRow: ref.endRow - table.info.totalsRows }
}

// The sheet's filters with buttons: its own autofilter and each table's that has one.
export function filterTargets(document: XlsxDocument, model: XlsxSheetModel, tables: readonly FilterTable[]): FilterTarget[] {
	const out: FilterTarget[] = []
	const own = sheetFilter(document, model)

	if (own !== null) out.push({ table: null, filter: own, range: own.ref })

	for (const table of tables) {
		const range = tableFilterRange(table)

		if (table.filter !== null && range !== null) out.push({ table, filter: table.filter, range })
	}

	return out
}

// The filter whose range holds the cell.
function targetAt(targets: readonly FilterTarget[], row: number, col: number): FilterTarget | undefined {
	return targets.find(target => within(target.range, row, col))
}

// --- Cells ---

function isoSerial(text: string, date1904: boolean): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(text)

	if (match === null) return Number.NaN

	const day = dateSerial(Number(match[1]), Number(match[2]), Number(match[3]), date1904)
	const seconds = Number(match[4] ?? 0) * 3600 + Number(match[5] ?? 0) * 60 + Number(match[6] ?? 0)

	return day + seconds / 86_400
}

const BLANK_CELL: FilterCell = { type: SortType.BLANK, number: 0, text: "", date: false }

// A cell's value as a filter and a sort read it: its kind (a formula's result when it has one), its number and
// whether its format is a date's. `text` reads what it shows, only when asked.
export function readCell(
	document: XlsxDocument,
	model: XlsxSheetModel,
	row: number,
	col: number,
	slot: number,
	withText: boolean
): FilterCell {
	const store = model.store as SheetStore

	if (slot < 0) return BLANK_CELL

	let kind = store.kind(slot)
	let value = store.value(slot)
	let type: SortType
	let number = 0
	let text: string | null = null

	if (kind === CellKind.EMPTY && store.formula(slot) >= 0) {
		const shown = document.shownResults.get(model.id)?.get(cellKeyOf(row, col))

		if (shown === undefined || shown.value === null)
			return withText ? { ...BLANK_CELL, text: document.cellView(model.id, row, col).text } : BLANK_CELL

		if (typeof shown.value === "number") {
			kind = CellKind.NUMBER
			value = shown.value
		} else if (typeof shown.value === "boolean") {
			kind = CellKind.BOOLEAN
			value = shown.value ? 1 : 0
		} else {
			type = shown.error ? SortType.ERROR : SortType.TEXT
			text = shown.value

			return { type, number: 0, text: withText ? document.cellView(model.id, row, col).text : text, date: false }
		}
	}

	switch (kind) {
		case CellKind.EMPTY:
			return BLANK_CELL
		case CellKind.NUMBER:
			type = SortType.NUMBER
			number = value
			break
		case CellKind.DATE:
			type = SortType.NUMBER
			number = isoSerial(store.strings.text(value), document.date1904)
			break
		case CellKind.BOOLEAN:
			type = SortType.BOOLEAN
			number = value
			break
		case CellKind.ERROR:
			type = SortType.ERROR
			text = store.strings.text(value)
			break
		default:
			type = SortType.TEXT
			text = document.stringOf(model, kind, value)
	}

	const date = type === SortType.NUMBER && document.numFmt(store.style(slot)).isDate

	return { type, number, text: withText ? document.cellView(model.id, row, col).text : (text ?? ""), date }
}

// A cell as a sort compares it: text by its sort key.
export function sortValueOf(cell: FilterCell, caseSensitive: boolean): SortValue {
	return cell.type === SortType.TEXT
		? { type: SortType.TEXT, number: 0, key: textSortKey(cell.text, caseSensitive) }
		: { type: cell.type, number: cell.number, key: "" }
}

function calendarOf(date1904: boolean): (serial: number) => CalendarParts | null {
	const parts: DateParts = { year: 0, month: 0, day: 0, weekday: 0 }

	return serial => {
		if (!Number.isFinite(serial) || serial < 0) return null

		const day = Math.floor(serial)

		serialDate(day, date1904, parts)

		const seconds = Math.round((serial - day) * 86_400)

		return {
			year: parts.year,
			month: parts.month,
			day: parts.day,
			hour: Math.floor(seconds / 3600) % 24,
			minute: Math.floor(seconds / 60) % 60,
			second: seconds % 60
		}
	}
}

// --- Working a filter out ---

interface ColumnTest {
	readonly col: number
	readonly test: FilterTest
	readonly withText: boolean
	readonly blank: boolean
	// A colour filter reads each cell's colours (a blank cell's from its row or column).
	readonly colors: boolean
}

function needsText(criteria: SheetFilterCriteria): boolean {
	return criteria.kind === "values" || criteria.kind === "custom"
}

// Why a column's criteria cannot be worked out here, or null.
function unworkable(column: AutoFilterColumn): SheetRefusal | null {
	if (column.unknown) return { reason: "filterCriteria", detail: "unknown" }
	if (column.criteria?.kind === "icon") return { reason: "filterCriteria", detail: "iconFilter" }

	return null
}

// The ranges the sheet's conditional formatting applies to (its own and the x14 ones in extLst): what a cell shows
// there may not be its own colour.
function formattedRanges(document: XlsxDocument, model: XlsxSheetModel): SheetRange[] | null {
	const state = refState(document.workbook)
	const out: SheetRange[] = []

	try {
		for (const markup of state.sectionMarkup(model, "conditionalFormatting"))
			for (const ref of (/\ssqref="([^"]*)"/.exec(markup)?.[1] ?? "").split(/\s+/)) {
				const range = parseA1Range(ref)

				if (range !== null) out.push(range)
			}

		for (const markup of state.sectionMarkup(model, "extLst"))
			for (const match of markup.matchAll(/<(?:\w+:)?sqref>([^<]*)<\/(?:\w+:)?sqref>/g))
				for (const ref of (match[1] ?? "").split(/\s+/)) {
					const range = parseA1Range(ref)

					if (range !== null) out.push(range)
				}
	} catch (error) {
		if (error instanceof RefRefused) return null

		throw error
	}

	return out
}

// A cell's fill (cell) or font colour as shown without conditional formatting; null for none or automatic.
function cellColor(document: XlsxDocument, model: XlsxSheetModel, row: number, col: number, slot: number, cell: boolean): SheetRgb | null {
	const style = slot < 0 ? document.startingStyle(model, row, col) : (model.store as SheetStore).style(slot)
	const render = document.styles.renderStyle(style)

	return (cell ? render.fill : render.color) ?? null
}

// A colour filter's colour, from its dxf (a solid fill's colour is the dxf's background colour, as Excel writes
// it); undefined when the dxf holds none this reads.
function dxfColor(document: XlsxDocument, dxfId: number, cell: boolean): SheetRgb | null | undefined {
	const dxf = document.workbook.styles.dxfs[dxfId]

	if (dxf === undefined) return undefined

	if (!cell) {
		const rgb = document.styles.color(dxf.font?.color)

		return rgb < 0 ? null : rgb
	}

	const fill = dxf.fill

	if (fill === undefined || (fill.kind === "pattern" && fill.pattern === "none")) return null
	if (fill.kind !== "pattern") return undefined

	const rgb = document.styles.color(fill.bg ?? fill.fg)

	return rgb < 0 ? null : rgb
}

function today(document: XlsxDocument): number {
	return todaySerial((document.settings.clock ?? Date.now)(), document.date1904)
}

// Each column's test, the whole column's context worked out first; refused for a colour filter on cells conditional
// formatting may colour.
function columnTests(
	document: XlsxDocument,
	model: XlsxSheetModel,
	range: SheetRange,
	columns: readonly { readonly col: number; readonly criteria: SheetFilterCriteria }[]
): ColumnTest[] | SheetRefusal {
	const store = model.store as SheetStore
	const calendar = calendarOf(document.date1904)
	const now = today(document)

	if (columns.some(column => column.criteria.kind === "color")) {
		const formatted = formattedRanges(document, model)

		for (const { col, criteria } of columns) {
			if (criteria.kind !== "color") continue

			const data = { startRow: range.startRow + 1, endRow: range.endRow, startCol: col, endCol: col }

			if (formatted === null || formatted.some(ranged => intersects(ranged, data)))
				return { reason: "filterCriteria", detail: "colorFilter" }
		}
	}

	return columns.map(({ col, criteria }) => {
		const numbers: number[] = []

		if (criteria.kind === "top10" || criteria.kind === "dynamic")
			store.forEachCell({ startRow: range.startRow + 1, endRow: range.endRow, startCol: col, endCol: col }, (row, _, slot) => {
				const cell = readCell(document, model, row, col, slot, false)

				if (cell.type === SortType.NUMBER) numbers.push(cell.number)
			})

		const test = new FilterTest(criteria, filterContext(criteria, numbers, now, document.date1904), calendar)

		return { col, test, withText: needsText(criteria), blank: test.passes(BLANK_CELL), colors: criteria.kind === "color" }
	})
}

// Whether each data row of `range` (from its second row) passes every test: 1 passes.
function passing(document: XlsxDocument, model: XlsxSheetModel, range: SheetRange, tests: readonly ColumnTest[]): Uint8Array {
	const store = model.store as SheetStore
	const count = range.endRow - range.startRow
	const pass = new Uint8Array(count).fill(1)

	for (const { col, test, withText, blank, colors } of tests) {
		// Rows with no cell in the column are blank (a colour filter reads their row's or column's colours).
		const seen = blank && !colors ? null : new Uint8Array(count)

		store.forEachCell({ startRow: range.startRow + 1, endRow: range.endRow, startCol: col, endCol: col }, (row, _, slot) => {
			const index = row - range.startRow - 1

			if (seen !== null) seen[index] = 1
			if (pass[index] === 0) return

			const colorOf = colors ? (cell: boolean) => cellColor(document, model, row, col, slot, cell) : undefined

			if (!test.passes(readCell(document, model, row, col, slot, withText), colorOf)) pass[index] = 0
		})

		if (seen === null) continue

		for (let index = 0; index < count; index++) {
			if (seen[index] === 1 || pass[index] === 0) continue

			const row = range.startRow + 1 + index
			const passes = colors ? test.passes(BLANK_CELL, cell => cellColor(document, model, row, col, -1, cell)) : blank

			if (!passes) pass[index] = 0
		}
	}

	return pass
}

// The rows whose hidden flag the filter changes, with their properties before and after.
interface RowChanges {
	readonly rows: number[]
	readonly before: RowState[]
	readonly after: RowState[]
}

function rowChanges(store: SheetStore, range: SheetRange, pass: Uint8Array): RowChanges | "tooLarge" {
	const changes: RowChanges = { rows: [], before: [], after: [] }
	let added = 0

	for (let index = 0; index < pass.length; index++) {
		const row = range.startRow + 1 + index
		const state = rowState(store, row)
		const hidden = (state.flags & RowFlag.HIDDEN) !== 0
		const hide = pass[index] === 0

		if (hidden === hide) continue

		// A row of no height reads as hidden too: shown, it takes the default height.
		const flat = !hide && state.height === 0

		if (state === NO_ROW && ++added > MAX_HIDDEN_ROWS) return "tooLarge"

		changes.rows.push(row)
		changes.before.push(state)
		changes.after.push({
			...state,
			flags: hide ? state.flags | RowFlag.HIDDEN : state.flags & ~(RowFlag.HIDDEN | (flat ? RowFlag.CUSTOM_HEIGHT : 0)),
			height: flat ? Number.NaN : state.height
		})
	}

	return changes
}

// --- Writing ---

// Values, conditions and dates as a filter writes them: within Excel's limits.
function criteriaRefusal(criteria: SheetFilterCriteria | null): SheetRefusal | null {
	if (criteria === null) return null

	switch (criteria.kind) {
		case "values":
			return criteria.values.length + criteria.dates.length > MAX_FILTER_VALUES
				? { reason: "tooLarge", detail: "filterValues" }
				: null
		case "custom":
			return criteria.conditions.length === 0 ||
				criteria.conditions.length > MAX_FILTER_CONDITIONS ||
				criteria.conditions.some(condition => condition.value.length > MAX_FILTER_TEXT)
				? { reason: "unsupported", detail: "customFilter" }
				: null
		case "top10":
			return !Number.isFinite(criteria.value) || criteria.value <= 0 || criteria.value > (criteria.percent ? 100 : 500)
				? { reason: "unsupported", detail: "top10" }
				: null
		case "dynamic":
		case "color":
			return null
		case "icon":
			return { reason: "filterCriteria", detail: criteria.kind }
	}
}

// The dxf a colour filter names: a solid fill of the colour (both colours, as Excel writes it) or none, or the font
// colour (automatic for null). Styles are append-only: an equal appended dxf is reused.
function colorDxf(document: XlsxDocument, criteria: { readonly cell: boolean; readonly color: SheetRgb | null }): number {
	const argb = criteria.color === null ? undefined : (0xff000000 | criteria.color) >>> 0
	const id = criteria.cell
		? document.workbook.styles.appendDxf({
				fill:
					argb === undefined
						? { kind: "pattern", pattern: "none" }
						: { kind: "pattern", pattern: "solid", fg: { argb }, bg: { argb } }
			})
		: document.workbook.styles.appendDxf({ font: { color: argb === undefined ? { auto: true } : { argb } } })

	document.workbook.changes.stylesAppended()

	return id
}

// What a column's criteria element says beyond the criteria (a threshold, a period, an average).
function criteriaExtra(
	document: XlsxDocument,
	model: XlsxSheetModel,
	range: SheetRange,
	col: number,
	criteria: SheetFilterCriteria
): { filterVal?: number; val?: number; maxVal?: number; dxfId?: number } {
	if (criteria.kind === "color") return { dxfId: colorDxf(document, criteria) }
	if (criteria.kind !== "top10" && criteria.kind !== "dynamic") return {}

	const store = model.store as SheetStore
	const numbers: number[] = []

	store.forEachCell({ startRow: range.startRow + 1, endRow: range.endRow, startCol: col, endCol: col }, (row, _, slot) => {
		const cell = readCell(document, model, row, col, slot, false)

		if (cell.type === SortType.NUMBER) numbers.push(cell.number)
	})

	const context = filterContext(criteria, numbers, today(document), document.date1904)

	if (criteria.kind === "top10") return { filterVal: context.threshold }
	if (criteria.type === "aboveAverage" || criteria.type === "belowAverage") return { val: context.average }

	const offset = document.date1904 ? DATE_1904_OFFSET : 0
	const period = datePeriod(criteria.type, today(document) + offset)

	return period === null ? {} : { val: period[0] - offset, maxVal: period[1] - offset }
}

// The filter's element on `ref` with the criteria of the sheet columns in `set` written anew (null clears them) and
// the other columns kept as written. Column ids count from the range's first column.
function filterWith(
	document: XlsxDocument,
	model: XlsxSheetModel,
	filter: AutoFilter | null,
	prefix: string,
	ref: SheetRange,
	set: ReadonlyMap<number, SheetFilterCriteria | null>,
	sort?: string | null
): string {
	const columns = new Map<number, string>()
	const byId = new Map((filter?.columns ?? []).map(column => [column.colId, column]))

	for (const column of filter?.columns ?? []) if (!set.has(ref.startCol + column.colId)) columns.set(column.colId, column.markup ?? "")

	for (const [col, criteria] of set) {
		const colId = col - ref.startCol
		const column = byId.get(colId) ?? null
		const own = filter?.prefix ?? prefix
		const markup = criteria === null ? null : criteriaMarkup(own, criteria, criteriaExtra(document, model, ref, col, criteria))

		columns.set(colId, columnMarkup(own, column, colId, markup))
	}

	for (const [colId, markup] of columns) if (markup === "") columns.delete(colId)

	return writeAutoFilter(filter, prefix, { ref, columns, ...(sort !== undefined && { sort }) })
}

// A table part with its autofilter (and, with `sort`, its sort state) replaced.
function tableWith(table: FilterTable, filterMarkup: string | null, sort?: string | null): Uint8Array {
	const xml = parseXml(table.info.bytes)
	const root = xml.documentElement()
	const editor = new XmlEditor(xml)
	let filterNode = -1
	let sortNode = -1
	let firstAfter = -1

	for (let child = xml.firstChildElement(root); child >= 0; child = xml.nextSiblingElement(child)) {
		const local = xml.localName(child)

		if (local === "autoFilter") filterNode = child
		else if (local === "sortState") sortNode = child
		else if (firstAfter < 0) firstAfter = child
	}

	const place = (node: number, markup: string, before: number): void => {
		if (node >= 0) {
			if (markup === "") editor.remove(node)
			else editor.replace(node, markup)
		} else if (markup !== "") {
			if (before >= 0) editor.insertBefore(before, markup)
			else editor.append(root, markup)
		}
	}

	if (filterMarkup !== null) place(filterNode, filterMarkup, sortNode >= 0 ? sortNode : firstAfter)
	if (sort !== undefined) place(sortNode, sort ?? "", firstAfter)

	return editor.serialize()
}

function quotedSheet(name: string): string {
	return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) &&
		!/^[A-Za-z]{1,3}\d+$/.test(name) &&
		!/^[Rr]\d*[Cc]\d*$/.test(name) &&
		!/^(TRUE|FALSE)$/i.test(name)
		? `${name}!`
		: `'${name.replaceAll("'", "''")}'!`
}

function absoluteRange(range: SheetRange): string {
	const letters = (col: number): string => {
		let out = ""

		for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out

		return out
	}

	return `$${letters(range.startCol)}$${String(range.startRow + 1)}:$${letters(range.endCol)}$${String(range.endRow + 1)}`
}

// The workbook's names with the sheet's _xlnm._FilterDatabase on `range` (added when missing), or null when that is
// already so.
function namesWith(document: XlsxDocument, sheet: SheetId, range: SheetRange): XlsxDefinedName[] | null {
	const entry = document.workbook.sheet(sheet)

	if (entry === undefined) return null

	const formula = `${quotedSheet(entry.name)}${absoluteRange(range)}`
	const names = document.workbook.definedNames
	const at = names.findIndex(name => name.sheet === sheet && name.name.toUpperCase() === FILTER_DATABASE.toUpperCase())
	const existing = names[at]

	if (existing !== undefined && existing.formula === formula) return null

	const next = names.slice()

	if (existing !== undefined) {
		const updated = nameWithFormula(existing, formula)

		if (updated === null) return null

		next[at] = updated
	} else {
		next.push({ name: FILTER_DATABASE, sheet, formula, hidden: true, source: null })
	}

	return next
}

// One filter edit: rows hidden or shown, the sheet's autofilter or a table part, and the filter database name; each
// side put back as a whole.
export interface FilterEditParts {
	readonly sheet: SheetId
	readonly rows: RowChanges | null
	readonly section: { readonly before: readonly string[]; readonly after: readonly string[] } | null
	readonly table: {
		readonly part: string
		readonly contentType: string
		readonly before: Uint8Array | undefined
		readonly after: Uint8Array
	} | null
	readonly names: { readonly before: readonly XlsxDefinedName[]; readonly after: readonly XlsxDefinedName[] } | null
}

function applyParts(
	document: XlsxDocument,
	model: XlsxSheetModel,
	parts: FilterEditParts,
	which: "before" | "after",
	sink: SheetChangeSink
): void {
	const store = model.store as SheetStore
	const state = refState(document.workbook)

	if (parts.rows !== null && parts.rows.rows.length > 0) {
		const states = which === "before" ? parts.rows.before : parts.rows.after

		store.setRows(
			parts.rows.rows.map((row, index) => {
				const value = states[index] ?? NO_ROW

				return { row, height: value.height, style: value.style, flags: value.flags }
			})
		)
		document.workbook.changes.sheetRows(parts.sheet)
	}

	if (parts.section !== null) state.setSection(model, "autoFilter", which === "before" ? parts.section.before : parts.section.after)

	if (parts.table !== null)
		state.setPart(parts.table.part, parts.table.contentType, which === "before" ? parts.table.before : parts.table.after)

	if (parts.names !== null) {
		const names = which === "before" ? parts.names.before : parts.names.after

		spliceAll(document.workbook.definedNames, 0, document.workbook.definedNames.length, names)
		document.workbook.changes.workbookSection("definedNames")
		document.dropEngine()
	}

	if (parts.table !== null) document.structureChanged()

	filteringRanges.delete(document)
	sink.layout(parts.sheet)
}

// Applies an edit's parts. filterMode is worked out when the edit is first applied and put back exactly on undo and
// redo, so an undone edit leaves the source's sheetPr as it was, also where the source's flag disagreed with its
// hidden rows.
function partsApplier(
	document: XlsxDocument,
	model: XlsxSheetModel,
	parts: FilterEditParts
): (which: "before" | "after", sink: SheetChangeSink) => void {
	let modes: { readonly before: boolean | undefined; readonly after: boolean | undefined } | null = null

	return (which, sink) => {
		const before = model.filterMode

		applyParts(document, model, parts, which, sink)

		if (modes === null) {
			syncFilterMode(document, model)
			modes = { before, after: model.filterMode }

			return
		}

		const mode = which === "before" ? modes.before : modes.after

		if (model.filterMode === mode) return

		if (mode === undefined) delete model.filterMode
		else model.filterMode = mode

		document.workbook.changes.sheetSection(model.id, "sheetPr")
	}
}

// The ranges of a sheet's filters that filter something (have criteria), worked out once per task: an evaluation
// asks for many rows. A filter edit drops them at once.
const filteringRanges = new WeakMap<XlsxDocument, Map<SheetId, readonly SheetRange[]>>()

function filterRanges(document: XlsxDocument, model: XlsxSheetModel): readonly SheetRange[] {
	let bySheet = filteringRanges.get(document)

	if (bySheet === undefined) {
		const held = new Map<SheetId, readonly SheetRange[]>()

		bySheet = held
		filteringRanges.set(document, held)
		void Promise.resolve().then(() => {
			if (filteringRanges.get(document) === held) filteringRanges.delete(document)
		})
	}

	let ranges = bySheet.get(model.id)

	if (ranges === undefined) {
		ranges = filterTargets(document, model, tablesNow(document, model) ?? [])
			.filter(target => target.filter.columns.some(column => column.criteria !== null || column.unknown))
			.map(target => target.range)
		bySheet.set(model.id, ranges)
	}

	return ranges
}

// Tells the document which hidden rows a filter hides (SUBTOTAL and AGGREGATE leave those out for every function):
// those in the body of a filter that filters something.
export function trackFilteredRows(document: XlsxDocument): void {
	document.filteredRow ??= (sheet, row) => {
		const model = document.model(sheet)

		return model !== null && filterRanges(document, model).some(range => row > range.startRow && row <= range.endRow)
	}
}

// Whether one of the sheet's filters with criteria hides a row of its range (sheetPr filterMode, §18.3.1.82).
function filtering(document: XlsxDocument, model: XlsxSheetModel): boolean {
	const store = model.store as SheetStore

	for (const { startRow, endRow } of filterRanges(document, model)) {
		for (const block of store.blocks) {
			if (block.firstRow > endRow) break

			for (let i = 0; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)

				if (row > startRow && row <= endRow && ((block.rowFlags[i] ?? 0) & RowFlag.HIDDEN) !== 0) return true
			}
		}
	}

	return false
}

// The source's own filterMode, read from its sheetPr.
function sourceFilterMode(model: XlsxSheetModel): boolean {
	const bytes = model.sections.find(section => section.name === "sheetPr")?.bytes ?? null

	if (bytes === null) return false

	const document = parseXml(bytes)
	const value = document.attribute(document.documentElement(), "filterMode")

	return value === "1" || value === "true"
}

// filterMode follows what the sheet's filters now hide; left to the source while it agrees with it.
function syncFilterMode(document: XlsxDocument, model: XlsxSheetModel): void {
	const now = filtering(document, model)

	if (now === (model.filterMode ?? sourceFilterMode(model))) return

	model.filterMode = now
	document.workbook.changes.sheetSection(model.id, "sheetPr")
}

function editStep(document: XlsxDocument, model: XlsxSheetModel, parts: FilterEditParts, changes: SheetChangeSink): SheetEditStep {
	const engine = document.engine !== null
	const apply = partsApplier(document, model, parts)

	apply("after", changes)

	// SUBTOTAL and AGGREGATE leave the rows a filter hides out. A changed name dropped the engine (applyParts): it is
	// built again, so the rows are what it recalculates.
	const rows = parts.rows !== null && parts.rows.rows.length > 0
	const results = new CellLog()

	if (rows) {
		trackFilteredRows(document)

		if (engine && document.engine === null && document.allReady && document.hasFormulas) document.buildEngine(changes)

		document.rowsChanged(results, changes)
		results.seal((s, r, c) => document.state(s, r, c))
	}

	const bytes =
		(parts.rows?.rows.length ?? 0) * 48 +
		results.bytes +
		(parts.section === null ? 0 : (parts.section.before.join("").length + parts.section.after.join("").length) * 2) +
		(parts.table === null ? 0 : (parts.table.before?.length ?? 0) + parts.table.after.length) +
		(parts.names === null ? 0 : (parts.names.before.length + parts.names.after.length) * 64)
	const replay = (which: "before" | "after", sink: SheetChangeSink): void => {
		apply(which, sink)

		if (rows) document.rowsRestored(results, which, sink)
	}

	return { bytes, undo: sink => replay("before", sink), redo: sink => replay("after", sink) }
}

// A sort state written on its own (a sort of a filter's or table's range): applied or taken back as a whole.
export interface SortStateEdit {
	readonly bytes: number
	apply(which: "before" | "after", sink: SheetChangeSink): void
}

// The sort state `markup` on the sheet's autofilter (`target.table` null) or as the table's own child (a table's
// sort state is the table's, beside its autofilter); null when it is already so.
export function sortStateParts(
	document: XlsxDocument,
	model: XlsxSheetModel,
	target: { readonly table: FilterTable | null; readonly filter: AutoFilter | null; readonly range: SheetRange },
	markup: string
): SortStateEdit | null {
	const state = refState(document.workbook)
	let parts: FilterEditParts

	if (target.table === null) {
		if (target.filter === null) return null

		let before: readonly string[]

		try {
			before = state.sectionMarkup(model, "autoFilter")
		} catch (error) {
			if (error instanceof RefRefused) return null

			throw error
		}

		const columns = new Map<number, string>()

		for (const column of target.filter.columns) if (column.markup !== null) columns.set(column.colId, column.markup)

		const after = writeAutoFilter(target.filter, prefixOf(model), { ref: target.filter.ref, columns, sort: markup })

		if (before.length === 1 && before[0] === after) return null

		parts = { sheet: model.id, rows: null, section: { before, after: [after] }, table: null, names: null }
	} else {
		const after = tableWith(target.table, null, markup)

		if (sameBytes(after, target.table.info.bytes)) return null

		const part = target.table.info.part

		parts = {
			sheet: model.id,
			rows: null,
			section: null,
			table: { part, contentType: target.table.info.contentType, before: state.heldPart(part), after },
			names: null
		}
	}

	return {
		bytes: parts.section === null ? (parts.table?.after.length ?? 0) * 2 : markup.length * 4,
		apply: partsApplier(document, model, parts)
	}
}

// The edit that gives `target` the element `markup` (and the sort state `tableSort` for a table), its rows filtered
// by `criteria` (by sheet column), the name kept on the range. Parts left as they are stay out of it.
function filterEdit(
	document: XlsxDocument,
	model: XlsxSheetModel,
	target: { readonly table: FilterTable | null; readonly filter: AutoFilter | null; readonly range: SheetRange },
	markup: string,
	criteria: ReadonlyMap<number, SheetFilterCriteria>,
	tableSort?: string | null
): FilterEditParts | SheetRefusal {
	const store = model.store as SheetStore
	const sheet = model.id
	const range = target.range
	const tests = columnTests(
		document,
		model,
		range,
		[...criteria].map(([col, value]) => ({ col, criteria: value }))
	)

	if ("reason" in tests) return tests

	const rows = rowChanges(store, range, passing(document, model, range, tests))

	if (rows === "tooLarge") return { reason: "tooLarge", detail: "rows" }

	const state = refState(document.workbook)

	if (target.table === null) {
		let before: readonly string[]

		try {
			before = state.sectionMarkup(model, "autoFilter")
		} catch (error) {
			if (error instanceof RefRefused) return { reason: "structureLocked", detail: "autoFilter" }

			throw error
		}

		const names = markup === "" ? null : namesWith(document, sheet, range)
		const unchanged = markup === "" ? before.length === 0 : before.length === 1 && before[0] === markup

		return {
			sheet,
			rows,
			section: unchanged ? null : { before, after: markup === "" ? [] : [markup] },
			table: null,
			names: names === null ? null : { before: document.workbook.definedNames.slice(), after: names }
		}
	}

	const part = target.table.info.part
	const after = tableWith(target.table, markup, tableSort)

	return {
		sheet,
		rows,
		section: null,
		table: sameBytes(after, target.table.info.bytes)
			? null
			: { part, contentType: target.table.info.contentType, before: state.heldPart(part), after },
		names: null
	}
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false

	return true
}

// Whether an edit changes nothing.
function emptyEdit(parts: FilterEditParts): boolean {
	return (parts.rows === null || parts.rows.rows.length === 0) && parts.section === null && parts.table === null && parts.names === null
}

// Every column's criteria of a filter, by sheet column (a colour filter's colour read from its dxf), or why they cannot
// all be worked out.
function criteriaOf(document: XlsxDocument, filter: AutoFilter, range: SheetRange): Map<number, SheetFilterCriteria> | SheetRefusal {
	const out = new Map<number, SheetFilterCriteria>()

	for (const column of filter.columns) {
		const refusal = unworkable(column)

		if (refusal !== null) return refusal
		if (column.criteria === null) continue

		if (column.criteria.kind === "color") {
			const color = dxfColor(document, column.dxfId ?? -1, column.criteria.cell)

			if (color === undefined) return { reason: "filterCriteria", detail: "colorFilter" }

			out.set(range.startCol + column.colId, { ...column.criteria, color })

			continue
		}

		out.set(range.startCol + column.colId, column.criteria)
	}

	return out
}

// --- Commands ---

async function context(document: XlsxDocument, sheet: SheetId): Promise<{ model: XlsxSheetModel; tables: FilterTable[] } | SheetRefusal> {
	const model = await document.ready(sheet)

	try {
		return { model, tables: await loadTables(document, model) }
	} catch (error) {
		if (error instanceof RefRefused) return { reason: "structureLocked", detail: "tables" }

		throw error
	}
}

function intersects(a: SheetRange, b: SheetRange): boolean {
	return a.startRow <= b.endRow && a.endRow >= b.startRow && a.startCol <= b.endCol && a.endCol >= b.startCol
}

function inGrid(range: SheetRange): boolean {
	return (
		Number.isInteger(range.startRow) &&
		Number.isInteger(range.endRow) &&
		Number.isInteger(range.startCol) &&
		Number.isInteger(range.endCol) &&
		range.startRow >= 0 &&
		range.startCol >= 0 &&
		range.endRow < SHEET_MAX_ROWS &&
		range.endCol < SHEET_MAX_COLS &&
		range.startRow <= range.endRow &&
		range.startCol <= range.endCol
	)
}

async function toggleFilter(
	document: XlsxDocument,
	sheet: SheetId,
	range: SheetRange,
	active: { readonly row: number; readonly col: number },
	changes: SheetChangeSink
): Promise<SheetHandled> {
	if (!inGrid(range)) return { refused: { reason: "tooLarge" } }

	const found = await context(document, sheet)

	if ("reason" in found) return { refused: found }

	await document.engineBeforeRows(changes)

	const { model, tables } = found

	// Turning a filter on or off is not among what sheet protection allows (autoFilter only lets existing ones be used).
	if (model.protection !== null) return { refused: { reason: "protectedSheet", detail: "autoFilter" } }

	const own = sheetFilter(document, model)

	if (own !== null) {
		const parts = filterEdit(document, model, { table: null, filter: own, range: own.ref }, "", new Map())

		return "reason" in parts ? { refused: parts } : editStep(document, model, parts, changes)
	}

	const table = tables.find(candidate => within(candidate.info.ref, active.row, active.col))

	if (table !== undefined) {
		const filterRange = tableFilterRange(table)

		if (filterRange === null) return { refused: { reason: "unsupported", detail: "tableHeader" } }

		// Off, the table keeps its sort state; on, it starts with no criteria.
		const markup = table.filter === null ? writeAutoFilter(null, table.prefix, { ref: filterRange, columns: new Map() }) : ""
		const parts = filterEdit(document, model, { table, filter: table.filter, range: filterRange }, markup, new Map())

		return "reason" in parts ? { refused: parts } : editStep(document, model, parts, changes)
	}

	// A new filter cannot cross a table or a merge that reaches out of the range's header row.
	if (tables.some(candidate => intersects(candidate.info.ref, range))) return { refused: { reason: "structureLocked", detail: "tables" } }

	const markup = writeAutoFilter(null, prefixOf(model), { ref: range, columns: new Map() })
	const parts = filterEdit(document, model, { table: null, filter: null, range }, markup, new Map())

	return "reason" in parts ? { refused: parts } : editStep(document, model, parts, changes)
}

async function setColumn(
	document: XlsxDocument,
	sheet: SheetId,
	row: number,
	col: number,
	criteria: SheetFilterCriteria | null,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const refusal = criteriaRefusal(criteria)

	if (refusal !== null) return { refused: refusal }

	const found = await context(document, sheet)

	if ("reason" in found) return { refused: found }

	await document.engineBeforeRows(changes)

	const { model, tables } = found
	const target = targetAt(filterTargets(document, model, tables), row, col)

	if (target === undefined) return { refused: { reason: "unsupported", detail: "noFilter" } }

	const all = criteriaOf(
		document,
		{ ...target.filter, columns: target.filter.columns.filter(column => target.range.startCol + column.colId !== col) },
		target.range
	)

	if ("reason" in all) return { refused: all }

	if (criteria === null) all.delete(col)
	else all.set(col, criteria)

	const own = target.filter.columns.find(column => target.range.startCol + column.colId === col)

	if (criteria === null && own === undefined) return null

	const markup = filterWith(document, model, target.filter, target.filter.prefix, target.range, new Map([[col, criteria]]))
	const parts = filterEdit(document, model, target, markup, all)

	return "reason" in parts ? { refused: parts } : editStep(document, model, parts, changes)
}

async function clearFilter(
	document: XlsxDocument,
	sheet: SheetId,
	row: number,
	col: number,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const found = await context(document, sheet)

	if ("reason" in found) return { refused: found }

	await document.engineBeforeRows(changes)

	const { model, tables } = found
	const target = targetAt(filterTargets(document, model, tables), row, col)

	if (target === undefined) return { refused: { reason: "unsupported", detail: "noFilter" } }

	const clear = new Map<number, SheetFilterCriteria | null>()

	for (const column of target.filter.columns)
		if (column.criteria !== null || column.unknown) clear.set(target.range.startCol + column.colId, null)

	const markup = filterWith(document, model, target.filter, target.filter.prefix, target.range, clear)
	const parts = filterEdit(document, model, target, markup, new Map())

	return "reason" in parts ? { refused: parts } : editStep(document, model, parts, changes)
}

async function reapplyFilter(
	document: XlsxDocument,
	sheet: SheetId,
	row: number,
	col: number,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const found = await context(document, sheet)

	if ("reason" in found) return { refused: found }

	await document.engineBeforeRows(changes)

	const { model, tables } = found
	const target = targetAt(filterTargets(document, model, tables), row, col)

	if (target === undefined) return { refused: { reason: "unsupported", detail: "noFilter" } }

	const all = criteriaOf(document, target.filter, target.range)

	if ("reason" in all) return { refused: all }

	// Dynamic periods, averages and thresholds are worked out again, as of now; the rest stays as written.
	const renewed = new Map([...all].filter(([, criteria]) => criteria.kind === "top10" || criteria.kind === "dynamic"))
	const markup = filterWith(document, model, target.filter, target.filter.prefix, target.range, renewed)
	const parts = filterEdit(document, model, target, markup, all)

	if ("reason" in parts) return { refused: parts }

	return emptyEdit(parts) ? null : editStep(document, model, parts, changes)
}

// --- The values list ---

function dominantKind(numbers: number, dates: number, texts: number): "text" | "number" | "date" {
	if (dates > 0 && dates >= numbers - dates && dates >= texts) return "date"
	if (numbers > texts) return "number"

	return "text"
}

async function filterValues(
	document: XlsxDocument,
	sheet: SheetId,
	row: number,
	col: number,
	limit: number
): Promise<SheetFilterValues | null> {
	// A sheet an edit took away while the request was on its way has no filter.
	if (document.entry(sheet) === undefined) return null

	const found = await context(document, sheet)

	if ("reason" in found) return null

	const { model, tables } = found
	const target = targetAt(filterTargets(document, model, tables), row, col)

	if (target === undefined) return null

	const store = model.store as SheetStore
	const range = target.range
	const own = target.filter.columns.find(column => range.startCol + column.colId === col)
	const others = criteriaOf(document, { ...target.filter, columns: target.filter.columns.filter(column => column !== own) }, range)
	const otherTests =
		"reason" in others
			? []
			: columnTests(
					document,
					model,
					range,
					[...others].map(([c, criteria]) => ({ col: c, criteria }))
				)
	const shown =
		"reason" in otherTests || otherTests.length === 0
			? new Uint8Array(range.endRow - range.startRow).fill(1)
			: passing(document, model, range, otherTests)
	const criteria = own?.criteria ?? null
	const resolved = own === undefined ? null : criteriaOf(document, { ...target.filter, columns: [own] }, range)
	const ownTests =
		criteria === null || resolved === null || "reason" in resolved
			? null
			: columnTests(document, model, range, [{ col, criteria: resolved.get(col) ?? criteria }])
	const test = ownTests === null || "reason" in ownTests ? null : (ownTests[0]?.test ?? null)
	const calendar = calendarOf(document.date1904)
	const seen = new Map<string, { value: SortValue; item: SheetFilterItem }>()
	let blanks = 0
	let blankChecked = criteria === null
	let numbers = 0
	let dates = 0
	let texts = 0
	let present = 0
	let more = false

	store.forEachCell({ startRow: range.startRow + 1, endRow: range.endRow, startCol: col, endCol: col }, (r, _, slot) => {
		if (shown[r - range.startRow - 1] === 0) return

		const cell = readCell(document, model, r, col, slot, true)

		present++

		if (cell.type === SortType.BLANK) {
			blanks++

			return
		}

		if (cell.type === SortType.NUMBER) {
			numbers++

			if (cell.date) dates++
		} else texts++

		const key = cell.text.toLowerCase()

		if (seen.has(key)) return

		if (seen.size >= limit) {
			more = true

			return
		}

		const checked = test === null ? true : test.passes(cell, own => cellColor(document, model, r, col, slot, own))
		const parts = cell.date ? calendar(cell.number) : null
		const item: SheetFilterItem =
			parts === null
				? { text: cell.text, checked }
				: { text: cell.text, checked, date: { year: parts.year, month: parts.month, day: parts.day } }

		seen.set(key, { value: sortValueOf(cell, false), item })
	})

	// Rows the store holds no cell for in the column are blank too.
	let shownRows = 0

	for (const value of shown) shownRows += value

	blanks += shownRows - present

	if (blanks > 0 && test !== null) blankChecked = test.passes(BLANK_CELL)

	const items = [...seen.values()].sort((a, b) => compareSortValues(a.value, b.value, false)).map(entry => entry.item)
	const header = document.cellView(sheet, range.startRow, col).text
	const sortCondition = target.filter.sort?.conditions[0]
	const sorted =
		sortCondition !== undefined && sortCondition.ref.startCol === col && sortCondition.ref.endCol === col
			? sortCondition.descending
				? "descending"
				: "ascending"
			: null

	return {
		table: target.table?.info.name ?? null,
		range,
		header,
		items,
		blank: blanks > 0 ? { checked: blankChecked } : null,
		more,
		criteria,
		unknown: own?.unknown === true,
		kind: dominantKind(numbers, dates, texts),
		sorted
	}
}

// --- Layout ---

function buttonsOf(target: FilterTarget): Uint8Array {
	const width = target.range.endCol - target.range.startCol + 1
	const buttons = new Uint8Array(width).fill(FilterButton.SHOWN)

	for (const column of target.filter.columns) {
		if (column.colId >= width) continue

		let bits = column.hiddenButton || !column.showButton ? 0 : FilterButton.SHOWN

		if (column.criteria !== null || column.unknown) bits |= FilterButton.FILTERED

		buttons[column.colId] = bits
	}

	const sort = target.filter.sort

	for (const condition of sort?.conditions ?? []) {
		if (sort?.columnSort === true || condition.ref.startCol !== condition.ref.endCol) continue

		const at = condition.ref.startCol - target.range.startCol

		if (at >= 0 && at < width)
			buttons[at] = (buttons[at] ?? 0) | (condition.descending ? FilterButton.DESCENDING : FilterButton.ASCENDING)
	}

	return buttons
}

function filterLayout(context: SheetReadContext<XlsxDocument>, sheet: SheetId): SheetFilterLayout | undefined {
	const document = context.doc
	const model = document.model(sheet) ?? document.previews.get(sheet)?.model ?? null

	if (model === null) return undefined

	const tables = cacheOf(document).loaded.get(sheet) === true ? (tablesNow(document, model) ?? []) : []
	const targets = filterTargets(document, model, tables)

	if (targets.length === 0) return undefined

	return {
		ranges: targets.map(target => ({ table: target.table?.info.name ?? null, range: target.range, buttons: buttonsOf(target) }))
	}
}

// --- Feature ---

export const filterFeature = defineSheetFeature<XlsxDocument>({
	id: "filter",
	commands: {
		"filter.toggle": {
			info: { write: true },
			run: (context, command) => toggleFilter(context.doc, command.sheet, command.range, command.active, context.changes)
		},
		"filter.column": {
			info: { write: true, protection: "autoFilter" },
			run: (context, command) => setColumn(context.doc, command.sheet, command.row, command.col, command.criteria, context.changes)
		},
		"filter.clear": {
			info: { write: true, protection: "autoFilter" },
			run: (context, command) => clearFilter(context.doc, command.sheet, command.row, command.col, context.changes)
		},
		"filter.reapply": {
			info: { write: true, protection: "autoFilter" },
			run: (context, command) => reapplyFilter(context.doc, command.sheet, command.row, command.col, context.changes)
		}
	},
	queries: {
		"filter.values": {
			run: (context, request) =>
				filterValues(
					context.doc,
					request.sheet,
					request.row,
					request.col,
					Math.max(1, Math.min(MAX_FILTER_VALUES, Math.floor(request.limit)))
				)
		}
	},
	ready: async (context, sheet) => {
		trackFilteredRows(context.doc)

		const model = await context.doc.ready(sheet, context.slicing, context.signal)
		const tables = await loadTables(context.doc, model)

		return { ranges: [], layout: tables.some(table => table.filter !== null) }
	},
	layout: { filters: filterLayout }
})

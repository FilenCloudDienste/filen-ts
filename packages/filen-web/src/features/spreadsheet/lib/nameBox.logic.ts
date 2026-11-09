import {
	SHEET_MAX_COLS,
	SHEET_MAX_ROWS,
	cellName,
	columnIndex,
	type SheetId,
	type SheetQueryResult,
	type SheetRange,
	type SheetSummary
} from "@filen/office/core/sheet"
import { cellSelection, extendSelection, singleCell, type GridSelection } from "@filen/office/react/sheet"

export type NameBoxDefinedNames = SheetQueryResult<"names.list">

// What the name box was given: a reference (a cell, a range from either corner, whole columns "A:C" or rows "1:3",
// "$" allowed) or a defined name, either one after a sheet name ("Sheet2!A1", "'My sheet'!B2"). null for anything
// else.
export type NameBoxTarget =
	| { readonly kind: "range"; readonly sheet: string | null; readonly range: SheetRange }
	| { readonly kind: "name"; readonly sheet: string | null; readonly name: string }

// Where it goes: a range on a worksheet.
export interface NameBoxPlace {
	readonly sheet: SheetId
	readonly range: SheetRange
}

const CELL = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/
const COLUMN = /^\$?([A-Za-z]{1,3})$/
const ROW = /^\$?([0-9]{1,7})$/
// A cell's shape, in or past the grid: never a name.
const CELL_SHAPED = /^\$?[A-Za-z]{1,3}\$?[0-9]+$/
// Excel's defined-name characters: a letter, "_" or "\" first, then letters, digits, "_", "." and "\".
const NAME = /^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u
// A built-in name's prefix in the file; Excel shows and takes it without ("Print_Area").
const BUILT_IN = "_xlnm."
// How many names one name may go through (one naming another) before it counts as naming nothing.
const MAX_NAME_DEPTH = 4

function cell(text: string): { row: number; col: number } | null {
	const match = CELL.exec(text)

	if (match === null) {
		return null
	}

	const col = columnIndex(match[1] ?? "")
	const row = Number(match[2]) - 1

	return row >= 0 && row < SHEET_MAX_ROWS && col >= 0 && col < SHEET_MAX_COLS ? { row, col } : null
}

function column(text: string): number | null {
	const match = COLUMN.exec(text)

	if (match === null) {
		return null
	}

	const col = columnIndex(match[1] ?? "")

	return col >= 0 && col < SHEET_MAX_COLS ? col : null
}

function row(text: string): number | null {
	const match = ROW.exec(text)

	if (match === null) {
		return null
	}

	const index = Number(match[1]) - 1

	return index >= 0 && index < SHEET_MAX_ROWS ? index : null
}

function span(startRow: number, startCol: number, endRow: number, endCol: number): SheetRange {
	return {
		startRow: Math.min(startRow, endRow),
		startCol: Math.min(startCol, endCol),
		endRow: Math.max(startRow, endRow),
		endCol: Math.max(startCol, endCol)
	}
}

function reference(text: string): SheetRange | null {
	const parts = text.split(":")

	if (parts.length > 2) {
		return null
	}

	const first = parts[0] ?? ""

	if (parts.length === 1) {
		const point = cell(first)

		return point === null ? null : span(point.row, point.col, point.row, point.col)
	}

	const second = parts[1] ?? ""
	const start = cell(first)
	const end = cell(second)

	if (start !== null && end !== null) {
		return span(start.row, start.col, end.row, end.col)
	}

	const startCol = column(first)
	const endCol = column(second)

	if (startCol !== null && endCol !== null) {
		return span(0, startCol, SHEET_MAX_ROWS - 1, endCol)
	}

	const startRow = row(first)
	const endRow = row(second)

	return startRow !== null && endRow !== null ? span(startRow, 0, endRow, SHEET_MAX_COLS - 1) : null
}

// The last "!" outside a quoted sheet name, -1 for none.
function sheetSeparator(text: string): number {
	let quoted = false
	let found = -1

	for (let k = 0; k < text.length; k++) {
		const char = text[k]

		if (char === "'") {
			quoted = !quoted
		} else if (char === "!" && !quoted) {
			found = k
		}
	}

	return found
}

// A sheet name as a reference writes it: quoted with "''" for a quote, or bare. null when it is neither.
function sheetName(text: string): string | null {
	if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
		const inner = text.slice(1, -1)

		return inner === "" || /'(?!')/.test(inner.replaceAll("''", "")) ? null : inner.replaceAll("''", "'")
	}

	return text === "" || /['\s]/.test(text) ? null : text
}

export function parseNameBox(input: string): NameBoxTarget | null {
	const text = input.trim()
	const bang = sheetSeparator(text)
	const sheet = bang < 0 ? null : sheetName(text.slice(0, bang))

	if (bang >= 0 && sheet === null) {
		return null
	}

	const rest = bang < 0 ? text : text.slice(bang + 1)
	const range = reference(rest)

	if (range !== null) {
		return { kind: "range", sheet, range }
	}

	return NAME.test(rest) && !CELL_SHAPED.test(rest) ? { kind: "name", sheet, name: rest } : null
}

function shownName(name: string): string {
	return name.startsWith(BUILT_IN) ? name.slice(BUILT_IN.length) : name
}

function worksheetNamed(sheets: readonly SheetSummary[], name: string): SheetSummary | undefined {
	const upper = name.toUpperCase()

	return sheets.find(entry => entry.name.toUpperCase() === upper)
}

function resolve(
	target: NameBoxTarget,
	own: SheetId,
	sheets: readonly SheetSummary[],
	names: NameBoxDefinedNames,
	depth: number
): NameBoxPlace | null {
	let scope = own

	if (target.sheet !== null) {
		const named = worksheetNamed(sheets, target.sheet)

		if (named?.kind !== "worksheet") {
			return null
		}

		scope = named.id
	}

	if (target.kind === "range") {
		return { sheet: scope, range: target.range }
	}

	if (depth >= MAX_NAME_DEPTH) {
		return null
	}

	const upper = target.name.toUpperCase()
	const matches = (entry: NameBoxDefinedNames[number]) => shownName(entry.name).toUpperCase() === upper
	// A sheet's own name before the workbook's; "Sheet2!Name" names only Sheet2's own.
	const defined =
		names.find(entry => entry.sheet === scope && matches(entry)) ??
		(target.sheet === null ? names.find(entry => entry.sheet === null && matches(entry)) : undefined)

	if (defined === undefined) {
		return null
	}

	const formula = defined.formula.trim()
	const refers = parseNameBox(formula.startsWith("=") ? formula.slice(1) : formula)

	return refers === null ? null : resolve(refers, defined.sheet ?? scope, sheets, names, depth + 1)
}

// Where a target goes from sheet `own`: its sheet found whatever its case (a worksheet; a chartsheet's or a missing
// sheet's is nowhere), a name looked up as Excel does (the sheet's own, then the workbook's) and followed to one area
// of a worksheet. null for nowhere.
export function resolveNameBox(
	target: NameBoxTarget,
	own: SheetId,
	sheets: readonly SheetSummary[],
	names: NameBoxDefinedNames
): NameBoxPlace | null {
	return resolve(target, own, sheets, names, 0)
}

// The names the box's list offers on sheet `own`, sorted as Excel sorts them: the workbook's and the sheet's own (which
// hides a workbook name it shares), those that name one area of a worksheet.
export function nameBoxNames(own: SheetId, sheets: readonly SheetSummary[], names: NameBoxDefinedNames): string[] {
	const listed = new Map<string, string>()

	for (const entry of names) {
		if (entry.sheet !== null && entry.sheet !== own) {
			continue
		}

		const name = shownName(entry.name)
		const key = name.toUpperCase()

		if (!listed.has(key) && resolve({ kind: "name", sheet: null, name }, own, sheets, names, 0) !== null) {
			listed.set(key, name)
		}
	}

	return [...listed.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
}

// The selection a place makes: its range grown to the merges it cuts, the active cell its top left.
export function nameBoxSelection(range: SheetRange, merges: readonly SheetRange[]): GridSelection {
	const start = { row: range.startRow, col: range.startCol }
	const grown = extendSelection(cellSelection(start, merges), { row: range.endRow, col: range.endCol }, merges)
	const last = grown.ranges[grown.ranges.length - 1] ?? range
	const active = { row: last.startRow, col: last.startCol }

	return { ...grown, active, anchor: active }
}

// What the box shows: the active cell, as Excel's Name Box shows it (a merge by its top-left cell).
export function nameBoxShown(selection: GridSelection): string {
	const last = selection.ranges[selection.ranges.length - 1]

	return singleCell(selection) && last !== undefined
		? cellName(last.startRow, last.startCol)
		: cellName(selection.active.row, selection.active.col)
}

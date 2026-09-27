import { columnName } from "@/features/spreadsheet/lib/cellRef.logic"
import { MAX_COLS, MAX_ROWS } from "@/features/spreadsheet/lib/edits"

// Cell references inside Excel formula text, found and rewritten without evaluating anything: filling a
// shared formula down, moving references for inserted or deleted rows and columns, renaming a sheet. The
// text is Excel's own (as stored in the file, without the "="). String literals, structured table
// references and function names that look like cells (LOG10) are never taken for references, and a
// reference into another workbook is never touched.

export interface RefArea {
	// "cell": A1 or A1:B2; "cols": A:C; "rows": 1:3. Indices are 0-based; the axis a whole-row or
	// whole-column range does not name is 0.
	kind: "cell" | "cols" | "rows"
	range: boolean
	startRow: number
	startCol: number
	endRow: number
	endCol: number
	startRowAbs: boolean
	startColAbs: boolean
	endRowAbs: boolean
	endColAbs: boolean
}

export interface FormulaRef {
	// The sheet the reference names, null when it names none (the formula's own sheet). A 3D reference
	// (Jan:Mar!A1) names a first and a last one.
	sheet: string | null
	lastSheet: string | null
	// Into another workbook ([1]Sheet1!A1).
	external: boolean
	// null when the sheet prefix is followed by something else: a sheet-scoped name, #REF!.
	area: RefArea | null
}

interface RefPart {
	ref: FormulaRef
	prefix: string
	areaText: string
}

type Part = string | RefPart

export interface AxisEdit {
	type: "insert" | "delete"
	axis: "rows" | "cols"
	at: number
	count: number
}

const QUOTE = 34
const APOSTROPHE = 39
const HASH = 35
const BRACKET_OPEN = 91
const BRACKET_CLOSE = 93

function isWordChar(code: number): boolean {
	return (
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		(code >= 48 && code <= 57) ||
		code === 95 || // _
		code === 46 || // .
		code === 36 || // $
		code === 92 || // \
		code === 63 || // ?
		code >= 128
	)
}

function readWord(text: string, start: number): number {
	let end = start

	while (end < text.length && isWordChar(text.charCodeAt(end))) end++

	return end
}

// Past a quoted run ("…" or '…', the quote doubled inside), or the end of the text when it never closes.
function skipQuoted(text: string, start: number, quote: number): number {
	let index = start + 1

	while (index < text.length) {
		if (text.charCodeAt(index) === quote) {
			if (text.charCodeAt(index + 1) === quote) {
				index += 2

				continue
			}

			return index + 1
		}

		index++
	}

	return text.length
}

// Past a bracketed run, nested brackets included; inside a structured reference "'" escapes the next
// character.
function skipBracket(text: string, start: number): number {
	let depth = 0
	let index = start

	while (index < text.length) {
		const code = text.charCodeAt(index)

		if (code === APOSTROPHE) {
			index += 2

			continue
		}

		if (code === BRACKET_OPEN) depth++

		if (code === BRACKET_CLOSE) {
			depth--

			if (depth === 0) {
				return index + 1
			}
		}

		index++
	}

	return text.length
}

function skipError(text: string, start: number): number {
	let index = start + 1

	while (index < text.length) {
		const code = text.charCodeAt(index)

		if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 47) {
			index++
		} else {
			break
		}
	}

	const last = text.charCodeAt(index)

	return last === 33 || last === 63 ? index + 1 : index
}

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/
const COLUMN = /^(\$?)([A-Za-z]{1,3})$/
const ROW = /^(\$?)([0-9]{1,7})$/

function columnIndex(letters: string): number {
	let index = 0

	for (let position = 0; position < letters.length; position++) {
		index = index * 26 + (letters.toUpperCase().charCodeAt(position) - 64)
	}

	return index - 1
}

interface Point {
	kind: "cell" | "cols" | "rows"
	row: number
	col: number
	rowAbs: boolean
	colAbs: boolean
}

function point(word: string): Point | null {
	const cell = CELL.exec(word)

	if (cell !== null) {
		const [, colAbs = "", letters = "", rowAbs = "", digits = ""] = cell
		const col = columnIndex(letters)
		const row = Number(digits) - 1

		return col < MAX_COLS && row >= 0 && row < MAX_ROWS
			? { kind: "cell", row, col, rowAbs: rowAbs === "$", colAbs: colAbs === "$" }
			: null
	}

	const column = COLUMN.exec(word)

	if (column !== null) {
		const [, colAbs = "", letters = ""] = column
		const col = columnIndex(letters)

		return col < MAX_COLS ? { kind: "cols", row: 0, col, rowAbs: false, colAbs: colAbs === "$" } : null
	}

	const row = ROW.exec(word)

	if (row !== null) {
		const [, rowAbs = "", digits = ""] = row
		const index = Number(digits) - 1

		return index >= 0 && index < MAX_ROWS ? { kind: "rows", row: index, col: 0, rowAbs: rowAbs === "$", colAbs: false } : null
	}

	return null
}

// What a reference cannot be followed by: a call, a table's brackets, a sheet's "!".
function endsReference(text: string, end: number): boolean {
	const code = text.charCodeAt(end)

	return code !== 40 && code !== BRACKET_OPEN && code !== 33
}

function parseArea(text: string, start: number): { area: RefArea; end: number } | null {
	const firstEnd = readWord(text, start)
	const first = point(text.slice(start, firstEnd))

	if (first === null) {
		return null
	}

	if (text.charCodeAt(firstEnd) === 58) {
		const secondEnd = readWord(text, firstEnd + 1)
		const second = secondEnd > firstEnd + 1 ? point(text.slice(firstEnd + 1, secondEnd)) : null

		if (second?.kind === first.kind && endsReference(text, secondEnd)) {
			return {
				area: {
					kind: first.kind,
					range: true,
					startRow: first.row,
					startCol: first.col,
					endRow: second.row,
					endCol: second.col,
					startRowAbs: first.rowAbs,
					startColAbs: first.colAbs,
					endRowAbs: second.rowAbs,
					endColAbs: second.colAbs
				},
				end: secondEnd
			}
		}
	}

	if (first.kind !== "cell" || !endsReference(text, firstEnd)) {
		return null
	}

	return {
		area: {
			kind: "cell",
			range: false,
			startRow: first.row,
			startCol: first.col,
			endRow: first.row,
			endCol: first.col,
			startRowAbs: first.rowAbs,
			startColAbs: first.colAbs,
			endRowAbs: first.rowAbs,
			endColAbs: first.colAbs
		},
		end: firstEnd
	}
}

// The formula as text and the references in it, in order.
export function formulaParts(text: string): Part[] {
	const parts: Part[] = []
	let pending = 0
	let index = 0

	const emit = (
		prefixStart: number,
		areaStart: number,
		sheet: string | null,
		lastSheet: string | null,
		external: boolean,
		parsed = parseArea(text, areaStart)
	): number => {
		const end = parsed?.end ?? areaStart

		if (prefixStart > pending) {
			parts.push(text.slice(pending, prefixStart))
		}

		parts.push({
			ref: { sheet, lastSheet, external, area: parsed?.area ?? null },
			prefix: text.slice(prefixStart, areaStart),
			areaText: text.slice(areaStart, end)
		})
		pending = end

		return end
	}

	while (index < text.length) {
		const code = text.charCodeAt(index)

		if (code === QUOTE) {
			index = skipQuoted(text, index, QUOTE)
		} else if (code === APOSTROPHE) {
			const end = skipQuoted(text, index, APOSTROPHE)

			if (text.charCodeAt(end) !== 33) {
				index = end

				continue
			}

			const name = text.slice(index + 1, end - 1).replaceAll("''", "'")
			// Sheet names cannot hold ":", so one here spans sheets.
			const colon = name.indexOf(":")

			index = emit(
				index,
				end + 1,
				colon < 0 ? name : name.slice(0, colon),
				colon < 0 ? null : name.slice(colon + 1),
				name.startsWith("[")
			)
		} else if (code === BRACKET_OPEN) {
			const end = skipBracket(text, index)
			const wordEnd = readWord(text, end)

			// [1]Sheet1!A1: a sheet of another workbook.
			index =
				wordEnd > end && text.charCodeAt(wordEnd) === 33 ? emit(index, wordEnd + 1, text.slice(index, wordEnd), null, true) : end
		} else if (code === HASH) {
			index = skipError(text, index)
		} else if (isWordChar(code)) {
			const end = readWord(text, index)
			const next = text.charCodeAt(end)

			if (next === 33) {
				index = emit(index, end + 1, text.slice(index, end), null, false)
			} else if (next === 40) {
				index = end
			} else if (next === BRACKET_OPEN) {
				index = skipBracket(text, end)
			} else {
				const lastEnd = next === 58 ? readWord(text, end + 1) : end

				if (lastEnd > end + 1 && text.charCodeAt(lastEnd) === 33) {
					index = emit(index, lastEnd + 1, text.slice(index, end), text.slice(end + 1, lastEnd), false)
				} else {
					const parsed = parseArea(text, index)

					index = parsed === null ? end : emit(index, index, null, null, false, parsed)
				}
			}
		} else {
			index++
		}
	}

	if (pending < text.length) {
		parts.push(text.slice(pending))
	}

	return parts
}

function cellText(row: number, col: number, rowAbs: boolean, colAbs: boolean): string {
	return `${colAbs ? "$" : ""}${columnName(col)}${rowAbs ? "$" : ""}${String(row + 1)}`
}

function areaText(area: RefArea): string {
	switch (area.kind) {
		case "cols":
			return `${area.startColAbs ? "$" : ""}${columnName(area.startCol)}:${area.endColAbs ? "$" : ""}${columnName(area.endCol)}`
		case "rows":
			return `${area.startRowAbs ? "$" : ""}${String(area.startRow + 1)}:${area.endRowAbs ? "$" : ""}${String(area.endRow + 1)}`
		case "cell": {
			const start = cellText(area.startRow, area.startCol, area.startRowAbs, area.startColAbs)

			return area.range ? `${start}:${cellText(area.endRow, area.endCol, area.endRowAbs, area.endColAbs)}` : start
		}
	}
}

const PLAIN_NAME = /^[A-Za-z_¡-￿][A-Za-z0-9_.¡-￿]*$/
const R1C1 = /^[Rr][0-9]*[Cc][0-9]*$/

function needsQuotes(name: string): boolean {
	return !PLAIN_NAME.test(name) || point(name) !== null || R1C1.test(name) || /^(TRUE|FALSE)$/i.test(name)
}

// A sheet named in a formula: Data!, 'Bob''s Data'!, Jan:Mar!.
export function sheetPrefix(sheet: string, lastSheet: string | null = null): string {
	const name = lastSheet === null ? sheet : `${sheet}:${lastSheet}`

	return needsQuotes(sheet) || (lastSheet !== null && needsQuotes(lastSheet)) ? `'${name.replaceAll("'", "''")}'!` : `${name}!`
}

// The formula with each reference `visit` returns something for replaced: a changed reference, or null
// for #REF!. undefined keeps the reference as written.
function render(parts: readonly Part[], visit: (ref: FormulaRef) => FormulaRef | null | undefined): string {
	let text = ""

	for (const part of parts) {
		if (typeof part === "string") {
			text += part

			continue
		}

		const next = visit(part.ref)

		if (next === undefined) {
			text += part.prefix + part.areaText
		} else if (next === null) {
			text += `${part.prefix}#REF!`
		} else {
			const prefix =
				next.sheet === part.ref.sheet && next.lastSheet === part.ref.lastSheet
					? part.prefix
					: next.sheet === null
						? ""
						: sheetPrefix(next.sheet, next.lastSheet)

			text += prefix + (next.area === part.ref.area || next.area === null ? part.areaText : areaText(next.area))
		}
	}

	return text
}

export function rewriteFormula(formula: string, visit: (ref: FormulaRef) => FormulaRef | null | undefined): string {
	return render(formulaParts(formula), visit)
}

// A shared formula's text for a cell `rows` down and `cols` right of the one that stores it: relative
// references move, absolute ones stay, and one pushed off the sheet becomes #REF!. Parses once for many
// cells.
export function formulaTranslator(formula: string): (rows: number, cols: number) => string {
	const parts = formulaParts(formula)

	return (rows, cols) =>
		render(parts, ref => {
			const area = ref.area

			if (area === null || (rows === 0 && cols === 0)) {
				return undefined
			}

			const moveRows = area.kind !== "cols"
			const moveCols = area.kind !== "rows"
			const next: RefArea = {
				...area,
				startRow: moveRows && !area.startRowAbs ? area.startRow + rows : area.startRow,
				endRow: moveRows && !area.endRowAbs ? area.endRow + rows : area.endRow,
				startCol: moveCols && !area.startColAbs ? area.startCol + cols : area.startCol,
				endCol: moveCols && !area.endColAbs ? area.endCol + cols : area.endCol
			}

			if (
				Math.min(next.startRow, next.endRow, next.startCol, next.endCol) < 0 ||
				Math.max(next.startRow, next.endRow) >= MAX_ROWS ||
				Math.max(next.startCol, next.endCol) >= MAX_COLS
			) {
				return null
			}

			return { ...ref, area: next }
		})
}

function sameSheet(a: string, b: string): boolean {
	return a === b || a.toUpperCase() === b.toUpperCase()
}

// One axis of an area moved for an insert or delete: null when the deletion takes all of it.
function shiftSpan(start: number, end: number, edit: AxisEdit, limit: number, range: boolean): [number, number] | null {
	if (edit.type === "insert") {
		const nextStart = start >= edit.at ? start + edit.count : start
		let nextEnd = end >= edit.at ? end + edit.count : end

		if (nextEnd >= limit) {
			// Pushed off the sheet: a range keeps what is left of it, a cell is lost.
			if (!range || nextStart >= limit) {
				return null
			}

			nextEnd = limit - 1
		}

		return [nextStart, nextEnd]
	}

	const removedBefore = (index: number) => Math.max(0, Math.min(index, edit.at + edit.count) - edit.at)

	if (start >= edit.at && end < edit.at + edit.count) {
		return null
	}

	return [start - removedBefore(start), end - removedBefore(end + 1)]
}

// A reference's area after rows or columns of the sheet it points into were inserted or deleted: the
// same object when nothing moved, null when it was deleted.
export function shiftArea(area: RefArea, edit: AxisEdit): RefArea | null {
	const rowsAxis = edit.axis === "rows"

	if ((rowsAxis && area.kind === "cols") || (!rowsAxis && area.kind === "rows")) {
		return area
	}

	const start = rowsAxis ? area.startRow : area.startCol
	const end = rowsAxis ? area.endRow : area.endCol
	const moved = shiftSpan(Math.min(start, end), Math.max(start, end), edit, rowsAxis ? MAX_ROWS : MAX_COLS, area.range)

	if (moved === null) {
		return null
	}

	const [nextStart, nextEnd] = start <= end ? moved : [moved[1], moved[0]]

	if (nextStart === start && nextEnd === end) {
		return area
	}

	return rowsAxis ? { ...area, startRow: nextStart, endRow: nextEnd } : { ...area, startCol: nextStart, endCol: nextEnd }
}

// Whether a deletion cuts into the area: an end of it lies in the deleted run, so inserting the run again
// does not bring the area back as it was.
function cut(area: RefArea, edit: AxisEdit): boolean {
	const rowsAxis = edit.axis === "rows"

	if (edit.type === "insert" || (rowsAxis && area.kind === "cols") || (!rowsAxis && area.kind === "rows")) {
		return false
	}

	const inRun = (index: number) => index >= edit.at && index < edit.at + edit.count

	return rowsAxis ? inRun(area.startRow) || inRun(area.endRow) : inRun(area.startCol) || inRun(area.endCol)
}

// A formula on `ownSheet` after rows or columns of `target` were inserted or deleted, and whether the
// deletion cut into one of its references. References into other workbooks and 3D references are left as
// written.
export function shiftFormula(formula: string, ownSheet: string, target: string, edit: AxisEdit): { formula: string; cut: boolean } {
	const own = sameSheet(ownSheet, target)
	let wasCut = false

	if (!own && !formula.includes("!")) {
		return { formula, cut: false }
	}

	const shifted = rewriteFormula(formula, ref => {
		if (ref.external || ref.lastSheet !== null || ref.area === null || !(ref.sheet === null ? own : sameSheet(ref.sheet, target))) {
			return undefined
		}

		wasCut ||= cut(ref.area, edit)

		const area = shiftArea(ref.area, edit)

		return area === ref.area ? undefined : area === null ? null : { ...ref, area }
	})

	return { formula: shifted, cut: wasCut }
}

// Whether the formula refers to sheet `name` (3D references by either end).
export function namesSheet(formula: string, name: string): boolean {
	if (!formula.includes("!")) {
		return false
	}

	return formulaParts(formula).some(
		part =>
			typeof part !== "string" &&
			!part.ref.external &&
			((part.ref.sheet !== null && sameSheet(part.ref.sheet, name)) ||
				(part.ref.lastSheet !== null && sameSheet(part.ref.lastSheet, name)))
	)
}

// A formula with every reference to sheet `from` naming `to` instead.
export function renameSheetInFormula(formula: string, from: string, to: string): string {
	if (!formula.includes("!")) {
		return formula
	}

	return rewriteFormula(formula, ref => {
		const first = ref.sheet !== null && sameSheet(ref.sheet, from)
		const last = ref.lastSheet !== null && sameSheet(ref.lastSheet, from)

		if (ref.external || (!first && !last)) {
			return undefined
		}

		return { ...ref, sheet: first ? to : ref.sheet, lastSheet: last ? to : ref.lastSheet }
	})
}

// Excel formula text as HyperFormula reads it, where only the spelling differs: function names lose the
// _xlfn./_xlws. prefixes files store for newer functions, TRUE and FALSE become the functions HyperFormula
// has for them, exponents take a lower-case "e", and a string literal with a doubled quote is spelled
// with CHAR(34) (HyperFormula has no escape for it; inside an array constant it is left to fail). What
// HyperFormula still cannot read (intersections, unions, structured and external references) fails to
// parse there, and the caller keeps the file's own result.
export function engineFormula(formula: string): string {
	let text = ""
	let braces = 0
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE) {
			const end = skipQuoted(formula, index, QUOTE)
			const literal = formula.slice(index, end)

			text +=
				braces === 0 && literal.length > 2 && literal.slice(1, -1).includes('""')
					? `(${literal
							.slice(1, -1)
							.split('""')
							.map(piece => `"${piece}"`)
							.join("&CHAR(34)&")})`
					: literal
			index = end
		} else if (code === APOSTROPHE) {
			const end = skipQuoted(formula, index, APOSTROPHE)

			text += formula.slice(index, end)
			index = end
		} else if (code === BRACKET_OPEN) {
			const end = skipBracket(formula, index)

			text += formula.slice(index, end)
			index = end
		} else if (code === HASH) {
			const end = skipError(formula, index)

			text += formula.slice(index, end)
			index = end
		} else if (isWordChar(code)) {
			const end = readWord(formula, index)
			const word = formula.slice(index, end)
			const next = formula.charCodeAt(end)

			if (next === 40) {
				text += word.replace(/^(?:_xlfn\.|_xlws\.)+/i, "")
			} else if (/^(\d+\.?\d*|\.\d+)E$/i.test(word) && (next === 43 || next === 45)) {
				text += `${word.slice(0, -1)}e`
			} else if (/^(\d+\.?\d*|\.\d+)E\d+$/i.test(word)) {
				text += word.replace(/E/i, "e")
			} else if (next !== 33 && next !== 58 && /^(TRUE|FALSE)$/i.test(word)) {
				text += `${word}()`
			} else {
				text += word
			}

			index = end
		} else {
			if (code === 123) braces++
			if (code === 125) braces--

			text += formula[index] ?? ""
			index++
		}
	}

	return text
}

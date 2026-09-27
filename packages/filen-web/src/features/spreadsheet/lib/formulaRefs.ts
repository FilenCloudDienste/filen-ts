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

const PLAIN_NAME = /^[\p{L}_][\p{L}\p{N}_.]*$/u
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

// Functions newer than the file format's first version, which a file names with a prefix (Excel reads the
// bare name as unknown, #NAME?). FILTER and SORT belong to the worksheet-function namespace besides.
const FUTURE_FUNCTIONS = new Set(
	(
		"ACOT ACOTH AGGREGATE ARABIC ARRAYTOTEXT BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV BITAND " +
		"BITLSHIFT BITOR BITRSHIFT BITXOR BYCOL BYROW CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV " +
		"CHISQ.INV.RT CHISQ.TEST CHOOSECOLS CHOOSEROWS COMBINA CONCAT CONFIDENCE.NORM CONFIDENCE.T COT COTH " +
		"COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL DROP ENCODEURL ERF.PRECISE ERFC.PRECISE EXPAND EXPON.DIST " +
		"F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FILTERXML FLOOR.MATH FLOOR.PRECISE FORECAST.ETS FORECAST.ETS.CONFINT " +
		"FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT FORECAST.LINEAR FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV " +
		"GAMMALN.PRECISE GAUSS GROUPBY HSTACK HYPGEOM.DIST IFNA IFS IMAGE IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH " +
		"IMSINH IMTAN ISFORMULA ISOMITTED ISOWEEKNUM LAMBDA LET LOGNORM.DIST LOGNORM.INV MAKEARRAY MAP MAXIFS MINIFS " +
		"MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION " +
		"PERCENTILE.EXC PERCENTILE.INC PERCENTOF PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI PIVOTBY " +
		"POISSON.DIST QUARTILE.EXC QUARTILE.INC RANDARRAY RANK.AVG RANK.EQ REDUCE REGEXEXTRACT REGEXREPLACE " +
		"REGEXTEST RRI SCAN SEC SECH SEQUENCE SHEET SHEETS SINGLE SKEW.P SORTBY STDEV.P STDEV.S SWITCH T.DIST " +
		"T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST TAKE TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT TOCOL TOROW " +
		"TRIMRANGE UNICHAR UNICODE UNIQUE VALUETOTEXT VAR.P VAR.S VSTACK WEBSERVICE WEIBULL.DIST WRAPCOLS WRAPROWS " +
		"XLOOKUP XMATCH XOR Z.TEST"
	).split(" ")
)
const WORKSHEET_FUNCTIONS = new Set(["FILTER", "SORT"])

function prefixOf(name: string): string | null {
	const upper = name.toUpperCase()

	if (WORKSHEET_FUNCTIONS.has(upper)) return "_xlfn._xlws."
	if (FUTURE_FUNCTIONS.has(upper)) return "_xlfn."

	return null
}

// Rewrites each function name in a formula (outside strings, quoted sheet names and brackets).
function mapFunctionNames(formula: string, map: (name: string) => string): string {
	let text = ""
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			const end = skipQuoted(formula, index, code)

			text += formula.slice(index, end)
			index = end
		} else if (code === BRACKET_OPEN) {
			const end = skipBracket(formula, index)

			text += formula.slice(index, end)
			index = end
		} else if (isWordChar(code)) {
			const end = readWord(formula, index)
			const word = formula.slice(index, end)

			text += formula.charCodeAt(end) === 40 ? map(word) : word
			index = end
		} else {
			text += formula[index] ?? ""
			index++
		}
	}

	return text
}

// A typed formula as a file stores it: newer functions with the prefix Excel requires.
export function storedFormula(formula: string): string {
	return mapFunctionNames(formula, name => {
		if (name.startsWith("_")) return name

		const prefix = prefixOf(name)

		return prefix === null ? name : `${prefix}${name.toUpperCase()}`
	})
}

// A stored formula as the user reads and edits it: known prefixes left out (storedFormula puts them back).
// A prefix on a function it does not know stays, so nothing is lost by editing.
export function shownFormula(formula: string): string {
	if (!formula.includes("_xl")) return formula

	return mapFunctionNames(formula, name => {
		const bare = name.replace(/^(?:_xlfn\.)?(?:_xlws\.)?/i, "")
		const prefix = prefixOf(bare)

		return prefix !== null && name.toLowerCase() === `${prefix}${bare}`.toLowerCase() ? bare : name
	})
}

// Parentheses past this depth overflow HyperFormula's recursive parser (Excel stops at 64 levels).
const MAX_DEPTH = 100

// Whether HyperFormula can be handed the formula at all: its parser recurses once per nesting level.
export function engineCanParse(formula: string): boolean {
	let depth = 0
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			index = skipQuoted(formula, index, code)

			continue
		}

		if (code === 40 && ++depth > MAX_DEPTH) return false
		if (code === 41) depth--

		index++
	}

	return true
}

// Functions Excel evaluates over whole arrays even in an ordinary formula; the engine, calculating
// ordinary formulas as Excel does (a range in a single-value place meets the formula's row or column),
// is told so with ARRAYFORMULA.
const ARRAY_ARGUMENTS = new Set(["SUMPRODUCT", "SUMX2MY2", "SUMX2PY2", "SUMXMY2", "MDETERM"])

// Functions returning an array. Excel reads an ordinary formula holding one as taking the array's first
// value; the engine would spill it over the cells below and beside instead.
const ARRAY_RESULTS = new Set([
	"SEQUENCE",
	"MMULT",
	"TRANSPOSE",
	"SORT",
	"SORTBY",
	"UNIQUE",
	"FILTER",
	"VSTACK",
	"HSTACK",
	"ARRAY_CONSTRAIN",
	"MAXPOOL",
	"MEDIANPOOL",
	"MINVERSE",
	"RANDARRAY",
	"MUNIT",
	"FREQUENCY",
	"XLOOKUP"
])

// The most cells an array a formula builds may hold: the engine keeps every value of it, a few hundred
// bytes each.
const MAX_ARRAY_CELLS = 200_000

// Whether the formula calls an array-returning function over more cells than MAX_ARRAY_CELLS, going by
// its literal sizes (SEQUENCE(1000,1000)) and the largest range it names.
function arrayTooLarge(formula: string): boolean {
	const upper = formula.toUpperCase()
	let calls = false

	for (const name of ARRAY_RESULTS) {
		if (name !== "XLOOKUP" && upper.includes(`${name}(`)) {
			calls = true

			break
		}
	}

	if (!calls) {
		return false
	}

	for (const [, name, rows = "1", cols = "1"] of upper.matchAll(/(SEQUENCE|RANDARRAY|MUNIT)\(\s*(\d+)\s*(?:,\s*(\d+))?/g)) {
		const size = name === "MUNIT" ? Number(rows) ** 2 : Number(rows) * Number(cols)

		if (size > MAX_ARRAY_CELLS) return true
	}

	return formulaParts(formula).some(part => {
		if (typeof part === "string" || part.ref.area === null) return false

		const area = part.ref.area
		const rows = area.kind === "cols" ? MAX_ROWS : Math.abs(area.endRow - area.startRow) + 1
		const cols = area.kind === "rows" ? MAX_COLS : Math.abs(area.endCol - area.startCol) + 1

		return rows * cols > MAX_ARRAY_CELLS
	})
}

const SIZED = /^(SEQUENCE|RANDARRAY|MUNIT)$/i

// The end of the call whose "(" is at `open`, and its top-level argument texts.
function callArguments(text: string, open: number): { end: number; args: string[] } | null {
	const args: string[] = []
	let depth = 0
	let start = open + 1
	let index = open

	while (index < text.length) {
		const code = text.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			index = skipQuoted(text, index, code)

			continue
		}

		if (code === 40 || code === 123) depth++

		if (code === 41 || code === 125) {
			depth--

			if (depth === 0) {
				args.push(text.slice(start, index))

				return { end: index + 1, args }
			}
		}

		if (code === 44 && depth === 1) {
			args.push(text.slice(start, index))
			start = index + 1
		}

		index++
	}

	return null
}

// Array sizes the engine could otherwise be asked for from cell values (SEQUENCE(B1,B1)): past
// MAX_ARRAY_CELLS the size becomes #N/A, before the engine builds anything.
function boundArraySizes(text: string): string {
	let out = ""
	let index = 0

	while (index < text.length) {
		const code = text.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			const end = skipQuoted(text, index, code)

			out += text.slice(index, end)
			index = end

			continue
		}

		if (isWordChar(code)) {
			const end = readWord(text, index)
			const word = text.slice(index, end)
			const call = SIZED.test(word) && text.charCodeAt(end) === 40 ? callArguments(text, end) : null

			if (call === null) {
				out += word
				index = end

				continue
			}

			const args = call.args.map(boundArraySizes)
			const rows = args[0]?.trim() === "" || args[0] === undefined ? "1" : args[0]
			const cols = args[1]?.trim() === "" || args[1] === undefined ? (word.toUpperCase() === "MUNIT" ? rows : "1") : args[1]
			const bounded = `IF((${rows})*(${cols})>${String(MAX_ARRAY_CELLS)},NA(),${rows})`

			out += `${word}(${[bounded, ...args.slice(1)].join(",")})`
			index = call.end

			continue
		}

		out += text[index] ?? ""
		index++
	}

	return out
}

// A cell's formula as HyperFormula takes it (with its "="), or null when it cannot be given to it: nested
// past its parser's depth, or building an array too large to hold. Evaluated as Excel reads an ordinary
// formula: an array result gives its first value (INDEX), and nothing spills.
export function engineCellFormula(formula: string): string | null {
	if (!engineCanParse(formula) || arrayTooLarge(formula)) {
		return null
	}

	const text = boundArraySizes(engineFormula(formula))
	const upper = text.toUpperCase()

	for (const name of ARRAY_RESULTS) {
		if (upper.includes(`${name}(`)) {
			return `=INDEX((${text}),1,1)`
		}
	}

	return `=${text}`
}

// Excel formula text as HyperFormula reads it, where only the spelling differs: function names lose the
// _xlfn./_xlws. prefixes files store for newer functions, TRUE and FALSE become the functions HyperFormula
// has for them, exponents take a lower-case "e", a string literal with a doubled quote is spelled with
// CHAR(34) (HyperFormula has no escape for it; inside an array constant it is left to fail), and calls
// that evaluate arrays are wrapped in ARRAYFORMULA. What HyperFormula still cannot read (intersections,
// unions, structured and external references) fails to parse there, and the caller keeps the file's own
// result.
export function engineFormula(formula: string): string {
	let text = ""
	let braces = 0
	let index = 0
	// Per open parenthesis: whether it opened a call wrapped in ARRAYFORMULA, which closes with it.
	const opened: boolean[] = []
	let wrapNext = false

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
				const name = word.replace(/^(?:_xlfn\.|_xlws\.)+/i, "")

				wrapNext = ARRAY_ARGUMENTS.has(name.toUpperCase())
				text += wrapNext ? `ARRAYFORMULA(${name}` : name
			} else if (/^(\d+\.?\d*|\.\d+)E$/i.test(word) && (next === 43 || next === 45)) {
				text += `${word.slice(0, -1)}e`
			} else if (/^(\d+\.?\d*|\.\d+)E\d+$/i.test(word)) {
				text += word.replace(/E/i, "e")
			} else if (next === 33) {
				// HyperFormula reads only plain ASCII sheet names unquoted (not 数据!A1, not Q1.2024!A1).
				text += `'${word.replaceAll("'", "''")}'`
			} else if (next !== 58 && /^(TRUE|FALSE)$/i.test(word)) {
				text += `${word}()`
			} else {
				text += word
			}

			index = end
		} else {
			if (code === 123) braces++
			if (code === 125) braces--

			text += formula[index] ?? ""

			if (code === 40) {
				opened.push(wrapNext)
				wrapNext = false
			} else if (code === 41 && opened.pop() === true) {
				text += ")"
			}

			index++
		}
	}

	return text
}

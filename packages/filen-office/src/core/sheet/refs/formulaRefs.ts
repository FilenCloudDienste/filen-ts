import { functionPrefix, functionSupport, functionVolatility, sheetFunction } from "../functions/catalogue"
import { columnIndex, columnName } from "./cellRef"
import type { AxisEdit } from "../model/edits"
import { MAX_COLUMNS, MAX_ROWS } from "../model/model"
import {
	ANCHOR_FUNCTION,
	CALL_FUNCTION,
	CRITERION_FUNCTION,
	INDEX_REFERENCE_FUNCTION,
	INTERSECT_FUNCTION,
	NULL_FUNCTION,
	OFFSET_FUNCTION,
	RANGE_FUNCTION,
	SPILL_FUNCTION
} from "../functions/engineNames"

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

		return col < MAX_COLUMNS && row >= 0 && row < MAX_ROWS
			? { kind: "cell", row, col, rowAbs: rowAbs === "$", colAbs: colAbs === "$" }
			: null
	}

	const column = COLUMN.exec(word)

	if (column !== null) {
		const [, colAbs = "", letters = ""] = column
		const col = columnIndex(letters)

		return col < MAX_COLUMNS ? { kind: "cols", row: 0, col, rowAbs: false, colAbs: colAbs === "$" } : null
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

// The functions taking a LAMBDA, where a function's name alone stands for one (BYROW(A1:B3,SUM)), which a file
// stores as _xleta.SUM.
const ETA_PREFIX = "_xleta."
const HELPERS = new Set(["MAP", "REDUCE", "SCAN", "BYROW", "BYCOL", "MAKEARRAY", "GROUPBY", "PIVOTBY"])
const HELPER_CALL = /\b(?:_xlfn\.)?(?:MAP|REDUCE|SCAN|BYROW|BYCOL|MAKEARRAY|GROUPBY|PIVOTBY)\s*\(/i

// A function's name typed whole as an argument of a LAMBDA helper, as a file stores it: _xleta.SUM.
function storedEta(formula: string): string {
	let text = ""
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			const end = skipQuoted(formula, index, code)

			text += formula.slice(index, end)
			index = end

			continue
		}

		if (isWordChar(code)) {
			const end = readWord(formula, index)
			const word = formula.slice(index, end)
			const call =
				formula.charCodeAt(end) === 40 && HELPERS.has(bareFunctionName(word).toUpperCase()) ? callArguments(formula, end) : null

			if (call === null) {
				text += word
				index = end

				continue
			}

			const args = call.args.map(arg => {
				const name = arg.trim()

				return /^[A-Za-z][A-Za-z0-9.]*$/.test(name) && sheetFunction(name) !== undefined
					? arg.replace(name, `${ETA_PREFIX}${name.toUpperCase()}`)
					: storedEta(arg)
			})

			text += `${word}(${args.join(",")})`
			index = call.end

			continue
		}

		text += formula[index] ?? ""
		index++
	}

	return text
}

const SINGLE_CALL = "_xlfn.SINGLE("

// The end of the operand starting at `start` (a reference, a name, or a call with its arguments), or `start` for none.
function operandEnd(formula: string, start: number): number {
	const first = formulaParts(formula.slice(start))[0]

	if (first !== undefined && typeof first !== "string" && first.ref.area !== null)
		return start + first.prefix.length + first.areaText.length

	const end = readWord(formula, start)

	if (end > start && formula.charCodeAt(end) === 40) return callArguments(formula, end)?.end ?? end

	return end
}

// The implicit intersection operator as typed (@A1:A9, @INDEX(...)) as a file stores it: _xlfn.SINGLE(A1:A9).
function storedIntersections(formula: string): string {
	let text = ""
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			const end = skipQuoted(formula, index, code)

			// A quoted sheet name starts a reference: kept whole with what follows by operandEnd.
			if (code === APOSTROPHE && formula.charCodeAt(end) === 33) {
				const after = operandEnd(formula, index)

				text += formula.slice(index, after)
				index = Math.max(after, end)
			} else {
				text += formula.slice(index, end)
				index = end
			}

			continue
		}

		if (code === 64) {
			const end = operandEnd(formula, index + 1)

			if (end > index + 1) {
				text += `${SINGLE_CALL}${storedIntersections(formula.slice(index + 1, end))})`
				index = end

				continue
			}
		}

		text += formula[index] ?? ""
		index++
	}

	return text
}

// _xlfn.SINGLE(x) of one operand as Excel shows it: @x.
function shownIntersections(formula: string): string {
	let text = ""
	let index = 0
	const lower = formula.toLowerCase()
	const call = SINGLE_CALL.toLowerCase()

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			const end = skipQuoted(formula, index, code)

			text += formula.slice(index, end)
			index = end

			continue
		}

		if (lower.startsWith(call, index) && (index === 0 || !isWordChar(formula.charCodeAt(index - 1)))) {
			const open = index + call.length - 1
			const args = callArguments(formula, open)
			const inner = args?.args.length === 1 ? (args.args[0] ?? "") : null

			if (args !== null && inner !== null && operandEnd(inner, 0) === inner.length && inner.length > 0) {
				text += `@${shownIntersections(inner)}`
				index = args.end

				continue
			}
		}

		text += formula[index] ?? ""
		index++
	}

	return text
}

const ANCHOR_CALL = "_xlfn.ANCHORARRAY("

// Whether a reference is one cell of this workbook (a spill range reference's anchor).
function oneCell(part: RefPart): boolean {
	const area = part.ref.area

	return !part.ref.external && part.ref.lastSheet === null && area !== null && area.kind === "cell" && !area.range
}

// A spill range reference as typed (A1#, Sheet2!B3#) as a file stores it: _xlfn.ANCHORARRAY(A1) ([MS-XLSX] 2.2.2).
function storedSpillReferences(formula: string): string {
	const parts = formulaParts(formula)
	let text = ""

	parts.forEach((part, index) => {
		if (typeof part === "string") {
			const before = parts[index - 1]

			text +=
				before !== undefined && typeof before !== "string" && oneCell(before) && part.startsWith("#") ? `)${part.slice(1)}` : part

			return
		}

		const after = parts[index + 1]
		const spill = oneCell(part) && typeof after === "string" && after.startsWith("#") && !/^#[A-Z/0]/i.test(after)

		text += spill ? `${ANCHOR_CALL}${part.prefix}${part.areaText}` : `${part.prefix}${part.areaText}`
	})

	return text
}

// _xlfn.ANCHORARRAY(A1) as it is typed and shown: A1#.
function shownSpillReferences(formula: string): string {
	const parts = formulaParts(formula)
	let text = ""

	parts.forEach((part, index) => {
		if (typeof part !== "string") {
			text += `${part.prefix}${part.areaText}`

			return
		}

		const before = parts[index - 1]
		const after = parts[index + 1]
		let piece = part

		if (before !== undefined && typeof before !== "string" && oneCell(before) && piece.startsWith(")") && anchored(parts, index - 1))
			piece = `#${piece.slice(1)}`
		if (
			after !== undefined &&
			typeof after !== "string" &&
			oneCell(after) &&
			piece.toLowerCase().endsWith(ANCHOR_CALL.toLowerCase()) &&
			closes(parts, index + 1)
		)
			piece = piece.slice(0, -ANCHOR_CALL.length)

		text += piece
	})

	return text
}

// Whether the reference at `index` is the whole argument of an ANCHORARRAY call before it, and so is closed after it.
function anchored(parts: readonly Part[], index: number): boolean {
	const before = parts[index - 1]

	return typeof before === "string" && before.toLowerCase().endsWith(ANCHOR_CALL.toLowerCase())
}

function closes(parts: readonly Part[], index: number): boolean {
	const after = parts[index + 1]

	return typeof after === "string" && after.startsWith(")")
}

// The one A1 reference a text is and nothing else ("Sheet 2"!B3, A:A, $A$1:B9), as INDIRECT reads one; null for any
// other text. `area` null: the sheet prefix is followed by a name or nothing that is a reference (Sheet1!Name).
export function singleReference(text: string): (FormulaRef & { readonly areaText: string }) | null {
	const parts = formulaParts(text)
	const part = parts[0]

	if (parts.length !== 1 || part === undefined || typeof part === "string") return null

	return { ...part.ref, areaText: part.areaText }
}

// The formula as text and the references in it, in order.
function formulaParts(text: string): Part[] {
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
function sheetPrefix(sheet: string, lastSheet: string | null = null): string {
	const name = lastSheet === null ? sheet : `${sheet}:${lastSheet}`

	return needsQuotes(sheet) || (lastSheet !== null && needsQuotes(lastSheet)) ? `'${name.replaceAll("'", "''")}'!` : `${name}!`
}

// The formula with each reference `visit` returns something for replaced: a changed reference, or null
// for #REF!. undefined keeps the reference as written.
function render(parts: readonly Part[], visit: (ref: FormulaRef, prefix: string) => FormulaRef | null | undefined): string {
	let text = ""

	for (const part of parts) {
		if (typeof part === "string") {
			text += part

			continue
		}

		const next = visit(part.ref, part.prefix)

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

export function rewriteFormula(formula: string, visit: (ref: FormulaRef, prefix: string) => FormulaRef | null | undefined): string {
	return render(formulaParts(formula), visit)
}

// The first character past spaces from `index` on (back: before it), or -1.
function significant(text: string, index: number, back: boolean): number {
	for (let at = index; back ? at >= 0 : at < text.length; at += back ? -1 : 1) {
		const code = text.charCodeAt(at)

		if (code !== 32 && code !== 10 && code !== 13 && code !== 9) return code
	}

	return -1
}

// The formula with each 3-D reference (Jan:Mar!A1) spelled as the references to every sheet it spans, `sheets` in
// workbook order (Jan!A1,Feb!A1,Mar!A1), its ends in either order. Only an argument of its own to one of `functions`
// (upper case) is spelled so: Excel takes 3-D references in those alone ("Create a reference to the same cell range on
// multiple worksheets"). The formula unchanged when it has none; null when one stands elsewhere, names a sheet
// `sheets` lacks or another workbook.
export function spannedReferences(formula: string, sheets: readonly string[], functions: ReadonlySet<string>): string | null {
	const parts = formulaParts(formula)

	if (!parts.some(part => typeof part !== "string" && part.ref.lastSheet !== null)) return formula

	// The function each open parenthesis belongs to (null: none), and the text so far.
	const calls: (string | null)[] = []
	let text = ""

	for (let index = 0; index < parts.length; index++) {
		const part = parts[index] as Part

		if (typeof part === "string") {
			let word = ""

			for (let at = 0; at < part.length; at++) {
				const code = part.charCodeAt(at)

				if (code === QUOTE) {
					at = skipQuoted(part, at, QUOTE) - 1
					word = ""
				} else if (code === 40) {
					calls.push(word === "" ? null : word.toUpperCase().replace(/^_XLFN\./, ""))
					word = ""
				} else if (code === 41) {
					calls.pop()
					word = ""
				} else if (isWordChar(code)) word += part.charAt(at)
				else word = ""
			}

			text += part

			continue
		}

		const { ref } = part

		if (ref.lastSheet === null) {
			text += part.prefix + part.areaText

			continue
		}

		const before = significant(text, text.length - 1, true)
		const next = parts[index + 1]
		const after = typeof next === "string" ? significant(next, 0, false) : -1
		const call = calls.at(-1)
		const first = sheets.findIndex(name => sameSheet(name, ref.sheet ?? ""))
		const last = sheets.findIndex(name => sameSheet(name, ref.lastSheet ?? ""))

		if (
			ref.external ||
			ref.area === null ||
			call === null ||
			call === undefined ||
			!functions.has(call) ||
			(before !== 40 && before !== 44) ||
			(after !== 41 && after !== 44) ||
			first < 0 ||
			last < 0
		)
			return null

		const spanned: string[] = []

		for (let at = Math.min(first, last); at <= Math.max(first, last); at++) spanned.push(sheetPrefix(sheets[at] ?? "") + part.areaText)

		text += spanned.join(",")
	}

	return text
}

// Whether a sheet's name is quoted where a formula names it ('2024'!A1, 'Q1 Data'!A1).
export function sheetNameNeedsQuotes(name: string): boolean {
	return needsQuotes(name)
}

// The formula with every sheet it names spelled as Excel's grammar needs: quoted where the name needs it. HyperFormula
// writes such a name back bare (2024!A1), which it cannot read again.
export function quoteSheetNames(formula: string): string {
	let text = ""

	for (const part of formulaParts(formula)) {
		if (typeof part === "string") text += part
		else text += (part.ref.sheet === null ? part.prefix : sheetPrefix(part.ref.sheet, part.ref.lastSheet)) + part.areaText
	}

	return text
}

// F4 while a formula is typed: the reference the caret is in or just after (in `formula`, without the "=") made
// absolute, then absolute in its row alone, then in its column alone, then relative again, as Excel cycles it; both
// ends of a range take the state that follows the first's. A whole-column or whole-row range turns absolute and
// back. The formula and where the reference now ends, or null when the caret is at none.
export function cycleReference(formula: string, caret: number): { readonly formula: string; readonly end: number } | null {
	let offset = 0

	for (const part of formulaParts(formula)) {
		if (typeof part === "string") {
			offset += part.length

			continue
		}

		const start = offset
		const areaStart = start + part.prefix.length
		const end = areaStart + part.areaText.length

		offset = end

		const area = part.ref.area

		if (caret < start || caret > end || area === null || part.ref.external) continue

		let rowAbs: boolean
		let colAbs: boolean

		if (area.kind === "cell") {
			// Relative → $A$1 → A$1 → $A1 → relative.
			const state = (area.startColAbs ? 1 : 0) + (area.startRowAbs ? 2 : 0)
			const next = state === 0 ? 3 : state === 3 ? 2 : state === 2 ? 1 : 0

			colAbs = (next & 1) !== 0
			rowAbs = (next & 2) !== 0
		} else {
			colAbs = area.kind === "cols" && !area.startColAbs
			rowAbs = area.kind === "rows" && !area.startRowAbs
		}

		const text = areaText({ ...area, startRowAbs: rowAbs, endRowAbs: rowAbs, startColAbs: colAbs, endColAbs: colAbs })

		return { formula: formula.slice(0, areaStart) + text + formula.slice(end), end: areaStart + text.length }
	}

	return null
}

// A reference in formula text as typed: where it is (start and end, its sheet prefix included) and what it names.
export interface ReferenceSpan {
	readonly start: number
	readonly end: number
	// The sheet it names, null for the formula's own.
	readonly sheet: string | null
	readonly area: RefArea
}

// The references of a formula (without its "="), in order: what a formula being typed highlights. References into
// other workbooks, 3-D spans and names are left out.
export function referenceSpans(formula: string): ReferenceSpan[] {
	const spans: ReferenceSpan[] = []
	let offset = 0

	for (const part of formulaParts(formula)) {
		if (typeof part === "string") {
			offset += part.length

			continue
		}

		const start = offset
		const end = start + part.prefix.length + part.areaText.length

		offset = end

		if (part.ref.area !== null && !part.ref.external && part.ref.lastSheet === null)
			spans.push({ start, end, sheet: part.ref.sheet, area: part.ref.area })
	}

	return spans
}

// A reference's text: the cell or range, behind a sheet prefix (quoted where the name needs it) when `sheet` is given.
export function referenceText(area: RefArea, sheet: string | null = null): string {
	return `${sheet === null ? "" : sheetPrefix(sheet)}${areaText(area)}`
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
				Math.max(next.startCol, next.endCol) >= MAX_COLUMNS
			) {
				return null
			}

			return { ...ref, area: next }
		})
}

export function sameSheet(a: string, b: string): boolean {
	return a === b || a.toUpperCase() === b.toUpperCase()
}

// One axis of an area moved for an insert or delete: null when the deletion takes all of it.
export function shiftSpan(start: number, end: number, edit: AxisEdit, limit: number, range: boolean): [number, number] | null {
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
function shiftArea(area: RefArea, edit: AxisEdit): RefArea | null {
	const rowsAxis = edit.axis === "rows"

	if ((rowsAxis && area.kind === "cols") || (!rowsAxis && area.kind === "rows")) {
		return area
	}

	const start = rowsAxis ? area.startRow : area.startCol
	const end = rowsAxis ? area.endRow : area.endCol
	const moved = shiftSpan(Math.min(start, end), Math.max(start, end), edit, rowsAxis ? MAX_ROWS : MAX_COLUMNS, area.range)

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

// Whether a reference in a formula on the edited sheet (`own`) or another one points into sheet `target` alone. A 3-D
// reference does only when it spans `target` and no other: Excel moves one for rows or columns inserted or deleted on
// every sheet it spans at once (grouped sheets), never for an edit on one of them, as a single area cannot point
// differently into each.
export function pointsInto(ref: FormulaRef, own: boolean, target: string): boolean {
	if (ref.external || ref.area === null) return false
	if (ref.sheet === null) return own

	return sameSheet(ref.sheet, target) && (ref.lastSheet === null || sameSheet(ref.lastSheet, target))
}

// A formula on `ownSheet` after rows or columns of `target` were inserted or deleted, and whether the
// deletion cut into one of its references. References into other workbooks, and 3-D references spanning sheets
// besides `target` (pointsInto), are left as written.
export function shiftFormula(formula: string, ownSheet: string, target: string, edit: AxisEdit): { formula: string; cut: boolean } {
	const own = sameSheet(ownSheet, target)
	let wasCut = false

	if (!own && !formula.includes("!")) {
		return { formula, cut: false }
	}

	const shifted = rewriteFormula(formula, ref => {
		if (ref.area === null || !pointsInto(ref, own, target)) {
			return undefined
		}

		wasCut ||= cut(ref.area, edit)

		const area = shiftArea(ref.area, edit)

		return area === ref.area ? undefined : area === null ? null : { ...ref, area }
	})

	return { formula: shifted, cut: wasCut }
}

// A formula with every reference to sheet `from` naming `to` instead.
export function renameSheetInFormula(formula: string, from: string, to: string): string {
	if (!formula.includes("!")) {
		return formula
	}

	// A name holding ":" (an OpenDocument sheet's: SpreadsheetML has none) reads as a span of two sheets: the whole
	// quoted name is that sheet's.
	const spanned = from.includes(":")

	return rewriteFormula(formula, (ref, prefix) => {
		// Quoted: one sheet's name; unquoted (a:b!A1), a span of two sheets.
		if (
			spanned &&
			prefix.startsWith("'") &&
			!ref.external &&
			ref.sheet !== null &&
			ref.lastSheet !== null &&
			sameSheet(`${ref.sheet}:${ref.lastSheet}`, from)
		) {
			return { ...ref, sheet: to, lastSheet: null }
		}

		const first = ref.sheet !== null && sameSheet(ref.sheet, from)
		const last = ref.lastSheet !== null && sameSheet(ref.lastSheet, from)

		if (ref.external || (!first && !last)) {
			return undefined
		}

		return { ...ref, sheet: first ? to : ref.sheet, lastSheet: last ? to : ref.lastSheet }
	})
}

// What a file stores before a function's name (Excel reads the bare name of a newer function as unknown,
// #NAME?), as the function catalogue gives it. _xlfn.SINGLE is how a file stores the implicit intersection
// operator (@), which the catalogue does not list.
function prefixOf(name: string): string | null {
	const upper = name.toUpperCase()
	const prefix = upper === "SINGLE" ? "_xlfn." : functionPrefix(upper)

	return prefix === undefined || prefix === "" ? null : prefix
}

// A function name without the _xlfn./_xlws. prefixes files store for newer functions.
function bareFunctionName(name: string): string {
	return name.replace(/^(?:_xlfn\.|_xlws\.)+/i, "")
}

// Rewrites each word in a formula (outside strings, quoted sheet names and brackets), told whether it
// calls a function.
function mapWords(formula: string, map: (word: string, called: boolean) => string): string {
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

			text += map(word, formula.charCodeAt(end) === 40)
			index = end
		} else {
			text += formula[index] ?? ""
			index++
		}
	}

	return text
}

// Whether a formula calls a function the formula engine does not calculate (one the function catalogue does not
// mark "hyperformula" or "plugin", or no worksheet function at all: an add-in's, a LAMBDA's), or names one that
// `unknownName` (given the name in upper case) says the engine lacks. Such a formula keeps the result its file
// stored: under an error trap (IFERROR, ISERROR) the engine's #NAME? for the call would read as a value.
export function engineLacks(formula: string, unknownName?: (name: string) => boolean, lambdas?: ReadonlySet<string>): boolean {
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			index = skipQuoted(formula, index, code)
		} else if (code === BRACKET_OPEN) {
			index = skipBracket(formula, index)
		} else if (code === HASH) {
			index = skipError(formula, index)
		} else if (isWordChar(code)) {
			const end = readWord(formula, index)
			const next = formula.charCodeAt(end)

			if (next === 40) {
				const word = formula.slice(index, end)
				const bare = bareFunctionName(word).toUpperCase()
				const support =
					isParameter(word) || ENGINE_SPELLED.has(bare) || lambdas?.has(word.toUpperCase()) === true || TRIM_FUNCTION.test(bare)
						? "plugin"
						: functionSupport(bare)

				if (support !== "hyperformula" && support !== "plugin") return true
			} else if (unknownName !== undefined && next !== 33 && unknownName(formula.slice(index, end).toUpperCase())) {
				return true
			}

			index = end
		} else {
			index++
		}
	}

	return false
}

// The functions a formula calls, as written but for _xlfn./_xlws. (a LAMBDA parameter's call left out).
export function calledFunctions(formula: string): string[] {
	const out: string[] = []
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			index = skipQuoted(formula, index, code)
		} else if (code === BRACKET_OPEN) {
			index = skipBracket(formula, index)
		} else if (code === HASH) {
			index = skipError(formula, index)
		} else if (isWordChar(code)) {
			const end = readWord(formula, index)
			const word = formula.slice(index, end)

			if (formula.charCodeAt(end) === 40 && !isParameter(word)) out.push(bareFunctionName(word))

			index = end
		} else {
			index++
		}
	}

	return out
}

// A defined name's formula when it is one absolute cell of a sheet of this workbook ('Data'!$A$1, or the range
// 'Data'!$A$1:$A$1), as the engine reads it; null for anything else. Such a name stands for its cell wherever it is used.
export function absoluteCell(formula: string): string | null {
	const parts = formulaParts(formula.trim())
	const part = parts[0]

	if (parts.length !== 1 || part === undefined || typeof part === "string") return null

	const { ref } = part
	const area = ref.area

	if (ref.external || ref.sheet === null || ref.lastSheet !== null || area === null || area.kind !== "cell") return null

	// A range of one cell ($A$1:$A$1) is that cell.
	if (area.range && (area.startRow !== area.endRow || area.startCol !== area.endCol || !area.endRowAbs || !area.endColAbs)) return null

	return area.startRowAbs && area.startColAbs
		? engineFormula(`${part.prefix}${cellText(area.startRow, area.startCol, true, true)}`)
		: null
}

export interface FormulaInputs {
	// Its references into this workbook (sheet null: the formula's own; lastSheet set: a 3D span).
	readonly refs: readonly { readonly sheet: string | null; readonly lastSheet: string | null; readonly area: RefArea }[]
	// The words that may name defined names, upper case.
	readonly names: readonly string[]
	// The tables its structured references name, upper case ("" for the formula's own: [@Amount]).
	readonly tables: readonly string[]
	// It calls a volatile function that computes the references it reads (OFFSET, INDIRECT): what it reads is not
	// known. (NOW, TODAY and RAND read no cell.)
	readonly dynamic: boolean
}

// What a formula reads, without evaluating anything.
export function formulaInputs(formula: string): FormulaInputs {
	const refs: { sheet: string | null; lastSheet: string | null; area: RefArea }[] = []
	const names: string[] = []
	const tables: string[] = []
	let dynamic = false

	for (const part of formulaParts(formula)) {
		if (typeof part !== "string") {
			if (!part.ref.external && part.ref.area !== null)
				refs.push({ sheet: part.ref.sheet, lastSheet: part.ref.lastSheet, area: part.ref.area })

			continue
		}

		let index = 0
		let word = ""

		while (index < part.length) {
			const code = part.charCodeAt(index)

			if (code === QUOTE || code === APOSTROPHE) {
				index = skipQuoted(part, index, code)
				word = ""
			} else if (code === BRACKET_OPEN) {
				tables.push(word.toUpperCase())
				index = skipBracket(part, index)
				word = ""
			} else if (code === HASH) {
				index = skipError(part, index)
				word = ""
			} else if (isWordChar(code)) {
				const end = readWord(part, index)
				const next = part.charCodeAt(end)

				word = part.slice(index, end)

				if (next === 40) {
					const name = bareFunctionName(word).toUpperCase()

					if (
						functionVolatility(name) === "always" &&
						sheetFunction(name)?.args.some(arg => arg.id === "reference" || arg.id === "ref_text") === true
					)
						dynamic = true
				} else if (next !== 33 && next !== BRACKET_OPEN && /^[A-Za-z_\\\u0080-\uffff]/.test(word)) {
					names.push(word.toUpperCase())
				}

				index = end
			} else {
				index++
				word = ""
			}
		}
	}

	return { refs, names, tables, dynamic }
}

const PARAMETER = "_xlpm."
const SCOPES = /\b(?:LET|LAMBDA)\(/i

// Calls a file stores that are no worksheet function of the catalogue's, and the engine-only functions they reach it
// as: the spill range reference A1# (_xlfn.ANCHORARRAY(A1)) and the implicit intersection operator @ (_xlfn.SINGLE).
const ENGINE_SPELLED: ReadonlyMap<string, string> = new Map([
	["ANCHORARRAY", ANCHOR_FUNCTION],
	["SINGLE", INTERSECT_FUNCTION]
])

// The engine-only function a stored call reaches the engine as (ANCHORARRAY, SINGLE), upper case; undefined for others.
export function engineSpelledName(name: string): string | undefined {
	return ENGINE_SPELLED.get(name.toUpperCase())
}

// Whether a word is a LET or LAMBDA name as a file stores it (_xlpm.x).
function isParameter(word: string): boolean {
	return word.length > PARAMETER.length && word.slice(0, PARAMETER.length).toLowerCase() === PARAMETER
}

// A LET or LAMBDA name as written in a formula (x), the file's _xlpm. prefix left out.
export function withoutPrefix(name: string): string {
	return name.length > PARAMETER.length && name.slice(0, PARAMETER.length).toLowerCase() === PARAMETER
		? name.slice(PARAMETER.length)
		: name
}

// Space, tab, line feed, carriage return: what may stand between a formula's tokens.
function isSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 13
}

function nextCode(text: string, from: number): number {
	let index = from

	while (isSpace(text.charCodeAt(index))) index++

	return text.charCodeAt(index)
}

interface Scope {
	binds: "LET" | "LAMBDA" | null
	argument: number
	// Whether a word here would be a whole argument so far.
	fresh: boolean
	// The names in scope, each with whether it holds a LAMBDA (and may be called).
	names: Map<string, boolean>
	// A LET name whose value is being read: in scope once the value ends.
	pending: string | null
	callable: boolean
}

// The names LET and LAMBDA bind, where declared and where used within their call, with the prefix a file
// stores them with (Excel reads the bare name as a defined name). A name already prefixed stays as it is.
// A word beside ":" is a range's end, and one before "(" a function, unless the name is bound and names no function.
export function prefixParameters(formula: string): string {
	if (!SCOPES.test(formula)) return formula

	// One scope per open parenthesis or array constant.
	const frames: Scope[] = []
	const lookup = (name: string): boolean | undefined => {
		for (let depth = frames.length - 1; depth >= 0; depth--) {
			const callable = frames[depth]?.names.get(name)

			if (callable !== undefined) return callable
		}

		return undefined
	}
	let binds: "LET" | "LAMBDA" | null = null
	let text = ""
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)
		const frame = frames.at(-1)

		if (code === QUOTE || code === APOSTROPHE || code === BRACKET_OPEN) {
			const end = code === BRACKET_OPEN ? skipBracket(formula, index) : skipQuoted(formula, index, code)

			text += formula.slice(index, end)
			index = end

			if (frame !== undefined) frame.fresh = false

			continue
		}

		if (isWordChar(code)) {
			const end = readWord(formula, index)
			const word = formula.slice(index, end)
			const name = withoutPrefix(word)
			const key = name.toLowerCase()
			const after = formula.charCodeAt(end)
			const before = formula.charCodeAt(index - 1)
			const called = after === 40
			const reference = after === 33 || before === 33 || after === 58 || before === 58
			const bare = bareFunctionName(name).toUpperCase()
			let bound = false

			binds = called && (bare === "LET" || bare === "LAMBDA") ? bare : null

			if (frame !== undefined && !reference) {
				const ends = nextCode(formula, end)

				// The first word of a LET value: a LAMBDA, or a name holding one, makes the name callable.
				if (frame.pending !== null && frame.fresh) {
					frame.callable = binds === "LAMBDA" || (lookup(key) === true && (ends === 44 || ends === 41))
				}

				// A whole argument in a name's place: every one but LAMBDA's last, every other one of LET's.
				if (
					frame.binds !== null &&
					frame.fresh &&
					!called &&
					ends === 44 &&
					(frame.binds === "LAMBDA" || frame.argument % 2 === 0)
				) {
					if (frame.binds === "LAMBDA") frame.names.set(key, false)
					else frame.pending = key

					bound = true
				} else {
					const callable = lookup(key)

					// Called, a name in scope is one holding a LAMBDA, or a name whose value cannot be known before it
					// calculates (a LAMBDA's parameter given a LAMBDA) unless it names a function.
					bound = called
						? callable === true || (callable === false && functionPrefix(bare) === undefined)
						: callable !== undefined
				}
			}

			text += bound ? `${PARAMETER}${name}` : word
			index = end

			if (frame !== undefined) frame.fresh = false

			continue
		}

		if (code === 40 || code === 123) {
			frames.push({ binds: code === 40 ? binds : null, argument: 0, fresh: true, names: new Map(), pending: null, callable: false })
		} else if (code === 41 || code === 125) {
			frames.pop()
		} else if (code === 44 && frame !== undefined) {
			// A LET value ends: its name is in scope from the next argument on.
			if (frame.pending !== null && frame.argument % 2 === 1) {
				frame.names.set(frame.pending, frame.callable)
				frame.pending = null
			}

			frame.argument++
			frame.fresh = true
		} else if (!isSpace(code) && frame !== undefined) {
			frame.fresh = false
		}

		binds = null
		text += formula[index] ?? ""
		index++
	}

	return text
}

// A typed formula as a file stores it: newer functions with the prefix Excel requires, and the names LET
// and LAMBDA bind with theirs.
export function storedFormula(formula: string): string {
	const operators = formula.includes("@") ? storedIntersections(formula) : formula

	const spills = operators.includes("#") ? storedSpillReferences(operators) : operators

	// After the LET and LAMBDA names are marked: a bound name in a helper's argument is no function's.
	const bound = prefixParameters(spills)

	return mapWords(HELPER_CALL.test(bound) ? storedEta(bound) : bound, (name, called) => {
		if (!called || name.startsWith("_")) return name

		const prefix = prefixOf(name)

		return prefix === null ? name : `${prefix}${name.toUpperCase()}`
	})
}

// A stored formula as the user reads and edits it: known prefixes left out (storedFormula puts them back).
// A prefix on a function it does not know stays, so nothing is lost by editing.
export function shownFormula(formula: string): string {
	if (!formula.includes("_xl")) return formula
	if (/_xlfn\.SINGLE\(/i.test(formula)) return shownFormula(shownIntersections(formula))
	if (/_xlfn\.ANCHORARRAY\(/i.test(formula)) return shownFormula(shownSpillReferences(formula))

	return mapWords(formula, (name, called) => {
		if (!called && name.length > ETA_PREFIX.length && name.slice(0, ETA_PREFIX.length).toLowerCase() === ETA_PREFIX)
			return name.slice(ETA_PREFIX.length)

		const unbound = withoutPrefix(name)

		if (unbound !== name || !called) return unbound

		const bare = bareFunctionName(name)
		const prefix = prefixOf(bare)

		return prefix !== null && name.toLowerCase() === `${prefix}${bare}`.toLowerCase() ? bare : name
	})
}

// Trim references (support.microsoft.com "TRIMRANGE function": A1.:.E10 trims both ends, A1:.E10 the trailing empty
// rows and columns, A1.:E10 the leading). A file Excel wrote may hold them as _xlfn._TRO_ALL(A1:E10), _TRO_TRAILING and
// _TRO_LEADING: kept as written, and read by the engine as TRIMRANGE with its codes (1 leading, 2 trailing, 3 both).
const TRIM_KINDS = { ALL: 3, TRAILING: 2, LEADING: 1 } as const
const TRIM_CALL = /_xlfn\._TRO_(ALL|TRAILING|LEADING)\(/gi
const TRIM_FUNCTION = /^_TRO_(?:ALL|TRAILING|LEADING)$/
// A reference's end beside a trim operator: a cell, a column or a row, with a sheet before the first.
const TRIM_END = String.raw`\$?[A-Za-z]{1,3}\$?\d+|\$?[A-Za-z]{1,3}|\$?\d+`
const TRIM_OPERATOR = new RegExp(
	String.raw`(^|[^A-Za-z0-9_.$!'\]])((?:'(?:[^']|'')+'!|[A-Za-z_][\w.]*!)?(?:${TRIM_END}))(\.?):(\.?)(${TRIM_END})(?![\w.(!])`,
	"g"
)

// Each run of `formula` outside its strings, rewritten by `map`.
function outsideStrings(formula: string, map: (text: string) => string): string {
	let text = ""
	let from = 0
	let index = 0

	while (index < formula.length) {
		if (formula.charCodeAt(index) === QUOTE) {
			const end = skipQuoted(formula, index, QUOTE)

			text += map(formula.slice(from, index)) + formula.slice(index, end)
			index = end
			from = end
		} else index++
	}

	return text + map(formula.slice(from))
}

// Whether a typed formula holds a trim reference (A1:.A9, A1.:A9, A1.:.A9). Excel's stored form of one is not
// documented ([MS-XLSX] 2.2.3 lists no such function, and support.microsoft.com "TRIMRANGE function" gives none), so a
// typed one is refused rather than written under a name Excel may not read.
export function holdsTrimReference(formula: string): boolean {
	if (!formula.includes(".:") && !formula.includes(":.")) return false

	let found = false

	outsideStrings(formula, text => {
		for (const match of text.matchAll(TRIM_OPERATOR)) if (match[3] !== "" || match[4] !== "") found = true

		return text
	})

	return found
}

// Stored trim references as the engine reads them: TRIMRANGE.
function engineTrimReferences(formula: string): string {
	let text = ""
	let index = 0

	for (const match of formula.matchAll(TRIM_CALL)) {
		const at = match.index

		if (at < index) continue

		const open = at + match[0].length - 1
		const args = callArguments(formula, open)

		if (args === null || args.args.length !== 1) continue

		const code = String(TRIM_KINDS[(match[1] ?? "").toUpperCase() as keyof typeof TRIM_KINDS])

		text += `${formula.slice(index, at)}_xlfn.TRIMRANGE(${engineTrimReferences(args.args[0] ?? "")},${code},${code})`
		index = args.end
	}

	return text + formula.slice(index)
}

const REGEX_CALL = /(?<![\w.])(?:_xlfn\.)?REGEX(?:TEST|EXTRACT|REPLACE)\(/gi

// The patterns a formula's REGEXTEST, REGEXEXTRACT and REGEXREPLACE calls give as text written in the formula (their
// second argument a string alone), unquoted.
export function regexPatterns(formula: string): string[] {
	const patterns: string[] = []

	for (const match of formula.matchAll(REGEX_CALL)) {
		if (insideString(formula, match.index)) continue

		const args = callArguments(formula, match.index + match[0].length - 1)
		const pattern = args?.args[1]?.trim() ?? ""

		if (pattern.length >= 2 && pattern.startsWith('"') && skipQuoted(pattern, 0, QUOTE) === pattern.length)
			patterns.push(pattern.slice(1, -1).replaceAll('""', '"'))
	}

	return patterns
}

// Whether a position of a formula is inside a string.
function insideString(formula: string, at: number): boolean {
	let index = 0

	while (index < at) {
		if (formula.charCodeAt(index) === QUOTE) {
			const end = skipQuoted(formula, index, QUOTE)

			if (end > at) return true

			index = end
		} else index++
	}

	return false
}

// The functions that may give a multi-cell range or an array, which Excel shows with @ in a formula written before
// dynamic arrays (support.microsoft.com "Excel functions that return ranges or arrays": CELL, COLUMN, FILTERXML,
// FORMULATEXT, FREQUENCY, GROWTH, HYPERLINK, INDEX, INDIRECT, ISFORMULA, LINEST, LOGEST, MINVERSE, MMULT, MODE.MULT,
// MUNIT, OFFSET, ROW, TRANSPOSE, TREND and every user-defined function). INDEX, OFFSET and INDIRECT give a reference
// whatever their arguments ("Implicit intersection operator: @" shows =@INDEX(A1:A10,B1)); the others give an array
// from a range they are given, so they take @ when a reference to more than one cell is among their arguments (ROW(A1)
// gives one value, ROW(A1:A3) three).
const RANGE_CALLS = new Set(["INDEX", "OFFSET", "INDIRECT"])
const ARRAY_CALLS = new Set([
	"CELL",
	"COLUMN",
	"FILTERXML",
	"FORMULATEXT",
	"FREQUENCY",
	"GROWTH",
	"HYPERLINK",
	"ISFORMULA",
	"LINEST",
	"LOGEST",
	"MINVERSE",
	"MMULT",
	"MODE.MULT",
	"MUNIT",
	"ROW",
	"TRANSPOSE",
	"TREND"
])

// Whether a reference names more than one cell.
function manyCells(ref: FormulaRef): boolean {
	const area = ref.area

	return area !== null && (area.kind !== "cell" || (area.range && (area.startRow !== area.endRow || area.startCol !== area.endCol)))
}

// A stored formula without dynamic-array metadata (Excel calculates it as it did before dynamic arrays) with the @
// Excel shows where it reads one value from a range (support.microsoft.com "Implicit intersection operator: @"):
// before a range or a call that may give one (RANGE_CALLS, or a function `known` does not know) that is the whole
// result, or in an argument that takes one value (`oneValue`), alone or in an operation (=@A1:A9*2, =LEN(@A1:A9)).
// A range a function reads whole (SUM) is left as it is, as is anything inside an argument not known to take one
// value. Shown as typed again, the formula means what it did.
export function legacyIntersections(
	formula: string,
	oneValue: (name: string, index: number) => boolean,
	known: (name: string) => boolean
): string {
	if (!formula.includes(":") && !formula.includes("(")) return formula

	// One frame per open parenthesis: whether its current argument takes one value, and the call it belongs to; for a
	// call of ARRAY_CALLS read for one value, where its name is in `text` (its @ goes there once a reference to more
	// than one cell is among its arguments: `ranged`).
	interface Frame {
		one: boolean
		call: string | null
		argument: number
		at: number
		ranged: boolean
	}

	const frames: Frame[] = [{ one: true, call: null, argument: 0, at: -1, ranged: false }]
	let text = ""
	let call: string | null = null
	// Where the last call's name was written, and whether it is one of ARRAY_CALLS read for one value.
	let callAt = -1

	for (const part of formulaParts(formula)) {
		const frame = frames.at(-1) ?? { one: false, call: null, argument: 0, at: -1, ranged: false }

		if (typeof part !== "string") {
			const many = !part.ref.external && manyCells(part.ref)

			if (many) for (const open of frames) open.ranged = true

			text += `${frame.one && many ? "@" : ""}${part.prefix}${part.areaText}`
			call = null

			continue
		}

		let index = 0

		while (index < part.length) {
			const code = part.charCodeAt(index)
			const top = frames.at(-1) ?? { one: false, call: null, argument: 0, at: -1, ranged: false }

			// A string, a quoted name or a structured reference's brackets (T[[#This Row],[x]]): whole, its commas no
			// argument's.
			if (code === QUOTE || code === APOSTROPHE || code === BRACKET_OPEN) {
				const end = code === BRACKET_OPEN ? skipBracket(part, index) : skipQuoted(part, index, code)

				text += part.slice(index, end)
				index = end
				call = null

				continue
			}

			if (isWordChar(code)) {
				const end = readWord(part, index)
				const word = part.slice(index, end)

				call = null

				if (part.charCodeAt(end) === 40) {
					const name = bareFunctionName(word).toUpperCase()

					call = name
					callAt = top.one && ARRAY_CALLS.has(name) ? text.length : -1
					text += top.one && (RANGE_CALLS.has(name) || !known(word)) ? `@${word}` : word
				} else text += word

				index = end

				continue
			}

			if (code === 40)
				frames.push({
					one: call === null ? top.one : oneValue(call, 0),
					call,
					argument: 0,
					at: call === null ? -1 : callAt,
					ranged: false
				})
			else if (code === 123) frames.push({ one: false, call: null, argument: 0, at: -1, ranged: false })
			else if ((code === 41 || code === 125) && frames.length > 1) {
				frames.pop()

				if (top.at >= 0 && top.ranged) text = `${text.slice(0, top.at)}@${text.slice(top.at)}`
			} else if (code === 44 && top.call !== null) {
				top.argument++
				top.one = oneValue(top.call, top.argument)
			}

			call = null
			text += part[index] ?? ""
			index++
		}
	}

	return text
}

// Past a quoted run ("…" or '…', the quote doubled inside), or -1 when it never closes.
function closedQuote(text: string, start: number, quote: number): number {
	let index = start + 1

	while (index < text.length) {
		if (text.charCodeAt(index) === quote) {
			if (text.charCodeAt(index + 1) !== quote) return index + 1

			index++
		}

		index++
	}

	return -1
}

// Past a bracketed run (a structured reference, an external workbook's number), nested brackets included
// ("'" escaping the next character), or -1 when it never closes.
function closedBracket(text: string, start: number): number {
	let depth = 0
	let index = start

	while (index < text.length) {
		const code = text.charCodeAt(index)

		if (code === APOSTROPHE) {
			index += 2

			continue
		}

		if (code === BRACKET_OPEN) depth++
		else if (code === BRACKET_CLOSE && --depth === 0) return index + 1

		index++
	}

	return -1
}

// Past one operand that names something: a number, name, function name or reference, with what may
// prefix it (an external workbook, a sheet, quoted or not) and follow it (a structured reference); -1 when
// it does not read as one.
function nameEnd(text: string, start: number): number {
	let index = start

	if (text.charCodeAt(index) === BRACKET_OPEN) {
		index = closedBracket(text, index)

		if (index < 0) return -1
	}

	if (text.charCodeAt(index) === APOSTROPHE) {
		index = closedQuote(text, index, APOSTROPHE)

		// A quoted name is a sheet's: a reference follows.
		if (index < 0 || text.charCodeAt(index) !== 33) return -1
	} else {
		index = readWord(text, index)
	}

	if (text.charCodeAt(index) === 33) {
		index++

		if (text.charCodeAt(index) === HASH) {
			index = skipError(text, index)
		} else if (isWordChar(text.charCodeAt(index))) {
			index = readWord(text, index)
		} else {
			return -1
		}
	}

	while (text.charCodeAt(index) === BRACKET_OPEN) {
		index = closedBracket(text, index)

		if (index < 0) return -1
	}

	return index > start ? index : -1
}

// What may begin an operand right after a space, which between two operands intersects them.
function startsOperand(code: number): boolean {
	return isWordChar(code) || code === APOSTROPHE || code === BRACKET_OPEN || code === 40
}

const ARRAY_NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y

// Past an array constant ({1,2;"a",TRUE}), or -1 when it is not one: it holds constants only (numbers,
// a minus sign before one, strings, TRUE and FALSE, error values), between "," and ";".
function arrayEnd(text: string, start: number): number {
	let index = start + 1

	for (;;) {
		while (isSpace(text.charCodeAt(index))) index++

		if (text.charCodeAt(index) === 45) index++

		const code = text.charCodeAt(index)

		ARRAY_NUMBER.lastIndex = index

		if (code === QUOTE) {
			index = closedQuote(text, index, QUOTE)
		} else if (code === HASH) {
			const end = skipError(text, index)

			index = end === index + 1 ? -1 : end
		} else if (ARRAY_NUMBER.test(text)) {
			index = ARRAY_NUMBER.lastIndex
		} else {
			const end = readWord(text, index)
			const word = text.slice(index, end).toUpperCase()

			index = word === "TRUE" || word === "FALSE" ? end : -1
		}

		if (index < 0) return -1

		while (isSpace(text.charCodeAt(index))) index++

		const separator = text.charCodeAt(index++)

		if (separator === 125) return index
		if (separator !== 44 && separator !== 59) return -1
	}
}

// Whether a typed formula (without its "=") reads as one, as Excel's grammar has it: strings, quoted sheet
// names and brackets closed, parentheses paired, an operand on either side of every operator, array
// constants of constants only, and ";" only between an array's rows (an argument separator elsewhere, as
// some locales type it, is not Excel's). Anything past the grammar (an unknown name, a wrong argument
// count) is a result for the formula to show, not a reason to refuse it.
export function wellFormedFormula(formula: string): boolean {
	// Each open parenthesis: a call's, whose arguments may be left empty, or a group's.
	const frames: ("call" | "group")[] = []
	// Whether an operand comes next, rather than an operator; and whether, right after a call's "(" or
	// ",", nothing may come instead (an argument left empty).
	let operand = true
	let empty = false
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)
		const frame = frames.at(-1)

		if (isSpace(code)) {
			while (isSpace(formula.charCodeAt(index))) index++

			// Between two operands, a space is the intersection operator.
			if (!operand && index < formula.length && startsOperand(formula.charCodeAt(index))) operand = true

			continue
		}

		const allowsEmpty = empty

		empty = false

		if (code === QUOTE || code === 123) {
			const end = code === QUOTE ? closedQuote(formula, index, QUOTE) : arrayEnd(formula, index)

			if (!operand || end < 0) return false

			index = end
			operand = false

			continue
		}

		if (isWordChar(code) || code === APOSTROPHE || code === BRACKET_OPEN) {
			const end = operand ? nameEnd(formula, index) : -1

			if (end < 0) return false

			index = end

			if (formula.charCodeAt(index) === 40) {
				frames.push("call")
				index++
				empty = true
			} else {
				operand = false
			}

			continue
		}

		index++

		switch (code) {
			case HASH:
				// An error value, or (after a reference) its spilled range.
				if (operand) {
					const end = skipError(formula, index - 1)

					if (end === index) return false

					// A reference into a deleted sheet (#REF!A1) goes on past its error.
					index = formula.charCodeAt(end - 1) === 33 && isWordChar(formula.charCodeAt(end)) ? readWord(formula, end) : end
					operand = false
				}

				break
			case 40:
				// A group, or a call on what a call returned (LAMBDA(x, x + 1)(2)).
				if (operand) {
					frames.push("group")
				} else if (formula.charCodeAt(index - 2) === 41) {
					frames.push("call")
					operand = true
					empty = true
				} else {
					return false
				}

				break
			case 41:
				if ((operand && !(frame === "call" && allowsEmpty)) || frames.pop() === undefined) return false

				operand = false

				break
			case 44:
				// An argument may be left empty; anywhere else a comma joins two operands.
				if (operand && !(frame === "call" && allowsEmpty)) return false

				operand = true
				empty = frame === "call"

				break
			case 43:
			case 45:
				operand = true

				break
			case 64:
				// Implicit intersection, before what it applies to.
				if (!operand) return false

				break
			case 37:
				if (operand) return false

				break
			case 42:
			case 47:
			case 94:
			case 38:
			case 61:
			case 58:
			case 60:
			case 62:
				if (operand) return false

				// <=, >=, <>
				if (
					(code === 60 || code === 62) &&
					(formula.charCodeAt(index) === 61 || (code === 60 && formula.charCodeAt(index) === 62))
				) {
					index++
				}

				operand = true

				break
			default:
				return false
		}
	}

	return !operand && frames.length === 0
}

// Parentheses past this depth overflow HyperFormula's recursive parser (Excel stops at 64 levels).
const MAX_DEPTH = 100

// Whether HyperFormula can be handed the formula at all: its parser recurses once per nesting level.
function engineCanParse(formula: string): boolean {
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
export const ARRAY_RESULTS: ReadonlySet<string> = new Set([
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
	"XLOOKUP",
	"TEXTSPLIT",
	"TAKE",
	"DROP",
	"CHOOSECOLS",
	"CHOOSEROWS",
	"MODE.MULT",
	"TREND",
	"MAP",
	"SCAN",
	"BYROW",
	"BYCOL",
	"MAKEARRAY",
	"REGEXEXTRACT",
	"TOCOL",
	"TOROW",
	"WRAPCOLS",
	"WRAPROWS",
	"EXPAND",
	"TRIMRANGE",
	"LINEST",
	"LOGEST",
	"GROWTH",
	"GROUPBY",
	"PIVOTBY",
	// A spill range reference (A1#) as the file stores it and as the engine reads it.
	"ANCHORARRAY",
	ANCHOR_FUNCTION
])

// A call to any of ARRAY_RESULTS, or to one of them but XLOOKUP, in any case: one test where each name would be one.
const CALLS_ARRAY_RESULT = new RegExp(`(?:${[...ARRAY_RESULTS].map(name => name.replaceAll(".", "\\.")).join("|")})\\(`, "i")
const BUILDS_ARRAY = new RegExp(`(?:${[...ARRAY_RESULTS].filter(name => name !== "XLOOKUP").join("|")})\\(`, "i")
const CALLS_SIZED = /(?:SEQUENCE|RANDARRAY|MUNIT)\(/i

// The most cells an array a formula builds may hold: the engine keeps every value of it, a few hundred
// bytes each.
const MAX_ARRAY_CELLS = 200_000

// Whether the formula calls an array-returning function over more cells than MAX_ARRAY_CELLS, going by
// its literal sizes (SEQUENCE(1000,1000)) and the largest range it names.
function arrayTooLarge(formula: string): boolean {
	if (!BUILDS_ARRAY.test(formula)) {
		return false
	}

	const upper = formula.toUpperCase()

	for (const [, name, rows = "1", cols = "1"] of upper.matchAll(/(SEQUENCE|RANDARRAY|MUNIT)\(\s*(\d+)\s*(?:,\s*(\d+))?/g)) {
		const size = name === "MUNIT" ? Number(rows) ** 2 : Number(rows) * Number(cols)

		if (size > MAX_ARRAY_CELLS) return true
	}

	return formulaParts(formula).some(part => {
		if (typeof part === "string" || part.ref.area === null) return false

		const area = part.ref.area
		const rows = area.kind === "cols" ? MAX_ROWS : Math.abs(area.endRow - area.startRow) + 1
		const cols = area.kind === "rows" ? MAX_COLUMNS : Math.abs(area.endCol - area.startCol) + 1

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

// Whether a formula holds a bracket outside strings: a structured reference (Table1[Amount]) or one into another
// workbook ([1]Sheet1!A1, '[1]Sheet 1'!A1), which the engine has no syntax for. A bracket inside a quoted sheet
// name is a workbook's only at its start.
export function holdsBracket(formula: string): boolean {
	if (!formula.includes("[")) return false

	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === APOSTROPHE && formula.charCodeAt(index + 1) === BRACKET_OPEN) {
			const end = skipQuoted(formula, index, code)

			if (formula.charCodeAt(end) === 33) return true

			index = end
		} else if (code === QUOTE || code === APOSTROPHE) index = skipQuoted(formula, index, code)
		else if (code === BRACKET_OPEN) return true
		else index++
	}

	return false
}

// Whether a formula holds an array constant: a brace outside strings, quoted sheet names and brackets.
export function holdsArrayConstant(formula: string): boolean {
	if (!formula.includes("{")) return false

	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) index = skipQuoted(formula, index, code)
		else if (code === BRACKET_OPEN) index = skipBracket(formula, index)
		else if (code === 123) return true
		else index++
	}

	return false
}

// A cell's formula as HyperFormula takes it (with its "="), or null when it cannot be given to it: nested
// past its parser's depth, or building an array too large to hold. Evaluated as Excel reads an ordinary
// formula: an array result gives its first value (INDEX), and nothing spills.
export function engineCellFormula(formula: string, aliases?: ReadonlyMap<string, string>, lambdas?: ReadonlySet<string>): string | null {
	if (!engineCanParse(formula) || arrayTooLarge(formula)) {
		return null
	}

	const read = engineFormula(RESIZED_CALL.test(formula) ? resizedSumRanges(formula) : formula, aliases, lambdas)
	const text = CALLS_SIZED.test(read) ? boundArraySizes(read) : read

	if (CALLS_ARRAY_RESULT.test(text)) return `=INDEX((${text}),1,1)`

	// A formula that is a range alone (=B1:B9, =Sheet2!A1:C1) gives the cell of it in the formula's row or column, as
	// Excel reads an ordinary formula (implicit intersection).
	return rangeAlone(formula) ? `=${INTERSECT_FUNCTION}(${text})` : `=${text}`
}

// A formula's text evaluated as an array, without spilling (ARRAYFORMULA): what FormulaEngine.givesArray reads.
export function engineArrayFormula(formula: string, aliases?: ReadonlyMap<string, string>, lambdas?: ReadonlySet<string>): string | null {
	if (!engineCanParse(formula) || arrayTooLarge(formula)) return null

	const read = engineFormula(RESIZED_CALL.test(formula) ? resizedSumRanges(formula) : formula, aliases, lambdas)

	return `=ARRAYFORMULA(${CALLS_SIZED.test(read) ? boundArraySizes(read) : read})`
}

// A dynamic-array formula's text as the engine takes it (with its "="): evaluated as an array and spilled
// (SPILL_FUNCTION), or null when it cannot be given to it.
export function engineSpillFormula(formula: string, aliases?: ReadonlyMap<string, string>, lambdas?: ReadonlySet<string>): string | null {
	if (!engineCanParse(formula) || arrayTooLarge(formula)) return null

	const read = engineFormula(RESIZED_CALL.test(formula) ? resizedSumRanges(formula) : formula, aliases, lambdas)

	return `=${SPILL_FUNCTION}(${CALLS_SIZED.test(read) ? boundArraySizes(read) : read})`
}

// Operators that take one value from each side: a range beside one makes an array of the operation.
const OPERATORS = new Set(["+", "-", "*", "/", "^", "&", "=", "<", ">", "%"])

// Whether a formula may give an array as Excel's dynamic arrays calculate it: it calls a function returning one, is a
// range alone, or takes a range into an operation (A1:A9*2). A range given to a function's argument is read by the
// function (SUM) and gives no array.
export function mayReturnArray(formula: string): boolean {
	if (CALLS_ARRAY_RESULT.test(formula) || rangeAlone(formula)) return true
	if (!formula.includes(":")) return false

	const parts = intersected(formulaParts(formula))

	return parts.some((part, index) => {
		if (typeof part === "string" || part.ref.external || part.ref.area === null) return false

		const area = part.ref.area

		if (!area.range && area.kind === "cell") return false

		const before = parts[index - 1]
		const after = parts[index + 1]
		const left = typeof before === "string" ? before.trimEnd().at(-1) : undefined
		const right = typeof after === "string" ? after.trimStart()[0] : undefined

		return (left !== undefined && OPERATORS.has(left)) || (right !== undefined && OPERATORS.has(right))
	})
}

// Whether the formula is one reference to more than one cell (an intersection of two too), and nothing else.
function rangeAlone(formula: string): boolean {
	if (!formula.includes(":")) return false

	const parts = intersected(formulaParts(formula))
	let ref: RefPart | null = null

	for (const part of parts) {
		if (typeof part === "string") {
			if (part.trim() !== "") return false
		} else if (ref === null) ref = part
		else return false
	}

	const area = ref?.ref.area

	return ref !== null && !ref.ref.external && area !== null && area !== undefined && (area.range || area.kind !== "cell")
}

const RESIZED_CALL = /(?:SUMIF|AVERAGEIF|LOOKUP)\(/i
const RESIZED = /^(?:_xlfn\.)?(?:SUMIF|AVERAGEIF)$/i

// The reference an argument is, alone, or null.
function soleReference(text: string): RefPart | null {
	const parts = formulaParts(text.trim())
	const part = parts[0]

	return parts.length === 1 && part !== undefined && typeof part !== "string" && !part.ref.external && part.ref.area !== null
		? part
		: null
}

// SUMIF and AVERAGEIF with a sum_range of another size than the range it is tested over: Excel reads the sum_range
// as starting at its top-left cell with the range's size ("The sum_range argument does not have to be the same
// size and shape as the range argument. The actual cells that are added are determined by using the upper
// leftmost cell in the sum_range argument as the beginning cell, and then including cells that correspond in
// size and shape to the range argument": support.microsoft.com "SUMIF function"); the engine wants one size.
// Rewritten so where both are plain references (the engine then follows the cells it reads); and LOOKUP's
// result_vector shorter than its lookup_vector likewise.
function resizedSumRanges(formula: string): string {
	let out = ""
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			const end = skipQuoted(formula, index, code)

			out += formula.slice(index, end)
			index = end

			continue
		}

		if (code === BRACKET_OPEN) {
			const end = skipBracket(formula, index)

			out += formula.slice(index, end)
			index = end

			continue
		}

		if (!isWordChar(code)) {
			out += formula[index] ?? ""
			index++

			continue
		}

		const end = readWord(formula, index)
		const word = formula.slice(index, end)
		const call = formula.charCodeAt(end) === 40 ? callArguments(formula, end) : null

		if (call === null) {
			out += word
			index = end

			continue
		}

		const args = call.args.map(resizedSumRanges)
		const range = args.length === 3 && RESIZED.test(word) ? soleReference(args[0] ?? "") : null
		const sum = range === null ? null : soleReference(args[2] ?? "")
		const resized = range === null || sum === null ? null : resizedArea(range.ref.area as RefArea, sum.ref.area as RefArea)

		if (resized !== null && sum !== null) args[2] = `${sum.prefix}${areaText(resized)}`

		// LOOKUP's result_vector shorter than lookup_vector: read on from its first cell, along itself (one cell: along
		// lookup_vector), as Excel and LibreOffice read it.
		if (args.length === 3 && /^LOOKUP$/i.test(word)) {
			const vector = soleReference(args[1] ?? "")?.ref.area
			const result = soleReference(args[2] ?? "")
			const area = result?.ref.area

			if (vector !== undefined && vector !== null && result !== null && area?.kind === "cell" && vector.kind === "cell") {
				const length = Math.max(Math.abs(vector.endRow - vector.startRow), Math.abs(vector.endCol - vector.startCol)) + 1
				const rows = Math.abs(area.endRow - area.startRow) + 1
				const cols = Math.abs(area.endCol - area.startCol) + 1
				const down = area.range
					? cols === 1
					: Math.abs(vector.endRow - vector.startRow) >= Math.abs(vector.endCol - vector.startCol)
				const shape: RefArea = down
					? { ...vector, startRow: 0, startCol: 0, endRow: length - 1, endCol: 0 }
					: { ...vector, startRow: 0, startCol: 0, endRow: 0, endCol: length - 1 }

				if ((rows === 1 || cols === 1) && Math.max(rows, cols) < length) {
					const grown = resizedArea(shape, area)

					if (grown !== null) args[2] = `${result.prefix}${areaText(grown)}`
				}
			}
		}

		out += `${word}(${args.join(",")})`
		index = call.end
	}

	return out
}

// `sum` from its top-left cell with `range`'s size, or null when it already has it (or either spans whole rows or
// columns, whose size the text does not give).
function resizedArea(range: RefArea, sum: RefArea): RefArea | null {
	if (range.kind !== "cell" || sum.kind !== "cell") return null

	const rows = Math.abs(range.endRow - range.startRow)
	const cols = Math.abs(range.endCol - range.startCol)
	const top = Math.min(sum.startRow, sum.endRow)
	const left = Math.min(sum.startCol, sum.endCol)

	if (Math.abs(sum.endRow - sum.startRow) === rows && Math.abs(sum.endCol - sum.startCol) === cols) return null
	if (top + rows >= MAX_ROWS || left + cols >= MAX_COLUMNS) return null

	const topAbs = sum.startRow <= sum.endRow ? sum.startRowAbs : sum.endRowAbs
	const leftAbs = sum.startCol <= sum.endCol ? sum.startColAbs : sum.endColAbs

	return {
		kind: "cell",
		range: rows > 0 || cols > 0,
		startRow: top,
		startCol: left,
		endRow: top + rows,
		endCol: left + cols,
		startRowAbs: topAbs,
		startColAbs: leftAbs,
		endRowAbs: topAbs,
		endColAbs: leftAbs
	}
}

// What an intersection of references that do not meet gives: Excel's #NULL!.
const NULL_CALL = `${NULL_FUNCTION}()`

// The text between the two operands of an intersection: spaces alone (support.microsoft.com "Calculation operators and
// precedence in Excel": "space" is the intersection operator).
const SPACES = /^ +$/

// An area's rows and columns, low to high: top, left, bottom, right.
function bounds(area: RefArea): readonly [number, number, number, number] {
	return [
		area.kind === "cols" ? 0 : Math.min(area.startRow, area.endRow),
		area.kind === "rows" ? 0 : Math.min(area.startCol, area.endCol),
		area.kind === "cols" ? MAX_ROWS - 1 : Math.max(area.startRow, area.endRow),
		area.kind === "rows" ? MAX_COLUMNS - 1 : Math.max(area.startCol, area.endCol)
	]
}

// The intersection of two references (A1:B3 B2:C4): the reference to the cells both hold, NULL_CALL where they hold
// none, or null where the text cannot tell (another workbook, several sheets, a name, two sheets that may differ). The
// engine reads the same cells whether a reference is absolute or not, so the one given is relative.
function meeting(a: RefPart, b: RefPart): RefPart | string | null {
	const first = a.ref
	const second = b.ref

	if (first.area === null || second.area === null || first.external || second.external) return null
	if (first.lastSheet !== null || second.lastSheet !== null) return null
	if (first.sheet === null ? second.sheet !== null : second.sheet === null || !sameSheet(first.sheet, second.sheet)) return null

	const [aTop, aLeft, aBottom, aRight] = bounds(first.area)
	const [bTop, bLeft, bBottom, bRight] = bounds(second.area)
	const top = Math.max(aTop, bTop)
	const left = Math.max(aLeft, bLeft)
	const bottom = Math.min(aBottom, bBottom)
	const right = Math.min(aRight, bRight)

	if (top > bottom || left > right) return NULL_CALL

	const kind = first.area.kind === second.area.kind ? first.area.kind : "cell"
	const area: RefArea = {
		kind,
		range: kind !== "cell" || top !== bottom || left !== right,
		startRow: top,
		startCol: left,
		endRow: bottom,
		endCol: right,
		startRowAbs: false,
		startColAbs: false,
		endRowAbs: false,
		endColAbs: false
	}

	return { ref: { ...first, area }, prefix: a.prefix, areaText: areaText(area) }
}

// Whether the text around an intersection's operands leaves them whole: a range or spill operator beside one binds
// first (INDEX(…):A1 B1), and @ is left as written.
function wholeOperands(before: Part | undefined, after: Part | undefined): boolean {
	const end = typeof before === "string" ? before.trimEnd().at(-1) : undefined
	const start = typeof after === "string" ? after.trimStart()[0] : undefined

	return end !== ":" && end !== "@" && start !== ":" && start !== "#"
}

// The parts with each intersection of two literal references on one sheet resolved: the reference both hold, or
// NULL_CALL. Others (a name, OFFSET) are left as written, which the engine cannot read.
function intersected(parts: readonly Part[]): readonly Part[] {
	// Copied only once an intersection is resolved.
	let out: Part[] | null = null

	for (let index = 0; index < parts.length; index++) {
		const part = parts[index] ?? ""
		const held = out ?? parts
		const length = out === null ? index : held.length
		const gap = held[length - 1]
		const left = held[length - 2]

		if (
			typeof part !== "string" &&
			typeof gap === "string" &&
			left !== undefined &&
			SPACES.test(gap) &&
			wholeOperands(held[length - 3], parts[index + 1])
		) {
			const met = left === NULL_CALL ? NULL_CALL : typeof left === "string" ? null : meeting(left, part)

			if (met !== null) {
				out ??= parts.slice(0, index)
				out.splice(-2, 2, met)

				continue
			}
		}

		out?.push(part)
	}

	return out ?? parts
}

// The functions whose reference arguments are read alike one by one, so a union given as one ((A1,B2:C3)) reads as its
// references given apart.
const UNION_CALLS: ReadonlySet<string> = new Set([
	"SUM",
	"COUNT",
	"COUNTA",
	"AVERAGE",
	"AVERAGEA",
	"MIN",
	"MAX",
	"MINA",
	"MAXA",
	"PRODUCT",
	"SUMSQ",
	"STDEV",
	"STDEV.S",
	"STDEV.P",
	"STDEVA",
	"STDEVP",
	"STDEVPA",
	"VAR",
	"VAR.S",
	"VAR.P",
	"VARA",
	"VARP",
	"VARPA",
	"MEDIAN"
])

function partText(part: Part): string {
	return typeof part === "string" ? part : part.prefix + part.areaText
}

// A union of references written whole as one argument, from its "(" at `open` in parts[at]: how many areas it has,
// whether an intersection in it met nowhere, and where its ")" is (parts[last] at `close`); null for anything else.
function unionAt(
	parts: readonly Part[],
	at: number,
	open: number
): { readonly count: number; readonly empty: boolean; readonly last: number; readonly close: number } | null {
	const head = parts[at]

	if (typeof head !== "string" || head.slice(open + 1).trim() !== "") return null

	let count = 0
	let empty = false

	for (let index = at + 1; ; index += 2) {
		const element = parts[index]
		const separator = parts[index + 1]

		if (element === undefined || typeof separator !== "string") return null

		if (typeof element === "string") {
			if (element !== NULL_CALL) return null

			empty = true
		} else if (element.ref.external || element.ref.area === null || element.ref.lastSheet !== null) return null

		count++

		const trimmed = separator.trimStart()

		if (trimmed.startsWith(",")) {
			if (trimmed.slice(1).trim() !== "") return null

			continue
		}

		if (!trimmed.startsWith(")") || count < 2) return null

		const close = separator.length - trimmed.length
		const rest = separator.slice(close + 1).trimStart()

		return rest.startsWith(",") || rest.startsWith(")") ? { count, empty, last: index + 1, close } : null
	}
}

// Unions of literal references given to a function of UNION_CALLS, as its references given apart (SUM((A1,B2)) is
// SUM(A1,B2)), and to AREAS, as their count. Others are left as written, which the engine cannot read.
function unions(parts: readonly Part[]): string {
	const frames: { readonly call: string | null; readonly at: number }[] = []
	let text = ""
	let call: { readonly name: string; readonly at: number } | null = null
	let at = 0
	let start = 0

	while (at < parts.length) {
		const part = parts[at] ?? ""

		if (typeof part !== "string") {
			text += partText(part)
			call = null
			at++

			continue
		}

		let index = start
		let resumed = false

		start = 0

		while (index < part.length) {
			const code = part.charCodeAt(index)

			if (code === QUOTE || code === APOSTROPHE || code === BRACKET_OPEN) {
				const end = code === BRACKET_OPEN ? skipBracket(part, index) : skipQuoted(part, index, code)

				text += part.slice(index, end)
				index = end
				call = null

				continue
			}

			if (isWordChar(code)) {
				const end = readWord(part, index)
				const word = part.slice(index, end)

				call = part.charCodeAt(end) === 40 ? { name: bareFunctionName(word).toUpperCase(), at: text.length } : null
				text += word
				index = end

				continue
			}

			if (code === 40) {
				const top = frames.at(-1)
				const lead = text.trimEnd().at(-1)
				const union =
					call === null &&
					top !== undefined &&
					top.call !== null &&
					(UNION_CALLS.has(top.call) || top.call === "AREAS") &&
					(lead === "(" || lead === ",")
						? unionAt(parts, at, index)
						: null

				if (top !== undefined && union !== null) {
					const closing = parts[union.last] ?? ""
					const after = partText(closing).slice(union.close + 1)

					if (top.call !== "AREAS") {
						text += part.slice(index + 1)

						for (let next = at + 1; next < union.last; next++) text += partText(parts[next] ?? "")

						at = union.last
						start = union.close + 1
						resumed = true

						break
					}

					const sole = /^\s*\)/.exec(after)

					if (lead === "(" && sole !== null) {
						text = text.slice(0, top.at) + (union.empty ? NULL_CALL : String(union.count))
						frames.pop()
						at = union.last
						start = union.close + 1 + sole[0].length
						resumed = true

						break
					}
				}

				frames.push({ call: call?.name ?? null, at: call?.at ?? -1 })
			} else if (code === 123) frames.push({ call: null, at: -1 })
			else if (code === 41 || code === 125) frames.pop()

			call = null
			text += part[index] ?? ""
			index++
		}

		if (!resumed) at++
	}

	return text
}

// Where a formula may hold what the engine cannot parse: OFFSET, which it resolves as it parses and so only with
// integer literals, or a range with a function at an end (A1:INDEX(A:A,3)), of which it reads OFFSET's alone.
const DYNAMIC_REFERENCE = /(?:OFFSET|INDEX|INDIRECT)\(/i

// The first sheet of an unquoted 3-D reference at the end of the text so far (Jan: of Jan:Mar!A1).
const SPAN_START = /(?:^|[^\p{L}\p{N}_.$'])([\p{L}_][\p{L}\p{N}_.]*):$/u

// An operand dynamicReferences reads: its text as the engine takes it, and for a function call its name (upper case)
// and arguments as the engine takes them.
interface Operand {
	readonly text: string
	readonly end: number
	readonly call: string | null
	readonly args: string
	// An OFFSET the engine resolves as it parses to one cell, which it reads at an end of a range too.
	readonly staticCell: boolean
}

// Whether a text is one cell's reference (Sheet1!$A$1) and nothing else.
function oneCellReference(text: string): boolean {
	const ref = singleReference(text.trim())

	return ref?.area?.kind === "cell" && !ref.area.range && !ref.external && ref.lastSheet === null
}

// Whether the engine resolves OFFSET with these arguments as it parses (its handleOffsetHeuristic): a cell reference,
// integer rows and cols, and positive integer height and width, each a literal.
function staticOffset(args: readonly string[]): boolean {
	const [base, rows, cols, height, width] = args.map(arg => arg.trim())

	return (
		args.length >= 3 &&
		args.length <= 5 &&
		base !== undefined &&
		oneCellReference(base) &&
		/^[+-]?\d+$/.test(rows ?? "") &&
		/^[+-]?\d+$/.test(cols ?? "") &&
		(height === undefined || (/^\d+$/.test(height) && Number(height) > 0)) &&
		(width === undefined || (/^\d+$/.test(width) && Number(width) > 0))
	)
}

// The operand at `start`: a reference ('My Sheet'!A1, an end of A1:B2) or another word, or a function call, its
// arguments read in turn; null where none starts.
function dynamicOperand(text: string, start: number): Operand | null {
	const code = text.charCodeAt(start)
	let end: number

	if (code === APOSTROPHE) {
		end = skipQuoted(text, start, APOSTROPHE)

		if (text.charCodeAt(end) !== 33) return null

		end = readWord(text, end + 1)
	} else if (isWordChar(code)) {
		end = readWord(text, start)

		if (text.charCodeAt(end) === 33) end = readWord(text, end + 1)
		else if (text.charCodeAt(end) === 40) {
			const call = callArguments(text, end)

			if (call !== null) {
				const name = text.slice(start, end).toUpperCase()
				const args = call.args.map(dynamicReferences).join(",")
				const offset = name === "OFFSET"
				const fixed = offset && staticOffset(call.args)

				return {
					text: `${offset && !fixed ? OFFSET_FUNCTION : text.slice(start, end)}(${args})`,
					end: call.end,
					call: name,
					args,
					staticCell: fixed && call.args.length <= 3
				}
			}
		}
	} else return null

	return { text: text.slice(start, end), end, call: null, args: "", staticCell: false }
}

// An operand as an end of a range given to RANGE_FUNCTION: INDEX as the reference it gives.
function rangeEnd(operand: Operand): string {
	return operand.call === "INDEX" ? `${INDEX_REFERENCE_FUNCTION}(${operand.args})` : operand.text
}

// A formula's text with each OFFSET the engine cannot resolve as it parses given to OFFSET_FUNCTION, and each range
// with a function at an end (A1:INDEX(A:A,3), INDIRECT("A1"):B2, A1:OFFSET(A1,B1,0)) to RANGE_FUNCTION. A range of
// two references, or of a cell and an OFFSET the engine resolves to one, stays as written.
function dynamicReferences(text: string): string {
	let out = ""
	let index = 0

	while (index < text.length) {
		const code = text.charCodeAt(index)
		let operand = code === QUOTE || code === HASH || code === BRACKET_OPEN ? null : dynamicOperand(text, index)

		if (operand === null) {
			const end =
				code === QUOTE || code === APOSTROPHE
					? skipQuoted(text, index, code)
					: code === BRACKET_OPEN
						? skipBracket(text, index)
						: code === HASH
							? skipError(text, index)
							: index + 1

			out += text.slice(index, end)
			index = end

			continue
		}

		while (text.charCodeAt(operand.end) === 58) {
			const left: Operand = operand
			const right = dynamicOperand(text, left.end + 1)

			if (right === null) break

			const plain =
				(left.call === null && right.call === null) ||
				(left.staticCell && (right.staticCell || (right.call === null && oneCellReference(right.text)))) ||
				(right.staticCell && left.call === null && oneCellReference(left.text))

			operand = {
				text: plain ? `${left.text}:${right.text}` : `${RANGE_FUNCTION}(${rangeEnd(left)},${rangeEnd(right)})`,
				end: right.end,
				call: plain ? null : RANGE_FUNCTION,
				args: "",
				staticCell: false
			}
		}

		out += operand.text
		index = operand.end
	}

	return out
}

// A formula that may hold an intersection or a union of references.
const REFERENCE_OPERATOR = /[\w$] +[^\s,)&+\-*/^=<>%]|[(,]\s*\(/

// The reference operators the engine has none of, rewritten where the text tells what they give: an intersection of
// literal references as the reference to the cells both hold (#NULL! when none), a union given whole to a function
// reading its references alike (SUM, AREAS) as those references.
function referenceOperators(formula: string): string {
	return REFERENCE_OPERATOR.test(formula) ? unions(intersected(formulaParts(formula))) : formula
}

// Excel formula text as HyperFormula reads it, where only the spelling differs: function names lose the
// _xlfn./_xlws. prefixes files store for newer functions, TRUE and FALSE become the functions HyperFormula
// has for them, exponents take a lower-case "e", a string literal with a doubled quote is spelled with
// CHAR(34) (HyperFormula has no escape for it; inside an array constant it is left to fail), and calls
// that evaluate arrays are wrapped in ARRAYFORMULA. Intersections and unions of references are rewritten where the
// text tells what they give (referenceOperators). What HyperFormula still cannot read (other intersections and
// unions, structured and external references) fails to parse there, and the caller keeps the file's own
// result. A defined name in `aliases` (upper case) is spelled as its alias: the engine reads some names Excel
// takes (CustomCost1, R2D2) as references.
export function engineFormula(written: string, aliases?: ReadonlyMap<string, string>, lambdas?: ReadonlySet<string>): string {
	const source = referenceOperators(written)
	const trimmed = /_xlfn\._TRO_/i.test(source) ? engineTrimReferences(source) : source
	const formula = DYNAMIC_REFERENCE.test(trimmed) ? dynamicReferences(trimmed) : trimmed
	let text = ""
	let braces = 0
	let index = 0
	// Per open parenthesis: whether it opened a call wrapped in ARRAYFORMULA, which closes with it, and for a call
	// taking criteria, which argument is being written and whether it is wrapped in CRITERION_FUNCTION.
	const opened: {
		wrap: boolean
		criteria: ((index: number) => boolean) | null
		arg: number
		braces: number
		criterion: boolean
		// Where a LAMBDA call's text starts, should it be called in place (LAMBDA(x,x)(1)).
		lambda: number
	}[] = []
	let wrapNext = false
	// The next "(" opens the values of a LAMBDA called through CALL_FUNCTION, which has opened already.
	let callNext = false
	let lambdaNext = -1
	let criteriaNext: ((index: number) => boolean) | null = null

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

			// A number starts with a digit or a point; only those are read for an exponent.
			const numeric = (code >= 48 && code <= 57) || code === 46

			if (next === 40 && (isParameter(word) || lambdas?.has(word.toUpperCase()) === true)) {
				// A call of a LET or LAMBDA name (_xlpm.f(1)) or of a defined name holding a LAMBDA (MyFn(1)), which the
				// engine reads as an unknown function.
				text += `${CALL_FUNCTION}(${isParameter(word) ? word : (aliases?.get(word.toUpperCase()) ?? word)}`
				callNext = true
			} else if (next === 40) {
				const bare = code === 95 ? bareFunctionName(word) : word
				const name = ENGINE_SPELLED.get(bare.toUpperCase()) ?? bare

				wrapNext = ARRAY_ARGUMENTS.has(name.toUpperCase())
				criteriaNext = CRITERIA.get(name.toUpperCase()) ?? null
				lambdaNext = name.toUpperCase() === "LAMBDA" ? text.length : -1
				text += wrapNext ? `ARRAYFORMULA(${name}` : name
			} else if (numeric && (next === 43 || next === 45) && /^(\d+\.?\d*|\.\d+)E$/i.test(word)) {
				text += `${word.slice(0, -1)}e`
			} else if (numeric && /^(\d+\.?\d*|\.\d+)E\d+$/i.test(word)) {
				text += word.replace(/E/i, "e")
			} else if (next === 33) {
				// HyperFormula reads only plain ASCII sheet names unquoted (not 数据!A1, not Q1.2024!A1). A 3-D reference's
				// first sheet (Jan:Mar!A1) is quoted with the last ('Jan:Mar'!A1), as one prefix.
				const start = formula.charCodeAt(index - 1) === 58 ? SPAN_START.exec(text)?.[1] : undefined
				// A cell before the colon (A1:Mar!B2) is a range's start, which no sheet name unquoted can be.
				const first = start === undefined || /^[A-Za-z]{1,3}[0-9]+$/.test(start) ? undefined : start

				text =
					first === undefined
						? `${text}'${word.replaceAll("'", "''")}'`
						: `${text.slice(0, text.length - first.length - 1)}'${first}:${word}'`
			} else if (next !== 58 && (word.length === 4 || word.length === 5) && /^(TRUE|FALSE)$/i.test(word)) {
				text += `${word}()`
			} else {
				// A word on either side of ":" is a column of a range (AA:AA), never a name.
				const column = next === 58 || formula.charCodeAt(index - 1) === 58

				text += !numeric && !column && aliases !== undefined && aliases.size > 0 ? (aliases.get(word.toUpperCase()) ?? word) : word
			}

			index = end
		} else {
			if (code === 123) braces++
			if (code === 125) braces--

			const frame = opened.at(-1)

			// The end of a criteria argument.
			if ((code === 41 || (code === 44 && frame?.braces === braces)) && frame?.criterion === true) {
				text += ")"
				frame.criterion = false
			}

			// The values of a LAMBDA called follow the LAMBDA as CALL_FUNCTION's next arguments.
			if (code === 40 && callNext) text += nextCode(formula, index + 1) === 41 ? "" : ","
			else text += formula[index] ?? ""

			if (code === 40) {
				const criteria = criteriaNext
				const criterion = criteria?.(0) === true

				opened.push({ wrap: wrapNext, criteria, arg: 0, braces, criterion, lambda: callNext ? -1 : lambdaNext })
				callNext = false
				lambdaNext = -1

				if (criterion) text += `${CRITERION_FUNCTION}(`

				wrapNext = false
				criteriaNext = null
			} else if (code === 44 && frame !== undefined && frame.criteria !== null && frame.braces === braces) {
				frame.arg++
				frame.criterion = frame.criteria(frame.arg)

				if (frame.criterion) text += `${CRITERION_FUNCTION}(`
			} else if (code === 41) {
				const closed = opened.pop()

				if (closed?.wrap === true) text += ")"

				// A LAMBDA called in place: LAMBDA(x,x)(1) is CALL_FUNCTION(LAMBDA(x,x),1).
				if (closed !== undefined && closed.lambda >= 0 && nextCode(formula, index + 1) === 40) {
					text = `${text.slice(0, closed.lambda)}${CALL_FUNCTION}(${text.slice(closed.lambda)}`
					callNext = true
				}
			}

			index++
		}
	}

	return text
}

// The criteria arguments of the functions that take them, by position from 0. Each is given to the engine through
// CRITERION_FUNCTION, which reads an empty cell as 0 as Excel does.
const CRITERIA: ReadonlyMap<string, (index: number) => boolean> = new Map([
	["COUNTIF", (index: number) => index === 1],
	["SUMIF", (index: number) => index === 1],
	["AVERAGEIF", (index: number) => index === 1],
	["COUNTIFS", (index: number) => index % 2 === 1],
	["SUMIFS", (index: number) => index >= 2 && index % 2 === 0],
	["AVERAGEIFS", (index: number) => index >= 2 && index % 2 === 0],
	["MAXIFS", (index: number) => index >= 2 && index % 2 === 0],
	["MINIFS", (index: number) => index >= 2 && index % 2 === 0]
])

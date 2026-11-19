import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../../sheet/protocol"
import { columnName } from "../../sheet/refs/cellRef"
import { skipQuoted } from "../../sheet/refs/scan"

// Moves the relative references of an A1 formula by (rows, cols), as a shared formula's text applies to each of
// its cells (ECMA-376 Part 1 §18.3.1.40): absolute parts ($) stay, strings, sheet names, structured references,
// external workbook indexes and function names are copied. A reference moved off the grid becomes #REF!.

function isLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57
}

// Characters that continue a name or a number: a reference is a whole token, never part of one.
function isNameChar(code: number): boolean {
	return isLetter(code) || isDigit(code) || code === 95 || code === 46 || code === 92 || code === 63 || code >= 128
}

interface Part {
	// Column (0-based) or row (0-based) and whether it is absolute; -1 when absent.
	col: number
	colAbsolute: boolean
	row: number
	rowAbsolute: boolean
	end: number
}

// A cell (A1), a column (A) or a row (1) reference part at `i`, the token ending there; null for none.
function readPart(text: string, i: number, allow: "cell" | "col" | "row"): Part | null {
	let at = i
	const part: Part = { col: -1, colAbsolute: false, row: -1, rowAbsolute: false, end: i }

	if (allow !== "row") {
		const absolute = text.charCodeAt(at) === 36

		if (absolute) at++

		let col = 0
		let letters = 0

		while (letters < 4 && isLetter(text.charCodeAt(at))) {
			col = col * 26 + ((text.charCodeAt(at) | 32) - 96)
			at++
			letters++
		}

		if (letters === 0 || letters > 3 || col > SHEET_MAX_COLS) return null

		part.col = col - 1
		part.colAbsolute = absolute
	}

	if (allow !== "col") {
		const absolute = text.charCodeAt(at) === 36

		if (absolute) at++

		let row = 0
		let digits = 0

		while (isDigit(text.charCodeAt(at))) {
			row = row * 10 + text.charCodeAt(at) - 48
			at++
			digits++
		}

		if (digits === 0 || digits > 7 || row === 0 || row > SHEET_MAX_ROWS) return null

		part.row = row - 1
		part.rowAbsolute = absolute
	}

	if (isNameChar(text.charCodeAt(at)) || text.charCodeAt(at) === 36 || text.charCodeAt(at) === 40) return null

	part.end = at

	return part
}

// The part moved, or null when it leaves the grid.
function movePart(part: Part, rows: number, cols: number): string | null {
	let out = ""

	if (part.col >= 0) {
		const col = part.colAbsolute ? part.col : part.col + cols

		if (col < 0 || col >= SHEET_MAX_COLS) return null

		out += (part.colAbsolute ? "$" : "") + columnName(col)
	}

	if (part.row >= 0) {
		const row = part.rowAbsolute ? part.row : part.row + rows

		if (row < 0 || row >= SHEET_MAX_ROWS) return null

		out += (part.rowAbsolute ? "$" : "") + String(row + 1)
	}

	return out
}

// After the bracketed text (structured reference, external index) whose "[" is at `i`; brackets nest, "'"
// escapes the next character inside.
function bracketEnd(text: string, i: number): number {
	let depth = 0
	let at = i

	while (at < text.length) {
		const code = text.charCodeAt(at)

		if (code === 39) {
			at += 2

			continue
		}

		if (code === 91) depth++
		else if (code === 93 && --depth === 0) return at + 1

		at++
	}

	return text.length
}

export function moveRelativeReferences(text: string, rows: number, cols: number): string {
	if (rows === 0 && cols === 0) return text

	let out = ""
	let copied = 0
	let i = 0

	while (i < text.length) {
		const code = text.charCodeAt(i)

		if (code === 34 || code === 39) {
			i = skipQuoted(text, i, code)

			continue
		}

		if (code === 91) {
			i = bracketEnd(text, i)

			continue
		}

		if (code === 35) {
			// An error literal (#REF!, #N/A): its letters are not a reference.
			i++

			while (i < text.length && (isNameChar(text.charCodeAt(i)) || text.charCodeAt(i) === 47)) i++

			if (text.charCodeAt(i) === 33 || text.charCodeAt(i) === 63) i++

			continue
		}

		const previous = i > 0 ? text.charCodeAt(i - 1) : 0

		if (!(isNameChar(code) || code === 36) || isNameChar(previous) || previous === 36) {
			i++

			continue
		}

		// A token: a cell, an area, a column or row range, or something else (a name, a function, a number).
		const cell = readPart(text, i, "cell")
		let first: Part | null = cell
		let second: Part | null = null
		let end = cell?.end ?? i

		if (cell !== null && text.charCodeAt(cell.end) === 58) {
			second = readPart(text, cell.end + 1, "cell")

			if (second !== null) end = second.end
		} else if (cell === null) {
			const col = readPart(text, i, "col")
			const row = col === null ? readPart(text, i, "row") : null
			const range = col ?? row

			if (range !== null && text.charCodeAt(range.end) === 58) {
				const other = readPart(text, range.end + 1, col !== null ? "col" : "row")

				if (other !== null) {
					first = range
					second = other
					end = other.end
				}
			}
		}

		// A sheet name ("Sheet1!") or a function ("LOG10(") is not a reference.
		if (first === null || text.charCodeAt(end) === 33 || text.charCodeAt(end) === 40) {
			i++

			while (i < text.length && (isNameChar(text.charCodeAt(i)) || text.charCodeAt(i) === 36)) i++

			continue
		}

		const moved = movePart(first, rows, cols)
		const movedSecond = second === null ? "" : movePart(second, rows, cols)

		out +=
			text.slice(copied, i) + (moved === null || movedSecond === null ? "#REF!" : second === null ? moved : `${moved}:${movedSecond}`)
		copied = end
		i = end
	}

	return copied === 0 ? text : out + text.slice(copied)
}

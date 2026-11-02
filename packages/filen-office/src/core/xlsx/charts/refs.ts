import { appendAll } from "../../arrays"
import type { SheetRange } from "../../sheet/protocol"
import { referenceSpans, type RefArea } from "../../sheet/refs/formulaRefs"
import { MAX_COLUMNS, MAX_ROWS } from "../../sheet/model/model"

// What a chart's data reference (c:f, §21.2.2.65) reads: one cell range or a union of them, in order, each on a
// named sheet (a chart's references are always qualified), or a defined name standing for them. Anything else (a
// reference into another workbook, a function, #REF!) reads nothing here, and its cache is left as the file has it.

export interface ChartArea {
	// The sheet as the formula names it.
	readonly sheet: string
	readonly range: SheetRange
}

// Defined names the formula may use: a name's formula (without "="), the sheet's own first, then the workbook's.
export type ChartNameLookup = (name: string, sheet: string | null) => string | undefined

const NAME_DEPTH = 4

// The top-level pieces of a union: "(A,B)" or "A,B" split at commas outside quotes, brackets and parentheses.
function pieces(text: string): string[] | null {
	let body = text.trim()

	if (body.startsWith("(") && body.endsWith(")")) body = body.slice(1, -1)

	const out: string[] = []
	let depth = 0
	let start = 0

	for (let index = 0; index < body.length; index++) {
		const code = body.charCodeAt(index)

		if (code === 39 || code === 34) {
			const quote = code

			for (index++; index < body.length; index++) {
				if (body.charCodeAt(index) !== quote) continue
				if (body.charCodeAt(index + 1) === quote) index++
				else break
			}

			continue
		}

		if (code === 40 || code === 91) depth++
		else if (code === 41 || code === 93) depth--
		else if (code === 44 && depth === 0) {
			out.push(body.slice(start, index).trim())
			start = index + 1
		}

		if (depth < 0) return null
	}

	if (depth !== 0) return null

	out.push(body.slice(start).trim())

	return out.some(piece => piece === "") ? null : out
}

function rangeOf(area: RefArea): SheetRange {
	const startRow = area.kind === "cols" ? 0 : Math.min(area.startRow, area.endRow)
	const endRow = area.kind === "cols" ? MAX_ROWS - 1 : Math.max(area.startRow, area.endRow)
	const startCol = area.kind === "rows" ? 0 : Math.min(area.startCol, area.endCol)
	const endCol = area.kind === "rows" ? MAX_COLUMNS - 1 : Math.max(area.startCol, area.endCol)

	return { startRow, startCol, endRow, endCol }
}

const NAME = /^(?:(?:'((?:[^']|'')+)'|([^\s!'[\]()]+))!)?([A-Za-z_\\][\w.\\?]*)$/

// The areas `formula` reads, in order; null when it is not a plain reference, union or name of them.
export function chartAreas(formula: string, names: ChartNameLookup | null, depth = 0): ChartArea[] | null {
	const parts = pieces(formula)

	if (parts === null) return null

	const out: ChartArea[] = []

	for (const piece of parts) {
		const spans = referenceSpans(piece)
		const span = spans[0]

		if (spans.length === 1 && span !== undefined && span.start === 0 && span.end === piece.length) {
			if (span.sheet === null) return null

			out.push({ sheet: span.sheet, range: rangeOf(span.area) })

			continue
		}

		// A defined name: Sheet1!Name, [0]!Name (the workbook's own) or a bare name.
		const named = NAME.exec(piece.replace(/^\[0\]!/, ""))

		if (named === null || names === null || depth >= NAME_DEPTH) return null

		const sheet = named[1]?.replace(/''/g, "'") ?? named[2] ?? null
		const target = names(named[3] ?? "", sheet)

		if (target === undefined) return null

		const resolved = chartAreas(target, names, depth + 1)

		if (resolved === null) return null

		appendAll(out, resolved)
	}

	return out
}

// A whole column (or row) as far as its sheet holds cells (`lastRow`, `lastCol`: the last ones in use, -1 for
// none); other ranges as they are.
export function boundedRange(range: SheetRange, lastRow: number, lastCol: number): SheetRange {
	const wholeColumn = range.startRow === 0 && range.endRow === MAX_ROWS - 1
	const wholeRow = range.startCol === 0 && range.endCol === MAX_COLUMNS - 1

	return {
		...range,
		endRow: wholeColumn ? Math.max(0, Math.min(range.endRow, lastRow)) : range.endRow,
		endCol: wholeRow ? Math.max(0, Math.min(range.endCol, lastCol)) : range.endCol
	}
}

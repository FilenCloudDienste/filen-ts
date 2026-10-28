import { referenceSpans, referenceText } from "../../sheet/refs/formulaRefs"
import type { XlsxDocument } from "../edit/document"
import { documentCells } from "./cells"
import type { ChartFormulaHost } from "./edit"
import { MAX_POINTS } from "../../drawingml/chart/data"
import type { ChartCells } from "./cache"
import { chartAreas } from "./refs"

// Series formulas as typed in the chart editor, as a chart stores them: every reference qualified by its sheet (the
// chart's own sheet when none is named) and absolute, a union in parentheses, a defined name as written. Text that
// names no cells of this workbook is no reference.

const MAX_FORMULA = 8192

function pieces(text: string): string[] | null {
	const out: string[] = []
	let depth = 0
	let start = 0

	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index)

		if (code === 39) {
			for (index++; index < text.length; index++) {
				if (text.charCodeAt(index) !== 39) continue
				if (text.charCodeAt(index + 1) === 39) index++
				else break
			}
		} else if (code === 40) depth++
		else if (code === 41) depth--
		else if (code === 44 && depth === 0) {
			out.push(text.slice(start, index).trim())
			start = index + 1
		}
	}

	out.push(text.slice(start).trim())

	return depth === 0 && out.every(piece => piece !== "") ? out : null
}

// Whether the cells a formula reads hold numbers and nothing else but blanks (categories a numRef reads), each area
// read up to its sheet's last cell. A range past the cells a chart plots (MAX_POINTS) is no number range: what it holds
// is never all read.
export function numericCells(formula: string, cells: ChartCells): boolean {
	let numbers = 0
	let read = 0

	for (const area of chartAreas(formula, cells.names) ?? []) {
		const sheet = cells.sheet(area.sheet)

		if (sheet === null) return false

		const endRow = Math.min(area.range.endRow, Math.max(area.range.startRow, sheet.lastRow))
		const endCol = Math.min(area.range.endCol, Math.max(area.range.startCol, sheet.lastCol))

		read += (endRow - area.range.startRow + 1) * (endCol - area.range.startCol + 1)

		if (read > MAX_POINTS) return false

		for (let row = area.range.startRow; row <= endRow; row++) {
			for (let col = area.range.startCol; col <= endCol; col++) {
				const cell = sheet.cell(row, col)

				if (cell.kind === "number") numbers++
				else if (cell.kind !== "empty") return false
			}
		}
	}

	return numbers > 0
}

export function chartFormulaHost(document: XlsxDocument, ownSheet: string): ChartFormulaHost {
	return cellsFormulaHost(
		documentCells(document),
		document.worksheets().map(entry => entry.name),
		ownSheet
	)
}

// The same host over any workbook's cells and its worksheet names (an embedded chart workbook read without the sheet
// engine).
export function cellsFormulaHost(cells: ChartCells, sheetNames: readonly string[], ownSheet: string): ChartFormulaHost {
	const sheets = new Map(sheetNames.map(name => [name.toUpperCase(), name] as const))

	return {
		reference(text) {
			let body = text.trim()

			if (body.startsWith("=")) body = body.slice(1).trim()
			if (body.startsWith("(") && body.endsWith(")")) body = body.slice(1, -1)
			if (body === "" || body.length > MAX_FORMULA) return null

			const parts = pieces(body)

			if (parts === null) return null

			const out: string[] = []

			for (const piece of parts) {
				const spans = referenceSpans(piece)
				const span = spans[0]

				if (spans.length === 1 && span !== undefined && span.start === 0 && span.end === piece.length) {
					const sheet = sheets.get((span.sheet ?? ownSheet).toUpperCase())

					if (sheet === undefined) return null

					out.push(referenceText({ ...span.area, startRowAbs: true, startColAbs: true, endRowAbs: true, endColAbs: true }, sheet))

					continue
				}

				// A defined name standing for cells.
				if (chartAreas(piece, cells.names) === null) return null

				out.push(piece)
			}

			return out.length === 1 ? (out[0] ?? null) : `(${out.join(",")})`
		},
		numeric: formula => numericCells(formula, cells)
	}
}

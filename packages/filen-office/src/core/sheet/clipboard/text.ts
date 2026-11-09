import { cellKey } from "../model/model"
import { csvCellView } from "../csv/csvView"
import { EN_US_LOCALE, localizedNumber } from "../input/locale"
import { SHEET_MAX_COLS, SHEET_MAX_EDIT_CELLS, SHEET_MAX_ROWS, type SheetLocale } from "../protocol"
import { defineSheetFeature } from "../registry"
import { textFeature, type TextSheetDocument } from "../text"
import { clipboardHtml, MAX_HTML_COPY_CELLS, MAX_HTML_COPY_LENGTH, parseClipboardHtml, type ClipOutCell, type ClipValue } from "./html"
import { pasteRepeats } from "./tsv"

// Clipboard HTML over a text file: a copy's table of the fields as they are, and a paste of a table's values (a
// text file keeps no formats or formulas: a formula's shown value is not on the clipboard, so its text is pasted).

// A field as the view shows it: a number where it shows a plain one (read in the session's locale, as typed there);
// text where an entry would turn it into what it does not show (a formula, a number); else read as typed where it
// lands (a date, a grouped or percent number keeps the format it implies).
function fieldValue(text: string, locale: SheetLocale | undefined): ClipValue {
	if ((text.startsWith("=") && text.length > 1) || text.startsWith("'")) return { kind: "text", text }

	const number = localizedNumber(text.trim(), locale ?? EN_US_LOCALE)

	if (number === null) return { kind: "typed", text }
	if (csvCellView(text)?.numeric !== true) return { kind: "text", text }

	return number.impliedFormat === undefined ? { kind: "number", value: number.value } : { kind: "typed", text }
}

export const textClipboardHtmlFeature = defineSheetFeature<TextSheetDocument>({
	id: "clipboardHtml",
	commands: {
		"clipboard.pasteHtml": {
			info: { write: true },
			run: (context, command) => {
				const table = parseClipboardHtml(command.html, SHEET_MAX_EDIT_CELLS)
				const paste = textFeature.commands?.["clipboard.paste"]
				const set = textFeature.commands?.["cells.set"]

				if (table === "tooLarge") return { refused: { reason: "tooLarge" } }
				if (paste === undefined || set === undefined) return { refused: { reason: "unsupported" } }

				if (table === null)
					return paste.run(context, {
						type: "clipboard.paste",
						sheet: command.sheet,
						at: command.at,
						text: command.text,
						...(command.clip !== undefined && { clip: command.clip }),
						...(command.target !== undefined && { target: command.target })
					})

				if (command.at.row + table.rows > SHEET_MAX_ROWS || command.at.col + table.cols > SHEET_MAX_COLS)
					return { refused: { reason: "tooLarge" } }

				const { down, across } = pasteRepeats(table.rows, table.cols, command.at, command.target)
				const count = table.cells.length * down * across

				if (count > SHEET_MAX_EDIT_CELLS) return { refused: { reason: "tooLarge" } }

				const texts = table.cells.map(cell => {
					const value = cell.value

					switch (value.kind) {
						case "typed":
						case "text":
							return value.text
						case "number":
							return String(value.value)
						case "boolean":
							return value.value ? "TRUE" : "FALSE"
						case "empty":
							return cell.formula?.text ?? ""
					}
				})
				// The table once per copy over the paste area; a text file keeps no formulas to move.
				const rows = new Uint32Array(count)
				const cols = new Uint16Array(count)
				const inputs: string[] = []
				let i = 0

				for (let tileRow = 0; tileRow < down; tileRow++)
					for (let tileCol = 0; tileCol < across; tileCol++)
						table.cells.forEach((cell, k) => {
							rows[i] = command.at.row + tileRow * table.rows + cell.row
							cols[i] = command.at.col + tileCol * table.cols + cell.col
							inputs.push(texts[k] ?? "")
							i++
						})

				return set.run(context, { type: "cells.set", sheet: command.sheet, cells: { rows, cols, inputs } })
			}
		}
	},
	queries: {
		copyHtml: {
			run: (context, request) => {
				const range = request.range
				const rows = range.endRow - range.startRow + 1
				const cols = range.endCol - range.startCol + 1

				if (rows <= 0 || cols <= 0 || rows * cols > MAX_HTML_COPY_CELLS) return { html: null }

				const cells = new Map<number, ClipOutCell>()

				for (let row = range.startRow; row <= range.endRow; row++)
					for (let col = range.startCol; col <= range.endCol; col++) {
						const text = context.doc.text(row, col)

						if (text !== "")
							cells.set(cellKey(row - range.startRow, col - range.startCol), {
								text,
								value: fieldValue(text, context.doc.settings.locale),
								formula: null,
								style: {},
								numFmt: "General"
							})
					}

				return {
					html: clipboardHtml(
						rows,
						cols,
						{ row: range.startRow, col: range.startCol },
						(row, col) => cells.get(cellKey(row, col)) ?? null,
						MAX_HTML_COPY_LENGTH
					)
				}
			}
		}
	}
})

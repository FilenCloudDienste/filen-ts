import { csvCellView } from "../csv/csvView"
import { EN_US_LOCALE, localizedNumber } from "../input/locale"
import { formatGeneral } from "../numfmt"
import type { SheetRange } from "../protocol"
import { defineSheetFeature } from "../registry"
import { ERRORS } from "../sort/text"
import type { TextSheetDocument } from "../text"
import { SelectionStatsTally, type SheetSelectionStats } from "./stats"

// The status bar's summary over a text file's fields, read as sorting reads them: a field that shows as a number is
// the number the session's locale reads it as, an error text an error, the rest text.

export function textSelectionStats(document: TextSheetDocument, ranges: readonly SheetRange[], version: number): SheetSelectionStats {
	const rows = document.rows
	const locale = document.settings.locale ?? EN_US_LOCALE
	const tally = new SelectionStatsTally<true>()

	for (const range of ranges) {
		const lastRow = Math.min(range.endRow, rows.length - 1)

		for (let row = range.startRow; row <= lastRow; row++) {
			const fields = rows[row] ?? []
			const lastCol = Math.min(range.endCol, fields.length - 1)

			for (let col = range.startCol; col <= lastCol; col++) {
				const text = fields[col] ?? ""

				if (text === "") continue

				const trimmed = text.trim()
				const number = csvCellView(text)?.numeric === true ? localizedNumber(trimmed, locale) : null

				if (number !== null && Number.isFinite(number.value)) tally.number(number.value, true)
				else if (ERRORS.has(trimmed.toUpperCase())) tally.fail()
				else tally.text()
			}
		}
	}

	return tally.result((_format, value) => formatGeneral(value, locale.decimal), version)
}

export const textSelectionStatsFeature = defineSheetFeature<TextSheetDocument>({
	id: "selectionStats",
	queries: {
		selectionStats: { run: (context, request) => textSelectionStats(context.doc, request.ranges, context.version) }
	}
})

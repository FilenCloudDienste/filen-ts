import { csvCellView } from "../csv/csvView"
import { defineSheetFeature } from "../registry"
import type { TextSheetDocument } from "../text"
import { columnEntries } from "./autoComplete"

// AutoComplete's entries over a text file's fields: a field that shows as a number is not an entry. Choosing one
// enters it as it is (a text file's cells hold their text).

export const textAutoCompleteFeature = defineSheetFeature<TextSheetDocument>({
	id: "autoComplete",
	queries: {
		"autoComplete.entries": {
			run: (context, cell) => {
				const rows = context.doc.rows
				const field = (row: number, col: number): string => rows[row]?.[col] ?? ""
				const found = columnEntries(
					{
						filled: (row, col) => field(row, col) !== "",
						text: (row, col) => {
							const text = field(row, col)

							return text === "" || csvCellView(text)?.numeric === true ? null : text
						}
					},
					cell.row,
					cell.col,
					rows.length
				)

				return { entries: found.map(entry => ({ text: entry.text, input: entry.text })) }
			}
		}
	}
})

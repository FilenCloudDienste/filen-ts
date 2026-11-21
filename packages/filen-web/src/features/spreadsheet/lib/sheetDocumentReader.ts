import type { SheetSessionApi, SheetSummary } from "@filen/office/core/sheet"
import { noSelection, type DocumentReader } from "@/lib/activeDocument"
import { DocumentTextBuilder, unitRange } from "@/lib/documentText"

// A workbook's sheets for a reader (activeDocument.ts), in tab order: each worksheet's cells through the session's
// read-only "text" query, cut in the worker at the room left; a sheet without cells (a chart sheet) reads as empty.
export function sheetDocumentReader(
	session: Pick<SheetSessionApi, "query">,
	sheets: readonly Pick<SheetSummary, "id" | "name" | "kind">[]
): DocumentReader {
	return {
		units: () => Promise.resolve(sheets.length),
		text: async (range, signal, maxChars) => {
			if (range === "selection") {
				return noSelection()
			}

			const builder = new DocumentTextBuilder(maxChars)
			const span = unitRange(range, sheets.length)

			for (let index = span?.from ?? 1; span !== null && index <= span.to; index++) {
				signal.throwIfAborted()

				const sheet = sheets[index - 1]

				if (sheet === undefined) {
					break
				}

				const read =
					sheet.kind === "chartsheet" || sheet.kind === "dialogsheet"
						? { text: "", truncated: false }
						: await session.query("text", { sheet: sheet.id, maxChars: builder.room }, { signal })

				if (!builder.add(sheet.name, read.text)) {
					break
				}

				if (read.truncated) {
					builder.truncate()

					break
				}
			}

			signal.throwIfAborted()

			return builder.result()
		}
	}
}

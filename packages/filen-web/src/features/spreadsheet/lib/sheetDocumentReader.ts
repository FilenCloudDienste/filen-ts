import type { SheetId, SheetRange, SheetSessionApi, SheetSummary } from "@filen/office/core/sheet"
import type { SelectionReader, UnitReader } from "@/lib/activeDocument"
import { DocumentTextBuilder, unitRange } from "@/lib/documentText"

// A workbook's sheets for a reader (activeDocument.ts), in tab order: each worksheet's cells through the session's
// read-only "text" query, cut in the worker at the room left; a sheet without cells (a chart sheet) reads as empty.
export function sheetDocumentReader(
	session: Pick<SheetSessionApi, "query">,
	sheets: readonly Pick<SheetSummary, "id" | "name" | "kind">[]
): UnitReader {
	return {
		units: () => Promise.resolve(sheets.length),
		text: async (range, signal, maxChars) => {
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

// A selection larger than this many characters is counted as this many: counting more would carry more of the sheet
// to the page than any reader asks for.
export const SHEET_SELECTION_COUNT_MAX = 100_000

// What is selected on the sheet in view: its ranges.
export interface SheetSelectionNow {
	readonly sheet: SheetId
	readonly ranges: readonly SheetRange[]
}

// Whether `ranges` select more than the one cell the cursor is on (a cursor alone is not a selection).
function selectsCells(ranges: readonly SheetRange[]): boolean {
	const only = ranges[0]

	return ranges.length > 1 || (only !== undefined && (only.endRow > only.startRow || only.endCol > only.startCol))
}

// The cells of the selection as text, range after range (a blank line between), through the session's read-only
// "text" query, cut in the worker at `maxChars`.
async function selectionText(
	session: Pick<SheetSessionApi, "query">,
	selection: SheetSelectionNow,
	maxChars: number,
	signal: AbortSignal
): Promise<string> {
	if (!selectsCells(selection.ranges)) {
		return ""
	}

	const parts: string[] = []
	let length = 0

	for (const range of selection.ranges) {
		const separator = parts.length === 0 ? 0 : 2
		const room = maxChars - length - separator

		if (room <= 0) {
			break
		}

		const read = await session.query("text", { sheet: selection.sheet, range, maxChars: room }, { signal })

		parts.push(read.text)
		length += separator + read.text.length

		if (read.truncated) {
			break
		}
	}

	return parts.join("\n\n")
}

// The selected cells for the open document's selection (activeDocument.ts), the grid's selection set after each change.
// Only a selection of more than one cell counts; its size is read through the worker, up to SHEET_SELECTION_COUNT_MAX.
export function sheetSelectionReader(session: Pick<SheetSessionApi, "query">): {
	reader: SelectionReader
	set: (selection: SheetSelectionNow) => void
} {
	let current: SheetSelectionNow | null = null

	const read = (maxChars: number, signal: AbortSignal): Promise<string> =>
		current === null ? Promise.resolve("") : selectionText(session, current, maxChars, signal)

	return {
		reader: {
			selectedChars: async signal => (await read(SHEET_SELECTION_COUNT_MAX, signal)).length,
			selectedText: read
		},
		set: selection => {
			current = selection
		}
	}
}

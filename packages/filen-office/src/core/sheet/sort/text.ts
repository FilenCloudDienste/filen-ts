import { csvCellView } from "../csv/csvView"
import { EN_US_LOCALE, localizedNumber } from "../input/locale"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetCommandOf, type SheetLocale } from "../protocol"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled } from "../registry"
import { TEXT_SHEET, type TextSheetDocument } from "../text"
import { BLANK_SORT_VALUE, SortType, sortOrder, textSortKey, type SortValue } from "./order"

// Sorting a text file (CSV, TSV): its fields ordered as Excel orders the values it reads them as (a field that reads
// as a number is a number, TRUE and FALSE logical values, #N/A and the other error texts errors, the rest text), the
// header row left in place. Whole rows move as they are (their fields, empty ones included, as the file holds them);
// part of a row takes the sorted fields of another, and gives up the empty fields it no longer reaches.

const MAX_KEYS = 64
export const ERRORS: ReadonlySet<string> = new Set([
	"#NULL!",
	"#DIV/0!",
	"#VALUE!",
	"#REF!",
	"#NAME?",
	"#NUM!",
	"#N/A",
	"#GETTING_DATA",
	"#SPILL!",
	"#CALC!"
])

// A field that shows as a number is the number the session's locale reads it as (as the clipboard reads it): "1,5" is
// 1.5 in de-DE and text in en-US, "50%" 0.5.
function valueOf(text: string, caseSensitive: boolean, locale: SheetLocale): SortValue {
	if (text === "") return BLANK_SORT_VALUE

	const trimmed = text.trim()

	if (csvCellView(text)?.numeric === true) {
		const number = localizedNumber(trimmed, locale)

		if (number !== null && Number.isFinite(number.value)) return { type: SortType.NUMBER, number: number.value, key: "" }
	}

	const upper = trimmed.toUpperCase()

	if (upper === "TRUE" || upper === "FALSE") return { type: SortType.BOOLEAN, number: upper === "TRUE" ? 1 : 0, key: "" }
	if (ERRORS.has(upper)) return { type: SortType.ERROR, number: 0, key: "" }

	return { type: SortType.TEXT, number: 0, key: textSortKey(text, caseSensitive) }
}

// `target` with the fields from `start` to `end` taken from `source`: a row that ends inside them ends where the
// source's fields do.
function withSegment(target: readonly string[], source: readonly string[], start: number, end: number): string[] {
	const head = target.slice(0, start)
	const tail = target.length > end + 1 ? target.slice(end + 1) : []
	const segment = source.slice(start, end + 1)

	if (tail.length > 0) while (segment.length < end - start + 1) segment.push("")
	if (segment.length > 0 || tail.length > 0) while (head.length < start) head.push("")

	return head.concat(segment, tail)
}

export function sortText(document: TextSheetDocument, command: SheetCommandOf<"sort.apply">, changes: SheetChangeSink): SheetHandled {
	const { range, orientation, header, caseSensitive, keys } = command
	const rows = orientation === "rows"

	if (
		range.startRow < 0 ||
		range.startCol < 0 ||
		range.endRow >= SHEET_MAX_ROWS ||
		range.endCol >= SHEET_MAX_COLS ||
		range.startRow > range.endRow ||
		range.startCol > range.endCol
	)
		return { refused: { reason: "tooLarge" } }

	if (keys.length === 0 || keys.length > MAX_KEYS) return { refused: { reason: "unsupported", detail: "sortKeys" } }

	for (const key of keys) {
		const inside = rows
			? key.index >= range.startCol && key.index <= range.endCol
			: key.index >= range.startRow && key.index <= range.endRow

		if (!Number.isInteger(key.index) || !inside) return { refused: { reason: "unsupported", detail: "sortKeys" } }
	}

	const table = document.rows
	const first = (rows ? range.startRow : range.startCol) + (header ? 1 : 0)
	const last = Math.min(rows ? range.endRow : range.endCol, (rows ? table.length : document.width) - 1)

	if (last <= first) return null

	const count = last - first + 1
	const locale = document.settings.locale ?? EN_US_LOCALE
	const order = sortOrder(count, keys, (key, item) => {
		const line = first + item
		const index = keys[key]?.index ?? 0

		return valueOf(rows ? (table[line]?.[index] ?? "") : (table[index]?.[line] ?? ""), caseSensitive, locale)
	})
	let moved = false

	for (let k = 0; k < count; k++) if (order[k] !== k) moved = true

	if (!moved) return null

	// The rows the sort rewrites, as they were and as they become (each a new array: undo puts the old ones back).
	const touched: number[] = []
	const before: string[][] = []
	const after: string[][] = []

	if (rows) {
		for (let k = 0; k < count; k++) {
			const source = order[k] ?? k

			if (source === k) continue

			const row = first + k
			const old = table[row] ?? []

			touched.push(row)
			before.push(old)
			after.push(withSegment(old, table[first + source] ?? [], range.startCol, range.endCol))
		}
	} else {
		for (let row = range.startRow; row <= Math.min(range.endRow, table.length - 1); row++) {
			const old = table[row] ?? []

			if (old.length <= first) continue

			const next = old.slice()

			for (let k = 0; k < count; k++) {
				const col = first + k

				if (col >= next.length && (old[first + (order[k] ?? k)] ?? "") === "") continue

				while (next.length <= col) next.push("")

				next[col] = old[first + (order[k] ?? k)] ?? ""
			}

			// The empty fields the sort moved past the row's own end go.
			while (next.length > old.length && next[next.length - 1] === "") next.pop()

			touched.push(row)
			before.push(old)
			after.push(next)
		}
	}

	const span = rows
		? { startRow: first, endRow: last, startCol: range.startCol, endCol: range.endCol }
		: { startRow: range.startRow, endRow: range.endRow, startCol: first, endCol: last }
	const apply = (values: readonly string[][], sink: SheetChangeSink): void => {
		const width = document.width

		touched.forEach((row, index) => {
			document.rows[row] = values[index] ?? []
		})
		document.reshaped()
		sink.content(TEXT_SHEET, span)

		if (document.width !== width) sink.layout(TEXT_SHEET)
	}

	apply(after, changes)

	let bytes = 64

	for (const row of after) for (const text of row) bytes += 16 + text.length * 2

	return { bytes, undo: sink => apply(before, sink), redo: sink => apply(after, sink) }
}

export const textSortFeature = defineSheetFeature<TextSheetDocument>({
	id: "sort",
	commands: {
		"sort.apply": {
			info: { write: true },
			run: (context, command) => sortText(context.doc, command, context.changes)
		}
	}
})

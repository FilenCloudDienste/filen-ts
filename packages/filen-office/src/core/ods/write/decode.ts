import { OdfNs } from "../../odf/namespaces"
import { SharedStrings } from "../../xlsx/model/sharedStrings"
import type { SheetStore } from "../../xlsx/model/store"
import { CellKind } from "../../xlsx/model/types"
import { OdsIssues } from "../issues"
import { capturedText, parseCaptured } from "../read/captured"
import { ContentReader } from "../read/content"
import type { OdsBuiltSheet } from "../read/sheet"
import type { OdsCellStyles } from "../styles/cell"
import { EMPTY_CELL, storeValue, type CellValue } from "./cells"
import { linkVisits } from "./features"

// Source rows read back as the reader read them: the row elements (each once, repeats aside) after the table's
// columns, through the reader itself, so a cell the writer compares is what the model was built from.

const encoder = new TextEncoder()

export interface DecodedNote {
	readonly text: string
	readonly author: string
}

export interface DecodedRows {
	readonly built: OdsBuiltSheet
	readonly shared: SharedStrings
	// Each row's cells in the built sheet are at row index k (the k-th row element given).
	cell(row: number, col: number): CellValue
	note(row: number, col: number): DecodedNote | undefined
	link(row: number, col: number): string | undefined
	// The merge anchored at a cell: its last row and column, or undefined.
	merge(row: number, col: number): { readonly endRow: number; readonly endCol: number } | undefined
}

// The element names a snippet needs, under the document's prefixes.
function qualified(prefixes: ReadonlyMap<string, string>, uri: string, local: string): string {
	for (const [prefix, bound] of prefixes) if (bound === uri) return prefix === "" ? local : `${prefix}:${local}`

	return `${uri === OdfNs.table ? "table" : "office"}:${local}`
}

export function decodeRows(
	styles: OdsCellStyles,
	prefixes: ReadonlyMap<string, string>,
	columns: Uint8Array,
	rows: readonly Uint8Array[]
): DecodedRows {
	const spreadsheet = qualified(prefixes, OdfNs.office, "spreadsheet")
	const table = qualified(prefixes, OdfNs.table, "table")
	const name = qualified(prefixes, OdfNs.table, "name")
	const head = encoder.encode(`<${spreadsheet}><${table} ${name}="d">`)
	const tail = encoder.encode(`</${table}></${spreadsheet}>`)
	let size = head.length + columns.length + tail.length

	for (const row of rows) size += row.length

	const bytes = new Uint8Array(size)
	let at = 0

	bytes.set(head, at)
	at += head.length
	bytes.set(columns, at)
	at += columns.length

	for (const row of rows) {
		bytes.set(row, at)
		at += row.length
	}

	bytes.set(tail, at)

	const shared = SharedStrings.empty(() => null)
	const reader = new ContentReader(styles, new OdsIssues(), shared, prefixes, 0, Number.MAX_SAFE_INTEGER, 1)
	const content = reader.readBytes(bytes)
	const built = content.tables[0]?.built

	if (built === undefined) throw new Error("The rows read back as no table")

	const store = built.store as SheetStore
	const notes = new Map<string, DecodedNote>()
	const links = new Map<string, string>()
	const merges = new Map<string, { endRow: number; endCol: number }>()

	for (const note of built.notes) {
		const captured = parseCaptured(note.markup, prefixes)
		const text = capturedText(captured, new Set(["dc:creator", "dc:date", "meta:date-string", "text:list-header"]))
		let author = ""

		for (
			let child = captured.document.firstChildElement(captured.node);
			child >= 0;
			child = captured.document.nextSiblingElement(child)
		)
			if (captured.namespaces.elementUri(child) === OdfNs.dc && captured.document.localName(child) === "creator")
				author = captured.document.textContent(child)

		for (let row = note.row; row <= note.endRow; row++)
			for (let col = note.col; col <= note.endCol; col++) notes.set(`${row},${col}`, { text, author })
	}

	// On the cells holding text alone (a link is a text:a of its cell's text), not the whole block a repeated linked
	// cell reads as.
	const visited = linkVisits(store)

	for (const link of built.links)
		store.forEachCell({ startRow: link.row, startCol: link.col, endRow: link.endRow, endCol: link.endCol }, (row, col, slot) => {
			if (store.kind(slot) === CellKind.EMPTY) return

			visited()
			links.set(`${row},${col}`, link.href)
		})

	for (let k = 0; k + 3 < built.merges.length; k += 4)
		merges.set(`${built.merges[k] ?? 0},${built.merges[k + 1] ?? 0}`, {
			endRow: built.merges[k + 2] ?? 0,
			endCol: built.merges[k + 3] ?? 0
		})

	const columnXf = (col: number): number => {
		for (const range of built.cols) if (col >= range.first && col <= range.last) return Math.max(0, range.style)

		return 0
	}

	return {
		built,
		shared,
		cell(row, col) {
			const slot = store.locate(row, col)

			if (slot >= 0) return storeValue(store, shared, slot, store.style(slot), undefined)

			const run = built.styleRuns?.styleAt(row, col) ?? -1

			return { ...EMPTY_CELL, xf: run >= 0 ? run : columnXf(col) }
		},
		note: (row, col) => notes.get(`${row},${col}`),
		link: (row, col) => links.get(`${row},${col}`),
		merge: (row, col) => merges.get(`${row},${col}`)
	}
}

import * as Comlink from "comlink"
import { openXlsx, readXls } from "hucre/xlsx"
import type { SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import { MAX_SHEET_CELLS, type EditOp, type EditResult } from "@/features/spreadsheet/lib/edits"
import { workbookDoc, WorkbookViews } from "@/features/spreadsheet/lib/xlsxView"
import { parseCsvFile } from "@/features/spreadsheet/lib/csvView"
import { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { CsvDocument } from "@/features/spreadsheet/lib/csvDocument"

// Owns every open spreadsheet: the parsed workbook stays here, with its edits and undo history, and the
// page gets views of it (model.ts) and patches after each edit (edits.ts). A file is untrusted input, so
// parsing runs off the main thread, inside limits: a zip that inflates past DECOMPRESSED_LIMIT or a grid
// past CELL_LIMIT fails to open rather than taking the tab's memory.

export type SpreadsheetFileKind = "xlsx" | "xls" | "csv" | "tsv"

const CELL_LIMIT = MAX_SHEET_CELLS
const DECOMPRESSED_LIMIT = 512 * 1024 * 1024

// An .xls opens to be looked at only: nothing is kept, as nothing can be written back.
const documents = new Map<number, XlsxDocument | CsvDocument>()
let nextId = 1

async function open(bytes: Uint8Array, kind: SpreadsheetFileKind): Promise<{ id: number; doc: SpreadsheetDoc }> {
	const id = nextId++

	switch (kind) {
		case "xlsx": {
			const document = new XlsxDocument(
				await openXlsx(bytes, { readStyles: true, maxTotalCells: CELL_LIMIT, maxDecompressedBytes: DECOMPRESSED_LIMIT })
			)

			documents.set(id, document)

			return { id, doc: document.doc() }
		}
		case "xls": {
			const workbook = await readXls(bytes, { maxTotalCells: CELL_LIMIT })

			return { id, doc: { ...workbookDoc(workbook, new WorkbookViews(workbook.themeColors), false), kind: "xls" } }
		}
		case "csv":
		case "tsv": {
			const { rows, format } = parseCsvFile(bytes, kind === "tsv")

			if (rows.reduce((cells, row) => cells + row.length, 0) > CELL_LIMIT) {
				throw new Error("spreadsheet: too many cells")
			}

			const document = new CsvDocument(rows, format)

			documents.set(id, document)

			return { id, doc: document.doc() }
		}
	}
}

function document(id: number): XlsxDocument | CsvDocument {
	const found = documents.get(id)

	if (found === undefined) {
		throw new Error(`spreadsheet: no open document ${String(id)}`)
	}

	return found
}

const api = {
	open,
	apply: (id: number, op: EditOp): EditResult => document(id).apply(op),
	undo: (id: number): EditResult => document(id).undo(),
	redo: (id: number): EditResult => document(id).redo(),
	// The file's bytes as they now stand, handed over rather than copied.
	serialize: async (id: number): Promise<Uint8Array> => {
		const bytes = await document(id).serialize()

		return Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer])
	},
	close: (id: number): void => {
		documents.delete(id)
	}
}

export type SpreadsheetWorkerApi = typeof api

Comlink.expose(api)

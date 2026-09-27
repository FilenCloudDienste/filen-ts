import * as Comlink from "comlink"
import { openXlsx, readXls } from "hucre/xlsx"
import type { SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import { MAX_SHEET_CELLS, type DocState, type EditOp, type EditResult } from "@/features/spreadsheet/lib/edits"
import { workbookDoc, WorkbookViews } from "@/features/spreadsheet/lib/xlsxView"
import { parseCsvFile } from "@/features/spreadsheet/lib/csvView"
import { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { CsvDocument } from "@/features/spreadsheet/lib/csvDocument"
import { checkZipLimits } from "@/features/spreadsheet/lib/zipLimits"

// Owns every open spreadsheet: the parsed workbook stays here, with its edits and undo history, and the
// page gets views of it (model.ts) and patches after each edit (edits.ts). A file is untrusted input, so
// parsing runs off the main thread, inside limits: a zip whose entries inflate past DECOMPRESSED_LIMIT in
// all (or number past ZIP_ENTRY_LIMIT) or a grid past CELL_LIMIT fails to open rather than taking the tab's
// memory.

export type SpreadsheetFileKind = "xlsx" | "xls" | "csv" | "tsv"

const CELL_LIMIT = MAX_SHEET_CELLS
const DECOMPRESSED_LIMIT = 512 * 1024 * 1024
const ZIP_ENTRY_LIMIT = 20_000

// An .xls opens to be looked at only: nothing is kept, as nothing can be written back.
const documents = new Map<number, XlsxDocument | CsvDocument>()
let nextId = 1

async function open(bytes: Uint8Array, kind: SpreadsheetFileKind): Promise<{ id: number; doc: SpreadsheetDoc }> {
	const id = nextId++

	switch (kind) {
		case "xlsx": {
			// The whole archive's declared sizes first: hucre caps each entry, not their sum.
			checkZipLimits(bytes, { maxEntries: ZIP_ENTRY_LIMIT, maxBytes: DECOMPRESSED_LIMIT })

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
	// The file's bytes as they now stand, handed over rather than copied, and the edit state they hold.
	serialize: async (id: number): Promise<{ bytes: Uint8Array; version: number }> => {
		const serialized = await document(id).serialize()

		return Comlink.transfer(serialized, [serialized.bytes.buffer as ArrayBuffer])
	},
	// The bytes serialize returned at `version` are now the file's.
	markSaved: (id: number, version: number): DocState => document(id).markSaved(version),
	close: (id: number): void => {
		const found = documents.get(id)

		if (found instanceof XlsxDocument) {
			found.close()
		}

		documents.delete(id)
	}
}

export type SpreadsheetWorkerApi = typeof api

Comlink.expose(api)

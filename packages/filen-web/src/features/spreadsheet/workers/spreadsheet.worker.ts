import * as Comlink from "comlink"
import { openXlsx, readXls } from "hucre/xlsx"
import type { SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import { MAX_SHEET_CELLS, type DocState, type EditOp, type EditResult } from "@/features/spreadsheet/lib/edits"
import { workbookDoc, WorkbookViews } from "@/features/spreadsheet/lib/xlsxView"
import { parseCsvFile } from "@/features/spreadsheet/lib/csvView"
import { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"
import { CsvDocument } from "@/features/spreadsheet/lib/csvDocument"
import { checkZipLimits } from "@/features/spreadsheet/lib/zipLimits"
import { xlsToXlsx } from "@/features/spreadsheet/lib/xlsConvert"

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
// Whether each open text file can be saved, as its doc said at opening.
const textWritable = new Map<number, boolean>()

async function open(bytes: Uint8Array, kind: SpreadsheetFileKind): Promise<{ id: number; doc: SpreadsheetDoc }> {
	const id = nextId++

	switch (kind) {
		case "xlsx": {
			// The whole archive's declared sizes first: hucre caps each entry, not their sum.
			checkZipLimits(bytes, { maxEntries: ZIP_ENTRY_LIMIT, maxBytes: DECOMPRESSED_LIMIT })

			const document = new XlsxDocument(
				await openXlsx(bytes, { readStyles: true, maxTotalCells: CELL_LIMIT, maxDecompressedBytes: DECOMPRESSED_LIMIT })
			)

			// View-only until proven: the page asks writability(id) when it may edit, which runs the proof, or
			// viewOnly(id) when it won't, which skips it.
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
			const doc = document.doc()

			documents.set(id, document)
			textWritable.set(id, doc.writable)

			return { id, doc }
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
	// Whether the open document can be saved: for a workbook, once proven that saving loses nothing (its
	// doc opens with writable false until then); for text, as its doc said.
	writability: async (id: number): Promise<boolean> => {
		const found = document(id)

		return found instanceof XlsxDocument ? await found.verifyWritable() : (textWritable.get(id) ?? false)
	},
	// The page will not edit this document: a workbook skips its proof and drops what only saving needs.
	viewOnly: (id: number): void => {
		const found = document(id)

		if (found instanceof XlsxDocument) {
			found.viewOnly()
		}
	},
	// An .xls converted to an .xlsx (values and merges only: lib/xlsConvert.ts), handed over.
	xlsToXlsx: async (bytes: Uint8Array): Promise<Uint8Array> => {
		const converted = await xlsToXlsx(bytes, CELL_LIMIT)

		return Comlink.transfer(converted, [converted.buffer as ArrayBuffer])
	},
	// The bytes serialize returned at `version` are now the file's.
	markSaved: (id: number, version: number): DocState => document(id).markSaved(version),
	close: (id: number): void => {
		const found = documents.get(id)

		if (found instanceof XlsxDocument) {
			found.close()
		}

		documents.delete(id)
		textWritable.delete(id)
	}
}

export type SpreadsheetWorkerApi = typeof api

Comlink.expose(api)

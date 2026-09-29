import * as Comlink from "comlink"
import SpreadsheetWorker from "@/features/spreadsheet/workers/spreadsheet.worker.ts?worker"
import type { SpreadsheetWorkerApi } from "@/features/spreadsheet/workers/spreadsheet.worker"

// One worker for every open spreadsheet, created the first time one opens. It holds the open workbooks,
// each until its viewer closes it.
let worker: Comlink.Remote<SpreadsheetWorkerApi> | null = null

export function spreadsheetWorker(): Comlink.Remote<SpreadsheetWorkerApi> {
	worker ??= Comlink.wrap<SpreadsheetWorkerApi>(new SpreadsheetWorker())

	return worker
}

const ZIP = [0x50, 0x4b, 0x03, 0x04]
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
	return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte)
}

// A file whose name does not say what it is, read from its first bytes: a zip is taken for an .xlsx, an
// OLE2 compound file for an .xls, anything else for text.
export function sniffSpreadsheetKind(bytes: Uint8Array): "xlsx" | "xls" | "csv" {
	if (startsWith(bytes, ZIP)) return "xlsx"
	if (startsWith(bytes, OLE2)) return "xls"

	return "csv"
}

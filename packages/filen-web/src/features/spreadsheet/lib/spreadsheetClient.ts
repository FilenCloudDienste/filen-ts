import * as Comlink from "comlink"
import SpreadsheetWorker from "@/features/spreadsheet/workers/spreadsheet.worker.ts?worker"
import type { SpreadsheetFileKind, SpreadsheetWorkerApi } from "@/features/spreadsheet/workers/spreadsheet.worker"

// One worker for every open spreadsheet, created the first time one opens. It holds the open workbooks,
// each until its viewer closes it.
let worker: Comlink.Remote<SpreadsheetWorkerApi> | null = null

export function spreadsheetWorker(): Comlink.Remote<SpreadsheetWorkerApi> {
	worker ??= Comlink.wrap<SpreadsheetWorkerApi>(new SpreadsheetWorker())

	return worker
}

export function spreadsheetFileKind(extension: string): SpreadsheetFileKind | null {
	switch (extension) {
		case "xlsx":
		case "xlsm":
			return "xlsx"
		case "xls":
			return "xls"
		case "csv":
			return "csv"
		case "tsv":
			return "tsv"
		default:
			return null
	}
}

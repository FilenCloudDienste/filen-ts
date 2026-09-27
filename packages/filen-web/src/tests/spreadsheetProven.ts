import type { RoundtripWorkbook } from "hucre/xlsx"
import { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"

// A workbook opened as the worker opens one: proven (or not) to save intact before anything is edited.
export async function proven(workbook: RoundtripWorkbook, historyBudget?: number): Promise<XlsxDocument> {
	const document = historyBudget === undefined ? new XlsxDocument(workbook) : new XlsxDocument(workbook, historyBudget)

	await document.verifyWritable()

	return document
}

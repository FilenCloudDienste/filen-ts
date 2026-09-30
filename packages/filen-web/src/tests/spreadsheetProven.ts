import { readFileSync } from "node:fs"
import { openXlsx, writeXlsx, type RoundtripWorkbook } from "hucre/xlsx"
import type { Cell, CellValue, Workbook } from "hucre"
import type { CellPatch, EditResult } from "@/features/spreadsheet/lib/edits"
import { cellKey, type CellView } from "@/features/spreadsheet/lib/model"
import { XlsxDocument } from "@/features/spreadsheet/lib/xlsxDocument"

const FIXTURES = new URL("./fixtures/spreadsheet/", import.meta.url)

// A workbook opened as the worker opens one: proven (or not) to save intact before anything is edited.
export async function proven(workbook: RoundtripWorkbook, historyBudget?: number): Promise<XlsxDocument> {
	const document = historyBudget === undefined ? new XlsxDocument(workbook) : new XlsxDocument(workbook, historyBudget)

	await document.verifyWritable()

	return document
}

export async function openFixture(name: string): Promise<RoundtripWorkbook> {
	return await openXlsx(readFileSync(new URL(name, FIXTURES)), { readStyles: true })
}

export async function openSheets(
	sheets: { name: string; rows: CellValue[][]; cells?: Map<string, Cell> }[],
	namedRanges?: Workbook["namedRanges"]
): Promise<XlsxDocument> {
	const bytes = await writeXlsx(namedRanges === undefined ? { sheets } : { sheets, namedRanges })

	return await proven(await openXlsx(bytes, { readStyles: true }))
}

export async function savedWorkbook(document: XlsxDocument): Promise<RoundtripWorkbook> {
	return await openXlsx((await document.serialize()).bytes, { readStyles: true })
}

export async function reopen(document: XlsxDocument): Promise<XlsxDocument> {
	return await proven(await savedWorkbook(document))
}

export function formula(text: string, result: CellValue = null): Cell {
	return { value: result, type: "formula", formula: text, formulaResult: result }
}

function patchedCell(patches: readonly CellPatch[] | undefined, row: number, col: number, sheet: number): CellView | null | undefined {
	return patches?.find(patch => patch.sheet === sheet)?.cells.find(([key]) => key === cellKey(row, col))?.[1]
}

// A cell as an edit result carries it, in a sheet's view or a patch; undefined when the result does not.
export function viewCell(result: EditResult, row: number, col: number, sheet = 0): CellView | null | undefined {
	if (result.type === "cells") {
		return patchedCell(result.patches, row, col, sheet)
	}

	if (result.type !== "sheets") {
		return undefined
	}

	const view = result.sheets[sheet]

	return view === null || view === undefined ? patchedCell(result.patches, row, col, sheet) : view.cells.get(cellKey(row, col))
}

export function shownCell(document: XlsxDocument, row: number, col: number, sheet = 0): CellView | undefined {
	return document.doc().sheets[sheet]?.cells.get(cellKey(row, col))
}

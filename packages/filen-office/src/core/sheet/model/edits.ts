import { DEFAULT_XLSX_LIMITS } from "../../xlsx/read/limits"
import type { SizeAxis } from "../sizes/sizes"

// A run of rows or columns inserted or deleted.
export interface AxisEdit {
	type: "insert" | "delete"
	axis: SizeAxis
	at: number
	count: number
}

// The most cells a workbook opens with: the workbook reader's own cap, which a legacy .xls converted for opening is
// held to as well.
export const MAX_SHEET_CELLS = DEFAULT_XLSX_LIMITS.maxCells

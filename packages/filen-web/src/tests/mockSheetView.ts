import type { SheetView } from "@/features/spreadsheet/lib/model"

// Apart from the xlsx helpers so grid tests do not load the workbook engine.
export function mockSheetView(overrides: Partial<SheetView> = {}): SheetView {
	return {
		name: "Sheet1",
		rowCount: 5,
		colCount: 4,
		cells: new Map(),
		merges: [],
		colWidths: new Map(),
		rowHeights: new Map(),
		hiddenCols: [],
		hiddenRows: [],
		frozenRows: 0,
		frozenCols: 0,
		structureLocked: false,
		...overrides
	}
}

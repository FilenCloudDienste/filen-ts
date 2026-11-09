import { describe, expect, it } from "vitest"
import {
	nameBoxNames,
	nameBoxSelection,
	nameBoxShown,
	parseNameBox,
	resolveNameBox,
	type NameBoxDefinedNames
} from "@/features/spreadsheet/lib/nameBox.logic"
import { csvRefusalKey, readOnlyNoteKey, refusalKey, viewOnlyKey } from "@/features/spreadsheet/lib/sheetMessages.logic"
import { SheetEventRelay } from "@/features/spreadsheet/lib/sheetEvents"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetEvent, type SheetRange, type SheetSummary } from "@filen/office/core/sheet"
import { preview } from "@/locales/en/preview"

describe("name box", () => {
	const here = (range: SheetRange) => ({ kind: "range", sheet: null, range })

	it("reads a cell, absolute or not, in either case", () => {
		expect(parseNameBox("B4")).toEqual(here({ startRow: 3, startCol: 1, endRow: 3, endCol: 1 }))
		expect(parseNameBox(" $b$4 ")).toEqual(here({ startRow: 3, startCol: 1, endRow: 3, endCol: 1 }))
		expect(parseNameBox("XFD1048576")).toEqual(here({ startRow: 1_048_575, startCol: 16_383, endRow: 1_048_575, endCol: 16_383 }))
	})

	it("reads a range from either corner", () => {
		expect(parseNameBox("C3:A1")).toEqual(here({ startRow: 0, startCol: 0, endRow: 2, endCol: 2 }))
	})

	it("reads whole columns and rows", () => {
		expect(parseNameBox("A:A")).toEqual(here({ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: 0 }))
		expect(parseNameBox("$C:b")).toEqual(here({ startRow: 0, startCol: 1, endRow: SHEET_MAX_ROWS - 1, endCol: 2 }))
		expect(parseNameBox("3:$1")).toEqual(here({ startRow: 0, startCol: 0, endRow: 2, endCol: SHEET_MAX_COLS - 1 }))
	})

	it("reads a sheet before the reference, quoted or bare", () => {
		expect(parseNameBox("Sheet2!A1")).toEqual({
			kind: "range",
			sheet: "Sheet2",
			range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }
		})
		expect(parseNameBox("'Bob''s data'!B2:B3")).toEqual({
			kind: "range",
			sheet: "Bob's data",
			range: { startRow: 1, startCol: 1, endRow: 2, endCol: 1 }
		})
		expect(parseNameBox("Sheet2!Totals")).toEqual({ kind: "name", sheet: "Sheet2", name: "Totals" })
	})

	it("reads a defined name", () => {
		expect(parseNameBox("Sales_2024")).toEqual({ kind: "name", sheet: null, name: "Sales_2024" })
		expect(parseNameBox("ABCD1")).toEqual({ kind: "name", sheet: null, name: "ABCD1" })
	})

	it("refuses anything past the grid or neither a reference nor a name", () => {
		for (const input of ["", "A0", "XFE1", "A1048577", "A1:B2:C3", "A1:B", "1A", "=A1", "!A1", "My sheet!A1", "'x'y'!A1", "a b"]) {
			expect(parseNameBox(input), input).toBeNull()
		}
	})

	const sheets: SheetSummary[] = [
		{ id: 1, name: "Data", state: "visible", kind: "worksheet", ready: true },
		{ id: 2, name: "Bob's data", state: "visible", kind: "worksheet", ready: true },
		{ id: 3, name: "Chart1", state: "visible", kind: "chartsheet", ready: true }
	]
	const names: NameBoxDefinedNames = [
		{ name: "Totals", sheet: null, formula: "Data!$B$2:$B$9" },
		{ name: "Totals", sheet: 2, formula: "'Bob''s data'!$C$1" },
		{ name: "Whole", sheet: null, formula: "=Data!$A:$A" },
		{ name: "Alias", sheet: null, formula: "Totals" },
		{ name: "Loop", sheet: null, formula: "Loop" },
		{ name: "Two", sheet: null, formula: "Data!$A$1,Data!$C$3" },
		{ name: "Rate", sheet: null, formula: "0.2" },
		{ name: "_xlnm.Print_Area", sheet: 1, formula: "Data!$A$1:$D$20" },
		{ name: "Other", sheet: 2, formula: "'Bob''s data'!$A$1" }
	]
	const go = (input: string, own: number) => {
		const target = parseNameBox(input)

		return target === null ? null : resolveNameBox(target, own, sheets, names)
	}

	it("finds another sheet whatever its case, never a chartsheet or a missing one", () => {
		expect(go("data!A1", 2)).toEqual({ sheet: 1, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } })
		expect(go("Chart1!A1", 1)).toBeNull()
		expect(go("Nowhere!A1", 1)).toBeNull()
		expect(go("B2", 2)).toEqual({ sheet: 2, range: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 } })
	})

	it("follows a name: the sheet's own before the workbook's, through other names, to one area only", () => {
		expect(go("totals", 1)).toEqual({ sheet: 1, range: { startRow: 1, startCol: 1, endRow: 8, endCol: 1 } })
		expect(go("Totals", 2)).toEqual({ sheet: 2, range: { startRow: 0, startCol: 2, endRow: 0, endCol: 2 } })
		expect(go("Data!Totals", 2)).toBeNull()
		expect(go("'Bob''s data'!Totals", 1)).toEqual({ sheet: 2, range: { startRow: 0, startCol: 2, endRow: 0, endCol: 2 } })
		expect(go("Whole", 2)).toEqual({ sheet: 1, range: { startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: 0 } })
		expect(go("Alias", 1)).toEqual(go("Totals", 1))
		expect(go("Print_Area", 1)).toEqual({ sheet: 1, range: { startRow: 0, startCol: 0, endRow: 19, endCol: 3 } })
		for (const name of ["Loop", "Two", "Rate", "Missing", "Other"]) {
			expect(go(name, 1), name).toBeNull()
		}
	})

	it("lists the names a sheet can go to, sorted, its own hiding the workbook's", () => {
		expect(nameBoxNames(1, sheets, names)).toEqual(["Alias", "Print_Area", "Totals", "Whole"])
		expect(nameBoxNames(2, sheets, names)).toEqual(["Alias", "Other", "Totals", "Whole"])
	})

	it("selects a place grown to the merges it cuts, from its top-left cell", () => {
		const merges = [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }]
		const selection = nameBoxSelection({ startRow: 1, startCol: 1, endRow: 2, endCol: 2 }, merges)

		expect(selection.ranges).toEqual([{ startRow: 0, startCol: 0, endRow: 2, endCol: 2 }])
		expect(selection.active).toEqual({ row: 0, col: 0 })
	})

	it("shows the active cell, a merge by its top left", () => {
		const range = { startRow: 0, startCol: 0, endRow: 2, endCol: 2 }

		const merge = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }

		const active = { row: 1, col: 2 }

		expect(nameBoxShown({ active, anchor: { row: 0, col: 0 }, focus: { row: 2, col: 2 }, ranges: [range] })).toBe("C2")
		expect(nameBoxShown(nameBoxSelection({ startRow: 1, startCol: 1, endRow: 1, endCol: 1 }, [merge]))).toBe("A1")
	})
})

describe("view-only and refusal messages", () => {
	const base = { editable: true, readOnlyReason: undefined, unnamed: false, renamed: false, kind: "xlsx" } as const

	it("names every view-only reason with a string the catalog has", () => {
		for (const reason of [
			"legacyFormat",
			"lossy",
			"tooLarge",
			"unsafe",
			"signed",
			"readOnlyRecommended",
			"modifyPassword",
			"incomplete"
		] as const) {
			expect(preview).toHaveProperty(viewOnlyKey(reason, "xlsx"))
		}

		expect(viewOnlyKey("incomplete", "csv")).toBe("previewSheetReadOnlyIncomplete")

		expect(viewOnlyKey("unsafe", "csv")).toBe("previewSpreadsheetReadOnlyUnsafe")
		expect(viewOnlyKey("unsafe", "xlsx")).toBe("previewSpreadsheetReadOnlyLossy")
	})

	it("says why a CSV download was refused: too large, a text file read in part, or that it failed", () => {
		expect(csvRefusalKey({ reason: "tooLarge", detail: "csv" })).toBe("previewSheetDownloadCsvTooLarge")
		expect(csvRefusalKey({ reason: "tooLarge", detail: "incomplete" })).toBe("previewSheetReadOnlyIncomplete")
		expect(csvRefusalKey({ reason: "unsupported", detail: "unreadable" })).toBe("previewSheetDownloadCsvFailed")

		for (const key of ["previewSheetDownloadCsvTooLarge", "previewSheetReadOnlyIncomplete", "previewSheetDownloadCsvFailed"]) {
			expect(preview).toHaveProperty(key)
		}
	})

	it("puts the app's own reasons before the session's verdict, and says a legacy workbook whoever looks", () => {
		const lossy = { state: "viewOnly", reason: "lossy" } as const

		expect(readOnlyNoteKey({ ...base, unnamed: true, writability: lossy })).toBe("previewSpreadsheetReadOnlyUnnamed")
		expect(readOnlyNoteKey({ ...base, renamed: true, writability: lossy })).toBe("previewSpreadsheetReadOnlyRenamed")
		expect(readOnlyNoteKey({ ...base, writability: lossy })).toBe("previewSpreadsheetReadOnlyLossy")
		expect(readOnlyNoteKey({ ...base, writability: { state: "checking" } })).toBe("previewSpreadsheetCheckingWritable")
		expect(readOnlyNoteKey({ ...base, writability: { state: "unproven" } })).toBeNull()
		expect(readOnlyNoteKey({ ...base, editable: false, writability: lossy })).toBeNull()
		expect(readOnlyNoteKey({ ...base, editable: false, readOnlyReason: "renamed", writability: lossy })).toBe(
			"previewSpreadsheetReadOnlyRenamed"
		)
		expect(readOnlyNoteKey({ ...base, editable: false, writability: { state: "viewOnly", reason: "legacyFormat" } })).toBe(
			"previewSpreadsheetReadOnlyXls"
		)
	})

	it("gives every refusal a string the catalog has, a view-only one by its verdict", () => {
		const reasons = [
			"readOnly",
			"tooLarge",
			"sheetName",
			"lastSheet",
			"formula",
			"arrayFormula",
			"tableHeader",
			"structureLocked",
			"pivot",
			"merged",
			"protectedSheet",
			"protectedWorkbook",
			"encoding",
			"styleLimit",
			"unsupported"
		] as const

		for (const reason of reasons) {
			expect(preview).toHaveProperty(refusalKey({ reason }, "xlsx"))
		}

		expect(refusalKey({ reason: "readOnly", detail: "signed" }, "xlsx")).toBe("previewSheetReadOnlySigned")
		expect(refusalKey({ reason: "readOnly", detail: "something else" }, "xlsx")).toBe("previewSpreadsheetReadOnlyLossy")
		// A sort over merged cells of different sizes says so, as Excel does.
		expect(refusalKey({ reason: "merged", detail: "mergeSize" }, "xlsx")).toBe("previewSheetSortMergeSize")
		expect(preview).toHaveProperty("previewSheetSortMergeSize")
	})
})

describe("event relay", () => {
	it("holds events until a target attaches, then passes them on in order", () => {
		const relay = new SheetEventRelay()
		const seen: SheetEvent["type"][] = []
		const engine = (state: "building" | "ready"): SheetEvent => ({ type: "engine", state })

		relay.emit(engine("building"))
		relay.emit({ type: "progress", task: "open", done: 1, total: 2 })

		const detach = relay.attach(event => seen.push(event.type))

		relay.emit(engine("ready"))
		expect(seen).toEqual(["engine", "progress", "engine"])

		detach()
		relay.emit(engine("ready"))
		expect(seen).toHaveLength(3)

		relay.attach(event => seen.push(event.type))
		expect(seen).toHaveLength(4)
	})
})

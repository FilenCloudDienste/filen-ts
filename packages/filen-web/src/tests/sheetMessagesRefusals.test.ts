import { describe, expect, it } from "vitest"
import { refusalKey, viewOnlyKey } from "@/features/spreadsheet/lib/sheetMessages.logic"
import { isTextSheetKind } from "@/features/spreadsheet/lib/sheetKind"
import { preview } from "@/locales/en/preview"

describe("sheet refusal toasts", () => {
	it("says an insert-drag would split the selection, not that it is too large", () => {
		expect(refusalKey({ reason: "tooLarge", detail: "split" }, "xlsx")).toBe("previewSheetMoveSplit")
		expect(refusalKey({ reason: "tooLarge", detail: "split" }, "csv")).toBe("previewSheetMoveSplit")
		expect(refusalKey({ reason: "tooLarge" }, "xlsx")).toBe("previewSpreadsheetTooLarge")
		expect(preview).toHaveProperty("previewSheetMoveSplit")
	})

	it("blames a chart editor value the user can correct, not the chart", () => {
		expect(refusalKey({ reason: "chartValue", detail: "axis bounds" }, "xlsx")).toBe("previewSheetChartValueInvalid")
		expect(refusalKey({ reason: "chartUnsupported", detail: "pivot chart" }, "xlsx")).toBe("previewSheetChartUnsupported")
		expect(preview).toHaveProperty("previewSheetChartValueInvalid")
	})
})

describe("text sheet kinds", () => {
	it("knows the delimited kinds, and words an unsafe text file as one", () => {
		for (const kind of ["csv", "tsv", "tab"] as const) {
			expect(isTextSheetKind(kind)).toBe(true)
			expect(viewOnlyKey("unsafe", kind)).toBe("previewSpreadsheetReadOnlyUnsafe")
		}

		for (const kind of ["xlsx", "xls", "ods"] as const) {
			expect(isTextSheetKind(kind)).toBe(false)
			expect(viewOnlyKey("unsafe", kind)).toBe("previewSpreadsheetReadOnlyLossy")
		}
	})
})

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openXlsx } from "hucre/xlsx"
import { bytesSource } from "@filen/office/core/opc"
import { XlsxReadError } from "@filen/office/core/xlsx"
import { workbookOpener } from "@filen/office/dom/sheet"
import { xlsChart, xlsFile, xlsLabel, xlsNumber, xlsRecord, xlsWorkbookStream, XLS_CHART } from "@filen/office/testing/encryption"
import { xlsToXlsx, xlsxCopyName } from "@/features/spreadsheet/lib/xlsConvert"

const XLS = new Uint8Array(readFileSync(join(__dirname, "fixtures/spreadsheet/budget.xls")))

describe("xlsToXlsx", () => {
	it("converts every sheet's values into an .xlsx that opens", async () => {
		const workbook = await openXlsx(await xlsToXlsx(XLS))

		expect(workbook.sheets.map(sheet => sheet.name)).toEqual(["Budget", "Notes"])
		expect(workbook.sheets[0]?.rows).toEqual([
			["Item", "Cost"],
			["Rent", 1200],
			["Food", 300],
			["Total", 1500]
		])
		expect(workbook.sheets[1]?.rows).toEqual([["second sheet"]])
	})

	// A chart's series caches are NUMBER/LABEL records inside its own BOF…EOF substream ([MS-XLS] §2.4.21).
	it("keeps an embedded chart's cached series out of the sheet's cells, and reads the cells after it", async () => {
		const stream = xlsWorkbookStream([
			{
				name: "Data",
				records: [
					xlsLabel(0, 0, "Title"),
					xlsChart([xlsNumber(0, 0, 4074), xlsNumber(1, 0, 7), xlsLabel(2, 1, "series")]),
					xlsNumber(1, 0, 12.5)
				]
			}
		])
		const workbook = await openXlsx(await xlsToXlsx(await xlsFile(stream)))

		expect(workbook.sheets[0]?.rows).toEqual([["Title"], [12.5]])
	})

	// [MS-XLS] §2.1.7.20.6: FORMULA [ShrFmla | Array | Table] [String]; a string result's text is in the STRING record.
	it("reads a formula's string result past the shared, array or table formula record before its STRING", async () => {
		// FORMULA at (row, 0): a string result (FormulaValue byte 0 = 0, fExprO 0xFFFF), no parsed formula.
		const formula = (row: number) =>
			xlsRecord(0x0006, Uint8Array.of(row, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0))
		const string = (text: string) => xlsRecord(0x0207, Uint8Array.of(text.length, 0, 0, ...Array.from(text, c => c.charCodeAt(0))))
		const stream = xlsWorkbookStream([
			{
				name: "Data",
				records: [
					formula(0),
					xlsRecord(0x04bc, new Uint8Array(10)),
					string("2 Wow"),
					formula(1),
					xlsRecord(0x0221, new Uint8Array(14)),
					string("10"),
					formula(2),
					string("plain")
				]
			}
		])
		const workbook = await openXlsx(await xlsToXlsx(await xlsFile(stream)))

		expect(workbook.sheets[0]?.rows).toEqual([["2 Wow"], ["10"], ["plain"]])
	})

	// The workbook opener answers a converter's XlsxReadError "tooLarge" as a typed "tooLarge" failure.
	it("refuses a sheet past the cell limit as too large, not damaged", async () => {
		const error: unknown = await xlsToXlsx(XLS, 2).catch((thrown: unknown) => thrown)

		expect(error).toBeInstanceOf(XlsxReadError)
		expect(error instanceof XlsxReadError && error.code).toBe("tooLarge")

		const result = await workbookOpener({ legacy: file => xlsToXlsx(file, 2) })(
			bytesSource(XLS),
			{ kind: "xls" },
			() => undefined,
			() => undefined
		)

		expect(result.kind === "failed" && result.reason).toBe("tooLarge")
	})

	it("still throws damage as hucre's own error", async () => {
		await expect(xlsToXlsx(XLS.slice(0, 600))).rejects.not.toBeInstanceOf(XlsxReadError)
	})

	it("gives a chart sheet no cells", async () => {
		const stream = xlsWorkbookStream([
			{ name: "Data", records: [xlsNumber(0, 0, 1)] },
			{ name: "Chart1", dt: XLS_CHART, records: [xlsNumber(0, 0, 2), xlsNumber(1, 0, 3), xlsNumber(2, 0, 4)] }
		])
		const workbook = await openXlsx(await xlsToXlsx(await xlsFile(stream)))

		expect(workbook.sheets.map(sheet => sheet.name)).toEqual(["Data", "Chart1"])
		expect(workbook.sheets[0]?.rows).toEqual([[1]])
		expect(workbook.sheets[1]?.rows ?? []).toEqual([])
	})
})

describe("xlsxCopyName", () => {
	it("swaps the extension for .xlsx", async () => {
		expect(await xlsxCopyName("budget.xls", () => Promise.resolve(false))).toBe("budget.xlsx")
		expect(await xlsxCopyName("Q3 Report.XLS", () => Promise.resolve(false))).toBe("Q3 Report.xlsx")
	})

	it("numbers the copy when the name is taken, the way a file manager does", async () => {
		const taken = new Set(["budget.xlsx", "budget (2).xlsx"])

		expect(await xlsxCopyName("budget.xls", name => Promise.resolve(taken.has(name)))).toBe("budget (3).xlsx")
	})
})

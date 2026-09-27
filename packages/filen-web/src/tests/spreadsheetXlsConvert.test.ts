import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openXlsx } from "hucre/xlsx"
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

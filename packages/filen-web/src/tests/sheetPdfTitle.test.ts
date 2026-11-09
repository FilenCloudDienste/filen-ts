import { describe, expect, it } from "vitest"
import { pdfFile, pdfRequest } from "@/features/spreadsheet/print/print.logic"

// A spreadsheet's PDF is titled as a document's is: the workbook's own title, else its file name without the extension.

describe("the title of a spreadsheet's PDF", () => {
	it("is the workbook's own, else the file's name without its extension", () => {
		expect(pdfFile("budget.xlsx", { title: "Budget 2026" }, "en")).toEqual({ name: "budget.xlsx", title: "Budget 2026", lang: "en" })
		expect(pdfFile("budget.xlsx", {}, "en")).toEqual({ name: "budget.xlsx", title: "budget", lang: "en" })
	})

	it("carries the workbook's author, subject and keywords into the PDF request", () => {
		const file = pdfFile("budget.xlsx", { title: "Budget", properties: { author: "Ann", keywords: "money" } }, "en")

		expect(file.properties).toEqual({ author: "Ann", keywords: "money" })
		expect(pdfRequest([], file, { kind: "xlsx", sheets: [], date1904: false, showFormulas: false }).properties).toEqual({
			author: "Ann",
			keywords: "money"
		})
		expect(
			pdfRequest([], pdfFile("a.xlsx", {}, "en"), { kind: "xlsx", sheets: [], date1904: false, showFormulas: false })
		).not.toHaveProperty("properties")
	})
})

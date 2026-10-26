import { afterAll, describe, expect, it } from "vitest"
import { structuredDocx } from "../../docxPdfFixtures"
import { latin1 } from "../../rtfWriteFixtures"
import { buildFixture } from "../../xlsxWriteFixtures"
import { compareAb, disposeAb, exportForAb, sha256, type AbExport, type AbResult } from "./ab"

// The A/B gate's export: deterministic per format (the gate's baseline is only worth its bytes if two runs of the
// same tree agree), sensitive to content, and a comparison that reports every kind of change.

afterAll(() => {
	disposeAb()
})

function pdf(result: AbExport): Uint8Array {
	if (result.outcome !== "pdf") throw new Error(`${result.outcome}: ${result.reason}`)

	return result.pdf
}

const WORKBOOK = (value: string) =>
	buildFixture({
		sheets: [
			{
				name: "Data",
				body: `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c><c r="B1"><v>42</v></c></row></sheetData>`
			}
		]
	})
const RTF = (text: string) => latin1(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times;}}\\pard\\plain ${text}\\par}`)

describe("the shared-engine A/B export", () => {
	it("exports the same docx to the same PDF bytes twice, and another document to other bytes", { timeout: 60_000 }, async () => {
		const first = pdf(await exportForAb("docx", structuredDocx(), "report"))

		expect(pdf(await exportForAb("docx", structuredDocx(), "report"))).toEqual(first)
		expect(
			sha256(pdf(await exportForAb("docx", structuredDocx({ extraBody: "<w:p><w:r><w:t>More</w:t></w:r></w:p>" }), "report")))
		).not.toBe(sha256(first))
	})

	it("exports the same workbook to the same PDF bytes twice, and a changed cell to other bytes", { timeout: 60_000 }, async () => {
		const first = pdf(await exportForAb("xlsx", WORKBOOK("Alpha"), "book"))

		expect(pdf(await exportForAb("xlsx", WORKBOOK("Alpha"), "book"))).toEqual(first)
		expect(sha256(pdf(await exportForAb("xlsx", WORKBOOK("Beta"), "book")))).not.toBe(sha256(first))
	})

	it("exports an RTF through the converting worker the same way twice", { timeout: 60_000 }, async () => {
		const first = pdf(await exportForAb("rtf", RTF("Hello"), "letter"))

		expect(pdf(await exportForAb("rtf", RTF("Hello"), "letter"))).toEqual(first)
	})

	it("reports a file it cannot export as failed or refused with a reason, never as a PDF", { timeout: 60_000 }, async () => {
		for (const format of ["docx", "odt", "doc", "rtf", "xlsx", "ods"] as const) {
			const result = await exportForAb(format, new Uint8Array([1, 2, 3, 4]), "junk")

			expect(result.outcome, format).not.toBe("pdf")

			if (result.outcome !== "pdf") expect(result.reason, format).not.toBe("")
		}
	})
})

describe("the A/B comparison", () => {
	const base: AbResult = { path: "docx/a.docx", sha256: "s", outcome: "pdf", pdfSha256: "p", size: 1, pages: 1 }

	it("finds nothing between identical runs", () => {
		expect(compareAb([base], [{ ...base }])).toEqual([])
	})

	it("reports changed bytes, a changed outcome, a changed refusal, and a file only one run has", () => {
		const refused: AbResult = { path: "doc/b.doc", sha256: "t", outcome: "refused", reason: "encrypted" }
		const differences = compareAb(
			[base, refused, { path: "ods/c.ods", sha256: "u", outcome: "pdf", pdfSha256: "q" }],
			[
				{ ...base, pdfSha256: "other" },
				{ ...refused, reason: "corrupt" },
				{ path: "xlsx/d.xlsx", sha256: "v", outcome: "failed", reason: "x" }
			]
		)

		expect(differences.map(difference => difference.path)).toEqual(["doc/b.doc", "docx/a.docx", "ods/c.ods", "xlsx/d.xlsx"])
		expect(differences.find(difference => difference.path === "ods/c.ods")?.current).toBeUndefined()
		expect(compareAb([base], [{ ...base, outcome: "timeout" }])).toHaveLength(1)
	})
})

import { describe, expect, it } from "vitest"
import { XlsxWriteError } from "../core/xlsx/write/failure"
import { saveXlsx, writeXlsx } from "../core/xlsx/write/save"
import { CellKind } from "../core/xlsx/model/types"
import { verifyXlsxParts } from "../core/xlsx/verify/verify"
import { buildFixture, openWorkbook, parts } from "./xlsxWriteFixtures"

// The save's check counts each worksheet section against the model: a section written anew appears once (its
// markup holds every child of its name), a copied one as often as the source holds it.

const RULES =
	'<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>A1&gt;1</formula></cfRule></conditionalFormatting>' +
	'<conditionalFormatting sqref="B1"><cfRule type="expression" priority="2"><formula>B1&gt;1</formula></cfRule></conditionalFormatting>'

describe("the save check's section counts", () => {
	it("refuses a section written more often than the model has it", async () => {
		const workbook = await openWorkbook(buildFixture({ sheets: [{ name: "Data", body: `<sheetData/>${RULES}` }] }))

		await workbook.load(0)
		workbook.changes.sheetSection(0, "conditionalFormatting", () => RULES)

		const draft = await writeXlsx({ opc: workbook.opc, workbook })

		await expect(verifyXlsxParts(draft)).resolves.toBeUndefined()

		// The assembly as it was once: the markup written in place of each of the two sources.
		const sheet = draft.sheets[0]

		if (sheet === undefined) throw new Error("no sheet written")

		const doubled = { ...draft, sheets: [{ ...sheet, names: ["sheetData", "conditionalFormatting", "conditionalFormatting"] }] }
		const refusal = await verifyXlsxParts(doubled).then(
			() => null,
			(error: unknown) => error
		)

		expect(refusal).toBeInstanceOf(XlsxWriteError)
		expect((refusal as XlsxWriteError).reason).toBe("model")
		expect((refusal as XlsxWriteError).message).toContain("conditionalFormatting written 2 times")
	})

	it("accepts a copied section as often as the source holds it", async () => {
		const workbook = await openWorkbook(buildFixture({ sheets: [{ name: "Data", body: `<sheetData/>${RULES}` }] }))

		await workbook.load(0)
		workbook.changes.sheetRows(0)

		await expect(verifyXlsxParts(await writeXlsx({ opc: workbook.opc, workbook }))).resolves.toBeUndefined()
	})
})

describe("numbers the file cannot hold", () => {
	async function format(defaultRowHeight: string) {
		const workbook = await openWorkbook(
			buildFixture({
				sheets: [{ name: "Data", body: `<sheetFormatPr defaultRowHeight="${defaultRowHeight}" baseColWidth="1e999"/><sheetData/>` }]
			})
		)
		const sheet = await workbook.load(0)

		return { workbook, sheet }
	}

	it("write the model's value over a source attribute that is no number", async () => {
		for (const source of ["abc", "1e999"]) {
			const { workbook, sheet } = await format(source)

			sheet.format = { ...sheet.format, defaultRowHeight: 18, baseColWidth: 10 }
			workbook.changes.sheetSection(0, "sheetFormatPr")

			const result = await saveXlsx({ opc: workbook.opc, workbook })

			if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

			const written = parts(result.bytes as Uint8Array)["xl/worksheets/sheet1.xml"] ?? ""

			expect(written).toContain('defaultRowHeight="18"')
			expect(written).toContain('baseColWidth="10"')
		}
	})

	it("refuse naming the cell or the attribute that holds one", async () => {
		const cell = await format("15")

		cell.sheet.store.setCell(1, 2, CellKind.NUMBER, Number.NaN, 0, -1)
		cell.workbook.changes.sheetRows(0)

		expect(await saveXlsx({ opc: cell.workbook.opc, workbook: cell.workbook })).toMatchObject({
			ok: false,
			reason: "write",
			message: "Cell C2 holds NaN"
		})

		const attribute = await format("15")

		attribute.sheet.format = { ...attribute.sheet.format, defaultColWidth: Number.POSITIVE_INFINITY }
		attribute.workbook.changes.sheetSection(0, "sheetFormatPr")

		expect(await saveXlsx({ opc: attribute.workbook.opc, workbook: attribute.workbook })).toMatchObject({
			ok: false,
			reason: "write",
			message: "defaultColWidth is Infinity"
		})
	})
})

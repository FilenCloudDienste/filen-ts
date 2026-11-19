import { describe, expect, it } from "vitest"
import { CellKind } from "../core/xlsx/model/types"
import { saveXlsx } from "../core/xlsx/write/save"
import { buildFixture, openWorkbook, parts } from "./xlsxWriteFixtures"
import { slicedRun } from "./slicedRun"
import { budget } from "./timing"

// A save that appends one cell format to a styles part of megabytes: the part is walked, spliced and checked in
// slices, never parsed whole, so an in-thread host is never held over 50 ms of its CPU time.

const FORMATS = 60_000

function styles(): string {
	let xfs = ""

	for (let k = 0; k < FORMATS; k++) {
		xfs += `<xf numFmtId="${k % 50}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" indent="${k % 15}"/></xf>`
	}

	return (
		'<numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts>' +
		'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
		'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
		'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
		'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
		`<cellXfs count="${FORMATS}">${xfs}</cellXfs>` +
		'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
	)
}

describe("a sliced styles save", () => {
	it("gives the host a turn at least every 50 ms when one format is appended to 60,000", { timeout: 120_000 }, async () => {
		const workbook = await openWorkbook(
			buildFixture({
				sheets: [{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }],
				styles: styles()
			})
		)
		const model = await workbook.load(0)
		const xf = workbook.styles.cellXfs[1]!

		// A cell takes the appended format.
		model.store.setCell(0, 0, CellKind.NUMBER, 1, workbook.styles.appendXf({ ...xf, numFmtId: 164 }), -1)
		workbook.changes.stylesAppended()
		workbook.changes.sheetRows(0)

		const { result, longest } = await slicedRun(slicing => saveXlsx({ opc: workbook.opc, workbook }, { slicing }))

		expect(result.ok, JSON.stringify(result)).toBe(true)
		expect(longest).toBeLessThan(budget(50))

		if (result.ok) {
			const written = parts(result.bytes!)["xl/styles.xml"] ?? ""

			expect(written).toContain(`<cellXfs count="${FORMATS + 1}">`)
			expect(written).toContain('<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"')
		}
	})
})

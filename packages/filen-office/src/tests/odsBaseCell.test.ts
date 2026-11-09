import { describe, expect, it } from "vitest"
import { strFromU8, unzipSync } from "fflate"
import { bytesSource } from "../core/opc/index"
import { convertSheet } from "../core/ods/convert/index"
import { translateExpression } from "../core/ods/formula/toXlsx"
import { openOds } from "../core/ods/open"
import { openOdsFixture, table } from "./odsFixtures"
import { buildWorkbook } from "./xlsxReadFixtures"

// A condition's relative references are relative to its base cell (ODF 1.3 Part 3 §19.584); SpreadsheetML resolves a
// cfRule's or dataValidation's against the top-left cell of its range, so they move by the difference.

const STYLES =
	'<style:style style:name="Default" style:family="table-cell"/><style:style style:name="Bad" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>'
const ROWS = Array.from(
	{ length: 3 },
	(_, k) =>
		`<table:table-row><table:table-cell office:value-type="float" office:value="${String(k)}"><text:p>${String(k)}</text:p></table:table-cell><table:table-cell table:content-validation-name="v1"/></table:table-row>`
).join("")

function conditional(value: string, base: string): string {
	return `<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="S.A1:S.A3"><calcext:condition calcext:apply-style-name="Bad" calcext:value="${value}" calcext:base-cell-address="${base}"/></calcext:conditional-format></calcext:conditional-formats>`
}

function validation(condition: string, base: string): string {
	return `<table:content-validations><table:content-validation table:name="v1" table:condition="${condition}" table:allow-empty-cell="true" table:base-cell-address="${base}"/></table:content-validations>`
}

async function open(body: string): Promise<{ sections: string; issues: string[] }> {
	const opened = await openOdsFixture({ styles: STYLES, body })
	const sheet = opened.workbook.sheets[0]?.model

	return {
		sections: (sheet?.sections ?? []).map(section => (section.bytes === null ? "" : strFromU8(section.bytes))).join(""),
		issues: opened.issues.map(issue => `${issue.kind}:${issue.detail ?? ""}`)
	}
}

function withConditional(value: string, base: string): string {
	return table("S", ROWS).replace("</table:table>", `${conditional(value, base)}</table:table>`)
}

describe("an .ods condition's base cell", () => {
	it("moves a conditional format's relative references from its base cell to the range's top-left", async () => {
		const read = await open(withConditional("formula-is([.A2]&gt;0)", "S.A2"))

		expect(read.sections).toContain("<formula>A1&gt;0</formula>")
	})

	it("moves a cell-is comparison's references and leaves its absolute parts", async () => {
		const read = await open(withConditional("&gt;[.B$3]+[.$C2]+[.$D$9]", "S.B2"))

		expect(read.sections).toContain("<formula>A$3+$C1+$D$9</formula>")
	})

	it("refuses a rule whose references the move takes off the sheet, never clamps them", async () => {
		const read = await open(withConditional("formula-is([.A2]&gt;0)", "S.A3"))

		expect(read.sections).not.toContain("cfRule")
		expect(read.issues.some(issue => issue.startsWith("conditionalFormat:"))).toBe(true)
	})

	it("leaves a rule whose base cell is the range's top-left as written", async () => {
		const read = await open(withConditional("formula-is([.A1]&gt;[Other.B2])", "$S.$A$1"))

		expect(read.sections).toContain("<formula>A1&gt;Other!B2</formula>")
	})

	it("moves a validation's custom formula and list range from its base cell to the range's top-left", async () => {
		const custom = await open(validation("of:is-true-formula([.A3]&gt;1)", "S.B3") + table("S", ROWS))

		expect(custom.sections).toContain("<formula1>A1&gt;1</formula1>")

		const list = await open(validation("of:cell-content-is-in-list([.C2:.C4])", "S.B2") + table("S", ROWS))

		expect(list.sections).toContain("<formula1>C1:C3</formula1>")
	})

	it("reads back what its own writer gives off the top-left unchanged", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="2"><c r="B2"><v>1</v></c><c r="C2"><v>2</v></c></row></sheetData>' +
						'<conditionalFormatting sqref="B2:B4"><cfRule type="expression" dxfId="0" priority="1"><formula>C2&gt;B2</formula></cfRule></conditionalFormatting>' +
						'<dataValidations count="1"><dataValidation type="custom" allowBlank="1" sqref="C3:C5"><formula1>D3&gt;$A$1</formula1></dataValidation></dataValidations>'
				}
			]
		})
		const result = await convertSheet(source, "xlsx", "ods")

		if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

		const opened = await openOds(bytesSource(result.bytes))

		if (!opened.ok) throw new Error(`${opened.reason}: ${opened.message}`)

		const sections = (opened.workbook.sheets[0]?.model?.sections ?? [])
			.map(section => (section.bytes === null ? "" : strFromU8(section.bytes)))
			.join("")

		expect(sections).toMatch(/sqref="B2:B4"><cfRule type="expression"[^>]*><formula>C2&gt;B2<\/formula>/)
		expect(sections).toMatch(/<formula1>D3&gt;\$A\$1<\/formula1>/)
	})

	it("writes a range list's formulas for the top-left around its ranges, whichever range is listed first", async () => {
		const source = buildWorkbook({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="2"><c r="B2"><v>1</v></c></row></sheetData>' +
						'<conditionalFormatting sqref="C5 B2:B3"><cfRule type="expression" dxfId="0" priority="1"><formula>B2&gt;0</formula></cfRule></conditionalFormatting>' +
						'<dataValidations count="1"><dataValidation type="custom" allowBlank="1" sqref="D9 B4:B5 C3"><formula1>OR(ISBLANK(B3),ISTEXT(B3))</formula1></dataValidation></dataValidations>'
				}
			]
		})
		const result = await convertSheet(source, "xlsx", "ods")

		if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

		const content = strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array())

		expect(content).toMatch(/calcext:value="formula-is\(\[\.B2\]>0\)" calcext:base-cell-address="S\.B2"/)
		expect(content).toMatch(
			/table:condition="of:is-true-formula\(OR\(ISBLANK\(\[\.B3\]\);ISTEXT\(\[\.B3\]\)\)\)"[^>]*table:base-cell-address="S\.B3"/
		)

		const opened = await openOds(bytesSource(result.bytes))

		if (!opened.ok) throw new Error(`${opened.reason}: ${opened.message}`)

		const sections = (opened.workbook.sheets[0]?.model?.sections ?? [])
			.map(section => (section.bytes === null ? "" : strFromU8(section.bytes)))
			.join("")

		expect(sections).toMatch(/<formula>B2&gt;0<\/formula>/)
		expect(sections).toMatch(/<formula1>OR\(ISBLANK\(B3\),ISTEXT\(B3\)\)<\/formula1>/)
	})

	it("reads a range list's formulas for the top-left around its ranges, not its first range's", async () => {
		const rows =
			'<table:table-row><table:table-cell/><table:table-cell table:content-validation-name="v1"/></table:table-row>' +
			'<table:table-row><table:table-cell table:content-validation-name="v1"/><table:table-cell/></table:table-row>'
		const read = await open(validation("of:is-true-formula([.A1]&gt;1)", "S.A1") + table("S", rows))

		expect(read.sections).toContain("<formula1>A1&gt;1</formula1>")

		const shown = await open(
			table("S", rows).replace(
				"</table:table>",
				'<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="S.B1 S.A2"><calcext:condition calcext:apply-style-name="Bad" calcext:value="formula-is([.A1]&gt;0)" calcext:base-cell-address="S.A1"/></calcext:conditional-format></calcext:conditional-formats></table:table>'
			)
		)

		expect(shown.sections).toContain("<formula>A1&gt;0</formula>")
	})

	it("moves whole columns and rows only along their own axis", () => {
		expect(translateExpression("SUM([.B:.B])+SUM([.2:.2])", { rows: -1, cols: 1 })).toEqual({ text: "SUM(C:C)+SUM(1:1)" })
		expect(translateExpression('COUNTIF([.$B:.$B];"A1")+Rate', { rows: 5, cols: 5 })).toEqual({ text: 'COUNTIF($B:$B,"A1")+Rate' })
	})
})

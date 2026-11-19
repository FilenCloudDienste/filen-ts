import { describe, expect, it } from "vitest"
import type { SheetCommandResult } from "../core/sheet/protocol"
import type { SheetValidationRule } from "../core/sheet/dv/xlsx"
import { inThreadSheetHost } from "../dom/sheet/host"
import { IMMEDIATE } from "./sheetCfFixtures"
import { cells, savedBytes } from "./sheetSessionFixtures"
import { buildFixture, parts, type Fixture } from "./xlsxWriteFixtures"

// Data validation in a session: which cells offer a list or show a message, a list's items, an entry checked as
// Excel checks what is typed, and validations set and cleared through the reference catalogue's sections.

async function open(fixture: Fixture) {
	const host = inThreadSheetHost()
	const bytes = buildFixture(fixture)
	const result = await host.open(bytes.slice(), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(result.kind)

	const sheet = result.info.sheets[0]?.id ?? 0
	const layout = await result.session.layout(sheet)

	return { session: result.session, sheet, layout, bytes, info: result.info }
}

function ok(result: SheetCommandResult): void {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason} ${result.refusal.detail ?? ""}`)
}

const X14 =
	'xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"'

const VALIDATED: Fixture = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1"><v>3</v></c></row><row r="3"><c r="C3" t="inlineStr"><is><t>Red</t></is></c></row>' +
				'<row r="4"><c r="C4" t="inlineStr"><is><t>Green</t></is></c></row><row r="5"><c r="C5"><v>0.5</v></c></row></sheetData>' +
				'<dataValidations count="5">' +
				'<dataValidation type="whole" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="Out" error="1 to 10" promptTitle="Count" prompt="A whole number" sqref="A1:A10"><formula1>1</formula1><formula2>10</formula2></dataValidation>' +
				'<dataValidation type="list" showErrorMessage="1" sqref="B1:B5"><formula1>"Yes,No,Maybe"</formula1></dataValidation>' +
				'<dataValidation type="list" errorStyle="warning" showErrorMessage="1" sqref="D1"><formula1>$C$3:$C$5</formula1></dataValidation>' +
				'<dataValidation type="custom" showErrorMessage="1" sqref="E1:E5"><formula1>ISNUMBER(E1)</formula1></dataValidation>' +
				'<dataValidation type="textLength" operator="lessThanOrEqual" showErrorMessage="1" showDropDown="1" sqref="F1"><formula1>3</formula1></dataValidation>' +
				"</dataValidations>" +
				`<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" ${X14}><x14:dataValidations count="1"><x14:dataValidation type="list" showErrorMessage="1">` +
				"<x14:formula1><xm:f>Two!$A$1:$A$2</xm:f></x14:formula1><xm:sqref>G1:G3</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>"
		},
		{
			name: "Two",
			body: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>North</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>South</t></is></c></row></sheetData>'
		}
	]
}

const LIST: SheetValidationRule = {
	type: "list",
	operator: "between",
	value1: "a,b,c",
	value2: "",
	allowBlank: true,
	inCellDropdown: true,
	showInputMessage: false,
	promptTitle: "",
	prompt: "",
	showErrorMessage: true,
	errorStyle: "stop",
	errorTitle: "",
	error: ""
}

describe("data validation in a session", () => {
	it("lays out the cells that offer a list or show an input message", async () => {
		const { layout, session } = await open(VALIDATED)
		const validations = layout.extensions?.validations

		expect(validations?.entries).toEqual([
			{ dropdown: false, promptTitle: "Count", prompt: "A whole number" },
			{ dropdown: true, promptTitle: null, prompt: null },
			{ dropdown: true, promptTitle: null, prompt: null },
			{ dropdown: true, promptTitle: null, prompt: null }
		])
		// F1's list is hidden (showDropDown="1") and shows no message: not laid out.
		expect([...(validations?.ranges ?? [])].slice(-4)).toEqual([0, 6, 2, 6])
		session.close()
	})

	it("gives a list's items: typed, from cells as shown, and from another sheet not read yet", async () => {
		const { session, sheet } = await open(VALIDATED)

		expect((await session.query("validation.list", { sheet, row: 0, col: 1 }))?.items.map(item => item.text)).toEqual([
			"Yes",
			"No",
			"Maybe"
		])
		expect((await session.query("validation.list", { sheet, row: 0, col: 3 }))?.items).toEqual([
			{ text: "Red", input: "Red" },
			{ text: "Green", input: "Green" },
			{ text: "0.5", input: "0.5" }
		])
		expect((await session.query("validation.list", { sheet, row: 1, col: 6 }))?.items.map(item => item.text)).toEqual([
			"North",
			"South"
		])
		expect(await session.query("validation.list", { sheet, row: 0, col: 0 })).toBeNull()
		session.close()
	})

	// Excel's list leaves out the space typed after each comma, and LibreOffice reads the list without it; the file
	// keeps the formula as written.
	it("offers and takes a literal list's items without the spaces after its commas", async () => {
		const formula = '<formula1>"Yes, No,  Maybe"</formula1>'
		const { session, sheet } = await open({
			sheets: [
				{
					name: "One",
					body: `<sheetData/><dataValidations count="1"><dataValidation type="list" showErrorMessage="1" sqref="A1:A5">${formula}</dataValidation></dataValidations>`
				}
			]
		})

		expect((await session.query("validation.list", { sheet, row: 0, col: 0 }))?.items).toEqual([
			{ text: "Yes", input: "Yes" },
			{ text: "No", input: "No" },
			{ text: "Maybe", input: "Maybe" }
		])
		expect(await session.query("validation.check", { sheet, row: 0, col: 0, input: "No" })).toBeNull()
		expect(await session.query("validation.check", { sheet, row: 0, col: 0, input: "maybe" })).toBeNull()
		expect(await session.query("validation.check", { sheet, row: 0, col: 0, input: "Perhaps" })).not.toBeNull()

		ok(await session.command({ type: "cells.set", sheet, cells: cells([[0, 0, "No"]]) }))
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain(formula)
		session.close()
	})

	it("reads a list named by a defined name on a sheet not read yet", async () => {
		const { session, sheet } = await open({
			sheets: [
				{
					name: "One",
					body: '<sheetData/><dataValidations count="1"><dataValidation type="list" showErrorMessage="1" sqref="A1"><formula1>Regions</formula1></dataValidation></dataValidations>'
				},
				VALIDATED.sheets[1] as NonNullable<Fixture["sheets"][number]>
			],
			workbookTail: '<definedNames><definedName name="Regions">Two!$A$1:$A$2</definedName></definedNames>'
		})

		expect((await session.query("validation.list", { sheet, row: 0, col: 0 }))?.items.map(item => item.text)).toEqual([
			"North",
			"South"
		])
		expect(await session.query("validation.check", { sheet, row: 0, col: 0, input: "west" })).not.toBeNull()
		session.close()
	})

	it("checks an entry as Excel does", async () => {
		const { session, sheet } = await open(VALIDATED)
		const check = (row: number, col: number, input: string) => session.query("validation.check", { sheet, row, col, input })

		expect(await check(1, 0, "5")).toBeNull()
		expect(await check(1, 0, "11")).toEqual({ style: "stop", title: "Out", message: "1 to 10" })
		expect(await check(1, 0, "2.5")).not.toBeNull()
		expect(await check(1, 0, "abc")).not.toBeNull()
		// A formula's result is checked.
		expect(await check(1, 0, "=4*3")).not.toBeNull()
		expect(await check(1, 0, "=A1*2")).toBeNull()
		// Clearing a cell is never checked.
		expect(await check(1, 0, "")).toBeNull()
		expect(await check(0, 1, "yes")).toBeNull()
		expect(await check(0, 1, "Perhaps")).toEqual({ style: "stop", title: null, message: null })
		expect(await check(0, 3, "green")).toBeNull()
		expect(await check(0, 3, "Blue")).toMatchObject({ style: "warning" })
		expect(await check(0, 4, "12")).toBeNull()
		expect(await check(0, 4, "twelve")).not.toBeNull()
		expect(await check(0, 5, "abcd")).not.toBeNull()
		expect(await check(0, 6, "South")).toBeNull()
		expect(await check(0, 6, "East")).not.toBeNull()
		// No validation there.
		expect(await check(9, 9, "anything")).toBeNull()
		session.close()
	})

	it("compares an entry with its bounds and list to 15 significant digits", async () => {
		const { session, sheet } = await open({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="C1"><v>0.3</v></c></row></sheetData><dataValidations count="3">' +
						'<dataValidation type="decimal" operator="equal" showErrorMessage="1" sqref="A1"><formula1>0.3</formula1></dataValidation>' +
						'<dataValidation type="decimal" operator="lessThanOrEqual" showErrorMessage="1" sqref="A2"><formula1>0.3</formula1></dataValidation>' +
						'<dataValidation type="list" showErrorMessage="1" sqref="A3"><formula1>$C$1</formula1></dataValidation>' +
						"</dataValidations>"
				}
			]
		})
		const check = (row: number, input: string) => session.query("validation.check", { sheet, row, col: 0, input })

		expect(await check(0, "=0.1+0.2")).toBeNull()
		expect(await check(1, "=0.1+0.2")).toBeNull()
		expect(await check(2, "=0.1+0.2")).toBeNull()
		expect(await check(0, "0.30000000000001")).not.toBeNull()
		session.close()
	})

	it("reads an entry and a dialog's bounds in the session's locale", async () => {
		const { session, sheet } = await open({
			sheets: [
				{
					name: "One",
					body: '<sheetData/><dataValidations count="1"><dataValidation type="decimal" showErrorMessage="1" sqref="A1"><formula1>1</formula1><formula2>2</formula2></dataValidation></dataValidations>'
				}
			]
		})

		session.configure({ locale: { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" } })

		expect(await session.query("validation.check", { sheet, row: 0, col: 0, input: "1,5" })).toBeNull()
		// A list's items are entered as the locale types them.
		ok(
			await session.command({
				type: "validation.set",
				sheet,
				ranges: [{ startRow: 5, startCol: 0, endRow: 5, endCol: 0 }],
				rule: { ...LIST, value1: "=$A$7" }
			})
		)
		ok(
			await session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(6), cols: Uint16Array.of(0), inputs: ["2,75"] }
			})
		)
		expect((await session.query("validation.list", { sheet, row: 5, col: 0 }))?.items).toEqual([{ text: "2,75", input: "2,75" }])
		expect(await session.query("validation.check", { sheet, row: 0, col: 0, input: "2,5" })).not.toBeNull()

		ok(
			await session.command({
				type: "validation.set",
				sheet,
				ranges: [{ startRow: 1, startCol: 0, endRow: 1, endCol: 0 }],
				rule: { ...LIST, type: "decimal", operator: "greaterThan", value1: "0,25" }
			})
		)
		ok(
			await session.command({
				type: "validation.set",
				sheet,
				ranges: [{ startRow: 2, startCol: 0, endRow: 2, endCol: 0 }],
				rule: { ...LIST, type: "custom", value1: "=AND(A3>0;A3<5)" }
			})
		)
		ok(
			await session.command({
				type: "validation.set",
				sheet,
				ranges: [{ startRow: 3, startCol: 0, endRow: 3, endCol: 0 }],
				rule: { ...LIST, value1: "x;y" }
			})
		)

		const xml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(xml).toContain("<formula1>0.25</formula1>")
		expect(xml).toContain("<formula1>AND(A3&gt;0,A3&lt;5)</formula1>")
		expect(xml).toContain('<formula1>"x,y"</formula1>')
		// The dialog shows them as the locale types them.
		expect(await session.query("validation.rule", { sheet, row: 1, col: 0 })).toMatchObject({ value1: "0,25" })
		expect(await session.query("validation.rule", { sheet, row: 2, col: 0 })).toMatchObject({ value1: "=AND(A3>0;A3<5)" })
		expect(await session.query("validation.rule", { sheet, row: 3, col: 0 })).toMatchObject({ value1: "x;y" })
		session.close()
	})

	it("lets anything through a validation without an error alert", async () => {
		const { session, sheet } = await open({
			sheets: [
				{
					name: "One",
					body: '<sheetData/><dataValidations count="1"><dataValidation type="whole" sqref="A1"><formula1>1</formula1><formula2>2</formula2></dataValidation></dataValidations>'
				}
			]
		})

		expect(await session.query("validation.check", { sheet, row: 0, col: 0, input: "99" })).toBeNull()
		session.close()
	})

	it("sets a validation, splitting the ones the cells had and keeping their formulas for their cells", async () => {
		const { session, sheet, bytes } = await open(VALIDATED)

		ok(
			await session.command({
				type: "validation.set",
				sheet,
				ranges: [{ startRow: 0, startCol: 4, endRow: 1, endCol: 4 }],
				rule: LIST
			})
		)

		const xml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(xml).toContain(
			'<dataValidation type="custom" showErrorMessage="1" sqref="E3:E5"><formula1>ISNUMBER(E3)</formula1></dataValidation>'
		)
		expect(xml).toContain(
			'<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="E1:E2"><formula1>"a,b,c"</formula1></dataValidation></dataValidations>'
		)
		expect(xml).toContain('<dataValidations count="6">')
		expect(await session.query("validation.rule", { sheet, row: 1, col: 4 })).toMatchObject({ type: "list", value1: "a,b,c" })
		expect(await session.query("validation.check", { sheet, row: 1, col: 4, input: "B" })).toBeNull()

		ok(await session.undo())
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})

	it("clears validations, the Excel 2010 ones in the extLst too", async () => {
		const { session, sheet } = await open(VALIDATED)

		ok(
			await session.command({
				type: "validation.set",
				sheet,
				ranges: [{ startRow: 0, startCol: 0, endRow: 9, endCol: 7 }],
				rule: null
			})
		)

		const xml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(xml).not.toContain("dataValidation")
		expect(xml).not.toContain("extLst")
		expect(await session.query("validation.rule", { sheet, row: 0, col: 0 })).toBeNull()
		session.close()
	})

	it("adds the section where the sheet had none, at its place, and moves it with an inserted row", async () => {
		const { session, sheet } = await open({
			sheets: [
				{
					name: "One",
					body: '<sheetData/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
				}
			]
		})

		ok(
			await session.command({
				type: "validation.set",
				sheet,
				ranges: [{ startRow: 2, startCol: 0, endRow: 4, endCol: 0 }],
				rule: { ...LIST, type: "custom", value1: "=A3>B3" },
				at: { row: 3, col: 0 }
			})
		)
		ok(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 0, count: 1 }))

		const xml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		// Typed for A4 (the active cell), written for A3, then moved down a row.
		expect(xml).toContain(
			'<sheetData/><dataValidations count="1"><dataValidation type="custom" allowBlank="1" showErrorMessage="1" sqref="A4:A6"><formula1>A3&gt;B3</formula1></dataValidation></dataValidations><pageMargins'
		)
		session.close()
	})

	it("copies a validation a sheet was given with the sheet", async () => {
		const { session, sheet } = await open({ sheets: [{ name: "One", body: "<sheetData/>" }] })

		ok(
			await session.command({
				type: "validation.set",
				sheet,
				ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
				rule: LIST
			})
		)
		ok(await session.command({ type: "sheet.duplicate", sheet }))

		const saved = parts(await savedBytes(session))

		expect(saved["xl/worksheets/sheet2.xml"]).toContain(
			'<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="A1"><formula1>"a,b,c"</formula1></dataValidation>'
		)
		session.close()
	})

	it("refuses what the file cannot hold, and on a protected sheet", async () => {
		const { session, sheet } = await open(VALIDATED)
		const range = [{ startRow: 20, startCol: 0, endRow: 20, endCol: 0 }]
		const refusal = async (rule: SheetValidationRule) => {
			const result = await session.command({ type: "validation.set", sheet, ranges: range, rule })

			return result.ok ? null : result.refusal.reason
		}

		expect(await refusal({ ...LIST, value1: "x".repeat(256) })).toBe("tooLarge")
		expect(await refusal({ ...LIST, value1: "=SUM(" })).toBe("formula")
		expect(await refusal({ ...LIST, type: "whole", value1: "ten", value2: "20" })).toBe("formula")
		expect(await refusal({ ...LIST, errorTitle: "t".repeat(33) })).toBe("tooLarge")
		expect(await refusal({ ...LIST, prompt: "\u0001" })).toBe("unsupported")
		session.close()

		const locked = await open({ sheets: [{ name: "One", body: '<sheetData/><sheetProtection sheet="1"/>' }] })
		const result = await locked.session.command({ type: "validation.set", sheet: locked.sheet, ranges: range, rule: LIST })

		expect(result.ok ? null : result.refusal.reason).toBe("protectedSheet")
		locked.session.close()
	})
})

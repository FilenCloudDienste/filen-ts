import { describe, expect, it } from "vitest"
import type { SheetChange, SheetCommandResult, SheetRange, SheetSessionApi } from "../core/sheet/protocol"
import { equalBytes, parts, type Fixture, type FixtureSheet } from "./xlsxWriteFixtures"
import { cells, firstTile, openFixture, savedBytes, tileEntry } from "./sheetSessionFixtures"
import { R, TYPES, relationship, rels } from "./xlsxRefsFixtures"

// A cut and its paste: the source is cleared as cells.clear clears it (and refused where a clear is), and every
// formula that refers to the moved cells follows them.

function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok)
		throw new Error(`refused: ${result.refusal.reason}${result.refusal.detail === undefined ? "" : ` (${result.refusal.detail})`}`)

	return result.change
}

function range(startRow: number, startCol: number, endRow = startRow, endCol = startCol): SheetRange {
	return { startRow, startCol, endRow, endCol }
}

async function cutPaste(
	session: SheetSessionApi,
	from: number,
	source: SheetRange,
	to: number,
	at: { row: number; col: number }
): Promise<SheetCommandResult> {
	const copy = await session.query("copy", { sheet: from, range: source, cut: true })

	if (!("clip" in copy)) throw new Error("copy refused")

	return session.command({ type: "clipboard.paste", sheet: to, at, text: copy.text, clip: copy.clip })
}

async function inputAt(session: SheetSessionApi, sheet: number, row: number, col: number): Promise<string | null | undefined> {
	return tileEntry(await firstTile(session, sheet), row, col)?.input
}

const SHARED: Fixture = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row>' +
				'<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>4</v></c></row>' +
				'<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>6</v></c></row></sheetData>'
		}
	]
}

describe("sheet session: a cut's source", () => {
	it("unshares a cut shared formula's master, so the children keep their formulas", async () => {
		const { session, info } = await openFixture(SHARED)
		const one = info.sheets[0]!.id

		changeOf(await cutPaste(session, one, range(0, 1), one, { row: 0, col: 3 }))
		expect(await inputAt(session, one, 0, 3)).toBe("=A1*2")
		expect(await inputAt(session, one, 1, 1)).toBe("=A2*2")
		expect(await inputAt(session, one, 2, 1)).toBe("=A3*2")

		const sheet = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheet).toContain('<c r="B2"><f>A2*2</f><v>4</v></c>')
		expect(sheet).toContain('<c r="B3"><f>A3*2</f><v>6</v></c>')
		expect(sheet).not.toContain('t="shared"')
		session.close()
	})

	it("gives the shared group back on undo", async () => {
		const { session, info, bytes } = await openFixture(SHARED)
		const one = info.sheets[0]!.id

		changeOf(await cutPaste(session, one, range(0, 1), one, { row: 0, col: 3 }))
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("refuses to cut part of an array formula", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><f t="array" ref="C1:C2">A1:A2*2</f><v>2</v></c></row>' +
						'<row r="2"><c r="A2"><v>2</v></c><c r="C2"><v>4</v></c></row></sheetData>'
				}
			]
		})
		const one = info.sheets[0]!.id
		const result = await cutPaste(session, one, range(1, 2), one, { row: 5, col: 5 })

		expect(result.ok ? null : result.refusal.reason).toBe("arrayFormula")
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('<c r="C2"><v>4</v></c>')
		session.close()
	})

	it("refuses to cut locked cells of a protected sheet", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "Locked",
					body: '<sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData><sheetProtection sheet="1" objects="1" scenarios="1"/>'
				},
				{ name: "Open", body: "<sheetData/>" }
			]
		})
		const result = await cutPaste(session, info.sheets[0]!.id, range(0, 0), info.sheets[1]!.id, { row: 0, col: 0 })

		expect(result.ok ? null : result.refusal.reason).toBe("protectedSheet")
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('<c r="A1"><v>7</v></c>')
		session.close()
	})
})

const LINKED: Fixture = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1"><v>5</v></c><c r="B1"><f>A1*2</f><v>10</v></c><c r="E1"><f>SUM(A1:A2)</f><v>5</v></c></row>' +
				'<row r="2"><c r="B2"><f>$A$1+One!A1</f><v>10</v></c></row></sheetData>'
		},
		{ name: "Two", body: '<sheetData><row r="1"><c r="A1"><f>One!A1+1</f><v>6</v></c></row></sheetData>' }
	]
}

describe("sheet session: formulas that refer to cut cells", () => {
	it("follow the cells to the paste, on every sheet; a range the cut covers only in part stays", async () => {
		const { session, info } = await openFixture(LINKED)
		const one = info.sheets[0]!.id
		const two = info.sheets[1]!.id

		changeOf(await cutPaste(session, one, range(0, 0), one, { row: 2, col: 2 }))
		expect(await inputAt(session, one, 0, 1)).toBe("=C3*2")
		expect(await inputAt(session, one, 1, 1)).toBe("=$C$3+One!C3")
		expect(await inputAt(session, one, 0, 4)).toBe("=SUM(A1:A2)")
		expect(await inputAt(session, two, 0, 0)).toBe("=One!C3+1")

		// The engine reads the moved cells from their new place.
		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[2, 2, "7"]]) }))
		expect(tileEntry(await firstTile(session, one), 0, 1)?.text).toBe("14")
		expect(tileEntry(await firstTile(session, two), 0, 0)?.text).toBe("8")
		session.close()
	})

	it("follow cells cut to another sheet, and undo puts every formula back", async () => {
		const { session, info, bytes } = await openFixture(LINKED)
		const one = info.sheets[0]!.id
		const two = info.sheets[1]!.id

		changeOf(await cutPaste(session, one, range(0, 0), two, { row: 0, col: 3 }))
		// "Two" reads as a column name: the sheet is quoted.
		expect(await inputAt(session, one, 0, 1)).toBe("='Two'!D1*2")
		expect(await inputAt(session, two, 0, 0)).toBe("='Two'!D1+1")
		expect(tileEntry(await firstTile(session, two), 0, 3)?.text).toBe("5")
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("unshares a shared group whose formulas follow the cut cells", async () => {
		const { session, info } = await openFixture(SHARED)
		const one = info.sheets[0]!.id

		changeOf(await cutPaste(session, one, range(0, 0, 2, 0), one, { row: 0, col: 3 }))

		const sheet = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheet).toContain('<c r="B1"><f>D1*2</f><v>2</v></c>')
		expect(sheet).toContain('<c r="B2"><f>D2*2</f><v>4</v></c>')
		expect(sheet).toContain('<c r="B3"><f>D3*2</f><v>6</v></c>')
		session.close()
	})

	it("moves a defined name wholly inside the cut, keeps one only partly inside, and undo puts them back", async () => {
		const { session, info, bytes } = await openFixture({
			...LINKED,
			workbookTail:
				'<definedNames><definedName name="Rate" comment="c">One!$A$1</definedName><definedName name="Span">One!$A$1:$A$9</definedName></definedNames>'
		})
		const one = info.sheets[0]!.id

		changeOf(await cutPaste(session, one, range(0, 0), one, { row: 2, col: 2 }))

		const workbook = parts(await savedBytes(session))["xl/workbook.xml"] ?? ""

		expect(workbook).toContain('<definedName name="Rate" comment="c">One!$C$3</definedName>')
		expect(workbook).toContain('<definedName name="Span">One!$A$1:$A$9</definedName>')
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})
})

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const ONE: FixtureSheet = {
	name: "One",
	body: '<sheetData><row r="1"><c r="A1"><v>5</v></c></row><row r="2"><c r="A2"><v>6</v></c></row><row r="3"><c r="A3"><v>7</v></c><c r="C3"><v>9</v></c></row></sheetData>'
}

function withTwo(body: string): Fixture {
	return { sheets: [ONE, { name: "Two", body: `<sheetData/>${body}` }] }
}

function chartFixture(formula: string): Fixture {
	const xdr = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
	const a = "http://schemas.openxmlformats.org/drawingml/2006/main"
	const c = "http://schemas.openxmlformats.org/drawingml/2006/chart"
	const marker = (name: string, at: number): string =>
		`<xdr:${name}><xdr:col>${at}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${at}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${name}>`

	return {
		sheets: [
			ONE,
			{ name: "Two", body: '<sheetData/><drawing r:id="rId1"/>', rels: relationship("rId1", "drawing", "../drawings/drawing1.xml") }
		],
		parts: {
			"xl/drawings/drawing1.xml": {
				text:
					`${DECLARATION}<xdr:wsDr xmlns:xdr="${xdr}" xmlns:a="${a}" xmlns:r="${R}"><xdr:twoCellAnchor>${marker("from", 1)}${marker("to", 4)}` +
					'<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="c"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/>' +
					`<a:graphic><a:graphicData uri="${c}"><c:chart xmlns:c="${c}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
				type: TYPES.drawing
			},
			"xl/drawings/_rels/drawing1.xml.rels": {
				text: rels(relationship("rId1", "chart", "../charts/chart1.xml")),
				type: TYPES.relationships
			},
			"xl/charts/chart1.xml": {
				text: `${DECLARATION}<c:chartSpace xmlns:c="${c}" xmlns:a="${a}"><c:chart><c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>${formula}</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
				type: TYPES.chart
			}
		}
	}
}

async function cutOne(fixture: Fixture, source: SheetRange, at: { row: number; col: number }) {
	const opened = await openFixture(fixture)
	const one = opened.info.sheets[0]!.id
	const result = await cutPaste(opened.session, one, source, one, at)

	return { ...opened, one, result }
}

function refusal(result: SheetCommandResult): { reason: string; detail?: string } | null {
	return result.ok ? null : result.refusal
}

// A table over A1:B3, its header row A1:B1.
const TABLE: Fixture = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>K</t></is></c><c r="B1" t="inlineStr"><is><t>V</t></is></c></row>' +
				'<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c><c r="B3"><v>4</v></c></row></sheetData>' +
				'<tableParts count="1"><tablePart r:id="rId1"/></tableParts>',
			rels: relationship("rId1", "table", "../tables/table1.xml")
		}
	],
	parts: {
		"xl/tables/table1.xml": {
			text: `${DECLARATION}<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="A1:B3"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="K"/><tableColumn id="2" name="V"/></tableColumns></table>`,
			type: TYPES.table
		}
	}
}

describe("sheet session: what else refers to cut cells", () => {
	it("moves conditional format and validation formulas that read the cut cells, and undo saves the source", async () => {
		const { session, result, bytes } = await cutOne(
			withTwo(
				'<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>One!$A$1&gt;3</formula></cfRule></conditionalFormatting>' +
					'<dataValidations count="1"><dataValidation type="list" sqref="B1"><formula1>One!$A$1:$A$2</formula1></dataValidation></dataValidations>'
			),
			range(0, 0, 1, 0),
			{ row: 0, col: 3 }
		)

		changeOf(result)

		const two = parts(await savedBytes(session))["xl/worksheets/sheet2.xml"] ?? ""

		expect(two).toContain("<formula>One!$D$1&gt;3</formula>")
		expect(two).toContain("<formula1>One!$D$1:$D$2</formula1>")
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		changeOf(await session.redo())
		expect(parts(await savedBytes(session))["xl/worksheets/sheet2.xml"]).toContain("<formula>One!$D$1&gt;3</formula>")
		session.close()
	})

	it("moves a chart's series that reads the cut cells", async () => {
		const { session, result } = await cutOne(chartFixture("One!$A$1:$A$2"), range(0, 0, 1, 0), { row: 0, col: 3 })

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/charts/chart1.xml"]).toContain("<c:f>One!$D$1:$D$2</c:f>")
		session.close()
	})

	it("keeps a chart's series that reads the cut cells only in part", async () => {
		const { session, result } = await cutOne(chartFixture("One!$A$1:$A$3"), range(0, 0, 1, 0), { row: 0, col: 3 })

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/charts/chart1.xml"]).toContain("<c:f>One!$A$1:$A$3</c:f>")
		session.close()
	})

	it("moves a relative reference to the cut cells in another sheet's conditional format, as written", async () => {
		const { session, result } = await cutOne(
			withTwo(
				'<conditionalFormatting sqref="A1:A5"><cfRule type="expression" priority="1"><formula>One!A1&gt;3</formula></cfRule></conditionalFormatting>'
			),
			range(0, 0),
			{ row: 0, col: 3 }
		)

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/worksheets/sheet2.xml"]).toContain("<formula>One!D1&gt;3</formula>")
		session.close()
	})

	it("carries a conditional format, a validation and a hyperlink with the cut cell; those of the pasted cells go", async () => {
		const sheet = (body: string): Fixture => ({ sheets: [{ ...ONE, body: `${ONE.body ?? ""}${body}` }] })
		const format = await cutOne(
			sheet(
				'<conditionalFormatting sqref="A1:A5"><cfRule type="cellIs" operator="greaterThan" priority="1"><formula>3</formula></cfRule></conditionalFormatting>'
			),
			range(0, 0),
			{ row: 4, col: 4 }
		)
		const validation = await cutOne(
			sheet(
				'<dataValidations count="1"><dataValidation type="whole" sqref="E5"><formula1>1</formula1></dataValidation></dataValidations>'
			),
			range(0, 0),
			{ row: 4, col: 4 }
		)
		const link = await cutOne(sheet('<hyperlinks><hyperlink ref="E5" location="One!A1" display="x"/></hyperlinks>'), range(0, 0), {
			row: 4,
			col: 4
		})

		changeOf(format.result)
		changeOf(validation.result)
		changeOf(link.result)
		expect(parts(await savedBytes(format.session))["xl/worksheets/sheet1.xml"]).toContain('<conditionalFormatting sqref="A2:A5 E5">')

		const validated = parts(await savedBytes(validation.session))["xl/worksheets/sheet1.xml"] ?? ""
		const linked = parts(await savedBytes(link.session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(validated).not.toContain("dataValidation")
		expect(linked).not.toContain("hyperlink")

		for (const opened of [format, validation, link]) opened.session.close()
	})

	it("moves a cut cell's conditional format, its formula written for the top-left of the rectangle around its ranges", async () => {
		const { session, result, bytes } = await cutOne(
			{
				sheets: [
					{
						...ONE,
						body:
							`${ONE.body ?? ""}<conditionalFormatting sqref="A1:A3"><cfRule type="expression" priority="1"><formula>$B1&gt;5</formula></cfRule></conditionalFormatting>` +
							'<dataValidations count="1"><dataValidation type="whole" sqref="A1:A3"><formula1>0</formula1></dataValidation></dataValidations>' +
							'<hyperlinks><hyperlink ref="A1" location="One!C3" display="go"/></hyperlinks>'
					}
				]
			},
			range(0, 0),
			{ row: 0, col: 4 }
		)

		changeOf(result)

		const sheet = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheet).toContain(
			'<conditionalFormatting sqref="A2:A3 E1"><cfRule type="expression" priority="1"><formula>$B1&gt;5</formula>'
		)
		expect(sheet).toContain('<dataValidation type="whole" sqref="A2:A3 E1">')
		expect(sheet).toContain('<hyperlink ref="E1" location="One!C3" display="go"/>')
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("refuses to carry a cut cell's conditional format to another sheet", async () => {
		const opened = await openFixture({
			sheets: [
				{
					...ONE,
					body: `${ONE.body ?? ""}<conditionalFormatting sqref="A1:A3"><cfRule type="cellIs" operator="greaterThan" priority="1"><formula>3</formula></cfRule></conditionalFormatting>`
				},
				{ name: "Two", body: "<sheetData/>" }
			]
		})
		const result = await cutPaste(opened.session, opened.info.sheets[0]!.id, range(0, 0), opened.info.sheets[1]!.id, { row: 0, col: 0 })

		expect(refusal(result)).toEqual({ reason: "structureLocked", detail: "conditionalFormatting: another sheet" })
		opened.session.close()
	})
})

describe("sheet session: formulas that refer to cells a cut's paste writes over", () => {
	const fixture: Fixture = {
		sheets: [
			{
				name: "One",
				body:
					'<sheetData><row r="1"><c r="A1"><v>5</v></c><c r="B1"><v>6</v></c></row>' +
					'<row r="3"><c r="C3"><v>9</v></c><c r="D3"><v>1</v></c></row>' +
					'<row r="5"><c r="E5"><f>C3+1</f><v>10</v></c><c r="F5"><f>SUM(C3:D3)</f><v>10</v></c><c r="G5"><f>SUM(C3:C4)</f><v>9</v></c></row></sheetData>'
			},
			{ name: "Two", body: '<sheetData><row r="1"><c r="A1"><f>One!C3*2</f><v>18</v></c></row></sheetData>' }
		]
	}

	it("write #REF! where the reference is wholly to the written-over cells", async () => {
		const opened = await openFixture({
			sheets: [
				{ ...fixture.sheets[0]!, body: (fixture.sheets[0]!.body ?? "").replace('<c r="G5"><f>SUM(C3:C4)</f><v>9</v></c>', "") },
				fixture.sheets[1]!
			]
		})
		const one = opened.info.sheets[0]!.id

		changeOf(await cutPaste(opened.session, one, range(0, 0, 0, 1), one, { row: 2, col: 2 }))
		expect(await inputAt(opened.session, one, 4, 4)).toBe("=#REF!+1")
		expect(await inputAt(opened.session, one, 4, 5)).toBe("=SUM(#REF!)")
		expect(await inputAt(opened.session, opened.info.sheets[1]!.id, 0, 0)).toBe("=One!#REF!*2")
		changeOf(await opened.session.undo())
		expect(equalBytes(await savedBytes(opened.session), opened.bytes)).toBe(true)
		opened.session.close()
	})

	it("keep a range that takes the written-over cells only in part", async () => {
		const { session, one, result } = await cutOne(fixture, range(0, 0, 0, 1), { row: 2, col: 2 })

		changeOf(result)
		expect(await inputAt(session, one, 4, 6)).toBe("=SUM(C3:C4)")
		session.close()
	})
})

describe("sheet session: ordinary cuts", () => {
	const column = (n: number, extra: (r: number) => string = () => ""): string =>
		Array.from(
			{ length: n },
			(_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${100 + i}</v></c><c r="B${i + 1}"><v>${i + 1}</v></c>${extra(i + 1)}</row>`
		).join("")
	const sheetOf = (body: string): Fixture => ({ sheets: [{ name: "One", body: `<sheetData>${body}</sheetData>` }] })

	it("pastes into the middle of a summed range, and cuts from a column a whole-column sum reads", async () => {
		const middle = await cutOne(sheetOf(column(10) + '<row r="11"><c r="B11"><f>SUM(B1:B10)</f><v>55</v></c></row>'), range(0, 0), {
			row: 4,
			col: 1
		})
		const whole = await cutOne(sheetOf(column(10, r => (r === 1 ? '<c r="D1"><f>SUM(B:B)</f><v>55</v></c>' : ""))), range(2, 1), {
			row: 19,
			col: 1
		})

		changeOf(middle.result)
		changeOf(whole.result)
		expect(await inputAt(middle.session, middle.one, 10, 1)).toBe("=SUM(B1:B10)")
		expect(await inputAt(whole.session, whole.one, 0, 3)).toBe("=SUM(B:B)")
		middle.session.close()
		whole.session.close()
	})

	it("moves a reference to the cut cell and breaks one to the cell it writes over", async () => {
		const { session, one, result } = await cutOne(
			sheetOf(column(3, r => (r === 1 ? '<c r="D1"><f>A1+B3</f><v>103</v></c>' : ""))),
			range(0, 0),
			{
				row: 2,
				col: 1
			}
		)

		changeOf(result)
		expect(await inputAt(session, one, 0, 3)).toBe("=B3+#REF!")
		session.close()
	})

	it("moves a merge the cut takes whole, drops one the paste covers whole, and refuses one only partly cut or covered", async () => {
		const fixture = (merges: string): Fixture => ({
			sheets: [{ name: "One", body: `<sheetData>${column(10)}</sheetData><mergeCells count="1">${merges}</mergeCells>` }]
		})
		const whole = await cutOne(fixture('<mergeCell ref="A3:B3"/>'), range(2, 0, 2, 1), { row: 2, col: 4 })
		const covered = await cutOne(fixture('<mergeCell ref="E3:F3"/>'), range(2, 0, 2, 1), { row: 2, col: 4 })
		const split = await cutOne(fixture('<mergeCell ref="A3:B3"/>'), range(2, 0), { row: 2, col: 4 })
		const partly = await cutOne(fixture('<mergeCell ref="E3:E4"/>'), range(2, 0), { row: 2, col: 4 })

		changeOf(whole.result)
		changeOf(covered.result)
		expect(parts(await savedBytes(whole.session))["xl/worksheets/sheet1.xml"]).toContain('<mergeCell ref="E3:F3"/>')
		expect(parts(await savedBytes(covered.session))["xl/worksheets/sheet1.xml"]).not.toContain("mergeCell")
		expect(refusal(split.result)?.reason).toBe("merged")
		expect(refusal(partly.result)?.reason).toBe("merged")

		for (const opened of [whole, covered, split, partly]) opened.session.close()
	})

	it("cuts a data cell out of a table, as LibreOffice does, and refuses a header cell", async () => {
		const fixture = TABLE

		const data = await cutOne(fixture, range(2, 0), { row: 2, col: 4 })
		const header = await cutOne(fixture, range(0, 0), { row: 0, col: 4 })

		changeOf(data.result)
		expect(parts(await savedBytes(data.session))["xl/tables/table1.xml"]).toContain('ref="A1:B3"')
		expect(refusal(header.result)?.reason).toBe("tableHeader")
		data.session.close()
		header.session.close()
	})

	it("clears a table's data cells and formats, as a cut clears them, and refuses to empty a header cell", async () => {
		const { session, info } = await openFixture(TABLE)
		const one = info.sheets[0]!.id
		const clear = (ranges: readonly SheetRange[], what: "contents" | "formats" | "all"): Promise<SheetCommandResult> =>
			session.command({ type: "cells.clear", sheet: one, ranges, what })

		expect(refusal(await clear([range(0, 0)], "contents"))?.reason).toBe("tableHeader")
		expect(refusal(await clear([range(0, 0, 2, 1)], "all"))?.reason).toBe("tableHeader")
		expect(refusal(await clear([range(0, 0, 1_048_575, 0)], "contents"))?.reason).toBe("tableHeader")
		expect(tileEntry(await firstTile(session, one), 0, 0)?.text).toBe("K")
		changeOf(await clear([range(0, 0)], "formats"))
		changeOf(await clear([range(1, 0, 2, 1)], "contents"))
		expect(tileEntry(await firstTile(session, one), 1, 0)?.text ?? "").toBe("")
		expect(tileEntry(await firstTile(session, one), 0, 0)?.text).toBe("K")
		session.close()

		const plain = await openFixture(SHARED)

		changeOf(await plain.session.command({ type: "cells.clear", sheet: plain.info.sheets[0]!.id, ranges: [range(0, 0)], what: "all" }))
		plain.session.close()
	})
})

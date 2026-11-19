import { describe, expect, it } from "vitest"
import type { SheetCommandResult, SheetSessionApi } from "../core/sheet/protocol"
import { parts, type Fixture, type FixtureSheet } from "./xlsxWriteFixtures"
import { firstTile, openFixture, savedBytes, tileEntry, changeOf } from "./sheetSessionFixtures"
import { TYPES, relationship } from "./xlsxRefsFixtures"

// Rows and columns inserted and deleted, and sheets renamed, by the session's basic structure path: what moves
// with them, and the typed refusal for what it cannot move.

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const VML_TYPE = TYPES.vml

function refusal(result: SheetCommandResult): { reason: string; detail?: string } | null {
	return result.ok ? null : result.refusal
}

const ONE: FixtureSheet = { name: "One", body: '<sheetData><row r="5"><c r="A5"><v>3</v></c></row></sheetData>' }

function table(formula: string): string {
	return (
		`${DECLARATION}<table xmlns="${MAIN}" id="1" name="T" displayName="T" ref="A1:B2"><autoFilter ref="A1:B2"/>` +
		'<tableColumns count="2"><tableColumn id="1" name="K"/><tableColumn id="2" name="V">' +
		`<calculatedColumnFormula>${formula}</calculatedColumnFormula></tableColumn></tableColumns>` +
		'<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>'
	)
}

function tableFixture(formula: string): Fixture {
	return {
		sheets: [
			ONE,
			{
				name: "Two",
				body:
					'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>K</t></is></c><c r="B1" t="inlineStr"><is><t>V</t></is></c></row>' +
					`<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f>${formula}</f><v>6</v></c></row></sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts>`,
				rels: relationship("rId1", "table", "../tables/table1.xml")
			}
		],
		parts: { "xl/tables/table1.xml": { text: table(formula), type: TYPES.table } }
	}
}

const VML =
	`${DECLARATION}<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">` +
	'<v:shape id="_x0000_s1025" type="#_x0000_t201"><x:ClientData ObjectType="Checkbox"><x:Anchor>1, 0, 1, 0, 2, 0, 2, 0</x:Anchor>' +
	"<x:FmlaLink>One!$A$5</x:FmlaLink></x:ClientData></v:shape></xml>"

const CONTROL = `${DECLARATION}<formControlPr xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" objectType="CheckBox" fmlaLink="One!$A$5"/>`

const CONNECTIONS =
	`${DECLARATION}<connections xmlns="${MAIN}"><connection id="1" name="c" type="4"><webPr url="x"/><parameters count="1">` +
	'<parameter name="p" parameterType="cell" cell="One!$A$5"/></parameters></connection></connections>'

const VOLATILE = `${DECLARATION}<volTypes xmlns="${MAIN}"><volType type="realTimeData"><main first="s"><tp><v>1</v><stp>x</stp><tr r="A5" s="1"/></tp></main></volType></volTypes>`

async function insertRow(fixture: Fixture, sheet = 0): Promise<{ result: SheetCommandResult; session: SheetSessionApi }> {
	const { session, info } = await openFixture(fixture)
	const result = await session.command({ type: "axis.insert", sheet: info.sheets[sheet]!.id, axis: "rows", at: 0, count: 1 })

	return { result, session }
}

async function renameOne(fixture: Fixture): Promise<{ result: SheetCommandResult; session: SheetSessionApi }> {
	const { session, info } = await openFixture(fixture)
	const result = await session.command({ type: "sheet.rename", sheet: info.sheets[0]!.id, name: "Main" })

	return { result, session }
}

describe("sheet session: rows and columns inserted at the sheet's edge", () => {
	it("refuses an insert that would push a row's cells off the sheet, and keeps them", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="A1048576"><v>42</v></c></row></sheetData>'
				}
			]
		})
		const one = info.sheets[0]!.id
		const result = await session.command({ type: "axis.insert", sheet: one, axis: "rows", at: 0, count: 1 })

		expect(refusal(result)).toEqual({ reason: "tooLarge", detail: "cells" })
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('<c r="A1048576"><v>42</v></c>')
		session.close()
	})

	it("refuses an insert that would push a column's cells off the sheet", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>42</v></c></row></sheetData>' }]
		})
		const result = await session.command({ type: "axis.insert", sheet: info.sheets[0]!.id, axis: "cols", at: 0, count: 1 })

		expect(refusal(result)).toEqual({ reason: "tooLarge", detail: "cells" })
		session.close()
	})

	it("inserts up to the last row the cells can move to", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: '<sheetData><row r="1048570"><c r="A1048570"><v>42</v></c></row></sheetData>' }]
		})

		changeOf(await session.command({ type: "axis.insert", sheet: info.sheets[0]!.id, axis: "rows", at: 0, count: 6 }))
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('<c r="A1048576"><v>42</v></c>')
		session.close()
	})
})

describe("sheet session: formulas moved with rows", () => {
	it("keeps a LET parameter with non-ASCII letters whole when a row above goes", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="3"><c r="A3"><f>_xlfn.LET(_xlpm.größe1,5,_xlpm.größe1*2)</f><v>10</v></c></row></sheetData>'
				}
			]
		})

		changeOf(await session.command({ type: "axis.delete", sheet: info.sheets[0]!.id, axis: "rows", at: 0, count: 1 }))
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain("<f>_xlfn.LET(_xlpm.größe1,5,_xlpm.größe1*2)</f>")
		session.close()
	})
})

describe("sheet session: what refers to the edited sheet moves with its rows", () => {
	it("moves a table's calculated formula on another sheet that reads the edited sheet", async () => {
		const { result, session } = await insertRow(tableFixture("One!$A$5*2"))

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/tables/table1.xml"]).toContain(
			"<calculatedColumnFormula>One!$A$6*2</calculatedColumnFormula>"
		)
		session.close()
	})

	it("moves rows under a table on another sheet that does not name the edited sheet", async () => {
		const { result, session } = await insertRow(tableFixture("A2*2"))

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('<c r="A6"><v>3</v></c>')
		session.close()
	})

	it("moves a legacy form control's link on another sheet", async () => {
		const { result, session } = await insertRow({
			sheets: [
				ONE,
				{
					name: "Two",
					body: '<sheetData/><legacyDrawing r:id="rId1"/>',
					rels: relationship("rId1", "vmlDrawing", "../drawings/vmlDrawing1.vml")
				}
			],
			parts: { "xl/drawings/vmlDrawing1.vml": { text: VML, type: VML_TYPE } }
		})

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/drawings/vmlDrawing1.vml"]).toContain("<x:FmlaLink>One!$A$6</x:FmlaLink>")
		session.close()
	})

	it("moves form control properties' links on another sheet", async () => {
		const { result, session } = await insertRow({
			sheets: [ONE, { name: "Two", body: "<sheetData/>", rels: relationship("rId1", "ctrlProp", "../ctrlProps/ctrlProp1.xml") }],
			parts: { "xl/ctrlProps/ctrlProp1.xml": { text: CONTROL, type: TYPES.controlProperties } }
		})

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/ctrlProps/ctrlProp1.xml"]).toContain('fmlaLink="One!$A$6"')
		session.close()
	})

	it("moves a data consolidation's source on another sheet", async () => {
		const { result, session } = await insertRow({
			sheets: [
				ONE,
				{
					name: "Two",
					body: '<sheetData/><dataConsolidate><dataRefs count="1"><dataRef ref="A1:A5" sheet="One"/></dataRefs></dataConsolidate>'
				}
			]
		})

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/worksheets/sheet2.xml"]).toContain('<dataRef ref="A2:A6" sheet="One"/>')
		session.close()
	})

	it("moves a connection parameter bound to a cell of the edited sheet", async () => {
		const { result, session } = await insertRow({
			sheets: [ONE],
			parts: { "xl/connections.xml": { text: CONNECTIONS, type: TYPES.connections } }
		})

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/connections.xml"]).toContain('cell="One!$A$6"')
		session.close()
	})

	it("moves a web publishing object's source", async () => {
		const { result, session } = await insertRow({
			sheets: [ONE],
			workbookTail:
				'<webPublishObjects count="1"><webPublishObject id="1" divId="d" sourceObject="One!A1:A5" destinationFile="x.htm"/></webPublishObjects>'
		})

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toContain('sourceObject="One!A2:A6"')
		session.close()
	})

	it("moves real-time data's cells on the sheet they name by position", async () => {
		const { result, session } = await insertRow({
			sheets: [ONE],
			parts: { "xl/volatileDependencies.xml": { text: VOLATILE, type: TYPES.volatile } }
		})

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/volatileDependencies.xml"]).toContain('<tr r="A6" s="1"/>')
		session.close()
	})

	it("moves the edited sheet's threaded comments with their cells", async () => {
		const { result, session } = await insertRow({
			sheets: [{ ...ONE, rels: relationship("rId1", "threadedComment", "../threadedComments/threadedComment1.xml") }],
			parts: {
				"xl/threadedComments/threadedComment1.xml": {
					text: `${DECLARATION}<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A5" dT="2020-01-01T00:00:00.00" personId="{0}" id="{1}"><text>x</text></threadedComment></ThreadedComments>`,
					type: TYPES.threaded
				}
			}
		})

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/threadedComments/threadedComment1.xml"]).toContain('ref="A6"')
		session.close()
	})

	it("finds a sheet name written with an entity or a doubled apostrophe", async () => {
		const fixture = (sheet: string, formula: string): Fixture => ({
			sheets: [{ ...ONE, name: sheet }],
			parts: { "xl/connections.xml": { text: CONNECTIONS.replace("One!$A$5", formula), type: TYPES.connections } }
		})
		const escaped = await insertRow(fixture("R&amp;D", "'R&amp;D'!$A$5"))
		const quoted = await insertRow(fixture("Bob's", "'Bob''s'!$A$5"))

		changeOf(escaped.result)
		changeOf(quoted.result)
		expect(parts(await savedBytes(escaped.session))["xl/connections.xml"]).toContain("$A$6")
		expect(parts(await savedBytes(quoted.session))["xl/connections.xml"]).toContain("&apos;Bob&apos;&apos;s&apos;!$A$6")
		escaped.session.close()
		quoted.session.close()
	})

	it("moves rows in a workbook with children of newer schemas that do not name the sheet", async () => {
		const { result, session } = await insertRow({
			sheets: [ONE],
			workbookTail:
				'<extLst><ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><x15:workbookPr chartTrackingRefBase="1"/></ext></extLst>'
		})

		changeOf(result)
		session.close()
	})

	it("moves rows in a workbook whose saved path names the sheet's name", async () => {
		const { result, session } = await insertRow({
			sheets: [ONE],
			workbookTail:
				'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15"><x15ac:absPath xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" url="C:\\One!\\"/></mc:Choice></mc:AlternateContent>'
		})

		changeOf(result)
		session.close()
	})

	// Excel 365's usual workbook extensions, whose feature names, GUIDs and attributes hold sheet names as plain text.
	const EXCEL_EXTENSIONS =
		'<extLst><ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><x15:workbookPr chartTrackingRefBase="1"/></ext>' +
		'<ext uri="{B58B0392-4F1F-4190-BB64-5DF3571DCE5F}" xmlns:xcalcf="http://schemas.microsoft.com/office/spreadsheetml/2018/calcfeatures"><xcalcf:calcFeatures><xcalcf:feature name="microsoft.com:RD"/><xcalcf:feature name="microsoft.com:Single"/><xcalcf:feature name="microsoft.com:FV"/><xcalcf:feature name="microsoft.com:CNMTM"/><xcalcf:feature name="microsoft.com:LET_WF"/></xcalcf:calcFeatures></ext></extLst>'

	for (const name of ["A", "B5", "Calc", "Single", "FV", "Flags"]) {
		it(`edits a sheet named ${name} whose name the workbook's extensions write as plain text`, async () => {
			const fixture = {
				sheets: [{ ...ONE, name }],
				workbookTail:
					'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="mx"><mx:ArchID xmlns:mx="http://schemas.microsoft.com/office/mac/excel/2008/main" Flags="2"/></mc:Choice></mc:AlternateContent>' +
					'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15"><x15ac:absPath xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" url="/Users/a/"/></mc:Choice></mc:AlternateContent>' +
					EXCEL_EXTENSIONS
			}
			const inserted = await insertRow(fixture)

			changeOf(inserted.result)
			inserted.session.close()

			const renamed = await renameOne(fixture)

			changeOf(renamed.result)
			renamed.session.close()
		})
	}

	it("refuses when a later alternate content child of the workbook refers to the edited sheet", async () => {
		const alternate = (inner: string): string =>
			`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15">${inner}</mc:Choice></mc:AlternateContent>`
		const { result, session } = await insertRow({
			sheets: [ONE],
			workbookTail:
				alternate('<x15ac:absPath xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" url="/Users/a/"/>') +
				alternate('<x:ref xmlns:x="urn:x">One!A5</x:ref>')
		})

		expect(refusal(result)).toEqual({ reason: "structureLocked", detail: "workbook mc:AlternateContent" })
		session.close()
	})

	for (const reference of ["One!$A$5", "'One'!$A$5", "&apos;One&apos;!A5", "Two:One!A5", "'Two:One'!A5", "One:Two!A5"]) {
		it(`refuses when a workbook extension refers to the edited sheet: ${reference}`, async () => {
			const { result, session } = await insertRow({
				sheets: [ONE, { name: "Two", body: "<sheetData/>" }],
				workbookTail: `<extLst><ext uri="{X}" xmlns:x="urn:x"><x:ref>${reference}</x:ref></ext></extLst>`
			})

			expect(refusal(result)).toEqual({ reason: "structureLocked", detail: "workbook extLst" })
			session.close()
		})
	}

	it("refuses to delete or move sheets past a 3-D span a workbook extension holds", async () => {
		const fixture = {
			sheets: [ONE, { name: "Two", body: "<sheetData/>" }, { name: "Three", body: "<sheetData/>" }],
			workbookTail: '<extLst><ext uri="{X}" xmlns:x="urn:x"><x:ref>One:Two!A5</x:ref></ext></extLst>'
		}
		const opened = await openFixture(fixture)

		expect(refusal(await opened.session.command({ type: "sheet.move", sheet: opened.info.sheets[2]!.id, to: 0 }))).toEqual({
			reason: "structureLocked",
			detail: "workbook extLst"
		})
		expect(refusal(await opened.session.command({ type: "sheet.delete", sheet: opened.info.sheets[2]!.id }))).toEqual({
			reason: "structureLocked",
			detail: "workbook extLst"
		})
		changeOf(await opened.session.command({ type: "axis.insert", sheet: opened.info.sheets[2]!.id, axis: "rows", at: 0, count: 1 }))
		opened.session.close()
	})

	it("refuses when a workbook extension names the edited sheet", async () => {
		const { result, session } = await insertRow({
			sheets: [ONE],
			workbookTail: '<extLst><ext uri="{X}" xmlns:x="urn:x"><x:ref>One!$A$5</x:ref></ext></extLst>'
		})

		expect(refusal(result)).toEqual({ reason: "structureLocked", detail: "workbook extLst" })
		session.close()
	})

	it("refuses an edit an undo could not take back exactly: a pivot table's range cut through", async () => {
		const pivot = `${DECLARATION}<pivotTableDefinition xmlns="${MAIN}" name="P" cacheId="1" dataCaption="Values"><location ref="A3:B6" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/></pivotTableDefinition>`
		const { session, info } = await openFixture({
			sheets: [{ ...ONE, rels: relationship("rId1", "pivotTable", "../pivotTables/pivotTable1.xml") }],
			parts: { "xl/pivotTables/pivotTable1.xml": { text: pivot, type: TYPES.pivotTable } }
		})
		const result = await session.command({ type: "axis.delete", sheet: info.sheets[0]!.id, axis: "rows", at: 3, count: 1 })

		expect(refusal(result)?.reason).toBe("pivot")
		session.close()
	})
})

describe("sheet session: sheets renamed", () => {
	it("keeps a defined name's other attributes when the rename rewrites its formula", async () => {
		const { result, session } = await renameOne({
			sheets: [ONE],
			workbookTail:
				'<definedNames><definedName name="Total" comment="the total" description="sum of the column" function="1" vbProcedure="1" shortcutKey="t">One!$A$5</definedName></definedNames>'
		})

		changeOf(result)

		const workbook = parts(await savedBytes(session))["xl/workbook.xml"] ?? ""

		expect(workbook).toContain(
			'<definedName name="Total" comment="the total" description="sum of the column" function="1" vbProcedure="1" shortcutKey="t">Main!$A$5</definedName>'
		)
		session.close()
	})

	it("renames a sheet a defined name names, and its undo writes the name as it was", async () => {
		const { session, info, bytes } = await openFixture({
			sheets: [ONE, { name: "Two", body: '<sheetData><row r="1"><c r="A1"><f>One!A5+1</f><v>4</v></c></row></sheetData>' }],
			workbookTail: '<definedNames><definedName name="Total" comment="c">\'One\'!$A$5</definedName></definedNames>'
		})

		changeOf(await session.command({ type: "sheet.rename", sheet: info.sheets[0]!.id, name: "My Main" }))
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toContain(
			'<definedName name="Total" comment="c">\'My Main\'!$A$5</definedName>'
		)
		expect(tileEntry(await firstTile(session, info.sheets[1]!.id), 0, 0)?.input).toBe("='My Main'!A5+1")
		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toBe(parts(bytes)["xl/workbook.xml"])
		session.close()
	})

	it("renames the sheet in a legacy form control's link", async () => {
		const { result, session } = await renameOne({
			sheets: [
				ONE,
				{
					name: "Two",
					body: '<sheetData/><legacyDrawing r:id="rId1"/>',
					rels: relationship("rId1", "vmlDrawing", "../drawings/vmlDrawing1.vml")
				}
			],
			parts: { "xl/drawings/vmlDrawing1.vml": { text: VML, type: VML_TYPE } }
		})

		changeOf(result)
		expect(parts(await savedBytes(session))["xl/drawings/vmlDrawing1.vml"]).toContain("<x:FmlaLink>Main!$A$5</x:FmlaLink>")
		session.close()
	})

	it("renames the sheet in a connection and a data consolidation", async () => {
		const connection = await renameOne({
			sheets: [ONE],
			parts: { "xl/connections.xml": { text: CONNECTIONS, type: TYPES.connections } }
		})
		const consolidation = await renameOne({
			sheets: [
				ONE,
				{
					name: "Two",
					body: '<sheetData/><dataConsolidate><dataRefs count="1"><dataRef ref="A1:A5" sheet="One"/></dataRefs></dataConsolidate>'
				}
			]
		})

		changeOf(connection.result)
		changeOf(consolidation.result)
		expect(parts(await savedBytes(connection.session))["xl/connections.xml"]).toContain('cell="Main!$A$5"')
		expect(parts(await savedBytes(consolidation.session))["xl/worksheets/sheet2.xml"]).toContain('sheet="Main"')
		connection.session.close()
		consolidation.session.close()
	})
})

describe("sheet session: structure edits undone", () => {
	// A dimension smaller than the cells (a cell whose reference does not read takes the next column).
	const SHORT_DIMENSION: FixtureSheet = {
		name: "One",
		body: '<dimension ref="A1"/><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B"><v>2</v></c></row></sheetData>'
	}

	for (const [axis, at] of [
		["cols", 1],
		["cols", 0],
		["rows", 0],
		["rows", 3]
	] as const) {
		it(`saves the source again after ${axis} inserted at ${String(at)} are undone, its dimension as written`, async () => {
			const { session, info, bytes } = await openFixture({ sheets: [SHORT_DIMENSION] })

			changeOf(await session.command({ type: "axis.insert", sheet: info.sheets[0]!.id, axis, at, count: 1 }))
			changeOf(await session.undo())

			expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
			session.close()
		})
	}
})

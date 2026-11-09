import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openOds } from "../core/ods/open"
import { HeldResult } from "../core/sheet/formula/formulaEngine"
import { cellKeyOf } from "../core/xlsx/edit/history"
import { CellKind, FormulaKind, RowFlag, type XlsxSheetModel } from "../core/xlsx/model/types"
import { AxisFlag } from "../core/sheet/protocol"
import type { SheetStore } from "../core/xlsx/model/store"
import { encryptedEntry, odsBytes, odsDocument, openOdsFixture, shownRows, table } from "./odsFixtures"
import { buildZip, text } from "./zipBuilder"
import { budget, cpuMs } from "./timing"

// The OpenDocument spreadsheet reader: content.xml streamed into the xlsx sheet model, repeats never expanded where
// only formats repeat, values and texts as ODF 1.3 Part 3 §19 writes them.

function model(result: Awaited<ReturnType<typeof openOdsFixture>>, index = 0): XlsxSheetModel {
	const entry = result.workbook.sheets[index]

	if (entry?.model === null || entry === undefined) throw new Error("not loaded")

	return entry.model
}

function cell(sheet: XlsxSheetModel, row: number, col: number): { kind: number; value: number; formula: string } | null {
	const store = sheet.store as SheetStore
	const slot = store.locate(row, col)

	if (slot < 0) return null

	const formula = store.formula(slot)

	return { kind: store.kind(slot), value: store.value(slot), formula: formula < 0 ? "" : store.formulas.text(formula) }
}

const CELL = (attributes: string, paragraph = ""): string =>
	`<table:table-cell ${attributes}>${paragraph === "" ? "" : `<text:p>${paragraph}</text:p>`}</table:table-cell>`

describe("the ODS reader", () => {
	it("reads every value type with its value and shows each as LibreOffice does", async () => {
		const result = await openOdsFixture({
			body: table(
				"Values",
				"<table:table-row>" +
					CELL('office:value-type="float" office:value="1.5"', "1.5") +
					CELL('office:value-type="percentage" office:value="0.25"', "25%") +
					CELL('office:value-type="currency" office:currency="EUR" office:value="3"', "3 €") +
					CELL('office:value-type="date" office:date-value="2023-06-30"', "2023-06-30") +
					CELL('office:value-type="date" office:date-value="1900-01-01T12:00:00"', "x") +
					CELL('office:value-type="time" office:time-value="PT36H30M00S"', "36:30") +
					CELL('office:value-type="boolean" office:boolean-value="true"', "TRUE") +
					CELL('office:value-type="string" office:string-value="from attribute"', "ignored") +
					CELL('office:value-type="string"', "a &amp; b") +
					CELL("", "no type") +
					"</table:table-row>"
			)
		})
		const sheet = model(result)

		expect(cell(sheet, 0, 0)).toEqual({ kind: CellKind.NUMBER, value: 1.5, formula: "" })
		expect(cell(sheet, 0, 1)?.value).toBe(0.25)
		// Days since the null date 1899-12-30: 45107 is 2023-06-30 in both LibreOffice and Excel.
		expect(cell(sheet, 0, 3)?.value).toBe(45107)
		expect(cell(sheet, 0, 4)?.value).toBe(2.5)
		expect(cell(sheet, 0, 5)?.value).toBeCloseTo(1.5208333333, 9)
		expect(cell(sheet, 0, 6)).toEqual({ kind: CellKind.BOOLEAN, value: 1, formula: "" })
		// Without a data style a typed value shows in its type's standard format (LibreOffice's ScXMLImport::SetType):
		// a date with a time part as date and time, a time-value as elapsed hours.
		expect(shownRows(odsDocument(result), 0)).toEqual([
			["1.5", "25%", "€3.00", "6/30/2023", "1/1/1900 12:00", "36:30:00", "TRUE", "from attribute", "a & b", "no type"]
		])
	})

	it("keeps a typed value's own data style and shares one derived format among cells of a type", async () => {
		const result = await openOdsFixture({
			automatic:
				'<number:number-style style:name="N2"><number:number number:decimal-places="2" number:min-integer-digits="1"/></number:number-style>' +
				'<style:style style:name="fixed" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N2"/>' +
				'<style:style style:name="fill" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ffff00"/></style:style>',
			body: table(
				"S",
				'<table:table-row table:number-rows-repeated="3">' +
					CELL('table:style-name="fixed" office:value-type="percentage" office:value="0.25"') +
					CELL('table:style-name="fill" office:value-type="percentage" office:value="0.5"') +
					CELL('office:value-type="currency" office:value="-3.5"') +
					CELL('office:value-type="currency" office:currency="GBP" office:value="2"') +
					CELL('office:value-type="float" office:value="0.5"') +
					CELL('office:value-type="time" office:time-value="PT1H"') +
					"</table:table-row>"
			)
		})
		const sheet = model(result)
		const store = sheet.store as SheetStore
		const xfs = result.workbook.styles.cellXfs

		expect(shownRows(odsDocument(result), 0)).toEqual([
			["0.25", "50%", "($3.50)", "£2.00", "0.5", "1:00:00"],
			["0.25", "50%", "($3.50)", "£2.00", "0.5", "1:00:00"],
			["0.25", "50%", "($3.50)", "£2.00", "0.5", "1:00:00"]
		])

		// The filled cell keeps its fill under the percent format, one record for all its rows.
		const filled = store.style(store.locate(0, 1))

		expect(xfs[filled]?.fillId).toBeGreaterThan(0)
		expect(store.style(store.locate(2, 1))).toBe(filled)
		expect(store.style(store.locate(0, 4))).toBe(0)
	})

	it("reads the 1904 null date as Excel's 1904 date system", async () => {
		const result = await openOdsFixture({
			body:
				'<table:calculation-settings><table:null-date table:date-value="1904-01-01"/></table:calculation-settings>' +
				table("S", `<table:table-row>${CELL('office:value-type="date" office:date-value="1904-01-02"')}</table:table-row>`)
		})

		expect(result.workbook.date1904).toBe(true)
		expect(cell(model(result), 0, 0)?.value).toBe(1)
	})

	it("collapses paragraph white space and joins paragraphs with line ends (ODF 1.3 Part 3 §6.1.2)", async () => {
		const result = await openOdsFixture({
			body: table(
				"S",
				"<table:table-row>" +
					CELL('office:value-type="string"', "  a \n\t b  ") +
					'<table:table-cell office:value-type="string"><text:p>one<text:s text:c="3"/>two<text:tab/>x</text:p><text:p>second<text:line-break/>line</text:p></table:table-cell>' +
					"</table:table-row>"
			)
		})

		expect(shownRows(odsDocument(result), 0)).toEqual([["a b", "one   two\tx\nsecond\nline"]])
	})

	it("keeps repeats of formats as runs, never one cell each, and shows them in tiles and starting formats", async () => {
		const result = await openOdsFixture({
			automatic:
				'<style:style style:name="fill" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ffff00"/></style:style>',
			body: table(
				"S",
				'<table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="5" table:style-name="fill"/><table:table-cell table:number-columns-repeated="16379"/></table:table-row>' +
					`<table:table-row>${CELL('office:value-type="float" office:value="7"', "7")}</table:table-row>`
			)
		})
		const sheet = model(result)
		const store = sheet.store as SheetStore
		const document = odsDocument(result)
		const filled = document.startingStyle(sheet, 500_000, 4)

		expect(store.cellCount).toBe(1)
		expect(sheet.styleRuns?.rowExtent).toBe(1_048_575)
		expect(filled).toBeGreaterThan(0)
		expect(result.workbook.styles.fills[result.workbook.styles.cellXfs[filled]?.fillId ?? 0]).toMatchObject({ pattern: "solid" })
		expect(document.startingStyle(sheet, 500_000, 5)).toBe(0)
		expect(cell(sheet, 1_048_575, 0)?.value).toBe(7)

		const entries: { row: number; col: number }[] = []

		document.fillTile(0, 0, 0, {
			add: (row, col) => entries.push({ row, col }) - 1,
			repeat: () => undefined,
			runs: () => undefined
		})

		expect(entries.filter(entry => entry.row === 0).map(entry => entry.col)).toEqual([0, 1, 2, 3, 4])
	})

	it("reads the largest repeats in a few milliseconds", async () => {
		const bytes = odsBytes({
			body: table(
				"S",
				'<table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>',
				'<table:table-column table:number-columns-repeated="16384"/>'
			)
		})
		const started = cpuMs()
		const result = await openOds(bytesSource(bytes))

		expect(cpuMs() - started).toBeLessThan(budget(50))
		expect(result.ok && result.workbook.sheets[0]?.model?.store.cellCount).toBe(0)
	})

	it("materialises a repeated content cell per copy and names what a cap leaves out", async () => {
		const result = await openOdsFixture({
			body: table(
				"S",
				`<table:table-row table:number-rows-repeated="3">${CELL('office:value-type="float" office:value="2" table:number-columns-repeated="2"', "2")}</table:table-row>`
			)
		})

		expect(shownRows(odsDocument(result), 0)).toEqual([
			["2", "2"],
			["2", "2"],
			["2", "2"]
		])
	})

	it("reads spans as merges and keeps a covered cell's content", async () => {
		const result = await openOdsFixture({
			body: table(
				"S",
				`<table:table-row>${CELL('office:value-type="string" table:number-columns-spanned="2" table:number-rows-spanned="2"', "big")}<table:covered-table-cell office:value-type="float" office:value="4"><text:p>4</text:p></table:covered-table-cell></table:table-row>` +
					'<table:table-row><table:covered-table-cell table:number-columns-repeated="2"/></table:table-row>'
			)
		})
		const sheet = model(result)

		expect([...sheet.merges]).toEqual([0, 0, 1, 1])
		expect(cell(sheet, 0, 1)?.value).toBe(4)
	})

	it("translates formulas and keeps the cached result; a matrix is an array formula over its span", async () => {
		const result = await openOdsFixture({
			body:
				table(
					"One",
					"<table:table-row>" +
						CELL('office:value-type="float" office:value="1"', "1") +
						CELL('table:formula="of:=SUM([.A1];[\'Two 2\'.A1:.B2])*2" office:value-type="float" office:value="12"', "12") +
						CELL(
							'table:formula="of:=COM.MICROSOFT.IFS([.A1]=1;&quot;x&quot;)" office:value-type="string" office:string-value="x"',
							"x"
						) +
						CELL('table:formula="of:=ORG.OPENOFFICE.STYLE(&quot;a&quot;)" office:value-type="float" office:value="0"', "0") +
						CELL(
							'table:formula="of:=TRANSPOSE({1;2|3;4})" table:number-matrix-columns-spanned="2" table:number-matrix-rows-spanned="2" office:value-type="float" office:value="1"',
							"1"
						) +
						"</table:table-row>"
				) + table("Two 2", `<table:table-row>${CELL('office:value-type="float" office:value="5"', "5")}</table:table-row>`)
		})
		const sheet = model(result)
		const store = sheet.store as SheetStore

		expect(cell(sheet, 0, 1)).toEqual({ kind: CellKind.NUMBER, value: 12, formula: "SUM(A1,'Two 2'!A1:B2)*2" })
		expect(cell(sheet, 0, 2)?.formula).toBe('_xlfn.IFS(A1=1,"x")')
		// No Excel equivalent: the cached result stays, the reason is named.
		expect(cell(sheet, 0, 3)).toEqual({ kind: CellKind.NUMBER, value: 0, formula: "" })
		expect(result.issues).toContainEqual({ kind: "formula", sheet: "One", detail: "function ORG.OPENOFFICE.STYLE", count: 1 })

		const matrix = store.formula(store.locate(0, 4))

		expect(store.formulas.kind(matrix)).toBe(FormulaKind.ARRAY)
		expect(store.formulas.formula(matrix).ref).toEqual({ startRow: 0, startCol: 4, endRow: 1, endCol: 5 })
		expect(store.formulas.text(matrix)).toBe("TRANSPOSE({1,2;3,4})")
	})

	it("reads an error result, written as an error type or as a number with its error text", async () => {
		const result = await openOdsFixture({
			body: table(
				"S",
				"<table:table-row>" +
					CELL(
						'table:formula="of:=1/0" office:value-type="string" office:string-value="" calcext:value-type="error"',
						"#DIV/0!"
					) +
					CELL('table:formula="of:=[.Z9]" office:value-type="float" office:value="0"', "Err:502") +
					"</table:table-row>"
			)
		})

		expect(cell(model(result), 0, 0)?.kind).toBe(CellKind.ERROR)
		expect(shownRows(odsDocument(result), 0)).toEqual([["#DIV/0!", "Err:502"]])
	})

	it("recalculates on load what LibreOffice recalculates: a volatile formula, and a number written with an error's text", async () => {
		const result = await openOdsFixture({
			body: table(
				"S",
				"<table:table-row>" +
					CELL('table:formula="of:=INDIRECT(&quot;FOO&quot;)" office:value-type="float" office:value="4"', "4") +
					CELL('table:formula="of:=[.C1]*2" office:value-type="float" office:value="0"', "Err:502") +
					CELL('office:value-type="float" office:value="3"', "3") +
					CELL('table:formula="of:=[.C1]+1" office:value-type="float" office:value="9"', "9") +
					"</table:table-row>"
			)
		})
		const sheet = model(result)
		const document = odsDocument(result)

		expect([...(sheet.recalculate ?? [])].sort((a, b) => a - b)).toEqual([cellKeyOf(0, 0), cellKeyOf(0, 1)])
		expect(document.needsPreparing(false)).toBe(true)

		document.buildEngine()

		// What is not recalculated keeps the file's result, however stale.
		expect(shownRows(document, 0)).toEqual([["#REF!", "6", "3", "9"]])
		document.dropEngine()
	})

	it("reads LibreOffice's Calc A1 text in INDIRECT, its default reference syntax", async () => {
		const result = await openOdsFixture({
			body: table(
				"S",
				"<table:table-row>" +
					CELL('table:formula="of:=INDIRECT(&quot;S.C1&quot;)" office:value-type="float" office:value="4"', "4") +
					CELL('table:formula="of:=INDIRECT(&quot;$S.$C$1&quot;)" office:value-type="float" office:value="4"', "4") +
					CELL('office:value-type="float" office:value="3"', "3") +
					"</table:table-row>"
			)
		})
		const document = odsDocument(result)

		document.buildEngine()
		expect(shownRows(document, 0)).toEqual([["3", "3", "3"]])
		document.dropEngine()
	})

	it("reads column widths and row heights as lengths, the commonest as the defaults", async () => {
		const result = await openOdsFixture({
			automatic:
				'<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="1in"/></style:style>' +
				'<style:style style:name="co2" style:family="table-column"><style:table-column-properties style:column-width="2in"/></style:style>' +
				'<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="0.25in"/></style:style>' +
				'<style:style style:name="ro2" style:family="table-row"><style:table-row-properties style:row-height="0.5in" style:use-optimal-row-height="false"/></style:style>',
			body: table(
				"S",
				`<table:table-row table:style-name="ro2">${CELL('office:value-type="float" office:value="1"', "1")}</table:table-row>` +
					'<table:table-row table:style-name="ro1" table:number-rows-repeated="1000"><table:table-cell/></table:table-row>' +
					'<table:table-row table:style-name="ro1" table:visibility="collapse"><table:table-cell/></table:table-row>',
				'<table:table-column table:style-name="co2"/><table:table-column table:style-name="co1" table:number-columns-repeated="1023" table:visibility="collapse"/>'
			)
		})
		const document = odsDocument(result)
		const layout = document.layout(0)

		expect(layout.rows.defaultSize).toBe(24)
		expect(layout.cols.defaultSize).toBe(96)
		expect(layout.cols.sizes[0]).toBe(192)
		expect([...layout.rows.indices]).toEqual([0, 1001])
		expect(layout.rows.sizes[0]).toBe(48)

		// The hidden row holds no cell: a run beside the store, not a row in it.
		expect(model(result).rowRuns).toEqual([{ first: 1001, last: 1001, flags: RowFlag.HIDDEN, heightPt: 18 }])
		expect(((layout.rows.flags[1] ?? 0) & AxisFlag.HIDDEN) !== 0).toBe(true)
	})

	it("shows an edit cell's text as written and a plain one through the format's text section", async () => {
		const result = await openOdsFixture({
			styles:
				'<style:style style:name="Default" style:family="table-cell"/>' +
				'<number:text-style style:name="T1"><number:text>[</number:text><number:text-content/><number:text>]</number:text></number:text-style>' +
				'<style:style style:name="boxed" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="T1"/>',
			automatic: '<style:style style:name="bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>',
			body: table(
				"S",
				"<table:table-row>" +
					CELL('office:value-type="string" table:style-name="boxed"', "plain") +
					CELL('office:value-type="string" table:style-name="boxed"', 'a<text:span text:style-name="bold">b</text:span>') +
					"</table:table-row>"
			)
		})
		const document = odsDocument(result)

		expect(shownRows(document, 0)).toEqual([["[plain]", "ab"]])

		const runs = document.richRuns(
			model(result).store.locate(0, 1) >= 0
				? (model(result).store as SheetStore).value((model(result).store as SheetStore).locate(0, 1))
				: -1,
			0,
			-1
		)

		expect(runs?.starts).toEqual([0, 1])
	})

	it("hides a hidden-and-protected cell's content on a protected sheet (ODF 1.3 Part 3 §20.189)", async () => {
		const result = await openOdsFixture({
			automatic:
				'<style:style style:name="hide" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties style:cell-protect="hidden-and-protected"/></style:style>',
			body: table(
				"S",
				`<table:table-row>${CELL('office:value-type="string" table:style-name="hide"', "secret")}${CELL('office:value-type="string"', "shown")}</table:table-row>`,
				"",
				' table:protected="true"'
			)
		})

		expect(shownRows(odsDocument(result), 0)).toEqual([["", "shown"]])
		expect(model(result).protection?.allows.has("selectLockedCells")).toBe(true)
	})

	it("names a cell style's conditions (style:map, before calcext) as not applied", async () => {
		const result = await openOdsFixture({
			styles: '<style:style style:name="Default" style:family="table-cell"/><style:style style:name="Red" style:family="table-cell"><style:table-cell-properties fo:background-color="#ff0000"/></style:style>',
			automatic:
				'<style:style style:name="cond" style:family="table-cell" style:parent-style-name="Default"><style:map style:condition="cell-content()&gt;3" style:apply-style-name="Red" style:base-cell-address="S.A1"/></style:style>',
			body: table(
				"S",
				`<table:table-row>${CELL('office:value-type="float" office:value="5" table:style-name="cond"', "5")}</table:table-row>`
			)
		})

		expect(result.issues).toContainEqual({
			kind: "conditionalFormat",
			sheet: undefined,
			detail: "style:map cell-content()>3",
			count: 1
		})
	})

	it("gives the engine no name over a huge area: a formula reading one keeps its cached result", async () => {
		const result = await openOdsFixture({
			body:
				table(
					"Data",
					`<table:table-row>${CELL('table:formula="of:=ROWS(Huge)" office:value-type="float" office:value="21949"', "21949")}${CELL('table:formula="of:=SUM(Small)" office:value-type="float" office:value="0"', "0")}</table:table-row>`
				) +
				'<table:named-expressions><table:named-range table:name="Huge" table:base-cell-address="$Data.$A$1" table:cell-range-address="$Data.$A$1:.$XFD$21949"/><table:named-range table:name="Small" table:base-cell-address="$Data.$A$1" table:cell-range-address="$Data.$C$1:.$D$2"/></table:named-expressions>'
		})
		const document = odsDocument(result)
		const sheet = model(result)

		document.buildEngine()

		expect(result.workbook.definedNames.map(name => [name.name, name.formula])).toEqual([
			["Huge", "Data!$A$1:$XFD$21949"],
			["Small", "Data!$C$1:$D$2"]
		])
		expect(document.engineCell(sheet, 0, 0).content).toBeInstanceOf(HeldResult)
		expect(document.engine?.result(0, 0, 1).value).toBe(0)
		document.dropEngine()
	})

	it("reads names under any prefix the root binds, and inside an element that binds its own", async () => {
		const namespaces =
			'xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:p="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"'
		const content = `<?xml version="1.0" encoding="UTF-8"?><o:document-content ${namespaces} o:version="1.3"><o:body><o:spreadsheet><t:table t:name="P"><t:table-row><t:table-cell o:value-type="float" o:value="3"><p:p>3</p:p></t:table-cell><x:table-cell xmlns:x="urn:oasis:names:tc:opendocument:xmlns:table:1.0" o:value-type="float" o:value="4"/></t:table-row></t:table></o:spreadsheet></o:body></o:document-content>`
		const manifest =
			'<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>'
		const bytes = buildZip([
			{ name: "mimetype", data: text("application/vnd.oasis.opendocument.spreadsheet"), method: 0 },
			{ name: "content.xml", data: text(content) },
			{ name: "META-INF/manifest.xml", data: text(manifest) }
		])
		const result = await openOds(bytesSource(bytes))

		if (!result.ok) throw new Error(result.message)

		expect(result.workbook.sheets[0]?.name).toBe("P")
		expect(shownRows(odsDocument(result), 0)).toEqual([["3", "4"]])
	})

	it("refuses an encrypted package and a damaged stream with typed reasons, never in part", async () => {
		const encrypted = odsBytes({
			body: table("S", "<table:table-row><table:table-cell/></table:table-row>"),
			manifestEntries: encryptedEntry("settings.xml")
		})
		const damaged = odsBytes({
			body: '<table:table table:name="S"><table:table-row><table:table-cell></table:table-row></table:table>'
		})
		const wrong = odsBytes({ body: table("S", "<table:table-row/>"), mediaType: "application/vnd.oasis.opendocument.text" })
		const opened = await openOds(bytesSource(damaged))
		const text = await openOds(bytesSource(wrong))

		expect(opened.ok ? "opened" : opened.reason).toBe("malformed")
		expect(text.ok ? "opened" : text.reason).toBe("notSpreadsheet")
		const locked = await openOds(bytesSource(encrypted))

		expect(locked.ok ? "opened" : locked.reason).toBe("encrypted")
	})

	it("refuses a workbook holding more cells than the limit as too large", async () => {
		const bytes = odsBytes({
			body: table(
				"S",
				`<table:table-row table:number-rows-repeated="2">${CELL('office:value-type="float" office:value="1" table:number-columns-repeated="2"', "1")}</table:table-row>`
			)
		})
		const result = await openOds(bytesSource(bytes), { readLimits: { maxCells: 3 } })

		expect(result.ok ? "opened" : result.reason).toBe("tooLarge")
		expect((await openOds(bytesSource(bytes), { readLimits: { maxCells: 4 } })).ok).toBe(true)
	})

	it("opens the template media type as a spreadsheet", async () => {
		const result = await openOds(
			bytesSource(
				odsBytes({
					body: table("S", "<table:table-row><table:table-cell/></table:table-row>"),
					mediaType: "application/vnd.oasis.opendocument.spreadsheet-template"
				})
			)
		)

		expect(result.ok).toBe(true)
	})

	it("takes the active sheet, frozen panes, the cursor and the grid from settings.xml", async () => {
		const settings =
			'<config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>' +
			'<config:config-item config:name="ActiveTable" config:type="string">Two</config:config-item>' +
			'<config:config-item-map-named config:name="Tables"><config:config-item-map-entry config:name="Two">' +
			'<config:config-item config:name="CursorPositionX" config:type="int">2</config:config-item><config:config-item config:name="CursorPositionY" config:type="int">5</config:config-item>' +
			'<config:config-item config:name="HorizontalSplitMode" config:type="short">2</config:config-item><config:config-item config:name="VerticalSplitMode" config:type="short">2</config:config-item>' +
			'<config:config-item config:name="HorizontalSplitPosition" config:type="int">1</config:config-item><config:config-item config:name="VerticalSplitPosition" config:type="int">3</config:config-item>' +
			'<config:config-item config:name="PositionRight" config:type="int">1</config:config-item><config:config-item config:name="PositionBottom" config:type="int">3</config:config-item>' +
			'<config:config-item config:name="ZoomValue" config:type="int">150</config:config-item><config:config-item config:name="ShowGrid" config:type="boolean">false</config:config-item>' +
			"</config:config-item-map-entry></config:config-item-map-named></config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set>"
		const result = await openOdsFixture({
			settings,
			body:
				table("One", "<table:table-row><table:table-cell/></table:table-row>") +
				table("Two", "<table:table-row><table:table-cell/></table:table-row>")
		})
		const view = model(result, 1).view

		expect(result.workbook.activeTab).toBe(1)
		expect(view.frozen).toEqual({ rows: 3, cols: 1, topLeftRow: 3, topLeftCol: 1 })
		expect([view.activeRow, view.activeCol, view.zoom, view.gridLines]).toEqual([5, 2, 150, false])
	})
})

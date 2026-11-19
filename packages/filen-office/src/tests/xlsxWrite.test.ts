import { deflateSync, unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { Relationships } from "../core/opc/index"
import { DEFAULT_FORMAT, DEFAULT_VIEW, FormulaTable, SheetStore, SheetStrings } from "../core/xlsx/read/index"
import { CellKind, ColFlag, FormulaKind, RowFlag, XfApply, type XlsxFormula } from "../core/xlsx/model/types"
import { planRefEdit } from "../core/xlsx/refs/index"
import { rootTag } from "../core/xlsx/write/markup"
import { saveXlsx } from "../core/xlsx/write/save"
import { decodeUtf8, encodeUtf8 } from "../core/xml/index"
import { seedImpliedStyles } from "../core/xlsx/write/styles"
import { buildFixture, changedEntries, difference, equalBytes, openWorkbook, parts, R, saved, SML } from "./xlsxWriteFixtures"
import { ZIP_ENTRY_TIME } from "./zipTime"

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${SML}" count="3" uniqueCount="2"><si><t>alpha</t></si><si><t>beta</t></si></sst>`

const ROWS =
	'<sheetData><row r="1" spans="1:3" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1.5</v></c><c r="C1" t="s" ph="1"><v>1</v></c></row>' +
	'<row r="2" spans="1:3" x14ac:dyDescent="0.25"><c r="A2"><f>B1*2</f><v>3</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="s"><v>0</v></c></row>' +
	'<row r="4" spans="1:3" ht="20" customHeight="1" x14ac:dyDescent="0.25"><c r="A4" t="inlineStr"><is><t>inline</t></is></c><c r="C4" t="e"><v>#DIV/0!</v></c></row></sheetData>'

function worksheet(body: string, extra = ""): string {
	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
		`<worksheet xmlns="${SML}" xmlns:r="${R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac"${extra}>` +
		body +
		"</worksheet>"
	)
}

function basic(): Uint8Array {
	return buildFixture({
		sheets: [
			{
				name: "One",
				xml: worksheet(
					`<dimension ref="A1:C4"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/>${ROWS}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`
				)
			},
			{ name: "Two", body: '<sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData>' }
		],
		sharedStrings: SHARED_STRINGS,
		calcChain: true,
		workbookTail: '<calcPr calcId="191029"/>'
	})
}

function formula(text: string, kind: FormulaKind = FormulaKind.NORMAL): XlsxFormula {
	return { kind, text, sharedIndex: -1, ref: null, flags: 0, cellMetadata: -1 }
}

describe("xlsx splice writer", () => {
	it("saves an unedited workbook as its source bytes", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)

		await workbook.load(0)

		expect(equalBytes(await saved(workbook), source)).toBe(true)
	})

	it("rewrites only the edited row, keeping its unchanged cells and unknown attributes as written", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		sheet.store.setCell(0, 1, CellKind.NUMBER, 2.25, 0, -1)
		workbook.changes.sheetRows(0)

		const output = await saved(workbook)
		const before = parts(source)["xl/worksheets/sheet1.xml"] as string
		const after = parts(output)["xl/worksheets/sheet1.xml"] as string
		const diff = difference(before, after)
		const row = before.indexOf('<row r="1"')

		// Only B1's value changed: everything else in the part is its source text.
		expect(diff.from).toBeGreaterThan(row)
		expect(diff.to).toBeLessThan(before.indexOf("</row>", row))
		expect(after).toContain(
			'<row r="1" spans="1:3" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>2.25</v></c><c r="C1" t="s" ph="1"><v>1</v></c></row>'
		)
		expect((await changedEntries(source, output)).changed).toEqual(["xl/worksheets/sheet1.xml"])

		const reopened = await openWorkbook(output)
		const read = await reopened.load(0)
		const slot = read.store.locate(0, 1)

		expect(slot).toBeGreaterThanOrEqual(0)
		expect(read.store.cellCount).toBe(sheet.store.cellCount)
	})

	it("saves an edit and its undo as the source bytes", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		sheet.store.setCell(0, 1, CellKind.NUMBER, 9, 1, -1)
		sheet.store.setCell(0, 1, CellKind.NUMBER, 1.5, 0, -1)
		sheet.store.setRow(3, 30, -1, RowFlag.CUSTOM_HEIGHT)
		sheet.store.setRow(3, 20, -1, RowFlag.CUSTOM_HEIGHT)
		workbook.changes.sheetRows(0)
		workbook.changes.sheetSection(0, "mergeCells")

		expect(equalBytes(await saved(workbook), source)).toBe(true)
	})

	it("saves the same in slices", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)
		let pauses = 0

		sheet.store.setCell(0, 1, CellKind.NUMBER, 4, 0, -1)
		workbook.sharedStrings.append("sliced")
		workbook.changes.sharedStringsAppended()
		workbook.changes.sheetRows(0)

		const plain = await saved(workbook)
		const sliced = await saved(workbook, {
			slicing: {
				sliceMs: 0,
				now: () => Date.now(),
				pause: async () => {
					pauses++
					await new Promise(resolve => setTimeout(resolve, 0))
				}
			}
		})

		expect(equalBytes(sliced, plain)).toBe(true)
		expect(pauses).toBeGreaterThan(0)
	})

	it("deflates the parts it changed and nothing else", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)
		const deflated: number[] = []

		sheet.store.setCell(0, 1, CellKind.NUMBER, 3, 0, -1)
		workbook.changes.sheetRows(0)

		const result = await saveXlsx(
			{ opc: workbook.opc, workbook },
			{
				zip: {
					deflate: async data => (deflated.push(data.length), deflateSync(data)),
					deflateChunks: async chunks => {
						const all: Uint8Array[] = []

						for await (const chunk of chunks) all.push(chunk)

						const joined = new Uint8Array(all.reduce((sum, chunk) => sum + chunk.length, 0))
						let at = 0

						for (const chunk of all) {
							joined.set(chunk, at)
							at += chunk.length
						}

						deflated.push(joined.length)

						return deflateSync(joined)
					}
				}
			}
		)

		expect(result.ok).toBe(true)
		expect(deflated).toEqual([(parts((result as { bytes: Uint8Array }).bytes)["xl/worksheets/sheet1.xml"] as string).length])
	})

	it("appends shared strings and updates count and uniqueCount", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)
		const index = workbook.sharedStrings.append("gamma & <delta>")

		workbook.changes.sharedStringsAppended()
		workbook.sharedStrings.adjustReferences(1)
		sheet.store.setCell(2, 0, CellKind.SHARED_STRING, index, 0, -1)
		workbook.changes.sheetRows(0)

		const output = await saved(workbook)
		const after = parts(output)

		expect(after["xl/sharedStrings.xml"]).toBe(
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${SML}" count="4" uniqueCount="3"><si><t>alpha</t></si><si><t>beta</t></si><si><t>gamma &amp; &lt;delta&gt;</t></si></sst>`
		)
		// A new row goes between rows 2 and 4, the rows around it untouched.
		expect(after["xl/worksheets/sheet1.xml"]).toContain(
			'</row><row r="3"><c r="A3" t="s"><v>2</v></c></row><row r="4" spans="1:3" ht="20"'
		)

		const reopened = await openWorkbook(output)

		expect(reopened.sharedStrings.text(2)).toBe("gamma & <delta>")
	})

	it("keeps formulas, booleans, inline strings and errors through a rewrite of their rows", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		// A style change on every row forces each to be rewritten; the cells must come out as they were.
		sheet.store.setRow(1, Number.NaN, 1, RowFlag.CUSTOM_FORMAT)
		sheet.store.setRow(3, 20, -1, RowFlag.CUSTOM_HEIGHT | RowFlag.HIDDEN)
		workbook.changes.sheetRows(0)

		const after = parts(await saved(workbook))["xl/worksheets/sheet1.xml"] as string

		expect(after).toContain(
			'<row r="2" spans="1:3" s="1" customFormat="1" x14ac:dyDescent="0.25"><c r="A2"><f>B1*2</f><v>3</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="s"><v>0</v></c></row>'
		)
		expect(after).toContain(
			'<row r="4" spans="1:3" ht="20" hidden="1" customHeight="1" x14ac:dyDescent="0.25"><c r="A4" t="inlineStr"><is><t>inline</t></is></c><c r="C4" t="e"><v>#DIV/0!</v></c></row>'
		)
	})

	it("serialises every kind of new cell", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)
		const store = sheet.store
		const text = store.strings.intern("  padded ")
		const error = store.strings.intern("#N/A")
		const id = store.formulas.add(formula("SUM(A1:A2)"))

		store.setCell(5, 0, CellKind.INLINE_STRING, text, 0, -1)
		store.setCell(5, 1, CellKind.BOOLEAN, 0, 0, -1)
		store.setCell(5, 2, CellKind.ERROR, error, 0, -1)
		store.setCell(5, 3, CellKind.NUMBER, 1e21, 1, id)
		store.setCell(5, 4, CellKind.EMPTY, 0, 1, -1)
		workbook.changes.sheetRows(0)
		workbook.changes.formulasChanged()

		const output = await saved(workbook)
		const after = parts(output)["xl/worksheets/sheet1.xml"] as string

		expect(after).toContain(
			'<row r="6"><c r="A6" t="inlineStr"><is><t xml:space="preserve">  padded </t></is></c><c r="B6" t="b"><v>0</v></c><c r="C6" t="e"><v>#N/A</v></c><c r="D6" s="1"><f>SUM(A1:A2)</f><v>1e+21</v></c><c r="E6" s="1"/></row>'
		)
		// The dimension grows to cover the new cells.
		expect(after).toContain('<dimension ref="A1:E6"/>')
		// calcChain goes with its relationship and override.
		const names = parts(output)

		expect(names["xl/calcChain.xml"]).toBeUndefined()
		expect(names["xl/_rels/workbook.xml.rels"]).not.toContain("calcChain")
		expect(names["[Content_Types].xml"]).not.toContain("calcChain")
	})

	it("drops calcChain when a rewritten row's formulas changed, recorded or not", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		// A2's formula goes; nothing else said formulas changed.
		sheet.store.setCell(1, 0, CellKind.NUMBER, 3, 0, -1)
		workbook.changes.sheetRows(0)

		const output = await saved(workbook)

		expect(parts(output)["xl/calcChain.xml"]).toBeUndefined()
		expect(await changedEntries(source, output)).toEqual({
			changed: ["[Content_Types].xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"],
			added: [],
			removed: ["xl/calcChain.xml"]
		})
	})

	it("keeps value metadata only while the value stays", async () => {
		const source = buildFixture({
			sheets: [
				{
					name: "S",
					body: '<sheetData><row r="1"><c r="A1" vm="1" ph="1"><v>5</v><extLst><ext uri="{X}"/></extLst></c><c r="B1" vm="2"><v>6</v></c></row></sheetData>'
				}
			]
		})
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		sheet.store.setCell(0, 0, CellKind.NUMBER, 5, 1, -1)
		sheet.store.setCell(0, 1, CellKind.NUMBER, 7, 0, -1)
		workbook.changes.sheetRows(0)

		const after = parts(await saved(workbook))["xl/worksheets/sheet1.xml"] as string

		expect(after).toContain(
			'<row r="1"><c r="A1" s="1" vm="1" ph="1"><v>5</v><extLst><ext uri="{X}"/></extLst></c><c r="B1"><v>7</v></c></row>'
		)
	})

	it("renumbers rows that only moved", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		sheet.store.insertRows(1, 2)
		workbook.changes.sheetRows(0)

		const after = parts(await saved(workbook))["xl/worksheets/sheet1.xml"] as string

		expect(after).toContain('<row r="1" spans="1:3" x14ac:dyDescent="0.25"><c r="A1" t="s">')
		expect(after).toContain(
			'<row r="4" spans="1:3" x14ac:dyDescent="0.25"><c r="A4"><f>B1*2</f><v>3</v></c><c r="B4" t="b"><v>1</v></c><c r="C4" t="s"><v>0</v></c></row>'
		)
		expect(after).toContain('<row r="6" spans="1:3" ht="20" customHeight="1" x14ac:dyDescent="0.25"><c r="A6" t="inlineStr">')
	})

	it("drops deleted rows", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		sheet.store.deleteRows(0, 1)
		workbook.changes.sheetRows(0)

		const after = parts(await saved(workbook))["xl/worksheets/sheet1.xml"] as string

		expect(after).toContain('<sheetData><row r="1" spans="1:3" x14ac:dyDescent="0.25"><c r="A1"><f>B1*2</f>')
		expect(after).not.toContain(">alpha<")
	})

	it("appends style records without touching the existing ones", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)
		const styles = workbook.styles
		const font = styles.appendFont({ name: "Arial", size: 12, bold: true, color: { argb: 0xffff0000 } })
		const fill = styles.appendFill({ kind: "pattern", pattern: "solid", fg: { theme: 4, tint: -0.25 } })
		const xf = styles.appendXf({
			numFmtId: styles.numFmtId("0.000%"),
			fontId: font,
			fillId: fill,
			borderId: 0,
			xfId: 0,
			flags: 0b111,
			alignment: { horizontal: "center", wrapText: true }
		})

		workbook.changes.stylesAppended()
		sheet.store.setCell(0, 1, CellKind.NUMBER, 1.5, xf, -1)
		workbook.changes.sheetRows(0)

		const output = await saved(workbook)
		const before = parts(source)["xl/styles.xml"] as string
		const after = parts(output)["xl/styles.xml"] as string

		expect(after).toContain(
			'<numFmts count="1"><numFmt numFmtId="164" formatCode="0.000%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="12"/><color rgb="FFFF0000"/><name val="Arial"/></font></fonts>'
		)
		expect(after).toContain('<fill><patternFill patternType="solid"><fgColor theme="4" tint="-0.25"/></patternFill></fill></fills>')
		expect(after).toContain(
			'<xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"><alignment horizontal="center" wrapText="1"/></xf></cellXfs>'
		)
		expect(after.startsWith(before.slice(0, before.indexOf("<fonts")))).toBe(true)

		const reopened = await openWorkbook(output)

		expect(reopened.styles.cellXfs.length).toBe(3)
		expect(reopened.styles.fonts[1]?.name).toBe("Arial")
	})

	it("writes a styles part for a workbook that had none, its implied defaults first", async () => {
		const source = buildFixture({
			sheets: [{ name: "S", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }],
			styles: null
		})
		const append = async (seed: boolean) => {
			const workbook = await openWorkbook(source)
			const sheet = await workbook.load(0)

			if (seed) seedImpliedStyles(workbook.styles)

			const font = workbook.styles.appendFont({ name: "Arial", bold: true })
			const xf = workbook.styles.appendXf({ numFmtId: 0, fontId: font, fillId: 0, borderId: 0, xfId: 0, flags: XfApply.FONT })

			workbook.changes.stylesAppended()
			sheet.store.setCell(0, 1, CellKind.NUMBER, 2, xf, -1)
			workbook.changes.sheetRows(0)

			return saveXlsx({ opc: workbook.opc, workbook })
		}

		// Without the defaults, the edit's format would become every unformatted cell's.
		expect(await append(false)).toMatchObject({ ok: false, reason: "model" })

		const result = await append(true)

		expect(result.ok).toBe(true)

		const after = parts((result as { bytes: Uint8Array }).bytes)

		expect(after["xl/styles.xml"]).toContain(
			'<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
		)
		expect(after["xl/styles.xml"]).toContain(
			'<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
		)
		expect(after["xl/_rels/workbook.xml.rels"]).toContain(
			'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"'
		)
		expect(after["[Content_Types].xml"]).toContain(
			'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
		)
		expect(after["xl/worksheets/sheet1.xml"]).toContain('<c r="A1"><v>1</v></c><c r="B1" s="1"><v>2</v></c>')
	})

	it("writes the sections it owns in schema order", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		sheet.merges = Uint32Array.from([0, 0, 0, 1, 3, 0, 4, 1])
		sheet.cols = [{ first: 1, last: 2, width: 20.5, style: -1, flags: ColFlag.CUSTOM_WIDTH }]
		sheet.view = {
			...sheet.view,
			frozen: { rows: 1, cols: 0, topLeftRow: 1, topLeftCol: 0 },
			activeRow: 1,
			activeCol: 0,
			selection: [{ startRow: 1, startCol: 0, endRow: 1, endCol: 0 }]
		}
		sheet.protection = {
			hash: { algorithmName: "SHA-512", hashValue: "aGFzaA==", saltValue: "c2FsdA==", spinCount: 100000 },
			allows: new Set(["selectLockedCells", "selectUnlockedCells", "formatCells"])
		}
		sheet.tabColor = { argb: 0xff00b050 }

		for (const name of ["mergeCells", "cols", "sheetViews", "sheetProtection", "sheetPr"]) workbook.changes.sheetSection(0, name)

		const output = await saved(workbook)
		const after = parts(output)["xl/worksheets/sheet1.xml"] as string

		expect(after).toContain('<sheetPr><tabColor rgb="FF00B050"/></sheetPr><dimension ref="A1:C4"/>')
		expect(after).toContain(
			'<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
		)
		expect(after).toContain('<cols><col min="2" max="3" width="20.5" customWidth="1"/></cols><sheetData>')
		expect(after).toContain(
			'</sheetData><sheetProtection algorithmName="SHA-512" hashValue="aGFzaA==" saltValue="c2FsdA==" spinCount="100000" sheet="1" objects="1" scenarios="1" formatCells="0"/><mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="A4:B5"/></mergeCells><pageMargins'
		)

		const reopened = await openWorkbook(output)
		const read = await reopened.load(0)

		expect([...read.merges]).toEqual([0, 0, 0, 1, 3, 0, 4, 1])
		expect(read.view.frozen).toEqual({ rows: 1, cols: 0, topLeftRow: 1, topLeftCol: 0 })
		expect(read.protection?.allows.has("formatCells")).toBe(true)
	})

	it("writes into a part whose root uses a prefix", async () => {
		const source = buildFixture({
			sheets: [
				{
					name: "S",
					xml: `<x:worksheet xmlns:x="${SML}"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>`
				}
			]
		})
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		sheet.store.setCell(0, 1, CellKind.NUMBER, 2, 0, -1)
		sheet.merges = Uint32Array.from([1, 0, 1, 1])
		workbook.changes.sheetRows(0)
		workbook.changes.sheetSection(0, "mergeCells")

		const after = parts(await saved(workbook))["xl/worksheets/sheet1.xml"] as string

		expect(after).toBe(
			`<x:worksheet xmlns:x="${SML}"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c><x:c r="B1"><x:v>2</x:v></x:c></x:row></x:sheetData><x:mergeCells count="1"><x:mergeCell ref="A2:B2"/></x:mergeCells></x:worksheet>`
		)
	})

	it("sets fullCalcOnLoad and the workbook sections it owns", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)

		workbook.sheets[1]!.name = "Renamed"
		workbook.activeTab = 1
		workbook.changes.workbookSection("sheets")
		workbook.changes.workbookSection("bookViews")
		workbook.changes.needsFullCalc()

		const after = parts(await saved(workbook))["xl/workbook.xml"] as string

		expect(after).toContain('<workbookView xWindow="0" yWindow="0" windowWidth="100" windowHeight="100" activeTab="1"/>')
		expect(after).toContain('<sheet name="Renamed" sheetId="2" r:id="rId2"/>')
		expect(after).toContain('<calcPr calcId="191029" fullCalcOnLoad="1"/>')
	})

	it("moves a sheet with its local names", async () => {
		const source = buildFixture({
			sheets: [
				{ name: "One", body: "<sheetData/>" },
				{ name: "Two", body: "<sheetData/>" }
			],
			workbookTail:
				'<definedNames><definedName name="_xlnm.Print_Area" localSheetId="1">Two!$A$1:$B$2</definedName><definedName name="Global">One!$A$1</definedName></definedNames>'
		})
		const workbook = await openWorkbook(source)

		workbook.sheets.reverse()
		workbook.changes.workbookSection("sheets")

		const after = parts(await saved(workbook))["xl/workbook.xml"] as string

		expect(after).toContain(
			'<sheets><sheet name="Two" sheetId="2" r:id="rId2"/><sheet name="One" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Two!$A$1:$B$2</definedName><definedName name="Global">One!$A$1</definedName></definedNames>'
		)
	})

	it("accepts whole rows and columns in a section an edit wrote", async () => {
		const workbook = await openWorkbook(basic())

		await workbook.load(0)
		workbook.changes.sheetSection(
			0,
			"conditionalFormatting",
			() =>
				'<conditionalFormatting sqref="A:B 3:4"><cfRule type="expression" dxfId="0" priority="1"><formula>1</formula></cfRule></conditionalFormatting>'
		)
		workbook.styles.appendDxf({ font: { bold: true } })
		workbook.changes.stylesAppended()

		const after = parts(await saved(workbook))["xl/worksheets/sheet1.xml"] as string

		expect(after).toContain('</sheetData><conditionalFormatting sqref="A:B 3:4">')
		expect(after.indexOf("<conditionalFormatting")).toBeLessThan(after.indexOf("<pageMargins"))
	})

	it("keeps a UTF-16 sheet's rows, written out as UTF-8", async () => {
		const text = worksheet(
			'<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData>'
		).replace("UTF-8", "UTF-16")
		const utf16 = new Uint8Array(2 + text.length * 2)

		utf16[0] = 0xff
		utf16[1] = 0xfe

		for (let k = 0; k < text.length; k++) {
			utf16[2 + k * 2] = text.charCodeAt(k) & 0xff
			utf16[3 + k * 2] = text.charCodeAt(k) >> 8
		}

		const plain = buildFixture({ sheets: [{ name: "S", body: "<sheetData/>" }] })
		const files = unzipSync(plain)

		files["xl/worksheets/sheet1.xml"] = utf16

		const source = zipSync(files, { mtime: ZIP_ENTRY_TIME })
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		sheet.store.setCell(1, 0, CellKind.NUMBER, 3, 0, -1)
		workbook.changes.sheetRows(0)

		const after = parts(await saved(workbook))["xl/worksheets/sheet1.xml"] as string

		expect(after.startsWith('<?xml version="1.0" encoding="UTF-8"  standalone="yes"?>')).toBe(true)
		expect(after).toContain('<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>3</v></c></row>')
	})

	it("adds a sheet with its part, relationship and content type", async () => {
		const source = basic()
		const workbook = await openWorkbook(source)

		await workbook.parts.relationships(workbook.workbookPart)

		const relationship = workbook.changes.addRelationship(workbook.workbookPart, {
			type: `${R}/worksheet`,
			target: "worksheets/sheet3.xml"
		})
		const id = workbook.allocateSheetId()

		workbook.sheets.push({
			id,
			name: "Three",
			state: "visible",
			kind: "worksheet",
			sheetId: 3,
			relationshipId: relationship.id,
			part: "xl/worksheets/sheet3.xml",
			model: null
		})
		workbook.changes.workbookSection("sheets")

		const store = new SheetStore([], new SheetStrings(), new FormulaTable())

		store.setCell(0, 0, CellKind.NUMBER, 9, 0, -1)
		;(workbook.sheets[2] as { model: unknown }).model = {
			id,
			part: "xl/worksheets/sheet3.xml",
			store,
			sections: [],
			relationships: new Relationships([]),
			cols: [],
			merges: new Uint32Array(0),
			format: DEFAULT_FORMAT,
			view: DEFAULT_VIEW,
			protection: null,
			tabColor: null
		}

		const output = await saved(workbook)
		const after = parts(output)

		expect(after["xl/worksheets/sheet3.xml"]).toContain('<sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData>')
		expect(after["[Content_Types].xml"]).toContain(
			'<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
		)
		expect(after["xl/workbook.xml"]).toContain(`<sheet name="Three" sheetId="3" r:id="${relationship.id}"/>`)

		const reopened = await openWorkbook(output)

		expect(reopened.sheets.map(sheet => sheet.name)).toEqual(["One", "Two", "Three"])
		expect((await reopened.load(reopened.sheets[2]!.id)).store.cellCount).toBe(1)
	})
})

describe("a part's root element", () => {
	const PROLOG = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- made with <x:worksheet> and <b>y</b> -->\n'

	it("is found past markup inside a prolog comment, and a save that touches the part succeeds", async () => {
		const { tag, prefix, name } = rootTag(encodeUtf8(`${PROLOG}<worksheet xmlns="${SML}"><sheetData/></worksheet>`))

		expect({ prefix, name, start: tag.start }).toEqual({ prefix: "", name: "worksheet", start: PROLOG.length })

		const source = buildFixture({
			sheets: [
				{
					name: "One",
					xml: `${PROLOG}<worksheet xmlns="${SML}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`
				}
			]
		})
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		sheet.store.setCell(0, 0, CellKind.NUMBER, 2, 0, -1)
		workbook.changes.sheetRows(0)

		expect(parts(await saved(workbook))["xl/worksheets/sheet1.xml"]).toContain('<c r="A1"><v>2</v></c>')
	})

	it("is skipped to past a document type declaration, and refuses unterminated prolog markup", () => {
		expect(rootTag(encodeUtf8(`<!DOCTYPE worksheet SYSTEM "a>b.dtd"><x:worksheet xmlns:x="${SML}"/>`)).prefix).toBe("x")

		for (const text of [
			'<?xml version="1.0"?><!-- <worksheet/>',
			'<?xml version="1.0"<worksheet/>',
			'<!DOCTYPE worksheet [<!ENTITY a "b">]><worksheet/>'
		])
			expect(() => rootTag(encodeUtf8(text))).toThrow(expect.objectContaining({ reason: "malformedPart" }))
	})
})

describe("the save gate and defects the source already had", () => {
	const LONG = "A sheet name of forty characters, really"

	function withWorkbookXml(bytes: Uint8Array, edit: (xml: string) => string): Uint8Array {
		const files = unzipSync(bytes)
		const xml = encodeUtf8(edit(decodeUtf8(files["xl/workbook.xml"] ?? new Uint8Array(0))))

		return zipSync({ ...files, "xl/workbook.xml": xml }, { mtime: ZIP_ENTRY_TIME })
	}

	it("keeps a source sheet name the gate would refuse, and refuses a rename to one", async () => {
		expect(LONG.length).toBe(40)

		const source = buildFixture({
			sheets: [{ name: LONG, body: '<sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData>' }, { name: "Two" }]
		})
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		sheet.store.setCell(0, 1, CellKind.NUMBER, 3, 0, -1)
		workbook.changes.sheetRows(0)
		workbook.changes.needsFullCalc()

		expect(parts(await saved(workbook))["xl/workbook.xml"]).toContain(`name="${LONG}"`)

		const renamed = await openWorkbook(source)
		const two = renamed.sheets[1]!

		two.name = `${LONG}!`
		renamed.changes.workbookSection("sheets")

		expect(await saveXlsx({ opc: renamed.opc, workbook: renamed })).toMatchObject({ ok: false, reason: "reference" })
	})

	it("keeps duplicate sheetIds of the source, and refuses a new duplicate", async () => {
		const source = withWorkbookXml(
			buildFixture({
				sheets: [{ name: "One" }, { name: "Two" }, { name: "Three" }],
				workbookTail: '<definedNames><definedName name="n">One!$A$1</definedName></definedNames>'
			}),
			xml => xml.replace('sheetId="2"', 'sheetId="1"')
		)
		const workbook = await openWorkbook(source)

		workbook.changes.workbookSection("definedNames", () => '<definedNames><definedName name="n">One!$A$1</definedName></definedNames>')

		expect(parts(await saved(workbook))["xl/workbook.xml"]).toContain('<sheet name="Two" sheetId="1"')

		const other = await openWorkbook(source)

		other.sheets[2]!.name = "one"
		other.changes.workbookSection("sheets")

		expect(await saveXlsx({ opc: other.opc, workbook: other })).toMatchObject({ ok: false, reason: "reference" })
	})

	it("writes an active tab past the last sheet back within the sheets", async () => {
		const source = withWorkbookXml(buildFixture({ sheets: [{ name: "One" }, { name: "Two" }] }), xml =>
			xml.replace('<workbookView xWindow="0"', '<workbookView activeTab="5" firstSheet="7" xWindow="0"')
		)
		const workbook = await openWorkbook(source)

		workbook.changes.needsFullCalc()

		const written = parts(await saved(workbook))["xl/workbook.xml"] ?? ""

		expect(written).toMatch(new RegExp(`<workbookView activeTab="${workbook.activeTab}" firstSheet="1" `))
		expect(workbook.activeTab).toBeLessThan(2)
	})

	it("keeps overlapping column ranges of the source when the columns are written", async () => {
		const source = buildFixture({
			sheets: [
				{
					name: "One",
					body: '<cols><col min="1" max="3" width="5" customWidth="1"/><col min="2" max="4" width="6" customWidth="1"/></cols><sheetData/>'
				}
			]
		})
		const workbook = await openWorkbook(source)
		const sheet = await workbook.load(0)

		// A width changed: the section is written anew, its source overlap with it.
		sheet.cols = sheet.cols.map(col => (col.first === 1 ? { ...col, width: 9 } : col))
		workbook.changes.sheetSection(0, "cols")

		expect(parts(await saved(workbook))["xl/worksheets/sheet1.xml"]).toContain('<col min="2" max="4" width="9"')

		sheet.cols = [...sheet.cols, { ...sheet.cols[0]!, first: 3, last: 3 }]
		workbook.changes.sheetSection(0, "cols")

		expect(await saveXlsx({ opc: workbook.opc, workbook })).toMatchObject({ ok: false, reason: "reference" })
	})

	it("keeps a dangling relationship id of the source through a structure edit, and refuses a new one", async () => {
		const source = buildFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><hyperlinks><hyperlink ref="A3" r:id="rId9"/></hyperlinks>'
				}
			]
		})
		const workbook = await openWorkbook(source)

		await workbook.load(0)

		const result = await planRefEdit(workbook, { kind: "axis", sheet: 0, shift: { type: "insert", axis: "rows", at: 0, count: 1 } })

		if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`)

		result.plan.apply()

		expect(parts(await saved(workbook))["xl/worksheets/sheet1.xml"]).toContain('<hyperlink ref="A4" r:id="rId9"/>')

		const other = await openWorkbook(source)

		await other.load(0)
		other.changes.sheetSection(
			0,
			"hyperlinks",
			() => '<hyperlinks><hyperlink ref="A3" r:id="rId9"/><hyperlink ref="A5" r:id="rId8"/></hyperlinks>'
		)

		expect(await saveXlsx({ opc: other.opc, workbook: other })).toMatchObject({ ok: false, reason: "relationship" })
	})
})

describe("xlsx save gate", () => {
	it("refuses a cell whose style does not exist, without throwing", async () => {
		const workbook = await openWorkbook(basic())
		const sheet = await workbook.load(0)

		sheet.store.setCell(0, 0, CellKind.NUMBER, 1, 99, -1)
		workbook.changes.sheetRows(0)

		const result = await saveXlsx({ opc: workbook.opc, workbook })

		expect(result).toMatchObject({ ok: false, reason: "reference" })
	})

	it("refuses a shared string index past the table", async () => {
		const workbook = await openWorkbook(basic())
		const sheet = await workbook.load(0)

		sheet.store.setCell(0, 0, CellKind.SHARED_STRING, 7, 0, -1)
		workbook.changes.sheetRows(0)

		expect(await saveXlsx({ opc: workbook.opc, workbook })).toMatchObject({ ok: false, reason: "reference" })
	})

	it("refuses overlapping merges", async () => {
		const workbook = await openWorkbook(basic())
		const sheet = await workbook.load(0)

		sheet.merges = Uint32Array.from([0, 0, 1, 1, 1, 1, 2, 2])
		workbook.changes.sheetSection(0, "mergeCells")

		expect(await saveXlsx({ opc: workbook.opc, workbook })).toMatchObject({ ok: false, reason: "reference" })
	})

	it("refuses a sheet name Excel would repair", async () => {
		for (const name of ["a/b", "x".repeat(32), "TWO", "'quoted'"]) {
			const workbook = await openWorkbook(basic())

			workbook.sheets[0]!.name = name
			workbook.changes.workbookSection("sheets")

			expect(await saveXlsx({ opc: workbook.opc, workbook }), name).toMatchObject({ ok: false, reason: "reference" })
		}
	})

	it("refuses a number the file cannot hold", async () => {
		const workbook = await openWorkbook(basic())
		const sheet = await workbook.load(0)

		sheet.store.setCell(0, 0, CellKind.NUMBER, Number.NaN, 0, -1)
		workbook.changes.sheetRows(0)

		expect(await saveXlsx({ opc: workbook.opc, workbook })).toMatchObject({ ok: false, reason: "write" })
	})

	it("refuses a section written out of well-formedness or out of schema order", async () => {
		const workbook = await openWorkbook(basic())

		await workbook.load(0)
		workbook.changes.sheetSection(
			0,
			"conditionalFormatting",
			() => '<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>1</formula></cfRule>'
		)

		expect(await saveXlsx({ opc: workbook.opc, workbook })).toMatchObject({ ok: false, reason: "malformedPart" })

		const other = await openWorkbook(basic())

		await other.load(0)
		other.changes.sheetSection(
			0,
			"conditionalFormatting",
			() =>
				'<conditionalFormatting sqref="A1:XFE1"><cfRule type="expression" dxfId="0" priority="1"><formula>1</formula></cfRule></conditionalFormatting>'
		)

		expect(await saveXlsx({ opc: other.opc, workbook: other })).toMatchObject({ ok: false, reason: "reference" })
	})

	it("refuses a removed part something still relates to", async () => {
		const source = buildFixture({
			sheets: [
				{
					name: "S",
					body: '<sheetData/><drawing r:id="rId1"/>',
					rels: `<Relationship Id="rId1" Type="${R}/drawing" Target="../drawings/drawing1.xml"/>`
				}
			],
			parts: {
				"xl/drawings/drawing1.xml": {
					text: '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>',
					type: "application/vnd.openxmlformats-officedocument.drawing+xml"
				}
			}
		})
		const workbook = await openWorkbook(source)

		workbook.changes.removePart("xl/drawings/drawing1.xml")

		expect(await saveXlsx({ opc: workbook.opc, workbook })).toMatchObject({ ok: false, reason: "relationship" })
	})

	it("refuses to rewrite a sheet that is not loaded", async () => {
		const workbook = await openWorkbook(basic())

		workbook.changes.sheetRows(1)

		expect(await saveXlsx({ opc: workbook.opc, workbook })).toMatchObject({ ok: false, reason: "write" })
	})

	it("refuses a row whose span is not a row", async () => {
		const workbook = await openWorkbook(basic())
		const sheet = await workbook.load(0)
		const block = sheet.store.blocks[0]!

		;(block.rowSpans as Uint32Array)[0] = (block.rowSpans[0] ?? 0) + 1
		workbook.changes.sheetRows(0)

		expect(await saveXlsx({ opc: workbook.opc, workbook })).toMatchObject({ ok: false, reason: "malformedPart" })
	})
})

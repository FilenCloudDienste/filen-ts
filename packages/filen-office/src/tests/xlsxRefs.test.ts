import { describe, expect, it } from "vitest"
import { FormulaShift } from "../core/xlsx/refs/formulas"
import { REF_CONSTRUCTS, shiftEdges, shiftVmlAnchor, specifierColumns } from "../core/xlsx/refs/index"
import { rewriteStructured } from "../core/xlsx/refs/structured"
import { MC, R, TYPES, X14, XM, cols, covered, edited, refused, relationship, rels, rows, sheetBody } from "./xlsxRefsFixtures"
import type { Fixture } from "./xlsxWriteFixtures"

// The reference catalogue: every construct that refers to cells, moved by row and column inserts and deletes and
// by sheet deletes, renames and moves as Excel moves it, each saved through the gate and reverted to the source's
// bytes. The last test checks that every catalogue entry was exercised here.

const DATA =
	'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c></row>' +
	'<row r="2"><c r="A2"><v>4</v></c></row><row r="3"><c r="A3"><v>5</v></c></row><row r="4"><c r="A4"><v>6</v></c></row>' +
	'<row r="5"><c r="A5"><v>7</v></c></row></sheetData>'

function axisOp(type: "insert" | "delete", axis: "rows" | "cols", at: number, count: number) {
	return { kind: "axis" as const, target: "Data", shift: { type, axis, at, count } }
}

describe("formula text", () => {
	it("moves references into the edited sheet only", () => {
		const shift = new FormulaShift(axisOp("insert", "rows", 2, 3))

		expect(shift.shift("SUM(A1:A5)+A2+A3+$A$10", "Data")).toBe("SUM(A1:A8)+A2+A6+$A$13")
		expect(shift.shift("SUM(A1:A5)", "Other")).toBe("SUM(A1:A5)")
		expect(shift.shift("Data!A3+'Data'!B9+Other!A3", "Other")).toBe("Data!A6+'Data'!B12+Other!A3")
		// 3-D spans and other workbooks stay as written.
		expect(shift.shift("SUM(Data:Other!A3)+[1]Data!A3", "Data")).toBe("SUM(Data:Other!A3)+[1]Data!A3")
		expect(shift.shift("SUM(A:A)+SUM(3:4)", "Data")).toBe("SUM(A:A)+SUM(6:7)")
	})

	it("turns deleted references into #REF! and shrinks cut ranges", () => {
		const shift = new FormulaShift(axisOp("delete", "rows", 1, 2))

		expect(shift.shift("A2+A3+A4+SUM(A1:A5)+SUM(A2:A3)", "Data")).toBe("#REF!+#REF!+A2+SUM(A1:A3)+SUM(#REF!)")
		expect(shift.shift("Data!A2", "Other")).toBe("Data!#REF!")
	})

	it("moves anchored formulas to the new top-left cell", () => {
		const shift = new FormulaShift(axisOp("delete", "rows", 1, 1))

		// A2:A10 with A2>1, row 2 deleted: the new top-left is the old A3, whose formula is A3>1, now A2>1.
		expect(shift.shiftAnchored("A2>1", "Data", 1, 0)).toBe("A2>1")
	})

	it("deletes, renames and moves sheets", () => {
		const order = ["Jan", "Feb", "Mar", "Apr"]
		const deleteFeb = new FormulaShift({ kind: "deleteSheet", target: "Feb", order })
		const deleteJan = new FormulaShift({ kind: "deleteSheet", target: "Jan", order })

		expect(deleteFeb.shift("Feb!A1+SUM(Feb!A1:B2)+Jan!A1", null)).toBe("#REF!A1+SUM(#REF!A1:B2)+Jan!A1")
		// Names that read as columns (JAN, MAR) are quoted.
		expect(deleteFeb.shift("SUM(Jan:Mar!A1)+SUM(Feb:Mar!A1)+SUM(Jan:Feb!A1)", null)).toBe("SUM(Jan:Mar!A1)+SUM('Mar'!A1)+SUM('Jan'!A1)")
		expect(deleteJan.shift("SUM(Jan:Apr!A1)+SUM(Jan:Jan!A1)", null)).toBe("SUM('Feb:Apr'!A1)+SUM(#REF!A1)")

		const rename = new FormulaShift({ kind: "renameSheet", target: "Feb", name: "Feb 2026" })

		expect(rename.shift("Feb!A1+SUM(Jan:Feb!A1)+'Feb'!B2", null)).toBe("'Feb 2026'!A1+SUM('Jan:Feb 2026'!A1)+'Feb 2026'!B2")

		const move = new FormulaShift({ kind: "moveSheet", order: ["Feb", "Mar", "Jan", "Apr"] })

		expect(move.shift("SUM(Jan:Mar!A1)+SUM(Feb:Apr!A1)", null)).toBe("SUM('Mar:Jan'!A1)+SUM(Feb:Apr!A1)")
	})

	it("breaks structured references to deleted tables and columns", () => {
		const tables = new Map([
			["T1", { deleted: false as const, columns: new Set(["B", "C D"]) }],
			["GONE", { deleted: true as const }]
		])

		expect(rewriteStructured("SUM(T1[A])+SUM(T1[B])+T1[[#This Row],[C D]]+Gone[x]+T1[[A]:[A]]", null, tables)).toBe(
			"SUM(T1[A])+SUM(#REF!)+#REF!+#REF!+T1[[A]:[A]]"
		)
		expect(rewriteStructured('[@B]*2&"T1[B]"+[1]Sheet!A1', "T1", tables)).toBe('#REF!*2&"T1[B]"+[1]Sheet!A1')
		expect(specifierColumns("[#Headers],[A]:[C]")).toEqual(["A", "C"])
		expect(specifierColumns("@[Col 'Name]")).toEqual(["Col Name"])
	})
})

describe("anchors", () => {
	const at = (index: number, offset = 0) => ({ index, offset })

	it("moves and sizes two-cell anchors", () => {
		const insert = { type: "insert" as const, axis: "rows" as const, at: 3, count: 2 }

		expect(shiftEdges(at(1), at(5, 10), "twoCell", insert)).toEqual({ from: at(1), to: at(7, 10) })
		expect(shiftEdges(at(3), at(5), "twoCell", insert)).toEqual({ from: at(5), to: at(7) })
		// The bottom edge on the boundary above the insert does not grow.
		expect(shiftEdges(at(1), at(3, 0), "twoCell", insert)).toEqual({ from: at(1), to: at(3, 0) })
		expect(shiftEdges(at(1), at(5), "oneCell", insert)).toEqual({ from: at(1), to: at(5) })
		expect(shiftEdges(at(4), at(6), "oneCell", insert)).toEqual({ from: at(6), to: at(8) })
		expect(shiftEdges(at(4), at(6), "absolute", insert)).toEqual({ from: at(4), to: at(6) })

		const remove = { type: "delete" as const, axis: "rows" as const, at: 2, count: 2 }

		expect(shiftEdges(at(1, 5), at(6, 5), "twoCell", remove)).toEqual({ from: at(1, 5), to: at(4, 5) })
		expect(shiftEdges(at(2, 5), at(3, 5), "twoCell", remove)).toEqual({ from: at(2), to: at(2) })
		expect(shiftVmlAnchor("1, 15, 2, 10, 3, 15, 6, 4", remove)).toBe("1, 15, 2, 0, 3, 15, 4, 4")
	})
})

describe("worksheet constructs", () => {
	it("moves cells, formulas, merges, the view, the dimension, formats, validations, links and names", async () => {
		const fixture: Fixture = {
			sheets: [
				{
					name: "Data",
					body:
						'<dimension ref="A1:C5"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>' +
						'<selection pane="bottomLeft" activeCell="B3" sqref="B3:C4"/></sheetView></sheetViews>' +
						'<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="3"><c r="A3"><f>SUM(A1:A2)</f><v>1</v></c><c r="B3"><f t="shared" ref="B3:B5" si="0">A3*2</f><v>2</v></c></row>' +
						'<row r="4"><c r="B4"><f t="shared" si="0"/><v>0</v></c></row><row r="5"><c r="B5"><f t="shared" si="0"/><v>0</v></c></row></sheetData>' +
						'<mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells>' +
						'<conditionalFormatting sqref="A2:A5"><cfRule type="expression" priority="1"><formula>A2&gt;1</formula></cfRule></conditionalFormatting>' +
						'<dataValidations count="1"><dataValidation type="list" sqref="C3:C4"><formula1>$A$1:$A$3</formula1></dataValidation></dataValidations>' +
						'<hyperlinks><hyperlink ref="C5" location="Data!A2"/></hyperlinks>'
				},
				{ name: "Other", body: '<sheetData><row r="1"><c r="A1"><f>Data!A3+SUM(Data!A:A)</f><v>0</v></c></row></sheetData>' }
			],
			workbookTail:
				'<definedNames><definedName name="x">Data!$A$2:$A$4</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$2</definedName></definedNames>'
		}
		const { sheet, files } = await edited(fixture, rows("insert", 1, 2), [
			"cells",
			"formulas",
			"merges",
			"sheetView",
			"dimension",
			"conditionalFormatting",
			"dataValidations",
			"hyperlinks",
			"definedNames"
		])

		expect(sheet).toContain('<dimension ref="A1:C7"/>')
		expect(sheet).toContain('<pane ySplit="4" topLeftCell="A5"')
		expect(sheet).toContain('<selection pane="bottomLeft" activeCell="B5" sqref="B5:C6"/>')
		expect(sheet).toContain('<c r="A5"><f>SUM(A1:A4)</f>')
		expect(sheet).toContain('<f t="shared" ref="B5:B7" si="0">A5*2</f>')
		expect(sheet).toContain('<mergeCell ref="A1:B4"/>')
		expect(sheet).toContain('<conditionalFormatting sqref="A4:A7"><cfRule type="expression" priority="1"><formula>A4&gt;1</formula>')
		expect(sheet).toContain("<formula1>$A$1:$A$5</formula1>")
		expect(sheet).toContain('<hyperlink ref="C7" location="Data!A4"/>')
		expect(files["xl/worksheets/sheet2.xml"]).toContain("<f>Data!A5+SUM(Data!A:A)</f>")
		expect(files["xl/workbook.xml"]).toContain('<definedName name="x">Data!$A$4:$A$6</definedName>')
		expect(files["xl/workbook.xml"]).toContain('localSheetId="0">Data!$1:$4</definedName>')
	})

	it("deletes rows: #REF!, shrinking ranges, constructs that go with their cells", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1"><f>A3+SUM(A2:A4)+A2</f><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>' +
			'<row r="3"><c r="A3"><v>3</v></c></row><row r="6"><c r="A6"><f>A3*2</f><v>6</v></c></row></sheetData>' +
			'<mergeCells count="2"><mergeCell ref="B2:C3"/><mergeCell ref="B5:C7"/></mergeCells>' +
			'<conditionalFormatting sqref="D2:D3 D5:D6"><cfRule type="expression" priority="1"><formula>D2&gt;$A$1</formula></cfRule></conditionalFormatting>' +
			'<hyperlinks><hyperlink ref="E2" location="A1"/><hyperlink ref="E6" location="A3"/></hyperlinks>'
		const { sheet } = await edited(sheetBody(body), rows("delete", 1, 3), [
			"cells",
			"formulas",
			"merges",
			"conditionalFormatting",
			"hyperlinks"
		])

		expect(sheet).toContain("<f>#REF!+SUM(#REF!)+#REF!</f>")
		expect(sheet).toContain('<c r="A3"><f>#REF!*2</f>')
		// B2:C3 gone; B5:C7 now B2:C4.
		expect(sheet).toContain('<mergeCells count="1"><mergeCell ref="B2:C4"/></mergeCells>')
		// D2:D3 gone, D5:D6 now D2:D3 and its top-left (once D5) reads D5's formula, D5>$A$1, as D2>$A$1.
		expect(sheet).toContain('<conditionalFormatting sqref="D2:D3"><cfRule type="expression" priority="1"><formula>D2&gt;$A$1</formula>')
		expect(sheet).toContain('<hyperlinks><hyperlink ref="E3" location="#REF!"/></hyperlinks>')
	})

	it("rewrites repeated sections together, in place of the first", async () => {
		const body =
			DATA +
			'<conditionalFormatting sqref="A1:A3"><cfRule type="expression" priority="1"><formula>A1&gt;1</formula></cfRule></conditionalFormatting>' +
			'<conditionalFormatting sqref="B2"><cfRule type="expression" priority="2"><formula>B2&gt;1</formula></cfRule></conditionalFormatting>' +
			'<conditionalFormatting sqref="C9"><cfRule type="expression" priority="3"><formula>C9&gt;1</formula></cfRule></conditionalFormatting>'
		const { sheet } = await edited(sheetBody(body), rows("delete", 1, 1), ["conditionalFormatting"])

		expect(sheet).toContain(
			'</sheetData><conditionalFormatting sqref="A1:A2"><cfRule type="expression" priority="1"><formula>A1&gt;1</formula></cfRule></conditionalFormatting>' +
				'<conditionalFormatting sqref="C8"><cfRule type="expression" priority="3"><formula>C8&gt;1</formula></cfRule></conditionalFormatting></worksheet>'
		)
	})

	it("keeps shared formulas shared where every member still reads as the master moved, unshares the rest", async () => {
		// B5:B8 share A2 (each the cell three rows up); an insert at row 4 moves every member but only the
		// references from row 4 on.
		const body =
			'<sheetData><row r="5"><c r="B5"><f t="shared" ref="B5:B8" si="0">A2</f><v>0</v></c></row><row r="6"><c r="B6"><f t="shared" si="0"/><v>0</v></c></row>' +
			'<row r="7"><c r="B7"><f t="shared" si="0"/><v>0</v></c></row><row r="8"><c r="B8"><f t="shared" si="0"/><v>0</v></c></row>' +
			'<row r="9"><c r="D9"><f t="shared" ref="D9:D11" si="1">D1+$A$1</f><v>0</v></c></row><row r="10"><c r="D10"><f t="shared" si="1"/><v>0</v></c></row>' +
			'<row r="11"><c r="D11"><f t="shared" si="1"/><v>0</v></c></row></sheetData>'
		const { sheet } = await edited(sheetBody(body), rows("insert", 3, 1), ["sharedFormulas"])

		expect(sheet).toContain('<c r="B6"><f t="shared" ref="B6:B7" si="0">A2</f>')
		expect(sheet).toContain('<c r="B7"><f t="shared" si="0"/>')
		expect(sheet).toContain('<c r="B8"><f>A5</f>')
		expect(sheet).toContain('<c r="B9"><f>A6</f>')
		// D9:D11 read D1:D3 and $A$1, all above: the group moves as one.
		expect(sheet).toContain('<c r="D10"><f t="shared" ref="D10:D12" si="1">D1+$A$1</f>')

		// The master's row deleted: the others keep their texts as formulas of their own.
		const masterGone = await edited(sheetBody(body), rows("delete", 4, 1), ["sharedFormulas"])

		expect(masterGone.sheet).toContain('<c r="B5"><f>A3</f>')
		expect(masterGone.sheet).toContain('<c r="B6"><f>A4</f>')
		expect(masterGone.sheet).toContain('<c r="B7"><f>#REF!</f>')
	})

	it("refuses to cut an array formula, moves a whole one and a data table's inputs", async () => {
		const array = '<sheetData><row r="2"><c r="A2"><f t="array" ref="A2:A4">B2:B4*2</f><v>0</v></c></row></sheetData>'

		expect(await refused(sheetBody(array), rows("insert", 2), "formulas")).toEqual({ reason: "arrayFormula", detail: "array formula" })
		expect(await refused(sheetBody(array), rows("delete", 2), "formulas")).toEqual({ reason: "arrayFormula", detail: "array formula" })

		const { sheet } = await edited(sheetBody(array), rows("insert", 0, 2), ["formulas"])

		expect(sheet).toContain('<c r="A4"><f t="array" ref="A4:A6">B4:B6*2</f>')

		const table =
			'<sheetData><row r="3"><c r="C3"><f t="dataTable" ref="C3:C5" dt2D="0" dtr="0" r1="A1"/><v>0</v></c></row></sheetData>'
		const moved = await edited(sheetBody(table), rows("insert", 0, 1), ["formulas"])

		expect(moved.sheet).toContain('ref="C4:C6"')
		expect(moved.sheet).toContain('r1="A2"')
	})

	it("widens column ranges for columns inserted inside them", async () => {
		const body = '<cols><col min="2" max="4" width="20" customWidth="1"/><col min="6" max="6" width="5" customWidth="1"/></cols>' + DATA
		const { sheet } = await edited(sheetBody(body), cols("insert", 2, 2), ["cols", "cells"])

		expect(sheet).toContain('<col min="2" max="6" width="20" customWidth="1"/><col min="8" max="8" width="5" customWidth="1"/>')

		const removed = await edited(sheetBody(body), cols("delete", 1, 4), ["cols"])

		expect(removed.sheet).toContain('<cols><col min="2" max="2" width="5" customWidth="1"/></cols>')
	})

	it("moves page breaks and drops those of deleted rows", async () => {
		const body = `${DATA}<rowBreaks count="2" manualBreakCount="2"><brk id="2" max="16383" man="1"/><brk id="4" max="16383" man="1"/></rowBreaks><colBreaks count="1" manualBreakCount="1"><brk id="3" max="1048575" man="1"/></colBreaks>`
		const inserted = await edited(sheetBody(body), rows("insert", 1, 2), ["breaks"])

		expect(inserted.sheet).toContain('<brk id="4" max="16383" man="1"/><brk id="6" max="16383" man="1"/>')

		const deleted = await edited(sheetBody(body), rows("delete", 2, 1), ["breaks"])

		expect(deleted.sheet).toContain('<rowBreaks count="1" manualBreakCount="1"><brk id="3" max="16383" man="1"/></rowBreaks>')

		const columns = await edited(sheetBody(body), cols("insert", 0, 1), ["breaks"])

		expect(columns.sheet).toContain('<colBreaks count="1" manualBreakCount="1"><brk id="4" max="1048575" man="1"/></colBreaks>')
	})

	it("moves the autofilter, its filter columns and sort state", async () => {
		const body =
			DATA +
			'<autoFilter ref="A1:D5"><filterColumn colId="1"><filters><filter val="2"/></filters></filterColumn><filterColumn colId="3"><filters><filter val="x"/></filters></filterColumn>' +
			'<sortState ref="A2:D5"><sortCondition ref="D2:D5"/></sortState></autoFilter>'
		const { sheet } = await edited(sheetBody(body), cols("delete", 1, 1), ["autoFilter"])

		// Column B (filter 1) is gone; D (filter 3) is now C (filter 2).
		expect(sheet).toContain(
			'<autoFilter ref="A1:C5"><filterColumn colId="2"><filters><filter val="x"/></filters></filterColumn><sortState ref="A2:C5"><sortCondition ref="C2:C5"/>'
		)

		const inserted = await edited(sheetBody(body), cols("insert", 0, 1), ["autoFilter"])

		expect(inserted.sheet).toContain('<autoFilter ref="B1:E5"><filterColumn colId="1">')
	})

	it("moves the sheet's sort state, ignored errors and protected ranges", async () => {
		const body =
			'<sheetData/><sheetProtection sheet="1"/><protectedRanges><protectedRange name="r" sqref="B2:B4"/><protectedRange name="s" sqref="C9"/></protectedRanges>' +
			'<sortState ref="A2:C6"><sortCondition ref="B2:B6"/></sortState><ignoredErrors><ignoredError sqref="A3:A9" numberStoredAsText="1"/><ignoredError sqref="C9" formula="1"/></ignoredErrors>'
		const { sheet } = await edited(sheetBody(body), rows("delete", 8, 1), ["protectedRanges", "ignoredErrors"])

		expect(sheet).toContain('<protectedRanges><protectedRange name="r" sqref="B2:B4"/></protectedRanges>')
		expect(sheet).toContain('<ignoredErrors><ignoredError sqref="A3:A8" numberStoredAsText="1"/></ignoredErrors>')

		const sorted = await edited(sheetBody(body), rows("insert", 0, 1), ["sortState", "protectedRanges", "ignoredErrors"])

		expect(sorted.sheet).toContain('<sortState ref="A3:C7"><sortCondition ref="B3:B7"/></sortState>')
	})

	it("moves conditional formats, validations and sparklines of the x14 extension", async () => {
		const body =
			DATA +
			`<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="${X14}"><x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="${XM}">` +
			'<x14:cfRule type="expression" priority="2" id="{1}"><xm:f>A2&gt;Data!$B$1</xm:f></x14:cfRule><xm:sqref>A2:A4</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext>' +
			`<ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="${X14}"><x14:dataValidations count="1" xmlns:xm="${XM}"><x14:dataValidation type="list"><x14:formula1><xm:f>Data!$C$1:$C$3</xm:f></x14:formula1><xm:sqref>B2:B3</xm:sqref></x14:dataValidation></x14:dataValidations></ext>` +
			`<ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="${X14}"><x14:sparklineGroups xmlns:xm="${XM}"><x14:sparklineGroup><x14:sparklines>` +
			"<x14:sparkline><xm:f>Data!A1:C1</xm:f><xm:sqref>D1</xm:sqref></x14:sparkline><x14:sparkline><xm:f>Data!A2:C2</xm:f><xm:sqref>D2</xm:sqref></x14:sparkline>" +
			"</x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext></extLst>"
		const { sheet } = await edited(sheetBody(body), rows("insert", 0, 1), [
			"conditionalFormattingX14",
			"dataValidationsX14",
			"sparklines"
		])

		expect(sheet).toContain("<xm:f>A3&gt;Data!$B$2</xm:f></x14:cfRule><xm:sqref>A3:A5</xm:sqref>")
		expect(sheet).toContain("<xm:f>Data!$C$2:$C$4</xm:f></x14:formula1><xm:sqref>B3:B4</xm:sqref>")
		expect(sheet).toContain("<xm:f>Data!A2:C2</xm:f><xm:sqref>D2</xm:sqref>")

		const deleted = await edited(sheetBody(body), rows("delete", 1, 1), ["sparklines", "dataValidationsX14"])

		expect(deleted.sheet).toContain(
			"<x14:sparklines><x14:sparkline><xm:f>Data!A1:C1</xm:f><xm:sqref>D1</xm:sqref></x14:sparkline></x14:sparklines>"
		)
		expect(deleted.sheet).toContain("<xm:f>Data!$C$1:$C$2</xm:f></x14:formula1><xm:sqref>B2</xm:sqref>")
	})

	it("refuses extensions and sections it does not know", async () => {
		const unknownExt = `${DATA}<extLst><ext uri="{00000000-0000-0000-0000-000000000000}"><x:thing xmlns:x="urn:x" ref="A1"/></ext></extLst>`

		expect(await refused(sheetBody(unknownExt), rows("insert", 0))).toEqual({
			reason: "structureLocked",
			detail: "extension {00000000-0000-0000-0000-000000000000}"
		})
		expect(await refused(sheetBody(`${DATA}<odd/>`), rows("insert", 0))).toEqual({ reason: "structureLocked", detail: "section odd" })
		// An extension that holds no reference to cells does not stop the edit.
		await edited(sheetBody(`${DATA}<extLst><ext uri="{64002731-A6B0-56B0-2670-7721B7C09600}"><x/></ext></extLst>`), rows("insert", 0))
	})

	it("moves custom views, scenarios, consolidation sources, watches, smart tags and published items", async () => {
		const body =
			DATA +
			'<scenarios current="0" sqref="B2:B3"><scenario name="s" count="1"><inputCells r="B2" val="1"/></scenario></scenarios>' +
			'<dataConsolidate><dataRefs count="1"><dataRef ref="A2:A5" sheet="Data"/></dataRefs></dataConsolidate>' +
			'<customSheetViews><customSheetView guid="{1}" topLeftCell="A2"><pane ySplit="1" topLeftCell="A3" state="frozen"/><selection activeCell="A4" sqref="A4"/>' +
			'<rowBreaks count="1" manualBreakCount="1"><brk id="3" max="16383" man="1"/></rowBreaks><autoFilter ref="A1:B5"/></customSheetView></customSheetViews>' +
			'<cellWatches><cellWatch r="A3"/></cellWatches><smartTags><cellSmartTags r="A4"><cellSmartTag type="0"/></cellSmartTags></smartTags>' +
			'<webPublishItems count="1"><webPublishItem id="1" divId="d" sourceType="range" sourceRef="A1:B4" destinationFile="x.htm"/></webPublishItems>'
		const { sheet } = await edited(sheetBody(body), rows("insert", 0, 1), [
			"scenarios",
			"dataConsolidate",
			"customSheetViews",
			"cellWatches",
			"smartTags",
			"webPublishItems"
		])

		expect(sheet).toContain('<scenarios current="0" sqref="B3:B4"><scenario name="s" count="1"><inputCells r="B3" val="1"/>')
		expect(sheet).toContain('<dataRef ref="A3:A6" sheet="Data"/>')
		// The frozen row (row 2, counted from the view's topLeftCell) moves down with the rows inserted above it.
		expect(sheet).toContain(
			'<customSheetView guid="{1}" topLeftCell="A3"><pane ySplit="1" topLeftCell="A4" state="frozen"/><selection activeCell="A5" sqref="A5"/>'
		)
		expect(sheet).toContain('<brk id="4" max="16383" man="1"/></rowBreaks><autoFilter ref="A2:B6"/>')
		expect(sheet).toContain('<cellWatch r="A4"/>')
		expect(sheet).toContain('<cellSmartTags r="A5">')
		expect(sheet).toContain('sourceRef="A2:B5"')

		const renamed = await edited(
			sheetBody(body),
			workbook => ({ kind: "renameSheet", sheet: workbook.sheets[0]?.id ?? 0, name: "Data 2" }),
			["dataConsolidate"]
		)

		expect(renamed.sheet).toContain('<dataRef ref="A2:A5" sheet="Data 2"/>')
	})

	it("moves controls' anchors and linked cells", async () => {
		const xdr = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
		const body =
			DATA +
			`<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice Requires="x14"><controls><mc:AlternateContent><mc:Choice Requires="x14"><control shapeId="1025" r:id="rId1" name="Check 1">` +
			`<controlPr defaultSize="0" linkedCell="$A$3" listFillRange="Data!$B$2:$B$4"><anchor moveWithCells="1" sizeWithCells="1"><from><xdr:col xmlns:xdr="${xdr}">1</xdr:col><xdr:colOff xmlns:xdr="${xdr}">0</xdr:colOff><xdr:row xmlns:xdr="${xdr}">2</xdr:row><xdr:rowOff xmlns:xdr="${xdr}">0</xdr:rowOff></from>` +
			`<to><xdr:col xmlns:xdr="${xdr}">2</xdr:col><xdr:colOff xmlns:xdr="${xdr}">0</xdr:colOff><xdr:row xmlns:xdr="${xdr}">3</xdr:row><xdr:rowOff xmlns:xdr="${xdr}">5</xdr:rowOff></to></anchor></controlPr></control></mc:Choice></mc:AlternateContent></controls></mc:Choice></mc:AlternateContent>`
		const fixture: Fixture = {
			sheets: [{ name: "Data", body, rels: relationship("rId1", "ctrlProp", "../ctrlProps/ctrlProp1.xml") }],
			parts: {
				"xl/ctrlProps/ctrlProp1.xml": {
					text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<formControlPr xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" objectType="CheckBox" fmlaLink="$A$3"/>',
					type: TYPES.controlProperties
				}
			}
		}
		const { sheet, files } = await edited(fixture, rows("insert", 0, 2), ["controls", "formControls"])

		expect(sheet).toContain('linkedCell="$A$5" listFillRange="Data!$B$4:$B$6"')
		expect(sheet).toMatch(/<from><xdr:col[^>]*>1<\/xdr:col><xdr:colOff[^>]*>0<\/xdr:colOff><xdr:row[^>]*>4<\/xdr:row>/)
		expect(sheet).toMatch(/<to><xdr:col[^>]*>2<\/xdr:col><xdr:colOff[^>]*>0<\/xdr:colOff><xdr:row[^>]*>5<\/xdr:row>/)
		expect(files["xl/ctrlProps/ctrlProp1.xml"]).toContain('fmlaLink="$A$5"')
	})

	it("refuses an insert that would push cells off the sheet", async () => {
		expect(
			await refused(sheetBody('<sheetData><row r="1048576"><c r="A1048576"><v>1</v></c></row></sheetData>'), rows("insert", 0))
		).toEqual({
			reason: "tooLarge",
			detail: "cells"
		})
	})
})

describe("names", () => {
	it("refuses a workbook name with a reference to no sheet", async () => {
		const fixture: Fixture = {
			...sheetBody(DATA),
			workbookTail: '<definedNames><definedName name="rel">A1+1</definedName></definedNames>'
		}

		expect(await refused(fixture, rows("insert", 0), "definedNames")).toEqual({
			reason: "structureLocked",
			detail: "definedNames: rel"
		})
	})

	it("drops a deleted sheet's local names and breaks references to it", async () => {
		const fixture: Fixture = {
			sheets: [
				{ name: "Data", body: DATA },
				{ name: "Other", body: '<sheetData><row r="1"><c r="A1"><f>Data!A1+SUM(Data:Other!B2)</f><v>0</v></c></row></sheetData>' },
				{ name: "Last", body: "<sheetData/>" }
			],
			workbookTail:
				'<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$C$5</definedName><definedName name="g">Data!$B$2</definedName></definedNames>'
		}
		const { files } = await edited(fixture, { kind: "deleteSheet", sheet: 0 }, ["definedNames", "formulas"])

		expect(files["xl/workbook.xml"]).toContain('<definedNames><definedName name="g">#REF!$B$2</definedName></definedNames>')
		expect(files["xl/worksheets/sheet2.xml"]).toContain("<f>#REF!A1+SUM(Other!B2)</f>")
	})

	it("keeps a rewritten name's other attributes", async () => {
		const fixture: Fixture = {
			...sheetBody(DATA),
			workbookTail:
				'<definedNames><definedName name="g" comment="the input" description="d" function="1" vbProcedure="1" xlm="1" functionGroupId="14" shortcutKey="g" publishToServer="1">Data!$B$2</definedName></definedNames>'
		}
		const { files } = await edited(fixture, rows("insert", 0), ["definedNames"])

		expect(files["xl/workbook.xml"]).toContain(
			'<definedName name="g" comment="the input" description="d" function="1" vbProcedure="1" xlm="1" functionGroupId="14" shortcutKey="g" publishToServer="1">Data!$B$3</definedName>'
		)
	})
})

const xdr = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

function marker(name: string, col: number, row: number, rowOff = 0): string {
	return `<xdr:${name}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:${name}>`
}

const DRAWING =
	`${DECLARATION}<xdr:wsDr xmlns:xdr="${xdr}" xmlns:a="${A}" xmlns:r="${R}">` +
	`<xdr:twoCellAnchor>${marker("from", 1, 1)}${marker("to", 3, 4, 10)}<xdr:sp macro="" textlink="$A$3"><xdr:nvSpPr><xdr:cNvPr id="2" name="s"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>` +
	`<xdr:twoCellAnchor editAs="oneCell">${marker("from", 1, 6)}${marker("to", 3, 8)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="c"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>` +
	'<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="10" cy="10"/><xdr:sp macro=""><xdr:nvSpPr><xdr:cNvPr id="4" name="t"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp><xdr:clientData/></xdr:absoluteAnchor></xdr:wsDr>'
const CHART =
	`${DECLARATION}<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart><c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Data!$A$1</c:f></c:strRef></c:tx>` +
	"<c:cat><c:strRef><c:f>Data!$A$2:$A$5</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>(Data!$B$2:$B$3,Data!$B$5)</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>"

const OBJECTS: Fixture = {
	sheets: [
		{
			name: "Data",
			body: `${DATA}<drawing r:id="rId1"/>`,
			rels: relationship("rId1", "drawing", "../drawings/drawing1.xml")
		}
	],
	parts: {
		"xl/drawings/drawing1.xml": { text: DRAWING, type: TYPES.drawing },
		"xl/drawings/_rels/drawing1.xml.rels": {
			text: rels(relationship("rId1", "chart", "../charts/chart1.xml")),
			type: TYPES.relationships
		},
		"xl/charts/chart1.xml": { text: CHART, type: TYPES.chart }
	}
}

describe("drawings and charts", () => {
	it("moves anchors, text links and chart series formulas", async () => {
		const { files } = await edited(OBJECTS, rows("insert", 2, 2), ["drawingAnchors", "drawingTextLinks", "chartFormulas"])
		const drawing = files["xl/drawings/drawing1.xml"] ?? ""

		// The shape (two-cell) grows over the insert; the chart (one-cell) starts below it and moves; the absolute one stays.
		expect(drawing).toContain(`${marker("from", 1, 1)}${marker("to", 3, 6, 10)}`)
		expect(drawing).toContain('textlink="$A$5"')
		expect(drawing).toContain(`${marker("from", 1, 8)}${marker("to", 3, 10)}`)
		expect(drawing).toContain('<xdr:absoluteAnchor><xdr:pos x="0" y="0"/>')
		expect(files["xl/charts/chart1.xml"]).toContain("<c:f>Data!$A$2:$A$7</c:f>")
		expect(files["xl/charts/chart1.xml"]).toContain("<c:f>(Data!$B$2:$B$5,Data!$B$7)</c:f>")
	})

	it("breaks chart formulas into a deleted sheet", async () => {
		const fixture: Fixture = { ...OBJECTS, sheets: [{ name: "Chart", body: "<sheetData/>" }, ...OBJECTS.sheets] }
		const { files } = await edited(fixture, workbook => ({ kind: "deleteSheet", sheet: workbook.sheets[1]?.id ?? 1 }), [
			"chartFormulas"
		])

		expect(files["xl/charts/chart1.xml"]).toContain("<c:f>#REF!$A$2:$A$5</c:f>")
	})
})

const COMMENTS: Fixture = {
	sheets: [
		{
			name: "Data",
			body: `${DATA}<legacyDrawing r:id="rId2"/>`,
			rels:
				relationship("rId1", "comments", "../comments1.xml") +
				relationship("rId2", "vmlDrawing", "../drawings/vmlDrawing1.vml") +
				'<Relationship Id="rId3" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/>'
		}
	],
	parts: {
		"xl/comments1.xml": {
			text: `${DECLARATION}<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>a</author></authors><commentList><comment ref="B2" authorId="0"><text><t>one</t></text></comment><comment ref="B4" authorId="0"><text><t>two</t></text></comment></commentList></comments>`,
			type: TYPES.comments
		},
		"xl/drawings/vmlDrawing1.vml": {
			text:
				'<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
				'<v:shape id="_x0000_s1" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Anchor>2, 15, 0, 10, 4, 15, 4, 4</x:Anchor><x:Row>1</x:Row><x:Column>1</x:Column></x:ClientData></v:shape>' +
				'<v:shape id="_x0000_s2" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Anchor>2, 15, 2, 10, 4, 15, 6, 4</x:Anchor><x:Row>3</x:Row><x:Column>1</x:Column></x:ClientData></v:shape>' +
				'<v:shape id="_x0000_s3" type="#_x0000_t201"><x:ClientData ObjectType="Checkbox"><x:Anchor>5, 0, 5, 0, 6, 0, 6, 0</x:Anchor><x:FmlaLink>$A$5</x:FmlaLink></x:ClientData></v:shape></xml>',
			type: TYPES.vml
		},
		"xl/threadedComments/threadedComment1.xml": {
			text: `${DECLARATION}<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="B2" dT="2026-01-01T00:00:00.00" personId="{1}" id="{2}"><text>one</text></threadedComment><threadedComment ref="B4" dT="2026-01-01T00:00:00.00" personId="{1}" id="{3}"><text>two</text></threadedComment></ThreadedComments>`,
			type: TYPES.threaded
		}
	}
}

describe("comments", () => {
	it("moves notes, their shapes and threads; those of deleted cells go", async () => {
		const { files } = await edited(COMMENTS, rows("delete", 1, 1), ["comments", "commentShapes", "threadedComments"])

		expect(files["xl/comments1.xml"]).toContain('<commentList><comment ref="B3" authorId="0"><text><t>two</t>')
		expect(files["xl/comments1.xml"]).not.toContain(">one<")
		expect(files["xl/drawings/vmlDrawing1.vml"]).not.toContain("_x0000_s1")
		expect(files["xl/drawings/vmlDrawing1.vml"]).toContain("<x:Anchor>2, 15, 1, 10, 4, 15, 5, 4</x:Anchor><x:Row>2</x:Row>")
		expect(files["xl/drawings/vmlDrawing1.vml"]).toContain("<x:FmlaLink>$A$4</x:FmlaLink>")
		expect(files["xl/threadedComments/threadedComment1.xml"]).toContain('<threadedComment ref="B3"')
		expect(files["xl/threadedComments/threadedComment1.xml"]).not.toContain('ref="B2"')
	})
})

function tableXml(ref: string, columns: string[], extra = "", options = ""): string {
	return (
		`${DECLARATION}<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T1" displayName="T1" ref="${ref}"${options}>` +
		`<autoFilter ref="${ref}"/><tableColumns count="${columns.length}">${columns.join("")}</tableColumns><tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/>${extra}</table>`
	)
}

const TABLE_DATA =
	'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>A</t></is></c><c r="B1" t="inlineStr"><is><t>B</t></is></c><c r="C1" t="inlineStr"><is><t>C</t></is></c></row>' +
	'<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c><c r="C2"><f>T1[[#This Row],[A]]+T1[[#This Row],[B]]</f><v>3</v></c></row>' +
	'<row r="3"><c r="A3"><v>4</v></c><c r="B3"><v>5</v></c><c r="C3"><f>T1[[#This Row],[A]]+T1[[#This Row],[B]]</f><v>9</v></c></row>' +
	'<row r="5"><c r="E5"><f>SUM(T1[B])+SUM(T1[C])</f><v>0</v></c></row></sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts>'

function tables(table: string, sharedStrings?: string): Fixture {
	return {
		sheets: [{ name: "Data", body: TABLE_DATA, rels: relationship("rId1", "table", "../tables/table1.xml") }],
		...(sharedStrings !== undefined && { sharedStrings }),
		parts: { "xl/tables/table1.xml": { text: table, type: TYPES.table } }
	}
}

const COLUMNS = [
	'<tableColumn id="1" name="A"/>',
	'<tableColumn id="2" name="B"/>',
	'<tableColumn id="3" name="C"><calculatedColumnFormula>T1[[#This Row],[A]]+T1[[#This Row],[B]]</calculatedColumnFormula></tableColumn>'
]

describe("tables", () => {
	it("grow with rows inserted inside and move with rows inserted above", async () => {
		const grown = await edited(tables(tableXml("A1:C3", COLUMNS)), rows("insert", 2, 1), ["tables"])

		expect(grown.files["xl/tables/table1.xml"]).toContain('ref="A1:C4"><autoFilter ref="A1:C4"/>')

		const moved = await edited(tables(tableXml("A1:C3", COLUMNS)), rows("insert", 0, 2), ["tables"])

		expect(moved.files["xl/tables/table1.xml"]).toContain('ref="A3:C5"><autoFilter ref="A3:C5"/>')
	})

	it("get a new named column, with its header cell, for a column inserted inside", async () => {
		const { files, sheet } = await edited(
			tables(tableXml("A1:C3", COLUMNS)),
			cols("insert", 1, 1),
			["tables", "tableColumns", "cells"],
			["xl/sharedStrings.xml"]
		)

		expect(files["xl/tables/table1.xml"]).toContain(
			'<tableColumns count="4"><tableColumn id="1" name="A"/><tableColumn id="4" name="Column1"/><tableColumn id="2" name="B"/>'
		)
		expect(files["xl/tables/table1.xml"]).toContain('ref="A1:D3"')
		// The header cell names the column, through the shared strings.
		expect(sheet).toMatch(/<c r="B1" t="s"><v>(\d+)<\/v><\/c>/)
		expect(files["xl/sharedStrings.xml"]).toContain("<t>Column1</t>")
	})

	it("lose a deleted column, and references to it break", async () => {
		const { files, sheet } = await edited(tables(tableXml("A1:C3", COLUMNS)), cols("delete", 1, 1), [
			"tableColumns",
			"structuredReferences"
		])

		expect(files["xl/tables/table1.xml"]).toContain(
			'<tableColumns count="2"><tableColumn id="1" name="A"/><tableColumn id="3" name="C"><calculatedColumnFormula>T1[[#This Row],[A]]+#REF!</calculatedColumnFormula>'
		)
		expect(sheet).toContain("<f>T1[[#This Row],[A]]+#REF!</f>")
		expect(sheet).toContain("<f>SUM(#REF!)+SUM(T1[C])</f>")
	})

	it("go when every row is deleted, with their part and relationship", async () => {
		const { files, sheet, workbook } = await edited(tables(tableXml("A1:C3", COLUMNS)), rows("delete", 0, 3), [
			"tables",
			"structuredReferences"
		])

		expect(files["xl/tables/table1.xml"]).toBeUndefined()
		expect(sheet).not.toContain("tableParts")
		expect(sheet).toContain("<f>SUM(#REF!)+SUM(#REF!)</f>")
		expect(workbook.sheets[0]?.name).toBe("Data")
	})

	it("go together when one delete takes several, the others kept", async () => {
		const table = (id: number, col: string) =>
			`${DECLARATION}<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${String(id)}" name="T${String(id)}" displayName="T${String(id)}" ref="${col}1:${col}2">` +
			`<autoFilter ref="${col}1:${col}2"/><tableColumns count="1"><tableColumn id="1" name="H${String(id)}"/></tableColumns></table>`
		const header = (col: string, id: number) => `<c r="${col}1" t="inlineStr"><is><t>H${String(id)}</t></is></c>`
		const fixture: Fixture = {
			sheets: [
				{
					name: "Data",
					body:
						`<sheetData><row r="1">${header("A", 1)}${header("B", 2)}${header("D", 3)}</row>` +
						'<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c><c r="D2"><v>3</v></c></row></sheetData>' +
						'<tableParts count="3"><tablePart r:id="rId1"/><tablePart r:id="rId2"/><tablePart r:id="rId3"/></tableParts>',
					rels:
						relationship("rId1", "table", "../tables/table1.xml") +
						relationship("rId2", "table", "../tables/table2.xml") +
						relationship("rId3", "table", "../tables/table3.xml")
				}
			],
			parts: {
				"xl/tables/table1.xml": { text: table(1, "A"), type: TYPES.table },
				"xl/tables/table2.xml": { text: table(2, "B"), type: TYPES.table },
				"xl/tables/table3.xml": { text: table(3, "D"), type: TYPES.table }
			}
		}
		const { files, sheet } = await edited(fixture, cols("delete", 0, 2), ["tables"])

		expect(files["xl/tables/table1.xml"]).toBeUndefined()
		expect(files["xl/tables/table2.xml"]).toBeUndefined()
		expect(files["xl/tables/table3.xml"]).toContain('ref="B1:B2"')
		expect(sheet).toContain('<tableParts count="1"><tablePart r:id="rId3"/></tableParts>')
		expect(files["xl/worksheets/_rels/sheet1.xml.rels"]).not.toMatch(/rId1|rId2/)
		expect(files["[Content_Types].xml"]).not.toMatch(/table1\.xml|table2\.xml/)
	})

	it("refuse deleting the header row, the totals row or every data row alone", async () => {
		expect(await refused(tables(tableXml("A1:C3", COLUMNS)), rows("delete", 0, 1))).toEqual({
			reason: "structureLocked",
			detail: "tables: header row"
		})
		expect(await refused(tables(tableXml("A1:C3", COLUMNS)), rows("delete", 1, 2))).toEqual({
			reason: "structureLocked",
			detail: "tables: every data row"
		})
		expect(await refused(tables(tableXml("A1:C4", COLUMNS, "", ' totalsRowCount="1"')), rows("delete", 3, 1))).toEqual({
			reason: "structureLocked",
			detail: "tables: totals row"
		})
	})

	it("with a query table refuse columns added or removed", async () => {
		const fixture = tables(tableXml("A1:C3", COLUMNS, "", ' tableType="queryTable"'))
		const withQuery: Fixture = {
			...fixture,
			parts: {
				...fixture.parts,
				"xl/tables/_rels/table1.xml.rels": {
					text: rels(relationship("rId1", "queryTable", "../queryTables/queryTable1.xml")),
					type: TYPES.relationships
				},
				"xl/queryTables/queryTable1.xml": {
					text: `${DECLARATION}<queryTable xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="q" connectionId="1"/>`,
					type: TYPES.queryTable
				}
			}
		}

		expect(await refused(withQuery, cols("delete", 1, 1), "queryTables")).toEqual({ reason: "structureLocked", detail: "queryTables" })
	})
})

describe("pivots, slicers, timelines", () => {
	const cache = (ref: string, sheet: string) =>
		`${DECLARATION}<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}" r:id="rId1"><cacheSource type="worksheet"><worksheetSource ref="${ref}" sheet="${sheet}"/></cacheSource><cacheFields count="0"/></pivotCacheDefinition>`
	const pivot = {
		sheets: [
			{ name: "Data", body: DATA },
			{ name: "Pivot", body: "<sheetData/>", rels: relationship("rId1", "pivotTable", "../pivotTables/pivotTable1.xml") }
		],
		parts: {
			"xl/pivotCache/pivotCacheDefinition1.xml": { text: cache("A1:B5", "Data"), type: TYPES.pivotCache },
			"xl/pivotTables/pivotTable1.xml": {
				text: `${DECLARATION}<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="P1" cacheId="1" dataCaption="Values"><location ref="B3:C9" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/></pivotTableDefinition>`,
				type: TYPES.pivotTable
			}
		}
	} satisfies Fixture

	it("lock a pivot cache's source and a pivot table's location", async () => {
		expect(await refused(pivot, rows("insert", 2), "pivotSources")).toEqual({ reason: "pivot", detail: "pivotSources" })
		expect(await refused(pivot, rows("insert", 1, 1, 1), "pivotTables")).toEqual({ reason: "pivot", detail: "pivotTables" })
		expect(await refused(pivot, { kind: "deleteSheet", sheet: 0 })).toEqual({ reason: "pivot", detail: "pivotSources: sheet deleted" })

		// Below both: allowed.
		await edited(pivot, rows("insert", 10, 1, 1), [])
		await edited(pivot, cols("insert", 5, 1), [])
	})

	it("rename a pivot cache's source sheet", async () => {
		const { files } = await edited(pivot, { kind: "renameSheet", sheet: 0, name: "Source" }, ["pivotSources"])

		expect(files["xl/pivotCache/pivotCacheDefinition1.xml"]).toContain('<worksheetSource ref="A1:B5" sheet="Source"/>')
	})

	it("refuse removing what a slicer or timeline reads", async () => {
		const slicer = (body: string) =>
			`${DECLARATION}<slicerCacheDefinition xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" name="S" sourceName="B">${body}</slicerCacheDefinition>`
		const withSlicer = (body: string, type: string = TYPES.slicerCache): Fixture => {
			const base = tables(tableXml("A1:C3", COLUMNS))

			return {
				...base,
				sheets: [...base.sheets, { name: "Other", body: "<sheetData/>" }],
				parts: { ...base.parts, "xl/slicerCaches/slicerCache1.xml": { text: slicer(body), type } }
			}
		}
		const tableSlicer = withSlicer(
			'<extLst><ext uri="{2F2917AC-EB37-4324-AD4E-5DD8C200BD13}"><x15:tableSlicerCache tableId="1" column="2"/></ext></extLst>'
		)

		expect(await refused(tableSlicer, cols("delete", 1, 1), "slicerSources")).toEqual({
			reason: "structureLocked",
			detail: "slicerSources"
		})
		await edited(tableSlicer, cols("delete", 2, 1), ["slicerSources"])

		const pivotSlicer = withSlicer('<pivotTables><pivotTable tabId="2" name="P1"/></pivotTables>')

		expect(await refused(pivotSlicer, { kind: "deleteSheet", sheet: 1 })).toEqual({
			reason: "structureLocked",
			detail: "slicerSources"
		})

		const timeline = withSlicer('<pivotTables><pivotTable tabId="2" name="P1"/></pivotTables>', TYPES.timelineCache)

		expect(await refused(timeline, { kind: "deleteSheet", sheet: 1 }, "timelineSources")).toEqual({
			reason: "structureLocked",
			detail: "timelineSources"
		})
	})
})

describe("workbook parts", () => {
	it("move query parameters, real-time data cells and mapped single cells; leave external links", async () => {
		const fixture: Fixture = {
			sheets: [
				{
					name: "Data",
					body: '<sheetData><row r="1"><c r="A1"><f>[1]Data!A1+A2</f><v>0</v></c></row></sheetData>',
					rels: relationship("rId1", "tableSingleCells", "../tables/tableSingleCells1.xml")
				}
			],
			parts: {
				"xl/connections.xml": {
					text: `${DECLARATION}<connections xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><connection id="1" name="c" type="4"><webPr url="x"/><parameters count="1"><parameter name="p" parameterType="cell" cell="Data!$B$3"/></parameters></connection></connections>`,
					type: TYPES.connections
				},
				"xl/volatileDependencies.xml": {
					text: `${DECLARATION}<volTypes xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><volType type="realTimeData"><main first="x"><tp><v>1</v><stp>a</stp><tr r="C4" s="1"/></tp></main></volType></volTypes>`,
					type: TYPES.volatile
				},
				"xl/tables/tableSingleCells1.xml": {
					text: `${DECLARATION}<singleXmlCells xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><singleXmlCell id="1" r="D5" connectionId="0"><xmlCellPr id="1" uniqueName="u"><xmlPr mapId="1" xpath="/a" xmlDataType="string"/></xmlCellPr></singleXmlCell></singleXmlCells>`,
					type: TYPES.singleCells
				},
				"xl/externalLinks/externalLink1.xml": {
					text: `${DECLARATION}<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><externalBook xmlns:r="${R}" r:id="rId1"><sheetNames><sheetName val="Data"/></sheetNames></externalBook></externalLink>`,
					type: TYPES.externalLink
				}
			},
			calcChain: true
		}
		const { files, sheet } = await edited(fixture, rows("insert", 0, 1), [
			"connections",
			"volatileDependencies",
			"singleXmlCells",
			"externalLinks",
			"calcChain"
		])

		expect(files["xl/connections.xml"]).toContain('cell="Data!$B$4"')
		expect(files["xl/volatileDependencies.xml"]).toContain('<tr r="C5" s="1"/>')
		expect(files["xl/tables/tableSingleCells1.xml"]).toContain('r="D6"')
		expect(sheet).toContain("<f>[1]Data!A1+A3</f>")
		expect(files["xl/calcChain.xml"]).toBeUndefined()
	})

	it("moves a query parameter whose sheet name is written with an entity", async () => {
		const fixture: Fixture = {
			sheets: [{ name: "R&amp;D", body: DATA }],
			parts: {
				"xl/connections.xml": {
					text: `${DECLARATION}<connections xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><connection id="1" name="c" type="4"><webPr url="x"/><parameters count="1"><parameter name="p" parameterType="cell" cell="'R&amp;D'!$B$3"/></parameters></connection></connections>`,
					type: TYPES.connections
				}
			}
		}
		const { files } = await edited(fixture, rows("insert", 0, 1), ["connections"])

		expect(files["xl/connections.xml"]).toContain('cell="&apos;R&amp;D&apos;!$B$4"')
	})

	it("refuses parts it does not know and shared workbook revisions", async () => {
		const unknown: Fixture = {
			...sheetBody(DATA),
			parts: { "xl/odd.xml": { text: "<odd/>", type: "application/vnd.example.odd+xml" } }
		}

		expect(await refused(unknown, rows("insert", 0))).toEqual({
			reason: "structureLocked",
			detail: "part application/vnd.example.odd+xml"
		})

		const revisions: Fixture = {
			...sheetBody(DATA),
			parts: {
				"xl/revisions/revisionHeaders.xml": {
					text: "<headers/>",
					type: "application/vnd.openxmlformats-officedocument.spreadsheetml.revisionHeaders+xml"
				}
			}
		}

		expect(await refused(revisions, rows("insert", 0))).toEqual({ reason: "structureLocked", detail: "revisions" })
	})
})

describe("sheet operations", () => {
	it("renames and moves sheets in formulas, names and validations of every sheet", async () => {
		const fixture: Fixture = {
			sheets: [
				{ name: "Jan", body: DATA },
				{
					name: "Feb",
					body:
						'<sheetData><row r="1"><c r="A1"><f>Jan!A1+SUM(Jan:Mar!A1)</f><v>0</v></c></row></sheetData>' +
						'<dataValidations count="1"><dataValidation type="list" sqref="B1"><formula1>Jan!$A$1:$A$3</formula1></dataValidation></dataValidations>'
				},
				{ name: "Mar", body: "<sheetData/>" }
			],
			workbookTail: '<definedNames><definedName name="n">Jan!$A$1</definedName></definedNames>'
		}
		const renamed = await edited(fixture, { kind: "renameSheet", sheet: 0, name: "January 2026" }, [
			"formulas",
			"dataValidations",
			"definedNames"
		])

		expect(renamed.files["xl/worksheets/sheet2.xml"]).toContain("<f>'January 2026'!A1+SUM('January 2026:Mar'!A1)</f>")
		expect(renamed.files["xl/worksheets/sheet2.xml"]).toContain("<formula1>'January 2026'!$A$1:$A$3</formula1>")
		expect(renamed.files["xl/workbook.xml"]).toContain(">'January 2026'!$A$1</definedName>")

		const moved = await edited(fixture, { kind: "moveSheet", sheet: 0, to: 2 }, ["formulas"])

		expect(moved.files["xl/worksheets/sheet2.xml"]).toContain("<f>Jan!A1+SUM('Mar:Jan'!A1)</f>")
	})
})

describe("the catalogue", () => {
	it("has a test for every entry", () => {
		expect(REF_CONSTRUCTS.filter(construct => !covered.has(construct))).toEqual([])
	})
})

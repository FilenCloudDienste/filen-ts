import { describe, expect, it } from "vitest"
import { CellFlag, type SheetRenderStyle, type SheetStyleAppend, type SheetTile } from "../core/sheet/protocol"
import { ICON_SETS } from "../core/sheet/cf/layers"
import { inThreadSheetHost } from "../dom/sheet/host"
import { IMMEDIATE, STYLES_WITH, cells, tileEntry } from "./sheetCfFixtures"
import { buildFixture, type Fixture } from "./xlsxWriteFixtures"
import { changeOf } from "./sheetSessionFixtures"

// Conditional formats on a session's tiles: each rule type's look, priorities and stopIfTrue, number formats in
// rules, data bars and icons, and tiles patched when a value a rule reads changes elsewhere.

class Looks {
	private readonly styles: SheetRenderStyle[] = []

	add(append: SheetStyleAppend | undefined): void {
		if (append === undefined) return

		append.styles.forEach((style, i) => {
			this.styles[append.from + i] = style
		})
	}

	of(tile: SheetTile, row: number, col: number): SheetRenderStyle {
		return this.styles[tileEntry(tile, row, col)?.style ?? 0] ?? {}
	}
}

async function open(fixture: Fixture) {
	const host = inThreadSheetHost()
	const result = await host.open(
		buildFixture(fixture),
		{ kind: "xlsx", slicing: IMMEDIATE, settings: { clock: () => Date.UTC(2023, 2, 15, 12) } },
		() => undefined
	)

	if (result.kind !== "opened") throw new Error(result.kind)

	const looks = new Looks()

	looks.add(result.info.styles)

	const sheet = result.info.sheets[0]?.id ?? 0

	// Formats show once the sheet is parsed (its preview rows show without them) and the statistics its rules need
	// are computed (in turns of their own).
	await result.session.layout(sheet)
	await new Promise(resolve => setTimeout(resolve, 0))

	const tile = async (tileRow = 0, tileCol = 0): Promise<SheetTile> => {
		const { tiles, styles } = await result.session.tiles(sheet, Uint32Array.of(tileRow, tileCol))

		looks.add(styles)

		return tiles[0] as SheetTile
	}

	return { session: result.session, sheet, tile, looks }
}

const RED = '<dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf>'
const GREEN = '<dxf><font><color rgb="FF006100"/></font><fill><patternFill><bgColor rgb="FFC6EFCE"/></patternFill></fill></dxf>'
const PERCENT = '<dxf><numFmt numFmtId="164" formatCode="0.0%"/></dxf>'

function column(values: readonly (number | string)[], col = "A"): string {
	return values
		.map(
			(value, i) =>
				`<row r="${String(i + 1)}"><c r="${col}${String(i + 1)}"${typeof value === "string" ? ' t="inlineStr"' : ""}>${typeof value === "string" ? `<is><t>${value}</t></is>` : `<v>${String(value)}</v>`}</c></row>`
		)
		.join("")
}

function sheet(rows: string, after: string): Fixture {
	return { sheets: [{ name: "One", body: `<sheetData>${rows}</sheetData>${after}` }], styles: STYLES_WITH([RED, GREEN, PERCENT]) }
}

describe("conditional formats on tiles", () => {
	it("applies a cell value rule's font and fill (a dxf's solid fill is its bgColor)", async () => {
		const { tile, looks, session } = await open(
			sheet(
				column([1, 7, 3]),
				'<conditionalFormatting sqref="A1:A3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>5</formula></cfRule></conditionalFormatting>'
			)
		)
		const first = await tile()

		expect(looks.of(first, 1, 0)).toMatchObject({ bold: true, color: 0x9c0006, fill: 0xffc7ce })
		expect(looks.of(first, 0, 0).fill).toBeUndefined()
		session.close()
	})

	it("applies the higher priority rule's properties first and stops at stopIfTrue", async () => {
		const { tile, looks, session } = await open(
			sheet(
				column([10, 4]),
				'<conditionalFormatting sqref="A1:A2"><cfRule type="cellIs" dxfId="1" priority="2" operator="greaterThan"><formula>3</formula></cfRule>' +
					'<cfRule type="cellIs" dxfId="0" priority="1" stopIfTrue="1" operator="greaterThan"><formula>5</formula></cfRule></conditionalFormatting>'
			)
		)
		const first = await tile()

		// A1 holds the first rule, which stops the second.
		expect(looks.of(first, 0, 0)).toMatchObject({ bold: true, fill: 0xffc7ce })
		expect(looks.of(first, 1, 0)).toMatchObject({ color: 0x006100, fill: 0xc6efce })
		session.close()
	})

	it("moves an expression's relative references with the cell", async () => {
		const { tile, looks, session } = await open(
			sheet(
				'<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>0</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>1</v></c></row>',
				'<conditionalFormatting sqref="A1:A2"><cfRule type="expression" dxfId="0" priority="1"><formula>$B1=1</formula></cfRule></conditionalFormatting>'
			)
		)
		const first = await tile()

		expect(looks.of(first, 0, 0).fill).toBeUndefined()
		expect(looks.of(first, 1, 0).fill).toBe(0xffc7ce)
		session.close()
	})

	it("reads a formula as written for the top-left cell around the rule's ranges, whatever their order", async () => {
		const { tile, looks, session } = await open(
			sheet(
				'<row r="1"><c r="B1"><v>1</v></c></row><row r="5"><c r="B5"><v>1</v></c></row><row r="6"><c r="B6"><v>0</v></c></row>',
				'<conditionalFormatting sqref="A5:A6 A1:A2"><cfRule type="expression" dxfId="0" priority="1"><formula>$B1=1</formula></cfRule></conditionalFormatting>'
			)
		)
		const first = await tile()

		expect(looks.of(first, 0, 0).fill).toBe(0xffc7ce)
		expect(looks.of(first, 1, 0).fill).toBeUndefined()
		expect(looks.of(first, 4, 0).fill).toBe(0xffc7ce)
		expect(looks.of(first, 5, 0).fill).toBeUndefined()
		session.close()
	})

	it("tests text, blanks and dates with Excel's formulas when the file writes none", async () => {
		const { tile, looks, session } = await open(
			sheet(
				column(["Apples", "pears", "  "]) + '<row r="4"><c r="A4"><v>45000.6</v></c></row>',
				'<conditionalFormatting sqref="A1:A4"><cfRule type="containsText" dxfId="0" priority="1" operator="containsText" text="PP"/>' +
					'<cfRule type="containsBlanks" dxfId="1" priority="2"/><cfRule type="timePeriod" dxfId="1" priority="3" timePeriod="today"/></conditionalFormatting>'
			)
		)
		const first = await tile()

		expect(looks.of(first, 0, 0).fill).toBe(0xffc7ce)
		expect(looks.of(first, 1, 0).fill).toBeUndefined()
		expect(looks.of(first, 2, 0).fill).toBe(0xc6efce)
		expect(looks.of(first, 3, 0).fill).toBe(0xc6efce)
		// A blank cell the rule covers is drawn too.
		expect(looks.of(first, 4, 0).fill).toBeUndefined()
		session.close()
	})

	it("ranks top and bottom values, averages and duplicates over the rule's range", async () => {
		const { tile, looks, session } = await open(
			sheet(
				column([5, 9, 9, 1, 3, "x"]),
				'<conditionalFormatting sqref="A1:A6"><cfRule type="top10" dxfId="0" priority="1" rank="1"/></conditionalFormatting>' +
					'<conditionalFormatting sqref="A1:A6"><cfRule type="aboveAverage" dxfId="1" priority="2" aboveAverage="0"/></conditionalFormatting>' +
					'<conditionalFormatting sqref="A1:A6"><cfRule type="duplicateValues" dxfId="2" priority="3"/></conditionalFormatting>'
			)
		)
		const first = await tile()

		// Both 9s are the top one (ties count).
		expect(looks.of(first, 1, 0).fill).toBe(0xffc7ce)
		expect(looks.of(first, 2, 0).fill).toBe(0xffc7ce)
		// Below the average of 5.4 (text is not counted).
		expect(looks.of(first, 0, 0).fill).toBe(0xc6efce)
		expect(looks.of(first, 3, 0).fill).toBe(0xc6efce)
		expect(looks.of(first, 4, 0).fill).toBe(0xc6efce)
		// A duplicate takes the third rule's number format too.
		expect(tileEntry(first, 1, 0)?.text).toBe("900.0%")
		expect(tileEntry(first, 1, 0)?.input).toBe("9")
		session.close()
	})

	it("shows a value through a rule's number format, out of the General layer", async () => {
		const { tile, session } = await open(
			sheet(
				column([0.25, 3]),
				'<conditionalFormatting sqref="A1"><cfRule type="cellIs" dxfId="2" priority="1" operator="lessThan"><formula>1</formula></cfRule></conditionalFormatting>'
			)
		)
		const first = await tile()

		expect(tileEntry(first, 0, 0)?.text).toBe("25.0%")
		expect(tileEntry(first, 0, 0)?.input).toBe("0.25")
		expect([...(first.layers?.general?.entries ?? [])].map(entry => first.positions[entry])).toEqual([32])
		session.close()
	})

	it("fills a colour scale's cells between its colours", async () => {
		const { tile, looks, session } = await open(
			sheet(
				column([0, 50, 100]),
				'<conditionalFormatting sqref="A1:A3"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/>' +
					'<color rgb="FFFFFFFF"/><color rgb="FFFF0000"/></colorScale></cfRule></conditionalFormatting>'
			)
		)
		const first = await tile()

		expect(looks.of(first, 0, 0).fill).toBe(0xffffff)
		expect(looks.of(first, 1, 0).fill).toBe(0xff8080)
		expect(looks.of(first, 2, 0).fill).toBe(0xff0000)
		session.close()
	})

	it("lays out data bars, a 2010 bar's negative values from its axis", async () => {
		const { tile, session } = await open(
			sheet(
				column([-5, 0, 5, 10]),
				'<conditionalFormatting sqref="A1:A4"><cfRule type="dataBar" priority="1"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar>' +
					'<extLst><ext uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:id>{00000000-0000-0000-0000-000000000001}</x14:id></ext></extLst>' +
					"</cfRule></conditionalFormatting>" +
					'<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">' +
					'<x14:conditionalFormattings><x14:conditionalFormatting><x14:cfRule type="dataBar" id="{00000000-0000-0000-0000-000000000001}">' +
					'<x14:dataBar minLength="0" maxLength="100" gradient="0" negativeBarColorSameAsPositive="0" axisPosition="automatic"><x14:cfvo type="autoMin"/><x14:cfvo type="autoMax"/>' +
					'<x14:negativeFillColor rgb="FFFF0000"/><x14:axisColor rgb="FF000000"/></x14:dataBar></x14:cfRule><xm:sqref>A1:A4</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst>'
			)
		)
		const first = await tile()
		const bars = first.layers?.cfBars

		expect(bars?.entries.length).toBe(4)
		expect((tileEntry(first, 0, 0)?.flags ?? 0) & CellFlag.CF_BAR).not.toBe(0)

		const at = (row: number) => {
			const k = [...(bars?.entries ?? [])].findIndex(entry => first.positions[entry] === row * 32)

			return { start: bars?.starts[k], end: bars?.ends[k], axis: bars?.axes[k], fill: bars?.fills[k], flags: bars?.flags[k] }
		}

		// The axis a third of the way in (0 between -5 and 10).
		expect(at(0).axis).toBeCloseTo(1 / 3)
		expect(at(0)).toMatchObject({ start: 0, fill: 0xff0000, flags: 0 })
		expect(at(0).end).toBeCloseTo(1 / 3)
		expect(at(3).start).toBeCloseTo(1 / 3)
		expect(at(3).end).toBeCloseTo(1)
		expect(at(2).end).toBeCloseTo(2 / 3)
		session.close()
	})

	it("gives icons by threshold, hiding the value but keeping it to edit", async () => {
		const { tile, session } = await open(
			sheet(
				column([0, 40, 80]),
				'<conditionalFormatting sqref="A1:A3"><cfRule type="iconSet" priority="1"><iconSet iconSet="3Arrows" showValue="0">' +
					'<cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule></conditionalFormatting>'
			)
		)
		const first = await tile()
		const icons = first.layers?.cfIcons

		expect([...(icons?.icons ?? [])]).toEqual([0, 1, 2])
		expect([...(icons?.sets ?? [])].map(set => ICON_SETS[set])).toEqual(["3Arrows", "3Arrows", "3Arrows"])
		expect(tileEntry(first, 1, 0)?.text).toBe("")
		expect(tileEntry(first, 1, 0)?.input).toBe("40")
		session.close()
	})

	it("patches the other tiles of a rule's range when a value it ranks changes", async () => {
		const values = Array.from({ length: 100 }, (_, i) => i + 1)
		const {
			session,
			sheet: id,
			tile,
			looks
		} = await open(
			sheet(
				column(values),
				'<conditionalFormatting sqref="A1:A100"><cfRule type="top10" dxfId="0" priority="1" rank="1"/></conditionalFormatting>'
			)
		)
		const lower = await tile(1, 0)

		await tile(0, 0)
		expect(looks.of(lower, 99, 0).fill).toBe(0xffc7ce)

		const change = changeOf(await session.command({ type: "cells.set", sheet: id, cells: cells([[0, 0, "1000"]]) }))
		const patched = change.patches.find(patch => patch.tileRow === 1)

		looks.add(change.styles)
		expect(patched).toBeDefined()
		expect(looks.of(patched as SheetTile, 99, 0).fill).toBeUndefined()

		const undone = changeOf(await session.undo())
		const back = undone.patches.find(patch => patch.tileRow === 1)

		looks.add(undone.styles)
		expect(looks.of(back as SheetTile, 99, 0).fill).toBe(0xffc7ce)
		session.close()
	})

	it("reads other sheets through names, once they are read, and leaves a rule it cannot calculate unapplied", async () => {
		const { tile, looks, session } = await open({
			sheets: [
				{
					name: "One",
					body:
						"<sheetData>" +
						column([1, 2]) +
						"</sheetData>" +
						'<conditionalFormatting sqref="A1"><cfRule type="expression" dxfId="0" priority="1"><formula>STATUS="Empty"</formula></cfRule></conditionalFormatting>' +
						'<conditionalFormatting sqref="A2"><cfRule type="expression" dxfId="1" priority="2"><formula>WEBSERVICE("https://example.com")="x"</formula></cfRule></conditionalFormatting>'
				},
				{ name: "Checks", body: '<sheetData><row r="2"><c r="M2" t="inlineStr"><is><t>Empty</t></is></c></row></sheetData>' }
			],
			styles: STYLES_WITH([RED, GREEN, PERCENT]),
			workbookTail: '<definedNames><definedName name="STATUS">Checks!$M$2</definedName></definedNames>'
		})
		const first = await tile()

		expect(looks.of(first, 0, 0).fill).toBe(0xffc7ce)
		expect(looks.of(first, 1, 0).fill).toBeUndefined()
		session.close()
	})

	it("keeps a number format's colour over a rule's font colour, and draws a rule's borders", async () => {
		const { tile, looks, session } = await open({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1" s="2"><v>-4</v></c><c r="B1"><v>4</v></c></row></sheetData>' +
						'<conditionalFormatting sqref="A1:B1"><cfRule type="cellIs" dxfId="0" priority="1" operator="notEqual"><formula>0</formula></cfRule></conditionalFormatting>'
				}
			],
			styles: STYLES_WITH([
				'<dxf><font><color rgb="FF0000FF"/></font><border><bottom style="thick"><color rgb="FF00FF00"/></bottom></border></dxf>'
			])
				.replace(
					'<cellXfs count="2">',
					'<numFmts count="1"><numFmt numFmtId="164" formatCode="0;[Red]-0"/></numFmts><cellXfs count="3">'
				)
				.replace("</cellXfs>", '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>')
		})
		const first = await tile()

		expect(looks.of(first, 0, 0).color).toBe(0xff0000)
		expect(looks.of(first, 0, 1).color).toBe(0x0000ff)
		expect(looks.of(first, 0, 1).bottom).toEqual({ style: "thick", color: 0x00ff00 })
		session.close()
	})

	it("moves the formats with an inserted row", async () => {
		const {
			session,
			sheet: id,
			tile,
			looks
		} = await open(
			sheet(
				column([1, 7]),
				'<conditionalFormatting sqref="A1:A2"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>5</formula></cfRule></conditionalFormatting>'
			)
		)

		await tile()
		changeOf(await session.command({ type: "axis.insert", sheet: id, axis: "rows", at: 0, count: 1 }))

		const moved = await tile()

		expect(looks.of(moved, 2, 0).fill).toBe(0xffc7ce)
		expect(looks.of(moved, 1, 0).fill).toBeUndefined()
		session.close()
	})

	it("applies rules over a hostile number of ranges within a budget of rules times ranges", async () => {
		// 100,000 ranges (A1 A3 A5 ...) and 2,000 rules: past the budget, rules beyond it are not read.
		const sqref = Array.from({ length: 100_000 }, (_, i) => `A${String(i * 2 + 1)}`).join(" ")
		const rules = Array.from(
			{ length: 2_000 },
			(_, i) => `<cfRule type="expression" dxfId="0" priority="${String(i + 1)}"><formula>$B1=1</formula></cfRule>`
		).join("")
		const { tile, looks, session } = await open(
			sheet(
				'<row r="1"><c r="B1"><v>1</v></c></row><row r="3"><c r="B3"><v>0</v></c></row>',
				`<conditionalFormatting sqref="${sqref}">${rules}</conditionalFormatting>`
			)
		)
		const first = await tile()

		expect(looks.of(first, 0, 0).fill).toBe(0xffc7ce)
		expect(looks.of(first, 2, 0).fill).toBeUndefined()
		session.close()
	})

	it("keeps every rule over a few thousand ranges, and repaints what they read from around the ranges", async () => {
		// 3,000 ranges (A1 A3 ... A5999): more than a rule's reach is kept per range for.
		const sqref = Array.from({ length: 3_000 }, (_, i) => `A${String(i * 2 + 1)}`).join(" ")
		const {
			session,
			sheet: id,
			tile,
			looks
		} = await open(
			sheet(
				'<row r="1"><c r="A1"><v>0.5</v></c><c r="B1"><v>1</v></c><c r="D1"><v>1</v></c></row><row r="65"><c r="C65"><v>1</v></c></row>' +
					'<row r="67"><c r="B67"><v>0</v></c></row>',
				`<conditionalFormatting sqref="${sqref}">` +
					'<cfRule type="expression" dxfId="0" priority="1"><formula>$B1=1</formula></cfRule>' +
					'<cfRule type="expression" dxfId="1" priority="2"><formula>$C1=1</formula></cfRule>' +
					'<cfRule type="expression" dxfId="2" priority="3"><formula>$D1=1</formula></cfRule></conditionalFormatting>'
			)
		)
		const top = await tile(0, 0)
		const lower = await tile(1, 0)

		expect(looks.of(top, 0, 0)).toMatchObject({ bold: true, fill: 0xffc7ce })
		expect(tileEntry(top, 0, 0)?.text).toBe("50.0%")
		expect(looks.of(lower, 64, 0)).toMatchObject({ color: 0x006100, fill: 0xc6efce })
		expect(looks.of(lower, 66, 0).fill).toBeUndefined()

		const change = changeOf(await session.command({ type: "cells.set", sheet: id, cells: cells([[66, 1, "1"]]) }))
		const patched = change.patches.find(patch => patch.tileRow === 1)

		looks.add(change.styles)
		expect(patched).toBeDefined()
		expect(looks.of(patched as SheetTile, 66, 0).fill).toBe(0xffc7ce)
		session.close()
	})
})

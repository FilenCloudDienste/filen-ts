import { describe, expect, it } from "vitest"
import { axisMoveOrder, orderedAxisSpans } from "../core/sheet/axisSpans"
import { SHEET_MAX_ROWS, type SheetChange, type SheetCommandResult } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { parts, type FixtureSheet } from "./xlsxWriteFixtures"
import { IMMEDIATE, firstTile, openFixture, savedBytes, tileTexts } from "./sheetSessionFixtures"

// Rows and columns inserted or deleted at several spans at once (a selection of several ranges), as Excel does: an
// insert before each span, a delete of every span, in one undo step; what refers to the cells moves with them.

function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`)

	return result.change
}

// A1:A8 hold 1..8; B1 sums them; C3:D3 merged; a rule over A5:A6, a validation on A7.
const SHEET: FixtureSheet = {
	name: "One",
	body:
		"<sheetData>" +
		Array.from(
			{ length: 8 },
			(_, k) =>
				`<row r="${String(k + 1)}"><c r="A${String(k + 1)}"><v>${String(k + 1)}</v></c>${k === 0 ? '<c r="B1"><f>SUM(A1:A8)</f><v>36</v></c>' : ""}</row>`
		).join("") +
		'</sheetData><mergeCells count="1"><mergeCell ref="C3:D3"/></mergeCells>' +
		'<conditionalFormatting sqref="A5:A6"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>0</formula></cfRule></conditionalFormatting>' +
		'<dataValidations count="1"><dataValidation type="whole" sqref="A7"><formula1>0</formula1></dataValidation></dataValidations>'
}

// styles.xml's children.
const STYLES =
	'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
	'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
	'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
	'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
	'<dxfs count="1"><dxf><font><b/></font></dxf></dxfs>'

async function opened(): ReturnType<typeof openFixture> {
	return openFixture({ sheets: [SHEET], styles: STYLES })
}

function columnA(texts: Map<string, string>): string[] {
	return Array.from({ length: 12 }, (_, row) => texts.get(`${String(row)},0`) ?? "")
}

describe("axis spans: order and refusals", () => {
	it("moves the last span first, whatever order the command names them in", () => {
		expect(
			orderedAxisSpans(
				[
					{ at: 1, count: 2 },
					{ at: 7, count: 1 },
					{ at: 4, count: 1 }
				],
				100
			)
		).toEqual([
			{ at: 7, count: 1 },
			{ at: 4, count: 1 },
			{ at: 1, count: 2 }
		])
	})

	it("takes spans that touch, and refuses spans that overlap as Excel refuses overlapping selections", () => {
		expect(
			orderedAxisSpans(
				[
					{ at: 1, count: 2 },
					{ at: 3, count: 1 }
				],
				100
			)
		).toHaveLength(2)
		expect(
			orderedAxisSpans(
				[
					{ at: 1, count: 3 },
					{ at: 3, count: 1 }
				],
				100
			)
		).toEqual({ reason: "multipleSelection", detail: "overlapping" })
		expect(
			orderedAxisSpans(
				[
					{ at: 2, count: 1 },
					{ at: 2, count: 1 }
				],
				100
			)
		).toEqual({ reason: "multipleSelection", detail: "overlapping" })
	})

	it("refuses spans past the sheet or empty, and takes the one-span form as it is", () => {
		expect(orderedAxisSpans([], 100)).toEqual({ reason: "tooLarge" })
		expect(orderedAxisSpans([{ at: 99, count: 2 }], 100)).toEqual({ reason: "tooLarge" })
		expect(orderedAxisSpans([{ at: 0, count: 0 }], 100)).toEqual({ reason: "tooLarge" })
		expect(axisMoveOrder({ sheet: 0, axis: "rows", at: 3, count: 2 })).toEqual([{ at: 3, count: 2 }])
	})
})

describe("sheet session: rows inserted and deleted at several spans", () => {
	it("inserts before each span, moving formulas, merges, rules and validations, and undoes in one step", async () => {
		const { session, info, bytes } = await opened()
		const sheet = info.sheets[0]!.id

		changeOf(
			await session.command({
				type: "axis.insert",
				sheet,
				axis: "rows",
				spans: [
					{ at: 1, count: 2 },
					{ at: 4, count: 1 }
				]
			})
		)

		expect(columnA(tileTexts(await firstTile(session, sheet)))).toEqual(["1", "", "", "2", "3", "4", "", "5", "6", "7", "8", ""])

		const xml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(xml).toContain("SUM(A1:A11)")
		expect(xml).toContain('ref="C5:D5"')
		expect(xml).toContain('sqref="A8:A9"')
		expect(xml).toContain('sqref="A10"')

		expect(changeOf(await session.undo()).state.canUndo).toBe(false)
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])

		changeOf(await session.redo())
		expect(columnA(tileTexts(await firstTile(session, sheet)))).toEqual(["1", "", "", "2", "3", "4", "", "5", "6", "7", "8", ""])
		session.close()
	})

	it("deletes every span, moving what refers to the rows after them", async () => {
		const { session, info, bytes } = await opened()
		const sheet = info.sheets[0]!.id

		changeOf(
			await session.command({
				type: "axis.delete",
				sheet,
				axis: "rows",
				spans: [
					{ at: 4, count: 1 },
					{ at: 1, count: 2 }
				]
			})
		)

		expect(columnA(tileTexts(await firstTile(session, sheet))).slice(0, 6)).toEqual(["1", "4", "6", "7", "8", ""])

		const xml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(xml).toContain("SUM(A1:A5)")
		expect(xml).not.toContain("<mergeCell ")
		expect(xml).toContain('sqref="A3"')
		expect(xml).toContain('sqref="A4"')

		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})

	it("refuses overlapping spans and changes nothing", async () => {
		const { session, info } = await opened()
		const result = await session.command({
			type: "axis.delete",
			sheet: info.sheets[0]!.id,
			axis: "rows",
			spans: [
				{ at: 1, count: 3 },
				{ at: 2, count: 1 }
			]
		})

		expect(result.ok ? null : result.refusal).toEqual({ reason: "multipleSelection", detail: "overlapping" })
		expect(result.ok ? null : result.state.dirty).toBe(false)
		session.close()
	})

	it("takes back the spans it moved when a later one is refused", async () => {
		const last = SHEET_MAX_ROWS - 1
		const { session, info, bytes } = await openFixture({
			sheets: [
				{
					name: "One",
					body: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="${String(last)}"><c r="A${String(last)}"><v>2</v></c></row></sheetData>`
				}
			]
		})
		// The first insert (the later span) moves the last cell to the sheet's last row; the second would push it off.
		const result = await session.command({
			type: "axis.insert",
			sheet: info.sheets[0]!.id,
			axis: "rows",
			spans: [
				{ at: 0, count: 1 },
				{ at: 5, count: 1 }
			]
		})

		expect(result.ok ? null : result.refusal.reason).toBe("tooLarge")
		expect(result.ok ? null : { canUndo: result.state.canUndo, dirty: result.state.dirty }).toEqual({ canUndo: false, dirty: false })
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})
})

describe("text session: rows deleted at several spans", () => {
	it("deletes every span of a CSV in one step", async () => {
		const host = inThreadSheetHost()
		const result = await host.open(new TextEncoder().encode("a\nb\nc\nd\ne\n"), { kind: "csv", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "opened") throw new Error(result.kind)

		const { session, info } = result
		const sheet = info.sheets[0]!.id

		changeOf(
			await session.command({
				type: "axis.delete",
				sheet,
				axis: "rows",
				spans: [
					{ at: 1, count: 1 },
					{ at: 3, count: 1 }
				]
			})
		)
		expect(columnA(tileTexts(await firstTile(session, sheet))).slice(0, 4)).toEqual(["a", "c", "e", ""])

		changeOf(await session.undo())
		expect(columnA(tileTexts(await firstTile(session, sheet))).slice(0, 6)).toEqual(["a", "b", "c", "d", "e", ""])
		session.close()
	})
})

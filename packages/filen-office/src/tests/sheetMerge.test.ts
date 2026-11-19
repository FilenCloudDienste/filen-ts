import { describe, expect, it } from "vitest"
import type { SheetChange, SheetCommandResult } from "../core/sheet/protocol"
import { STYLES, parts } from "./xlsxWriteFixtures"
import { firstTile, openFixture, savedBytes, tileEntry } from "./sheetSessionFixtures"
import { TYPES, relationship } from "./xlsxRefsFixtures"

// Cells merged and unmerged: the value-loss refusal, what a merge keeps, merge and centre, merge across, and the
// typed refusals.

function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok)
		throw new Error(`refused: ${result.refusal.reason}${result.refusal.detail === undefined ? "" : ` (${result.refusal.detail})`}`)

	return result.change
}

const SHEET = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1"><v>2</v></c></row>' +
				'<row r="2"><c r="A2"><f>B1*2</f><v>4</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="D1:E1"/></mergeCells>'
		}
	]
}

const range = (startRow: number, startCol: number, endRow: number, endCol: number) => ({ startRow, startCol, endRow, endCol })

describe("sheet session: cells merged", () => {
	it("asks before dropping values, then keeps the upper-left value and gives every cell its format", async () => {
		const { session, info, bytes } = await openFixture(SHEET)
		const sheet = info.sheets[0]!.id
		const asked = await session.command({ type: "merge.cells", sheet, ranges: [range(0, 0, 0, 2)], mode: "merge" })

		expect(asked.ok ? null : asked.refusal.reason).toBe("mergeLosesValues")

		const merged = changeOf(
			await session.command({ type: "merge.cells", sheet, ranges: [range(0, 0, 0, 2)], mode: "merge", discard: true })
		)

		expect([...(merged.layouts[0]?.layout.merges ?? [])]).toEqual([0, 3, 0, 4, 0, 0, 0, 2])

		const sheetXml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheetXml).toContain('<c r="A1" s="1"><v>45000</v></c><c r="B1" s="1"/><c r="C1" s="1"/>')
		expect(sheetXml).toContain('<mergeCell ref="A1:C1"/>')
		// A formula reading a dropped value is recalculated.
		expect(tileEntry(await firstTile(session, sheet), 1, 0)?.text).toBe("0")

		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})

	it("takes in merges the range holds whole, centres it, and merges across row by row", async () => {
		const { session, info } = await openFixture(SHEET)
		const sheet = info.sheets[0]!.id

		changeOf(await session.command({ type: "merge.cells", sheet, ranges: [range(0, 3, 1, 5)], mode: "center" }))

		const saved = parts(await savedBytes(session))
		const sheetXml = saved["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheetXml).toContain('<mergeCells count="1"><mergeCell ref="D1:F2"/></mergeCells>')
		expect(saved["xl/styles.xml"]).toContain('<alignment horizontal="center"/>')

		changeOf(await session.command({ type: "merge.cells", sheet, ranges: [range(4, 0, 6, 2)], mode: "across" }))
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain(
			'<mergeCell ref="D1:F2"/><mergeCell ref="A5:C5"/><mergeCell ref="A6:C6"/><mergeCell ref="A7:C7"/>'
		)
		session.close()
	})

	it("refuses to cut through a merge, a table or an array formula, and on a protected sheet", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="4"><c r="A4"><f t="array" ref="A4:A5">B4:B5</f><v>0</v></c></row></sheetData>' +
						'<mergeCells count="1"><mergeCell ref="D1:E1"/></mergeCells><tableParts count="1"><tablePart r:id="rId1"/></tableParts>',
					rels: relationship("rId1", "table", "../tables/table1.xml")
				}
			],
			parts: {
				"xl/tables/table1.xml": {
					text:
						'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="H1:I3">' +
						'<autoFilter ref="H1:I3"/><tableColumns count="2"><tableColumn id="1" name="K"/><tableColumn id="2" name="V"/></tableColumns></table>',
					type: TYPES.table
				}
			}
		})
		const sheet = info.sheets[0]!.id
		const reason = async (ranges: ReturnType<typeof range>[]) => {
			const result = await session.command({ type: "merge.cells", sheet, ranges, mode: "merge", discard: true })

			return result.ok ? null : result.refusal
		}

		expect(await reason([range(0, 4, 0, 5)])).toEqual({ reason: "merged" })
		expect(await reason([range(0, 6, 0, 7)])).toEqual({ reason: "merged", detail: "table" })
		expect(await reason([range(3, 0, 3, 1)])).toEqual({ reason: "arrayFormula" })
		session.close()

		const locked = await openFixture({ sheets: [{ name: "One", body: '<sheetData/><sheetProtection sheet="1" formatCells="0"/>' }] })
		const refused = await locked.session.command({
			type: "merge.cells",
			sheet: locked.info.sheets[0]!.id,
			ranges: [range(0, 0, 0, 1)],
			mode: "merge"
		})

		expect(refused.ok ? null : refused.refusal.reason).toBe("protectedSheet")
		locked.session.close()
	})
})

describe("sheet session: cells merged at scale", () => {
	it("refuses overlapping ranges and a tall merge cut through, and takes in one held whole", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData/><mergeCells count="2"><mergeCell ref="B1:B20"/><mergeCell ref="D5:E5"/></mergeCells>'
				}
			]
		})
		const sheet = info.sheets[0]!.id
		const reason = async (ranges: ReturnType<typeof range>[], mode: "merge" | "across" = "merge") => {
			const result = await session.command({ type: "merge.cells", sheet, ranges, mode, discard: true })

			return result.ok ? null : result.refusal
		}

		expect(await reason([range(30, 0, 31, 1), range(31, 1, 32, 2)])).toEqual({ reason: "merged" })
		expect(await reason([range(30, 0, 32, 1), range(32, 0, 32, 2)], "across")).toEqual({ reason: "merged" })
		// B1:B20 starts rows above the merge and reaches into it.
		expect(await reason([range(10, 0, 10, 2)])).toEqual({ reason: "merged" })
		expect(await reason([range(10, 0, 10, 2)], "across")).toEqual({ reason: "merged" })

		const change = changeOf(await session.command({ type: "merge.cells", sheet, ranges: [range(3, 3, 5, 5)], mode: "merge" }))

		expect([...(change.layouts[0]?.layout.merges ?? [])]).toEqual([0, 1, 19, 1, 3, 3, 5, 5])
		session.close()
	})

	it("merges a hundred thousand rows across, every cell centred, and undo takes it all back", async () => {
		const { session, info, bytes } = await openFixture({ sheets: [{ name: "One", body: "<sheetData/>" }] })
		const sheet = info.sheets[0]!.id
		const change = changeOf(await session.command({ type: "merge.cells", sheet, ranges: [range(0, 0, 99_999, 1)], mode: "across" }))

		expect(change.layouts[0]?.layout.merges?.length).toBe(400_000)

		const sheetXml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheetXml).toContain('<row r="100000"><c r="A100000" s="2"/><c r="B100000" s="2"/></row>')
		expect(sheetXml).toContain('<mergeCell ref="A100000:B100000"/>')

		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})

	it("unshares a shared formula's master it drops, its children keeping their formulas", async () => {
		const { session, info, bytes } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row>' +
						'<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>4</v></c></row>' +
						'<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>6</v></c></row></sheetData>'
				}
			]
		})
		const sheet = info.sheets[0]!.id

		changeOf(await session.command({ type: "merge.cells", sheet, ranges: [range(0, 0, 0, 2)], mode: "center", discard: true }))

		const sheetXml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheetXml).toContain('<c r="A1" s="2"><v>1</v></c><c r="B1" s="2"/><c r="C1" s="2"/>')
		expect(sheetXml).toContain('<c r="B2"><f>A2*2</f><v>4</v></c>')
		expect(sheetXml).toContain('<c r="B3"><f>A3*2</f><v>6</v></c>')

		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})

	it("refuses at the style limit with the cells it already merged put back", async () => {
		// One cell format short of the limit: the first merge's centred format fits, the second's does not.
		const padding = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'.repeat(65_487)
		const styles = STYLES.replace(
			/<cellXfs count="2">(.*)<\/cellXfs>/,
			(_whole, xfs: string) => `<cellXfs count="65489">${xfs}${padding}</cellXfs>`
		)
		const { session, info, bytes } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="3"><c r="A3" s="1"><v>2</v></c></row></sheetData>'
				}
			],
			styles
		})
		const sheet = info.sheets[0]!.id
		const result = await session.command({
			type: "merge.cells",
			sheet,
			ranges: [range(0, 0, 0, 2), range(2, 0, 2, 2)],
			mode: "center"
		})

		expect(result.ok ? null : result.refusal.reason).toBe("styleLimit")
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})
})

describe("sheet session: cells unmerged", () => {
	it("unmerges every merge the selection touches, and says when there is none", async () => {
		const { session, info, bytes } = await openFixture(SHEET)
		const sheet = info.sheets[0]!.id
		const state = await session.query("commandState", { sheet, ranges: [range(5, 5, 5, 5)], types: ["merge.unmerge"] })

		expect(state.enabled).toEqual([false])

		const change = changeOf(await session.command({ type: "merge.unmerge", sheet, ranges: [range(0, 4, 0, 4)] }))

		expect([...(change.layouts[0]?.layout.merges ?? [])]).toEqual([])
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).not.toContain("mergeCell")

		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})
})

describe("sheet session: cells merged over a dynamic array", () => {
	// support.microsoft.com "How to correct a #SPILL! error": "Spill range has merged cells".
	it("hold it back as #SPILL!, and unmerged it spills again; undo and redo follow", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "S", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }]
		})
		const sheet = info.sheets[0]!.id
		const column = async (): Promise<string[]> => {
			const tile = await firstTile(session, sheet)

			return [0, 1, 2].map(row => tileEntry(tile, row, 5)?.text ?? "")
		}

		await session.intent()
		changeOf(
			await session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(5), inputs: ["=SEQUENCE(3)"] }
			})
		)
		changeOf(await session.command({ type: "merge.cells", sheet, ranges: [range(1, 5, 1, 6)], mode: "merge", discard: true }))
		expect(await column()).toEqual(["#SPILL!", "", ""])

		changeOf(await session.command({ type: "merge.unmerge", sheet, ranges: [range(1, 5, 1, 6)] }))
		expect(await column()).toEqual(["1", "2", "3"])

		changeOf(await session.undo())
		expect(await column()).toEqual(["#SPILL!", "", ""])
		changeOf(await session.redo())
		expect(await column()).toEqual(["1", "2", "3"])
		changeOf(await session.undo())
		changeOf(await session.undo())
		expect(await column()).toEqual(["1", "2", "3"])
		session.close()
	})
})

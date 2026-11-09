import { describe, expect, it } from "vitest"
import { SHEET_MAX_EDIT_CELLS, type SheetCommandResult, type SheetSessionApi } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { IMMEDIATE, buildFixture, savedBytes } from "./sheetSessionFixtures"
import { STYLES, equalBytes, parts, type Fixture } from "./xlsxWriteFixtures"

// Inserted rows take the format of the row above (columns: of the column to the left), the row below (right) at
// the sheet's edge: Excel's Insert Options default, "Format Same As Above/Left". Formats only: no value moves.

async function open(fixture: Fixture | Uint8Array): Promise<{ session: SheetSessionApi; sheet: number }> {
	const bytes = fixture instanceof Uint8Array ? fixture : buildFixture(fixture)
	const result = await inThreadSheetHost().open(bytes.slice(), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(result.kind)

	return { session: result.session, sheet: result.info.activeSheet }
}

function ok(result: SheetCommandResult): void {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`)
}

async function sheetXml(session: SheetSessionApi): Promise<string> {
	return parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""
}

function rowXml(xml: string, row: number): string | null {
	return new RegExp(`<row r="${String(row)}"[^>]*?(/>|>.*?</row>)`, "u").exec(xml)?.[0] ?? null
}

// Row 1 formatted (row style 1, customFormat); B1 a cell of style 1 in a plain row 2; C2 holds a value.
const ROWS: Fixture = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1" s="1" customFormat="1"><c r="A1"><v>1</v></c><c r="B1" s="1"><v>2</v></c></row>' +
				'<row r="2"><c r="B2" s="1"/><c r="C2"><v>3</v></c></row></sheetData>'
		}
	],
	styles: STYLES
}

const COLS: Fixture = {
	sheets: [
		{
			name: "One",
			body:
				'<cols><col min="1" max="1" width="20" customWidth="1" style="1"/></cols>' +
				'<sheetData><row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1"><v>2</v></c></row>' +
				'<row r="2"><c r="A2"><v>4</v></c></row></sheetData>'
		}
	],
	styles: STYLES
}

describe("inserted rows and columns take their neighbour's format", () => {
	it("formats rows inserted in the middle like the row above, cell formats included, values left behind", async () => {
		const { session, sheet } = await open(ROWS)

		ok(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 2, count: 2 }))

		const xml = await sheetXml(session)

		// Under row 2 (plain, B2 styled): rows 3 and 4 get B's style as cells of their own, nothing else.
		expect(rowXml(xml, 3)).toBe('<row r="3"><c r="B3" s="1"/></row>')
		expect(rowXml(xml, 4)).toBe('<row r="4"><c r="B4" s="1"/></row>')
		expect(rowXml(xml, 2)).toBe('<row r="2"><c r="B2" s="1"/><c r="C2"><v>3</v></c></row>')
		session.close()
	})

	it("copies a row's own format, and a default-format cell in it as a copy of the default format", async () => {
		const { session, sheet } = await open(ROWS)

		ok(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 1, count: 1 }))

		const xml = await sheetXml(session)
		const inserted = rowXml(xml, 2) ?? ""

		// The row's style with customFormat; A1 shows the default format in a styled row: A2 does too, through a
		// record of its own; B1 shows the row's style already, so B2 needs no cell.
		expect(inserted).toMatch(/^<row r="2" s="1" customFormat="1"><c r="A2" s="(\d+)"\/><\/row>$/u)
		expect(Number(/r="A2" s="(\d+)"/u.exec(inserted)?.[1])).toBeGreaterThan(1)
		expect(inserted).not.toContain("<v>")
		session.close()
	})

	it("formats rows inserted above the first like the row below", async () => {
		const { session, sheet } = await open(ROWS)

		ok(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 0, count: 1 }))

		const xml = await sheetXml(session)

		expect(rowXml(xml, 1)).toMatch(/^<row r="1" s="1" customFormat="1"><c r="A1" s="\d+"\/><\/row>$/u)
		expect(rowXml(xml, 2)).toContain('<c r="A2"><v>1</v></c>')
		session.close()
	})

	it("formats columns like the column to the left, its width and values left behind", async () => {
		const { session, sheet } = await open(COLS)

		ok(await session.command({ type: "axis.insert", sheet, axis: "cols", at: 1, count: 2 }))

		const xml = await sheetXml(session)

		expect(xml).toMatch(/<col min="1" max="1" width="20" customWidth="1" style="1"\/><col min="2" max="3" width="[\d.]+" style="1"\/>/u)
		// A2 shows the default format under a styled column: B2 and C2 do too, through a record of their own.
		expect(rowXml(xml, 1)).toBe('<row r="1"><c r="A1" s="1"><v>1</v></c><c r="D1"><v>2</v></c></row>')
		expect(rowXml(xml, 2)).toMatch(/^<row r="2"><c r="A2"><v>4<\/v><\/c><c r="B2" s="(\d+)"\/><c r="C2" s="\1"\/><\/row>$/u)
		session.close()
	})

	it("formats columns inserted before the first like the column to the right", async () => {
		const { session, sheet } = await open(COLS)

		ok(await session.command({ type: "axis.insert", sheet, axis: "cols", at: 0, count: 1 }))

		const xml = await sheetXml(session)

		expect(xml).toMatch(/<col min="1" max="1" width="[\d.]+" style="1"\/><col min="2" max="2" width="20" style="1" customWidth="1"\/>/u)
		// B2 (A2 before) shows the default format under its styled column: A2 does too.
		expect(xml).toMatch(/<row r="2"><c r="A2" s="(\d+)"\/><c r="B2"><v>4<\/v><\/c><\/row>/u)
		session.close()
	})

	it("undoes to the file as it was and redoes the same formats", async () => {
		for (const [fixture, axis, at] of [
			[ROWS, "rows", 1],
			[ROWS, "rows", 0],
			[COLS, "cols", 1]
		] as const) {
			const bytes = buildFixture(fixture)
			const { session, sheet } = await open(bytes)

			ok(await session.command({ type: "axis.insert", sheet, axis, at, count: 2 }))

			const after = await sheetXml(session)

			ok(await session.undo())
			expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
			ok(await session.redo())
			expect(await sheetXml(session)).toBe(after)
			ok(await session.undo())
			expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
			session.close()
		}
	})

	it("past the edit limit gives the rows their row format but writes no cells", async () => {
		const { session, sheet } = await open(ROWS)
		const count = SHEET_MAX_EDIT_CELLS / 2 + 1

		ok(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 1, count }))

		const xml = await sheetXml(session)

		expect(rowXml(xml, 2)).toBe('<row r="2" s="1" customFormat="1"/>')
		expect(xml).not.toMatch(/<c r="A2"/u)
		session.close()
	})
})

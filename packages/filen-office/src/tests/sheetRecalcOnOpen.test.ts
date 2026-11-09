import { describe, expect, it, vi } from "vitest"
import { bytesSource } from "../core/opc/index"
import { CellFlag } from "../core/sheet/protocol"
import { RenderStyleTable } from "../core/sheet/session"
import { XlsxDocument } from "../core/xlsx/edit/document"
import { cellKeyOf } from "../core/xlsx/edit/history"
import { openXlsx } from "../core/xlsx/read/index"
import { cells, firstTile, openFixture, savedBytes, tileTexts } from "./sheetSessionFixtures"
import { budget, cpuMs } from "./timing"
import { buildFixture, parts } from "./xlsxWriteFixtures"

async function opened(body: string, workbookTail = ""): Promise<XlsxDocument> {
	const result = await openXlsx(bytesSource(buildFixture({ sheets: [{ name: "Data", body }], workbookTail })))

	if (!result.ok) throw new Error(result.reason)

	await result.workbook.loadAll(0)

	return new XlsxDocument(result.workbook, new RenderStyleTable(), { kind: "xlsx" })
}

function texts(document: XlsxDocument, refs: readonly (readonly [number, number])[]): string[] {
	const sheet = document.activeSheet()

	return refs.map(([row, col]) => document.cellView(sheet, row, col).text)
}

const ROW = [0, 1, 2, 3].map(col => [0, col] as const)
const COLUMN = [0, 1].map(row => [row, 0] as const)

describe("results calculated again on open", () => {
	it("calculates a volatile formula and what reads it, keeping every other stored result", async () => {
		// The file's results are stale: C1 is 5, so OFFSET gives 5 and B1 10; D1's stale 99 reads nothing volatile.
		const document = await opened(
			'<sheetData><row r="1"><c r="A1"><f>OFFSET(C1,0,0)</f><v>0</v></c><c r="B1"><f>A1*2</f><v>0</v></c>' +
				'<c r="C1"><v>5</v></c><c r="D1"><f>C1+1</f><v>99</v></c></row></sheetData>'
		)

		expect(document.needsPreparing(false)).toBe(true)
		expect(texts(document, ROW)).toEqual(["0", "0", "5", "99"])

		document.buildEngine()
		expect(texts(document, ROW)).toEqual(["5", "10", "5", "99"])
		document.dropEngine()
	})

	// A volatile result that happens to equal the stored one (RANDBETWEEN drawing the cached number) is still one this
	// open calculated: another open calculates it again, so what the file stores is no result the session kept.
	it("marks a volatile result and what reads it as recalculated where they equal the stored results", async () => {
		const recalculated = (document: XlsxDocument, row: number, col: number): boolean =>
			document.shownResults.get(document.activeSheet())?.get(cellKeyOf(row, col))?.recalculated === true
		const document = await opened(
			'<sheetData><row r="1"><c r="A1"><f>OFFSET(C1,0,0)</f><v>5</v></c><c r="B1"><f>A1*2</f><v>10</v></c>' +
				'<c r="C1"><v>5</v></c><c r="D1"><f>C1+1</f><v>6</v></c></row></sheetData>'
		)

		document.buildEngine()
		expect(texts(document, ROW)).toEqual(["5", "10", "5", "6"])
		expect([recalculated(document, 0, 0), recalculated(document, 0, 1), recalculated(document, 0, 3)]).toEqual([true, true, false])
		document.dropEngine()

		// Under fullCalcOnLoad every formula is calculated, but a result the file holds is shown again only where it
		// is volatile or reads one (one entry per formula cell otherwise).
		const full = await opened(
			'<sheetData><row r="1"><c r="A1"><f>OFFSET(C1,0,0)</f><v>5</v></c><c r="B1"><f>A1*2</f><v>10</v></c>' +
				'<c r="C1"><v>5</v></c><c r="D1"><f>C1+1</f><v>6</v></c></row></sheetData>',
			'<calcPr calcId="0" fullCalcOnLoad="1"/>'
		)

		full.buildEngine()
		expect(texts(full, ROW)).toEqual(["5", "10", "5", "6"])
		expect([recalculated(full, 0, 0), recalculated(full, 0, 1), recalculated(full, 0, 3)]).toEqual([true, true, false])
		full.dropEngine()

		// RANDBETWEEN drawing the stored 37.
		const random = vi.spyOn(Math, "random").mockReturnValue(0.365)

		try {
			const drawn = await opened(
				'<sheetData><row r="1"><c r="A1"><f ca="1">RANDBETWEEN(1,100)</f><v>37</v></c><c r="B1"><f ca="1">A1*2</f><v>74</v></c></row></sheetData>'
			)

			drawn.buildEngine()
			expect(texts(drawn, ROW.slice(0, 2))).toEqual(["37", "74"])
			expect([recalculated(drawn, 0, 0), recalculated(drawn, 0, 1)]).toEqual([true, true])
			drawn.dropEngine()
		} finally {
			random.mockRestore()
		}
	})

	it("needs no engine to view a workbook whose results are all stored and none volatile", async () => {
		const document = await opened(
			'<sheetData><row r="1"><c r="A1"><f>C1+1</f><v>9</v></c><c r="B1" t="str"><f>"TODAY()"&amp;MYTODAY(1)</f><v>x</v></c><c r="C1"><v>5</v></c></row></sheetData>'
		)

		expect(document.needsPreparing(false)).toBe(false)
	})

	it("calculates every cell of a shared volatile formula", async () => {
		const document = await opened(
			'<sheetData><row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">OFFSET(C1,0,0)</f><v>0</v></c><c r="C1"><v>5</v></c></row>' +
				'<row r="2"><c r="A2"><f t="shared" si="0"/><v>0</v></c><c r="C2"><v>6</v></c></row></sheetData>'
		)

		expect(document.needsPreparing(false)).toBe(true)
		document.buildEngine()
		expect(texts(document, COLUMN)).toEqual(["5", "6"])
		document.dropEngine()
	})

	it("calculates every formula under calcPr fullCalcOnLoad, a held one keeping its stored result", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1"><f>C1*2</f><v>0</v></c><c r="B1"><f>GETPIVOTDATA(C1,C3)</f><v>7</v></c>' +
			'<c r="C1"><v>4</v></c><c r="D1"><f>A1+1</f><v>0</v></c></row></sheetData>'
		const stale = await opened(body)

		expect(stale.needsPreparing(false)).toBe(false)

		const document = await opened(body, '<calcPr calcId="0" fullCalcOnLoad="1"/>')

		expect(document.needsPreparing(false)).toBe(true)
		document.buildEngine()
		expect(texts(document, ROW)).toEqual(["8", "7", "4", "9"])
		document.dropEngine()
	})

	it("shows the same once the engine is built again", async () => {
		const document = await opened(
			'<sheetData><row r="1"><c r="A1"><f>OFFSET(C1,0,0)</f><v>0</v></c><c r="C1"><v>5</v></c></row></sheetData>'
		)

		document.buildEngine()
		expect(texts(document, [[0, 0]])).toEqual(["5"])
		document.dropEngine()
		document.buildEngine()
		expect(texts(document, [[0, 0]])).toEqual(["5"])
		document.dropEngine()
	})

	it("stays within budget over many volatile formulas", async () => {
		const rows = Array.from(
			{ length: 2000 },
			(_, row) =>
				`<row r="${String(row + 1)}"><c r="A${String(row + 1)}"><f>OFFSET(C${String(row + 1)},0,0)</f><v>0</v></c>` +
				`<c r="B${String(row + 1)}"><f>A${String(row + 1)}+1</f><v>0</v></c><c r="C${String(row + 1)}"><v>${String(row)}</v></c></row>`
		).join("")
		const document = await opened(`<sheetData>${rows}</sheetData>`)
		const start = cpuMs()

		document.buildEngine()

		const ms = cpuMs() - start

		expect(texts(document, [[1999, 1]])).toEqual(["2000"])
		expect(ms).toBeLessThan(budget(400))
		document.dropEngine()
	})
})

describe("legacy array formulas", () => {
	it("calculates one of a single cell as an array, its first value, and what reads it", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>1</v></c><c r="C1"><f t="array" ref="C1">SUM(A1:A2*B1:B2)</f><v>19</v></c>' +
						'<c r="D1"><f>C1+1</f><v>20</v></c><c r="E1"><f t="array" ref="E1">A1:A2*10</f><v>10</v></c></row>' +
						'<row r="2"><c r="A2"><v>9</v></c><c r="B2"><v>2</v></c></row></sheetData>'
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0
		const shown = async (): Promise<(string | undefined)[]> => {
			const tile = tileTexts(await firstTile(session, one))

			return [tile.get("0,2"), tile.get("0,3"), tile.get("0,4"), tile.get("1,4")]
		}

		const result = await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "3"]]) })

		expect(result.ok).toBe(true)
		expect(await shown()).toEqual(["21", "22", "30", undefined])

		const files = parts(await savedBytes(session))

		expect(files["xl/workbook.xml"] ?? "").not.toMatch(/fullCalcOnLoad="(?:1|true)"/)
		expect(files["xl/worksheets/sheet1.xml"] ?? "").toMatch(/<c r="C1"[^>]*><f t="array" ref="C1">SUM\(A1:A2\*B1:B2\)<\/f><v>21<\/v>/)
		session.close()
	})

	it("is not flagged as cached when it is calculated; a block is", async () => {
		const document = await opened(
			'<sheetData><row r="1"><c r="A1"><v>2</v></c><c r="B1"><f t="array" ref="B1">SUM(A1:A2*2)</f><v>4</v></c>' +
				'<c r="C1"><f t="array" ref="C1:C2">A1:A2*2</f><v>4</v></c></row><row r="2"><c r="C2"><v>0</v></c></row></sheetData>'
		)
		const sheet = document.activeSheet()

		document.buildEngine()
		expect(document.cellView(sheet, 0, 1).flags & CellFlag.CACHED).toBe(0)
		expect(document.cellView(sheet, 0, 2).flags & CellFlag.CACHED).toBe(CellFlag.CACHED)
		document.dropEngine()
	})
})

import { describe, expect, it } from "vitest"
import { parts } from "./xlsxWriteFixtures"
import { cells, firstTile, openFixture, savedBytes, tileTexts, changeOf } from "./sheetSessionFixtures"

const FORMULAS = '<sheetData><row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*2</f><v>4</v></c></row></sheetData>'

// The formula engine copies what removing a sheet, rows or columns takes away, cell by cell over the sheet's whole
// width or height (for an undo of its own the session never uses): cells at the grid's far edges must not make
// that copy exhaust memory.
describe("sheet session: formula engine work over a sheet reaching the grid's far edges", () => {
	it("undoes an added sheet whose far corner was written, and still calculates", { timeout: 60_000 }, async () => {
		const { session, info } = await openFixture({ sheets: [{ name: "One", body: FORMULAS }] })
		const one = info.sheets[0]?.id ?? 0

		await session.intent()

		const added = changeOf(await session.command({ type: "sheet.add" })).sheets?.at(-1)?.id ?? -1

		changeOf(
			await session.command({
				type: "cells.set",
				sheet: added,
				cells: cells([
					[1_048_574, 0, "=One!A1"],
					[0, 16_381, "1"]
				])
			})
		)
		changeOf(await session.undo())
		changeOf(await session.undo())
		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "5"]]) }))

		expect(tileTexts(await firstTile(session, one)).get("0,1")).toBe("10")
		session.close()
	})

	it.each([
		["rows", 100, '<row r="1"><c r="XFD1"><v>1</v></c></row>'],
		["cols", 3, '<row r="1048576"><c r="A1048576"><v>1</v></c></row>']
	] as const)("deletes %s across the whole sheet only within what the engine can copy", { timeout: 60_000 }, async (axis, count, far) => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: FORMULAS.replace("</sheetData>", `${far}</sheetData>`) }]
		})
		const one = info.sheets[0]?.id ?? 0

		await session.intent()
		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "3"]]) }))

		const deleted = await session.command({ type: "axis.delete", sheet: one, axis, at: 2, count })

		expect(deleted.ok ? null : deleted.refusal).toEqual({ reason: "tooLarge", detail: "engine" })
		expect(tileTexts(await firstTile(session, one)).get("0,1")).toBe("6")
		session.close()
	})
})

describe("sheet session: a command on a sheet an undo took away", () => {
	it("is refused, not thrown", async () => {
		const { session } = await openFixture({ sheets: [{ name: "One", body: FORMULAS }] })

		await session.intent()

		const added = changeOf(await session.command({ type: "sheet.add" })).sheets?.at(-1)?.id ?? -1
		const [, late] = await Promise.all([
			session.undo(),
			session.command({ type: "cells.set", sheet: added, cells: cells([[0, 0, "1"]]) })
		])

		expect(late.ok ? null : late.refusal).toEqual({ reason: "unsupported", detail: "sheet" })
		session.close()
	})
})

// A whole-column lookup reads its range's every cell there: over a sheet reaching the last row, millions.
const LOOKUPS =
	'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>VLOOKUP(A1,Two!A:L,2,FALSE)</f><v>5</v></c><c r="C1"><f>SUM(Two!A:L)</f><v>6</v></c></row></sheetData>'
const LOOKED_UP = '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>5</v></c></row>'

describe("sheet session: whole-column ranges over a sheet reaching the grid's last row", () => {
	it.each([
		["read when the engine is built", '<row r="1048576"><c r="L1048576"><v>1</v></c></row>', null],
		["reached by an edit", "", [1_048_575, 11, "2"]]
	] as const)("keep their results, %s, within memory", { timeout: 60_000 }, async (_label, far, write) => {
		const { session, info } = await openFixture({
			sheets: [
				{ name: "One", body: LOOKUPS },
				{ name: "Two", body: `<sheetData>${LOOKED_UP}${far}</sheetData>` }
			]
		})
		const [one, two] = [info.sheets[0]?.id ?? 0, info.sheets[1]?.id ?? 1]
		const heap = process.memoryUsage().heapUsed

		await session.intent()
		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 4, "1"]]) }))
		if (write !== null) changeOf(await session.command({ type: "cells.set", sheet: two, cells: cells([write]) }))

		const texts = tileTexts(await firstTile(session, one))
		const workbook = parts(await savedBytes(session))["xl/workbook.xml"] ?? ""

		expect(process.memoryUsage().heapUsed - heap).toBeLessThan(400 * 1024 * 1024)
		expect([texts.get("0,1"), texts.get("0,2")]).toEqual(["5", "6"])
		// A cell the sum reads changed: Excel recalculates it.
		expect(/fullCalcOnLoad="1"/.test(workbook)).toBe(write !== null)
		session.close()
	})
})

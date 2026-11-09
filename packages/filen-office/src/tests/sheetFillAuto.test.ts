import { describe, expect, it } from "vitest"
import type { SeriesRequest } from "../core/sheet/fill/series"
import type { SheetCommandResult, SheetRange, SheetSessionApi } from "../core/sheet/protocol"
import { firstTile, openFixture, savedBytes, tileEntry } from "./sheetSessionFixtures"
import { openKeys, sheetBody } from "./sheetKeysFixtures"
import { STYLES } from "./xlsxWriteFixtures"

// The fill handle (fill.auto) and the Series dialog (fill.series) over sessions: what the cells hold after, their
// formats, formulas moved, the selection, undo, refusals, and saves that reopen as the session held them.

async function texts(session: SheetSessionApi, at: readonly (readonly [number, number])[]): Promise<string[]> {
	const tile = await firstTile(session, 0)

	return at.map(([row, col]) => tileEntry(tile, row, col)?.text ?? "")
}

function auto(
	session: SheetSessionApi,
	source: SheetRange,
	target: SheetRange,
	mode: "auto" | "alternate" = "auto"
): Promise<SheetCommandResult> {
	return session.command({ type: "fill.auto", sheet: 0, source, target, mode })
}

const column = (rows: number, col = 0): (readonly [number, number])[] => Array.from({ length: rows }, (_, row) => [row, col] as const)

describe("fill.auto", () => {
	it("extends numbers, steps dates in their format, moves formulas, and selects what it filled", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1" s="1"><v>45306</v></c><c r="C1"><f>A1*10</f><v>10</v></c>' +
			'<c r="D1" t="inlineStr"><is><t>Mon</t></is></c></row>' +
			'<row r="2"><c r="A2"><v>3</v></c><c r="B2" s="1"><v>45307</v></c><c r="C2"><f>A2*10</f><v>30</v></c>' +
			'<c r="D2" t="inlineStr"><is><t>Wed</t></is></c></row></sheetData>'
		const { session } = await openFixture({ sheets: [{ name: "S", body }] })
		const result = await auto(
			session,
			{ startRow: 0, startCol: 0, endRow: 1, endCol: 3 },
			{ startRow: 0, startCol: 0, endRow: 3, endCol: 3 }
		)

		expect(result.ok).toBe(true)
		expect(result.ok ? result.change.selection : null).toEqual({
			sheet: 0,
			activeRow: 0,
			activeCol: 0,
			ranges: [{ startRow: 0, startCol: 0, endRow: 3, endCol: 3 }]
		})
		expect(
			await texts(session, [
				[2, 0],
				[3, 0],
				[2, 1],
				[3, 1],
				[2, 2],
				[3, 2],
				[2, 3],
				[3, 3]
			])
		).toEqual(["5", "7", "1/17/2024", "1/18/2024", "50", "70", "Fri", "Sun"])

		const tile = await firstTile(session, 0)

		expect(tileEntry(tile, 3, 2)?.input).toBe("=A4*10")
		expect(tileEntry(tile, 3, 1)?.style).toBe(tileEntry(tile, 1, 1)?.style)

		const reopened = await openFixture(await savedBytes(session))

		expect(
			await texts(reopened.session, [
				[3, 0],
				[3, 1],
				[3, 3]
			])
		).toEqual(["7", "1/18/2024", "Sun"])
	})

	it("steps a time-formatted cell by an hour and dates a month apart by months", async () => {
		const styles = STYLES.replace(
			'<cellXfs count="2">',
			'<cellXfs count="3"><xf numFmtId="20" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
		)
		// Style 0 is now h:mm, 1 General, 2 m/d/yyyy.
		const body =
			'<sheetData><row r="1"><c r="A1"><v>0.375</v></c><c r="B1" s="2"><v>45306</v></c></row>' +
			'<row r="2"><c r="B2" s="2"><v>45337</v></c></row></sheetData>'
		const { session } = await openFixture({ sheets: [{ name: "S", body }], styles })

		expect(
			(await auto(session, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, { startRow: 0, startCol: 0, endRow: 3, endCol: 0 })).ok
		).toBe(true)
		expect(
			(await auto(session, { startRow: 0, startCol: 1, endRow: 1, endCol: 1 }, { startRow: 0, startCol: 1, endRow: 3, endCol: 1 })).ok
		).toBe(true)
		expect(
			await texts(session, [
				[1, 0],
				[2, 0],
				[3, 0],
				[2, 1],
				[3, 1]
			])
		).toEqual(["10:00", "11:00", "12:00", "3/15/2024", "4/15/2024"])
	})

	it("copies one number, or extends it with Ctrl held, and undoes in one step", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([[2]]) }] })
		const one = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }
		const down = { startRow: 0, startCol: 0, endRow: 3, endCol: 0 }

		await auto(session, one, down)
		expect(await texts(session, column(4))).toEqual(["2", "2", "2", "2"])

		await session.undo()
		expect(await texts(session, column(4))).toEqual(["2", "", "", ""])

		await auto(session, one, down, "alternate")
		expect(await texts(session, column(4))).toEqual(["2", "3", "4", "5"])
	})

	it("fills up and left from the source's far end", async () => {
		const { session } = await openKeys({
			sheets: [{ name: "S", body: sheetBody([[], [], [null, null, "Item 1", "Item 2"], [null, null, 5]]) }]
		})

		await auto(session, { startRow: 2, startCol: 2, endRow: 3, endCol: 2 }, { startRow: 0, startCol: 2, endRow: 3, endCol: 2 })
		expect(await texts(session, column(2, 2))).toEqual(["Item 0", "4"])

		await auto(session, { startRow: 2, startCol: 2, endRow: 2, endCol: 3 }, { startRow: 2, startCol: 0, endRow: 2, endCol: 3 })
		expect(
			await texts(session, [
				[2, 0],
				[2, 1]
			])
		).toEqual(["Item -1", "Item 0"])
	})

	it("refuses merged cells in the way and a target that is not the source grown one way", async () => {
		const body = `${sheetBody([[1], [2]])}<mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells>`
		const { session } = await openKeys({ sheets: [{ name: "S", body }] })
		const merged = await auto(
			session,
			{ startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
			{ startRow: 0, startCol: 0, endRow: 4, endCol: 0 }
		)

		expect(merged.ok ? null : merged.refusal.reason).toBe("merged")

		const sideways = await auto(
			session,
			{ startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
			{ startRow: 0, startCol: 0, endRow: 4, endCol: 2 }
		)

		expect(sideways.ok && sideways.change.patches.length === 0).toBe(true)
	})

	it("fills a text file's fields", async () => {
		const { session } = await openKeys("1,Mon\n2,Tue\n")
		const result = await auto(
			session,
			{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
			{ startRow: 0, startCol: 0, endRow: 3, endCol: 1 }
		)

		expect(result.ok).toBe(true)
		expect(
			await texts(session, [
				[2, 0],
				[3, 0],
				[2, 1],
				[3, 1]
			])
		).toEqual(["3", "4", "Wed", "Thu"])
	})
})

const LINEAR: SeriesRequest = { type: "linear", dateUnit: "day", step: 1, stop: null, trend: false }

describe("fill.series", () => {
	it("steps each column from its first cell, keeping its format", async () => {
		const body = '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1" s="1"><v>45322</v></c></row></sheetData>'
		const { session } = await openFixture({ sheets: [{ name: "S", body }] })
		const range = { startRow: 0, startCol: 0, endRow: 3, endCol: 0 }

		await session.command({ type: "fill.series", sheet: 0, range, orientation: "cols", options: { ...LINEAR, step: 5 } })
		await session.command({
			type: "fill.series",
			sheet: 0,
			range: { ...range, startCol: 1, endCol: 1 },
			orientation: "cols",
			options: { ...LINEAR, type: "date", dateUnit: "month" }
		})

		expect(
			await texts(session, [
				[1, 0],
				[2, 0],
				[3, 0],
				[1, 1],
				[2, 1],
				[3, 1]
			])
		).toEqual(["6", "11", "16", "2/29/2024", "3/31/2024", "4/30/2024"])
	})

	it("leaves a line whose first cell is not a number", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([["x"], [7]]) }] })
		const result = await session.command({
			type: "fill.series",
			sheet: 0,
			range: { startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
			orientation: "cols",
			options: LINEAR
		})

		expect(result.ok && result.change.patches.length === 0).toBe(true)
		expect(await texts(session, column(3))).toEqual(["x", "7", ""])
	})

	it("reads the stop value as an entry: a date in a workbook, and refuses one that is not a number", async () => {
		const body = '<sheetData><row r="1"><c r="A1" s="1"><v>45322</v></c></row></sheetData>'
		const { session } = await openFixture({ sheets: [{ name: "S", body }] })
		const range = { startRow: 0, startCol: 0, endRow: 5, endCol: 0 }
		const options: SeriesRequest = { ...LINEAR, type: "date", dateUnit: "month", stop: "2024-04-15" }

		await session.command({ type: "fill.series", sheet: 0, range, orientation: "cols", options })

		expect(await texts(session, column(5))).toEqual(["1/31/2024", "2/29/2024", "3/31/2024", "", ""])

		const refused = await session.command({
			type: "fill.series",
			sheet: 0,
			range,
			orientation: "cols",
			options: { ...options, stop: "soon" }
		})

		expect(refused.ok ? null : refused.refusal).toEqual({ reason: "unsupported", detail: "stop" })
	})
})

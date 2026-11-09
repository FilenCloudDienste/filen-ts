import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SheetChange, SheetCommandResult } from "../core/sheet/protocol"
import { CORPUS_DIR } from "./corpusDir"
import { parts } from "./xlsxWriteFixtures"
import { cells, firstTile, openFixture, savedBytes, tileEntry, tileTexts } from "./sheetSessionFixtures"

function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason} ${result.refusal.detail ?? ""}`)

	return result.change
}

function cellXml(sheet: string, ref: string): string {
	return new RegExp(`<c r="${ref}"[^>]*>.*?</c>`).exec(sheet)?.[0] ?? ""
}

function fullCalc(workbook: string): boolean {
	return /<calcPr[^>]*\sfullCalcOnLoad="(?:1|true)"/.test(workbook)
}

async function saved(session: Parameters<typeof savedBytes>[0]): Promise<{ sheet: string; workbook: string }> {
	const files = parts(await savedBytes(session))

	return { sheet: files["xl/worksheets/sheet1.xml"] ?? "", workbook: files["xl/workbook.xml"] ?? "" }
}

const XA = '<row r="2"><c r="A2"><v>9</v></c><c r="B2" t="inlineStr"><is><t>x</t></is></c></row>'

describe("sheet session: a formula giving a range", () => {
	// Typed, it is a dynamic array (support.microsoft.com "Dynamic array formulas and spilled array behavior"): it spills
	// down from its cell, and a cell there holding something makes it #SPILL!.
	it("spills it as a dynamic array, #SPILL! while a cell is in the way, and leaves the formulas there as they are", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>5</v></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row>' +
						'<row r="16"><c r="K16"><f>B1*2</f><v>10</v></c></row></sheetData>'
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[14, 10, "=A1:A3"]]) }))

		const tile = await firstTile(session, one)
		const { sheet } = await saved(session)

		expect([tileEntry(tile, 15, 10)?.text, tileEntry(tile, 14, 10)?.text]).toEqual(["10", "#SPILL!"])
		expect(cellXml(sheet, "K16")).toContain("<v>10</v>")
		expect(cellXml(sheet, "K15")).toContain('<f t="array" ref="K15">A1:A3</f><v>#SPILL!</v>')
		session.close()
	})
})

describe("sheet session: an ordinary formula giving an array constant", () => {
	it("takes its first value, as Excel does, and spills nothing over the cells beside it", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: '<sheetData><row r="4"><c r="C4"><v>2</v></c></row></sheetData>' }]
		})
		const one = info.sheets[0]?.id ?? 0

		changeOf(
			await session.command({
				type: "cells.set",
				sheet: one,
				cells: cells([
					[3, 3, "={1,2}"],
					[3, 4, '=C4&"x"'],
					[1, 5, "=SUM(C4:E7)"]
				])
			})
		)

		const shownTexts = (tile: Awaited<ReturnType<typeof firstTile>>): (string | undefined)[] => {
			const texts = tileTexts(tile)

			return [texts.get("3,3"), texts.get("3,4"), texts.get("1,5")]
		}
		const live = shownTexts(await firstTile(session, one))
		const reopened = await openFixture(await savedBytes(session))

		expect(live).toEqual(["1", "2x", "3"])
		expect(shownTexts(await firstTile(reopened.session, one))).toEqual(live)
		reopened.session.close()
		session.close()
	})
})

describe("sheet session: a function the engine lacks, under an error trap", () => {
	it.each([
		["IFERROR(_xlfn.FORECAST.ETS.SEASONALITY(A1:A2,B1:B2),A1)", "5", false],
		["IF(ISERROR(LEFTB(A1)),A1,LEFTB(A1))", "1x", true],
		["IFERROR(GETPIVOTDATA(A1,A2),A1)", "10", false]
	] as const)(
		"%s keeps its stored result, never the trap's, and asks Excel to recalculate once a precedent changes",
		async (formula, cached, isString) => {
			const { session, info } = await openFixture({
				sheets: [
					{
						name: "One",
						body:
							'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is><t>x</t></is></c>' +
							`<c r="C1"${isString ? ' t="str"' : ""}><f>${formula.replaceAll('"', "&quot;")}</f><v>${cached}</v></c></row>${XA}</sheetData>`
					}
				]
			})
			const one = info.sheets[0]?.id ?? 0

			changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "2"]]) }))

			const shown = tileTexts(await firstTile(session, one)).get("0,2")
			const { sheet, workbook } = await saved(session)

			expect(shown).toBe(cached)
			expect(cellXml(sheet, "C1")).toContain(`<v>${cached}</v>`)
			expect(fullCalc(workbook)).toBe(true)
			session.close()
		}
	)

	it("is not stale after an edit elsewhere, and an undo takes the recalculation request back", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is><t>x</t></is></c>' +
						`<c r="C1"><f>IFERROR(_xlfn.FORECAST.ETS.SEASONALITY(A1:A2,B1:B2),0)</f><v>5</v></c></row>${XA}` +
						'<row r="9"><c r="F9"><v>1</v></c></row></sheetData>'
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[8, 5, "7"]]) }))
		expect(fullCalc((await saved(session)).workbook)).toBe(false)

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[1, 0, "4"]]) }))
		expect(fullCalc((await saved(session)).workbook)).toBe(true)

		changeOf(await session.undo())
		expect(fullCalc((await saved(session)).workbook)).toBe(false)

		changeOf(await session.redo())
		expect(fullCalc((await saved(session)).workbook)).toBe(true)
		session.close()
	})

	it("shows #NAME? for one typed without a result to keep, and never the trap's value", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: `<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is><t>x</t></is></c></row>${XA}</sheetData>`
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0

		changeOf(
			await session.command({
				type: "cells.set",
				sheet: one,
				cells: cells([[0, 2, "=IFERROR(FORECAST.ETS.SEASONALITY(A1:A2,B1:B2),0)"]])
			})
		)

		const { sheet, workbook } = await saved(session)

		expect(tileTexts(await firstTile(session, one)).get("0,2")).toBe("#NAME?")
		expect(cellXml(sheet, "C1")).not.toContain("<v>")
		expect(fullCalc(workbook)).toBe(true)
		session.close()
	})

	it("shows #NAME? for one typed without a result whose references the engine cannot read, as a reopen does", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }]
		})
		const one = info.sheets[0]?.id ?? 0

		changeOf(
			await session.command({
				type: "cells.set",
				sheet: one,
				cells: cells([[0, 2, "=FORECAST.ETS.SEASONALITY(Table1[A],Table1[B])"]])
			})
		)

		const reopened = await openFixture(await savedBytes(session))

		// The reopened session calculates what the file keeps no result for once it is set to edit.
		await reopened.session.intent()
		expect(tileTexts(await firstTile(session, one)).get("0,2")).toBe("#NAME?")
		expect(tileTexts(await firstTile(reopened.session, one)).get("0,2")).toBe("#NAME?")
		reopened.session.close()
		session.close()
	})

	it("holds a formula that reads a defined name the engine has no syntax for", async () => {
		const { session, info } = await openFixture({
			workbookTail: '<definedNames><definedName name="both">(One!$A$1,One!$A$2)</definedName></definedNames>',
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><f>IFERROR(SUM(both),-1)</f><v>10</v></c></row><row r="2"><c r="A2"><v>9</v></c></row></sheetData>'
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "3"]]) }))

		const { sheet, workbook } = await saved(session)

		// Excel: 12. The engine would give the trap's -1.
		expect(tileTexts(await firstTile(session, one)).get("0,2")).toBe("10")
		expect(cellXml(sheet, "C1")).toContain("<v>10</v>")
		expect(fullCalc(workbook)).toBe(true)
		session.close()
	})

	it("holds a formula that reads a defined name the engine lacks", async () => {
		const { session, info } = await openFixture({
			workbookTail: '<definedNames><definedName name="avg">GETPIVOTDATA(One!$A$1,One!$A$2)</definedName></definedNames>',
			sheets: [
				{
					name: "One",
					body: `<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><f>IFERROR(avg,A1)</f><v>10</v></c><c r="D1"><f>C1*2</f><v>20</v></c></row>${XA}</sheetData>`
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "3"]]) }))

		const { sheet, workbook } = await saved(session)

		expect(cellXml(sheet, "C1")).toContain("<v>10</v>")
		expect(cellXml(sheet, "D1")).toContain("<v>20</v>")
		expect(fullCalc(workbook)).toBe(true)
		session.close()
	})
})

describe("sheet session: results held from the file", () => {
	it("asks Excel to recalculate when a precedent of a held result changes, and what reads it keeps calculating", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is><t>x</t></is></c>' +
						`<c r="C1"><f>_xlfn.FORECAST.ETS.SEASONALITY(A1:A2,B1:B2)</f><v>5</v></c><c r="D1"><f>C1*2</f><v>10</v></c><c r="E1"><f>C1+F1</f><v>5</v></c></row>${XA}</sheetData>`
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0

		// E1 reads the held 5 and the edited F1: calculated from both.
		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 5, "1"]]) }))
		expect(tileTexts(await firstTile(session, one)).get("0,4")).toBe("6")
		expect(fullCalc((await saved(session)).workbook)).toBe(false)

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "3"]]) }))
		expect(fullCalc((await saved(session)).workbook)).toBe(true)
		session.close()
	})

	it.each([
		// Over a block: what it gives the block's other cells is not calculated (one of a single cell is).
		["a legacy array formula", '<c r="C1"><f t="array" ref="C1:C2">SUM(A1:A2*B1:B2)</f><v>19</v></c>', '<c r="C2"><v>19</v></c>'],
		["a dynamic array", '<c r="C1" cm="1"><f t="array" ref="C1:C2">_xlfn.SEQUENCE(2,1,A1,1)</f><v>1</v></c>', '<c r="C2"><v>2</v></c>']
	] as const)("%s keeps its result and asks Excel to recalculate once a precedent changes", async (_label, cell, spill) => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: `<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>1</v></c>${cell}</row><row r="2"><c r="A2"><v>9</v></c><c r="B2"><v>2</v></c>${spill}</row></sheetData>`
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "3"]]) }))
		expect(fullCalc((await saved(session)).workbook)).toBe(true)
		session.close()
	})

	it("asks Excel to recalculate when a row insert moves what a held result reads", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><f>GETPIVOTDATA(A1,A3)</f><v>10</v></c></row><row r="2"><c r="A2"><v>9</v></c></row></sheetData>'
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0

		await session.intent()
		changeOf(await session.command({ type: "axis.insert", sheet: one, axis: "rows", at: 1, count: 1 }))
		expect(fullCalc((await saved(session)).workbook)).toBe(true)

		changeOf(await session.undo())
		expect(fullCalc((await saved(session)).workbook)).toBe(false)
		session.close()
	})

	it("treats one the engine cannot read as reading anything: any edit asks Excel to recalculate", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><f>SUM(Table1[Amount])</f><v>5</v></c><c r="D1"><f>C1*2</f><v>10</v></c></row></sheetData>'
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[8, 5, "7"]]) }))

		const tile = await firstTile(session, one)
		const { sheet, workbook } = await saved(session)

		expect([tileEntry(tile, 0, 2)?.text, tileEntry(tile, 0, 3)?.text]).toEqual(["5", "10"])
		expect(cellXml(sheet, "C1")).toContain("<v>5</v>")
		expect(fullCalc(workbook)).toBe(true)
		session.close()
	})

	it("keeps holding a stale legacy array block's result through undo, redo and later edits", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>1</v></c><c r="C1"><f t="array" ref="C1:C2">SUM(A1:A2*B1:B2)</f><v>19</v></c><c r="D1"><f>C1+1</f><v>20</v></c></row><row r="2"><c r="A2"><v>9</v></c><c r="B2"><v>2</v></c><c r="C2"><v>19</v></c></row></sheetData>'
				}
			]
		})
		const one = info.sheets[0]?.id ?? 0
		const shown = async (): Promise<(string | undefined)[]> => {
			const texts = tileTexts(await firstTile(session, one))

			return [texts.get("0,2"), texts.get("0,3")]
		}

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "3"]]) }))
		expect(await shown()).toEqual(["19", "20"])

		changeOf(await session.undo())
		changeOf(await session.redo())
		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[1, 1, "5"]]) }))
		expect(await shown()).toEqual(["19", "20"])
		expect(fullCalc((await saved(session)).workbook)).toBe(true)
		session.close()
	})
})

describe("sheet session: defined names the engine reads as references", () => {
	it("calculates a formula reading one (CustomCost1), and an unrelated edit marks nothing stale", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "Data",
					body: '<sheetData><row r="1"><c r="A1"><v>4</v></c><c r="B1"><f>CustomCost1*2</f><v>8</v></c></row></sheetData>'
				}
			],
			workbookTail: '<definedNames><definedName name="CustomCost1">Data!$A$1</definedName></definedNames>'
		})
		const data = info.sheets[0]?.id ?? 0

		changeOf(await session.command({ type: "cells.set", sheet: data, cells: cells([[40, 10, "1"]]) }))
		expect(fullCalc((await saved(session)).workbook)).toBe(false)

		changeOf(await session.command({ type: "cells.set", sheet: data, cells: cells([[0, 0, "5"]]) }))

		const { sheet, workbook } = await saved(session)

		expect(tileTexts(await firstTile(session, data)).get("0,1")).toBe("10")
		expect(cellXml(sheet, "B1")).toContain("<v>10</v>")
		expect(fullCalc(workbook)).toBe(false)
		session.close()
	})

	const cashflow = join(CORPUS_DIR, "xlsx", "govuk__Initial_Cashflow.xlsx")

	it.skipIf(!existsSync(cashflow))(
		"an unrelated entry in a workbook full of held results marks nothing stale",
		{ timeout: 120_000 },
		async () => {
			const { session, info } = await openFixture(new Uint8Array(readFileSync(cashflow)))
			const sheet = info.sheets.find(entry => entry.name === "ImportCosts")?.id ?? 0

			changeOf(await session.command({ type: "cells.set", sheet, cells: cells([[900, 40, "0"]]) }))
			changeOf(await session.command({ type: "cells.set", sheet, cells: cells([[901, 40, "1"]]) }))
			expect(fullCalc((await saved(session)).workbook)).toBe(false)
			session.close()
		}
	)
})

describe("sheet session: a formula written again as it was", () => {
	it("shows its result again (the engine reports no change for a value it already had)", async () => {
		const { session, info } = await openFixture({ sheets: [{ name: "One", body: "<sheetData/>" }] })
		const one = info.sheets[0]?.id ?? 0

		changeOf(
			await session.command({
				type: "cells.set",
				sheet: one,
				cells: cells([
					[0, 2, "=Calc!A1+1"],
					[1, 2, "=1/0"]
				])
			})
		)
		changeOf(
			await session.command({
				type: "cells.set",
				sheet: one,
				cells: cells([
					[0, 2, "=Calc!A1+1"],
					[1, 2, "=1/0"]
				])
			})
		)

		const texts = tileTexts(await firstTile(session, one))
		const reopened = await openFixture(await savedBytes(session))

		await reopened.session.intent()

		const again = tileTexts(await firstTile(reopened.session, one))

		expect([texts.get("0,2"), texts.get("1,2")]).toEqual(["#REF!", "#DIV/0!"])
		expect([again.get("0,2"), again.get("1,2")]).toEqual(["#REF!", "#DIV/0!"])
		reopened.session.close()
		session.close()
	})
})

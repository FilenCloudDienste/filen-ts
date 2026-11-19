import { describe, expect, it } from "vitest"
import type { SheetChange, SheetCommandResult } from "../core/sheet/protocol"
import { unzipSync, zipSync } from "fflate"
import { encodeUtf8 } from "../core/xml/index"
import { buildFixture, parts, type Fixture } from "./xlsxWriteFixtures"
import { ZIP_ENTRY_TIME } from "./zipTime"
import { firstTile, openFixture, savedBytes, tileEntry } from "./sheetSessionFixtures"

// Sheets deleted, moved, hidden and shown, and tab colours: what the saved workbook holds, and that an undo gives
// the source back.

function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok)
		throw new Error(`refused: ${result.refusal.reason}${result.refusal.detail === undefined ? "" : ` (${result.refusal.detail})`}`)

	return result.change
}

const THREE = {
	sheets: [
		{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' },
		{ name: "Two", body: '<sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData>' },
		{
			name: "Three",
			body: '<sheetData><row r="1"><c r="A1"><f>Two!A1+1</f><v>3</v></c><c r="B1"><f>SUM(One:Two!A1)</f><v>3</v></c></row></sheetData>'
		}
	],
	workbookTail:
		'<definedNames><definedName name="Local" localSheetId="1">Two!$A$1</definedName><definedName name="Global">Two!$A$1</definedName></definedNames>'
}

describe("sheet session: sheets deleted", () => {
	it("deletes a sheet, turns references to it into #REF! and drops its local names, and undoes to the source", async () => {
		const { session, info, bytes } = await openFixture(THREE)
		const [one, two, three] = info.sheets.map(sheet => sheet.id)
		const change = changeOf(await session.command({ type: "sheet.delete", sheet: two! }))

		expect(change.sheets?.map(sheet => sheet.name)).toEqual(["One", "Three"])

		const saved = parts(await savedBytes(session))

		expect(saved["xl/worksheets/sheet2.xml"]).toBeUndefined()
		expect(saved["xl/workbook.xml"]).not.toContain('name="Two"')
		expect(saved["xl/workbook.xml"]).not.toContain('name="Local"')
		expect(saved["xl/workbook.xml"]).toContain('<definedName name="Global">#REF!$A$1</definedName>')
		expect(saved["xl/worksheets/sheet3.xml"]).toContain("<f>#REF!A1+1</f>")
		// A 3-D span losing its last sheet narrows to the one before it.
		expect(saved["xl/worksheets/sheet3.xml"]).toContain("<f>SUM('One'!A1)</f>")
		expect(saved["[Content_Types].xml"]).not.toContain("sheet2.xml")
		expect(tileEntry(await firstTile(session, three!), 0, 0)?.input).toBe("=#REF!A1+1")

		changeOf(await session.undo())

		const undone = parts(await savedBytes(session))
		const source = parts(bytes)

		for (const name of Object.keys(source)) expect(undone[name], name).toBe(source[name])

		expect(one).toBeDefined()
		session.close()
	})

	it("refuses to delete the last visible sheet", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{ name: "One", body: "<sheetData/>" },
				{ name: "Two", body: "<sheetData/>" }
			],
			workbookTail: ""
		})

		changeOf(await session.command({ type: "sheet.state", sheet: info.sheets[1]!.id, state: "hidden" }))

		const result = await session.command({ type: "sheet.delete", sheet: info.sheets[0]!.id })

		expect(result.ok ? null : result.refusal.reason).toBe("lastSheet")
		session.close()
	})
})

describe("sheet session: sheets moved", () => {
	it("moves a sheet, writes a 3-D span whose ends swapped in sheet order, and keeps local names on their sheet", async () => {
		const { session, info, bytes } = await openFixture(THREE)
		const one = info.sheets[0]!.id

		changeOf(await session.command({ type: "sheet.move", sheet: one, to: 2 }))

		const saved = parts(await savedBytes(session))
		const workbook = saved["xl/workbook.xml"] ?? ""

		expect(workbook.indexOf('name="Two"')).toBeLessThan(workbook.indexOf('name="One"'))
		expect(workbook).toContain('<definedName name="Local" localSheetId="0">Two!$A$1</definedName>')
		expect(saved["xl/worksheets/sheet3.xml"]).toContain("<f>SUM('Two:One'!A1)</f>")

		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toBe(parts(bytes)["xl/workbook.xml"])
		session.close()
	})
})

// A filled-down formula is one shared master and children whose stored text is empty, each reading a name over a
// 3-D span; the stored results are stale (99). A delete or move that rewrites the name recalculates them all.
const SPANNED = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*SUM(Span)</f><v>99</v></c></row>' +
				'<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>99</v></c></row>' +
				'<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>99</v></c></row></sheetData>'
		},
		{ name: "Two", body: '<sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData>' },
		{ name: "Three", body: '<sheetData><row r="1"><c r="A1"><v>3</v></c></row></sheetData>' }
	],
	workbookTail: '<definedNames><definedName name="Span">Two:Three!$A$1</definedName></definedNames>'
}

async function spannedResults(session: Awaited<ReturnType<typeof openFixture>>["session"], sheet: number) {
	const tile = await firstTile(session, sheet)
	const saved = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

	return {
		shown: [0, 1, 2].map(row => tileEntry(tile, row, 1)?.text),
		saved: ["B1", "B2", "B3"].map(ref => new RegExp(`<c r="${ref}"[^>]*>.*?<v>(.*?)</v></c>`).exec(saved)?.[1])
	}
}

// A name pointing at a sheet, read by a filled-down formula (a shared master and children) and an ordinary one, all
// with stale stored results (99).
const NAMED_CELL = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*Rate</f><v>99</v></c>' +
				'<c r="C1"><f>IFERROR(Rate,0)+1</f><v>99</v></c><c r="D1"><f>Rate+1</f><v>99</v></c></row>' +
				'<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>99</v></c></row>' +
				'<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>99</v></c></row></sheetData>'
		},
		{ name: "Two", body: '<sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData>' }
	],
	workbookTail: '<definedNames><definedName name="Rate">Two!$A$1</definedName></definedNames>'
}

async function namedResults(session: Awaited<ReturnType<typeof openFixture>>["session"], sheet: number) {
	const tile = await firstTile(session, sheet)
	const saved = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""
	const cells = [
		[0, 1, "B1"],
		[1, 1, "B2"],
		[2, 1, "B3"],
		[0, 2, "C1"],
		[0, 3, "D1"]
	] as const

	return {
		shown: cells.map(([row, col]) => tileEntry(tile, row, col)?.text),
		saved: cells.map(([, , ref]) => new RegExp(`<c r="${ref}"[^>]*>.*?<v>(.*?)</v></c>`).exec(saved)?.[1])
	}
}

describe("sheet session: shared formulas reading a name a sheet edit changed", () => {
	it("recalculates every child once a delete narrows the name", async () => {
		const { session, info } = await openFixture(SPANNED)
		const [one, , three] = info.sheets.map(sheet => sheet.id)

		changeOf(await session.command({ type: "sheet.delete", sheet: three! }))
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toContain("<definedName name=\"Span\">'Two'!$A$1</definedName>")
		expect(await spannedResults(session, one!)).toEqual({ shown: ["2", "4", "6"], saved: ["2", "4", "6"] })
		session.close()
	})

	it("calculates what reads a name into a deleted sheet as #REF!, master and children alike, and undoes", async () => {
		const { session, info } = await openFixture(NAMED_CELL)
		const [one, two] = info.sheets.map(sheet => sheet.id)

		changeOf(await session.command({ type: "sheet.delete", sheet: two! }))
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toContain('<definedName name="Rate">#REF!$A$1</definedName>')
		expect(await namedResults(session, one!)).toEqual({
			shown: ["#REF!", "#REF!", "#REF!", "1", "#REF!"],
			saved: ["#REF!", "#REF!", "#REF!", "1", "#REF!"]
		})

		changeOf(await session.undo())
		expect(await namedResults(session, one!)).toEqual({
			shown: ["99", "99", "99", "99", "99"],
			saved: ["99", "99", "99", "99", "99"]
		})
		session.close()
	})

	it("recalculates every child once a move swaps the name's span", async () => {
		const { session, info } = await openFixture(SPANNED)
		const [one, two] = info.sheets.map(sheet => sheet.id)

		changeOf(await session.command({ type: "sheet.move", sheet: two!, to: 2 }))

		// The engine takes no 3-D span in a name: every cell as the master, none keeping the stale 99.
		expect(await spannedResults(session, one!)).toEqual({
			shown: ["#REF!", "#REF!", "#REF!"],
			saved: ["#REF!", "#REF!", "#REF!"]
		})
		session.close()
	})
})

describe("sheet session: sheets hidden and shown", () => {
	it("hides the active sheet, moving the active tab to the next visible one, and shows it again", async () => {
		const { session, info, bytes } = await openFixture({
			sheets: [
				{ name: "One", body: '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetData/>' },
				{ name: "Two", body: '<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData/>' }
			]
		})
		const one = info.sheets[0]!.id
		const change = changeOf(await session.command({ type: "sheet.state", sheet: one, state: "hidden" }))

		expect(change.sheets?.find(sheet => sheet.id === one)?.state).toBe("hidden")

		const saved = parts(await savedBytes(session))

		expect(saved["xl/workbook.xml"]).toContain('<sheet name="One" sheetId="1" r:id="rId1" state="hidden"/>')
		expect(saved["xl/workbook.xml"]).toMatch(/activeTab="1"/)
		expect(saved["xl/worksheets/sheet1.xml"]).not.toContain('tabSelected="1"')
		expect(saved["xl/worksheets/sheet2.xml"]).toContain('tabSelected="1"')

		changeOf(await session.command({ type: "sheet.state", sheet: one, state: "visible" }))
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toContain('<sheet name="One" sheetId="1" r:id="rId1"/>')

		changeOf(await session.undo())
		changeOf(await session.undo())

		const undone = parts(await savedBytes(session))

		for (const name of ["xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"])
			expect(undone[name], name).toBe(parts(bytes)[name])

		session.close()
	})

	it("refuses to hide the last visible sheet, and refuses under workbook structure protection", async () => {
		const single = await openFixture({ sheets: [{ name: "One", body: "<sheetData/>" }] })
		const hidden = await single.session.command({ type: "sheet.state", sheet: single.info.sheets[0]!.id, state: "hidden" })

		expect(hidden.ok ? null : hidden.refusal.reason).toBe("lastSheet")
		single.session.close()

		const locked = await openFixture({
			sheets: [
				{ name: "One", body: "<sheetData/>" },
				{ name: "Two", body: "<sheetData/>" }
			],
			workbookTail: '<workbookProtection lockStructure="1"/>'
		})
		const refused = await locked.session.command({ type: "sheet.state", sheet: locked.info.sheets[0]!.id, state: "hidden" })

		expect(refused.ok ? null : refused.refusal.reason).toBe("protectedWorkbook")
		locked.session.close()
	})
})

describe("sheet session: tab colours", () => {
	it("writes a tab colour into the sheet's properties and takes it off", async () => {
		const { session, info, bytes } = await openFixture({ sheets: [{ name: "One", body: "<sheetData/>" }] })
		const one = info.sheets[0]!.id
		const change = changeOf(await session.command({ type: "sheet.tabColor", sheet: one, color: 0xff0000 }))

		expect(change.sheets?.[0]?.tabColor).toBe(0xff0000)
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('<tabColor rgb="FFFF0000"/>')

		changeOf(await session.command({ type: "sheet.tabColor", sheet: one, color: null }))
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})
})

function withPart(fixture: Fixture, name: string, text: string): Uint8Array {
	const files = unzipSync(buildFixture(fixture))

	files[name] = Uint8Array.from(encodeUtf8(text))

	return new Uint8Array(zipSync(files, { mtime: ZIP_ENTRY_TIME }))
}

describe("sheet session: the sheet list after an undo", () => {
	it("writes the workbook's sheet list as it was, white space included, once a move is undone", async () => {
		const fixture = {
			sheets: [
				{ name: "One", body: "<sheetData/>" },
				{ name: "Two", body: "<sheetData/>" }
			]
		}
		const source = parts(buildFixture(fixture))
		const spaced = (source["xl/workbook.xml"] ?? "").replace("<sheets>", "<sheets>\n    ").replace("</sheets>", "\n  </sheets>")
		const { session, info, bytes } = await openFixture(withPart(fixture, "xl/workbook.xml", spaced))

		changeOf(await session.command({ type: "sheet.move", sheet: info.sheets[0]!.id, to: 1 }))
		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toBe(parts(bytes)["xl/workbook.xml"])
		session.close()
	})
})

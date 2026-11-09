import { strFromU8, unzipSync } from "fflate"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { odsProof } from "../core/ods/write/save"
import type { SheetCommand, SheetCommandResult } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { unheldDifference, type OdsUnheld, type UnheldItem } from "../core/ods/unheld"
import { SourceAxis } from "../core/ods/write/axis"
import { ChangeLog } from "../core/xlsx/model/changes"
import { odsBytes, table, type OdsParts } from "./odsFixtures"
import { IMMEDIATE } from "./sheetSessionFixtures"
import { budget, cpuMs } from "./timing"

// What an OpenDocument spreadsheet names cells by but the model does not carry (formulas outside the engine's
// grammar, shapes anchored to a range, refused names, database, label and DataPilot ranges): moved with the rows
// and columns as LibreOffice moves them, the edit refused where that cannot be sure, and read back by the proof.

async function open(parts: OdsParts) {
	const host = inThreadSheetHost()
	const result = await host.open(odsBytes(parts), { kind: "ods", slicing: IMMEDIATE, settings: { author: "Test" } }, () => undefined)

	if (result.kind !== "opened") throw new Error(result.kind === "failed" ? result.message : result.kind)

	expect(await result.session.intent()).toEqual({ state: "writable" })

	return { session: result.session, sheets: result.info.sheets.map(sheet => sheet.id) }
}

type Session = Awaited<ReturnType<typeof open>>["session"]

async function run(session: Session, command: SheetCommand): Promise<SheetCommandResult> {
	return session.command(command)
}

async function ok(session: Session, command: SheetCommand): Promise<void> {
	const result = await run(session, command)

	if (!result.ok) throw new Error(`${command.type}: ${JSON.stringify(result.refusal)}`)
}

async function saved(session: Session): Promise<string> {
	const result = await session.save()

	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))
}

const cell = (value: string): string =>
	/^\d+$/.test(value)
		? `<table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`
		: `<table:table-cell office:value-type="string"><text:p>${value}</text:p></table:table-cell>`

// B() is LibreOffice's binomial, which the engine's grammar does not take: only its cached result is shown.
const kept = (formula: string): string =>
	`<table:table-cell table:formula="${formula}" office:value-type="float" office:value="0.15625"><text:p>0.15625</text:p></table:table-cell>`

const COLUMNS = '<table:table-column table:number-columns-repeated="4"/>'
const DATA = ["1", "2", "3", "5", "4"]
	.map(v => `<table:table-row><table:table-cell table:number-columns-repeated="2"/>${cell(v)}</table:table-row>`)
	.join("")

function sheet(rows: string, name = "S"): string {
	return table(name, rows, COLUMNS)
}

const formulas = (xml: string): string[] =>
	[...xml.matchAll(/table:formula="([^"]*)"/g)].map(match => (match[1] ?? "").replaceAll("&apos;", "'").replaceAll("&quot;", '"'))

beforeAll(() => {
	odsProof.whole = true
})
afterAll(() => {
	odsProof.whole = false
})

describe("ODS formulas the model does not carry", () => {
	const parts = { body: sheet(`<table:table-row>${kept("of:=B([.C5];0.5;1)")}<table:table-cell/>${cell("9")}</table:table-row>${DATA}`) }

	for (const [label, command, formula] of [
		["a column inserted before", { type: "axis.insert", axis: "cols", at: 0, count: 1 }, "of:=B([.D5];0.5;1)"],
		["rows inserted above", { type: "axis.insert", axis: "rows", at: 1, count: 2 }, "of:=B([.C7];0.5;1)"],
		["a row deleted above", { type: "axis.delete", axis: "rows", at: 1, count: 1 }, "of:=B([.C4];0.5;1)"],
		["a column deleted before", { type: "axis.delete", axis: "cols", at: 1, count: 1 }, "of:=B([.B5];0.5;1)"]
	] as const)
		it(`moves the cell it reads with ${label}`, async () => {
			const { session, sheets } = await open(parts)

			await ok(session, { ...command, sheet: sheets[0] ?? 0 } as SheetCommand)

			expect(formulas(await saved(session))).toEqual([formula])
			session.close()
		})

	it("refuses deleting the cell it reads, which no address names any more", async () => {
		const { session, sheets } = await open(parts)
		const result = await run(session, { type: "axis.delete", sheet: sheets[0] ?? 0, axis: "cols", at: 2, count: 1 })

		expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "unsupported", detail: "keptReferences" })
		session.close()
	})

	it("shrinks a range it reads that loses some of its rows, as LibreOffice does", async () => {
		const { session, sheets } = await open({
			body: sheet(`<table:table-row>${kept("of:=B([.C2:.C6];0.5;1)")}</table:table-row>${DATA}`)
		})

		await ok(session, { type: "axis.delete", sheet: sheets[0] ?? 0, axis: "rows", at: 1, count: 2 })

		expect(formulas(await saved(session))).toEqual(["of:=B([.C2:.C4];0.5;1)"])
		session.close()
	})

	it("moves references to another sheet and follows its rename", async () => {
		const { session, sheets } = await open({
			body: sheet(DATA) + sheet(`<table:table-row>${kept("of:=B([$S.C5];0.5;1)+B([$S.$C$1:.$C$2];0.5;1)")}</table:table-row>`, "T")
		})
		const s = sheets[0] ?? 0

		await ok(session, { type: "axis.insert", sheet: s, axis: "rows", at: 0, count: 1 })
		await ok(session, { type: "sheet.rename", sheet: s, name: "Data sheet" })

		expect(formulas(await saved(session))).toEqual(["of:=B([$'Data sheet'.C6];0.5;1)+B([$'Data sheet'.$C$2:.$C$3];0.5;1)"])
		session.close()
	})

	it("refuses deleting a sheet one of them reads", async () => {
		const { session, sheets } = await open({
			body: sheet(DATA) + sheet(`<table:table-row>${kept("of:=B([$S.C5];0.5;1)")}</table:table-row>`, "T")
		})
		const result = await run(session, { type: "sheet.delete", sheet: sheets[0] ?? 0 })

		expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "unsupported", detail: "keptReferences" })
		session.close()
	})

	it("refuses a sort or a cut moving one, which would land as its result alone", async () => {
		const { session, sheets } = await open({
			body: sheet(`<table:table-row>${kept("of:=B([.C5];0.5;1)")}<table:table-cell/>${cell("1")}</table:table-row>${DATA}`)
		})
		const result = await run(session, {
			type: "sort.apply",
			sheet: sheets[0] ?? 0,
			range: { startRow: 0, startCol: 0, endRow: 5, endCol: 2 },
			orientation: "rows",
			header: false,
			caseSensitive: false,
			keys: [{ index: 2, descending: true }]
		})

		expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "formula", detail: "keptFormula" })
		session.close()
	})

	it("still takes a plain edit after a refused one", async () => {
		const conditional =
			'<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="S.C1:S.C6"><calcext:condition calcext:apply-style-name="Default" calcext:value="&gt;3" calcext:base-cell-address="S.C1"/></calcext:conditional-format></calcext:conditional-formats>'
		const { session, sheets } = await open({ body: table("S", DATA + conditional, COLUMNS) })
		const s = sheets[0] ?? 0
		// Cells shifted down in the format's column: LibreOffice would not move its range so.
		const refused = await run(session, {
			type: "cells.shift",
			sheet: s,
			range: { startRow: 0, startCol: 2, endRow: 0, endCol: 2 },
			edit: "insert",
			axis: "rows"
		})

		expect(refused.ok ? "ok" : refused.refusal).toEqual({ reason: "unsupported", detail: "conditionalFormatting" })

		await ok(session, { type: "cells.set", sheet: s, cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["hello"] } })
		await ok(session, {
			type: "format.apply",
			sheet: s,
			ranges: [{ startRow: 1, startCol: 2, endRow: 1, endCol: 2 }],
			patch: { bold: true }
		})

		expect(await saved(session)).toContain("<text:p>hello</text:p>")
		session.close()
	})
})

describe("ODS cells holding a formula the model does not carry, edited otherwise", () => {
	const parts = { body: sheet(`<table:table-row>${kept("of:=B([.C5];0.5;1)")}<table:table-cell/>${cell("9")}</table:table-row>${DATA}`) }
	const A1 = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }

	for (const [label, commands, formula] of [
		["made bold", [{ type: "format.apply", ranges: [A1], patch: { bold: true } }], "of:=B([.C5];0.5;1)"],
		["given a number format", [{ type: "format.apply", ranges: [A1], patch: { numFmt: "0.00" } }], "of:=B([.C5];0.5;1)"],
		["given a note", [{ type: "note.set", row: 0, col: 0, text: "hi" }], "of:=B([.C5];0.5;1)"],
		["given a link", [{ type: "link.set", ranges: [A1], target: { url: "https://example.com" } }], "of:=B([.C5];0.5;1)"],
		["merged with the cell beside it", [{ type: "merge.cells", ranges: [{ ...A1, endCol: 1 }] }], "of:=B([.C5];0.5;1)"],
		[
			"made bold, then a column inserted before",
			[
				{ type: "format.apply", ranges: [A1], patch: { bold: true } },
				{ type: "axis.insert", axis: "cols", at: 0, count: 1 }
			],
			"of:=B([.D5];0.5;1)"
		]
	] as const)
		it(`keeps the formula of a cell ${label}`, async () => {
			const { session, sheets } = await open(parts)

			for (const command of commands) await ok(session, { ...command, sheet: sheets[0] ?? 0 } as SheetCommand)

			expect(formulas(await saved(session))).toEqual([formula])
			session.close()
		})

	const clipboard = async (session: Session, sheet: number, range: typeof A1, cut: boolean, at: { row: number; col: number }) => {
		const copied = await session.query("copy", { sheet, range, cut })

		if ("refused" in copied) throw new Error("copy refused")

		return run(session, { type: "clipboard.paste", sheet, at, text: copied.text, clip: copied.clip })
	}

	for (const [label, range, at] of [
		["the cell one reads", { startRow: 4, startCol: 2, endRow: 4, endCol: 2 }, { row: 4, col: 4 }],
		["a range holding the cell one reads", { startRow: 1, startCol: 2, endRow: 4, endCol: 2 }, { row: 1, col: 4 }]
	] as const)
		it(`refuses cutting ${label} elsewhere, which would leave its address behind`, async () => {
			const { session, sheets } = await open(parts)
			const result = await clipboard(session, sheets[0] ?? 0, range, true, at)

			expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "unsupported", detail: "keptReferences" })
			session.close()
		})

	it("cuts a cell none of them reads", async () => {
		const { session, sheets } = await open(parts)
		const result = await clipboard(session, sheets[0] ?? 0, { startRow: 2, startCol: 2, endRow: 2, endCol: 2 }, true, {
			row: 2,
			col: 5
		})

		expect(result.ok).toBe(true)
		expect(formulas(await saved(session))).toEqual(["of:=B([.C5];0.5;1)"])
		session.close()
	})

	it("refuses copying one, which would paste its result alone", async () => {
		const { session, sheets } = await open(parts)
		const result = await clipboard(session, sheets[0] ?? 0, A1, false, { row: 9, col: 0 })

		expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "formula", detail: "keptFormula" })
		session.close()
	})
})

describe("ODS rows formatted to the grid's last column", () => {
	for (const declared of ["4", "1024"])
		for (const [label, range] of [
			["a whole row", { startRow: 0, startCol: 0, endRow: 0, endCol: 16_383 }],
			["three whole rows", { startRow: 0, startCol: 0, endRow: 2, endCol: 16_383 }],
			["an empty row past the last", { startRow: 4, startCol: 0, endRow: 4, endCol: 16_383 }]
		] as const)
			it(`saves ${label} made bold where the table declares ${declared} columns`, async () => {
				const { session, sheets } = await open({
					body: table(
						"S",
						`<table:table-row>${cell("a")}${cell("b")}${cell("c")}</table:table-row>`,
						`<table:table-column table:number-columns-repeated="${declared}"/>`
					)
				})

				await ok(session, { type: "format.apply", sheet: sheets[0] ?? 0, ranges: [range], patch: { bold: true } })

				const xml = await saved(session)

				// Each cell names the style, to the last column (LibreOffice 7.5 reads no row's default cell style).
				if (label === "a whole row")
					expect(xml).toMatch(/<table:table-cell table:style-name="[^"]+" table:number-columns-repeated="16381"\/>/)
				session.close()
			})
})

describe("The change log of an edit refused and undone", () => {
	it("keeps no mark the edit made first, and every mark made before it", () => {
		const changes = new ChangeLog(() => undefined)

		changes.sheetSection(0, "cols")
		changes.beginJournal()
		changes.sheetSection(0, "cols")
		changes.sheetSection(0, "conditionalFormatting")
		changes.workbookSection("definedNames")

		expect([...(changes.endJournal() ?? [])].map(mark => mark.split("\u0000").join(" "))).toEqual([
			"s 0 cols",
			"s 0 conditionalFormatting",
			"w definedNames"
		])

		// The undo marks them again; then what the edit marked first is taken back.
		changes.sheetSection(0, "conditionalFormatting")
		changes.forgetJournal()

		expect([...(changes.sheets.get(0)?.sections.keys() ?? [])]).toEqual(["cols"])
		expect(changes.workbookSections.size).toBe(0)
	})
})

describe("ODS ranges outside the cells", () => {
	const ranges = (after: string) => ({ body: sheet(`<table:table-row>${cell("x")}</table:table-row>${DATA}`) + after })

	it("moves a database range, a label range and a DataPilot table with a column inserted", async () => {
		const { session, sheets } = await open(
			ranges(
				'<table:database-ranges><table:database-range table:name="Data1" table:target-range-address="S.C1:S.C6"/></table:database-ranges>' +
					'<table:data-pilot-tables><table:data-pilot-table table:name="P" table:target-range-address="S.E1:S.F3"><table:source-cell-range table:cell-range-address="S.C1:S.C6"/><table:data-pilot-field table:source-field-name="x" table:orientation="row"/></table:data-pilot-table></table:data-pilot-tables>' +
					'<table:label-ranges><table:label-range table:label-cell-range-address="S.C1:S.C1" table:data-cell-range-address="S.C2:S.C6" table:orientation="column"/></table:label-ranges>'
			)
		)

		await ok(session, { type: "axis.insert", sheet: sheets[0] ?? 0, axis: "cols", at: 0, count: 1 })

		const xml = await saved(session)

		expect(xml).toContain('table:target-range-address="S.D1:S.D6"')
		expect(xml).toContain('table:target-range-address="S.F1:S.G3"')
		expect(xml).toContain('table:cell-range-address="S.D1:S.D6"')
		expect(xml).toContain('table:label-cell-range-address="S.D1:S.D1" table:data-cell-range-address="S.D2:S.D6"')
		session.close()
	})

	it("moves a database range whose sort names its columns only whole, refusing a column inserted inside it", async () => {
		const sorted =
			'<table:database-ranges><table:database-range table:name="Sorted" table:target-range-address="S.A1:S.C6"><table:sort><table:sort-by table:field-number="2"/></table:sort></table:database-range></table:database-ranges>'
		const { session, sheets } = await open(ranges(sorted))
		const s = sheets[0] ?? 0
		const inside = await run(session, { type: "axis.insert", sheet: s, axis: "cols", at: 1, count: 1 })

		expect(inside.ok ? "ok" : inside.refusal).toEqual({ reason: "unsupported", detail: "keptReferences" })

		await ok(session, { type: "axis.insert", sheet: s, axis: "rows", at: 0, count: 1 })

		expect(await saved(session)).toContain('table:target-range-address="S.A2:S.C7"')
		session.close()
	})

	it("moves a named expression the engine does not take, refusing one relative to where it is used", async () => {
		const names = (expression: string): string =>
			`<table:named-expressions><table:named-expression table:name="Odd" table:expression="${expression}" table:base-cell-address="$S.$A$1"/></table:named-expressions>`
		const absolute = await open(ranges(names("of:=B([$S.$C$5];0.5;1)")))

		await ok(absolute.session, { type: "axis.insert", sheet: absolute.sheets[0] ?? 0, axis: "rows", at: 0, count: 1 })

		expect(await saved(absolute.session)).toContain('table:expression="of:=B([$S.$C$6];0.5;1)"')
		absolute.session.close()

		const relative = await open(ranges(names("of:=B([.C5];0.5;1)")))
		const result = await run(relative.session, { type: "axis.insert", sheet: relative.sheets[0] ?? 0, axis: "rows", at: 0, count: 1 })

		expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "unsupported", detail: "keptReferences" })
		relative.session.close()
	})
})

describe("ODS addresses kept as written", () => {
	it("refuses moving rows or renaming a sheet where tracked changes name cells by position", async () => {
		const { session, sheets } = await open({ body: '<table:tracked-changes table:track-changes="false"/>' + sheet(DATA) })
		const s = sheets[0] ?? 0

		for (const command of [
			{ type: "axis.insert", sheet: s, axis: "rows", at: 0, count: 1 },
			{ type: "sheet.rename", sheet: s, name: "Other" }
		] as const) {
			const result = await run(session, command)

			expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "unsupported", detail: "trackedChanges" })
		}

		await ok(session, { type: "cells.set", sheet: s, cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["x"] } })
		session.close()
	})

	it("refuses moving the columns of a sheet with detective marks, and only its", async () => {
		const marked =
			'<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p><table:detective><table:highlighted-range table:cell-range-address="S.C1:S.C5" table:direction="from-another-table"/></table:detective></table:table-cell></table:table-row>'
		const { session, sheets } = await open({ body: sheet(marked + DATA) + sheet(DATA, "T") })
		const result = await run(session, { type: "axis.insert", sheet: sheets[0] ?? 0, axis: "cols", at: 0, count: 1 })

		expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "unsupported", detail: "detective" })

		await ok(session, { type: "axis.insert", sheet: sheets[1] ?? 1, axis: "cols", at: 0, count: 1 })
		session.close()
	})
})

describe("ODS shapes anchored to a cell range", () => {
	const frame =
		'<draw:frame draw:name="Image 1" table:end-cell-address="S.D4" table:end-x="0.5cm" table:end-y="0.5cm" svg:width="5cm" svg:height="3cm" svg:x="0cm" svg:y="0cm"><draw:image xlink:href="Pictures/a.png" xlink:type="simple"><text:p/></draw:image></draw:frame>'
	const PNG = Uint8Array.from(
		atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
		c => c.charCodeAt(0)
	)
	const parts = {
		body: sheet(
			`<table:table-row>${cell("a")}<table:table-cell office:value-type="string">${frame}<text:p>b</text:p></table:table-cell>${cell("c")}</table:table-row><table:table-row>${cell("1")}${cell("2")}</table:table-row>`
		),
		extra: [{ name: "Pictures/a.png", data: PNG }]
	}
	const end = (xml: string): string => /table:end-cell-address="([^"]*)"/.exec(xml)?.[1] ?? ""

	// LibreOffice 7.5 over UNO: its end cell moves with an insert before the shape or inside it (the shape
	// stretching), and a delete inside it; a delete of the end cell's own column or row resizes it otherwise.
	for (const [label, command, address] of [
		["a column inserted before it", { type: "axis.insert", axis: "cols", at: 0, count: 1 }, "S.E4"],
		["a column inserted inside it", { type: "axis.insert", axis: "cols", at: 2, count: 1 }, "S.E4"],
		["a column deleted inside it", { type: "axis.delete", axis: "cols", at: 2, count: 1 }, "S.C4"],
		["a row inserted inside it", { type: "axis.insert", axis: "rows", at: 1, count: 2 }, "S.D6"]
	] as const)
		it(`moves its end cell with ${label}`, async () => {
			const { session, sheets } = await open(parts)

			await ok(session, { ...command, sheet: sheets[0] ?? 0 } as SheetCommand)

			expect(end(await saved(session))).toBe(address)
			session.close()
		})

	it("refuses deleting its end cell's column", async () => {
		const { session, sheets } = await open(parts)
		const result = await run(session, { type: "axis.delete", sheet: sheets[0] ?? 0, axis: "cols", at: 3, count: 1 })

		expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "unsupported", detail: "keptReferences" })
		session.close()
	})
})

describe("ODS structure edits over hostile and tall sheets", () => {
	it("saves a column insert past a cell repeated 10^15 times at once", { timeout: 20_000 }, async () => {
		const { session, sheets } = await open({
			body: sheet(
				`<table:table-row>${cell("1")}<table:table-cell table:number-columns-repeated="1000000000000000"/></table:table-row><table:table-row>${cell("2")}</table:table-row>`
			)
		})

		await ok(session, { type: "axis.insert", sheet: sheets[0] ?? 0, axis: "cols", at: 0, count: 1 })

		const started = cpuMs()
		const xml = await saved(session)

		expect(cpuMs() - started).toBeLessThan(budget(5_000))
		expect(xml).toContain('<table:table-cell table:number-columns-repeated="16382"/>')
		session.close()
	})

	it("saves a row and a column insert past a row repeated 10^15 times at once", { timeout: 20_000 }, async () => {
		const { session, sheets } = await open({
			body: sheet(
				`<table:table-row>${cell("1")}</table:table-row><table:table-row table:number-rows-repeated="1000000000000000"><table:table-cell table:number-columns-repeated="1000000000000000"/></table:table-row>`
			)
		})

		await ok(session, { type: "axis.insert", sheet: sheets[0] ?? 0, axis: "rows", at: 0, count: 1 })
		await ok(session, { type: "axis.insert", sheet: sheets[0] ?? 0, axis: "cols", at: 0, count: 1 })

		const started = cpuMs()
		const xml = await saved(session)

		expect(cpuMs() - started).toBeLessThan(budget(5_000))
		expect(xml).toContain('<table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell>')
		session.close()
	})

	it("saves a column insert beside a merge a million rows tall without walking it per row element", { timeout: 60_000 }, async () => {
		let rows = `<table:table-row>${cell("0")}<table:table-cell table:number-rows-spanned="1000000" office:value-type="string"><text:p>m</text:p></table:table-cell></table:table-row>`

		for (let k = 1; k < 3000; k++) rows += `<table:table-row>${cell(String(k))}<table:covered-table-cell/></table:table-row>`

		const { session, sheets } = await open({ body: sheet(rows) })

		await ok(session, { type: "axis.insert", sheet: sheets[0] ?? 0, axis: "cols", at: 0, count: 1 })

		const started = cpuMs()

		await saved(session)

		// Walking the merge's million rows for each of the 3,000 row elements took 13 s.
		expect(cpuMs() - started).toBeLessThan(budget(6_000))
		session.close()
	})
})

describe("The proof of what the model does not carry", () => {
	const item = (text: string, col = 0): UnheldItem => ({ kind: "formula", sheet: "S", row: 0, rows: 1, col, cols: 1, key: "", text })
	const unheld = (items: UnheldItem[]): OdsUnheld => ({
		items,
		formulas: new Set(items.map(entry => entry.text)),
		rows: new Map([["S", new Set([0])]]),
		opaque: null,
		pinned: new Map()
	})
	const moved = {
		sheets: [
			{
				id: 0,
				name: "S",
				model: {
					rowAxis: SourceAxis.identity(1_048_576),
					colAxis: SourceAxis.identity(16_384).shifted({ type: "insert", axis: "cols", at: 0, count: 1 }, "cols", 16_384)
				}
			}
		]
	}
	const tables = [{ id: 0, name: "S" }]

	it("refuses a formula lost from a cell still holding its result", () => {
		const before = { tables, unheld: unheld([{ ...item("of:=B([.C5];0.5;1)"), cached: '[1,0.15625,""]' }]) }
		const holding = (): string => '[1,0.15625,""]'

		expect(unheldDifference(moved, before, { tables, unheld: unheld([item("of:=B([.D5];0.5;1)", 1)]) }, holding)).toBeNull()
		expect(unheldDifference(moved, before, { tables, unheld: unheld([]) }, holding)).toBe(
			"S B1: its formula of:=B([.C5];0.5;1) is not read back"
		)
		// Overwritten: the formula goes with its result.
		expect(unheldDifference(moved, before, { tables, unheld: unheld([]) }, () => '[1,5,""]')).toBeNull()
	})

	it("refuses a formula read back with the address it had before the column insert", () => {
		const before = { tables, unheld: unheld([item("of:=B([.C5];0.5;1)")]) }

		expect(unheldDifference(moved, before, { tables, unheld: unheld([item("of:=B([.D5];0.5;1)", 1)]) })).toBeNull()
		expect(unheldDifference(moved, before, { tables, unheld: unheld([item("of:=B([.C5];0.5;1)", 1)]) })).toBe(
			"S B1: formula reads of:=B([.C5];0.5;1)"
		)
	})
})

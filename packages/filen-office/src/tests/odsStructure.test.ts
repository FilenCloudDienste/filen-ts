import { strFromU8, unzipSync } from "fflate"
import { odsProof } from "../core/ods/write/save"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openOds } from "../core/ods/open"
import type { SheetCommand } from "../core/sheet/protocol"
import type { SheetStore } from "../core/xlsx/model/store"
import { inThreadSheetHost } from "../dom/sheet/host"
import { odsBytes, odsDocument, shownRows, table, type OdsParts } from "./odsFixtures"
import { IMMEDIATE } from "./sheetSessionFixtures"

// Structure and format edits on an OpenDocument spreadsheet, saved and read back: rows and columns inserted and
// deleted (repeated rows and cells split around them), sheets added, renamed, moved, duplicated and deleted, formats
// and sizes written as automatic styles.

async function open(parts: OdsParts) {
	const host = inThreadSheetHost()
	const result = await host.open(odsBytes(parts), { kind: "ods", slicing: IMMEDIATE, settings: { author: "Test" } }, () => undefined)

	if (result.kind !== "opened") throw new Error(result.kind === "failed" ? result.message : result.kind)

	expect(await result.session.intent()).toEqual({ state: "writable" })

	return { session: result.session, sheets: result.info.sheets.map(sheet => sheet.id) }
}

type Session = Awaited<ReturnType<typeof open>>["session"]

async function run(session: Session, command: SheetCommand): Promise<void> {
	const result = await session.command(command)

	if (!result.ok) throw new Error(`${command.type}: ${JSON.stringify(result.refusal)}`)
}

async function saved(session: Session): Promise<Uint8Array> {
	const result = await session.save()

	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return result.bytes
}

async function readBack(bytes: Uint8Array) {
	const opened = await openOds(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.message)

	const document = odsDocument(opened)

	await document.readyAllSheets()

	return { document, names: opened.workbook.sheets.map(sheet => sheet.name), rows: (sheet: number) => shownRows(document, sheet) }
}

function content(bytes: Uint8Array): string {
	return strFromU8(unzipSync(bytes)["content.xml"] ?? new Uint8Array(0))
}

const set = (sheet: number, row: number, col: number, input: string): SheetCommand => ({
	type: "cells.set",
	sheet,
	cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [input] }
})

const cell = (value: string): string =>
	/^\d+$/.test(value)
		? `<table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`
		: `<table:table-cell office:value-type="string"><text:p>${value}</text:p></table:table-cell>`

const GRID =
	'<table:table-column table:number-columns-repeated="4"/>' +
	`<table:table-row>${cell("a")}${cell("b")}${cell("c")}<table:table-cell/></table:table-row>` +
	`<table:table-row table:number-rows-repeated="3">${cell("1")}${cell("2")}<table:table-cell table:number-columns-repeated="2"/></table:table-row>` +
	`<table:table-row>${cell("x")}<table:table-cell table:formula="of:=SUM([.A2:.A4])" office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row>`

// Every save proved by the whole file too where the rows it wrote proved it: the two never disagree.
beforeAll(() => {
	odsProof.whole = true
})
afterAll(() => {
	odsProof.whole = false
})

describe("ODS structure edits", () => {
	it("inserts rows inside a repeated row, moving the formula reading it", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const sheet = sheets[0] ?? 0

		await run(session, { type: "axis.insert", sheet, axis: "rows", at: 2, count: 2 })
		await run(session, set(sheet, 2, 0, "9"))

		const back = await readBack(await saved(session))

		expect(back.rows(0)).toEqual([["a", "b", "c"], ["1", "2"], ["9"], [], ["1", "2"], ["1", "2"], ["x", "12"]])
		session.close()
	})

	it("deletes rows from a repeated row and the source's last", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const sheet = sheets[0] ?? 0

		await run(session, { type: "axis.delete", sheet, axis: "rows", at: 1, count: 2 })

		const back = await readBack(await saved(session))

		expect(back.rows(0)).toEqual([
			["a", "b", "c"],
			["1", "2"],
			["x", "1"]
		])
		session.close()
	})

	it("inserts and deletes columns, splitting repeated cells", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const sheet = sheets[0] ?? 0

		await run(session, { type: "axis.insert", sheet, axis: "cols", at: 1, count: 1 })

		let back = await readBack(await saved(session))

		expect(back.rows(0)).toEqual([
			["a", "", "b", "c"],
			["1", "", "2"],
			["1", "", "2"],
			["1", "", "2"],
			["x", "", "3"]
		])

		await run(session, { type: "axis.delete", sheet, axis: "cols", at: 0, count: 2 })
		back = await readBack(await saved(session))

		expect(back.rows(0)).toEqual([["b", "c"], ["2"], ["2"], ["2"], ["#REF!"]])
		session.close()
	})

	it("moves the ranges names name with the rows inserted, keeping the names no edit touched as they were", async () => {
		const names =
			'<table:named-expressions><table:named-range table:name="Block" table:base-cell-address="$S.$A$1" table:cell-range-address="$S.$A$2:.$B$4"/><table:named-range table:name="Far" table:base-cell-address="$S.$A$1" table:cell-range-address="$S.$A$1"/></table:named-expressions>'
		const local =
			'<table:named-expressions><table:named-expression table:name="Twice" table:base-cell-address="$S.$A$1" table:expression="of:=2*[.$A$5]"/></table:named-expressions>'
		const { session, sheets } = await open({ body: table("S", local, GRID) + names })
		const sheet = sheets[0] ?? 0

		await run(session, { type: "axis.insert", sheet, axis: "rows", at: 1, count: 2 })

		const bytes = await saved(session)
		const back = await readBack(bytes)
		const xml = content(bytes)

		expect(back.document.workbook.definedNames.map(name => [name.name, name.sheet === null, name.formula])).toEqual([
			["Block", true, "'S'!$A$4:$B$6"],
			["Far", true, "'S'!$A$1"],
			["Twice", false, "2*$A$7"]
		])
		expect(xml).toContain('<table:named-range table:name="Far" table:base-cell-address="$S.$A$1" table:cell-range-address="$S.$A$1"/>')
		session.close()
	})

	it("adds, renames, moves, duplicates and deletes sheets", async () => {
		const { session, sheets } = await open({
			body: table("One", "", GRID) + table("Two", "", `<table:table-row>${cell("t")}</table:table-row>`)
		})
		const [one = 0, two = 1] = sheets

		await run(session, { type: "sheet.add", name: "New" })
		await run(session, { type: "sheet.rename", sheet: two, name: "Second" })
		await run(session, { type: "sheet.move", sheet: two, to: 0 })

		let back = await readBack(await saved(session))

		expect(back.names).toEqual(["Second", "One", "New"])
		expect(back.rows(0)).toEqual([["t"]])
		expect(back.rows(1)).toEqual([
			["a", "b", "c"],
			["1", "2"],
			["1", "2"],
			["1", "2"],
			["x", "3"]
		])

		await run(session, { type: "sheet.duplicate", sheet: one })
		await run(session, { type: "sheet.delete", sheet: two })
		back = await readBack(await saved(session))

		expect(back.names).toEqual(["One", "One (2)", "New"])
		expect(back.rows(1)).toEqual(back.rows(0))
		session.close()
	})

	it("writes formats, number formats and sizes as automatic styles", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const sheet = sheets[0] ?? 0

		await run(session, {
			type: "format.apply",
			sheet,
			ranges: [{ startRow: 1, startCol: 0, endRow: 1, endCol: 1 }],
			patch: { bold: true, numFmt: "0.00", fill: 0xffff00 }
		})
		await run(session, { type: "axis.resize", sheet, axis: "cols", indices: Uint32Array.of(2), sizes: Float32Array.of(150) })
		await run(session, { type: "axis.resize", sheet, axis: "rows", indices: Uint32Array.of(0), sizes: Float32Array.of(40) })

		const written = await saved(session)
		const back = await readBack(written)

		expect(back.rows(0)[1]).toEqual(["1.00", "2.00"])
		expect(content(written)).toMatch(
			/<number:number-style style:name="NF1"><number:number number:decimal-places="2" number:min-integer-digits="1"\/><\/number:number-style>/
		)
		session.close()
	})

	// A two-row merge read from the file, anchored on the first row in column `col`, with a third row below.
	const merged = (col: number): string => {
		const lead = col > 0 ? `<table:table-cell table:number-columns-repeated="${col}"/>` : ""

		return (
			'<table:table-column table:number-columns-repeated="3"/>' +
			`<table:table-row>${lead}<table:table-cell table:style-name="ceB" office:value-type="string" table:number-rows-spanned="2"><text:p>m</text:p></table:table-cell>${cell("z")}</table:table-row>` +
			`<table:table-row>${lead}<table:covered-table-cell/>${cell("y")}</table:table-row>` +
			`<table:table-row>${lead}${cell("w")}</table:table-row>`
		)
	}
	const mergesOf = (back: Awaited<ReturnType<typeof readBack>>): number[] => [...(back.document.workbook.sheets[0]?.model?.merges ?? [])]
	const bold = '<style:style style:name="ceB" style:family="table-cell"><style:text-properties fo:font-weight="bold"/></style:style>'
	const boldAnchor = (back: Awaited<ReturnType<typeof readBack>>, col: number): boolean | undefined => {
		const model = back.document.workbook.sheets[0]?.model

		if (model === null || model === undefined) return undefined

		const store = model.store as SheetStore
		const styles = back.document.workbook.styles

		return styles.fonts[styles.cellXfs[store.style(store.locate(0, col))]?.fontId ?? 0]?.bold
	}

	for (const col of [0, 1]) {
		it(`grows a merge read from the file when rows go in inside it (column ${col})`, async () => {
			const { session, sheets } = await open({ automatic: bold, body: table("S", merged(col)) })

			await run(session, { type: "axis.insert", sheet: sheets[0] ?? 0, axis: "rows", at: 1, count: 1 })

			const bytes = await saved(session)
			const back = await readBack(bytes)

			expect(mergesOf(back)).toEqual([0, col, 2, col])
			expect(content(bytes)).toContain('table:number-rows-spanned="3"')
			expect(boldAnchor(back, col)).toBe(true)
			session.close()
		})

		it(`drops a merge read from the file when rows deleted leave it one cell (column ${col})`, async () => {
			const { session, sheets } = await open({ automatic: bold, body: table("S", merged(col)) })

			await run(session, { type: "axis.delete", sheet: sheets[0] ?? 0, axis: "rows", at: 1, count: 1 })

			const bytes = await saved(session)
			const back = await readBack(bytes)
			const lead = col > 0 ? Array<string>(col).fill("") : []

			expect(mergesOf(back)).toEqual([])
			expect(back.rows(0)).toEqual([
				[...lead, "m", "z"],
				[...lead, "w"]
			])
			expect(boldAnchor(back, col)).toBe(true)
			session.close()
		})

		it(`keeps the rows below whole when a merge read from the file loses its anchor row (column ${col})`, async () => {
			const { session, sheets } = await open({ automatic: bold, body: table("S", merged(col)) })

			await run(session, { type: "axis.delete", sheet: sheets[0] ?? 0, axis: "rows", at: 0, count: 1 })

			const back = await readBack(await saved(session))

			expect(mergesOf(back)).toEqual([])
			expect(back.rows(0)).toEqual([
				[...Array<string>(col + 1).fill(""), "y"],
				[...Array<string>(col).fill(""), "w"]
			])
			session.close()
		})
	}

	it("hides and shows rows and columns", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const sheet = sheets[0] ?? 0

		await run(session, { type: "axis.hide", sheet, axis: "rows", spans: [{ start: 2, end: 2 }], hidden: true })
		await run(session, { type: "axis.hide", sheet, axis: "cols", spans: [{ start: 1, end: 1 }], hidden: true })

		const written = await saved(session)

		expect(content(written)).toContain('table:visibility="collapse"')
		session.close()
	})
})

describe("ODS notes and links", () => {
	it("writes a note set, edited and deleted as office:annotation", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const sheet = sheets[0] ?? 0

		await run(session, { type: "note.set", sheet, row: 1, col: 1, text: "first line\nsecond" })
		await run(session, { type: "note.set", sheet, row: 4, col: 3, text: "on an empty cell" })

		const written = await saved(session)

		expect(content(written)).toContain(
			"<office:annotation><dc:creator>Test</dc:creator><text:p>first line</text:p><text:p>second</text:p></office:annotation>"
		)

		await run(session, { type: "note.delete", sheet, ranges: [{ startRow: 1, startCol: 1, endRow: 1, endCol: 1 }] })

		expect(content(await saved(session))).not.toContain("first line")
		session.close()
	})

	it("writes a link on a cell's text and keeps it when the text changes", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const sheet = sheets[0] ?? 0

		await run(session, {
			type: "link.set",
			sheet,
			ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
			target: { url: "https://example.com/a" }
		})
		await run(session, set(sheet, 0, 0, "renamed"))

		const written = await saved(session)

		expect(content(written)).toContain('<text:a xlink:href="https://example.com/a" xlink:type="simple">renamed</text:a>')
		session.close()
	})
})

describe("ODS views, protection and print areas", () => {
	const SETTINGS =
		'<config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry><config:config-item config:name="ViewId" config:type="string">view1</config:config-item><config:config-item-map-named config:name="Tables"><config:config-item-map-entry config:name="S"><config:config-item config:name="CursorPositionX" config:type="int">0</config:config-item><config:config-item config:name="CursorPositionY" config:type="int">0</config:config-item></config:config-item-map-entry></config:config-item-map-named><config:config-item config:name="ActiveTable" config:type="string">S</config:config-item></config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set>'

	it("writes frozen panes and the active sheet into settings.xml, keeping its other bytes", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) + table("T", "", GRID), settings: SETTINGS })
		const [one = 0] = sheets

		await run(session, { type: "view.freeze", sheet: one, rows: 1, cols: 1 })

		const written = await saved(session)
		const settings = strFromU8(unzipSync(written)["settings.xml"] ?? new Uint8Array(0))

		expect(settings).toContain('<config:config-item config:name="HorizontalSplitMode" config:type="short">2</config:config-item>')
		expect(settings).toContain('<config:config-item config:name="ViewId" config:type="string">view1</config:config-item>')

		const back = await readBack(written)

		expect(back.document.model(0)?.view.frozen).toEqual({ rows: 1, cols: 1, topLeftRow: 1, topLeftCol: 1 })
		session.close()
	})

	it("writes a settings.xml for a package without one once a view is kept", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })

		await run(session, { type: "view.freeze", sheet: sheets[0] ?? 0, rows: 2, cols: 0 })

		const written = await saved(session)
		const files = unzipSync(written)

		expect(Object.keys(files)).toContain("settings.xml")
		// config:name="ooo:view-settings" is a QName LibreOffice resolves: without the prefix it ignores the views.
		expect(strFromU8(files["settings.xml"] ?? new Uint8Array(0))).toContain('xmlns:ooo="http://openoffice.org/2004/office"')
		expect(strFromU8(files["META-INF/manifest.xml"] ?? new Uint8Array(0))).toContain('manifest:full-path="settings.xml"')
		expect((await readBack(written)).document.model(0)?.view.frozen?.rows).toBe(2)
		session.close()
	})

	it("protects a sheet and the workbook without a password, and refuses Excel's salted hash", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const sheet = sheets[0] ?? 0

		await run(session, { type: "sheet.protect", sheet, allows: ["selectLockedCells", "selectUnlockedCells"] })
		await run(session, { type: "workbook.protect", structure: true, windows: false })

		const written = await saved(session)

		expect(content(written)).toContain('table:protected="true"')
		expect(content(written)).toContain('table:structure-protected="true"')

		await run(session, { type: "sheet.unprotect", sheet })

		const salted = await session.command({
			type: "sheet.protect",
			sheet,
			allows: [],
			hash: { algorithmName: "SHA-512", hashValue: "AAAA", saltValue: "BBBB", spinCount: 100000 }
		})

		expect(salted.ok ? null : salted.refusal).toEqual({ reason: "unsupported", detail: "passwordHash" })
		session.close()
	})
})

describe("ODS validations", () => {
	const RULE = {
		type: "whole",
		operator: "between",
		value1: "1",
		value2: "10",
		allowBlank: true,
		inCellDropdown: true,
		showInputMessage: true,
		promptTitle: "Count",
		prompt: "One to ten",
		showErrorMessage: true,
		errorStyle: "warning",
		errorTitle: "",
		error: "Out of range"
	} as const

	it("writes a new validation as a table:content-validation its cells name", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const sheet = sheets[0] ?? 0

		await run(session, { type: "validation.set", sheet, ranges: [{ startRow: 1, startCol: 1, endRow: 3, endCol: 1 }], rule: RULE })

		const written = await saved(session)
		const text = content(written)

		expect(text).toContain('table:condition="of:cell-content-is-whole-number() and cell-content-is-between(1;10)"')
		expect(text.match(/table:content-validation-name="valF1"/g)?.length).toBe(3)
		session.close()
	})

	it("refuses a rule a table:content-validation cannot hold", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const result = await session.command({
			type: "validation.set",
			sheet: sheets[0] ?? 0,
			ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
			rule: { ...RULE, type: "list", operator: "between", value1: "=Sheet9:Sheet10!A1:A3", value2: "" }
		})

		expect(result.ok).toBe(false)
		session.close()
	})
})

describe("ODS autoFilters", () => {
	it("writes an autoFilter and its criteria as a database range, its hidden rows as filtered", async () => {
		const { session, sheets } = await open({ body: table("S", "", GRID) })
		const sheet = sheets[0] ?? 0

		await run(session, {
			type: "filter.toggle",
			sheet,
			range: { startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
			active: { row: 0, col: 0 }
		})
		await run(session, {
			type: "filter.column",
			sheet,
			row: 0,
			col: 0,
			criteria: { kind: "values", values: ["x"], blank: false, dates: [] }
		})

		const written = await saved(session)
		const text = content(written)

		expect(text).toContain(
			'<table:database-range table:name="__Anonymous_Sheet_DB__0" table:target-range-address="S.A1:S.B5" table:display-filter-buttons="true">'
		)
		expect(text).toContain('table:visibility="filter"')

		await run(session, {
			type: "filter.toggle",
			sheet,
			range: { startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
			active: { row: 0, col: 0 }
		})

		expect(content(await saved(session))).not.toContain("table:database-range ")
		session.close()
	})
})

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { HyperFormula } from "hyperformula"
import { describe, expect, it, vi } from "vitest"
import type { SheetChange, SheetCommandResult, SheetSessionApi, SheetTile } from "../core/sheet/protocol"
import type { SheetSession } from "../core/sheet/session"
import type { XlsxDocument } from "../core/xlsx/edit/document"
import { takesOneValue } from "../core/sheet/functions/valueArguments"
import { legacyIntersections, shownFormula } from "../core/sheet/refs/formulaRefs"
import { dynamicCellMetadata } from "../core/xlsx/edit/spill"
import { SheetStore } from "../core/xlsx/model/store"
import { inThreadSheetHost } from "../dom/sheet/host"
import { compareRecords, modelRecord, readSaved } from "./fuzz/sheet/compare"
import { buildXlsx } from "./oracles/sheet/synthetic"
import { strictOf } from "./sheetDrawingsFixtures"
import { openFixture } from "./sheetSessionFixtures"
import { TYPES, relationship } from "./xlsxRefsFixtures"

// Dynamic arrays in a workbook (support.microsoft.com "Dynamic array formulas and spilled array behavior"; [MS-XLSX]
// 2.6.97): the array formula whose cm names an XLDAPR record calculates and spills, its ref follows what it spills
// over, the values there are written to their cells, and #SPILL! is stored when a cell is in the way. A formula typed
// that gives an array is stored as one, with the metadata part made for it.

const IMMEDIATE = { sliceMs: 1_000_000, now: () => 0, pause: () => Promise.resolve() }
const EXCEL = { name: "Microsoft Excel", version: "16.0300" }

// The metadata part Excel writes for dynamic arrays (one XLDAPR record, cm 1).
const METADATA =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
	'xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"><metadataTypes count="1"><metadataType name="XLDAPR" ' +
	'minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" ' +
	'clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes><futureMetadata name="XLDAPR" count="1"><bk><extLst>' +
	'<ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk>' +
	'</futureMetadata><cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>'

// A workbook with a sheet body, the metadata part when `metadata` is given, and defined names.
function workbook(body: string, metadata?: string, names = ""): Uint8Array {
	const files = unzipSync(buildXlsx({ sheets: [{ name: "S", body }], application: EXCEL, calcPr: 'calcId="191029"' }))

	if (names !== "")
		files["xl/workbook.xml"] = strToU8(
			strFromU8(files["xl/workbook.xml"] as Uint8Array).replace("</sheets>", `</sheets><definedNames>${names}</definedNames>`)
		)

	if (metadata !== undefined) {
		files["xl/metadata.xml"] = strToU8(metadata)
		files["xl/_rels/workbook.xml.rels"] = strToU8(
			strFromU8(files["xl/_rels/workbook.xml.rels"] as Uint8Array).replace(
				"</Relationships>",
				'<Relationship Id="rIdMeta" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata" Target="metadata.xml"/></Relationships>'
			)
		)
		files["[Content_Types].xml"] = strToU8(
			strFromU8(files["[Content_Types].xml"] as Uint8Array).replace(
				"</Types>",
				'<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/></Types>'
			)
		)
	}

	return zipSync(files)
}

async function open(bytes: Uint8Array): Promise<{ session: SheetSessionApi; sheet: number }> {
	const result = await inThreadSheetHost().open(bytes.slice(), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

	const sheet = result.info.sheets[0]?.id ?? 0

	await result.session.tiles(sheet, Uint32Array.of(0, 0))
	expect(await result.session.intent()).toEqual({ state: "writable" })

	return { session: result.session, sheet }
}

function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason} ${result.refusal.detail ?? ""}`)

	return result.change
}

async function set(session: SheetSessionApi, sheet: number, cell: string, input: string): Promise<SheetChange> {
	const row = Number(cell.slice(1)) - 1
	const col = cell.charCodeAt(0) - 65

	return changeOf(
		await session.command({
			type: "cells.set",
			sheet,
			cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [input] }
		})
	)
}

async function texts(session: SheetSessionApi, sheet: number, cells: readonly string[]): Promise<string[]> {
	const { tiles } = await session.tiles(sheet, Uint32Array.of(0, 0))
	const tile = tiles[0] as SheetTile

	return cells.map(cell => {
		const position = ((Number(cell.slice(1)) - 1) << 5) | (cell.charCodeAt(0) - 65)

		for (let i = 0; i < tile.count; i++) {
			if (tile.positions[i] !== position) continue

			const text = tile.texts[i] ?? -1

			return text < 0 ? "" : (tile.strings[text] ?? "")
		}

		return ""
	})
}

async function inputs(session: SheetSessionApi, sheet: number, cells: readonly string[]): Promise<string[]> {
	const { tiles } = await session.tiles(sheet, Uint32Array.of(0, 0))
	const tile = tiles[0] as SheetTile

	return cells.map(cell => {
		const position = ((Number(cell.slice(1)) - 1) << 5) | (cell.charCodeAt(0) - 65)

		for (let i = 0; i < tile.count; i++) if (tile.positions[i] === position) return tile.strings[tile.inputs[i] ?? -1] ?? ""

		return ""
	})
}

async function saved(session: SheetSessionApi): Promise<{ sheet: string; files: Record<string, Uint8Array> }> {
	const result = await session.save()

	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	const document = (session as SheetSession<XlsxDocument>).document

	expect(compareRecords(modelRecord(document.workbook), await readSaved(result.bytes))).toEqual([])

	const files = unzipSync(result.bytes)

	return { sheet: strFromU8(files["xl/worksheets/sheet1.xml"] as Uint8Array), files }
}

describe("dynamic-array cell metadata", () => {
	it("reads the cm values an XLDAPR record marks dynamic", () => {
		expect([...dynamicCellMetadata(METADATA).dynamic]).toEqual([1])
		expect(dynamicCellMetadata(METADATA).cm).toBe(1)
		expect([...dynamicCellMetadata(METADATA.replace('fDynamic="1"', 'fDynamic="0"')).dynamic]).toEqual([])
		expect([...dynamicCellMetadata(METADATA.replace('name="XLDAPR" min', 'name="XLRICHVALUE" min')).dynamic]).toEqual([])
	})
})

describe("dynamic arrays in a workbook", () => {
	// B1 spills A1:A3*10 over B1:B3, as Excel saved it.
	const SPILLING =
		'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1" cm="1"><f t="array" ref="B1:B3">A1:A3*10</f><v>10</v></c></row>' +
		'<row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>20</v></c></row><row r="3"><c r="A3"><v>3</v></c><c r="B3"><v>30</v></c></row></sheetData>'

	it("spill again when an input changes, and save the values in their cells", async () => {
		const { session, sheet } = await open(workbook(SPILLING, METADATA))

		await set(session, sheet, "A2", "5")
		expect(await texts(session, sheet, ["B1", "B2", "B3"])).toEqual(["10", "50", "30"])

		const { sheet: xml } = await saved(session)

		expect(xml).toContain('<c r="B1" cm="1"><f t="array" ref="B1:B3">A1:A3*10</f><v>10</v></c>')
		expect(xml).toMatch(/<c r="B2"[^>]*><v>50<\/v><\/c>/)
		session.close()
	})

	it("rewrite their ref when the array grows or shrinks, clearing what they no longer reach", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1"><v>3</v></c><c r="B1" cm="1"><f t="array" ref="B1:B3">_xlfn.SEQUENCE(A1)</f><v>1</v></c></row>' +
			'<row r="2"><c r="B2"><v>2</v></c></row><row r="3"><c r="B3"><v>3</v></c></row></sheetData>'
		const { session, sheet } = await open(workbook(body, METADATA))

		await set(session, sheet, "A1", "2")
		expect(await texts(session, sheet, ["B1", "B2", "B3"])).toEqual(["1", "2", ""])
		expect((await saved(session)).sheet).toContain('<f t="array" ref="B1:B2">_xlfn.SEQUENCE(A1)</f>')

		await set(session, sheet, "A1", "4")
		expect(await texts(session, sheet, ["B3", "B4"])).toEqual(["3", "4"])
		expect((await saved(session)).sheet).toContain('<f t="array" ref="B1:B4">')

		// Undone, the cells and the ref are as they were.
		changeOf(await session.undo())
		expect(await texts(session, sheet, ["B3", "B4"])).toEqual(["", ""])
		expect((await saved(session)).sheet).toContain('<f t="array" ref="B1:B2">')
		session.close()
	})

	it("store #SPILL! while a value is in the way, and spill once it is cleared", async () => {
		const { session, sheet } = await open(workbook(SPILLING, METADATA))

		await set(session, sheet, "B3", "x")
		expect(await texts(session, sheet, ["B1", "B2", "B3"])).toEqual(["#SPILL!", "", "x"])

		const { sheet: xml } = await saved(session)

		expect(xml).toMatch(/<c r="B1" t="e" cm="1"><f t="array" ref="B1">A1:A3\*10<\/f><v>#SPILL!<\/v><\/c>/)

		await set(session, sheet, "B3", "")
		expect(await texts(session, sheet, ["B1", "B2", "B3"])).toEqual(["10", "20", "30"])
		session.close()
	})

	it("store a typed formula that gives an array as a dynamic array, with the metadata part made for it", async () => {
		const { session, sheet } = await open(workbook('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'))

		await set(session, sheet, "C1", "=SEQUENCE(3)")
		expect(await texts(session, sheet, ["C1", "C2", "C3"])).toEqual(["1", "2", "3"])

		const { sheet: xml, files } = await saved(session)

		expect(xml).toContain('<c r="C1" cm="1"><f t="array" ref="C1:C3">_xlfn.SEQUENCE(3)</f><v>1</v></c>')
		expect([...dynamicCellMetadata(strFromU8(files["xl/metadata.xml"] as Uint8Array)).dynamic]).toEqual([1])
		expect(strFromU8(files["xl/_rels/workbook.xml.rels"] as Uint8Array)).toContain("relationships/sheetMetadata")
		expect(strFromU8(files["[Content_Types].xml"] as Uint8Array)).toContain("sheetMetadata+xml")

		// Undone, the metadata part goes with it, and the save is the source; redone, it is back.
		const before = workbook('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>')
		const fresh = await open(before)
		const source = await fresh.session.save()

		await set(fresh.session, fresh.sheet, "C1", "=SEQUENCE(3)")
		changeOf(await fresh.session.undo())

		const undone = await fresh.session.save()

		if (!source.ok || !undone.ok) throw new Error("save refused")
		expect(undone.bytes).toEqual(source.bytes)
		expect(strFromU8(unzipSync(undone.bytes)["xl/_rels/workbook.xml.rels"] as Uint8Array)).not.toContain("sheetMetadata")
		changeOf(await fresh.session.redo())
		expect((await saved(fresh.session)).files["xl/metadata.xml"]).toBeDefined()
		fresh.session.close()

		// A formula that gives one value is an ordinary one.
		await set(session, sheet, "D1", "=SUM(A1:A3)")
		expect((await saved(session)).sheet).toContain('<c r="D1"><f>SUM(A1:A3)</f><v>1</v></c>')
		session.close()
	})

	it("in a Strict workbook, are read through its own metadata part, which a typed one reuses", async () => {
		const { session, sheet } = await open(strictOf(workbook(SPILLING, METADATA)))

		await set(session, sheet, "A2", "5")
		expect(await texts(session, sheet, ["B1", "B2", "B3"])).toEqual(["10", "50", "30"])
		await set(session, sheet, "C1", "=SEQUENCE(3)")
		expect(await texts(session, sheet, ["C1", "C2", "C3"])).toEqual(["1", "2", "3"])

		const { sheet: xml, files } = await saved(session)
		const types = [...strFromU8(files["xl/_rels/workbook.xml.rels"] as Uint8Array).matchAll(/Type="([^"]*\/sheetMetadata)"/g)].map(
			match => match[1]
		)

		expect(xml).toContain('<c r="C1" cm="1"><f t="array" ref="C1:C3">_xlfn.SEQUENCE(3)</f><v>1</v></c>')
		expect(Object.keys(files).filter(name => name.startsWith("xl/metadata"))).toEqual(["xl/metadata.xml"])
		expect(types).toEqual(["http://purl.oclc.org/ooxml/officeDocument/relationships/sheetMetadata"])
		session.close()
	})

	it("make the metadata part next to a workbook part outside xl/, in the Strict namespace for a Strict workbook", async () => {
		const files = unzipSync(strictOf(workbook('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>')))
		const moved: Record<string, Uint8Array> = {}

		for (const [name, data] of Object.entries(files)) {
			const text =
				name.endsWith(".xml") || name.endsWith(".rels")
					? strFromU8(data).replaceAll("/xl/", "/book/").replaceAll('"xl/', '"book/')
					: null

			moved[name.replace(/^xl\//, "book/")] = text === null ? data : strToU8(text)
		}

		const { session, sheet } = await open(zipSync(moved))

		await set(session, sheet, "C1", "=SEQUENCE(3)")

		const result = await session.save()

		if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

		const out = unzipSync(result.bytes)

		expect(strFromU8(out["book/_rels/workbook.xml.rels"] as Uint8Array)).toMatch(
			/Type="http:\/\/purl\.oclc\.org\/ooxml\/officeDocument\/relationships\/sheetMetadata" Target="metadata\.xml"/
		)
		expect(strFromU8(out["book/metadata.xml"] as Uint8Array)).toContain(
			'<metadata xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"'
		)
		expect(Object.keys(out).some(name => name.startsWith("xl/"))).toBe(false)
		session.close()
	})

	it("store a typed formula lifting a function over a range as a dynamic array, and @ as the file's intersection", async () => {
		// "Dynamic array formulas and spilled array behavior": =LEN(A1:A3) spills one length per cell; "@" asks for
		// implicit intersection ("Implicit intersection operator: @").
		const body =
			'<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>22</v></c></row><row r="3"><c r="A3"><v>333</v></c></row></sheetData>'
		const { session, sheet } = await open(workbook(body))

		await set(session, sheet, "C1", "=LEN(A1:A3)")
		await set(session, sheet, "D1", "=SUM(LEN(A1:A3))")
		await set(session, sheet, "E1", "=SUM(A1:A3)")
		await set(session, sheet, "F2", "=@A1:A3")
		expect(await texts(session, sheet, ["C1", "C2", "C3", "D1", "E1", "F2"])).toEqual(["1", "2", "3", "6", "356", "22"])

		const { sheet: xml } = await saved(session)

		expect(xml).toContain('<f t="array" ref="C1:C3">LEN(A1:A3)</f>')
		expect(xml).toContain('<f t="array" ref="D1">SUM(LEN(A1:A3))</f>')
		expect(xml).toContain("<f>SUM(A1:A3)</f>")
		expect(xml).toContain("<f>_xlfn.SINGLE(A1:A3)</f>")
		session.close()
	})

	it("store #SPILL! where it would spill over a merged cell or a table", async () => {
		// "How to correct a #SPILL! error": "Spill range has merged cells", "Spill range in table".
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "S",
					body:
						'<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="D2:E2"/></mergeCells>' +
						'<tableParts count="1"><tablePart r:id="rId1"/></tableParts>',
					rels: relationship("rId1", "table", "../tables/table1.xml")
				}
			],
			parts: {
				"xl/tables/table1.xml": {
					text:
						'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="H3:I5">' +
						'<autoFilter ref="H3:I5"/><tableColumns count="2"><tableColumn id="1" name="K"/><tableColumn id="2" name="V"/></tableColumns></table>',
					type: TYPES.table
				}
			}
		})
		const sheet = info.sheets[0]?.id ?? 0

		await session.intent()
		await set(session, sheet, "D1", "=SEQUENCE(3)")
		await set(session, sheet, "H1", "=SEQUENCE(3)")
		await set(session, sheet, "F1", "=SEQUENCE(3)")
		await set(session, sheet, "H4", "=SUM(A1:A3)")
		expect(await texts(session, sheet, ["D1", "D2", "H1", "H2", "F1", "F3", "H4"])).toEqual([
			"#SPILL!",
			"",
			"#SPILL!",
			"",
			"1",
			"3",
			"1"
		])

		const { sheet: xml } = await saved(session)

		expect(xml).toContain('<c r="D1" t="e" cm="1"><f t="array" ref="D1">_xlfn.SEQUENCE(3)</f><v>#SPILL!</v></c>')
		expect(xml).not.toMatch(/<c r="D2"[^>]*><v>/)
		session.close()
	})

	it("clear what a dynamic array spilled when its formula is cleared", async () => {
		const { session, sheet } = await open(workbook(SPILLING, METADATA))

		await set(session, sheet, "B1", "")
		expect(await texts(session, sheet, ["B1", "B2", "B3"])).toEqual(["", "", ""])
		session.close()
	})

	it("take rows inserted and deleted through what they spill over, and spill again; a legacy array refuses", async () => {
		const { session, sheet } = await open(workbook(SPILLING, METADATA))

		changeOf(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 1, count: 1 }))
		expect(await texts(session, sheet, ["B1", "B2", "B3", "B4"])).toEqual(["10", "0", "20", "30"])
		expect((await saved(session)).sheet).toContain('<f t="array" ref="B1:B4">A1:A4*10</f>')

		changeOf(await session.command({ type: "axis.delete", sheet, axis: "rows", at: 1, count: 2 }))
		expect(await texts(session, sheet, ["B1", "B2", "B3"])).toEqual(["10", "30", ""])
		expect((await saved(session)).sheet).toContain('<f t="array" ref="B1:B2">A1:A2*10</f>')
		session.close()

		const legacy = SPILLING.replace(' cm="1"', "")
		const opened = await open(workbook(legacy, METADATA))
		const refused = await opened.session.command({ type: "axis.insert", sheet: opened.sheet, axis: "rows", at: 1, count: 1 })

		expect(refused.ok ? "" : refused.refusal.reason).toBe("arrayFormula")
		opened.session.close()
	})

	it("take what they spilled with them when the row or column of their formula is deleted", async () => {
		// "Dynamic array formulas and spilled array behavior": the spilled values belong to the formula's cell.
		const source = workbook(SPILLING, METADATA)
		const { session, sheet } = await open(source)
		const original = (await saved(session)).sheet

		changeOf(await session.command({ type: "axis.delete", sheet, axis: "rows", at: 0, count: 1 }))
		expect(await texts(session, sheet, ["A1", "A2", "B1", "B2"])).toEqual(["2", "3", "", ""])
		expect((await saved(session)).sheet).not.toMatch(/<c r="B[12]"/)

		changeOf(await session.undo())
		expect(await texts(session, sheet, ["B1", "B2", "B3"])).toEqual(["10", "20", "30"])
		expect((await saved(session)).sheet).toBe(original)

		const across =
			'<sheetData><row r="1"><c r="A1" cm="1"><f t="array" ref="A1:C1">_xlfn.SEQUENCE(1,3)</f><v>1</v></c><c r="B1"><v>2</v></c>' +
			'<c r="C1"><v>3</v></c><c r="D1"><v>9</v></c></row></sheetData>'
		const columns = await open(workbook(across, METADATA))

		changeOf(await columns.session.command({ type: "axis.delete", sheet: columns.sheet, axis: "cols", at: 0, count: 1 }))
		expect(await texts(columns.session, columns.sheet, ["A1", "B1", "C1"])).toEqual(["", "", "9"])
		columns.session.close()
		session.close()
	})

	it("read a spill range reference (A1#) as what the array spills over", async () => {
		const body = SPILLING.replace(
			'<c r="A3"><v>3</v></c>',
			'<c r="A3"><v>3</v></c><c r="C3"><f>SUM(_xlfn.ANCHORARRAY(B1))</f><v>60</v></c>'
		)
		const { session, sheet } = await open(workbook(body, METADATA))

		await set(session, sheet, "A1", "4")
		expect(await texts(session, sheet, ["B1", "C3"])).toEqual(["40", "90"])
		session.close()
	})

	it("call a LAMBDA a defined name holds, recursively too, and a function named in a LAMBDA's place", async () => {
		// "LAMBDA function": a LAMBDA named in the Name Manager is called by its name; one may call itself.
		const names =
			'<definedName name="Twice">_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2)</definedName>' +
			'<definedName name="Fact">_xlfn.LAMBDA(_xlpm.n,IF(_xlpm.n&lt;=1,1,_xlpm.n*Fact(_xlpm.n-1)))</definedName>'
		const body =
			'<sheetData><row r="1"><c r="A1"><v>3</v></c><c r="B1"><v>4</v></c><c r="C1"><f>Twice(A1)</f><v>6</v></c><c r="D1"><f>Fact(A1)</f><v>6</v></c></row></sheetData>'
		const { session, sheet } = await open(workbook(body, METADATA, names))

		await set(session, sheet, "A1", "5")
		await set(session, sheet, "E1", "=Twice(B1)+1")
		await set(session, sheet, "F1", "=BYROW(A1:B1,SUM)")
		expect(await texts(session, sheet, ["C1", "D1", "E1", "F1"])).toEqual(["10", "120", "9", "9"])

		const { sheet: xml } = await saved(session)

		expect(xml).toContain("<f>Twice(B1)+1</f>")
		expect(xml).toContain("_xlfn.BYROW(A1:B1,_xleta.SUM)")
		session.close()
	})
})

describe("a large spill", () => {
	it("moves its rows and columns in one task and recalculates what the move changed in another", async () => {
		// Each is one engine call that cannot be cut; apart, no task holds both.
		const order: string[] = []
		const slicing = {
			sliceMs: 0,
			now: () => 0,
			pause: () => {
				order.push("turn")

				return Promise.resolve()
			}
		}
		const result = await inThreadSheetHost().open(
			workbook('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'),
			{ kind: "xlsx", slicing },
			() => undefined
		)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const session = result.session
		const sheet = result.info.sheets[0]?.id ?? 0

		await session.tiles(sheet, Uint32Array.of(0, 0))
		await session.intent()
		changeOf(
			await session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(2), inputs: ["=SEQUENCE(5000)"] }
			})
		)

		const addColumns = HyperFormula.prototype.addColumns
		const resume = HyperFormula.prototype.resumeEvaluation

		vi.spyOn(HyperFormula.prototype, "addColumns").mockImplementation(function (this: HyperFormula, ...args) {
			order.push("move")

			return addColumns.apply(this, args)
		})
		vi.spyOn(HyperFormula.prototype, "resumeEvaluation").mockImplementation(function (this: HyperFormula) {
			order.push("calculate")

			return resume.apply(this)
		})
		order.length = 0
		changeOf(await session.command({ type: "axis.insert", sheet, axis: "cols", at: 0, count: 1 }))

		const moved = order.indexOf("move")

		expect(moved).toBeGreaterThanOrEqual(0)
		expect(order.slice(moved, moved + 3)).toEqual(["move", "turn", "calculate"])
		expect(await texts(session, sheet, ["D1", "D5"])).toEqual(["1", "5"])
		session.close()
	})

	it("is written to the cells together and in parts, the host given a turn between them", async () => {
		const engineWrites = vi.spyOn(HyperFormula.prototype, "setCellContents")
		const cellWrites = vi.spyOn(SheetStore.prototype, "setCell")
		// The engine's writes between two turns of the host.
		const parts: number[] = []
		let since = 0
		const slicing = {
			sliceMs: 0,
			now: () => 0,
			pause: () => {
				parts.push(engineWrites.mock.calls.length - since)
				since = engineWrites.mock.calls.length

				return Promise.resolve()
			}
		}
		const result = await inThreadSheetHost().open(
			workbook('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'),
			{ kind: "xlsx", slicing },
			() => undefined
		)

		if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

		const session = result.session
		const sheet = result.info.sheets[0]?.id ?? 0

		await session.tiles(sheet, Uint32Array.of(0, 0))
		await session.intent()

		for (const input of ["=SEQUENCE(30000)", "=SEQUENCE(5000,5)"]) {
			parts.length = 0
			since = engineWrites.mock.calls.length
			cellWrites.mockClear()
			changeOf(
				await session.command({
					type: "cells.set",
					sheet,
					cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(2), inputs: [input] }
				})
			)
			// The engine is given the spilled values a few thousand at a time, and the store takes them in batches.
			expect(Math.max(...parts, engineWrites.mock.calls.length - since)).toBeLessThanOrEqual(8_192)
			expect(cellWrites.mock.calls.length).toBeLessThan(10)
		}

		expect(await texts(session, sheet, ["C1", "D1", "G1", "C2", "G2", "C6"])).toEqual(["1", "2", "5", "6", "10", "26"])
		session.close()
	})
})

describe("a formula written before dynamic arrays", () => {
	// support.microsoft.com "Implicit intersection operator: @": such a formula reads one value where a range stands
	// for one; Excel shows @ there (=@A1:A10, =@INDEX(...), LEN's text), and SUM, which reads a range, as it is.
	const LEGACY =
		'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="F1"><f>SUM(A1:A3)</f><v>356</v></c></row>' +
		'<row r="2"><c r="A2"><v>22</v></c><c r="B2"><f>LEN(A1:A3)</f><v>2</v></c><c r="C2"><f>A1:A3</f><v>22</v></c>' +
		'<c r="D2"><f>A1:A3*2</f><v>44</v></c><c r="E2"><f>INDEX(A1:A3,0)+SUM(A1:A3)</f><v>378</v></c><c r="G2"><f>Custom(A1:A3)</f><v>0</v></c></row>' +
		'<row r="3"><c r="A3"><v>333</v></c><c r="D3" t="inlineStr"><is><t>keep</t></is></c></row></sheetData>'

	it("is shown with @ where it reads one value from a range", async () => {
		const { session, sheet } = await open(workbook(LEGACY, METADATA))

		expect(await inputs(session, sheet, ["B2", "C2", "D2", "E2", "F1", "G2"])).toEqual([
			"=LEN(@A1:A3)",
			"=@A1:A3",
			"=@A1:A3*2",
			"=@INDEX(A1:A3,0)+SUM(A1:A3)",
			"=SUM(A1:A3)",
			"=@Custom(A1:A3)"
		])
		session.close()
	})

	it("shows @ on the arguments LibreOffice's parameter classes give one value", () => {
		// sc/source/core/tool/parclass.cxx: VLOOKUP {Value, ReferenceOrForceArray, Value, Value}, MATCH {Value, ...},
		// COUNTIF {ReferenceOrRefArray, Value}, INDEX {Reference, Value, Value, Value}, functions it does not list Value;
		// IF {Array, Reference, Reference} and SUM {Reference} take no @.
		const shown = (formula: string): string => shownFormula(legacyIntersections(formula, takesOneValue, () => true))

		expect(
			[
				"VLOOKUP(A1:A3,D1:E3,2,0)",
				"HLOOKUP(A1:A3,D1:F2,2,0)",
				"MATCH(A1:A3,D1:D3,0)",
				"LOOKUP(A1:A3,D1:D3)",
				"COUNTIF(D1:D3,A1:A3)",
				"SUMIF(D1:D3,A1:A3)",
				"ISNUMBER(A1:A3)",
				"VALUE(A1:A3)",
				'CONCATENATE(A1:A3,"x")',
				"SUM(INDEX(D1:E3,1,1,A1:A3))",
				"IF(A1:A3,1,2)",
				"SUM(A1:A3)",
				"N(A1:A3)",
				"T.TEST(A1:A5,B1:B5,2,1)",
				"F.TEST(A1:A5,B1:B5)",
				"CHISQ.TEST(A1:A5,B1:B5)",
				"CHITEST(A1:A5,B1:B5)",
				"FORECAST.LINEAR(A1:A3,A1:A5,B1:B5)",
				"TYPE(A1:A5)",
				'GETPIVOTDATA("x",A3:D20,"f",A1:A3)',
				"_xlfn.IFS(A1:A3>1,A1:A3)",
				"UNKNOWNFN(A1:A3)"
			].map(shown)
		).toEqual([
			"VLOOKUP(@A1:A3,D1:E3,2,0)",
			"HLOOKUP(@A1:A3,D1:F2,2,0)",
			"MATCH(@A1:A3,D1:D3,0)",
			"LOOKUP(@A1:A3,D1:D3)",
			"COUNTIF(D1:D3,@A1:A3)",
			"SUMIF(D1:D3,@A1:A3)",
			"ISNUMBER(@A1:A3)",
			"VALUE(@A1:A3)",
			'CONCATENATE(@A1:A3,"x")',
			"SUM(INDEX(D1:E3,1,1,@A1:A3))",
			"IF(A1:A3,1,2)",
			"SUM(A1:A3)",
			"N(A1:A3)",
			"T.TEST(A1:A5,B1:B5,2,1)",
			"F.TEST(A1:A5,B1:B5)",
			"CHISQ.TEST(A1:A5,B1:B5)",
			"CHITEST(A1:A5,B1:B5)",
			"FORECAST.LINEAR(@A1:A3,A1:A5,B1:B5)",
			"TYPE(A1:A5)",
			'GETPIVOTDATA("x",A3:D20,"f",@A1:A3)',
			"IFS(A1:A3>1,A1:A3)",
			"UNKNOWNFN(A1:A3)"
		])
	})

	it("counts no comma inside a structured reference, a string, a quoted sheet name or an array constant", () => {
		const shown = (formula: string): string => shownFormula(legacyIntersections(formula, takesOneValue, () => true))

		expect(
			[
				// Corpus formulas: closedxml column-style-autofilter B2, the 16 to 19 allocation toolkit, Anti-Slavery H3 and N2.
				"VLOOKUP(HateIndex[[#This Row],[Row Labels]],FavoriteGUI!A:B,2,FALSE)",
				'IF(ISNONTEXT(VLOOKUP(AimsData[[#This Row],[Student Reference]],Comments!$B$7:$C$1500,2,0)),"",1)',
				"INDEX('T Level lookup'!B:B,MATCH(ProgrammeData[[#This Row],[T Level Occupational Specialism Code]],'T Level lookup'!A:A,0))",
				"IFERROR(MATCH(Table2[[#This Row],[Country]],GSI!F:F,0)>0,FALSE)",
				"IF(ROW(Table6[[#This Row],[ID]])=2,1,IFERROR(N1*SIGN(MATCH(Table6[[#This Row],[Country]],F:F,0)),N1+1))",
				"INDEX(T[[#Headers],[a],[b]],1,A1:A3)",
				'VLOOKUP(",,",D1:E3,2,0)&VLOOKUP(A1:A3,D1:E3,2,0)',
				"VLOOKUP({1,2,3},'a,b'!D1:E3,2,0)+VLOOKUP(A1:A3,'a,b'!D1:E3,2,0)"
			].map(shown)
		).toEqual([
			"VLOOKUP(HateIndex[[#This Row],[Row Labels]],FavoriteGUI!A:B,2,FALSE)",
			'IF(ISNONTEXT(VLOOKUP(AimsData[[#This Row],[Student Reference]],Comments!$B$7:$C$1500,2,0)),"",1)',
			"@INDEX('T Level lookup'!B:B,MATCH(ProgrammeData[[#This Row],[T Level Occupational Specialism Code]],'T Level lookup'!A:A,0))",
			"IFERROR(MATCH(Table2[[#This Row],[Country]],GSI!F:F,0)>0,FALSE)",
			"IF(ROW(Table6[[#This Row],[ID]])=2,1,IFERROR(N1*SIGN(MATCH(Table6[[#This Row],[Country]],F:F,0)),N1+1))",
			"@INDEX(T[[#Headers],[a],[b]],1,@A1:A3)",
			'VLOOKUP(",,",D1:E3,2,0)&VLOOKUP(@A1:A3,D1:E3,2,0)',
			"VLOOKUP({1,2,3},'a,b'!D1:E3,2,0)+VLOOKUP(@A1:A3,'a,b'!D1:E3,2,0)"
		])
	})

	it("shows @ on a function that may give a range or an array, where it would give one", () => {
		// support.microsoft.com "Excel functions that return ranges or arrays": COLUMN, ROW, TRANSPOSE, MMULT and the
		// others take @ in a formula written before dynamic arrays; ROW(A1) gives one value, and an argument that reads
		// an array whole (SUM's) needs none.
		const shown = (formula: string): string => shownFormula(legacyIntersections(formula, takesOneValue, () => true))

		expect(
			[
				"COLUMN(1:2)",
				"ROW(A1:A3)",
				"ROW(A1)+ROW()",
				"TRANSPOSE(A1:C1)",
				"MMULT(A1:B2,C1:D2)*2",
				"SUM(ROW(A1:A3))",
				"LEN(TRANSPOSE(A1:C1))",
				"TRANSPOSE(ROW(A1:A3))",
				'HYPERLINK("https://filen.io","x")'
			].map(shown)
		).toEqual([
			"@COLUMN(1:2)",
			"@ROW(A1:A3)",
			"ROW(A1)+ROW()",
			"@TRANSPOSE(A1:C1)",
			"@MMULT(A1:B2,C1:D2)*2",
			"SUM(ROW(A1:A3))",
			"LEN(@TRANSPOSE(A1:C1))",
			"@TRANSPOSE(ROW(A1:A3))",
			'HYPERLINK("https://filen.io","x")'
		])
	})

	it("typed again as shown or edited, a function that may give an array keeps giving one value", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>COLUMN(1:2)</f><v>1</v></c><c r="C1"><f>ROW(A1:A3)</f><v>1</v></c></row>' +
			'<row r="2"><c r="A2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row></sheetData>'
		const source = workbook(body, METADATA)
		const { session, sheet } = await open(source)
		const original = (await saved(session)).sheet

		expect(await inputs(session, sheet, ["B1", "C1"])).toEqual(["=@COLUMN(1:2)", "=@ROW(A1:A3)"])

		for (const cell of ["B1", "C1"]) await set(session, sheet, cell, (await inputs(session, sheet, [cell]))[0] ?? "")
		expect((await saved(session)).sheet).toBe(original)

		await set(session, sheet, "C1", "=@ROW(A1:A3)+1")
		expect(await texts(session, sheet, ["C1", "C2"])).toEqual(["2", ""])
		expect((await saved(session)).sheet).not.toContain('t="array"')
		session.close()
	})

	it("edited, keeps reading one value where it shows @", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>1</v></c><c r="E1"><v>10</v></c></row>' +
			'<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f>VLOOKUP(A1:A3,D1:E3,2,0)</f><v>20</v></c><c r="D2"><v>2</v></c><c r="E2"><v>20</v></c></row>' +
			'<row r="3"><c r="A3"><v>3</v></c><c r="D3"><v>3</v></c><c r="E3"><v>30</v></c></row></sheetData>'
		const { session, sheet } = await open(workbook(body, METADATA))
		const [input] = await inputs(session, sheet, ["B2"])

		expect(input).toBe("=VLOOKUP(@A1:A3,D1:E3,2,0)")
		await set(session, sheet, "B2", `${input ?? ""}+0`)
		expect(await texts(session, sheet, ["B2", "B3"])).toEqual(["20", ""])
		expect((await saved(session)).sheet).not.toContain('t="array"')
		session.close()
	})

	it("means the same typed again as shown, and is saved as it was", async () => {
		const { session, sheet } = await open(workbook(LEGACY, METADATA))
		const source = (await saved(session)).sheet

		for (const cell of ["B2", "C2", "D2", "E2"]) await set(session, sheet, cell, (await inputs(session, sheet, [cell]))[0] ?? "")
		expect(await texts(session, sheet, ["B2", "B3", "C2", "C3", "D2", "D3", "E2"])).toEqual(["2", "", "22", "", "44", "keep", "378"])

		const { sheet: xml } = await saved(session)

		expect(xml).toContain("<f>LEN(A1:A3)</f>")
		expect(xml).toContain("<f>A1:A3*2</f>")
		expect(xml).not.toContain('t="array"')
		expect(xml.length).toBe(source.length)

		// Edited, the @ it shows keeps it reading one value.
		await set(session, sheet, "B2", "=LEN(@A1:A3)+1")
		expect(await texts(session, sheet, ["B2", "B3"])).toEqual(["3", ""])
		expect((await saved(session)).sheet).toContain("<f>LEN(_xlfn.SINGLE(A1:A3))+1</f>")
		session.close()
	})
})

describe("trim references", () => {
	// support.microsoft.com "TRIMRANGE function": A1:.A9 trims the trailing empty cells, A1.:A9 the leading, A1.:.A9
	// both. Excel's stored form of one is not documented ([MS-XLSX] 2.2.3 lists none): a typed one is refused, and one
	// a file holds (_xlfn._TRO_TRAILING and its kin) is kept as written and calculated as TRIMRANGE.
	it("typed, are refused with their reason rather than written under a name Excel may not read", async () => {
		const { session, sheet } = await open(workbook('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'))
		const reason = async (input: string): Promise<string> => {
			const result = await session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(2), inputs: [input] }
			})

			return result.ok ? "ok" : `${result.refusal.reason} ${result.refusal.detail ?? ""}`
		}

		expect(await reason("=SUM(A:.A)")).toBe("formula trimReference")
		expect(await reason("=Sheet2!A1.:B9")).toBe("formula trimReference")
		expect(await reason("=COUNTA('My S'!$A$1.:.$B9)")).toBe("formula trimReference")
		expect(await reason('=A1:B2+1.5&"x:.y"')).toBe("ok")
		session.close()
	})

	it("in a file, are kept as written and calculate as TRIMRANGE", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><f>SUM(_xlfn._TRO_TRAILING(A:A))</f><v>3</v></c></row>' +
			'<row r="2"><c r="A2"><v>2</v></c></row></sheetData>'
		const { session, sheet } = await open(workbook(body))

		await set(session, sheet, "A1", "5")
		expect(await texts(session, sheet, ["C1"])).toEqual(["7"])
		expect(await inputs(session, sheet, ["C1"])).toEqual(["=SUM(_xlfn._TRO_TRAILING(A:A))"])

		// Typed again as shown, it stays as written.
		await set(session, sheet, "C1", "=SUM(_xlfn._TRO_TRAILING(A:A))")
		expect((await saved(session)).sheet).toContain('<c r="C1"><f>SUM(_xlfn._TRO_TRAILING(A:A))</f><v>7</v></c>')
		session.close()
	})
})

describe("a typed pattern the app's regular expressions do not run", () => {
	it("is refused with its reason, not kept without a result", async () => {
		const { session, sheet } = await open(workbook('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'))
		const reason = async (input: string): Promise<string> => {
			const result = await session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(1), inputs: [input] }
			})

			return result.ok ? "ok" : `${result.refusal.reason} ${result.refusal.detail ?? ""}`
		}

		expect(await reason('=REGEXTEST("ab","(?=a)+b")')).toBe("formula regex")
		expect(await reason('=REGEXTEST(REPT("a",9),"(a{1,100}){1,100}b")')).toBe("formula regex")
		expect(await reason('=REGEXREPLACE("aa","(a)\\1","x")')).toBe("formula regex")
		expect(await reason('=REGEXTEST("ab","[")')).toBe("ok")
		expect(await reason('=REGEXTEST("(?=a)+b",A1)')).toBe("ok")
		expect(await texts(session, sheet, ["B1"])).toEqual(["FALSE"])
		session.close()
	})
})

describe("a column of formulas recalculated together", () => {
	it("gives each cell what it gives alone, and holds none whose inputs changed", async () => {
		// Each REGEXTEST and each recursive LAMBDA has a budget of its own, not one shared by a recalculation.
		const count = 2000
		let rows = ""

		for (let r = 1; r <= count; r++)
			rows += `<row r="${String(r)}"><c r="A${String(r)}" t="inlineStr"><is><t>item-1</t></is></c><c r="B${String(r)}" t="b"><f>REGEXTEST(A${String(r)},"(\\w+)-(\\d+)$")</f><v>1</v></c></row>`

		const { session, sheet } = await open(workbook(`<sheetData>${rows}</sheetData>`))
		const text = "x".repeat(2000)
		const result = await session.command({
			type: "cells.set",
			sheet,
			cells: {
				rows: Uint32Array.from({ length: count }, (_, i) => i),
				cols: new Uint16Array(count),
				inputs: Array.from({ length: count }, () => text)
			}
		})

		changeOf(result)

		const { sheet: xml } = await saved(session)

		expect(xml.match(/t="b"><f>[^<]*<\/f><v>0<\/v>/g)?.length).toBe(count)
		expect(xml).not.toMatch(/t="b"><f>[^<]*<\/f><v>1<\/v>/)
		session.close()
	})
})

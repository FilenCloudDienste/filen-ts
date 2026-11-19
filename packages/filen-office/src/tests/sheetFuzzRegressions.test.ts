import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openXlsxSession } from "../core/sheet/commands"
import type { SheetCommandResult, SheetTile } from "../core/sheet/protocol"
import { encodeUtf8 } from "../core/xml/index"
import { CORPUS_DIR } from "./corpusDir"
import { fixtureBytes } from "./fuzz/sheet/fixtures"
import { isFinding, runSequence, type FuzzMode } from "./fuzz/sheet/harness"
import { R, SML, buildFixture, equalBytes } from "./xlsxWriteFixtures"
import { ZIP_ENTRY_TIME } from "./zipTime"
import { IMMEDIATE } from "./sheetSessionFixtures"

// Sequences the sheet fuzz found, kept as plain tests.

async function open(name: string, bytes = fixtureBytes(name)) {
	const opened = await openXlsxSession(bytesSource(bytes.slice()), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (opened.kind !== "opened") throw new Error(`expected an open, got ${opened.kind}`)

	expect(await opened.session.intent()).toEqual({ state: "writable" })

	return { session: opened.session, bytes }
}

// The bare fixture with its workbook.xml replaced.
function withWorkbook(xml: string): Uint8Array {
	const files: Record<string, Uint8Array> = unzipSync(buildFixture({ sheets: [{ name: "Sheet1", body: "<sheetData/>" }] }))

	files["xl/workbook.xml"] = encodeUtf8(xml)

	return zipSync(files, { mtime: ZIP_ENTRY_TIME })
}

async function workbookAfterUndo(bytes: Uint8Array, edits: (session: Awaited<ReturnType<typeof open>>["session"]) => Promise<number>) {
	const { session } = await open("", bytes)
	const count = await edits(session)

	for (let k = 0; k < count; k++) ok(await session.undo())

	const saved = await session.save()

	session.close()

	if (!saved.ok) throw new Error(saved.message)

	return new TextDecoder().decode(unzipSync(saved.bytes)["xl/workbook.xml"])
}

function ok(result: SheetCommandResult): void {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`)
}

function entry(tile: SheetTile, row: number, col: number): string {
	const position = ((row & 63) << 5) | (col & 31)

	for (let i = 0; i < tile.count; i++) {
		if (tile.positions[i] !== position) continue

		const text = tile.texts[i] ?? -1
		const input = tile.inputs[i] ?? -1

		return `${text < 0 ? "" : tile.strings[text]}|${input < 0 ? "" : tile.strings[input]}`
	}

	return "absent"
}

describe("sheet fuzz regressions", () => {
	it("undoes a row deletion without bringing back a later edit's cells", async () => {
		const { session, bytes } = await open("bare")
		const cells = (rows: number[], cols: number[], inputs: string[]) => ({
			rows: Uint32Array.from(rows),
			cols: Uint16Array.from(cols),
			inputs
		})

		ok(await session.command({ type: "axis.delete", sheet: 0, axis: "rows", at: 1, count: 2 }))
		// B1 written in place, then a new row: the block the deletion's undo holds is replaced.
		ok(await session.command({ type: "cells.set", sheet: 0, cells: cells([0, 3], [1, 0], ["=C1*2", "5"]) }))
		ok(await session.undo())
		ok(await session.undo())

		const { tiles } = await session.tiles(0, Uint32Array.of(0, 0))

		expect(entry(tiles[0] as SheetTile, 0, 1)).toBe("2|=A1+1")

		const saved = await session.save()

		if (!saved.ok) throw new Error(saved.message)

		const sheet = "xl/worksheets/sheet1.xml"

		expect(equalBytes(unzipSync(saved.bytes)[sheet] ?? new Uint8Array(), unzipSync(bytes)[sheet] ?? new Uint8Array())).toBe(true)
		session.close()
	})

	it.each(["<definedNames/>", "<definedNames />"])("keeps an empty %s through an autofilter and its undo", async names => {
		const xml = `<workbook xmlns="${SML}" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>${names}</workbook>`
		const after = await workbookAfterUndo(withWorkbook(xml), async session => {
			ok(
				await session.command({
					type: "cells.set",
					sheet: 0,
					cells: { rows: Uint32Array.of(0, 1), cols: Uint16Array.of(0, 0), inputs: ["a", "1"] }
				})
			)
			ok(
				await session.command({
					type: "filter.toggle",
					sheet: 0,
					range: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
					active: { row: 0, col: 0 }
				})
			)

			return 2
		})

		expect(after).toBe(xml)
	})

	it("adds no bookViews to a prefixed workbook without one when a sheet added and activated is undone", async () => {
		const xml = `<x:workbook xmlns:x="${SML}"><x:sheets><x:sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="${R}" /></x:sheets></x:workbook>`
		const after = await workbookAfterUndo(withWorkbook(xml), async session => {
			ok(await session.command({ type: "sheet.add", index: 0 }))

			return 1
		})

		expect(after).toBe(xml)
	})

	it("writes the active tab into a source bookViews without a workbookView", async () => {
		const xml = `<workbook xmlns="${SML}" xmlns:r="${R}"><bookViews/><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
		const { session } = await open("", withWorkbook(xml))

		// Added before the active sheet, which moves to the second tab.
		ok(await session.command({ type: "sheet.add", index: 0 }))

		const saved = await session.save()

		session.close()

		if (!saved.ok) throw new Error(saved.message)

		expect(new TextDecoder().decode(unzipSync(saved.bytes)["xl/workbook.xml"])).toContain(
			'<bookViews><workbookView activeTab="1"/></bookViews>'
		)
	})

	it("keeps a cell whose reference names no row in its column when the cell before it is cleared", async () => {
		const bytes = buildFixture({
			sheets: [
				{
					name: "Sheet1",
					body: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B" t="inlineStr"><is><t>b</t></is></c></row></sheetData>'
				}
			]
		})
		const { session } = await open("", bytes)

		ok(
			await session.command({
				type: "cells.set",
				sheet: 0,
				cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: [""] }
			})
		)

		const saved = await session.save()

		session.close()

		if (!saved.ok) throw new Error(saved.message)

		const reopened = await open("", saved.bytes)
		const { tiles } = await reopened.session.tiles(0, Uint32Array.of(0, 0))

		expect(entry(tiles[0] as SheetTile, 0, 0)).toBe("absent")
		expect(entry(tiles[0] as SheetTile, 0, 1)).toBe("b|")
		reopened.session.close()
	})

	it("shows what reads a formula the engine cannot parse the same once the engine is built again", async () => {
		const bytes = buildFixture({
			sheets: [
				{ name: "Sheet1", body: '<sheetData><row r="1"><c r="A1"><f>B1-(-4,3)</f><v>4.3</v></c></row></sheetData>' },
				{ name: "Sheet2" },
				{ name: "Sheet3" }
			]
		})
		const { session } = await open("", bytes)
		const shown = async (live: typeof session, sheet: number) => {
			const { tiles } = await live.tiles(sheet, Uint32Array.of(0, 0))

			return [entry(tiles[0] as SheetTile, 0, 0), entry(tiles[0] as SheetTile, 1, 0)]
		}
		const copied = await session.query("copy", { sheet: 0, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, cut: true })

		if ("refused" in copied) throw new Error(copied.refused)

		// Moved to another sheet, the formula keeps no result of the file's: it shows the engine's parse error.
		ok(await session.command({ type: "clipboard.paste", sheet: 2, at: { row: 0, col: 0 }, text: copied.text, clip: copied.clip }))
		ok(
			await session.command({
				type: "cells.set",
				sheet: 2,
				cells: { rows: Uint32Array.of(1), cols: Uint16Array.of(0), inputs: ["=SUM(A1)"] }
			})
		)

		const before = await shown(session, 2)

		// Deleting a sheet drops the engine; the next edit builds it again from the cells.
		ok(await session.command({ type: "sheet.delete", sheet: 1 }))
		ok(
			await session.command({
				type: "cells.set",
				sheet: 0,
				cells: { rows: Uint32Array.of(4), cols: Uint16Array.of(1), inputs: ["=1"] }
			})
		)

		expect(await shown(session, 2)).toEqual(before)

		const saved = await session.save()

		session.close()

		if (!saved.ok) throw new Error(saved.message)

		const reopened = await open("", saved.bytes)

		await reopened.session.intent()
		await reopened.session.layout(1)

		expect(await shown(reopened.session, 1)).toEqual(before)
		reopened.session.close()
	})

	it("builds the engine again for a cell at the grid's far edge while another sheet reaches it too", async () => {
		// Enough lookups over whole columns that a cell at the last row has the engine built again.
		const rows = Array.from(
			{ length: 300 },
			(_, k) =>
				`<row r="${k + 1}"><c r="A${k + 1}"><v>${k + 1}</v></c><c r="B${k + 1}"><f>VLOOKUP(A${k + 1},$D:$E,2,0)</f><v>${k + 2}</v></c><c r="D${k + 1}"><v>${k + 1}</v></c><c r="E${k + 1}"><v>${k + 2}</v></c></row>`
		)
		const bytes = buildFixture({ sheets: [{ name: "Sheet1", body: `<sheetData>${rows.join("")}</sheetData>` }, { name: "Sheet2" }] })
		const { session } = await open("", bytes)

		// The second sheet's cells span the whole grid.
		ok(
			await session.command({
				type: "cells.set",
				sheet: 1,
				cells: { rows: Uint32Array.of(1_048_573, 0), cols: Uint16Array.of(1, 16_383), inputs: ["=A2*2", "50%"] }
			})
		)
		ok(
			await session.command({
				type: "cells.set",
				sheet: 0,
				cells: { rows: Uint32Array.of(1_048_573), cols: Uint16Array.of(4), inputs: ["=D1+1"] }
			})
		)

		const { tiles } = await session.tiles(0, Uint32Array.of(0, 0))

		expect(entry(tiles[0] as SheetTile, 0, 1)).toBe("2|=VLOOKUP(A1,$D:$E,2,0)")
		session.close()
	})
})

// Corpus sequences, run when the corpus is fetched: two URL links on a sheet whose root binds no relationships
// prefix, then a save; a sort over a shared formula reaching outside its rows, then undoing everything.
const CORPUS_SEQUENCES: readonly { readonly file: string; readonly seed: number; readonly mode: FuzzMode }[] = [
	{ file: "xlsx/lo__tdf137734.xlsx", seed: 54, mode: "sync" },
	{ file: "xlsx/poi__45544.xlsx", seed: 60, mode: "race" },
	{ file: "xlsx/poi__45540_classic_Header.xlsx", seed: 60, mode: "race" }
]

describe("sheet fuzz corpus sequences", () => {
	for (const { file, seed, mode } of CORPUS_SEQUENCES) {
		const path = join(CORPUS_DIR, file)

		it.skipIf(!existsSync(path))(`${file}, seed ${String(seed)}, ${mode}`, { timeout: 60_000 }, async () => {
			const result = await runSequence(new Uint8Array(readFileSync(path)), "xlsx", file, seed, mode)

			expect(isFinding(result) ? JSON.stringify(result).slice(0, 3000) : "").toBe("")
		})
	}
})

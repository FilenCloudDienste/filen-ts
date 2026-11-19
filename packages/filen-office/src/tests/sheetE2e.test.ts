import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { SheetChange, SheetSessionApi, SheetTile } from "../core/sheet/protocol"
import type { SheetSession } from "../core/sheet/session"
import type { XlsxDocument } from "../core/xlsx/edit/document"
import { inThreadSheetHost } from "../dom/sheet/host"
import { compareRecords, modelRecord, readSaved } from "./fuzz/sheet/compare"
import { fixtureBytes } from "./fuzz/sheet/fixtures"
import { equalBytes } from "./xlsxWriteFixtures"
import { changeOf, IMMEDIATE } from "./sheetSessionFixtures"

// A session end to end through the in-thread host, as a renderer drives it: open, hold tiles, prove, then one
// edit of every command family (cells, formats, rows, sizes, sheets, the clipboard) with undo and redo, each
// answered by patches to the held tiles; the save passes its gate, reads back without the engine as the model
// holds it, keeps every part it did not change byte for byte, and a fresh session on it shows the same cells.

async function open(bytes: Uint8Array): Promise<{ session: SheetSessionApi; sheets: Map<string, number> }> {
	const host = inThreadSheetHost()
	const result = await host.open(bytes.slice(), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

	return { session: result.session, sheets: new Map(result.info.sheets.map(sheet => [sheet.name, sheet.id])) }
}

function shown(tile: SheetTile, row: number, col: number): string {
	const position = ((row & 63) << 5) | (col & 31)

	for (let i = 0; i < tile.count; i++) {
		if (tile.positions[i] !== position) continue

		const text = tile.texts[i] ?? -1

		return text < 0 ? "" : (tile.strings[text] ?? "")
	}

	return ""
}

function patch(change: SheetChange, sheet: number): SheetTile {
	const found = change.patches.find(candidate => candidate.sheet === sheet && candidate.tileRow === 0 && candidate.tileCol === 0)

	if (found === undefined) throw new Error("no patch for the held tile")

	return found
}

async function texts(session: SheetSessionApi, sheet: number): Promise<Map<string, string>> {
	const { tiles } = await session.tiles(sheet, Uint32Array.of(0, 0))
	const tile = tiles[0] as SheetTile
	const out = new Map<string, string>()

	for (let i = 0; i < tile.count; i++) {
		const position = tile.positions[i] ?? 0
		const text = tile.texts[i] ?? -1
		const input = tile.inputs[i] ?? -1

		out.set(`${position >> 5},${position & 31}`, `${text < 0 ? "" : tile.strings[text]}|${input < 0 ? "" : tile.strings[input]}`)
	}

	return out
}

describe("sheet sessions end to end", () => {
	it("saves an unopened-for-editing workbook as its source", async () => {
		const bytes = fixtureBytes("rich")
		const { session } = await open(bytes)
		const saved = await session.save()

		expect(saved.ok && equalBytes(saved.bytes, bytes)).toBe(true)
		session.close()
	})

	it("edits through every command family and saves what it shows", { timeout: 60_000 }, async () => {
		const bytes = fixtureBytes("unnamed")
		const { session, sheets } = await open(bytes)
		const data = sheets.get("Data") as number
		const calc = sheets.get("Calc") as number

		await session.tiles(data, Uint32Array.of(0, 0))
		await session.tiles(calc, Uint32Array.of(0, 0))
		expect(await session.intent()).toEqual({ state: "writable" })

		// A1 feeds the shared formula down E ($A$1) and Calc!A1.
		const edit = changeOf(
			await session.command({
				type: "cells.set",
				sheet: data,
				cells: { rows: Uint32Array.of(0, 0), cols: Uint16Array.of(0, 8), inputs: ["10", "=A1*2"] }
			})
		)

		expect(shown(patch(edit, data), 0, 8)).toBe("20")
		// E2 = A2*B2+$A$1 = 6*2.5+10.
		expect(shown(patch(edit, data), 1, 4)).toBe("25")
		expect(shown(patch(edit, calc), 0, 0)).toBe("12.5")

		const format = changeOf(
			await session.command({
				type: "format.apply",
				sheet: data,
				ranges: [{ startRow: 0, startCol: 8, endRow: 0, endCol: 8 }],
				patch: { bold: true, numFmt: "0.00" }
			})
		)

		expect(shown(patch(format, data), 0, 8)).toBe("20.00")

		changeOf(await session.command({ type: "axis.insert", sheet: calc, axis: "rows", at: 2, count: 2 }))
		changeOf(
			await session.command({
				type: "axis.resize",
				sheet: data,
				axis: "cols",
				indices: Uint32Array.of(8),
				sizes: Float32Array.of(120)
			})
		)

		const added = changeOf(await session.command({ type: "sheet.add", name: "Notes" }))
		const notes = added.sheets?.find(sheet => sheet.name === "Notes")?.id

		expect(notes).toBeDefined()
		changeOf(await session.command({ type: "sheet.rename", sheet: calc, name: "Results" }))

		const copied = await session.query("copy", { sheet: data, range: { startRow: 0, startCol: 8, endRow: 0, endCol: 8 }, cut: false })

		if ("refused" in copied) throw new Error("copy refused")

		changeOf(
			await session.command({
				type: "clipboard.paste",
				sheet: notes as number,
				at: { row: 1, col: 8 },
				text: copied.text,
				clip: copied.clip
			})
		)
		// The paste is undone and done again; so is the rename.
		changeOf(await session.undo())
		changeOf(await session.undo())
		changeOf(await session.redo())
		changeOf(await session.redo())

		const saved = await session.save()

		if (!saved.ok) throw new Error(`${saved.reason}: ${saved.message}`)

		const document = (session as SheetSession<XlsxDocument>).document

		expect(compareRecords(modelRecord(document.workbook), await readSaved(saved.bytes))).toEqual([])

		// Every part the save did not change is the source's.
		const before = unzipSync(bytes)
		const after = unzipSync(saved.bytes)
		const changed = new Set(saved.changedParts.map(part => part.replace(/^\//, "")))

		for (const [part, content] of Object.entries(before))
			if (!changed.has(part) && after[part] !== undefined) expect(equalBytes(after[part], content), part).toBe(true)

		// A fresh session shows what this one shows.
		const again = await open(saved.bytes)

		expect([...again.sheets.keys()]).toEqual(["Data", "Results", "Hidden", "Locked", "Notes"])

		for (const [name, id] of sheets) {
			const other = again.sheets.get(name === "Calc" ? "Results" : name) as number

			expect(await texts(again.session, other), name).toEqual(await texts(session, id))
		}

		expect(await texts(again.session, again.sheets.get("Notes") as number)).toEqual(await texts(session, notes as number))
		expect((await texts(again.session, again.sheets.get("Notes") as number)).get("1,8")).toBe("0.00|=A2*2")
		session.close()
		again.session.close()
	})

	it("refuses what protection forbids and saves nothing of it", async () => {
		const bytes = fixtureBytes("rich")
		const { session, sheets } = await open(bytes)
		const locked = sheets.get("Locked") as number

		await session.intent()

		const result = await session.command({
			type: "cells.set",
			sheet: locked,
			cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["2"] }
		})

		expect(result.ok).toBe(false)
		expect(!result.ok && result.refusal.reason).toBe("protectedSheet")

		const saved = await session.save()

		expect(saved.ok && equalBytes(saved.bytes, bytes)).toBe(true)
		session.close()
	})
})

import { unzipSync, zipSync } from "fflate"
import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeUtf8, encodeUtf8 } from "../core/xml/index"
import { CellFlag, type SheetChange, type SheetTile } from "../core/sheet/protocol"
import { openXlsx } from "../core/xlsx/read/index"
import { XlsxDocument } from "../core/xlsx/edit/document"
import { bytesSource } from "../core/opc/index"
import { changedEntries, equalBytes, parts } from "./xlsxWriteFixtures"
import { BASIC, SML, buildFixture, cells, firstTile, openFixture, savedBytes, tileEntry, tileTexts, changeOf } from "./sheetSessionFixtures"
import { ZIP_ENTRY_TIME } from "./zipTime"

function patched(change: SheetChange, sheet: number): SheetTile {
	const patch = change.patches.find(candidate => candidate.sheet === sheet && candidate.tileRow === 0 && candidate.tileCol === 0)

	if (patch === undefined) throw new Error("no patch for the held tile")

	return patch
}

describe("sheet session: open and tiles", () => {
	it("opens with the active sheet's layout and shows cells through their formats", async () => {
		const { session, info } = await openFixture(BASIC)

		expect(info.kind).toBe("xlsx")
		expect(info.sheets.map(sheet => sheet.name)).toEqual(["One", "Two"])
		expect(info.writability).toEqual({ state: "unproven" })
		expect(info.activeLayout.rowCount).toBe(3)

		const tile = await firstTile(session, info.activeSheet)
		const texts = tileTexts(tile)

		expect(texts.get("0,0")).toBe("2")
		expect(texts.get("0,1")).toBe("hello")
		expect(texts.get("0,2")).toBe("6")
		// numFmtId 14 (m/d/yyyy) on 45000.
		expect(texts.get("1,0")).toBe("3/15/2023")
		expect(texts.get("1,1")).toBe("TRUE")
		expect(tileEntry(tile, 0, 2)?.input).toBe("=A1*3")
		expect(tileEntry(tile, 1, 0)?.input).toBe("2023-03-15")
		expect((tileEntry(tile, 0, 2)?.flags ?? 0) & CellFlag.FORMULA).toBe(CellFlag.FORMULA)
		expect((tileEntry(tile, 1, 1)?.flags ?? 0) & CellFlag.BOOLEAN).toBe(CellFlag.BOOLEAN)
		// Typed arrays own their buffers: a worker host transfers them.
		expect(tile.positions.buffer.byteLength).toBe(tile.positions.byteLength)
		session.close()
	})

	it("answers the first tiles from the sheet's first rows while the rest is parsed, then sends them again", async () => {
		const rows = Array.from(
			{ length: 300 },
			(_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c><c r="B${i + 1}"><f>A${i + 1}*2</f><v>${i * 2}</v></c></row>`
		).join("")
		const { session, info, events } = await openFixture({
			sheets: [{ name: "One", body: `<dimension ref="A1:B300"/><sheetData>${rows}</sheetData>` }]
		})

		expect(info.sheets[0]?.ready).toBe(false)
		expect(info.activeLayout.rowCount).toBe(300)

		const first = await firstTile(session, 0)

		expect(tileTexts(first).get("63,1")).toBe("126")
		expect(tileEntry(first, 63, 1)?.input).toBe("=A64*2")

		// The cell query reads past the preview too, and gives what editing starts from.
		expect(await session.query("cell", { sheet: 0, row: 200, col: 1 })).toMatchObject({
			input: "=A201*2",
			flags: CellFlag.FORMULA | CellFlag.NUMBER
		})
		expect((await session.query("cell", { sheet: 0, row: 200, col: 0 })).input).toBe("200")

		// Past the preview: the parse is waited for.
		const { tiles } = await session.tiles(0, Uint32Array.of(4, 0))

		expect(tileTexts(tiles[0]!).get("299,0")).toBe("299")
		await session.layout(0)
		await new Promise(resolve => setTimeout(resolve, 10))
		expect(events.some(event => event.type === "sheetReady" && event.sheet.id === 0)).toBe(true)
		expect(events.some(event => event.type === "change" && event.change.patches.some(patch => patch.tileRow === 0))).toBe(true)
		session.close()
	})

	it("shows rich text with its runs, and sends the first tiles' looks with the open", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{ name: "One", body: '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>1</v></c></row></sheetData>' }
			],
			sharedStrings: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${SML}" count="1" uniqueCount="1"><si><r><rPr><b/><sz val="14"/><color rgb="FFFF0000"/></rPr><t>bold</t></r><r><t xml:space="preserve"> plain</t></r></si></sst>`
		})
		const tile = await firstTile(session, info.activeSheet)
		const entry = tileEntry(tile, 0, 0)
		const runs = tile.layers?.runs

		expect(entry?.text).toBe("bold plain")
		expect((entry?.flags ?? 0) & CellFlag.RICH).toBe(CellFlag.RICH)
		expect(Array.from(runs?.runStarts ?? [])).toEqual([0, 4])

		const styles = [{}, ...info.styles.styles]

		expect(styles[runs?.runStyles[0] ?? 0]).toMatchObject({ bold: true, size: 14, color: 0xff0000 })
		expect(styles[runs?.runStyles[1] ?? 0]?.bold).toBeUndefined()
		// Every look the first tile shows came with the open.
		expect(Math.max(...tile.styles, ...(runs?.runStyles ?? []))).toBeLessThan(styles.length)
		session.close()
	})

	it("saves an unedited workbook as its source, byte for byte", async () => {
		const { session, bytes } = await openFixture(BASIC)

		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})
})

describe("sheet session: cell edits", () => {
	it("proves on intent, then edits and recalculates dependents across sheets", async () => {
		const { session, info, events } = await openFixture(BASIC)
		const one = info.sheets[0]!.id
		const two = info.sheets[1]!.id

		expect(await session.intent()).toEqual({ state: "writable" })
		await firstTile(session, one)
		await firstTile(session, two)

		const change = changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "5"]]) }))
		const tile = patched(change, one)

		expect(tileTexts(tile).get("0,0")).toBe("5")
		expect(tileTexts(tile).get("0,2")).toBe("15")
		expect(tileTexts(patched(change, two)).get("0,0")).toBe("6")
		expect(change.state.dirty).toBe(true)
		expect(events.some(event => event.type === "writability" && event.writability.state === "writable")).toBe(true)

		const reopened = await openFixture(await savedBytes(session))
		const back = await firstTile(reopened.session, reopened.info.sheets[0]!.id)

		expect(tileTexts(back).get("0,0")).toBe("5")
		expect(tileTexts(back).get("0,2")).toBe("15")
		session.close()
		reopened.session.close()
	})

	it("reads entries as Excel does: text, numbers with their implied format, booleans, dates, formulas", async () => {
		const { session, info } = await openFixture(BASIC)
		const one = info.sheets[0]!.id

		await firstTile(session, one)

		const change = changeOf(
			await session.command({
				type: "cells.set",
				sheet: one,
				cells: cells([
					[4, 0, "hello"],
					[4, 1, "1,234.5"],
					[4, 2, "50%"],
					[5, 0, "true"],
					[5, 1, "2024-03-05"],
					[5, 2, "'007"],
					[6, 0, '=A5&"!"'],
					[6, 1, "14:30"]
				])
			})
		)
		const tile = patched(change, one)
		const texts = tileTexts(tile)

		expect(texts.get("4,0")).toBe("hello")
		expect(texts.get("4,1")).toBe("1,234.50")
		expect(texts.get("4,2")).toBe("50%")
		expect(texts.get("5,0")).toBe("TRUE")
		expect(texts.get("5,1")).toBe("2024-03-05")
		expect(texts.get("5,2")).toBe("007")
		expect(tileEntry(tile, 5, 2)?.input).toBe("'007")
		expect(texts.get("6,0")).toBe("hello!")
		expect(texts.get("6,1")).toBe("14:30")
		session.close()
	})

	it("saves an empty sheet as its source after a row is added and undone", async () => {
		const { session, info, bytes } = await openFixture({ sheets: [{ name: "One", body: "<sheetData/>" }] })

		changeOf(await session.command({ type: "cells.set", sheet: info.sheets[0]!.id, cells: cells([[3, 0, "1"]]) }))
		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})

	it("refuses a malformed formula and keeps the file as it was", async () => {
		const { session, info, bytes } = await openFixture(BASIC)
		const result = await session.command({ type: "cells.set", sheet: info.sheets[0]!.id, cells: cells([[0, 0, "=SUM(A1"]]) })

		expect(result.ok).toBe(false)
		expect(!result.ok && result.refusal.reason).toBe("formula")
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("undoes and redoes an edit, and an undone edit saves as the source", async () => {
		const { session, info, bytes } = await openFixture(BASIC)
		const one = info.sheets[0]!.id

		await firstTile(session, one)
		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "7"]]) }))

		const undone = changeOf(await session.undo())

		expect(tileTexts(patched(undone, one)).get("0,2")).toBe("6")
		expect(undone.state).toMatchObject({ dirty: false, canUndo: false, canRedo: true })
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)

		const redone = changeOf(await session.redo())

		expect(tileTexts(patched(redone, one)).get("0,2")).toBe("21")
		expect(redone.state.dirty).toBe(true)
		session.close()
	})

	it("changes only the edited row's sheet part and the parts a new string needs", async () => {
		const { session, info, bytes } = await openFixture(BASIC)
		const one = info.sheets[0]!.id

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[1, 1, "new text"]]) }))

		const output = await savedBytes(session)
		const entries = await changedEntries(bytes, output)

		expect(entries.changed).toEqual(["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"])
		expect(parts(output)["xl/sharedStrings.xml"]).toContain("<si><t>new text</t></si>")
		session.close()
	})

	it("clears contents, keeping formats", async () => {
		const { session, info } = await openFixture(BASIC)
		const one = info.sheets[0]!.id

		await firstTile(session, one)

		const change = changeOf(
			await session.command({
				type: "cells.clear",
				sheet: one,
				ranges: [{ startRow: 1, startCol: 0, endRow: 1, endCol: 1 }],
				what: "contents"
			})
		)
		const tile = patched(change, one)

		expect(tileTexts(tile).get("1,0")).toBe("")
		// A2 keeps its date format: typing a number shows it as a date.
		expect(tileEntry(tile, 1, 0)).not.toBeNull()
		expect(tileEntry(tile, 1, 1)).toBeNull()
		session.close()
	})

	it("asks Excel to recalculate only while an edited result is one the session could not calculate", async () => {
		const { session, info, bytes } = await openFixture(BASIC)
		const one = info.sheets[0]!.id

		await session.intent()
		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[5, 0, "=NOSUCHFUNC(1)"]]) }))
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toContain('fullCalcOnLoad="1"')
		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toBe(parts(bytes)["xl/workbook.xml"])
		changeOf(await session.redo())
		expect(parts(await savedBytes(session))["xl/workbook.xml"]).toContain('fullCalcOnLoad="1"')
		session.close()
	})
})

describe("sheet session: formats, sizes and structure", () => {
	it("applies bold, fill and a number format through appended records", async () => {
		const { session, info } = await openFixture(BASIC)
		const one = info.sheets[0]!.id

		await firstTile(session, one)

		const change = changeOf(
			await session.command({
				type: "format.apply",
				sheet: one,
				ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
				patch: { bold: true, fill: 0xff0000, numFmt: "0.00" }
			})
		)
		const entry = tileEntry(patched(change, one), 0, 0)
		const style = change.styles?.styles[(entry?.style ?? 0) - (change.styles?.from ?? 0)]

		expect(entry?.text).toBe("2.00")
		expect(style).toMatchObject({ bold: true, fill: 0xff0000 })

		const output = await savedBytes(session)
		const styles = parts(output)["xl/styles.xml"] ?? ""

		// "0.00" is built-in format 2 (ECMA-376 Part 1 §18.8.30): no numFmt record is added.
		expect(styles).not.toContain("<numFmts")
		expect(styles).toContain(
			'<xf numFmtId="2" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/></cellXfs>'
		)
		session.close()
	})

	it("resizes columns and rows in the file", async () => {
		const { session, info } = await openFixture(BASIC)
		const one = info.sheets[0]!.id
		const columns = changeOf(
			await session.command({
				type: "axis.resize",
				sheet: one,
				axis: "cols",
				indices: Uint32Array.of(1),
				sizes: Float32Array.of(120)
			})
		)

		expect(Array.from(columns.layouts[0]?.layout.cols?.indices ?? [])).toEqual([1])

		// A row's sample says which column each text is in.
		const sample = (await session.query("fitSample", { sheet: one, axis: "rows", index: 0, limit: 2 })) as {
			texts: readonly string[]
			indices?: Uint32Array
		}

		expect(sample.texts).toEqual(["hello", "2"])
		expect(Array.from(sample.indices ?? [])).toEqual([1, 0])
		expect(columns.layouts[0]?.layout.cols?.sizes[0]).toBe(120)

		changeOf(
			await session.command({ type: "axis.resize", sheet: one, axis: "rows", indices: Uint32Array.of(0), sizes: Float32Array.of(40) })
		)

		const sheet = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheet).toMatch(/<col min="2" max="2" width="[\d.]+" customWidth="1"\/>/)
		expect(sheet).toMatch(/<row r="1"[^>]* ht="30" customHeight="1"/)
		session.close()
	})

	it("inserts rows, moving cells and every formula that refers to them; undo saves as the source", async () => {
		const { session, info, bytes } = await openFixture(BASIC)
		const one = info.sheets[0]!.id
		const two = info.sheets[1]!.id
		const change = changeOf(await session.command({ type: "axis.insert", sheet: one, axis: "rows", at: 0, count: 2 }))

		expect(change.invalidated).toEqual([{ sheet: one, startRow: 0, startCol: 0, endRow: 1_048_575, endCol: 16_383 }])

		const tile = await firstTile(session, one)

		expect(tileTexts(tile).get("2,0")).toBe("2")
		expect(tileEntry(tile, 2, 2)?.input).toBe("=A3*3")
		expect(tileEntry(tile, 4, 0)?.input).toBe("=SUM(A3:A4)")
		expect(tileEntry(await firstTile(session, two), 0, 0)?.input).toBe("=One!A3+1")

		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("deletes columns and undoes the deletion back to the source bytes", async () => {
		const { session, info, bytes } = await openFixture(BASIC)
		const one = info.sheets[0]!.id

		changeOf(await session.command({ type: "axis.delete", sheet: one, axis: "cols", at: 0, count: 1 }))

		const tile = await firstTile(session, one)

		expect(tileTexts(tile).get("0,0")).toBe("hello")
		expect(tileEntry(tile, 0, 1)?.input).toBe("=#REF!*3")

		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		session.close()
	})

	it("deletes rows with a merge and undoes it back to the source bytes, edits in between undone too", async () => {
		const { session, info, bytes } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1" ht="20" customHeight="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>' +
						'<row r="3"><c r="A3"><f>A1+A2</f><v>3</v></c></row><row r="4"><c r="B4"><v>4</v></c></row></sheetData>' +
						'<mergeCells count="1"><mergeCell ref="B4:C5"/></mergeCells>'
				}
			]
		})
		const one = info.sheets[0]!.id
		const deleted = changeOf(await session.command({ type: "axis.delete", sheet: one, axis: "rows", at: 0, count: 2 }))

		expect(Array.from(deleted.layouts[0]?.layout.merges ?? [])).toEqual([1, 1, 2, 2])
		expect(tileEntry(await firstTile(session, one), 0, 0)?.input).toBe("=#REF!+#REF!")

		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[1, 1, "9"]]) }))
		changeOf(await session.undo())
		changeOf(await session.undo())
		expect(equalBytes(await savedBytes(session), bytes)).toBe(true)
		changeOf(await session.redo())
		expect(tileTexts(await firstTile(session, one)).get("1,1")).toBe("4")
		session.close()
	})

	it("moves a conditional format's range and formula with the rows", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>A1&gt;0</formula></cfRule></conditionalFormatting>'
				}
			]
		})

		changeOf(await session.command({ type: "axis.insert", sheet: info.sheets[0]!.id, axis: "rows", at: 0, count: 1 }))

		const sheet = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheet).toContain('<conditionalFormatting sqref="A2">')
		expect(sheet).toContain("<formula>A2&gt;0</formula>")
		session.close()
	})

	it("refuses to move rows past a construct it cannot move, naming it", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }],
			parts: {
				"xl/revisions/revisionHeaders.xml": {
					text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<headers xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" guid="{00000000-0000-0000-0000-000000000000}"/>',
					type: "application/vnd.openxmlformats-officedocument.spreadsheetml.revisionHeaders+xml"
				}
			}
		})
		const result = await session.command({ type: "axis.insert", sheet: info.sheets[0]!.id, axis: "rows", at: 0, count: 1 })

		expect(result.ok ? null : result.refusal).toEqual({ reason: "structureLocked", detail: "revisions" })
		session.close()
	})

	it("adds and renames sheets, rewriting formulas that name them", async () => {
		const { session, info } = await openFixture(BASIC)
		const one = info.sheets[0]!.id
		const two = info.sheets[1]!.id
		const added = changeOf(await session.command({ type: "sheet.add" }))

		expect(added.sheets?.map(sheet => sheet.name)).toEqual(["One", "Two", "Sheet3"])

		const taken = await session.command({ type: "sheet.rename", sheet: two, name: "one" })

		expect(taken.ok ? null : taken.refusal.reason).toBe("sheetName")

		const renamed = changeOf(await session.command({ type: "sheet.rename", sheet: one, name: "First" }))

		expect(renamed.sheets?.[0]?.name).toBe("First")
		expect(tileEntry(await firstTile(session, two), 0, 0)?.input).toBe("=First!A1+1")

		const output = await savedBytes(session)
		const reopened = await openXlsx(bytesSource(output))

		expect(reopened.ok && reopened.workbook.sheets.map(sheet => sheet.name)).toEqual(["First", "Two", "Sheet3"])
		session.close()
	})
})

describe("sheet session: clipboard", () => {
	it("pastes tab-separated text, and its own copy with formulas moved", async () => {
		const { session, info } = await openFixture(BASIC)
		const one = info.sheets[0]!.id

		await firstTile(session, one)

		const plain = changeOf(
			await session.command({ type: "clipboard.paste", sheet: one, at: { row: 9, col: 0 }, text: "1\t2\r\n3\tx\r\n" })
		)
		const texts = tileTexts(patched(plain, one))

		expect([texts.get("9,0"), texts.get("9,1"), texts.get("10,0"), texts.get("10,1")]).toEqual(["1", "2", "3", "x"])
		expect(plain.selection).toEqual({
			sheet: one,
			activeRow: 9,
			activeCol: 0,
			ranges: [{ startRow: 9, startCol: 0, endRow: 10, endCol: 1 }]
		})

		const copied = await session.query("copy", { sheet: one, range: { startRow: 0, startCol: 2, endRow: 0, endCol: 2 }, cut: false })

		if ("refused" in copied) throw new Error("copy refused")

		expect(copied.text).toBe("6")

		const pasted = changeOf(
			await session.command({ type: "clipboard.paste", sheet: one, at: { row: 1, col: 2 }, text: copied.text, clip: copied.clip })
		)
		const entry = tileEntry(patched(pasted, one), 1, 2)

		expect(entry?.input).toBe("=A2*3")
		expect(entry?.text).toBe("135000")
		session.close()
	})
})

// A fixture with its workbook.xml changed.
function withWorkbook(transform: (xml: string) => string): Uint8Array {
	const files: Record<string, Uint8Array> = unzipSync(
		buildFixture({ sheets: [{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }] })
	)
	const workbook = files["xl/workbook.xml"]

	if (workbook === undefined) throw new Error("no workbook part")

	files["xl/workbook.xml"] = encodeUtf8(transform(decodeUtf8(workbook)))

	return new Uint8Array(zipSync(files, { mtime: ZIP_ENTRY_TIME }))
}

describe("sheet session: writability", () => {
	it("is view-only, with the reason, when the author recommends read-only or set a password to modify", async () => {
		const recommended = await openFixture(
			withWorkbook(xml => xml.replace("<bookViews>", '<fileSharing readOnlyRecommended="1"/><bookViews>'))
		)

		expect(recommended.info.writability).toEqual({ state: "viewOnly", reason: "readOnlyRecommended" })
		expect(recommended.info.fileSharing).toMatchObject({ readOnlyRecommended: true, modifyPassword: false })

		const result = await recommended.session.command({
			type: "cells.set",
			sheet: recommended.info.sheets[0]!.id,
			cells: cells([[0, 0, "2"]])
		})

		expect(result.ok ? null : result.refusal).toEqual({ reason: "readOnly", detail: "readOnlyRecommended" })
		recommended.session.close()

		const password = withWorkbook(xml => xml.replace("<bookViews>", '<fileSharing reservationPassword="CC4B"/><bookViews>'))
		const locked = await openFixture(password)

		expect(locked.info.writability).toEqual({ state: "viewOnly", reason: "modifyPassword" })
		locked.session.close()

		const unlocked = await openFixture(password, { writeUnlocked: true })

		expect(unlocked.info.writability).toEqual({ state: "unproven" })
		expect(await unlocked.session.intent()).toEqual({ state: "writable" })
		unlocked.session.close()
	})

	it("refuses edits once the app declined to edit", async () => {
		const { session, info } = await openFixture(BASIC)

		session.viewOnly()

		const result = await session.command({ type: "cells.set", sheet: info.sheets[0]!.id, cells: cells([[0, 0, "1"]]) })

		expect(result.ok ? null : result.refusal.reason).toBe("readOnly")
		session.close()
	})

	it("honours sheet protection: locked cells and forbidden actions", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><sheetProtection sheet="1"/>'
				}
			]
		})
		const one = info.sheets[0]!.id
		const edit = await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "2"]]) })
		const format = await session.command({
			type: "format.apply",
			sheet: one,
			ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
			patch: { bold: true }
		})
		const state = await session.query("commandState", { sheet: one, ranges: [], types: ["format.apply", "cells.set"] })
		const tile = await firstTile(session, one)

		expect(edit.ok ? null : edit.refusal.reason).toBe("protectedSheet")
		expect(format.ok ? null : format.refusal).toEqual({ reason: "protectedSheet", detail: "formatCells" })
		expect(state.reasons[0]).toBe("protectedSheet")
		expect(state.enabled[1]).toBe(true)
		expect((tileEntry(tile, 0, 0)?.flags ?? 0) & CellFlag.LOCKED).toBe(CellFlag.LOCKED)
		session.close()
	})

	it("honours workbook structure protection", async () => {
		const { session, info } = await openFixture(
			withWorkbook(xml => xml.replace("<bookViews>", '<workbookProtection lockStructure="1"/><bookViews>'))
		)

		expect(info.protection).toEqual({ structure: true, windows: false, hasPassword: false })

		const result = await session.command({ type: "sheet.add" })

		expect(result.ok ? null : result.refusal.reason).toBe("protectedWorkbook")
		session.close()
	})
})

describe("sheet session: text model", () => {
	it("writes typed control characters and literal escapes as ST_Xstring", async () => {
		const { session, info } = await openFixture({ sheets: [{ name: "One", body: "<sheetData/>" }] })
		const one = info.sheets[0]!.id

		await firstTile(session, one)

		const change = changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "a\u0001b _x0041_"]]) }))

		expect(tileTexts(patched(change, one)).get("0,0")).toBe("a\u0001b _x0041_")

		const output = await savedBytes(session)

		// A workbook without a shared strings part gets one, counting the one reference.
		expect(parts(output)["xl/sharedStrings.xml"]).toContain(
			`<sst xmlns="${SML}" count="1" uniqueCount="1"><si><t>a_x0001_b _x005F_x0041_</t></si></sst>`
		)
		session.close()
	})
})

describe("sheet session: save failures", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("reports a save that threw as failed, not closed", async () => {
		const { session } = await openFixture(BASIC)

		vi.spyOn(XlsxDocument.prototype, "save").mockRejectedValueOnce(new TypeError("Cannot read properties of undefined"))

		expect(await session.save()).toEqual({ ok: false, reason: "failed", message: "Cannot read properties of undefined" })
		expect((await session.save()).ok).toBe(true)
		session.close()
	})

	it("reports a save that threw under an aborted signal as aborted", async () => {
		const { session } = await openFixture(BASIC)

		vi.spyOn(XlsxDocument.prototype, "save").mockRejectedValueOnce(new Error("stopped"))

		expect(await session.save({ signal: { aborted: true } })).toEqual({ ok: false, reason: "aborted", message: "stopped" })
		session.close()
	})

	it("reports a save of a closed session as closed", async () => {
		const { session } = await openFixture(BASIC)

		session.close()

		expect(await session.save()).toMatchObject({ ok: false, reason: "closed" })
	})
})

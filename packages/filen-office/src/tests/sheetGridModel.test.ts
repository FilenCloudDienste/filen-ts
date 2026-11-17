import { describe, expect, it, vi } from "vitest"
import { tileKey, type SheetChange, type SheetSessionApi, type SheetTile } from "../core/sheet/protocol"
import { SheetGridModel, type SheetGridKeptSizes, type SheetGridShift, type SheetGridSizes } from "../react/sheet/model"
import { cellSelection } from "../react/sheet/selection"
import { entryText } from "../react/sheet/tiles"
import { inThreadSheetHost } from "../dom/sheet/host"
import { BASIC, IMMEDIATE, buildFixture, openFixture } from "./sheetSessionFixtures"

// The grid's model over a real session on the in-thread host: tiles fetched for what a frame needs, entries shown
// at once and committed through the session, changes folded in in arrival order, and the races an in-flight tile
// can lose.

async function settle(): Promise<void> {
	for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))
}

async function opened(fixture = buildFixture(BASIC)): Promise<{ model: SheetGridModel; session: SheetSessionApi; sheet: number }> {
	const { session, info } = await openFixture(fixture)
	const model = new SheetGridModel({ source: session, edit: session, info })

	return { model, session, sheet: info.activeSheet }
}

function text(model: SheetGridModel, sheet: number, row: number, col: number): string | null {
	const found = model.entry(sheet, row, col)

	return found === null ? null : entryText(found.tile, found.entry)
}

describe("sheet grid model", () => {
	it("fetches the tiles a frame needs in one call and answers cells from them", async () => {
		const { model, session, sheet } = await opened()
		const tiles = vi.spyOn(session, "tiles")

		model.need(sheet, [0, 0, 0, 1])
		model.need(sheet, [0, 0, 0, 1])

		expect(tiles).toHaveBeenCalledTimes(1)

		await settle()

		expect(text(model, sheet, 0, 0)).toBe("2")
		expect(text(model, sheet, 0, 1)).toBe("hello")
		expect(model.getSnapshot().active).toEqual({ text: "2", input: "2", flags: expect.any(Number), known: true })
	})

	it("shows an entry at once, commits it, moves on and takes the recalculated tile", async () => {
		const { model, sheet } = await opened()
		const painted = vi.fn()

		model.onPaint(painted)
		model.need(sheet, [0, 0])
		await settle()

		expect(model.startEditing("4", "enter")).toBe(true)
		expect(model.getSnapshot().editing).toMatchObject({ row: 0, col: 0, text: "4", initial: "2" })

		const committing = model.commitEditing(cellSelection({ row: 1, col: 0 }, []))

		expect(model.pendingText(sheet, 0, 0)).toBe("4")
		expect(model.getSnapshot().selection.active).toEqual({ row: 1, col: 0 })
		expect(await committing).toBe(true)
		expect(model.pendingText(sheet, 0, 0)).toBeUndefined()
		expect(text(model, sheet, 0, 0)).toBe("4")
		expect(text(model, sheet, 0, 2)).toBe("12")
		expect(model.getSnapshot().state.dirty).toBe(true)
		expect(painted).toHaveBeenCalled()

		await model.undo()

		expect(text(model, sheet, 0, 0)).toBe("2")
		expect(model.getSnapshot().state.canRedo).toBe(true)
	})

	it("reopens a malformed formula marked, and sends nothing for an entry left as it was", async () => {
		const { model, session, sheet } = await opened()
		const command = vi.spyOn(session, "command")

		model.need(sheet, [0, 0])
		await settle()
		model.startEditing(null, "edit")

		expect(await model.commitEditing(null)).toBe(true)
		expect(command).not.toHaveBeenCalled()

		model.startEditing("=SUM(", "enter")

		expect(await model.commitEditing(cellSelection({ row: 1, col: 0 }, []))).toBe(false)
		expect(model.getSnapshot().editing).toMatchObject({ text: "=SUM(", invalid: true, row: 0, col: 0 })
		expect(model.getSnapshot().selection.active).toEqual({ row: 0, col: 0 })
	})

	it("keeps a whole-tile patch that lands before its tile, and fetches again a tile a move invalidated in flight", async () => {
		const { model, session, sheet } = await opened()
		const real = session.tiles.bind(session)
		let release: (() => void) | null = null

		vi.spyOn(session, "tiles").mockImplementation((id, coordinates) => {
			const answer = real(id, coordinates)

			return new Promise(resolve => {
				release = () => resolve(answer)
			})
		})

		const released = vi.spyOn(session, "release")

		model.need(sheet, [0, 0])

		const stale = (await real(sheet, Uint32Array.of(0, 0))).tiles[0] as SheetTile
		const newer: SheetTile = {
			...stale,
			version: stale.version + 5,
			strings: stale.strings.map(entry => (entry === "2" ? "patched" : entry))
		}
		const change: SheetChange = {
			state: { version: newer.version, dirty: true, canUndo: true, canRedo: false },
			patches: [{ ...newer, mode: "replace" }],
			invalidated: [],
			layouts: []
		}

		model.apply(change)
		;(release as unknown as () => void)()
		await settle()

		expect(text(model, sheet, 0, 0)).toBe("patched")

		model.tiles.invalidate({ sheet, startRow: 0, startCol: 0, endRow: 63, endCol: 31 }, new Set())
		model.need(sheet, [0, 0])
		model.apply({ ...change, patches: [], invalidated: [{ sheet, startRow: 0, startCol: 0, endRow: 1_048_575, endCol: 16_383 }] })
		;(release as unknown as () => void)()
		await settle()

		expect(model.tiles.has(tileKey(sheet, 0, 0))).toBe(false)
		expect(released.mock.calls.some(call => [...call[0]].includes(tileKey(sheet, 0, 0)))).toBe(true)
	})

	it("trims the cache to a multiple of a frame's need and tells the session which tiles it let go", async () => {
		const rows = Array.from({ length: 40 }, (_, k) => `<row r="${k * 64 + 1}"><c r="A${k * 64 + 1}"><v>${k}</v></c></row>`).join("")
		const { model, session, sheet } = await opened(buildFixture({ sheets: [{ name: "S", body: `<sheetData>${rows}</sheetData>` }] }))
		const released = vi.spyOn(session, "release")

		for (let tileRow = 0; tileRow < 40; tileRow++) {
			model.need(sheet, [tileRow, 0])
			await settle()
		}

		expect(model.tiles.size).toBeLessThanOrEqual(24)
		expect(released.mock.calls.flatMap(call => [...call[0]]).length).toBeGreaterThanOrEqual(16)
		expect(text(model, sheet, 39 * 64, 0)).toBe("39")
	})

	it("drops the tiles an inserted row moved, takes the new layout and fetches them again", async () => {
		const { model, sheet } = await opened()

		model.need(sheet, [0, 0])
		await settle()

		const result = await model.command({ type: "axis.insert", sheet, axis: "rows", at: 0, count: 1 })

		expect(result.ok).toBe(true)
		expect(model.tiles.has(tileKey(sheet, 0, 0))).toBe(false)
		expect(model.getSnapshot().layout?.rowCount).toBe(4)

		model.need(sheet, [0, 0])
		await settle()

		expect(text(model, sheet, 1, 0)).toBe("2")
		expect(text(model, sheet, 0, 0)).toBeNull()
	})

	it("switches sheets with their own layout and selection", async () => {
		const { model } = await opened()
		const second = model.getSnapshot().sheets[1]?.id as number

		model.setSheet(second)
		await settle()

		expect(model.getSnapshot().sheet).toBe(second)
		expect(model.getSnapshot().layout?.sheet).toBe(second)

		model.need(second, [0, 0])
		await settle()

		expect(text(model, second, 0, 0)).toBe("3")
	})

	it("commits an entry open as the grid turns read-only, and reports a malformed one rather than reopening it", async () => {
		const { model, sheet } = await opened()
		const refusals: string[] = []

		model.setRefusalHandler(refusal => refusals.push(refusal.reason))
		model.need(sheet, [0, 0])
		await settle()
		model.startEditing("4", "enter")
		model.setReadOnly(true)
		await settle()

		expect(model.getSnapshot().editing).toBeNull()
		expect(text(model, sheet, 0, 0)).toBe("4")
		expect(model.getSnapshot().state.dirty).toBe(true)

		model.setReadOnly(false)
		model.startEditing("=SUM(", "enter")
		model.setReadOnly(true)
		await settle()

		expect(model.getSnapshot().editing).toBeNull()
		expect(text(model, sheet, 0, 0)).toBe("4")
		expect(refusals).toEqual(["formula"])
	})

	it("edits and shows a cell whose text its tile cuts from the whole input, which the cell query gives", async () => {
		const long = "x".repeat(40_000)
		const { model, sheet } = await opened(
			buildFixture({
				sheets: [
					{ name: "One", body: `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${long}</t></is></c></row></sheetData>` }
				]
			})
		)

		model.need(sheet, [0, 0])
		await settle()

		expect(model.getSnapshot().active.input).toBe(long)

		model.startEditing(null, "edit")
		await settle()

		expect(model.getSnapshot().editing?.text).toBe(long)
	})

	it("judges an entry started before its cell's tile arrived against the cell's input, not against nothing", async () => {
		const { model, session, sheet } = await opened()
		const cleared = async (): Promise<string> => (await session.query("cell", { sheet, row: 0, col: 0 })).input

		// F2 and Enter at once: the entry is the cell's input, unchanged.
		expect(model.startEditing(null, "edit")).toBe(true)
		expect(await model.commitEditing(null)).toBe(true)
		expect(await cleared()).toBe("2")
		expect(model.getSnapshot().state.dirty).toBe(false)

		// Backspace and Enter at once: the cell is cleared.
		expect(model.startEditing("", "enter")).toBe(true)
		expect(await model.commitEditing(null)).toBe(true)
		expect(await cleared()).toBe("")
	})

	it("starts no entry when view-only, read-only by the app, failed, or on a locked cell", async () => {
		const { model } = await opened()

		model.setReadOnly(true)

		expect(model.startEditing("x", "enter")).toBe(false)

		model.setReadOnly(false)
		model.handleEvent({ type: "writability", writability: { state: "viewOnly", reason: "lossy" } })

		expect(model.startEditing("x", "enter")).toBe(false)

		model.handleEvent({ type: "writability", writability: { state: "writable" } })

		expect(model.startEditing("x", "enter")).toBe(true)

		model.handleEvent({ type: "failed", message: "gone" })

		expect(model.getSnapshot().editing).toBeNull()
		expect(model.canEdit()).toBe(false)
	})

	it("grows the shown extent past the used area to where the user went", async () => {
		const { model, sheet } = await opened()
		const layout = model.layout(sheet)

		if (layout === null) throw new Error("no layout")

		expect(model.extent(sheet, layout).rows).toBe(3 + 100)

		model.select(cellSelection({ row: 1_048_575, col: 3 }, []))

		expect(model.extent(sheet, layout).rows).toBe(1_048_576)
		expect(model.axes(sheet)?.rows.count).toBe(1_048_576)
	})

	it("keeps a text file's sizes in the app's layer: drawn over the file's, resized and shifted there", async () => {
		const host = inThreadSheetHost()
		const opened = await host.open(new TextEncoder().encode("a,b\nc,d\ne,f\n"), { kind: "csv", slicing: IMMEDIATE }, () => undefined)

		if (opened.kind !== "opened") throw new Error(opened.kind)

		const model = new SheetGridModel({ source: opened.session, edit: opened.session, info: opened.info })
		const sheet = opened.info.activeSheet
		const command = vi.spyOn(opened.session, "command")
		const follows: SheetGridShift[] = []
		let kept: SheetGridKeptSizes = { cols: new Map([[1, 150]]), rows: new Map() }
		const layer: SheetGridSizes = {
			sizes: () => kept,
			update: (_sheet, axis, entries) => {
				const next = new Map(axis === "cols" ? kept.cols : kept.rows)

				for (const [index, px] of entries) {
					if (px === null) next.delete(index)
					else next.set(index, px)
				}

				kept = axis === "cols" ? { ...kept, cols: next } : { ...kept, rows: next }
			},
			follow: (_sheet, shift) => {
				follows.push(shift)
			}
		}

		expect(model.canResize()).toBe(false)

		model.setSizes(layer)

		expect(model.canResize()).toBe(true)
		expect(model.axes(sheet)?.cols.size(1)).toBe(150)

		await model.resize(sheet, "cols", Uint32Array.of(0, 1), Float32Array.of(90, Number.NaN))
		model.setSizes({ ...layer })

		expect(command).not.toHaveBeenCalled()
		expect([...kept.cols]).toEqual([[0, 90]])
		expect(model.axes(sheet)?.cols.size(0)).toBe(90)
		expect(model.axes(sheet)?.cols.size(1)).toBe(model.layout(sheet)?.cols.defaultSize)

		const inserted = await model.command({ type: "axis.insert", sheet, axis: "rows", at: 1, count: 2 })

		expect(inserted.ok).toBe(true)

		await model.undo()
		await model.redo()

		expect(follows).toEqual([
			{ type: "insert", axis: "rows", at: 1, count: 2, revert: false },
			{ type: "insert", axis: "rows", at: 1, count: 2, revert: true },
			{ type: "insert", axis: "rows", at: 1, count: 2, revert: false }
		])
	})

	it("sends sizes to the session for a writable workbook and to the layer once it is view-only", async () => {
		const { model, session, sheet } = await opened()
		const update = vi.fn()

		model.setSizes({ sizes: () => undefined, update, follow: () => undefined })

		expect(model.keepsSizes()).toBe(false)

		const resized = vi.spyOn(session, "command")

		await model.resize(sheet, "cols", Uint32Array.of(0), Float32Array.of(120))

		expect(resized).toHaveBeenCalledWith(expect.objectContaining({ type: "axis.resize" }))
		expect(update).not.toHaveBeenCalled()

		model.handleEvent({ type: "writability", writability: { state: "viewOnly", reason: "lossy" } })
		await model.resize(sheet, "cols", Uint32Array.of(0), Float32Array.of(80))

		expect(update).toHaveBeenCalledWith(sheet, "cols", [[0, 80]])
		expect(resized).toHaveBeenCalledTimes(1)
	})
})

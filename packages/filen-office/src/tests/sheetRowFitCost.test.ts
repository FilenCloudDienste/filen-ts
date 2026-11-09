import { afterEach, describe, expect, it, vi } from "vitest"
import { TILE_COLS, TILE_ROWS, tileKey, type SheetChange, type SheetRange, type SheetRenderStyle } from "../core/sheet/protocol"
import type { SheetGridModel } from "../react/sheet/model"
import { TextMeasurer } from "../react/sheet/paint/text"
import { RowFitter, measureRows } from "../react/sheet/rowFit"
import type { GridTile } from "../react/sheet/tiles"
import { RecordingCanvas } from "./sheetGridCanvas"
import { budget, cpuMs } from "./timing"

// Fitting rows costs about the cells of the rows fitted, and a change to tiles without wrapped text costs close to
// nothing: no scan of a whole band per row, no test of every merge per cell, no look built for rows that never wrap.

const SHEET = 0
const PLAIN = 0
const WRAP = 1
const STYLES: SheetRenderStyle[] = [{}, { wrap: true }]

interface Counter {
	reads: number
}

// Counts the indexed reads of an array (or typed array).
function counted<T extends object>(target: T, counter: Counter): T {
	return new Proxy(target, {
		get(object, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) counter.reads++

			return Reflect.get(object, key, typeof receiver === "object" ? object : receiver) as unknown
		}
	})
}

// A full tile (every cell of its 64 rows x 32 columns), each cell showing `text` in `style`.
function fullTile(
	tileRow: number,
	tileCol: number,
	style: number,
	text = "words that wrap",
	counters?: { positions?: Counter; strings?: Counter }
): GridTile {
	const count = TILE_ROWS * TILE_COLS
	const positions = Uint16Array.from({ length: count }, (_, i) => i)
	const strings = [text]

	return {
		key: tileKey(SHEET, tileRow, tileCol),
		sheet: SHEET,
		tileRow,
		tileCol,
		version: 0,
		count,
		positions: counters?.positions === undefined ? positions : counted(positions, counters.positions),
		texts: new Int32Array(count),
		inputs: new Int32Array(count).fill(-1),
		styles: new Uint32Array(count).fill(style),
		flags: new Uint32Array(count),
		strings: counters?.strings === undefined ? strings : counted(strings, counters.strings)
	}
}

function fakeModel(tiles: GridTile[], merges: readonly SheetRange[] = []) {
	const held = new Map(tiles.map(tile => [tile.key, tile]))
	const command = vi.fn(() => Promise.resolve())
	const model = {
		tiles: { keys: () => held.keys(), peek: (key: number) => held.get(key) },
		style: (index: number) => STYLES[index] ?? STYLES[0],
		layout: () => ({ merges: [] }),
		axes: () => ({ cols: { size: () => 64 }, rows: { size: () => 20 }, scale: 1 }),
		merges: () => merges,
		getSnapshot: () => ({ readOnly: false, writability: { state: "writable" } }),
		command
	} as unknown as SheetGridModel

	return { model, held, command }
}

const measurer = () => new TextMeasurer(new RecordingCanvas())

// Merges far below the rows fitted, as a report-style sheet holds many.
function distantMerges(count: number): SheetRange[] {
	return Array.from({ length: count }, (_, k) => ({ startRow: 10_000 + 2 * k, startCol: 0, endRow: 10_001 + 2 * k, endCol: 1 }))
}

function change(keys: readonly { tileRow: number; tileCol: number }[]): SheetChange {
	return {
		patches: keys.map(({ tileRow, tileCol }) => ({ sheet: SHEET, tileRow, tileCol })),
		invalidated: [],
		layouts: []
	} as unknown as SheetChange
}

afterEach(() => {
	vi.useRealTimers()
})

describe("row fit cost", () => {
	it("reads only the entries of the rows fitted, not each row's whole band", () => {
		const positions: Counter = { reads: 0 }
		const band = Array.from({ length: 8 }, (_, col) => fullTile(0, col, col === 0 ? WRAP : PLAIN, "words that wrap", { positions }))
		const { model } = fakeModel(band)
		const rows = new Set([3, 17, 40, 63])
		const fitted = measureRows(model, SHEET, rows, measurer(), "sans-serif", new Set())

		expect(fitted === null ? null : Array.from(fitted.rows)).toEqual([3, 17, 40, 63])
		// A row's 32 entries in each of the 8 tiles, and a search for where they start and end.
		expect(positions.reads).toBeLessThanOrEqual(rows.size * band.length * (TILE_COLS + 2 * 13))
	})

	it("tests a wrapped cell only against the merges on its row", () => {
		const reads: Counter = { reads: 0 }
		// One merge over B4, so B4's text fits nothing; the rest far below.
		const merges = counted([{ startRow: 3, startCol: 1, endRow: 3, endCol: 1 }, ...distantMerges(20_000)], reads)
		const { model } = fakeModel([fullTile(0, 0, WRAP, "x")], merges)
		const rows = new Set(Array.from({ length: TILE_ROWS }, (_, row) => row))
		const fitted = measureRows(model, SHEET, rows, measurer(), "sans-serif", new Set())

		expect(fitted?.rows.length).toBe(TILE_ROWS)
		// One pass over the merges, not one per wrapped cell (64 x 32 x 20 001).
		expect(reads.reads).toBeLessThanOrEqual(merges.length + TILE_ROWS)
	})

	it("keeps a merged wrapped cell out of its row's height", () => {
		// B1 wraps a long text; every other cell is plain.
		const styles = new Uint32Array(TILE_ROWS * TILE_COLS)

		styles[1] = WRAP

		const wide = { ...fullTile(0, 0, PLAIN, "a long text that wraps over several lines"), styles }

		const plain = measureRows(fakeModel([wide]).model, SHEET, new Set([0]), measurer(), "sans-serif", new Set())
		const merged = measureRows(
			fakeModel([wide], [{ startRow: 0, startCol: 1, endRow: 1, endCol: 2 }, ...distantMerges(10)]).model,
			SHEET,
			new Set([0]),
			measurer(),
			"sans-serif",
			new Set([0])
		)

		expect(plain?.heights[0]).toBeGreaterThan(40)
		expect(merged === null ? null : Number.isNaN(merged.heights[0])).toBe(true)
	})

	it("fits 64 rows of 32 wrapped cells beside 20 000 merges without a long task", () => {
		const { model } = fakeModel([fullTile(0, 0, WRAP, "x")], distantMerges(20_000))
		const rows = new Set(Array.from({ length: TILE_ROWS }, (_, row) => row))
		const text = measurer()
		let least = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const started = cpuMs()

			measureRows(model, SHEET, rows, text, "sans-serif", new Set())
			least = Math.min(least, cpuMs() - started)
		}

		expect(least).toBeLessThan(budget(50))
	})

	it("reads no text of tiles without wrapped text when an edit changes them", () => {
		const strings: Counter = { reads: 0 }
		const keys = Array.from({ length: 100 }, (_, k) => ({ tileRow: Math.floor(k / 10), tileCol: k % 10 }))
		const { model } = fakeModel(keys.map(({ tileRow, tileCol }) => fullTile(tileRow, tileCol, PLAIN, "text", { strings })))
		const fitter = new RowFitter(model)

		fitter.attach({ measurer, font: () => "sans-serif" })
		fitter.changed(change(keys))

		expect(strings.reads).toBe(0)
	})

	it("fits a row that starts or stops wrapping, or whose wrapping row changes, and no other", () => {
		vi.useFakeTimers()

		const before = fullTile(0, 0, PLAIN, "words that wrap")
		const { model, held, command } = fakeModel([before])
		const fitter = new RowFitter(model)
		const styles = new Uint32Array(before.count)

		fitter.attach({ measurer, font: () => "sans-serif" })

		// Wrap goes on in A2: row 2 fits, nothing else.
		fitter.changed(change([{ tileRow: 0, tileCol: 0 }]))
		styles[TILE_COLS] = WRAP
		held.set(before.key, { ...before, styles })
		vi.runAllTimers()

		expect(command.mock.calls.map(call => Array.from((call as unknown as [{ rows: Uint32Array }])[0].rows))).toEqual([[1]])

		// A plain cell beside it changes (B2): its row still wraps, so it fits again.
		const wrapped = held.get(before.key) ?? before
		const texts = new Int32Array(before.count)

		texts[TILE_COLS + 1] = 1
		fitter.changed(change([{ tileRow: 0, tileCol: 0 }]))
		held.set(before.key, { ...wrapped, texts, strings: ["words that wrap", "other"] })
		vi.runAllTimers()

		expect(command.mock.calls.length).toBe(2)

		// Wrap goes off: the row that wrapped is sent with no height of wrapped text.
		fitter.changed(change([{ tileRow: 0, tileCol: 0 }]))
		held.set(before.key, before)
		vi.runAllTimers()

		const last = (command.mock.calls[2] as unknown as [{ rows: Uint32Array; heights: Float32Array }] | undefined)?.[0]

		expect(last === undefined ? null : [Array.from(last.rows), Number.isNaN(last.heights[0])]).toEqual([[1], true])

		// Plain text changes where nothing wraps: no fit.
		fitter.changed(change([{ tileRow: 0, tileCol: 0 }]))
		held.set(before.key, { ...before, strings: ["changed"] })
		vi.runAllTimers()

		expect(command.mock.calls.length).toBe(3)
	})
})

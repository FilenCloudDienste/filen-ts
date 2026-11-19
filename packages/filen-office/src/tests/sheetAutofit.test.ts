import { describe, expect, it, vi } from "vitest"
import { MAX_COL_WIDTH } from "../core/sheet/sizes/sizes"
import { tileKey, tilePosition, type SheetAxis, type SheetRange, type SheetRenderStyle } from "../core/sheet/protocol"
import { autofitSizes, MAX_FIT_INDICES } from "../react/sheet/autofit"
import type { SheetGridModel } from "../react/sheet/model"
import { TEXT_PADDING } from "../react/sheet/paint/cells"
import { TextMeasurer } from "../react/sheet/paint/text"
import type { GridTile } from "../react/sheet/tiles"
import { RecordingCanvas } from "./sheetGridCanvas"

// The explicit autofit's numbers: NaN where an index goes back to the default, a column's widest line plus its
// padding, a row's lines plus its padding, clamped, and at most MAX_FIT_INDICES indices. The recording canvas
// measures 0.55 of the font's pixel size per character; the default font is 11 pt (14.67 px, lines 18 px tall).

const SHEET = 0
const PLAIN = 0
const WRAP = 1
const STYLES: SheetRenderStyle[] = [{}, { wrap: true }]
const DEFAULT_ROW = 20

interface Sample {
	readonly texts: readonly string[]
	readonly wraps?: readonly number[]
	readonly indices?: readonly number[]
}

// The width the recording canvas gives `chars` characters in the default font.
function measured(chars: number): number {
	return chars * 14.67 * 0.55
}

// A tile holding one cell, `text` in the wrapping style.
function heldTile(row: number, col: number, text: string): GridTile {
	return {
		key: tileKey(SHEET, 0, 0),
		sheet: SHEET,
		tileRow: 0,
		tileCol: 0,
		version: 0,
		count: 1,
		positions: Uint16Array.of(tilePosition(row, col)),
		texts: Int32Array.of(0),
		inputs: Int32Array.of(-1),
		styles: Uint32Array.of(WRAP),
		flags: new Uint32Array(1),
		strings: [text]
	}
}

// A model whose session answers fitSample from `samples` by index (nothing sampled for the rest), drawn at `scale`
// with every column `colWidth` px wide at 100 %.
function fakeModel(
	samples: ReadonlyMap<number, Sample>,
	options: { tiles?: GridTile[]; merges?: SheetRange[]; colWidth?: number; scale?: number } = {}
) {
	const held = new Map((options.tiles ?? []).map(tile => [tile.key, tile]))
	const scale = options.scale ?? 1
	const query = vi.fn((_type: "fitSample", request: { readonly index: number }) => {
		const sample = samples.get(request.index)
		const texts = sample?.texts ?? []

		return Promise.resolve({
			texts,
			styles: Uint32Array.from(texts, (_, i) => ((sample?.wraps?.[i] ?? 0) !== 0 ? WRAP : PLAIN)),
			wraps: Uint8Array.from(texts, (_, i) => sample?.wraps?.[i] ?? 0),
			indices: Uint32Array.from(texts, (_, i) => sample?.indices?.[i] ?? 0)
		})
	})
	const model = {
		session: { query },
		tiles: { peek: (key: number) => held.get(key) },
		style: (index: number) => STYLES[index] ?? STYLES[0],
		layout: () => ({ rows: { defaultSize: DEFAULT_ROW }, merges: [] }),
		merges: () => options.merges ?? [],
		axes: () => ({ cols: { size: () => (options.colWidth ?? 64) * scale }, scale })
	} as unknown as SheetGridModel

	return { model, query }
}

async function fit(model: SheetGridModel, axis: SheetAxis, indices: readonly number[]): Promise<number[]> {
	const fitted = await autofitSizes(model, SHEET, axis, indices, new TextMeasurer(new RecordingCanvas()), "sans-serif")

	return Array.from(fitted.sizes)
}

describe("autofitSizes", () => {
	it("gives NaN to an index with nothing sampled, on either axis", async () => {
		const { model } = fakeModel(new Map())

		expect(await fit(model, "cols", [0, 3])).toEqual([Number.NaN, Number.NaN])
		expect(await fit(model, "rows", [0, 3])).toEqual([Number.NaN, Number.NaN])
	})

	it("fits a column to its widest line and the cell padding, clamped to the widest column", async () => {
		const { model } = fakeModel(
			new Map([
				[0, { texts: ["ab", "abcd"] }],
				[1, { texts: ["ab\nabcdef"], wraps: [1] }],
				[2, { texts: ["x".repeat(400)] }]
			])
		)

		expect(await fit(model, "cols", [0, 1, 2])).toEqual([
			Math.ceil(measured(4)) + 2 * TEXT_PADDING + 2,
			Math.ceil(measured(6)) + 2 * TEXT_PADDING + 2,
			MAX_COL_WIDTH
		])
	})

	it("ignores the line breaks of a text that does not wrap when fitting a column", async () => {
		const { model } = fakeModel(new Map([[0, { texts: ["ab\ncd"] }]]))

		expect(await fit(model, "cols", [0])).toEqual([Math.ceil(measured(4)) + 2 * TEXT_PADDING + 2])
	})

	it("gives NaN to a row whose fit is no taller than the default, and counts an unheld wrapped text's lines", async () => {
		const { model } = fakeModel(
			new Map([
				[0, { texts: ["one line"] }],
				// The tile of row 5000 is not held: its own three lines, 18 px each, and 2 px.
				[5000, { texts: ["a\nb\nc"], wraps: [1] }]
			])
		)

		expect(await fit(model, "rows", [0, 5000])).toEqual([Number.NaN, 56])
	})

	it("wraps a held cell at its column's width at 100 % under a zoom", async () => {
		// 100 px at 100 %, drawn 200 px wide at 200 %: two lines at 100 px, one at 200 px.
		const text = "aaaa bbbb cccc dddd"
		const samples = new Map([[0, { texts: [text], wraps: [1], indices: [0] }]])
		const { model } = fakeModel(samples, { tiles: [heldTile(0, 0, text)], colWidth: 100, scale: 2 })

		expect(await fit(model, "rows", [0])).toEqual([2 * 18 + 2])
	})

	it("fits no row to a merged cell's wrapped text", async () => {
		const samples = new Map([[0, { texts: ["a\nb\nc"], wraps: [1], indices: [1] }]])
		const { model } = fakeModel(samples, { merges: [{ startRow: 0, startCol: 1, endRow: 1, endCol: 2 }] })

		expect(await fit(model, "rows", [0])).toEqual([Number.NaN])
	})

	it("measures at most the first MAX_FIT_INDICES indices", async () => {
		const { model, query } = fakeModel(new Map())
		const indices = Array.from({ length: MAX_FIT_INDICES + 100 }, (_, index) => index)
		const fitted = await autofitSizes(model, SHEET, "cols", indices, new TextMeasurer(new RecordingCanvas()), "sans-serif")

		expect(MAX_FIT_INDICES).toBe(1024)
		expect(fitted.indices.length).toBe(MAX_FIT_INDICES)
		expect(fitted.sizes.length).toBe(MAX_FIT_INDICES)
		expect(fitted.indices[MAX_FIT_INDICES - 1]).toBe(MAX_FIT_INDICES - 1)
		expect(query).toHaveBeenCalledTimes(MAX_FIT_INDICES)
	})
})

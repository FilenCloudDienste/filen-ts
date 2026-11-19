import { MAX_COL_WIDTH, MAX_ROW_HEIGHT, MIN_SIZE } from "../../core/sheet/sizes/sizes"
import { TILE_COLS, TILE_ROWS, tileKey, type SheetAxis, type SheetId, type SheetRange } from "../../core/sheet/protocol"
import { createGridAxis } from "./axis"
import type { SheetGridModel } from "./model"
import { TEXT_PADDING } from "./paint/cells"
import { textFont, type TextMeasurer } from "./paint/text"
import { LINE_HEIGHT, ROW_PADDING, wrappedCellHeight } from "./rowHeight"
import { entryOf, type GridTile } from "./tiles"

// Autofit: the session names each column's or row's longest texts with their styles (fitSample; the core has no
// fonts), and the grid measures them with the canvas it draws with, at 100 %. A wrapped text fits a row at its
// column's width when its cell is on screen (its tile held), measured as the fit after an edit measures it (its rich
// runs and indent: rowHeight.ts), else by its own line breaks. As there, a merged cell's wrapped text fits no row.

// Texts measured per index.
const FIT_SAMPLE = 32
// Indices one autofit measures (a select-all on a wide sheet fits the first ones).
export const MAX_FIT_INDICES = 1024

function clamp(axis: SheetAxis, px: number): number {
	return Math.round(Math.min(axis === "cols" ? MAX_COL_WIDTH : MAX_ROW_HEIGHT, Math.max(MIN_SIZE, px)))
}

// Pixel sizes at 100 % for `indices`, NaN where an index goes back to the default.
export async function autofitSizes(
	model: SheetGridModel,
	sheet: SheetId,
	axis: SheetAxis,
	indices: readonly number[],
	measurer: TextMeasurer,
	fallback: string
): Promise<{ readonly indices: Uint32Array; readonly sizes: Float32Array }> {
	const chosen = indices.slice(0, MAX_FIT_INDICES)
	const samples = await Promise.all(chosen.map(index => model.session.query("fitSample", { sheet, axis, index, limit: FIT_SAMPLE })))
	const base = model.style(0)
	const layout = model.layout(sheet)
	const defaultRow = layout?.rows.defaultSize ?? 20
	const merges = axis === "rows" && layout !== null ? model.merges(layout) : []
	const sizes = new Float32Array(chosen.length)

	chosen.forEach((index, k) => {
		const sample = samples[k]
		const rowMerges = merges.filter(merge => index >= merge.startRow && index <= merge.endRow)
		let largest = 0

		sample?.texts.forEach((text, i) => {
			const style = model.style(sample.styles[i] ?? 0)
			const font = textFont(style, base, fallback, 1)
			const wraps = (sample.wraps[i] ?? 0) !== 0

			if (axis === "cols") {
				const lines = wraps ? text.split(/\r?\n|\r/u) : [text.replace(/\r?\n|\r/gu, "")]

				for (const line of lines) largest = Math.max(largest, measurer.width(font.css, line))

				return
			}

			if (!wraps) {
				largest = Math.max(largest, Math.round(font.px * LINE_HEIGHT))

				return
			}

			const col = sample.indices[i] ?? 0

			if (merged(rowMerges, col)) return

			const held = heldCell(model, sheet, index, col)

			// Its lines only: the row's padding is added once below.
			const lines =
				held === null
					? text.split(/\r?\n|\r/u).length * Math.round(font.px * LINE_HEIGHT)
					: wrappedCellHeight(model, held.tile, held.entry, style, held.width, measurer, base, fallback) - ROW_PADDING

			largest = Math.max(largest, lines)
		})

		if (largest === 0) {
			sizes[k] = Number.NaN
		} else if (axis === "cols") {
			sizes[k] = clamp("cols", Math.ceil(largest) + 2 * TEXT_PADDING + 2)
		} else {
			const height = clamp("rows", largest + ROW_PADDING)

			sizes[k] = height <= defaultRow ? Number.NaN : height
		}
	})

	return { indices: Uint32Array.from(chosen), sizes }
}

function merged(merges: readonly SheetRange[], col: number): boolean {
	return merges.some(merge => col >= merge.startCol && col <= merge.endCol)
}

// A cell's entry in the tile held for it, with its column's width at 100 %; null when its tile is not held.
function heldCell(
	model: SheetGridModel,
	sheet: SheetId,
	row: number,
	col: number
): { readonly tile: GridTile; readonly entry: number; readonly width: number } | null {
	const layout = model.layout(sheet)
	const tile = model.tiles.peek(tileKey(sheet, Math.floor(row / TILE_ROWS), Math.floor(col / TILE_COLS)))

	if (layout === null || tile === undefined) return null

	const entry = entryOf(tile, row, col)

	if (entry < 0) return null

	const axes = model.axes(sheet)

	// The width as drawn (kept sizes and zoom included), back at 100 %.
	return { tile, entry, width: axes === null ? createGridAxis(layout.cols, col + 1, 1).size(col) : axes.cols.size(col) / axes.scale }
}

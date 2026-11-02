import { appendAll } from "../../../core/arrays"
import type { PrintPage } from "../../../core/sheet/print/paginate"
import type { SheetPrintSpan } from "../../../core/sheet/print/setup"
import { TILE_COLS, TILE_ROWS, type SheetTile } from "../../../core/sheet/protocol"
import type { GridView } from "../view"
import { pageView, type PrintedSheet } from "./printPage"

// A page with many cells, drawn in slices: bands of its rows, each from the tiles around it only, one after another
// with a turn between them (the print's SVG on the page's thread) and a cancellation check. A band's working memory
// (its tiles, its page model, the texts it keeps for the tagged PDF) is the band's, never the page's. Bands are cut
// between rows no merged cell crosses, so every block is drawn whole by one band.
//
// Before a slice is drawn the page's cells are counted (tiles fetched a few at a time and let go): a page past
// MAX_PAGE_CELLS is refused without drawing anything.

// Tiles a page draws from at once, unsliced, and asked for in one request: 32,768 cells at most.
export const SLICE_TILES = 16

// Whether a page's tiles are few enough to draw it as one piece.
export function smallPage(coordinates: readonly number[]): boolean {
	return coordinates.length <= 2 * SLICE_TILES
}

function within(span: SheetPrintSpan | null, index: number): boolean {
	return span !== null && index >= span.first && index <= span.last
}

function spanRange(spans: readonly (SheetPrintSpan | null)[], shift: number): number[] {
	const out = new Set<number>()

	for (const span of spans) if (span !== null) for (let k = span.first >>> shift; k <= span.last >>> shift; k++) out.add(k)

	return [...out].sort((a, b) => a - b)
}

// What a page holds: its cells (the title rows and columns repeated on it included), per row of its own, and the
// columns of every entry of the tiles read (where any text drawn on the page belongs).
export interface PageSurvey {
	readonly cells: number
	// By row of the page's own, from its first.
	readonly rowCells: Uint32Array
	readonly columns: ReadonlySet<number>
}

export type TileFetch = (coordinates: Uint32Array) => Promise<readonly SheetTile[]>

// Asks for tile rows' tiles over the page's columns (title columns included), SLICE_TILES at a time.
async function fetchRows(
	page: PrintPage,
	tileRows: readonly number[],
	fetch: TileFetch,
	between: () => Promise<void>,
	each: (tiles: readonly SheetTile[]) => boolean
): Promise<boolean> {
	const tileCols = spanRange([page.titleCols, page.cols], 5)
	const batch: number[] = []
	const flush = async (): Promise<boolean> => {
		if (batch.length === 0) return true

		const tiles = await fetch(Uint32Array.from(batch))

		batch.length = 0
		await between()

		return each(tiles)
	}

	for (const tileRow of tileRows) {
		for (const tileCol of tileCols) {
			batch.push(tileRow, tileCol)

			if (batch.length >= 2 * SLICE_TILES && !(await flush())) return false
		}
	}

	return flush()
}

// The page's cells counted, or null past `limit`: its tiles asked for a few at a time and let go.
export async function surveyPage(
	page: PrintPage,
	fetch: TileFetch,
	limit: number,
	between: () => Promise<void>
): Promise<PageSurvey | null> {
	const rowCells = new Uint32Array(page.rows.last - page.rows.first + 1)
	const columns = new Set<number>()
	let cells = 0
	const counted = await fetchRows(page, spanRange([page.titleRows, page.rows], 6), fetch, between, tiles => {
		for (const tile of tiles) {
			for (let entry = 0; entry < tile.count; entry++) {
				const position = tile.positions[entry] ?? 0
				const row = tile.tileRow * TILE_ROWS + (position >>> 5)
				const col = tile.tileCol * TILE_COLS + (position & 31)

				columns.add(col)

				if (!(within(page.rows, row) || within(page.titleRows, row)) || !(within(page.cols, col) || within(page.titleCols, col)))
					continue

				cells++

				if (within(page.rows, row)) rowCells[row - page.rows.first] = (rowCells[row - page.rows.first] ?? 0) + 1
			}
		}

		return cells <= limit
	})

	return counted ? { cells, rowCells, columns } : null
}

// The page's own rows in bands of about `size` cells, cut only between rows no merged cell over the page's columns
// crosses (`merges`: start row, start column, end row, end column).
export function planSlices(page: PrintPage, survey: PageSurvey, merges: Uint32Array, size: number): SheetPrintSpan[] {
	const { first, last } = page.rows
	// Per row, whether a block crosses from it to the next (a running sum of starts and ends).
	const crossing = new Int32Array(last - first + 2)

	for (let k = 0; k + 3 < merges.length; k += 4) {
		const top = merges[k] ?? 0
		const left = merges[k + 1] ?? 0
		const bottom = merges[k + 2] ?? 0
		const right = merges[k + 3] ?? 0
		const meets = (span: SheetPrintSpan | null): boolean => span !== null && left <= span.last && right >= span.first

		if (bottom <= top || bottom < first || top > last || !(meets(page.cols) || meets(page.titleCols))) continue

		const from = Math.max(top, first) - first
		const to = Math.min(bottom, last + 1) - first

		crossing[from] = (crossing[from] ?? 0) + 1
		crossing[to] = (crossing[to] ?? 0) - 1
	}

	const spans: SheetPrintSpan[] = []
	let start = first
	let cells = 0
	let open = 0

	for (let row = first; row <= last; row++) {
		open += crossing[row - first] ?? 0
		cells += survey.rowCells[row - first] ?? 0

		if (cells >= size && row < last && open === 0) {
			spans.push({ first: start, last: row })
			start = row + 1
			cells = 0
		}
	}

	spans.push({ first: start, last })

	return spans
}

// A slice of a page: its rows `span` (the title rows on the first only, above it as on the page).
export function slicePage(page: PrintPage, span: SheetPrintSpan, first: boolean): PrintPage {
	return { ...page, rows: span, titleRows: first ? page.titleRows : null }
}

// A slice's view, and where it starts in the page's (px at 100 %): the column letters on the first only.
export function sliceView(printed: PrintedSheet, page: PrintPage, slice: PrintPage, first: boolean): { view: GridView; top: number } {
	const view = pageView(printed, slice)

	if (first) return { view, top: 0 }

	const whole = pageView(printed, page)
	const rows = { ...view.rows, header: 0, view: view.rows.view - view.rows.header }
	const axis = printed.rows

	return {
		view: { ...view, rows, height: rows.view },
		top: whole.rows.header + whole.rows.frozenSize + axis.offset(slice.rows.first) - axis.offset(page.rows.first)
	}
}

// The tiles slices draw from, by tile row, each asked for once: a slice holds its rows' tiles and the rows beside
// them on the page (a border between two rows is the heavier of theirs), the first slice the title rows' too.
export class SliceTiles {
	private readonly held = new Map<number, readonly SheetTile[]>()
	private readonly page: PrintPage
	private readonly fetch: TileFetch
	private readonly between: () => Promise<void>

	constructor(page: PrintPage, fetch: TileFetch, between: () => Promise<void>) {
		this.page = page
		this.fetch = fetch
		this.between = between
	}

	async take(slice: PrintPage): Promise<SheetTile[]> {
		const { rows } = this.page
		const around = { first: Math.max(rows.first, slice.rows.first - 1), last: Math.min(rows.last, slice.rows.last + 1) }
		const wanted = spanRange([slice.titleRows, around], 6)
		const missing = wanted.filter(tileRow => !this.held.has(tileRow))
		const fetched = new Map<number, SheetTile[]>(missing.map(tileRow => [tileRow, []]))

		await fetchRows(this.page, missing, this.fetch, this.between, tiles => {
			for (const tile of tiles) fetched.get(tile.tileRow)?.push(tile)

			return true
		})

		for (const [tileRow, tiles] of fetched) this.held.set(tileRow, tiles)

		const out: SheetTile[] = []

		for (const tileRow of wanted) appendAll(out, this.held.get(tileRow) ?? [])

		return out
	}

	// Lets go of the tiles above a slice's last row: the next slice needs only that row of what it read.
	drop(slice: PrintPage): void {
		const keep = slice.rows.last >>> 6

		for (const tileRow of [...this.held.keys()]) if (tileRow < keep) this.held.delete(tileRow)
	}
}

import { spliceAll } from "../../arrays"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetRange } from "../../sheet/protocol"
import {
	CARRIED,
	CellKind,
	FormulaKind,
	NO_SPAN,
	sourceKey,
	type XlsxSourceCell,
	blockOrigin,
	RowFlag,
	SLOT_BLOCK,
	type XlsxFormulaTable,
	type XlsxRowBlock,
	type XlsxSheetStore,
	type XlsxSheetStrings
} from "./types"

// Rows and cells a block holds at most: small enough that replacing a block (a cell added or removed) copies
// little, large enough that a million-row sheet has few blocks.
export const BLOCK_ROWS = 1024
export const BLOCK_CELLS = 32_768

const PROPERTY_FLAGS =
	RowFlag.HIDDEN |
	RowFlag.CUSTOM_HEIGHT |
	RowFlag.CUSTOM_FORMAT |
	RowFlag.COLLAPSED |
	RowFlag.THICK_TOP |
	RowFlag.THICK_BOTTOM |
	RowFlag.OUTLINE_MASK

export class RowBlock implements XlsxRowBlock {
	firstRow: number
	readonly sourceFirstRow: number
	readonly rowCount: number
	readonly rows: Uint32Array
	readonly rowStarts: Uint32Array
	readonly rowSpans: Uint32Array
	readonly rowFlags: Uint16Array
	readonly rowHeights: Float64Array
	readonly rowStyles: Int32Array
	readonly cols: Uint16Array
	readonly kinds: Uint8Array
	readonly values: Float64Array
	readonly styles: Uint32Array
	readonly formulas: Int32Array | null
	readonly origins: Uint32Array | null
	// One past the highest column of a cell in the block.
	colExtent = 0

	constructor(
		firstRow: number,
		sourceFirstRow: number,
		rows: Uint32Array,
		rowStarts: Uint32Array,
		rowSpans: Uint32Array,
		rowFlags: Uint16Array,
		rowHeights: Float64Array,
		rowStyles: Int32Array,
		cols: Uint16Array,
		kinds: Uint8Array,
		values: Float64Array,
		styles: Uint32Array,
		formulas: Int32Array | null,
		origins: Uint32Array | null
	) {
		this.firstRow = firstRow
		this.sourceFirstRow = sourceFirstRow
		this.rowCount = rows.length
		this.rows = rows
		this.rowStarts = rowStarts
		this.rowSpans = rowSpans
		this.rowFlags = rowFlags
		this.rowHeights = rowHeights
		this.rowStyles = rowStyles
		this.cols = cols
		this.kinds = kinds
		this.values = values
		this.styles = styles
		this.formulas = formulas
		this.origins = origins

		this.measureCols()
	}

	measureCols(): void {
		let colExtent = 0

		for (let i = 0; i < this.rowCount; i++) {
			const end = this.rowStarts[i + 1] ?? 0

			if (end > (this.rowStarts[i] ?? 0)) colExtent = Math.max(colExtent, (this.cols[end - 1] ?? 0) + 1)
		}

		this.colExtent = colExtent
	}

	get lastRow(): number {
		return this.firstRow + (this.rows[this.rowCount - 1] ?? 0)
	}

	get cellCount(): number {
		return this.cols.length
	}

	bytes(): number {
		return (
			this.rows.byteLength +
			this.rowStarts.byteLength +
			this.rowSpans.byteLength +
			this.rowFlags.byteLength +
			this.rowHeights.byteLength +
			this.rowStyles.byteLength +
			this.cols.byteLength +
			this.kinds.byteLength +
			this.values.byteLength +
			this.styles.byteLength +
			(this.formulas?.byteLength ?? 0) +
			(this.origins?.byteLength ?? 0) +
			96
		)
	}

	// Index of `row` (absolute) in this block, or -1.
	rowIndex(row: number): number {
		const relative = row - this.firstRow
		let low = 0
		let high = this.rowCount - 1

		while (low <= high) {
			const mid = (low + high) >>> 1
			const at = this.rows[mid] ?? 0

			if (at === relative) return mid
			if (at < relative) low = mid + 1
			else high = mid - 1
		}

		return -1
	}

	// Index into the cell arrays of `col` in row index `index`, or -1.
	cellIndex(index: number, col: number): number {
		let low = this.rowStarts[index] ?? 0
		let high = (this.rowStarts[index + 1] ?? 0) - 1

		while (low <= high) {
			const mid = (low + high) >>> 1
			const at = this.cols[mid] ?? 0

			if (at === col) return mid
			if (at < col) low = mid + 1
			else high = mid - 1
		}

		return -1
	}
}

// One row as a block rebuild sees it.
interface RowRecord {
	row: number
	spanStart: number
	spanEnd: number
	flags: number
	height: number
	style: number
	cols: number[]
	kinds: number[]
	values: number[]
	styles: number[]
	formulas: number[]
	origins: number[]
}

// One cell as setCells writes it: setCell's arguments.
export interface CellWrite {
	readonly row: number
	readonly col: number
	readonly kind: CellKind
	readonly value: number
	readonly style: number
	readonly formula: number
	readonly origin: number
}

// A row's own properties, as setRows takes them.
export interface RowProperties {
	readonly row: number
	readonly height: number
	readonly style: number
	readonly flags: number
}

function rowRecords(block: RowBlock): RowRecord[] {
	const out: RowRecord[] = []

	for (let i = 0; i < block.rowCount; i++) {
		const from = block.rowStarts[i] ?? 0
		const to = block.rowStarts[i + 1] ?? 0
		const record: RowRecord = {
			row: block.firstRow + (block.rows[i] ?? 0),
			spanStart: block.rowSpans[i * 2] ?? NO_SPAN,
			spanEnd: block.rowSpans[i * 2 + 1] ?? NO_SPAN,
			flags: block.rowFlags[i] ?? 0,
			height: block.rowHeights[i] ?? Number.NaN,
			style: block.rowStyles[i] ?? -1,
			cols: Array.from(block.cols.subarray(from, to)),
			kinds: Array.from(block.kinds.subarray(from, to)),
			values: Array.from(block.values.subarray(from, to)),
			styles: Array.from(block.styles.subarray(from, to)),
			formulas: block.formulas === null ? new Array<number>(to - from).fill(-1) : Array.from(block.formulas.subarray(from, to)),
			origins: Array.from({ length: to - from }, (_, k) => blockOrigin(block, i, from + k))
		}

		out.push(record)
	}

	return out
}

// A block from row records (ascending, unique rows). `firstRow` is the block's base; rows are relative to it.
function blockOf(records: readonly RowRecord[], firstRow: number, sourceFirstRow: number): RowBlock {
	let cells = 0
	let hasFormulas = false
	// Whether some cell is not the source cell at its position (origins are then held).
	let moved = false

	for (const record of records) {
		cells += record.cols.length

		if (!hasFormulas) for (const formula of record.formulas) if (formula >= 0) hasFormulas = true
		if (!moved) for (let k = 0; k < record.origins.length; k++) if (record.origins[k] !== k + 1) moved = true
	}

	const rowCount = records.length
	const rows = new Uint32Array(rowCount)
	const rowStarts = new Uint32Array(rowCount + 1)
	const rowSpans = new Uint32Array(rowCount * 2)
	const rowFlags = new Uint16Array(rowCount)
	const rowHeights = new Float64Array(rowCount)
	const rowStyles = new Int32Array(rowCount)
	const cols = new Uint16Array(cells)
	const kinds = new Uint8Array(cells)
	const values = new Float64Array(cells)
	const styles = new Uint32Array(cells)
	const formulas = hasFormulas ? new Int32Array(cells) : null
	const origins = moved ? new Uint32Array(cells) : null
	let at = 0

	records.forEach((record, i) => {
		rows[i] = record.row - firstRow
		rowStarts[i] = at
		rowSpans[i * 2] = record.spanStart
		rowSpans[i * 2 + 1] = record.spanEnd
		rowFlags[i] = record.flags
		rowHeights[i] = record.height
		rowStyles[i] = record.style

		for (let k = 0; k < record.cols.length; k++) {
			cols[at] = record.cols[k] ?? 0
			kinds[at] = record.kinds[k] ?? 0
			values[at] = record.values[k] ?? 0
			styles[at] = record.styles[k] ?? 0

			if (formulas !== null) formulas[at] = record.formulas[k] ?? -1
			if (origins !== null) origins[at] = record.origins[k] ?? 0

			at++
		}
	})

	rowStarts[rowCount] = at

	return new RowBlock(
		firstRow,
		sourceFirstRow,
		rows,
		rowStarts,
		rowSpans,
		rowFlags,
		rowHeights,
		rowStyles,
		cols,
		kinds,
		values,
		styles,
		formulas,
		origins
	)
}

// What a row the store does not hold has of its own (an OpenDocument sheet's runs of hidden or resized rows): a row
// the store adds there starts with it.
export type RowBase = (row: number) => { readonly heightPt: number; readonly flags: number } | undefined

// Row flags a row takes from its base.
// A row whose cells only moved along it (columns inserted or deleted): SHIFTED as well where no edit marked it
// before; an edit since takes SHIFTED off.
function shiftedFlags(flags: number): number {
	return (flags & RowFlag.DIRTY) === 0 ? flags | RowFlag.DIRTY | RowFlag.SHIFTED : flags | RowFlag.DIRTY
}

const BASE_FLAGS = RowFlag.HIDDEN | RowFlag.CUSTOM_HEIGHT | RowFlag.COLLAPSED | RowFlag.OUTLINE_MASK

function emptyRecord(row: number, base?: RowBase): RowRecord {
	const inherited = base?.(row)

	return {
		row,
		spanStart: NO_SPAN,
		spanEnd: NO_SPAN,
		flags: RowFlag.NEW | RowFlag.DIRTY | ((inherited?.flags ?? 0) & BASE_FLAGS),
		height: inherited?.heightPt ?? Number.NaN,
		style: -1,
		cols: [],
		kinds: [],
		values: [],
		styles: [],
		formulas: [],
		origins: []
	}
}

// A record with no cells and no properties of its own, which is not from the source: it need not exist.
function isVacant(record: RowRecord): boolean {
	return (
		record.cols.length === 0 &&
		(record.flags & RowFlag.NEW) !== 0 &&
		(record.flags & PROPERTY_FLAGS) === 0 &&
		Number.isNaN(record.height) &&
		record.style < 0
	)
}

// A block (or none) with a batch's cells written, as one setCell per cell leaves it, rebuilt over typed arrays
// (no object per row): the rows in order, each row's cells merged with the batch's, rows a write adds new and dirty,
// rows that end up vacant gone. Rows before the block go into blocks of their own; the rest are cut where a block
// would outgrow its limits, each based at its first row with the source shift of the block it came from (edit).
function writtenBlocks(block: RowBlock | undefined, writes: readonly CellWrite[], base?: RowBase): RowBlock[] {
	const count = writes.length
	const order = sortedWrites(writes)
	const rowCount = block?.rowCount ?? 0
	const maxRows = rowCount + count
	const maxCells = (block?.cellCount ?? 0) + count
	const baseRow = block?.firstRow ?? writes[order[0] ?? 0]?.row ?? 0
	const shift = block === undefined || block.sourceFirstRow < 0 ? Number.NaN : block.firstRow - block.sourceFirstRow
	const rows = new Uint32Array(maxRows)
	const rowStarts = new Uint32Array(maxRows + 1)
	const rowSpans = new Uint32Array(maxRows * 2)
	const rowFlags = new Uint16Array(maxRows)
	const rowHeights = new Float64Array(maxRows)
	const rowStyles = new Int32Array(maxRows)
	const cols = new Uint16Array(maxCells)
	const kinds = new Uint8Array(maxCells)
	const values = new Float64Array(maxCells)
	const styles = new Uint32Array(maxCells)
	const formulas = new Int32Array(maxCells)
	const origins = new Uint32Array(maxCells)
	let outRows = 0
	let outCells = 0
	let i = 0
	let w = 0

	while (i < rowCount || w < count) {
		const existing = block !== undefined && i < rowCount ? block.firstRow + (block.rows[i] ?? 0) : Number.POSITIVE_INFINITY
		const written = w < count ? (writes[order[w] ?? 0]?.row ?? 0) : Number.POSITIVE_INFINITY
		const row = Math.min(existing, written)
		const own = block !== undefined && existing === row ? i++ : -1
		const rowStart = outCells
		let present = own >= 0
		let flags = 0

		if (block !== undefined && own >= 0) {
			flags = block.rowFlags[own] ?? 0
			rowSpans[outRows * 2] = block.rowSpans[own * 2] ?? NO_SPAN
			rowSpans[outRows * 2 + 1] = block.rowSpans[own * 2 + 1] ?? NO_SPAN
			rowHeights[outRows] = block.rowHeights[own] ?? Number.NaN
			rowStyles[outRows] = block.rowStyles[own] ?? -1
		} else {
			rowSpans[outRows * 2] = NO_SPAN
			rowSpans[outRows * 2 + 1] = NO_SPAN
			rowHeights[outRows] = base?.(row)?.heightPt ?? Number.NaN
			rowStyles[outRows] = -1
		}

		let k = block !== undefined && own >= 0 ? (block.rowStarts[own] ?? 0) : 0
		const kEnd = block !== undefined && own >= 0 ? (block.rowStarts[own + 1] ?? 0) : 0

		// The row's writes, by column: the row's own cells before each written column kept as they are.
		while (w < count && (writes[order[w] ?? 0]?.row ?? 0) === row) {
			const col = writes[order[w] ?? 0]?.col ?? 0

			while (block !== undefined && k < kEnd && (block.cols[k] ?? 0) < col) {
				copyCell(block, own, k++, outCells++, cols, kinds, values, styles, formulas, origins)
			}

			let exists = block !== undefined && k < kEnd && block.cols[k] === col

			if (exists && block !== undefined) copyCell(block, own, k++, outCells, cols, kinds, values, styles, formulas, origins)

			for (; w < count && (writes[order[w] ?? 0]?.row ?? 0) === row && (writes[order[w] ?? 0]?.col ?? 0) === col; w++) {
				const cell = writes[order[w] ?? 0] as CellWrite
				const remove = cell.origin < 0 && cell.kind === CellKind.EMPTY && cell.style === 0 && cell.formula < 0

				// Removing a cell that is not there changes nothing (as setCell).
				if (remove) {
					if (exists) flags = (flags | RowFlag.DIRTY) & ~RowFlag.SHIFTED

					exists = false

					continue
				}

				if (!present) {
					present = true
					flags = RowFlag.NEW | ((base?.(row)?.flags ?? 0) & BASE_FLAGS)
				}

				flags = (flags | RowFlag.DIRTY) & ~RowFlag.SHIFTED
				cols[outCells] = col
				kinds[outCells] = cell.kind
				values[outCells] = cell.value
				styles[outCells] = cell.style
				formulas[outCells] = cell.formula

				if (!exists || cell.origin >= 0) origins[outCells] = Math.max(0, cell.origin)

				exists = true
			}

			if (exists) outCells++
		}

		while (block !== undefined && k < kEnd) copyCell(block, own, k++, outCells++, cols, kinds, values, styles, formulas, origins)

		const vacant =
			outCells === rowStart &&
			(flags & RowFlag.NEW) !== 0 &&
			(flags & PROPERTY_FLAGS) === 0 &&
			Number.isNaN(rowHeights[outRows] ?? 0) &&
			(rowStyles[outRows] ?? -1) < 0

		if (!present || vacant) {
			outCells = rowStart

			continue
		}

		rows[outRows] = row
		rowFlags[outRows] = flags
		rowStarts[outRows] = rowStart
		outRows++
	}

	rowStarts[outRows] = outCells

	const out: RowBlock[] = []
	let start = 0

	while (start < outRows) {
		const before = (rows[start] ?? 0) < baseRow
		let end = start
		let cells = 0

		while (end < outRows && end - start < BLOCK_ROWS && (rows[end] ?? 0) < baseRow === before) {
			const size = (rowStarts[end + 1] ?? 0) - (rowStarts[end] ?? 0)

			if (end > start && cells + size > BLOCK_CELLS) break

			cells += size
			end++
		}

		const head = rows[start] ?? 0
		const from = rowStarts[start] ?? 0
		const to = rowStarts[end] ?? 0
		const sliceRows = rows.slice(start, end)
		const sliceStarts = rowStarts.slice(start, end + 1)
		let hasFormulas = false
		let moved = false

		for (let r = 0; r < sliceRows.length; r++) sliceRows[r] = (sliceRows[r] ?? 0) - head
		for (let r = 0; r < sliceStarts.length; r++) sliceStarts[r] = (sliceStarts[r] ?? 0) - from
		for (let c = from; c < to && !hasFormulas; c++) hasFormulas = (formulas[c] ?? -1) >= 0

		for (let r = start; r < end && !moved; r++) {
			const first = rowStarts[r] ?? 0

			for (let c = first; c < (rowStarts[r + 1] ?? 0); c++) {
				if (origins[c] !== c - first + 1) {
					moved = true

					break
				}
			}
		}

		out.push(
			new RowBlock(
				head,
				before || Number.isNaN(shift) ? -1 : head - shift,
				sliceRows,
				sliceStarts,
				rowSpans.slice(start * 2, end * 2),
				rowFlags.slice(start, end),
				rowHeights.slice(start, end),
				rowStyles.slice(start, end),
				cols.slice(from, to),
				kinds.slice(from, to),
				values.slice(from, to),
				styles.slice(from, to),
				hasFormulas ? formulas.slice(from, to) : null,
				moved ? origins.slice(from, to) : null
			)
		)
		start = end
	}

	return out
}

// The order a batch is written in: by row, then column, then as given (a later write to a cell wins).
function sortedWrites(writes: readonly CellWrite[]): Uint32Array {
	const order = new Uint32Array(writes.length)
	let sorted = true

	for (let k = 0; k < writes.length; k++) {
		order[k] = k

		if (k > 0 && sorted) {
			const a = writes[k - 1] as CellWrite
			const b = writes[k] as CellWrite

			sorted = a.row < b.row || (a.row === b.row && a.col <= b.col)
		}
	}

	if (sorted) return order

	return order.sort((a, b) => {
		const x = writes[a] as CellWrite
		const y = writes[b] as CellWrite

		return x.row - y.row || x.col - y.col || a - b
	})
}

function copyCell(
	block: RowBlock,
	index: number,
	k: number,
	at: number,
	cols: Uint16Array,
	kinds: Uint8Array,
	values: Float64Array,
	styles: Uint32Array,
	formulas: Int32Array,
	origins: Uint32Array
): void {
	cols[at] = block.cols[k] ?? 0
	kinds[at] = block.kinds[k] ?? 0
	values[at] = block.values[k] ?? 0
	styles[at] = block.styles[k] ?? 0
	formulas[at] = block.formulas?.[k] ?? -1
	origins[at] = blockOrigin(block, index, k)
}

export class SheetStore implements XlsxSheetStore {
	blocks: RowBlock[]
	readonly strings: XlsxSheetStrings
	readonly formulas: XlsxFormulaTable
	cellCount: number
	rowExtent: number
	colExtent: number
	// Increases with every write.
	version = 0
	// Blocks undo snapshots hold (edit/history.ts StoreSnapshot): an in-place write copies one first.
	readonly held = new WeakSet<RowBlock>()
	// What rows the store does not hold have of their own, for one it adds (none for a SpreadsheetML sheet).
	rowBase: RowBase | undefined = undefined

	// Source cells holding markup the model does not (sourceKey), as the reader found them.
	private readonly marked: ReadonlySet<number>
	// Source cells a paste carried elsewhere (CARRIED + index), and their codes by sourceKey.
	private readonly carried: XlsxSourceCell[] = []
	private readonly carriedCodes = new Map<string, number>()

	constructor(blocks: RowBlock[], strings: XlsxSheetStrings, formulas: XlsxFormulaTable, marked: ReadonlySet<number> = new Set()) {
		this.blocks = blocks
		this.strings = strings
		this.formulas = formulas
		this.marked = marked
		this.cellCount = 0
		this.rowExtent = 0
		this.colExtent = 0
		this.measure()
	}

	private measure(): void {
		let cells = 0
		let rows = 0
		let cols = 0

		for (const block of this.blocks) {
			cells += block.cellCount
			cols = Math.max(cols, block.colExtent)

			if (block.rowCount > 0) rows = Math.max(rows, block.lastRow + 1)
		}

		this.cellCount = cells
		this.rowExtent = rows
		this.colExtent = cols
	}

	// The index of the last block whose firstRow is at or before `row`, or -1.
	blockOf(row: number): number {
		let low = 0
		let high = this.blocks.length - 1
		let found = -1

		while (low <= high) {
			const mid = (low + high) >>> 1

			if ((this.blocks[mid]?.firstRow ?? 0) <= row) {
				found = mid
				low = mid + 1
			} else {
				high = mid - 1
			}
		}

		return found
	}

	locate(row: number, col: number): number {
		const b = this.blockOf(row)
		const block = this.blocks[b]

		if (block === undefined) return -1

		const index = block.rowIndex(row)

		if (index < 0) return -1

		const cell = block.cellIndex(index, col)

		return cell < 0 ? -1 : b * SLOT_BLOCK + cell
	}

	block(slot: number): RowBlock | undefined {
		return this.blocks[Math.floor(slot / SLOT_BLOCK)]
	}

	kind(slot: number): CellKind {
		return (this.block(slot)?.kinds[slot % SLOT_BLOCK] ?? 0) as CellKind
	}

	value(slot: number): number {
		return this.block(slot)?.values[slot % SLOT_BLOCK] ?? 0
	}

	style(slot: number): number {
		return this.block(slot)?.styles[slot % SLOT_BLOCK] ?? 0
	}

	formula(slot: number): number {
		return this.block(slot)?.formulas?.[slot % SLOT_BLOCK] ?? -1
	}

	// Visits the cells of `range` in row-major order.
	forEachCell(range: SheetRange, visit: (row: number, col: number, slot: number) => void): void {
		for (let b = Math.max(0, this.blockOf(range.startRow)); b < this.blocks.length; b++) {
			const block = this.blocks[b]

			if (block === undefined || block.firstRow > range.endRow) break

			for (let i = 0; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)

				if (row < range.startRow) continue
				if (row > range.endRow) break

				const end = block.rowStarts[i + 1] ?? 0

				for (let k = block.rowStarts[i] ?? 0; k < end; k++) {
					const col = block.cols[k] ?? 0

					if (col < range.startCol) continue
					if (col > range.endCol) break

					visit(row, col, b * SLOT_BLOCK + k)
				}
			}
		}
	}

	// The source cell a slot is (blockOrigin), 0 for none or no slot.
	origin(slot: number): number {
		const block = this.block(slot)

		if (block === undefined) return 0

		const k = slot % SLOT_BLOCK

		return block.origins !== null ? (block.origins[k] ?? 0) : blockOrigin(block, rowOfCell(block, k), k)
	}

	// The source cell a slot is, or carries (a paste of it), null for none. `part`: this sheet's part.
	sourceCell(slot: number, part: string): XlsxSourceCell | null {
		const block = this.block(slot)

		if (block === undefined) return null

		const k = slot % SLOT_BLOCK
		const index = rowOfCell(block, k)
		const origin = blockOrigin(block, index, k)

		if (origin >= CARRIED) return this.carried[origin - CARRIED] ?? null

		const spanStart = block.rowSpans[index * 2] ?? NO_SPAN

		if (origin === 0 || spanStart === NO_SPAN || ((block.rowFlags[index] ?? 0) & RowFlag.NEW) !== 0) return null

		return { part, spanStart, spanEnd: block.rowSpans[index * 2 + 1] ?? NO_SPAN, ordinal: origin }
	}

	// Whether a slot's source cell holds markup the model does not (a picture in the cell, rich runs...): what a
	// copy carries. No cost on a sheet without such cells.
	carriesMarkup(slot: number): boolean {
		const origin = this.origin(slot)

		if (origin >= CARRIED) return true
		if (this.marked.size === 0) return false

		const cell = this.sourceCell(slot, "")

		return cell !== null && this.marked.has(sourceKey(cell.spanStart, cell.ordinal))
	}

	// The origin a cell pasted from `cell` takes (one code per source cell): the writer keeps that cell's markup.
	carry(cell: XlsxSourceCell): number {
		const key = `${cell.part}\n${cell.spanStart}\n${cell.ordinal}`
		let code = this.carriedCodes.get(key)

		if (code === undefined) {
			code = CARRIED + this.carried.length
			this.carried.push(cell)
			this.carriedCodes.set(key, code)
		}

		return code
	}

	carriedCell(origin: number): XlsxSourceCell | undefined {
		return origin >= CARRIED ? this.carried[origin - CARRIED] : undefined
	}

	carriedParts(): ReadonlySet<string> {
		return new Set(this.carried.map(cell => cell.part))
	}

	setCell(row: number, col: number, kind: CellKind, value: number, style: number, formula: number, origin = -1): void {
		this.version++

		const remove = origin < 0 && kind === CellKind.EMPTY && style === 0 && formula < 0
		const b = this.blockOf(row)
		const block = this.blocks[b]
		const index = block === undefined ? -1 : block.rowIndex(row)

		if (block !== undefined && index >= 0) {
			const cell = block.cellIndex(index, col)

			if (cell >= 0 && !remove && (formula < 0 || block.formulas !== null)) {
				// A block an undo snapshot holds is never written: the cell goes into a copy of it.
				const target = this.held.has(block) ? (this.blocks[b] = copyBlock(block)) : block

				target.kinds[cell] = kind
				target.values[cell] = value
				target.styles[cell] = style

				if (target.formulas !== null) target.formulas[cell] = formula

				target.rowFlags[index] = ((target.rowFlags[index] ?? 0) | RowFlag.DIRTY) & ~RowFlag.SHIFTED

				if (origin >= 0 && blockOrigin(target, index, cell) !== origin) this.blocks[b] = withOrigin(target, cell, origin)

				return
			}

			if (cell < 0 && remove) return

			// One cell added, removed or given a formula column: the block's arrays copied once, no records.
			const vacates = remove && (block.rowStarts[index + 1] ?? 0) - (block.rowStarts[index] ?? 0) === 1 && isNewBare(block, index)

			if (!vacates && block.cellCount < BLOCK_CELLS * 2) {
				const at = cell >= 0 ? cell : insertionPoint(block, index, col)

				const spliced = spliceCell(
					block,
					index,
					at,
					cell < 0 ? 1 : remove ? -1 : 0,
					col,
					kind,
					value,
					style,
					formula,
					Math.max(0, origin)
				)

				this.blocks[b] = origin >= 0 && blockOrigin(spliced, index, at) !== origin ? withOrigin(spliced, at, origin) : spliced
				this.measure()

				return
			}
		} else if (remove) {
			return
		} else if (
			block !== undefined &&
			row > block.firstRow &&
			block.rowCount < BLOCK_ROWS &&
			(this.blocks[b + 1]?.firstRow ?? Infinity) > row
		) {
			// A new row inside or just after the block: the row arrays copied once, then the cell as above.
			this.blocks[b] = spliceRow(block, row, this.rowBase)
			this.setCell(row, col, kind, value, style, formula, origin)

			return
		}

		this.edit(row, records => {
			let record = records.find(candidate => candidate.row === row)

			if (record === undefined) {
				record = emptyRecord(row, this.rowBase)
				records.push(record)
				records.sort((a, z) => a.row - z.row)
			}

			record.flags = (record.flags | RowFlag.DIRTY) & ~RowFlag.SHIFTED

			let at = 0

			while (at < record.cols.length && (record.cols[at] ?? 0) < col) at++

			const exists = record.cols[at] === col

			if (remove) {
				if (exists) {
					record.cols.splice(at, 1)
					record.kinds.splice(at, 1)
					record.values.splice(at, 1)
					record.styles.splice(at, 1)
					record.formulas.splice(at, 1)
					record.origins.splice(at, 1)
				}
			} else if (exists) {
				record.kinds[at] = kind
				record.values[at] = value
				record.styles[at] = style
				record.formulas[at] = formula

				if (origin >= 0) record.origins[at] = origin
			} else {
				record.cols.splice(at, 0, col)
				record.kinds.splice(at, 0, kind)
				record.values.splice(at, 0, value)
				record.styles.splice(at, 0, style)
				record.formulas.splice(at, 0, formula)
				record.origins.splice(at, 0, Math.max(0, origin))
			}
		})
	}

	setRow(row: number, height: number, style: number, flags: number): void {
		this.setRows([{ row, height, style, flags }])
	}

	// setCell for many cells, each named once: a block whose cells all stay where they are is written in place, any
	// other block they fall in is rebuilt once (setCell copies a block per cell added or removed).
	setCells(cells: readonly CellWrite[]): void {
		if (cells.length === 0) return

		const groups = new Map<number, CellWrite[]>()

		for (const cell of cells) {
			const index = Math.max(0, this.blockOf(cell.row))
			const group = groups.get(index)

			if (group === undefined) groups.set(index, [cell])
			else group.push(cell)
		}

		// Last block first: rebuilding a block moves only the blocks after it.
		for (const index of [...groups.keys()].sort((a, b) => b - a)) {
			const group = groups.get(index) ?? []
			const block = this.blocks[index]

			if (block !== undefined && this.writeInPlace(index, block, group)) continue

			this.version++
			spliceAll(this.blocks, index, block === undefined ? 0 : 1, writtenBlocks(block, group, this.rowBase))
			this.measure()
		}
	}

	// Writes a batch's cells of one block where they are, as setCell would one by one, when every one of them is
	// there to write (none added or removed, no formula column wanted): the block is copied at most once (when an undo
	// snapshot holds it, or the batch changes origins), not once per cell. False, writing nothing, otherwise.
	private writeInPlace(b: number, block: RowBlock, cells: readonly CellWrite[]): boolean {
		const rows = new Int32Array(cells.length)
		const slots = new Int32Array(cells.length)
		let origins = false

		for (let i = 0; i < cells.length; i++) {
			const cell = cells[i] as CellWrite
			const index = block.rowIndex(cell.row)
			const k = index < 0 ? -1 : block.cellIndex(index, cell.col)
			const remove = cell.origin < 0 && cell.kind === CellKind.EMPTY && cell.style === 0 && cell.formula < 0

			if (k < 0 || remove || (cell.formula >= 0 && block.formulas === null)) return false

			rows[i] = index
			slots[i] = k
			origins ||= cell.origin >= 0 && blockOrigin(block, index, k) !== cell.origin
		}

		let target = this.held.has(block) ? copyBlock(block) : block

		if (origins) {
			const next = target.origins?.slice() ?? positionalOrigins(target)

			for (let i = 0; i < cells.length; i++) {
				const origin = (cells[i] as CellWrite).origin

				if (origin >= 0) next[slots[i] ?? 0] = origin
			}

			target = withOriginArray(target, next)
		}

		for (let i = 0; i < cells.length; i++) {
			const cell = cells[i] as CellWrite
			const k = slots[i] ?? 0
			const index = rows[i] ?? 0

			target.kinds[k] = cell.kind
			target.values[k] = cell.value
			target.styles[k] = cell.style

			if (target.formulas !== null) target.formulas[k] = cell.formula

			target.rowFlags[index] = ((target.rowFlags[index] ?? 0) | RowFlag.DIRTY) & ~RowFlag.SHIFTED
		}

		this.blocks[b] = target
		this.version++

		return true
	}

	// setRow for many rows: each block they fall in is rebuilt once.
	setRows(rows: readonly RowProperties[]): void {
		if (rows.length === 0) return

		this.version++

		const groups = new Map<number, RowProperties[]>()

		for (const entry of rows) {
			const index = Math.max(0, this.blockOf(entry.row))
			const group = groups.get(index)

			if (group === undefined) groups.set(index, [entry])
			else group.push(entry)
		}

		// Last block first: rebuilding a block moves only the blocks after it.
		for (const index of [...groups.keys()].sort((a, b) => b - a)) {
			const group = groups.get(index) ?? []

			this.edit(group[0]?.row ?? 0, records => {
				const byRow = new Map(records.map(record => [record.row, record]))
				let added = false

				for (const { row, height, style, flags } of group) {
					let record = byRow.get(row)

					if (record === undefined) {
						record = emptyRecord(row)
						records.push(record)
						byRow.set(row, record)
						added = true
					}

					record.height = height
					record.style = style
					record.flags = (record.flags & (RowFlag.NEW | RowFlag.DIRTY)) | (flags & PROPERTY_FLAGS) | RowFlag.DIRTY
				}

				if (added) records.sort((a, z) => a.row - z.row)
			})
		}
	}

	// Rebuilds the block holding `row` (the one before it when none does) through `change`, which edits its row
	// records in place. Rows before the block go into new blocks of their own; the rest are cut where a block
	// would outgrow its limits, each block based at its first row (rows[0] is always 0) with the source shift
	// of the block it came from.
	private edit(row: number, change: (records: RowRecord[]) => void): void {
		const index = Math.max(0, this.blockOf(row))
		const block = this.blocks[index]
		const records = block === undefined ? [] : rowRecords(block)
		const baseRow = block?.firstRow ?? row
		// firstRow - sourceFirstRow: how far the block's source rows moved.
		const shift = block === undefined || block.sourceFirstRow < 0 ? Number.NaN : block.firstRow - block.sourceFirstRow

		change(records)

		const kept = records.filter(record => !isVacant(record))
		const rebuilt: RowBlock[] = []
		let start = 0

		while (start < kept.length) {
			const before = (kept[start]?.row ?? 0) < baseRow
			let end = start
			let cells = 0

			while (
				end < kept.length &&
				end - start < BLOCK_ROWS &&
				(kept[end]?.row ?? 0) < baseRow === before &&
				(end === start || cells + (kept[end]?.cols.length ?? 0) <= BLOCK_CELLS)
			) {
				cells += kept[end]?.cols.length ?? 0
				end++
			}

			const slice = kept.slice(start, end)
			const head = slice[0]?.row ?? 0

			rebuilt.push(blockOf(slice, head, before || Number.isNaN(shift) ? -1 : head - shift))
			start = end
		}

		spliceAll(this.blocks, index, block === undefined ? 0 : 1, rebuilt)
		this.measure()
	}

	insertRows(at: number, count: number): void {
		if (count <= 0) return

		this.version++
		this.splitAt(at)

		for (const block of this.blocks) {
			if (block.firstRow >= at) block.firstRow += count
		}

		this.dropPast(SHEET_MAX_ROWS)
		this.measure()
	}

	deleteRows(at: number, count: number): void {
		if (count <= 0) return

		this.version++
		this.splitAt(at)
		this.splitAt(at + count)
		this.blocks = this.blocks.filter(block => block.firstRow < at || block.firstRow >= at + count)

		for (const block of this.blocks) {
			if (block.firstRow >= at + count) block.firstRow -= count
		}

		this.measure()
	}

	// Splits the block holding rows on both sides of `row`, so that a block starts exactly at its first row
	// at or after `row`. Rows keep their positions relative to their block's base.
	private splitAt(row: number): void {
		const b = this.blockOf(row)
		const block = this.blocks[b]

		if (block === undefined || block.firstRow + (block.rows[0] ?? 0) >= row) return

		let index = 0

		while (index < block.rowCount && block.firstRow + (block.rows[index] ?? 0) < row) index++

		if (index === block.rowCount) return

		this.blocks.splice(b, 1, sliceBlock(block, 0, index), sliceBlock(block, index, block.rowCount))
	}

	// Drops rows at and past `limit` (moved off the grid).
	private dropPast(limit: number): void {
		this.splitAt(limit)
		this.blocks = this.blocks.filter(block => block.firstRow + (block.rows[0] ?? 0) < limit)
	}

	insertCols(at: number, count: number): void {
		if (count <= 0) return

		this.shiftCols(at, count)
	}

	deleteCols(at: number, count: number): void {
		if (count <= 0) return

		this.shiftCols(at, -count)
	}

	private shiftCols(at: number, delta: number): void {
		this.version++

		const deleteEnd = delta < 0 ? at - delta : at

		for (let b = 0; b < this.blocks.length; b++) {
			const block = this.blocks[b]

			if (block === undefined) continue

			let affected = false
			let shapeChanges = false

			for (let k = 0; k < block.cellCount; k++) {
				const col = block.cols[k] ?? 0

				if (col >= at) {
					affected = true

					if ((delta < 0 && col < deleteEnd) || col + delta >= SHEET_MAX_COLS) shapeChanges = true
				}
			}

			if (!affected) continue

			if (!shapeChanges) {
				for (let i = 0; i < block.rowCount; i++) {
					const end = block.rowStarts[i + 1] ?? 0
					let moved = false

					for (let k = block.rowStarts[i] ?? 0; k < end; k++) {
						const col = block.cols[k] ?? 0

						if (col >= at) {
							block.cols[k] = col + delta
							moved = true
						}
					}

					if (moved) block.rowFlags[i] = shiftedFlags(block.rowFlags[i] ?? 0)
				}

				block.measureCols()

				continue
			}

			const records = rowRecords(block)

			for (const record of records) {
				let moved = false

				for (let k = record.cols.length - 1; k >= 0; k--) {
					const col = record.cols[k] ?? 0

					if (col < at) continue

					moved = true

					if ((delta < 0 && col < deleteEnd) || col + delta >= SHEET_MAX_COLS) {
						record.cols.splice(k, 1)
						record.kinds.splice(k, 1)
						record.values.splice(k, 1)
						record.styles.splice(k, 1)
						record.formulas.splice(k, 1)
						record.origins.splice(k, 1)
					} else {
						record.cols[k] = col + delta
					}
				}

				if (moved) record.flags = shiftedFlags(record.flags)
			}

			this.blocks[b] = blockOf(records, block.firstRow, block.sourceFirstRow)
		}

		this.measure()
	}

	estimateBytes(): number {
		let bytes = 0

		for (const block of this.blocks) bytes += block.bytes()

		const strings = this.strings as { estimateBytes?: () => number }
		const formulas = this.formulas as { estimateBytes?: () => number }

		return bytes + (strings.estimateBytes?.() ?? 0) + (formulas.estimateBytes?.() ?? 0)
	}
}

// A new row without span or properties, which need not exist once empty.
function isNewBare(block: RowBlock, index: number): boolean {
	return (
		((block.rowFlags[index] ?? 0) & RowFlag.NEW) !== 0 &&
		((block.rowFlags[index] ?? 0) & PROPERTY_FLAGS) === 0 &&
		Number.isNaN(block.rowHeights[index] ?? 0) &&
		(block.rowStyles[index] ?? -1) < 0
	)
}

// Where `col` goes among the cells of row `index`.
function insertionPoint(block: RowBlock, index: number, col: number): number {
	let at = block.rowStarts[index] ?? 0
	const end = block.rowStarts[index + 1] ?? 0

	while (at < end && (block.cols[at] ?? 0) < col) at++

	return at
}

// A block with arrays of its own.
function copyBlock(block: RowBlock): RowBlock {
	return new RowBlock(
		block.firstRow,
		block.sourceFirstRow,
		block.rows.slice(),
		block.rowStarts.slice(),
		block.rowSpans.slice(),
		block.rowFlags.slice(),
		block.rowHeights.slice(),
		block.rowStyles.slice(),
		block.cols.slice(),
		block.kinds.slice(),
		block.values.slice(),
		block.styles.slice(),
		block.formulas?.slice() ?? null,
		block.origins?.slice() ?? null
	)
}

// The block with the cell at `at` inserted (delta 1), removed (-1) or rewritten (0), its row marked dirty.
function spliceCell(
	block: RowBlock,
	index: number,
	at: number,
	delta: number,
	col: number,
	kind: number,
	value: number,
	style: number,
	formula: number,
	origin: number
): RowBlock {
	const count = block.cellCount + delta
	const tail = delta < 0 ? at + 1 : delta > 0 ? at : at + 1
	const into = delta > 0 ? at + 1 : delta < 0 ? at : at + 1
	const copy = <T extends Uint16Array | Uint8Array | Float64Array | Uint32Array | Int32Array>(
		source: T,
		make: (size: number) => T,
		set: number
	): T => {
		const out = make(count)

		out.set(source.subarray(0, at))
		out.set(source.subarray(tail), into)

		if (delta >= 0) out[at] = set

		return out
	}
	const formulas =
		block.formulas === null && formula < 0
			? null
			: copy(block.formulas ?? new Int32Array(block.cellCount).fill(-1), size => new Int32Array(size), formula)
	const rowStarts = block.rowStarts.slice()

	for (let i = index + 1; i < rowStarts.length; i++) rowStarts[i] = (rowStarts[i] ?? 0) + delta

	// A cell added or removed moves its row's later cells off their source positions: origins are held. A new
	// cell has none; a rewritten one keeps its own.
	let origins = block.origins

	if (delta !== 0) {
		const held = origins ?? positionalOrigins(block)

		origins = copy(held, size => new Uint32Array(size), origin)
	}

	const rowFlags = block.rowFlags.slice()

	rowFlags[index] = ((rowFlags[index] ?? 0) | RowFlag.DIRTY) & ~RowFlag.SHIFTED

	return new RowBlock(
		block.firstRow,
		block.sourceFirstRow,
		block.rows,
		rowStarts,
		block.rowSpans,
		rowFlags,
		block.rowHeights,
		block.rowStyles,
		copy(block.cols, size => new Uint16Array(size), col),
		copy(block.kinds, size => new Uint8Array(size), kind),
		copy(block.values, size => new Float64Array(size), value),
		copy(block.styles, size => new Uint32Array(size), style),
		formulas,
		origins
	)
}

// The block with cell k's origin set: origins of its own (an undo snapshot may hold the block's).
function withOrigin(block: RowBlock, k: number, origin: number): RowBlock {
	const origins = block.origins?.slice() ?? positionalOrigins(block)

	origins[k] = origin

	return withOriginArray(block, origins)
}

// The block with `origins` as its origins (its other arrays shared).
function withOriginArray(block: RowBlock, origins: Uint32Array): RowBlock {
	return new RowBlock(
		block.firstRow,
		block.sourceFirstRow,
		block.rows,
		block.rowStarts,
		block.rowSpans,
		block.rowFlags,
		block.rowHeights,
		block.rowStyles,
		block.cols,
		block.kinds,
		block.values,
		block.styles,
		block.formulas,
		origins
	)
}

// The row index of cell k in a block: the last row whose first cell is at or before it.
function rowOfCell(block: RowBlock, k: number): number {
	let low = 0
	let high = block.rowCount - 1

	while (low < high) {
		const mid = (low + high + 1) >>> 1

		if ((block.rowStarts[mid] ?? 0) <= k) low = mid
		else high = mid - 1
	}

	return low
}

// Each cell's origin as its position in its row.
function positionalOrigins(block: RowBlock): Uint32Array {
	const origins = new Uint32Array(block.cellCount)

	for (let i = 0; i < block.rowCount; i++) {
		const from = block.rowStarts[i] ?? 0
		const to = block.rowStarts[i + 1] ?? 0

		for (let k = from; k < to; k++) origins[k] = k - from + 1
	}

	return origins
}

// The block with a new, empty row `row` (after its first row, not in it).
function spliceRow(block: RowBlock, row: number, base?: RowBase): RowBlock {
	const relative = row - block.firstRow
	let index = 0

	while (index < block.rowCount && (block.rows[index] ?? 0) < relative) index++

	const insert = <T extends Uint32Array | Uint16Array | Float64Array | Int32Array>(
		source: T,
		make: (size: number) => T,
		per: number,
		values: readonly number[]
	): T => {
		const out = make(source.length + per)

		out.set(source.subarray(0, index * per))
		out.set(values, index * per)
		out.set(source.subarray(index * per), (index + 1) * per)

		return out
	}
	const rowStarts = new Uint32Array(block.rowCount + 2)

	rowStarts.set(block.rowStarts.subarray(0, index + 1))
	rowStarts.set(block.rowStarts.subarray(index), index + 1)

	return new RowBlock(
		block.firstRow,
		block.sourceFirstRow,
		insert(block.rows, size => new Uint32Array(size), 1, [relative]),
		rowStarts,
		insert(block.rowSpans, size => new Uint32Array(size), 2, [NO_SPAN, NO_SPAN]),
		insert(block.rowFlags, size => new Uint16Array(size), 1, [RowFlag.NEW | RowFlag.DIRTY | ((base?.(row)?.flags ?? 0) & BASE_FLAGS)]),
		insert(block.rowHeights, size => new Float64Array(size), 1, [base?.(row)?.heightPt ?? Number.NaN]),
		insert(block.rowStyles, size => new Int32Array(size), 1, [-1]),
		block.cols,
		block.kinds,
		block.values,
		block.styles,
		block.formulas,
		block.origins
	)
}

// Rows [from, to) of a block as a block of their own, keeping the base (so the source numbering holds).
function sliceBlock(block: RowBlock, from: number, to: number): RowBlock {
	const cellFrom = block.rowStarts[from] ?? 0
	const cellTo = block.rowStarts[to] ?? 0
	const relative = block.rows[from] ?? 0
	const rows = block.rows.slice(from, to)

	for (let i = 0; i < rows.length; i++) rows[i] = (rows[i] ?? 0) - relative

	const rowStarts = block.rowStarts.slice(from, to + 1)

	for (let i = 0; i < rowStarts.length; i++) rowStarts[i] = (rowStarts[i] ?? 0) - cellFrom

	return new RowBlock(
		block.firstRow + relative,
		block.sourceFirstRow < 0 ? -1 : block.sourceFirstRow + relative,
		rows,
		rowStarts,
		block.rowSpans.slice(from * 2, to * 2),
		block.rowFlags.slice(from, to),
		block.rowHeights.slice(from, to),
		block.rowStyles.slice(from, to),
		block.cols.slice(cellFrom, cellTo),
		block.kinds.slice(cellFrom, cellTo),
		block.values.slice(cellFrom, cellTo),
		block.styles.slice(cellFrom, cellTo),
		block.formulas === null ? null : block.formulas.slice(cellFrom, cellTo),
		block.origins === null ? null : block.origins.slice(cellFrom, cellTo)
	)
}

// The cells a row may reach in the builder's scratch before it is folded (sortRow): twice the grid's width, so
// a row with repeated columns never outgrows the scratch and is folded at most once per SHEET_MAX_COLS cells.
const ROW_SCRATCH = SHEET_MAX_COLS * 2

// The builder's first scratch: rows and cells.
const SCRATCH_ROWS = 64
const SCRATCH_CELLS = 2048

function grown<T extends Uint8Array | Uint16Array | Uint32Array | Int32Array | Float64Array>(
	array: T,
	size: number,
	make: (size: number) => T
): T {
	const out = make(size)

	out.set(array)

	return out
}

// Rows plus cells a finishing pass handles between yields.
const FINISH_STEP = 16_384

// Builds a store's blocks while a sheet is read, row by row, into scratch arrays cut into blocks.
export class StoreBuilder {
	readonly blocks: RowBlock[] = []
	// Rows came out of order or repeated: finish() sorts and merges them.
	private unordered = false
	private previousRow = -1
	private rowCount = 0
	private cellCount = 0
	private blockFirstRow = 0
	private hasFormulas = false
	// The block under way holds a cell off its source position: its origins are kept.
	private blockMoved = false
	// A row of the block under way came while rows were out of order: its absolute row numbers are kept.
	private blockUnordered = false
	// Scratch, grown on demand up to a block's rows and BLOCK_CELLS + ROW_SCRATCH cells: a builder over a few
	// rows (the gate's reads of rewritten rows) allocates little.
	private rows = new Uint32Array(SCRATCH_ROWS)
	private absolute = new Uint32Array(SCRATCH_ROWS)
	private rowStarts = new Uint32Array(SCRATCH_ROWS + 1)
	private rowSpans = new Uint32Array(SCRATCH_ROWS * 2)
	private rowFlags = new Uint16Array(SCRATCH_ROWS)
	private rowHeights = new Float64Array(SCRATCH_ROWS)
	private rowStyles = new Int32Array(SCRATCH_ROWS)
	private cols = new Uint16Array(SCRATCH_CELLS)
	private kinds = new Uint8Array(SCRATCH_CELLS)
	private values = new Float64Array(SCRATCH_CELLS)
	private styles = new Uint32Array(SCRATCH_CELLS)
	private formulas = new Int32Array(SCRATCH_CELLS)
	private origins = new Uint32Array(SCRATCH_CELLS)
	// Source cells holding markup the model does not (sourceKey), for the store; the row under way's ordinals.
	readonly marked = new Set<number>()
	private readonly rowMarked: number[] = []
	// Absolute row numbers of each cut block whose rows came out of order (undefined: firstRow + rows[i]).
	private readonly absolutes: (Uint32Array | undefined)[] = []
	// The row under way: its first cell, the <c> elements read, its last column, whether its cells came in order
	// and whether it was folded.
	private rowCellStart = 0
	private rowOrdinal = 0
	private lastCol = -1
	private rowSorted = true
	totalCells = 0

	// Starts a row; cells follow (cell), then endRow.
	beginRow(): void {
		if (this.rowCount === BLOCK_ROWS || this.cellCount >= BLOCK_CELLS) this.cut()

		this.rowCellStart = this.cellCount
		this.rowOrdinal = 0
		this.lastCol = -1
		this.rowSorted = true
	}

	// The row's next <c> element.
	// `marked`: the element holds markup the model does not (vm, ph, extLst, rich runs).
	cell(col: number, kind: number, value: number, style: number, formula: number, marked = false): void {
		this.place(col, kind, value, style, formula, ++this.rowOrdinal)

		if (marked) this.rowMarked.push(this.rowOrdinal)
	}

	private place(col: number, kind: number, value: number, style: number, formula: number, origin: number): void {
		if (this.cellCount - this.rowCellStart === ROW_SCRATCH) this.sortRow()

		if (this.cellCount === this.cols.length) {
			const size = Math.min(BLOCK_CELLS + ROW_SCRATCH, this.cols.length * 2)

			this.cols = grown(this.cols, size, n => new Uint16Array(n))
			this.kinds = grown(this.kinds, size, n => new Uint8Array(n))
			this.values = grown(this.values, size, n => new Float64Array(n))
			this.styles = grown(this.styles, size, n => new Uint32Array(n))
			this.formulas = grown(this.formulas, size, n => new Int32Array(n))
			this.origins = grown(this.origins, size, n => new Uint32Array(n))
		}

		const at = this.cellCount++

		this.cols[at] = col
		this.kinds[at] = kind
		this.values[at] = value
		this.styles[at] = style
		this.formulas[at] = formula
		this.origins[at] = origin

		if (formula >= 0) this.hasFormulas = true
		if (origin !== at - this.rowCellStart + 1) this.blockMoved = true
		if (col <= this.lastCol) this.rowSorted = false

		this.lastCol = col
		this.totalCells++
	}

	get rowCells(): number {
		return this.cellCount - this.rowCellStart
	}

	endRow(row: number, spanStart: number, spanEnd: number, flags: number, height: number, style: number): void {
		if (this.rowMarked.length > 0) {
			for (const ordinal of this.rowMarked) {
				const key = spanStart === NO_SPAN ? -1 : sourceKey(spanStart, ordinal)

				if (key >= 0) this.marked.add(key)
			}

			this.rowMarked.length = 0
		}

		if (!this.rowSorted) {
			this.sortRow()
			flags |= RowFlag.DIRTY
		}

		if (this.rowCount === 0) {
			this.blockFirstRow = row
		} else if (row <= this.previousRow || row < this.blockFirstRow) {
			this.unordered = true
		}

		if (this.rowCount === this.rows.length) {
			const size = Math.min(BLOCK_ROWS, this.rows.length * 2)

			this.rows = grown(this.rows, size, n => new Uint32Array(n))
			this.absolute = grown(this.absolute, size, n => new Uint32Array(n))
			this.rowStarts = grown(this.rowStarts, size + 1, n => new Uint32Array(n))
			this.rowSpans = grown(this.rowSpans, size * 2, n => new Uint32Array(n))
			this.rowFlags = grown(this.rowFlags, size, n => new Uint16Array(n))
			this.rowHeights = grown(this.rowHeights, size, n => new Float64Array(n))
			this.rowStyles = grown(this.rowStyles, size, n => new Int32Array(n))
		}

		const i = this.rowCount++

		this.rows[i] = row < this.blockFirstRow ? 0 : row - this.blockFirstRow
		this.absolute[i] = row
		this.rowStarts[i] = this.rowCellStart
		this.rowSpans[i * 2] = spanStart
		this.rowSpans[i * 2 + 1] = spanEnd
		this.rowFlags[i] = flags
		this.rowHeights[i] = height
		this.rowStyles[i] = style

		if (this.unordered) this.blockUnordered = true

		this.previousRow = row
	}

	// Sorts the row under way by column (stable); of repeated columns the last written stays.
	private sortRow(): void {
		const from = this.rowCellStart
		const to = this.cellCount
		const order: number[] = []

		for (let k = from; k < to; k++) order.push(k)

		order.sort((a, b) => (this.cols[a] ?? 0) - (this.cols[b] ?? 0) || a - b)

		const kept = order.filter((k, n) => (this.cols[order[n + 1] ?? -1] ?? -1) !== this.cols[k])
		const cols = kept.map(k => this.cols[k] ?? 0)
		const kinds = kept.map(k => this.kinds[k] ?? 0)
		const values = kept.map(k => this.values[k] ?? 0)
		const styles = kept.map(k => this.styles[k] ?? 0)
		const formulas = kept.map(k => this.formulas[k] ?? -1)
		const origins = kept.map(k => this.origins[k] ?? 0)

		this.cols.set(cols, from)
		this.kinds.set(kinds, from)
		this.values.set(values, from)
		this.styles.set(styles, from)
		this.formulas.set(formulas, from)
		this.origins.set(origins, from)
		this.totalCells -= to - from - kept.length
		this.cellCount = from + kept.length
		this.blockMoved = true
	}

	private cut(): void {
		if (this.rowCount === 0) return

		const rowCount = this.rowCount
		const cells = this.cellCount

		this.rowStarts[rowCount] = cells
		this.blocks.push(
			new RowBlock(
				this.blockFirstRow,
				this.blockFirstRow,
				this.rows.slice(0, rowCount),
				this.rowStarts.slice(0, rowCount + 1),
				this.rowSpans.slice(0, rowCount * 2),
				this.rowFlags.slice(0, rowCount),
				this.rowHeights.slice(0, rowCount),
				this.rowStyles.slice(0, rowCount),
				this.cols.slice(0, cells),
				this.kinds.slice(0, cells),
				this.values.slice(0, cells),
				this.styles.slice(0, cells),
				this.hasFormulas ? this.formulas.slice(0, cells) : null,
				this.blockMoved ? this.origins.slice(0, cells) : null
			)
		)
		this.absolutes.push(this.blockUnordered ? this.absolute.slice(0, rowCount) : undefined)
		this.rowCount = 0
		this.cellCount = 0
		this.hasFormulas = false
		this.blockMoved = false
		this.blockUnordered = false
	}

	// The blocks, at once (see finishSteps).
	finish(): RowBlock[] {
		const steps = this.finishSteps()

		for (;;) {
			const step = steps.next()

			if (step.done === true) return step.value
		}
	}

	// The blocks. Rows out of order are sorted (stable, by a counting sort over their numbers) and repeated rows
	// merged into one (its cells by column, the last written winning; it loses its span, so the writer
	// serialises it), in time linear in rows and cells; it yields every FINISH_STEP rows and cells.
	*finishSteps(): Generator<void, RowBlock[]> {
		this.cut()

		if (!this.unordered) return this.blocks

		const input = this.blocks
		const absolutes = this.absolutes
		// A row by its block and index: b * BLOCK_ROWS + i.
		const rowOf = (key: number): number => {
			const b = Math.floor(key / BLOCK_ROWS)
			const i = key - b * BLOCK_ROWS
			const block = input[b] as RowBlock

			return absolutes[b]?.[i] ?? block.firstRow + (block.rows[i] ?? 0)
		}
		let total = 0
		let low = SHEET_MAX_ROWS
		let high = 0
		let work = 0

		for (let b = 0; b < input.length; b++) {
			const block = input[b] as RowBlock

			for (let i = 0; i < block.rowCount; i++) {
				const row = rowOf(b * BLOCK_ROWS + i)

				low = Math.min(low, row)
				high = Math.max(high, row)
				total++
			}

			work += block.rowCount

			if (work >= FINISH_STEP) {
				work = 0
				yield
			}
		}

		const counts = new Uint32Array(high - low + 2)

		for (let b = 0; b < input.length; b++) {
			const block = input[b] as RowBlock

			for (let i = 0; i < block.rowCount; i++) {
				const at = rowOf(b * BLOCK_ROWS + i) - low + 1

				counts[at] = (counts[at] ?? 0) + 1
			}
		}

		for (let k = 1; k < counts.length; k++) {
			counts[k] = (counts[k] ?? 0) + (counts[k - 1] ?? 0)

			if (++work >= FINISH_STEP) {
				work = 0
				yield
			}
		}

		const order = new Uint32Array(total)

		for (let b = 0; b < input.length; b++) {
			const block = input[b] as RowBlock

			for (let i = 0; i < block.rowCount; i++) {
				const key = b * BLOCK_ROWS + i
				const at = rowOf(key) - low

				order[counts[at] ?? 0] = key
				counts[at] = (counts[at] ?? 0) + 1
			}

			work += block.rowCount

			if (work >= FINISH_STEP) {
				work = 0
				yield
			}
		}

		const out = new StoreBuilder()
		// For a repeated row: per column, the last cell written (b * SLOT_BLOCK + k), and the columns set.
		const latest = new Float64Array(SHEET_MAX_COLS).fill(-1)
		const touched: number[] = []

		for (let g = 0; g < total;) {
			const first = order[g] ?? 0
			const row = rowOf(first)
			let end = g + 1

			while (end < total && rowOf(order[end] ?? 0) === row) end++

			const fb = Math.floor(first / BLOCK_ROWS)
			const fi = first - fb * BLOCK_ROWS
			const head = input[fb] as RowBlock

			out.beginRow()

			if (end === g + 1) {
				const to = head.rowStarts[fi + 1] ?? 0

				for (let k = head.rowStarts[fi] ?? 0; k < to; k++) {
					out.place(
						head.cols[k] ?? 0,
						head.kinds[k] ?? 0,
						head.values[k] ?? 0,
						head.styles[k] ?? 0,
						head.formulas?.[k] ?? -1,
						blockOrigin(head, fi, k)
					)
				}

				work += to - (head.rowStarts[fi] ?? 0) + 1
				out.endRow(
					row,
					head.rowSpans[fi * 2] ?? NO_SPAN,
					head.rowSpans[fi * 2 + 1] ?? NO_SPAN,
					head.rowFlags[fi] ?? 0,
					head.rowHeights[fi] ?? Number.NaN,
					head.rowStyles[fi] ?? -1
				)
			} else {
				for (let m = g; m < end; m++) {
					const key = order[m] ?? 0
					const b = Math.floor(key / BLOCK_ROWS)
					const i = key - b * BLOCK_ROWS
					const block = input[b] as RowBlock
					const to = block.rowStarts[i + 1] ?? 0

					for (let k = block.rowStarts[i] ?? 0; k < to; k++) {
						const col = block.cols[k] ?? 0

						if ((latest[col] ?? -1) < 0) touched.push(col)

						latest[col] = b * SLOT_BLOCK + k
					}

					work += to - (block.rowStarts[i] ?? 0) + 1

					if (work >= FINISH_STEP) {
						work = 0
						yield
					}
				}

				touched.sort((a, z) => a - z)

				for (const col of touched) {
					const at = latest[col] ?? 0
					const b = Math.floor(at / SLOT_BLOCK)
					const k = at - b * SLOT_BLOCK
					const block = input[b] as RowBlock

					out.place(col, block.kinds[k] ?? 0, block.values[k] ?? 0, block.styles[k] ?? 0, block.formulas?.[k] ?? -1, 0)
					latest[col] = -1
				}

				work += touched.length
				touched.length = 0
				out.endRow(
					row,
					NO_SPAN,
					NO_SPAN,
					((head.rowFlags[fi] ?? 0) | RowFlag.DIRTY | RowFlag.NEW) & ~RowFlag.SHIFTED,
					head.rowHeights[fi] ?? Number.NaN,
					head.rowStyles[fi] ?? -1
				)
			}

			g = end

			if (work >= FINISH_STEP) {
				work = 0
				yield
			}
		}

		this.totalCells = out.totalCells

		return out.finish()
	}
}

// The shared indexes (si) with a child cell no master of theirs covers (a child without a formula a reader can
// build), in steps of a block. Without shared children nothing is walked.
export function* orphanedSharedSteps(store: XlsxSheetStore): Generator<void, Set<number>> {
	const formulas = store.formulas
	const orphaned = new Set<number>()
	let children = false

	for (let id = 0; id < formulas.length && !children; id++) children = formulas.kind(id) === FormulaKind.SHARED_CHILD

	if (!children) return orphaned

	// The ranges of the masters cells hold, by si (four numbers each), then every child against them.
	const masters = new Map<number, number[]>()

	for (let pass = 0; pass < 2; pass++) {
		for (const block of store.blocks) {
			const ids = block.formulas

			for (let index = 0; ids !== null && index < block.rowCount; index++) {
				const row = block.firstRow + (block.rows[index] ?? 0)

				for (let k = block.rowStarts[index] ?? 0; k < (block.rowStarts[index + 1] ?? 0); k++) {
					const id = ids[k] ?? -1

					if (id < 0) continue

					const kind = formulas.kind(id)

					if (pass === 0) {
						const ref = kind === FormulaKind.SHARED_MASTER ? formulas.formula(id).ref : null

						if (ref !== null) {
							const sharedIndex = formulas.sharedIndex(id)
							let ranges = masters.get(sharedIndex)

							if (ranges === undefined) masters.set(sharedIndex, (ranges = []))

							ranges.push(ref.startRow, ref.startCol, ref.endRow, ref.endCol)
						}

						continue
					}

					if (kind !== FormulaKind.SHARED_CHILD) continue

					const sharedIndex = formulas.sharedIndex(id)

					if (orphaned.has(sharedIndex)) continue

					const col = block.cols[k] ?? 0
					const ranges = masters.get(sharedIndex) ?? []
					let covered = false

					for (let r = 0; r < ranges.length && !covered; r += 4) {
						covered =
							row >= (ranges[r] ?? 0) &&
							row <= (ranges[r + 2] ?? -1) &&
							col >= (ranges[r + 1] ?? 0) &&
							col <= (ranges[r + 3] ?? -1)
					}

					if (!covered) orphaned.add(sharedIndex)
				}
			}

			yield
		}
	}

	return orphaned
}

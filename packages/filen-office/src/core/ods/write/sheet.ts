import { SHEET_MAX_COLS, type SheetId } from "../../sheet/protocol"
import type { XlsxDocument } from "../../xlsx/edit/document"
import { cellKeyOf } from "../../xlsx/edit/history"
import type { SheetStore } from "../../xlsx/model/store"
import { RowFlag, rowRunAt, type XlsxColRange, type XlsxRowRun, type XlsxSheetModel } from "../../xlsx/model/types"
import { colWidthToPx, defaultColPx } from "../../sheet/sizes/sizes"
import { numFmt } from "../../sheet/numfmt/format"
import { SectionKind, Tok } from "../../sheet/numfmt/parse"
import { EMPTY_CELL, storeValue, type CellValue, type NumberKind } from "./cells"

// One sheet as the writer reads the model: cells (stored or formatted in runs), rows' properties, merges, and the
// rows an edit marked, ascending.

export interface RowProps {
	// Points, NaN for the sheet's default.
	readonly heightPt: number
	// RowFlag bits.
	readonly flags: number
}

const PLAIN: RowProps = { heightPt: Number.NaN, flags: 0 }

export interface Merge {
	readonly startRow: number
	readonly startCol: number
	readonly endRow: number
	readonly endCol: number
}

// A row an edit changed: new, or marked by more than columns inserted or deleted.
function edited(flags: number): boolean {
	return (flags & RowFlag.NEW) !== 0 || (flags & (RowFlag.DIRTY | RowFlag.SHIFTED)) === RowFlag.DIRTY
}

// Whether an edit marked a row of the model's store (SheetView.marked not empty), without collecting them.
export function hasMarkedRows(model: XlsxSheetModel): boolean {
	for (const block of (model.store as SheetStore).blocks)
		for (let i = 0; i < block.rowCount; i++) if (edited(block.rowFlags[i] ?? 0)) return true

	return false
}

export class SheetView {
	readonly document: XlsxDocument
	readonly model: XlsxSheetModel
	readonly id: SheetId
	readonly store: SheetStore
	// Store rows an edit marked (DIRTY, NEW; not those whose cells only moved along them, SHIFTED), ascending.
	readonly marked: readonly number[]
	private readonly merges: Merge[]
	// Merges by their first row.
	private readonly mergesByRow = new Map<number, Merge[]>()
	// Merges by their first row, and the last row any of the first k reaches (a stabbing query's bound).
	private readonly byStart: Merge[]
	private readonly reach: Int32Array
	private readonly kinds = new Map<number, NumberKind>()

	constructor(document: XlsxDocument, model: XlsxSheetModel) {
		this.document = document
		this.model = model
		this.id = model.id
		this.store = model.store as SheetStore

		const marked: number[] = []

		for (const block of this.store.blocks)
			for (let i = 0; i < block.rowCount; i++) if (edited(block.rowFlags[i] ?? 0)) marked.push(block.firstRow + (block.rows[i] ?? 0))

		this.marked = marked.sort((a, b) => a - b)

		const quads = model.merges

		this.merges = []

		for (let k = 0; k + 3 < quads.length; k += 4) {
			const merge = { startRow: quads[k] ?? 0, startCol: quads[k + 1] ?? 0, endRow: quads[k + 2] ?? 0, endCol: quads[k + 3] ?? 0 }

			this.merges.push(merge)

			let list = this.mergesByRow.get(merge.startRow)

			if (list === undefined) this.mergesByRow.set(merge.startRow, (list = []))

			list.push(merge)
		}

		this.byStart = [...this.merges].sort((a, b) => a.startRow - b.startRow)
		this.reach = new Int32Array(this.byStart.length)

		let reach = -1

		this.byStart.forEach((merge, k) => {
			reach = Math.max(reach, merge.endRow)
			this.reach[k] = reach
		})
	}

	// Merges with rows in [from, to]: those starting by `to` whose last row is `from` or after, found back from the
	// last starting by `to` while any before it reaches that far.
	private crossing(from: number, to: number): Merge[] {
		let low = 0
		let high = this.byStart.length

		while (low < high) {
			const mid = (low + high) >>> 1

			if ((this.byStart[mid]?.startRow ?? 0) <= to) low = mid + 1
			else high = mid
		}

		const out: Merge[] = []

		for (let k = low - 1; k >= 0 && (this.reach[k] ?? -1) >= from; k--) {
			const merge = this.byStart[k] as Merge

			if (merge.endRow >= from) out.push(merge)
		}

		return out.reverse()
	}

	// The marked rows in [from, to), ascending.
	markedIn(from: number, to: number): number[] {
		let low = 0
		let high = this.marked.length

		while (low < high) {
			const mid = (low + high) >>> 1

			if ((this.marked[mid] ?? 0) < from) low = mid + 1
			else high = mid
		}

		const out: number[] = []

		for (let k = low; k < this.marked.length && (this.marked[k] ?? 0) < to; k++) out.push(this.marked[k] ?? 0)

		return out
	}

	// Store rows in [from, to), ascending.
	storeRowsIn(from: number, to: number): number[] {
		const out: number[] = []
		const blocks = this.store.blocks

		for (let b = Math.max(0, this.store.blockOf(from)); b < blocks.length; b++) {
			const block = blocks[b]

			if (block === undefined || block.firstRow >= to) break

			// Rows ascend within a block: from the first at `from` or after.
			let low = 0
			let high = block.rowCount

			while (low < high) {
				const mid = (low + high) >>> 1

				if (block.firstRow + (block.rows[mid] ?? 0) < from) low = mid + 1
				else high = mid
			}

			for (let i = low; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)

				if (row >= to) break

				out.push(row)
			}
		}

		return out
	}

	// The properties a row has: its store row's, else its run's, else none.
	rowProps(row: number): RowProps {
		const store = this.store
		const block = store.blocks[store.blockOf(row)]
		const index = block === undefined ? -1 : block.rowIndex(row)

		if (block !== undefined && index >= 0) return { heightPt: block.rowHeights[index] ?? Number.NaN, flags: block.rowFlags[index] ?? 0 }

		const run: XlsxRowRun | undefined = rowRunAt(this.model.rowRuns, row)

		return run === undefined ? PLAIN : { heightPt: run.heightPt, flags: run.flags }
	}

	// The row style a row's empty cells take (customFormat), -1 for none.
	rowStyle(row: number): number {
		const store = this.store
		const block = store.blocks[store.blockOf(row)]
		const index = block === undefined ? -1 : block.rowIndex(row)

		if (block === undefined || index < 0 || ((block.rowFlags[index] ?? 0) & RowFlag.CUSTOM_FORMAT) === 0) return -1

		return block.rowStyles[index] ?? -1
	}

	// Runs of rows the model holds without the store, overlapping [from, to).
	runsIn(from: number, to: number): XlsxRowRun[] {
		return (this.model.rowRuns ?? []).filter(run => run.last >= from && run.first < to)
	}

	cell(row: number, col: number): CellValue {
		const slot = this.store.locate(row, col)

		if (slot < 0) return { ...EMPTY_CELL, xf: this.document.startingStyle(this.model, row, col) }

		const shown = this.document.shownResults.get(this.id)?.get(cellKeyOf(row, col))

		return storeValue(
			this.store,
			this.document.workbook.sharedStrings,
			slot,
			this.store.style(slot),
			shown?.edited === true && shown.value !== null ? { value: shown.value, error: shown.error } : undefined
		)
	}

	// Columns of a row's stored cells, ascending.
	cellCols(row: number): number[] {
		const store = this.store
		const block = store.blocks[store.blockOf(row)]
		const index = block === undefined ? -1 : block.rowIndex(row)

		if (block === undefined || index < 0) return []

		const out: number[] = []

		for (let k = block.rowStarts[index] ?? 0; k < (block.rowStarts[index + 1] ?? 0); k++) out.push(block.cols[k] ?? 0)

		return out
	}

	// Where the format of empty cells changes along a row: the runs' and columns' bounds.
	styleBounds(row: number, into: Set<number>): void {
		for (const range of this.model.cols) {
			into.add(range.first)
			into.add(range.last + 1)
		}

		this.model.styleRuns?.forEach(
			{ startRow: row, startCol: 0, endRow: row, endCol: SHEET_MAX_COLS - 1 },
			(_r0, startCol, _r1, endCol) => {
				into.add(startCol)
				into.add(endCol + 1)
			}
		)
	}

	// The merge anchored at a cell.
	mergeAt(row: number, col: number): Merge | undefined {
		return this.mergesByRow.get(row)?.find(merge => merge.startCol === col)
	}

	// Merges crossing rows [from, to).
	mergesBetween(from: number, to: number): Merge[] {
		return to <= from ? [] : this.crossing(from, to - 1)
	}

	// Merges crossing a row.
	mergesIn(row: number): Merge[] {
		return this.crossing(row, row)
	}

	// Whether a cell is inside a merge but not its first.
	covered(row: number, col: number): boolean {
		for (const merge of this.crossing(row, row))
			if (col >= merge.startCol && col <= merge.endCol) return row !== merge.startRow || col !== merge.startCol

		return false
	}

	// table:visibility of a row (§19.751): "filter" for one a filter hides, "collapse" for one hidden by hand.
	visibility(row: number, flags: number): string | undefined {
		if ((flags & RowFlag.HIDDEN) === 0) return undefined

		return this.document.filteredRow?.(this.id, row) === true ? "filter" : "collapse"
	}

	// A row's height as written: the sheet's default for a row of none.
	height(props: RowProps): number {
		return Number.isNaN(props.heightPt) ? this.model.format.defaultRowHeight : props.heightPt
	}

	// The width of a column without one of its own, in pixels.
	defaultColumnPx(): number {
		return this.model.format.defaultColPx ?? defaultColPx(this.model.format, this.document.digitPx)
	}

	// A column range's width in pixels.
	columnPx(range: XlsxColRange | undefined): number {
		if (range === undefined) return this.defaultColumnPx()

		return range.px ?? (Number.isNaN(range.width) ? this.defaultColumnPx() : colWidthToPx(range.width, this.document.digitPx))
	}

	// How a number of format `xf` is typed: a date or time format's as a date or time, a percentage's as one.
	numberKind(xf: number): NumberKind {
		let kind = this.kinds.get(xf)

		if (kind === undefined) {
			const format = numFmt(this.document.styles.numFmtCode(xf))
			const first = format.sections[0]

			if (first?.kind === SectionKind.DATE) {
				const dated = first.tokens.some(token => token.kind === Tok.YEAR || token.kind === Tok.MONTH || token.kind === Tok.DAY)

				kind = dated ? "date" : "time"
			} else if (first !== undefined && first.percent > 0) {
				kind = "percentage"
			} else {
				kind = "float"
			}

			this.kinds.set(xf, kind)
		}

		return kind
	}

	// What a cell shows (a number's text:p).
	shown(row: number, col: number): string {
		return this.document.cellView(this.id, row, col).text
	}
}

import { OdfPackage } from "../../odf/package"
import { readStyleSheet } from "../../odf/load"
import { OdfStyleResolver } from "../../odf/resolve"
import { bytesSource } from "../../opc/index"
import type { InflateHook } from "../../opc/zipReader"
import { SheetStyles } from "../../sheet/style/resolve"
import type { SliceClock } from "../../slicing"
import type { XlsxDocument } from "../../xlsx/edit/document"
import { ColFlag, RowFlag, rowRunAt, type XlsxSheetModel } from "../../xlsx/model/types"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "../../sheet/protocol"
import { DEFAULT_ROW_PT } from "../read/sheet"
import { encodeUtf8 } from "../../xml/index"
import { OdsIssues } from "../issues"
import type { OdsSource } from "../source"
import { OdsCellStyles } from "../styles/cell"
import { sameContent } from "./cells"
import { decodeRows, type DecodedRows } from "./decode"
import { currentLinks, currentNotes } from "./features"
import { SheetView } from "./sheet"
import type { SpanRow, TableWriter } from "./table"
import { column, Styles } from "../verify"
import { colWidthToPx } from "../../sheet/sizes/sizes"

// The proof of a save that changed rows and styles alone: the row elements the writer wrote from the model are read
// back (with the written file's styles) and compared with the model's rows they stand for; every other byte of the
// content is the source's, which reads as the source did. Undecided (false) wherever it cannot tell, and the whole
// file's proof (verify.ts) decides. Only for saves where no row or column moved and nothing past rows changed.

// Row elements read back per pass.
const BATCH = 512
// A run of more rows than this is compared at the rows where the model changes along it.
const DENSE = 64
const MASK = RowFlag.HIDDEN | RowFlag.OUTLINE_MASK

export async function proveSpan(
	document: XlsxDocument,
	source: OdsSource,
	writers: ReadonlyMap<number, TableWriter>,
	written: Uint8Array,
	inflate?: InflateHook,
	clock?: SliceClock
): Promise<boolean> {
	const opened = await OdfPackage.open(bytesSource(written), { kinds: ["spreadsheet"], ...(inflate !== undefined && { inflate }) })

	if (!opened.ok) return false

	const { sheet, prologue } = await readStyleSheet(opened.package, clock)

	if (prologue === undefined || prologue.bodyStart < 0) return false

	const prefixes = new Map<string, string>()

	for (const { name, value } of prologue.document.attributes(prologue.root)) {
		if (name === "xmlns") prefixes.set("", value)
		else if (name.startsWith("xmlns:")) prefixes.set(name.slice(6), value)
	}

	prefixes.set("xml", "http://www.w3.org/XML/1998/namespace")

	const styles = new OdsCellStyles(sheet, new OdfStyleResolver(sheet), new OdsIssues())
	const reads: { view: SheetView; rows: readonly SpanRow[]; decoded: DecodedRows[]; model: XlsxSheetModel }[] = []

	const columnReads: { view: SheetView; read: DecodedRows }[] = []

	for (const [id, writer] of writers) {
		const rows = writer.spanRows
		const model = document.model(id)

		if (rows === null || model === null) return false

		// Columns written anew: read back on their own, compared with the model's below.
		if (writer.writtenColumns !== null)
			columnReads.push({
				view: new SheetView(document, model),
				read: decodeRows(styles, prefixes, encodeUtf8(writer.writtenColumns), [])
			})

		if (rows.length === 0) continue

		const decoded: DecodedRows[] = []
		const columns = writer.writtenColumns === null ? writer.columnsMarkup : encodeUtf8(writer.writtenColumns)

		for (let start = 0; start < rows.length; start += BATCH) {
			const batch = rows.slice(start, start + BATCH).map(row => encodeUtf8(withoutRepeat(row.markup)))
			const read = decodeRows(styles, prefixes, columns, batch)

			// One row each: an element holding more (or none) is not the one row it was written as.
			if (read.built.rowCount !== batch.length) return false

			decoded.push(read)

			if (clock?.due === true) await clock.pause()
		}

		reads.push({ view: new SheetView(document, model), rows, decoded, model })
	}

	// Read back first: their styles are in the table once every row is.
	const compare = new Styles(document.styles, new SheetStyles(styles.table, null))

	for (const { view, read } of columnReads) if (!sameColumns(view, read, compare, document.digitPx)) return false

	for (const { view, rows, decoded, model } of reads) {
		const notes = await currentNotes(document.workbook, source, model)
		const links = currentLinks(document.workbook, model)
		// A row of no height of its own reads at the table's commonest: the model's where the rows after the last
		// written (most of the grid) are at it.
		const last = rows.findIndex(row => row.count > SHEET_MAX_ROWS / 2)
		const lastProps = last < 0 ? undefined : decodedProps(decoded[Math.floor(last / BATCH)] as DecodedRows, last % BATCH)
		const lastHeight = lastProps === undefined || Number.isNaN(lastProps.heightPt) ? DEFAULT_ROW_PT : lastProps.heightPt
		const fallback = last >= 0 && lastHeight === model.format.defaultRowHeight ? lastHeight : undefined

		for (const [k, row] of rows.entries()) {
			const read = decoded[Math.floor(k / BATCH)]
			const index = k % BATCH

			if (read === undefined || rowsOf(row.markup) !== row.count) return false

			for (const target of targetRows(view, row)) {
				if (!sameRow(view, read, index, target, compare, notes, links, fallback)) return false

				if (clock?.due === true) await clock.pause()
			}
		}
	}

	return true
}

// Widths, visibility and formats of the columns read back, as the whole file's proof compares them.
function sameColumns(view: SheetView, read: DecodedRows, styles: Styles, digitPx: number): boolean {
	const bounds = new Set<number>([0])
	const cols = read.built.cols

	for (const range of [...view.model.cols, ...cols]) {
		bounds.add(range.first)
		bounds.add(range.last + 1)
	}

	for (const col of bounds) {
		if (col > SHEET_MAX_COLS - 1) continue

		const left = column(view, col)
		const range = cols.find(candidate => col >= candidate.first && col <= candidate.last)
		const px =
			range === undefined
				? read.built.defaultColPx
				: (range.px ?? (Number.isNaN(range.width) ? read.built.defaultColPx : colWidthToPx(range.width, digitPx)))

		if (left.px !== px || left.hidden !== (range !== undefined && (range.flags & ColFlag.HIDDEN) !== 0)) return false
		if (!styles.same(left.style, range === undefined ? 0 : Math.max(0, range.style))) return false
	}

	return true
}

function withoutRepeat(markup: string): string {
	return markup.replace(/^(<table:table-row\b[^>]*?)\s+table:number-rows-repeated="\d+"/u, "$1")
}

function rowsOf(markup: string): number {
	const repeat = /^<table:table-row\b[^>]*?\stable:number-rows-repeated="(\d+)"/u.exec(markup)?.[1]

	return repeat === undefined ? 1 : Number(repeat)
}

// The model rows an element stands for that can differ: each one of a short run, else the first and the rows where
// the model changes along it.
function targetRows(view: SheetView, row: SpanRow): number[] {
	const end = row.target + row.count

	if (row.count <= DENSE) return Array.from({ length: row.count }, (_, k) => row.target + k)

	const rows = new Set<number>([row.target])

	for (const at of view.storeRowsIn(row.target, end)) {
		rows.add(at)
		if (at + 1 < end) rows.add(at + 1)
	}

	for (const run of view.runsIn(row.target, end)) {
		rows.add(Math.max(row.target, run.first))
		if (run.last + 1 < end) rows.add(run.last + 1)
	}

	view.model.styleRuns?.forEach(
		{ startRow: row.target, startCol: 0, endRow: end - 1, endCol: SHEET_MAX_COLS - 1 },
		(startRow, _c, endRow) => {
			rows.add(Math.max(row.target, startRow))
			if (endRow + 1 < end) rows.add(endRow + 1)
		}
	)

	for (const merge of view.mergesBetween(row.target, end)) {
		rows.add(Math.max(row.target, merge.startRow))
		if (merge.endRow + 1 < end) rows.add(merge.endRow + 1)
	}

	return [...rows].sort((a, b) => a - b)
}

function decodedProps(read: DecodedRows, row: number): { heightPt: number; flags: number } | undefined {
	const store = read.built.store
	const block = store.blocks[store.blockOf(row)]
	const index = block === undefined ? -1 : block.rowIndex(row)

	if (block !== undefined && index >= 0) return { heightPt: block.rowHeights[index] ?? Number.NaN, flags: block.rowFlags[index] ?? 0 }

	const run = rowRunAt(read.built.rowRuns, row)

	return run === undefined ? undefined : { heightPt: run.heightPt, flags: run.flags }
}

function decodedCols(read: DecodedRows, row: number, into: Set<number>): void {
	const store = read.built.store
	const block = store.blocks[store.blockOf(row)]
	const index = block === undefined ? -1 : block.rowIndex(row)

	if (block !== undefined && index >= 0)
		for (let k = block.rowStarts[index] ?? 0; k < (block.rowStarts[index + 1] ?? 0); k++) {
			const col = block.cols[k] ?? 0

			into.add(col)
			into.add(col + 1)
		}

	for (const range of read.built.cols) {
		into.add(range.first)
		into.add(range.last + 1)
	}

	read.built.styleRuns?.forEach({ startRow: row, startCol: 0, endRow: row, endCol: SHEET_MAX_COLS - 1 }, (_r0, startCol, _r1, endCol) => {
		into.add(startCol)
		into.add(endCol + 1)
	})
}

function sameRow(
	view: SheetView,
	read: DecodedRows,
	index: number,
	target: number,
	styles: Styles,
	notes: ReadonlyMap<string, { readonly text: string; readonly author: string }>,
	links: ReadonlyMap<string, string>,
	fallback: number | undefined
): boolean {
	const propsA = view.rowProps(target)
	const propsB = decodedProps(read, index) ?? { heightPt: Number.NaN, flags: 0 }
	const heightB = Number.isNaN(propsB.heightPt) ? fallback : propsB.heightPt

	if (heightB === undefined || (propsA.flags & MASK) !== (propsB.flags & MASK) || view.height(propsA) !== heightB) return false

	const cols = new Set<number>([0])

	for (const col of view.cellCols(target)) {
		cols.add(col)
		cols.add(col + 1)
	}

	view.styleBounds(target, cols)
	decodedCols(read, index, cols)

	for (const merge of view.mergesIn(target)) {
		cols.add(merge.startCol)
		cols.add(merge.endCol + 1)
	}

	for (const col of cols) {
		if (col > SHEET_MAX_COLS - 1) continue

		const left = view.cell(target, col)
		const right = read.cell(index, col)

		if (!sameContent(left, right) || !styles.same(left.xf, right.xf)) return false

		const mergeA = view.mergeAt(target, col)
		const mergeB = read.merge(index, col)

		if ((mergeA === undefined) !== (mergeB === undefined)) return false
		if (
			mergeA !== undefined &&
			mergeB !== undefined &&
			(mergeA.endRow - mergeA.startRow !== mergeB.endRow - index || mergeA.endCol !== mergeB.endCol)
		)
			return false

		const noteA = notes.get(`${target},${col}`)
		const noteB = read.note(index, col)

		if ((noteA === undefined) !== (noteB === undefined)) return false
		if (noteA !== undefined && noteB !== undefined && (noteA.text !== noteB.text || noteA.author !== noteB.author)) return false
		if (links.get(`${target},${col}`) !== read.link(index, col)) return false
	}

	return true
}

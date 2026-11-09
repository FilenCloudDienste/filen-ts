import type { Slicing } from "../slicing"
import { pastedCells, type GridClip } from "./clipboard/tsv"
import { canEncodeWindows1252, csvCellView, parseCsvFile, serializeCsv, type CsvFormat } from "./csv/csvView"
import { writeCsv } from "./csv/csvParse"
import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, cellKey } from "./model/model"
import {
	CellFlag,
	SHEET_MAX_COLS,
	SHEET_MAX_COPY_CELLS,
	SHEET_MAX_EDIT_CELLS,
	SHEET_MAX_ROWS,
	SHEET_TILE_TEXT,
	TILE_COLS,
	TILE_ROWS,
	tileText,
	type SheetAxis,
	type SheetCell,
	type SheetCellDetail,
	type SheetEvent,
	type SheetFileKind,
	type SheetId,
	type SheetLayout,
	type SheetOpenFailure,
	type SheetOpened,
	type SheetPane,
	type SheetQueryResult,
	type SheetRange,
	type SheetRefusal,
	type SheetSaveResult,
	type SheetSessionOptions,
	type SheetSessionSettings,
	type SheetSummary,
	type SheetWritability
} from "./protocol"
import { textClipboardHtmlFeature } from "./clipboard/text"
import { textFillFeature } from "./fill/text"
import { textAutoCompleteFeature } from "./autoComplete/text"
import { textFindFeature } from "./find/text"
import { textNavigateFeature } from "./navigate/text"
import { textSelectionStatsFeature } from "./stats/text"
import { textShiftFeature } from "./shift/text"
import { textSortFeature } from "./sort/text"
import { defineSheetFeature, sheetRegistry, type SheetChangeSink, type SheetFeature, type SheetHandled } from "./registry"
import { RenderStyleTable, SheetSession, sessionFeature, type SheetEntrySink, type SheetSessionDocument } from "./session"

// CSV, TSV and .tab files as a session: one sheet of text. What is typed is what is stored, a leading "=" or "'"
// included (a CSV holds no formulas, formats or sizes; sizes live beside the file, in the app's size layer). The
// file is written back in its own encoding, separator and line ends; a character its legacy encoding cannot hold
// is refused. Nothing here reaches the workbook reader, the writer or the formula engine.

// The most cells a text file opens with, as the workbook view's limit.
export const MAX_TEXT_CELLS = 5_000_000

const TEXT_KINDS: ReadonlySet<SheetFileKind> = new Set(["csv", "tsv", "tab"])

export function isTextKind(kind: SheetFileKind): boolean {
	return TEXT_KINDS.has(kind)
}

// The only sheet of a text file.
export const TEXT_SHEET: SheetId = 0

function field(text: string): string {
	return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

declare module "./protocol" {
	interface SheetCommandMap {
		// Rows above and columns left of the scrolling pane kept in view (0 and 0 unfreeze); `topRow` and `leftCol`
		// name the scrolling pane's first cell (by default the first after the frozen ones). A workbook writes it
		// into the sheet's view; a text file, which cannot hold it, keeps it in the session (the app keeps it beside
		// the file and gives it again at the next open).
		"view.freeze": {
			readonly sheet: SheetId
			readonly rows: number
			readonly cols: number
			readonly topRow?: number
			readonly leftCol?: number
		}
	}
}

export class TextSheetDocument implements SheetSessionDocument {
	readonly kind: SheetFileKind
	readonly date1904 = false
	// Frozen panes, the session's alone.
	pane: SheetPane | null = null
	readonly encrypted = undefined
	settings: SheetSessionSettings
	readonly format: CsvFormat
	private table: string[][]
	// The longest row's length, and how many rows have it; -1 when not known (counted again on the next look).
	// Kept as edits go, so a keystroke never walks every row.
	private knownWidth = -1
	private widthRows = 0
	// The file as opened: an unedited save (or one undone back to it) hands it out as it was.
	private readonly source: Uint8Array
	// The latest copy (the copy query).
	clip: { readonly id: number; readonly grid: GridClip } | null = null
	private nextClip = 1
	private closed = false

	// false: the file holds more records than a sheet; only the first SHEET_MAX_ROWS were read, so nothing that would
	// write the rest away (a save, a CSV, a copy in another format) is made.
	readonly complete: boolean

	constructor(
		source: Uint8Array,
		rows: string[][],
		format: CsvFormat,
		kind: SheetFileKind,
		settings: SheetSessionSettings = {},
		complete = true
	) {
		this.source = source
		this.table = rows
		this.format = format
		this.complete = complete
		this.kind = kind
		this.settings = settings
	}

	get rows(): string[][] {
		return this.table
	}

	set rows(rows: string[][]) {
		this.table = rows
		this.knownWidth = -1
	}

	get width(): number {
		if (this.knownWidth < 0) {
			let width = 0
			let count = 0

			for (const row of this.table) {
				if (row.length > width) {
					width = row.length
					count = 1
				} else if (row.length === width) {
					count++
				}
			}

			this.knownWidth = width
			this.widthRows = count
		}

		return this.knownWidth
	}

	// The rows were changed in place (not through write or shrink).
	reshaped(): void {
		this.knownWidth = -1
	}

	// A row's length went from `before` to `after` (-1: no row).
	private resized(before: number, after: number): void {
		const width = this.knownWidth

		if (width < 0 || before === after) return

		if (after > width) {
			this.knownWidth = after
			this.widthRows = 1
		} else if (after === width) {
			this.widthRows++
		} else if (before === width && --this.widthRows === 0) {
			this.knownWidth = -1
		}
	}

	text(row: number, col: number): string {
		return this.rows[row]?.[col] ?? ""
	}

	sheets(): SheetSummary[] {
		return [{ id: TEXT_SHEET, name: "", state: "visible", kind: "worksheet", ready: true }]
	}

	activeSheet(): SheetId {
		return TEXT_SHEET
	}

	isReady(): boolean {
		return true
	}

	ready(): Promise<void> {
		return Promise.resolve()
	}

	readyAll(): Promise<void> {
		return Promise.resolve()
	}

	layout(sheet: SheetId): Omit<SheetLayout, "version" | "extensions"> {
		const empty = (defaultSize: number) => ({
			defaultSize,
			indices: new Uint32Array(0),
			sizes: new Float32Array(0),
			styles: new Uint32Array(0),
			flags: new Uint16Array(0)
		})

		return {
			sheet,
			rowCount: this.rows.length,
			colCount: this.width,
			rows: empty(DEFAULT_ROW_HEIGHT),
			cols: empty(DEFAULT_COL_WIDTH),
			merges: new Uint32Array(0),
			pane: this.pane,
			zoom: 100,
			gridLines: true,
			headings: true,
			rightToLeft: false,
			protection: null
		}
	}

	fillTile(_sheet: SheetId, tileRow: number, tileCol: number, sink: SheetEntrySink): void {
		const firstRow = tileRow * TILE_ROWS
		const firstCol = tileCol * TILE_COLS
		const lastRow = Math.min(firstRow + TILE_ROWS, this.rows.length)

		for (let row = firstRow; row < lastRow; row++) {
			const values = this.rows[row] ?? []
			const lastCol = Math.min(firstCol + TILE_COLS, values.length)

			for (let col = firstCol; col < lastCol; col++) {
				const text = values[col] ?? ""

				if (text === "") continue

				const flags = csvCellView(text)?.numeric === true ? CellFlag.NUMBER : 0

				// No tile carries more of a field than a cell paints: the cell query gives the whole input.
				if (text.length > SHEET_TILE_TEXT) sink.add(row, col, tileText(text), null, 0, flags | CellFlag.CLIPPED)
				else sink.add(row, col, text, null, 0, flags)
			}
		}
	}

	cellDetail(cell: SheetCell): Omit<SheetCellDetail, "details"> {
		const text = this.text(cell.row, cell.col)

		return { input: text, numFmt: "@", style: 0, flags: csvCellView(text)?.numeric === true ? CellFlag.NUMBER : 0 }
	}

	protects(): SheetRefusal | null {
		return null
	}

	workbookProtection(): null {
		return null
	}

	fileSharing(): null {
		return null
	}

	// A text file has no properties.
	title(): undefined {
		return undefined
	}

	// A text file is never proven: it saves as its encoding allows.
	initialWritability(): SheetWritability {
		if (!this.complete) return { state: "viewOnly", reason: "incomplete" }

		return this.format.writable ? { state: "writable" } : { state: "viewOnly", reason: "unsafe" }
	}

	prove(): Promise<SheetWritability> {
		return Promise.resolve(this.initialWritability())
	}

	needsPreparing(): boolean {
		return false
	}

	prepare(): void {}

	save(options: {
		readonly untouched?: boolean
	}): Promise<
		Exclude<SheetSaveResult, { ok: true }> | { readonly ok: true; readonly bytes: Uint8Array; readonly changedParts: readonly string[] }
	> {
		if (this.closed) return Promise.resolve({ ok: false, reason: "closed", message: "The session is closed" })
		if (!this.complete)
			return Promise.resolve({ ok: false, reason: "gate", message: "Only the first rows of this text file were read" })
		if (!this.format.writable)
			return Promise.resolve({ ok: false, reason: "gate", message: "This text file cannot be written back as it was" })
		if (options.untouched === true) return Promise.resolve({ ok: true, bytes: this.source.slice(), changedParts: [] })

		return Promise.resolve({ ok: true, bytes: serializeCsv(this.rows, this.format), changedParts: [""] })
	}

	// "CSV UTF-8": the cells comma-separated, with a BOM.
	csv(): Uint8Array | SheetRefusal {
		if (!this.complete) return { reason: "tooLarge", detail: "incomplete" }

		const body = new TextEncoder().encode(writeCsv(this.rows, ",", "\r\n", true))
		const bytes = new Uint8Array(body.length + 3)

		bytes.set([0xef, 0xbb, 0xbf], 0)
		bytes.set(body, 3)

		return bytes
	}

	viewOnly(): void {}

	close(): void {
		this.closed = true
	}

	// --- Editing ---

	write(row: number, col: number, text: string): void {
		const rows = this.table

		while (rows.length <= row) {
			rows.push([])
			this.resized(-1, 0)
		}

		const values = rows[row] ?? []
		const before = values.length

		while (values.length <= col) values.push("")

		values[col] = text
		rows[row] = values
		this.resized(before, values.length)
	}

	// Undoes the growth of an edit: each row back to its length, and the rows it added dropped.
	shrink(widths: ReadonlyMap<number, number>, rowCount: number): void {
		const rows = this.table

		for (const [row, width] of widths) {
			const values = rows[row]

			if (values !== undefined && values.length > width) {
				const before = values.length

				values.length = width
				this.resized(before, width)
			}
		}

		for (let row = rowCount; row < rows.length; row++) this.resized(rows[row]?.length ?? 0, -1)

		if (rows.length > rowCount) rows.length = rowCount
	}

	encodable(texts: readonly string[]): boolean {
		return this.format.encoding !== "windows-1252" || texts.every(text => canEncodeWindows1252(text))
	}

	copyId(): number {
		return this.nextClip++
	}
}

// --- Commands ---

function bounds(rows: ArrayLike<number>, cols: ArrayLike<number>): SheetRange {
	let startRow = Infinity
	let startCol = Infinity
	let endRow = -1
	let endCol = -1

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i] ?? 0
		const col = cols[i] ?? 0

		startRow = Math.min(startRow, row)
		startCol = Math.min(startCol, col)
		endRow = Math.max(endRow, row)
		endCol = Math.max(endCol, col)
	}

	return { startRow, startCol, endRow, endCol }
}

// Writes texts as typed; undo writes back what the cells held and drops the rows and columns the edit grew.
function setTexts(
	document: TextSheetDocument,
	rows: ArrayLike<number>,
	cols: ArrayLike<number>,
	texts: readonly string[],
	changes: SheetChangeSink
): SheetHandled {
	const count = texts.length

	if (count === 0) return null
	if (count > SHEET_MAX_EDIT_CELLS || rows.length !== count || cols.length !== count) return { refused: { reason: "tooLarge" } }

	for (let i = 0; i < count; i++)
		if ((rows[i] ?? 0) >= SHEET_MAX_ROWS || (cols[i] ?? 0) >= SHEET_MAX_COLS) return { refused: { reason: "tooLarge" } }

	// A windows-1252 file is never re-encoded behind the user's back: a character it cannot hold is refused.
	if (!document.encodable(texts)) return { refused: { reason: "encoding" } }

	const before = new Map<number, string>()
	const widths = new Map<number, number>()
	const rowCount = document.rows.length
	const after = new Map<number, string>()

	for (let i = 0; i < count; i++) {
		const row = rows[i] ?? 0
		const col = cols[i] ?? 0
		const key = cellKey(row, col)

		if (!before.has(key)) before.set(key, document.text(row, col))
		if (!widths.has(row)) widths.set(row, document.rows[row]?.length ?? 0)

		after.set(key, texts[i] ?? "")
	}

	const range = bounds(rows, cols)
	const apply = (values: ReadonlyMap<number, string>, sink: SheetChangeSink, undoing: boolean): void => {
		const rowsBefore = document.rows.length
		const widthBefore = document.width

		for (const [key, text] of values) document.write(Math.floor(key / SHEET_MAX_COLS), key % SHEET_MAX_COLS, text)

		if (undoing) document.shrink(widths, rowCount)

		sink.content(TEXT_SHEET, range)

		// The layout holds the row and column counts alone.
		if (document.rows.length !== rowsBefore || document.width !== widthBefore) sink.layout(TEXT_SHEET)
	}

	apply(after, changes, false)

	let bytes = 64

	for (const text of before.values()) bytes += 48 + text.length * 2
	for (const text of after.values()) bytes += 48 + text.length * 2

	return {
		bytes,
		undo: sink => apply(before, sink, true),
		redo: sink => apply(after, sink, false)
	}
}

// Rows or columns inserted or deleted; an insert past the data moves nothing, so the file stays as it is.
function moveTexts(
	document: TextSheetDocument,
	axis: SheetAxis,
	type: "insert" | "delete",
	at: number,
	count: number,
	changes: SheetChangeSink
): SheetHandled {
	const limit = axis === "rows" ? SHEET_MAX_ROWS : SHEET_MAX_COLS

	if (!Number.isInteger(at) || !Number.isInteger(count) || at < 0 || count <= 0 || at + count > limit)
		return { refused: { reason: "tooLarge" } }
	if (type === "insert" && at >= (axis === "rows" ? document.rows.length : document.width)) return null
	if (type === "insert" && axis === "cols" && document.width + count > SHEET_MAX_COLS) return { refused: { reason: "tooLarge" } }

	let removed: string[][] = []
	const forward = (sink: SheetChangeSink): void => {
		if (axis === "rows") {
			if (type === "insert") {
				// concat, not splice(...spread): a large run would overflow the argument limit.
				document.rows = document.rows.slice(0, at).concat(
					Array.from({ length: count }, (): string[] => []),
					document.rows.slice(at)
				)
			} else {
				removed = document.rows.splice(at, count)
				document.reshaped()
			}
		} else if (type === "insert") {
			const empty = new Array<string>(count).fill("")

			document.rows = document.rows.map(row => (at < row.length ? row.slice(0, at).concat(empty, row.slice(at)) : row))
		} else {
			removed = document.rows.map(row => row.splice(at, count))
			document.reshaped()
		}

		sink.moved(TEXT_SHEET, axis, at, type === "insert" ? count : -count)
		sink.layout(TEXT_SHEET)
	}

	forward(changes)

	let bytes = 64

	for (const row of removed) for (const text of row) bytes += 48 + text.length * 2

	return {
		bytes,
		undo: sink => {
			if (axis === "rows") {
				document.rows =
					type === "insert"
						? document.rows.slice(0, at).concat(document.rows.slice(at + count))
						: document.rows.slice(0, at).concat(removed, document.rows.slice(at))
			} else {
				document.rows = document.rows.map((row, index) => {
					if (type === "insert") return row.length > at + count ? row.slice(0, at).concat(row.slice(at + count)) : row

					const back = removed[index]

					return back === undefined || back.length === 0 ? row : row.slice(0, at).concat(back, row.slice(at))
				})
			}

			sink.moved(TEXT_SHEET, axis, at, type === "insert" ? -count : count)
			sink.layout(TEXT_SHEET)
		},
		redo: sink => forward(sink)
	}
}

// The filled cells of ranges (whole columns cost what the file holds).
function filled(document: TextSheetDocument, ranges: readonly SheetRange[]): { rows: number[]; cols: number[] } | null {
	const rows: number[] = []
	const cols: number[] = []

	for (const range of ranges) {
		const lastRow = Math.min(range.endRow, document.rows.length - 1)

		for (let row = range.startRow; row <= lastRow; row++) {
			const values = document.rows[row] ?? []
			const lastCol = Math.min(range.endCol, values.length - 1)

			for (let col = range.startCol; col <= lastCol; col++) {
				if ((values[col] ?? "") === "") continue
				if (rows.length === SHEET_MAX_EDIT_CELLS) return null

				rows.push(row)
				cols.push(col)
			}
		}
	}

	return { rows, cols }
}

function copyTexts(document: TextSheetDocument, range: SheetRange, cut: boolean): SheetQueryResult<"copy"> {
	const rowCount = range.endRow - range.startRow + 1
	const colCount = range.endCol - range.startCol + 1

	if (rowCount <= 0 || colCount <= 0 || rowCount * colCount > SHEET_MAX_COPY_CELLS) return { refused: "tooLarge" }

	const lines: string[] = []

	for (let row = range.startRow; row <= range.endRow; row++) {
		const fields: string[] = []

		for (let col = range.startCol; col <= range.endCol; col++) fields.push(field(document.text(row, col)))

		lines.push(fields.join("\t"))
	}

	const text = lines.join("\r\n")
	const id = document.copyId()

	document.clip = { id, grid: { tsv: text, sheet: "", range, cut, inputs: new Map() } }

	return { clip: id, text }
}

function lineEnds(text: string): string {
	return text.replace(/\r\n?/g, "\n")
}

function pasteTexts(
	document: TextSheetDocument,
	at: { readonly row: number; readonly col: number },
	text: string,
	clip: number | undefined,
	changes: SheetChangeSink,
	area?: SheetRange
): SheetHandled {
	const held = document.clip
	const own = held !== null && clip === held.id && lineEnds(text) === lineEnds(held.grid.tsv) ? held : null
	const block = pastedCells(text, own?.grid ?? null, at, "", SHEET_MAX_EDIT_CELLS, area)

	if (block === null) return { refused: { reason: "tooLarge" } }
	if (block.cells.length === 0) return null

	const rows = block.cells.map(cell => cell.row)
	const cols = block.cells.map(cell => cell.col)
	const texts = block.cells.map(cell => cell.input)

	// A cut empties its cells first; the paste lands over them.
	if (own?.grid.cut === true) {
		const source = filled(document, [own.grid.range])

		if (source !== null) {
			const pasted = new Set(block.cells.map(cell => cellKey(cell.row, cell.col)))

			source.rows.forEach((row, index) => {
				const col = source.cols[index] ?? 0

				if (pasted.has(cellKey(row, col))) return

				rows.unshift(row)
				cols.unshift(col)
				texts.unshift("")
			})
		}
	}

	const handled = setTexts(document, rows, cols, texts, changes)

	if (handled !== null && !("refused" in handled)) {
		if (own?.grid.cut === true && block.clip !== null) document.clip = { id: own.id, grid: block.clip }

		changes.select(TEXT_SHEET, {
			activeRow: at.row,
			activeCol: at.col,
			ranges: [{ startRow: at.row, startCol: at.col, endRow: at.row + block.rows - 1, endCol: at.col + block.cols - 1 }]
		})
	}

	return handled
}

function fitTexts(document: TextSheetDocument, axis: SheetAxis, index: number, limit: number): SheetQueryResult<"fitSample"> {
	const cap = Math.max(0, Math.min(limit, 1024))
	const kept: { text: string; at: number }[] = []
	const consider = (text: string, at: number): void => {
		if (text === "" || cap === 0) return
		if (kept.length === cap && (kept[cap - 1]?.text.length ?? 0) >= text.length) return

		let to = kept.length

		while (to > 0 && (kept[to - 1]?.text.length ?? 0) < text.length) to--

		kept.splice(to, 0, { text, at })

		if (kept.length > cap) kept.pop()
	}

	if (axis === "cols") document.rows.forEach((row, at) => consider(row[index] ?? "", at))
	else (document.rows[index] ?? []).forEach((text, at) => consider(text, at))

	// Where each text is: its row in a column's sample, its column in a row's.
	const sample = {
		texts: kept.map(entry => entry.text),
		styles: new Uint32Array(kept.length),
		wraps: new Uint8Array(kept.length),
		indices: Uint32Array.from(kept, entry => entry.at)
	}

	return sample
}

const unsupported: SheetHandled = { refused: { reason: "unsupported" } }

export const textFeature = defineSheetFeature<TextSheetDocument>({
	id: "text",
	commands: {
		"cells.set": {
			info: { write: true },
			run: (context, command) => setTexts(context.doc, command.cells.rows, command.cells.cols, command.cells.inputs, context.changes)
		},
		"cells.clear": {
			info: { write: true },
			run: (context, command) => {
				// A text file has no formats to clear.
				if (command.what === "formats") return null

				const cells = filled(context.doc, command.ranges)

				return cells === null
					? { refused: { reason: "tooLarge" } }
					: setTexts(
							context.doc,
							cells.rows,
							cells.cols,
							cells.rows.map(() => ""),
							context.changes
						)
			}
		},
		"axis.insert": {
			info: { write: true },
			run: (context, command) => moveTexts(context.doc, command.axis, "insert", command.at, command.count, context.changes)
		},
		"axis.delete": {
			info: { write: true },
			run: (context, command) => moveTexts(context.doc, command.axis, "delete", command.at, command.count, context.changes)
		},
		// Sizes of a text file live beside it (the app's size layer), formats and sheets nowhere.
		"axis.resize": { info: { write: true }, run: () => unsupported },
		"format.apply": { info: { write: true }, run: () => unsupported },
		"clipboard.paste": {
			info: { write: true },
			// A text file's cells hold their text: a values paste is the text read as tab-separated values.
			run: (context, command) =>
				pasteTexts(
					context.doc,
					command.at,
					command.text,
					command.values === true ? undefined : command.clip,
					context.changes,
					command.target
				)
		},
		// Changes no file: no step, and a read-only text file freezes too.
		"view.freeze": {
			info: { write: false },
			run: (context, command) => {
				const { rows, cols } = command
				const topRow = command.topRow ?? rows
				const leftCol = command.leftCol ?? cols

				if (
					![rows, cols, topRow, leftCol].every(Number.isInteger) ||
					rows < 0 ||
					cols < 0 ||
					topRow < rows ||
					leftCol < cols ||
					topRow >= SHEET_MAX_ROWS ||
					leftCol >= SHEET_MAX_COLS
				)
					return { refused: { reason: "tooLarge" } }

				context.doc.pane = rows === 0 && cols === 0 ? null : { rows, cols, firstRow: 0, firstCol: 0, topRow, leftCol }
				context.changes.layout(TEXT_SHEET)

				return null
			}
		}
	},
	queries: {
		copy: { run: (context, request) => copyTexts(context.doc, request.range, request.cut) },
		fitSample: { run: (context, request) => fitTexts(context.doc, request.axis, request.index, request.limit) }
	}
})

export type TextSessionOpen =
	| ({ readonly kind: "opened" } & SheetOpened & { readonly session: SheetSession<TextSheetDocument> })
	| { readonly kind: "failed"; readonly reason: SheetOpenFailure; readonly message: string }
	| { readonly kind: "aborted" }

// Opens a CSV (separator detected), a TSV or a .tab (tab-separated) as a session.
export async function openTextSession(
	bytes: Uint8Array,
	options: SheetSessionOptions & { readonly slicing?: Slicing },
	onEvent: (event: SheetEvent) => void,
	features: readonly SheetFeature<TextSheetDocument>[] = []
): Promise<TextSessionOpen> {
	if (options.signal?.aborted === true) return { kind: "aborted" }

	let parsed: ReturnType<typeof parseCsvFile>

	try {
		// Refused as the parse passes a limit, before the rows of a hostile file fill memory; a file longer than a sheet
		// opens with its first rows, view-only.
		parsed = parseCsvFile(bytes, options.kind === "tsv" || options.kind === "tab", {
			...(options.settings?.locale !== undefined && { listSeparator: options.settings.locale.argument }),
			limits: { maxCells: MAX_TEXT_CELLS, maxRows: SHEET_MAX_ROWS, keepFirstRows: true }
		})
	} catch (error) {
		return { kind: "failed", reason: "tooLarge", message: error instanceof Error ? error.message : String(error) }
	}

	const styles = new RenderStyleTable()
	const document = new TextSheetDocument(bytes, parsed.rows, parsed.format, options.kind, options.settings, parsed.complete)
	const session = new SheetSession(
		document,
		styles,
		{
			features: own =>
				sheetRegistry([
					textFeature,
					textFindFeature,
					textNavigateFeature,
					textSelectionStatsFeature,
					textFillFeature,
					textAutoCompleteFeature,
					textShiftFeature,
					textSortFeature,
					textClipboardHtmlFeature,
					...features,
					sessionFeature(own)
				])
		},
		options,
		onEvent
	)
	const info = await session.start(options.signal)

	return { kind: "opened", session, info }
}

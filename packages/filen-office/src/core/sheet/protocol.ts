import type { ByteSource } from "../opc/io"
import type { Slicing } from "../slicing"
import type { NumFmtLocale } from "./numfmt/locale"

// The spreadsheet engine as a renderer and an app call it, whether it runs in a worker (web) or on the calling
// thread (mobile, under Hermes). Every message is plain data: numbers, strings, plain objects and typed arrays.
// Every typed array in a message owns its whole buffer (never a view into the engine's store), so a worker host
// transfers it instead of copying. A host runs the calls of one session in the order they were made, and
// answers them in that order; events interleave between answers. A client that applies answers and events in
// arrival order therefore never sees a tile older than a change it already applied.
//
// Extension: commands, queries, tile layers, layout extensions, refusal reasons and cell details are open maps
// (SheetCommandMap and its siblings). A feature declares its entries in its own module by declaration merging:
//
//     declare module "../protocol" {
//         interface SheetCommandMap {
//             "merge.cells": { readonly sheet: SheetId; readonly ranges: readonly SheetRange[]; readonly center: boolean }
//         }
//     }
//
// and registers the handlers for them (registry.ts). Names are "<feature>.<verb>"; one feature owns a name.

// --- Grid ---

// Excel's own grid ("Excel specifications and limits"). Rows and columns are 0-based everywhere here.
export const SHEET_MAX_ROWS = 1_048_576
export const SHEET_MAX_COLS = 16_384
// What one cell holds there: characters of text, and of a formula's contents.
export const SHEET_MAX_CELL_TEXT = 32_767
export const SHEET_MAX_FORMULA_TEXT = 8_192
// What of a cell's text a tile carries: no cell paints more (Excel 2000 and 2003 documented "Only 1,024 display in
// a cell; all 32,767 display in the formula bar"), and a tile of 2,048 cells stays a few MB. The cell query gives
// the whole input.
export const SHEET_TILE_TEXT = 1_024

// A text cut at SHEET_TILE_TEXT, never between the halves of a surrogate pair.
export function tileText(text: string): string {
	if (text.length <= SHEET_TILE_TEXT) return text

	const code = text.charCodeAt(SHEET_TILE_TEXT - 1)

	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? SHEET_TILE_TEXT - 1 : SHEET_TILE_TEXT)
}

// Cells one edit, paste or clear may name, and cells one copy may hold.
export const SHEET_MAX_EDIT_CELLS = 200_000
export const SHEET_MAX_COPY_CELLS = 1_000_000

// A tile: TILE_ROWS by TILE_COLS cells, aligned to multiples of its size. A cell's position inside its tile,
// (row % TILE_ROWS) * TILE_COLS + col % TILE_COLS, fits a Uint16.
export const TILE_ROWS = 64
export const TILE_COLS = 32
export const TILE_CELLS = TILE_ROWS * TILE_COLS
const TILE_ROW_BITS = 6
const TILE_COL_BITS = 5
// Tile rows per sheet (16,384) times tile columns (512): 23 bits, so a key stays an exact double for any sheet id
// below 2^30.
const TILE_COLS_PER_SHEET = SHEET_MAX_COLS / TILE_COLS
const TILES_PER_SHEET = (SHEET_MAX_ROWS / TILE_ROWS) * TILE_COLS_PER_SHEET

// A session's sheets by an id that follows the sheet through renames, moves and the deletion of others, and is
// never reused in the session. Not the file's sheetId attribute.
export type SheetId = number

// Inclusive bounds.
export interface SheetRange {
	readonly startRow: number
	readonly startCol: number
	readonly endRow: number
	readonly endCol: number
}

export interface SheetRegion extends SheetRange {
	readonly sheet: SheetId
}

export interface SheetCell {
	readonly sheet: SheetId
	readonly row: number
	readonly col: number
}

export type SheetAxis = "rows" | "cols"

export function tileKey(sheet: SheetId, tileRow: number, tileCol: number): number {
	return sheet * TILES_PER_SHEET + tileRow * TILE_COLS_PER_SHEET + tileCol
}

export function tileKeySheet(key: number): SheetId {
	return Math.floor(key / TILES_PER_SHEET)
}

export function tileKeyRow(key: number): number {
	return Math.floor((key % TILES_PER_SHEET) / TILE_COLS_PER_SHEET)
}

export function tileKeyCol(key: number): number {
	return key % TILE_COLS_PER_SHEET
}

// The key of the tile holding a cell.
export function cellTileKey(sheet: SheetId, row: number, col: number): number {
	return tileKey(sheet, row >>> TILE_ROW_BITS, col >>> TILE_COL_BITS)
}

// A cell's position inside its tile.
export function tilePosition(row: number, col: number): number {
	return ((row & (TILE_ROWS - 1)) << TILE_COL_BITS) | (col & (TILE_COLS - 1))
}

// --- Tiles ---

// Per tile entry, in SheetTileData.flags.
export const CellFlag = {
	// The value is a number (dates and times included): General alignment puts it right.
	NUMBER: 1 << 0,
	BOOLEAN: 1 << 1,
	ERROR: 1 << 2,
	FORMULA: 1 << 3,
	// The cell's own format is Text ("@"): an entry typed here is kept as text. A cell without an entry takes its
	// row's AxisFlag.TEXT_FORMAT when the row is STYLED, else its column's.
	TEXT_FORMAT: 1 << 4,
	// Text with runs of its own format (the "runs" layer).
	RICH: 1 << 5,
	// The number format repeats a character to fill the cell ("*" in the code; the "repeats" layer).
	REPEAT: 1 << 6,
	// A result this app does not calculate: the file's cached value is shown (and kept on save).
	CACHED: 1 << 7,
	// Under sheet protection: the cell cannot be edited, or its formula is not shown (input is -1).
	LOCKED: 1 << 8,
	FORMULA_HIDDEN: 1 << 9,
	NOTE: 1 << 10,
	THREADED_COMMENT: 1 << 11,
	HYPERLINK: 1 << 12,
	// Data validation offers a list: the grid draws a dropdown button on the active cell.
	LIST: 1 << 13,
	// The top-left cell of a dynamic array's spill range, and the cells the spill fills.
	SPILL_ANCHOR: 1 << 14,
	SPILL: 1 << 15,
	// The value breaks the cell's data validation.
	INVALID: 1 << 16,
	// The text or input is cut at SHEET_TILE_TEXT: the cell query gives the whole input to edit.
	CLIPPED: 1 << 17,
	// Conditional formatting draws a data bar (the "cfBars" layer) or an icon (the "cfIcons" layer) in the cell.
	CF_BAR: 1 << 18,
	CF_ICON: 1 << 19
	// Bits 20-31 are free for features: claim one here, never reuse one.
} as const

// One tile's cells, sparse: only the cells with something to draw or to know (a value, a style other than the
// default, a flag), in row-major order of `positions`.
export interface SheetTileData {
	readonly count: number
	// Position in the tile (tilePosition), ascending.
	readonly positions: Uint16Array
	// Index into `strings`: what the cell shows (its value through its number format, a formula's result); -1
	// for nothing.
	readonly texts: Int32Array
	// Index into `strings`: what editing the cell starts from when that is not its text ("=SUM(A1:A3)", or
	// 1234.5 shown as "$1,234.50"); -1 when it starts from the text (or empty).
	readonly inputs: Int32Array
	// Index into the session's render styles (SheetRenderStyle): the cell's effective look, after its number
	// format's colour and conditional formatting. 0 is the workbook's default.
	readonly styles: Uint32Array
	// CellFlag bits.
	readonly flags: Uint32Array
	// The tile's own string table: each string once per tile.
	readonly strings: readonly string[]
	readonly layers?: SheetTileLayers
}

export interface SheetTile extends SheetTileData {
	readonly sheet: SheetId
	readonly tileRow: number
	readonly tileCol: number
	// The session version (SheetDocState.version) the tile was built at.
	readonly version: number
}

// A change to a tile the client holds. "merge": the entries replace the cells at the same positions and
// `cleared` positions become empty; "replace": the data replaces the whole tile.
export interface SheetTilePatch extends SheetTile {
	readonly mode: "merge" | "replace"
	readonly cleared?: Uint16Array
}

// Optional per-tile data beyond the base arrays, by layer name. Entry indices refer to the tile's entries.
export interface SheetTileLayerMap {
	// Rich text: for each RICH entry, its runs. runEntries[i] is the entry of run i, runStarts[i] the UTF-16
	// offset in the entry's text where it starts, runStyles[i] its render style. A run lasts until the next run
	// of the same entry, or the text's end.
	readonly runs: {
		readonly runEntries: Uint16Array
		readonly runStarts: Uint32Array
		readonly runStyles: Uint32Array
	}
	// A number format's "*x": for each REPEAT entry, where in its text the fill goes and the character repeated
	// there to fill the cell's width.
	readonly repeats: {
		readonly entries: Uint16Array
		readonly offsets: Uint32Array
		readonly chars: readonly string[]
	}
}

export type SheetTileLayerName = keyof SheetTileLayerMap & string

export type SheetTileLayers = { readonly [L in SheetTileLayerName]?: SheetTileLayerMap[L] }

// --- Render styles ---

// 0xRRGGBB, theme and tint already applied. Never a CSS string: a renderer formats it.
export type SheetRgb = number

export type SheetBorderStyle =
	| "thin"
	| "medium"
	| "thick"
	| "dashed"
	| "dotted"
	| "double"
	| "hair"
	| "mediumDashed"
	| "dashDot"
	| "mediumDashDot"
	| "dashDotDot"
	| "mediumDashDotDot"
	| "slantDashDot"

export interface SheetBorderLine {
	readonly style: SheetBorderStyle
	readonly color: SheetRgb
}

// ECMA-376 §18.18.55 ST_PatternType, "none" and "solid" excepted (those are `fill` or nothing).
export type SheetPatternType =
	| "mediumGray"
	| "darkGray"
	| "lightGray"
	| "darkHorizontal"
	| "darkVertical"
	| "darkDown"
	| "darkUp"
	| "darkGrid"
	| "darkTrellis"
	| "lightHorizontal"
	| "lightVertical"
	| "lightDown"
	| "lightUp"
	| "lightGrid"
	| "lightTrellis"
	| "gray125"
	| "gray0625"

export type SheetHorizontalAlign = "left" | "center" | "right" | "fill" | "justify" | "centerContinuous" | "distributed"

export type SheetVerticalAlign = "top" | "center" | "bottom" | "justify" | "distributed"

export type SheetUnderline = "single" | "double" | "singleAccounting" | "doubleAccounting"

// How a cell looks, resolved from its format (cell xf, font, fill, border, alignment, number format colour,
// conditional formatting): what a grid draws. Absent fields are the default's. Styles are interned by the
// session, so equal looks share an index.
export interface SheetRenderStyle {
	// The family named in the file. A renderer maps it to a face it has; it never goes into CSS unchecked.
	readonly font?: string
	// Points.
	readonly size?: number
	readonly bold?: boolean
	readonly italic?: boolean
	readonly strike?: boolean
	readonly underline?: SheetUnderline
	readonly script?: "superscript" | "subscript"
	readonly color?: SheetRgb
	// A solid background, or a gradient's average.
	readonly fill?: SheetRgb
	readonly pattern?: { readonly type: SheetPatternType; readonly color: SheetRgb; readonly background: SheetRgb }
	readonly align?: SheetHorizontalAlign
	readonly valign?: SheetVerticalAlign
	readonly wrap?: boolean
	readonly shrink?: boolean
	// Indent levels (three spaces' width each, as Excel draws them).
	readonly indent?: number
	// Degrees counter-clockwise, -90 to 90; 255 for text stacked vertically.
	readonly rotation?: number
	readonly rightToLeft?: boolean
	readonly top?: SheetBorderLine
	readonly right?: SheetBorderLine
	readonly bottom?: SheetBorderLine
	readonly left?: SheetBorderLine
	readonly diagonalUp?: SheetBorderLine
	readonly diagonalDown?: SheetBorderLine
}

// Render styles a client does not have yet: they take indices from..from + styles.length - 1.
export interface SheetStyleAppend {
	readonly from: number
	readonly styles: readonly SheetRenderStyle[]
}

// --- Workbook and sheets ---

// "ods" and "ots" open view-only (an OpenDocument spreadsheet and its template).
export type SheetFileKind = "xlsx" | "xlsm" | "xltx" | "xltm" | "xls" | "xlt" | "ods" | "ots" | "csv" | "tsv" | "tab"

export type SheetState = "visible" | "hidden" | "veryHidden"

export type SheetKind = "worksheet" | "chartsheet" | "dialogsheet" | "macrosheet"

export interface SheetSummary {
	readonly id: SheetId
	readonly name: string
	readonly state: SheetState
	readonly kind: SheetKind
	readonly tabColor?: SheetRgb
	// Parsed: its layout and tiles answer at once. A sheet not parsed yet is parsed when first asked for, or in
	// idle slices after the active one (a "sheetReady" event).
	readonly ready: boolean
}

// The rows or columns that differ from the default (size, visibility, outline or style), ascending by index. An
// entry may stand for a run of indices alike (`counts`): an OpenDocument sheet's hidden rows to the grid's end cost
// one entry, not a million.
export interface SheetAxisLayout {
	// Pixels at 100 %.
	readonly defaultSize: number
	readonly indices: Uint32Array
	readonly sizes: Float32Array
	// The render style of the row's or column's cells that have no tile entry (0: the default). A row's beats a
	// column's when the row is STYLED.
	readonly styles: Uint32Array
	// AxisFlag bits.
	readonly flags: Uint16Array
	// How many indices from indices[k] on entry k stands for (at least 1); absent: one each. Entries never overlap.
	readonly counts?: Uint32Array
}

export const AxisFlag = {
	HIDDEN: 1 << 0,
	// The size was set by the user (customHeight, customWidth) rather than fitted to the content.
	CUSTOM: 1 << 1,
	COLLAPSED: 1 << 2,
	// Bits 3-5: outline level 0-7.
	OUTLINE_SHIFT: 3,
	OUTLINE_MASK: 0b111 << 3,
	// Has a style of its own (a row: customFormat).
	STYLED: 1 << 6,
	// Its style's number format is Text ("@").
	TEXT_FORMAT: 1 << 7
} as const

export interface SheetPane {
	// Frozen rows and columns (0 for none), from `firstRow` and `firstCol`: the first frozen row and column, which
	// need not be the sheet's first (the rows above and the columns left of them are not shown, as in Excel).
	readonly rows: number
	readonly cols: number
	readonly firstRow: number
	readonly firstCol: number
	// The first cell of the scrolling pane, past the frozen rows and columns; on an axis with none frozen, where the
	// view starts.
	readonly topRow: number
	readonly leftCol: number
}

export interface SheetSelectionState {
	readonly activeRow: number
	readonly activeCol: number
	readonly ranges: readonly SheetRange[]
}

// A sheet's protection, as the grid and menus honour it (§18.3.1.85): what is allowed while protected.
export interface SheetProtectionState {
	readonly hasPassword: boolean
	readonly allows: ReadonlySet<SheetProtectedAction>
}

export type SheetProtectedAction =
	| "selectLockedCells"
	| "selectUnlockedCells"
	| "formatCells"
	| "formatColumns"
	| "formatRows"
	| "insertColumns"
	| "insertRows"
	| "insertHyperlinks"
	| "deleteColumns"
	| "deleteRows"
	| "sort"
	| "autoFilter"
	| "pivotTables"
	| "objects"
	| "scenarios"

export interface SheetLayout {
	readonly sheet: SheetId
	readonly version: number
	// The used area: at least past the last cell with content, format, merge or anything anchored to cells.
	readonly rowCount: number
	readonly colCount: number
	readonly rows: SheetAxisLayout
	readonly cols: SheetAxisLayout
	// Merged ranges as quads: startRow, startCol, endRow, endCol.
	readonly merges: Uint32Array
	readonly pane: SheetPane | null
	readonly selection?: SheetSelectionState
	// Percent.
	readonly zoom: number
	readonly gridLines: boolean
	readonly headings: boolean
	readonly rightToLeft: boolean
	readonly protection: SheetProtectionState | null
	readonly extensions?: SheetLayoutExtensions
}

// Per-sheet data features add to the layout (filter buttons, drawing anchors, print areas), by name. `_reserved`
// only keeps the map from being empty until a feature declares an entry.
export interface SheetLayoutExtensionMap {
	readonly _reserved?: never
}

export type SheetLayoutExtensionName = Exclude<keyof SheetLayoutExtensionMap, "_reserved"> & string

export type SheetLayoutExtensions = { readonly [K in SheetLayoutExtensionName]?: SheetLayoutExtensionMap[K] }

export interface SheetLayoutPatch {
	readonly sheet: SheetId
	// Only what changed; an absent field keeps its value.
	readonly layout: Partial<Omit<SheetLayout, "sheet">>
}

// --- Writability ---

// Why a session opened read-only, or became so. The app turns each into its message.
//   legacyFormat   .xls / .xlt: only "save as .xlsx"
//   lossy          saving would lose part of the file (the gate's proof failed)
//   tooLarge       too large to prove that saving loses nothing
//   unsafe         a text file that would not save back as it was (encoding, line ends, quoting)
//   signed         digitally signed: an edit would break the signature
//   readOnlyRecommended  the author asked for read-only (fileSharing) and the user did not choose to edit
//   modifyPassword the file's password to modify was not given
//   incomplete     a text file longer than a sheet: only its first SHEET_MAX_ROWS records were read
export type SheetViewOnlyReason =
	"legacyFormat" | "lossy" | "tooLarge" | "unsafe" | "signed" | "readOnlyRecommended" | "modifyPassword" | "incomplete"

// A workbook opens unproven: the gate runs once the app says the user set out to edit (SheetSessionApi.intent),
// and an edit sent before the verdict waits for it.
export type SheetWritability =
	| { readonly state: "unproven" }
	| { readonly state: "checking" }
	| { readonly state: "writable" }
	| { readonly state: "viewOnly"; readonly reason: SheetViewOnlyReason }

export interface SheetWorkbookProtection {
	// lockStructure: sheets cannot be added, deleted, moved, renamed, hidden or unhidden.
	readonly structure: boolean
	readonly windows: boolean
	readonly hasPassword: boolean
}

export interface SheetFileSharing {
	readonly readOnlyRecommended: boolean
	// A password to modify is set (§18.2.12): editing needs it.
	readonly modifyPassword: boolean
	readonly userName?: string
}

// What a workbook says of itself beyond its title (ECMA-376 Part 2 §11.1: dc:creator, dc:subject, cp:keywords); each
// whitespace-collapsed and present only when not blank.
export interface SheetDocumentProperties {
	readonly author?: string
	readonly subject?: string
	readonly keywords?: string
}

export interface SheetWorkbookInfo {
	readonly kind: SheetFileKind
	readonly sheets: readonly SheetSummary[]
	readonly activeSheet: SheetId
	// The layout of the active sheet, ready at open.
	readonly activeLayout: SheetLayout
	readonly styles: SheetStyleAppend
	readonly writability: SheetWritability
	readonly state: SheetDocState
	readonly date1904: boolean
	readonly protection: SheetWorkbookProtection | null
	readonly fileSharing: SheetFileSharing | null
	// The workbook's own title (docProps/core.xml dc:title, an OpenDocument spreadsheet's meta.xml dc:title); absent:
	// it names none (a PDF of it is titled from its file name).
	readonly title?: string
	// The workbook's author, subject and keywords (docProps/core.xml); absent: none named. A PDF of it carries them.
	readonly properties?: SheetDocumentProperties
	// The file was password-protected: opened decrypted, and every save is sealed. verified: the Agile HMAC
	// matched; unchecked: the file carries none.
	readonly encrypted?: "verified" | "unchecked"
}

export interface SheetDocState {
	// Increases with every change to what tiles show, layouts or the sheet list (edits, undo, redo,
	// recalculation). Tiles and changes carry the version they were made at.
	readonly version: number
	// Differs from what was opened or last saved.
	readonly dirty: boolean
	readonly canUndo: boolean
	readonly canRedo: boolean
}

// --- Commands ---

// Edits as data. Sheets by SheetId; inputs as typed (the session parses them with the session's locale).
export interface SheetCommandMap {
	// Entries as typed into cells: "" empties a cell's content, "=..." is a formula, "'..." is text.
	"cells.set": { readonly sheet: SheetId; readonly cells: SheetCellInputs }
	"cells.clear": { readonly sheet: SheetId; readonly ranges: readonly SheetRange[]; readonly what: "contents" | "formats" | "all" }
	"format.apply": { readonly sheet: SheetId; readonly ranges: readonly SheetRange[]; readonly patch: SheetFormatPatch }
	"axis.insert": SheetAxisMove
	"axis.delete": SheetAxisMove
	// Pixel sizes at 100 %; NaN takes an index back to the default size.
	"axis.resize": { readonly sheet: SheetId; readonly axis: SheetAxis; readonly indices: Uint32Array; readonly sizes: Float32Array }
	// At `index` in the sheet order (default: after the last); a name the session proposes when absent.
	"sheet.add": { readonly name?: string; readonly index?: number }
	"sheet.rename": { readonly sheet: SheetId; readonly name: string }
	// Text from the clipboard put at `at`. When `clip` names a copy this session made (SheetQueryMap "copy") and the
	// text is still that copy's, the copy is pasted instead (formulas moved relative to `at`, formats; a cut moves
	// its cells), else the text is read as tab-separated values. `values` pastes values only (Paste Values): the copy's
	// values in full and formulas' results, without formats; a cut is then a copy. `target` is the paste area, the
	// selection starting at `at`: one whose height and width are whole multiples of the pasted block takes it that
	// many times, as Excel fills it (each copy's relative references moved to its own origin); a cut, any other area,
	// or one whose copies would cut through a merged cell takes it once.
	"clipboard.paste": {
		readonly sheet: SheetId
		readonly at: { readonly row: number; readonly col: number }
		readonly text: string
		readonly clip?: number
		readonly values?: boolean
		readonly target?: SheetRange
	}
	// Rows of `range` (columns when `orientation` is "cols") ordered by `keys`, the first key first. Values order as
	// Excel does: numbers, text, booleans, errors, then blanks, whatever the direction.
	"sort.apply": {
		readonly sheet: SheetId
		readonly range: SheetRange
		readonly orientation: "rows" | "cols"
		readonly header: boolean
		readonly caseSensitive: boolean
		// Column (row) indices in the sheet.
		readonly keys: readonly { readonly index: number; readonly descending: boolean }[]
	}
}

// `count` rows (columns) from `at`.
export interface SheetAxisSpan {
	readonly at: number
	readonly count: number
}

// Rows or columns inserted or deleted: one span, or several at once (a selection of several ranges), as Excel does
// them: an insert puts each span's count before it, a delete takes every span; spans are where they are before the
// edit, in any order, and none may overlap another (refused: multipleSelection, "overlapping"). One undo step.
export type SheetAxisMove = { readonly sheet: SheetId; readonly axis: SheetAxis } & (
	{ readonly at: number; readonly count: number } | { readonly spans: readonly SheetAxisSpan[] }
)

// Columnar cell entries: rows[i], cols[i], inputs[i].
export interface SheetCellInputs {
	readonly rows: Uint32Array
	readonly cols: Uint16Array
	readonly inputs: readonly string[]
}

// A theme colour (§20.1.6.2 index) with an optional tint (-1..1), or a fixed colour.
export type SheetColorInput = SheetRgb | { readonly theme: number; readonly tint?: number }

// What a format command changes. null clears a property back to the default.
export interface SheetFormatPatch {
	readonly bold?: boolean
	readonly italic?: boolean
	readonly strike?: boolean
	readonly underline?: SheetUnderline | null
	readonly script?: "superscript" | "subscript" | null
	readonly font?: string | null
	readonly size?: number | null
	readonly color?: SheetColorInput | null
	readonly fill?: SheetColorInput | null
	readonly align?: SheetHorizontalAlign | null
	readonly valign?: SheetVerticalAlign | null
	readonly wrap?: boolean
	readonly shrink?: boolean
	readonly indent?: number
	readonly rotation?: number
	// A number format code; "General" clears it.
	readonly numFmt?: string
	readonly locked?: boolean
	readonly formulaHidden?: boolean
}

export type SheetCommandType = keyof SheetCommandMap & string

export type SheetCommandOf<T extends SheetCommandType> = { readonly type: T } & SheetCommandMap[T]

export type SheetCommand = { [T in SheetCommandType]: SheetCommandOf<T> }[SheetCommandType]

// --- Queries ---

// Reads that change nothing, as { request, result }.
export interface SheetQueryMap {
	// The cells to copy: tab-separated text for the clipboard, and a clip id a paste of that text can name (the
	// session holds its latest copy only).
	copy: {
		request: { readonly sheet: SheetId; readonly range: SheetRange; readonly cut: boolean }
		result: { readonly clip: number; readonly text: string } | { readonly refused: "tooLarge" }
	}
	// Matches in order from `from` (exclusive), row by row, wrapping round; at most `limit` and a `more` flag.
	find: {
		request: {
			readonly scope: { readonly sheet: SheetId } | "workbook"
			// Only these ranges of the scope's sheet (a selection of more than one cell, as Excel searches it); the
			// whole scope when absent.
			readonly within?: readonly SheetRange[]
			readonly text: string
			readonly matchCase: boolean
			readonly wholeCell: boolean
			readonly lookIn: "values" | "formulas"
			readonly from?: SheetCell
			// Where the walk starts: after `from` (the default), round to `from` itself; or at `from`, round to the cell
			// before it; or "before": the matches before `from` (the walk at it), the last `limit` of them.
			readonly start?: "after" | "at" | "before"
			readonly limit: number
		}
		// Triples: sheet, row, col.
		result: { readonly cells: Uint32Array; readonly more: boolean; readonly version: number }
	}
	// Where Ctrl+arrow lands from `from`: the edge of the data region, or of the used area.
	navigate: {
		request: {
			readonly sheet: SheetId
			readonly row: number
			readonly col: number
			readonly direction: "up" | "down" | "left" | "right"
			readonly to: "dataEdge" | "usedEdge"
		}
		result: { readonly row: number; readonly col: number }
	}
	// The data region around a cell (Ctrl+A, Ctrl+Shift+*): bounded by blank rows and columns.
	dataRegion: {
		request: { readonly sheet: SheetId; readonly row: number; readonly col: number }
		result: SheetRange
	}
	// The cells autofit measures for one column or row: the `limit` longest texts with their render styles (the
	// renderer measures them; the core has no fonts), and where each is: its row (a column's sample) or its column
	// (a row's sample, so a wrapped text is measured at its column's width).
	fitSample: {
		request: { readonly sheet: SheetId; readonly axis: SheetAxis; readonly index: number; readonly limit: number }
		result: {
			readonly texts: readonly string[]
			readonly styles: Uint32Array
			readonly wraps: Uint8Array
			readonly indices: Uint32Array
		}
	}
	// What a cell holds beyond its tile entry.
	cell: {
		request: SheetCell
		result: SheetCellDetail
	}
	// Which commands can run on a selection, for menus and toolbars: refused ones with why.
	commandState: {
		request: {
			readonly sheet: SheetId
			readonly ranges: readonly SheetRange[]
			readonly types: readonly SheetCommandType[]
		}
		result: { readonly enabled: readonly boolean[]; readonly reasons: readonly (SheetRefusalReason | null)[] }
	}
}

export interface SheetCellDetail {
	readonly input: string
	readonly numFmt: string
	readonly style: number
	readonly flags: number
	readonly details?: SheetCellDetails
}

// Per-cell data features add to SheetCellDetail (a note's text, a hyperlink, a validation's list), by name, as
// SheetLayoutExtensionMap.
export interface SheetCellDetailMap {
	readonly _reserved?: never
}

export type SheetCellDetailName = Exclude<keyof SheetCellDetailMap, "_reserved"> & string

export type SheetCellDetails = { readonly [K in SheetCellDetailName]?: SheetCellDetailMap[K] }

export type SheetQueryName = keyof SheetQueryMap & string

export type SheetQueryRequest<Q extends SheetQueryName> = SheetQueryMap[Q]["request"]

export type SheetQueryResult<Q extends SheetQueryName> = SheetQueryMap[Q]["result"]

// --- Results ---

// Why a command did not run. An edit the writer could not hold is refused here, never dropped at save.
export interface SheetRefusalReasons {
	// The session is view-only (SheetWritability).
	readOnly: true
	// Past the grid's limits, or more cells than one edit takes.
	tooLarge: true
	// Invalid or taken (sheet names are unique whatever their case).
	sheetName: true
	// Would leave no visible sheet.
	lastSheet: true
	// A formula that does not read as one.
	formula: true
	// Would change part of an array formula's range.
	arrayFormula: true
	// Would rename a table column by editing its header.
	tableHeader: true
	// Something here refers to cells in a way the session cannot move (detail: the construct).
	structureLocked: true
	// Would move or cut through a pivot table.
	pivot: true
	// Merged cells in the way (a sort, a partial merge).
	merged: true
	// Sheet protection forbids it (detail: the protected action), or the cell is locked.
	protectedSheet: true
	// The workbook's structure is protected.
	protectedWorkbook: true
	// A character the text file's legacy encoding cannot hold.
	encoding: true
	// More cell formats than a workbook holds (Excel: 64,000).
	styleLimit: true
	// The file format cannot hold the result.
	unsupported: true
	// The selection's ranges cannot be taken together (Excel's "Cannot use that command on overlapping selections",
	// detail "overlapping"; "That command cannot be used on multiple selections", detail "mixed": whole rows with
	// whole columns).
	multipleSelection: true
}

export type SheetRefusalReason = keyof SheetRefusalReasons & string

export interface SheetRefusal {
	readonly reason: SheetRefusalReason
	// What refused, for a log or a more specific message: a construct, a protected action.
	readonly detail?: string
}

// What changed, for a client holding tiles and layouts. A client drops cached tiles of `invalidated` regions
// that no patch replaced, folds `patches` into the tiles it holds, and applies the rest.
export interface SheetChange {
	readonly state: SheetDocState
	readonly patches: readonly SheetTilePatch[]
	readonly invalidated: readonly SheetRegion[]
	readonly layouts: readonly SheetLayoutPatch[]
	// The whole sheet list, when it changed (order, names, states, sheets added or deleted).
	readonly sheets?: readonly SheetSummary[]
	readonly styles?: SheetStyleAppend
	// Where the selection goes (a paste, an undo).
	readonly selection?: { readonly sheet: SheetId } & SheetSelectionState
}

export type SheetCommandResult =
	| { readonly ok: true; readonly change: SheetChange }
	| { readonly ok: false; readonly refusal: SheetRefusal; readonly state: SheetDocState }

// --- Save ---

export type SheetSaveFailure =
	// The independent re-read of the saved package did not equal the session (nothing is handed out).
	| "gate"
	// Sealing a protected workbook failed, or its check did.
	| "seal"
	| "closed"
	| "aborted"

export type SheetSaveResult =
	| {
			readonly ok: true
			// For a protected workbook, the sealed compound file, never its zip.
			readonly bytes: Uint8Array
			// What markSaved names once the bytes are stored.
			readonly version: number
			readonly encrypted: boolean
			readonly changedParts: readonly string[]
	  }
	| { readonly ok: false; readonly reason: SheetSaveFailure; readonly message: string }

// --- Events ---

export type SheetEvent =
	// A sheet was parsed in an idle slice.
	| { readonly type: "sheetReady"; readonly sheet: SheetSummary; readonly layout: SheetLayout }
	| { readonly type: "writability"; readonly writability: SheetWritability }
	// The formula engine, built on edit intent: an edit before "ready" waits for it.
	| { readonly type: "engine"; readonly state: "building" | "ready" | "failed" }
	// Results that arrived after an edit's answer (a recalculation finished in slices).
	| { readonly type: "change"; readonly change: SheetChange }
	| { readonly type: "progress"; readonly task: "open" | "proof" | "save" | "find"; readonly done: number; readonly total: number }
	// A feature could not read what it shows on a sheet (a damaged part beside the sheet's own): it shows nothing there
	// and refuses its commands on that sheet; the file's parts are saved as they were.
	| { readonly type: "featureUnavailable"; readonly sheet: SheetId; readonly feature: string; readonly message: string }
	// The workbook's circular references changed (none while it calculates iteratively, as Excel reports none): the
	// first formula cell on one of each sheet that has one, by row then column (Excel's status bar names the active
	// sheet's: "Circular References: B1"); empty once none is left. `introduced`: an edit, or the engine's build,
	// made a circle that was not one before, which Excel warns of once.
	| { readonly type: "circularReferences"; readonly cells: readonly SheetCell[]; readonly introduced: boolean }
	// The session cannot go on (its worker died, or the active sheet is damaged past the preview it opened on): every
	// call rejects from now on.
	| { readonly type: "failed"; readonly message: string }

// --- Session ---

// An AbortSignal, or anything with `aborted`.
export interface SheetAbortSignal {
	readonly aborted: boolean
	addEventListener?(type: "abort", listener: () => void): void
	removeEventListener?(type: "abort", listener: () => void): void
}

// Locale data the app injects (the core reads no Intl locale). Entries are parsed with it; files always store
// en-US syntax and English function names.
export interface SheetLocale {
	readonly decimal: string
	readonly group: string
	// Between function arguments as typed ("," or ";").
	readonly argument: string
	readonly dateOrder: "mdy" | "dmy" | "ymd"
	// The currency symbols text reads as a number with ("$4.00"+1, "5 €"*1). Without them, "$" where "." is the
	// decimal point.
	readonly currencies?: readonly string[]
	// What numbers and dates show in, as the system's regional settings in Excel: the short date of built-in 14 and
	// 22, the long date and time of [$-F800] and [$-F400], month and day names, AM and PM, the separators. With it a
	// date typed in the locale's order takes built-in 14 (22 with h:mm after it). Without it, en-US's with `decimal`
	// and `group`. Codes in files are never changed.
	readonly numFmt?: NumFmtLocale
}

export interface SheetSessionSettings {
	readonly locale?: SheetLocale
	// The name comments and threaded replies are written under; never filled in for the user.
	readonly author?: string
	// The clock dates in the file are read from (ms since the epoch).
	readonly clock?: () => number
}

// An open workbook. Every method that answers does so asynchronously, on both hosts.
export interface SheetSessionApi {
	// Tiles of one sheet, by tile row and column pairs. The host holds them as the client's from now on (changes
	// patch them) until `release`.
	tiles(sheet: SheetId, coordinates: Uint32Array): Promise<{ readonly tiles: readonly SheetTile[]; readonly styles?: SheetStyleAppend }>
	// The client dropped these tiles (tileKey): changes no longer patch them.
	release(keys: Float64Array): void
	// A sheet's layout; parses the sheet first when it is not ready.
	layout(sheet: SheetId): Promise<SheetLayout>
	command(command: SheetCommand): Promise<SheetCommandResult>
	undo(): Promise<SheetCommandResult>
	redo(): Promise<SheetCommandResult>
	query<Q extends SheetQueryName>(
		name: Q,
		request: SheetQueryRequest<Q>,
		options?: { readonly signal?: SheetAbortSignal }
	): Promise<SheetQueryResult<Q>>
	// The user set out to edit: the gate proves the file (once), then the formula engine is built while the
	// first entry is typed. Answers the verdict.
	intent(): Promise<SheetWritability>
	// The app will not edit this file: the proof is skipped and what only saving needs is let go.
	viewOnly(): void
	configure(settings: SheetSessionSettings): void
	// The file as the session now holds it, handed over (transferred). Never throws: a failure is a result.
	save(options?: { readonly signal?: SheetAbortSignal }): Promise<SheetSaveResult>
	// Another format's bytes: an .xlsx of a text file or legacy workbook, a CSV of one sheet ("CSV UTF-8": with a
	// BOM).
	export(
		format: "xlsx" | "csv",
		options?: { readonly sheet?: SheetId }
	): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly refusal: SheetRefusal }>
	// The bytes save answered at `version` are now the file's.
	markSaved(version: number): Promise<SheetDocState>
	// Ends the session: a protected workbook's key is released, a save under way fails.
	close(): void
}

// --- Opening ---

// Why a file did not open (no prompt).
export type SheetOpenFailure =
	// Not a workbook of its kind, or damaged past reading.
	| "malformed"
	// Past the archive, part or cell limits.
	| "tooLarge"
	// A spreadsheet format Filen does not open (.xlsb, .numbers).
	| "unsupported"
	| "failed"

// Why an encrypted workbook is not opened (no prompt): rights-managed (IRM), an encryption Filen does not
// implement, or a damaged container or failed integrity check. Equal to dom/encryption's EncryptionRefusal.
export type SheetEncryptionRefusal = "rightsManaged" | "unsupported" | "damaged"

export interface SheetOpened {
	readonly session: SheetSessionApi
	readonly info: SheetWorkbookInfo
}

export type SheetOpenResult =
	| ({ readonly kind: "opened" } & SheetOpened)
	| { readonly kind: "needsPassword"; readonly locked: SheetLockedFile }
	| { readonly kind: "refused"; readonly reason: SheetEncryptionRefusal }
	| { readonly kind: "failed"; readonly reason: SheetOpenFailure; readonly message: string }
	| { readonly kind: "aborted" }

// A password-protected workbook waiting for its password. Excel's default password ("VelvetSweatshop") was tried
// first: a file it opens never asks.
export interface SheetLockedFile {
	// An encrypted package's ([MS-OFFCRYPTO] §2.3.4), or an Excel 97–2003 workbook's password to open (XOR, RC4 or
	// CryptoAPI RC4: §2.3.7, §2.3.6, §2.3.5).
	readonly scheme: "standard" | "agile" | "xor" | "rc4" | "cryptoApiRc4"
	// Hash iterations an unlock costs: what an "Unlocking…" state waits on (0 for an Excel 97–2003 workbook).
	readonly spinCount: number
	// One try at a time; may be called again after a wrong password or an abort.
	unlock(
		password: string,
		options?: { readonly signal?: SheetAbortSignal }
	): Promise<
		| ({ readonly ok: true } & SheetOpened)
		| { readonly ok: false; readonly reason: "wrongPassword" | "aborted" | SheetEncryptionRefusal }
	>
	// The prompt went without an unlock: what is held for the file goes.
	dispose(): void
}

export interface SheetOpenOptions {
	readonly kind: SheetFileKind
	readonly settings?: SheetSessionSettings
	// The file's password to modify was given: fileSharing does not make it view-only.
	readonly writeUnlocked?: boolean
	// The in-thread host's slices (a worker host slices on its own).
	readonly slicing?: Slicing
	readonly signal?: SheetAbortSignal
}

// Where sessions run: a worker (web) or the calling thread (mobile). Both answer the same API; events reach
// `onEvent` in order, between answers.
export interface SheetHost {
	// A worker host takes the bytes (transferred: the caller keeps no copy); the in-thread host also reads a
	// ByteSource lazily (a file on disk), never holding the whole file.
	open(source: Uint8Array | ByteSource, options: SheetOpenOptions, onEvent: (event: SheetEvent) => void): Promise<SheetOpenResult>
	// Ends every session and lets the host's resources go.
	dispose(): void
}

// --- Encryption hooks ---
// The core imports no WebCrypto: the host passes these in, made from @filen/office/dom/encryption (its
// PackageSealer is a SheetSealer; its DecryptedPackage gives the bytes, the sealer and the release).

export interface SheetSealOptions {
	readonly signal?: { readonly aborted: boolean }
	readonly slicing?: Slicing
}

// Seals a saved package under the session's key and checks it reads back (PackageSealer.seal): rejects when the
// key was released, aborted, or the check failed.
export interface SheetSealer {
	readonly released: boolean
	seal(zip: Uint8Array, options?: SheetSealOptions): Promise<Uint8Array>
}

// What a session opened from a decrypted package is given: every save goes through `sealer` after the gate, and
// the result is held to isSealedOfficeFile before it is handed out. `release` drops the key once the session
// closes.
export interface SheetEncryption {
	readonly sealer: SheetSealer
	readonly integrity: "verified" | "unchecked"
	// The file as it was read, sealed: an unedited save hands it out as it is.
	readonly sealed?: ByteSource
	release(): void
}

// What a host passes the core's session factory (never crosses a thread).
export interface SheetSessionOptions extends SheetOpenOptions {
	// The file was password-protected and is opened from its decrypted package.
	readonly encryption?: SheetEncryption
}

// A decrypted package held where it was unlocked (a protection worker), for a session in another realm: `take`
// copies the package to the caller, whose sealer comes from `key` (dom/encryption importOfficeKey) at its first
// save. Key is dom/encryption's OfficeKeyTransfer.
export interface SheetUnlockedPackage<Key> {
	readonly scheme: "standard" | "agile"
	readonly integrity: "verified" | "unchecked"
	readonly size: number
	take(options?: { readonly signal?: SheetAbortSignal }): Promise<SheetTakenPackage<Key>>
	// The session opened on its copy: the held copy goes, the key stays for key().
	dropPackage(): void
	release(): void
}

export interface SheetTakenPackage<Key> {
	readonly bytes: Uint8Array
	key(options?: { readonly signal?: SheetAbortSignal }): Promise<Key>
}

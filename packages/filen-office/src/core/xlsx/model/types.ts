import type { NewRelationship, Relationship, Relationships } from "../../opc/relationships"
import type { PartBytes } from "../../opc/pieces"
import type { ZipEntry } from "../../opc/zipReader"
import type {
	SheetHorizontalAlign,
	SheetId,
	SheetKind,
	SheetPatternType,
	SheetProtectedAction,
	SheetRange,
	SheetState,
	SheetUnderline,
	SheetVerticalAlign,
	SheetBorderStyle
} from "../../sheet/protocol"
import type { Markup } from "../../xml/editor"
import type { Slicing } from "../../slicing"
import type { AxisShift } from "../refs/axis"

// The lossless workbook model the reader builds, edits change and the splice writer saves. Untouched parts stay
// compressed in the source zip and are copied as stored; a sheet is parsed on demand into a columnar store whose
// rows remember their byte span in the source part, so a save rewrites only what an edit touched. Nothing holds
// one object per cell.
//
// Rules the reader, the edits and the writer share:
// - Byte spans are offsets into a part's inflated bytes as the source zip holds them. The writer inflates the part
//   again at save; nothing keeps a sheet's inflated bytes after it is parsed.
// - Change marks are conservative: anything marked may equal its source, and the writer then emits the source
//   bytes (a row, a cell, a section, a part), so an edit and its undo save byte-identical.
// - Inside a rewritten row, a cell equal to its source is copied from its source bytes (its unknown attributes,
//   vm, ph and extLst kept, `r` rewritten when it moved); only cells that differ are serialised from the store.
// - Records are append-only: styles, shared strings and formulas are never reindexed, so other sheets keep their
//   bytes.

// --- Cells ---

// What a store slot holds (XlsxRowBlock.kinds), and how its value (XlsxRowBlock.values) reads.
export const CellKind = {
	// No value: a cell kept for its style (or its formula's pending result).
	EMPTY: 0,
	NUMBER: 1,
	// value: index into the workbook's shared strings.
	SHARED_STRING: 2,
	// value: index into the sheet's strings (an inline <is> string).
	INLINE_STRING: 3,
	// value: index into the sheet's strings (t="str", a formula's text result).
	FORMULA_STRING: 4,
	// value: 0 or 1.
	BOOLEAN: 5,
	// value: index into the sheet's strings, holding the error text ("#DIV/0!") as written.
	ERROR: 6,
	// value: index into the sheet's strings, holding the ISO 8601 text of a t="d" cell as written.
	DATE: 7
} as const

export type CellKind = (typeof CellKind)[keyof typeof CellKind]

// XlsxRowBlock.rowFlags.
export const RowFlag = {
	// Changed since open (content, properties or number): the writer serialises it, or copies its source when
	// it turns out equal.
	DIRTY: 1 << 0,
	// Not from the source (inserted, or written into a gap): it has no span.
	NEW: 1 << 1,
	HIDDEN: 1 << 2,
	CUSTOM_HEIGHT: 1 << 3,
	// The row's style applies to its empty cells (customFormat).
	CUSTOM_FORMAT: 1 << 4,
	COLLAPSED: 1 << 5,
	THICK_TOP: 1 << 6,
	THICK_BOTTOM: 1 << 7,
	// Bits 8-10: outline level 0-7.
	OUTLINE_SHIFT: 8,
	OUTLINE_MASK: 0b111 << 8,
	// With DIRTY: its cells moved along the row as columns were inserted or deleted, and nothing else changed it since
	// (each cell is its source cell at its new column).
	SHIFTED: 1 << 11
} as const

// The bits that say how a row changed since open, not what it is.
export const ROW_MARKS = RowFlag.DIRTY | RowFlag.NEW | RowFlag.SHIFTED

// XlsxRowBlock.rowSpans for a row with no source bytes.
export const NO_SPAN = 0xffffffff

// A run of consecutive source rows, stored column by column. Blocks are ascending and never overlap. Rows are
// relative to `firstRow`, so inserting or deleting rows above a block moves `firstRow` alone. A block is replaced
// whole when its shape changes (a cell added or removed); a value or style written over an existing slot is
// written in place. Only the store writes to these arrays: everyone else reads them.
export interface XlsxRowBlock {
	firstRow: number
	// The block's firstRow in the source (-1 for a block of new rows): a block whose firstRow moved renumbers its
	// rows on save.
	readonly sourceFirstRow: number
	readonly rowCount: number
	// Per row (rowCount entries).
	readonly rows: Uint32Array
	// rowCount + 1 offsets into the cell arrays: the cells of row i are rowStarts[i] .. rowStarts[i + 1] - 1.
	readonly rowStarts: Uint32Array
	// Two per row: start and end of its <row> element in the source part, or NO_SPAN.
	readonly rowSpans: Uint32Array
	readonly rowFlags: Uint16Array
	// Height in points (ht), NaN for none. Float64: a height written back keeps its decimal text.
	readonly rowHeights: Float64Array
	// Row style (s, an index into cellXfs), -1 for none.
	readonly rowStyles: Int32Array
	// Per cell, ascending by column within each row.
	readonly cols: Uint16Array
	readonly kinds: Uint8Array
	readonly values: Float64Array
	// Index into cellXfs (0 for the default).
	readonly styles: Uint32Array
	// Index into the sheet's formula table, -1 for none; null for a block without formulas.
	readonly formulas: Int32Array | null
	// Per cell, which <c> of its row's source element it is (1-based, 0 for a cell not from the source): the
	// writer keeps that element's markup the model does not hold. Null while every cell is the one at its
	// position in its row (blockOrigin).
	readonly origins: Uint32Array | null
}

// Origins at and past this name a source cell a paste carried in (XlsxSheetStore.carriedCell), not the row's own.
export const CARRIED = 0x80000000

// A cell of a source sheet part: the part, the span of its row's element, and which <c> of it (1-based).
export interface XlsxSourceCell {
	readonly part: string
	readonly spanStart: number
	readonly spanEnd: number
	readonly ordinal: number
}

// A source cell as one number (unique while parts stay under 512 MB and rows under 2^24 cells), -1 past that.
export function sourceKey(spanStart: number, ordinal: number): number {
	return ordinal < 0x1000000 ? spanStart * 0x1000000 + ordinal : -1
}

// The source cell (1-based ordinal in its row's source element, 0 for none) of cell `k` in row `index`.
export function blockOrigin(block: XlsxRowBlock, index: number, k: number): number {
	return block.origins === null ? k - (block.rowStarts[index] ?? 0) + 1 : (block.origins[k] ?? 0)
}

// A store slot: block index * SLOT_BLOCK + index into the block's cell arrays.
export const SLOT_BLOCK = 0x1000000

// The cells of one sheet.
export interface XlsxSheetStore {
	readonly blocks: readonly XlsxRowBlock[]
	readonly strings: XlsxSheetStrings
	readonly formulas: XlsxFormulaTable
	readonly cellCount: number
	// Past the last row and column with a cell or a row with properties.
	readonly rowExtent: number
	readonly colExtent: number
	// The slot holding a cell, or -1.
	locate(row: number, col: number): number
	// Writes one cell (marking its row dirty). An EMPTY kind with style 0 and no formula removes the cell. With
	// `origin` (0 or more) the cell is put back as it was: it stays though it holds nothing, and is again that source
	// cell (blockOrigin), so the writer keeps what the file held on it.
	setCell(row: number, col: number, kind: CellKind, value: number, style: number, formula: number, origin?: number): void
	// The source cell a slot is (blockOrigin), 0 for none.
	origin(slot: number): number
	// The source cell a carried origin (CARRIED and past) names, and the parts carried cells come from.
	carriedCell(origin: number): XlsxSourceCell | undefined
	carriedParts(): ReadonlySet<string>
	// Writes a row's properties (height NaN for none, style -1 for none, flags without DIRTY and NEW).
	setRow(row: number, height: number, style: number, flags: number): void
	// Moves rows or columns at and after `at`; deleted ones go. Cells only: formulas, merges and everything else
	// that refers to cells are moved by the refs catalogue.
	insertRows(at: number, count: number): void
	deleteRows(at: number, count: number): void
	insertCols(at: number, count: number): void
	deleteCols(at: number, count: number): void
	// Retained bytes, for memory budgets and the undo history's estimates.
	estimateBytes(): number
}

// A sheet's own strings: inline strings, formula string results, error texts and dates as written.
export interface XlsxSheetStrings {
	readonly length: number
	text(index: number): string
	// The index of `text`, added once.
	intern(text: string): number
}

export const FormulaKind = {
	NORMAL: 0,
	// t="shared": the master holds the text and the range, its children only the shared index.
	SHARED_MASTER: 1,
	SHARED_CHILD: 2,
	// t="array" (a dynamic array when its cell metadata says so).
	ARRAY: 3,
	// t="dataTable": a what-if table (r1, r2 and its flags).
	DATA_TABLE: 4
} as const

export type FormulaKind = (typeof FormulaKind)[keyof typeof FormulaKind]

export const FormulaFlag = {
	// ca: calculate on every recalculation.
	ALWAYS: 1 << 0,
	// aca: an always-calculate array.
	ALWAYS_ARRAY: 1 << 1,
	// bx: assigns a name.
	ASSIGNS_NAME: 1 << 2,
	// Data tables: dt2D, dtr, del1, del2.
	TWO_D: 1 << 3,
	ROW_INPUT: 1 << 4,
	DELETED_1: 1 << 5,
	DELETED_2: 1 << 6
} as const

export interface XlsxFormula {
	readonly kind: FormulaKind
	// As stored: Excel syntax, future functions with their _xlfn. prefix. "" for a shared child.
	readonly text: string
	// si, -1 for none.
	readonly sharedIndex: number
	// The range of an array, a shared master or a data table.
	readonly ref: SheetRange | null
	// FormulaFlag bits.
	readonly flags: number
	// The cell's cm (cell metadata index; a dynamic array points at XLDAPR), -1 for none.
	readonly cellMetadata: number
	readonly r1?: string
	readonly r2?: string
	// A shared master's own cell from its ref's top-left, when it is not that cell: its children's references move
	// from the master cell (ECMA-376 Part 1 §18.3.1.40), which a file may place anywhere in the ref.
	readonly masterOffset?: { readonly row: number; readonly col: number }
}

// Formulas of one sheet, by id. Columnar inside; `formula` builds an object for an edit, never for a scan.
export interface XlsxFormulaTable {
	readonly length: number
	kind(id: number): FormulaKind
	text(id: number): string
	sharedIndex(id: number): number
	formula(id: number): XlsxFormula
	// A shared child's text as its own cell would hold it: the master's moved to the child.
	expanded(id: number, row: number, col: number): string
	add(formula: XlsxFormula): number
	set(id: number, formula: XlsxFormula): void
}

// --- Worksheet part ---

// The children of <worksheet> (ECMA-376 §18.3.1.99 CT_Worksheet) in schema order, sheetData included. A child the
// schema does not name (mc:AlternateContent, a newer extension) keeps its qualified name.
export type WorksheetSection =
	| "sheetPr"
	| "dimension"
	| "sheetViews"
	| "sheetFormatPr"
	| "cols"
	| "sheetData"
	| "sheetCalcPr"
	| "sheetProtection"
	| "protectedRanges"
	| "scenarios"
	| "autoFilter"
	| "sortState"
	| "dataConsolidate"
	| "customSheetViews"
	| "mergeCells"
	| "phoneticPr"
	| "conditionalFormatting"
	| "dataValidations"
	| "hyperlinks"
	| "printOptions"
	| "pageMargins"
	| "pageSetup"
	| "headerFooter"
	| "rowBreaks"
	| "colBreaks"
	| "customProperties"
	| "cellWatches"
	| "ignoredErrors"
	| "smartTags"
	| "drawing"
	| "legacyDrawing"
	| "legacyDrawingHF"
	| "drawingHF"
	| "picture"
	| "oleObjects"
	| "controls"
	| "webPublishItems"
	| "tableParts"
	| "extLst"

// One child of the source part's root, in source order. `bytes` holds it as written (every child but sheetData,
// which only spans); a feature parses its own sections from these.
export interface XlsxSection {
	readonly name: WorksheetSection | (string & {})
	readonly start: number
	readonly end: number
	readonly bytes: Uint8Array | null
}

export interface XlsxColRange {
	// 0-based, inclusive.
	readonly first: number
	readonly last: number
	// Characters of the default font (width), NaN for none.
	readonly width: number
	// The width as a length in pixels, for a source that gives lengths (OpenDocument): shown as is, whatever the
	// default font's digit measures.
	readonly px?: number
	// cellXfs index, -1 for none.
	readonly style: number
	// RowFlag-like bits: HIDDEN, CUSTOM_HEIGHT (customWidth), COLLAPSED, outline level; BEST_FIT below.
	readonly flags: number
}

export const ColFlag = {
	HIDDEN: RowFlag.HIDDEN,
	CUSTOM_WIDTH: RowFlag.CUSTOM_HEIGHT,
	COLLAPSED: RowFlag.COLLAPSED,
	BEST_FIT: 1 << 6,
	PHONETIC: 1 << 7,
	OUTLINE_SHIFT: RowFlag.OUTLINE_SHIFT,
	OUTLINE_MASK: RowFlag.OUTLINE_MASK
} as const

export interface XlsxSheetFormat {
	// Points.
	readonly defaultRowHeight: number
	// Characters, NaN when absent (baseColWidth then applies).
	readonly defaultColWidth: number
	readonly baseColWidth: number
	readonly customHeight: boolean
	readonly zeroHeight: boolean
	readonly thickTop: boolean
	readonly thickBottom: boolean
	readonly outlineLevelRow: number
	readonly outlineLevelCol: number
	// The default column width as a length in pixels (see XlsxColRange.px).
	readonly defaultColPx?: number
}

// A run of rows alike: RowFlag bits and the height in points (NaN: the sheet's default).
export interface XlsxRowRun {
	readonly first: number
	readonly last: number
	readonly flags: number
	readonly heightPt: number
}

// The run holding `row` in ascending runs, undefined for none.
export function rowRunAt(runs: readonly XlsxRowRun[] | undefined, row: number): XlsxRowRun | undefined {
	if (runs === undefined) return undefined

	let low = 0
	let high = runs.length

	while (low < high) {
		const middle = (low + high) >>> 1

		if ((runs[middle]?.first ?? 0) <= row) low = middle + 1
		else high = middle
	}

	const run = runs[low - 1]

	return run !== undefined && row <= run.last ? run : undefined
}

// Cells formatted in runs the store does not hold one by one (an OpenDocument source's style-only blocks, which
// can cover millions of cells): the format an empty cell has of its own, before its row's and its column's.
export interface XlsxStyleRuns {
	// Past the last row and column a run covers.
	readonly rowExtent: number
	readonly colExtent: number
	// The cellXfs index of an empty cell at (row, col), -1 for none.
	styleAt(row: number, col: number): number
	// The runs crossing `range`, clipped to it, in row then column order.
	forEach(range: SheetRange, visit: (startRow: number, startCol: number, endRow: number, endCol: number, style: number) => void): void
	estimateBytes(): number
	// The runs after rows or columns inserted or deleted, as ranges move (refs/axis.ts); undefined when none is left.
	shifted(shift: AxisShift): XlsxStyleRuns | undefined
}

// The first <sheetView> (the others are kept as written).
export interface XlsxSheetView {
	// Frozen rows and columns (ySplit, xSplit), counted from the view's first row and column; the scrolling pane's
	// first cell (the pane's topLeftCell).
	readonly frozen: { readonly rows: number; readonly cols: number; readonly topLeftRow: number; readonly topLeftCol: number } | null
	// The first row and column the view shows (its topLeftCell, ECMA-376 Part 1 §18.3.1.87; [MS-XLSB] BrtBeginWsView
	// rwTop and colLeft): with frozen rows (columns), the first frozen one, which need not be the sheet's first.
	readonly topRow: number
	readonly leftCol: number
	readonly activeRow: number
	readonly activeCol: number
	readonly selection: readonly SheetRange[]
	readonly zoom: number
	readonly gridLines: boolean
	readonly headings: boolean
	readonly rightToLeft: boolean
	readonly tabSelected: boolean
	readonly view: "normal" | "pageLayout" | "pageBreakPreview"
}

// The modern hash (§18.3.1.85 algorithmName and friends) or the legacy 16-bit one (password), as written.
export interface XlsxProtectionHash {
	readonly algorithmName?: string
	readonly hashValue?: string
	readonly saltValue?: string
	readonly spinCount?: number
	readonly legacy?: string
}

export interface XlsxSheetProtection {
	readonly hash: XlsxProtectionHash
	readonly allows: ReadonlySet<SheetProtectedAction>
}

export interface XlsxSheetModel {
	readonly id: SheetId
	readonly part: string
	readonly store: XlsxSheetStore
	// Shared indexes whose children the source already left outside every master (none for a new sheet): the
	// gate takes those as the file's, not a save's.
	readonly sourceOrphanedShared?: ReadonlySet<number>
	readonly sections: readonly XlsxSection[]
	readonly relationships: Relationships
	// The prefix the root binds SpreadsheetML to ("x" for <x:worksheet>), "" for the default namespace: sections an
	// edit writes take it.
	readonly prefix: string
	cols: readonly XlsxColRange[]
	// Quads: startRow, startCol, endRow, endCol.
	merges: Uint32Array
	format: XlsxSheetFormat
	view: XlsxSheetView
	protection: XlsxSheetProtection | null
	tabColor: XlsxColor | null
	// sheetPr filterMode (§18.3.1.82): whether a filter hides rows. Undefined: as the source has it.
	filterMode?: boolean
	// sheetPr pageSetUpPr fitToPage (§18.3.1.65): print fitted to pageSetup's fitToWidth by fitToHeight pages.
	// Undefined: as the source has it.
	fitToPage?: boolean
	// A sheet with no part in the source (a duplicated one): its root's start tag, when it takes another part's
	// (namespaces, mc:Ignorable); without one the writer makes a plain root.
	readonly freshRoot?: string | undefined
	// Formats of empty cells the store does not hold (XlsxStyleRuns); none for a SpreadsheetML source.
	styleRuns?: XlsxStyleRuns
	// Rows the store does not hold, alike in runs (an OpenDocument source's hidden or resized rows without cells, which
	// can reach the grid's end): ascending, apart from each other and from the store's rows. None for SpreadsheetML.
	rowRuns?: readonly XlsxRowRun[] | undefined
	// What else of the sheet moves with its rows and columns (an OpenDocument source's runs and where its rows and
	// columns came from): the step a structure edit applies and reverts, null when nothing moves.
	shiftSource?(shift: AxisShift): { readonly apply: () => void; readonly revert: () => void } | null
	// Formula cells (history.ts cellKeyOf) whose stored results are calculated again once the engine is built, the
	// stored one shown until then and where the engine holds the formula: an OpenDocument source's volatile formulas
	// (LibreOffice recalculates them on load) and results written as error text.
	readonly recalculate?: ReadonlySet<number>
}

// --- Workbook ---

export type XlsxVariant = "xlsx" | "xlsm" | "xltx" | "xltm"

export interface XlsxSheetEntry {
	readonly id: SheetId
	name: string
	state: SheetState
	readonly kind: SheetKind
	// The file's sheetId attribute.
	readonly sheetId: number
	readonly relationshipId: string
	readonly part: string
	// Null until parsed (XlsxWorkbookModel.load).
	model: XlsxSheetModel | null
}

export interface XlsxDefinedName {
	readonly name: string
	// The sheet a local name belongs to (localSheetId), null for a workbook-wide one.
	readonly sheet: SheetId | null
	readonly formula: string
	readonly hidden: boolean
	// The element to write: as the source wrote it, or with an edit's formula as its text (its other attributes
	// kept); null for a new one.
	readonly source: Uint8Array | null
}

export type XlsxWorkbookSection =
	| "fileVersion"
	| "fileSharing"
	| "workbookPr"
	| "workbookProtection"
	| "bookViews"
	| "sheets"
	| "functionGroups"
	| "externalReferences"
	| "definedNames"
	| "calcPr"
	| "oleSize"
	| "customWorkbookViews"
	| "pivotCaches"
	| "smartTagPr"
	| "smartTagTypes"
	| "webPublishing"
	| "fileRecoveryPr"
	| "webPublishObjects"
	| "extLst"

export interface XlsxCalcProperties {
	readonly calcId: number
	readonly mode: "auto" | "manual" | "autoNoTable"
	readonly fullCalcOnLoad: boolean
	readonly iterate: boolean
	readonly iterateCount: number
	readonly iterateDelta: number
}

export interface XlsxWorkbookProtection {
	readonly structure: boolean
	readonly windows: boolean
	readonly hash: XlsxProtectionHash
}

export interface XlsxFileSharing {
	readonly readOnlyRecommended: boolean
	readonly userName?: string
	// The password to modify; empty when none is set.
	readonly hash: XlsxProtectionHash
}

export interface XlsxTheme {
	// The 12 scheme colours in clrScheme order (dk1, lt1, dk2, lt2, accent1-6, hlink, folHlink), 0xRRGGBB.
	readonly colors: readonly number[]
	readonly majorFont: string
	readonly minorFont: string
}

export interface XlsxWorkbookModel {
	readonly variant: XlsxVariant
	readonly strict: boolean
	readonly parts: XlsxPartMap
	readonly workbookPart: string
	// workbook.xml's children, as XlsxSection.
	readonly workbookSections: readonly XlsxSection[]
	// In workbook order (moves and deletions change it).
	readonly sheets: XlsxSheetEntry[]
	readonly definedNames: XlsxDefinedName[]
	readonly styles: XlsxStyleTable
	readonly sharedStrings: XlsxSharedStrings
	readonly theme: XlsxTheme | null
	readonly date1904: boolean
	calc: XlsxCalcProperties
	protection: XlsxWorkbookProtection | null
	fileSharing: XlsxFileSharing | null
	activeTab: number
	readonly changes: XlsxChangeLog
	sheet(id: SheetId): XlsxSheetEntry | undefined
	// Parses a sheet once; concurrent calls share the parse.
	load(id: SheetId, slicing?: Slicing): Promise<XlsxSheetModel>
}

// --- Shared strings ---

export interface XlsxRichRun {
	readonly text: string
	// The run's properties (CT_RPrElt is a font), null for a run without.
	readonly font: XlsxFont | null
}

export interface XlsxSharedStrings {
	// The count attribute as read (references to shared strings in the whole workbook).
	readonly sourceCount: number
	// Entries in the source part; later ones were appended.
	readonly sourceLength: number
	readonly length: number
	// References added minus references removed since open: the written count is sourceCount plus this.
	readonly referenceDelta: number
	text(index: number): string
	// Runs of a rich entry, null for plain text.
	runs(index: number): readonly XlsxRichRun[] | null
	// The index of a plain entry equal to `text`, or -1.
	find(text: string): number
	// Appends an entry (a plain one equal to an appended one is reused).
	append(text: string, runs?: readonly XlsxRichRun[]): number
	adjustReferences(delta: number): void
}

// --- Styles ---

export interface XlsxColor {
	// 0xAARRGGBB.
	readonly argb?: number
	readonly theme?: number
	readonly tint?: number
	readonly indexed?: number
	readonly auto?: boolean
}

export interface XlsxFont {
	readonly name?: string
	readonly size?: number
	readonly bold?: boolean
	readonly italic?: boolean
	readonly strike?: boolean
	readonly underline?: SheetUnderline | "none"
	readonly vertAlign?: "baseline" | "superscript" | "subscript"
	readonly color?: XlsxColor
	readonly family?: number
	readonly charset?: number
	readonly scheme?: "major" | "minor" | "none"
	readonly outline?: boolean
	readonly shadow?: boolean
	readonly condense?: boolean
	readonly extend?: boolean
}

export type XlsxFill =
	| {
			readonly kind: "pattern"
			readonly pattern: SheetPatternType | "none" | "solid"
			readonly fg?: XlsxColor
			readonly bg?: XlsxColor
	  }
	| {
			readonly kind: "gradient"
			readonly type: "linear" | "path"
			readonly degree: number
			readonly left: number
			readonly right: number
			readonly top: number
			readonly bottom: number
			readonly stops: readonly { readonly position: number; readonly color: XlsxColor }[]
	  }

export interface XlsxBorderEdge {
	readonly style?: SheetBorderStyle
	readonly color?: XlsxColor
}

export interface XlsxBorder {
	readonly left?: XlsxBorderEdge
	readonly right?: XlsxBorderEdge
	readonly top?: XlsxBorderEdge
	readonly bottom?: XlsxBorderEdge
	readonly diagonal?: XlsxBorderEdge
	readonly vertical?: XlsxBorderEdge
	readonly horizontal?: XlsxBorderEdge
	readonly diagonalUp?: boolean
	readonly diagonalDown?: boolean
	readonly outline?: boolean
}

export interface XlsxAlignment {
	readonly horizontal?: SheetHorizontalAlign | "general"
	readonly vertical?: SheetVerticalAlign
	readonly wrapText?: boolean
	readonly shrinkToFit?: boolean
	readonly indent?: number
	readonly relativeIndent?: number
	readonly textRotation?: number
	readonly readingOrder?: number
	readonly justifyLastLine?: boolean
}

export interface XlsxCellProtection {
	readonly locked?: boolean
	readonly hidden?: boolean
	// The content is not shown while the sheet is protected (OpenDocument's style:cell-protect="hidden-and-protected",
	// ODF 1.3 Part 3 §20.189); SpreadsheetML's hidden hides formulas only.
	readonly hideAll?: boolean
}

export { XfApply } from "../../sheet/style/xfApply"

export interface XlsxXf {
	readonly numFmtId: number
	readonly fontId: number
	readonly fillId: number
	readonly borderId: number
	// The cell style's xf (cellStyleXfs), -1 for a cellStyleXfs record itself.
	readonly xfId: number
	// XfApply bits: the apply* attributes as written, quotePrefix and pivotButton.
	readonly flags: number
	readonly alignment?: XlsxAlignment
	readonly protection?: XlsxCellProtection
}

export interface XlsxDxf {
	readonly font?: XlsxFont
	readonly numFmt?: { readonly id: number; readonly code: string }
	readonly fill?: XlsxFill
	readonly alignment?: XlsxAlignment
	readonly border?: XlsxBorder
	readonly protection?: XlsxCellProtection
}

export interface XlsxCellStyle {
	readonly name: string
	readonly xfId: number
	readonly builtinId?: number
	readonly outlineLevel?: number
	readonly hidden?: boolean
	readonly customBuiltin?: boolean
}

// styles.xml. Records are appended, never changed or reindexed; each append reuses an equal appended record.
export interface XlsxStyleTable {
	// Custom number formats by id (built-in ids are implied, §18.8.30).
	readonly numFmts: ReadonlyMap<number, string>
	readonly fonts: readonly XlsxFont[]
	readonly fills: readonly XlsxFill[]
	readonly borders: readonly XlsxBorder[]
	readonly cellStyleXfs: readonly XlsxXf[]
	readonly cellXfs: readonly XlsxXf[]
	readonly cellStyles: readonly XlsxCellStyle[]
	readonly dxfs: readonly XlsxDxf[]
	// A custom palette (indexedColors), 0xAARRGGBB; null for the default one.
	readonly indexedColors: readonly number[] | null
	// Records the source holds; the writer appends what follows.
	readonly sourceCounts: {
		readonly numFmts: number
		readonly fonts: number
		readonly fills: number
		readonly borders: number
		readonly cellXfs: number
		readonly dxfs: number
	}
	// An existing id of the code (built-in or custom), else a new custom one (164 and up).
	numFmtId(code: string): number
	appendFont(font: XlsxFont): number
	appendFill(fill: XlsxFill): number
	appendBorder(border: XlsxBorder): number
	// Throws past the cell format limit: callers check first and refuse ("styleLimit").
	appendXf(xf: XlsxXf): number
	appendDxf(dxf: XlsxDxf): number
}

// --- Parts and changes ---

export interface XlsxPart {
	readonly name: string
	readonly contentType: string
	// The source entry its bytes come from (copied as stored while unchanged), null for a part added since open.
	readonly source: ZipEntry | null
}

export interface XlsxPartMap {
	get(name: string): XlsxPart | undefined
	parts(): Iterable<XlsxPart>
	// A source part inflated (not cached).
	read(name: string, slicing?: Slicing): Promise<Uint8Array>
	relationships(source: string): Promise<Relationships>
}

// Serialises a section or a part at save, from the model as it then is. "" removes a section.
export type XlsxSectionWriter = (sheet: XlsxSheetModel, workbook: XlsxWorkbookModel) => Markup
export type XlsxWorkbookSectionWriter = (workbook: XlsxWorkbookModel) => Markup

export interface XlsxPartWrite {
	readonly contentType: string
	write(workbook: XlsxWorkbookModel, slicing?: Slicing): PartBytes | Promise<PartBytes>
}

export interface XlsxRelationshipChanges {
	readonly added: readonly Relationship[]
	readonly removed: ReadonlySet<string>
}

export interface XlsxSheetChanges {
	// Some rows changed: RowFlag.DIRTY says which.
	readonly rows: boolean
	// Sections to serialise again: by the writer an edit gave, or (sheetPr, dimension, sheetViews, sheetFormatPr,
	// cols, mergeCells, sheetProtection) by the writer's own.
	readonly sections: ReadonlyMap<WorksheetSection | (string & {}), XlsxSectionWriter | null>
}

// What changed since open, cumulative (a save does not reset it: every save is planned against the source). The
// edit side records; the writer reads. Recording is idempotent, so an undo records as its edit did.
export interface XlsxChangeLog {
	readonly empty: boolean
	readonly sheets: ReadonlyMap<SheetId, XlsxSheetChanges>
	readonly workbookSections: ReadonlyMap<XlsxWorkbookSection | (string & {}), XlsxWorkbookSectionWriter | null>
	readonly sharedStrings: boolean
	readonly styles: boolean
	// Added or replaced parts by name, and removed ones (null).
	readonly parts: ReadonlyMap<string, XlsxPartWrite | null>
	readonly relationships: ReadonlyMap<string, XlsxRelationshipChanges>
	// Formulas changed: calcChain goes, with its relationship and override (it is optional).
	readonly dropCalcChain: boolean
	// A dependent result could not be calculated here: calcPr fullCalcOnLoad="1".
	readonly fullCalcOnLoad: boolean

	sheetRows(sheet: SheetId): void
	// `writer` serialises the section; without one the writer's own does (for the sections it owns).
	sheetSection(sheet: SheetId, section: WorksheetSection | (string & {}), writer?: XlsxSectionWriter): void
	workbookSection(section: XlsxWorkbookSection | (string & {}), writer?: XlsxWorkbookSectionWriter): void
	sharedStringsAppended(): void
	stylesAppended(): void
	writePart(name: string, write: XlsxPartWrite): void
	removePart(name: string): void
	// The part is again as in the source (absent when it was added): an undo of writePart or removePart.
	restorePart(name: string): void
	// Returns the relationship as added (its id allocated against the source part's relationships).
	addRelationship(source: string, relationship: NewRelationship): Relationship
	// A relationship addRelationship returned, added back under its own id (an undo or redo).
	readdRelationship(source: string, relationship: Relationship): void
	removeRelationship(source: string, id: string): void
	formulasChanged(): void
	needsFullCalc(): void
	// What one edit marks: begun before it runs, ended once it ran (each section and part it marked, re-marked ones
	// too, as changes.ts sheetMark, workbookMark and partMark name them; null when none was begun).
	beginJournal?(): void
	endJournal?(): ReadonlySet<string> | null
	// The edit the journal ended on was refused and undone: the marks it made first go too.
	forgetJournal?(): void
}

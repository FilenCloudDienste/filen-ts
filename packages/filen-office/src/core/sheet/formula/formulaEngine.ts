import { appendAll, spliceAll } from "../../arrays"
import { ISO_1900, type DateBase } from "../numfmt/date"
import {
	CellError,
	DenseSparseChooseBasedOnThreshold,
	EmptyValue,
	DetailedCellError,
	ErrorType,
	FunctionArgumentType,
	FunctionPlugin,
	HyperFormula,
	type ConfigParams,
	type ImplementedFunctions,
	type RawCellContent,
	type SimpleCellAddress
} from "hyperformula"
import type { AxisEdit } from "../model/edits"
import type { SheetLocale } from "../protocol"
import { runSliced, type SliceClock } from "../../slicing"
import { cellName } from "../refs/cellRef"
import { formulaInputs, quoteSheetNames, sameSheet, sheetNameNeedsQuotes, spannedReferences } from "../refs/formulaRefs"
import { MAX_COLUMNS, MAX_ROWS } from "../model/model"
import type { SizeAxis } from "../sizes/sizes"
import { registerSheetFunctions } from "./functions"
import { installIndirect, withIndirect, type IndirectHost, type IndirectRead } from "./functions/indirect"
import { spillError, withSpill, type SpillHost, type SpillSize } from "./functions/spill"
import {
	GENERIC_ERRORS,
	genericErrorText,
	guardFunctionPlugins,
	installLiftTracking,
	trackLifts,
	UNMODELED,
	withRowState,
	type PluginScalar
} from "./functions/plugin"
import { textDateParser } from "./textDates"
import { installErrorValues } from "./errorValues"
import { installExactSearch } from "./exactSearch"
import { installSharedRanges } from "./sharedRanges"
import { installWholeRanges, WholeRanges, withWholeRanges } from "./wholeRanges"

// HyperFormula over a workbook, for recalculating what an edit changes. Built only once the workbook has a
// formula to care about, and kept in step with the workbook from then on (cells, inserted and deleted rows
// and columns, added and renamed sheets). Formula text is never read back from it: references are moved in
// the workbook's own text (refs/formulaRefs.ts), which stays Excel's.
// GPL-3.0 licensed, as the app (AGPL-3.0) may combine it.
const LICENSE_KEY = "gpl-v3"

export interface RecalculatedCell {
	sheet: number
	row: number
	col: number
	// A number, string, boolean, error text ("#DIV/0!") or null. Dates come as serial numbers.
	value: number | string | boolean | null
	// The value is an error, not text that reads like one.
	error?: true
	// A result held from the file (HeldResult) whose inputs changed: it is no longer what the formula gives. The
	// value is the held one.
	stale?: true
	// A dynamic-array formula's cell: what it spills over now from its own cell (1 by 1 when it is #SPILL!).
	spill?: SpillSize
	// A cell a dynamic-array formula spills over, not a formula of its own: its value now (null where the spill no
	// longer reaches).
	spilled?: true
	// An error that comes from another cell's formula (propagated): that cell, by sheet index.
	root?: { readonly sheet: number; readonly row: number; readonly col: number }
	// What a #NAME? did not know: a function or a name, as written.
	unknown?: { readonly kind: "function" | "name"; readonly name: string }
}

// The engine's words for what a #NAME? did not know (HyperFormula's ErrorMessage.FunctionName and
// NamedExpressionName).
const UNKNOWN_FUNCTION = /^Function name (.+) not recognized\.$/u
const UNKNOWN_NAME = /^Named expression (.+) not recognized\.$/u

// A formula's stored result, held by the engine in its place: the formula is not calculated here (a function the
// engine lacks, an array formula, syntax it cannot read). It depends on no cell there: the caller knows what the
// formula reads and tells when that changes; the engine reports it stale at each inserted or deleted row or column.
export class HeldResult {
	readonly value: RawCellContent

	constructor(value: RawCellContent) {
		this.value = value
	}
}

// A cell to give the engine. A formula also carries the result the file stored, when it has one: should
// the engine not read the formula (syntax it lacks) or not know a function in it, the cell holds that
// result instead, so what depends on it still calculates.
export interface EngineCell {
	row: number
	col: number
	content: RawCellContent | HeldResult
	fallback?: RawCellContent
	// A dynamic-array formula (calculated through SPILL_FUNCTION, or held): what it spills over now.
	spill?: SpillSize
}

export interface EngineSheet {
	name: string
	// A held cell (HeldResult) is listed in `formulas` too.
	rows: (RawCellContent | HeldResult)[][]
	// Its formula cells that carry a fallback or hold a result, or spill (EngineCell.spill).
	formulas: EngineCell[]
}

// A block of cells a dynamic array would spill over, 0-based and inclusive.
export interface SpillRange {
	readonly startRow: number
	readonly startCol: number
	readonly endRow: number
	readonly endCol: number
}

export interface EngineName {
	name: string
	expression: string
	// Grid sheet index of a sheet-scoped name.
	scope?: number
}

// A circular reference. Excel, not iterating, shows 0 for it; iterating, the result it stored.
export const CYCLE = "#CYCLE!"

// Excel's own error texts, which the files store and the grid shows.
const ERROR_TEXT: Readonly<Partial<Record<ErrorType, string>>> = {
	[ErrorType.DIV_BY_ZERO]: "#DIV/0!",
	[ErrorType.NAME]: "#NAME?",
	[ErrorType.VALUE]: "#VALUE!",
	[ErrorType.NUM]: "#NUM!",
	[ErrorType.NA]: "#N/A",
	[ErrorType.REF]: "#REF!",
	[ErrorType.CYCLE]: CYCLE,
	[ErrorType.SPILL]: "#SPILL!"
}

const INSERT_RUN = 10_000

// A formula calling SUBTOTAL or AGGREGATE, which read whether rows are hidden.
const CALLS_TOTAL = /(?:SUBTOTAL|AGGREGATE)\s*\(/i

// The most cells the engine may copy for one removal: it copies what it removes for an undo of its own (every cell
// of the removed rows across the sheet's width, of a removed sheet), which far cells make billions.
const MAX_COPIED_CELLS = 1_048_576

// An operation the engine cannot do within bounds: the caller refuses the edit, or drops the engine and builds it
// again from the cells when next needed.
export class EngineLimitError extends Error {
	constructor() {
		super("spreadsheet: the formula engine would copy too many cells")
	}
}

// The rounds of INDIRECT calculated again for what they read (followIndirect): past them a chain of INDIRECT reading
// INDIRECT keeps what it has.
const INDIRECT_ROUNDS = 16

// Changed cells times INDIRECT reads past which every INDIRECT is calculated again rather than each matched.
const INDIRECT_MATCHES = 4_000_000

// A cell a dynamic-array formula deleted with its own cell had spilled over (engine sheet id), and the value it spilled
// there.
interface Orphan {
	readonly address: SimpleCellAddress
	readonly value: PluginScalar
}

// A dynamic-array formula: what it spills over now from its cell, the values it spilled there (the file's before it
// first calculated here), and what its latest calculation gave, until written (writeSpills).
interface Spill {
	readonly address: SimpleCellAddress
	size: SpillSize
	values: readonly (readonly PluginScalar[])[]
	// removed: the formula is gone from its cell, and what it spilled is cleared.
	next: { readonly values: readonly (readonly PluginScalar[])[]; readonly blocked: boolean; readonly removed?: true } | undefined
}

// Whether the value a cell holds is the one spilled there.
function spilledValue(spilled: PluginScalar, held: PluginScalar): boolean {
	if (spilled === held) return true

	const a = typeof spilled === "object" && spilled !== null && "val" in spilled ? spilled.val : spilled
	const b = typeof held === "object" && held !== null && "val" in held ? held.val : held

	if (a instanceof CellError && b instanceof CellError) return a.type === b.type && a.message === b.message

	return a === b
}

// A spilled value as content the engine takes: text stays text, an error its text.
function spilledContent(value: PluginScalar): RawCellContent {
	if (value instanceof CellError) return genericErrorText(value) ?? ERROR_TEXT[value.type] ?? "#VALUE!"
	if (value === EmptyValue) return 0
	if (typeof value === "string") return `'${value}`
	if (typeof value === "object" && value !== null && "val" in value) return value.val

	return value
}

// Failing formulas at build past which the engine is built again with them held.
const REBUILD_FAILING = 256

// What the engine gives back for a formula it could not read at all.
const PARSE_ERROR = "#ERROR!"

// Content standing in for a formula the engine cannot be given: text reading as its parse error.
export const UNPARSEABLE = `'${PARSE_ERROR}`

// Changed cells read back between yields to a slice clock (releaseEvaluation).
const READ_PART = 4_096

// Cells a dynamic array spills written and evaluated between yields to a slice clock: a few milliseconds of work.
const SPILL_PART = 4_096

// Runs sliced steps to their end without yielding.
function drain<T>(steps: Generator<void, T>): T {
	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value
	}
}

// A recalculated cell's key in a batch's changes.
function changeKey(address: SimpleCellAddress): string {
	return `${String(address.sheet)},${String(address.row)},${String(address.col)}`
}

function exported(value: unknown): RecalculatedCell["value"] {
	if (value instanceof DetailedCellError) {
		// #CALC!, #NULL! and the others the engine has no type for: its generic error with that message
		// (functions/plugin.ts GENERIC_ERRORS).
		return genericErrorText(value) ?? ERROR_TEXT[value.type] ?? value.value
	}

	return typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : null
}

// Excel's smallest positive number ("Excel specifications and limits"): a result below it is 0.
const SMALLEST = 2.2250738585072014e-308
const NUM_ERROR = new DetailedCellError(new CellError(ErrorType.NUM), "#NUM!")

// A number result at Excel's 15 significant digits ("Excel specifications and limits"), from the value the engine
// holds: its export scales by a power of ten, which overflows past about 1e294 and below about 1e-294 (Infinity or
// NaN) and is off in the last digit for large numbers (1e300 as 9.999999999999999e299). Past a double, #NUM!.
function heldNumber(held: unknown): number | DetailedCellError {
	const value = typeof held === "object" && held !== null && "val" in held ? held.val : held

	if (typeof value !== "number" || !Number.isFinite(value)) return NUM_ERROR
	if (Math.abs(value) < SMALLEST) return 0

	const rounded = Number(value.toPrecision(15))

	return Number.isFinite(rounded) ? rounded : value
}

interface Pending {
	address: SimpleCellAddress
	content: RawCellContent | HeldResult
	fallback: RawCellContent | undefined
}

// What the held-result functions answer from: the engine running now (calls into HyperFormula are synchronous).
type HeldAnswer = (id: number, address: SimpleCellAddress) => number | string | boolean | CellError

let running: HeldAnswer | null = null

const HELD = "FILEN.HELD"

// FILEN.HELD(id): the result held under `id`. It is recalculated at each inserted or deleted row or column, which is
// a held result's inputs changing.
class HeldResultPlugin extends FunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		[HELD]: { method: "held", parameters: [{ argumentType: FunctionArgumentType.ANY }], isDependentOnSheetStructureChange: true }
	}

	held(ast: { readonly args: readonly { readonly value?: unknown }[] }, state: { readonly formulaAddress: SimpleCellAddress }): unknown {
		const id = ast.args[0]?.value

		return running === null || typeof id !== "number" ? new CellError(ErrorType.VALUE) : running(id, state.formulaAddress)
	}
}

let registered = false

function registerHeld(): void {
	if (registered) return

	HyperFormula.registerFunctionPlugin(HeldResultPlugin, { enGB: { [HELD]: HELD } })
	registerSheetFunctions()
	guardFunctionPlugins()
	installWholeRanges(LICENSE_KEY)
	installSharedRanges(LICENSE_KEY)
	installExactSearch(LICENSE_KEY)
	installErrorValues(LICENSE_KEY)
	installIndirect(LICENSE_KEY)
	installLiftTracking()
	registered = true
}

const ERROR_TYPES = new Map<string, ErrorType>(
	Object.entries(ERROR_TEXT).flatMap(([type, text]) => (text === CYCLE ? [] : [[text, type as ErrorType]]))
)

// What a formula naming a sheet the workbook does not have shows (Excel's reading of it).
const REF_ERROR = "#REF!"

function engineConfig(date1904: DateBase, locale: SheetLocale | undefined): Partial<ConfigParams> {
	return {
		licenseKey: LICENSE_KEY,
		// Ordinary formulas as Excel calculates them: a range where one value is expected meets the
		// formula's row or column. Array-evaluating calls are marked with ARRAYFORMULA (refs/formulaRefs.ts).
		useArrayArithmetic: false,
		// A sheet's cells are held densely (one slot per cell of its used rectangle) only when they fill most of
		// it: by default HyperFormula always does, so one value far right and one far down need gigabytes.
		chooseAddressMappingPolicy: new DenseSparseChooseBasedOnThreshold(0.8),
		maxRows: MAX_ROWS,
		maxColumns: MAX_COLUMNS,
		// Excel's serial dates (1900-02-29 included, counted from 1904, or a Strict workbook's plain count from
		// 1899-12-30: numfmt/date.ts), whitespace and empty-cell arithmetic.
		leapYear1900: date1904 === false,
		nullDate:
			date1904 === true
				? { year: 1904, month: 1, day: 1 }
				: date1904 === ISO_1900
					? { year: 1899, month: 12, day: 30 }
					: { year: 1899, month: 12, day: 31 },
		ignoreWhiteSpace: "any",
		evaluateNullToZero: true,
		// Text dates and times as the session's locale reads them (textDates.ts), in place of the engine's formats.
		dateFormats: [],
		timeFormats: [],
		parseDateTime: textDateParser(locale),
		// Results to 15 significant digits, Excel's precision ("Excel specifications and limits"); the engine's own
		// default keeps 11.
		precisionRounding: 14,
		// Text compares without case but with accents, as Excel's does: "é" is not "e" (support.microsoft.com MATCH,
		// SUMIF and EXACT read case alone as alike).
		accentSensitive: true,
		// The engine's tolerance for sums and comparisons, relative: two numbers Excel tells apart at 15 significant
		// digits (1.0000000000001 and 1) stay apart. Excel's own floating-point note.
		precisionEpsilon: 1e-15,
		// Undo is the document's own; the engine's would hold copies of what each operation replaced.
		undoLimit: 0
	}
}

// The most cells one range of a formula may cover, within the sheet it names as far as that sheet reaches: the
// engine reads a range's every cell (a whole-column VLOOKUP over a sheet with a cell in its last row is twelve
// million).
const MAX_RANGE_CELLS = 2_097_152

// Collects the sheets one formula reads whole columns or rows of together (wholeRanges.ts), its defined names
// included when there are any.
interface WholeLink {
	names(): boolean
	add(sheets: ReadonlySet<string>, names: readonly string[], own: number): void
}

// The most cells a sheet's whole-column (whole-row) references may read in all at one recalculation, once a cell
// written far past the cells they cover makes them reach that far (about four seconds of the engine's reading).
const MAX_SHEET_READS = 8_388_608

interface SheetExtent {
	readonly name: string
	readonly height: number
	readonly width: number
}

// Why the engine is not given a formula: it names a sheet the workbook lacks ("sheet": the engine would keep a
// placeholder for it, and fails on the cell when it is written next), or a range past what the engine can read
// ("range"), a whole column or row of a sheet in `heavy` (upper-case names) included. Null when it is given.
function unreadable(
	content: unknown,
	sheets: readonly SheetExtent[],
	own: number,
	reach?: (sheet: string, cols: number, rows: number) => void,
	heavy?: ReadonlySet<string>,
	link?: WholeLink
): "sheet" | "range" | null {
	if (typeof content !== "string" || !content.startsWith("=") || content.startsWith(`=${HELD}(`)) return null

	// A formula naming no other sheet and no range reads whole columns only through defined names.
	const plain = !content.includes("!") && !content.includes(":")

	if (plain && link?.names() !== true) return null

	const inputs = formulaInputs(content.slice(1))
	const refs = inputs.refs

	// The sheets whose whole columns or rows this formula reads, which then end together (wholeRanges.ts).
	if (link !== undefined) {
		const whole = new Set<string>()

		for (const ref of refs) {
			if (ref.area.kind === "cell" || ref.lastSheet !== null) continue

			const named = ref.sheet === null ? sheets[own] : sheets.find(sheet => sameSheet(sheet.name, ref.sheet ?? ""))

			if (named !== undefined) whole.add(named.name)
		}

		link.add(whole, inputs.names, own)
	}

	if (plain) return null

	for (const ref of refs) {
		// The engine has no 3-D references: one left here is not spelled sheet by sheet (spanned).
		if (ref.lastSheet !== null) return "sheet"

		const first = ref.sheet === null ? sheets[own] : sheets.find(sheet => sameSheet(sheet.name, ref.sheet ?? ""))

		if (first === undefined) return "sheet"

		const area = ref.area

		if (!area.range && area.kind === "cell") continue
		if (area.kind !== "cell" && heavy?.has(first.name.toUpperCase()) === true) return "range"

		const top = area.kind === "cols" ? 0 : Math.min(area.startRow, area.endRow)
		const bottom = area.kind === "cols" ? first.height - 1 : Math.min(Math.max(area.startRow, area.endRow), first.height - 1)
		const left = area.kind === "rows" ? 0 : Math.min(area.startCol, area.endCol)
		const right = area.kind === "rows" ? first.width - 1 : Math.min(Math.max(area.startCol, area.endCol), first.width - 1)

		if (Math.max(0, bottom - top + 1) * Math.max(0, right - left + 1) > MAX_RANGE_CELLS) return "range"

		// What it would read were the sheet to reach its last row or column.
		const cols = Math.abs(area.endCol - area.startCol) + 1
		const rows = Math.abs(area.endRow - area.startRow) + 1

		if (area.kind === "cols" || (area.kind === "cell" && rows * cols > MAX_RANGE_CELLS)) reach?.(first.name, cols, 0)
		if (area.kind === "rows" || (area.kind === "cell" && rows * cols > MAX_RANGE_CELLS)) reach?.(first.name, 0, rows)
	}

	return null
}

// Whether a formula reads its own cell (a reference to it, or a range holding it, on its own sheet): a circle, whatever
// the other cells hold. Its own cell's name in the text is looked for first, so most formulas are not parsed.
function readsItself(content: unknown, own: number, row: number, col: number, sheets: readonly string[]): boolean {
	if (typeof content !== "string" || !content.startsWith("=")) return false

	const text = content.includes("$") ? content.replaceAll("$", "") : content
	const name = cellName(row, col)
	let at = text.toUpperCase().indexOf(name)

	for (; at >= 0; at = text.toUpperCase().indexOf(name, at + 1)) {
		const before = text.charCodeAt(at - 1)
		const after = text.charCodeAt(at + name.length)

		if (!(before >= 65 && before <= 90) && !(before >= 97 && before <= 122) && !(after >= 48 && after <= 57)) break
	}

	if (at < 0) return false

	return formulaInputs(content.slice(1)).refs.some(ref => {
		if (ref.lastSheet !== null || (ref.sheet !== null && !sameSheet(ref.sheet, sheets[own] ?? ""))) return false

		const area = ref.area

		if (area.kind === "cols") return col >= Math.min(area.startCol, area.endCol) && col <= Math.max(area.startCol, area.endCol)
		if (area.kind === "rows") return row >= Math.min(area.startRow, area.endRow) && row <= Math.max(area.startRow, area.endRow)

		return (
			row >= Math.min(area.startRow, area.endRow) &&
			row <= Math.max(area.startRow, area.endRow) &&
			col >= Math.min(area.startCol, area.endCol) &&
			col <= Math.max(area.startCol, area.endCol)
		)
	})
}

// The functions Excel takes 3-D references in ("Create a reference to the same cell range on multiple worksheets").
const SPAN_FUNCTIONS: ReadonlySet<string> = new Set([
	"SUM",
	"AVERAGE",
	"AVERAGEA",
	"COUNT",
	"COUNTA",
	"MAX",
	"MAXA",
	"MIN",
	"MINA",
	"PRODUCT",
	"STDEV",
	"STDEVA",
	"STDEVP",
	"STDEVPA",
	"STDEV.S",
	"STDEV.P",
	"VAR",
	"VARA",
	"VARP",
	"VARPA",
	"VAR.S",
	"VAR.P"
])

// Text that may hold a 3-D reference: a colon before a sheet prefix's "!".
const MAY_SPAN = /:[^(),]*!/

// A formula with its 3-D references spelled sheet by sheet over the workbook's sheets in order, which the engine
// reads; as given when it has none, or one it cannot be spelled for (unreadable holds it then). The sheets it spans
// change only where the engine is built again (a sheet moved or deleted) or at an end (an added sheet, a removed last
// one, whose references the engine makes #REF!), and a renamed one keeps its place.
function spanned<T>(content: T, sheets: readonly string[]): T | string {
	if (typeof content !== "string" || !content.startsWith("=") || !MAY_SPAN.test(content)) return content

	const text = spannedReferences(content.slice(1), sheets, SPAN_FUNCTIONS)

	return text === null ? content : `=${text}`
}

// What a formula the engine is not given shows when its file stored no result.
function unreadableShows(reason: "sheet" | "range"): RawCellContent {
	return reason === "sheet" ? REF_ERROR : UNPARSEABLE
}

// A sheet's contents as the engine writes them back, each row up to its last cell. getSheetSerialized fills every row
// to the sheet's width and height, which a cell at the grid's far edge makes past what memory holds.
function serializedSheet(engine: HyperFormula, id: number): RawCellContent[][] {
	const rows: RawCellContent[][] = []

	for (const [address] of engine.dependencyGraph.addressMapping.sheetEntries(id)) {
		const content = engine.getCellSerialized(address)

		if (content === null || content === undefined) continue

		while (rows.length <= address.row) rows.push([])

		const row = rows[address.row] as RawCellContent[]

		while (row.length < address.col) row.push(null)

		row[address.col] = content
	}

	return rows
}

// A value the engine gave, as content holding it: text kept as text, an error as its text.
function rawValue(value: unknown): RawCellContent | undefined {
	if (value instanceof DetailedCellError) return exported(value) ?? undefined
	if (typeof value === "string") return `'${value}`

	return typeof value === "number" || typeof value === "boolean" ? value : undefined
}

// A held result as the engine's functions give it: text without the apostrophe that keeps it text, an error
// text as the error.
function heldInterpreterValue(value: RawCellContent): number | string | boolean | CellError {
	if (typeof value === "number" || typeof value === "boolean") return value
	if (typeof value !== "string") return 0
	if (value.startsWith("'")) return value.slice(1)

	const type = ERROR_TYPES.get(value)

	if (type !== undefined) return new CellError(type)

	return GENERIC_ERRORS.has(value) ? new CellError(ErrorType.ERROR, value) : value
}

export class FormulaEngine {
	private engine: HyperFormula
	// Grid sheet index (worksheets only, as the grid lists them) → engine sheet id.
	private readonly sheetIds: number[] = []
	// Held results by id (FILEN.HELD's first argument), as the engine's functions give them.
	private readonly heldValues: (number | string | boolean | CellError)[] = []
	private readonly held: ((sheet: number, row: number, col: number) => void) | undefined
	private readonly config: Partial<ConfigParams>
	// Per sheet (upper-case name), the widest span of columns a formula reads to the sheet's last row, and of rows it
	// reads to its last column: what a cell written past the sheet's reach makes the engine read.
	private readonly reaches = new Map<string, { cols: number; rows: number }>()
	private readonly reach = (sheet: string, cols: number, rows: number): void => {
		const key = sheet.toUpperCase()
		const known = this.reaches.get(key)

		this.reaches.set(key, { cols: Math.max(known?.cols ?? 0, cols), rows: Math.max(known?.rows ?? 0, rows) })
	}
	// The held results recalculated while an edit is recorded (their inputs changed), by changeKey.
	private recorded: Map<string, SimpleCellAddress> | null = null
	// Sets made while evaluation is held (holdEvaluation): their cells, recalculated together at releaseEvaluation.
	private deferred: {
		readonly own: Set<string>
		readonly pending: Pending[]
		// Sheet index, row, col of each cell set.
		readonly written: number[]
		results: RecalculatedCell[]
	} | null = null
	// Whether a row is shown, hidden or hidden by a filter (functions/plugin.ts ROW_*), by grid sheet index: what
	// SUBTOTAL and AGGREGATE leave out.
	private readonly rows: ((sheet: number, row: number) => number) | undefined
	private readonly blocking: ((sheet: number, range: SpillRange) => boolean) | undefined
	private readonly shownFormula: ((sheet: number, row: number, col: number) => string | null) | undefined
	private readonly calcA1: boolean
	// The cells whose formula calls SUBTOTAL or AGGREGATE, by engine sheet id (row * MAX_COLUMNS + col): calculated
	// again when rows are hidden or shown (rowsChanged).
	private readonly totals = new Map<number, Set<number>>()
	// Each engine sheet id's grid index while the first build calculates (sheetIds is filled after it).
	private building: number[] | null = null
	// Where its whole-column and whole-row references end (wholeRanges.ts).
	private readonly whole = new WholeRanges()
	// The defined names by scope (grid sheet index, -1 for the workbook's) and upper-case name.
	private readonly definedNames = new Map<string, EngineName>()
	// The workbook's sheet names in grid order, for the names' own references.
	private sheetNames: readonly string[] = []
	// The dynamic-array formulas by changeKey of their cell (writeSpills).
	private readonly spills = new Map<string, Spill>()
	// Whether what dynamic arrays calculate is written (not while the engine is built from the file).
	private spilling = false
	private readonly spillHost: SpillHost = {
		owned: anchor => {
			const entry = this.spills.get(changeKey(anchor))

			// Before the build has its values, the cells it spills over are its whatever they hold.
			return entry === undefined ? undefined : { size: entry.size, values: entry.values.length === 0 ? undefined : entry.values }
		},
		spilled: (anchor, values, blocked) => {
			const key = changeKey(anchor)
			let entry = this.spills.get(key)

			if (entry === undefined) {
				entry = { address: anchor, size: { rows: 1, cols: 1 }, values: [[0]], next: undefined }
				this.spills.set(key, entry)
			}

			entry.next = { values, blocked }
		},
		blocks: (anchor, rows, cols) => {
			const sheet = this.building === null ? this.sheetIndex(anchor.sheet) : (this.building[anchor.sheet] ?? -1)

			return (
				sheet >= 0 &&
				this.blocking?.(sheet, {
					startRow: anchor.row,
					startCol: anchor.col,
					endRow: anchor.row + rows - 1,
					endCol: anchor.col + cols - 1
				}) === true
			)
		}
	}
	// What each INDIRECT call read at its last calculation (by changeKey of its cell), and the run that was.
	private readonly indirectReads = new Map<string, { address: SimpleCellAddress; vertex: unknown; reads: IndirectRead[]; run: number }>()
	// Each top-level run of the engine's (run), counted.
	private runs = 0
	// While an engine is built (this.engine is not it yet).
	private inBuild = false
	// A sheet was added, renamed or removed: what INDIRECT names by sheet name may be another sheet's now, so every
	// INDIRECT calculates again at the next recalculation.
	private sheetsChanged = false
	private depth = 0
	private readonly indirect: IndirectHost = {
		name: (name, own) => {
			const sheet = this.building === null ? this.sheetIndex(own) : (this.building[own] ?? -1)
			const upper = name.toUpperCase()
			const named = this.definedNames.get(`${String(sheet)}|${upper}`) ?? this.definedNames.get(`-1|${upper}`)

			if (named === undefined) return undefined

			const scope =
				named.scope === undefined ? own : this.building === null ? this.sheetIds[named.scope] : this.building.indexOf(named.scope)

			return { text: named.expression, sheet: scope ?? own }
		},
		read: (address, read) => {
			const key = changeKey(address)
			const known = this.indirectReads.get(key)

			if (known === undefined || known.run !== this.runs) {
				// The cell's formula as calculated now: written over, it is another (followRound lets go of it).
				const vertex = this.inBuild ? null : this.engine.dependencyGraph.addressMapping.getCell(address)

				this.indirectReads.set(key, { address, vertex, reads: read === null ? [] : [read], run: this.runs })
			} else if (read !== null) known.reads.push(read)
		},
		formula: at => {
			const shown = this.shownFormula

			if (shown === undefined) return null

			const sheet = this.building === null ? this.sheetIndex(at.sheet) : (this.building[at.sheet] ?? -1)

			return sheet < 0 ? null : shown(sheet, at.row, at.col)
		},
		calcA1: () => this.calcA1
	}
	private readonly link: WholeLink = {
		names: () => this.definedNames.size > 0,
		add: (sheets, names, own) => {
			const all = new Set(sheets)

			for (const name of names) for (const sheet of this.namedWhole(name, own, new Set())) all.add(sheet)

			if (all.size > 1) this.whole.link([...all])
		}
	}

	// The sheets whose whole columns or rows a defined name reads, through the names it names in turn.
	private namedWhole(name: string, own: number, seen: Set<EngineName>): string[] {
		const named = this.definedNames.get(`${String(own)}|${name}`) ?? this.definedNames.get(`-1|${name}`)

		if (named === undefined || seen.has(named)) return []

		seen.add(named)

		const at = named.scope ?? own
		const inputs = formulaInputs(named.expression)
		const sheets: string[] = []

		for (const ref of inputs.refs) {
			if (ref.area.kind === "cell" || ref.lastSheet !== null) continue

			const sheet = ref.sheet === null ? this.sheetNames[at] : this.sheetNames.find(known => sameSheet(known, ref.sheet ?? ""))

			if (sheet !== undefined) sheets.push(sheet)
		}

		for (const inner of inputs.names) appendAll(sheets, this.namedWhole(inner, at, seen))

		return sheets
	}

	// `held`: told of each cell this engine comes to hold on its own account (a formula it fails on), by grid sheet
	// index; with it, a formula in a circle the engine finds, or naming a sheet the workbook lacks, is held too (the
	// caller tracks what held results read).
	// `rows`: whether a row of a sheet (by grid sheet index) is shown (0), hidden (1) or hidden by a filter (2); every
	// row shown without it. `locale`: how text dates in formulas read (en-US's month first without it). `blocking`:
	// whether a range of a sheet (by grid sheet index) holds a merged cell or a table, which a dynamic array does not
	// spill over. `shownFormula`: a cell's formula (by grid sheet index) as the formula bar shows it, "=" first, or
	// null for a cell without one, which FORMULATEXT gives; it is #N/A everywhere without it (the engine's text is
	// its own rewrite of the user's). `calcA1`: the workbook came from an .ods file, whose INDIRECT also reads
	// LibreOffice's Calc A1 text (Sheet.A1).
	constructor(
		sheets: readonly EngineSheet[],
		names: readonly EngineName[],
		date1904: DateBase = false,
		held?: (sheet: number, row: number, col: number) => void,
		rows?: (sheet: number, row: number) => number,
		locale?: SheetLocale,
		blocking?: (sheet: number, range: SpillRange) => boolean,
		shownFormula?: (sheet: number, row: number, col: number) => string | null,
		calcA1 = false
	) {
		this.calcA1 = calcA1
		this.held = held
		this.rows = rows
		this.blocking = blocking
		this.shownFormula = shownFormula
		this.config = engineConfig(date1904, locale)
		this.sheetNames = sheets.map(sheet => sheet.name)

		for (const named of names) this.definedNames.set(`${String(named.scope ?? -1)}|${named.name.toUpperCase()}`, named)
		registerHeld()

		// A null-prototype record: a sheet named "__proto__" is a key like any other.
		const contents = Object.create(null) as Record<string, RawCellContent[][]>

		const extents: SheetExtent[] = sheets.map(sheet => ({
			name: sheet.name,
			height: sheet.rows.length,
			width: sheet.rows.reduce((width, row) => Math.max(width, row.length), 0)
		}))
		const missing: { sheet: number; row: number; col: number }[] = []

		sheets.forEach((sheet, index) => {
			const fallbacks = new Map<number, RawCellContent>()

			for (const cell of sheet.formulas) {
				const row = sheet.rows[cell.row]

				if (row !== undefined && cell.content instanceof HeldResult) row[cell.col] = this.holding(cell.content)
				if (cell.fallback !== undefined) fallbacks.set(cell.row * MAX_COLUMNS + cell.col, cell.fallback)
			}

			sheet.rows.forEach((row, rowIndex) => {
				row.forEach((given, col) => {
					const value = spanned(given, this.sheetNames)

					if (value !== given) row[col] = value

					const reason = unreadable(value, extents, index, this.reach, undefined, this.link)

					if (reason === null || held === undefined) return

					row[col] = this.holding(new HeldResult(fallbacks.get(rowIndex * MAX_COLUMNS + col) ?? unreadableShows(reason)))
					missing.push({ sheet: index, row: rowIndex, col })
				})
			})

			contents[sheet.name] = sheet.rows as RawCellContent[][]
		})

		for (const cell of missing) this.held?.(cell.sheet, cell.row, cell.col)

		// The names come with the build, so it calculates once. A name the engine cannot take (a print area it has
		// no syntax for) is left out: what uses it keeps the file's results (the caller holds them,
		// FormulaEngine.refusedNames). The engine numbers the sheets in the record's key order.
		const order = Object.keys(contents)
		const refused = FormulaEngine.refusedNames(
			sheets.map(sheet => sheet.name),
			names
		)
		const namedExpressions = names.flatMap((named, index) => {
			const sheet = named.scope === undefined ? undefined : sheets[named.scope]
			const scope = sheet === undefined ? undefined : order.indexOf(sheet.name)

			return refused.has(index) || scope === -1
				? []
				: [{ name: named.name, expression: `=${named.expression}`, ...(scope !== undefined && { scope }) }]
		})

		const build = (): HyperFormula => {
			this.inBuild = true

			try {
				return this.run(() => HyperFormula.buildFromSheets(contents, this.config, namedExpressions))
			} finally {
				this.inBuild = false
			}
		}

		// The dynamic arrays, each over what the file has it spill over.
		sheets.forEach(sheet => {
			const id = order.indexOf(sheet.name)

			for (const cell of sheet.formulas)
				if (cell.spill !== undefined) this.ownSpill({ sheet: id, row: cell.row, col: cell.col }, cell.spill)
		})

		// While the first build calculates, the engine's sheet ids are the record's key order.
		this.building = order.map(name => sheets.findIndex(sheet => sheet.name === name))
		this.engine = build()
		this.building = null

		for (const sheet of sheets) {
			const id = this.engine.getSheetId(sheet.name)

			if (id === undefined) {
				throw new Error(`spreadsheet: engine has no sheet ${sheet.name}`)
			}

			this.sheetIds.push(id)
		}

		sheets.forEach((sheet, index) => {
			const id = this.sheetIds[index]

			if (id === undefined) return

			sheet.rows.forEach((row, rowIndex) => {
				row.forEach((value, col) => {
					if (typeof value === "string" && CALLS_TOTAL.test(value)) this.noteTotal(id, rowIndex, col, value)
				})
			})
		})

		let pending = sheets.flatMap((sheet, index) => sheet.formulas.flatMap(cell => this.pending(index, cell)))

		// Many formulas the engine fails on (a circle through thousands of cells): built again with them held, which
		// costs less than replacing each one (every cell a held formula read lets go of its dependencies).
		const failing = pending.flatMap(cell => {
			const held = this.failure(cell)

			return held === null ? [] : [{ cell, held }]
		})

		if (failing.length >= REBUILD_FAILING) {
			for (const { cell, held } of failing) {
				const row = contents[order[cell.address.sheet] ?? ""]?.[cell.address.row]

				if (row !== undefined) row[cell.address.col] = this.holding(held)

				this.heldBy(cell.address)
			}

			this.engine.destroy()
			this.engine = build()

			const failed = new Set(failing.map(({ cell }) => cell))

			pending = pending.filter(cell => !failed.has(cell))
		}

		this.settle(pending, new Map())
		this.followDynamic(new Map(), true)
		this.snapshotSpills()
		this.spilling = true
	}

	// A dynamic-array formula at `address` (engine sheet id) spilling over `size`: its values the cells' as they stand
	// once the engine has them (snapshotSpills).
	private ownSpill(address: SimpleCellAddress, size: SpillSize): void {
		this.spills.set(changeKey(address), { address, size, values: [], next: undefined })
	}

	// The dynamic arrays of a sheet after rows or columns were inserted (count > 0) or deleted (count < 0) at `at`: a
	// formula moves with its cell (one deleted is gone), and what it spills over grows or shrinks where the edit runs
	// through it, its values with it.
	// Returns the cells, where they are after the edit, that a formula deleted with its cell had spilled over: what
	// it spilled there goes with it (orphanedSpills).
	private moveSpills(id: number, axis: SizeAxis, at: number, count: number): Orphan[] {
		const moved: Spill[] = []
		const orphans: Orphan[] = []

		for (const [key, entry] of this.spills) {
			if (entry.address.sheet !== id) continue

			this.spills.delete(key)

			const start = axis === "rows" ? entry.address.row : entry.address.col
			const length = axis === "rows" ? entry.size.rows : entry.size.cols

			if (count < 0 && start >= at && start < at - count) {
				// Past the deleted run, the rest of what it spilled over moves up (or left) by the run.
				for (let offset = at - count - start; offset < length; offset++) {
					const across = axis === "rows" ? entry.size.cols : entry.size.rows

					for (let other = 0; other < across; other++) {
						const value = axis === "rows" ? entry.values[offset]?.[other] : entry.values[other]?.[offset]

						if (value === undefined) continue

						orphans.push({
							address:
								axis === "rows"
									? { sheet: id, row: start + offset + count, col: entry.address.col + other }
									: { sheet: id, row: entry.address.row + other, col: start + offset + count },
							value
						})
					}
				}

				continue
			}

			const shifted = start >= at ? Math.max(at, start + count) : start
			// The part of what it spills over the edit runs through, from its own cell.
			const from = Math.max(at - start, 1)
			const span =
				count > 0
					? at > start && at < start + length
						? count
						: 0
					: Math.max(0, Math.min(start + length, at - count) - Math.max(start + 1, at))
			const next = count > 0 ? length + span : length - span
			// Rows move whole lines (the lines themselves are not copied); columns change each line.
			const values = axis === "rows" ? (entry.values.slice() as PluginScalar[][]) : entry.values.map(line => [...line])

			if (axis === "rows") {
				if (count > 0 && span > 0)
					spliceAll(
						values,
						from,
						0,
						Array.from({ length: span }, () => new Array<PluginScalar>(entry.size.cols).fill(EmptyValue))
					)
				else if (span > 0) values.splice(from, span)
			} else {
				for (const line of values) {
					if (count > 0 && span > 0) spliceAll(line, from, 0, new Array<PluginScalar>(span).fill(EmptyValue))
					else if (span > 0) line.splice(from, span)
				}
			}

			moved.push({
				address: axis === "rows" ? { ...entry.address, row: shifted } : { ...entry.address, col: shifted },
				size: axis === "rows" ? { rows: next, cols: entry.size.cols } : { rows: entry.size.rows, cols: next },
				values,
				next: undefined
			})
		}

		for (const entry of moved) this.spills.set(changeKey(entry.address), entry)

		return orphans
	}

	// Clears the cells orphans name that still hold what was spilled there (a value of the user's own stays), and
	// adds what that changes to `changes`, the cleared cells as spilled.
	private *orphanedSpills(orphans: readonly Orphan[], changes: Map<string, RecalculatedCell>): Generator<void, void> {
		const graph = this.engine.dependencyGraph
		const cleared = orphans.filter(orphan => {
			const vertex = graph.addressMapping.getCell(orphan.address)

			return (
				vertex !== undefined &&
				typeof (vertex as { getFormula?: unknown }).getFormula !== "function" &&
				spilledValue(orphan.value, graph.getScalarValue(orphan.address))
			)
		})

		if (cleared.length === 0) return

		const written = yield* this.recordingSteps(
			() =>
				this.batched(() => {
					for (const orphan of cleared) this.engine.setCellContents(orphan.address, null)
				}),
			null
		)
		const keys = new Set(cleared.map(orphan => changeKey(orphan.address)))

		for (const [key, cell] of written) changes.set(key, keys.has(key) ? { ...cell, spilled: true } : cell)
	}

	// The values the dynamic arrays spill over, as the engine holds them: what each spilled.
	private snapshotSpills(): void {
		const graph = this.engine.dependencyGraph

		for (const entry of this.spills.values()) {
			if (entry.values.length > 0) continue

			const values: PluginScalar[][] = []

			for (let row = 0; row < entry.size.rows; row++) {
				const line: PluginScalar[] = []

				for (let col = 0; col < entry.size.cols; col++) {
					const at = { sheet: entry.address.sheet, row: entry.address.row + row, col: entry.address.col + col }

					line.push(graph.addressMapping.getCell(at) === undefined ? EmptyValue : graph.getScalarValue(at))
				}

				values.push(line)
			}

			entry.values = values
		}
	}

	// The names the engine cannot give a defined name, by index (it reads CustomCost1 or R2D2 as a reference, which
	// Excel does not): such a name is given to it under an alias.
	static unnamable(names: readonly string[]): Set<number> {
		const unnamable = new Set<number>()

		if (names.length === 0) return unnamable

		const engine = HyperFormula.buildEmpty({ licenseKey: LICENSE_KEY })

		try {
			names.forEach((name, index) => {
				if (!engine.isItPossibleToAddNamedExpression(name, "=1")) unnamable.add(index)
			})
		} finally {
			engine.destroy()
		}

		return unnamable
	}

	// The defined names the engine cannot take, by index: syntax it has no reading for (it would take some as
	// names whose value is a parse error). `sheets` are the grid's worksheet names, which a name's scope indexes.
	static refusedNames(sheets: readonly string[], names: readonly EngineName[]): Set<number> {
		const refused = new Set<number>()

		if (names.length === 0) return refused

		const contents = Object.create(null) as Record<string, RawCellContent[][]>

		for (const name of sheets) contents[name] = []

		const engine = HyperFormula.buildFromSheets(contents, { licenseKey: LICENSE_KEY, maxRows: MAX_ROWS, maxColumns: MAX_COLUMNS })

		try {
			names.forEach((named, index) => {
				const sheet = named.scope === undefined ? undefined : sheets[named.scope]
				const scope = sheet === undefined ? undefined : engine.getSheetId(sheet)

				const expression = `=${named.expression}`

				if (!engine.validateFormula(expression) || !engine.isItPossibleToAddNamedExpression(named.name, expression, scope))
					refused.add(index)
			})
		} finally {
			engine.destroy()
		}

		return refused
	}

	// Runs work that may calculate: the held-result functions answer from this engine meanwhile.
	private run<T>(work: () => T): T {
		const previous = running

		running = this.answer

		if (this.depth++ === 0) this.runs++

		try {
			return withSpill(this.spillHost, () =>
				withIndirect(this.indirect, () =>
					withWholeRanges(this.whole, () => (this.rows === undefined ? work() : withRowState(this.rowState, work)))
				)
			)
		} finally {
			running = previous
			this.depth--
		}
	}

	// After a calculation that changed `changes`: INDIRECT and spill references calculated again where a cell they read
	// changed (every one of them with `all`), and what dynamic arrays spilled written beside them, round by round with
	// what that changes in turn, all added to `changes`. An INDIRECT the run calculated read a changed value cell after
	// it was written; a formula cell the run calculated may have come after it.
	private followDynamic(changes: Map<string, RecalculatedCell>, all = false): void {
		drain(this.following(changes, all))
	}

	// followDynamic in steps: a large spill is written and read back a part at a time.
	private *following(changes: Map<string, RecalculatedCell>, all = false): Generator<void, void> {
		let round: ReadonlyMap<string, RecalculatedCell> = changes
		let every = all || this.sheetsChanged

		this.sheetsChanged = false

		for (let count = 0; count < INDIRECT_ROUNDS; count++) {
			const next = new Map<string, RecalculatedCell>()

			yield* this.followRound(round, every, next)
			every = false
			yield* this.writeSpills(next)

			if (next.size === 0) return

			let moved = 0

			for (const [key, cell] of next) {
				if (++moved % READ_PART === 0) yield

				changes.set(key, cell)
			}

			round = next
		}
	}

	private *followRound(
		round: ReadonlyMap<string, RecalculatedCell>,
		every: boolean,
		next: Map<string, RecalculatedCell>
	): Generator<void, void> {
		if (this.indirectReads.size === 0) return

		const run = this.runs
		const due: SimpleCellAddress[] = []
		let reads = 0

		for (const entry of this.indirectReads.values()) reads += entry.reads.length

		const all = every || round.size * reads > INDIRECT_MATCHES

		const graph = this.engine.dependencyGraph

		for (const [key, entry] of this.indirectReads) {
			const vertex = graph.addressMapping.getCell(entry.address)

			// Written over or moved: what is there now records its own reads when it calculates.
			if (vertex === undefined || (entry.vertex !== null && vertex !== entry.vertex)) {
				this.indirectReads.delete(key)

				continue
			}

			entry.vertex = vertex

			if (all || (yield* this.readsChanged(key, entry, round, entry.run === run))) due.push(entry.address)
		}

		if (due.length === 0) return

		yield* this.collecting(
			this.run(() =>
				this.batched(() => {
					const graph = this.engine.dependencyGraph

					for (const address of due) {
						const vertex = graph.addressMapping.getCell(address)

						if (vertex !== undefined) graph.graph.markNodeAsDirty(vertex)
					}
				})
			),
			next
		)
	}

	// Writes what the dynamic arrays calculated since spilled: their values over the cells beside and below them, the
	// cells they no longer reach cleared (a cell of the user's own among them is kept: it is what blocks one). Reported in
	// `next` as spilled, and each formula's cell with what it spills over now. While the engine is built, nothing: it
	// holds the file's values, which the formula's next calculation writes over where they differ.
	// The cells are visited, written and read back a part at a time.
	private *writeSpills(next: Map<string, RecalculatedCell>): Generator<void, void> {
		const pending: Spill[] = []

		for (const entry of this.spills.values()) if (entry.next !== undefined) pending.push(entry)

		if (pending.length === 0) return

		if (this.building !== null || !this.spilling) {
			for (const entry of pending) entry.next = undefined

			return
		}

		const graph = this.engine.dependencyGraph
		const writes: { address: SimpleCellAddress; content: RawCellContent }[] = []
		const outputs = new Set<string>()
		let visited = 0

		for (const entry of pending) {
			const calculated = entry.next

			if (calculated === undefined) continue

			entry.next = undefined

			const { address } = entry
			const values = calculated.values
			const height = calculated.blocked ? 1 : values.length
			const width = calculated.blocked ? 1 : (values[0]?.length ?? 1)

			for (let row = 0; row < Math.max(height, entry.size.rows); row++) {
				for (let col = 0; col < Math.max(width, entry.size.cols); col++) {
					if (row === 0 && col === 0) continue
					if (++visited % READ_PART === 0) yield

					const at = { sheet: address.sheet, row: address.row + row, col: address.col + col }
					const inside = row < height && col < width
					const vertex = graph.addressMapping.getCell(at)
					const held = vertex === undefined ? EmptyValue : graph.getScalarValue(at)

					if (inside) {
						const value = values[row]?.[col] ?? 0

						if (vertex === undefined || !spilledValue(value, held)) writes.push({ address: at, content: spilledContent(value) })
					} else if (row < entry.size.rows && col < entry.size.cols && vertex !== undefined && held !== EmptyValue) {
						// A cell it spilled over, unless the user's own (a formula, or a value other than the one spilled).
						const isFormula = typeof (vertex as { getFormula?: unknown }).getFormula === "function"
						const last = entry.values[row]?.[col]

						if (!isFormula && last !== undefined && spilledValue(last, held)) writes.push({ address: at, content: null })
					} else continue

					outputs.add(changeKey(at))
				}
			}

			entry.size = { rows: height, cols: width }
			entry.values = calculated.blocked ? [[spillError()]] : (values as PluginScalar[][])

			if (calculated.removed === true) this.spills.delete(changeKey(address))
		}

		const written = new Map<string, RecalculatedCell>()

		if (writes.length > 0) {
			// As batched, in parts: nothing else reaches the engine between them (a session answers nothing else until
			// an edit is done).
			// A part at a time, each evaluated: the engine's evaluation walks every cell written, too long a task at once
			// for a large spill. What reads the spill may calculate once per part; its last calculation is the one kept.
			for (let start = 0; start < writes.length; start += SPILL_PART) {
				if (start > 0) yield

				yield* this.collecting(
					this.run(() =>
						this.batched(() => {
							for (let i = start; i < Math.min(writes.length, start + SPILL_PART); i++) {
								const write = writes[i] as { address: SimpleCellAddress; content: RawCellContent }

								this.engine.setCellContents(write.address, write.content)
							}
						})
					),
					written
				)
			}
		}

		let reported = 0

		for (const [key, cell] of written) {
			if (++reported % READ_PART === 0) yield

			next.set(key, outputs.has(key) ? { ...cell, spilled: true } : cell)
		}

		for (const entry of pending) {
			const key = changeKey(entry.address)
			const sheet = this.sheetIndex(entry.address.sheet)
			const known = next.get(key)

			if (sheet < 0 || this.spills.get(key) !== entry) continue

			next.set(key, {
				...(known ?? {
					sheet,
					row: entry.address.row,
					col: entry.address.col,
					...this.result(sheet, entry.address.row, entry.address.col)
				}),
				spill: entry.size
			})

			// What it spilled is no change it read.
			const reads = this.indirectReads.get(key)

			if (reads !== undefined) reads.run = this.runs
		}
	}

	// Whether a cell an INDIRECT read is among `changes` (its own cell aside): a formula cell, or any cell when the run
	// that made the changes did not calculate the INDIRECT (`calculated` false).
	private *readsChanged(
		key: string,
		entry: { readonly reads: readonly IndirectRead[] },
		changes: ReadonlyMap<string, RecalculatedCell>,
		calculated: boolean
	): Generator<void, boolean> {
		let visited = 0

		for (const [changed, cell] of changes) {
			if (++visited % READ_PART === 0) yield
			if (changed === key) continue

			const sheet = this.sheetIds[cell.sheet]

			if (sheet === undefined) continue

			for (const read of entry.reads) {
				if (
					read.sheet === sheet &&
					cell.row >= read.startRow &&
					cell.row <= read.endRow &&
					cell.col >= read.startCol &&
					cell.col <= read.endCol &&
					(!calculated || this.engine.doesCellHaveFormula({ sheet, row: cell.row, col: cell.col }))
				)
					return true
			}
		}

		return false
	}

	private readonly rowState = (sheet: number, row: number): number =>
		this.rows?.(this.building === null ? this.sheetIndex(sheet) : (this.building[sheet] ?? -1), row) ?? 0

	// Keeps the registry of SUBTOTAL and AGGREGATE cells in step with what a cell is given.
	private noteTotal(id: number, row: number, col: number, content: unknown): void {
		const key = row * MAX_COLUMNS + col

		if (typeof content === "string" && CALLS_TOTAL.test(content)) {
			let cells = this.totals.get(id)

			if (cells === undefined) {
				cells = new Set()
				this.totals.set(id, cells)
			}

			cells.add(key)
		} else this.totals.get(id)?.delete(key)
	}

	// The registry after rows or columns are inserted (count > 0) or deleted (count < 0) at `at` of one sheet.
	private moveTotals(id: number, axis: SizeAxis, at: number, count: number): void {
		const cells = this.totals.get(id)

		if (cells === undefined || cells.size === 0) return

		const moved = new Set<number>()

		for (const key of cells) {
			const row = Math.floor(key / MAX_COLUMNS)
			const col = key % MAX_COLUMNS
			const index = axis === "rows" ? row : col

			if (count < 0 && index >= at && index < at - count) continue

			const next = index >= at ? index + count : index

			moved.add(axis === "rows" ? next * MAX_COLUMNS + col : row * MAX_COLUMNS + next)
		}

		this.totals.set(id, moved)
	}

	// Rows were hidden or shown (by hand or by a filter): every SUBTOTAL and AGGREGATE is calculated again, and what
	// changed reported as `set` reports it.
	rowsChanged(): RecalculatedCell[] {
		const cells: SimpleCellAddress[] = []

		for (const [sheet, keys] of this.totals) {
			for (const key of keys) {
				const address = { sheet, row: Math.floor(key / MAX_COLUMNS), col: key % MAX_COLUMNS }
				const formula = this.engine.getCellFormula(address)

				if (formula !== undefined && CALLS_TOTAL.test(formula)) cells.push(address)
				else keys.delete(key)
			}
		}

		if (cells.length === 0) return []

		return [
			...this.recording(
				() =>
					this.batched(() => {
						for (const address of cells) this.engine.setCellContents(address, this.engine.getCellFormula(address) ?? null)
					}),
				null
			).values()
		]
	}

	// What a sheet's dynamic arrays may spill over changed (cells merged or unmerged, a table): each is calculated
	// again, and what that changes returned. `sheet`: grid sheet index.
	spillsChanged(sheet: number): RecalculatedCell[] {
		const id = this.sheetIds[sheet]
		const anchors = [...this.spills.values()].filter(entry => entry.address.sheet === id).map(entry => entry.address)

		if (anchors.length === 0) return []

		return [
			...this.recording(
				() =>
					this.batched(() => {
						const graph = this.engine.dependencyGraph

						for (const address of anchors) {
							const vertex = graph.addressMapping.getCell(address)

							if (vertex !== undefined) graph.graph.markNodeAsDirty(vertex)
						}
					}),
				null
			).values()
		]
	}

	// A held result as the formula the engine is given.
	private holding(held: HeldResult): string {
		const id = this.heldValues.length

		this.heldValues.push(heldInterpreterValue(held.value))

		return `=${HELD}(${String(id)})`
	}

	private contentOf(content: RawCellContent | HeldResult): RawCellContent {
		return content instanceof HeldResult ? this.holding(content) : content
	}

	// What FILEN.HELD gives in the cell at `address`, recorded as recalculated while an edit is.
	private readonly answer: HeldAnswer = (id, address) => {
		this.recorded?.set(changeKey(address), address)

		return this.heldValues[id] ?? new CellError(ErrorType.VALUE)
	}

	private heldBy(address: SimpleCellAddress): void {
		const sheet = this.sheetIndex(address.sheet)

		if (sheet >= 0) this.held?.(sheet, address.row, address.col)
	}

	private pending(sheet: number, cell: EngineCell): Pending[] {
		const id = this.sheetIds[sheet]
		return id === undefined || cell.fallback === undefined || cell.content instanceof HeldResult
			? []
			: [{ address: { sheet: id, row: cell.row, col: cell.col }, content: cell.content, fallback: cell.fallback }]
	}

	// What a cell the engine fails on holds instead: its stored result. Null when the engine does not fail on it.
	private failure(cell: Pending): HeldResult | null {
		const value = this.cellValue(this.engine, cell.address)
		const fallback = cell.fallback

		if (!(value instanceof DetailedCellError) || fallback === undefined) {
			return null
		}

		// A whole column read past the engine's end in a way it cannot tell Excel's answer for (functions/blankTails.ts),
		// in this very formula.
		if (value.type === ErrorType.ERROR && value.message === UNMODELED)
			return value.address === this.engine.simpleCellAddressToString(cell.address, -1) ? new HeldResult(fallback) : null

		if (value.type === ErrorType.ERROR) {
			return typeof cell.content !== "string" || !this.engine.validateFormula(cell.content) ? new HeldResult(fallback) : null
		}

		// A legacy array formula has no room to spill over the values the file keeps in its range (the
		// formula's own spill has no origin address; one it inherits has its own). A dynamic array's #SPILL! is its
		// result.
		if (value.type === ErrorType.SPILL) {
			return value.address === undefined && !this.spills.has(changeKey(cell.address)) ? new HeldResult(fallback) : null
		}

		// An unknown function or name in this very formula, not one it inherits; or a circle it is part of, which the
		// engine draws from every cell a range names (INDEX(A1:C1,1,1) in B1) where Excel's calculation may never
		// meet one. Held, the circle is gone.
		return (value.type === ErrorType.NAME || (value.type === ErrorType.CYCLE && this.held !== undefined)) &&
			value.address === this.engine.simpleCellAddressToString(cell.address, -1)
			? new HeldResult(fallback)
			: null
	}

	// Replaces formulas the engine fails on with their held results, recording what that recalculates. A second
	// round catches formulas whose own failure an inherited one hid.
	private settle(cells: Pending[], changes: Map<string, RecalculatedCell>): void {
		drain(this.settling(cells, changes))
	}

	// The same, yielding between parts of the cells checked.
	private *settling(cells: Pending[], changes: Map<string, RecalculatedCell>): Generator<void, void> {
		let pending = cells

		for (let round = 0; round < 3 && pending.length > 0; round++) {
			const failing: { cell: Pending; held: HeldResult }[] = []
			let checked = 0

			for (const cell of pending) {
				if (++checked % READ_PART === 0) yield

				const held = this.failure(cell)

				if (held !== null) failing.push({ cell, held })
			}

			if (failing.length === 0) {
				return
			}

			this.collect(
				this.run(() =>
					this.batched(() => {
						for (const { cell, held } of failing) {
							this.engine.setCellContents(cell.address, this.holding(held))
						}
					})
				),
				changes
			)

			for (const { cell } of failing) {
				const key = changeKey(cell.address)

				// The result the file stored did not change.
				changes.delete(key)
				this.recorded?.delete(key)
				this.heldBy(cell.address)
			}

			const failed = new Set(failing.map(({ cell }) => cell))

			pending = pending.filter(cell => !failed.has(cell))
		}
	}

	// A cell's value as the engine exports it, a number rounded from what it holds (heldNumber).
	private cellValue(engine: HyperFormula, address: SimpleCellAddress): ReturnType<HyperFormula["getCellValue"]> {
		const value = engine.getCellValue(address)

		return typeof value !== "number" ? value : heldNumber(engine.dependencyGraph.getScalarValue(address))
	}

	private sheetIndex(id: number): number {
		return this.sheetIds.indexOf(id)
	}

	// Each cell a change names, with its value read back once the operation is done: what a batch reports is not
	// always what the cell holds (a formula giving a range, =A1:A3, is reported as spilling its values over the
	// cells below, while it holds #VALUE! and they keep their own).
	private collect(exportedChanges: ReturnType<HyperFormula["batch"]>, into: Map<string, RecalculatedCell>): void {
		drain(this.collecting(exportedChanges, into))
	}

	private *collecting(exportedChanges: ReturnType<HyperFormula["batch"]>, into: Map<string, RecalculatedCell>): Generator<void, void> {
		let read = 0

		for (const change of exportedChanges) {
			if (++read % READ_PART === 0) yield

			if (!("address" in change)) {
				continue
			}

			const sheet = this.sheetIndex(change.address.sheet)

			if (sheet < 0) {
				continue
			}

			const value: unknown = this.cellValue(this.engine, change.address)

			into.set(changeKey(change.address), {
				sheet,
				row: change.address.row,
				col: change.address.col,
				value: exported(value),
				...this.errorOf(value, change.address, id => this.sheetIds.indexOf(id))
			})
		}
	}

	// HyperFormula's batch without its undo grouping, whose bookkeeping costs time quadratic in the operations batched
	// (each walks the batch so far; with undoLimit 0 nothing is ever undone): evaluation suspended for the work and
	// resumed once, as batch does, a throw included.
	// `moved`: the work moves cells (rows or columns inserted or removed), so where whole-column and whole-row
	// references end is read again before anything calculates.
	private batched(work: () => void, moved = false): ReturnType<HyperFormula["batch"]> {
		this.engine.suspendEvaluation()

		try {
			work()
		} catch (error) {
			if (moved) this.whole.reset()

			this.engine.resumeEvaluation()

			throw error
		}

		if (moved) this.whole.reset()

		return this.engine.resumeEvaluation()
	}

	// Runs an edit, reporting what it recalculates: the held results whose inputs changed among it (`own`, the
	// edit's own cells, aside).
	private recording(work: () => ReturnType<HyperFormula["batch"]>, own: ReadonlySet<string> | null): Map<string, RecalculatedCell> {
		return drain(this.recordingSteps(work, own))
	}

	// recording in steps: what it changed read back, and the dynamic arrays and INDIRECT followed, a part at a time.
	private *recordingSteps(
		work: () => ReturnType<HyperFormula["batch"]>,
		own: ReadonlySet<string> | null
	): Generator<void, Map<string, RecalculatedCell>> {
		return yield* this.recordedSteps(() => this.run(work), own)
	}

	// A move of rows or columns recorded in steps: the engine moves its cells with evaluation suspended, then, in a task
	// of its own, calculates what the move changed (each its own engine call, neither of which can be cut).
	private *movingSteps(move: () => void): Generator<void, Map<string, RecalculatedCell>> {
		this.engine.suspendEvaluation()

		try {
			this.run(move)
		} catch (error) {
			this.whole.reset()
			this.engine.resumeEvaluation()

			throw error
		}

		this.whole.reset()

		yield

		return yield* this.recordedSteps(() => this.run(() => this.engine.resumeEvaluation()), null)
	}

	private *recordedSteps(
		work: () => ReturnType<HyperFormula["batch"]>,
		own: ReadonlySet<string> | null
	): Generator<void, Map<string, RecalculatedCell>> {
		const changes = new Map<string, RecalculatedCell>()
		const recorded = new Map<string, SimpleCellAddress>()
		let exportedChanges: ReturnType<HyperFormula["batch"]>

		this.recorded = recorded

		try {
			exportedChanges = work()
		} finally {
			this.recorded = null
		}

		yield* this.collecting(exportedChanges, changes)
		this.staled(recorded, own, changes)
		yield* this.following(changes)

		return changes
	}

	private staled(
		recorded: ReadonlyMap<string, SimpleCellAddress>,
		own: ReadonlySet<string> | null,
		changes: Map<string, RecalculatedCell>
	): void {
		for (const [key, address] of recorded) {
			const sheet = this.sheetIndex(address.sheet)

			if (sheet < 0 || own?.has(key) === true || changes.has(key)) continue

			const value: unknown = this.cellValue(this.engine, address)

			changes.set(key, {
				sheet,
				row: address.row,
				col: address.col,
				value: exported(value),
				...this.errorOf(value, address, id => this.sheetIds.indexOf(id)),
				stale: true
			})
		}
	}

	// Sets cells and returns every cell whose value changed as a result, the set ones included (except
	// formulas that fell back to their stored result, which did not change), and the held results it made stale.
	// While evaluation is held it only writes them and returns nothing: releaseEvaluation reports them.
	set(sheet: number, cells: readonly EngineCell[]): RecalculatedCell[] {
		const id = this.sheetIds[sheet]

		if (id === undefined || cells.length === 0) {
			return []
		}

		const heavy = this.held === undefined ? null : this.outgrows(id, cells)

		if (heavy !== null) {
			if (this.deferred === null) return [...this.rebuildWith(sheet, cells, heavy).values()]

			// Built again from what it holds: what was held is recalculated first, then held again.
			const earlier = drain(this.releasing(true))
			const rebuilt = [...this.rebuildWith(sheet, cells, heavy).values()]

			this.holdEvaluation()

			if (this.deferred !== null) this.deferred.results = [...earlier, ...rebuilt]

			return []
		}

		const deferred = this.deferred

		if (deferred !== null) {
			this.write(id, sheet, cells)

			for (const cell of cells) {
				deferred.own.add(changeKey({ sheet: id, row: cell.row, col: cell.col }))
				appendAll(deferred.pending, this.pending(sheet, cell))
				deferred.written.push(sheet, cell.row, cell.col)
				this.noteTotal(id, cell.row, cell.col, cell.content instanceof HeldResult ? null : cell.content)
			}

			return []
		}

		const own = new Set(cells.map(cell => changeKey({ sheet: id, row: cell.row, col: cell.col })))
		const changes = this.recording(() => this.batched(() => this.write(id, sheet, cells)), own)

		this.settle(
			cells.flatMap(cell => this.pending(sheet, cell)),
			changes
		)

		for (const cell of cells) this.noteTotal(id, cell.row, cell.col, cell.content instanceof HeldResult ? null : cell.content)

		drain(
			this.reporting(
				changes,
				cells.flatMap(cell => [sheet, cell.row, cell.col])
			)
		)

		return [...changes.values()]
	}

	// Holds evaluation: sets write their cells and nothing is recalculated until releaseEvaluation, which works out
	// everything they changed once (a long write its caller slices: a total over the cells is not recalculated for
	// each part). Only sets may run while it is held.
	holdEvaluation(): void {
		if (this.deferred !== null) return

		this.engine.suspendEvaluation()
		this.deferred = { own: new Set(), pending: [], written: [], results: [] }
	}

	// Recalculates what the sets since holdEvaluation changed, in one task of the engine's, and returns it as set
	// returns it, the changed cells read back in slices of `clock`; with `report` false returns nothing and spares
	// reading them (a caller that has the results already: an undo).
	async releaseEvaluation(report = true, clock?: SliceClock): Promise<RecalculatedCell[]> {
		return await runSliced(this.releasing(report), clock)
	}

	private *releasing(report: boolean): Generator<void, RecalculatedCell[]> {
		const deferred = this.deferred

		if (deferred === null) return []

		this.deferred = null

		if (!report) {
			this.run(() => this.engine.resumeEvaluation())
			yield* this.settling(deferred.pending, new Map())

			return []
		}

		const changes = new Map<string, RecalculatedCell>()
		const recorded = new Map<string, SimpleCellAddress>()
		let exportedChanges: ReturnType<HyperFormula["batch"]>

		this.recorded = recorded

		try {
			exportedChanges = this.run(() => this.engine.resumeEvaluation())
		} finally {
			this.recorded = null
		}

		yield* this.collecting(exportedChanges, changes)
		this.staled(recorded, deferred.own, changes)
		yield* this.settling(deferred.pending, changes)
		yield* this.reporting(changes, deferred.written)
		yield* this.following(changes)

		return [...deferred.results, ...changes.values()]
	}

	// The cells given, one by one, evaluation suspended by the caller.
	private write(id: number, sheet: number, cells: readonly EngineCell[]): void {
		// The sheets as far as the engine has seen them, read once, when a formula needs them.
		let known: SheetExtent[] | null = null
		const extents = (): SheetExtent[] =>
			(known ??= this.sheetIds.map(sheetId => {
				const { width, height } = this.engine.getSheetDimensions(sheetId)

				return { name: this.engine.getSheetName(sheetId) ?? "", height, width }
			}))

		for (const cell of cells) {
			const address = { sheet: id, row: cell.row, col: cell.col }
			const spill = this.spills.get(changeKey(address))

			// A dynamic array written anew, or a cell that held one written over (what it spilled is cleared).
			if (cell.spill !== undefined && spill === undefined) {
				this.ownSpill(address, cell.spill)
				this.snapshotSpills()
			} else if (cell.spill === undefined && spill !== undefined) spill.next = { values: [], blocked: true, removed: true }

			// Any cell written, a held one too, can move where whole columns and rows end.
			if (cell.content !== null && cell.content !== undefined && cell.content !== "") this.whole.written(id, cell.row, cell.col)

			try {
				const given = spanned(cell.content, this.sheetNames)
				const read =
					typeof given === "string" && given.startsWith("=")
						? unreadable(given, extents(), sheet, this.reach, undefined, this.link)
						: null
				const reason = this.held === undefined ? null : read

				// A formula reading its own cell is a circle: held at its stored result now, rather than found by the
				// engine and held after it calculated everything reading it (a second recalculation).
				if (
					reason === null &&
					this.held !== undefined &&
					cell.fallback !== undefined &&
					readsItself(given, sheet, cell.row, cell.col, this.sheetNames)
				) {
					this.engine.setCellContents(address, this.holding(new HeldResult(cell.fallback)))
					this.heldBy(address)

					continue
				}

				if (reason !== null) {
					this.engine.setCellContents(address, this.holding(new HeldResult(cell.fallback ?? unreadableShows(reason))))
					this.heldBy(address)
				} else {
					const content = this.contentOf(given)

					this.engine.setCellContents(address, content)

					// A spilled array fills cells besides its own.
					if (typeof content === "string" && content.startsWith("=") && this.engine.isCellPartOfArray(address)) this.whole.reset()
				}
			} catch {
				// A formula the parser overflows on: it holds what it stored, or reads as unparseable.
				const stored = cell.fallback

				this.engine.setCellContents(address, stored === undefined ? UNPARSEABLE : this.holding(new HeldResult(stored)))

				if (stored !== undefined) this.heldBy(address)
			}
		}
	}

	// A set cell whose value is what it was is not reported by the engine, though the caller wrote it anew: added
	// (`written`: sheet index, row, col triples). Yields between parts.
	private *reporting(changes: Map<string, RecalculatedCell>, written: readonly number[]): Generator<void, void> {
		for (let k = 0; k + 2 < written.length; k += 3) {
			if (k > 0 && k % (3 * READ_PART) === 0) yield

			const sheet = written[k] ?? 0
			const id = this.sheetIds[sheet]

			if (id === undefined) continue

			const address = { sheet: id, row: written[k + 1] ?? 0, col: written[k + 2] ?? 0 }
			const key = changeKey(address)

			if (changes.has(key)) continue

			const value: unknown = this.cellValue(this.engine, address)

			changes.set(key, {
				sheet,
				row: address.row,
				col: address.col,
				value: exported(value),
				...this.errorOf(value, address, id => this.sheetIds.indexOf(id))
			})
		}
	}

	// Whether a result is the engine failing rather than the formula (a function it lacks, syntax it cannot
	// read, an array it spills where Excel does not): the file's own result is kept.
	static unsupported(value: unknown): boolean {
		return value === "#NAME?" || value === PARSE_ERROR || value === "#SPILL!" || value === CYCLE
	}

	// Whether the engine can insert or delete these rows or columns (it cannot move a spilled array onto
	// cells it would cover, nor grow a sheet past its size), or why not.
	moveRefusal(sheet: number, edit: AxisEdit): "spill" | "tooLarge" | null {
		const id = this.sheetIds[sheet]

		if (id === undefined) {
			return null
		}

		const span: [number, number] = [edit.at, edit.count]

		if (edit.type === "insert") {
			return (edit.axis === "rows" ? this.engine.isItPossibleToAddRows(id, span) : this.engine.isItPossibleToAddColumns(id, span))
				? null
				: "spill"
		}

		if (this.removedCopies(id, edit.axis, edit.count) > MAX_COPIED_CELLS) return "tooLarge"

		return (edit.axis === "rows" ? this.engine.isItPossibleToRemoveRows(id, span) : this.engine.isItPossibleToRemoveColumns(id, span))
			? null
			: "spill"
	}

	canMove(sheet: number, edit: AxisEdit): boolean {
		return this.moveRefusal(sheet, edit) === null
	}

	// The cells the engine copies to remove rows or columns of a sheet: each one across the sheet's whole width or
	// height as it has seen it.
	private removedCopies(id: number, axis: SizeAxis, count: number): number {
		const { width, height } = this.engine.getSheetDimensions(id)

		return count * (axis === "rows" ? width : height)
	}

	private ensureCopies(cells: number): void {
		if (cells > MAX_COPIED_CELLS) throw new EngineLimitError()
	}

	insert(sheet: number, axis: SizeAxis, at: number, count: number): RecalculatedCell[] {
		return drain(this.inserting(sheet, axis, at, count))
	}

	// insert, a part at a time between yields to `clock` (what a dynamic array spills through the rows written again).
	async insertSliced(sheet: number, axis: SizeAxis, at: number, count: number, clock?: SliceClock): Promise<RecalculatedCell[]> {
		return await runSliced(this.inserting(sheet, axis, at, count), clock)
	}

	private *inserting(sheet: number, axis: SizeAxis, at: number, count: number): Generator<void, RecalculatedCell[]> {
		const id = this.sheetIds[sheet]

		if (id === undefined) return []

		this.moveTotals(id, axis, at, count)
		this.moveSpills(id, axis, at, count)

		// In runs: the engine spreads the new rows into one call, which a large insert overflows.
		const changes = yield* this.movingSteps(() => {
			for (let done = 0; done < count; done += INSERT_RUN) {
				const run = Math.min(INSERT_RUN, count - done)

				if (axis === "rows") this.engine.addRows(id, [at, run])
				else this.engine.addColumns(id, [at, run])
			}
		})

		return [...changes.values()]
	}

	remove(sheet: number, axis: SizeAxis, at: number, count: number): RecalculatedCell[] {
		return drain(this.removing(sheet, axis, at, count))
	}

	// remove, a part at a time between yields to `clock`.
	async removeSliced(sheet: number, axis: SizeAxis, at: number, count: number, clock?: SliceClock): Promise<RecalculatedCell[]> {
		return await runSliced(this.removing(sheet, axis, at, count), clock)
	}

	private *removing(sheet: number, axis: SizeAxis, at: number, count: number): Generator<void, RecalculatedCell[]> {
		const id = this.sheetIds[sheet]

		if (id === undefined) return []

		this.ensureCopies(this.removedCopies(id, axis, count))
		this.moveTotals(id, axis, at, -count)

		const orphans = this.moveSpills(id, axis, at, -count)
		const changes = yield* this.movingSteps(() => {
			if (axis === "rows") this.engine.removeRows(id, [at, count])
			else this.engine.removeColumns(id, [at, count])
		})

		yield* this.orphanedSpills(orphans, changes)

		return [...changes.values()]
	}

	// Adds a sheet; what INDIRECT names by sheet name may be it now: every INDIRECT is calculated again, and what that
	// changes returned.
	addSheet(name: string): RecalculatedCell[] {
		return drain(this.addingSheet(name))
	}

	// addSheet, a part at a time between yields to `clock`.
	async addSheetSliced(name: string, clock?: SliceClock): Promise<RecalculatedCell[]> {
		return await runSliced(this.addingSheet(name), clock)
	}

	private *addingSheet(name: string): Generator<void, RecalculatedCell[]> {
		const added = this.run(() => this.engine.addSheet(name))
		const id = this.engine.getSheetId(added)

		if (id === undefined) {
			throw new Error(`spreadsheet: engine has no sheet ${name}`)
		}

		this.sheetIds.push(id)
		this.sheetNames = [...this.sheetNames, added]
		this.sheetsChanged = true

		return yield* this.sheetNamesChanged()
	}

	// The cells holding INDIRECT as last calculated, by grid sheet index.
	indirectCells(): { sheet: number; row: number; col: number }[] {
		const cells: { sheet: number; row: number; col: number }[] = []

		for (const { address } of this.indirectReads.values()) {
			const sheet = this.sheetIndex(address.sheet)

			if (sheet >= 0) cells.push({ sheet, row: address.row, col: address.col })
		}

		return cells
	}

	// The sheets' names changed: INDIRECT, volatile in Excel, calculated again at once (each one, those that named no
	// sheet the workbook had too).
	private *sheetNamesChanged(): Generator<void, RecalculatedCell[]> {
		const changes = new Map<string, RecalculatedCell>()

		yield* this.following(changes, true)

		return [...changes.values()]
	}

	// Removes the last sheet (an added one being undone).
	removeLastSheet(): RecalculatedCell[] {
		return drain(this.removingLastSheet())
	}

	// removeLastSheet, a part at a time between yields to `clock`.
	async removeLastSheetSliced(clock?: SliceClock): Promise<RecalculatedCell[]> {
		return await runSliced(this.removingLastSheet(), clock)
	}

	private *removingLastSheet(): Generator<void, RecalculatedCell[]> {
		const id = this.sheetIds.at(-1)

		if (id === undefined) return []

		const { width, height } = this.engine.getSheetDimensions(id)

		this.ensureCopies(width * height)
		this.sheetIds.pop()
		this.sheetNames = this.sheetNames.slice(0, -1)
		this.totals.delete(id)
		this.whole.reset()

		for (const [key, entry] of this.spills) if (entry.address.sheet === id) this.spills.delete(key)

		this.sheetsChanged = true

		return [...(yield* this.recordingSteps(() => this.engine.removeSheet(id), null)).values()]
	}

	// Renames a sheet: every INDIRECT is calculated again, and what that changes returned.
	renameSheet(sheet: number, name: string): RecalculatedCell[] {
		return drain(this.renamingSheet(sheet, name))
	}

	// renameSheet, a part at a time between yields to `clock`.
	async renameSheetSliced(sheet: number, name: string, clock?: SliceClock): Promise<RecalculatedCell[]> {
		return await runSliced(this.renamingSheet(sheet, name), clock)
	}

	private *renamingSheet(sheet: number, name: string): Generator<void, RecalculatedCell[]> {
		const id = this.sheetIds[sheet]

		if (id !== undefined) {
			const before = (this.engine.getSheetName(id) ?? "").toUpperCase()
			const reach = this.reaches.get(before)

			this.run(() => {
				this.engine.renameSheet(id, name)
			})
			this.whole.rename(before, name)
			this.sheetNames = this.sheetNames.map((known, index) => (index === sheet ? name : known))
			this.sheetsChanged = true

			if (reach !== undefined) {
				this.reaches.delete(before)
				this.reaches.set(name.toUpperCase(), reach)
			}

			return yield* this.sheetNamesChanged()
		}

		return []
	}

	// Whether writing these cells makes the sheet reach so far that a formula reading it to its last row or column
	// would read past MAX_RANGE_CELLS, or its whole-column (whole-row) references together past MAX_SHEET_READS at a
	// jump (a cell written far below the cells they cover; growing as data does is left alone): null when not, else the
	// sheets (upper-case names) whose whole-column and whole-row references are held for it.
	private outgrows(id: number, cells: readonly EngineCell[]): ReadonlySet<string> | null {
		const name = (this.engine.getSheetName(id) ?? "").toUpperCase()
		const reach = this.reaches.get(name)

		if (reach === undefined) return null

		const graph = this.engine.dependencyGraph
		const { width, height } = this.engine.getSheetDimensions(id)
		const ends = this.whole.ends(graph, id)
		let rows = height
		let cols = width
		let coveredRows = ends.rows
		let coveredCols = ends.cols

		for (const cell of cells) {
			if (cell.content === null || cell.content === undefined || cell.content === "") continue

			rows = Math.max(rows, cell.row + 1)
			cols = Math.max(cols, cell.col + 1)

			const reads = this.whole.reads(id, cell.row, cell.col)

			if (reads.rows) coveredRows = Math.max(coveredRows, cell.row + 1)
			if (reads.cols) coveredCols = Math.max(coveredCols, cell.col + 1)
		}

		if ((rows > height && reach.cols * rows > MAX_RANGE_CELLS) || (cols > width && reach.rows * cols > MAX_RANGE_CELLS))
			return new Set()

		if (coveredRows <= 2 * ends.rows && coveredCols <= 2 * ends.cols) return null

		const load = this.whole.load(graph, id)

		return (coveredRows > 2 * ends.rows && load.rows * coveredRows > MAX_SHEET_READS) ||
			(coveredCols > 2 * ends.cols && load.cols * coveredCols > MAX_SHEET_READS)
			? this.whole.groupNames(graph, id)
			: null
	}

	// Builds the engine again with these cells written, holding at the results they had the formulas that read past
	// MAX_RANGE_CELLS once the sheet reaches as far (and those reading a whole column or row of a `heavy` sheet), and
	// reports every formula cell whose value that changed and the cells written. Rare (a cell written at the grid's far edge) and whole-workbook: the engine would otherwise read
	// each of those ranges cell by cell, past what memory holds.
	private rebuildWith(sheet: number, cells: readonly EngineCell[], heavy: ReadonlySet<string>): Map<string, RecalculatedCell> {
		const old = this.engine
		const names = this.sheetIds.map(id => old.getSheetName(id) ?? "")
		const contents = Object.create(null) as Record<string, RawCellContent[][]>

		// The engine writes formulas back with names that need quotes bare (2024!A1), which it cannot read again.
		const requote = names.some(sheetNameNeedsQuotes)
		const serialized = (content: RawCellContent): RawCellContent =>
			requote && typeof content === "string" && content.startsWith("=") ? `=${quoteSheetNames(content.slice(1))}` : content

		this.sheetIds.forEach((id, index) => {
			const rows = serializedSheet(old, id)

			contents[names[index] ?? ""] = requote ? rows.map(row => row.map(serialized)) : rows
		})

		const written = contents[names[sheet] ?? ""] ?? []

		for (const cell of cells) {
			while (written.length <= cell.row) written.push([])

			const row = written[cell.row] ?? []

			while (row.length < cell.col) row.push(null)

			row[cell.col] = this.contentOf(spanned(cell.content, this.sheetNames))
		}

		const extents: SheetExtent[] = names.map(name => {
			const rows = contents[name] ?? []

			return { name, height: rows.length, width: rows.reduce((width, row) => Math.max(width, row.length), 0) }
		})
		const fallbacks = new Map(cells.map(cell => [cell.row * MAX_COLUMNS + cell.col, cell.fallback]))
		const before = new Map<string, { address: SimpleCellAddress; value: unknown }>()
		const holds: SimpleCellAddress[] = []

		this.reaches.clear()

		names.forEach((name, index) => {
			const id = this.sheetIds[index] ?? 0

			;(contents[name] ?? []).forEach((row, rowIndex) => {
				row.forEach((value, col) => {
					if (typeof value !== "string" || !value.startsWith("=")) return

					const address = { sheet: id, row: rowIndex, col }
					const own = index === sheet && fallbacks.has(rowIndex * MAX_COLUMNS + col)
					const was: unknown = own ? undefined : this.cellValue(old, address)
					const reason = unreadable(value, extents, index, this.reach, heavy, this.link)

					before.set(changeKey(address), { address, value: was })

					if (reason === null) return

					const stored = own ? fallbacks.get(rowIndex * MAX_COLUMNS + col) : rawValue(was)

					row[col] = this.holding(new HeldResult(stored ?? unreadableShows(reason)))
					holds.push(address)
				})
			})
		})

		const order = Object.keys(contents)
		const named = old.getAllNamedExpressionsSerialized().map(entry => {
			const scope = entry.scope === undefined ? undefined : order.indexOf(old.getSheetName(entry.scope) ?? "")

			const { scope: _scope, ...global } = { ...entry, expression: serialized(entry.expression) }

			return scope === undefined || scope < 0 ? global : { ...global, scope }
		})

		old.destroy()
		// What INDIRECT read was the old engine's (its sheet ids); the build records it again.
		this.indirectReads.clear()

		// The new engine numbers the sheets in grid order: the dynamic arrays under their new ids before it calculates.
		const spills = [...this.spills.values()]

		this.spills.clear()

		for (const entry of spills) {
			const sheet = this.sheetIds.indexOf(entry.address.sheet)

			if (sheet >= 0) this.spills.set(changeKey({ ...entry.address, sheet }), { ...entry, address: { ...entry.address, sheet } })
		}
		// While the new engine calculates, its sheet ids are the record's key order; sheetIds still names the old ones.
		this.building = order.map(name => names.indexOf(name))

		try {
			this.inBuild = true
			this.engine = this.run(() => HyperFormula.buildFromSheets(contents, this.config, named))
		} finally {
			this.inBuild = false
			this.building = null
		}

		const ids = names.map(name => this.engine.getSheetId(name) ?? -1)
		const remap = (address: SimpleCellAddress): SimpleCellAddress => ({
			...address,
			sheet: ids[this.sheetIds.indexOf(address.sheet)] ?? address.sheet
		})

		for (const address of holds) this.heldBy(remap(address))

		const changes = new Map<string, RecalculatedCell>()
		const report = (address: SimpleCellAddress, was: unknown, always: boolean): void => {
			const value: unknown = this.cellValue(this.engine, address)

			if (!always && exported(value) === exported(was) && value instanceof DetailedCellError === was instanceof DetailedCellError)
				return

			changes.set(changeKey(address), {
				sheet: ids.indexOf(address.sheet),
				row: address.row,
				col: address.col,
				value: exported(value),
				...this.errorOf(value, address, id => ids.indexOf(id))
			})
		}

		const previous = [...before.values()].map(entry => ({ address: remap(entry.address), value: entry.value }))

		const totals = new Map(this.totals)

		this.totals.clear()
		this.sheetIds.forEach((previous, index) => {
			const cells = totals.get(previous)
			const next = ids[index]

			if (cells !== undefined && next !== undefined) this.totals.set(next, cells)
		})
		spliceAll(this.sheetIds, 0, this.sheetIds.length, ids)

		for (const cell of cells)
			this.noteTotal(ids[sheet] ?? 0, cell.row, cell.col, cell.content instanceof HeldResult ? null : cell.content)

		this.followDynamic(new Map(), true)

		for (const entry of previous) report(entry.address, entry.value, false)
		for (const cell of cells) report({ sheet: ids[sheet] ?? 0, row: cell.row, col: cell.col }, undefined, true)

		return changes
	}

	// Whether a formula (as the engine takes it, ARRAYFORMULA(...)) gives an array on a sheet: one of more than one
	// value, or a function lifted over a range inside it (SUM(LEN(A1:A3))). What a typed formula's dynamic-array
	// reading decides (support.microsoft.com "Dynamic array formulas and spilled array behavior").
	givesArray(sheet: number, formula: string): boolean {
		const id = this.sheetIds[sheet]

		if (id === undefined || this.deferred !== null) return false

		try {
			const { value, lifted } = this.run(() => trackLifts(() => this.engine.calculateFormula(formula, id)))

			return lifted || Array.isArray(value)
		} catch {
			return false
		}
	}

	// Whether a value is an error, and the cell it comes from where that is another one (the engine names the cell
	// whose formula failed first: a propagated error keeps it).
	private errorOf(
		value: unknown,
		at: SimpleCellAddress,
		index: (id: number) => number
	): Pick<RecalculatedCell, "error" | "root" | "unknown"> {
		if (!(value instanceof DetailedCellError)) return {}

		const fn = UNKNOWN_FUNCTION.exec(value.message)?.[1]
		const name = UNKNOWN_NAME.exec(value.message)?.[1]
		const unknown =
			fn !== undefined ? { kind: "function" as const, name: fn } : name !== undefined ? { kind: "name" as const, name } : undefined
		const root = value.address === undefined ? undefined : this.engine.simpleCellAddressFromString(value.address, at.sheet)
		const sheet = root === undefined ? -1 : index(root.sheet)
		const own = root === undefined || (root.sheet === at.sheet && root.row === at.row && root.col === at.col)

		return {
			error: true,
			...(unknown !== undefined && { unknown }),
			...(!own && root !== undefined && sheet >= 0 && { root: { sheet, row: root.row, col: root.col } })
		}
	}

	// A cell's value, and whether it is an error.
	result(sheet: number, row: number, col: number): Pick<RecalculatedCell, "value" | "error"> {
		const id = this.sheetIds[sheet]
		const value: unknown = id === undefined ? null : this.cellValue(this.engine, { sheet: id, row, col })

		return value instanceof DetailedCellError ? { value: exported(value), error: true } : { value: exported(value) }
	}

	// The cells whose formulas read `cells` (grid sheet index), directly or through others, `cells` left out.
	dependents(cells: readonly { readonly sheet: number; readonly row: number; readonly col: number }[]): {
		sheet: number
		row: number
		col: number
	}[] {
		const seen = new Set<string>()
		const queue: ReturnType<HyperFormula["getCellDependents"]> = []
		const found: { sheet: number; row: number; col: number }[] = []

		for (const cell of cells) {
			const id = this.sheetIds[cell.sheet]

			if (id === undefined) continue

			const address = { sheet: id, row: cell.row, col: cell.col }

			seen.add(changeKey(address))
			queue.push(address)
		}

		for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
			let next: ReturnType<HyperFormula["getCellDependents"]>

			try {
				next = this.engine.getCellDependents(at)
			} catch {
				// A named expression's vertex (no sheet of its own) has no address to ask about.
				continue
			}

			for (const dependent of next) {
				const range = "start" in dependent
				const key = range ? `${changeKey(dependent.start)}:${changeKey(dependent.end)}` : changeKey(dependent)

				if (seen.has(key)) continue

				seen.add(key)
				queue.push(dependent)

				if (range) continue

				const sheet = this.sheetIndex(dependent.sheet)

				if (sheet >= 0) found.push({ sheet, row: dependent.row, col: dependent.col })
			}
		}

		return found
	}

	destroy(): void {
		this.engine.destroy()
	}
}

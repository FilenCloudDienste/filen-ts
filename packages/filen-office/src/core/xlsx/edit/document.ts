import { appendAll } from "../../arrays"
import type { RawCellContent } from "hyperformula"
import { isSealedOfficeFile } from "../../encryption/index"
import type { SliceClock, Slicing } from "../../slicing"
import { decodeUtf8, encodeUtf8 } from "../../xml/index"
import { csvField, utf8Length } from "../../sheet/csv/csvParse"
import {
	CYCLE,
	FormulaEngine,
	HeldResult,
	UNPARSEABLE,
	type EngineCell,
	type EngineName,
	type EngineSheet,
	type RecalculatedCell,
	type SpillSize
} from "../../sheet/formula/index"
import {
	NUMFMT_EN_US,
	NumFmtOutput,
	formatNumberInto,
	formatTextInto,
	serialDate,
	type DateParts,
	type NumFmt,
	type NumFmtOptions
} from "../../sheet/numfmt/index"
import { dateSerial, ISO_1900, type DateBase } from "../../sheet/numfmt/date"
import {
	AxisFlag,
	CellFlag,
	SHEET_MAX_COLS,
	SHEET_MAX_ROWS,
	SHEET_TILE_TEXT,
	TILE_COLS,
	TILE_ROWS,
	tileText,
	type SheetAbortSignal,
	type SheetAxisLayout,
	type SheetCell,
	type SheetCommand,
	type SheetEncryption,
	type SheetFileKind,
	type SheetFileSharing,
	type SheetId,
	type SheetLayout,
	type SheetPane,
	type SheetProtectedAction,
	type SheetProtectionState,
	type SheetRefusal,
	type SheetRange,
	type SheetRenderStyle,
	type SheetSaveResult,
	type SheetSessionSettings,
	type SheetSummary,
	type SheetViewOnlyReason,
	type SheetWorkbookProtection,
	type SheetWritability
} from "../../sheet/protocol"
import type { SheetChangeSink } from "../../sheet/registry"
import type { AxisEdit } from "../../sheet/model/edits"
import { DEFAULT_DIGIT_PX, colWidthToPx, defaultColPx, rowHeightToPx } from "../../sheet/sizes/sizes"
import {
	absoluteCell,
	calledFunctions,
	engineArrayFormula,
	engineCellFormula,
	engineFormula,
	engineLacks,
	engineSpillFormula,
	formulaInputs,
	holdsArrayConstant,
	holdsBracket,
	legacyIntersections,
	sameSheet,
	shownFormula
} from "../../sheet/refs/formulaRefs"
import { localizedInput } from "../../sheet/input/locale"
import { sheetFunction } from "../../sheet/functions/catalogue"
import { takesOneValue } from "../../sheet/functions/valueArguments"
import { volatileFormula } from "../../sheet/functions/volatile"
import { SheetStyles } from "../../sheet/style/index"
import type { CellWrite, SheetStore } from "../model/store"
import { readWorksheet } from "../read/worksheet"
import { readDimension } from "../write/sections"
import { Inflate } from "fflate"
import {
	CARRIED,
	CellKind,
	ColFlag,
	FormulaKind,
	RowFlag,
	SLOT_BLOCK,
	rowRunAt,
	type XlsxDefinedName,
	type XlsxFont,
	type XlsxFormula,
	type XlsxFormulaTable,
	type XlsxProtectionHash,
	type XlsxSheetEntry,
	type XlsxSheetModel,
	type XlsxSheetView
} from "../model/types"
import { withRuns, type AxisRun } from "../../sheet/axisRuns"
import { XlsxReadError, decodeXstring, parseRange, type XlsxWorkbook } from "../read/index"
import { saveXlsx, seedImpliedStyles } from "../write/index"
import type { XlsxClip } from "./clipboard"
import { readEntry } from "./cells"
import type { ChangeLog } from "../model/changes"
import { RefRefused } from "../refs/catalogue"
import { refState } from "../refs/state"
import { ABSENT, cellKeyOf, cellState, type CellLog, type CellState, type ShownResult } from "./history"
import { dynamicArrayCm, ODS_DYNAMIC_ARRAYS, readDynamicArrays, type DynamicArrays, type MadeMetadata } from "./spill"

// The xlsx session's document: the workbook model with what a session adds to it. It shows cells (their text
// through their number format, their look through the render style table), lays sheets out, keeps the formula
// engine in step with the cells, judges whether the file can be edited, and saves through the splice writer and
// its gate. Edits (cells.ts, format.ts, resize.ts, structure-basic.ts) change the model through it.

// The interning of render styles a session keeps (session.ts): equal looks share an index.
export interface RenderStyleInterner {
	intern(style: SheetRenderStyle): number
}

// One tile entry as the document fills it in; the session's builder takes it.
export interface TileEntrySink {
	add(row: number, col: number, text: string, input: string | null, style: number, flags: number): number
	repeat(entry: number, offset: number, char: string): void
	// A rich text's runs: where each starts in the entry's text (UTF-16) and its render style.
	runs(entry: number, starts: readonly number[], styles: readonly number[]): void
}

export interface XlsxDocumentOptions {
	readonly kind: SheetFileKind
	readonly settings?: SheetSessionSettings
	readonly writeUnlocked?: boolean
	readonly encryption?: SheetEncryption
	// The writer of the format a workbook not read from SpreadsheetML was (an OpenDocument spreadsheet).
	readonly writer?: XlsxFormatWriter
}

// A writer of the format the workbook was read from, in place of the SpreadsheetML writer.
export interface XlsxFormatWriter {
	// Why the workbook can never be written (known at open), null when it can.
	readonly viewOnly: SheetViewOnlyReason | null
	// Why an edit just made cannot be written (SheetSessionDocument.checkEdit), null when it can.
	// Before each edit runs (SheetSessionDocument.beginEdit).
	begin?(document: XlsxDocument, command: SheetCommand): void
	// The edit checked last was refused and undone (SheetSessionDocument.editUndone).
	refused?(document: XlsxDocument): void
	check?(document: XlsxDocument, touched: ReadonlyMap<SheetId, readonly SheetRange[]>, command: SheetCommand): SheetRefusal | null
	save(
		document: XlsxDocument,
		options: { readonly slicing?: Slicing; readonly signal?: SheetAbortSignal; readonly untouched: boolean }
	): Promise<
		| { readonly ok: true; readonly bytes: Uint8Array; readonly changedParts: readonly string[] }
		| { readonly ok: false; readonly message: string }
	>
}

const LEGACY_KINDS: ReadonlySet<SheetFileKind> = new Set(["xls", "xlt"])

// An Excel 97–2003 workbook (.xls, .xlt), which a session opens from an .xlsx made of its values alone.
export function isLegacyKind(kind: SheetFileKind): boolean {
	return LEGACY_KINDS.has(kind)
}

// What a formula the engine does not calculate shows when its file stored no result for it.
const NAME_ERROR = "#NAME?"

// A defined name's formula that is a LAMBDA ([MS-XLSX] 2.2.2: _xlfn.LAMBDA).
const LAMBDA_NAME = /^\s*(?:_xlfn\.)?LAMBDA\s*\(/i

// What a cell shows, filled in by `show` (one scratch object: tiles show thousands of cells).
interface Shown {
	text: string
	input: string | null
	flags: number
	color: number
	repeatOffset: number
	repeatChar: string
}

function pad(value: number): string {
	return value < 10 ? `0${String(value)}` : String(value)
}

// Cells one part of a sliced write takes: about a few milliseconds of work.
const WRITE_SLICE = 2048

// Shown legacy formulas kept by stored text (shownFormulaText).
const LEGACY_SHOWN = 4096

// The functions a file stores for operators (@, A1#, a LAMBDA called in place), known to every workbook.
const KNOWN_OPERATORS = /^_xlfn\.(?:SINGLE|ANCHORARRAY|LAMBDA|LET)$/i

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/

// A t="d" cell's ISO 8601 text as a serial, NaN when it does not read.
function isoSerial(text: string, date1904: DateBase): number {
	const match = ISO_DATE.exec(text)

	if (match === null) return Number.NaN

	const [, year = "", month = "", day = "", hours = "0", minutes = "0", seconds = "0"] = match

	return (
		dateSerial(Number(year), Number(month), Number(day), date1904) +
		(Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) / 86_400
	)
}

const dateScratch: DateParts = { year: 0, month: 0, day: 0, weekday: 0 }

// A serial under a date format as it is typed: the date, its time when it has one, the time alone on the epoch
// day; to the second.
export function typedSerial(serial: number, date1904: DateBase): string {
	if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466) return String(serial)

	let day = Math.floor(serial)
	let seconds = Math.round((serial - day) * 86_400)

	if (seconds >= 86_400) {
		day++
		seconds -= 86_400
	}

	const time = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}${seconds % 60 === 0 ? "" : `:${pad(seconds % 60)}`}`

	if (day === 0 && date1904 === false) return time

	const parts = serialDate(day, date1904, dateScratch)
	const date = `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`

	return seconds === 0 ? date : `${date} ${time}`
}

function hasHash(hash: XlsxProtectionHash): boolean {
	return (hash.hashValue !== undefined && hash.hashValue !== "") || (hash.legacy !== undefined && hash.legacy !== "")
}

// Read through a call: a signal's state changes while a save is awaited.
function aborted(signal: SheetAbortSignal | undefined): boolean {
	return signal?.aborted === true
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// The rows a preview reads (one tile row), and the most of the part it inflates to find them.
const PREVIEW_ROWS = TILE_ROWS
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024
// The largest CSV a sheet exports. The page holds the bytes and then the Blob it downloads as, two copies, so this
// keeps the peak near 1 GiB, the bound the reader puts on a whole package's inflated parts (zip limits) doubled. A few
// cells far apart (A1, XFD1, A1048576) would make a file of commas many GB long.
export const MAX_CSV_BYTES = 512 * 1024 * 1024
const CSV_TOO_LARGE: SheetRefusal = { reason: "tooLarge", detail: "csv" }
const PREVIEW_READ = 32 * 1024

export interface SheetPreview {
	readonly model: XlsxSheetModel
	// Rows it holds in full: PREVIEW_ROWS, or every row when the whole part was read.
	readonly rows: number
	readonly dimension: SheetRange | null
}

const LT = 0x3c
const GT = 0x3e
const QUOTE = 0x22
const APOSTROPHE = 0x27
const EQUALS = 0x3d

function isSpace(byte: number | undefined): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

function endsName(byte: number | undefined): boolean {
	return byte === undefined || isSpace(byte) || byte === GT || byte === 0x2f
}

// The start of a part as it is inflated, in one buffer that doubles as it fills, with where its <row> elements
// start: each push scans only what it added.
class PartPrefix {
	bytes = new Uint8Array(64 * 1024)
	size = 0
	readonly rows: number[] = []
	private scanned = 0

	push(chunk: Uint8Array): void {
		if (this.size + chunk.length > this.bytes.length) {
			const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.size + chunk.length))

			grown.set(this.bytes.subarray(0, this.size))
			this.bytes = grown
		}

		this.bytes.set(chunk, this.size)
		this.size += chunk.length
		this.scan()
	}

	view(): Uint8Array {
		return this.bytes.subarray(0, this.size)
	}

	// Row starts up to the (PREVIEW_ROWS + 1)th; a name cut off at the end is read again after the next push.
	private scan(): void {
		const bytes = this.view()

		while (this.rows.length <= PREVIEW_ROWS) {
			const at = bytes.indexOf(LT, this.scanned)

			if (at < 0) {
				this.scanned = bytes.length

				return
			}

			let name = at + 1

			while (name < bytes.length && !endsName(bytes[name])) name++

			if (name >= bytes.length) {
				this.scanned = at

				return
			}

			const length = name - at - 1

			// "row" or "<prefix>:row".
			if (
				length >= 3 &&
				bytes[name - 3] === 0x72 &&
				bytes[name - 2] === 0x6f &&
				bytes[name - 1] === 0x77 &&
				(length === 3 || bytes[name - 4] === 0x3a)
			) {
				this.rows.push(at)
			}

			this.scanned = at + 1
		}
	}
}

// The 0-based index a <row> start tag gives (its r), or `previous` + 1 when it gives none it reads whole (as the
// sheet reader takes it).
function rowIndex(bytes: Uint8Array, start: number, previous: number): number {
	let i = start + 1

	while (i < bytes.length && !endsName(bytes[i])) i++

	while (i < bytes.length && bytes[i] !== GT) {
		const byte = bytes[i]

		if (byte === QUOTE || byte === APOSTROPHE) {
			const close = bytes.indexOf(byte, i + 1)

			if (close < 0) break

			i = close + 1

			continue
		}

		if (byte === 0x72 && isSpace(bytes[i - 1]) && (isSpace(bytes[i + 1]) || bytes[i + 1] === EQUALS)) {
			let j = i + 1

			while (isSpace(bytes[j])) j++

			if (bytes[j] !== EQUALS) break

			j++

			while (isSpace(bytes[j])) j++

			const quote = bytes[j]
			const close = quote === QUOTE || quote === APOSTROPHE ? bytes.indexOf(quote, j + 1) : -1

			if (close < 0) break

			let value = 0
			let k = j + 1

			while (k < close && isSpace(bytes[k])) k++
			while (k < close && (bytes[k] ?? 0) >= 0x30 && (bytes[k] ?? 0) <= 0x39 && value <= SHEET_MAX_ROWS)
				value = value * 10 + (bytes[k++] ?? 0) - 0x30
			while (k < close && isSpace(bytes[k])) k++

			return k === close && value >= 1 ? value - 1 : previous + 1
		}

		i++
	}

	return previous + 1
}

// The rows a preview cut at `rows[cut]` holds in full: those below the row left out, when the rows before it
// ascend (as the schema orders them); none when they do not.
function heldRows(bytes: Uint8Array, rows: readonly number[], cut: number): number {
	let previous = -1

	for (let k = 0; k < cut; k++) {
		const index = rowIndex(bytes, rows[k] ?? 0, previous)

		if (index <= previous) return 0

		previous = index
	}

	return Math.min(PREVIEW_ROWS, rowIndex(bytes, rows[cut] ?? 0, previous))
}

// The start of the part up to the (PREVIEW_ROWS + 1)th row (or its last row begun, which may be cut off), closed
// off as a worksheet, and the rows it holds in full.
function closedPrefix(bytes: Uint8Array, rows: readonly number[]): { readonly bytes: Uint8Array; readonly rows: number } | null {
	const index = Math.min(rows.length - 1, PREVIEW_ROWS)
	const cut = rows[index]

	if (cut === undefined) return null

	const text = decodeAscii(bytes, 0, Math.min(bytes.length, 4096))
	const root = /<([A-Za-z_][\w.-]*:)?(worksheet|chartsheet|dialogsheet|macrosheet)[\s>]/.exec(text)
	const data = indexOfAscii(bytes, "sheetData", cut)
	let open = data - 1

	while (open >= 0 && bytes[open] !== LT) open--

	if (root === null || data < 0 || open < 0) return null

	const tail = encodeUtf8(`</${decodeAscii(bytes, open + 1, data)}sheetData></${root[1] ?? ""}${root[2] ?? "worksheet"}>`)
	const out = new Uint8Array(cut + tail.length)

	out.set(bytes.subarray(0, cut), 0)
	out.set(tail, cut)

	return { bytes: out, rows: heldRows(bytes, rows, index) }
}

// The first `text` (ASCII) in bytes before `limit`, or -1.
function indexOfAscii(bytes: Uint8Array, text: string, limit: number): number {
	const first = text.charCodeAt(0)

	for (let at = bytes.indexOf(first); at >= 0 && at < limit; at = bytes.indexOf(first, at + 1)) {
		let i = 1

		while (i < text.length && bytes[at + i] === text.charCodeAt(i)) i++

		if (i === text.length) return at
	}

	return -1
}

function decodeAscii(bytes: Uint8Array, from: number, to: number): string {
	let text = ""

	for (let i = from; i < to; i++) text += String.fromCharCode(bytes[i] ?? 0)

	return text
}

export interface XlsxTableRange {
	// Upper case.
	readonly name: string
	readonly sheet: SheetId
	readonly range: SheetRange
	readonly headerRows: number
}

export class XlsxDocument {
	readonly workbook: XlsxWorkbook
	readonly kind: SheetFileKind
	readonly date1904: boolean
	// The date base serials count from: date1904, or a Strict workbook's 1900 date base (numfmt/date.ts).
	readonly dateBase: DateBase
	readonly styles: SheetStyles
	readonly encryption: SheetEncryption | undefined
	readonly writeUnlocked: boolean
	readonly writer: XlsxFormatWriter | undefined
	private ownSettings: SheetSessionSettings
	// Formula results the session shows that the file keeps none for, by sheet and cell (cellKeyOf).
	readonly shownResults = new Map<SheetId, Map<number, ShownResult>>()
	// The formula engine, once built, and the sheet each of its sheet indices is.
	engine: FormulaEngine | null = null
	engineSheets: SheetId[] = []
	// The default font's widest digit in pixels, the unit of column widths (digitWidth.ts): the app measures it.
	digitPx = DEFAULT_DIGIT_PX
	// Why a sheet could not be read (it stays unparsed), by sheet.
	readonly failed = new Map<SheetId, XlsxReadError>()
	private readonly interner: RenderStyleInterner
	private numFmtOptions: NumFmtOptions
	private readonly out = new NumFmtOutput()
	private readonly shown: Shown = { text: "", input: null, flags: 0, color: -1, repeatOffset: -1, repeatChar: "" }
	// Rich strings' runs by string, cell format and number format colour.
	private readonly richCache = new Map<string, { readonly starts: readonly number[]; readonly styles: readonly number[] }>()
	// Render style index by cell format and number format colour.
	private readonly renderIndex = new Map<number, number>()
	// The first rows of sheets still being parsed, shown until the parse ends (preview()).
	readonly previews = new Map<SheetId, SheetPreview>()
	// The latest copy (clipboard.ts): a paste of its text writes what its cells held.
	clip: XlsxClip | null = null
	nextClip = 1
	private closed = false

	constructor(workbook: XlsxWorkbook, interner: RenderStyleInterner, options: XlsxDocumentOptions) {
		this.workbook = workbook
		this.kind = options.kind
		this.date1904 = workbook.date1904
		// Strict SpreadsheetML and OpenDocument count 1900 dates without Excel's 1900-02-29.
		this.dateBase = (workbook.strict || workbook.format === "ods") && !workbook.date1904 ? ISO_1900 : workbook.date1904
		this.encryption = options.encryption
		this.writeUnlocked = options.writeUnlocked === true
		this.writer = options.writer
		this.ownSettings = options.settings ?? {}
		this.interner = interner
		// A workbook without a styles part implies Excel's defaults: they come first, before any format an edit adds.
		seedImpliedStyles(workbook.styles)
		this.styles = new SheetStyles(workbook.styles, workbook.theme)
		this.numFmtOptions = this.formatOptions()
	}

	get settings(): SheetSessionSettings {
		return this.ownSettings
	}

	// New settings: the locale's separators show in every tile built from now on. Text dates and numbers in formulas
	// read in the locale: an engine built for another is dropped (built again when next needed).
	set settings(settings: SheetSessionSettings) {
		const before = this.ownSettings.locale
		const after = settings.locale

		this.ownSettings = settings
		this.numFmtOptions = this.formatOptions()

		if (
			before?.dateOrder !== after?.dateOrder ||
			before?.decimal !== after?.decimal ||
			before?.group !== after?.group ||
			before?.currencies?.join("\u0000") !== after?.currencies?.join("\u0000")
		)
			this.dropEngine()
	}

	// The app's locale gives the separators; month and day names stay en-US until the app injects a NumFmtLocale.
	private formatOptions(): NumFmtOptions {
		const locale = this.ownSettings.locale

		return {
			date1904: this.dateBase,
			palette: this.styles.palette,
			...(locale !== undefined && { locale: { ...NUMFMT_EN_US, decimal: locale.decimal, group: locale.group } }),
			...(this.workbook.localeFor !== undefined && { localeFor: this.workbook.localeFor, lcidSeparators: true }),
			...(this.workbook.standardPrecision !== undefined && { standardPrecision: this.workbook.standardPrecision })
		}
	}

	get encrypted(): "verified" | "unchecked" | undefined {
		return this.encryption?.integrity
	}

	isReady(sheet: SheetId): boolean {
		return this.model(sheet) !== null
	}

	// The engine is built for editing a workbook with formulas, and for showing results the file keeps none of.
	needsPreparing(editing: boolean): boolean {
		return this.engine === null && this.allReady && !this.closed && (editing ? this.hasFormulas : this.hasMissingResults)
	}

	async prepare(changes: SheetChangeSink): Promise<void> {
		await this.loadTables()

		if (!this.closed) this.buildEngine(changes)
	}

	// Results the file lacks, or keeps that are calculated again on open: under calcPr fullCalcOnLoad (ECMA-376 Part 1
	// §18.2.2) every formula's, else a volatile formula's (SpreadsheetML) or what the OpenDocument reader marked.
	get hasMissingResults(): boolean {
		if (this.workbook.calc.fullCalcOnLoad && this.hasFormulas) return true

		const xlsx = this.workbook.format !== "ods"

		for (const entry of this.workbook.sheets) {
			const store = entry.model?.store as SheetStore | undefined

			for (const block of store?.blocks ?? []) {
				const formulas = block.formulas

				if (formulas === null) continue

				for (let k = 0; k < formulas.length; k++) if ((formulas[k] ?? -1) >= 0 && block.kinds[k] === CellKind.EMPTY) return true
			}

			if ((entry.model?.recalculate?.size ?? 0) > 0) return true

			// A shared formula's text is its master's: the children call what it calls.
			if (xlsx && store !== undefined)
				for (let id = 0; id < store.formulas.length; id++) if (volatileFormula(store.formulas.text(id))) return true
		}

		return false
	}

	get isClosed(): boolean {
		return this.closed
	}

	// --- Sheets ---

	entry(sheet: SheetId): XlsxSheetEntry | undefined {
		return this.workbook.sheet(sheet)
	}

	model(sheet: SheetId): XlsxSheetModel | null {
		return this.workbook.loaded(sheet)
	}

	store(sheet: SheetId): SheetStore | null {
		return (this.model(sheet)?.store as SheetStore | undefined) ?? null
	}

	summary(entry: XlsxSheetEntry): SheetSummary {
		const tab = entry.model?.tabColor ?? null
		const color = tab === null ? -1 : this.styles.color(tab)

		return {
			id: entry.id,
			name: entry.name,
			state: entry.state,
			kind: entry.kind,
			...(color >= 0 && { tabColor: color }),
			ready: entry.model !== null
		}
	}

	sheets(): SheetSummary[] {
		return this.workbook.sheets.map(entry => this.summary(entry))
	}

	activeSheet(): SheetId {
		const sheets = this.workbook.sheets
		const active = sheets[this.workbook.activeTab]

		if (active !== undefined && active.state === "visible") return active.id

		return (sheets.find(sheet => sheet.state === "visible") ?? sheets[0])?.id ?? 0
	}

	worksheets(): XlsxSheetEntry[] {
		return this.workbook.sheets.filter(sheet => sheet.kind === "worksheet")
	}

	// Parses a sheet; rejects with the XlsxReadError a sheet that cannot be read gives, at once when it was read
	// before (it is not inflated and parsed again). A sheet the workbook does not hold now (an edit took it away; an
	// undo or redo may bring it back) is no parse failure and is never remembered as one.
	async ready(sheet: SheetId, slicing?: Slicing, signal?: SheetAbortSignal): Promise<XlsxSheetModel> {
		if (this.workbook.sheet(sheet) === undefined) throw new XlsxReadError("missingPart", `No sheet ${sheet}`)

		const failure = this.failed.get(sheet)

		if (failure !== undefined) throw failure

		try {
			return await this.workbook.load(sheet, slicing, signal)
		} catch (error) {
			if (error instanceof XlsxReadError && error.code !== "aborted") this.failed.set(sheet, error)

			throw error
		}
	}

	// Every sheet, `first` first; each one ready is reported.
	async readyAll(
		first: SheetId,
		slicing: Slicing | undefined,
		onReady: (sheet: SheetId) => void,
		signal?: SheetAbortSignal
	): Promise<void> {
		await this.workbook.loadAll(
			first,
			slicing,
			model => onReady(model.id),
			(id, error) => {
				this.failed.set(id, error)
			},
			signal
		)
	}

	async readyAllSheets(slicing?: Slicing, signal?: SheetAbortSignal): Promise<void> {
		if (!this.allReady) await this.readyAll(this.activeSheet(), slicing, () => undefined, signal)
	}

	// Results shown for formulas the file keeps none for move with their cells; a deleted one goes. `band`: only the
	// cells of these columns (an edit of rows) or rows (of columns) move (cells inserted or deleted).
	shiftShown(sheet: SheetId, edit: AxisEdit & { readonly band?: CellBand }): void {
		// What alone-held results read moves too: read again when next needed.
		this.aloneInputs.clear()

		const alone = this.alone.get(sheet)

		if (alone !== undefined && alone.size > 0) {
			const shifted = new Set<number>()

			for (const key of alone) {
				const moved = shiftedKey(key, edit)

				if (moved >= 0) shifted.add(moved)
			}

			this.alone.set(sheet, shifted)
		}

		const results = this.shownResults.get(sheet)

		if (results === undefined || results.size === 0) return

		const moved = new Map<number, ShownResult>()

		for (const [key, result] of results) {
			const next = shiftedKey(key, edit)

			if (next >= 0) moved.set(next, result)
		}

		this.shownResults.set(sheet, moved)
	}

	// The first PREVIEW_ROWS rows of a sheet, read from the start of its part alone, before the whole part is
	// inflated and parsed: what the first tiles show while the parse goes on. The start of the part (up to the row
	// after them) is closed off and read by the sheet reader itself, so it shows as the parsed sheet will. Null
	// when that cannot be done (UTF-16, stored oddly, not reading): the parse is waited for.
	async preview(sheet: SheetId): Promise<boolean> {
		const entry = this.entry(sheet)
		const part =
			entry === undefined || entry.model !== null || this.workbook.format !== "xlsx" ? undefined : this.workbook.parts.get(entry.part)
		const zipEntry = part?.source ?? null

		if (entry === undefined || part === undefined || zipEntry === null) return false

		try {
			const zip = this.workbook.opc.zip
			const { dataOffset } = await zip.layout(zipEntry)
			const prefix = new PartPrefix()
			let complete = false
			const enough = (): boolean => prefix.size >= PREVIEW_MAX_BYTES || prefix.rows.length > PREVIEW_ROWS

			if (zipEntry.method === 0) {
				prefix.push(await zip.source.read(dataOffset, Math.min(zipEntry.compressedSize, PREVIEW_MAX_BYTES)))
				complete = zipEntry.compressedSize <= PREVIEW_MAX_BYTES
			} else if (zipEntry.method === 8) {
				const inflater = new Inflate((chunk, final) => {
					prefix.push(chunk)

					if (final) complete = true
				})

				for (let read = 0; read < zipEntry.compressedSize && !complete && !enough();) {
					const length = Math.min(PREVIEW_READ, zipEntry.compressedSize - read)

					read += length
					inflater.push(await zip.source.read(dataOffset + read - length, length), read >= zipEntry.compressedSize)
				}
			} else {
				return false
			}

			const bytes = prefix.view()

			if (bytes[0] === 0xff || bytes[0] === 0xfe || (bytes.length > 1 && bytes[1] === 0)) return false

			const cut = complete ? { bytes, rows: SHEET_MAX_ROWS } : closedPrefix(bytes, prefix.rows)

			// A preview that cannot answer the first tile row is none: the parse is waited for.
			if (cut === null || cut.rows < PREVIEW_ROWS) return false

			const relationships = await this.workbook.parts.relationships(part.name)
			const model = await readWorksheet(cut.bytes, {
				id: sheet,
				part: part.name,
				relationships,
				limits: this.workbook.limits,
				sharedStrings: this.workbook.sharedStrings.sourceLength,
				cellBudget: PREVIEW_MAX_BYTES,
				clock: undefined,
				signal: undefined
			})
			const dimension = model.sections.find(section => section.name === "dimension")

			if (entry.model !== null) return false

			this.previews.set(sheet, {
				model,
				rows: cut.rows,
				dimension: dimension === undefined ? null : readDimension(dimension.bytes)
			})

			return true
		} catch {
			return false
		}
	}

	dropPreview(sheet: SheetId): void {
		this.previews.delete(sheet)
	}

	// Whether a sheet's preview holds every cell of these tile rows.
	previewCovers(sheet: SheetId, tileRows: readonly number[]): boolean {
		const preview = this.model(sheet) === null ? this.previews.get(sheet) : undefined

		return preview !== undefined && tileRows.every(tileRow => (tileRow + 1) * TILE_ROWS <= preview.rows)
	}

	get allReady(): boolean {
		return this.workbook.sheets.every(sheet => sheet.model !== null)
	}

	// --- Protection ---

	protection(sheet: SheetId): SheetProtectionState | null {
		const protection = this.model(sheet)?.protection ?? null

		return protection === null ? null : { hasPassword: hasHash(protection.hash), allows: protection.allows }
	}

	workbookProtection(): SheetWorkbookProtection | null {
		const protection = this.workbook.protection

		return protection === null
			? null
			: { structure: protection.structure, windows: protection.windows, hasPassword: hasHash(protection.hash) }
	}

	title(): string | undefined {
		return this.workbook.title
	}

	fileSharing(): SheetFileSharing | null {
		const sharing = this.workbook.fileSharing

		return sharing === null
			? null
			: {
					readOnlyRecommended: sharing.readOnlyRecommended,
					modifyPassword: hasHash(sharing.hash),
					...(sharing.userName !== undefined && { userName: sharing.userName })
				}
	}

	// A refusal when sheet protection forbids `action` on `sheet`.
	protects(sheet: SheetId, action: SheetProtectedAction): SheetRefusal | null {
		const protection = this.model(sheet)?.protection ?? null

		return protection === null || protection.allows.has(action) ? null : { reason: "protectedSheet", detail: action }
	}

	// Whether a cell cannot be edited: its sheet is protected and its format locks it (§18.8.33).
	locked(sheet: SheetId, row: number, col: number): boolean {
		const model = this.model(sheet)

		if (model === null || model.protection === null) return false

		const slot = model.store.locate(row, col)

		return this.styles.locked(slot < 0 ? this.startingStyle(model, row, col) : (model.store as SheetStore).style(slot))
	}

	// --- Writability ---

	// What is known at open: legacy formats, signatures and the author's sharing settings make it view-only; anything
	// else waits for the proof.
	initialWritability(): SheetWritability {
		// An OpenDocument spreadsheet saves through its own writer, without which it is shown only.
		if (isLegacyKind(this.kind) || (this.workbook.format === "ods" && this.writer === undefined))
			return { state: "viewOnly", reason: "legacyFormat" }
		const refusal = this.writer?.viewOnly ?? null

		if (refusal !== null) return { state: "viewOnly", reason: refusal }
		if (this.workbook.signatures > 0) return { state: "viewOnly", reason: "signed" }

		const sharing = this.fileSharing()

		if (sharing !== null && !this.writeUnlocked) {
			if (sharing.modifyPassword) return { state: "viewOnly", reason: "modifyPassword" }
			if (sharing.readOnlyRecommended) return { state: "viewOnly", reason: "readOnlyRecommended" }
		}

		return { state: "unproven" }
	}

	// The proof: every sheet read (an edit may move cells of any sheet, and formulas read every sheet). The save
	// gate checks each save on top: nothing the writer cannot hold is ever handed out.
	async prove(
		slicing: Slicing | undefined,
		signal: SheetAbortSignal | undefined,
		progress: (done: number, total: number) => void
	): Promise<SheetWritability> {
		const total = this.workbook.sheets.length
		let done = this.workbook.sheets.filter(sheet => sheet.model !== null).length

		progress(done, total)
		await this.readyAll(this.activeSheet(), slicing, () => progress(++done, total), signal)

		if (signal?.aborted === true || this.closed) return { state: "unproven" }

		for (const error of this.failed.values()) return { state: "viewOnly", reason: error.code === "tooLarge" ? "tooLarge" : "lossy" }

		if (!this.allReady) return { state: "unproven" }

		return { state: "writable" }
	}

	// --- Showing cells ---

	// The format a cell without one of its own starts from: its run's (a source's style-only block), else its row's (a
	// row formatted as a whole), else its column's, else the default.
	startingStyle(model: XlsxSheetModel, row: number, col: number): number {
		const store = model.store as SheetStore
		const block = store.blocks[store.blockOf(row)]
		const index = block === undefined ? -1 : block.rowIndex(row)

		const run = model.styleRuns?.styleAt(row, col) ?? -1

		if (run >= 0) return run

		if (block !== undefined && index >= 0 && ((block.rowFlags[index] ?? 0) & RowFlag.CUSTOM_FORMAT) !== 0) {
			const style = block.rowStyles[index] ?? -1

			if (style >= 0) return style
		}

		for (const range of model.cols) if (col >= range.first && col <= range.last && range.style >= 0) return range.style

		return 0
	}

	// The render style index of a cell format, with a number format's colour over its font's.
	render(xf: number, color: number): number {
		const key = xf * 0x1000001 + color + 1
		let index = this.renderIndex.get(key)

		if (index === undefined) {
			const base = this.styles.renderStyle(xf)

			index = this.interner.intern(color < 0 ? base : { ...base, color })
			this.renderIndex.set(key, index)
		}

		return index
	}

	// The runs of a rich shared string in a cell of format `xf`: each run's start in the shown text and its look (the
	// cell's, with the run's own font in place of the cell's: a run's properties are its whole font, §18.4.7).
	// Null for plain text.
	richRuns(index: number, xf: number, color: number): { readonly starts: readonly number[]; readonly styles: readonly number[] } | null {
		const strings = this.workbook.sharedStrings

		if (!strings.isRich(index)) return null

		const key = `${String(index)}:${String(xf)}:${String(color)}`
		const cached = this.richCache.get(key)

		if (cached !== undefined) return cached

		const runs = strings.runs(index)

		if (runs === null || runs.length === 0) return null

		const base = this.styles.renderStyle(xf)
		const cell: SheetRenderStyle = color < 0 ? base : { ...base, color }
		const starts: number[] = []
		const styles: number[] = []
		let offset = 0

		for (const run of runs) {
			starts.push(offset)
			styles.push(run.font === null ? this.interner.intern(cell) : this.interner.intern(this.withFont(cell, run.font)))
			offset += decodeXstring(run.text).length
		}

		const result = { starts, styles }

		if (this.richCache.size > 4096) this.richCache.clear()

		this.richCache.set(key, result)

		return result
	}

	private withFont(cell: SheetRenderStyle, font: XlsxFont): SheetRenderStyle {
		const {
			font: _font,
			size: _size,
			bold: _bold,
			italic: _italic,
			strike: _strike,
			underline: _underline,
			script: _script,
			color: _color,
			...rest
		} = cell
		const style: { -readonly [K in keyof SheetRenderStyle]: SheetRenderStyle[K] } = { ...rest }
		const theme = this.workbook.theme
		const name =
			font.scheme === "major" && theme !== null && theme.majorFont !== ""
				? theme.majorFont
				: font.scheme === "minor" && theme !== null && theme.minorFont !== ""
					? theme.minorFont
					: font.name

		if (name !== undefined && name !== "") style.font = name
		if (font.size !== undefined && font.size > 0) style.size = font.size
		if (font.bold === true) style.bold = true
		if (font.italic === true) style.italic = true
		if (font.strike === true) style.strike = true
		if (font.underline !== undefined && font.underline !== "none") style.underline = font.underline
		if (font.vertAlign === "superscript" || font.vertAlign === "subscript") style.script = font.vertAlign

		const rgb = this.styles.color(font.color)

		if (rgb >= 0 && font.color?.auto !== true) style.color = rgb

		return style
	}

	numFmt(xf: number): NumFmt {
		return this.styles.numFmt(xf)
	}

	// A number as cell format `xf` shows it, in the workbook's date system and locale.
	formatNumber(xf: number, value: number): string {
		return formatNumberInto(this.styles.numFmt(xf), value, this.out, this.numFmtOptions).text
	}

	// A stored cell's value as it shows (a formula's shown result): a number, true or false, an error's text, text
	// as `'text`; undefined when it shows none.
	shownValue(
		model: XlsxSheetModel,
		row: number,
		col: number,
		kind: CellKind,
		value: number,
		formula: number
	): RawCellContent | undefined {
		if (formula < 0) return this.storedResult(model, kind, value)

		const shown = this.shownResults.get(model.id)?.get(cellKeyOf(row, col))

		if (kind !== CellKind.EMPTY && shown?.recalculated !== true) return this.storedResult(model, kind, value)
		if (shown === undefined || shown.value === null) return undefined
		if (typeof shown.value === "string") return shown.error ? shown.value : `'${shown.value}`

		return shown.value
	}

	stringOf(model: XlsxSheetModel, kind: CellKind, value: number): string {
		return decodeXstring(kind === CellKind.SHARED_STRING ? this.workbook.sharedStrings.text(value) : model.store.strings.text(value))
	}

	// A cell's formula as the user reads and edits it (in the file's own syntax, without "="): one written before
	// dynamic arrays (neither an array formula nor a data table) with the @ Excel shows where it reads one value from
	// a range, so typed again it means the same.
	shownFormulaText(model: XlsxSheetModel, id: number, row: number, col: number): string {
		const text = this.formulaText(model, id, row, col)
		const kind = model.store.formulas.kind(id)

		if (kind === FormulaKind.ARRAY || kind === FormulaKind.DATA_TABLE) return shownFormula(text)

		const kept = this.legacyShown.get(text)

		if (kept !== undefined) return kept

		this.namesRead = false

		const shown = shownFormula(legacyIntersections(text, takesOneValue, this.knownFunction))

		// One calling a defined name is read again each time: the names may change.
		if (!this.namesRead) {
			if (this.legacyShown.size >= LEGACY_SHOWN) this.legacyShown.clear()

			this.legacyShown.set(text, shown)
		}

		return shown
	}

	// shownFormulaText's results by stored text (formulas repeat down a column), up to LEGACY_SHOWN of them.
	private readonly legacyShown = new Map<string, string>()
	// Whether knownFunction looked at the defined names.
	private namesRead = false

	// Whether a name called in a formula is a function the workbook or Excel knows (a defined name, a LAMBDA's
	// parameter, a worksheet function) rather than an add-in's.
	private readonly knownFunction = (name: string): boolean => {
		if (/^_xlpm\./i.test(name) || sheetFunction(name) !== undefined || KNOWN_OPERATORS.test(name)) return true

		const upper = name.toUpperCase()

		this.namesRead = true

		return this.workbook.definedNames.some(entry => entry.name.toUpperCase() === upper)
	}

	formulaText(model: XlsxSheetModel, id: number, row: number, col: number): string {
		const formulas = model.store.formulas

		return formulas.kind(id) === FormulaKind.SHARED_CHILD ? formulas.expanded(id, row, col) : formulas.text(id)
	}

	private showNumber(format: NumFmt, value: number, formula: boolean): void {
		const shown = this.shown
		const out = formatNumberInto(format, value, this.out, this.numFmtOptions)

		shown.text = out.text
		shown.color = out.color
		shown.repeatOffset = out.repeatOffset
		shown.repeatChar = out.repeatChar
		shown.flags |= CellFlag.NUMBER

		if (!formula)
			shown.input = format.isDate ? typedSerial(value, this.dateBase) : localizedInput(String(value), this.ownSettings.locale)
	}

	// Text an OpenDocument cell holds that typed again would be no text (a number, a date, a formula): its entry
	// starts with an apostrophe, as LibreOffice shows it (an ODF cell has no quote-prefix flag to carry it).
	private quotedText(format: NumFmt, text: string): boolean {
		return this.workbook.format === "ods" && text !== "" && readEntry(text, format.isText, this.dateBase).type !== "text"
	}

	private showText(format: NumFmt, text: string, formula: boolean, quoted: boolean, rich = false): void {
		const shown = this.shown

		// Rich text shows as stored (its runs' offsets index it), whatever the format's text section.
		if (rich) {
			shown.text = text

			if (!formula) shown.input = quoted ? `'${text}` : text

			return
		}

		const out = formatTextInto(format, text, this.out, this.numFmtOptions)

		shown.text = out.text
		shown.color = out.color
		shown.repeatOffset = out.repeatOffset
		shown.repeatChar = out.repeatChar

		if (!formula) shown.input = quoted ? `'${text}` : text
	}

	// What a cell shows: into `this.shown`.
	private show(model: XlsxSheetModel, row: number, col: number, kind: CellKind, value: number, xf: number, formula: number): Shown {
		const shown = this.shown

		shown.text = ""
		shown.input = null
		shown.flags = 0
		shown.color = -1
		shown.repeatOffset = -1
		shown.repeatChar = ""

		const format = this.styles.numFmt(xf)
		const hasFormula = formula >= 0

		if (format.isText) shown.flags |= CellFlag.TEXT_FORMAT

		if (hasFormula) {
			const formulaKind = model.store.formulas.kind(formula)

			shown.flags |= CellFlag.FORMULA
			shown.input = localizedInput(`=${this.shownFormulaText(model, formula, row, col)}`, this.ownSettings.locale)

			// A dynamic array and a legacy array formula of one cell calculate here; a legacy one over a block or a data
			// table keeps its stored result, as does a formula the engine holds (a name or function it lacks).
			if (
				formulaKind === FormulaKind.DATA_TABLE ||
				(formulaKind === FormulaKind.ARRAY && this.legacyBlock(model.store.formulas.formula(formula))) ||
				this.alone.get(model.id)?.has(cellKeyOf(row, col)) === true
			)
				shown.flags |= CellFlag.CACHED

			if (kind === CellKind.EMPTY) {
				const result = this.shownResults.get(model.id)?.get(cellKeyOf(row, col))

				if (result !== undefined) this.showResult(format, result)

				return shown
			}

			const recalculated = this.shownResults.get(model.id)?.get(cellKeyOf(row, col))

			if (recalculated?.recalculated === true) {
				this.showResult(format, recalculated)

				return shown
			}
		}

		switch (kind) {
			case CellKind.NUMBER:
				this.showNumber(format, value, hasFormula)
				break
			case CellKind.SHARED_STRING:
			case CellKind.INLINE_STRING:
			case CellKind.FORMULA_STRING:
				this.showText(
					format,
					this.stringOf(model, kind, value),
					hasFormula,
					!hasFormula && (this.styles.quotePrefix(xf) || this.quotedText(format, this.stringOf(model, kind, value))),
					kind === CellKind.SHARED_STRING && this.workbook.sharedStrings.isRich(value)
				)
				break
			case CellKind.BOOLEAN:
				shown.text = value !== 0 ? "TRUE" : "FALSE"
				shown.flags |= CellFlag.BOOLEAN
				break
			case CellKind.ERROR:
				shown.text = model.store.strings.text(value)
				shown.flags |= CellFlag.ERROR
				break
			case CellKind.DATE: {
				const text = model.store.strings.text(value)
				const serial = isoSerial(text, this.dateBase)

				if (Number.isNaN(serial)) shown.text = text
				else this.showNumber(format, serial, hasFormula)
				break
			}
		}

		return shown
	}

	private showResult(format: NumFmt, result: ShownResult): void {
		const shown = this.shown
		const value = result.value

		if (result.error) {
			shown.text = String(value)
			shown.flags |= CellFlag.ERROR
		} else if (typeof value === "number") {
			this.showNumber(format, value, true)
		} else if (typeof value === "boolean") {
			shown.text = value ? "TRUE" : "FALSE"
			shown.flags |= CellFlag.BOOLEAN
		} else if (typeof value === "string") {
			this.showText(format, value, true, false)
		}
	}

	// A cell's text, what editing it starts from (null: its text), its render style and its flags.
	// What a cell the caller found in the store shows, and what editing it starts from (null when that is its text,
	// and for a protected sheet's hidden formula, flagged FORMULA_HIDDEN): no lookup, no render style. A search's read.
	shownAt(
		model: XlsxSheetModel,
		row: number,
		col: number,
		slot: number
	): { readonly text: string; readonly input: string | null; readonly flags: number } {
		const block = (model.store as SheetStore).blocks[Math.floor(slot / SLOT_BLOCK)]
		const at = slot % SLOT_BLOCK

		if (block === undefined) return { text: "", input: null, flags: 0 }

		const xf = block.styles[at] ?? 0
		const formula = block.formulas?.[at] ?? -1
		const shown = this.show(model, row, col, (block.kinds[at] ?? 0) as CellKind, block.values[at] ?? 0, xf, formula)
		let flags = shown.flags
		let input = shown.input

		if (model.protection !== null && formula >= 0 && this.styles.formulaHidden(xf)) {
			flags |= CellFlag.FORMULA_HIDDEN
			input = null
		}

		if (model.protection !== null && this.styles.protection(xf)?.hideAll === true)
			return { text: "", input: null, flags: flags | CellFlag.FORMULA_HIDDEN }

		return { text: shown.text, input: input === shown.text ? null : input, flags }
	}

	cellView(sheet: SheetId, row: number, col: number): { text: string; input: string | null; style: number; flags: number; xf: number } {
		const model = this.model(sheet)

		if (model === null) return { text: "", input: null, style: 0, flags: 0, xf: 0 }

		const store = model.store as SheetStore
		const slot = store.locate(row, col)
		const xf = slot < 0 ? this.startingStyle(model, row, col) : store.style(slot)
		const shown =
			slot < 0
				? this.show(model, row, col, CellKind.EMPTY, 0, xf, -1)
				: this.show(model, row, col, store.kind(slot), store.value(slot), xf, store.formula(slot))
		let flags = shown.flags
		let input = shown.input

		if (model.protection !== null) {
			if (this.styles.locked(xf)) flags |= CellFlag.LOCKED

			if ((flags & CellFlag.FORMULA) !== 0 && this.styles.formulaHidden(xf)) {
				flags |= CellFlag.FORMULA_HIDDEN
				input = null
			}

			if (this.styles.protection(xf)?.hideAll === true) {
				return { text: "", input: null, style: this.render(xf, -1), flags: flags | CellFlag.FORMULA_HIDDEN, xf }
			}
		}

		return { text: shown.text, input: input === shown.text ? null : input, style: this.render(xf, shown.color), flags, xf }
	}

	// The base entries of one tile: every cell the store holds there.
	fillTile(sheet: SheetId, tileRow: number, tileCol: number, sink: TileEntrySink): void {
		const model = this.model(sheet) ?? this.previews.get(sheet)?.model ?? null

		if (model === null) return

		const protectedSheet = model.protection !== null
		const store = model.store as SheetStore
		const firstRow = tileRow * TILE_ROWS
		const firstCol = tileCol * TILE_COLS

		store.forEachCell(
			{ startRow: firstRow, startCol: firstCol, endRow: firstRow + TILE_ROWS - 1, endCol: firstCol + TILE_COLS - 1 },
			(row, col, slot) => {
				const block = store.blocks[Math.floor(slot / SLOT_BLOCK)]
				const at = slot % SLOT_BLOCK

				if (block === undefined) return

				const xf = block.styles[at] ?? 0
				const formula = block.formulas?.[at] ?? -1
				const shown = this.show(model, row, col, (block.kinds[at] ?? 0) as CellKind, block.values[at] ?? 0, xf, formula)
				let flags = shown.flags
				let input = shown.input

				let hidden = false

				if (protectedSheet) {
					if (this.styles.locked(xf)) flags |= CellFlag.LOCKED

					if (formula >= 0 && this.styles.formulaHidden(xf)) {
						flags |= CellFlag.FORMULA_HIDDEN
						input = null
					}

					hidden = this.styles.protection(xf)?.hideAll === true
				}

				if (hidden) {
					sink.add(row, col, "", null, this.render(xf, -1), flags | CellFlag.FORMULA_HIDDEN)

					return
				}

				let text = shown.text
				let own = input === text ? null : input

				// No tile carries more of a text than a cell paints: the cell query gives the whole input.
				if (text.length > SHEET_TILE_TEXT || (own?.length ?? 0) > SHEET_TILE_TEXT) {
					flags |= CellFlag.CLIPPED
					text = tileText(text)
					own = own === null ? null : tileText(own)
				}

				const repeats = shown.repeatOffset >= 0 && shown.repeatOffset <= text.length

				if (repeats) flags |= CellFlag.REPEAT

				const kind = (block.kinds[at] ?? 0) as CellKind
				const runs = kind === CellKind.SHARED_STRING && formula < 0 ? this.richRuns(block.values[at] ?? 0, xf, shown.color) : null

				if (runs !== null) flags |= CellFlag.RICH

				const entry = sink.add(row, col, text, own, this.render(xf, shown.color), flags)

				if (runs !== null) {
					if (text.length === shown.text.length) {
						sink.runs(entry, runs.starts, runs.styles)
					} else {
						const kept = runs.starts.filter(start => start < text.length).length

						sink.runs(entry, runs.starts.slice(0, kept), runs.styles.slice(0, kept))
					}
				}

				if (repeats) sink.repeat(entry, shown.repeatOffset, shown.repeatChar)
			}
		)

		// Empty cells formatted in runs the store does not hold: their look, no text.
		model.styleRuns?.forEach(
			{ startRow: firstRow, startCol: firstCol, endRow: firstRow + TILE_ROWS - 1, endCol: firstCol + TILE_COLS - 1 },
			(startRow, startCol, endRow, endCol, xf) => {
				const style = this.render(xf, -1)
				const flags = protectedSheet && this.styles.locked(xf) ? CellFlag.LOCKED : 0

				for (let row = startRow; row <= endRow; row++) {
					for (let col = startCol; col <= endCol; col++)
						if (store.locate(row, col) < 0) sink.add(row, col, "", null, style, flags)
				}
			}
		)
	}

	// --- Layout ---

	layout(sheet: SheetId): Omit<SheetLayout, "version" | "extensions"> {
		const preview = this.model(sheet) === null ? this.previews.get(sheet) : undefined
		const model = this.model(sheet) ?? preview?.model ?? null

		if (model === null) throw new Error(`Sheet ${String(sheet)} is not ready`)

		const store = model.store as SheetStore
		const format = model.format
		const defaultRow = rowHeightToPx(format.defaultRowHeight)
		const rowIndices: number[] = []
		const rowSizes: number[] = []
		const rowStyles: number[] = []
		const rowFlags: number[] = []

		for (const block of store.blocks) {
			for (let i = 0; i < block.rowCount; i++) {
				const own = block.rowFlags[i] ?? 0
				const height = block.rowHeights[i] ?? Number.NaN
				const size = Number.isNaN(height) ? defaultRow : rowHeightToPx(height)
				const styled = (own & RowFlag.CUSTOM_FORMAT) !== 0 && (block.rowStyles[i] ?? -1) >= 0
				let flags = 0

				if ((own & RowFlag.HIDDEN) !== 0) flags |= AxisFlag.HIDDEN
				if ((own & RowFlag.CUSTOM_HEIGHT) !== 0) flags |= AxisFlag.CUSTOM
				if ((own & RowFlag.COLLAPSED) !== 0) flags |= AxisFlag.COLLAPSED

				flags |= ((own & RowFlag.OUTLINE_MASK) >> RowFlag.OUTLINE_SHIFT) << AxisFlag.OUTLINE_SHIFT

				if (styled) {
					flags |= AxisFlag.STYLED

					if (this.styles.numFmt(block.rowStyles[i] ?? 0).isText) flags |= AxisFlag.TEXT_FORMAT
				}

				if (flags === 0 && size === defaultRow) continue

				rowIndices.push(block.firstRow + (block.rows[i] ?? 0))
				rowSizes.push(size)
				rowStyles.push(styled ? this.render(block.rowStyles[i] ?? 0, -1) : 0)
				rowFlags.push(flags)
			}
		}

		// Rows the store does not hold (an OpenDocument sheet's runs of hidden or resized rows): an entry each.
		const rowRuns: AxisRun[] = []

		for (const run of model.rowRuns ?? []) {
			const size = Number.isNaN(run.heightPt) ? defaultRow : rowHeightToPx(run.heightPt)
			let flags = 0

			if ((run.flags & RowFlag.HIDDEN) !== 0) flags |= AxisFlag.HIDDEN
			if ((run.flags & RowFlag.CUSTOM_HEIGHT) !== 0) flags |= AxisFlag.CUSTOM
			if ((run.flags & RowFlag.COLLAPSED) !== 0) flags |= AxisFlag.COLLAPSED

			flags |= ((run.flags & RowFlag.OUTLINE_MASK) >> RowFlag.OUTLINE_SHIFT) << AxisFlag.OUTLINE_SHIFT

			if (flags === 0 && size === defaultRow) continue

			rowRuns.push({ first: run.first, count: run.last - run.first + 1, size, style: 0, flags })
		}

		const defaultCol = format.defaultColPx ?? defaultColPx(format, this.digitPx)
		const colIndices: number[] = []
		const colSizes: number[] = []
		const colStyles: number[] = []
		const colFlags: number[] = []

		for (const range of model.cols) {
			const size = range.px ?? (Number.isNaN(range.width) ? defaultCol : colWidthToPx(range.width, this.digitPx))
			let flags = 0

			if ((range.flags & ColFlag.HIDDEN) !== 0) flags |= AxisFlag.HIDDEN
			if ((range.flags & ColFlag.CUSTOM_WIDTH) !== 0) flags |= AxisFlag.CUSTOM
			if ((range.flags & ColFlag.COLLAPSED) !== 0) flags |= AxisFlag.COLLAPSED

			flags |= ((range.flags & ColFlag.OUTLINE_MASK) >> ColFlag.OUTLINE_SHIFT) << AxisFlag.OUTLINE_SHIFT

			if (range.style > 0) {
				flags |= AxisFlag.STYLED

				if (this.styles.numFmt(range.style).isText) flags |= AxisFlag.TEXT_FORMAT
			}

			if (flags === 0 && size === defaultCol) continue

			const style = range.style > 0 ? this.render(range.style, -1) : 0

			for (let col = range.first; col <= Math.min(range.last, SHEET_MAX_COLS - 1); col++) {
				colIndices.push(col)
				colSizes.push(size)
				colStyles.push(style)
				colFlags.push(flags)
			}
		}

		const lastRun = model.rowRuns?.[model.rowRuns.length - 1]
		let rowCount = Math.max(store.rowExtent, model.styleRuns?.rowExtent ?? 0, lastRun === undefined ? 0 : lastRun.last + 1)
		let colCount = Math.max(store.colExtent, model.styleRuns?.colExtent ?? 0)
		const merges = model.merges

		for (let i = 0; i + 3 < merges.length; i += 4) {
			rowCount = Math.max(rowCount, (merges[i + 2] ?? 0) + 1)
			colCount = Math.max(colCount, (merges[i + 3] ?? 0) + 1)
		}

		// A preview stands for the whole sheet: its dimension says how far it reaches.
		if (preview?.dimension !== null && preview?.dimension !== undefined) {
			rowCount = Math.max(rowCount, preview.dimension.endRow + 1)
			colCount = Math.max(colCount, preview.dimension.endCol + 1)
		}

		const view = model.view
		const frozen = view.frozen

		return {
			sheet,
			rowCount: Math.min(rowCount, SHEET_MAX_ROWS),
			colCount: Math.min(colCount, SHEET_MAX_COLS),
			rows: withRuns(defaultRow, rowIndices, rowSizes, rowStyles, rowFlags, rowRuns),
			cols: axisLayout(defaultCol, colIndices, colSizes, colStyles, colFlags),
			merges: merges.slice(),
			pane: frozen === null ? null : layoutPane(view, frozen),
			selection: { activeRow: view.activeRow, activeCol: view.activeCol, ranges: view.selection },
			zoom: view.zoom,
			gridLines: view.gridLines,
			headings: view.headings,
			rightToLeft: view.rightToLeft,
			// The model shown (a preview's while the sheet is parsed), as its tiles flag locked cells.
			protection: model.protection === null ? null : { hasPassword: hasHash(model.protection.hash), allows: model.protection.allows }
		}
	}

	// --- Writing cells ---

	state(sheet: SheetId, row: number, col: number): CellState {
		const model = this.model(sheet)

		return model === null ? ABSENT : cellState(model.store, row, col, this.shownResults.get(sheet)?.get(cellKeyOf(row, col)))
	}

	// Writes a cell, keeping the shared strings' reference count and the change log in step. `restore`: the cell is
	// put back as it was (an undo or redo), so it stays though it holds nothing and is again the source cell it was.
	write(sheet: SheetId, row: number, col: number, state: CellState, restore = false): void {
		const model = this.model(sheet)

		if (model === null) return

		const store = model.store as SheetStore
		const write = this.cellWrite(sheet, store, row, col, state, restore)

		store.setCell(row, col, write.kind, write.value, write.style, write.formula, write.origin)
		this.wrote(sheet, write.delta, write.formulaChanged)
	}

	// write for many cells of one sheet, each named once: the store rebuilds each block they fall in once
	// (SheetStore.setCells), where one write after another copies a block for every row or cell added.
	writeCells(
		sheet: SheetId,
		cells: readonly { readonly row: number; readonly col: number; readonly state: CellState }[],
		restore = false
	): void {
		const only = cells.length === 1 ? cells[0] : undefined

		if (only !== undefined) {
			this.write(sheet, only.row, only.col, only.state, restore)

			return
		}

		const model = this.model(sheet)

		if (model === null || cells.length === 0) return

		const store = model.store as SheetStore
		const writes: CellWrite[] = []
		let delta = 0
		let formulaChanged = false

		for (const { row, col, state } of cells) {
			const write = this.cellWrite(sheet, store, row, col, state, restore)

			writes.push(write)
			delta += write.delta
			formulaChanged ||= write.formulaChanged
		}

		store.setCells(writes)
		this.wrote(sheet, delta, formulaChanged)
	}

	// What write gives the store for one cell (its old content read before anything is written), with the shown
	// result kept or dropped.
	private cellWrite(
		sheet: SheetId,
		store: SheetStore,
		row: number,
		col: number,
		state: CellState,
		restore: boolean
	): CellWrite & { readonly delta: number; readonly formulaChanged: boolean } {
		const slot = store.locate(row, col)
		const oldKind = slot < 0 ? CellKind.EMPTY : store.kind(slot)
		const oldFormula = slot < 0 ? -1 : store.formula(slot)
		const kind = state.present ? state.kind : CellKind.EMPTY
		const formula = state.present ? state.formula : -1
		const delta = (oldKind === CellKind.SHARED_STRING ? -1 : 0) + (kind === CellKind.SHARED_STRING ? 1 : 0)

		if (oldFormula !== formula) this.alone.get(sheet)?.delete(cellKeyOf(row, col))

		const results = this.shownResults.get(sheet)

		if (state.shown === undefined) {
			results?.delete(cellKeyOf(row, col))
		} else {
			let map = results

			if (map === undefined) {
				map = new Map()
				this.shownResults.set(sheet, map)
			}

			map.set(cellKeyOf(row, col), state.shown)
		}

		return {
			row,
			col,
			kind,
			value: state.present ? state.value : 0,
			style: state.present ? state.style : 0,
			formula,
			// Put back as it was (an undo or redo), or a paste carrying a source cell's markup (CARRIED).
			origin: state.present && state.origin !== undefined && (restore || state.origin >= CARRIED) ? state.origin : -1,
			delta,
			formulaChanged: oldFormula !== formula
		}
	}

	// The change log after cells were written: their rows, the shared strings' references, the formulas.
	private wrote(sheet: SheetId, delta: number, formulaChanged: boolean): void {
		const strings = this.workbook.sharedStrings

		this.workbook.changes.sheetRows(sheet)

		if (delta !== 0) strings.adjustReferences(delta)
		if (delta !== 0 || strings.length > strings.sourceLength) this.workbook.changes.sharedStringsAppended()
		if (formulaChanged) this.workbook.changes.formulasChanged()
	}

	// writeCells in parts of WRITE_SLICE cells, yielding between them once the clock's slice is up (a large paste, fill
	// or undo in the in-thread host). Each cell is named once, so the parts may go in any order.
	async writeCellsSliced(
		sheet: SheetId,
		cells: readonly { readonly row: number; readonly col: number; readonly state: CellState }[],
		restore: boolean,
		clock: SliceClock | undefined
	): Promise<void> {
		if (clock === undefined || cells.length <= WRITE_SLICE) {
			this.writeCells(sheet, cells, restore)

			return
		}

		for (let start = 0; start < cells.length; start += WRITE_SLICE) {
			this.writeCells(sheet, cells.slice(start, start + WRITE_SLICE), restore)

			if (clock.due) await clock.pause()
		}
	}

	// The writer CellLog.restore takes.
	readonly restoreCell = (sheet: SheetId, row: number, col: number, state: CellState): void => {
		this.write(sheet, row, col, state, true)
	}

	// Writes back every cell of a log as it was before (undo) or after (redo) the edit, a sheet's cells at once
	// (writeCells): a log names each cell once, so the order CellLog.restore keeps does not matter here.
	restoreLog(log: CellLog, which: "before" | "after"): void {
		for (const [sheet, cells] of this.logCells(log, which)) this.writeCells(sheet, cells, true)
	}

	// restoreLog in slices (writeCellsSliced).
	async restoreLogSliced(log: CellLog, which: "before" | "after", clock: SliceClock | undefined): Promise<void> {
		for (const [sheet, cells] of this.logCells(log, which)) await this.writeCellsSliced(sheet, cells, true, clock)
	}

	// A log's cells as they were before or after its edit, by sheet.
	private logCells(log: CellLog, which: "before" | "after"): Map<SheetId, { row: number; col: number; state: CellState }[]> {
		const states = which === "before" ? log.before : log.after
		const bySheet = new Map<SheetId, { row: number; col: number; state: CellState }[]>()

		for (let i = 0; i < log.size; i++) {
			const state = states[i]
			const sheet = log.sheets[i] ?? 0

			if (state === undefined) continue

			let cells = bySheet.get(sheet)

			if (cells === undefined) {
				cells = []
				bySheet.set(sheet, cells)
			}

			cells.push({ row: log.rows[i] ?? 0, col: log.cols[i] ?? 0, state })
		}

		return bySheet
	}

	// --- Formula engine ---

	get hasFormulas(): boolean {
		return this.workbook.sheets.some(entry => (entry.model?.store.formulas.length ?? 0) > 0)
	}

	engineIndex(sheet: SheetId): number {
		return this.engineSheets.indexOf(sheet)
	}

	// The stored result of a formula cell, as the engine takes it in place of a formula it cannot read.
	private storedResult(model: XlsxSheetModel, kind: CellKind, value: number, shown?: ShownResult): RawCellContent | undefined {
		switch (kind) {
			case CellKind.EMPTY:
				// A result the session shows without storing it: held as the cell's result once given to the engine again.
				// The engine failing on it (an unparseable formula) is no result: given again, it fails the same way.
				if (shown === undefined || shown.value === null || FormulaEngine.unsupported(shown.value)) return undefined
				if (typeof shown.value === "string") return shown.error ? shown.value : `'${shown.value}`

				return shown.value
			case CellKind.NUMBER:
				return value
			case CellKind.BOOLEAN:
				return value !== 0
			case CellKind.ERROR:
				return model.store.strings.text(value)
			case CellKind.SHARED_STRING:
			case CellKind.INLINE_STRING:
			case CellKind.FORMULA_STRING:
				return `'${this.stringOf(model, kind, value)}`
			case CellKind.DATE: {
				const serial = isoSerial(model.store.strings.text(value), this.dateBase)

				return Number.isNaN(serial) ? undefined : serial
			}
			default:
				return undefined
		}
	}

	// Formula cells the engine holds alone (FILEN.HELD.ALONE: their inputs are not known to it), by sheet and cell:
	// told stale here when what they read changes.
	private readonly alone = new Map<SheetId, Set<number>>()
	// What each of them reads, by sheet and cell (null: not known, so any edit), read when first needed.
	private readonly aloneInputs = new Map<SheetId, Map<number, readonly ReadArea[] | null>>()
	// The workbook's tables: name (upper case), sheet, range and header rows.
	private tables: readonly XlsxTableRange[] | null = null
	// The workbook's dynamic-array cell metadata (spill.ts), read with the tables; null before.
	private dynamicArrays: DynamicArrays | null = null

	// Whether an array formula's cell metadata makes it a dynamic array.
	isDynamicArray(cellMetadata: number): boolean {
		return cellMetadata >= 0 && this.dynamicArrays?.dynamic.has(cellMetadata) === true
	}

	// Whether an array formula is a legacy one (Ctrl+Shift+Enter) over a block of cells: what it gives the block's
	// other cells is not calculated here, so it keeps its stored results. One of a single cell is calculated.
	legacyBlock(formula: XlsxFormula): boolean {
		const ref = formula.ref

		return ref !== null && (ref.endRow > ref.startRow || ref.endCol > ref.startCol) && !this.isDynamicArray(formula.cellMetadata)
	}

	// Whether a formula typed on a sheet gives an array as the engine calculates it now (a function lifted over a
	// range: LEN(A1:A3)); false without an engine to ask.
	givesArray(sheet: SheetId, formula: string): boolean {
		const engine = this.engine
		const index = this.engineIndex(sheet)
		const text =
			engine === null || index < 0 || holdsBracket(formula) ? null : engineArrayFormula(formula, this.nameAliases, this.lambdaNames)

		return text !== null && engine !== null && engine.givesArray(index, text)
	}

	// The cell metadata a new dynamic array is written with (the metadata part made for it first), or null when the
	// workbook cannot take one here: it is written as an ordinary formula then.
	newDynamicArrayCm(): number | null {
		if (this.dynamicArrays === null) return null

		const before = this.dynamicArrays
		const made = dynamicArrayCm(this.workbook, before)

		if (made === null) return null

		this.dynamicArrays = made.arrays

		if (made.made !== undefined) {
			const part = made.made
			const after = made.arrays

			this.madeMetadata = {
				remove: () => {
					part.remove()
					this.dynamicArrays = before
				},
				add: () => {
					part.add()
					this.dynamicArrays = after
				}
			}
		}

		return made.cm
	}

	// The metadata part newDynamicArrayCm made since last asked, for the edit that made it to take away on undo.
	takeMadeMetadata(): MadeMetadata | null {
		const made = this.madeMetadata

		this.madeMetadata = null

		return made
	}

	private madeMetadata: MadeMetadata | null = null

	private markAlone(sheet: SheetId, row: number, col: number): void {
		let cells = this.alone.get(sheet)

		if (cells === undefined) {
			cells = new Set()
			this.alone.set(sheet, cells)
		}

		const key = cellKeyOf(row, col)

		cells.add(key)
		this.aloneInputs.get(sheet)?.delete(key)
	}

	// A formula cell the engine holds its result for, told stale here when what it reads changes.
	private held(model: XlsxSheetModel, row: number, col: number, value: RawCellContent, spill?: SpillSize): EngineCell {
		this.markAlone(model.id, row, col)

		return { row, col, content: new HeldResult(value), ...(spill !== undefined && { spill }) }
	}

	// Whether a block of a sheet holds a merged cell or a table, which a dynamic array does not spill over
	// (support.microsoft.com "How to correct a #SPILL! error": "Spill range has merged cells", "Spill range in
	// table"). Tables as last read (loadTables, before an edit recalculates).
	private spillBlocked(sheet: SheetId | undefined, range: SheetRange): boolean {
		const model = sheet === undefined ? null : this.model(sheet)

		if (sheet === undefined || model === null) return false

		const merges = model.merges

		for (let i = 0; i + 3 < merges.length; i += 4)
			if (
				(merges[i] ?? 0) <= range.endRow &&
				(merges[i + 2] ?? 0) >= range.startRow &&
				(merges[i + 1] ?? 0) <= range.endCol &&
				(merges[i + 3] ?? 0) >= range.startCol
			)
				return true

		return (this.tables ?? []).some(
			table =>
				table.sheet === sheet &&
				table.range.startRow <= range.endRow &&
				table.range.endRow >= range.startRow &&
				table.range.startCol <= range.endCol &&
				table.range.endCol >= range.startCol
		)
	}

	// A structure edit moved, renamed or removed what held results read (tables, names, cells): the tables are read
	// again (loadTables) and what each held result reads is worked out again when next needed.
	structureChanged(): void {
		this.tables = null
		this.aloneInputs.clear()
	}

	// Reads every table part once, as edits left it (what structured references in held formulas read). A table part
	// another edit rewrites is left out: a formula naming it reads what is not known.
	async loadTables(): Promise<void> {
		this.dynamicArrays ??= this.workbook.format === "ods" ? ODS_DYNAMIC_ARRAYS : await readDynamicArrays(this.workbook)

		if (this.tables !== null) return

		const tables: XlsxTableRange[] = []
		const state = refState(this.workbook)

		for (const entry of this.workbook.sheets) {
			const edits = this.workbook.changes.relationships.get(entry.part)
			const relationships = [
				...(entry.model?.relationships.all ?? []).filter(relationship => edits?.removed.has(relationship.id) !== true),
				...(entry.model === null ? [] : (edits?.added ?? []))
			]

			for (const relationship of relationships) {
				if (relationship.external || !relationship.type.endsWith("/table") || relationship.partName === undefined) continue

				let bytes: Uint8Array | null

				try {
					bytes = await state.partBytes(relationship.partName)
				} catch (error) {
					if (error instanceof RefRefused) continue

					throw error
				}

				if (bytes === null) continue

				const text = decodeUtf8(bytes)
				const root = /<(?:\w+:)?table\b[^>]*>/.exec(text)?.[0] ?? ""
				const name = /\sdisplayName="([^"]*)"/.exec(root)?.[1] ?? /\sname="([^"]*)"/.exec(root)?.[1]
				const ref = /\sref="([^"]*)"/.exec(root)?.[1]
				const range = ref === undefined ? null : parseRange(ref)
				const headerRows = Number(/\sheaderRowCount="(\d+)"/.exec(root)?.[1] ?? "1")

				if (name !== undefined && range !== null) tables.push({ name: name.toUpperCase(), sheet: entry.id, range, headerRows })
			}
		}

		this.tables = tables
	}

	// A sheet's tables as edits left them.
	async sheetTables(sheet: SheetId): Promise<readonly XlsxTableRange[]> {
		await this.loadTables()

		return (this.tables ?? []).filter(table => table.sheet === sheet)
	}

	// The areas a formula reads, through the defined names and tables it names; null when that is not known (OFFSET,
	// INDIRECT, a table not found).
	private readAreas(model: XlsxSheetModel, text: string, row: number, col: number, seen: Set<string>): ReadArea[] | null {
		const inputs = formulaInputs(text)

		if (inputs.dynamic) return null

		const areas: ReadArea[] = []
		const sheets = this.workbook.sheets

		for (const ref of inputs.refs) {
			const first =
				ref.sheet === null
					? sheets.findIndex(entry => entry.id === model.id)
					: sheets.findIndex(entry => sameSheet(entry.name, ref.sheet ?? ""))
			const last = ref.lastSheet === null ? first : sheets.findIndex(entry => sameSheet(entry.name, ref.lastSheet ?? ""))

			if (first < 0 || last < 0) continue

			const area = ref.area
			const box = {
				startRow: area.kind === "cols" ? 0 : Math.min(area.startRow, area.endRow),
				endRow: area.kind === "cols" ? SHEET_MAX_ROWS - 1 : Math.max(area.startRow, area.endRow),
				startCol: area.kind === "rows" ? 0 : Math.min(area.startCol, area.endCol),
				endCol: area.kind === "rows" ? SHEET_MAX_COLS - 1 : Math.max(area.startCol, area.endCol)
			}

			for (let index = Math.min(first, last); index <= Math.max(first, last); index++) {
				const sheet = sheets[index]

				if (sheet !== undefined) areas.push({ sheet: sheet.id, ...box })
			}
		}

		for (const table of inputs.tables) {
			const found =
				table === ""
					? this.tables?.find(
							candidate =>
								candidate.sheet === model.id &&
								row >= candidate.range.startRow &&
								row <= candidate.range.endRow &&
								col >= candidate.range.startCol &&
								col <= candidate.range.endCol
						)
					: this.tables?.find(candidate => candidate.name === table)

			if (found === undefined) return null

			areas.push({ sheet: found.sheet, ...found.range })
		}

		for (const name of new Set(inputs.names)) {
			const defined = this.workbook.definedNames.filter(entry => entry.name.toUpperCase() === name)

			if (defined.length === 0 || seen.has(name)) continue

			seen.add(name)

			for (const entry of defined) {
				const scope = entry.sheet === null ? model : (this.model(entry.sheet) ?? model)
				const more = this.readAreas(scope, entry.formula, row, col, seen)

				if (more === null) return null

				appendAll(areas, more)
			}
		}

		return areas
	}

	// Whether a formula cell already holds this result (or shows it, when it stores none).
	private holdsResult(sheet: SheetId, result: RecalculatedCell): boolean {
		const model = this.model(sheet)

		if (model === null) return false

		const store = model.store as SheetStore
		const slot = store.locate(result.row, result.col)

		if (slot < 0 || store.formula(slot) < 0) return false

		const value = store.value(slot)

		switch (store.kind(slot)) {
			case CellKind.NUMBER:
				return result.error !== true && result.value === value
			case CellKind.BOOLEAN:
				return result.error !== true && result.value === (value !== 0)
			case CellKind.ERROR:
				return result.error === true && result.value === model.store.strings.text(value)
			case CellKind.FORMULA_STRING:
			case CellKind.SHARED_STRING:
			case CellKind.INLINE_STRING:
				return (
					result.error !== true &&
					typeof result.value === "string" &&
					result.value === this.stringOf(model, store.kind(slot), value)
				)
			case CellKind.EMPTY: {
				const shown = this.shownResults.get(sheet)?.get(cellKeyOf(result.row, result.col))

				return (
					shown !== undefined && shown.edited !== true && shown.value === result.value && shown.error === (result.error === true)
				)
			}
			default:
				return false
		}
	}

	// The alone-held results the edit made stale: those reading a cell it wrote or the engine recalculated.
	private staleAlone(
		sheet: SheetId,
		cells: readonly { row: number; col: number }[],
		results: readonly RecalculatedCell[]
	): RecalculatedCell[] {
		if (this.alone.size === 0 || this.engine === null) return []

		const changed: ReadArea[] = cells.map(cell => ({
			sheet,
			startRow: cell.row,
			endRow: cell.row,
			startCol: cell.col,
			endCol: cell.col
		}))

		// What the engine reports that the cell already holds is no change (a volatile call gives a new error each time).
		for (const result of results) {
			const at = this.engineSheets[result.sheet]

			if (at !== undefined && result.stale !== true && !this.holdsResult(at, result))
				changed.push({ sheet: at, startRow: result.row, endRow: result.row, startCol: result.col, endCol: result.col })
		}

		// Each sheet's changes as one box first: most held results read none of it.
		const boxes = new Map<SheetId, ReadArea>()

		for (const area of changed) {
			const box = boxes.get(area.sheet)

			boxes.set(
				area.sheet,
				box === undefined
					? { ...area }
					: {
							sheet: area.sheet,
							startRow: Math.min(box.startRow, area.startRow),
							endRow: Math.max(box.endRow, area.endRow),
							startCol: Math.min(box.startCol, area.startCol),
							endCol: Math.max(box.endCol, area.endCol)
						}
			)
		}

		const stale: RecalculatedCell[] = []

		for (const [held, keys] of this.alone) {
			const model = this.model(held)
			const index = this.engineIndex(held)

			if (model === null || index < 0) continue

			let inputs = this.aloneInputs.get(held)

			if (inputs === undefined) {
				inputs = new Map()
				this.aloneInputs.set(held, inputs)
			}

			for (const key of keys) {
				const row = Math.floor(key / 16_384)
				const col = key % 16_384
				let areas = inputs.get(key)

				if (areas === undefined) {
					const store = model.store as SheetStore
					const formula = store.formula(store.locate(row, col))

					areas = formula < 0 ? [] : this.readAreas(model, this.formulaText(model, formula, row, col), row, col, new Set())
					inputs.set(key, areas)
				}

				const reads =
					areas === null ||
					areas.some(area => {
						const box = boxes.get(area.sheet)

						return (
							box !== undefined &&
							overlaps(area, box) &&
							changed.some(cell => cell.sheet === area.sheet && overlaps(area, cell))
						)
					})

				if (reads) stale.push({ sheet: index, row, col, ...this.engine.result(index, row, col), stale: true })
			}
		}

		return stale
	}

	// A cell as the engine takes it: text stays text whatever it looks like, dates are serials, and a formula
	// carries its stored result to fall back on. A formula the engine does not calculate as Excel does (an array
	// formula or data table, one calling a function the engine lacks, syntax it cannot read) holds that result
	// there instead, reported stale once what it reads changes; with none stored, it shows #NAME?.
	engineCell(model: XlsxSheetModel, row: number, col: number): EngineCell {
		const store = model.store as SheetStore
		const slot = store.locate(row, col)

		if (slot < 0) return { row, col, content: null }

		const kind = store.kind(slot)
		const value = store.value(slot)
		const formula = store.formula(slot)

		if (formula < 0) return { row, col, content: this.storedResult(model, kind, value) ?? null }

		const stored = this.storedResult(model, kind, value, this.shownResults.get(model.id)?.get(cellKeyOf(row, col)))
		const formulaKind = store.formulas.kind(formula)

		// A dynamic array spills over what it calculates (or keeps its stored result where the engine cannot calculate it).
		if (formulaKind === FormulaKind.ARRAY) {
			const array = store.formulas.formula(formula)
			const ref = array.ref

			if (ref !== null && ref.startRow === row && ref.startCol === col && this.isDynamicArray(array.cellMetadata)) {
				const spill = { rows: ref.endRow - ref.startRow + 1, cols: ref.endCol - ref.startCol + 1 }
				const text = this.formulaText(model, formula, row, col)
				const content = holdsBracket(text) ? null : engineSpillFormula(text, this.nameAliases, this.lambdaNames)

				if (content === null || engineLacks(text, this.unknownNames.size === 0 ? undefined : this.unknownName, this.lambdaNames))
					return this.held(model, row, col, stored ?? NAME_ERROR, spill)

				return stored === undefined ? { row, col, content, spill } : { row, col, content, fallback: stored, spill }
			}
		}

		// A data table, or a legacy array formula over a block, keeps its stored result: its text is not read.
		if (
			stored !== undefined &&
			(formulaKind === FormulaKind.DATA_TABLE ||
				(formulaKind === FormulaKind.ARRAY && this.legacyBlock(store.formulas.formula(formula))))
		)
			return this.held(model, row, col, stored)

		const text = this.formulaText(model, formula, row, col)
		// A legacy array formula is evaluated as an array, its cell taking the first value (Excel's for one cell).
		const array = formulaKind === FormulaKind.ARRAY
		// A structured or external reference is known not to parse there: not given to it, which spares a failed parse.
		const engineText = holdsBracket(text)
			? null
			: array
				? engineArrayFormula(text, this.nameAliases, this.lambdaNames)
				: engineCellFormula(text, this.nameAliases, this.lambdaNames)
		const content = array && engineText !== null ? `=INDEX(${engineText.slice(1)},1,1)` : engineText

		const lacks = engineLacks(text, this.unknownNames.size === 0 ? undefined : this.unknownName, this.lambdaNames)

		if (content === null) {
			const shown = stored ?? (lacks ? NAME_ERROR : undefined)

			return shown === undefined ? { row, col, content: UNPARSEABLE } : this.held(model, row, col, shown)
		}

		if (lacks) return this.held(model, row, col, stored ?? NAME_ERROR)

		// An array constant gives an array too ({1,2}, IF(A1,{1,2},0)): its first value, as Excel reads an ordinary
		// formula.
		const read = !array && holdsArrayConstant(text) ? `=INDEX((${content.slice(1)}),1,1)` : content

		return stored === undefined ? { row, col, content: read } : { row, col, content: read, fallback: stored }
	}

	// Defined names the engine lacks, upper case: what reads them is not calculated here.
	private unknownNames = new Set<string>()
	private readonly unknownName = (name: string): boolean => this.unknownNames.has(name)
	// Defined names holding a LAMBDA, upper case: a formula calls one as a function.
	private lambdaNames: ReadonlySet<string> = new Set()
	// Defined names the engine reads under an alias or as the reference they stand for, upper case.
	private nameAliases: ReadonlyMap<string, string> = new Map()

	// The defined names as the engine takes them: under an alias when it cannot take the name, left out when it
	// cannot take what the name refers to (syntax it has no reading for, a function it lacks, a name it lacks in
	// turn), those recorded in unknownNames.
	private engineNames(entries: readonly XlsxSheetEntry[]): EngineName[] {
		const named: { named: XlsxDefinedName; scope: number | undefined }[] = []

		for (const entry of this.workbook.definedNames) {
			const scope = entry.sheet === null ? undefined : entries.findIndex(sheet => sheet.id === entry.sheet)

			if (scope === undefined || scope >= 0) named.push({ named: entry, scope })
		}

		const taken = new Set(this.workbook.definedNames.map(entry => entry.name.toUpperCase()))
		const aliases = new Map<string, string>()

		for (const index of FormulaEngine.unnamable(named.map(entry => entry.named.name))) {
			const upper = named[index]?.named.name.toUpperCase() ?? ""

			if (aliases.has(upper)) continue

			let alias = `FILEN.NAME.${String(aliases.size + 1)}`

			while (taken.has(alias)) alias += "_"

			aliases.set(upper, alias)
		}

		// A name defined once as one absolute cell is spelled as that cell: the engine would read the name as a value
		// (an empty cell as 0, which ISBLANK takes for a number). Ranges stay names (one range for every use).
		const definitions = new Map<string, number>()

		for (const { named: entry } of named)
			definitions.set(entry.name.toUpperCase(), (definitions.get(entry.name.toUpperCase()) ?? 0) + 1)

		const spelled = new Map(aliases)

		for (const { named: entry } of named) {
			const upper = entry.name.toUpperCase()
			const reference = definitions.get(upper) === 1 ? absoluteCell(entry.formula) : null

			if (reference !== null) spelled.set(upper, reference)
		}

		// The names holding a LAMBDA, which formulas call as functions (MyFn(2)).
		const lambdas = new Set(
			named.filter(({ named: entry }) => LAMBDA_NAME.test(entry.formula)).map(({ named: entry }) => entry.name.toUpperCase())
		)

		this.lambdaNames = lambdas

		const candidates = named.map(({ named: entry, scope }) => {
			const name = {
				name: aliases.get(entry.name.toUpperCase()) ?? entry.name,
				expression: engineFormula(entry.formula, spelled, lambdas)
			}

			return { named: entry, name: scope === undefined ? name : { ...name, scope } }
		})
		const refused = FormulaEngine.refusedNames(
			entries.map(entry => entry.name),
			candidates.map(candidate => candidate.name)
		)
		const unknown = new Set<string>()

		candidates.forEach((candidate, index) => {
			if (refused.has(index) || hugeArea(candidate.named.formula)) unknown.add(candidate.named.name.toUpperCase())
		})

		// A name reading one the engine lacks is lacking too: until none is added.
		for (let added = true; added;) {
			added = false

			for (const { named: entry } of candidates) {
				const upper = entry.name.toUpperCase()

				if (!unknown.has(upper) && engineLacks(entry.formula, name => unknown.has(name), lambdas)) {
					unknown.add(upper)
					added = true
				}
			}
		}

		this.unknownNames = unknown
		this.nameAliases = spelled

		return candidates.filter(candidate => !unknown.has(candidate.named.name.toUpperCase())).map(candidate => candidate.name)
	}

	// Builds the engine from every worksheet as it stands (all of them must be ready). Formulas the file keeps no
	// result for are calculated and shown (not stored: the file is not changed by opening it).
	buildEngine(changes?: SheetChangeSink): FormulaEngine {
		if (this.engine !== null) return this.engine

		const entries = this.worksheets().filter(entry => entry.model !== null)
		// First: which names the formulas may read decides which formulas hold their results.
		const names = this.engineNames(entries)
		const missing: { sheet: number; row: number; col: number }[] = []
		// Formulas whose stored results are calculated again on open (Excel's full calculation under fullCalcOnLoad,
		// its recalculation of volatile formulas), and what reads them: shown over what the file stores.
		const fullCalc = this.workbook.calc.fullCalcOnLoad
		const xlsx = this.workbook.format !== "ods"
		const again: { sheet: number; row: number; col: number }[] = []
		const sheets: EngineSheet[] = entries.map((entry, index) => {
			const model = entry.model as XlsxSheetModel
			const store = model.store as SheetStore
			const rows: EngineSheet["rows"] = []
			const formulas: EngineCell[] = []
			// Whether a shared formula is volatile, by shared index: its cells call what its master calls.
			const shared = new Map<number, boolean>()

			for (const block of store.blocks) {
				for (let i = 0; i < block.rowCount; i++) {
					const row = block.firstRow + (block.rows[i] ?? 0)
					const start = block.rowStarts[i] ?? 0
					const end = block.rowStarts[i + 1] ?? 0

					if (end <= start) continue

					const values = new Array<EngineSheet["rows"][number][number]>((block.cols[end - 1] ?? 0) + 1).fill(null)

					for (let k = start; k < end; k++) {
						const col = block.cols[k] ?? 0
						const cell = this.engineCell(model, row, col)

						values[col] = cell.content

						const formula = block.formulas?.[k] ?? -1

						if (formula >= 0) {
							if (cell.fallback !== undefined || cell.content instanceof HeldResult || cell.spill !== undefined)
								formulas.push(cell)
							if (block.kinds[k] === CellKind.EMPTY) missing.push({ sheet: index, row, col })
							else if (
								!(cell.content instanceof HeldResult) &&
								cell.spill === undefined &&
								(fullCalc ||
									model.recalculate?.has(cellKeyOf(row, col)) === true ||
									(xlsx && this.volatileAt(store.formulas, formula, row, col, shared)))
							)
								again.push({ sheet: index, row, col })
						}
					}

					while (rows.length < row) rows.push([])

					rows[row] = values
				}
			}

			return { name: entry.name, rows, formulas }
		})
		const sheetAt = (index: number): SheetId | undefined =>
			this.engineSheets.length > 0 ? this.engineSheets[index] : entries[index]?.id
		const engine = new FormulaEngine(
			sheets,
			names,
			this.dateBase,
			(index, row, col) => {
				const sheet = sheetAt(index)

				if (sheet !== undefined) this.markAlone(sheet, row, col)
			},
			(index, row) => this.rowState(sheetAt(index), row),
			this.ownSettings.locale,
			(index, range) => this.spillBlocked(sheetAt(index), range),
			(index, row, col) => this.formulaInput(sheetAt(index), row, col),
			this.workbook.format === "ods"
		)

		this.engine = engine
		this.engineSheets = entries.map(entry => entry.id)

		for (const cell of missing) {
			const result = engine.result(cell.sheet, cell.row, cell.col)
			const sheet = this.engineSheets[cell.sheet] ?? 0

			this.setShown(
				sheet,
				cell.row,
				cell.col,
				result.value === CYCLE ? { value: 0, error: false } : { value: result.value, error: result.error === true }
			)
			changes?.content(sheet, { startRow: cell.row, startCol: cell.col, endRow: cell.row, endCol: cell.col })
		}

		if (again.length > 0) {
			for (const cell of again) this.showAgain(engine, cell.sheet, cell.row, cell.col, changes)

			// Under fullCalcOnLoad every formula is in already.
			if (!fullCalc)
				for (const cell of engine.dependents(again)) this.showAgain(engine, cell.sheet, cell.row, cell.col, changes, true)
		}

		return engine
	}

	// Whether a formula calls a volatile function, a shared one's answer kept by shared index.
	private volatileAt(formulas: XlsxFormulaTable, id: number, row: number, col: number, shared: Map<number, boolean>): boolean {
		const kind = formulas.kind(id)

		if (kind !== FormulaKind.SHARED_MASTER && kind !== FormulaKind.SHARED_CHILD) return volatileFormula(formulas.text(id))

		const index = formulas.sharedIndex(id)
		let known = shared.get(index)

		if (known === undefined) {
			known = volatileFormula(kind === FormulaKind.SHARED_MASTER ? formulas.text(id) : formulas.expanded(id, row, col))
			shared.set(index, known)
		}

		return known
	}

	// A formula cell (engine sheet index) whose stored result is calculated again on open: the engine's result shown
	// in its place where it differs (not a circle or a result the engine cannot give, which keep the file's).
	// `reading`: a cell reading one, which may be no formula the engine calculates.
	private showAgain(
		engine: FormulaEngine,
		index: number,
		row: number,
		col: number,
		changes: SheetChangeSink | undefined,
		reading = false
	): void {
		const sheet = this.engineSheets[index]
		const model = sheet === undefined ? null : this.model(sheet)

		if (sheet === undefined || model === null) return

		if (reading) {
			const store = model.store as SheetStore
			const slot = store.locate(row, col)
			const formula = slot < 0 ? -1 : store.formula(slot)

			if (formula < 0 || store.kind(slot) === CellKind.EMPTY || this.alone.get(sheet)?.has(cellKeyOf(row, col)) === true) return

			// A dynamic array's values spill beside it (calculated with the first edit), a data table's are held.
			const kind = store.formulas.kind(formula)

			if (
				kind === FormulaKind.DATA_TABLE ||
				(kind === FormulaKind.ARRAY && this.isDynamicArray(store.formulas.formula(formula).cellMetadata))
			)
				return
		}

		const result = { sheet: index, row, col, ...engine.result(index, row, col) }
		const shows = result.value !== CYCLE && !FormulaEngine.unsupported(result.value) && !this.holdsResult(sheet, result)
		const results = this.shownResults.get(sheet)
		const key = cellKeyOf(row, col)

		if (shows) this.setShown(sheet, row, col, { value: result.value, error: result.error === true, recalculated: true })
		else if (results?.get(key)?.recalculated === true) results.delete(key)
		else return

		changes?.content(sheet, { startRow: row, startCol: col, endRow: row, endCol: col })
	}

	private setShown(sheet: SheetId, row: number, col: number, result: ShownResult): void {
		let map = this.shownResults.get(sheet)

		if (map === undefined) {
			map = new Map()
			this.shownResults.set(sheet, map)
		}

		map.set(cellKeyOf(row, col), result)
	}

	dropEngine(): void {
		this.engine?.destroy()
		this.engine = null
		this.engineSheets = []
	}

	// Whether a hidden row is hidden by a filter (in the body of a filter that filters something): set by the filter
	// feature. Without it every hidden row reads as hidden by hand.
	filteredRow: ((sheet: SheetId, row: number) => boolean) | null = null

	// A row as SUBTOTAL and AGGREGATE read it: 0 shown, 1 hidden by hand, 2 hidden by a filter.
	// A cell's formula as the formula bar shows it (Shown.input), or null for a cell without one: what FORMULATEXT gives.
	private formulaInput(sheet: SheetId | undefined, row: number, col: number): string | null {
		const model = sheet === undefined ? null : this.model(sheet)

		if (model === null) return null

		const store = model.store as SheetStore
		const slot = store.locate(row, col)
		const formula = slot < 0 ? -1 : store.formula(slot)

		return formula < 0 ? null : localizedInput(`=${this.shownFormulaText(model, formula, row, col)}`, this.ownSettings.locale)
	}

	private rowState(sheet: SheetId | undefined, row: number): number {
		const model = sheet === undefined ? null : this.model(sheet)

		if (sheet === undefined || model === null) return 0

		const store = model.store as SheetStore
		const block = store.blocks[store.blockOf(row)]
		const index = block?.rowIndex(row) ?? -1
		const flags = block !== undefined && index >= 0 ? (block.rowFlags[index] ?? 0) : (rowRunAt(model.rowRuns, row)?.flags ?? 0)

		if ((flags & RowFlag.HIDDEN) === 0) return 0

		return this.filteredRow?.(sheet, row) === true ? 2 : 1
	}

	// Before an edit that hides or shows rows: the engine built from the cells as they stand (all sheets ready, a
	// workbook with formulas), so the edit is what it recalculates.
	async engineBeforeRows(changes: SheetChangeSink): Promise<void> {
		if (this.engine !== null || !this.allReady || !this.hasFormulas) return

		await this.loadTables()

		if (!this.closed && this.engine === null) this.buildEngine(changes)
	}

	// Rows were hidden or shown: SUBTOTAL and AGGREGATE calculated again, their results stored as recalculate stores
	// them (logged first).
	rowsChanged(log: CellLog | null, changes: SheetChangeSink): void {
		const engine = this.engine

		if (engine !== null)
			this.apply(
				this.guarded(() => engine.rowsChanged()),
				log,
				changes
			)
	}

	// The cells holding INDIRECT, by sheet, as the engine last calculated them (none without one).
	indirectCells(): Map<SheetId, { row: number; col: number }[]> {
		const bySheet = new Map<SheetId, { row: number; col: number }[]>()

		for (const cell of this.engine?.indirectCells() ?? []) {
			const sheet = this.engineSheets[cell.sheet]

			if (sheet === undefined) continue

			const list = bySheet.get(sheet)

			if (list === undefined) bySheet.set(sheet, [{ row: cell.row, col: cell.col }])
			else list.push({ row: cell.row, col: cell.col })
		}

		return bySheet
	}

	// Cells of a sheet merged or unmerged: its dynamic arrays calculated again (a merged cell is in the way of one),
	// their results stored (logged).
	spillsChanged(sheet: SheetId, log: CellLog | null, changes: SheetChangeSink): void {
		const engine = this.engine
		const index = this.engineIndex(sheet)

		if (engine !== null && index >= 0)
			this.apply(
				this.guarded(() => engine.spillsChanged(index)),
				log,
				changes
			)
	}

	// The rows of an edit hidden or shown again by its undo or redo: the engine calculates SUBTOTAL and AGGREGATE again
	// (giving what it gave then), and the results the edit stored come back from its log. An edit made with no engine
	// logged none: what the engine now gives is stored.
	rowsRestored(log: CellLog, which: "before" | "after", changes: SheetChangeSink): void {
		const engine = this.engine
		const results = engine === null ? [] : this.guarded(() => engine.rowsChanged())

		if (log.size === 0) {
			this.apply(results, null, changes)

			return
		}

		this.restoreLog(log, which)

		for (let i = 0; i < log.size; i++) {
			const row = log.rows[i] ?? 0
			const col = log.cols[i] ?? 0

			changes.content(log.sheets[i] ?? 0, { startRow: row, startCol: col, endRow: row, endCol: col })
		}
	}

	// Gives the engine the cells as they now stand, and stores what it recalculated in the formula cells it
	// names (logged first). Without an engine, nothing.
	recalculate(sheet: SheetId, cells: readonly { row: number; col: number }[], log: CellLog | null, changes: SheetChangeSink): void {
		const engine = this.engine
		const model = this.model(sheet)
		const index = this.engineIndex(sheet)

		if (engine === null || model === null || index < 0 || cells.length === 0) return

		const results = this.guarded(() =>
			engine.set(
				index,
				cells.map(cell => this.engineCell(model, cell.row, cell.col))
			)
		)

		this.applyRecalculated(sheet, cells, results, log, changes)
	}

	// Stores what the engine recalculated for `cells` of `sheet` (given to it apart from recalculate: in parts, its
	// evaluation held between them), as recalculate does.
	applyRecalculated(
		sheet: SheetId,
		cells: readonly { row: number; col: number }[],
		results: readonly RecalculatedCell[],
		log: CellLog | null,
		changes: SheetChangeSink
	): void {
		this.apply([...results, ...this.staleAlone(sheet, cells, results)], log, changes)
	}

	// apply in parts of WRITE_SLICE results, yielding between them once the clock's slice is up.
	async applySliced(
		results: readonly RecalculatedCell[],
		log: CellLog | null,
		changes: SheetChangeSink,
		clock: SliceClock | undefined
	): Promise<void> {
		if (clock === undefined || results.length <= WRITE_SLICE) {
			this.apply(results, log, changes)

			return
		}

		for (let start = 0; start < results.length; start += WRITE_SLICE) {
			this.apply(results.slice(start, start + WRITE_SLICE), log, changes)

			if (clock.due) await clock.pause()
		}
	}

	// applyRecalculated in parts of WRITE_SLICE results, yielding between them once the clock's slice is up (a large
	// spill). Each result names its own cell, so the parts may go in any order.
	async applyRecalculatedSliced(
		sheet: SheetId,
		cells: readonly { row: number; col: number }[],
		results: readonly RecalculatedCell[],
		log: CellLog | null,
		changes: SheetChangeSink,
		clock: SliceClock | undefined
	): Promise<void> {
		const all = [...results, ...this.staleAlone(sheet, cells, results)]

		if (clock === undefined || all.length <= WRITE_SLICE) {
			this.apply(all, log, changes)

			return
		}

		for (let start = 0; start < all.length; start += WRITE_SLICE) {
			this.apply(all.slice(start, start + WRITE_SLICE), log, changes)

			if (clock.due) await clock.pause()
		}
	}

	// guarded for engine work in parts (a sliced structure edit).
	async guardedSliced(work: () => Promise<RecalculatedCell[]>): Promise<RecalculatedCell[]> {
		try {
			return await work()
		} catch {
			this.dropEngine()

			return []
		}
	}

	// Runs engine work; should the engine fail part-way it is dropped (built again from the cells when next needed).
	guarded(work: () => RecalculatedCell[]): RecalculatedCell[] {
		try {
			return work()
		} catch {
			this.dropEngine()

			return []
		}
	}

	// Stores recalculated results in their formula cells. A result the engine failed on itself keeps the file's
	// stored one; with none stored, it is shown, the cell keeps no result and Excel is asked to recalculate.
	apply(results: readonly RecalculatedCell[], log: CellLog | null, changes: SheetChangeSink): void {
		// The values dynamic arrays spill, by sheet: written together (writeCells), as one write per cell rebuilds its
		// row block each time.
		const spilled = new Map<SheetId, { row: number; col: number; state: CellState }[]>()

		for (const result of results) {
			const sheet = this.engineSheets[result.sheet]
			const model = sheet === undefined ? null : this.model(sheet)

			if (sheet === undefined || model === null) continue

			const store = model.store as SheetStore

			if (result.spilled === true) {
				let writes = spilled.get(sheet)

				if (writes === undefined) spilled.set(sheet, (writes = []))

				this.spilledWrite(sheet, model, result, log, changes, writes)

				continue
			}

			const slot = store.locate(result.row, result.col)

			if (slot < 0 || store.formula(slot) < 0) continue

			// A dynamic array's cell: its range follows what it spills over, and its #SPILL! is its result.
			const spilling = result.spill !== undefined && this.spillsAt(store, slot, result.row, result.col)

			if (spilling && result.spill !== undefined) this.resizeSpill(sheet, store, slot, result.row, result.col, result.spill, log)

			// A held result is no longer what its formula gives, or an edit closed a circle through a cell holding a
			// result: kept, as reading the saved file here shows it, and Excel recalculates on load (logged, so an undo
			// takes that back).
			if (result.stale === true || (result.value === CYCLE && store.kind(slot) !== CellKind.EMPTY)) {
				const state = this.state(sheet, result.row, result.col)

				if (state.shown?.edited === true) continue

				log?.touch(sheet, result.row, result.col, () => state, false)
				this.write(sheet, result.row, result.col, {
					...state,
					shown: { value: state.shown?.value ?? null, error: state.shown?.error ?? false, edited: true }
				})

				continue
			}

			// What the cell already holds needs no writing (the engine reports a volatile call's dependents each time).
			if (this.holdsResult(sheet, result)) continue

			const kind = store.kind(slot)
			const unsupported =
				FormulaEngine.unsupported(result.value) && !(spilling && result.value === "#SPILL!") && !this.shownFailure(result)

			if (unsupported && result.value !== CYCLE && kind !== CellKind.EMPTY) continue

			log?.touch(sheet, result.row, result.col, () => this.state(sheet, result.row, result.col), false)

			const style = store.style(store.locate(result.row, result.col))
			const formula = store.formula(store.locate(result.row, result.col))
			const value = result.value === CYCLE ? 0 : result.value
			let next: CellState

			if (unsupported && result.value !== CYCLE) {
				next = {
					present: true,
					kind: CellKind.EMPTY,
					value: 0,
					style,
					formula,
					shown: { value, error: result.error === true, edited: true }
				}
			} else if (typeof value === "number") {
				next = { present: true, kind: CellKind.NUMBER, value, style, formula, shown: undefined }
			} else if (typeof value === "boolean") {
				next = { present: true, kind: CellKind.BOOLEAN, value: value ? 1 : 0, style, formula, shown: undefined }
			} else if (typeof value === "string") {
				next =
					result.error === true
						? {
								present: true,
								kind: CellKind.ERROR,
								value: model.store.strings.intern(value),
								style,
								formula,
								shown: undefined
							}
						: {
								present: true,
								kind: CellKind.FORMULA_STRING,
								value: model.store.strings.intern(encodeXstring(value)),
								style,
								formula,
								shown: undefined
							}
			} else {
				next = { present: true, kind: CellKind.EMPTY, value: 0, style, formula, shown: undefined }
			}

			this.write(sheet, result.row, result.col, next)
			changes.content(sheet, { startRow: result.row, startCol: result.col, endRow: result.row, endCol: result.col })
		}

		for (const [sheet, writes] of spilled) this.writeCells(sheet, writes)
	}

	// A #NAME? that comes from another cell's formula which shows it (holding no result of the file's in its place),
	// over a name the workbook does not define or a function Excel does not have: that formula's own error, which a
	// formula reading it gives too, as Excel does; not the engine failing (a name kept from it, a function it lacks).
	private shownFailure(result: RecalculatedCell): boolean {
		if (result.value !== "#NAME?" || result.root === undefined) return false

		const sheet = this.engineSheets[result.root.sheet]
		const model = sheet === undefined ? null : this.model(sheet)

		if (model === null) return false

		const store = model.store as SheetStore
		const slot = store.locate(result.root.row, result.root.col)
		const formula = slot < 0 ? -1 : store.formula(slot)

		if (formula < 0 || store.kind(slot) !== CellKind.EMPTY) return false

		// What Excel would not know either: the name the engine reports, else a function the formula calls.
		const unknown = result.unknown

		if (unknown !== undefined) return unknown.kind === "function" ? !this.excelCalls(unknown.name) : !this.definesName(unknown.name)

		return calledFunctions(store.formulas.formula(formula).text).some(name => !this.excelCalls(name))
	}

	// A function Excel calculates: one of its worksheet functions, an add-in's or macro's (_xludf.), or a LAMBDA the
	// workbook names.
	private excelCalls(name: string): boolean {
		return sheetFunction(name) !== undefined || /^_xludf\./iu.test(name) || this.definesName(name)
	}

	private definesName(name: string): boolean {
		const wanted = name.toUpperCase()

		return this.workbook.definedNames.some(defined => defined.name.toUpperCase() === wanted)
	}

	// Whether the cell's formula is a dynamic array of its own cell.
	private spillsAt(store: SheetStore, slot: number, row: number, col: number): boolean {
		const id = store.formula(slot)

		if (id < 0 || store.formulas.kind(id) !== FormulaKind.ARRAY) return false

		const formula = store.formulas.formula(id)

		return (
			formula.ref !== null &&
			formula.ref.startRow === row &&
			formula.ref.startCol === col &&
			this.isDynamicArray(formula.cellMetadata)
		)
	}

	// A dynamic array's range made what it spills over now (logged): the formula written again with that ref.
	private resizeSpill(
		sheet: SheetId,
		store: SheetStore,
		slot: number,
		row: number,
		col: number,
		size: SpillSize,
		log: CellLog | null
	): void {
		const formula = store.formulas.formula(store.formula(slot))
		const ref = formula.ref

		if (ref !== null && ref.endRow - ref.startRow + 1 === size.rows && ref.endCol - ref.startCol + 1 === size.cols) return

		const state = this.state(sheet, row, col)
		const resized = store.formulas.add({
			...formula,
			ref: { startRow: row, startCol: col, endRow: row + size.rows - 1, endCol: col + size.cols - 1 }
		})

		log?.touch(sheet, row, col, () => state, false)
		this.write(sheet, row, col, { ...state, formula: resized })
	}

	// A value a dynamic array spills into a cell of its own (or, null, takes back from it): a value, the cell's format
	// kept (logged), added to `writes`.
	private spilledWrite(
		sheet: SheetId,
		model: XlsxSheetModel,
		result: RecalculatedCell,
		log: CellLog | null,
		changes: SheetChangeSink,
		writes: { row: number; col: number; state: CellState }[]
	): void {
		const { row, col, value } = result
		const state = this.state(sheet, row, col)

		// A formula of the user's own is never written over (the engine reports none).
		if (state.present && state.formula >= 0) return

		const style = state.present ? state.style : 0
		let next: CellState

		if (value === null)
			next = style === 0 ? ABSENT : { present: true, kind: CellKind.EMPTY, value: 0, style, formula: -1, shown: undefined }
		else if (typeof value === "number") next = { present: true, kind: CellKind.NUMBER, value, style, formula: -1, shown: undefined }
		else if (typeof value === "boolean")
			next = { present: true, kind: CellKind.BOOLEAN, value: value ? 1 : 0, style, formula: -1, shown: undefined }
		else if (result.error === true)
			next = { present: true, kind: CellKind.ERROR, value: model.store.strings.intern(value), style, formula: -1, shown: undefined }
		else {
			const strings = this.workbook.sharedStrings
			const encoded = encodeXstring(value)
			const found = strings.find(encoded)
			const index = found >= 0 ? found : strings.append(encoded)

			if (found < 0) this.workbook.changes.sharedStringsAppended()

			next = { present: true, kind: CellKind.SHARED_STRING, value: index, style, formula: -1, shown: undefined }
		}

		log?.touch(sheet, row, col, () => state, false)
		writes.push({ row, col, state: next })
		changes.content(sheet, { startRow: row, startCol: col, endRow: row, endCol: col })
	}

	// --- Saving ---

	private hasEditedShown(): boolean {
		for (const results of this.shownResults.values()) for (const result of results.values()) if (result.edited === true) return true

		return false
	}

	async save(options: {
		readonly slicing?: Slicing
		readonly signal?: SheetAbortSignal
		readonly untouched?: boolean
	}): Promise<Exclude<SheetSaveResult, { ok: true }> | { ok: true; bytes: Uint8Array; changedParts: readonly string[] }> {
		if (this.closed) return { ok: false, reason: "closed", message: "The session is closed" }

		if (this.workbook.format === "ods") {
			const writer = this.writer

			if (writer === undefined) return { ok: false, reason: "gate", message: "An OpenDocument spreadsheet is not saved here" }

			const signal = options.signal
			// A close meanwhile ends the save at its next slice, as an abort does.
			const stop = { aborted: () => this.closed || signal?.aborted === true }
			const saved = await writer.save(this, {
				untouched: options.untouched === true,
				...(options.slicing !== undefined && { slicing: options.slicing }),
				signal: {
					get aborted(): boolean {
						return stop.aborted()
					}
				}
			})

			if (this.closed) return { ok: false, reason: "closed", message: "The session is closed" }
			if (options.signal?.aborted === true) return { ok: false, reason: "aborted", message: "The save was aborted" }

			return saved.ok
				? { ok: true, bytes: saved.bytes, changedParts: saved.changedParts }
				: { ok: false, reason: "gate", message: saved.message }
		}

		const encryption = this.encryption

		// Read before anything is awaited: a close meanwhile releases the key, which fails the seal rather than
		// handing out the zip.
		if (encryption?.sealer.released === true) return { ok: false, reason: "seal", message: "The workbook's key was released" }

		// Unedited: the sealed file as read (a copy, the source kept), not a fresh seal under a new salt.
		const sealed = encryption?.sealed

		if (options.untouched === true && sealed !== undefined) {
			const bytes = (await sealed.read(0, sealed.size)).slice()

			if (this.closed) return { ok: false, reason: "closed", message: "The session is closed" }

			return { ok: true, bytes, changedParts: [] }
		}

		// Asked for while an edited formula's result is still one this session could not calculate (an undo takes it
		// back, so it is decided at each save).
		const changes = this.workbook.changes as ChangeLog

		changes.fullCalcOnLoad = this.hasEditedShown()

		const saved = await saveXlsx(
			{ opc: this.workbook.opc, workbook: this.workbook },
			options.slicing === undefined ? {} : { slicing: options.slicing }
		)

		if (!saved.ok) return { ok: false, reason: "gate", message: `${saved.reason}: ${saved.message}` }
		if (this.closed) return { ok: false, reason: "closed", message: "The session is closed" }
		if (options.signal?.aborted === true) return { ok: false, reason: "aborted", message: "The save was aborted" }

		const zip = saved.bytes

		if (zip === undefined) return { ok: false, reason: "gate", message: "The save wrote no bytes" }
		if (encryption === undefined) return { ok: true, bytes: zip, changedParts: saved.changedParts }

		try {
			const sealed = await encryption.sealer.seal(zip, {
				...(options.signal !== undefined && { signal: options.signal }),
				...(options.slicing !== undefined && { slicing: options.slicing })
			})

			if (!isSealedOfficeFile(sealed)) return { ok: false, reason: "seal", message: "The sealed save is not a compound file" }

			return { ok: true, bytes: sealed, changedParts: saved.changedParts }
		} catch (error) {
			return aborted(options.signal)
				? { ok: false, reason: "aborted", message: messageOf(error) }
				: { ok: false, reason: "seal", message: messageOf(error) }
		} finally {
			zip.fill(0)
		}
	}

	// The sheet as Excel's "CSV UTF-8" (at most MAX_CSV_BYTES): its data area, from A1 to the last row and column holding a value or a
	// formula, every row that wide, as LibreOffice's CSV export writes it, with a BOM. A cell holding only a format is
	// no data. Written row by row into one array of the output's exact size: memory is the output and the data cells,
	// never a row × column grid nor an array per field. A field holding a separator the next open weighs is quoted (writeCsv's stable).
	csv(sheet: SheetId): Uint8Array | SheetRefusal | null {
		const model = this.model(sheet)

		if (model === null) return null

		const store = model.store as SheetStore
		const rows: number[] = []
		const cols: number[] = []
		const fields: string[] = []
		let lastRow = -1
		let lastCol = -1
		let sorted = true
		let size = 0

		for (const block of store.blocks) {
			for (let i = 0; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)

				for (let k = block.rowStarts[i] ?? 0; k < (block.rowStarts[i + 1] ?? 0); k++) {
					if (block.kinds[k] === CellKind.EMPTY && (block.formulas?.[k] ?? -1) < 0) continue

					const col = block.cols[k] ?? 0

					lastRow = Math.max(lastRow, row)
					lastCol = Math.max(lastCol, col)

					const text = this.cellView(sheet, row, col).text

					if (text === "") continue

					const last = rows.length - 1

					if (last >= 0 && (row < (rows[last] ?? 0) || (row === rows[last] && col <= (cols[last] ?? 0)))) sorted = false

					const field = csvField(text, ",", true)

					rows.push(row)
					cols.push(col)
					fields.push(field)
					size += utf8Length(field)

					if (size > MAX_CSV_BYTES) return CSV_TOO_LARGE
				}
			}
		}

		// The size is exact before anything is allocated: past the cap, refused.
		const total = 3 + (lastRow + 1) * (lastCol + 2) + size

		if (total > MAX_CSV_BYTES) return CSV_TOO_LARGE

		const order = Array.from(fields, (_, index) => index)

		if (!sorted) order.sort((a, z) => (rows[a] ?? 0) - (rows[z] ?? 0) || (cols[a] ?? 0) - (cols[z] ?? 0))

		// Each row ends with a line end, the last too: lastCol commas and CRLF a row, and the fields.
		const bytes = new Uint8Array(total)
		const encoder = new TextEncoder()
		let at = 3
		let next = 0

		bytes.set([0xef, 0xbb, 0xbf], 0)

		for (let row = 0; row <= lastRow; row++) {
			let col = 0

			for (; next < order.length && rows[order[next] ?? 0] === row; next++) {
				const index = order[next] ?? 0
				const target = cols[index] ?? 0

				bytes.fill(0x2c, at, at + target - col)
				at += target - col
				col = target
				at += encoder.encodeInto(fields[index] ?? "", bytes.subarray(at)).written
			}

			bytes.fill(0x2c, at, at + lastCol - col)
			at += lastCol - col
			bytes[at++] = 0x0d
			bytes[at++] = 0x0a
		}

		return bytes
	}

	cellDetail(cell: SheetCell): { input: string; numFmt: string; style: number; flags: number } {
		const view = this.cellView(cell.sheet, cell.row, cell.col)

		return { input: view.input ?? view.text, numFmt: this.styles.numFmtCode(view.xf), style: view.style, flags: view.flags }
	}

	// Whether the format's writer can hold what an edit just did (an OpenDocument spreadsheet's).
	beginEdit(command: SheetCommand): void {
		this.writer?.begin?.(this, command)
	}

	editUndone(): void {
		this.writer?.refused?.(this)
	}

	checkEdit(touched: ReadonlyMap<SheetId, readonly SheetRange[]>, command: SheetCommand): SheetRefusal | null {
		return this.writer?.check?.(this, touched, command) ?? null
	}

	// What only edits and saving need goes: the engine.
	viewOnly(): void {
		this.dropEngine()
	}

	close(): void {
		this.closed = true
		this.dropEngine()
		this.encryption?.release()
	}
}

// A sheet's rectangle of cells.
interface ReadArea {
	readonly sheet: SheetId
	readonly startRow: number
	readonly endRow: number
	readonly startCol: number
	readonly endCol: number
}

function overlaps(a: ReadArea, b: ReadArea): boolean {
	return a.startRow <= b.endRow && b.startRow <= a.endRow && a.startCol <= b.endCol && b.startCol <= a.endCol
}

// An inclusive span of columns (rows) whose cells alone an edit of rows (columns) moves.
interface CellBand {
	readonly start: number
	readonly end: number
}

// A cell's key after rows or columns move, or -1 when they deleted it.
function shiftedKey(key: number, edit: AxisEdit & { readonly band?: CellBand }): number {
	const row = Math.floor(key / 16_384)
	const col = key % 16_384
	const index = edit.axis === "rows" ? row : col
	const cross = edit.axis === "rows" ? col : row

	if (index < edit.at || (edit.band !== undefined && (cross < edit.band.start || cross > edit.band.end))) return key
	if (edit.type === "delete" && index < edit.at + edit.count) return -1

	const next = edit.type === "insert" ? index + edit.count : index - edit.count

	return edit.axis === "rows" ? cellKeyOf(next, col) : cellKeyOf(row, next)
}

// Cells past which a name that is one area alone is not given to the engine, which reads a name's area whole when it
// builds (a print area of entire rows would take gigabytes): what reads such a name keeps its result.
const MAX_NAME_AREA = 4_000_000
const AREA = /^(?:(?:'(?:[^']|'')+'|[^'!:]+)!)?\$?([A-Z]{1,3})\$?(\d{1,7}):\$?([A-Z]{1,3})\$?(\d{1,7})$/

function hugeArea(formula: string): boolean {
	const match = AREA.exec(formula.trim())

	if (match === null) return false

	const column = (letters: string): number => {
		let index = 0

		for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)

		return index
	}
	const columns = Math.abs(column(match[3] ?? "A") - column(match[1] ?? "A")) + 1
	const rows = Math.abs(Number(match[4]) - Number(match[2])) + 1

	return columns * rows > MAX_NAME_AREA
}

function axisLayout(defaultSize: number, indices: number[], sizes: number[], styles: number[], flags: number[]): SheetAxisLayout {
	return {
		defaultSize,
		indices: Uint32Array.from(indices),
		sizes: Float32Array.from(sizes),
		styles: Uint32Array.from(styles),
		flags: Uint16Array.from(flags)
	}
}

// Text from the user as the model keeps it (ST_Xstring, ECMA-376 Part 1 §22.9.2.19): a control character XML
// cannot hold (but tab, line feed and carriage return), U+FFFE, U+FFFF and a lone surrogate as _xHHHH_, and a
// literal "_xHHHH_" with its underscore escaped, so it reads back as typed.
export function encodeXstring(text: string): string {
	let out = ""
	let from = 0

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		let escape = false

		if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff) {
			escape = true
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1)

			if (next >= 0xdc00 && next <= 0xdfff) {
				i++

				continue
			}

			escape = true
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			escape = true
		} else if (code === 0x5f && /^_x[0-9A-Fa-f]{4}_/.test(text.slice(i, i + 7))) {
			out += `${text.slice(from, i)}_x005F_`
			from = i + 1

			continue
		}

		if (escape) {
			out += `${text.slice(from, i)}_x${code.toString(16).toUpperCase().padStart(4, "0")}_`
			from = i + 1
		}
	}

	return from === 0 ? text : out + text.slice(from)
}

// A frozen view as the grid shows it (ECMA-376 Part 1 §18.3.1.66, §18.3.1.87): the frozen block starts at the view's
// first row (column) and the scrolling pane past it, at the pane's first cell; an axis with nothing frozen starts
// where the view does (a pane's first cell names the scrolling pane, which that axis does not split: [MS-XLS] Pane
// rwTop and colLeft name the bottom and right panes).
function layoutPane(view: XlsxSheetView, frozen: NonNullable<XlsxSheetView["frozen"]>): SheetPane {
	const firstRow = frozen.rows > 0 ? Math.min(view.topRow, SHEET_MAX_ROWS - 1 - frozen.rows) : 0
	const firstCol = frozen.cols > 0 ? Math.min(view.leftCol, SHEET_MAX_COLS - 1 - frozen.cols) : 0

	return {
		rows: frozen.rows,
		cols: frozen.cols,
		firstRow,
		firstCol,
		topRow: frozen.rows > 0 ? Math.min(Math.max(frozen.topLeftRow, firstRow + frozen.rows), SHEET_MAX_ROWS - 1) : view.topRow,
		leftCol: frozen.cols > 0 ? Math.min(Math.max(frozen.topLeftCol, firstCol + frozen.cols), SHEET_MAX_COLS - 1) : view.leftCol
	}
}

import {
	CONTENT_TYPES_NAMESPACE,
	CONTENT_TYPES_PART,
	RELATIONSHIPS_NAMESPACE,
	bytesSource,
	memorySink,
	writeZip,
	type ZipPlanItem
} from "../../opc/index"
import { BytePieces, type PartBytes } from "../../opc/pieces"
import { encodeUtf8, escapeAttribute, escapeText } from "../../xml/index"
import { sliceClock, type SliceClock, type Slicing } from "../../slicing"
import { columnName } from "../../sheet/refs/cellRef"
import { formatGeneral } from "../../sheet/numfmt/format"
import { SHEET_MAX_CELL_TEXT, SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetAbortSignal, type SheetRefusal } from "../../sheet/protocol"
import { nativeDeflate, nativeDeflateChunks } from "../../docx/write/zip"
import { encodeXstring } from "../edit/document"
import { openXlsx } from "../package/open"
import { decodeXstring } from "../model/strings"
import { CellKind } from "../model/types"
import { TRANSITIONAL } from "../write/namespaces"
import { SHARED_STRINGS_CONTENT_TYPE } from "../write/sharedStrings"
import { STYLES_CONTENT_TYPE } from "../write/styles"

// A text file's cells (CSV, TSV) as a new workbook of one sheet, the way Excel's "Save As" of an opened CSV
// keeps them: a number written as Excel would write it back (General format) becomes a number, and every other
// value stays the text it is, formulas and dates included (so nothing a text file holds runs or changes as it
// moves). The package is the least a valid SpreadsheetML workbook holds (ECMA-376 Part 1 §12.2, §18.2.27,
// §18.3.1.99, §18.4.9, §18.8.39), re-read before it is handed out: what reads back must be every cell as given.

const WORKSHEET_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
const WORKBOOK_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
const OFFICE_DOCUMENT = `${TRANSITIONAL.relationships}/officeDocument`
const SHEET_PART = "xl/worksheets/sheet1.xml"
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
// Rows of markup gathered into one piece.
const ROWS_PER_PIECE = 2048
// Excel's own default sheet name, for a name nothing of which is allowed.
const DEFAULT_SHEET_NAME = "Sheet1"
const FORBIDDEN_NAME_CHARS: ReadonlySet<string> = new Set(["\\", "/", "?", "*", "[", "]", ":"])

export interface TextWorkbookOptions {
	readonly slicing?: Slicing
	readonly signal?: SheetAbortSignal
	// Raw deflate in place of the platform's (CompressionStream) or fflate's.
	readonly deflate?: (data: Uint8Array) => Promise<Uint8Array>
}

export type TextWorkbookResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly refusal: SheetRefusal }

class Aborted extends Error {}

// A value as a cell: its number when General format shows that number exactly as the text is ("3", "-12", "1.5"),
// else null. "007", "1.50", "1e5", "+3", "1,000" and an id of 12 digits or more (shown in scientific notation)
// stay text: as numbers they would show otherwise than the file says.
export function textCellNumber(text: string): number | null {
	if (text.length === 0 || text.length > 32) return null

	// Only a digit or a minus sign starts what General shows: most text is turned away here, unparsed.
	const first = text.charCodeAt(0)

	if (first !== 0x2d && (first < 0x30 || first > 0x39)) return null

	const value = Number(text)

	return Number.isFinite(value) && (value < 0 ? "-" : "") + formatGeneral(value) === text ? value : null
}

// The file's name as a sheet name Excel takes: the characters it forbids (\ / ? * [ ] :) dropped, no apostrophe
// first or last, at most 31 characters; Excel's "Sheet1" when nothing but spaces is left, or for the reserved
// "History". Spaces are kept where they are: a name may start or end with one.
export function textSheetName(name: string): string {
	let allowed = ""

	// 31 UTF-16 code units, as the sheet name check counts them, never half a surrogate pair.
	for (const char of name) {
		if (FORBIDDEN_NAME_CHARS.has(char) || (char.codePointAt(0) ?? 0) < 0x20) continue
		if (allowed.length + char.length > 31) break

		allowed += char
	}

	const kept = allowed.replace(/^'+|'+$/g, "")

	return kept.trim().length === 0 || kept.toUpperCase() === "HISTORY" ? DEFAULT_SHEET_NAME : kept
}

function preserved(text: string): string {
	return /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ""
}

interface Built {
	readonly sheet: BytePieces
	readonly strings: BytePieces
	readonly cells: number
}

async function turn(clock: SliceClock | undefined, signal: SheetAbortSignal | undefined): Promise<void> {
	if (signal?.aborted === true) throw new Aborted()
	if (clock?.due === true) await clock.pause()
}

// One cell as written: text (a shared string), or a number (its <v> text, its cellXfs index).
type WrittenCell =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "number"; readonly value: number; readonly v: string; readonly style: number }

// The cells a workbook is built from: rows of cells, null for an empty one.
interface CellGrid {
	readonly rows: number
	width(row: number): number
	cell(row: number, col: number): WrittenCell | null
}

// A text file's rows: a number where General shows it exactly as the text is, else the text.
function textGrid(rows: readonly (readonly string[])[]): CellGrid {
	return {
		rows: rows.length,
		width: row => rows[row]?.length ?? 0,
		cell(row, col) {
			const text = rows[row]?.[col] ?? ""

			if (text === "") return null

			const number = textCellNumber(text)

			return number === null ? { kind: "text", text } : { kind: "number", value: number, v: text, style: 0 }
		}
	}
}

async function buildParts(
	grid: CellGrid,
	clock: SliceClock | undefined,
	signal: SheetAbortSignal | undefined
): Promise<Built | SheetRefusal> {
	const main = TRANSITIONAL.main
	const stringIndex = new Map<string, number>()
	const stringPieces: Uint8Array[] = []
	const sheetPieces: Uint8Array[] = []
	let stringMarkup = ""
	let sheetMarkup = ""
	let references = 0
	let cells = 0
	let lastRow = -1
	let lastCol = -1

	for (let r = 0; r < grid.rows; r++) {
		const width = grid.width(r)
		let rowMarkup = ""

		for (let c = 0; c < width; c++) {
			const cell = grid.cell(r, c)

			if (cell === null) continue
			if (r >= SHEET_MAX_ROWS || c >= SHEET_MAX_COLS) return { reason: "tooLarge", detail: "grid" }
			if (cell.kind === "text" && cell.text.length > SHEET_MAX_CELL_TEXT) return { reason: "tooLarge", detail: "cellText" }

			const ref = `${columnName(c)}${String(r + 1)}`

			if (cell.kind === "text") {
				const text = cell.text
				let index = stringIndex.get(text)

				if (index === undefined) {
					index = stringIndex.size
					stringIndex.set(text, index)

					const stored = encodeXstring(text)

					stringMarkup += `<si><t${preserved(stored)}>${escapeText(stored)}</t></si>`
				}

				references++
				rowMarkup += `<c r="${ref}" t="s"><v>${String(index)}</v></c>`
			} else {
				rowMarkup += `<c r="${ref}"${cell.style === 0 ? "" : ` s="${String(cell.style)}"`}><v>${cell.v}</v></c>`
			}

			cells++
			lastCol = Math.max(lastCol, c)
		}

		if (rowMarkup !== "") {
			sheetMarkup += `<row r="${String(r + 1)}">${rowMarkup}</row>`
			lastRow = r
		}

		if (r % ROWS_PER_PIECE === ROWS_PER_PIECE - 1) {
			sheetPieces.push(encodeUtf8(sheetMarkup))
			stringPieces.push(encodeUtf8(stringMarkup))
			sheetMarkup = ""
			stringMarkup = ""
			await turn(clock, signal)
		}
	}

	sheetPieces.push(encodeUtf8(sheetMarkup))
	stringPieces.push(encodeUtf8(stringMarkup))

	const dimension = lastRow < 0 ? "A1" : `A1:${columnName(lastCol)}${String(lastRow + 1)}`
	const sheetHead =
		`${DECLARATION}<worksheet xmlns="${main}" xmlns:r="${TRANSITIONAL.relationships}"><dimension ref="${dimension}"/>` +
		'<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>'
	const stringsHead = `${DECLARATION}<sst xmlns="${main}" count="${String(references)}" uniqueCount="${String(stringIndex.size)}">`

	return {
		sheet: BytePieces.of([encodeUtf8(sheetHead), ...sheetPieces, encodeUtf8("</sheetData></worksheet>")]),
		strings: BytePieces.of([encodeUtf8(stringsHead), ...stringPieces, encodeUtf8("</sst>")]),
		cells
	}
}

// cellXfs beyond the default: one per number format code, numFmtId 164 on (custom formats, §18.8.30).
function numberFormats(formats: readonly string[]): { readonly numFmts: string; readonly xfs: string } {
	if (formats.length === 0) return { numFmts: "", xfs: "" }

	return {
		numFmts:
			`<numFmts count="${String(formats.length)}">` +
			formats.map((code, k) => `<numFmt numFmtId="${String(164 + k)}" formatCode="${escapeAttribute(code)}"/>`).join("") +
			"</numFmts>",
		xfs: formats
			.map((_, k) => `<xf numFmtId="${String(164 + k)}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`)
			.join("")
	}
}

function fixedParts(sheetName: string, formats: readonly string[] = []): readonly (readonly [string, string])[] {
	const custom = numberFormats(formats)

	const main = TRANSITIONAL.main
	const relationships = TRANSITIONAL.relationships

	return [
		[
			CONTENT_TYPES_PART,
			`${DECLARATION}<Types xmlns="${CONTENT_TYPES_NAMESPACE}">` +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				`<Override PartName="/xl/workbook.xml" ContentType="${WORKBOOK_CONTENT_TYPE}"/>` +
				`<Override PartName="/${SHEET_PART}" ContentType="${WORKSHEET_CONTENT_TYPE}"/>` +
				`<Override PartName="/xl/styles.xml" ContentType="${STYLES_CONTENT_TYPE}"/>` +
				`<Override PartName="/xl/sharedStrings.xml" ContentType="${SHARED_STRINGS_CONTENT_TYPE}"/>` +
				"</Types>"
		],
		[
			"_rels/.rels",
			`${DECLARATION}<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">` +
				`<Relationship Id="rId1" Type="${OFFICE_DOCUMENT}" Target="xl/workbook.xml"/></Relationships>`
		],
		[
			"xl/workbook.xml",
			`${DECLARATION}<workbook xmlns="${main}" xmlns:r="${relationships}"><bookViews><workbookView/></bookViews>` +
				`<sheets><sheet name="${escapeAttribute(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
		],
		[
			"xl/_rels/workbook.xml.rels",
			`${DECLARATION}<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">` +
				`<Relationship Id="rId1" Type="${relationships}/worksheet" Target="worksheets/sheet1.xml"/>` +
				`<Relationship Id="rId2" Type="${relationships}/styles" Target="styles.xml"/>` +
				`<Relationship Id="rId3" Type="${relationships}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
		],
		[
			"xl/styles.xml",
			`${DECLARATION}<styleSheet xmlns="${main}">${custom.numFmts}` +
				'<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
				'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
				'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
				'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
				`<cellXfs count="${String(1 + formats.length)}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${custom.xfs}</cellXfs>` +
				'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
				'<dxfs count="0"/><tableStyles count="0"/></styleSheet>'
		]
	]
}

// The independent re-read: the package opens as a workbook of one sheet holding exactly `rows`' cells, each a
// number or the shared string it was written as.
async function readsBack(bytes: Uint8Array, grid: CellGrid, cells: number, clock: SliceClock | undefined): Promise<string | null> {
	const opened = await openXlsx(bytesSource(bytes), clock === undefined ? {} : { slicing: clock })

	if (!opened.ok) return `the converted workbook does not open (${opened.reason}: ${opened.message})`

	const workbook = opened.workbook
	const entry = workbook.sheets[0]

	if (workbook.sheets.length !== 1 || entry === undefined) return "the converted workbook does not hold one sheet"

	const store = (await workbook.load(entry.id, clock)).store

	if (store.cellCount !== cells) return `${String(store.cellCount)} cells read back, ${String(cells)} written`

	for (const block of store.blocks) {
		for (let i = 0; i < block.rowCount; i++) {
			const row = block.firstRow + (block.rows[i] ?? 0)

			for (let k = block.rowStarts[i] ?? 0; k < (block.rowStarts[i + 1] ?? 0); k++) {
				const col = block.cols[k] ?? 0
				const cell = grid.cell(row, col)
				const kind = block.kinds[k]
				const value = block.values[k] ?? Number.NaN
				const same =
					kind === CellKind.NUMBER
						? cell?.kind === "number" && cell.value === value
						: kind === CellKind.SHARED_STRING &&
							cell?.kind === "text" &&
							decodeXstring(workbook.sharedStrings.text(value)) === cell.text

				if (!same) return `cell ${columnName(col)}${String(row + 1)} does not read back as written`
			}

			if (i % ROWS_PER_PIECE === ROWS_PER_PIECE - 1 && clock?.due === true) await clock.pause()
		}
	}

	return null
}

// Builds the workbook, re-reads it and hands it out. Refuses (never drops) what a workbook cannot hold: more rows
// or columns than a sheet has, a cell longer than Excel's 32,767 characters. Never throws.
export async function textWorkbookXlsx(
	rows: readonly (readonly string[])[],
	name: string,
	options: TextWorkbookOptions = {}
): Promise<TextWorkbookResult> {
	return gridWorkbookXlsx(textGrid(rows), [], name, options)
}

// A cell of a workbook built from values: text, a number (General), a number with its format code, or empty.
export type WorkbookCell = string | number | { readonly number: number; readonly format: string } | null

// Cells as a new workbook of one sheet, each as it is given: a string a shared string (never read as a number), a
// number its exact value (the shortest text that reads back as it, never a General rounding), a formatted number with
// its format code as a custom number format. A number that is not finite is refused. Re-read before it is handed
// out, as textWorkbookXlsx.
export async function cellsWorkbookXlsx(
	rows: readonly (readonly WorkbookCell[])[],
	name: string,
	options: TextWorkbookOptions = {}
): Promise<TextWorkbookResult> {
	const formats: string[] = []
	const styleOf = new Map<string, number>()

	for (const row of rows)
		for (const cell of row) {
			if (cell === null || typeof cell !== "object" || cell.format === "General" || styleOf.has(cell.format)) continue

			formats.push(cell.format)
			styleOf.set(cell.format, formats.length)
		}

	for (const row of rows)
		for (const cell of row) {
			const value = typeof cell === "number" ? cell : cell !== null && typeof cell === "object" ? cell.number : 0

			if (!Number.isFinite(value)) return { ok: false, refusal: { reason: "unsupported", detail: "a number that is not finite" } }
		}

	const grid: CellGrid = {
		rows: rows.length,
		width: row => rows[row]?.length ?? 0,
		cell(row, col) {
			const cell = rows[row]?.[col] ?? null

			if (cell === null || cell === "") return null
			if (typeof cell === "string") return { kind: "text", text: cell }
			if (typeof cell === "number") return { kind: "number", value: cell, v: String(cell), style: 0 }

			return { kind: "number", value: cell.number, v: String(cell.number), style: styleOf.get(cell.format) ?? 0 }
		}
	}

	return gridWorkbookXlsx(grid, formats, name, options)
}

async function gridWorkbookXlsx(
	grid: CellGrid,
	formats: readonly string[],
	name: string,
	options: TextWorkbookOptions
): Promise<TextWorkbookResult> {
	const clock = options.slicing === undefined ? undefined : sliceClock(options.slicing)

	try {
		const built = await buildParts(grid, clock, options.signal)

		if (!("sheet" in built)) return { ok: false, refusal: built }

		const parts: [string, PartBytes][] = fixedParts(textSheetName(name), formats).map(([part, markup]) => [
			part,
			BytePieces.of([encodeUtf8(markup)])
		])

		parts.splice(3, 0, [SHEET_PART, built.sheet])
		parts.push(["xl/sharedStrings.xml", built.strings])

		const items: ZipPlanItem[] = parts.map(([part, bytes]) => ({ kind: "data", name: part, bytes, compress: true }))
		const sink = memorySink()
		const deflate = options.deflate ?? nativeDeflate()
		const deflateChunks = options.deflate === undefined ? nativeDeflateChunks() : undefined

		await writeZip({ items }, null, sink, {
			...(deflate !== undefined && { deflate }),
			...(deflateChunks !== undefined && { deflateChunks }),
			...(clock !== undefined && { slicing: clock })
		})
		await turn(clock, options.signal)

		const bytes = sink.bytes()
		const problem = await readsBack(bytes, grid, built.cells, clock)

		if (problem !== null) return { ok: false, refusal: { reason: "unsupported", detail: problem } }
		if (options.signal?.aborted === true) return { ok: false, refusal: { reason: "unsupported", detail: "aborted" } }

		return { ok: true, bytes }
	} catch (error) {
		return {
			ok: false,
			refusal: {
				reason: "unsupported",
				detail: error instanceof Aborted ? "aborted" : error instanceof Error ? error.message : String(error)
			}
		}
	}
}

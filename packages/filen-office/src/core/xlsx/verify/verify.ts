import {
	CONTENT_TYPES_PART,
	Relationships,
	joinBytes,
	parseContentTypes,
	parseRelationships,
	partKey,
	relationshipsPartName
} from "../../opc/index"
import {
	XmlError,
	assertWellFormed,
	assertWellFormedSliced,
	decodeCharacterData,
	decodeUtf8,
	encodeUtf8,
	parseXml,
	parseXmlSliced,
	type XmlDocument
} from "../../xml/index"
import type { SliceClock } from "../../slicing"
import type { SheetRange } from "../../sheet/protocol"
import {
	CellKind,
	NO_SPAN,
	RowFlag,
	ROW_MARKS,
	type XlsxColRange,
	type XlsxFormula,
	type XlsxRichRun,
	type XlsxRowBlock,
	type XlsxSheetModel,
	type XlsxStyleTable
} from "../model/types"
import { XlsxReadError } from "../read/errors"
import { Scanner } from "../read/scan"
import { SheetDataReader } from "../read/sheetData"
import { orderInversions } from "../write/assemble"
import { orphanedSharedSteps } from "../model/store"
import { decodeRowElement, sameFormula, sameRowProperties, sameValue, usedRange, type WrittenRow } from "../write/cells"
import { XlsxWriteError, type XlsxSaveFailure } from "../write/failure"
import { eachChild, findAttribute, qualify, rootTag, scanReference, scanTag, spells } from "../write/markup"
import { STYLESHEET, WORKBOOK } from "../write/order.generated"
import { readBorder, readDxf, readFill, readFont, readXf, sameBorder, sameDxf, sameFill, sameFont, sameXf } from "../write/records"
import type { XlsxDraft } from "../write/save"
import { IMPLIED_BORDER, IMPLIED_FILLS, IMPLIED_FONT, IMPLIED_XF, type StylesExtent } from "../write/styles"
import {
	childElement,
	readCols,
	readDimension,
	readMerges,
	readProtection,
	readTabColor,
	sameCol,
	sameColor,
	sameFormat,
	sameProtection,
	sameQuads,
	sameView
} from "../write/sections"
import { OWN_SHEET_SECTIONS, sheetOrder, type WrittenSheet } from "../write/sheet"
import { SHEET_CONTENT_TYPES } from "../write/namespaces"
import { boundPrefix, relationshipIdName, type WrittenWorkbook } from "../write/workbook"
import { MAX_COLS, MAX_ROWS, cellRef, inSheet, parseCellRef, parseRangeRef, readBoolean } from "../write/text"

// The part half of the save gate. Everything a save writes is read back independently of the model's reader
// (the generic XML parser and this module's own decoding) and must equal the session model; the written XML
// must be well formed, keep schema order, and refer only to what exists: cells, sheets, styles, shared strings,
// relationships and content types. A failure is an XlsxWriteError with its reason; the save turns it into a
// refusal.

function fail(reason: XlsxSaveFailure, message: string): never {
	throw new XlsxWriteError(reason, message)
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// Rows checked between looks at the slice clock.
const ROWS_PER_CHECK = 512

async function parseCheckedSliced(name: string, bytes: Uint8Array, clock: SliceClock): Promise<XmlDocument> {
	try {
		const document = await parseXmlSliced(bytes, clock)

		await assertWellFormedSliced(document, clock)

		return document
	} catch (error) {
		if (error instanceof XmlError) return fail("malformedPart", `${name}: ${describe(error)}`)

		throw error
	}
}

function parseChecked(name: string, bytes: Uint8Array): XmlDocument {
	try {
		const document = parseXml(bytes)

		assertWellFormed(document)

		return document
	} catch (error) {
		if (error instanceof XmlError) return fail("malformedPart", `${name}: ${describe(error)}`)

		throw error
	}
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
	let size = 0

	for (const chunk of chunks) size += chunk.length

	const out = new Uint8Array(size)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

function closeTag(open: Uint8Array): Uint8Array {
	return encodeUtf8(`</${rootTag(open).name}>`)
}

function contains(outer: SheetRange, inner: SheetRange): boolean {
	return (
		outer.startRow <= inner.startRow && outer.startCol <= inner.startCol && outer.endRow >= inner.endRow && outer.endCol >= inner.endCol
	)
}

// --- The package after the save ---

class Outcome {
	private readonly draft: XlsxDraft
	private readonly written = new Map<string, Uint8Array>()
	private readonly removed: Set<string>
	private readonly added: Set<string>
	private readonly relationshipsCache = new Map<string, Promise<Relationships>>()

	constructor(draft: XlsxDraft) {
		this.draft = draft
		this.removed = new Set(draft.remove.map(partKey))
		this.added = new Set(draft.add.map(change => partKey(change.name)))

		for (const [name, bytes] of draft.relationships) this.written.set(partKey(name), bytes)
	}

	has(name: string): boolean {
		const key = partKey(name)

		return this.added.has(key) || (this.draft.input.opc.has(name) && !this.removed.has(key))
	}

	isRemoved(name: string): boolean {
		return this.removed.has(partKey(name))
	}

	// The relationships of `source` as the save leaves them.
	relationships(source: string): Promise<Relationships> {
		const key = partKey(source)
		let promise = this.relationshipsCache.get(key)

		if (promise === undefined) {
			const written = this.written.get(partKey(relationshipsPartName(source)))

			promise =
				written !== undefined
					? Promise.resolve(parseRelationships(written, source))
					: this.isRemoved(relationshipsPartName(source))
						? Promise.resolve(new Relationships([]))
						: this.draft.input.opc.relationships(source)
			this.relationshipsCache.set(key, promise)
		}

		return promise
	}
}

// --- Cells ---

// The store against the file's limits: rows ascending and in the sheet, and in every row the save wrote anew
// (the others are their source bytes) columns ascending and every style and string index in range.
// `styles` and `shared`: the cell formats and shared strings the package holds after the save.
async function checkStore(
	sheet: XlsxSheetModel,
	name: string,
	styles: number,
	shared: number,
	clock: SliceClock | undefined
): Promise<void> {
	const store = sheet.store
	const own = store.strings.length
	const formulas = store.formulas.length
	let lastRow = -1

	for (const block of store.blocks) {
		for (let index = 0; index < block.rowCount; index++) {
			const row = block.firstRow + (block.rows[index] ?? 0)

			if (row <= lastRow || row >= MAX_ROWS) fail("reference", `${name}: row ${row + 1} is out of order or outside the sheet`)

			lastRow = row

			const flags = block.rowFlags[index] ?? 0

			if ((flags & (RowFlag.DIRTY | RowFlag.NEW)) === 0 && (block.rowSpans[index * 2] ?? NO_SPAN) !== NO_SPAN) continue

			const rowStyle = block.rowStyles[index] ?? -1

			if (rowStyle > 0 && rowStyle >= styles) fail("reference", `${name}: row ${row + 1} has style ${rowStyle} of ${styles}`)

			let lastCol = -1

			for (let slot = block.rowStarts[index] ?? 0; slot < (block.rowStarts[index + 1] ?? 0); slot++) {
				const col = block.cols[slot] ?? 0

				if (col <= lastCol || col >= MAX_COLS)
					fail("reference", `${name}: cell ${cellRef(row, col)} is out of order or outside the sheet`)

				lastCol = col

				const kind = block.kinds[slot] ?? 0
				const value = block.values[slot] ?? 0
				const style = block.styles[slot] ?? 0
				const formula = block.formulas?.[slot] ?? -1

				if (style > 0 && style >= styles) fail("reference", `${name}: ${cellRef(row, col)} has style ${style} of ${styles}`)
				if (formula >= formulas) fail("reference", `${name}: ${cellRef(row, col)} has formula ${formula} of ${formulas}`)
				if (kind === CellKind.SHARED_STRING && !(Number.isInteger(value) && value >= 0 && value < shared)) {
					fail("reference", `${name}: ${cellRef(row, col)} refers to shared string ${value} of ${shared}`)
				}

				if (
					(kind === CellKind.INLINE_STRING ||
						kind === CellKind.FORMULA_STRING ||
						kind === CellKind.ERROR ||
						kind === CellKind.DATE) &&
					!(Number.isInteger(value) && value >= 0 && value < own)
				) {
					fail("reference", `${name}: ${cellRef(row, col)} refers to sheet string ${value} of ${own}`)
				}
			}
		}

		if (clock?.due === true) await clock.pause()
	}
}

// A rewritten row read back: its number, properties and every cell as the store holds them (a cell without r, as
// a row copied whole keeps it, at the column its position implies).
// A rewritten row, read from the parsed markup the well-formedness check built (`node` in `document`, whose bytes
// are `bytes`), against the store.
function checkRow(
	name: string,
	sheet: XlsxSheetModel,
	block: XlsxRowBlock,
	index: number,
	document: XmlDocument,
	node: number,
	bytes: Uint8Array
): void {
	const row = block.firstRow + (block.rows[index] ?? 0)
	const where = `${name} row ${row + 1}`
	const tag = node < 0 || document.localName(node) !== "row" ? undefined : scanTag(bytes, document.start(node))

	if (tag === undefined) return fail("malformedPart", `${where} is not a row`)

	let decoded

	try {
		decoded = decodeRowElement(document, node, 0, document.end(node), tag)
	} catch (error) {
		return fail("malformedPart", `${where}: ${describe(error)}`)
	}

	if (decoded.row !== row) fail("model", `${where} reads back as row ${decoded.row + 1}`)

	const flags = (block.rowFlags[index] ?? 0) & ~ROW_MARKS

	if (!sameRowProperties(decoded, block.rowHeights[index] ?? Number.NaN, block.rowStyles[index] ?? -1, flags)) {
		fail("model", `${where}: its properties read back differently`)
	}

	const from = block.rowStarts[index] ?? 0
	const to = block.rowStarts[index + 1] ?? 0

	if (decoded.cells.length !== to - from) fail("model", `${where} reads back with ${decoded.cells.length} cells, not ${to - from}`)

	for (let slot = from; slot < to; slot++) {
		const cell = decoded.cells[slot - from]
		const col = block.cols[slot] ?? 0
		const id = block.formulas?.[slot] ?? -1
		const formula = id >= 0 ? sheet.store.formulas.formula(id) : null

		if (
			cell === undefined ||
			cell.col !== col ||
			cell.style !== (block.styles[slot] ?? 0) ||
			!sameValue(cell, block.kinds[slot] ?? 0, block.values[slot] ?? 0, sheet.store.strings) ||
			!sameFormula(cell.formula, cell.cm, formula)
		) {
			fail("model", `${name} ${cellRef(row, col)} reads back differently`)
		}
	}
}

// A row only renumbered: its r and every cell's r name the store's row and columns.
// The A1 reference at [from, to) of `bytes` as row * 16384 + col, or -1.
function referenceAt(bytes: Uint8Array, from: number, to: number): number {
	let i = from
	let col = 0

	if (bytes[i] === 36) i++

	const letters = i

	while (i < to) {
		const upper = (bytes[i] ?? 0) & 0xdf

		if (upper < 65 || upper > 90) break

		col = col * 26 + upper - 64
		i++
	}

	if (i === letters || i - letters > 3) return -1
	if (bytes[i] === 36) i++

	let row = 0

	if (i === to) return -1

	for (; i < to; i++) {
		const digit = (bytes[i] ?? 0) - 48

		if (digit < 0 || digit > 9) return -1

		row = row * 10 + digit
	}

	return row < 1 || row > MAX_ROWS ? -1 : (row - 1) * MAX_COLS + col - 1
}

const REFERENCE = new Int32Array(4)

// A row that only moved: numbered as the store's row, every cell where the store has it.
function checkRenumbered(name: string, block: XlsxRowBlock, index: number, bytes: Uint8Array, prefix: string): void {
	const row = block.firstRow + (block.rows[index] ?? 0)
	const cellName = qualify(prefix, "c")
	const from = block.rowStarts[index] ?? 0
	const to = block.rowStarts[index + 1] ?? 0
	const tag = REFERENCE
	let slot = from

	if (!scanReference(bytes, 0, tag)) return fail("malformedPart", `${name} row ${row + 1} is not an element`)
	if ((tag[1] ?? -1) < 0 || decodeUtf8(bytes, tag[1] ?? 0, tag[2] ?? 0) !== String(row + 1)) {
		fail("model", `${name} row ${row + 1} is not numbered as the store's`)
	}

	for (let i = bytes.indexOf(60, tag[3] ?? 0); i >= 0; i = bytes.indexOf(60, i + 1)) {
		if (!scanReference(bytes, i, tag) || !spells(bytes, i + 1, tag[0] ?? 0, cellName)) continue

		const col = block.cols[slot] ?? -1

		if ((tag[1] ?? -1) >= 0 && referenceAt(bytes, tag[1] ?? 0, tag[2] ?? 0) !== row * MAX_COLS + col)
			fail("model", `${name} ${cellRef(row, col)} is not where the store has it`)

		slot++
		i = (tag[3] ?? i + 1) - 1
	}

	if (slot !== to) fail("model", `${name} row ${row + 1} reads back with ${slot - from} cells, not ${to - from}`)
}

// --- Sheets ---

function checkMerges(name: string, merges: Uint32Array): void {
	const ranges: SheetRange[] = []

	for (let k = 0; k + 3 < merges.length; k += 4) {
		const range = { startRow: merges[k] ?? 0, startCol: merges[k + 1] ?? 0, endRow: merges[k + 2] ?? 0, endCol: merges[k + 3] ?? 0 }

		if (!inSheet(range) || range.startRow > range.endRow || range.startCol > range.endCol)
			fail("reference", `${name}: merge ${k / 4} is not a range in the sheet`)

		ranges.push(range)
	}

	ranges.sort((a, b) => a.startRow - b.startRow || a.startCol - b.startCol)

	// Ranges still open at the current row, checked pairwise in columns.
	let open: SheetRange[] = []

	for (const range of ranges) {
		open = open.filter(other => other.endRow >= range.startRow)

		for (const other of open) {
			if (other.startCol <= range.endCol && range.startCol <= other.endCol) fail("reference", `${name}: merged ranges overlap`)
		}

		open.push(range)
	}
}

// Column ranges that start at or before the end of the one before them.
function colOverlaps(cols: readonly XlsxColRange[]): number {
	let last = -1
	let overlaps = 0

	for (const col of cols) {
		if (col.first <= last) overlaps++

		last = col.last
	}

	return overlaps
}

// Overlaps the source's cols section already had are the file's, kept as written (`source`: that section).
function checkCols(name: string, sheet: XlsxSheetModel, styles: number, source: Uint8Array | null): void {
	for (const col of sheet.cols) {
		if (col.first > col.last || col.last >= MAX_COLS) fail("reference", `${name}: column ranges overlap or leave the sheet`)
		if (col.style > 0 && col.style >= styles) fail("reference", `${name}: a column has style ${col.style} of ${styles}`)
	}

	const overlaps = colOverlaps(sheet.cols)

	if (overlaps > 0 && overlaps > (source === null ? 0 : colOverlaps(readCols(source))))
		fail("reference", `${name}: column ranges overlap or leave the sheet`)
}

// A cell, a range, or whole columns ("A:C") or rows ("1:3"), within the sheet.
function referenceInSheet(text: string): boolean {
	const range = parseRangeRef(text)

	if (range !== undefined) return inSheet(range)

	const columns = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/.exec(text)

	if (columns !== null) {
		const first = parseCellRef(`${columns[1] ?? ""}1`)
		const last = parseCellRef(`${columns[2] ?? ""}1`)

		return first !== undefined && last !== undefined && first.col < MAX_COLS && last.col < MAX_COLS
	}

	const rows = /^\$?(\d{1,7}):\$?(\d{1,7})$/.exec(text)

	return rows !== null && Number(rows[1]) >= 1 && Number(rows[2]) >= 1 && Number(rows[1]) <= MAX_ROWS && Number(rows[2]) <= MAX_ROWS
}

const REF_ATTRIBUTE = /\s(sqref|ref)\s*=\s*"([^"]*)"/g
const DXF_ATTRIBUTE = /\sdxfId\s*=\s*"([^"]*)"/g

// A reference in written markup that does not resolve: the attribute as written (name and value) and the failure.
interface Unresolved {
	readonly attribute: string
	readonly value: string
	// A relationship id: the source part's relationships decide whether it was already dangling.
	readonly relationship: boolean
	readonly reason: XlsxSaveFailure
	readonly message: string
}

// References in written markup: every sqref and ref names cells in the sheet, every dxfId a format, every
// relationship id a relationship of the part. Those that do not resolve, null when all do.
function unresolvedReferences(
	name: string,
	markup: Uint8Array,
	dxfs: number,
	relationships: Relationships,
	relationshipsPrefix: string | null
): Unresolved[] | null {
	const text = decodeUtf8(markup)
	let out: Unresolved[] | null = null

	for (const match of text.matchAll(REF_ATTRIBUTE)) {
		const value = match[2] ?? ""

		for (const part of value.trim().split(/\s+/)) {
			if (part === "" || referenceInSheet(part)) continue

			;(out ??= []).push({
				attribute: match[1] ?? "",
				value,
				relationship: false,
				reason: "reference",
				message: `${name}: ${match[1]}="${value}" is not in the sheet`
			})

			break
		}
	}

	for (const match of text.matchAll(DXF_ATTRIBUTE)) {
		const id = Number(match[1])

		if (!Number.isInteger(id) || id < 0 || id >= dxfs)
			(out ??= []).push({
				attribute: "dxfId",
				value: match[1] ?? "",
				relationship: false,
				reason: "reference",
				message: `${name}: dxfId ${match[1]} of ${dxfs}`
			})
	}

	if (relationshipsPrefix === null) return out

	const pattern = new RegExp(`\\s(${relationshipsPrefix}:[A-Za-z]+)\\s*=\\s*"([^"]*)"`, "g")

	for (const match of text.matchAll(pattern)) {
		if (relationships.byId(match[2] ?? "") === undefined)
			(out ??= []).push({
				attribute: match[1] ?? "",
				value: match[2] ?? "",
				relationship: true,
				reason: "relationship",
				message: `${name}: no relationship ${match[2]}`
			})
	}

	return out
}

// A written section's references, each resolving or written identically in the source's sections of that name
// (re-serialised from source text: the file's, kept as written; a relationship id only when the source part's
// relationships lacked it too). Sections the model writes itself get no such discount.
async function checkSectionReferences(
	written: WrittenSheet,
	section: string,
	markup: Uint8Array,
	draft: XlsxDraft,
	relationships: Relationships,
	relationshipsPrefix: string | null
): Promise<void> {
	const unresolved = unresolvedReferences(
		`${written.part} ${section}`,
		markup,
		draft.input.workbook.styles.dxfs.length,
		relationships,
		relationshipsPrefix
	)

	if (unresolved === null) return

	const sources = OWN_SHEET_SECTIONS.has(section)
		? []
		: (written.entry.model?.sections ?? []).flatMap(candidate =>
				candidate.name === section && candidate.bytes !== null ? [decodeUtf8(candidate.bytes)] : []
			)
	const opc = draft.input.opc
	const before =
		sources.length > 0 && unresolved.some(item => item.relationship) && opc.has(relationshipsPartName(written.part))
			? await opc.relationships(written.part)
			: undefined

	for (const item of unresolved) {
		const inherited =
			sources.some(
				text => text.includes(`${item.attribute}="${item.value}"`) || text.includes(`${item.attribute}='${item.value}'`)
			) &&
			(!item.relationship || before?.byId(item.value) === undefined)

		if (!inherited) fail(item.reason, item.message)
	}
}

// Rows written as spliced source bytes, read back by the reader (as the next open reads them) and compared with
// the store: number, properties, and every cell's column, style, value and formula.
async function checkSplicedRows(
	name: string,
	sheet: XlsxSheetModel,
	rows: readonly WrittenRow[],
	prefix: string,
	sharedStrings: number,
	clock: SliceClock | undefined
): Promise<void> {
	// In batches of about a megabyte: the rows are never copied together whole.
	let from = 0

	while (from < rows.length) {
		let to = from
		let size = 0

		while (to < rows.length && (to === from || size < SPLICED_BATCH)) size += rows[to++]?.bytes.length ?? 0

		await checkSplicedBatch(name, sheet, rows.slice(from, to), prefix, sharedStrings, clock)
		from = to
	}
}

const SPLICED_BATCH = 1 << 20

async function checkSplicedBatch(
	name: string,
	sheet: XlsxSheetModel,
	rows: readonly WrittenRow[],
	prefix: string,
	sharedStrings: number,
	clock: SliceClock | undefined
): Promise<void> {
	if (rows.length === 0) return

	const head = encodeUtf8(`<${qualify(prefix, "sheetData")}>`)
	const bytes = join([head, ...rows.map(row => row.bytes), encodeUtf8(`</${qualify(prefix, "sheetData")}>`)])
	const reader = new SheetDataReader(new Scanner(bytes, name), head.length, {
		part: name,
		sharedStrings,
		cellBudget: Number.POSITIVE_INFINITY
	})

	try {
		while (!reader.step(ROWS_PER_CHECK, 1 << 20)) if (clock?.due === true) await clock.pause()
	} catch (error) {
		if (error instanceof XlsxReadError) fail("malformedPart", `${name}: spliced rows: ${error.message}`)

		throw error
	}

	const store = sheet.store
	let k = 0

	const steps = reader.builder.finishSteps()
	let finished = steps.next()

	while (finished.done !== true) {
		if (clock?.due === true) await clock.pause()

		finished = steps.next()
	}

	for (const read of finished.value) {
		for (let i = 0; i < read.rowCount; i++, k++) {
			const written = rows[k]

			if (k % ROWS_PER_CHECK === 0 && clock?.due === true) await clock.pause()

			if (written === undefined) return fail("model", `${name}: more spliced rows read back than written`)

			const block = store.blocks[written.block] as XlsxRowBlock
			const index = written.index
			const row = block.firstRow + (block.rows[index] ?? 0)
			const where = `${name} row ${row + 1}`
			const own = (flags: number) => flags & ~ROW_MARKS
			const height = block.rowHeights[index] ?? Number.NaN
			const readHeight = read.rowHeights[i] ?? Number.NaN

			if (read.firstRow + (read.rows[i] ?? 0) !== row)
				fail("model", `${where} reads back as row ${read.firstRow + (read.rows[i] ?? 0) + 1}`)
			if (
				own(read.rowFlags[i] ?? 0) !== own(block.rowFlags[index] ?? 0) ||
				(read.rowStyles[i] ?? -1) !== (block.rowStyles[index] ?? -1) ||
				!(readHeight === height || (Number.isNaN(readHeight) && Number.isNaN(height)))
			)
				fail("model", `${where}: its properties read back differently`)

			const from = block.rowStarts[index] ?? 0
			const to = block.rowStarts[index + 1] ?? 0
			const readFrom = read.rowStarts[i] ?? 0

			if ((read.rowStarts[i + 1] ?? 0) - readFrom !== to - from) fail("model", `${where} reads back with another number of cells`)

			for (let slot = from; slot < to; slot++) {
				const at = readFrom + slot - from
				const kind = block.kinds[slot] ?? 0
				const id = block.formulas?.[slot] ?? -1
				const readId = read.formulas?.[at] ?? -1
				const textual =
					kind === CellKind.INLINE_STRING || kind === CellKind.FORMULA_STRING || kind === CellKind.ERROR || kind === CellKind.DATE
				const sameCellValue = textual
					? reader.strings.text(read.values[at] ?? 0) === store.strings.text(block.values[slot] ?? 0)
					: (read.values[at] ?? 0) === (block.values[slot] ?? 0)

				if (
					(read.cols[at] ?? -1) !== (block.cols[slot] ?? -2) ||
					(read.styles[at] ?? 0) !== (block.styles[slot] ?? 0) ||
					(read.kinds[at] ?? 0) !== kind ||
					!sameCellValue ||
					readId < 0 !== id < 0 ||
					(id >= 0 && !sameFormulas(reader.formulas.formula(readId), store.formulas.formula(id)))
				)
					fail("model", `${name} ${cellRef(row, block.cols[slot] ?? 0)} reads back differently`)
			}
		}
	}

	if (k !== rows.length) fail("model", `${name}: ${rows.length} spliced rows written, ${k} read back`)
}

// Every shared formula child (t="shared" with si and no ref) of a written sheet lies in the range of a master with
// its si: a child without one has no formula a reader can build. The rows read back as the store holds them, so
// the store's formulas are the sheet's.
async function checkSharedFormulas(name: string, sheet: XlsxSheetModel, clock: SliceClock | undefined): Promise<void> {
	const steps = orphanedSharedSteps(sheet.store)
	let step = steps.next()

	while (step.done !== true) {
		if (clock?.due === true) await clock.pause()

		step = steps.next()
	}

	// Children the source already left without a master are the file's, kept as written.
	for (const sharedIndex of step.value)
		if (sheet.sourceOrphanedShared?.has(sharedIndex) !== true)
			fail("reference", `${name}: a child of shared formula ${sharedIndex} has no master over it`)
}

function sameFormulas(a: XlsxFormula, b: XlsxFormula): boolean {
	const range = (x: SheetRange | null, y: SheetRange | null) =>
		x === null || y === null
			? x === y
			: x.startRow === y.startRow && x.startCol === y.startCol && x.endRow === y.endRow && x.endCol === y.endCol

	return (
		a.kind === b.kind &&
		a.text === b.text &&
		a.sharedIndex === b.sharedIndex &&
		range(a.ref, b.ref) &&
		a.flags === b.flags &&
		a.cellMetadata === b.cellMetadata &&
		a.r1 === b.r1 &&
		a.r2 === b.r2
	)
}

// Each section as often as the model has it: one written anew stands for every child of its name (its markup holds
// them all), one copied as often as the source holds it.
function checkSectionCounts(
	name: string,
	names: readonly string[],
	sourceNames: readonly string[],
	written: ReadonlyMap<string, Uint8Array>
): void {
	const count = (list: readonly string[]): Map<string, number> => {
		const out = new Map<string, number>()

		for (const item of list) out.set(item, (out.get(item) ?? 0) + 1)

		return out
	}
	const source = count(sourceNames)

	for (const [section, times] of count(names)) {
		const allowed = written.has(section) || !source.has(section) ? 1 : (source.get(section) ?? 0)

		if (times > allowed)
			fail("model", `${name}: ${section} written ${times} times, the model has it ${allowed === 1 ? "once" : `${allowed} times`}`)
	}
}

const EMPTY_BYTES = new Uint8Array(0)
const EMPTY_DOCUMENT = parseXml(encodeUtf8("<empty/>"))

// Rewritten rows parsed together, at most this many bytes of them: a part every row of which was rewritten is never
// held whole, nor its parse.
const ROW_CHUNK_BYTES = 1 << 20

async function checkSheet(written: WrittenSheet, draft: XlsxDraft, outcome: Outcome, clock: SliceClock | undefined): Promise<void> {
	const sheet = written.entry.model as XlsxSheetModel
	const name = written.part
	const order = sheetOrder(written.entry)
	const open = written.rootOpen
	const close = closeTag(open)
	const dataOpen = encodeUtf8(`<${qualify(written.prefix, "sheetData")}>`)
	const dataClose = encodeUtf8(`</${qualify(written.prefix, "sheetData")}>`)
	const chunks: Uint8Array[] = [open]

	// Well formed: the new markup in the part's root, every copy (whole elements of a well-formed source) left out.
	// The rows rewritten are each whole elements of sheetData, so the part is well formed when the rest is and each
	// run of them is in the root's sheetData: they are parsed in runs below, before anything else is checked.
	for (const markup of written.written.values()) chunks.push(markup)

	if (written.rows !== null) chunks.push(dataOpen, dataClose)

	chunks.push(close)

	const parse = (bytes: Uint8Array): Promise<XmlDocument> | XmlDocument =>
		clock === undefined ? parseChecked(name, bytes) : parseCheckedSliced(name, bytes, clock)

	await parse(join(chunks))

	// The rows rewritten anew (renumbered and spliced rows are their source bytes with values replaced, as copies are:
	// checked below), each run parsed in the root's sheetData and read back against the store. A row that reads back
	// otherwise fails once every run is known to be well formed and every check before the rows has passed, as when
	// the part was parsed whole.
	const fresh = written.rows === null ? [] : written.rows.filter(row => !row.spliced && !row.renumbered)
	// The first row that failed (null: after the last row), with its failure.
	let rowFailure: { readonly row: WrittenRow | null; readonly error: unknown } | null = null
	let checked = 0

	// The rows and the row elements read are paired in one sequence across the runs, as one parse of the part paired
	// them: an empty row takes the next element, wherever that lies.
	let nextRow = 0
	// The part as once parsed whole: its root's start tag, the new sections and sheetData's start, then the rows.
	const head = chunks.reduce((size, chunk) => size + chunk.length, 0) - dataClose.length - close.length
	let rowsBefore = 0
	const check = (row: WrittenRow, document: XmlDocument | null, node: number, bytes: Uint8Array): void => {
		if (rowFailure !== null) return

		try {
			checkRow(name, sheet, sheet.store.blocks[row.block] as XlsxRowBlock, row.index, document ?? EMPTY_DOCUMENT, node, bytes)
		} catch (error) {
			if (!(error instanceof XlsxWriteError)) throw error

			rowFailure = { row, error }
		}
	}

	for (let first = 0; first < fresh.length;) {
		let last = first
		let size = 0

		while (last < fresh.length && (last === first || size + (fresh[last]?.bytes.length ?? 0) <= ROW_CHUNK_BYTES))
			size += fresh[last++]?.bytes.length ?? 0

		const bytes = join([open, dataOpen, ...fresh.slice(first, last).map(row => row.bytes), dataClose, close])
		const document = await Promise.resolve()
			.then(() => parse(bytes))
			.catch((error: unknown) => {
				// Where the part as parsed whole has the byte: its head and the rows before this run, not the run's own.
				if (!(error instanceof XlsxWriteError)) throw error

				const prefix = open.length + dataOpen.length

				throw new XlsxWriteError(
					error.reason,
					error.message.replace(/byte (\d+)/, (whole, at: string) =>
						Number(at) < prefix ? whole : `byte ${String(head + rowsBefore + Number(at) - prefix)}`
					)
				)
			})

		for (let k = first; k < last; k++) rowsBefore += fresh[k]?.bytes.length ?? 0
		const data = childElement(document, document.documentElement(), "sheetData")

		for (let node = data < 0 ? -1 : document.firstChildElement(data); node >= 0; node = document.nextSiblingElement(node)) {
			if (++checked % ROWS_PER_CHECK === 0 && clock?.due === true) await clock.pause()

			const row = fresh[nextRow++]

			// An element after the part's last row: sheetData may hold none there.
			if (row === undefined) {
				rowFailure ??= { row: null, error: new XlsxWriteError("malformedPart", `${name}: an element after the last row`) }

				break
			}

			check(row, document, node, bytes)
		}

		first = last
	}

	// Rows no element was read for.
	for (; nextRow < fresh.length; nextRow++) check(fresh[nextRow] as WrittenRow, null, -1, EMPTY_BYTES)

	if (orderInversions(written.names, order) > orderInversions(written.sourceNames, order))
		fail("elementOrder", `${name}: sections out of schema order`)

	checkSectionCounts(name, written.names, written.sourceNames, written.written)

	const relationships = await outcome.relationships(name)
	const relationshipsPrefix = boundPrefix(join([open, close]))

	for (const [section, markup] of written.written)
		await checkSectionReferences(written, section, markup, draft, relationships, relationshipsPrefix)

	if (written.rows !== null) {
		await checkStore(sheet, name, draft.cellXfCount, draft.sharedStringCount, clock)

		const spliced: WrittenRow[] = []

		// In the order the rows were written, as the part's own parse checked them.
		for (const row of written.rows) {
			if (++checked % ROWS_PER_CHECK === 0 && clock?.due === true) await clock.pause()

			if (row === rowFailure?.row) throw rowFailure.error
			if (row.spliced) spliced.push(row)
			else if (row.renumbered)
				checkRenumbered(name, sheet.store.blocks[row.block] as XlsxRowBlock, row.index, row.bytes, written.prefix)
		}

		if (rowFailure !== null && rowFailure.row === null) throw rowFailure.error

		await checkSplicedRows(name, sheet, spliced, written.prefix, draft.sharedStringCount, clock)
		await checkSharedFormulas(name, sheet, clock)
	}

	// The sections the writer owns read back as the model.
	const section = (key: string): Uint8Array | null => written.written.get(key) ?? null
	const replaced = (key: string): boolean =>
		written.written.has(key) || (written.sourceNames.includes(key) && !written.names.includes(key))

	if (replaced("mergeCells")) {
		if (!sameQuads(readMerges(section("mergeCells")), sheet.merges)) fail("model", `${name}: merged cells read back differently`)

		checkMerges(name, sheet.merges)
	}

	if (replaced("cols")) {
		const cols = readCols(section("cols"))

		if (cols.length !== sheet.cols.length || !cols.every((col, k) => sameCol(col, sheet.cols[k])))
			fail("model", `${name}: columns read back differently`)

		checkCols(name, sheet, draft.cellXfCount, sheet.sections.find(candidate => candidate.name === "cols")?.bytes ?? null)
	}

	if (replaced("sheetProtection") && !sameProtection(readProtection(section("sheetProtection")), sheet.protection)) {
		fail("model", `${name}: sheet protection reads back differently`)
	}

	if (written.written.has("sheetViews") && !sameView(section("sheetViews"), sheet.view))
		fail("model", `${name}: the sheet view reads back differently`)
	if (written.written.has("sheetFormatPr") && !sameFormat(section("sheetFormatPr"), sheet.format))
		fail("model", `${name}: the sheet format reads back differently`)
	if (written.written.has("sheetPr") && !sameColor(readTabColor(section("sheetPr")), sheet.tabColor))
		fail("model", `${name}: the tab colour reads back differently`)

	if (written.written.has("dimension")) {
		const dimension = readDimension(section("dimension"))
		const used = usedRange(sheet)

		if (dimension === null || (used !== null && !contains(dimension, used)))
			fail("model", `${name}: the dimension does not cover the cells`)
	}
}

// --- Workbook ---

const SHEET_NAME_INVALID = /[[\]:*?/\\]/

// The source's sheet records: each name by relationship id, and how many sheets share each name (lower case) and
// each sheetId.
interface SourceSheets {
	readonly byRelationship: ReadonlyMap<string, string>
	readonly names: ReadonlyMap<string, number>
	readonly ids: ReadonlyMap<number, number>
}

function sourceSheets(written: WrittenWorkbook, id: string): SourceSheets {
	const byRelationship = new Map<string, string>()
	const names = new Map<string, number>()
	const ids = new Map<number, number>()

	if (written.sourceSheets === null) return { byRelationship, names, ids }

	const document = parseXml(written.sourceSheets)

	for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node)) {
		if (document.localName(node) !== "sheet") continue

		const sheetName = document.attribute(node, "name") ?? ""
		const sheetId = Number(document.attribute(node, "sheetId") ?? Number.NaN)
		const relationship = document.attribute(node, id)

		if (relationship !== undefined) byRelationship.set(relationship, sheetName)

		names.set(sheetName.toLowerCase(), (names.get(sheetName.toLowerCase()) ?? 0) + 1)
		ids.set(sheetId, (ids.get(sheetId) ?? 0) + 1)
	}

	return { byRelationship, names, ids }
}

function checkWorkbook(draft: XlsxDraft, workbookRelationships: Relationships): void {
	const written = draft.workbook

	if (written === null) return

	const workbook = draft.input.workbook
	const name = workbook.workbookPart
	const document = parseChecked(name, written.bytes)

	if (orderInversions(written.names, WORKBOOK) > orderInversions(written.sourceNames, WORKBOOK))
		fail("elementOrder", `${name}: sections out of schema order`)

	checkSectionCounts(name, written.names, written.sourceNames, written.written)

	const root = document.documentElement()
	const id = relationshipIdName(written.context)
	const sheets = childElement(document, root, "sheets")
	const read: { name: string; sheetId: number; state: string; id: string }[] = []

	for (let node = sheets < 0 ? -1 : document.firstChildElement(sheets); node >= 0; node = document.nextSiblingElement(node)) {
		if (document.localName(node) !== "sheet") continue

		read.push({
			name: document.attribute(node, "name") ?? "",
			sheetId: Number(document.attribute(node, "sheetId") ?? Number.NaN),
			state: document.attribute(node, "state") ?? "visible",
			id: document.attribute(node, id) ?? ""
		})
	}

	if (read.length !== workbook.sheets.length || read.length === 0)
		fail("model", `${name}: ${read.length} sheets read back, not ${workbook.sheets.length}`)

	const names = new Map<string, number>()
	const ids = new Map<number, number>()
	let source: SourceSheets | null = null
	const held = (): SourceSheets => (source ??= sourceSheets(written, id))

	workbook.sheets.forEach((sheet, index) => {
		const back = read[index]

		if (
			back === undefined ||
			back.name !== sheet.name ||
			back.sheetId !== sheet.sheetId ||
			back.state !== sheet.state ||
			back.id !== sheet.relationshipId
		) {
			fail("model", `${name}: sheet ${sheet.name} reads back differently`)
		}

		const key = sheet.name.toLowerCase()
		const sameName = (names.get(key) ?? 0) + 1
		const sameId = (ids.get(sheet.sheetId) ?? 0) + 1

		names.set(key, sameName)
		ids.set(sheet.sheetId, sameId)

		// What the source already had (a name it gave this sheet, a name or sheetId as often shared) is the file's,
		// kept as written; the source is read only for a sheet that fails.
		if (
			(sheet.name === "" ||
				sheet.name.length > 31 ||
				SHEET_NAME_INVALID.test(sheet.name) ||
				sheet.name.startsWith("'") ||
				sheet.name.endsWith("'")) &&
			held().byRelationship.get(sheet.relationshipId) !== sheet.name
		) {
			fail("reference", `${name}: the sheet name "${sheet.name}" is not valid`)
		}

		if ((sameName > 1 && sameName > (held().names.get(key) ?? 0)) || (sameId > 1 && sameId > (held().ids.get(sheet.sheetId) ?? 0)))
			fail("reference", `${name}: two sheets share the name ${sheet.name} or sheetId ${sheet.sheetId}`)

		const target = workbookRelationships.byId(sheet.relationshipId)

		if (
			sheet.part !== "" &&
			(target === undefined || target.partName === undefined || partKey(target.partName) !== partKey(sheet.part))
		) {
			fail("relationship", `${name}: sheet ${sheet.name} does not relate to ${sheet.part}`)
		}
	})

	if (written.written.has("definedNames") || (written.sourceNames.includes("definedNames") && !written.names.includes("definedNames"))) {
		const container = childElement(document, root, "definedNames")
		const back: { name: string; local: number; formula: string; hidden: boolean }[] = []

		for (let node = container < 0 ? -1 : document.firstChildElement(container); node >= 0; node = document.nextSiblingElement(node)) {
			if (document.localName(node) !== "definedName") continue

			const local = document.attribute(node, "localSheetId")

			back.push({
				name: document.attribute(node, "name") ?? "",
				local: local === undefined ? -1 : Number(local),
				formula: document.textContent(node),
				hidden: readBoolean(document.attribute(node, "hidden"), false)
			})
		}

		const index = new Map(workbook.sheets.map((sheet, position) => [sheet.id, position]))

		if (back.length !== workbook.definedNames.length)
			fail("model", `${name}: ${back.length} defined names read back, not ${workbook.definedNames.length}`)

		workbook.definedNames.forEach((defined, k) => {
			const other = back[k]
			const local = defined.sheet === null ? -1 : (index.get(defined.sheet) ?? -2)

			if (
				other === undefined ||
				other.name !== defined.name ||
				other.local !== local ||
				other.formula !== defined.formula ||
				other.hidden !== defined.hidden
			) {
				fail("model", `${name}: the name ${defined.name} reads back differently`)
			}

			if (other.local >= workbook.sheets.length)
				fail("reference", `${name}: the name ${defined.name} belongs to sheet ${other.local}`)
		})
	}

	const calc = childElement(document, root, "calcPr")

	if (workbook.changes.fullCalcOnLoad && (calc < 0 || !readBoolean(document.attribute(calc, "fullCalcOnLoad"), false))) {
		fail("model", `${name}: fullCalcOnLoad is not set`)
	}

	const views = childElement(document, root, "bookViews")
	const view = views < 0 ? -1 : childElement(document, views, "workbookView")

	if (view >= 0) {
		const active = Number(document.attribute(view, "activeTab") ?? 0)
		const first = Number(document.attribute(view, "firstSheet") ?? 0)

		if (!(active >= 0 && active < workbook.sheets.length && first >= 0 && first < workbook.sheets.length)) {
			fail("reference", `${name}: the active or first tab is not a sheet`)
		}
	}
}

// --- Shared strings and styles ---

function readRuns(document: XmlDocument, node: number): { text: string; runs: XlsxRichRun[] | null } {
	let text = ""
	let runs: XlsxRichRun[] | null = null

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "t") {
			text += document.textContent(child)
		} else if (local === "r") {
			const t = childElement(document, child, "t")
			const properties = childElement(document, child, "rPr")
			const runText = t < 0 ? "" : document.textContent(t)

			runs ??= []
			runs.push({ text: runText, font: properties < 0 ? null : readFont(document, properties) })
			text += runText
		}
	}

	return { text, runs }
}

function checkSharedStrings(draft: XlsxDraft): void {
	const written = draft.sharedStrings

	if (written === null) return

	const strings = draft.input.workbook.sharedStrings
	const name = written.part
	const document = parseChecked(name, join([written.root, written.appended, closeTag(written.root)]))
	const root = document.documentElement()
	const unique = document.attribute(root, "uniqueCount")
	const count = document.attribute(root, "count")

	if (unique !== undefined && Number(unique) !== written.length)
		fail("model", `${name}: uniqueCount ${unique}, ${written.length} entries`)
	if (count !== undefined && Number(count) !== Math.max(0, Math.max(0, strings.sourceCount) + strings.referenceDelta))
		fail("model", `${name}: count ${count} is not the model's`)

	// The entries parsed here are the appended ones written, the first of them the first the model appended.
	let index = written.length - countEntries(document, root)

	if (written.length > strings.length || index !== Math.min(strings.sourceLength, written.length))
		fail("model", `${name}: ${countEntries(document, root)} entries appended to ${strings.sourceLength}, ${written.length} written`)

	if (index < 0) fail("model", `${name}: more entries were written than appended`)

	for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
		if (document.localName(node) !== "si") continue

		const { text, runs } = readRuns(document, node)
		const model = strings.runs(index)

		if (text !== strings.text(index)) fail("model", `${name}: entry ${index} reads back differently`)
		if ((runs === null) !== (model === null || model.length === 0)) fail("model", `${name}: entry ${index} reads back with other runs`)

		if (runs !== null && model !== null) {
			if (runs.length !== model.length) fail("model", `${name}: entry ${index} reads back with other runs`)

			runs.forEach((run, k) => {
				const other = model[k]

				if (other === undefined || other.text !== run.text || !sameFont(other.font, run.font))
					fail("model", `${name}: entry ${index} run ${k} reads back differently`)
			})
		}

		index++
	}
}

function countEntries(document: XmlDocument, root: number): number {
	let count = 0

	for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node))
		if (document.localName(node) === "si") count++

	return count
}

const BUILT_IN_NUMBER_FORMATS = 164

// The written styles part, walked (never parsed whole: it can hold megabytes of cell formats) in slices: its
// containers in schema order, each holding as many records as the model, with the right count where the save
// appended; the appended records parsed and read back against the model; number formats read from their tags.
async function checkStyles(draft: XlsxDraft, clock: SliceClock | undefined): Promise<void> {
	const written = draft.styles

	if (written === null) return

	try {
		await checkStylesPart(draft.input.workbook.styles, written.extent, written.part, written.bytes, clock)
	} catch (error) {
		if (error instanceof XlsxReadError) fail("malformedPart", `${written.part}: ${error.message}`)

		throw error
	}
}

async function checkStylesPart(
	styles: XlsxStyleTable,
	extent: StylesExtent,
	name: string,
	bytes: Uint8Array,
	clock: SliceClock | undefined
): Promise<void> {
	const { tag: root } = rootTag(bytes)
	const scanner = new Scanner(bytes, name)
	const containers = new Map<string, { readonly start: number; readonly end: number }>()
	const children: string[] = []

	if (!root.selfClosing) {
		const close = await eachChild(scanner, root.start, root.end, clock, (start, end) => {
			const tag = scanTag(bytes, start)

			if (tag === undefined) return fail("malformedPart", `${name}: no element at ${start}`)

			const qualified = decodeUtf8(bytes, start + 1, tag.nameEnd)
			const local = qualified.slice(qualified.indexOf(":") + 1)

			children.push(local)

			if (!containers.has(local)) containers.set(local, { start, end })
		})

		if (bytes.indexOf(62, close) < 0) fail("malformedPart", `${name}: the root is not closed`)
	}

	if (orderInversions(children, STYLESHEET) > 0) fail("elementOrder", `${name}: containers out of schema order`)

	const rootOpen = bytes.subarray(root.start, root.end)

	// A container's records: how many, and where record `from` starts (its end tag when it has fewer). With
	// `appended` (the save added to it) its count must be right; a source's wrong count elsewhere stays as it was.
	const records = async (
		container: string,
		appended: boolean,
		from: number
	): Promise<{ count: number; first: number; close: number }> => {
		const span = containers.get(container)
		const tag = span === undefined ? undefined : scanTag(bytes, span.start)

		if (span === undefined || tag === undefined || tag.selfClosing) return { count: 0, first: -1, close: -1 }

		let count = 0
		let first = -1
		const close = await eachChild(scanner, span.start, tag.end, clock, start => {
			if (count === from) first = start

			count++
		})
		const at = findAttribute(bytes, tag, "count")
		const declared = at < 0 ? undefined : decodeCharacterData(bytes, tag.attributes[at + 2] ?? 0, tag.attributes[at + 3] ?? 0, true)

		if (appended && declared !== undefined && Number(declared) !== count)
			fail("model", `${name}: ${container} count ${declared}, ${count} records`)

		return { count, first: first < 0 ? close : first, close }
	}

	// Records [from, ...) of a container, parsed on their own under the root's start tag (its namespaces).
	const parsedFrom = (first: number, close: number): { document: XmlDocument; nodes: number[] } => {
		const document = parseChecked(name, join([rootOpen, bytes.subarray(first, close), closeTag(rootOpen)]))
		const nodes: number[] = []

		for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node))
			nodes.push(node)

		return { document, nodes }
	}

	const compare = async <T>(
		container: string,
		model: readonly T[],
		from: number,
		read: (document: XmlDocument, node: number) => T,
		same: (a: T, b: T) => boolean
	): Promise<void> => {
		const found = await records(container, model.length > from, from)

		if (found.count !== model.length) fail("model", `${name}: ${found.count} ${container}, the model has ${model.length}`)
		if (model.length <= from) return

		const { document, nodes } = parsedFrom(found.first, found.close)

		if (nodes.length !== model.length - from) fail("model", `${name}: ${container} reads back with another number of records`)

		for (let k = from; k < model.length; k++) {
			if (!same(read(document, nodes[k - from] as number), model[k] as T))
				fail("model", `${name}: ${container} ${k} reads back differently`)
		}
	}

	const counts = styles.sourceCounts
	// Cells without a format use cell format 0: in a workbook that had none, the first records written must be the
	// implied defaults, or every such cell takes an edit's format (seedImpliedStyles).
	if (
		counts.cellXfs === 0 &&
		styles.cellXfs.length > 0 &&
		(!sameXf(styles.cellXfs[0], IMPLIED_XF) ||
			(counts.fonts === 0 && !sameFont(styles.fonts[0], IMPLIED_FONT)) ||
			(counts.fills === 0 && !IMPLIED_FILLS.every((fill, k) => sameFill(styles.fills[k], fill))) ||
			(counts.borders === 0 && !sameBorder(styles.borders[0], IMPLIED_BORDER)))
	) {
		fail("model", `${name}: the first records are not the defaults the workbook implied`)
	}

	await compare("fonts", styles.fonts.slice(0, extent.fonts), counts.fonts, readFont, sameFont)
	await compare("fills", styles.fills.slice(0, extent.fills), counts.fills, readFill, sameFill)
	await compare("borders", styles.borders.slice(0, extent.borders), counts.borders, readBorder, sameBorder)
	await compare(
		"cellXfs",
		styles.cellXfs.slice(0, extent.cellXfs),
		counts.cellXfs,
		(document, node) => readXf(document, node, false),
		sameXf
	)
	await compare("dxfs", styles.dxfs.slice(0, extent.dxfs), counts.dxfs, readDxf, sameDxf)

	// Number formats, from their tags.
	const formats = new Map<number, string>()
	const numFmts = containers.get("numFmts")
	const numFmtsTag = numFmts === undefined ? undefined : scanTag(bytes, numFmts.start)

	await records("numFmts", extent.numFmts.size > 0, 0)

	if (numFmts !== undefined && numFmtsTag !== undefined && !numFmtsTag.selfClosing) {
		await eachChild(scanner, numFmts.start, numFmtsTag.end, clock, start => {
			const tag = scanTag(bytes, start)

			if (tag === undefined) return

			const value = (attribute: string): string | undefined => {
				const at = findAttribute(bytes, tag, attribute)

				return at < 0 ? undefined : decodeCharacterData(bytes, tag.attributes[at + 2] ?? 0, tag.attributes[at + 3] ?? 0, true)
			}

			formats.set(Number(value("numFmtId")), value("formatCode") ?? "")
		})
	}

	// Every format the part holds is the model's; every one a written format uses is there.
	for (const [id, code] of formats)
		if (styles.numFmts.get(id) !== code) fail("model", `${name}: number format ${id} reads back differently`)
	for (const id of extent.numFmts) if (!formats.has(id)) fail("model", `${name}: number format ${id} was not written`)

	// What the part holds (a new part gets a default cell style record the model may lack).
	const cellStyleXfs = (await records("cellStyleXfs", false, 0)).count

	for (let k = counts.cellXfs; k < extent.cellXfs; k++) {
		const xf = styles.cellXfs[k]

		if (
			xf === undefined ||
			xf.fontId >= extent.fonts ||
			xf.fillId >= extent.fills ||
			xf.borderId >= extent.borders ||
			xf.xfId >= cellStyleXfs ||
			(xf.numFmtId >= BUILT_IN_NUMBER_FORMATS && !formats.has(xf.numFmtId))
		) {
			fail("reference", `${name}: cell format ${k} refers to a record that does not exist`)
		}
	}
}

// --- Relationships and content types ---

async function checkRelationships(draft: XlsxDraft, outcome: Outcome): Promise<void> {
	for (const [name, bytes] of draft.relationships) {
		const document = parseChecked(name, bytes)
		const seen = new Set<string>()

		for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node)) {
			const id = document.attribute(node, "Id") ?? ""

			if (seen.has(id)) fail("relationship", `${name}: relationship ${id} twice`)

			seen.add(id)
		}

		const source = name.replace(/(^|\/)_rels\/([^/]*)\.rels$/, "$1$2")
		const opc = draft.input.opc
		// A relationship the source part already had to a part its package lacked is the source's, kept as written.
		const before = opc.has(name) ? await opc.relationships(source) : undefined
		const inherited = (id: string, part: string): boolean => {
			const was = before?.byId(id)

			return (
				was !== undefined &&
				!was.external &&
				was.partName !== undefined &&
				partKey(was.partName) === partKey(part) &&
				!opc.has(part)
			)
		}

		for (const relationship of parseRelationships(bytes, source).all) {
			if (
				!relationship.external &&
				relationship.partName !== undefined &&
				!outcome.has(relationship.partName) &&
				!inherited(relationship.id, relationship.partName)
			) {
				fail("relationship", `${name}: ${relationship.id} targets ${relationship.partName}, which is not in the package`)
			}
		}
	}

	if (draft.remove.length === 0) return

	// Nothing left may point at a removed part.
	const opc = draft.input.opc

	for (const entry of opc.zip.entries) {
		if (!entry.name.endsWith(".rels") || draft.relationships.has(entry.name) || outcome.isRemoved(entry.name)) continue

		const source = entry.name.replace(/(^|\/)_rels\/([^/]*)\.rels$/, "$1$2")

		if (source !== "" && !outcome.has(source)) continue

		for (const relationship of (await opc.relationships(source)).all) {
			if (!relationship.external && relationship.partName !== undefined && outcome.isRemoved(relationship.partName)) {
				fail("relationship", `${entry.name}: ${relationship.id} targets the removed ${relationship.partName}`)
			}
		}
	}
}

async function checkContentTypes(draft: XlsxDraft): Promise<void> {
	if (draft.contentTypes !== null) parseChecked(CONTENT_TYPES_PART, draft.contentTypes)

	const types = parseContentTypes(draft.contentTypes ?? (await draft.input.opc.read(CONTENT_TYPES_PART)))

	for (const change of draft.add) if (types.typeOf(change.name) === undefined) fail("contentType", `${change.name} has no content type`)
	for (const sheet of draft.sheets)
		if (!SHEET_CONTENT_TYPES.has(types.typeOf(sheet.part)?.toLowerCase() ?? ""))
			fail("contentType", `Sheet ${sheet.entry.name} is written to ${sheet.part}, which is not typed as a sheet`)
	for (const name of draft.remove)
		if (types.overrides.has(partKey(name))) fail("contentType", `${name} was removed but keeps its override`)
	for (const [name, other] of draft.others)
		if (types.typeOf(name) !== other.contentType) fail("contentType", `${name} is not typed ${other.contentType}`)
}

function isXml(contentType: string): boolean {
	return contentType.endsWith("+xml") || contentType.endsWith("/xml")
}

export async function verifyXlsxParts(draft: XlsxDraft, clock?: SliceClock): Promise<void> {
	const outcome = new Outcome(draft)
	const workbook = draft.input.workbook

	for (const sheet of draft.sheets) {
		await checkSheet(sheet, draft, outcome, clock)

		if (clock?.due === true) await clock.pause()
	}

	const workbookRelationships = await outcome.relationships(workbook.workbookPart)

	checkWorkbook(draft, workbookRelationships)

	// Every sheet relates to a part that is there (a sheet whose part the source lacked stays so), its own.
	const sheetParts = new Set<string>()

	for (const sheet of workbook.sheets) {
		if (sheet.part !== "") {
			const key = partKey(sheet.part)

			if (sheetParts.has(key)) fail("relationship", `Sheet ${sheet.name} shares its part ${sheet.part} with another sheet`)

			sheetParts.add(key)
		}

		if (sheet.part !== "" && !outcome.has(sheet.part) && (draft.input.opc.has(sheet.part) || sheet.model !== null)) {
			fail("relationship", `Sheet ${sheet.name} has no part ${sheet.part}`)
		}
	}

	checkSharedStrings(draft)
	await checkStyles(draft, clock)
	await checkRelationships(draft, outcome)
	await checkContentTypes(draft)

	for (const [name, other] of draft.others) if (isXml(other.contentType)) parseChecked(name, await joinBytes(other.bytes))

	if (draft.calcChain !== null) {
		for (const relationship of workbookRelationships.all) {
			if (relationship.partName !== undefined && partKey(relationship.partName) === partKey(draft.calcChain)) {
				fail("relationship", `${workbook.workbookPart} still relates to ${draft.calcChain}`)
			}
		}
	}
}

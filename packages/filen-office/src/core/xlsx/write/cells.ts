import { decodeCharacterData, decodeUtf8, encodeUtf8, escapeText, parseXml, type XmlDocument } from "../../xml/index"
import type { SheetRange } from "../../sheet/protocol"
import {
	CellKind,
	FormulaFlag,
	FormulaKind,
	CARRIED,
	NO_SPAN,
	RowFlag,
	ROW_MARKS,
	blockOrigin,
	type XlsxSourceCell,
	type XlsxFormula,
	type XlsxRowBlock,
	type XlsxSheetModel,
	type XlsxSheetStrings
} from "../model/types"
import { parseNumber } from "../read/scan"
import { XlsxWriteError } from "./failure"
import {
	ByteBuilder,
	Pieces,
	attr,
	findAttribute,
	onlySpace,
	qualify,
	rootTag,
	scanReference,
	scanTag,
	spells,
	type ScannedTag
} from "./markup"
import { cellRef, formatNumber, parseCellRef, parseRangeRef, rangeRef, readBoolean } from "./text"

// <sheetData> as the splice writer emits it: rows nothing touched are their source bytes (runs of them one
// view), a row that only moved has its r attributes rewritten, and a changed row is serialised from the store
// with every cell equal to its source copied as written. The same row decoding reads rows back for the gate.

const ROW_ATTRIBUTES = [
	"r",
	"spans",
	"s",
	"customFormat",
	"ht",
	"hidden",
	"customHeight",
	"outlineLevel",
	"collapsed",
	"thickTop",
	"thickBot"
] as const
const CELL_ATTRIBUTES = ["r", "s", "t", "cm", "vm"] as const
// Cell kinds with their text in the sheet's strings.
const TEXT_KINDS: ReadonlySet<number> = new Set<number>([CellKind.INLINE_STRING, CellKind.FORMULA_STRING, CellKind.ERROR, CellKind.DATE])
const TYPES: Readonly<Record<number, string>> = {
	[CellKind.SHARED_STRING]: "s",
	[CellKind.INLINE_STRING]: "inlineStr",
	[CellKind.FORMULA_STRING]: "str",
	[CellKind.BOOLEAN]: "b",
	[CellKind.ERROR]: "e",
	[CellKind.DATE]: "d"
}
const FORMULA_FLAGS: readonly (readonly [string, number])[] = [
	["aca", FormulaFlag.ALWAYS_ARRAY],
	["dt2D", FormulaFlag.TWO_D],
	["dtr", FormulaFlag.ROW_INPUT],
	["del1", FormulaFlag.DELETED_1],
	["del2", FormulaFlag.DELETED_2],
	["ca", FormulaFlag.ALWAYS],
	["bx", FormulaFlag.ASSIGNS_NAME]
]
const FORMULA_TYPES: Readonly<Record<number, string>> = {
	[FormulaKind.SHARED_MASTER]: "shared",
	[FormulaKind.SHARED_CHILD]: "shared",
	[FormulaKind.ARRAY]: "array",
	[FormulaKind.DATA_TABLE]: "dataTable"
}
const UNREADABLE = -1

export interface DecodedFormula {
	readonly kind: FormulaKind
	readonly text: string
	readonly sharedIndex: number
	readonly ref: SheetRange | null
	readonly flags: number
	readonly r1: string | undefined
	readonly r2: string | undefined
}

export interface DecodedCell {
	// Absolute offsets of the element in the part.
	readonly start: number
	readonly end: number
	// From r, else implied by position; -1 when r names another row.
	readonly col: number
	// r's value span, or null without r.
	readonly r: readonly [number, number] | null
	// Whether r names the cell; without (r absent, or no reference such as "B") its column is implied by the cell
	// before it, so it is copied as written only while that cell is.
	readonly named: boolean
	readonly style: number
	// A CellKind, or UNREADABLE.
	readonly kind: number
	readonly number: number
	readonly text: string
	readonly formula: DecodedFormula | null
	readonly cm: number
	readonly vm: boolean
	// Attributes the store does not hold (ph, extensions): absolute [from, to) of each, kept on a rewrite.
	readonly kept: readonly number[]
	// Children the store does not hold (extLst): absolute [from, to) of each.
	readonly children: readonly number[]
	// The <f>, <v> and <is> elements, absolute [from, to), or null: copied as written while what they hold is the
	// store's.
	readonly formulaSpan: readonly [number, number] | null
	readonly valueSpan: readonly [number, number] | null
	readonly inlineSpan: readonly [number, number] | null
}

export interface DecodedRow {
	readonly start: number
	readonly end: number
	readonly tag: ScannedTag
	// From r, else -1.
	readonly row: number
	readonly height: number
	readonly style: number
	// RowFlag bits without DIRTY and NEW.
	readonly flags: number
	readonly spans: string | undefined
	readonly cells: readonly DecodedCell[]
	// Attributes and children the store does not hold, absolute [from, to) pairs.
	readonly kept: readonly number[]
	readonly children: readonly number[]
}

function number(text: string | undefined, fallback: number): number {
	if (text === undefined || text.trim() === "") return fallback

	const value = Number(text)

	return Number.isFinite(value) ? value : fallback
}

const NO_SPANS: readonly number[] = []

// Whether the bytes [start, end) are the ASCII name `name`.
function isName(bytes: Uint8Array, start: number, end: number, name: string): boolean {
	if (end - start !== name.length) return false

	for (let i = 0; i < name.length; i++) if (bytes[start + i] !== name.charCodeAt(i)) return false

	return true
}

// The start tag's attributes named in `names`: their raw value spans into `spans` by index (document offsets, -1
// when absent); the others' absolute [from, to) spans are returned (kept on a rewrite). Names are matched on their
// bytes and nothing is decoded: a value is read from its span when it is needed (valueAt, intAt).
function knownAttributes(
	document: XmlDocument,
	node: number,
	base: number,
	names: readonly string[],
	spans: Int32Array
): readonly number[] {
	const all = document.attributeSpans(node)
	const bytes = document.bytes
	let kept: number[] | null = null

	spans.fill(-1)

	for (let k = 0; k < all.length; k += 4) {
		const nameStart = all[k] ?? 0
		const nameEnd = all[k + 1] ?? 0
		let known = -1

		for (let n = 0; n < names.length; n++) {
			if (isName(bytes, nameStart, nameEnd, names[n] ?? "")) {
				known = n
				break
			}
		}

		if (known < 0) {
			kept ??= []
			kept.push(base + nameStart, base + (all[k + 3] ?? 0) + 1)

			continue
		}

		spans[known * 2] = all[k + 2] ?? 0
		spans[known * 2 + 1] = all[k + 3] ?? 0
	}

	return kept ?? NO_SPANS
}

// The decoded value of the attribute at `index` of `spans`, or undefined when absent.
function valueAt(bytes: Uint8Array, spans: Int32Array, index: number): string | undefined {
	const start = spans[index * 2] ?? -1

	return start < 0 ? undefined : decodeCharacterData(bytes, start, spans[index * 2 + 1] ?? 0, true)
}

// number() of the attribute at `index`: plain digits read from the bytes, anything else decoded first.
function intAt(bytes: Uint8Array, spans: Int32Array, index: number, fallback: number): number {
	const start = spans[index * 2] ?? -1

	if (start < 0) return fallback

	const end = spans[index * 2 + 1] ?? 0

	if (end > start && end - start <= 9) {
		let value = 0
		let i = start

		for (; i < end; i++) {
			const b = bytes[i] ?? 0

			if (b < 48 || b > 57) break

			value = value * 10 + (b - 48)
		}

		if (i === end) return value
	}

	return number(valueAt(bytes, spans, index), fallback)
}

// The cell types ECMA-376 names (§18.18.11), matched on their bytes.
const CELL_TYPES = ["n", "s", "str", "b", "e", "inlineStr", "d"] as const

function typeAt(bytes: Uint8Array, spans: Int32Array, index: number): string | undefined {
	const start = spans[index * 2] ?? -1

	if (start < 0) return undefined

	const end = spans[index * 2 + 1] ?? 0

	for (const type of CELL_TYPES) if (isName(bytes, start, end, type)) return type

	return valueAt(bytes, spans, index)
}

// parseCellRef of an attribute's raw value: the plain "A1" form read from its bytes, anything else (entities,
// "$") through parseCellRef.
function cellRefAt(
	bytes: Uint8Array,
	start: number,
	end: number,
	spans: Int32Array,
	index: number
): { readonly row: number; readonly col: number } | undefined {
	let i = start
	let col = 0

	while (i < end && i - start < 3) {
		const b = bytes[i] ?? 0
		const upper = b >= 97 && b <= 122 ? b - 32 : b

		if (upper < 65 || upper > 90) break

		col = col * 26 + (upper - 64)
		i++
	}

	const letters = i - start
	let row = 0

	while (i < end && i - start - letters < 7) {
		const b = bytes[i] ?? 0

		if (b < 48 || b > 57) break

		row = row * 10 + (b - 48)
		i++
	}

	if (letters === 0 || i === start + letters || i !== end) return parseCellRef(valueAt(bytes, spans, index) ?? "")

	return row >= 1 ? { row: row - 1, col: col - 1 } : undefined
}

const cellSpans = new Int32Array(CELL_ATTRIBUTES.length * 2)
const rowSpans = new Int32Array(ROW_ATTRIBUTES.length * 2)
const A = CELL_ATTRIBUTES.indexOf("r")
const S = CELL_ATTRIBUTES.indexOf("s")
const T = CELL_ATTRIBUTES.indexOf("t")
const CM = CELL_ATTRIBUTES.indexOf("cm")
const VM = CELL_ATTRIBUTES.indexOf("vm")

// The current row's attribute (decodeRowElement's scratch).
let rowBytes: Uint8Array = new Uint8Array(0)

function rowValue(name: (typeof ROW_ATTRIBUTES)[number]): string | undefined {
	return valueAt(rowBytes, rowSpans, ROW_ATTRIBUTES.indexOf(name))
}

function decodeFormula(document: XmlDocument, node: number): DecodedFormula {
	const type = document.attribute(node, "t") ?? "normal"
	const ref = document.attribute(node, "ref")
	let flags = 0

	for (const [name, bit] of FORMULA_FLAGS) if (readBoolean(document.attribute(node, name), false)) flags |= bit

	const kind =
		type === "shared"
			? ref !== undefined
				? FormulaKind.SHARED_MASTER
				: FormulaKind.SHARED_CHILD
			: type === "array"
				? FormulaKind.ARRAY
				: type === "dataTable"
					? FormulaKind.DATA_TABLE
					: FormulaKind.NORMAL

	return {
		kind,
		text: document.textContent(node),
		sharedIndex: number(document.attribute(node, "si"), -1),
		ref: ref === undefined ? null : (parseRangeRef(ref) ?? { startRow: -1, startCol: -1, endRow: -1, endCol: -1 }),
		flags,
		r1: document.attribute(node, "r1"),
		r2: document.attribute(node, "r2")
	}
}

function inlineText(document: XmlDocument, node: number): string {
	let text = ""

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "t") {
			text += document.textContent(child)
		} else if (local === "r") {
			for (let run = document.firstChildElement(child); run >= 0; run = document.nextSiblingElement(run)) {
				if (document.localName(run) === "t") text += document.textContent(run)
			}
		}
	}

	return text
}

function decodeCell(document: XmlDocument, node: number, base: number, row: number, implied: number): DecodedCell {
	const bytes = document.bytes
	const kept = knownAttributes(document, node, base, CELL_ATTRIBUTES, cellSpans)
	const type = typeAt(bytes, cellSpans, T) ?? "n"
	const style = intAt(bytes, cellSpans, S, 0)
	const cm = intAt(bytes, cellSpans, CM, -1)
	const vm = (cellSpans[VM * 2] ?? -1) >= 0
	const rStart = cellSpans[A * 2] ?? -1
	const rEnd = cellSpans[A * 2 + 1] ?? 0
	const at = rStart < 0 ? undefined : cellRefAt(bytes, rStart, rEnd, cellSpans, A)
	let formula: DecodedFormula | null = null
	let value: string | undefined
	let inline: string | undefined
	let formulaSpan: [number, number] | null = null
	let valueSpan: [number, number] | null = null
	let inlineSpan: [number, number] | null = null
	const children: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "f") {
			formula = decodeFormula(document, child)
			formulaSpan = [base + document.start(child), base + document.end(child)]
		} else if (local === "v") {
			value = document.textContent(child)
			valueSpan = [base + document.start(child), base + document.end(child)]
		} else if (local === "is") {
			inline = inlineText(document, child)
			inlineSpan = [base + document.start(child), base + document.end(child)]
		} else {
			children.push(base + document.start(child), base + document.end(child))
		}
	}

	let kind: number = CellKind.EMPTY
	let numeric = 0
	let text = ""

	if (type === "inlineStr") {
		if (inline !== undefined) {
			kind = CellKind.INLINE_STRING
			text = inline
		}
	} else if (value !== undefined) {
		switch (type) {
			case "s":
				kind = /^\s*\d+\s*$/.test(value) ? CellKind.SHARED_STRING : UNREADABLE
				numeric = Number(value)
				break
			case "str":
				kind = CellKind.FORMULA_STRING
				text = value
				break
			case "b":
				kind = CellKind.BOOLEAN
				numeric = readBoolean(value.trim(), false) ? 1 : 0
				break
			case "e":
				kind = CellKind.ERROR
				text = value
				break
			case "d":
				kind = CellKind.DATE
				text = value
				break
			case "n":
				numeric = number(value, Number.NaN)
				kind = Number.isNaN(numeric) ? UNREADABLE : CellKind.NUMBER
				break
			default:
				kind = UNREADABLE
		}
	}

	return {
		start: base + document.start(node),
		end: base + document.end(node),
		col: at === undefined ? implied : row >= 0 && at.row !== row ? -1 : at.col,
		r: rStart < 0 ? null : [base + rStart, base + rEnd],
		named: at !== undefined,
		style,
		kind,
		number: numeric,
		text,
		formula,
		cm,
		vm,
		kept,
		children,
		formulaSpan,
		valueSpan,
		inlineSpan
	}
}

// One <row> element at [start, end) of `bytes`, read independently of the model's reader.
export function decodeRow(bytes: Uint8Array, start: number, end: number): DecodedRow {
	const document = parseXml(bytes.subarray(start, end))
	const root = document.documentElement()
	const tag = scanTag(bytes, start)

	if (tag === undefined || document.localName(root) !== "row") throw new XlsxWriteError("malformedPart", `No row at ${start}`)

	return decodeRowElement(document, root, start, end, tag)
}

// A <row> element of a parsed document; `start` is the offset of the document's bytes in the part.
export function decodeRowElement(document: XmlDocument, root: number, start: number, end: number, tag: ScannedTag): DecodedRow {
	const kept = knownAttributes(document, root, start, ROW_ATTRIBUTES, rowSpans)

	rowBytes = document.bytes

	const rowNumber = number(rowValue("r"), 0)
	const row = rowNumber >= 1 ? rowNumber - 1 : -1
	const outline = number(rowValue("outlineLevel"), 0)
	let flags = (Math.max(0, Math.min(7, outline)) << RowFlag.OUTLINE_SHIFT) & RowFlag.OUTLINE_MASK

	if (readBoolean(rowValue("hidden"), false)) flags |= RowFlag.HIDDEN
	if (readBoolean(rowValue("customHeight"), false)) flags |= RowFlag.CUSTOM_HEIGHT
	if (readBoolean(rowValue("customFormat"), false)) flags |= RowFlag.CUSTOM_FORMAT
	if (readBoolean(rowValue("collapsed"), false)) flags |= RowFlag.COLLAPSED
	if (readBoolean(rowValue("thickTop"), false)) flags |= RowFlag.THICK_TOP
	if (readBoolean(rowValue("thickBot"), false)) flags |= RowFlag.THICK_BOTTOM

	const cells: DecodedCell[] = []
	const children: number[] = []
	let implied = 0

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) !== "c") {
			children.push(start + document.start(child), start + document.end(child))

			continue
		}

		const cell = decodeCell(document, child, start, row, implied)

		cells.push(cell)
		implied = cell.col + 1
	}

	return {
		start,
		end,
		tag,
		row,
		height: number(rowValue("ht"), Number.NaN),
		style: number(rowValue("s"), -1),
		flags,
		spans: rowValue("spans"),
		cells,
		kept,
		children
	}
}

// --- Comparison with the store ---

function sameRange(a: SheetRange | null, b: SheetRange | null): boolean {
	if (a === null || b === null) return a === b

	return a.startRow === b.startRow && a.startCol === b.startCol && a.endRow === b.endRow && a.endCol === b.endCol
}

export function sameFormula(decoded: DecodedFormula | null, cm: number, formula: XlsxFormula | null): boolean {
	if (decoded === null || formula === null) return decoded === null && formula === null && cm < 0

	return (
		decoded.kind === formula.kind &&
		decoded.text === formula.text &&
		decoded.sharedIndex === formula.sharedIndex &&
		sameRange(decoded.ref, formula.ref) &&
		decoded.flags === formula.flags &&
		cm === formula.cellMetadata &&
		decoded.r1 === formula.r1 &&
		decoded.r2 === formula.r2
	)
}

export function sameValue(cell: DecodedCell, kind: number, value: number, strings: XlsxSheetStrings): boolean {
	if (cell.kind !== kind) return false
	if (kind === CellKind.EMPTY) return true
	if (TEXT_KINDS.has(kind)) return cell.text === strings.text(value)

	return cell.number === value
}

export function sameRowProperties(row: DecodedRow, height: number, style: number, flags: number): boolean {
	return (Number.isNaN(row.height) ? Number.isNaN(height) : row.height === height) && row.style === style && row.flags === flags
}

// --- Serialisation ---

interface Names {
	readonly row: string
	readonly c: string
	readonly f: string
	readonly v: string
	readonly is: string
	readonly t: string
}

function names(prefix: string): Names {
	return {
		row: qualify(prefix, "row"),
		c: qualify(prefix, "c"),
		f: qualify(prefix, "f"),
		v: qualify(prefix, "v"),
		is: qualify(prefix, "is"),
		t: qualify(prefix, "t")
	}
}

function preserved(text: string): string {
	return text.length > 0 && /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ""
}

function writeFormula(out: ByteBuilder, n: Names, formula: XlsxFormula): void {
	let head = `<${n.f}`
	const type = FORMULA_TYPES[formula.kind]

	if (type !== undefined) head += attr("t", type)
	if ((formula.flags & FormulaFlag.ALWAYS_ARRAY) !== 0) head += attr("aca", 1)
	if (formula.ref !== null) head += attr("ref", rangeRef(formula.ref))

	for (const [name, bit] of FORMULA_FLAGS) {
		if (name === "aca" || name === "ca" || name === "bx" || (formula.flags & bit) === 0) continue

		head += attr(name, 1)
	}

	if (formula.r1 !== undefined) head += attr("r1", formula.r1)
	if (formula.r2 !== undefined) head += attr("r2", formula.r2)
	if ((formula.flags & FormulaFlag.ALWAYS) !== 0) head += attr("ca", 1)
	if (formula.sharedIndex >= 0) head += attr("si", formula.sharedIndex)
	if ((formula.flags & FormulaFlag.ASSIGNS_NAME) !== 0) head += attr("bx", 1)

	out.text(head)

	if (formula.text === "") {
		out.ascii("/>")
	} else {
		out.text(`>${escapeText(formula.text)}</${n.f}>`)
	}
}

// One cell from the store. `keep`, the source cell it is (by its origin), gives the attributes and children the
// store does not hold; its value metadata (vm) stays only while the value does, and its formula and inline
// string elements are copied as written while they hold what the store does.
function writeCell(
	out: ByteBuilder,
	n: Names,
	bytes: Uint8Array | null,
	row: number,
	col: number,
	kind: number,
	value: number,
	style: number,
	formula: XlsxFormula | null,
	strings: XlsxSheetStrings,
	keep: DecodedCell | undefined
): void {
	out.ascii(`<${n.c} r="${cellRef(row, col)}"`)

	if (style !== 0) out.ascii(` s="${style}"`)

	const type = TYPES[kind]

	if (type !== undefined) out.ascii(` t="${type}"`)
	if (formula !== null && formula.cellMetadata >= 0) out.ascii(` cm="${formula.cellMetadata}"`)

	if (keep !== undefined && bytes !== null) {
		if (keep.vm && sameValue(keep, kind, value, strings)) {
			const tag = scanTag(bytes, keep.start)
			const at = tag === undefined ? -1 : findAttribute(bytes, tag, "vm")

			if (tag !== undefined && at >= 0) {
				out.ascii(" ")
				out.bytes(bytes, tag.attributes[at] ?? 0, (tag.attributes[at + 3] ?? 0) + 1)
			}
		}

		for (let k = 0; k < keep.kept.length; k += 2) {
			out.ascii(" ")
			out.bytes(bytes, keep.kept[k] ?? 0, keep.kept[k + 1] ?? 0)
		}
	}

	const children = keep !== undefined && bytes !== null ? keep.children : []

	if (formula === null && kind === CellKind.EMPTY && children.length === 0) {
		out.ascii("/>")

		return
	}

	out.ascii(">")

	const sourceFormula = keep?.formulaSpan ?? null

	if (formula !== null && bytes !== null && keep !== undefined && sourceFormula !== null && sameFormula(keep.formula, keep.cm, formula)) {
		out.bytes(bytes, sourceFormula[0], sourceFormula[1])
	} else if (formula !== null) {
		writeFormula(out, n, formula)
	}

	const sourceValue = keep?.valueSpan ?? null

	// A value the store holds as the source cell did: its <v> as written (number text, spelling).
	if (
		kind !== CellKind.EMPTY &&
		kind !== CellKind.INLINE_STRING &&
		bytes !== null &&
		keep !== undefined &&
		sourceValue !== null &&
		sameValue(keep, kind, value, strings)
	) {
		out.bytes(bytes, sourceValue[0], sourceValue[1])
	} else
		switch (kind) {
			case CellKind.EMPTY:
				break
			case CellKind.NUMBER:
				out.ascii(`<${n.v}>${formatNumber(value)}</${n.v}>`)
				break
			case CellKind.SHARED_STRING:
			case CellKind.BOOLEAN:
				if (!Number.isInteger(value) || value < 0) throw new XlsxWriteError("write", `Cell ${cellRef(row, col)} holds ${value}`)

				out.ascii(`<${n.v}>${kind === CellKind.BOOLEAN ? (value === 0 ? 0 : 1) : value}</${n.v}>`)
				break
			case CellKind.INLINE_STRING: {
				const text = strings.text(value)
				const sourceInline = keep?.inlineSpan ?? null

				// Runs and phonetic text are the source's while the text is.
				if (bytes !== null && keep !== undefined && sourceInline !== null && keep.kind === kind && keep.text === text) {
					out.bytes(bytes, sourceInline[0], sourceInline[1])

					break
				}

				out.text(`<${n.is}><${n.t}${preserved(text)}>${escapeText(text)}</${n.t}></${n.is}>`)
				break
			}
			default: {
				if (!TEXT_KINDS.has(kind)) throw new XlsxWriteError("write", `Cell ${cellRef(row, col)} has kind ${kind}`)

				const text = strings.text(value)

				out.text(`<${n.v}${preserved(text)}>${escapeText(text)}</${n.v}>`)
			}
		}

	if (bytes !== null) for (let k = 0; k < children.length; k += 2) out.bytes(bytes, children[k] ?? 0, children[k + 1] ?? 0)

	out.ascii(`</${n.c}>`)
}

// Copies bytes [from, to) with value spans replaced: `edits` as [from, to, text] ascending.
function spliced(
	out: ByteBuilder,
	bytes: Uint8Array,
	from: number,
	to: number,
	edits: readonly (readonly [number, number, string])[]
): void {
	let at = from

	for (const [editFrom, editTo, text] of edits) {
		out.bytes(bytes, at, editFrom)
		out.text(text)
		at = editTo
	}

	out.bytes(bytes, at, to)
}

// A source cell copied, its r made to name (row, col).
function copyCell(out: ByteBuilder, bytes: Uint8Array, cell: DecodedCell, row: number, col: number): void {
	const reference = cellRef(row, col)

	if (cell.r !== null) {
		spliced(out, bytes, cell.start, cell.end, [[cell.r[0], cell.r[1], reference]])
	} else {
		const tag = scanTag(bytes, cell.start)

		if (tag === undefined) throw new XlsxWriteError("malformedPart", `No cell at ${cell.start}`)

		spliced(out, bytes, cell.start, cell.end, [[tag.nameEnd, tag.nameEnd, ` r="${reference}"`]])
	}
}

// spans widened to cover the row's cells (1-based "first:last" ranges; a hint, kept as written when it covers).
function widenedSpans(spans: string | undefined, block: XlsxRowBlock, index: number): string | undefined {
	const from = block.rowStarts[index] ?? 0
	const to = block.rowStarts[index + 1] ?? 0

	if (spans === undefined || from === to) return spans

	const first = (block.cols[from] ?? 0) + 1
	const last = (block.cols[to - 1] ?? 0) + 1
	let low = Number.POSITIVE_INFINITY
	let high = 0

	for (const range of spans.trim().split(/\s+/)) {
		const [a, b] = range.split(":").map(Number)

		if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b)) return `${first}:${last}`

		low = Math.min(low, a)
		high = Math.max(high, b)
	}

	return first >= low && last <= high ? spans : `${Math.min(low, first)}:${Math.max(high, last)}`
}

function rowPropertyAttributes(height: number, style: number, flags: number): string {
	let out = ""

	if (style >= 0) out += attr("s", style)
	if ((flags & RowFlag.CUSTOM_FORMAT) !== 0) out += attr("customFormat", 1)
	if (!Number.isNaN(height)) out += attr("ht", formatNumber(height))
	if ((flags & RowFlag.HIDDEN) !== 0) out += attr("hidden", 1)
	if ((flags & RowFlag.CUSTOM_HEIGHT) !== 0) out += attr("customHeight", 1)

	const outline = (flags & RowFlag.OUTLINE_MASK) >> RowFlag.OUTLINE_SHIFT

	if (outline > 0) out += attr("outlineLevel", outline)
	if ((flags & RowFlag.COLLAPSED) !== 0) out += attr("collapsed", 1)
	if ((flags & RowFlag.THICK_TOP) !== 0) out += attr("thickTop", 1)
	if ((flags & RowFlag.THICK_BOTTOM) !== 0) out += attr("thickBot", 1)

	return out
}

interface RowContext {
	readonly n: Names
	readonly bytes: Uint8Array | null
	readonly sheet: XlsxSheetModel
	// A formula was added, changed or removed in a rewritten row.
	formulas: boolean
	// Source rows decoded for the cells pastes carried, by part and span start; other sheets' parts the save read.
	readonly carriedRows: Map<string, DecodedRow>
	readonly carriedParts: ReadonlyMap<string, CarriedPart>
}

// Another sheet's part a paste carried cells from. `compatible`: its root declares no namespace this part's root
// does not declare alike, so its cells' markup reads the same here.
export interface CarriedPart {
	readonly bytes: Uint8Array
	readonly compatible: boolean
}

// The namespace declarations of a part's root start tag.
function rootNamespaces(bytes: Uint8Array): Map<string, string> {
	const { tag } = rootTag(bytes)
	const out = new Map<string, string>()

	for (let k = 0; k < tag.attributes.length; k += 4) {
		const name = decodeUtf8(bytes, tag.attributes[k] ?? 0, tag.attributes[k + 1] ?? 0)

		if (name === "xmlns" || name.startsWith("xmlns:"))
			out.set(name, decodeCharacterData(bytes, tag.attributes[k + 2] ?? 0, tag.attributes[k + 3] ?? 0, true))
	}

	return out
}

// Whether markup of `other` reads alike inside `own` (both part bytes).
export function namespacesCompatible(own: Uint8Array, other: Uint8Array): boolean {
	const mine = rootNamespaces(own)

	for (const [name, uri] of rootNamespaces(other)) if (mine.get(name) !== uri) return false

	return true
}

// The source cell a carried origin names, decoded from its row's element (once per row and save).
// From a part whose namespaces differ, only its unprefixed attributes (vm, ph) go: nothing else would read alike.
function carriedSourceCell(context: RowContext, cell: XlsxSourceCell | undefined): { cell: DecodedCell; bytes: Uint8Array } | undefined {
	const own = cell?.part === context.sheet.part
	const other = cell === undefined || own ? undefined : context.carriedParts.get(cell.part)
	const bytes = own ? context.bytes : other?.bytes

	if (cell === undefined || bytes === undefined || bytes === null || cell.spanEnd > bytes.length) return undefined

	const key = `${cell.part}\n${cell.spanStart}`
	let row = context.carriedRows.get(key)

	if (row === undefined) {
		row = decodeRow(bytes, cell.spanStart, cell.spanEnd)
		context.carriedRows.set(key, row)
	}

	const decoded = row.cells[cell.ordinal - 1]

	if (decoded === undefined) return undefined
	if (own || other?.compatible === true) return { cell: decoded, bytes }

	const kept: number[] = []

	for (let k = 0; k < decoded.kept.length; k += 2) {
		const from = decoded.kept[k] ?? 0

		if (bytes.subarray(from, bytes.indexOf(61, from)).indexOf(58) < 0) kept.push(from, decoded.kept[k + 1] ?? 0)
	}

	return { cell: { ...decoded, kept, children: [], formulaSpan: null, valueSpan: null, inlineSpan: null }, bytes }
}

// A changed (or new) row from the store, its unchanged cells copied from `source`.
function writeRow(out: ByteBuilder, context: RowContext, block: XlsxRowBlock, index: number, source: DecodedRow | undefined): void {
	const { n, bytes } = context
	const store = context.sheet.store
	const row = block.firstRow + (block.rows[index] ?? 0)
	const height = block.rowHeights[index] ?? Number.NaN
	const style = block.rowStyles[index] ?? -1
	const flags = (block.rowFlags[index] ?? 0) & ~ROW_MARKS
	const spans = widenedSpans(source?.spans, block, index)
	const from = block.rowStarts[index] ?? 0
	const to = block.rowStarts[index + 1] ?? 0

	if (source !== undefined && bytes !== null && sameRowProperties(source, height, style, flags)) {
		// The start tag as written, but r and spans.
		const tag = source.tag
		const edits: [number, number, string][] = []
		const r = findAttribute(bytes, tag, "r")
		const span = findAttribute(bytes, tag, "spans")

		if (r >= 0) edits.push([tag.attributes[r + 2] ?? 0, tag.attributes[r + 3] ?? 0, String(row + 1)])
		else edits.push([tag.nameEnd, tag.nameEnd, ` r="${row + 1}"`])

		if (span >= 0 && spans !== source.spans) edits.push([tag.attributes[span + 2] ?? 0, tag.attributes[span + 3] ?? 0, spans ?? ""])

		edits.sort((a, b) => a[0] - b[0])
		spliced(out, bytes, tag.start, tag.end - (tag.selfClosing ? 2 : 1), edits)
	} else {
		out.ascii(`<${n.row} r="${row + 1}"`)

		if (spans !== undefined) out.ascii(` spans="${spans}"`)

		out.text(rowPropertyAttributes(height, style, flags))

		if (source !== undefined && bytes !== null) {
			for (let k = 0; k < source.kept.length; k += 2) {
				out.ascii(" ")
				out.bytes(bytes, source.kept[k] ?? 0, source.kept[k + 1] ?? 0)
			}
		}
	}

	const children = source !== undefined && bytes !== null ? source.children : []

	if (from === to && children.length === 0) {
		out.ascii("/>")

		return
	}

	out.ascii(">")

	// Each slot is matched to its source cell by its origin alone: model-equal neighbours are never taken for it.
	const sourceCells = bytes !== null ? (source?.cells ?? []) : []
	const used = new Uint8Array(sourceCells.length)

	for (let slot = from; slot < to; slot++) {
		const col = block.cols[slot] ?? 0
		const kind = block.kinds[slot] ?? 0
		const value = block.values[slot] ?? 0
		const cellStyle = block.styles[slot] ?? 0
		const id = block.formulas?.[slot] ?? -1
		const formula = id >= 0 ? store.formulas.formula(id) : null
		const origin = bytes === null ? 0 : blockOrigin(block, index, slot)
		const match = origin > 0 && origin <= sourceCells.length && used[origin - 1] === 0 ? origin - 1 : -1
		// A paste of a source cell from elsewhere (CARRIED): that cell, decoded from its own row.
		const carried = origin >= CARRIED ? carriedSourceCell(context, store.carriedCell(origin)) : undefined
		const cell = match >= 0 ? sourceCells[match] : carried?.cell
		const cellBytes = carried?.bytes ?? bytes

		if (match >= 0) used[match] = 1

		if (
			cell !== undefined &&
			cellBytes !== null &&
			(carried === undefined || carried.bytes === bytes) &&
			cell.style === cellStyle &&
			sameValue(cell, kind, value, store.strings) &&
			sameFormula(cell.formula, cell.cm, formula)
		) {
			if (carried === undefined && cell.col === col && cell.named && source?.row === row) {
				out.bytes(cellBytes, cell.start, cell.end)
			} else {
				copyCell(out, cellBytes, cell, row, col)

				// A formula cell that moved: the calculation chain names it where it was.
				if (formula !== null) context.formulas = true
			}

			continue
		}

		if (
			!sameFormula(cell?.formula ?? null, cell?.cm ?? -1, formula) ||
			(formula !== null && (carried !== undefined || cell?.col !== col || source?.row !== row))
		)
			context.formulas = true

		writeCell(out, n, cellBytes, row, col, kind, value, cellStyle, formula, store.strings, cell)
	}

	// A source formula no cell kept is gone.
	for (let k = 0; k < sourceCells.length; k++) if (used[k] === 0 && sourceCells[k]?.formula !== null) context.formulas = true

	if (bytes !== null) for (let k = 0; k < children.length; k += 2) out.bytes(bytes, children[k] ?? 0, children[k + 1] ?? 0)

	out.ascii(`</${n.row}>`)
}

// Whether a dirty row equals its source (an edit and its undo): at its source position, with its properties and
// every cell as written. Its source bytes are then copied whole, white space and implied cell numbers kept.
function equalsSource(context: RowContext, block: XlsxRowBlock, index: number, row: number, source: DecodedRow): boolean {
	const store = context.sheet.store
	const from = block.rowStarts[index] ?? 0
	const to = block.rowStarts[index + 1] ?? 0
	const flags = (block.rowFlags[index] ?? 0) & ~ROW_MARKS
	const sourceRow = block.sourceFirstRow < 0 ? -1 : block.sourceFirstRow + (block.rows[index] ?? 0)

	// A row without r is numbered by its position: written anew with its number.
	if (sourceRow !== row || source.row !== row || source.cells.length !== to - from) return false
	if (!sameRowProperties(source, block.rowHeights[index] ?? Number.NaN, block.rowStyles[index] ?? -1, flags)) return false
	if (widenedSpans(source.spans, block, index) !== source.spans) return false

	for (let k = 0; k < source.cells.length; k++) {
		const cell = source.cells[k] as DecodedCell
		const slot = from + k
		const id = block.formulas?.[slot] ?? -1

		if (
			blockOrigin(block, index, slot) !== k + 1 ||
			cell.col !== (block.cols[slot] ?? -1) ||
			cell.style !== (block.styles[slot] ?? 0) ||
			!sameValue(cell, block.kinds[slot] ?? 0, block.values[slot] ?? 0, store.strings) ||
			!sameFormula(cell.formula, cell.cm, id >= 0 ? store.formulas.formula(id) : null)
		)
			return false
	}

	return true
}

// --- Rows whose formulas alone changed ---

// A decimal integer at [from, to) of `bytes` (spaces around allowed), or -1.
function uintAt(bytes: Uint8Array, from: number, to: number): number {
	while (from < to && isSpaceByte(bytes[from])) from++
	while (to > from && isSpaceByte(bytes[to - 1])) to--

	if (from === to || to - from > 15) return -1

	let value = 0

	for (let i = from; i < to; i++) {
		const digit = (bytes[i] ?? 0) - 48

		if (digit < 0 || digit > 9) return -1

		value = value * 10 + digit
	}

	return value
}

// An A1 cell reference at [from, to) ($ allowed): the row and column into `out`, false when it is none.
function cellAt(bytes: Uint8Array, from: number, to: number, out: Int32Array): boolean {
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

	if (i === letters || i - letters > 3) return false
	if (bytes[i] === 36) i++

	const row = uintAt(bytes, i, to)

	if (row < 1) return false

	out[0] = row - 1
	out[1] = col - 1

	return true
}

function isSpaceByte(byte: number | undefined): boolean {
	return byte === 32 || byte === 9 || byte === 10 || byte === 13
}

// The end (just past the end tag) of an element holding text only, or -1 when it holds elements.
function leafEnd(bytes: Uint8Array, tag: ScannedTag): number {
	if (tag.selfClosing) return tag.end

	const close = bytes.indexOf(60, tag.end)

	return close < 0 || bytes[close + 1] !== 47 ? -1 : bytes.indexOf(62, close) + 1
}

// Raw bytes [from, to) are exactly `text` escaped (ASCII fast path; anything else is decoded and compared).
function sameText(bytes: Uint8Array, from: number, to: number, text: string): boolean {
	if (to - from === text.length) {
		let ascii = true

		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i)

			if (code >= 128 || code === 38 || code === 60 || code === 62) {
				ascii = false

				break
			}

			if (bytes[from + i] !== code) return false
		}

		if (ascii) return true
	}

	return decodeCharacterData(bytes, from, to, false) === text
}

const QUICK_ROW_FLAGS: readonly (readonly [string, number])[] = [
	["hidden", RowFlag.HIDDEN],
	["customHeight", RowFlag.CUSTOM_HEIGHT],
	["customFormat", RowFlag.CUSTOM_FORMAT],
	["collapsed", RowFlag.COLLAPSED],
	["thickTop", RowFlag.THICK_TOP],
	["thickBot", RowFlag.THICK_BOTTOM]
]

// quickRow's scratch for a cell reference.
const CELL_AT = new Int32Array(2)

const FORMULA_KINDS: Readonly<Record<string, number>> = {
	shared: -2,
	array: FormulaKind.ARRAY,
	dataTable: FormulaKind.DATA_TABLE,
	normal: FormulaKind.NORMAL
}

const TAG_EDITS: [number, number, string][] = []

// A dirty row whose properties and cells (values, formula kinds and flags) are its source's, its cells' styles
// spliced where a format edit changed them: its source
// bytes with r renumbered, each moved cell's r renamed, each removed cell cut out, spans widened and each changed
// formula's text and range spliced in, read without a parse, as a structure edit leaves most rows. Cells are
// matched to the store's by their origins. False for anything else (the row is then written by writeRow).
function quickRow(
	out: ByteBuilder,
	context: RowContext,
	block: XlsxRowBlock,
	index: number,
	row: number,
	bytes: Uint8Array,
	start: number,
	end: number
): boolean {
	const n = context.n
	const store = context.sheet.store
	const tag = scanTag(bytes, start)

	if (tag === undefined) return false

	const height = block.rowHeights[index] ?? Number.NaN
	const style = block.rowStyles[index] ?? -1
	const flags = (block.rowFlags[index] ?? 0) & ~ROW_MARKS
	let sourceFlags = 0
	let sourceHeight = Number.NaN
	let sourceStyle = -1
	let spans: string | undefined
	let spansFrom = -1
	let spansTo = -1

	// The row's attributes, once over (r below).
	for (let k = 0; k < tag.attributes.length; k += 4) {
		const nameFrom = tag.attributes[k] ?? 0
		const nameTo = tag.attributes[k + 1] ?? 0
		const valueFrom = tag.attributes[k + 2] ?? 0
		const valueTo = tag.attributes[k + 3] ?? 0

		if (nameTo - nameFrom === 1) {
			if (bytes[nameFrom] === 115) sourceStyle = uintAt(bytes, valueFrom, valueTo)

			continue
		}

		const name = decodeUtf8(bytes, nameFrom, nameTo)

		if (name === "ht") {
			sourceHeight = parseNumber(bytes, valueFrom, valueTo)
		} else if (name === "spans") {
			spans = decodeCharacterData(bytes, valueFrom, valueTo, true)
			spansFrom = valueFrom
			spansTo = valueTo
		} else if (name === "outlineLevel") {
			sourceFlags |= (Math.max(0, Math.min(7, uintAt(bytes, valueFrom, valueTo))) << RowFlag.OUTLINE_SHIFT) & RowFlag.OUTLINE_MASK
		} else {
			const bit = QUICK_ROW_FLAGS.find(([flag]) => flag === name)?.[1]

			if (bit !== undefined && readBoolean(decodeCharacterData(bytes, valueFrom, valueTo, true), false)) sourceFlags |= bit
		}
	}

	if (sourceFlags !== flags || sourceStyle !== style) return false
	if (!(sourceHeight === height || (Number.isNaN(sourceHeight) && Number.isNaN(height)))) return false

	const edits: [number, number, string][] = []
	const rowText = String(row + 1)
	const r = findAttribute(bytes, tag, "r")
	const widened = widenedSpans(spans, block, index)

	if (r < 0) edits.push([tag.nameEnd, tag.nameEnd, ` r="${rowText}"`])
	else if (uintAt(bytes, tag.attributes[r + 2] ?? 0, tag.attributes[r + 3] ?? 0) !== row + 1)
		edits.push([tag.attributes[r + 2] ?? 0, tag.attributes[r + 3] ?? 0, rowText])

	if (widened !== spans && widened !== undefined) edits.push([spansFrom, spansTo, widened])

	edits.sort((a, z) => a[0] - z[0])

	const sourceRow = block.sourceFirstRow < 0 ? -1 : block.sourceFirstRow + (block.rows[index] ?? 0)
	const at = CELL_AT
	const to = block.rowStarts[index + 1] ?? 0
	const rowStart = block.rowStarts[index] ?? 0
	// blockOrigin, inlined: the hottest loop of a structure save.
	const origins = block.origins
	let slot = rowStart
	let ordinal = 0
	let implied = 0
	let changed = false

	for (let i = tag.selfClosing ? -1 : bytes.indexOf(60, tag.end); i >= 0 && i < end;) {
		if (bytes[i + 1] === 47) break
		if (bytes[i + 1] === 33 || bytes[i + 1] === 63) return false

		const cell = scanTag(bytes, i)

		if (cell === undefined || !spells(bytes, i + 1, cell.nameEnd, n.c)) return false

		ordinal++

		// The cell's attributes, once over.
		let rFrom = -1
		let rTo = -1
		let cellStyle = 0
		// The s attribute: where its name starts and its value's span (-1 when absent).
		let sName = -1
		let sFrom = -1
		let sTo = -1
		let type = "n"
		let cm = -1

		for (let k = 0; k < cell.attributes.length; k += 4) {
			const nameFrom = cell.attributes[k] ?? 0
			const nameTo = cell.attributes[k + 1] ?? 0
			const valueFrom = cell.attributes[k + 2] ?? 0
			const valueTo = cell.attributes[k + 3] ?? 0
			const first = bytes[nameFrom]

			if (nameTo - nameFrom === 1 && first === 114) {
				rFrom = valueFrom
				rTo = valueTo
			} else if (nameTo - nameFrom === 1 && first === 115) {
				cellStyle = uintAt(bytes, valueFrom, valueTo)
				sName = nameFrom
				sFrom = valueFrom
				sTo = valueTo
			} else if (nameTo - nameFrom === 1 && first === 116) {
				type = decodeCharacterData(bytes, valueFrom, valueTo, true)
			} else if (nameTo - nameFrom === 2 && first === 99 && bytes[nameFrom + 1] === 109) {
				cm = uintAt(bytes, valueFrom, valueTo)
			}
		}

		if (rFrom >= 0) {
			if (!cellAt(bytes, rFrom, rTo, at) || (at[0] !== row && at[0] !== sourceRow)) return false
		} else {
			at[0] = row
			at[1] = implied
		}

		const sourceCol = at[1] ?? 0
		const sourceAt = at[0] ?? 0

		implied = sourceCol + 1

		// Its children: f and v, both text only (anything else, an inline string, is left to writeRow).
		let formulaTag: ScannedTag | undefined
		let formulaEnd = -1
		let valueFrom = -1
		let valueTo = -1
		let cellEnd = cell.end

		if (!cell.selfClosing) {
			let j = bytes.indexOf(60, cell.end)

			for (;;) {
				if (j < 0 || j >= end) return false

				if (bytes[j + 1] === 47) {
					cellEnd = bytes.indexOf(62, j) + 1

					break
				}

				const child = scanTag(bytes, j)
				const childEnd = child === undefined ? -1 : leafEnd(bytes, child)

				if (child === undefined || childEnd < 0) return false

				if (spells(bytes, j + 1, child.nameEnd, n.f)) {
					formulaTag = child
					formulaEnd = childEnd
				} else if (spells(bytes, j + 1, child.nameEnd, n.v)) {
					valueFrom = child.end
					valueTo = child.selfClosing ? child.end : bytes.lastIndexOf(60, childEnd - 1)
				} else {
					return false
				}

				j = bytes.indexOf(60, childEnd)
			}
		}

		const origin = slot >= to ? 0 : origins === null ? slot - rowStart + 1 : (origins[slot] ?? 0)

		// A cell a paste carried from elsewhere leaves the row to writeRow.
		if (origin >= CARRIED) return false

		// A source cell the store no longer holds (its column deleted) is cut out; a store cell that is not the
		// next source one (added, or out of order) leaves the row to writeRow.
		if (slot >= to || origin > ordinal) {
			edits.push([i, cellEnd, ""])

			if (formulaTag !== undefined) changed = true

			i = bytes.indexOf(60, cellEnd)

			continue
		}

		if (origin !== ordinal) return false

		const col = block.cols[slot] ?? -1
		const style = block.styles[slot] ?? 0
		// The start tag's edits, put in order before those inside the cell (edits stay ascending).
		const tagEdits = TAG_EDITS

		tagEdits.length = 0

		// The cell's r names the new row and column.
		if (rFrom < 0) {
			tagEdits.push([cell.nameEnd, cell.nameEnd, ` r="${cellRef(row, col)}"`])
		} else if (sourceCol !== col) {
			tagEdits.push([rFrom, rTo, cellRef(row, col)])
		} else if (sourceAt !== row) {
			let digits = rFrom

			while (digits < rTo && ((bytes[digits] ?? 0) > 57 || bytes[digits] === 36)) digits++

			tagEdits.push([digits, rTo, rowText])
		}

		// A format edit's new s: its value replaced, or the attribute added or (back to the default) taken out with
		// the space before it.
		if (cellStyle !== style) {
			// Added after r, where Excel writes it.
			const after = rFrom < 0 ? cell.nameEnd : rTo + 1

			if (sFrom < 0) tagEdits.push([after, after, ` s="${String(style)}"`])
			else if (style === 0) tagEdits.push([sName - 1, sTo + 1, ""])
			else tagEdits.push([sFrom, sTo, String(style)])
		}

		if (tagEdits.length > 1) tagEdits.sort((a, z) => a[0] - z[0])

		for (const edit of tagEdits) edits.push(edit)

		// The value as the store holds it.
		const kind = block.kinds[slot] ?? 0
		const stored = block.values[slot] ?? 0

		if (valueFrom < 0) {
			if (kind !== CellKind.EMPTY) return false
		} else if (type === "n") {
			// The reader's own number parse: the value the store holds is what it read.
			if (kind !== CellKind.NUMBER || parseNumber(bytes, valueFrom, valueTo) !== stored) return false
		} else if (type === "s") {
			if (kind !== CellKind.SHARED_STRING || uintAt(bytes, valueFrom, valueTo) !== stored) return false
		} else if (type === "b") {
			if (kind !== CellKind.BOOLEAN || (readBoolean(decodeUtf8(bytes, valueFrom, valueTo).trim(), false) ? 1 : 0) !== stored)
				return false
		} else {
			return false
		}

		// The formula: everything but its text and range as in the source.
		const id = block.formulas?.[slot] ?? -1

		if ((formulaTag === undefined) !== id < 0) return false

		if (formulaTag !== undefined) {
			const formula = store.formulas.formula(id)
			let kindRead = FormulaKind.NORMAL as number
			let refFrom = -1
			let refTo = -1
			let si = -1
			let formulaFlags = 0
			let r1: string | undefined
			let r2: string | undefined

			for (let k = 0; k < formulaTag.attributes.length; k += 4) {
				const nameFrom = formulaTag.attributes[k] ?? 0
				const nameTo = formulaTag.attributes[k + 1] ?? 0
				const name = nameTo - nameFrom === 1 && bytes[nameFrom] === 116 ? "t" : decodeUtf8(bytes, nameFrom, nameTo)
				const valueStart = formulaTag.attributes[k + 2] ?? 0
				const valueEnd = formulaTag.attributes[k + 3] ?? 0

				if (name === "t") kindRead = FORMULA_KINDS[decodeCharacterData(bytes, valueStart, valueEnd, true)] ?? -1
				else if (name === "ref") [refFrom, refTo] = [valueStart, valueEnd]
				else if (name === "si") si = uintAt(bytes, valueStart, valueEnd)
				else if (name === "r1") r1 = decodeCharacterData(bytes, valueStart, valueEnd, true)
				else if (name === "r2") r2 = decodeCharacterData(bytes, valueStart, valueEnd, true)
				else {
					const bit = FORMULA_FLAGS.find(([flag]) => flag === name)?.[1]

					if (bit === undefined) return false
					if (readBoolean(decodeCharacterData(bytes, valueStart, valueEnd, true), false)) formulaFlags |= bit
				}
			}

			if (kindRead === -2) kindRead = refFrom >= 0 ? FormulaKind.SHARED_MASTER : FormulaKind.SHARED_CHILD

			if (kindRead !== formula.kind || formulaFlags !== formula.flags || si !== formula.sharedIndex || cm !== formula.cellMetadata)
				return false
			if (r1 !== formula.r1 || r2 !== formula.r2 || refFrom < 0 !== (formula.ref === null)) return false

			if (formula.ref !== null && refFrom >= 0) {
				const range = parseRangeRef(decodeUtf8(bytes, refFrom, refTo))

				if (range === undefined) return false

				if (!sameRange(range, formula.ref)) {
					edits.push([refFrom, refTo, rangeRef(formula.ref)])
					changed = true
				}
			}

			const textFrom = formulaTag.end
			const textTo = formulaTag.selfClosing ? textFrom : bytes.lastIndexOf(60, formulaEnd - 1)

			if (formulaTag.selfClosing ? formula.text !== "" : !sameText(bytes, textFrom, textTo, formula.text)) {
				if (formulaTag.selfClosing || formula.text === "") return false

				edits.push([textFrom, textTo, escapeText(formula.text)])
				changed = true
			}
			// A formula cell that moved: the calculation chain names it where it was.
			if (sourceCol !== col || sourceAt !== row) changed = true
		} else if (cm >= 0) {
			return false
		}

		slot++
		i = bytes.indexOf(60, cellEnd)
	}

	if (slot !== to) return false
	if (changed) context.formulas = true

	spliced(out, bytes, start, end, edits)

	return true
}

// Whether row `index` of a block holds a formula.
function holdsFormula(block: XlsxRowBlock, index: number): boolean {
	const formulas = block.formulas

	if (formulas === null) return false

	for (let k = block.rowStarts[index] ?? 0; k < (block.rowStarts[index + 1] ?? 0); k++) if ((formulas[k] ?? -1) >= 0) return true

	return false
}

// A row that only moved: its bytes with every r renumbered (cells keep their columns), written as it is scanned.
const REFERENCE = new Int32Array(4)

function renumberRow(out: ByteBuilder, bytes: Uint8Array, start: number, end: number, row: number, n: Names): void {
	const rowText = String(row + 1)
	const tag = REFERENCE
	let at = start

	for (let i = bytes.indexOf(60, start); i >= 0 && i < end; i = bytes.indexOf(60, i + 1)) {
		if (bytes[i + 1] === 33) {
			// A comment or CDATA section: past its end.
			const cdata = bytes[i + 2] === 91
			const close = cdata ? "]]>" : "-->"
			let j = i + 2

			while (j < end && !spells(bytes, j, j + 3, close)) j++

			i = j

			continue
		}

		if (!scanReference(bytes, i, tag)) continue

		const isRow = i === start

		if (!isRow && !spells(bytes, i + 1, tag[0] ?? 0, n.c)) {
			i = (tag[3] ?? i + 1) - 1

			continue
		}

		const valueStart = tag[1] ?? -1
		const valueEnd = tag[2] ?? -1

		if (valueStart < 0) {
			if (isRow) {
				out.bytes(bytes, at, tag[0] ?? 0)
				out.ascii(` r="${rowText}"`)
				at = tag[0] ?? 0
			}
		} else {
			// The row's whole value; a cell's digits (its letters stay).
			let digits = valueStart

			if (!isRow) while (digits < valueEnd && ((bytes[digits] ?? 0) > 57 || bytes[digits] === 36)) digits++

			out.bytes(bytes, at, digits)
			out.ascii(rowText)
			at = valueEnd
		}

		i = (tag[3] ?? i + 1) - 1
	}

	out.bytes(bytes, at, end)
}

// A rewritten row as the gate reads it back: where it is in the store and its bytes in the output.
export interface WrittenRow {
	readonly block: number
	readonly index: number
	readonly bytes: Uint8Array
	// Only its r attributes changed: the rest is its source bytes.
	readonly renumbered: boolean
	// Its source bytes with r, formula texts and ranges spliced in.
	readonly spliced: boolean
}

// The sheetData element of `sheet` into `pieces`. `section` is its span in the source part (`bytes`), or null
// for a sheet with no source. Rows nothing touched are checked to be whole <row> elements as they are copied.
// New row markup is handed out in pieces of about this size, so a part whose every row was rewritten or renumbered
// is never held in one growing buffer.
const BUILT_CHUNK = 1 << 20

// Rows written between yields (each a step of a sliced run).
const ROWS_PER_STEP = 512

// writeSheetData as steps: it yields every ROWS_PER_STEP rows, so a sliced run gives the host its turns.
export function* writeSheetDataSteps(
	pieces: Pieces,
	sheet: XlsxSheetModel,
	prefix: string,
	bytes: Uint8Array | null,
	section: { readonly start: number; readonly end: number } | null,
	carriedParts: ReadonlyMap<string, CarriedPart> = new Map()
): Generator<void, { readonly rows: WrittenRow[]; readonly formulasChanged: boolean }> {
	const n = names(prefix)
	const context: RowContext = { n, bytes, sheet, formulas: false, carriedRows: new Map(), carriedParts }
	const rows: WrittenRow[] = []
	const built = new ByteBuilder()
	let pending: { block: number; index: number; from: number; to: number; renumbered: boolean; spliced: boolean }[] = []
	let runStart = -1
	let runEnd = -1
	let close: Uint8Array

	const flushRun = (): void => {
		if (runStart >= 0 && bytes !== null) pieces.push(bytes.subarray(runStart, runEnd))

		runStart = -1
	}
	const flushBuilt = (): void => {
		if (built.length === 0) return

		const chunk = built.take()

		pieces.push(chunk)

		for (const row of pending)
			rows.push({
				block: row.block,
				index: row.index,
				bytes: chunk.subarray(row.from, row.to),
				renumbered: row.renumbered,
				spliced: row.spliced
			})

		pending = []
	}

	const open = bytes !== null && section !== null ? scanTag(bytes, section.start) : undefined

	// An empty sheetData that is empty again (a row added, then undone) is written as it was.
	if (bytes !== null && section !== null && open?.selfClosing === true && sheet.store.blocks.every(block => block.rowCount === 0)) {
		pieces.push(bytes.subarray(section.start, section.end))

		return { rows, formulasChanged: false }
	}

	let closeStart = -1
	// Where the last row with source bytes ended: the whitespace between it and the next source row is kept
	// (indented parts stay indented around a rewritten row). -1 after a new row.
	let previousEnd = -1

	if (bytes !== null && section !== null && open !== undefined && !open.selfClosing) {
		pieces.push(bytes.subarray(section.start, open.end))
		closeStart = bytes.lastIndexOf(60, section.end - 1)
		close = bytes.subarray(closeStart, section.end)
		previousEnd = open.end
	} else {
		pieces.text(`<${qualify(prefix, "sheetData")}>`)
		close = encodeUtf8(`</${qualify(prefix, "sheetData")}>`)
	}

	// The source whitespace between the previous source row and `start`, or -1.
	const gapFrom = (start: number): number =>
		bytes !== null && previousEnd >= 0 && start >= previousEnd && onlySpace(bytes, previousEnd, start) ? previousEnd : -1
	const blocks = sheet.store.blocks
	let steps = 0

	for (let b = 0; b < blocks.length; b++) {
		const block = blocks[b] as XlsxRowBlock
		const moved = block.firstRow !== block.sourceFirstRow

		for (let index = 0; index < block.rowCount; index++) {
			if (++steps % ROWS_PER_STEP === 0) yield

			const flags = block.rowFlags[index] ?? 0
			const spanStart = block.rowSpans[index * 2] ?? NO_SPAN
			const spanEnd = block.rowSpans[index * 2 + 1] ?? NO_SPAN
			const hasSpan = bytes !== null && spanStart !== NO_SPAN && (flags & RowFlag.NEW) === 0

			if (hasSpan && (spanEnd > bytes.length || bytes[spanStart] !== 60 || bytes[spanEnd - 1] !== 62)) {
				throw new XlsxWriteError("malformedPart", `${sheet.part}: row span ${spanStart}-${spanEnd} is not an element`)
			}

			if (!hasSpan) {
				flushRun()

				const from = built.length

				writeRow(built, context, block, index, undefined)
				pending.push({ block: b, index, from, to: built.length, renumbered: false, spliced: false })

				if (built.length >= BUILT_CHUNK) flushBuilt()
				previousEnd = -1

				continue
			}

			const gap = gapFrom(spanStart)

			if ((flags & RowFlag.DIRTY) === 0) {
				const tag = scanTag(bytes, spanStart)

				if (tag === undefined || !spells(bytes, spanStart + 1, tag.nameEnd, n.row)) {
					throw new XlsxWriteError("malformedPart", `${sheet.part}: row span ${spanStart}-${spanEnd} is not a row`)
				}

				if (!moved) {
					flushBuilt()

					if (runStart >= 0 && gap >= 0 && gap === runEnd) {
						runEnd = spanEnd
					} else {
						flushRun()
						runStart = gap >= 0 ? gap : spanStart
						runEnd = spanEnd
					}

					previousEnd = spanEnd

					continue
				}
			}

			flushRun()

			if (gap >= 0) built.bytes(bytes, gap, spanStart)

			const from = built.length
			const row = block.firstRow + (block.rows[index] ?? 0)

			let spliced = false

			if ((flags & RowFlag.DIRTY) === 0) {
				renumberRow(built, bytes, spanStart, spanEnd, row, n)

				if (!context.formulas && holdsFormula(block, index)) context.formulas = true
			} else if (quickRow(built, context, block, index, row, bytes, spanStart, spanEnd)) {
				spliced = true
			} else {
				const decoded = decodeRow(bytes, spanStart, spanEnd)

				if (equalsSource(context, block, index, row, decoded)) built.bytes(bytes, spanStart, spanEnd)
				else writeRow(built, context, block, index, decoded)
			}

			pending.push({ block: b, index, from, to: built.length, renumbered: (flags & RowFlag.DIRTY) === 0, spliced })

			if (built.length >= BUILT_CHUNK) flushBuilt()
			previousEnd = spanEnd
		}
	}

	const tail = closeStart >= 0 ? gapFrom(closeStart) : -1

	if (tail >= 0 && runStart >= 0 && runEnd === tail) {
		runEnd = closeStart
	} else if (tail >= 0 && bytes !== null) {
		flushRun()
		flushBuilt()
		runStart = tail
		runEnd = closeStart
	}

	flushRun()
	flushBuilt()
	pieces.push(close)

	return { rows, formulasChanged: context.formulas }
}

// The used range of the store (cells only), or null when it has none.
// The range of the cells in rows edits changed (rewritten, added or moved): what a dimension must be widened to cover.
// Rows as the source has them keep the source's dimension, even one too small for them, so an undone edit saves the
// source again.
export function editedRange(sheet: XlsxSheetModel): SheetRange | null {
	return cellsRange(sheet, true)
}

export function usedRange(sheet: XlsxSheetModel): SheetRange | null {
	return cellsRange(sheet, false)
}

function cellsRange(sheet: XlsxSheetModel, editedOnly: boolean): SheetRange | null {
	let startRow = -1
	let endRow = -1
	let startCol = Number.POSITIVE_INFINITY
	let endCol = -1

	for (const block of sheet.store.blocks) {
		for (let index = 0; index < block.rowCount; index++) {
			const from = block.rowStarts[index] ?? 0
			const to = block.rowStarts[index + 1] ?? 0

			if (from === to) continue

			const row = block.firstRow + (block.rows[index] ?? 0)

			if (
				editedOnly &&
				((block.rowFlags[index] ?? 0) & (RowFlag.DIRTY | RowFlag.NEW)) === 0 &&
				block.sourceFirstRow >= 0 &&
				block.sourceFirstRow + (block.rows[index] ?? 0) === row
			)
				continue

			if (startRow < 0) startRow = row

			endRow = row
			startCol = Math.min(startCol, block.cols[from] ?? 0)
			endCol = Math.max(endCol, block.cols[to - 1] ?? 0)
		}
	}

	return startRow < 0 ? null : { startRow, startCol, endRow, endCol }
}

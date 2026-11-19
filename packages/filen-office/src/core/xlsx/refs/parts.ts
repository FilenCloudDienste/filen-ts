import type { SheetRange } from "../../sheet/protocol"
import { decodeUtf8, transcodeUtf16, type XmlDocument } from "../../xml/index"
import { sameSheet } from "../../sheet/refs/formulaRefs"
import { axisLimit, meetsMoved, reaches, shiftCell, type AxisShift } from "./axis"
import { shiftAnchor, shiftVmlAnchor } from "./anchors"
import { refuse, type RefConstruct } from "./catalogue"
import {
	childByLocal,
	childElements,
	descendants,
	editMarkup,
	shiftCellAttribute,
	shiftFormulaAttribute,
	shiftFormulaText,
	type RefJob
} from "./markup"
import { BANG, bytesAre, GT, isSpace, localIs, LT, nameEnd, QUESTION, Scanner, SLASH } from "../read/scan"
import { XlsxReadError } from "../read/errors"
import { parseRef } from "./sqref"

// The other parts that refer to cells (ECMA-376 Part 1 §20.5 drawings, §21.2 charts, §18.7 comments, §18.10
// pivot tables, MS-XLSX threaded comments, slicers, timelines and form controls). Each rewrite returns the part's
// bytes after the edit, the same array when nothing changed.

const ANCHORS: ReadonlySet<string> = new Set(["twoCellAnchor", "oneCellAnchor", "absoluteAnchor"])

// xdr drawings (a sheet's objects; slicers and timelines inside mc:AlternateContent too): anchors on the edited
// sheet, and shape text linked to a cell.
export function rewriteDrawing(bytes: Uint8Array, job: RefJob, part: string): Uint8Array {
	if (job.shift === null && !job.formulas.markupMayChange(decodeUtf8(bytes), job.own)) return bytes

	const edited = editMarkup(bytes, `drawing ${part}`)

	for (const node of descendants(edited.document, edited.document.documentElement())) {
		if (job.shift !== null && ANCHORS.has(edited.document.localName(node))) shiftAnchor(edited, node, job, "drawingAnchors")

		shiftFormulaAttribute(edited, node, "textlink", job, "drawingTextLinks", null)
	}

	return edited.editor.changed ? edited.editor.serialize() : bytes
}

// Charts (c:f, c15:f, cx:f and c15 full references) and chart user shapes (textlink): workbook-wide formulas.
export function rewriteChart(bytes: Uint8Array, job: RefJob, part: string): Uint8Array {
	if (!job.formulas.markupMayChange(decodeUtf8(bytes), null)) return bytes

	const edited = editMarkup(bytes, `chart ${part}`)
	const { document } = edited

	for (const node of descendants(document, document.documentElement())) {
		const local = document.localName(node)

		if (local === "f" || (local === "sqref" && document.prefix(node) !== "")) shiftFormulaText(edited, node, job, "chartFormulas", null)

		shiftFormulaAttribute(edited, node, "textlink", job, "drawingTextLinks", null)
	}

	return edited.editor.changed ? edited.editor.serialize() : bytes
}

// Comments (notes) of the edited sheet: refs moved; those of deleted cells dropped (their shapes and threads go by
// the same rule).
export function rewriteComments(bytes: Uint8Array, job: RefJob, part: string): Uint8Array {
	const edited = editMarkup(bytes, `comments ${part}`)
	const { document, editor } = edited
	const list = childByLocal(document, document.documentElement(), "commentList")

	for (const comment of list < 0 ? [] : childElements(document, list)) {
		if (!shiftCellAttribute(edited, comment, "ref", job, "comments")) {
			job.touch("comments")
			editor.remove(comment)
		}
	}

	return editor.changed ? editor.serialize() : bytes
}

export function rewriteThreadedComments(bytes: Uint8Array, job: RefJob, part: string): Uint8Array {
	const edited = editMarkup(bytes, `threaded comments ${part}`)
	const { document, editor } = edited

	for (const comment of childElements(document, document.documentElement())) {
		if (document.localName(comment) !== "threadedComment") continue

		if (!shiftCellAttribute(edited, comment, "ref", job, "threadedComments")) {
			job.touch("threadedComments")
			editor.remove(comment)
		}
	}

	return editor.changed ? editor.serialize() : bytes
}

const VML_FORMULAS: ReadonlySet<string> = new Set(["FmlaLink", "FmlaRange", "FmlaTxbx", "FmlaGroup", "FmlaPict"])

// A legacy drawing (VML): note and form control shapes. x:Row / x:Column are the note's cell (0-based), x:Anchor
// its box; a note whose cell was deleted goes with its shape.
export function rewriteVml(bytes: Uint8Array, job: RefJob, part: string): Uint8Array {
	if (job.shift === null && !job.formulas.markupMayChange(decodeUtf8(bytes), job.own)) return bytes

	const edited = editMarkup(bytes, `legacy drawing ${part}`)
	const { document, editor } = edited

	for (const node of descendants(document, document.documentElement())) {
		if (document.localName(node) !== "ClientData") continue

		const shape = document.parent(node)
		const gone = job.shift !== null && noteDeleted(document, node, job.shift)

		if (gone) {
			job.touch("commentShapes")
			editor.remove(shape)

			continue
		}

		let row = -1
		let col = -1
		let rowNode = -1
		let colNode = -1
		let anchorNode = -1

		for (const child of childElements(document, node)) {
			const local = document.localName(child)

			if (local === "Row") {
				rowNode = child
				row = Number(document.textContent(child).trim())
			} else if (local === "Column") {
				colNode = child
				col = Number(document.textContent(child).trim())
			} else if (local === "Anchor") {
				anchorNode = child
			} else if (VML_FORMULAS.has(local)) {
				shiftFormulaText(edited, child, job, "commentShapes", null)
			}
		}

		const shift = job.shift

		if (shift === null) continue

		const note = rowNode >= 0 && colNode >= 0 && Number.isInteger(row) && Number.isInteger(col)
		const at = note ? shiftCell(row, col, shift) : null

		if (anchorNode >= 0) {
			const text = document.textContent(anchorNode)
			// Cells shifted in a band: a note's box goes where its cell goes, as it is.
			const next =
				shift.band !== undefined && note
					? at === null
						? text
						: offsetVmlAnchor(text, shift.axis === "rows" ? at.row - row : at.col - col, shift)
					: shiftVmlAnchor(text, shift)

			if (next !== null && next !== text) {
				job.touch("commentShapes")
				editor.setText(anchorNode, next)
			}
		}

		if (at === null) continue
		if (at.row !== row) editor.setText(rowNode, String(at.row))
		if (at.col !== col) editor.setText(colNode, String(at.col))
		if (at.row !== row || at.col !== col) job.touch("commentShapes")
	}

	return editor.changed ? editor.serialize() : bytes
}

// An x:Anchor moved `by` along the shifted axis (kept on the sheet), or null when it does not read.
function offsetVmlAnchor(text: string, by: number, shift: AxisShift): string | null {
	if (by === 0) return text

	const values = text.split(",").map(part => Number(part.trim()))

	if (values.length !== 8 || values.some(value => !Number.isInteger(value))) return null

	const base = shift.axis === "rows" ? 2 : 0
	const last = axisLimit(shift.axis) - 1

	values[base] = Math.max(0, Math.min(last, (values[base] ?? 0) + by))
	values[base + 4] = Math.max(0, Math.min(last, (values[base + 4] ?? 0) + by))

	return values.join(", ")
}

// A shape's cell (x:Row, x:Column) was deleted.
function noteDeleted(document: XmlDocument, data: number, shift: AxisShift): boolean {
	const row = childByLocal(document, data, "Row")
	const col = childByLocal(document, data, "Column")

	if (row < 0 || col < 0) return false

	const r = Number(document.textContent(row).trim())
	const c = Number(document.textContent(col).trim())

	return Number.isInteger(r) && Number.isInteger(c) && shiftCell(r, c, shift) === null
}

const CONTROL_FORMULAS = ["fmlaLink", "fmlaRange", "fmlaTxbx", "fmlaGroup"]

// Form control properties (ctrlProp parts): linked cell and input range.
export function rewriteControlProperties(bytes: Uint8Array, job: RefJob, part: string): Uint8Array {
	if (!job.formulas.markupMayChange(decodeUtf8(bytes), job.own)) return bytes

	const edited = editMarkup(bytes, `control properties ${part}`)
	const root = edited.document.documentElement()

	for (const name of CONTROL_FORMULAS) shiftFormulaAttribute(edited, root, name, job, "formControls", null)

	return edited.editor.changed ? edited.editor.serialize() : bytes
}

// Connections: query parameters bound to a cell (always on a named sheet).
export function rewriteConnections(bytes: Uint8Array, job: RefJob, part: string): Uint8Array {
	if (!job.formulas.markupMayChange(decodeUtf8(bytes), null)) return bytes

	const edited = editMarkup(bytes, `connections ${part}`)

	for (const node of descendants(edited.document, edited.document.documentElement())) {
		if (edited.document.localName(node) === "parameter") shiftFormulaAttribute(edited, node, "cell", job, "connections", null)
	}

	return edited.editor.changed ? edited.editor.serialize() : bytes
}

// Real-time data topics: each tr names a cell (r) of a sheet by its sheetId (s).
export function rewriteVolatileDependencies(bytes: Uint8Array, job: RefJob, sheetId: number, deleted: boolean, part: string): Uint8Array {
	const edited = editMarkup(bytes, `volatile dependencies ${part}`)
	const { document, editor } = edited

	for (const node of descendants(document, document.documentElement())) {
		if (document.localName(node) !== "tr" || Number(document.attribute(node, "s") ?? "-1") !== sheetId) continue
		if (deleted) refuse("structureLocked", "volatileDependencies: sheet deleted")
		if (!shiftCellAttribute(edited, node, "r", job, "volatileDependencies"))
			refuse("structureLocked", "volatileDependencies: cell deleted")
	}

	return editor.changed ? editor.serialize() : bytes
}

// XML-mapped single cells of the edited sheet.
export function rewriteSingleCells(bytes: Uint8Array, job: RefJob, part: string): Uint8Array {
	const edited = editMarkup(bytes, `single cells ${part}`)
	const { document } = edited

	for (const node of descendants(document, document.documentElement())) {
		if (document.localName(node) === "singleXmlCell" && !shiftCellAttribute(edited, node, "r", job, "singleXmlCells"))
			refuse("structureLocked", "singleXmlCells: cell deleted")
	}

	return edited.editor.changed ? edited.editor.serialize() : bytes
}

// A pivot table on the edited sheet is locked: an edit that would move it or cut through it refuses.
export function checkPivotTable(bytes: Uint8Array, shift: AxisShift, part: string, touch: (construct: RefConstruct) => void): void {
	const { document } = editMarkup(bytes, `pivot table ${part}`)
	const location = childByLocal(document, document.documentElement(), "location")
	const range = parseRef(document.attribute(location, "ref") ?? "")

	if (location < 0 || range === null) refuse("pivot", "pivotTables: location")

	touch("pivotTables")

	const rows = shift.axis === "rows"

	if (shift.band !== undefined ? meetsMoved(range, shift) : reaches(rows ? range.endRow : range.endCol, shift))
		refuse("pivot", "pivotTables")
}

export interface PivotSource {
	readonly sheet: string | null
	readonly ref: SheetRange | null
	// A named source (a table or a defined name).
	readonly name: string | null
}

// The cache's source, read from the start of the part: a pivot cache definition can run to megabytes of items,
// and cacheSource comes before them.
export function pivotSource(bytes: Uint8Array, part: string): PivotSource | null {
	let source = false
	let found: PivotSource | null = null

	scanTags(bytes, `pivot cache ${part}`, (scanner, tag, end, depth) => {
		const bytes = scanner.bytes
		const name = nameEnd(bytes, tag + 1)

		if (depth === 1) {
			if (source) return true

			source = localIs(bytes, tag + 1, name, "cacheSource")

			return source && scanner.selfClosing
		}

		if (!source || depth !== 2 || !localIs(bytes, tag + 1, name, "worksheetSource")) return false

		let sheet: string | null = null
		let ref: string | null = null
		let named: string | null = null

		scanner.attributes(tag, end, (start, stop, valueStart, valueEnd) => {
			if (bytesAre(bytes, start, stop, "sheet")) sheet = scanner.attributeValue(valueStart, valueEnd)
			else if (bytesAre(bytes, start, stop, "ref")) ref = scanner.attributeValue(valueStart, valueEnd)
			else if (bytesAre(bytes, start, stop, "name")) named = scanner.attributeValue(valueStart, valueEnd)
		})

		found = { sheet, ref: ref === null ? null : parseRef(ref), name: named }

		return true
	})

	return found
}

// Visits a part's start tags in document order (the root at depth 0) without building a tree, until `visit`
// returns true; `visit` reads `scanner.bytes`, which are UTF-8 (a UTF-16 part is transcoded first). It accepts
// what parseXml accepts before the root: a UTF-8 byte order mark and an external document type declaration.
// Markup that does not read refuses (`what` names it).
function scanTags(input: Uint8Array, what: string, visit: (scanner: Scanner, tag: number, end: number, depth: number) => boolean): void {
	try {
		const bytes = utf8Part(input, what)
		const scanner = new Scanner(bytes, what)
		let depth = 0
		let at = prologEnd(scanner)

		for (;;) {
			const lt = bytes.indexOf(LT, at)

			if (lt < 0) scanner.fail("An element is not closed", at)

			const next = bytes[lt + 1]

			if (next === BANG || next === QUESTION) {
				at = scanner.markupEnd(lt)
			} else if (next === SLASH) {
				const close = bytes.indexOf(GT, lt)

				if (close < 0) scanner.fail("An end tag is not closed", lt)

				at = close + 1
				depth--

				if (depth === 0) return
			} else {
				const end = scanner.tagEnd(lt)

				if (visit(scanner, lt, end, depth)) return
				if (scanner.selfClosing && depth === 0) return
				if (!scanner.selfClosing) depth++

				at = end
			}
		}
	} catch (error) {
		if (error instanceof XlsxReadError) refuse("structureLocked", `${what}: malformed`)

		throw error
	}
}

// The part as UTF-8, detected as parseXml detects it (xml/parse.ts): a UTF-16 part, with or without its byte
// order mark, is transcoded; anything else is read as UTF-8.
function utf8Part(input: Uint8Array, what: string): Uint8Array {
	const b0 = input[0]
	const b1 = input[1]
	const littleEndian = (b0 === 0xff && b1 === 0xfe) || (b0 === LT && b1 === 0)

	if (!littleEndian && !((b0 === 0xfe && b1 === 0xff) || (b0 === 0 && b1 === LT))) return input

	if (input.length % 2 !== 0) throw new XlsxReadError("malformed", "Truncated UTF-16 part", what)

	return transcodeUtf16(input, b0 === 0xff || b0 === 0xfe ? 2 : 0, littleEndian)
}

// The root element's "<": past a UTF-8 byte order mark, the XML declaration, comments, processing instructions,
// white space and one external document type declaration (an internal subset refuses, as in parseXml).
function prologEnd(scanner: Scanner): number {
	const bytes = scanner.bytes
	let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
	let doctype = false

	for (;;) {
		while (isSpace(bytes[at])) at++

		if (bytes[at] !== LT) return scanner.rootStart(at)

		if (bytesAre(bytes, at + 1, at + 9, "!DOCTYPE")) {
			if (doctype) scanner.fail("A second document type declaration", at)

			doctype = true
			at = doctypeEnd(scanner, at)
		} else if (bytes[at + 1] === QUESTION || bytes[at + 1] === BANG) {
			at = scanner.markupEnd(at)
		} else {
			return at
		}
	}
}

function doctypeEnd(scanner: Scanner, start: number): number {
	const bytes = scanner.bytes
	let at = start + 9

	while (at < bytes.length && bytes[at] !== GT) {
		const b = bytes[at]

		if (b === 0x5b) scanner.fail("Internal DTD subsets are not allowed", at)
		if (b === LT) scanner.fail("A document type declaration is not closed", at)

		if (b === 0x22 || b === 0x27) {
			const close = bytes.indexOf(b, at + 1)

			at = close < 0 ? bytes.length : close + 1
		} else {
			at++
		}
	}

	if (at >= bytes.length) scanner.fail("A document type declaration is not closed", start)

	return at + 1
}

// A pivot cache sourced from cells is locked: an edit that would move or cut its source refuses; a rename of its
// sheet renames the source.
export function checkPivotSource(source: PivotSource, sheet: string, shift: AxisShift, touch: (construct: RefConstruct) => void): void {
	if (source.ref === null || source.sheet === null || !sameSheet(source.sheet, sheet)) return

	touch("pivotSources")

	const rows = shift.axis === "rows"

	if (shift.band !== undefined ? meetsMoved(source.ref, shift) : reaches(rows ? source.ref.endRow : source.ref.endCol, shift))
		refuse("pivot", "pivotSources")
}

export function renamePivotSource(bytes: Uint8Array, from: string, to: string, part: string): Uint8Array {
	const edited = editMarkup(bytes, `pivot cache ${part}`)
	const { document, editor } = edited
	const source = childByLocal(document, document.documentElement(), "cacheSource")
	const worksheet = source < 0 ? -1 : childByLocal(document, source, "worksheetSource")
	const sheet = worksheet < 0 ? undefined : document.attribute(worksheet, "sheet")

	if (sheet !== undefined && sameSheet(sheet, from)) editor.setAttribute(worksheet, "sheet", to)

	return editor.changed ? editor.serialize() : bytes
}

export interface SlicerSource {
	// x15:tableSlicerCache: the table's id and the column's id.
	readonly table: { readonly id: number; readonly column: number } | null
	// Pivot tables by the sheetId of their sheet (tabId).
	readonly pivotSheets: readonly number[]
}

// Slicer and timeline caches: what they read from.
export function slicerSource(bytes: Uint8Array, part: string): SlicerSource {
	let table: SlicerSource["table"] = null
	const pivotSheets: number[] = []

	scanTags(bytes, `slicer cache ${part}`, (scanner, tag, end, depth) => {
		const bytes = scanner.bytes
		const name = nameEnd(bytes, tag + 1)
		const slicer = depth > 0 && localIs(bytes, tag + 1, name, "tableSlicerCache")

		if (!slicer && (depth === 0 || !localIs(bytes, tag + 1, name, "pivotTable"))) return false

		let tableId = "-1"
		let column = "-1"
		let tabId: string | null = null

		scanner.attributes(tag, end, (start, stop, valueStart, valueEnd) => {
			if (slicer && bytesAre(bytes, start, stop, "tableId")) tableId = scanner.attributeValue(valueStart, valueEnd)
			else if (slicer && bytesAre(bytes, start, stop, "column")) column = scanner.attributeValue(valueStart, valueEnd)
			else if (!slicer && bytesAre(bytes, start, stop, "tabId")) tabId = scanner.attributeValue(valueStart, valueEnd)
		})

		if (slicer) table = { id: Number(tableId), column: Number(column) }
		else if (tabId !== null) pivotSheets.push(Number(tabId))

		return false
	})

	return { table, pivotSheets }
}

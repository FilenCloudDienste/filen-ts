import { XmlEditor, encodeUtf8, parseXml, type XmlDocument } from "../../xml/index"
import type { SheetProtectedAction, SheetRange } from "../../sheet/protocol"
import {
	ColFlag,
	type XlsxColRange,
	type XlsxColor,
	type XlsxProtectionHash,
	type XlsxSheetFormat,
	type XlsxSheetModel,
	type XlsxSheetProtection,
	type XlsxSheetView
} from "../model/types"
import { readView as readSheetView } from "../read/worksheet"
import { attr, qualify, spliceAttributes } from "./markup"
import { cellRef, formatNumber, parseRangeRef, rangeRef, readBoolean } from "./text"

// The worksheet sections the writer owns (sheetPr, dimension, sheetViews, sheetFormatPr, cols, mergeCells,
// sheetProtection): each serialised from the model as a splice of its source element (unknown attributes and
// children kept), and each read back the same way for the gate.

// --- Attributes ---

// One attribute as the model has it: `value` is its text, or null when absent or at its default; `read` puts a
// source value in the same terms, so an attribute already right keeps its text.
export interface AttributeField {
	readonly name: string
	readonly value: string | null
	readonly read: (source: string | undefined) => string | null
}

export function booleanField(name: string, value: boolean, fallback: boolean): AttributeField {
	return {
		name,
		value: value === fallback ? null : value ? "1" : "0",
		read: source => {
			const read = readBoolean(source, fallback)

			return read === fallback ? null : read ? "1" : "0"
		}
	}
}

// A source attribute's number as `canonical` writes it; one that is no finite number (malformed, overflowing) reads
// as absent, so the model's value is written over it rather than refusing the save.
function sourceNumber(source: string, canonical: (n: number) => string | null): string | null {
	const n = Number(source)

	return Number.isFinite(n) ? canonical(n) : null
}

export function numberField(name: string, value: number, fallback: number = Number.NaN): AttributeField {
	const canonical = (n: number): string | null => (Number.isNaN(n) || n === fallback ? null : formatNumber(n, name))

	return {
		name,
		value: canonical(value),
		read: source => (source === undefined || source.trim() === "" ? null : sourceNumber(source, canonical))
	}
}

export function textField(name: string, value: string | undefined, fallback?: string): AttributeField {
	return {
		name,
		value: value === undefined || value === fallback ? null : value,
		read: source => (source === fallback ? null : (source ?? null))
	}
}

// `element` with `fields` set, or a new empty element `name` holding them when there is none.
export function syncAttributes(element: Uint8Array | null, name: string, fields: readonly AttributeField[]): Uint8Array {
	if (element === null) {
		let markup = `<${name}`

		for (const field of fields) if (field.value !== null) markup += attr(field.name, field.value)

		return encodeUtf8(`${markup}/>`)
	}

	const document = parseXml(element)
	const root = document.documentElement()
	const updates = new Map<string, string | null>()

	for (const field of fields) {
		const source = document.attribute(root, field.name)

		if (field.read(source) !== field.value) updates.set(field.name, field.value)
	}

	return spliceAttributes(element, updates)
}

// The fields' values as read from an element: what the model must equal.
function readFields(document: XmlDocument, node: number, fields: readonly AttributeField[]): Map<string, string | null> {
	const out = new Map<string, string | null>()

	for (const field of fields) out.set(field.name, node < 0 ? null : field.read(document.attribute(node, field.name)))

	return out
}

function sameFields(document: XmlDocument, node: number, fields: readonly AttributeField[]): boolean {
	const read = readFields(document, node, fields)

	return fields.every(field => read.get(field.name) === field.value)
}

export function childElement(document: XmlDocument, node: number, local: string): number {
	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === local) return child
	}

	return -1
}

// --- Colours ---

export function colorAttributes(color: XlsxColor): string {
	let out = ""

	if (color.auto === true) out += attr("auto", 1)
	if (color.indexed !== undefined) out += attr("indexed", color.indexed)
	if (color.argb !== undefined) out += attr("rgb", (color.argb >>> 0).toString(16).toUpperCase().padStart(8, "0"))
	if (color.theme !== undefined) out += attr("theme", color.theme)
	if (color.tint !== undefined && color.tint !== 0) out += attr("tint", formatNumber(color.tint, "tint"))

	return out
}

export function readColor(document: XmlDocument, node: number): XlsxColor {
	const rgb = document.attribute(node, "rgb")
	const theme = document.attribute(node, "theme")
	const tint = document.attribute(node, "tint")
	const indexed = document.attribute(node, "indexed")
	const auto = readBoolean(document.attribute(node, "auto"), false)
	const color: { argb?: number; theme?: number; tint?: number; indexed?: number; auto?: boolean } = {}

	if (rgb !== undefined) color.argb = Number.parseInt(rgb.length === 6 ? `FF${rgb}` : rgb, 16) >>> 0
	if (theme !== undefined) color.theme = Number(theme)
	if (tint !== undefined && Number(tint) !== 0) color.tint = Number(tint)
	if (indexed !== undefined) color.indexed = Number(indexed)
	if (auto) color.auto = true

	return color
}

export function sameColor(a: XlsxColor | null | undefined, b: XlsxColor | null | undefined): boolean {
	if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null)

	return (
		a.argb === b.argb &&
		a.theme === b.theme &&
		(a.tint ?? 0) === (b.tint ?? 0) &&
		a.indexed === b.indexed &&
		(a.auto ?? false) === (b.auto ?? false)
	)
}

// --- sheetPr ---

export function readTabColor(section: Uint8Array | null): XlsxColor | null {
	if (section === null) return null

	const document = parseXml(section)
	const tab = childElement(document, document.documentElement(), "tabColor")

	return tab < 0 ? null : readColor(document, tab)
}

export function writeSheetPr(sheet: XlsxSheetModel, section: Uint8Array | null, prefix: string): Uint8Array | null {
	const colored = writeTabColor(sheet, section, prefix)
	const filtered =
		sheet.filterMode === undefined || (colored === null && !sheet.filterMode)
			? colored
			: syncAttributes(colored, qualify(prefix, "sheetPr"), [booleanField("filterMode", sheet.filterMode, false)])

	return writeFitToPage(sheet, filtered, prefix)
}

// pageSetUpPr fitToPage (§18.3.1.65), the last child sheetPr's schema allows (CT_SheetPr).
function writeFitToPage(sheet: XlsxSheetModel, section: Uint8Array | null, prefix: string): Uint8Array | null {
	const fit = sheet.fitToPage

	if (fit === undefined) return section

	const field = [booleanField("fitToPage", fit, false)]

	if (section === null) {
		if (!fit) return null

		return encodeUtf8(
			`<${qualify(prefix, "sheetPr")}><${qualify(prefix, "pageSetUpPr")}${attr("fitToPage", "1")}/></${qualify(prefix, "sheetPr")}>`
		)
	}

	const document = parseXml(section)
	const root = document.documentElement()
	const existing = childElement(document, root, "pageSetUpPr")

	if (existing < 0) {
		if (!fit) return section

		const editor = new XmlEditor(document)

		editor.append(root, syncAttributes(null, qualify(prefix, "pageSetUpPr"), field))

		return editor.serialize()
	}

	if (readBoolean(document.attribute(existing, "fitToPage"), false) === fit) return section

	const editor = new XmlEditor(document)

	editor.replace(existing, syncAttributes(document.raw(existing), qualify(prefix, "pageSetUpPr"), field))

	return editor.serialize()
}

function writeTabColor(sheet: XlsxSheetModel, section: Uint8Array | null, prefix: string): Uint8Array | null {
	if (sameColor(readTabColor(section), sheet.tabColor)) return section

	const tab = sheet.tabColor === null ? "" : `<${qualify(prefix, "tabColor")}${colorAttributes(sheet.tabColor)}/>`

	if (section === null) return encodeUtf8(`<${qualify(prefix, "sheetPr")}>${tab}</${qualify(prefix, "sheetPr")}>`)

	const document = parseXml(section)
	const root = document.documentElement()
	const editor = new XmlEditor(document)
	const existing = childElement(document, root, "tabColor")

	if (existing >= 0) editor.replace(existing, tab)
	else editor.prepend(root, tab)

	return editor.serialize()
}

// --- dimension ---

export function readDimension(section: Uint8Array | null): SheetRange | null {
	if (section === null) return null

	const document = parseXml(section)
	const ref = document.attribute(document.documentElement(), "ref")

	return ref === undefined ? null : (parseRangeRef(ref) ?? null)
}

export function writeDimension(range: SheetRange | null, section: Uint8Array | null, prefix: string): Uint8Array {
	return syncAttributes(section, qualify(prefix, "dimension"), [textField("ref", range === null ? "A1" : rangeRef(range))])
}

// --- sheetFormatPr ---

function formatFields(format: XlsxSheetFormat): AttributeField[] {
	return [
		numberField("baseColWidth", format.baseColWidth, 8),
		numberField("defaultColWidth", format.defaultColWidth),
		{
			...numberField("defaultRowHeight", format.defaultRowHeight),
			read: source => (source === undefined ? null : sourceNumber(source, formatNumber))
		},
		booleanField("customHeight", format.customHeight, false),
		booleanField("zeroHeight", format.zeroHeight, false),
		booleanField("thickTop", format.thickTop, false),
		booleanField("thickBottom", format.thickBottom, false),
		numberField("outlineLevelRow", format.outlineLevelRow, 0),
		numberField("outlineLevelCol", format.outlineLevelCol, 0)
	]
}

export function sameFormat(section: Uint8Array | null, format: XlsxSheetFormat): boolean {
	if (section === null) return false

	const document = parseXml(section)

	return sameFields(document, document.documentElement(), formatFields(format))
}

export function writeSheetFormatPr(format: XlsxSheetFormat, section: Uint8Array | null, prefix: string): Uint8Array {
	return syncAttributes(section, qualify(prefix, "sheetFormatPr"), formatFields(format))
}

// --- cols ---

function colFields(col: XlsxColRange): AttributeField[] {
	const outline = (col.flags & ColFlag.OUTLINE_MASK) >> ColFlag.OUTLINE_SHIFT

	return [
		numberField("min", col.first + 1),
		numberField("max", col.last + 1),
		numberField("width", col.width),
		numberField("style", col.style, -1),
		booleanField("hidden", (col.flags & ColFlag.HIDDEN) !== 0, false),
		booleanField("bestFit", (col.flags & ColFlag.BEST_FIT) !== 0, false),
		booleanField("customWidth", (col.flags & ColFlag.CUSTOM_WIDTH) !== 0, false),
		booleanField("phonetic", (col.flags & ColFlag.PHONETIC) !== 0, false),
		numberField("outlineLevel", outline, 0),
		booleanField("collapsed", (col.flags & ColFlag.COLLAPSED) !== 0, false)
	]
}

export function readCols(section: Uint8Array | null): XlsxColRange[] {
	if (section === null) return []

	const document = parseXml(section)
	const out: XlsxColRange[] = []

	for (let col = document.firstChildElement(document.documentElement()); col >= 0; col = document.nextSiblingElement(col)) {
		if (document.localName(col) !== "col") continue

		const flag = (name: string, bit: number): number => (readBoolean(document.attribute(col, name), false) ? bit : 0)
		const outline = Math.max(0, Math.min(7, Number(document.attribute(col, "outlineLevel") ?? 0) || 0))
		const width = document.attribute(col, "width")
		const style = document.attribute(col, "style")

		out.push({
			first: Number(document.attribute(col, "min") ?? 0) - 1,
			last: Number(document.attribute(col, "max") ?? 0) - 1,
			width: width === undefined ? Number.NaN : Number(width),
			style: style === undefined ? -1 : Number(style),
			flags:
				flag("hidden", ColFlag.HIDDEN) |
				flag("bestFit", ColFlag.BEST_FIT) |
				flag("customWidth", ColFlag.CUSTOM_WIDTH) |
				flag("phonetic", ColFlag.PHONETIC) |
				flag("collapsed", ColFlag.COLLAPSED) |
				(outline << ColFlag.OUTLINE_SHIFT)
		})
	}

	return out
}

export function sameCol(a: XlsxColRange | undefined, b: XlsxColRange | undefined): boolean {
	if (a === undefined || b === undefined) return a === b

	return (
		a.first === b.first &&
		a.last === b.last &&
		(Number.isNaN(a.width) ? Number.isNaN(b.width) : a.width === b.width) &&
		a.style === b.style &&
		a.flags === b.flags
	)
}

// "" when there are no column ranges (the section goes).
export function writeCols(cols: readonly XlsxColRange[], section: Uint8Array | null, prefix: string): Uint8Array {
	const source = readCols(section)

	if (section !== null && source.length === cols.length && cols.every((col, index) => sameCol(col, source[index]))) return section
	if (cols.length === 0) return new Uint8Array(0)

	const document = section === null ? null : parseXml(section)
	const elements: number[] = []

	if (document !== null) {
		for (let col = document.firstChildElement(document.documentElement()); col >= 0; col = document.nextSiblingElement(col)) {
			if (document.localName(col) === "col") elements.push(col)
		}
	}

	const name = qualify(prefix, "col")
	const chunks: Uint8Array[] = [encodeUtf8(`<${qualify(prefix, "cols")}>`)]

	for (const col of cols) {
		const at = source.findIndex(candidate => sameCol(candidate, col))

		// An equal source range keeps its element (its own attribute spellings and extensions).
		if (document !== null && at >= 0) chunks.push(document.raw(elements[at] as number))
		else chunks.push(syncAttributes(null, name, colFields(col)))
	}

	chunks.push(encodeUtf8(`</${qualify(prefix, "cols")}>`))

	return join(chunks)
}

export function join(chunks: readonly Uint8Array[]): Uint8Array {
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

// --- mergeCells ---

// Quads; a reference that is not a cell range reads as all ones (so it never equals the model).
export function readMerges(section: Uint8Array | null): Uint32Array {
	if (section === null) return new Uint32Array(0)

	const document = parseXml(section)
	const out: number[] = []

	for (let merge = document.firstChildElement(document.documentElement()); merge >= 0; merge = document.nextSiblingElement(merge)) {
		if (document.localName(merge) !== "mergeCell") continue

		const range = parseRangeRef(document.attribute(merge, "ref") ?? "")

		if (range === undefined) out.push(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff)
		else out.push(range.startRow, range.startCol, range.endRow, range.endCol)
	}

	return Uint32Array.from(out)
}

export function sameQuads(a: Uint32Array, b: Uint32Array): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

export function writeMergeCells(merges: Uint32Array, section: Uint8Array | null, prefix: string): Uint8Array {
	if (section !== null && sameQuads(readMerges(section), merges)) return section
	if (merges.length === 0) return new Uint8Array(0)

	let markup = `<${qualify(prefix, "mergeCells")} count="${merges.length / 4}">`

	for (let k = 0; k + 3 < merges.length; k += 4) {
		const range = { startRow: merges[k] ?? 0, startCol: merges[k + 1] ?? 0, endRow: merges[k + 2] ?? 0, endCol: merges[k + 3] ?? 0 }

		markup += `<${qualify(prefix, "mergeCell")} ref="${rangeRef(range)}"/>`
	}

	return encodeUtf8(`${markup}</${qualify(prefix, "mergeCells")}>`)
}

// --- sheetProtection ---

// Each action and whether the attribute that locks it defaults to locked (§18.3.1.85): an allowed action is
// written as its attribute false.
const PROTECTION_DEFAULTS: readonly (readonly [SheetProtectedAction, boolean])[] = [
	["objects", false],
	["scenarios", false],
	["formatCells", true],
	["formatColumns", true],
	["formatRows", true],
	["insertColumns", true],
	["insertRows", true],
	["insertHyperlinks", true],
	["deleteColumns", true],
	["deleteRows", true],
	["selectLockedCells", false],
	["sort", true],
	["autoFilter", true],
	["pivotTables", true],
	["selectUnlockedCells", false]
]

export function hashFields(
	hash: XlsxProtectionHash,
	names: { algorithm: string; hash: string; salt: string; spin: string; legacy: string }
): AttributeField[] {
	return [
		textField(names.legacy, hash.legacy),
		textField(names.algorithm, hash.algorithmName),
		textField(names.hash, hash.hashValue),
		textField(names.salt, hash.saltValue),
		numberField(names.spin, hash.spinCount ?? Number.NaN)
	]
}

const SHEET_HASH = { algorithm: "algorithmName", hash: "hashValue", salt: "saltValue", spin: "spinCount", legacy: "password" }

function protectionFields(protection: XlsxSheetProtection): AttributeField[] {
	return [
		...hashFields(protection.hash, SHEET_HASH),
		booleanField("sheet", true, false),
		...PROTECTION_DEFAULTS.map(([action, locked]) => booleanField(action, !protection.allows.has(action), locked))
	]
}

function readHash(
	document: XmlDocument,
	node: number,
	names: { algorithm: string; hash: string; salt: string; spin: string; legacy: string }
): XlsxProtectionHash {
	const hash: { algorithmName?: string; hashValue?: string; saltValue?: string; spinCount?: number; legacy?: string } = {}
	const algorithm = document.attribute(node, names.algorithm)
	const value = document.attribute(node, names.hash)
	const salt = document.attribute(node, names.salt)
	const spin = document.attribute(node, names.spin)
	const legacy = document.attribute(node, names.legacy)

	if (algorithm !== undefined) hash.algorithmName = algorithm
	if (value !== undefined) hash.hashValue = value
	if (salt !== undefined) hash.saltValue = salt
	if (spin !== undefined) hash.spinCount = Number(spin)
	if (legacy !== undefined) hash.legacy = legacy

	return hash
}

export function sameHash(a: XlsxProtectionHash, b: XlsxProtectionHash): boolean {
	return (
		a.algorithmName === b.algorithmName &&
		a.hashValue === b.hashValue &&
		a.saltValue === b.saltValue &&
		a.spinCount === b.spinCount &&
		a.legacy === b.legacy
	)
}

export function readProtection(section: Uint8Array | null): XlsxSheetProtection | null {
	if (section === null) return null

	const document = parseXml(section)
	const root = document.documentElement()

	if (!readBoolean(document.attribute(root, "sheet"), false)) return null

	const allows = new Set<SheetProtectedAction>()

	for (const [action, locked] of PROTECTION_DEFAULTS) if (!readBoolean(document.attribute(root, action), locked)) allows.add(action)

	return { hash: readHash(document, root, SHEET_HASH), allows }
}

export function sameProtection(a: XlsxSheetProtection | null, b: XlsxSheetProtection | null): boolean {
	if (a === null || b === null) return a === b

	return sameHash(a.hash, b.hash) && a.allows.size === b.allows.size && [...a.allows].every(action => b.allows.has(action))
}

// Unprotected, an element that does not protect (Excel keeps the Protect Sheet choices in one without sheet="1"
// once a sheet is unprotected) stays as written.
export function writeSheetProtection(protection: XlsxSheetProtection | null, section: Uint8Array | null, prefix: string): Uint8Array {
	if (protection === null) return section !== null && section.length > 0 && readProtection(section) === null ? section : new Uint8Array(0)

	return syncAttributes(section, qualify(prefix, "sheetProtection"), protectionFields(protection))
}

// --- sheetViews ---

// The view's first cell (topLeftCell): none at A1, and a source's way of writing it read as the cell it names.
function topLeftField(view: XlsxSheetView): AttributeField {
	const name = (row: number, col: number): string | null => (row === 0 && col === 0 ? null : cellRef(row, col))

	return {
		name: "topLeftCell",
		value: name(view.topRow, view.leftCol),
		read: source => {
			const range = source === undefined ? undefined : parseRangeRef(source)

			return range === undefined ? (source ?? null) : name(range.startRow, range.startCol)
		}
	}
}

function viewFields(view: XlsxSheetView): AttributeField[] {
	return [
		topLeftField(view),
		booleanField("tabSelected", view.tabSelected, false),
		booleanField("showGridLines", view.gridLines, true),
		booleanField("showRowColHeaders", view.headings, true),
		booleanField("rightToLeft", view.rightToLeft, false),
		numberField("zoomScale", view.zoom, 100),
		textField("view", view.view, "normal")
	]
}

type Frozen = XlsxSheetView["frozen"]

function activePane(frozen: NonNullable<Frozen>): string {
	return frozen.rows > 0 && frozen.cols > 0 ? "bottomRight" : frozen.rows > 0 ? "bottomLeft" : "topRight"
}

// The panes a frozen split has: an active pane must be one of them.
function paneExists(name: string, frozen: NonNullable<Frozen>): boolean {
	if (name === "topLeft") return true
	if (name === "bottomRight") return frozen.rows > 0 && frozen.cols > 0
	if (name === "bottomLeft") return frozen.rows > 0
	if (name === "topRight") return frozen.cols > 0

	return false
}

function sameRanges(a: readonly SheetRange[], b: readonly SheetRange[]): boolean {
	return (
		a.length === b.length &&
		a.every((range, k) => {
			const other = b[k] as SheetRange

			return (
				range.startRow === other.startRow &&
				range.startCol === other.startCol &&
				range.endRow === other.endRow &&
				range.endCol === other.endCol
			)
		})
	)
}

function sameFrozen(a: Frozen, b: Frozen): boolean {
	if (a === null || b === null) return a === b

	return a.rows === b.rows && a.cols === b.cols && a.topLeftRow === b.topLeftRow && a.topLeftCol === b.topLeftCol
}

function sameSelection(a: XlsxSheetView, b: XlsxSheetView): boolean {
	return a.activeRow === b.activeRow && a.activeCol === b.activeCol && sameRanges(a.selection, b.selection)
}

function sameViews(a: XlsxSheetView, b: XlsxSheetView): boolean {
	return (
		sameFrozen(a.frozen, b.frozen) &&
		a.topRow === b.topRow &&
		a.leftCol === b.leftCol &&
		sameSelection(a, b) &&
		a.zoom === b.zoom &&
		a.gridLines === b.gridLines &&
		a.headings === b.headings &&
		a.rightToLeft === b.rightToLeft &&
		a.tabSelected === b.tabSelected &&
		a.view === b.view
	)
}

function firstSheetView(document: XmlDocument): number {
	return childElement(document, document.documentElement(), "sheetView")
}

// Whether the first sheetView reads as `view`, read the one way the reader reads it (other views, panes and
// selections the model does not hold are kept as written).
export function sameView(section: Uint8Array | null, view: XlsxSheetView): boolean {
	if (section === null) return false

	const document = parseXml(section)
	const node = firstSheetView(document)

	return node >= 0 && sameViews(readSheetView(document, node), view)
}

function selectionMarkup(view: XlsxSheetView, prefix: string, pane: string | undefined): string {
	const sqref = view.selection.length === 0 ? cellRef(view.activeRow, view.activeCol) : view.selection.map(rangeRef).join(" ")

	return `<${qualify(prefix, "selection")}${pane === undefined ? "" : attr("pane", pane)}${attr("activeCell", cellRef(view.activeRow, view.activeCol))}${attr("sqref", sqref)}/>`
}

function frozenPaneMarkup(frozen: NonNullable<Frozen>, prefix: string, pane: string): string {
	return (
		`<${qualify(prefix, "pane")}${frozen.cols > 0 ? attr("xSplit", frozen.cols) : ""}${frozen.rows > 0 ? attr("ySplit", frozen.rows) : ""}` +
		`${attr("topLeftCell", cellRef(frozen.topLeftRow, frozen.topLeftCol))}${attr("activePane", pane)}${attr("state", "frozen")}/>`
	)
}

function panesMarkup(view: XlsxSheetView, prefix: string): string {
	const frozen = view.frozen

	if (frozen === null || (frozen.rows === 0 && frozen.cols === 0)) return selectionMarkup(view, prefix, undefined)

	const pane = activePane(frozen)

	return frozenPaneMarkup(frozen, prefix, pane) + selectionMarkup(view, prefix, pane)
}

// The first sheetView's pane and active selection brought to the model, as a splice: a split pane the model does
// not hold, other panes' selections and the attributes of both are kept as written.
function splicePanes(document: XmlDocument, node: number, editor: XmlEditor, view: XlsxSheetView, prefix: string): void {
	const read = readSheetView(document, node)
	const pane = childElement(document, node, "pane")
	const state = pane < 0 ? undefined : document.attribute(pane, "state")
	const sourceFrozen = state === "frozen" || state === "frozenSplit"
	const frozen = view.frozen !== null && (view.frozen.rows > 0 || view.frozen.cols > 0) ? view.frozen : null
	const selections: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === "selection") selections.push(child)

	// The active pane after the splice, undefined without a pane.
	let active: string | undefined = pane < 0 ? undefined : (document.attribute(pane, "activePane") ?? "topLeft")
	let insertedPane = ""
	let paneGone = false

	if (!sameFrozen(read.frozen, view.frozen)) {
		if (frozen === null) {
			// Unfrozen: a frozen pane goes (a split one, which reads as no frozen pane, stays).
			if (sourceFrozen) {
				editor.remove(pane)
				paneGone = true
				active = undefined
			}
		} else if (pane < 0) {
			active = activePane(frozen)
			insertedPane = frozenPaneMarkup(frozen, prefix, active)
		} else {
			const keep = active !== undefined && sourceFrozen && paneExists(active, frozen) ? active : activePane(frozen)
			const set = (name: string, value: string | null): void => {
				if (document.attribute(pane, name) === (value ?? undefined)) return
				if (value === null) editor.removeAttribute(pane, name)
				else editor.setAttribute(pane, name, value)
			}

			set("xSplit", frozen.cols > 0 ? String(frozen.cols) : null)
			set("ySplit", frozen.rows > 0 ? String(frozen.rows) : null)
			set("topLeftCell", cellRef(frozen.topLeftRow, frozen.topLeftCol))
			set("activePane", keep)
			if (!sourceFrozen) set("state", "frozen")
			active = keep
		}
	}

	// The selection the reader takes after the splice: the active pane's, else the first left. A pane the split
	// no longer has takes its selection with it (as Excel writes only the panes that exist).
	const before = readSelection(document, node)
	const resplit = frozen !== null && !sameFrozen(read.frozen, view.frozen)
	let target = -1
	const kept = selections.filter(selection => {
		const name = document.attribute(selection, "pane") ?? "topLeft"
		const gone = (paneGone && name !== "topLeft") || (resplit && !paneExists(name, frozen))

		if (gone) editor.remove(selection)

		return !gone
	})

	for (const selection of kept) {
		const name = document.attribute(selection, "pane") ?? "topLeft"

		if (target < 0) target = selection
		if (active !== undefined && name === active) {
			target = selection

			break
		}
	}

	if (target < 0 || (active !== undefined && active !== "topLeft" && (document.attribute(target, "pane") ?? "topLeft") !== active)) {
		const markup = selectionMarkup(view, prefix, active === "topLeft" ? undefined : active)

		if (insertedPane !== "") editor.prepend(node, insertedPane + markup)
		else if (pane >= 0 && !paneGone) editor.insertAfter(pane, markup)
		else editor.prepend(node, markup)

		return
	}

	if (insertedPane !== "") editor.prepend(node, insertedPane)
	if (target === before && sameSelection(read, view)) return

	editor.setAttribute(target, "activeCell", cellRef(view.activeRow, view.activeCol))
	editor.setAttribute(
		target,
		"sqref",
		view.selection.length === 0 ? cellRef(view.activeRow, view.activeCol) : view.selection.map(rangeRef).join(" ")
	)
}

// The selection element the reader takes for the first view's model (the active pane's, else the first).
function readSelection(document: XmlDocument, node: number): number {
	const pane = childElement(document, node, "pane")
	const active = pane < 0 ? undefined : (document.attribute(pane, "activePane") ?? "topLeft")
	let found = -1

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) !== "selection") continue
		if (found < 0) found = child
		if ((document.attribute(child, "pane") ?? "topLeft") === active) return child
	}

	return found
}

export function writeSheetViews(view: XlsxSheetView, section: Uint8Array | null, prefix: string): Uint8Array {
	const fields = viewFields(view)
	const document = section === null ? null : parseXml(section)
	const node = document === null ? -1 : firstSheetView(document)

	if (document === null || node < 0) {
		let markup = `<${qualify(prefix, "sheetView")}`

		for (const field of fields) if (field.value !== null) markup += attr(field.name, field.value)

		const inner = `${markup}${attr("workbookViewId", 0)}>${panesMarkup(view, prefix)}</${qualify(prefix, "sheetView")}>`

		if (document === null) return encodeUtf8(`<${qualify(prefix, "sheetViews")}>${inner}</${qualify(prefix, "sheetViews")}>`)

		const editor = new XmlEditor(document)

		editor.prepend(document.documentElement(), inner)

		return editor.serialize()
	}

	const editor = new XmlEditor(document)

	for (const field of fields) {
		const source = document.attribute(node, field.name)

		if (field.read(source) === field.value) continue

		if (field.value === null) editor.removeAttribute(node, field.name)
		else editor.setAttribute(node, field.name, field.value)
	}

	const read = readSheetView(document, node)

	if (!sameFrozen(read.frozen, view.frozen) || !sameSelection(read, view)) splicePanes(document, node, editor, view, prefix)

	return editor.changed ? editor.serialize() : (section ?? new Uint8Array(0))
}

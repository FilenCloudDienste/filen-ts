import { D, drawingReader, type DrawingReader } from "../../drawingml/reader"
import { MAX_POINTS } from "../../drawingml/chart/data"
import { NodeKind, XmlEditor, decodeUtf8, escapeAttribute, escapeText, parseXml, type XmlDocument } from "../../xml/index"
import { encodeXstring } from "../edit/document"
import { decodeXstring } from "../model/strings"
import { boundedRange, chartAreas, type ChartArea, type ChartNameLookup } from "./refs"

// The values a chart caches beside each data reference (c:numCache, c:strCache, c:multiLvlStrCache; ECMA-376 Part 1
// §21.2.2.120, §21.2.2.199, §21.2.2.116), read again from the cells the reference names, as Excel writes them on
// save: numbers with the first cell's number format (a point whose format differs carries its own), text as the
// cells show it, points only for cells that hold something. A cache whose reference reads nothing here (another
// workbook, a function, a name for something else) stays as the file has it, and so does one already equal to the
// cells: a chart whose caches all match keeps its bytes. Equal means as Excel reads them: numbers by value (Excel
// writes 17 significant digits), text with its ST_Xstring escapes decoded. A pivot chart's caches are the pivot
// table's, never its cells' (its references name the table's area, labels and totals included): kept as they are.

export type ChartCellKind = "number" | "text" | "boolean" | "error" | "empty"

export interface ChartCell {
	readonly kind: ChartCellKind
	// The number a "number" cell holds (dates are serials).
	readonly number: number
	// The cell's text as shown (its number format applied).
	readonly text: string
	// Its number format code.
	readonly format: string
}

export interface ChartSheetCells {
	// The last row and column holding a cell, -1 for none: where a whole column or row reference stops.
	readonly lastRow: number
	readonly lastCol: number
	cell(row: number, col: number): ChartCell
	// Whether the cell's row or column is hidden (hiddenRow or hiddenCol).
	hidden(row: number, col: number): boolean
	hiddenRow(row: number): boolean
	hiddenCol(col: number): boolean
}

export interface ChartCells {
	// A sheet by the name a formula uses (any case), null when the workbook has none by it or it cannot be read.
	sheet(name: string): ChartSheetCells | null
	readonly names: ChartNameLookup
}

const REF_ELEMENTS: ReadonlySet<string> = new Set(["numRef", "strRef", "multiLvlStrRef"])

// The data references of a chart part: each numRef, strRef and multiLvlStrRef with its formula.
export interface ChartReference {
	readonly node: number
	readonly kind: "numRef" | "strRef" | "multiLvlStrRef"
	readonly formula: string
}

export function chartReferences(reader: DrawingReader): ChartReference[] {
	const document = reader.document
	const out: ChartReference[] = []

	for (let node = 0; node < document.count; node++) {
		if (document.kind(node) !== NodeKind.Element || reader.group(node) !== D.C) continue

		const local = reader.local(node)

		if (!REF_ELEMENTS.has(local)) continue

		const formula = reader.child(node, D.C, "f")

		if (formula >= 0) out.push({ node, kind: local as ChartReference["kind"], formula: reader.text(formula).trim() })
	}

	return out
}

// The sheets the chart's references read (as their formulas name them, upper case); none for a pivot chart, whose
// caches are never read again from cells.
export function chartSheetNames(document: XmlDocument, names: ChartNameLookup): Set<string> {
	const sheets = new Set<string>()
	const reader = drawingReader(document)

	if (isPivotChart(reader)) return sheets

	for (const reference of chartReferences(reader))
		for (const area of chartAreas(reference.formula, names) ?? []) sheets.add(area.sheet.toUpperCase())

	return sheets
}

interface Point {
	readonly idx: number
	readonly value: string
	// A number point's own format code, when it differs from the cache's.
	readonly format: string | undefined
}

interface Cache {
	readonly format: string | undefined
	readonly count: number
	readonly points: readonly Point[]
}

interface Levels {
	readonly count: number
	readonly levels: readonly (readonly Point[])[]
}

// The cells of the areas in order (each area row by row), or null when a sheet is missing or there are too many.
// `visibleOnly`: cells in hidden rows and columns are left out (a chart that plots visible cells only).
function cellsOf(areas: readonly ChartArea[], cells: ChartCells, visibleOnly: boolean): ChartCell[] | null {
	const out: ChartCell[] = []

	for (const area of areas) {
		const sheet = cells.sheet(area.sheet)

		if (sheet === null) return null

		const range = boundedRange(area.range, sheet.lastRow, sheet.lastCol)

		if ((range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1) + out.length > MAX_POINTS) return null

		for (let row = range.startRow; row <= range.endRow; row++)
			for (let col = range.startCol; col <= range.endCol; col++)
				if (!visibleOnly || !sheet.hidden(row, col)) out.push(sheet.cell(row, col))
	}

	return out
}

// xsd:double as JavaScript writes it (shortest round trip).
function numberText(value: number): string {
	return String(value)
}

// `fileFormat`: the cache's format code as the file has it, kept when no cell holds a number.
function numberCache(cells: readonly ChartCell[], fileFormat: string | undefined): Cache {
	const first = cells.find(cell => cell.kind === "number")
	const format = first?.format ?? fileFormat ?? "General"
	const points: Point[] = []

	cells.forEach((cell, idx) => {
		if (cell.kind === "number" && Number.isFinite(cell.number))
			points.push({ idx, value: numberText(cell.number), format: cell.format === format ? undefined : cell.format })
	})

	return { format, count: cells.length, points }
}

function stringCache(cells: readonly ChartCell[]): Cache {
	const points: Point[] = []

	cells.forEach((cell, idx) => {
		if (cell.kind !== "empty" && cell.text !== "") points.push({ idx, value: cell.text, format: undefined })
	})

	return { format: undefined, count: cells.length, points }
}

function readCache(reader: DrawingReader, cache: number): Cache | null {
	if (cache < 0) return null

	const formatNode = reader.child(cache, D.C, "formatCode")
	const points = reader.children(cache, D.C, "pt").map(pt => ({
		idx: reader.number(pt, "idx", -1),
		value: decodeXstring(reader.text(reader.child(pt, D.C, "v"))),
		format: reader.attr(pt, "formatCode")
	}))

	return {
		format: formatNode < 0 ? undefined : reader.text(formatNode),
		count: reader.number(reader.child(cache, D.C, "ptCount"), "val", -1),
		points
	}
}

// `numeric`: values compare as the numbers they write (xsd:double), so 0.10000000000000001 is 0.1.
function sameValue(a: string, b: string, numeric: boolean): boolean {
	if (a === b) return true
	if (!numeric) return false

	const x = Number(a)

	return !Number.isNaN(x) && a.trim() !== "" && b.trim() !== "" && x === Number(b)
}

function samePoints(a: readonly Point[], b: readonly Point[], numeric: boolean): boolean {
	if (a.length !== b.length) return false

	for (let index = 0; index < a.length; index++) {
		const x = a[index]
		const y = b[index]

		if (x === undefined || y === undefined || x.idx !== y.idx || x.format !== y.format || !sameValue(x.value, y.value, numeric))
			return false
	}

	return true
}

function sameCache(a: Cache | null, b: Cache, numeric: boolean): boolean {
	return (
		a !== null && a.count === b.count && (a.format ?? undefined) === (b.format ?? undefined) && samePoints(a.points, b.points, numeric)
	)
}

function pointsMarkup(prefix: string, points: readonly Point[]): string {
	let out = ""

	for (const point of points) {
		const format = point.format === undefined ? "" : ` formatCode="${escapeAttribute(point.format)}"`

		out += `<${prefix}pt idx="${point.idx}"${format}><${prefix}v>${escapeText(encodeXstring(point.value))}</${prefix}v></${prefix}pt>`
	}

	return out
}

function cacheMarkup(prefix: string, element: string, cache: Cache, extension: string): string {
	const format = cache.format === undefined ? "" : `<${prefix}formatCode>${escapeText(cache.format)}</${prefix}formatCode>`

	return `<${prefix}${element}>${format}<${prefix}ptCount val="${cache.count}"/>${pointsMarkup(prefix, cache.points)}${extension}</${prefix}${element}>`
}

// The levels of multi-level categories (§21.2.2.116): the range's columns when its rows are the points (the column
// nearest the data first), else its rows (the lowest first); a level has a point for each cell that holds text. With
// `visibleOnly`, hidden rows (or columns) drop their point and a hidden column (or row) its level, as Excel shows them.
function levelsOf(areas: readonly ChartArea[], cells: ChartCells, count: number | undefined, visibleOnly: boolean): Levels | null {
	const area = areas[0]

	if (areas.length !== 1 || area === undefined) return null

	const sheet = cells.sheet(area.sheet)

	if (sheet === null) return null

	const range = boundedRange(area.range, sheet.lastRow, sheet.lastCol)
	const rows = range.endRow - range.startRow + 1
	const cols = range.endCol - range.startCol + 1
	const byRows = count === undefined ? rows >= cols : rows === count || cols !== count

	if (rows * cols > MAX_POINTS) return null

	// The points shown: every row (or column) of the range, less the hidden ones when only visible cells are plotted.
	const shown: number[] = []

	for (let idx = 0; idx < (byRows ? rows : cols); idx++) {
		const hidden = byRows ? sheet.hiddenRow(range.startRow + idx) : sheet.hiddenCol(range.startCol + idx)

		if (!visibleOnly || !hidden) shown.push(idx)
	}

	const pointCount = shown.length
	const levelCount = byRows ? cols : rows
	const levels: Point[][] = []

	for (let level = levelCount - 1; level >= 0; level--) {
		if (visibleOnly && (byRows ? sheet.hiddenCol(range.startCol + level) : sheet.hiddenRow(range.startRow + level))) continue

		const points: Point[] = []

		shown.forEach((at, idx) => {
			const cell = byRows
				? sheet.cell(range.startRow + at, range.startCol + level)
				: sheet.cell(range.startRow + level, range.startCol + at)

			if (cell.kind !== "empty" && cell.text !== "") points.push({ idx, value: cell.text, format: undefined })
		})

		levels.push(points)
	}

	return { count: pointCount, levels }
}

function readLevels(reader: DrawingReader, cache: number): Levels | null {
	if (cache < 0) return null

	return {
		count: reader.number(reader.child(cache, D.C, "ptCount"), "val", -1),
		levels: reader.children(cache, D.C, "lvl").map(level =>
			reader.children(level, D.C, "pt").map(pt => ({
				idx: reader.number(pt, "idx", -1),
				value: decodeXstring(reader.text(reader.child(pt, D.C, "v"))),
				format: undefined
			}))
		)
	}
}

function sameLevels(a: Levels | null, b: Levels): boolean {
	if (a === null || a.count !== b.count || a.levels.length !== b.levels.length) return false

	return a.levels.every((level, index) => samePoints(level, b.levels[index] ?? [], false))
}

// The series' value count: what multi-level categories are laid out against (the val or yVal beside them). Every
// cell counts, hidden or not: the orientation is the ranges', and a hidden row must not turn it.
function seriesCount(reader: DrawingReader, reference: number, cells: ChartCells): number | undefined {
	const category = reader.document.parent(reference)
	const series = category < 0 ? -1 : reader.document.parent(category)

	if (series < 0) return undefined

	const values = reader.child(series, D.C, "val") >= 0 ? reader.child(series, D.C, "val") : reader.child(series, D.C, "yVal")
	const numRef = reader.child(values, D.C, "numRef")
	const formula = reader.child(numRef, D.C, "f")

	if (formula < 0) return undefined

	const areas = chartAreas(reader.text(formula).trim(), cells.names)
	const values$ = areas === null ? null : cellsOf(areas, cells, false)

	return values$ === null ? undefined : values$.length
}

// The extension a cache element carries (kept as written).
function extensionOf(reader: DrawingReader, cache: number): string {
	const extension = cache < 0 ? -1 : reader.child(cache, D.C, "extLst")

	return extension < 0 ? "" : decodeUtf8(reader.document.raw(extension))
}

// A pivot chart (c:pivotSource, §21.2.2.143): its data is the pivot table's.
export function isPivotChart(reader: DrawingReader): boolean {
	return reader.child(reader.document.documentElement(), D.C, "pivotSource") >= 0
}

export interface ChartRefresh {
	readonly bytes: Uint8Array
	readonly changed: boolean
}

export interface ChartRefreshOptions {
	// Leave out cells in hidden rows and columns when the chart plots visible cells only (c:plotVisOnly): what it shows,
	// not what a save writes.
	readonly shown?: boolean
}

// `bytes` with every cache equal to the cells; the same bytes (changed false) when they all already are, or the part
// does not read. `parsed`: the bytes already parsed (they are then not parsed again, nor changed).
export function refreshChartCaches(
	bytes: Uint8Array,
	cells: ChartCells,
	options: ChartRefreshOptions = {},
	parsed?: XmlDocument
): ChartRefresh {
	let document: XmlDocument

	try {
		document = parsed ?? parseXml(bytes)
	} catch {
		return { bytes, changed: false }
	}

	const reader = drawingReader(document)

	if (isPivotChart(reader)) return { bytes, changed: false }

	const editor = new XmlEditor(document)
	const chart = reader.child(document.documentElement(), D.C, "chart")
	const plotVisOnly = reader.child(chart, D.C, "plotVisOnly")
	const visibleOnly = options.shown === true && plotVisOnly >= 0 && reader.bool(plotVisOnly, "val", true)
	let changed = false

	for (const reference of chartReferences(reader)) {
		const areas = chartAreas(reference.formula, cells.names)

		if (areas === null) continue

		const prefix = document.prefix(reference.node) === "" ? "" : `${document.prefix(reference.node)}:`
		const formula = reader.child(reference.node, D.C, "f")

		if (reference.kind === "multiLvlStrRef") {
			const cache = reader.child(reference.node, D.C, "multiLvlStrCache")
			const levels = levelsOf(areas, cells, seriesCount(reader, reference.node, cells), visibleOnly)

			if (levels === null || sameLevels(readLevels(reader, cache), levels)) continue

			const markup = `<${prefix}multiLvlStrCache><${prefix}ptCount val="${levels.count}"/>${levels.levels
				.map(level => `<${prefix}lvl>${pointsMarkup(prefix, level)}</${prefix}lvl>`)
				.join("")}${extensionOf(reader, cache)}</${prefix}multiLvlStrCache>`

			if (cache >= 0) editor.replace(cache, markup)
			else editor.insertAfter(formula, markup)

			changed = true

			continue
		}

		const values = cellsOf(areas, cells, visibleOnly)

		if (values === null) continue

		const isCategory = reader.is(document.parent(reference.node), D.C, "cat") || reader.is(document.parent(reference.node), D.C, "xVal")
		const hasText = values.some(cell => cell.kind === "text")

		if (reference.kind === "numRef" && isCategory && hasText) {
			// Categories that now hold text: Excel reads them as text (a strRef), as it does when the chart is made.
			const cache = stringCache(values)

			editor.replace(
				reference.node,
				`<${prefix}strRef>${decodeUtf8(document.raw(formula))}${cacheMarkup(prefix, "strCache", cache, "")}${extensionOf(reader, reference.node)}</${prefix}strRef>`
			)
			changed = true

			continue
		}

		const element = reference.kind === "numRef" ? "numCache" : "strCache"
		const cacheNode = reader.child(reference.node, D.C, element)
		const read = readCache(reader, cacheNode)
		const cache = reference.kind === "numRef" ? numberCache(values, read?.format) : stringCache(values)

		if (sameCache(read, cache, reference.kind === "numRef")) continue

		const markup = cacheMarkup(prefix, element, cache, extensionOf(reader, cacheNode))

		if (cacheNode >= 0) editor.replace(cacheNode, markup)
		else editor.insertAfter(formula, markup)

		changed = true
	}

	return changed ? { bytes: editor.serialize(), changed } : { bytes, changed }
}

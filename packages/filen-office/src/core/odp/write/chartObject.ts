import type { DrawingTheme } from "../../drawingml/color"
import { D, drawingReader, type DrawingReader } from "../../drawingml/reader"
import { chartObject } from "../../ods/convert/chart"
import { dataStyles } from "../../ods/write/dataStyle"
import { formatValue } from "../../sheet/numfmt/index"
import { encodeUtf8, escapeAttribute, escapeText, parseXml, XmlEditor, type XmlDocument } from "../../xml/index"

// A DrawingML chart part (ECMA-376 Part 1 §21.2) as the object an ODF presentation embeds (ODF 1.3 Part 3 §11): the
// chart as core/ods/convert/chart.ts writes one, reading a table of its own (§11.1 table:table in chart:chart) that
// holds what the part's caches hold (c:strCache, c:numCache, §21.2.2.199, §21.2.2.120) the way LibreOffice lays one
// out: the series' names in the first row, the categories in the first column, a column per series. A presentation
// keeps no sheet the object could read.

export const LOCAL_TABLE = "local-table"

// A number shown in a format of its own (a SpreadsheetML format code, ECMA-376 Part 1 §18.8.31: a date, a percentage).
export interface FormattedNumber {
	readonly number: number
	readonly format: string
}

export type TableCell = string | number | FormattedNumber | null

// The data styles (§16.29) and table-cell styles a table's formatted numbers are written with, for the object's
// office:automatic-styles; `lost`: a format no data style can say (its cells keep their value and shown text only).
export interface LocalTableStyles {
	readonly markup: string
	// By format code: the table-cell style its cells name, and the data style itself (an axis showing it names that).
	readonly cells: ReadonlyMap<string, { readonly name: string; readonly dataStyle: string }>
	readonly lost: boolean
}

// Names of the styles a chart's own table is written with, and of an axis style stating its cells' format
// (ownTableStyle tells them).
const NUMBER_STYLE = "ltN"
const CELL_STYLE = "ltC"
export const AXIS_STYLE = "ltA"

// Whether a style name is one of a chart table's own (written again with the table).
export function ownTableStyle(name: string): boolean {
	return /^lt[NCA]\d+(?:P\d+)?$/u.test(name)
}

export function isFormatted(cell: TableCell): cell is FormattedNumber {
	return cell !== null && typeof cell === "object"
}

export function localTableStyles(rows: readonly (readonly TableCell[])[]): LocalTableStyles {
	const cells = new Map<string, { readonly name: string; readonly dataStyle: string }>()
	const seen = new Set<string>()
	let markup = ""
	let lost = false

	for (const row of rows)
		for (const cell of row) {
			if (!isFormatted(cell) || cell.format === "General" || seen.has(cell.format)) continue

			seen.add(cell.format)

			const index = String(seen.size)
			const written = dataStyles(cell.format, `${NUMBER_STYLE}${index}`)
			const main = "refused" in written ? undefined : written.styles[written.styles.length - 1]

			if ("refused" in written || main === undefined) {
				lost = true

				continue
			}

			const name = `${CELL_STYLE}${index}`

			markup += written.styles.map(style => style.markup).join("")
			markup += `<style:style style:name="${name}" style:family="table-cell" style:data-style-name="${main.name}"/>`
			cells.set(cell.format, { name, dataStyle: main.name })
		}

	return { markup, cells, lost }
}

// `markup` added to a content.xml's office:automatic-styles (made before office:body when it has none).
export function withAutomaticStyles(content: string, markup: string): string {
	if (markup === "") return content

	const end = content.indexOf("</office:automatic-styles>")

	if (end >= 0) return `${content.slice(0, end)}${markup}${content.slice(end)}`

	const empty = content.indexOf("<office:automatic-styles/>")

	if (empty >= 0)
		return `${content.slice(0, empty)}<office:automatic-styles>${markup}</office:automatic-styles>${content.slice(empty + "<office:automatic-styles/>".length)}`

	const body = content.indexOf("<office:body")

	return body < 0
		? content
		: `${content.slice(0, body)}<office:automatic-styles>${markup}</office:automatic-styles>${content.slice(body)}`
}

const MAX_POINTS = 10_000
const MAX_SERIES = 255
const MAX_CELLS = 1_000_000

// A chart's own table:table of `rows` (§9.1), its first row the header and its first column the categories;
// `declarations`: namespace declarations its start tag carries (a table written into a document in place); `styles`:
// the cell styles of its formatted numbers (localTableStyles, written with it), each shown in its format.
export function odpLocalTable(
	rows: readonly (readonly TableCell[])[],
	name = LOCAL_TABLE,
	declarations = "",
	styles?: LocalTableStyles
): string {
	const cols = Math.max(
		1,
		rows.reduce((max, row) => Math.max(max, row.length), 0)
	)
	const number = (value: number, format: string): string => {
		const style = format === "General" ? undefined : styles?.cells.get(format)
		const shown = formatValue(value, format).text

		return (
			// Always a float: LibreOffice reads a chart's own table's numbers from float cells only (a percentage cell
			// reads as no value); the cell's data style says how it shows.
			`<table:table-cell${style === undefined ? "" : ` table:style-name="${style.name}"`} office:value-type="float"` +
			` office:value="${String(value)}"><text:p>${escapeText(shown)}</text:p></table:table-cell>`
		)
	}
	const cell = (value: TableCell): string =>
		value === null || value === ""
			? "<table:table-cell/>"
			: typeof value === "number"
				? number(value, "General")
				: isFormatted(value)
					? number(value.number, value.format)
					: `<table:table-cell office:value-type="string"><text:p>${escapeText(value)}</text:p></table:table-cell>`
	const line = (row: readonly TableCell[]): string =>
		`<table:table-row>${Array.from({ length: cols }, (_, k) => cell(row[k] ?? null)).join("")}</table:table-row>`
	const [header, ...body] = rows
	const columns =
		cols > 1
			? `<table:table-columns><table:table-column table:number-columns-repeated="${String(cols - 1)}"/></table:table-columns>`
			: ""

	return (
		`<table:table${declarations} table:name="${escapeAttribute(name)}"><table:table-header-columns><table:table-column/></table:table-header-columns>` +
		`${columns}<table:table-header-rows>${line(header ?? [])}</table:table-header-rows>` +
		`<table:table-rows>${body.map(line).join("")}</table:table-rows></table:table>`
	)
}

function cacheOf(reader: DrawingReader, holder: number): number {
	return reader.child(holder, D.C, "numCache") >= 0
		? reader.child(holder, D.C, "numCache")
		: reader.child(holder, D.C, "strCache") >= 0
			? reader.child(holder, D.C, "strCache")
			: reader.descendant(holder, D.C, "lvl")
}

// A number cache's format code (c:formatCode, §21.2.2.71), General when it states none.
function cacheFormat(reader: DrawingReader, holder: number): string {
	const code = reader.child(cacheOf(reader, holder), D.C, "formatCode")

	return code < 0 ? "General" : reader.text(code) || "General"
}

// A cache's points by index (c:pt idx, c:v), at most MAX_POINTS; a number in a format other than General (the
// cache's, or the point's own c:pt/@formatCode) keeps it.
function cachePoints(reader: DrawingReader, holder: number, numeric: boolean): TableCell[] {
	const out: TableCell[] = []
	const cache = cacheOf(reader, holder)
	const format = numeric ? cacheFormat(reader, holder) : "General"

	for (const pt of reader.children(cache, D.C, "pt")) {
		const idx = reader.number(pt, "idx", -1)
		const text = reader.text(reader.child(pt, D.C, "v"))

		if (idx < 0 || idx >= MAX_POINTS) continue
		if (!numeric) {
			out[idx] = text

			continue
		}

		const value = Number(text)
		const own = reader.attr(pt, "formatCode") ?? format

		out[idx] = !Number.isFinite(value) ? null : own === "General" ? value : { number: value, format: own }
	}

	return out
}

// Axes whose number format is linked to the source (c:numFmt sourceLinked="1", §21.2.2.121) given the format of the
// cells they show (a category or date axis and a scatter chart's x axis: the categories' cache; a value axis: the
// values' cache): the object has no source cells to link to, so it states the format itself.
function withSourceFormats(document: XmlDocument, reader: DrawingReader, categories: string, values: string): XmlDocument {
	if (categories === "General" && values === "General") return document

	const editor = new XmlEditor(document)
	let xAxis: string | undefined

	for (let node = 0; node < document.count && xAxis === undefined; node++)
		if (reader.is(node, D.C, "scatterChart")) xAxis = reader.attr(reader.child(node, D.C, "axId"), "val")

	for (let node = 0; node < document.count; node++) {
		const value = reader.is(node, D.C, "valAx")

		if (!value && !reader.is(node, D.C, "catAx") && !reader.is(node, D.C, "dateAx")) continue

		const numFmt = reader.child(node, D.C, "numFmt")

		if (numFmt < 0 || reader.attr(numFmt, "sourceLinked") !== "1") continue

		const format =
			!value || (xAxis !== undefined && reader.attr(reader.child(node, D.C, "axId"), "val") === xAxis) ? categories : values

		if (format === "General") continue

		editor.setAttribute(numFmt, "formatCode", format)
		editor.setAttribute(numFmt, "sourceLinked", "0")
	}

	return editor.changed ? parseXml(editor.serialize()) : document
}

// The reference element of a data source (c:tx, c:cat, c:val, c:xVal, c:yVal): its strRef, numRef or multiLvlStrRef.
function referenceOf(reader: DrawingReader, source: number): number {
	for (const local of ["strRef", "numRef", "multiLvlStrRef"]) {
		const ref = reader.child(source, D.C, local)

		if (ref >= 0) return ref
	}

	return -1
}

function column(index: number): string {
	let out = ""

	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out

	return out
}

export interface PresentationChartObject {
	// The object's content.xml.
	readonly content: Uint8Array
	// It holds less than the part (core/ods/convert/chart.ts ChartObject.lost).
	readonly lost: boolean
}

// The object of a chart part in a cx × cy (cm text) frame, or undefined for a chart the object cannot hold (its
// plots, chart types the converter has no class for).
export function presentationChartObject(
	document: XmlDocument,
	theme: DrawingTheme,
	width: string,
	height: string
): PresentationChartObject | undefined {
	const reader = drawingReader(document)
	const series: number[] = []

	for (let node = 0; node < document.count && series.length < MAX_SERIES; node++) if (reader.is(node, D.C, "ser")) series.push(node)

	const sources = series.map(ser => {
		const cat = reader.child(ser, D.C, "cat") >= 0 ? reader.child(ser, D.C, "cat") : reader.child(ser, D.C, "xVal")
		const val = reader.child(ser, D.C, "val") >= 0 ? reader.child(ser, D.C, "val") : reader.child(ser, D.C, "yVal")

		return { tx: referenceOf(reader, reader.child(ser, D.C, "tx")), cat: referenceOf(reader, cat), val: referenceOf(reader, val) }
	})
	const first = sources[0]
	const categories = first === undefined || first.cat < 0 ? [] : cachePoints(reader, first.cat, reader.is(first.cat, D.C, "numRef"))
	// A name of the series' own (c:tx/c:v, §21.2.2.215) goes into the table with the others, read by reference: the
	// object then needs no name literal (LibreOffice's loext:label-string, no ODF 1.3 attribute).
	const literals = series.map(ser => {
		const tx = reader.child(ser, D.C, "tx")
		const v = reader.child(tx, D.C, "v")

		return tx >= 0 && v >= 0 && referenceOf(reader, tx) < 0 ? { tx, name: reader.text(v) } : undefined
	})
	const names = sources.map((source, index) =>
		source.tx < 0 ? (literals[index]?.name ?? null) : (cachePoints(reader, source.tx, false)[0] ?? null)
	)
	const columns = sources.map(source => (source.val < 0 ? [] : cachePoints(reader, source.val, true)))
	const points = Math.max(categories.length, ...columns.map(values => values.length))

	if (series.length === 0 || (points + 1) * (series.length + 1) > MAX_CELLS) return undefined

	// Each series reads its column of the table, every range to the longest series' last point.
	const editor = new XmlEditor(document)
	const last = String(Math.max(1, points) + 1)
	const formula = (ref: number, address: string): void => {
		const f = reader.child(ref, D.C, "f")

		if (f >= 0) editor.replace(f, `<${document.name(f)}>${escapeText(address)}</${document.name(f)}>`)
	}

	sources.forEach((source, index) => {
		const col = column(index + 1)
		const literal = literals[index]

		if (literal !== undefined) {
			const prefix = document.prefix(literal.tx) === "" ? "" : `${document.prefix(literal.tx)}:`

			editor.replace(
				literal.tx,
				`<${prefix}tx><${prefix}strRef><${prefix}f>'${LOCAL_TABLE}'!$${col}$1</${prefix}f></${prefix}strRef></${prefix}tx>`
			)
		}

		if (source.tx >= 0) formula(source.tx, `'${LOCAL_TABLE}'!$${col}$1`)
		if (source.cat >= 0) formula(source.cat, `'${LOCAL_TABLE}'!$A$2:$A$${last}`)
		if (source.val >= 0) formula(source.val, `'${LOCAL_TABLE}'!$${col}$2:$${col}$${last}`)
	})

	const rewritten = editor.changed ? parseXml(editor.serialize()) : document
	const formats = withSourceFormats(
		rewritten,
		drawingReader(rewritten),
		first === undefined || first.cat < 0 ? "General" : cacheFormat(reader, first.cat),
		first === undefined || first.val < 0 ? "General" : cacheFormat(reader, first.val)
	)
	const object = chartObject(formats, theme, LOCAL_TABLE, width, height)

	if (object === null) return undefined

	const rows: TableCell[][] = [[null, ...names]]

	for (let point = 0; point < points; point++) rows.push([categories[point] ?? null, ...columns.map(values => values[point] ?? null)])

	const at = object.content.lastIndexOf("</chart:chart>")

	if (at < 0) return undefined

	const styles = localTableStyles(rows)

	return {
		content: encodeUtf8(
			withAutomaticStyles(
				`${object.content.slice(0, at)}${odpLocalTable(rows, LOCAL_TABLE, "", styles)}${object.content.slice(at)}`,
				styles.markup
			)
		),
		lost: object.lost || styles.lost
	}
}

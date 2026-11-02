import { maxOf, minOf } from "../../arrays"
import type { PartChange } from "../../opc/index"
import { OdfNs } from "../../odf/namespaces"
import { canonicalAttributes, elementName } from "../../odf/tree"
import { singleReference } from "../../sheet/refs/formulaRefs"
import { chartBook } from "../../xlsx/charts/book"
import { readChartInfo, type ChartInfo, type ChartLabels, type ChartPlotInfo, type ChartType } from "../../xlsx/charts/model"
import type { DrawingAnchor } from "../../xlsx/drawings/anchor"
import { readDrawingPart } from "../../xlsx/drawings/read"
import { drawingStore } from "../../xlsx/drawings/store"
import type { XlsxDocument } from "../../xlsx/edit/document"
import { Namespaces, XmlEditor, decodeUtf8, encodeUtf8, escapeAttribute, escapeText, parseXml, type XmlDocument } from "../../xml/index"
import { parseCaptured } from "../read/captured"
import { odsSource, type OdsSource } from "../source"
import { addressBoxes } from "../unheld"
import { EMU_PER_PT, LEGENDS, chartOf, translateChart, type OdsChartSource } from "./read"

// What a save writes of the charts an edit changed. A chart the editor changed is its object's content.xml patched
// where the chart part now differs from what was read (title, legend, plot type and grouping, axes, series and their
// cells, data labels), every other part of the object kept as it is; a page-anchored frame moved, resized or deleted
// is its table's table:shapes with that frame's attributes changed. The patched object is read back and must give the
// chart as edited. Anything else refuses (ChartRefused), and a chart the reading could not carry whole
// (OdsChartSource.refusal) is never written.

export class ChartRefused extends Error {}

export interface OdsChartWrite {
	// Object parts written again (Object 1/content.xml...).
	readonly replace: readonly PartChange[]
	// table:shapes written again, by source table index.
	readonly shapes: ReadonlyMap<number, string>
}

export const NO_CHART_WRITE: OdsChartWrite = { replace: [], shapes: new Map() }

function refuse(why: string): never {
	throw new ChartRefused(`A chart edit cannot be written to the OpenDocument file: ${why}`)
}

// --- Comparing charts ---

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

// A reference without its anchors: what a chart reads, however it was typed.
function bare(ref: string | null | undefined): string | null {
	return ref === null || ref === undefined ? null : ref.replaceAll("$", "").replace(/^=/, "").toUpperCase()
}

// What a chart shows that its ODF form must keep: series by their cells (the name only where no cell gives it),
// labels as each series shows them, axes in order.
function shown(info: ChartInfo): unknown {
	return {
		title: info.title,
		legend: info.legend,
		plots: info.plots.map(plot => ({
			type: plot.type,
			grouping: plot.grouping,
			threeD: plot.threeD,
			series: plot.series.map(series => ({
				name: series.nameRef === null ? series.name : null,
				nameRef: bare(series.nameRef),
				categories: bare(series.categories),
				values: bare(series.values),
				labels: series.labels ?? plot.labels
			}))
		})),
		axes: info.axes.map(axis => ({ ...axis, id: 0 }))
	}
}

function infoOf(bytes: Uint8Array): ChartInfo {
	const info = readChartInfo(parseXml(bytes))

	if (info === null) refuse("the chart part does not read")

	return info
}

// --- The object's markup ---

interface ObjectMarkup {
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	readonly editor: XmlEditor
	readonly styles: number
	readonly chart: number
	readonly plotArea: number
	// New styles, appended to office:automatic-styles.
	readonly added: string[]
	readonly taken: Set<string>
}

function elementsOf(document: XmlDocument, namespaces: Namespaces, parent: number, name: string): number[] {
	const out: number[] = []

	for (let node = parent < 0 ? -1 : document.firstChildElement(parent); node >= 0; node = document.nextSiblingElement(node))
		if (elementName(document, namespaces, node) === name) out.push(node)

	return out
}

function all(object: ObjectMarkup, parent: number, name: string): number[] {
	return elementsOf(object.document, object.namespaces, parent, name)
}

function first(object: ObjectMarkup, parent: number, name: string): number {
	return all(object, parent, name)[0] ?? -1
}

function attribute(object: ObjectMarkup, node: number, name: string): string | undefined {
	return canonicalAttributes(object.document, object.namespaces, node).get(name)
}

// Sets (or, for undefined, removes) an attribute under its canonical name (the object binds the canonical prefixes).
function set(object: ObjectMarkup, node: number, name: string, value: string | undefined): void {
	if (value === undefined) {
		if (object.document.attribute(node, name) !== undefined) object.editor.removeAttribute(node, name)
	} else {
		object.editor.setAttribute(node, name, value)
	}
}

// Prefixes the patch writes, which the object's root must bind to their namespaces.
const PREFIXES: readonly (readonly [string, string])[] = [
	["style", OdfNs.style],
	["chart", OdfNs.chart],
	["table", OdfNs.table],
	["text", OdfNs.text]
]

function objectMarkup(bytes: Uint8Array): ObjectMarkup {
	const document = parseXml(bytes)
	const namespaces = new Namespaces(document, { lenient: true })
	const root = document.documentElement()

	for (const [prefix, uri] of PREFIXES)
		if (document.attribute(root, `xmlns:${prefix}`) !== uri) refuse(`the object binds ${prefix} otherwise`)

	const styles = elementsOf(document, namespaces, root, "office:automatic-styles")[0] ?? -1
	const body = elementsOf(document, namespaces, root, "office:body")[0] ?? -1
	const office = elementsOf(document, namespaces, body, "office:chart")[0] ?? -1
	const chart = elementsOf(document, namespaces, office, "chart:chart")[0] ?? -1

	if (chart < 0) refuse("the object holds no chart")
	if (styles < 0) refuse("the object has no automatic styles")

	const taken = new Set<string>()

	for (const style of elementsOf(document, namespaces, styles, "style:style")) {
		const name = canonicalAttributes(document, namespaces, style).get("style:name")

		if (name !== undefined) taken.add(name)
	}

	return {
		document,
		namespaces,
		editor: new XmlEditor(document),
		styles,
		chart,
		plotArea: elementsOf(document, namespaces, chart, "chart:plot-area")[0] ?? -1,
		added: [],
		taken
	}
}

// Gives an element a chart style of its own: a copy of its style (or a new one) with chart properties changed.
function restyle(object: ObjectMarkup, node: number, changes: ReadonlyMap<string, string | undefined>): void {
	const current = attribute(object, node, "chart:style-name")
	const style =
		current === undefined
			? undefined
			: all(object, object.styles, "style:style").find(candidate => attribute(object, candidate, "style:name") === current)
	let name = "chF1"

	for (let n = 2; object.taken.has(name); n++) name = `chF${n}`

	object.taken.add(name)

	let markup =
		style === undefined
			? `<style:style style:name="${name}" style:family="chart"><style:chart-properties/></style:style>`
			: decodeUtf8(object.document.raw(style)).replace(/style:name="[^"]*"/, `style:name="${escapeAttribute(name)}"`)

	if (!/<style:chart-properties\b/.test(markup)) {
		markup = markup.endsWith("/>")
			? `${markup.slice(0, -2)}><style:chart-properties/></style:style>`
			: markup.replace(/(<style:style\b[^>]*>)/, "$1<style:chart-properties/>")
	}

	markup = markup.replace(/<style:chart-properties\b[^>]*?\/?>/, tag => {
		let out = tag

		for (const [attributeName, value] of changes) {
			out = out.replace(new RegExp(`\\s${attributeName}="[^"]*"`), "")

			if (value !== undefined) out = out.replace(/(\/?>)$/, ` ${attributeName}="${escapeAttribute(value)}"$1`)
		}

		return out
	})
	object.added.push(markup)
	object.editor.setAttribute(node, "chart:style-name", name)
}

function paragraphs(text: string): string {
	return text
		.split("\n")
		.map(line => `<text:p>${escapeText(line)}</text:p>`)
		.join("")
}

// An Excel reference ("Data!$B$2:$B$4", "(a,b)") as a cell range address (§19.587: "Data.B2:Data.B4", areas apart).
export function odfAddress(ref: string, ownSheet: string): string {
	const text = ref.trim().replace(/^=/, "")
	const areas = text.startsWith("(") && text.endsWith(")") ? text.slice(1, -1).split(",") : [text]

	return areas
		.map(area => {
			const parsed = singleReference(area.trim())

			if (parsed === null || parsed.area === null || parsed.external || parsed.lastSheet !== null) refuse(`the reference ${area}`)

			const sheet = parsed.sheet ?? ownSheet
			const quoted = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet) ? sheet : `'${sheet.replaceAll("'", "''")}'`

			return parsed.areaText
				.replaceAll("$", "")
				.split(":")
				.map(end => `${quoted}.${end}`)
				.join(":")
		})
		.join(" ")
}

const CLASS_OF: Readonly<Record<ChartType, string | null>> = {
	column: "chart:bar",
	bar: "chart:bar",
	line: "chart:line",
	area: "chart:area",
	pie: "chart:circle",
	doughnut: "chart:ring",
	scatter: "chart:scatter",
	radar: "chart:radar",
	other: null
}

// c:dLblPos (§21.2.3.11) as chart:label-position (§20.71).
const POSITIONS: ReadonlyMap<string, string> = new Map([
	["bestFit", "avoid-overlap"],
	["ctr", "center"],
	["t", "top"],
	["b", "bottom"],
	["l", "left"],
	["r", "right"],
	["inEnd", "inside"],
	["outEnd", "outside"],
	["inBase", "near-origin"]
])

function labelChanges(labels: ChartLabels | null): Map<string, string | undefined> {
	const value = labels?.value === true
	const percent = labels?.percent === true
	const position = labels?.position

	return new Map([
		["chart:data-label-number", value && percent ? "value-and-percentage" : value ? "value" : percent ? "percentage" : "none"],
		["chart:data-label-text", labels?.category === true ? "true" : "false"],
		["chart:data-label-series", labels?.series === true ? "true" : "false"],
		["chart:label-position", position === null || position === undefined ? undefined : POSITIONS.get(position)]
	])
}

function sheetOf(ref: string | null): string | null {
	if (ref === null) return null

	return singleReference(ref.replace(/^\(|\)$/g, "").split(",")[0] ?? "")?.sheet ?? null
}

// Applies what changed from `was` to `now` to the object's chart:chart.
function patch(object: ObjectMarkup, was: ChartInfo, now: ChartInfo, ownSheet: string): void {
	const { chart, plotArea, editor } = object
	const address = (ref: string): string => odfAddress(ref, sheetOf(ref) ?? ownSheet)

	if (!sameJson(was.title, now.title)) {
		const title = first(object, chart, "chart:title")

		if (now.title === "") refuse("an automatic title")

		if (now.title === null) {
			if (title >= 0) editor.remove(title)
		} else if (title >= 0) {
			editor.setContent(title, paragraphs(now.title))
		} else {
			editor.prepend(chart, `<chart:title>${paragraphs(now.title)}</chart:title>`)
		}
	}

	if (was.legend !== now.legend) {
		const legend = first(object, chart, "chart:legend")
		const position = [...LEGENDS].find(([, value]) => value === now.legend)?.[0]

		if (now.legend === null) {
			if (legend >= 0) editor.remove(legend)
		} else if (position === undefined) {
			refuse(`a legend at ${now.legend}`)
		} else if (legend >= 0) {
			set(object, legend, "chart:legend-position", position)
		} else if (plotArea >= 0) {
			editor.insertBefore(plotArea, `<chart:legend chart:legend-position="${position}"/>`)
		}
	}

	const wasPlot = was.plots[0]
	const nowPlot = now.plots[0]

	if (was.plots.length !== 1 || now.plots.length !== 1 || wasPlot === undefined || nowPlot === undefined)
		refuse("a chart of more than one plot")
	if (nowPlot.threeD !== wasPlot.threeD) refuse("a three-dimensional chart")

	if (nowPlot.type !== wasPlot.type || nowPlot.grouping !== wasPlot.grouping) {
		const chartClass = CLASS_OF[nowPlot.type]

		if (chartClass === null) refuse(`a ${nowPlot.type} chart`)

		set(object, chart, "chart:class", chartClass)

		for (const series of all(object, plotArea, "chart:series"))
			if (attribute(object, series, "chart:class") !== undefined) set(object, series, "chart:class", chartClass)

		restyle(
			object,
			plotArea,
			new Map([
				["chart:vertical", nowPlot.type === "bar" ? "true" : "false"],
				["chart:stacked", nowPlot.grouping === "stacked" ? "true" : "false"],
				["chart:percentage", nowPlot.grouping === "percentStacked" ? "true" : "false"]
			])
		)
	}

	const xAxis = all(object, plotArea, "chart:axis").find(axis => attribute(object, axis, "chart:dimension") === "x")
	const wasSeries = wasPlot.series
	const nowSeries = nowPlot.series

	if (new Set(nowSeries.map(series => bare(series.categories))).size > 1) refuse("series with categories of their own")

	const categories = nowSeries[0]?.categories ?? null

	if (nowSeries.length > 0 && bare(categories) !== bare(wasSeries[0]?.categories)) {
		if (nowPlot.type === "scatter") refuse("scatter x values")
		if (xAxis === undefined) refuse("categories without an axis")

		const current = first(object, xAxis, "chart:categories")

		if (categories === null) {
			if (current >= 0) editor.remove(current)
		} else if (current >= 0) {
			set(object, current, "table:cell-range-address", address(categories))
		} else {
			editor.append(xAxis, `<chart:categories table:cell-range-address="${escapeAttribute(address(categories))}"/>`)
		}
	}

	// Series: each one now is one it was (in order, some left out) or added after them all.
	const elements = all(object, plotArea, "chart:series")

	if (elements.length !== wasSeries.length) refuse("series the object does not hold")

	let cursor = 0
	const kept = new Set<number>()
	const added: string[] = []

	for (const series of nowSeries) {
		if (series.values === null) refuse("a series without cells")

		let source = -1

		for (let k = cursor; k < wasSeries.length && source < 0; k++) if (wasSeries[k]?.idx === series.idx) source = k

		if (source < 0 && added.length === 0 && nowSeries.length === wasSeries.length) source = cursor

		const before = source < 0 ? undefined : wasSeries[source]

		if (series.nameRef === null && series.name !== "" && before?.name !== series.name) refuse("a series named by text of its own")

		const values = address(series.values)
		const label = series.nameRef === null ? undefined : address(series.nameRef)

		if (source < 0) {
			added.push(
				`<chart:series chart:values-cell-range-address="${escapeAttribute(values)}"${label === undefined ? "" : ` chart:label-cell-address="${escapeAttribute(label)}"`} chart:class="${CLASS_OF[nowPlot.type] ?? "chart:bar"}"/>`
			)

			if (series.labels !== null) refuse("labels on a new series")

			continue
		}

		if (added.length > 0) refuse("series moved")

		const node = elements[source] ?? -1

		cursor = source + 1
		kept.add(source)

		if (bare(before?.values) !== bare(series.values)) set(object, node, "chart:values-cell-range-address", values)
		if (bare(before?.nameRef) !== bare(series.nameRef)) set(object, node, "chart:label-cell-address", label)
		if (!sameJson(before?.labels ?? wasPlot.labels, series.labels ?? nowPlot.labels))
			restyle(object, node, labelChanges(series.labels ?? nowPlot.labels))
	}

	elements.forEach((node, k) => {
		if (!kept.has(k)) editor.remove(node)
	})

	if (added.length > 0) {
		const last = elements[elements.length - 1]

		if (last === undefined) refuse("series added to a chart without any")

		editor.insertAfter(last, added.join(""))
	}

	if (now.axes.length !== was.axes.length) refuse("axes added or removed")

	const axisElements = all(object, plotArea, "chart:axis")

	now.axes.forEach((axis, k) => {
		const before = was.axes[k]

		if (before === undefined || sameJson({ ...axis, id: 0 }, { ...before, id: 0 })) return
		if (axis.kind !== before.kind || axis.position !== before.position) refuse("an axis moved")
		if (axis.format !== before.format) refuse("an axis number format")
		if (axis.logBase !== null && axis.logBase !== 10) refuse(`a logarithmic base of ${axis.logBase}`)

		const node = axisElements.find(candidate => attribute(object, candidate, "chart:dimension") === (k === 0 ? "x" : "y"))

		if (node === undefined) refuse("an axis the object lacks")

		const changes = new Map<string, string | undefined>()

		if (axis.min !== before.min) changes.set("chart:minimum", axis.min === null ? undefined : String(axis.min))
		if (axis.max !== before.max) changes.set("chart:maximum", axis.max === null ? undefined : String(axis.max))

		if (axis.major !== before.major || axis.minor !== before.minor) {
			if (axis.minor !== null && axis.major === null) refuse("a minor unit without a major one")

			const divisor = axis.minor === null || axis.major === null ? null : axis.major / axis.minor

			if (divisor !== null && (!Number.isInteger(divisor) || divisor < 1)) refuse("a minor unit that does not divide the major one")

			changes.set("chart:interval-major", axis.major === null ? undefined : String(axis.major))
			changes.set("chart:interval-minor-divisor", divisor === null ? undefined : String(divisor))
		}

		if (axis.logBase !== before.logBase) changes.set("chart:logarithmic", axis.logBase === null ? "false" : "true")
		if (axis.reversed !== before.reversed) changes.set("chart:reverse-direction", axis.reversed ? "true" : "false")
		if (axis.visible !== before.visible) changes.set("chart:visible", axis.visible ? "true" : "false")
		if (changes.size > 0) restyle(object, node, changes)

		if (axis.title !== before.title) {
			const title = first(object, node, "chart:title")

			if (axis.title === "") refuse("an automatic axis title")

			if (axis.title === null) {
				if (title >= 0) editor.remove(title)
			} else if (title >= 0) {
				editor.setContent(title, paragraphs(axis.title))
			} else {
				editor.prepend(node, `<chart:title>${paragraphs(axis.title)}</chart:title>`)
			}
		}

		if (axis.majorGridlines !== before.majorGridlines) {
			const grid = all(object, node, "chart:grid").find(
				candidate => (attribute(object, candidate, "chart:class") ?? "major") === "major"
			)

			if (axis.majorGridlines && grid === undefined) editor.append(node, '<chart:grid chart:class="major"/>')
			if (!axis.majorGridlines && grid !== undefined) editor.remove(grid)
		}
	})

	// The plot area's own range (the data range LibreOffice offers to edit): moved as the ranges it holds were.
	if (plotArea >= 0) {
		const current = attribute(object, plotArea, "table:cell-range-address")
		const next = current === undefined ? null : movedPlotArea(current, rangePairs(wasPlot, nowPlot, ownSheet), ownSheet)

		if (next !== null && next !== current) set(object, plotArea, "table:cell-range-address", next)
	}

	if (object.added.length > 0) editor.append(object.styles, object.added.join(""))
}

interface Box {
	readonly sheet: string
	readonly startRow: number
	readonly startCol: number
	readonly endRow: number
	readonly endCol: number
}

// A reference's areas as boxes, null for none or one that does not read.
function boxesOf(ref: string | null, ownSheet: string): Box[] | null {
	if (ref === null) return null

	const text = ref.trim().replace(/^=/, "")
	const areas = text.startsWith("(") && text.endsWith(")") ? text.slice(1, -1).split(",") : [text]
	const out: Box[] = []

	for (const area of areas) {
		const parsed = singleReference(area.trim())

		if (parsed === null || parsed.area === null || parsed.external || parsed.lastSheet !== null) return null

		const { startRow, startCol, endRow, endCol } = parsed.area

		out.push({ sheet: parsed.sheet ?? ownSheet, startRow, startCol, endRow, endCol })
	}

	return out
}

// Each range a series held before beside the range it holds now (by its idx), as boxes.
function rangePairs(was: ChartPlotInfo, now: ChartPlotInfo, ownSheet: string): [Box, Box][] {
	const pairs: [Box, Box][] = []

	for (const before of was.series) {
		const after = now.series.find(series => series.idx === before.idx)

		if (after === undefined) continue

		for (const key of ["values", "nameRef", "categories"] as const) {
			const a = boxesOf(before[key], ownSheet)
			const b = boxesOf(after[key], ownSheet)

			if (a === null || b === null || a.length !== b.length) continue

			a.forEach((box, k) => {
				const other = b[k]

				if (other !== undefined) pairs.push([box, other])
			})
		}
	}

	return pairs
}

// The plot area's ranges, each moved as the series ranges inside it were (its corners by as much as theirs); as it
// is where one holds none of them or does not read.
function movedPlotArea(current: string, pairs: readonly [Box, Box][], ownSheet: string): string | null {
	const boxes = addressBoxes(current, ownSheet)

	if (boxes === null) return null

	const out: string[] = []

	for (const box of boxes) {
		const inside = pairs.filter(
			([before]) =>
				before.sheet === box.sheet &&
				before.startRow >= box.startRow &&
				before.endRow <= box.endRow &&
				before.startCol >= box.startCol &&
				before.endCol <= box.endCol
		)

		if (inside.length === 0) return null

		const bound = (side: 0 | 1, pick: (box: Box) => number, low: boolean): number => {
			const values = inside.map(pair => pick(pair[side]))

			return low ? minOf(values) : maxOf(values)
		}
		const startRow = box.startRow + bound(1, b => b.startRow, true) - bound(0, b => b.startRow, true)
		const startCol = box.startCol + bound(1, b => b.startCol, true) - bound(0, b => b.startCol, true)
		const endRow = box.endRow + bound(1, b => b.endRow, false) - bound(0, b => b.endRow, false)
		const endCol = box.endCol + bound(1, b => b.endCol, false) - bound(0, b => b.endCol, false)

		if (startRow < 0 || startCol < 0 || endRow < startRow || endCol < startCol) return null

		out.push(odfAddress(`${cellName(startRow, startCol)}:${cellName(endRow, endCol)}`, box.sheet))
	}

	return out.join(" ")
}

function cellName(row: number, col: number): string {
	let letters = ""

	for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters

	return `${letters}${row + 1}`
}

// The object's content.xml with the chart edited as `now` says, proved by reading it back.
export function patchObject(bytes: Uint8Array, was: ChartInfo, now: ChartInfo, ownSheet: string): Uint8Array {
	const object = objectMarkup(bytes)

	patch(object, was, now, ownSheet)

	const written = object.editor.serialize()
	const chart = chartOf(parseXml(written))

	if (chart === null) refuse("the written object does not read")

	const translated = translateChart(chart.chart, chart.styles)
	const back = readChartInfo(parseXml(encodeUtf8(translated.markup)))

	if (back === null || translated.refusal !== null || !sameJson(shown(back), shown(now))) refuse("the chart reads back otherwise")

	return written
}

// The object's content.xml for a chart as it now is, null when it needs no writing.
function chartObject(source: OdsSource, chart: OdsChartSource, now: Uint8Array | null): Uint8Array | null {
	const read = source.parts.get(chart.part)

	if (now === null || read === undefined || now === read) return null

	const was = infoOf(read)
	const edited = infoOf(now)

	if (sameJson(shown(was), shown(edited))) return null
	if (chart.refusal !== null) refuse(chart.refusal)

	return patchObject(chart.content, was, edited, source.tables[chart.table]?.name ?? "")
}

// Why the charts and their frames as they now are cannot be written to the OpenDocument file, null when they can (or
// nothing changed): asked once an edit ran, so an edit the file cannot hold is refused when made.
export function odsChartsRefusal(document: XlsxDocument): string | null {
	const source = odsSource(document.workbook)

	if (source === undefined || source.charts.length === 0) return null

	try {
		written(document, source)

		return null
	} catch (error) {
		if (error instanceof ChartRefused) return error.message

		throw error
	}
}

// --- Frames ---

function anchorKey(anchor: DrawingAnchor | null | undefined): string {
	return JSON.stringify(anchor ?? null)
}

function points(emu: number): string {
	return `${Math.round((emu / EMU_PER_PT) * 1e6) / 1e6}pt`
}

// A table's table:shapes with its page-anchored frames moved or deleted as the drawing now has them; null when none
// changed.
function framesWritten(source: OdsSource, charts: readonly OdsChartSource[], read: Uint8Array, now: Uint8Array | null): string | null {
	const before = readDrawingPart(parseXml(read)).objects
	const after = now === null ? [] : readDrawingPart(parseXml(now)).objects

	// What a frame says of itself beside its place (its name, alternative text, whether hidden) is not written.
	for (const object of after) {
		const was = before.find(candidate => candidate.chartRelationship === object.chartRelationship)

		if (was !== undefined && (was.name !== object.name || was.alt !== object.alt || was.hidden !== object.hidden))
			refuse("a frame's name, alternative text or visibility")
	}

	if (before.length === after.length && before.every((object, k) => anchorKey(object.anchor) === anchorKey(after[k]?.anchor))) return null
	if (after.some(object => object.chartRelationship === null || !charts.some(chart => chart.relationship === object.chartRelationship)))
		refuse("objects added to the sheet")

	const markup = charts[0]?.shapes
	const captured = markup === undefined ? null : parseCaptured(markup, source.prefixes)
	const editor = captured === null ? null : new XmlEditor(captured.document)
	const frames: number[] = []

	if (captured !== null)
		for (let node = captured.document.firstChildElement(captured.node); node >= 0; node = captured.document.nextSiblingElement(node))
			frames.push(node)

	let changed = false

	for (const chart of charts) {
		const was = before[chart.anchor]
		const moved = after.find(object => object.chartRelationship === chart.relationship)

		if (anchorKey(was?.anchor) === anchorKey(moved?.anchor)) continue
		if (chart.place.kind !== "page" || editor === null) refuse("a frame anchored to a cell moved or deleted")

		const frame = frames[chart.place.frame] ?? -1

		if (frame < 0) refuse("a frame the sheet lacks")

		changed = true

		if (moved === undefined) {
			editor.remove(frame)

			continue
		}

		const anchor = moved.anchor

		if (anchor === null || anchor.mode !== "absolute") refuse("a frame anchored to the page given another anchor")

		editor.setAttribute(frame, "svg:x", points(anchor.x))
		editor.setAttribute(frame, "svg:y", points(anchor.y))
		editor.setAttribute(frame, "svg:width", points(anchor.cx))
		editor.setAttribute(frame, "svg:height", points(anchor.cy))
	}

	if (!changed || editor === null) return null

	const serialized = decodeUtf8(editor.serialize())

	return serialized.slice(serialized.indexOf(">") + 1, serialized.lastIndexOf("</captured>"))
}

function written(document: XlsxDocument, source: OdsSource): OdsChartWrite {
	const book = chartBook(document.workbook)
	const replace: PartChange[] = []
	const shapes = new Map<number, string>()
	const drawings = new Map<string, OdsChartSource[]>()

	for (const chart of source.charts) {
		const object = chartObject(source, chart, book.bytes(chart.part))

		if (object !== null) replace.push({ name: `${chart.object}/content.xml`, bytes: object })

		const list = drawings.get(chart.drawing)

		if (list === undefined) drawings.set(chart.drawing, [chart])
		else list.push(chart)
	}

	const store = drawingStore(document.workbook)

	for (const [name, charts] of drawings) {
		const read = source.parts.get(name)
		const now = store.bytes(name)

		if (read === undefined || now === undefined || now === read) continue

		const markup = framesWritten(source, charts, read, now)
		const table = charts[0]?.table

		if (markup !== null && table !== undefined) shapes.set(table, markup)
	}

	return { replace, shapes }
}

export async function writeOdsCharts(document: XlsxDocument, source: OdsSource): Promise<OdsChartWrite> {
	if (source.charts.length === 0) return NO_CHART_WRITE

	// Every chart part's source bytes read, so each one's state now is known.
	await chartBook(document.workbook).load(document)

	return written(document, source)
}

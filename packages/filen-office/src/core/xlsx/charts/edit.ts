import { D, drawingReader, type DrawingReader } from "../../drawingml/reader"
import { numFmtProblem, unwritableText } from "../../sheet/numfmt/edit"
import { NodeKind, XmlEditor, decodeUtf8, escapeAttribute, escapeText, type XmlDocument } from "../../xml/index"
import {
	AXIS_ELEMENTS,
	axisNodes,
	chartRoot,
	plotNodes,
	val,
	type ChartGrouping,
	type ChartLabelPosition,
	type ChartLabels,
	type ChartLegendPosition,
	type ChartType
} from "./model"
import { CHART_STRICT_NAMESPACE } from "./parts"

// Chart edits as changes to the chart part's markup (ECMA-376 Part 1 §21.2.2): the elements an edit is about are
// rewritten in their schema order (dml-chart.xsd sequences), everything else stays as written. An element whose own
// extension list holds an extension this editor does not know is not rewritten: the edit refuses
// ("chartUnsupported"), so nothing a later Office version wrote is lost or left inconsistent.

export type ChartEditType = Exclude<ChartType, "radar" | "other">

export interface ChartAxisPatch {
	readonly min?: number | null
	readonly max?: number | null
	readonly major?: number | null
	readonly minor?: number | null
	// A number format code; null links it to the source again.
	readonly format?: string | null
	// null removes it.
	readonly title?: string | null
	readonly visible?: boolean
	readonly gridlines?: boolean
}

export type SheetChartEdit =
	| { readonly kind: "type"; readonly plot: number; readonly type: ChartEditType; readonly grouping?: ChartGrouping }
	// "" shows the automatic title; null removes it.
	| { readonly kind: "title"; readonly text: string | null }
	| { readonly kind: "legend"; readonly position: ChartLegendPosition | null }
	// plot null: every plot. labels null: hidden.
	| { readonly kind: "labels"; readonly plot: number | null; readonly labels: ChartLabels | null }
	| { readonly kind: "axis"; readonly axis: number; readonly patch: ChartAxisPatch }
	// Ranges as typed (with or without "="); a name is a reference when it starts with "=", else the series' own text.
	| {
			readonly kind: "series.add"
			readonly plot: number
			readonly name: string | null
			readonly categories: string | null
			readonly values: string
	  }
	// `series`: the series' place among the chart's series; `id`, when given, its c:idx as the editor read it, which
	// names it instead (an edit sent before the editor saw the last one acts on the series it was meant for, or refuses
	// once that series is gone).
	| { readonly kind: "series.remove"; readonly series: number; readonly id?: number }
	| { readonly kind: "series.move"; readonly series: number; readonly to: number; readonly id?: number }
	| {
			readonly kind: "series.set"
			readonly series: number
			readonly id?: number
			readonly name?: string | null
			readonly categories?: string | null
			readonly values?: string
	  }

type ChartEditRefusal = "chartUnsupported" | "chartValue" | "formula" | "tooLarge"

// Why an edit cannot be made (SheetRefusal detail).
export class ChartEditRefused extends Error {
	readonly reason: ChartEditRefusal

	constructor(reason: ChartEditRefusal, detail: string) {
		super(detail)
		this.reason = reason
	}
}

function refuse(detail: string, reason: ChartEditRefusal = "chartUnsupported"): never {
	throw new ChartEditRefused(reason, detail)
}

// What an edit needs from the workbook: a series formula as stored (qualified, absolute, without "="), null when the
// text names no cells; and whether a range holds numbers only (categories are then a numRef, as Excel makes them).
export interface ChartFormulaHost {
	reference(text: string): string | null
	numeric(formula: string): boolean
}

// Extensions this editor keeps with the element they are in (they say nothing an edit here makes untrue): series
// ids (c16 uniqueId), data label extras (c15), the display of #N/A (c16r3), the c14 style.
const SAFE_EXTENSIONS: ReadonlySet<string> = new Set([
	"{C3380CC4-5D6E-409C-BE32-E72D297353CC}",
	"{CE6537A1-D6FC-4F65-9D91-7224C49458BB}",
	"{56B9EC1D-385E-4148-901F-78D8002777C0}",
	"{781A3756-C4B2-4CAC-9D66-4F8BD8637D16}"
])

// Schema order of the containers edits write into (dml-chart.xsd).
const ORDER: Readonly<Record<string, readonly string[]>> = {
	chart: [
		"title",
		"autoTitleDeleted",
		"pivotFmts",
		"view3D",
		"floor",
		"sideWall",
		"backWall",
		"plotArea",
		"legend",
		"plotVisOnly",
		"dispBlanksAs",
		"showDLblsOverMax",
		"extLst"
	],
	plotArea: [
		"layout",
		"areaChart",
		"area3DChart",
		"lineChart",
		"line3DChart",
		"stockChart",
		"radarChart",
		"scatterChart",
		"pieChart",
		"pie3DChart",
		"doughnutChart",
		"barChart",
		"bar3DChart",
		"ofPieChart",
		"surfaceChart",
		"surface3DChart",
		"bubbleChart",
		"valAx",
		"catAx",
		"dateAx",
		"serAx",
		"dTable",
		"spPr",
		"extLst"
	],
	title: ["tx", "layout", "overlay", "spPr", "txPr", "extLst"],
	legend: ["legendPos", "legendEntry", "layout", "overlay", "spPr", "txPr", "extLst"],
	scaling: ["logBase", "orientation", "max", "min", "extLst"],
	dLbls: [
		"dLbl",
		"delete",
		"numFmt",
		"spPr",
		"txPr",
		"dLblPos",
		"showLegendKey",
		"showVal",
		"showCatName",
		"showSerName",
		"showPercent",
		"showBubbleSize",
		"separator",
		"showLeaderLines",
		"leaderLines",
		"extLst"
	],
	catAx: [
		"axId",
		"scaling",
		"delete",
		"axPos",
		"majorGridlines",
		"minorGridlines",
		"title",
		"numFmt",
		"majorTickMark",
		"minorTickMark",
		"tickLblPos",
		"spPr",
		"txPr",
		"crossAx",
		"crosses",
		"crossesAt",
		"auto",
		"lblAlgn",
		"lblOffset",
		"tickLblSkip",
		"tickMarkSkip",
		"noMultiLvlLbl",
		"extLst"
	],
	valAx: [
		"axId",
		"scaling",
		"delete",
		"axPos",
		"majorGridlines",
		"minorGridlines",
		"title",
		"numFmt",
		"majorTickMark",
		"minorTickMark",
		"tickLblPos",
		"spPr",
		"txPr",
		"crossAx",
		"crosses",
		"crossesAt",
		"crossBetween",
		"majorUnit",
		"minorUnit",
		"dispUnits",
		"extLst"
	],
	dateAx: [
		"axId",
		"scaling",
		"delete",
		"axPos",
		"majorGridlines",
		"minorGridlines",
		"title",
		"numFmt",
		"majorTickMark",
		"minorTickMark",
		"tickLblPos",
		"spPr",
		"txPr",
		"crossAx",
		"crosses",
		"crossesAt",
		"auto",
		"lblOffset",
		"baseTimeUnit",
		"majorUnit",
		"majorTimeUnit",
		"minorUnit",
		"minorTimeUnit",
		"extLst"
	],
	serAx: [
		"axId",
		"scaling",
		"delete",
		"axPos",
		"majorGridlines",
		"minorGridlines",
		"title",
		"numFmt",
		"majorTickMark",
		"minorTickMark",
		"tickLblPos",
		"spPr",
		"txPr",
		"crossAx",
		"crosses",
		"crossesAt",
		"tickLblSkip",
		"tickMarkSkip",
		"extLst"
	],
	barChart: ["barDir", "grouping", "varyColors", "ser", "dLbls", "gapWidth", "overlap", "serLines", "axId", "extLst"],
	bar3DChart: ["barDir", "grouping", "varyColors", "ser", "dLbls", "gapWidth", "gapDepth", "shape", "axId", "extLst"],
	lineChart: ["grouping", "varyColors", "ser", "dLbls", "dropLines", "hiLowLines", "upDownBars", "marker", "smooth", "axId", "extLst"],
	line3DChart: ["grouping", "varyColors", "ser", "dLbls", "dropLines", "gapDepth", "axId", "extLst"],
	areaChart: ["grouping", "varyColors", "ser", "dLbls", "dropLines", "axId", "extLst"],
	area3DChart: ["grouping", "varyColors", "ser", "dLbls", "dropLines", "gapDepth", "axId", "extLst"],
	pieChart: ["varyColors", "ser", "dLbls", "firstSliceAng", "extLst"],
	pie3DChart: ["varyColors", "ser", "dLbls", "extLst"],
	ofPieChart: [
		"ofPieType",
		"varyColors",
		"ser",
		"dLbls",
		"gapWidth",
		"splitType",
		"splitPos",
		"custSplit",
		"secondPieSize",
		"serLines",
		"extLst"
	],
	doughnutChart: ["varyColors", "ser", "dLbls", "firstSliceAng", "holeSize", "extLst"],
	scatterChart: ["scatterStyle", "varyColors", "ser", "dLbls", "axId", "extLst"],
	radarChart: ["radarStyle", "varyColors", "ser", "dLbls", "axId", "extLst"]
}

// Series children by plot element (CT_BarSer, CT_LineSer...).
const SERIES_ORDER: Readonly<Record<string, readonly string[]>> = {
	bar: [
		"idx",
		"order",
		"tx",
		"spPr",
		"invertIfNegative",
		"pictureOptions",
		"dPt",
		"dLbls",
		"trendline",
		"errBars",
		"cat",
		"val",
		"shape",
		"extLst"
	],
	line: ["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "smooth", "extLst"],
	area: ["idx", "order", "tx", "spPr", "pictureOptions", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "extLst"],
	pie: ["idx", "order", "tx", "spPr", "explosion", "dPt", "dLbls", "cat", "val", "extLst"],
	scatter: ["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "trendline", "errBars", "xVal", "yVal", "smooth", "extLst"],
	radar: ["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "cat", "val", "extLst"]
}

type SeriesKind = "bar" | "line" | "area" | "pie" | "scatter" | "radar"

const SERIES_KIND: Readonly<Record<string, SeriesKind>> = {
	barChart: "bar",
	bar3DChart: "bar",
	lineChart: "line",
	line3DChart: "line",
	areaChart: "area",
	area3DChart: "area",
	pieChart: "pie",
	pie3DChart: "pie",
	ofPieChart: "pie",
	doughnutChart: "pie",
	scatterChart: "scatter",
	radarChart: "radar"
}

const TARGET_ELEMENT: Readonly<Record<ChartEditType, string>> = {
	column: "barChart",
	bar: "barChart",
	line: "lineChart",
	area: "areaChart",
	pie: "pieChart",
	doughnut: "doughnutChart",
	scatter: "scatterChart"
}

// Plot kinds whose series are areas of colour (their spPr is a fill) rather than lines and points.
const FILLED: ReadonlySet<string> = new Set(["bar", "area", "pie"])

// Where data labels may sit (ST_DLblPos), by plot (Excel's "Label Position" choices; others make Excel repair the file).
export function labelPositions(type: ChartType, grouping: ChartGrouping | null): readonly ChartLabelPosition[] {
	switch (type) {
		case "column":
		case "bar":
			return grouping === "clustered" ? ["ctr", "inEnd", "inBase", "outEnd"] : ["ctr", "inEnd", "inBase"]
		case "line":
		case "scatter":
			return ["ctr", "l", "r", "t", "b"]
		case "pie":
			return ["bestFit", "ctr", "inEnd", "outEnd"]
		default:
			return []
	}
}

interface Context {
	readonly document: XmlDocument
	readonly reader: DrawingReader
	readonly editor: XmlEditor
	// The chart namespace's prefix with its colon ("c:"), and DrawingML main's URI for rich text.
	readonly c: string
	readonly main: string
	readonly host: ChartFormulaHost
}

function raw(context: Context, node: number): string {
	return decodeUtf8(context.document.raw(node))
}

function children(context: Context, node: number): number[] {
	const out: number[] = []
	const document = context.document

	for (let child = node < 0 ? -1 : document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		out.push(child)

	return out
}

function chartChild(context: Context, node: number, local: string): number {
	return context.reader.child(node, D.C, local)
}

// Refuses when the element's own extension list holds an extension not known to be safe to keep.
function checkExtensions(context: Context, node: number, what: string): void {
	const list = chartChild(context, node, "extLst")

	for (const ext of children(context, list)) {
		const uri = (context.reader.attr(ext, "uri") ?? "").toUpperCase()

		if (!SAFE_EXTENSIONS.has(uri)) refuse(`${what} extension ${uri}`)
	}
}

// Writes `markup` as the `local` child of `parent` (replacing one there), in schema order; null removes it.
function setChild(context: Context, parent: number, order: readonly string[], local: string, markup: string | null): void {
	const existing = chartChild(context, parent, local)

	if (existing >= 0) {
		if (markup === null) context.editor.remove(existing)
		else context.editor.replace(existing, markup)

		return
	}

	if (markup === null) return

	insertChild(context, parent, order, local, markup)
}

function insertChild(context: Context, parent: number, order: readonly string[], local: string, markup: string): void {
	const rank = order.indexOf(local)

	for (const child of children(context, parent)) {
		if (context.reader.group(child) !== D.C) continue

		const childRank = order.indexOf(context.reader.local(child))

		if (childRank > rank) {
			context.editor.insertBefore(child, markup)

			return
		}
	}

	context.editor.append(parent, markup)
}

function valElement(context: Context, local: string, value: string | number): string {
	return `<${context.c}${local} val="${escapeAttribute(String(value))}"/>`
}

// Rich text for a title (§21.2.2.156): one paragraph per line, the run properties of the text it replaces kept.
function richMarkup(context: Context, text: string, previous: number): string {
	const reader = context.reader
	const rich = reader.child(reader.child(previous, D.C, "tx"), D.C, "rich")
	const bodyPr = reader.child(rich, D.A, "bodyPr")
	const lstStyle = reader.child(rich, D.A, "lstStyle")
	const paragraph = reader.child(rich, D.A, "p")
	const pPr = reader.child(paragraph, D.A, "pPr")
	const rPr = reader.child(reader.child(paragraph, D.A, "r"), D.A, "rPr")
	const head = `${bodyPr >= 0 ? raw(context, bodyPr) : "<a:bodyPr/>"}${lstStyle >= 0 ? raw(context, lstStyle) : "<a:lstStyle/>"}`
	const paragraphProperties = pPr >= 0 ? raw(context, pPr) : "<a:pPr><a:defRPr/></a:pPr>"
	const runProperties = rPr >= 0 ? raw(context, rPr) : '<a:rPr lang="en-US"/>'
	const paragraphs = text
		.split(/\r\n|\r|\n/)
		.map(line => `<a:p>${paragraphProperties}<a:r>${runProperties}<a:t>${escapeText(line)}</a:t></a:r></a:p>`)
		.join("")

	// Inside the copied properties "a" is the source's own prefix only when it was bound so: rich text written here
	// declares it on c:rich.
	return `<${context.c}tx><${context.c}rich xmlns:a="${context.main}">${head}${paragraphs}</${context.c}rich></${context.c}tx>`
}

function checkText(text: string): void {
	if (text.length > 1024) refuse("title", "tooLarge")
	if (unwritableText(text)) refuse("title text")
}

// A title (chart or axis) with `text`; "" an automatic one (no text of its own).
function titleMarkup(context: Context, node: number, text: string): string {
	const order = ORDER["title"] ?? []

	if (node < 0) {
		return `<${context.c}title>${text === "" ? "" : richMarkup(context, text, -1)}${valElement(context, "overlay", 0)}</${context.c}title>`
	}

	checkExtensions(context, node, "title")

	let out = text === "" ? "" : richMarkup(context, text, node)

	for (const child of children(context, node)) {
		const local = context.reader.local(child)

		if (context.reader.group(child) === D.C && local === "tx") continue
		if (order.includes(local) || context.reader.group(child) !== D.C) out += raw(context, child)
	}

	return `${startTag(context, node)}${out}</${context.document.name(node)}>`
}

// An element's start tag as written (its attributes and declarations kept), made a non-empty one.
function startTag(context: Context, node: number): string {
	const document = context.document
	const tag = decodeUtf8(document.bytes.subarray(document.start(node), document.openEnd(node)))

	return tag.endsWith("/>") ? `${tag.slice(0, -2)}>` : tag
}

function editTitle(context: Context, chart: number, text: string | null): void {
	const order = ORDER["chart"] ?? []
	const title = chartChild(context, chart, "title")

	if (text === null) {
		setChild(context, chart, order, "title", null)
		setChild(context, chart, order, "autoTitleDeleted", valElement(context, "autoTitleDeleted", 1))

		return
	}

	checkText(text)
	setChild(context, chart, order, "title", titleMarkup(context, title, text))
	setChild(context, chart, order, "autoTitleDeleted", valElement(context, "autoTitleDeleted", 0))
}

function editLegend(context: Context, chart: number, position: ChartLegendPosition | null): void {
	const order = ORDER["chart"] ?? []
	const legend = chartChild(context, chart, "legend")

	if (position === null) {
		setChild(context, chart, order, "legend", null)

		return
	}

	if (legend < 0) {
		setChild(
			context,
			chart,
			order,
			"legend",
			`<${context.c}legend>${valElement(context, "legendPos", position)}${valElement(context, "overlay", 0)}</${context.c}legend>`
		)

		return
	}

	checkExtensions(context, legend, "legend")
	setChild(context, legend, ORDER["legend"] ?? [], "legendPos", valElement(context, "legendPos", position))
}

// Data labels (CT_DLbls) showing what `labels` asks, the labels of single points, their number format, shape and text
// properties kept.
function labelsMarkup(context: Context, node: number, labels: ChartLabels, pie: boolean): string {
	let kept = ""

	if (node >= 0) {
		checkExtensions(context, node, "data labels")

		for (const local of ["dLbl", "numFmt", "spPr", "txPr"])
			for (const child of context.reader.children(node, D.C, local)) kept += raw(context, child)
	}

	const position = labels.position === null ? "" : valElement(context, "dLblPos", labels.position)
	const flags =
		valElement(context, "showLegendKey", 0) +
		valElement(context, "showVal", labels.value ? 1 : 0) +
		valElement(context, "showCatName", labels.category ? 1 : 0) +
		valElement(context, "showSerName", labels.series ? 1 : 0) +
		valElement(context, "showPercent", pie && labels.percent ? 1 : 0) +
		valElement(context, "showBubbleSize", 0)
	const leader = pie ? valElement(context, "showLeaderLines", 1) : ""
	const extension = node < 0 ? -1 : chartChild(context, node, "extLst")

	return `<${context.c}dLbls>${kept}${position}${flags}${leader}${extension >= 0 ? raw(context, extension) : ""}</${context.c}dLbls>`
}

function hiddenLabelsMarkup(context: Context): string {
	return `<${context.c}dLbls>${
		valElement(context, "showLegendKey", 0) +
		valElement(context, "showVal", 0) +
		valElement(context, "showCatName", 0) +
		valElement(context, "showSerName", 0) +
		valElement(context, "showPercent", 0) +
		valElement(context, "showBubbleSize", 0)
	}</${context.c}dLbls>`
}

function plotType(context: Context, plot: number): { type: ChartType; grouping: ChartGrouping | null } {
	const element = context.reader.local(plot)
	const grouping = val(context.reader, plot, "grouping") as ChartGrouping | undefined
	const kind = SERIES_KIND[element]
	const type: ChartType =
		kind === "bar"
			? val(context.reader, plot, "barDir") === "bar"
				? "bar"
				: "column"
			: kind === "pie"
				? element === "doughnutChart"
					? "doughnut"
					: "pie"
				: kind === undefined
					? "other"
					: kind

	return {
		type,
		grouping: grouping ?? (type === "column" || type === "bar" ? "clustered" : type === "line" || type === "area" ? "standard" : null)
	}
}

function editLabels(context: Context, plots: readonly number[], labels: ChartLabels | null): void {
	for (const plot of plots) {
		const element = context.reader.local(plot)
		const order = ORDER[element]
		const seriesOrder = SERIES_ORDER[SERIES_KIND[element] ?? ""]

		if (order === undefined || seriesOrder === undefined) refuse(`labels on ${element}`)

		const { type, grouping } = plotType(context, plot)

		if (labels !== null && labels.position !== null && !labelPositions(type, grouping).includes(labels.position))
			refuse("label position")

		const pie = type === "pie" || type === "doughnut"

		for (const series of context.reader.children(plot, D.C, "ser")) {
			checkExtensions(context, series, "series")

			const existing = chartChild(context, series, "dLbls")

			setChild(context, series, seriesOrder, "dLbls", labels === null ? null : labelsMarkup(context, existing, labels, pie))
		}

		const own = chartChild(context, plot, "dLbls")

		setChild(
			context,
			plot,
			order,
			"dLbls",
			labels === null ? (own < 0 ? null : hiddenLabelsMarkup(context)) : labelsMarkup(context, own, labels, pie)
		)
	}
}

function checkNumber(value: number | null | undefined, what: string): void {
	if (value !== null && value !== undefined && !Number.isFinite(value)) refuse(what, "chartValue")
}

function editAxis(context: Context, axis: number, patch: ChartAxisPatch): void {
	const reader = context.reader
	const local = reader.local(axis)
	const order = ORDER[local] ?? []
	const kind = AXIS_ELEMENTS.get(local)
	const scaled = kind === "val" || kind === "date"

	checkExtensions(context, axis, "axis")

	if (!scaled && (patch.min !== undefined || patch.max !== undefined || patch.major !== undefined || patch.minor !== undefined))
		refuse("category axis bounds")

	checkNumber(patch.min, "axis minimum")
	checkNumber(patch.max, "axis maximum")
	checkNumber(patch.major, "axis unit")
	checkNumber(patch.minor, "axis unit")

	for (const unit of [patch.major, patch.minor]) if (unit !== undefined && unit !== null && unit <= 0) refuse("axis unit", "chartValue")

	if (patch.min !== undefined || patch.max !== undefined) {
		const scaling = chartChild(context, axis, "scaling")
		const scalingOrder = ORDER["scaling"] ?? []
		const min =
			patch.min === undefined ? (reader.child(scaling, D.C, "min") >= 0 ? Number(val(reader, scaling, "min")) : null) : patch.min
		const max =
			patch.max === undefined ? (reader.child(scaling, D.C, "max") >= 0 ? Number(val(reader, scaling, "max")) : null) : patch.max

		if (min !== null && max !== null && !(min < max)) refuse("axis bounds", "chartValue")
		if (scaling < 0) refuse("axis scaling")

		checkExtensions(context, scaling, "axis scaling")

		if (patch.max !== undefined)
			setChild(context, scaling, scalingOrder, "max", patch.max === null ? null : valElement(context, "max", patch.max))
		if (patch.min !== undefined)
			setChild(context, scaling, scalingOrder, "min", patch.min === null ? null : valElement(context, "min", patch.min))
	}

	if (patch.major !== undefined)
		setChild(context, axis, order, "majorUnit", patch.major === null ? null : valElement(context, "majorUnit", patch.major))
	if (patch.minor !== undefined)
		setChild(context, axis, order, "minorUnit", patch.minor === null ? null : valElement(context, "minorUnit", patch.minor))

	if (patch.format !== undefined) {
		if (patch.format !== null && numFmtProblem(patch.format) !== null) refuse("number format", "formula")

		setChild(
			context,
			axis,
			order,
			"numFmt",
			patch.format === null
				? `<${context.c}numFmt formatCode="General" sourceLinked="1"/>`
				: `<${context.c}numFmt formatCode="${escapeAttribute(patch.format)}" sourceLinked="0"/>`
		)
	}

	if (patch.title !== undefined) {
		if (patch.title !== null) checkText(patch.title)

		setChild(
			context,
			axis,
			order,
			"title",
			patch.title === null || patch.title === "" ? null : titleMarkup(context, chartChild(context, axis, "title"), patch.title)
		)
	}

	if (patch.visible !== undefined) setChild(context, axis, order, "delete", valElement(context, "delete", patch.visible ? 0 : 1))
	if (patch.gridlines !== undefined)
		setChild(
			context,
			axis,
			order,
			"majorGridlines",
			patch.gridlines
				? chartChild(context, axis, "majorGridlines") >= 0
					? raw(context, chartChild(context, axis, "majorGridlines"))
					: `<${context.c}majorGridlines/>`
				: null
		)
}

// --- Series ---

function seriesNodes(context: Context, plots: readonly number[]): { plot: number; series: number }[] {
	return plots.flatMap(plot => context.reader.children(plot, D.C, "ser").map(series => ({ plot, series })))
}

// The highest c:idx or c:order of the plots' series, the series an extension holds included (the c15 filtered
// series Excel keeps when a series is unticked in the chart filter): both are unique in a chart (§21.2.2.84,
// §21.2.2.128). -1 for none.
function highestOfSeries(context: Context, plots: readonly number[], local: "idx" | "order"): number {
	const reader = context.reader
	const document = context.document
	let highest = -1

	for (const plot of plots) {
		const end = document.end(plot)

		for (let node = plot + 1; node < document.count && document.start(node) < end; node++) {
			if (document.kind(node) !== NodeKind.Element || !reader.is(node, D.C, local)) continue

			const parent = document.parent(node)

			if (parent >= 0 && reader.local(parent) === "ser") highest = Math.max(highest, reader.number(node, "val", -1))
		}
	}

	return highest
}

function seriesOf(
	context: Context,
	all: readonly { plot: number; series: number }[],
	edit: { readonly series: number; readonly id?: number }
): { plot: number; series: number } {
	const found =
		edit.id === undefined
			? all[edit.series]
			: all.find(({ series }) => context.reader.number(chartChild(context, series, "idx"), "val", -1) === edit.id)

	return found ?? refuse("series")
}

function formulaMarkup(context: Context, element: "strRef" | "numRef", formula: string): string {
	return `<${context.c}${element}><${context.c}f>${escapeText(formula)}</${context.c}f></${context.c}${element}>`
}

function nameMarkup(context: Context, text: string): string {
	// As in Excel's Edit Series dialog: "=" starts a reference, anything else is the name itself.
	if (text.trimStart().startsWith("="))
		return `<${context.c}tx>${formulaMarkup(context, "strRef", reference(context, text))}</${context.c}tx>`

	checkText(text)

	return `<${context.c}tx><${context.c}v>${escapeText(text)}</${context.c}v></${context.c}tx>`
}

function reference(context: Context, text: string): string {
	const formula = context.host.reference(text)

	if (formula === null) refuse("series range", "formula")

	return formula
}

function categoriesMarkup(context: Context, local: "cat" | "xVal", text: string): string {
	const formula = reference(context, text)

	return `<${context.c}${local}>${formulaMarkup(context, context.host.numeric(formula) ? "numRef" : "strRef", formula)}</${context.c}${local}>`
}

function valuesMarkup(context: Context, local: "val" | "yVal", text: string): string {
	return `<${context.c}${local}>${formulaMarkup(context, "numRef", reference(context, text))}</${context.c}${local}>`
}

function editSeries(context: Context, plot: number, series: number, edit: Extract<SheetChartEdit, { kind: "series.set" }>): void {
	const element = context.reader.local(plot)
	const kind = SERIES_KIND[element]
	const order = SERIES_ORDER[kind ?? ""]

	if (kind === undefined || order === undefined) refuse(`series of ${element}`)

	checkExtensions(context, series, "series")

	const scatter = kind === "scatter"

	if (edit.name !== undefined) setChild(context, series, order, "tx", edit.name === null ? null : nameMarkup(context, edit.name))
	if (edit.categories !== undefined) {
		const local = scatter ? "xVal" : "cat"

		setChild(context, series, order, local, edit.categories === null ? null : categoriesMarkup(context, local, edit.categories))
	}

	if (edit.values !== undefined) {
		const local = scatter ? "yVal" : "val"

		setChild(context, series, order, local, valuesMarkup(context, local, edit.values))
	}
}

function addSeries(context: Context, plots: readonly number[], plot: number, edit: Extract<SheetChartEdit, { kind: "series.add" }>): void {
	const element = context.reader.local(plot)
	const kind = SERIES_KIND[element]
	const order = ORDER[element]

	if (kind === undefined || order === undefined) refuse(`series of ${element}`)

	const all = seriesNodes(context, plots)

	if (all.length >= 255) refuse("series", "tooLarge")

	const idx = highestOfSeries(context, plots, "idx") + 1
	const next = highestOfSeries(context, plots, "order") + 1
	const scatter = kind === "scatter"
	let markup = valElement(context, "idx", idx) + valElement(context, "order", next)

	if (edit.name !== null) markup += nameMarkup(context, edit.name)
	if (kind === "bar") markup += valElement(context, "invertIfNegative", 0)
	if (edit.categories !== null) markup += categoriesMarkup(context, scatter ? "xVal" : "cat", edit.categories)

	markup += valuesMarkup(context, scatter ? "yVal" : "val", edit.values)

	if (kind === "line" || kind === "scatter") markup += valElement(context, "smooth", 0)

	const last = context.reader.children(plot, D.C, "ser").at(-1)
	const series = `<${context.c}ser>${markup}</${context.c}ser>`

	if (last !== undefined) context.editor.insertAfter(last, series)
	else insertChild(context, plot, order, "ser", series)
}

// A series' markup with its c:order set to `order`.
function withOrder(context: Context, series: number, order: number): string {
	const document = context.document
	const node = chartChild(context, series, "order")
	const bytes = document.raw(series)

	if (node < 0) return decodeUtf8(bytes)

	const start = document.start(series)
	const before = decodeUtf8(bytes.subarray(0, document.start(node) - start))
	const after = decodeUtf8(bytes.subarray(document.end(node) - start))

	return `${before}${valElement(context, "order", order)}${after}`
}

function moveSeries(context: Context, plot: number, from: number, to: number): void {
	const list = context.reader.children(plot, D.C, "ser")

	if (to < 0 || to >= list.length) refuse("series position")

	const moved = list.slice()
	const [taken] = moved.splice(from, 1)

	if (taken === undefined) refuse("series position")

	moved.splice(to, 0, taken)

	const orders = list.map(series => Number(val(context.reader, series, "order") ?? 0)).sort((a, b) => a - b)

	list.forEach((slot, position) => {
		const series = moved[position]

		if (series !== undefined) context.editor.replace(slot, withOrder(context, series, orders[position] ?? position))
	})
}

// --- Type ---

// A child element renamed (cat and xVal, val and yVal hold the same types).
function renamed(context: Context, node: number, to: string): string {
	const document = context.document
	const name = document.name(node)
	const prefix = name.includes(":") ? `${name.slice(0, name.indexOf(":"))}:` : ""
	const text = raw(context, node)
	const open = `<${name}`

	if (!text.startsWith(open)) return text

	const body = `<${prefix}${to}${text.slice(open.length)}`

	return document.isSelfClosing(node) ? body : `${body.slice(0, body.length - `</${name}>`.length)}</${prefix}${to}>`
}

// Data labels without their positions (what one plot kind allows another does not).
function withoutPositions(context: Context, node: number): string {
	const document = context.document
	const start = document.start(node)
	const bytes = document.raw(node)
	const cuts: [number, number][] = []
	const end = document.end(node)

	for (let n = node + 1; n < document.count && document.start(n) < end; n++)
		if (document.kind(n) === NodeKind.Element && context.reader.is(n, D.C, "dLblPos"))
			cuts.push([document.start(n) - start, document.end(n) - start])

	let out = ""
	let at = 0

	for (const [from, to] of cuts) {
		out += decodeUtf8(bytes.subarray(at, from))
		at = to
	}

	return out + decodeUtf8(bytes.subarray(at))
}

function convertSeries(context: Context, series: number, from: string, to: string, stacked: boolean): string {
	const order = SERIES_ORDER[to] ?? []
	const sameFamily = FILLED.has(from) === FILLED.has(to)
	const parts = new Map<string, string[]>()

	checkExtensions(context, series, "series")

	for (const child of children(context, series)) {
		if (context.reader.group(child) !== D.C) refuse("series markup")

		let local = context.reader.local(child)
		let markup = raw(context, child)

		if (to === "scatter" && (local === "cat" || local === "val")) {
			local = local === "cat" ? "xVal" : "yVal"
			markup = renamed(context, child, local)
		} else if (from === "scatter" && to !== "scatter" && (local === "xVal" || local === "yVal")) {
			local = local === "xVal" ? "cat" : "val"
			markup = renamed(context, child, local)
		}

		if (!sameFamily && (local === "spPr" || local === "dPt")) continue
		if (local === "trendline" && stacked) continue
		if (local === "dLbls") markup = withoutPositions(context, child)

		const list = parts.get(local) ?? []

		list.push(markup)
		parts.set(local, list)
	}

	let out = ""

	for (const local of order) out += (parts.get(local) ?? []).join("")

	return `<${context.c}ser>${out}</${context.c}ser>`
}

function newAxisId(taken: Set<number>): number {
	// Excel's own ids are large arbitrary numbers; any unsigned int unique in the chart does.
	let id = 50_000_000 + taken.size * 7919

	while (taken.has(id)) id++

	taken.add(id)

	return id
}

function axisMarkup(context: Context, kind: "catAx" | "valAx", id: number, cross: number, position: string, between: string): string {
	const common =
		valElement(context, "axId", id) +
		`<${context.c}scaling>${valElement(context, "orientation", "minMax")}</${context.c}scaling>` +
		valElement(context, "delete", 0) +
		valElement(context, "axPos", position) +
		(kind === "valAx" ? `<${context.c}majorGridlines/>` : "") +
		`<${context.c}numFmt formatCode="General" sourceLinked="1"/>` +
		valElement(context, "majorTickMark", kind === "valAx" ? "none" : "out") +
		valElement(context, "minorTickMark", "none") +
		valElement(context, "tickLblPos", "nextTo") +
		valElement(context, "crossAx", cross) +
		valElement(context, "crosses", "autoZero")
	const tail =
		kind === "catAx"
			? valElement(context, "auto", 1) +
				valElement(context, "lblAlgn", "ctr") +
				valElement(context, "lblOffset", 100) +
				valElement(context, "noMultiLvlLbl", 0)
			: valElement(context, "crossBetween", between)

	return `<${context.c}${kind}>${common}${tail}</${context.c}${kind}>`
}

const COMMON_AXIS: readonly string[] = [
	"axId",
	"scaling",
	"delete",
	"axPos",
	"majorGridlines",
	"minorGridlines",
	"title",
	"numFmt",
	"majorTickMark",
	"minorTickMark",
	"tickLblPos",
	"spPr",
	"txPr",
	"crossAx",
	"crosses",
	"crossesAt"
]

// An axis as another kind (category and value axes share their first children), at `position` when given.
function convertAxis(context: Context, axis: number, kind: "catAx" | "valAx", position: string | null, between: string): string {
	checkExtensions(context, axis, "axis")

	let out = ""

	for (const local of COMMON_AXIS) {
		for (const child of context.reader.children(axis, D.C, local)) {
			out += local === "axPos" && position !== null ? valElement(context, "axPos", position) : raw(context, child)
		}
	}

	if (kind === "catAx")
		out +=
			valElement(context, "auto", 1) +
			valElement(context, "lblAlgn", "ctr") +
			valElement(context, "lblOffset", 100) +
			valElement(context, "noMultiLvlLbl", 0)
	else {
		out += valElement(context, "crossBetween", between)

		for (const local of ["majorUnit", "minorUnit", "dispUnits"])
			for (const child of context.reader.children(axis, D.C, local)) out += raw(context, child)
	}

	return `<${context.c}${kind}>${out}</${context.c}${kind}>`
}

const SWAP: Readonly<Record<string, string>> = { b: "l", l: "b", t: "r", r: "t" }

function editType(
	context: Context,
	plotArea: number,
	plots: readonly number[],
	index: number,
	type: ChartEditType,
	grouping: ChartGrouping | undefined
): void {
	const plot = plots[index]

	if (plot === undefined) refuse("plot")

	const reader = context.reader
	const element = reader.local(plot)
	const from = SERIES_KIND[element]

	if (from === undefined || element === "ofPieChart") refuse(`type of ${element}`)

	checkExtensions(context, plot, "plot")

	const combo = plots.length > 1

	if (combo && !(type === "column" || type === "line" || type === "area")) refuse("type in a combination chart")

	const target = TARGET_ELEMENT[type]
	const to = SERIES_KIND[target] ?? "bar"
	const groupingIn = plotType(context, plot).grouping
	const groupingOut: ChartGrouping | null =
		type === "column" || type === "bar"
			? grouping === "stacked" || grouping === "percentStacked"
				? grouping
				: grouping === undefined && (groupingIn === "stacked" || groupingIn === "percentStacked") && from === "bar"
					? groupingIn
					: "clustered"
			: type === "line" || type === "area"
				? grouping === "stacked" || grouping === "percentStacked" || grouping === "standard"
					? grouping
					: "standard"
				: null
	const stacked = groupingOut === "stacked" || groupingOut === "percentStacked"
	const series = reader.children(plot, D.C, "ser")
	const plotLabels = chartChild(context, plot, "dLbls")
	const changedKind = to !== from || target !== element
	// A new grouping allows other positions (outEnd is for clustered bars only): they go, as on a new kind.
	const labels =
		plotLabels < 0 ? "" : changedKind || groupingIn !== groupingOut ? withoutPositions(context, plotLabels) : raw(context, plotLabels)
	const seriesMarkup = series.map(node => convertSeries(context, node, from, to, stacked)).join("")
	const axisIds = reader.children(plot, D.C, "axId").map(node => reader.number(node, "val", -1))
	const allAxes = axisNodes(reader, plotArea)
	const byId = new Map(allAxes.map(axis => [reader.number(chartChild(context, axis, "axId"), "val", -1), axis] as const))
	const needsAxes = to !== "pie"
	let ids: number[] = []

	if (needsAxes) {
		const taken = new Set(byId.keys())

		if (axisIds.length >= 2 && axisIds.every(id => byId.has(id))) {
			ids = axisIds.slice(0, 2)

			const [first, second] = ids.map(id => byId.get(id) ?? -1)
			const fromDirection = from === "bar" && val(reader, plot, "barDir") === "bar" ? "bar" : "column"
			const toDirection = type === "bar" ? "bar" : "column"
			const swap = fromDirection !== toDirection
			const position = (node: number): string | null => {
				const current = val(reader, node, "axPos") ?? "b"

				return swap ? (SWAP[current] ?? current) : null
			}

			if (first !== undefined && first >= 0 && second !== undefined && second >= 0) {
				const firstKind = reader.local(first)
				const sharedElsewhere = plots.some(
					other =>
						other !== plot && reader.children(other, D.C, "axId").some(node => ids.includes(reader.number(node, "val", -1)))
				)

				if (to === "scatter" && firstKind !== "valAx") {
					if (sharedElsewhere) refuse("shared axis")

					context.editor.replace(first, convertAxis(context, first, "valAx", position(first), "midCat"))
				} else if (from === "scatter" && to !== "scatter" && firstKind === "valAx") {
					if (sharedElsewhere) refuse("shared axis")

					context.editor.replace(first, convertAxis(context, first, "catAx", position(first), "between"))
				} else if (swap) {
					context.editor.replace(
						first,
						convertAxis(context, first, firstKind === "valAx" ? "valAx" : "catAx", position(first), "between")
					)
				}

				if (reader.local(second) === "valAx" && (swap || to === "scatter" || from === "scatter"))
					context.editor.replace(
						second,
						convertAxis(context, second, "valAx", position(second), to === "scatter" ? "midCat" : "between")
					)
			}
		} else {
			const first = newAxisId(taken)
			const second = newAxisId(taken)
			const horizontal = type === "bar"

			ids = [first, second]

			const markup =
				axisMarkup(context, to === "scatter" ? "valAx" : "catAx", first, second, horizontal ? "l" : "b", "midCat") +
				axisMarkup(context, "valAx", second, first, horizontal ? "b" : "l", to === "scatter" ? "midCat" : "between")

			// Axes are a choice group in CT_PlotArea: they go before dTable, spPr and extLst.
			insertChild(context, plotArea, ORDER["plotArea"] ?? [], "serAx", markup)
		}
	}

	const c = context.c
	const head =
		target === "barChart"
			? valElement(context, "barDir", type === "bar" ? "bar" : "col") +
				valElement(context, "grouping", groupingOut ?? "clustered") +
				valElement(context, "varyColors", 0)
			: target === "lineChart" || target === "areaChart"
				? valElement(context, "grouping", groupingOut ?? "standard") + valElement(context, "varyColors", 0)
				: target === "scatterChart"
					? valElement(context, "scatterStyle", "lineMarker") + valElement(context, "varyColors", 0)
					: valElement(context, "varyColors", 1)
	const keep = (local: string, fallback: string): string => {
		const node = chartChild(context, plot, local)

		return node >= 0 && target === element ? raw(context, node) : fallback
	}
	const tail =
		target === "barChart"
			? keep("gapWidth", valElement(context, "gapWidth", 150)) + (stacked ? valElement(context, "overlap", 100) : "")
			: target === "lineChart"
				? valElement(context, "marker", 1)
				: target === "pieChart"
					? keep("firstSliceAng", valElement(context, "firstSliceAng", 0))
					: target === "doughnutChart"
						? keep("firstSliceAng", valElement(context, "firstSliceAng", 0)) +
							keep("holeSize", valElement(context, "holeSize", 75))
						: ""
	const axes = ids.map(id => valElement(context, "axId", id)).join("")
	const extension = chartChild(context, plot, "extLst")

	context.editor.replace(
		plot,
		`<${c}${target}>${head}${seriesMarkup}${labels}${tail}${axes}${extension >= 0 ? raw(context, extension) : ""}</${c}${target}>`
	)

	// Axes no plot refers to any more go.
	const used = new Set<number>(ids)

	for (const other of plots)
		if (other !== plot) for (const node of reader.children(other, D.C, "axId")) used.add(reader.number(node, "val", -1))

	for (const [id, axis] of byId) if (!used.has(id)) context.editor.remove(axis)
}

// --- Entry ---

// `edit` applied to a chart part's markup. Throws ChartEditRefused when it cannot be made.
export function applyChartEdit(document: XmlDocument, edit: SheetChartEdit, host: ChartFormulaHost): Uint8Array {
	const reader = drawingReader(document)
	const { space, chart, plotArea } = chartRoot(reader)

	if (chart < 0 || plotArea < 0) refuse("chart part")
	if (reader.child(space, D.C, "pivotSource") >= 0) refuse("pivot chart")

	const prefix = document.prefix(space)
	const strict = reader.namespaces.elementUri(space) === CHART_STRICT_NAMESPACE
	const context: Context = {
		document,
		reader,
		editor: new XmlEditor(document),
		c: prefix === "" ? "" : `${prefix}:`,
		main: strict ? "http://purl.oclc.org/ooxml/drawingml/main" : "http://schemas.openxmlformats.org/drawingml/2006/main",
		host
	}
	const plots = plotNodes(reader, plotArea)
	const all = seriesNodes(context, plots)

	switch (edit.kind) {
		case "title":
			editTitle(context, chart, edit.text)
			break
		case "legend":
			editLegend(context, chart, edit.position)
			break
		case "labels": {
			const target = edit.plot === null ? plots : [plots[edit.plot] ?? refuse("plot")]

			editLabels(context, target, edit.labels)
			break
		}
		case "axis": {
			const axis = axisNodes(reader, plotArea).find(node => reader.number(chartChild(context, node, "axId"), "val", -1) === edit.axis)

			if (axis === undefined) refuse("axis")

			editAxis(context, axis, edit.patch)
			break
		}
		case "type":
			editType(context, plotArea, plots, edit.plot, edit.type, edit.grouping)
			break
		case "series.add":
			addSeries(context, plots, plots[edit.plot] ?? refuse("plot"), edit)
			break
		case "series.remove": {
			const found = seriesOf(context, all, edit)

			context.editor.remove(found.series)
			break
		}
		case "series.move": {
			const found = seriesOf(context, all, edit)
			const inPlot = reader.children(found.plot, D.C, "ser")

			moveSeries(context, found.plot, inPlot.indexOf(found.series), edit.to)
			break
		}
		case "series.set": {
			const found = seriesOf(context, all, edit)

			editSeries(context, found.plot, found.series, edit)
			break
		}
	}

	return context.editor.serialize()
}

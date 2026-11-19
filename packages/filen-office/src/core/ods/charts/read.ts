import type { OdfPackage } from "../../odf/package"
import { elementName, readElement, type OdfElement } from "../../odf/tree"
import { parseLength } from "../../odf/units"
import { columnIndex } from "../../sheet/refs/cellRef"
import type { ChartLabels } from "../../xlsx/charts/model"
import type { XlsxSection } from "../../xlsx/model/types"
import { Namespaces, escapeAttribute, escapeText, parseXml, type XmlDocument } from "../../xml/index"
import { EMU_PER_PT } from "../convert/shapes"
import { rangeAddress } from "../formula/toXlsx"
import type { OdsIssues } from "../issues"
import type { SliceClock } from "../../slicing"
import { parseCaptured, spaceCount } from "../read/captured"
import type { OdsCellFrame } from "../read/content"
import { OdsReadError } from "../read/errors"

// ODF charts (chart:chart objects, ODF 1.3 Part 3 §11) as the sheet's DrawingML charts (ECMA-376 Part 1 §21.2), so
// the chart features show and edit them as they do a workbook's: each chart object a frame embeds becomes a chart
// part, and each sheet's frames one drawing part anchoring them (a page-anchored frame in table:shapes absolutely, a
// cell's frame from its cell). What a chart part cannot say is named in the issues and keeps the chart from being
// written back (OdsChartSource.refusal); a chart class with no DrawingML plot shows as a chart without plots (a
// placeholder).

export interface OdsChartTable {
	readonly index: number
	readonly name: string
	// table:shapes as written, and frames anchored to cells.
	readonly shapes: Uint8Array | undefined
	readonly frames: readonly OdsCellFrame[]
}

export interface OdsChartInput {
	readonly odf: OdfPackage
	readonly prefixes: ReadonlyMap<string, string>
	readonly tables: readonly OdsChartTable[]
	readonly issues: OdsIssues
	readonly clock?: SliceClock | undefined
	readonly signal?: { readonly aborted: boolean } | undefined
}

// A sheet's charts: the relationships its part needs and the sections naming them, given the ids they got.
export interface OdsSheetCharts {
	readonly relationships: readonly { readonly type: string; readonly target: string }[]
	sections(ids: readonly string[]): readonly XlsxSection[]
}

// Where a frame is anchored: on the page (table:shapes, its k-th child) or to a cell (its k-th frame there).
export type OdsChartPlace =
	| { readonly kind: "page"; readonly frame: number }
	| { readonly kind: "cell"; readonly row: number; readonly col: number; readonly frame: number }

// Where a chart part came from: the ODF object and the frame holding it.
export interface OdsChartSource {
	readonly part: string
	readonly object: string
	readonly table: number
	readonly place: OdsChartPlace
	// The drawing part showing it, its anchor's place there and its chart's relationship id.
	readonly drawing: string
	readonly anchor: number
	readonly relationship: string
	// Its table's table:shapes as written (a page-anchored frame is one of its children).
	readonly shapes: Uint8Array | undefined
	// The object's content.xml as read (charts are small): what an edit is written into.
	readonly content: Uint8Array
	// Why it is never written back (a construct the translation does not carry), null when it can be.
	readonly refusal: string | null
}

export interface OdsChartParts {
	// Drawing and chart parts with their relationships, by name.
	readonly parts: ReadonlyMap<string, Uint8Array>
	// [Content_Types].xml Override elements for them.
	readonly overrides: readonly string[]
	readonly sheets: ReadonlyMap<number, OdsSheetCharts>
	readonly charts: readonly OdsChartSource[]
}

export const NO_CHARTS: OdsChartParts = { parts: new Map(), overrides: [], sheets: new Map(), charts: [] }

const encoder = new TextEncoder()

const C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships"
const DRAWING_RELATIONSHIP = `${R}/drawing`
const CHART_RELATIONSHIP = `${R}/chart`
const DRAWING_CONTENT = "application/vnd.openxmlformats-officedocument.drawing+xml"
const CHART_CONTENT = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"

// Chart objects one workbook shows, and the bytes one object may take: past them the rest are left out (an issue).
const MAX_CHARTS = 1024
const MAX_OBJECT_BYTES = 16 * 1024 * 1024
// The objects' content one workbook reads, all told (each object once, however many frames show it).
export const MAX_CHART_BYTES = 64 * 1024 * 1024
const MAX_POINT_STYLES = 4096

// --- The chart object ---

export interface ChartStyles {
	// Per automatic style name: its chart, graphic and text properties.
	readonly chart: Map<string, ReadonlyMap<string, string>>
	readonly graphic: Map<string, ReadonlyMap<string, string>>
}

function readStyles(root: OdfElement): ChartStyles {
	const styles: ChartStyles = { chart: new Map(), graphic: new Map() }

	for (const container of root.children) {
		if (container.name !== "office:automatic-styles" && container.name !== "office:styles") continue

		for (const style of container.children) {
			const name = style.attributes.get("style:name")

			if (style.name !== "style:style" || name === undefined) continue

			for (const properties of style.children) {
				if (properties.name === "style:chart-properties") styles.chart.set(name, properties.attributes)
				else if (properties.name === "style:graphic-properties") styles.graphic.set(name, properties.attributes)
			}
		}
	}

	return styles
}

const NONE: ReadonlyMap<string, string> = new Map()

export function child(element: OdfElement | undefined, name: string): OdfElement | undefined {
	return element?.children.find(candidate => candidate.name === name)
}

export function children(element: OdfElement | undefined, name: string): OdfElement[] {
	return element === undefined ? [] : element.children.filter(candidate => candidate.name === name)
}

// The most spaces one text:s of a chart stands for.
const CHART_SPACE_RUN = 1024

// The text of an element, paragraphs on lines of their own (text:p, text:h), text:s and text:tab as themselves.
export function elementText(element: OdfElement): string {
	const lines: string[] = []
	const walk = (node: OdfElement, into: string[]): void => {
		into.push(node.text)

		for (const inner of node.children) {
			// Chart text is never written back as text:s: a short run is enough to show.
			if (inner.name === "text:s") into.push(" ".repeat(spaceCount(inner.attributes.get("text:c"), CHART_SPACE_RUN)))
			else if (inner.name === "text:tab") into.push("\t")
			else if (inner.name === "text:line-break") into.push("\n")
			else walk(inner, into)
		}
	}

	for (const paragraph of element.children) {
		if (paragraph.name !== "text:p" && paragraph.name !== "text:h") continue

		const parts: string[] = []

		walk(paragraph, parts)
		lines.push(parts.join(""))
	}

	return lines.join("\n")
}

// A cell range address of a chart (table:cell-range-address, chart:values-cell-range-address; §19.587) as an
// absolute Excel reference ("Data!$B$2:$B$4"), several areas joined in parentheses; null when it does not translate.
export function chartReference(address: string | undefined): string | null {
	if (address === undefined || address.trim() === "") return null

	const translated = rangeAddress(address.trim())

	if ("refused" in translated || translated.text === "") return null

	const areas = translated.text.split(",").map(area => {
		const bang = area.lastIndexOf("!")
		const sheet = bang < 0 ? "" : area.slice(0, bang + 1)
		let cells = (bang < 0 ? area : area.slice(bang + 1)).replace(/\$?([A-Z]{1,3})\$?(\d+)/g, "$$$1$$$2")
		const [first, second] = cells.split(":")

		if (second !== undefined && first === second) cells = first ?? cells

		return sheet + cells
	})

	return areas.length === 1 ? (areas[0] ?? null) : `(${areas.join(",")})`
}

// "#RRGGBB" as an srgbClr value, undefined for anything else.
function rgb(color: string | undefined): string | undefined {
	return color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color) ? color.slice(1).toUpperCase() : undefined
}

// The plot a chart class draws as (§19.15 chart:class).
type Plot = "bar" | "line" | "area" | "pie" | "doughnut" | "scatter" | "radar" | "filledRadar"

export const CLASSES: ReadonlyMap<string, Plot> = new Map([
	["chart:bar", "bar"],
	["chart:line", "line"],
	["chart:area", "area"],
	["chart:circle", "pie"],
	["chart:ring", "doughnut"],
	["chart:scatter", "scatter"],
	["chart:radar", "radar"],
	["chart:filled-radar", "filledRadar"]
])

interface Series {
	readonly element: OdfElement
	readonly plot: Plot
}

export interface Translated {
	readonly markup: string
	readonly refusal: string | null
	readonly issues: readonly string[]
}

function solidFill(color: string): string {
	return `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
}

// c:spPr of a series or point: its fill and its line as its graphic properties say (draw:fill, draw:fill-color,
// draw:stroke, svg:stroke-color; ODF 1.3 Part 3 §20.112, §20.115, §20.172, §20.485).
function shapeProperties(graphic: ReadonlyMap<string, string>, line: boolean): string {
	const fill = rgb(graphic.get("draw:fill-color"))
	const stroke = rgb(graphic.get("svg:stroke-color"))
	const noFill = graphic.get("draw:fill") === "none"
	const noStroke = graphic.get("draw:stroke") === "none"
	let out = ""

	if (line) {
		out += noStroke ? "<a:ln><a:noFill/></a:ln>" : stroke === undefined ? "" : `<a:ln>${solidFill(stroke)}</a:ln>`
	} else {
		out += noFill ? "<a:noFill/>" : fill === undefined ? "" : solidFill(fill)

		if (noStroke) out += "<a:ln><a:noFill/></a:ln>"
		else if (stroke !== undefined && graphic.has("draw:stroke")) out += `<a:ln>${solidFill(stroke)}</a:ln>`
	}

	return out === "" ? "" : `<c:spPr>${out}</c:spPr>`
}

// chart:label-position (§20.71) as c:dLblPos (§21.2.3.11), and the positions each plot takes.
export const LABEL_POSITIONS: ReadonlyMap<string, string> = new Map([
	["avoid-overlap", "bestFit"],
	["center", "ctr"],
	["top", "t"],
	["bottom", "b"],
	["left", "l"],
	["right", "r"],
	["inside", "inEnd"],
	["outside", "outEnd"],
	["near-origin", "inBase"]
])
const BAR_LABELS: ReadonlySet<string> = new Set(["ctr", "inBase", "inEnd", "outEnd"])
const PIE_LABELS: ReadonlySet<string> = new Set(["bestFit", "ctr", "inEnd", "outEnd"])
const LINE_LABELS: ReadonlySet<string> = new Set(["ctr", "t", "b", "l", "r"])

// c:dLbls of a series as its style says (chart:data-label-number, chart:data-label-text, chart:data-label-series;
// §20.27-§20.29).
function dataLabels(chart: ReadonlyMap<string, string>, plot: Plot): string {
	const number = chart.get("chart:data-label-number") ?? "none"
	const value = number === "value" || number === "value-and-percentage"
	const percent = number === "percentage" || number === "value-and-percentage"
	const category = chart.get("chart:data-label-text") === "true"
	const series = chart.get("chart:data-label-series") === "true"

	if (!value && !percent && !category && !series) return ""

	const position = LABEL_POSITIONS.get(chart.get("chart:label-position") ?? "")
	const pieLike = plot === "pie" || plot === "doughnut"
	const allowed =
		position !== undefined &&
		(plot === "bar" ? BAR_LABELS.has(position) : pieLike ? PIE_LABELS.has(position) : LINE_LABELS.has(position))

	return (
		"<c:dLbls>" +
		(allowed ? `<c:dLblPos val="${position}"/>` : "") +
		'<c:showLegendKey val="0"/>' +
		`<c:showVal val="${value ? 1 : 0}"/><c:showCatName val="${category ? 1 : 0}"/><c:showSerName val="${series ? 1 : 0}"/>` +
		`<c:showPercent val="${percent && pieLike ? 1 : 0}"/><c:showBubbleSize val="0"/></c:dLbls>`
	)
}

export function richText(text: string): string {
	const paragraphs = text
		.split("\n")
		.map(line => `<a:p><a:r><a:t>${escapeText(line)}</a:t></a:r></a:p>`)
		.join("")

	return `<c:tx><c:rich><a:bodyPr/><a:lstStyle/>${paragraphs}</c:rich></c:tx>`
}

function title(element: OdfElement | undefined): string {
	if (element === undefined) return ""

	return `<c:title>${richText(elementText(element))}<c:overlay val="0"/></c:title>`
}

// A chart's own data (table:table "local-table", §11.1): header row, rows, whether a first column labels them.
interface LocalTable {
	readonly header: readonly string[]
	readonly rows: readonly (readonly { readonly text: string; readonly number: number | null }[])[]
	readonly labelColumn: boolean
}

function localTable(chart: OdfElement): LocalTable | null {
	const table = child(chart, "table:table")

	if (table === undefined) return null

	const rowsOf = (container: OdfElement | undefined): { text: string; number: number | null }[][] =>
		children(container, "table:table-row").map(row =>
			children(row, "table:table-cell").map(cell => {
				const value = cell.attributes.get("office:value")

				return { text: elementText(cell), number: value === undefined || !Number.isFinite(Number(value)) ? null : Number(value) }
			})
		)
	const header = rowsOf(child(table, "table:table-header-rows"))[0]?.map(cell => cell.text) ?? []
	const rows = rowsOf(child(table, "table:table-rows"))

	return { header, rows, labelColumn: child(table, "table:table-header-columns") !== undefined }
}

function literal(values: readonly (string | number | null)[], numeric: boolean): string {
	const points = values
		.map((value, index) => (value === null ? "" : `<c:pt idx="${index}"><c:v>${escapeText(String(value))}</c:v></c:pt>`))
		.join("")

	return numeric
		? `<c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${points}</c:numLit>`
		: `<c:strLit><c:ptCount val="${values.length}"/>${points}</c:strLit>`
}

// chart:legend-position (§19.11) as c:legendPos (§21.2.3.24).
export const LEGENDS: ReadonlyMap<string, string> = new Map([
	["start", "l"],
	["end", "r"],
	["top", "t"],
	["bottom", "b"],
	["top-end", "tr"]
])
// The inverses, for the writers: c:dLblPos as chart:label-position, c:legendPos as chart:legend-position.
export const ODF_LABEL_POSITIONS: ReadonlyMap<string, string> = new Map([...LABEL_POSITIONS].map(([odf, drawing]) => [drawing, odf]))
export const ODF_LEGENDS: ReadonlyMap<string, string> = new Map([...LEGENDS].map(([odf, drawing]) => [drawing, odf]))

// A chart's or series' data labels as the chart properties saying them (none shown for null labels).
export function labelProperties(labels: ChartLabels | null): [string, string | undefined][] {
	const value = labels?.value === true
	const percent = labels?.percent === true
	const position = labels?.position ?? null

	return [
		["chart:data-label-number", value && percent ? "value-and-percentage" : value ? "value" : percent ? "percentage" : "none"],
		["chart:data-label-text", labels?.category === true ? "true" : "false"],
		["chart:data-label-series", labels?.series === true ? "true" : "false"],
		["chart:label-position", position === null ? undefined : ODF_LABEL_POSITIONS.get(position)]
	]
}
// chart:treat-empty-cells (§20.83) as c:dispBlanksAs (§21.2.3.5).
const BLANKS: ReadonlyMap<string, string> = new Map([
	["leave-gap", "gap"],
	["use-zero", "zero"],
	["ignore", "span"]
])

function percentage(value: string | undefined, fallback: number, low: number, high: number): number {
	const number = Number(value ?? String(fallback))

	return Number.isFinite(number) ? Math.max(low, Math.min(high, Math.round(number))) : fallback
}

// c:marker of a line or scatter series (§21.2.2.106): none when chart:symbol-type says so (§20.57).
function markerOf(chart: ReadonlyMap<string, string>, graphic: ReadonlyMap<string, string>): string {
	if ((chart.get("chart:symbol-type") ?? "automatic") === "none") return '<c:marker><c:symbol val="none"/></c:marker>'

	const fill = rgb(graphic.get("draw:fill-color")) ?? rgb(graphic.get("svg:stroke-color"))

	return fill === undefined ? "" : `<c:marker><c:symbol val="square"/><c:size val="5"/><c:spPr>${solidFill(fill)}</c:spPr></c:marker>`
}

// c:dPt for points with a style of their own (chart:data-point, §11.10): a pie's slices, a bar's own colour.
function dataPoints(series: OdfElement, styles: ChartStyles, pieLike: boolean, line: boolean): string {
	let index = 0
	let out = ""

	for (const point of children(series, "chart:data-point")) {
		const repeat = Math.max(1, Math.min(1 << 20, Number(point.attributes.get("chart:repeated") ?? "1") || 1))
		const name = point.attributes.get("chart:style-name")
		const graphic = name === undefined ? undefined : styles.graphic.get(name)

		if (graphic !== undefined && !line) {
			const properties = shapeProperties(graphic, false)

			for (let k = 0; k < repeat && properties !== "" && index + k < MAX_POINT_STYLES; k++)
				out += `<c:dPt><c:idx val="${index + k}"/>${pieLike ? "" : '<c:invertIfNegative val="0"/>'}<c:bubble3D val="0"/>${properties}</c:dPt>`
		}

		index += repeat
	}

	return out
}

function axisProperties(axis: OdfElement | undefined, styles: ChartStyles): ReadonlyMap<string, string> {
	const name = axis?.attributes.get("chart:style-name")

	return name === undefined ? NONE : (styles.chart.get(name) ?? NONE)
}

function axisCommon(
	axis: OdfElement | undefined,
	props: ReadonlyMap<string, string>
): { deleted: string; title: string; grid: string; labels: string } {
	const visible = axis !== undefined && props.get("chart:visible") !== "false"
	const grids = children(axis, "chart:grid")

	return {
		deleted: `<c:delete val="${visible ? 0 : 1}"/>`,
		title: title(child(axis, "chart:title")),
		grid:
			(grids.some(grid => (grid.attributes.get("chart:class") ?? "major") === "major") ? "<c:majorGridlines/>" : "") +
			(grids.some(grid => grid.attributes.get("chart:class") === "minor") ? "<c:minorGridlines/>" : ""),
		labels: `<c:tickLblPos val="${props.get("chart:display-label") === "false" ? "none" : "nextTo"}"/>`
	}
}

// c:scaling (§21.2.2.164) from chart:logarithmic, chart:reverse-direction, chart:maximum, chart:minimum (§20.21-§20.24).
function scaling(props: ReadonlyMap<string, string>, value: boolean): string {
	const number = (name: string): string | undefined => {
		const text = props.get(name)

		return text !== undefined && text.trim() !== "" && Number.isFinite(Number(text)) ? String(Number(text)) : undefined
	}
	let out = "<c:scaling>"

	if (value && props.get("chart:logarithmic") === "true") out += '<c:logBase val="10"/>'

	out += `<c:orientation val="${props.get("chart:reverse-direction") === "true" ? "maxMin" : "minMax"}"/>`

	if (value) {
		const max = number("chart:maximum")
		const min = number("chart:minimum")

		if (max !== undefined) out += `<c:max val="${max}"/>`
		if (min !== undefined) out += `<c:min val="${min}"/>`
	}

	return `${out}</c:scaling>`
}

function categoryAxis(id: number, cross: number, position: string, axis: OdfElement | undefined, styles: ChartStyles): string {
	const props = axisProperties(axis, styles)
	const common = axisCommon(axis, props)

	return (
		`<c:catAx><c:axId val="${id}"/>${scaling(props, false)}${common.deleted}<c:axPos val="${position}"/>${common.grid}${common.title}` +
		`<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>${common.labels}` +
		`<c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
	)
}

function valueAxis(id: number, cross: number, position: string, axis: OdfElement | undefined, styles: ChartStyles): string {
	const props = axisProperties(axis, styles)
	const common = axisCommon(axis, props)
	const major = Number(props.get("chart:interval-major"))
	const divisor = Number(props.get("chart:interval-minor-divisor"))
	const majorUnit = Number.isFinite(major) && major > 0 ? major : null
	const minorUnit = majorUnit !== null && Number.isFinite(divisor) && divisor > 0 ? majorUnit / divisor : null

	return (
		`<c:valAx><c:axId val="${id}"/>${scaling(props, true)}${common.deleted}<c:axPos val="${position}"/>${common.grid}${common.title}` +
		`<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>${common.labels}` +
		`<c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/>` +
		(majorUnit === null ? "" : `<c:majorUnit val="${majorUnit}"/>`) +
		(minorUnit === null ? "" : `<c:minorUnit val="${minorUnit}"/>`) +
		"</c:valAx>"
	)
}

function chartSpace(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}"><c:date1904 val="0"/><c:roundedCorners val="0"/><c:chart>${body}</c:chart></c:chartSpace>`
}

// A chart:chart as a c:chartSpace (§21.2.2.29), with why it cannot be written back.
export function translateChart(chart: OdfElement, styles: ChartStyles): Translated {
	const issues: string[] = []
	let refusal: string | null = null
	const refuse = (why: string): void => {
		refusal ??= why
	}
	const styleOf = (element: OdfElement | undefined, map: Map<string, ReadonlyMap<string, string>>): ReadonlyMap<string, string> => {
		const name = element?.attributes.get("chart:style-name")

		return name === undefined ? NONE : (map.get(name) ?? NONE)
	}
	const chartClass = chart.attributes.get("chart:class") ?? "chart:bar"
	const plotArea = child(chart, "chart:plot-area")
	const plotProps = styleOf(plotArea, styles.chart)
	const basePlot = CLASSES.get(chartClass)

	if (basePlot === undefined) {
		issues.push(`chart class ${chartClass}`)

		return {
			markup: chartSpace('<c:autoTitleDeleted val="1"/><c:plotArea><c:layout/></c:plotArea>'),
			refusal: `chart class ${chartClass}`,
			issues
		}
	}

	if (child(chart, "chart:subtitle") !== undefined) {
		issues.push("subtitle")
		refuse("subtitle")
	}

	const vertical = plotProps.get("chart:vertical") === "true"
	const stacked = plotProps.get("chart:stacked") === "true"
	const percent = plotProps.get("chart:percentage") === "true"

	if (plotProps.get("chart:three-dimensional") === "true") {
		issues.push("three-dimensional")
		refuse("three-dimensional")
	}

	const axes = children(plotArea, "chart:axis")
	const xAxis = axes.find(axis => axis.attributes.get("chart:dimension") === "x" && axis.attributes.get("chart:name") !== "secondary-x")
	const yAxis = axes.find(axis => axis.attributes.get("chart:dimension") === "y" && axis.attributes.get("chart:name") !== "secondary-y")
	const local = localTable(chart)
	const categoriesAddress = child(xAxis, "chart:categories")?.attributes.get("table:cell-range-address")
	const categories = chartReference(categoriesAddress)

	if (categoriesAddress !== undefined && categories === null) {
		issues.push(`categories ${categoriesAddress}`)
		refuse("categories")
	}

	if (axes.some(axis => axis.attributes.get("chart:name")?.startsWith("secondary") === true)) refuse("secondary axis")

	const series: Series[] = children(plotArea, "chart:series").map(element => {
		const own = CLASSES.get(element.attributes.get("chart:class") ?? chartClass)

		if (own === undefined) {
			issues.push(`series class ${element.attributes.get("chart:class") ?? ""}`)
			refuse("series class")
		}

		if (element.attributes.get("chart:attached-axis") === "secondary-y") refuse("secondary axis")
		if (children(element, "chart:regression-curve").length > 0) {
			issues.push("trend line")
			refuse("trend line")
		}

		return { element, plot: own ?? basePlot }
	})
	// Plots in the order their first series comes, each with its series.
	const plots: { plot: Plot; series: Series[] }[] = []

	for (const entry of series) {
		const plot = plots.find(candidate => candidate.plot === entry.plot)

		if (plot === undefined) plots.push({ plot: entry.plot, series: [entry] })
		else plot.series.push(entry)
	}

	if (plots.length === 0) plots.push({ plot: basePlot, series: [] })
	if (plots.length > 1) refuse("combined plots")

	const grouping = (plot: Plot): string => (stacked ? "stacked" : percent ? "percentStacked" : plot === "bar" ? "clustered" : "standard")
	let seriesIndex = 0
	const plotMarkup = plots.map(({ plot, series: list }) => {
		const scatter = plot === "scatter"
		const pieLike = plot === "pie" || plot === "doughnut"
		const line = plot === "line" || plot === "scatter" || plot === "radar"
		const seriesMarkup = list
			.map(({ element }) => {
				const index = seriesIndex++
				const chartProps = styleOf(element, styles.chart)
				const graphic = styleOf(element, styles.graphic)
				const valuesAddress = element.attributes.get("chart:values-cell-range-address")
				const labelAddress = element.attributes.get("chart:label-cell-address")
				const values = chartReference(valuesAddress)
				const name = chartReference(labelAddress)
				const column = local === null ? -1 : (local.labelColumn ? 1 : 0) + index

				if (valuesAddress !== undefined && values === null) issues.push(`values ${valuesAddress}`)
				if (values === null) refuse("values without cells")
				if (labelAddress !== undefined && name === null) refuse("series name")

				const domain = children(element, "chart:domain")[0]?.attributes.get("table:cell-range-address")
				const domainRef = scatter && domain !== undefined ? chartReference(domain) : null
				const header = local?.header[column]
				const tx =
					name !== null
						? `<c:tx><c:strRef><c:f>${escapeText(name)}</c:f></c:strRef></c:tx>`
						: header !== undefined && header !== ""
							? `<c:tx><c:v>${escapeText(header)}</c:v></c:tx>`
							: ""
				const valueSource =
					values !== null
						? `<c:numRef><c:f>${escapeText(values)}</c:f></c:numRef>`
						: literal(local === null ? [] : local.rows.map(row => row[column]?.number ?? null), true)
				const categorySource = (scatter ? domainRef : null) ?? categories
				const localCategories = local === null || !local.labelColumn ? null : local.rows.map(row => row[0]?.text ?? "")
				const cat =
					categorySource !== null
						? scatter
							? `<c:numRef><c:f>${escapeText(categorySource)}</c:f></c:numRef>`
							: `<c:strRef><c:f>${escapeText(categorySource)}</c:f></c:strRef>`
						: localCategories !== null && categoriesAddress === undefined && values === null
							? literal(localCategories, false)
							: ""
				let out = `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>${tx}${shapeProperties(graphic, line)}`

				if (plot === "bar") out += '<c:invertIfNegative val="0"/>'
				if (plot === "line" || scatter) out += markerOf(chartProps, graphic)
				if (plot === "radar") out += '<c:marker><c:symbol val="none"/></c:marker>'

				out += dataPoints(element, styles, pieLike, line) + dataLabels(chartProps, plot)
				out += scatter
					? `${cat === "" ? "" : `<c:xVal>${cat}</c:xVal>`}<c:yVal>${valueSource}</c:yVal><c:smooth val="0"/>`
					: `${cat === "" ? "" : `<c:cat>${cat}</c:cat>`}<c:val>${valueSource}</c:val>`

				if (plot === "line") out += '<c:smooth val="0"/>'

				return `${out}</c:ser>`
			})
			.join("")
		const axisIds = pieLike ? "" : '<c:axId val="1"/><c:axId val="2"/>'

		switch (plot) {
			case "bar": {
				const overlap = stacked || percent ? 100 : percentage(plotProps.get("chart:overlap"), 0, -100, 100)

				return `<c:barChart><c:barDir val="${vertical ? "bar" : "col"}"/><c:grouping val="${grouping(plot)}"/><c:varyColors val="0"/>${seriesMarkup}<c:gapWidth val="${percentage(plotProps.get("chart:gap-width"), 100, 0, 500)}"/>${overlap === 0 ? "" : `<c:overlap val="${overlap}"/>`}${axisIds}</c:barChart>`
			}
			case "line":
				return `<c:lineChart><c:grouping val="${grouping(plot)}"/><c:varyColors val="0"/>${seriesMarkup}<c:marker val="1"/>${axisIds}</c:lineChart>`
			case "area":
				return `<c:areaChart><c:grouping val="${grouping(plot)}"/><c:varyColors val="0"/>${seriesMarkup}${axisIds}</c:areaChart>`
			case "pie":
			case "doughnut": {
				// chart:angle-offset counts counter-clockwise from 3 o'clock (§20.11), c:firstSliceAng clockwise from 12.
				const offset = Number(plotProps.get("chart:angle-offset") ?? "90")
				const first = ((((90 - (Number.isFinite(offset) ? offset : 90)) % 360) + 360) % 360).toFixed(0)

				return plot === "pie"
					? `<c:pieChart><c:varyColors val="1"/>${seriesMarkup}<c:firstSliceAng val="${first}"/></c:pieChart>`
					: `<c:doughnutChart><c:varyColors val="1"/>${seriesMarkup}<c:firstSliceAng val="${first}"/><c:holeSize val="50"/></c:doughnutChart>`
			}
			case "scatter":
				return `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${seriesMarkup}${axisIds}</c:scatterChart>`
			case "radar":
			case "filledRadar":
				return `<c:radarChart><c:radarStyle val="${plot === "filledRadar" ? "filled" : "marker"}"/><c:varyColors val="0"/>${seriesMarkup}${axisIds}</c:radarChart>`
		}
	})
	const first = plots[0]?.plot ?? basePlot
	const pie = first === "pie" || first === "doughnut"
	const xPosition = vertical ? "l" : "b"
	const yPosition = vertical ? "b" : "l"
	const axisMarkup = pie
		? ""
		: (first === "scatter" ? valueAxis(1, 2, xPosition, xAxis, styles) : categoryAxis(1, 2, xPosition, xAxis, styles)) +
			valueAxis(2, 1, yPosition, yAxis, styles)
	const titleElement = child(chart, "chart:title")
	const legend = child(chart, "chart:legend")
	const legendAt = legend?.attributes.get("chart:legend-position") ?? "end"

	if (legend !== undefined && !LEGENDS.has(legendAt)) {
		issues.push(`legend position ${legendAt}`)
		refuse("legend position")
	}

	const body =
		(titleElement === undefined ? '<c:autoTitleDeleted val="1"/>' : `${title(titleElement)}<c:autoTitleDeleted val="0"/>`) +
		`<c:plotArea><c:layout/>${plotMarkup.join("")}${axisMarkup}</c:plotArea>` +
		(legend === undefined ? "" : `<c:legend><c:legendPos val="${LEGENDS.get(legendAt) ?? "r"}"/><c:overlay val="0"/></c:legend>`) +
		`<c:plotVisOnly val="${plotProps.get("chart:include-hidden-cells") === "true" ? 0 : 1}"/><c:dispBlanksAs val="${BLANKS.get(plotProps.get("chart:treat-empty-cells") ?? "") ?? "gap"}"/>`

	return { markup: chartSpace(body), refusal, issues }
}

// --- Objects and frames ---

// The chart:chart of an object's content.xml, with its styles; null when the object is no chart.
export function chartOf(document: XmlDocument): { chart: OdfElement; styles: ChartStyles } | null {
	const namespaces = new Namespaces(document, { lenient: true })
	const root = document.documentElement()

	if (root < 0 || elementName(document, namespaces, root) !== "office:document-content") return null

	const tree = readElement(document, namespaces, root)
	const chart = child(child(child(tree, "office:body"), "office:chart"), "chart:chart")

	return chart === undefined ? null : { chart, styles: readStyles(tree) }
}

// The object a frame embeds (draw:object xlink:href "./Object 1"), as a package path without "./" or "/".
export function objectPath(frame: OdfElement): string | undefined {
	const href = child(frame, "draw:object")?.attributes.get("xlink:href")

	if (href === undefined || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined

	return href.replace(/^\.\//, "").replace(/\/$/, "")
}

function emu(length: string | undefined): number | null {
	const points = parseLength(length)

	return points === undefined || !Number.isFinite(points) ? null : Math.max(0, Math.round(points * EMU_PER_PT))
}

// table:end-cell-address ("Sheet1.D10", §19.638) as a row and column.
function endCell(address: string | undefined): { row: number; col: number } | null {
	if (address === undefined) return null

	const match = /\.\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(address)

	if (match === null) return null

	return { row: Number(match[2]) - 1, col: columnIndex(match[1] ?? "") }
}

// The xdr anchor's open tag and placement of a frame (§20.5.2.2 absoluteAnchor, .24 oneCellAnchor, .33
// twoCellAnchor), and its close tag; null without a size.
export function anchorOf(frame: OdfElement, place: OdsChartPlace): { open: string; close: string } | null {
	const x = emu(frame.attributes.get("svg:x") ?? "0")
	const y = emu(frame.attributes.get("svg:y") ?? "0")
	const cx = emu(frame.attributes.get("svg:width"))
	const cy = emu(frame.attributes.get("svg:height"))

	if (x === null || y === null || cx === null || cy === null) return null

	const marker = (name: string, row: number, col: number, rowOff: number, colOff: number): string =>
		`<xdr:${name}><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:${name}>`

	if (place.kind === "page")
		return { open: `<xdr:absoluteAnchor><xdr:pos x="${x}" y="${y}"/><xdr:ext cx="${cx}" cy="${cy}"/>`, close: "</xdr:absoluteAnchor>" }

	const end = endCell(frame.attributes.get("table:end-cell-address"))
	const endX = emu(frame.attributes.get("table:end-x") ?? "0")
	const endY = emu(frame.attributes.get("table:end-y") ?? "0")

	if (end !== null && endX !== null && endY !== null)
		return {
			open: `<xdr:twoCellAnchor>${marker("from", place.row, place.col, y, x)}${marker("to", end.row, end.col, endY, endX)}`,
			close: "</xdr:twoCellAnchor>"
		}

	return {
		open: `<xdr:oneCellAnchor>${marker("from", place.row, place.col, y, x)}<xdr:ext cx="${cx}" cy="${cy}"/>`,
		close: "</xdr:oneCellAnchor>"
	}
}

function graphicFrame(id: number, name: string, relationship: string): string {
	return (
		`<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${escapeAttribute(name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
		'<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
		`<a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="${relationship}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/>`
	)
}

// The frames of a table: the page's (children of table:shapes) and the cells'.
export function framesOf(table: OdsChartTable, prefixes: ReadonlyMap<string, string>): { frame: OdfElement; place: OdsChartPlace }[] {
	const out: { frame: OdfElement; place: OdsChartPlace }[] = []

	if (table.shapes !== undefined) {
		const captured = parseCaptured(table.shapes, prefixes)
		const shapes = readElement(captured.document, captured.namespaces, captured.node)

		shapes.children.forEach((element, k) => {
			if (element.name === "draw:frame") out.push({ frame: element, place: { kind: "page", frame: k } })
		})
	}

	const perCell = new Map<string, number>()

	for (const cell of table.frames) {
		const key = `${cell.row},${cell.col}`
		const index = perCell.get(key) ?? 0
		const captured = parseCaptured(cell.markup, prefixes)

		perCell.set(key, index + 1)
		out.push({
			frame: readElement(captured.document, captured.namespaces, captured.node),
			place: { kind: "cell", row: cell.row, col: cell.col, frame: index }
		})
	}

	return out
}

function relationshipsPart(relationships: readonly { id: string; type: string; target: string }[]): Uint8Array {
	return encoder.encode(
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">${relationships
			.map(
				relationship =>
					`<Relationship Id="${relationship.id}" Type="${relationship.type}" Target="${escapeAttribute(relationship.target)}"/>`
			)
			.join("")}</Relationships>`
	)
}

// The chart:chart of a package's object, with its styles; null when it is none or does not read.
export async function objectChart(
	odf: OdfPackage,
	path: string
): Promise<{ chart: OdfElement; styles: ChartStyles; content: Uint8Array } | null> {
	const entry = odf.archive.get(`${path}/content.xml`)

	if (entry === undefined || entry.uncompressedSize > MAX_OBJECT_BYTES) return null

	const content = await odf.archive.read(entry)
	const found = chartOf(parseXml(content))

	return found === null ? null : { ...found, content }
}

// An object as read: its chart and translation (null when it holds none), or why it was not read.
type ObjectOutcome =
	| { readonly kind: "chart"; readonly content: Uint8Array; readonly translated: Translated; readonly markup: Uint8Array }
	| { readonly kind: "none" }
	| { readonly kind: "unread" }
	| { readonly kind: "overBudget" }

export async function readOdsCharts(input: OdsChartInput): Promise<OdsChartParts> {
	const parts = new Map<string, Uint8Array>()
	const overrides: string[] = []
	const sheets = new Map<number, OdsSheetCharts>()
	const charts: OdsChartSource[] = []
	// Each object read, parsed and translated once: frames naming one share it.
	const objects = new Map<string, ObjectOutcome>()
	let bytes = 0
	let count = 0

	const objectOutcome = async (path: string, size: number): Promise<ObjectOutcome> => {
		if (input.signal?.aborted === true) throw new OdsReadError("aborted", "Opening was aborted")
		if (input.clock?.due === true) await input.clock.pause()

		// Past MAX_OBJECT_BYTES objectChart reads nothing: nothing charged.
		if (size <= MAX_OBJECT_BYTES) {
			if (bytes + size > MAX_CHART_BYTES) return { kind: "overBudget" }

			bytes += size
		}

		let found: Awaited<ReturnType<typeof objectChart>>

		try {
			found = await objectChart(input.odf, path)
		} catch {
			return { kind: "unread" }
		}

		if (found === null) return { kind: "none" }

		const translated = translateChart(found.chart, found.styles)

		return { kind: "chart", content: found.content, translated, markup: encoder.encode(translated.markup) }
	}

	for (const table of input.tables) {
		if (table.shapes === undefined && table.frames.length === 0) continue

		let frames: { frame: OdfElement; place: OdsChartPlace }[]

		try {
			frames = framesOf(table, input.prefixes)
		} catch {
			input.issues.add("drawing", table.name, "chart frames")

			continue
		}

		const drawing = `xl/drawings/drawing${table.index + 1}.xml`
		const anchors: string[] = []
		const relationships: { id: string; type: string; target: string }[] = []

		for (const { frame, place } of frames) {
			const path = objectPath(frame)
			const entry = path === undefined ? undefined : input.odf.archive.get(`${path}/content.xml`)

			if (path === undefined || entry === undefined) continue

			if (count >= MAX_CHARTS) {
				input.issues.add("drawing", table.name, "charts past the limit")

				continue
			}

			let found = objects.get(path)

			if (found === undefined) {
				found = await objectOutcome(path, entry.uncompressedSize)

				objects.set(path, found)
			}

			if (found.kind === "overBudget") {
				input.issues.add("drawing", table.name, "charts past the limit")

				continue
			}

			if (found.kind === "unread") {
				input.issues.add("drawing", table.name, `chart ${path} does not read`)

				continue
			}

			if (found.kind === "none") continue

			const anchor = anchorOf(frame, place)

			if (anchor === null) {
				input.issues.add("drawing", table.name, `chart ${path} without a size`)

				continue
			}

			count++

			const translated = found.translated
			const part = `xl/charts/chart${count}.xml`
			const id = `rId${relationships.length + 1}`

			for (const issue of translated.issues) input.issues.add("drawing", table.name, `chart: ${issue}`)

			parts.set(part, found.markup)
			overrides.push(`<Override PartName="/${part}" ContentType="${CHART_CONTENT}"/>`)
			relationships.push({ id, type: CHART_RELATIONSHIP, target: `../charts/chart${count}.xml` })
			anchors.push(
				`${anchor.open}${graphicFrame(anchors.length + 2, frame.attributes.get("draw:name") ?? `Chart ${count}`, id)}${anchor.close}`
			)
			charts.push({
				part,
				object: path,
				table: table.index,
				place,
				drawing,
				anchor: anchors.length - 1,
				relationship: id,
				shapes: table.shapes,
				content: found.content,
				refusal: translated.refusal
			})
		}

		if (anchors.length === 0) continue

		parts.set(
			drawing,
			encoder.encode(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}">${anchors.join("")}</xdr:wsDr>`
			)
		)
		parts.set(`xl/drawings/_rels/drawing${table.index + 1}.xml.rels`, relationshipsPart(relationships))
		overrides.push(`<Override PartName="/${drawing}" ContentType="${DRAWING_CONTENT}"/>`)
		sheets.set(table.index, {
			relationships: [{ type: DRAWING_RELATIONSHIP, target: `../drawings/drawing${table.index + 1}.xml` }],
			sections: ids => [
				{
					name: "drawing",
					start: 0,
					end: 0,
					bytes: encoder.encode(`<drawing xmlns="${MAIN}" xmlns:r="${R}" r:id="${ids[0] ?? "rId1"}"/>`)
				}
			]
		})
	}

	return { parts, overrides, sheets, charts }
}

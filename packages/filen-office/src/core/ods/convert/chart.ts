import { seriesColor } from "../../drawingml/chart/palette"
import { readColorIn, type DrawingTheme } from "../../drawingml/color"
import { rgbaHex } from "../../drawingml/displayList"
import { D, drawingReader, type DrawingReader } from "../../drawingml/reader"
import { chartRoot, plotNodes, readChartInfo, type ChartAxisInfo, type ChartLabels } from "../../xlsx/charts/model"
import { escapeAttribute, escapeText, type XmlDocument } from "../../xml/index"
import { ChartRefused, odfAddress } from "../charts/write"
import { dataStyles } from "../write/dataStyle"

// A chart part (ECMA-376 Part 1 §21.2) as an OpenDocument chart object (ODF 1.3 Part 3 §11 charts, §17.22
// style:chart-properties): its plots' series by their cells, categories, axes with their scaling and titles, the title,
// the legend, data labels and each series' colour (its own, else the chart style's palette, as Excel draws it). What
// the object does not hold is lost: trendlines, error bars, data tables, up-down bars, drop and high-low lines, axis
// number formats no data style can say, gradients (their first colour kept), patterns and pictures as fills, a series
// valued by literals, a category axis of a second plot. A series' own name is LibreOffice's loext:label-string.
// Stock, surface and bubble charts have no object here.

const OFFICE =
	'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
	'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
	'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
	'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
	'xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" xmlns:dr3d="urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0" ' +
	'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"'

const CLASSES: Readonly<Record<string, string>> = {
	column: "chart:bar",
	bar: "chart:bar",
	line: "chart:line",
	area: "chart:area",
	pie: "chart:circle",
	doughnut: "chart:ring",
	scatter: "chart:scatter",
	radar: "chart:radar"
}

const LEGENDS: Readonly<Record<string, string>> = { r: "end", l: "start", t: "top", b: "bottom", tr: "top-end" }

// c:dLblPos (§21.2.3.11) as chart:label-position (§20.71).
const POSITIONS: Readonly<Record<string, string>> = {
	bestFit: "avoid-overlap",
	ctr: "center",
	t: "top",
	b: "bottom",
	l: "left",
	r: "right",
	inEnd: "inside",
	outEnd: "outside",
	inBase: "near-origin"
}

// What a chart part holds that its object does not (by element, anywhere in the chart).
const UNHELD = ["trendline", "errBars", "dTable", "upDownBars", "dropLines", "hiLowLines", "serLines"]

export interface ChartObject {
	// The object's content.xml.
	readonly content: string
	// The cells it reads (draw:notify-on-update-of-ranges).
	readonly ranges: string
	readonly lost: boolean
}

function number(value: number): string {
	return String(Math.round(value * 1e9) / 1e9)
}

function attributes(pairs: readonly (readonly [string, string | undefined])[]): string {
	return pairs.map(([name, value]) => (value === undefined ? "" : ` ${name}="${escapeAttribute(value)}"`)).join("")
}

// A title's text: one paragraph (chart:title holds one, ODF 1.3 Part 3 §11.2.4), its lines apart by line breaks.
function paragraphs(text: string): string {
	return `<text:p>${text.replace(/\n+$/, "").split("\n").map(escapeText).join("<text:line-break/>")}</text:p>`
}

class ObjectStyles {
	private readonly names = new Map<string, string>()
	readonly markup: string[] = []

	// A chart style of chart and graphic properties (the same ones once).
	style(
		chart: readonly (readonly [string, string | undefined])[],
		graphic: readonly (readonly [string, string | undefined])[] = [],
		dataStyle?: string
	): string {
		const own = `<style:chart-properties${attributes(chart)}/>${graphic.length === 0 ? "" : `<style:graphic-properties${attributes(graphic)}/>`}`
		const key = `${dataStyle ?? ""}\u0000${own}`
		let name = this.names.get(key)

		if (name === undefined) {
			name = `ch${String(this.names.size + 1)}`
			this.names.set(key, name)
			this.markup.push(
				`<style:style style:name="${name}" style:family="chart"${attributes([["style:data-style-name", dataStyle]])}>${own}</style:style>`
			)
		}

		return name
	}
}

// Labels shown on nothing (a point's own c:dLbl deleting its label).
const NO_LABELS: ChartLabels = { value: false, category: false, series: false, percent: false, position: null }

// The data labels a series' points state themselves (c:dLbls/c:dLbl, §21.2.2.47) by point index, null for a point
// whose label is deleted (c:delete); a point whose c:dLbl only places or styles its label states what the series'
// labels show.
function ownLabels(reader: DrawingReader, series: number): Map<number, ChartLabels | null> {
	const out = new Map<number, ChartLabels | null>()
	const dLbls = reader.child(series, D.C, "dLbls")

	for (const dLbl of reader.children(dLbls, D.C, "dLbl")) {
		const idx = reader.number(reader.child(dLbl, D.C, "idx"), "val", -1)

		if (idx < 0 || idx >= 1024) continue

		const shown = (local: string): boolean => {
			const child = reader.child(dLbl, D.C, local)

			return child >= 0 ? reader.bool(child, "val", true) : reader.bool(reader.child(dLbls, D.C, local), "val", false)
		}
		const position = reader.attr(reader.child(dLbl, D.C, "dLblPos"), "val") ?? reader.attr(reader.child(dLbls, D.C, "dLblPos"), "val")

		out.set(
			idx,
			reader.bool(reader.child(dLbl, D.C, "delete"), "val", reader.child(dLbl, D.C, "delete") >= 0)
				? null
				: {
						value: shown("showVal"),
						category: shown("showCatName"),
						series: shown("showSerName"),
						percent: shown("showPercent"),
						position: position === undefined ? null : (position as ChartLabels["position"])
					}
		)
	}

	return out
}

function labelProperties(labels: ChartLabels | null): [string, string | undefined][] {
	if (labels === null) return []

	const value = labels.value
	const percent = labels.percent

	return [
		["chart:data-label-number", value && percent ? "value-and-percentage" : value ? "value" : percent ? "percentage" : "none"],
		["chart:data-label-text", String(labels.category)],
		["chart:data-label-series", String(labels.series)],
		["chart:label-position", labels.position === null ? undefined : POSITIONS[labels.position]]
	]
}

// A solid colour of a container (a:solidFill), as #rrggbb; "none" for a:noFill; a gradient's first stop's colour
// (the gradient itself lost); "other" for a pattern or a picture; undefined for none given.
function solid(reader: DrawingReader, owner: number, theme: DrawingTheme, lose: () => void): string | "none" | "other" | undefined {
	if (owner < 0) return undefined
	if (reader.child(owner, D.A, "noFill") >= 0) return "none"

	const gradient = reader.child(owner, D.A, "gradFill")
	const fill = gradient >= 0 ? reader.child(reader.child(gradient, D.A, "gsLst"), D.A, "gs") : reader.child(owner, D.A, "solidFill")

	if (gradient >= 0) lose()

	if (fill >= 0) {
		const color = readColorIn(reader, fill, theme)

		return color === undefined ? "other" : `#${rgbaHex(color).slice(0, 6).toLowerCase()}`
	}

	return gradient >= 0 || reader.child(owner, D.A, "pattFill") >= 0 || reader.child(owner, D.A, "blipFill") >= 0 ? "other" : undefined
}

export function chartObject(document: XmlDocument, theme: DrawingTheme, sheet: string, width: string, height: string): ChartObject | null {
	const info = readChartInfo(document)

	if (info === null) return null

	const plots = info.plots.filter(plot => CLASSES[plot.type] !== undefined)
	const first = plots[0]

	if (first === undefined || plots.length !== info.plots.length) return null

	const reader = drawingReader(document)
	const { space, chart, plotArea } = chartRoot(reader)
	const styleNumber = reader.number(reader.child(space, D.C, "style"), "val", 2)
	const styles = new ObjectStyles()
	const nodes = plotNodes(reader, plotArea)
	const seriesNodes = nodes.flatMap(node => reader.children(node, D.C, "ser"))
	const total = seriesNodes.length
	const ranges: string[] = []
	let lost = UNHELD.some(local => reader.descendant(space, D.C, local) >= 0)
	const lose = (): void => {
		lost = true
	}
	const numberStyles: string[] = []
	const address = (ref: string): string | null => {
		try {
			return odfAddress(ref, sheet)
		} catch (error) {
			if (!(error instanceof ChartRefused)) throw error

			lost = true

			return null
		}
	}
	const axisById = new Map(info.axes.map(axis => [axis.id, axis]))
	const xAxis = first.type === "pie" || first.type === "doughnut" ? undefined : axisById.get(first.axes[0] ?? -1)
	const yAxis = first.type === "pie" || first.type === "doughnut" ? undefined : axisById.get(first.axes[1] ?? -1)
	let secondary: ChartAxisInfo | undefined
	const series: string[] = []
	let categories: string | null = null

	plots.forEach((plot, plotIndex) => {
		const node = nodes[plot.index] ?? -1
		const chartClass = CLASSES[plot.type] ?? "chart:bar"
		const lines = plot.type === "line" || plot.type === "scatter" || plot.type === "radar"
		const filledRadar = plot.type === "radar" && reader.attr(reader.child(node, D.C, "radarStyle"), "val") === "filled"
		const varyNode = reader.child(node, D.C, "varyColors")
		const vary = varyNode < 0 ? plot.type === "pie" || plot.type === "doughnut" : reader.bool(varyNode, "val", true)
		const plotMarkers = reader.child(node, D.C, "marker")
		const plotSymbols = plotMarkers < 0 || reader.bool(plotMarkers, "val", true)
		let attached: string | undefined

		if (plotIndex > 0 && (plot.axes[1] ?? -1) !== (first.axes[1] ?? -1)) {
			const axis = axisById.get(plot.axes[1] ?? -1)

			if (axis !== undefined && secondary === undefined) secondary = axis
			if (axis !== undefined && axis.id === secondary?.id) attached = "secondary-y"
			else lost = true
		}

		for (const one of plot.series) {
			const xml = seriesNodes[one.index] ?? -1
			const spPr = reader.child(xml, D.C, "spPr")
			const ln = reader.child(spPr, D.A, "ln")
			const palette = `#${rgbaHex(seriesColor(theme, styleNumber, one.index, total))
				.slice(0, 6)
				.toLowerCase()}`
			const fill = solid(reader, spPr, theme, lose)
			const stroke = solid(reader, ln, theme, lose)
			const values = one.values === null ? null : address(one.values)

			if (fill === "other" || stroke === "other") lost = true
			if (values === null) {
				lost = true

				continue
			}

			ranges.push(values)

			const label = one.nameRef === null ? null : address(one.nameRef)

			if (label !== null) ranges.push(label)
			// A name of its own, as LibreOffice writes it (loext:label-string, a string literal).
			const literal = one.nameRef === null && one.name !== "" ? `"${one.name.replaceAll('"', '""')}"` : undefined

			const marker = reader.child(xml, D.C, "marker")
			const symbol = reader.attr(reader.child(marker, D.C, "symbol"), "val")
			const fillColor = fill === undefined || fill === "none" || fill === "other" ? palette : fill
			const strokeColor = stroke === undefined || stroke === "none" || stroke === "other" ? palette : stroke
			// A line's colour is its stroke; a shape's its fill, outlined only where the file says.
			const graphic: (readonly [string, string | undefined])[] = lines
				? [
						["draw:stroke", stroke === "none" ? "none" : "solid"],
						["svg:stroke-color", strokeColor],
						["draw:fill-color", fillColor]
					]
				: [
						["draw:fill", fill === "none" ? "none" : "solid"],
						["draw:fill-color", fillColor],
						["draw:stroke", stroke === undefined || stroke === "none" || stroke === "other" ? "none" : "solid"],
						["svg:stroke-color", stroke === undefined || stroke === "none" || stroke === "other" ? undefined : stroke]
					]
			const style = styles.style(
				[
					...(lines ? ([["chart:symbol-type", symbol === "none" || !plotSymbols ? "none" : "automatic"]] as const) : []),
					...labelProperties(one.labels ?? plot.labels)
				],
				graphic
			)
			let children = ""

			if (plot.type === "scatter" && one.categories !== null) {
				const domain = address(one.categories)

				if (domain !== null) {
					children += `<chart:domain table:cell-range-address="${escapeAttribute(domain)}"/>`
					ranges.push(domain)
				}
			} else if (plotIndex === 0 && categories === null && one.categories !== null) {
				categories = address(one.categories)

				if (categories !== null) ranges.push(categories)
			}

			// Points of their own: varied colours (each point its palette colour, or its own c:dPt, §21.2.2.52) and data
			// labels a point states itself (c:dLbl, §21.2.2.47), one chart:data-point each (§11.15), a run of points
			// with neither one chart:data-point repeated.
			const pointLabels = ownLabels(reader, xml)

			if ((vary && !lines) || pointLabels.size > 0) {
				const count = Math.max(pointCount(reader, xml), ...[...pointLabels.keys()].map(k => k + 1))
				const own = new Map<number, string>()

				if (vary && !lines)
					for (const point of reader.children(xml, D.C, "dPt")) {
						const color = solid(reader, reader.child(point, D.C, "spPr"), theme, lose)

						if (color !== undefined && color !== "other" && color !== "none")
							own.set(reader.number(reader.child(point, D.C, "idx"), "val", -1), color)
					}

				let plain = 0
				const flush = (): void => {
					if (plain > 0) children += `<chart:data-point${plain > 1 ? ` chart:repeated="${String(plain)}"` : ""}/>`

					plain = 0
				}

				for (let k = 0; k < count; k++) {
					const labels = pointLabels.get(k)
					const color =
						vary && !lines
							? (own.get(k) ??
								`#${rgbaHex(seriesColor(theme, styleNumber, k, count))
									.slice(0, 6)
									.toLowerCase()}`)
							: undefined

					if (labels === undefined && color === undefined) {
						plain++

						continue
					}

					flush()
					children += `<chart:data-point chart:style-name="${styles.style(
						labels === undefined ? [] : labelProperties(labels ?? NO_LABELS),
						color === undefined
							? []
							: [
									["draw:fill", "solid"],
									["draw:fill-color", color]
								]
					)}"/>`
				}

				flush()
			}

			series.push(
				`<chart:series${attributes([
					["chart:style-name", style],
					["chart:values-cell-range-address", values],
					["chart:label-cell-address", label ?? undefined],
					["loext:label-string", literal],
					["chart:class", filledRadar ? "chart:filled-radar" : chartClass],
					["chart:attached-axis", attached ?? (xAxis === undefined ? undefined : "primary-y")]
				])}>${children}</chart:series>`
			)
		}
	})

	if (series.length === 0) return null

	const axis = (axisInfo: ChartAxisInfo | undefined, dimension: "x" | "y", name: string, inner: string): string => {
		if (axisInfo === undefined) return ""

		// Its own number format as a data style of the object (§16.29), else the cells'.
		let dataStyle: string | undefined

		if (axisInfo.format !== null) {
			const written = dataStyles(axisInfo.format, `N${String(numberStyles.length + 1)}`)

			if ("refused" in written) lost = true
			else {
				dataStyle = written.styles[written.styles.length - 1]?.name
				numberStyles.push(...written.styles.map(one => one.markup))
			}
		}

		const style = styles.style(
			[
				["chart:display-label", String(axisInfo.visible)],
				["chart:link-data-style-to-source", dataStyle === undefined ? undefined : "false"],
				["chart:minimum", axisInfo.min === null ? undefined : number(axisInfo.min)],
				["chart:maximum", axisInfo.max === null ? undefined : number(axisInfo.max)],
				["chart:interval-major", axisInfo.major === null ? undefined : number(axisInfo.major)],
				[
					"chart:interval-minor-divisor",
					axisInfo.major !== null && axisInfo.minor !== null && axisInfo.minor > 0
						? String(Math.max(1, Math.round(axisInfo.major / axisInfo.minor)))
						: undefined
				],
				["chart:logarithmic", axisInfo.logBase === null ? undefined : "true"],
				["chart:reverse-direction", axisInfo.reversed ? "true" : undefined]
			],
			axisInfo.visible ? [] : [["draw:stroke", "none"]],
			dataStyle
		)
		const title = axisInfo.title === null || axisInfo.title === "" ? "" : `<chart:title>${paragraphs(axisInfo.title)}</chart:title>`
		const grid = axisInfo.majorGridlines ? '<chart:grid chart:class="major"/>' : ""

		return `<chart:axis chart:dimension="${dimension}" chart:name="${name}" chart:style-name="${style}">${title}${inner}${grid}</chart:axis>`
	}
	const categoriesMarkup = categories === null ? "" : `<chart:categories table:cell-range-address="${escapeAttribute(categories)}"/>`
	const bars = first.type === "column" || first.type === "bar"
	const gap = reader.number(reader.child(nodes[first.index] ?? -1, D.C, "gapWidth"), "val", 150)
	const overlap = reader.number(
		reader.child(nodes[first.index] ?? -1, D.C, "overlap"),
		"val",
		first.grouping === "stacked" || first.grouping === "percentStacked" ? 100 : 0
	)
	const smooth =
		first.type === "line" &&
		first.series.some(one => reader.bool(reader.child(seriesNodes[one.index] ?? -1, D.C, "smooth"), "val", false))
	const firstSlice = reader.number(reader.child(nodes[first.index] ?? -1, D.C, "firstSliceAng"), "val", 0)
	const plotStyle = styles.style(
		[
			["chart:stacked", first.grouping === "stacked" ? "true" : undefined],
			["chart:percentage", first.grouping === "percentStacked" ? "true" : undefined],
			["chart:vertical", first.type === "bar" ? "true" : undefined],
			["chart:three-dimensional", first.threeD ? "true" : undefined],
			["chart:gap-width", bars ? String(gap) : undefined],
			["chart:overlap", bars ? String(overlap) : undefined],
			["chart:interpolation", smooth ? "cubic-spline" : undefined],
			[
				"chart:angle-offset",
				first.type === "pie" || first.type === "doughnut" ? String((((90 - firstSlice) % 360) + 360) % 360) : undefined
			],
			["chart:include-hidden-cells", "false"]
		],
		[]
	)
	const titleText = info.title === "" ? (total === 1 ? (first.series[0]?.name ?? "") : "Chart Title") : info.title
	const title = titleText === null || titleText === "" ? "" : `<chart:title>${paragraphs(titleText)}</chart:title>`
	const legend = info.legend === null ? "" : `<chart:legend chart:legend-position="${LEGENDS[info.legend] ?? "end"}"/>`
	const area = styles.style(
		[],
		[
			["draw:fill", "solid"],
			["draw:fill-color", "#ffffff"]
		]
	)
	const plot =
		`<chart:plot-area chart:style-name="${plotStyle}" table:cell-range-address="${escapeAttribute(ranges.join(" "))}" chart:data-source-has-labels="none">` +
		axis(xAxis, "x", "primary-x", categoriesMarkup) +
		axis(yAxis, "y", "primary-y", "") +
		axis(secondary, "y", "secondary-y", "") +
		series.join("") +
		// A flat chart's plot area is as Excel draws it, without LibreOffice's grey wall.
		(first.threeD || xAxis === undefined
			? ""
			: `<chart:wall chart:style-name="${styles.style(
					[],
					[
						["draw:fill", "none"],
						["draw:stroke", "none"]
					]
				)}"/>`) +
		"</chart:plot-area>"
	const body = `<chart:chart svg:width="${width}" svg:height="${height}" chart:class="${CLASSES[first.type] ?? "chart:bar"}" chart:style-name="${area}">${title}${legend}${plot}</chart:chart>`

	if (chart < 0) return null

	return {
		content: `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${OFFICE} office:version="1.3"><office:automatic-styles>${numberStyles.join("")}${styles.markup.join("")}</office:automatic-styles><office:body><office:chart>${body}</office:chart></office:body></office:document-content>`,
		ranges: ranges.join(" "),
		lost
	}
}

// Points a series has (its values' cache, c:ptCount, §21.2.2.141).
function pointCount(reader: DrawingReader, series: number): number {
	const values = reader.child(series, D.C, "val")
	const cache = reader.descendant(values, D.C, "ptCount")

	return Math.min(1024, Math.max(0, reader.number(cache, "val", 0)))
}

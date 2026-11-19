import { referenceText } from "../../sheet/refs/formulaRefs"
import type { SheetRange } from "../../sheet/protocol"
import { escapeText } from "../../xml/entities"
import { encodeUtf8 } from "../../xml/index"
import type { ChartSheetCells } from "./cache"
import type { ChartEditType } from "./edit"
import type { ChartGrouping } from "./model"
import { CHART_NAMESPACE, CHART_STRICT_NAMESPACE } from "./parts"

// A new chart part from a range of cells, laid out as Excel lays one out ("Change how rows and columns of data are
// plotted in a chart"): the larger dimension runs along the category axis, so with more rows than columns each column
// is a series, otherwise each row is; a first row or column holding text (or both, under a blank corner) names the
// series and the categories. A scatter chart's first column (or row) is the x values of every series.

const MAX_SERIES = 255

export interface ChartLayout {
	readonly byColumns: boolean
	// Rows (byColumns) or columns holding series names and categories.
	readonly nameLine: boolean
	readonly categoryLine: boolean
}

function isLabel(sheet: ChartSheetCells, row: number, col: number): boolean {
	const cell = sheet.cell(row, col)

	return cell.kind === "text" || cell.kind === "empty"
}

// Where a range's labels and series are (Excel's reading of a selection).
export function chartLayout(sheet: ChartSheetCells, range: SheetRange, type: ChartEditType): ChartLayout {
	const rows = range.endRow - range.startRow + 1
	const cols = range.endCol - range.startCol + 1
	const corner = sheet.cell(range.startRow, range.startCol)
	let topLabels = rows > 1
	let leftLabels = cols > 1

	for (let col = range.startCol + 1; col <= range.endCol && topLabels; col++) if (!isLabel(sheet, range.startRow, col)) topLabels = false
	for (let row = range.startRow + 1; row <= range.endRow && leftLabels; row++)
		if (!isLabel(sheet, row, range.startCol)) leftLabels = false

	// A single column (or row) has no category line to vote on its first cell: only text there names the series.
	if (cols === 1 && rows > 1) topLabels = corner.kind === "text"
	if (rows === 1 && cols > 1) leftLabels = corner.kind === "text"

	// Text in the corner over a column of text is the categories' header; a blank corner heads both.
	if (corner.kind === "empty" && rows > 1 && cols > 1) {
		topLabels = true
		leftLabels = true
	}

	const dataRows = rows - (topLabels ? 1 : 0)
	const dataCols = cols - (leftLabels ? 1 : 0)
	const byColumns = type === "scatter" ? dataRows >= dataCols || cols > 1 : dataRows > dataCols

	return byColumns
		? { byColumns, nameLine: topLabels, categoryLine: leftLabels }
		: { byColumns, nameLine: leftLabels, categoryLine: topLabels }
}

interface Line {
	readonly name: string | null
	readonly values: string
}

function area(range: SheetRange): {
	kind: "cell"
	range: boolean
	startRow: number
	startCol: number
	endRow: number
	endCol: number
	startRowAbs: true
	startColAbs: true
	endRowAbs: true
	endColAbs: true
} {
	return {
		kind: "cell",
		range: range.startRow !== range.endRow || range.startCol !== range.endCol,
		...range,
		startRowAbs: true,
		startColAbs: true,
		endRowAbs: true,
		endColAbs: true
	}
}

function ref(sheet: string, range: SheetRange): string {
	return referenceText(area(range), sheet)
}

export interface ChartSource {
	readonly categories: string | null
	readonly series: readonly Line[]
}

// The series a range makes, as formulas on `sheetName`.
export function chartSource(sheetName: string, range: SheetRange, layout: ChartLayout, type: ChartEditType): ChartSource {
	const firstRow = range.startRow + (layout.byColumns ? (layout.nameLine ? 1 : 0) : layout.categoryLine ? 1 : 0)
	const firstCol = range.startCol + (layout.byColumns ? (layout.categoryLine ? 1 : 0) : layout.nameLine ? 1 : 0)
	const series: Line[] = []
	let categories: string | null = null

	if (layout.byColumns) {
		if (layout.categoryLine && firstRow <= range.endRow)
			categories = ref(sheetName, { startRow: firstRow, startCol: range.startCol, endRow: range.endRow, endCol: range.startCol })

		let start = firstCol

		// A scatter chart without a categories column takes its first column as the x values.
		if (type === "scatter" && categories === null && range.endCol > firstCol) {
			categories = ref(sheetName, { startRow: firstRow, startCol: firstCol, endRow: range.endRow, endCol: firstCol })
			start++
		}

		for (let col = start; col <= range.endCol; col++)
			series.push({
				name: layout.nameLine
					? ref(sheetName, { startRow: range.startRow, startCol: col, endRow: range.startRow, endCol: col })
					: null,
				values: ref(sheetName, { startRow: firstRow, startCol: col, endRow: range.endRow, endCol: col })
			})
	} else {
		if (layout.categoryLine && firstCol <= range.endCol)
			categories = ref(sheetName, { startRow: range.startRow, startCol: firstCol, endRow: range.startRow, endCol: range.endCol })

		let start = firstRow

		if (type === "scatter" && categories === null && range.endRow > firstRow) {
			categories = ref(sheetName, { startRow: firstRow, startCol: firstCol, endRow: firstRow, endCol: range.endCol })
			start++
		}

		for (let row = start; row <= range.endRow; row++)
			series.push({
				name: layout.nameLine
					? ref(sheetName, { startRow: row, startCol: range.startCol, endRow: row, endCol: range.startCol })
					: null,
				values: ref(sheetName, { startRow: row, startCol: firstCol, endRow: row, endCol: range.endCol })
			})
	}

	// A pie shows one series.
	return { categories, series: (type === "pie" || type === "doughnut" ? series.slice(0, 1) : series).slice(0, MAX_SERIES) }
}

// The chart part (c:chartSpace) for `source`, without caches (the caller fills them from the cells).
export function newChartPart(
	source: ChartSource,
	type: ChartEditType,
	grouping: ChartGrouping | undefined,
	options: { readonly strict: boolean; readonly date1904: boolean; readonly numericCategories: boolean }
): Uint8Array {
	const c = options.strict ? CHART_STRICT_NAMESPACE : CHART_NAMESPACE
	const a = options.strict ? "http://purl.oclc.org/ooxml/drawingml/main" : "http://schemas.openxmlformats.org/drawingml/2006/main"
	const r = options.strict
		? "http://purl.oclc.org/ooxml/officeDocument/relationships"
		: "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
	const v = (local: string, value: string | number): string => `<c:${local} val="${String(value)}"/>`
	const pie = type === "pie" || type === "doughnut"
	const scatter = type === "scatter"
	const bar = type === "column" || type === "bar"
	const stackable = grouping === "stacked" || grouping === "percentStacked"
	const groupingOut = bar
		? stackable
			? grouping
			: "clustered"
		: type === "line" || type === "area"
			? stackable
				? grouping
				: "standard"
			: null
	const categoryElement = scatter ? "xVal" : "cat"
	const valueElement = scatter ? "yVal" : "val"
	const categoryKind = options.numericCategories || scatter ? "numRef" : "strRef"
	const series = source.series
		.map((line, index) => {
			const name = line.name === null ? "" : `<c:tx><c:strRef><c:f>${escapeText(line.name)}</c:f></c:strRef></c:tx>`
			const categories =
				source.categories === null
					? ""
					: `<c:${categoryElement}><c:${categoryKind}><c:f>${escapeText(source.categories)}</c:f></c:${categoryKind}></c:${categoryElement}>`
			const values = `<c:${valueElement}><c:numRef><c:f>${escapeText(line.values)}</c:f></c:numRef></c:${valueElement}>`
			const head = `${v("idx", index)}${v("order", index)}${name}`
			const own = type === "line" ? '<c:marker><c:symbol val="none"/></c:marker>' : bar ? v("invertIfNegative", 0) : ""

			return `<c:ser>${head}${own}${categories}${values}${type === "line" || scatter ? v("smooth", 0) : ""}</c:ser>`
		})
		.join("")
	const axes = pie ? "" : `${v("axId", 500000001)}${v("axId", 500000002)}`
	const plot = bar
		? `<c:barChart>${v("barDir", type === "bar" ? "bar" : "col")}${v("grouping", groupingOut ?? "clustered")}${v("varyColors", 0)}${series}${v("gapWidth", 150)}${stackable ? v("overlap", 100) : ""}${axes}</c:barChart>`
		: type === "line"
			? `<c:lineChart>${v("grouping", groupingOut ?? "standard")}${v("varyColors", 0)}${series}${v("marker", 1)}${axes}</c:lineChart>`
			: type === "area"
				? `<c:areaChart>${v("grouping", groupingOut ?? "standard")}${v("varyColors", 0)}${series}${axes}</c:areaChart>`
				: scatter
					? `<c:scatterChart>${v("scatterStyle", "lineMarker")}${v("varyColors", 0)}${series}${axes}</c:scatterChart>`
					: type === "pie"
						? `<c:pieChart>${v("varyColors", 1)}${series}${v("firstSliceAng", 0)}</c:pieChart>`
						: `<c:doughnutChart>${v("varyColors", 1)}${series}${v("firstSliceAng", 0)}${v("holeSize", 75)}</c:doughnutChart>`
	const horizontal = type === "bar"
	const axis = (kind: "catAx" | "valAx", id: number, cross: number, position: string, between: string): string =>
		`<c:${kind}>${v("axId", id)}<c:scaling>${v("orientation", "minMax")}</c:scaling>${v("delete", 0)}${v("axPos", position)}` +
		`${kind === "valAx" ? "<c:majorGridlines/>" : ""}<c:numFmt formatCode="General" sourceLinked="1"/>` +
		`${v("majorTickMark", kind === "valAx" ? "none" : "out")}${v("minorTickMark", "none")}${v("tickLblPos", "nextTo")}${v("crossAx", cross)}${v("crosses", "autoZero")}` +
		(kind === "catAx"
			? `${v("auto", 1)}${v("lblAlgn", "ctr")}${v("lblOffset", 100)}${v("noMultiLvlLbl", 0)}`
			: v("crossBetween", between)) +
		`</c:${kind}>`
	const axisMarkup = pie
		? ""
		: scatter
			? axis("valAx", 500000001, 500000002, "b", "midCat") + axis("valAx", 500000002, 500000001, "l", "midCat")
			: axis("catAx", 500000001, 500000002, horizontal ? "l" : "b", "between") +
				axis("valAx", 500000002, 500000001, horizontal ? "b" : "l", "between")
	const single = source.series.length === 1
	// One series: its name is the automatic title and no legend shows; more: a legend at the bottom (Excel's default).
	const title = single ? `<c:title>${v("overlay", 0)}</c:title>${v("autoTitleDeleted", 0)}` : v("autoTitleDeleted", 1)
	const legend = single && !pie ? "" : `<c:legend>${v("legendPos", "b")}${v("overlay", 0)}</c:legend>`

	return encodeUtf8(
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
			`<c:chartSpace xmlns:c="${c}" xmlns:a="${a}" xmlns:r="${r}">${v("date1904", options.date1904 ? 1 : 0)}${v("lang", "en-US")}${v("roundedCorners", 0)}` +
			`<c:chart>${title}<c:plotArea><c:layout/>${plot}${axisMarkup}</c:plotArea>${legend}${v("plotVisOnly", 1)}${v("dispBlanksAs", "gap")}</c:chart>` +
			"</c:chartSpace>"
	)
}

import type { ChartEditType, SheetChartEdit } from "../../../xlsx/charts/edit"
import type { ChartGrouping, ChartInfo, ChartLabels, ChartLegendPosition } from "../../../xlsx/charts/model"
import type { ShapeNode, ShapeRef, SlideRef, Xfrm } from "../../model"
import type { DeckOp } from "../ops"
import type { InsertDeck } from "./insert"

// The page's chart commands: Insert ▸ Chart (a chart of each type over sample data, as PowerPoint inserts one, its
// data then edited in Edit Data) and the Chart tab's edits, each one op.

// The chart types Insert ▸ Chart offers, with the groupings each has.
export const INSERT_CHART_TYPES: readonly { readonly type: ChartEditType; readonly groupings: readonly ChartGrouping[] }[] = [
	{ type: "column", groupings: ["clustered", "stacked", "percentStacked"] },
	{ type: "bar", groupings: ["clustered", "stacked", "percentStacked"] },
	{ type: "line", groupings: ["standard", "stacked", "percentStacked"] },
	{ type: "area", groupings: ["standard", "stacked", "percentStacked"] },
	{ type: "pie", groupings: [] },
	{ type: "doughnut", groupings: [] },
	{ type: "scatter", groupings: [] }
]

export type ChartCell = string | number | null

// The data a new chart starts with (PowerPoint's own sample: four categories, three series); the names are the
// caller's (localized).
export function sampleChartCells(names: { readonly categories: readonly string[]; readonly series: readonly string[] }): ChartCell[][] {
	const values = [
		[4.3, 2.4, 2],
		[2.5, 4.4, 2],
		[3.5, 1.8, 3],
		[4.5, 2.8, 5]
	]

	return [["", ...names.series.slice(0, 3)], ...values.map((row, index) => [names.categories[index] ?? String(index + 1), ...row])]
}

// A scatter chart's sample: x values in the first column, one y series.
export function sampleScatterCells(names: { readonly x: string; readonly y: string }): ChartCell[][] {
	return [
		[names.x, names.y],
		[0.7, 2.7],
		[1.8, 3.2],
		[2.6, 0.8]
	]
}

// A new chart's box: two thirds of the slide, centred (PowerPoint's default chart size is about that on 16:9 and 4:3).
export function chartBox(deck: InsertDeck): Xfrm {
	const cx = Math.round((deck.size.cx * 2) / 3)
	const cy = Math.round((deck.size.cy * 2) / 3)

	return { x: Math.round((deck.size.cx - cx) / 2), y: Math.round((deck.size.cy - cy) / 2), cx, cy, rot: 0, flipH: false, flipV: false }
}

// Insert ▸ Chart: a chart of `type` over `cells` on `slide`, its shape `id`.
export function insertChartOp(
	deck: InsertDeck,
	slide: SlideRef,
	id: number,
	type: ChartEditType,
	cells: readonly (readonly ChartCell[])[],
	grouping?: ChartGrouping,
	box?: Xfrm
): DeckOp {
	const shape: ShapeNode = {
		id,
		name: `Chart ${String(Math.max(1, id - 1))}`,
		hidden: false,
		kind: "frame",
		xfrm: box ?? chartBox(deck),
		frame: { kind: "chart", part: "" }
	}

	return { family: "chart", kind: "insert", slide, shape, type, cells, ...(grouping === undefined ? {} : { grouping }) }
}

export function chartEditOp(target: ShapeRef, edit: SheetChartEdit): DeckOp {
	return { family: "chart", kind: "edit", target, edit }
}

// Edit Data's commit: the workbook as the sheet worker saved it.
export function chartWorkbookOp(target: ShapeRef, workbook: Uint8Array): DeckOp {
	return {
		family: "chart",
		kind: "setWorkbook",
		target,
		workbook,
		contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	}
}

// The edits the Chart tab's quick controls make, for the chart's first plot.
export function chartTypeEdit(info: ChartInfo, type: ChartEditType, grouping?: ChartGrouping): SheetChartEdit | undefined {
	if (info.plots.length === 0) return undefined

	return { kind: "type", plot: 0, type, ...(grouping === undefined ? {} : { grouping }) }
}

export function chartTitleEdit(text: string | null): SheetChartEdit {
	return { kind: "title", text }
}

export function chartLegendEdit(position: ChartLegendPosition | null): SheetChartEdit {
	return { kind: "legend", position }
}

// Data labels on every plot: values (the common choice) or none.
export function chartLabelsEdit(shown: boolean): SheetChartEdit {
	const labels: ChartLabels = { value: true, percent: false, category: false, series: false, position: null }

	return { kind: "labels", plot: null, labels: shown ? labels : null }
}

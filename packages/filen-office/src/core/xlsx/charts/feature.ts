import { D, drawingReader } from "../../drawingml/reader"
import { partKey } from "../../opc/partNames"
import { type SheetId, type SheetRange, type SheetRefusal } from "../../sheet/protocol"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled } from "../../sheet/registry"
import type { XlsxDocument } from "../edit/document"
import { coveringAnchor } from "../drawings/media"
import { appendDrawingObject } from "../drawings/edit"
import { drawingObjects } from "../drawings/feature"
import { drawingStore } from "../drawings/store"
import { DrawingWrites } from "../drawings/writes"
import { refState } from "../refs/state"
import { freePartName, partFolder } from "../comments/parts"
import { escapeAttribute, parseXml, type XmlDocument } from "../../xml/index"
import { chartBook } from "./book"
import { chartSheetNames, refreshChartCaches } from "./cache"
import { chartAreas } from "./refs"
import { referenceSpans } from "../../sheet/refs/formulaRefs"
import { chartNames, documentCells, readySheets } from "./cells"
import { chartLayout, chartSource, newChartPart } from "./create"
import { ChartEditRefused, applyChartEdit, type ChartEditType, type SheetChartEdit } from "./edit"
import { chartFormulaHost } from "./formulas"
import { chartRoot, readChartInfo, type ChartGrouping } from "./model"
import { CHART_NAMESPACE, CHART_STRICT_NAMESPACE, CHART_TYPE, chartRelationship } from "./parts"
import type { ChartPlacement } from "./protocol"
import { renderChart } from "./render"
import { chartSheetChart } from "./sheets"

// Charts in worksheets' drawings (ECMA-376 Part 1 §21.2): drawn from their cells as they now are (chart.render), read
// for the chart editor (chart.get), edited (chart.edit: type, series and their ranges, axes, titles, legend, data
// labels), inserted from a range (chart.insert). Their cached values are read again from the cells at save for every
// chart whose cells an edit changed: a chart nobody touched keeps its bytes. Frames are the drawings feature's: it
// moves, resizes and deletes them (deleting a chart's parts through deleteChartParts).

// Excel's new chart: 5 x 3 inches.
const DEFAULT_WIDTH = 4_572_000
const DEFAULT_HEIGHT = 2_743_200

function refused(refusal: SheetRefusal): { readonly refused: SheetRefusal } {
	return { refused: refusal }
}

// Whether `part` is the chart of a frame on the sheet's drawing.
async function shownOn(document: XlsxDocument, sheet: SheetId, part: string): Promise<boolean> {
	const kind = document.entry(sheet)?.kind

	if (kind === "chartsheet") {
		const shown = await chartSheetChart(document, sheet)

		return shown !== null && partKey(shown.part) === partKey(part)
	}

	if (kind !== "worksheet") return false

	const store = drawingStore(document.workbook)

	try {
		await store.load(document, sheet)
	} catch {
		return false
	}

	return (
		drawingObjects(store, sheet)?.objects.some(
			object => object.chartPart !== undefined && partKey(object.chartPart) === partKey(part)
		) === true
	)
}

function sheetName(document: XlsxDocument, sheet: SheetId): string {
	return document.entry(sheet)?.name ?? ""
}

// The sheets an edit's ranges read (parsed before it runs: categories are a numRef when their cells hold numbers).
function editSheets(edit: SheetChartEdit, ownSheet: string, names: ReturnType<typeof chartNames>): Set<string> {
	const texts =
		edit.kind === "series.add"
			? [edit.name, edit.categories, edit.values]
			: edit.kind === "series.set"
				? [edit.name, edit.categories, edit.values]
				: []
	const out = new Set<string>([ownSheet.toUpperCase()])

	for (const text of texts) {
		if (text === null || text === undefined) continue

		for (const span of referenceSpans(text.replace(/^\s*=/, ""))) out.add((span.sheet ?? ownSheet).toUpperCase())
		for (const area of chartAreas(text.replace(/^\s*=/, ""), names) ?? []) out.add(area.sheet.toUpperCase())
	}

	return out
}

// Why a chart part cannot be edited at all (what any edit would refuse for).
function editRefusal(document: XmlDocument): SheetRefusal | null {
	const reader = drawingReader(document)
	const { space, chart } = chartRoot(reader)

	if (chart < 0) return { reason: "chartUnsupported", detail: "chart part" }
	if (reader.child(space, D.C, "pivotSource") >= 0) return { reason: "chartUnsupported", detail: "pivot chart" }

	return null
}

// The chart's bytes with its caches equal to its cells, and those bytes parsed (null when they do not read).
async function refreshed(document: XlsxDocument, bytes: Uint8Array): Promise<{ bytes: Uint8Array; parsed: XmlDocument | null }> {
	let source: XmlDocument

	try {
		source = parseXml(bytes)
	} catch {
		return { bytes, parsed: null }
	}

	await readySheets(document, chartSheetNames(source, chartNames(document)))

	const result = refreshChartCaches(bytes, documentCells(document), {}, source)

	return result.changed ? { bytes: result.bytes, parsed: null } : { bytes, parsed: source }
}

async function cachesRefreshed(document: XlsxDocument, bytes: Uint8Array): Promise<Uint8Array> {
	return (await refreshed(document, bytes)).bytes
}

async function editChart(
	document: XlsxDocument,
	sheet: SheetId,
	part: string,
	edit: SheetChartEdit,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	if (!(await shownOn(document, sheet, part))) return refused({ reason: "chartUnsupported", detail: "chart" })

	const book = chartBook(document.workbook)

	await book.load(document)

	const bytes = await book.current(part)

	if (bytes === null) return refused({ reason: "chartUnsupported", detail: "chart" })

	let edited: Uint8Array

	try {
		await readySheets(document, editSheets(edit, sheetName(document, sheet), chartNames(document)))
		edited = applyChartEdit(parseXml(bytes), edit, chartFormulaHost(document, sheetName(document, sheet)))
	} catch (error) {
		if (error instanceof ChartEditRefused) return refused({ reason: error.reason, detail: error.message })
		if (error instanceof Error && error.name === "XmlError") return refused({ reason: "chartUnsupported", detail: "chart part" })

		throw error
	}

	const writes = new DrawingWrites(document.workbook)

	writes.setPart(part, document.workbook.parts.get(part)?.contentType ?? CHART_TYPE, await cachesRefreshed(document, edited))

	const report = (sink: SheetChangeSink): void => {
		book.touch(part)
		sink.layout(sheet)
	}

	report(changes)

	return writes.step(report)
}

async function insertChart(
	document: XlsxDocument,
	command: {
		readonly sheet: SheetId
		readonly range: SheetRange
		readonly chart: ChartEditType
		readonly grouping?: ChartGrouping
		readonly placement: ChartPlacement
	},
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const { sheet, range, chart: type } = command
	const name = sheetName(document, sheet)

	if (document.entry(sheet)?.kind !== "worksheet") return refused({ reason: "unsupported", detail: "sheet" })
	if (range.endRow < range.startRow || range.endCol < range.startCol) return refused({ reason: "chartUnsupported", detail: "range" })
	if ((range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1) > 1 << 20)
		return refused({ reason: "tooLarge", detail: "chart" })

	await document.ready(sheet)

	const cells = documentCells(document).sheet(name)

	if (cells === null) return refused({ reason: "unsupported", detail: "sheet" })

	const layout = chartLayout(cells, range, type)
	const source = chartSource(name, range, layout, type)

	if (source.series.length === 0) return refused({ reason: "chartUnsupported", detail: "range" })

	const host = chartFormulaHost(document, name)
	const workbook = document.workbook
	const strict = workbook.strict
	const part = freePartName(workbook, n => `${partFolder(workbook)}charts/chart${String(n)}.xml`)
	const bytes = await cachesRefreshed(
		document,
		newChartPart(source, type, command.grouping, {
			strict,
			date1904: workbook.date1904,
			numericCategories: source.categories !== null && host.numeric(source.categories)
		})
	)
	const writes = new DrawingWrites(workbook)
	const anchor = coveringAnchor(
		document,
		sheet,
		command.placement.from,
		command.placement.cx ?? DEFAULT_WIDTH,
		command.placement.cy ?? DEFAULT_HEIGHT
	)

	writes.setPart(part, CHART_TYPE, bytes)

	const result = await appendDrawingObject(document, sheet, writes, anchor, (relate, id) => {
		const relationship = relate(chartRelationship(workbook), part)

		return (
			`<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${String(id)}" name="Chart ${String(id)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
			'<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
			`<a:graphic><a:graphicData uri="${strict ? CHART_STRICT_NAMESPACE : CHART_NAMESPACE}"><c:chart r:id="${escapeAttribute(relationship)}"/></a:graphicData></a:graphic></xdr:graphicFrame>`
		)
	})

	if ("refused" in result) {
		writes.undo()

		return result
	}

	const book = chartBook(workbook)
	const report = (sink: SheetChangeSink): void => {
		book.touch(part)
		sink.layout(sheet)
	}

	report(changes)

	return writes.step(report)
}

// At save: each chart whose cells or bytes changed since the workbook was opened gets caches equal to its cells, for
// this save only: what it returns puts every chart back as the model holds it once the save is written, so no undo,
// later edit or later save ever starts from caches an earlier save wrote. A chart whose values are already equal keeps
// its bytes; one unchanged since the last save reuses that save's refresh.
async function refreshOnSave(document: XlsxDocument): Promise<() => void> {
	const book = chartBook(document.workbook)
	const state = refState(document.workbook)
	const restores: { name: string; contentType: string; held: Uint8Array | undefined }[] = []

	const restore = (): void => {
		for (const { name, contentType, held } of restores) state.setPart(name, contentType, held)
	}

	await book.load(document)

	try {
		for (const name of book.parts()) {
			if (!book.dirty.has(partKey(name))) continue

			const bytes = await book.current(name)

			if (bytes === null) continue

			let refreshed = book.refreshed(name, bytes)

			if (refreshed === undefined) {
				refreshed = await cachesRefreshed(document, bytes)
				book.rememberRefresh(name, bytes, refreshed)
			}

			if (refreshed === bytes) continue

			const contentType = document.workbook.parts.get(name)?.contentType ?? CHART_TYPE

			restores.push({ name, contentType, held: state.heldPart(name) })
			state.setPart(name, contentType, refreshed)
		}
	} catch (error) {
		// Nothing this save wrote stays when it stops part way.
		restore()

		throw error
	}

	return restore
}

export const chartsFeature = defineSheetFeature<XlsxDocument>({
	id: "charts",
	commands: {
		"chart.edit": {
			info: { write: true, protection: "objects", anySheet: true },
			run: (context, command) => editChart(context.doc, command.sheet, command.part, command.edit, context.changes)
		},
		"chart.insert": {
			info: { write: true, protection: "objects" },
			run: (context, command) => insertChart(context.doc, command, context.changes)
		}
	},
	queries: {
		"chart.render": {
			run: (context, request) =>
				renderChart(context.doc, request.part, request.width, request.height, request.since, context.settings.chartText)
		},
		"chart.sheet": { run: (context, request) => chartSheetChart(context.doc, request.sheet) },
		"chart.get": {
			run: async (context, request) => {
				if (!(await shownOn(context.doc, request.sheet, request.part))) return null

				const book = chartBook(context.doc.workbook)

				await book.load(context.doc)

				const bytes = await book.current(request.part)

				if (bytes === null) return null

				try {
					const fresh = await refreshed(context.doc, bytes)
					const parsed = fresh.parsed ?? parseXml(fresh.bytes)
					const info = readChartInfo(parsed)

					return info === null ? null : { info, refusal: editRefusal(parsed) }
				} catch {
					return null
				}
			}
		}
	},
	ready: async context => {
		await chartBook(context.doc.workbook).load(context.doc)

		return { ranges: [] }
	},
	dependents: (context, sheet, range) => {
		const name = context.doc.entry(sheet)?.name

		if (name !== undefined) chartBook(context.doc.workbook).changed(context.doc, name, range)
	},
	// How cells look (their number formats: a cache's text) and which are shown (hidden rows: a chart of visible cells)
	// change what a chart shows too. Sizes, merges and panes never do.
	observe: (context, change) => {
		const book = chartBook(context.doc.workbook)

		for (const [sheet, ranges] of change.ranges) {
			const name = context.doc.entry(sheet)?.name

			if (name !== undefined) for (const range of ranges) book.changed(context.doc, name, range)
		}

		for (const sheet of change.layouts) book.layoutChanged(context.doc, sheet)
	},
	save: context => refreshOnSave(context.doc)
})

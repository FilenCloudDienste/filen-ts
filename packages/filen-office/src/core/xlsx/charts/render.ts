import { CHART_TEXT_EN, convertChart, type ChartText } from "../../drawingml/chart/index"
import { DrawingList } from "../../drawingml/displayList"
import type { ImageResolver } from "../../drawingml/picture"
import { D, drawingReader, type DrawingReader } from "../../drawingml/reader"
import { NodeKind, parseXml, type XmlDocument } from "../../xml/index"
import type { XlsxDocument } from "../edit/document"
import { workbookDrawingTheme, type SheetDrawingData } from "../drawings/render"
import { chartBook } from "./book"
import { chartSheetNames, refreshChartCaches } from "./cache"
import { chartNames, documentCells, readySheets } from "./cells"
import { partRelationships } from "./parts"

// A chart drawn as a display list (core/drawingml/chart) at its frame's size, from its values as the cells now hold
// them (its caches refreshed first, as a save would write them), so an edit of the data shows at once.

export type ChartRender =
	| { readonly kind: "drawing"; readonly drawing: SheetDrawingData; readonly stamp: string }
	// What was drawn last is still what the chart shows (the request's `since`).
	| { readonly kind: "same"; readonly stamp: string }
	// missing: no such chart part; unsupported: nothing in it is drawn; failed: it does not read.
	| { readonly kind: "placeholder"; readonly reason: "missing" | "unsupported" | "failed"; readonly stamp: string }

// What a stamp adds for the chart text a drawing was made with: a chart drawn in other words is not the same.
export function chartTextStamp(text: ChartText): string {
	return text === CHART_TEXT_EN ? "" : `|${text.series}|${text.chartTitle}|${text.axisTitle}`
}

// Frames past this are drawn at it (EMU, about 2,600 px): the list's text and paths are laid out for it.
const MAX_FRAME = 25_000_000

export async function renderChart(
	document: XlsxDocument,
	part: string,
	width: number,
	height: number,
	since: string | undefined,
	chartText: ChartText = CHART_TEXT_EN
): Promise<ChartRender> {
	const book = chartBook(document.workbook)

	await book.load(document)

	const bytes = await book.current(part)

	if (bytes === null) return { kind: "placeholder", reason: "missing", stamp: "" }

	const stamp = `${book.stamp(part, bytes)}@${String(Math.round(width))}x${String(Math.round(height))}${chartTextStamp(chartText)}`

	if (since === stamp) return { kind: "same", stamp }

	try {
		const source = parseXml(bytes)
		const sheets = chartSheetNames(source, chartNames(document))

		await readySheets(document, sheets)
		book.shown(document, sheets)

		const shown = refreshChartCaches(bytes, documentCells(document), { shown: true }, source)
		const relationships = await partRelationships(document.workbook, part)
		const images: ImageResolver = id => {
			const relationship = relationships.find(candidate => candidate.id === id)
			const partName = relationship === undefined || relationship.external ? undefined : relationship.partName

			return partName === undefined ? undefined : { partName, contentType: document.workbook.parts.get(partName)?.contentType }
		}
		const theme = await workbookDrawingTheme(document.workbook)
		const result = convertChart(
			{ list: new DrawingList(), theme, images, effects: false },
			shown.changed ? parseXml(shown.bytes) : source,
			Math.min(MAX_FRAME, Math.max(0, width)),
			Math.min(MAX_FRAME, Math.max(0, height)),
			undefined,
			undefined,
			chartText
		)

		if (!result.supported) return { kind: "placeholder", reason: "unsupported", stamp }

		const out = result.list.compact()

		return {
			kind: "drawing",
			stamp,
			drawing: {
				width: out.width,
				height: out.height,
				commands: out.commands,
				coords: out.coords,
				itemCount: out.itemCount,
				itemFloats: out.itemFloats,
				itemInts: out.itemInts,
				paints: out.paints,
				strokes: out.strokes,
				images: out.images,
				texts: out.texts,
				shadows: out.shadows,
				...(out.itemClips === null ? {} : { clips: out.clips, itemClips: out.itemClips })
			}
		}
	} catch {
		return { kind: "placeholder", reason: "failed", stamp }
	}
}

// A chart inside a group of a sheet's drawing (charts in a group): drawn into the group's list by the shape walker,
// through the frame hook the drawings feature gives it. The charts' parts are read (and their caches refreshed as
// shown) before the walk, which is synchronous.
export interface NestedChartFrame {
	// Draws the chart of the graphic frame `node` into `list`, placed by `matrix` (the frame's px to the list's), at
	// `width` x `height` EMU; false when the frame shows no chart this drew.
	(reader: DrawingReader, node: number, list: DrawingList, matrix: readonly number[], width: number, height: number): boolean
}

// `within`: the element whose charts are read (an object's content), the whole drawing when absent. Null when it holds
// no chart frame.
export async function nestedChartFrames(
	document: XlsxDocument,
	drawingPart: string,
	drawing: XmlDocument,
	within: number = drawing.documentElement(),
	chartText: ChartText = CHART_TEXT_EN
): Promise<NestedChartFrame | null> {
	const reader = drawingReader(drawing)
	const relationships = await partRelationships(document.workbook, drawingPart)
	const charts = new Map<string, { document: XmlDocument; images: ImageResolver }>()
	const book = chartBook(document.workbook)

	const end = within < 0 ? -1 : drawing.end(within)
	const nodes: number[] = []

	for (let node = within + 1; node >= 1 && node < drawing.count && drawing.start(node) < end; node++)
		if (drawing.kind(node) === NodeKind.Element && reader.is(node, D.C, "chart")) nodes.push(node)

	if (nodes.length === 0) return null

	await book.load(document)

	for (const node of nodes) {
		const id = reader.attrNs(node, D.R, "id")
		const part =
			id === undefined || charts.has(id) ? undefined : relationships.find(entry => entry.id === id && !entry.external)?.partName

		if (id === undefined || part === undefined) continue

		const bytes = await book.current(part)

		if (bytes === null) continue

		try {
			const source = parseXml(bytes)
			const sheets = chartSheetNames(source, chartNames(document))

			await readySheets(document, sheets)
			book.shown(document, sheets)

			const own = await partRelationships(document.workbook, part)
			const shown = refreshChartCaches(bytes, documentCells(document), { shown: true }, source)

			charts.set(id, {
				document: shown.changed ? parseXml(shown.bytes) : source,
				images: rid => {
					const target = own.find(entry => entry.id === rid && !entry.external)?.partName

					return target === undefined
						? undefined
						: { partName: target, contentType: document.workbook.parts.get(target)?.contentType }
				}
			})
		} catch {
			// A chart that does not read is left out of the group, as the walker counts it.
		}
	}

	const theme = await workbookDrawingTheme(document.workbook)

	return (frameReader, node, list, matrix, width, height) => {
		if (frameReader.local(node) !== "graphicFrame") return false

		const chart = frameReader.descendant(node, D.C, "chart")
		const id = chart < 0 ? undefined : frameReader.attrNs(chart, D.R, "id")
		const found = id === undefined ? undefined : charts.get(id)

		if (found === undefined) return false

		return convertChart(
			{ list, theme, images: found.images, effects: false },
			found.document,
			Math.min(MAX_FRAME, width),
			Math.min(MAX_FRAME, height),
			list,
			matrix,
			chartText
		).supported
	}
}

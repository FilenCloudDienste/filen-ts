import type { SheetId } from "../../sheet/protocol"
import { defineSheetFeature } from "../../sheet/registry"
import type { XlsxDocument } from "../edit/document"
import type { DrawingAnchor } from "./anchor"
import { deleteObjects, drawingsRefusal, moveObject, objectStamp, setAltText } from "./edit"
import { insertImage, mediaBytes, type ImagePlacement } from "./media"
import type { DrawingObjectKind, DrawingPartRecord } from "./read"
import { D, drawingReader } from "../../drawingml/reader"
import { NodeKind, type XmlDocument } from "../../xml/index"
import { chartBook } from "../charts/book"
import { CHART_TEXT_EN } from "../../drawingml/chart/index"
import { chartTextStamp, nestedChartFrames } from "../charts/render"
import { renderObject, type DrawingRender } from "./render"
import { drawingStore, type DrawingStore } from "./store"

// Drawing objects on a sheet (pictures, shapes, text boxes, connectors, groups, chart frames): listed with their
// anchors in the layout ("drawings"), drawn on request (drawing.render, drawing.media), moved, resized, deleted, given
// alternative text, and pictures inserted. A sheet whose drawing part does not read shows no objects and refuses their
// edits ("drawingUnavailable"); the part is then saved as it was.

declare module "../../sheet/protocol" {
	interface SheetCommandMap {
		// An object moved or resized: `anchor` of the same mode (and editAs) as its own. `stamp` names the object as the
		// layout listed it: an object that changed since is refused.
		"drawing.move": { readonly sheet: SheetId; readonly key: number; readonly stamp: string; readonly anchor: DrawingAnchor }
		"drawing.delete": { readonly sheet: SheetId; readonly objects: readonly { readonly key: number; readonly stamp: string }[] }
		// "" removes it.
		"drawing.alt": { readonly sheet: SheetId; readonly key: number; readonly stamp: string; readonly alt: string }
		// A picture (png, jpeg, gif, bmp, tiff, emf, wmf; an SVG with `fallback`, the PNG shown where SVG is not).
		"drawing.insertImage": {
			readonly sheet: SheetId
			readonly placement: ImagePlacement
			readonly bytes: Uint8Array
			readonly fallback?: Uint8Array
			readonly name: string
			readonly alt: string
		}
	}
	interface SheetQueryMap {
		// One object drawn as a display list (charts are drawn by the charts feature).
		"drawing.render": {
			// since: the stamp of what the client shows of a drawing holding charts (a "same" answer when it still is).
			request: { readonly sheet: SheetId; readonly key: number; readonly stamp: string; readonly since?: string }
			result: DrawingRender | null
		}
		// A picture an object shows: its bytes and the type to show them as; null when it is not a picture of the package.
		"drawing.media": { request: { readonly partName: string }; result: { readonly bytes: Uint8Array; readonly type: string } | null }
	}
	interface SheetLayoutExtensionMap {
		readonly drawings?: SheetDrawings
	}
	interface SheetRefusalReasons {
		// The sheet's drawing part could not be read (detail: why).
		drawingUnavailable: true
		// The file locks the object (a:picLocks noMove or noResize).
		objectLocked: true
	}
}

export interface SheetDrawingObject {
	// Its place in z-order (the first is drawn first); changes when objects are added or deleted.
	readonly key: number
	// What it is now (objectStamp): commands name it with this.
	readonly stamp: string
	readonly kind: DrawingObjectKind
	readonly name: string
	readonly alt: string
	readonly hidden: boolean
	readonly noMove: boolean
	readonly noResize: boolean
	readonly anchor: DrawingAnchor
	// A chart frame's chart part.
	readonly chartPart?: string
}

export interface SheetDrawings {
	readonly part: string
	readonly objects: readonly SheetDrawingObject[]
}

const listed = new WeakMap<DrawingPartRecord, SheetDrawings>()

// The objects of a sheet's drawing as the layout lists them (those whose anchor reads), null without any.
export function drawingObjects(store: DrawingStore, sheet: SheetId): SheetDrawings | null {
	const drawing = store.drawing(sheet)

	if (drawing === null) return null

	const record = store.record(drawing.part)
	const cached = record === undefined ? undefined : listed.get(record)

	if (cached !== undefined && cached.part === drawing.part) return cached

	const relationships = store.relationships(drawing.part)
	const objects: SheetDrawingObject[] = []

	for (const object of drawing.objects) {
		if (object.anchor === null) continue

		const chart =
			object.chartRelationship === null ? undefined : relationships.find(relationship => relationship.id === object.chartRelationship)
		const chartPart = chart === undefined || chart.external ? undefined : chart.partName

		objects.push({
			key: object.key,
			stamp: objectStamp(drawing.document, object),
			kind: object.kind,
			name: object.name,
			alt: object.alt,
			hidden: object.hidden,
			noMove: object.noMove,
			noResize: object.noResize,
			anchor: object.anchor,
			...(chartPart === undefined ? {} : { chartPart })
		})
	}

	const result: SheetDrawings = { part: drawing.part, objects }

	if (record !== undefined) listed.set(record, result)

	return result
}

// What the charts inside `within` (a group's content) now draw, from each chart part's stamp; null when it holds none.
async function chartsStamp(
	document: XlsxDocument,
	store: DrawingStore,
	part: string,
	drawing: XmlDocument,
	within: number
): Promise<string | null> {
	const reader = drawingReader(drawing)
	const end = within < 0 ? -1 : drawing.end(within)
	const ids: string[] = []

	for (let node = within + 1; node >= 1 && node < drawing.count && drawing.start(node) < end; node++) {
		if (drawing.kind(node) !== NodeKind.Element || !reader.is(node, D.C, "chart")) continue

		ids.push(reader.attrNs(node, D.R, "id") ?? "")
	}

	if (ids.length === 0) return null

	const book = chartBook(document.workbook)
	const relationships = store.relationships(part)
	const stamps: string[] = []

	await book.load(document)

	for (const id of ids) {
		const relationship = relationships.find(entry => entry.id === id && !entry.external)
		const bytes = relationship?.partName === undefined ? null : await book.current(relationship.partName)

		stamps.push(relationship?.partName === undefined || bytes === null ? "-" : book.stamp(relationship.partName, bytes))
	}

	return stamps.join(",")
}

function worksheet(document: XlsxDocument, sheet: SheetId): boolean {
	return document.entry(sheet)?.kind === "worksheet"
}

export const drawingsFeature = defineSheetFeature<XlsxDocument>({
	id: "drawings",
	commands: {
		"drawing.move": {
			info: { write: true, protection: "objects" },
			check: (context, target) => drawingsRefusal(context.doc, target.sheet),
			run: (context, command) => moveObject(context.doc, command.sheet, command.key, command.stamp, command.anchor, context.changes)
		},
		"drawing.delete": {
			info: { write: true, protection: "objects" },
			check: (context, target) => drawingsRefusal(context.doc, target.sheet),
			run: (context, command) => deleteObjects(context.doc, command.sheet, command.objects, context.changes)
		},
		"drawing.alt": {
			info: { write: true, protection: "objects" },
			check: (context, target) => drawingsRefusal(context.doc, target.sheet),
			run: (context, command) => setAltText(context.doc, command.sheet, command.key, command.stamp, command.alt, context.changes)
		},
		"drawing.insertImage": {
			info: { write: true, protection: "objects" },
			check: (context, target) => drawingsRefusal(context.doc, target.sheet),
			run: (context, command) =>
				insertImage(
					context.doc,
					command.sheet,
					command.placement,
					command.bytes,
					command.fallback,
					command.name,
					command.alt,
					context.changes
				)
		}
	},
	queries: {
		"drawing.render": {
			run: async (context, request) => {
				if (!worksheet(context.doc, request.sheet)) return null

				const store = drawingStore(context.doc.workbook)

				try {
					await store.load(context.doc, request.sheet)
				} catch {
					return null
				}

				const drawing = store.drawing(request.sheet)
				const object = drawing?.objects[request.key]

				if (drawing === null || object === undefined || objectStamp(drawing.document, object) !== request.stamp) return null

				// A group may hold charts, which follow their cells: drawn again only when one of them moved on.
				const charts =
					object.kind === "group" ? await chartsStamp(context.doc, store, drawing.part, drawing.document, object.content) : null

				if (charts === null) return await renderObject(store, drawing.part, drawing.document, object)

				const chartText = context.settings.chartText ?? CHART_TEXT_EN
				const stamp = `${request.stamp}|${charts}${chartTextStamp(chartText)}`

				if (request.since === stamp) return { kind: "same", stamp }

				// The charts are read first, the walk being synchronous.
				const frame = await nestedChartFrames(context.doc, drawing.part, drawing.document, object.content, chartText)
				const rendered = await renderObject(store, drawing.part, drawing.document, object, frame ?? undefined)

				return rendered.kind === "drawing" ? { ...rendered, live: stamp } : rendered
			}
		},
		"drawing.media": { run: (context, request) => mediaBytes(context.doc, request.partName) }
	},
	ready: async (context, sheet) => {
		if (!worksheet(context.doc, sheet)) return { ranges: [] }

		const store = drawingStore(context.doc.workbook)

		await store.load(context.doc, sheet, context.slicing)

		const failure = store.failure(sheet)

		if (failure !== null) throw new Error(failure)

		return { ranges: [], layout: store.drawing(sheet) !== null }
	},
	layout: {
		drawings: (context, sheet) => {
			const store = drawingStore(context.doc.workbook)

			if (!store.loaded(sheet)) return undefined

			const drawings = drawingObjects(store, sheet)

			return drawings === null || drawings.objects.length === 0 ? undefined : drawings
		}
	}
})

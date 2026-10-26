import { convertChart } from "../../drawingml/chart/index"
import { IDENTITY, ItemKind, type DrawingList } from "../../drawingml/displayList"
import type { PaintContext } from "../../drawingml/fill"
import { MISSING_IMAGE, imageFormat, imageHandling } from "../../drawingml/picture"
import { D, EMU_PER_PX, drawingReader } from "../../drawingml/reader"
import { convertSmartArt } from "../../drawingml/smartart"
import type { ShapeContext } from "../../drawingml/shape"
import { parseXml, type XmlDocument } from "../../xml/index"
import type { Slicing } from "../../slicing"
import type { FrameRef, ShapeRef } from "../model"
import type { RenderReport } from "./effects"
import type { RenderServices } from "./services"
import type { SmartArtTexts } from "./smartartText"

// Graphic frames other than tables: charts (the shared chart converter), SmartArt (the drawing PowerPoint caches
// beside the diagram, else the SmartArt engine), OLE objects and media (their preview picture). Each draws into a
// list in the frame's own px box.

function imagesOf(services: RenderServices, part: string): PaintContext["images"] {
	return id => {
		const relationship = services.relationship(part, id)

		return relationship === undefined || relationship.external
			? undefined
			: { partName: relationship.target, contentType: services.contentType(relationship.target) }
	}
}

// The drawing PowerPoint caches for a diagram (MS-ODRAWXML §2.4.10 dsp:dataModelExt@relId in the data part's
// extension list): a relationship of the part holding the frame, else of the data part.
export function cachedDrawing(services: RenderServices, data: string, host: string | undefined): string | undefined {
	const document = services.xml(data)

	if (document === undefined) return undefined

	const reader = drawingReader(document)
	const extensions = reader.child(document.documentElement(), D.Dgm, "extLst")
	let relId: string | undefined

	for (const ext of reader.children(extensions, D.A, "ext")) {
		const model = reader.child(ext, D.Dsp, "dataModelExt")

		if (model >= 0) relId = reader.attr(model, "relId")
	}

	if (relId === undefined) return undefined

	for (const part of host === undefined ? [data] : [host, data]) {
		const relationship = services.relationship(part, relId)

		if (relationship !== undefined && !relationship.external) return relationship.target
	}

	return undefined
}

const TREE_PROPERTIES: ReadonlySet<string> = new Set(["nvGrpSpPr", "grpSpPr", "extLst"])

// Whether a diagram drawing part (dsp:drawing) has a shape in its tree.
export function cacheHasShapes(document: XmlDocument): boolean {
	const reader = drawingReader(document)
	const root = document.documentElement()
	const tree = reader.child(root, D.Dsp, "spTree")

	if (!reader.is(root, D.Dsp, "drawing") || tree < 0) return true

	for (let child = document.firstChildElement(tree); child >= 0; child = document.nextSiblingElement(child))
		if (!TREE_PROPERTIES.has(document.localName(child))) return true

	return false
}

// A picture filling the frame (an OLE preview, a media poster).
export function drawPreview(
	list: DrawingList,
	services: RenderServices,
	part: string | undefined,
	matrix: readonly number[],
	width: number,
	height: number
): boolean {
	if (part === undefined) return false

	const format = imageFormat(part, services.contentType(part))
	const image = list.image({ ...MISSING_IMAGE, partName: part, format, handling: imageHandling(format) })

	list.addItem(ItemKind.IMAGE, matrix, 0, 0, width, height, list.commandCount, list.coordCount, -1, -1, image, -1, 0, 0)

	return true
}

// Draws a frame into `list` through `matrix` (frame px to the list's), `width` × `height` EMU. False when nothing was
// drawn (counted in the report).
export async function drawFrame(
	frame: FrameRef,
	target: ShapeRef,
	// The part holding the graphic frame (the slide).
	host: string | undefined,
	context: ShapeContext,
	services: RenderServices,
	matrix: readonly number[] | undefined,
	width: number,
	height: number,
	slicing: Slicing,
	report: RenderReport,
	// Where SmartArt text goes to be laid out by the text adapter; without it the drawing carries the text itself.
	texts?: SmartArtTexts
): Promise<boolean> {
	const list = context.list
	const w = width / EMU_PER_PX
	const h = height / EMU_PER_PX

	switch (frame.kind) {
		case "chart": {
			const document = services.xml(frame.part)

			if (document === undefined) {
				report.refuse("chartMissing")

				return false
			}

			const result = convertChart(
				{ ...context, images: imagesOf(services, frame.part) },
				document,
				width,
				height,
				matrix === undefined ? undefined : list,
				matrix
			)

			for (const name of result.unsupported) report.approximate(`chart:${name}`)

			return result.supported
		}
		case "smartart": {
			const drawing = frame.drawing ?? cachedDrawing(services, frame.data, host)
			const smartContext: ShapeContext = { ...context, images: imagesOf(services, drawing ?? frame.data) }
			let document = drawing === undefined ? undefined : services.xml(drawing)
			// A cache part whose shape tree holds no shape (written by tools that leave the drawing to the reader) is no
			// cache: the engine lays the diagram out, else nothing is drawn.
			const empty = document !== undefined && !cacheHasShapes(document)

			if (empty) document = undefined

			let relaid = false

			if (document === undefined && services.smartart !== undefined) {
				const layout = await services.smartart.relayout(target, frame, slicing)

				if (layout !== undefined) {
					document = parseXml(new TextEncoder().encode(layout.drawingXml))
					relaid = true
				}
			}

			if (document === undefined) {
				report.refuse(empty ? "smartartCacheEmpty" : "smartartUncached")

				return false
			}

			if (matrix !== undefined) {
				// The cached drawing is a shape tree of its own frame; inside a group it is not placed.
				report.refuse("smartartInGroup")

				return false
			}

			const drawn = document
			const conversion = convertSmartArt(
				texts === undefined
					? smartContext
					: { ...smartContext, body: txBody => texts.add(drawn, relaid ? "" : (drawing ?? ""), txBody) },
				document,
				width,
				height
			)

			if (conversion !== undefined && conversion.unsupported > 0) report.refuse("smartartElement", conversion.unsupported)

			return conversion !== undefined
		}
		case "ole":
			if (drawPreview(list, services, frame.preview, matrix ?? IDENTITY, w, h)) return true

			report.refuse("olePreviewMissing")

			return false
		case "media":
			if (drawPreview(list, services, frame.media.poster, matrix ?? IDENTITY, w, h)) return true

			report.refuse("mediaPosterMissing")

			return false
		case "table":
		case "unknown":
			return false
	}
}

import { convertChart } from "../../drawingml/chart/index"
import { IDENTITY, ItemKind, type DrawingList } from "../../drawingml/displayList"
import type { PaintContext } from "../../drawingml/fill"
import { MISSING_IMAGE, imageFormat, imageHandling } from "../../drawingml/picture"
import { D, EMU_PER_PX, drawingReader } from "../../drawingml/reader"
import { convertSmartArt } from "../../drawingml/smartart"
import type { ShapeContext } from "../../drawingml/shape"
import { parseXml, type XmlDocument } from "../../xml/index"
import type { Slicing } from "../../slicing"
import type { FrameRef, ShapeNode, ShapeRef } from "../model"
import type { RenderReport } from "./effects"
import type { RenderServices } from "./services"
import type { SmartArtTexts } from "./smartartText"
import { INSERTED_IMAGE_ID, PART_IMAGE_ID } from "../../smartart/emit"
import { drawingMarkup } from "../../smartart/style"

// Graphic frames other than tables: charts (the shared chart converter), SmartArt (the drawing PowerPoint caches
// beside the diagram, else the SmartArt engine), OLE objects and media (their preview picture). Each draws into a
// list in the frame's own px box.

function imagesOf(services: RenderServices, part: string): PaintContext["images"] {
	return id => {
		// A picture an edit put into a diagram names its image before a save relates it: an inserted image (served as
		// "inserted:<id>") or a package part.
		if (id.startsWith(INSERTED_IMAGE_ID)) return { partName: id, contentType: services.contentType(id) }
		if (id.startsWith(PART_IMAGE_ID)) {
			const name = id.slice(PART_IMAGE_ID.length)

			return { partName: name, contentType: services.contentType(name) }
		}

		const relationship = services.relationship(part, id)

		return relationship === undefined || relationship.external
			? undefined
			: { partName: relationship.target, contentType: services.contentType(relationship.target) }
	}
}

const DIAGRAM_FILLS = new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"])

// A diagram's background and outline (ECMA-376 §21.4.3.1 bg, §21.4.3.10 whole): the data model's fill and line over
// the whole frame, drawn under its shapes. The drawing cache leaves them out, so they come from the data part (its
// pictures are relationships of that part).
function diagramBackdrop(context: ShapeContext, services: RenderServices, data: string, width: number, height: number): boolean {
	const document = services.xml(data)

	if (document === undefined) return false

	const reader = drawingReader(document)
	const root = document.documentElement()
	const bg = reader.child(root, D.Dgm, "bg")
	const whole = reader.child(root, D.Dgm, "whole")
	let fill = ""

	for (let child = bg < 0 ? -1 : document.firstChildElement(bg); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.group(child) === D.A && DIAGRAM_FILLS.has(document.localName(child))) fill = drawingMarkup(reader, child, 0, true)
	}

	const ln = whole < 0 ? -1 : reader.child(whole, D.A, "ln")
	const line = ln < 0 ? "" : drawingMarkup(reader, ln)

	if ((fill === "" || fill.startsWith("<a:noFill")) && line === "") return false

	const markup =
		'<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
		'<dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/><dsp:sp modelId="0"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>' +
		`<dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${String(Math.round(width))}" cy="${String(Math.round(height))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
		`${fill === "" ? "<a:noFill/>" : fill}${line === "" ? "<a:ln><a:noFill/></a:ln>" : line}</dsp:spPr></dsp:sp></dsp:spTree></dsp:drawing>`

	return (
		convertSmartArt({ ...context, images: imagesOf(services, data) }, parseXml(new TextEncoder().encode(markup)), width, height) !==
		undefined
	)
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

// An OLE object's frame as the picture its p:oleObj holds (ECMA-376 Part 1 §19.3.2.4: the p:pic shown in the object's
// place), so the picture's crop, border and effects are drawn with it; undefined when it holds none (its preview alone
// is drawn, drawFrame).
export function olePicture(services: RenderServices, shape: ShapeNode): ShapeNode | undefined {
	const src = shape.src

	if (shape.kind !== "frame" || shape.frame?.kind !== "ole" || src?.format !== "pptx") return undefined

	const document = services.xml(src.part)

	if (document === undefined || src.node <= 0 || src.node >= document.count) return undefined

	const reader = drawingReader(document)
	// In the branch of an mc:AlternateContent that has one (PowerPoint's Fallback).
	const picture = reader.descendant(reader.child(src.node, D.A, "graphic"), D.P, "pic")

	if (picture < 0 || !reader.is(document.parent(picture), D.P, "oleObj")) return undefined

	return { ...shape, kind: "pic", src: { ...src, node: picture } }
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

			if (matrix !== undefined) {
				// The cached drawing is a shape tree of its own frame; inside a group it is not placed.
				report.refuse(document === undefined ? (empty ? "smartartCacheEmpty" : "smartartUncached") : "smartartInGroup")

				return false
			}

			// A diagram without nodes may still have its background (a picture of its own).
			const backdrop = diagramBackdrop(context, services, frame.data, width, height)

			if (document === undefined) {
				report.refuse(empty ? "smartartCacheEmpty" : "smartartUncached")

				return backdrop
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

import { refused, type FrameRef, type Refused, type ShapeNode } from "../../../presentation/model"
import { diagramRelationshipOwner } from "../../../presentation/edit/apply/smartart"
import {
	DIAGRAM_CONTENT_TYPES,
	dataHasRelationships,
	detachedDrawingRelId,
	drawingKey,
	rememberedDrawing,
	withDrawingReference,
	type DiagramPart
} from "../../../smartart/edit"
import { encodeUtf8, escapeAttribute, type XmlDocument } from "../../../xml/index"
import { G } from "../../read/xml"
import { RELATIONSHIP_TYPES } from "../parts"
import type { EmitPiece, EmitResult, PartsApi, PptxEmitFamily, PptxPartKind } from "../types"
import { attr, pristineOf, readerOf, shapeElement, sourceNode, xfrmXml, type EmitContext } from "./shape"

// A diagram's p:graphicFrame and its parts (ECMA-376 §21.4: dgm:relIds names the data, layout, quick style and
// colours parts; MS-ODRAWXML §2.3.4: the data part's dsp:dataModelExt names the drawing cache, a relationship of the
// slide). A frame whose parts are all the package's is the shape family's (its a:graphic kept as written). A frame an
// edit pointed at parts the session holds ("raw:N", apply/smartart.ts) writes them: each into the part the source frame
// named for the same role when only this diagram uses it (its relationship kept, so nothing is left behind), else as a
// new part; the drawing the renderer laid out from the held data (smartart/edit.ts rememberDrawing) into the part the
// detached dsp:dataModelExt named, or a new one. Without a laid-out drawing the data part names none, and the
// consumer lays the diagram out itself.

type DiagramFrame = Extract<FrameRef, { kind: "smartart" }>
type DefinitionRole = "data" | "layout" | "style" | "colors"

const GRAPHIC_DIAGRAM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
const R_URI = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const ROLES: readonly DefinitionRole[] = ["data", "layout", "style", "colors"]
const REL_ATTRIBUTES: Readonly<Record<DefinitionRole, string>> = { data: "dm", layout: "lo", style: "qs", colors: "cs" }
const KINDS: Readonly<Record<DiagramPart, PptxPartKind>> = {
	data: "diagramData",
	layout: "diagramLayout",
	style: "diagramStyle",
	colors: "diagramColors",
	drawing: "diagramDrawing"
}

// A part a later save may replace in place: PartsApi.replacePart where the writer has it (false: no such part).
type Replacing = PartsApi & { replacePart?: (part: string, content: Uint8Array) => boolean }

function isHeld(part: string): boolean {
	return part.startsWith("raw:")
}

function heldParts(frame: DiagramFrame): boolean {
	return ROLES.some(role => isHeld(frame[role]))
}

// The dgm:relIds of the source frame, and its a:graphic element.
function sourceGraphic(
	context: EmitContext,
	shape: ShapeNode
): { graphic: number; ids: Partial<Record<DefinitionRole, string>> } | undefined {
	const node = sourceNode(context, shape.src)
	const r = readerOf(context)

	if (node < 0 || r === undefined) return undefined

	const graphic = r.child(node, G.A, "graphic")
	const relIds = r.child(r.child(graphic, G.A, "graphicData"), G.Dgm, "relIds")

	if (graphic < 0 || relIds < 0) return undefined

	const ids: Partial<Record<DefinitionRole, string>> = {}

	for (const role of ROLES) {
		const id = r.rel(relIds, REL_ATTRIBUTES[role])

		if (id !== undefined) ids[role] = id
	}

	return { graphic, ids }
}

// Whether another diagram of the deck names `part` (a part shared is never replaced in place).
function sharedElsewhere(context: EmitContext, shape: ShapeNode, part: string): boolean {
	const visit = (shapes: readonly ShapeNode[], depth: number): boolean => {
		if (depth > 128) return false

		for (const each of shapes) {
			const frame = each.frame

			if (each !== shape && frame?.kind === "smartart" && ROLES.some(role => frame[role] === part)) return true
			if (each.children !== undefined && visit(each.children, depth + 1)) return true
		}

		return false
	}

	for (const node of context.deck.nodes.values()) if (visit(node.shapes, 0)) return true

	return false
}

// Writes `bytes` for `role`: into the part `inPlace` names (keeping relationship `rId`) when that is safe, else as a new
// part related from the slide.
function writePart(
	context: EmitContext,
	shape: ShapeNode,
	role: DiagramPart,
	bytes: Uint8Array,
	inPlace: { readonly part: string | undefined; readonly rId: string | undefined }
): string {
	const parts = context.parts as Replacing

	if (
		inPlace.part !== undefined &&
		inPlace.rId !== undefined &&
		parts.replacePart !== undefined &&
		!sharedElsewhere(context, shape, inPlace.part) &&
		parts.replacePart(inPlace.part, bytes)
	)
		return inPlace.rId

	return parts.addPart(KINDS[role], bytes, DIAGRAM_CONTENT_TYPES[role]).rId
}

function graphicXml(prefix: string, ids: Readonly<Record<DefinitionRole, string>>): string {
	return (
		`<${prefix}graphic><${prefix}graphicData uri="${GRAPHIC_DIAGRAM}">` +
		`<dgm:relIds xmlns:dgm="${GRAPHIC_DIAGRAM}" xmlns:r="${R_URI}" r:dm="${escapeAttribute(ids.data)}" r:lo="${escapeAttribute(ids.layout)}" r:qs="${escapeAttribute(ids.style)}" r:cs="${escapeAttribute(ids.colors)}"/>` +
		`</${prefix}graphicData></${prefix}graphic>`
	)
}

// The relationships of the diagram's four parts, writing those the session holds (and the drawing with the data).
function writeParts(context: EmitContext, shape: ShapeNode, frame: DiagramFrame): Record<DefinitionRole, string> | Refused {
	const pristine = pristineOf(context, shape)?.frame
	const before = pristine?.kind === "smartart" ? pristine : undefined
	const source = sourceGraphic(context, shape)
	const ids: Partial<Record<DefinitionRole, string>> = {}
	const held = (part: string): XmlDocument | undefined => context.rawDocument?.(part)
	const inPlace = (role: DefinitionRole): { part: string | undefined; rId: string | undefined } => {
		const part = before?.[role]
		const rId = source?.ids[role]

		// The source's part for this role, still the one its relationship names.
		return part !== undefined && part !== "" && rId !== undefined && context.parts.target(rId) === part
			? { part, rId }
			: { part: undefined, rId: undefined }
	}

	for (const role of ROLES) {
		const part = frame[role]

		if (part === "") return refused("malformed", `a diagram without its ${role} part`)

		if (before !== undefined && part === before[role] && source?.ids[role] !== undefined) {
			ids[role] = source.ids[role]

			continue
		}

		if (!isHeld(part)) {
			ids[role] = context.parts.relate(part, RELATIONSHIP_TYPES[KINDS[role]])

			continue
		}

		const document = held(part)

		if (document === undefined) return refused("stale", `the diagram part ${part} is no longer held`)
		if (role !== "data") {
			ids[role] = writePart(context, shape, role, document.bytes, inPlace(role))

			continue
		}

		// Data with pictures of its own goes back into the package part whose relationships name them, with no drawing
		// (one laid out from it names the data part's relationship ids; PowerPoint lays it out again). Apply refuses an
		// edit that part cannot take (shared with another diagram).
		if (dataHasRelationships(document)) {
			const target = inPlace("data")
			const owner = diagramRelationshipOwner(context.deck, part)
			const parts = context.parts as Replacing

			if (
				owner === undefined ||
				target.part !== owner ||
				target.rId === undefined ||
				sharedElsewhere(context, shape, owner) ||
				parts.replacePart?.(owner, withDrawingReference(document, undefined)) !== true
			)
				return refused("failed", "a diagram with pictures whose own data part cannot take the edit")

			ids.data = target.rId

			continue
		}

		// The drawing first: the data part names it.
		const box = shape.xfrm
		const drawingXml =
			box === undefined ? undefined : rememberedDrawing(document, drawingKey(frame.layout, frame.style, frame.colors, box.cx, box.cy))
		let drawingId: string | undefined

		if (drawingXml !== undefined) {
			const detached = detachedDrawingRelId(document)
			const target = detached === undefined ? undefined : context.parts.target(detached)

			drawingId = writePart(context, shape, "drawing", encodeUtf8(drawingXml), {
				part: target,
				rId: target === undefined ? undefined : detached
			})
		}

		ids.data = writePart(context, shape, "data", withDrawingReference(document, drawingId), inPlace("data"))
	}

	return ids as Record<DefinitionRole, string>
}

// A new frame (Insert ▸ SmartArt): written whole from the model.
function newFrame(shape: ShapeNode, ids: Readonly<Record<DefinitionRole, string>>): EmitResult {
	const xfrm = shape.xfrm

	if (xfrm === undefined) return refused("malformed", "a new diagram without its box")

	const markup =
		`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr${attr("id", shape.id)}${attr("name", shape.name)}${attr("descr", shape.alt?.descr)}${attr("title", shape.alt?.title)}${shape.hidden ? ' hidden="1"' : ""}/>` +
		`<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrmXml("p:xfrm", xfrm, false)}${graphicXml("a:", ids)}</p:graphicFrame>`

	return { kind: "markup", pieces: [markup] }
}

function emitDiagram(context: EmitContext, shape: ShapeNode): EmitResult {
	const frame = shape.frame

	// A diagram whose parts are all the package's: the shape family keeps its a:graphic as written (a new frame naming
	// parts a save wrote, an insert redone after it, is written whole below).
	if (frame?.kind !== "smartart" || (!heldParts(frame) && sourceNode(context, shape.src) >= 0)) return shapeElement(context, shape)

	const ids = writeParts(context, shape, frame)

	if ("kind" in ids) return ids

	const source = sourceGraphic(context, shape)

	if (source === undefined) {
		if (sourceNode(context, shape.src) >= 0) return refused("malformed", "a diagram frame without dgm:relIds")

		return newFrame(shape, ids)
	}

	const element = shapeElement(context, shape)

	if (element.kind !== "markup") return element
	if (ROLES.every(role => source.ids[role] === ids[role])) return element

	// The source's a:graphic (a hole of the element) replaced by one naming the parts written.
	const document = context.document as XmlDocument
	const name = document.name(source.graphic)
	const prefix = name.includes(":") ? `${name.slice(0, name.indexOf(":"))}:` : ""
	let swapped = false
	const pieces: EmitPiece[] = element.pieces.map(piece => {
		if (typeof piece === "object" && !(piece instanceof Uint8Array) && piece.hole === source.graphic) {
			swapped = true

			return graphicXml(prefix, ids)
		}

		return piece
	})

	return swapped ? { kind: "markup", pieces } : refused("failed", "the diagram's a:graphic was not written as its source")
}

export const emitPptxSmartArt: PptxEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		return shape === undefined ? refused("failed", "A diagram emit without a shape") : emitDiagram(context, shape)
	}
}

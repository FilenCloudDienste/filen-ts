import { partKey } from "../../../opc/index"
import { refused, type FrameRef, type Refused, type ShapeNode } from "../../../presentation/model"
import {
	diagramDataHadPictures,
	diagramDrawingRelId,
	diagramRelationshipOwner,
	diagramRelationshipTargets,
	noteDiagramFrameWritten,
	diagramDataAsItWas,
	diagramOwnerTargets,
	packageDrawingRel
} from "../../../presentation/edit/apply/smartart"
import {
	DIAGRAM_CONTENT_TYPES,
	dataHasRelationships,
	detachedDrawingRelId,
	drawingKey,
	pendDataRelationships,
	pendingImageIds,
	rememberedDrawing,
	withDrawingReference,
	withImageRelationships,
	type DiagramPart
} from "../../../smartart/edit"
import { INSERTED_IMAGE_ID, PART_IMAGE_ID } from "../../../smartart/emit"
import { insertedImage, insertedImageWritten } from "../../../presentation/edit/apply/picture"
import { encodeUtf8, escapeAttribute, NodeKind, parseXml, type XmlDocument } from "../../../xml/index"
import { G } from "../../read/xml"
import { RELATIONSHIP_TYPES, type RelatingWithId } from "../parts"
import type { EmitPiece, EmitResult, PartsApi, PptxEmitFamily, PptxPartKind } from "../types"
import { attr, IMAGE_RELATIONSHIP, readerOf, shapeElement, sourceNode, xfrmXml, type EmitContext } from "./shape"

// A diagram's p:graphicFrame and its parts (ECMA-376 §21.4: dgm:relIds names the data, layout, quick style and
// colours parts; MS-ODRAWXML §2.3.4: the data part's dsp:dataModelExt names the drawing cache, a relationship of the
// slide). A frame whose parts are all the package's is the shape family's (its a:graphic kept as written). A frame an
// edit pointed at parts the session holds ("raw:N", apply/smartart.ts) writes them, each into the slide's own part for
// the role (the one its relationship names; on a duplicated slide this save's copy, as every diagram of a copy holds
// parts of its own) when no other diagram names it, else as a new part; the drawing the renderer laid out from the
// held data (smartart/edit.ts rememberDrawing) into the part the detached dsp:dataModelExt named, or a new one. Without
// a laid-out drawing the data part names none, and the consumer lays the diagram out itself. The relationships the
// frame leaves unnamed go with the save (releaseUnnamed).

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

function isRefusal(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "refused"
}

function isHeld(part: string): boolean {
	return part.startsWith("raw:")
}

function heldParts(frame: DiagramFrame): boolean {
	return ROLES.some(role => isHeld(frame[role]))
}

// The dgm:relIds of the source frame, and its a:graphic element.
interface SourceGraphic {
	readonly graphic: number
	readonly ids: Partial<Record<DefinitionRole, string>>
}

function sourceGraphic(context: EmitContext, shape: ShapeNode): SourceGraphic | undefined {
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

// Diagram parts more than one slide of the package relates, by key (the splice writer notes them before it emits): a
// file that shares them between slides has them split by the first edit of either, which writes parts of its own.
const sharedParts = new WeakMap<object, ReadonlySet<string>>()

// Package diagram data the deck's frames name, as the splice writer read it before it emits (by model part name): its
// document and the parts its own relationships name.
export interface PackageDiagramData {
	readonly document: XmlDocument
	readonly targets: ReadonlyMap<string, string>
}

const packageData = new WeakMap<object, ReadonlyMap<string, PackageDiagramData>>()

// The picture targets of every package data part a save read (by model part name), kept for the session: held data an
// undo writes back after a later save dropped its part relates its pictures through them.
const knownTargets = new WeakMap<object, Map<string, ReadonlyMap<string, string>>>()

export function notePackageDiagramData(deck: object, data: ReadonlyMap<string, PackageDiagramData>): void {
	packageData.set(deck, data)

	let known = knownTargets.get(deck)

	if (known === undefined) {
		known = new Map()
		knownTargets.set(deck, known)
	}

	for (const [name, { targets }] of data) if (targets.size > 0) known.set(name, targets)
}

function packageDiagramData(deck: object, part: string): PackageDiagramData | undefined {
	return packageData.get(deck)?.get(part.toLowerCase())
}

// The drawing relationship package data part `part` names; `known` false when the save did not read it.
function packageDataDrawing(deck: EmitContext["deck"], part: string): { readonly relId: string | undefined; readonly known: boolean } {
	const relId = packageDrawingRel(deck, part)

	if (relId !== undefined) return { relId, known: true }

	const data = packageDiagramData(deck, part)

	return data === undefined ? { relId: undefined, known: false } : { relId: diagramDrawingRelId(data.document), known: true }
}

export function noteSharedDiagramParts(deck: object, parts: ReadonlySet<string>): void {
	sharedParts.set(deck, parts)
}

function sameName(a: string | undefined, b: string | undefined): boolean {
	return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
}

// Whether another diagram of the deck names `part` for any role, its drawing included, or the file shares it between
// slides: a part not the frame's alone is never replaced in place.
function sharedElsewhere(context: EmitContext, shape: ShapeNode, part: string): boolean {
	if (sharedParts.get(context.deck)?.has(partKey(part)) === true) return true

	let shared = false

	for (const node of context.deck.nodes.values()) {
		walkShapes(node.shapes, 0, each => {
			const frame = each.frame

			if (
				each !== shape &&
				frame?.kind === "smartart" &&
				[...ROLES.map(role => frame[role]), frame.drawing].some(name => sameName(name, part))
			)
				shared = true
		})

		if (shared) return true
	}

	return false
}

interface Own {
	readonly part: string | undefined
	readonly rId: string | undefined
}

const NOT_OWN: Own = { part: undefined, rId: undefined }

// The slide's own part for a role: the one the source markup's relationship names now (on a duplicated slide, this
// save's copy), when no other diagram names it.
function ownPart(context: EmitContext, shape: ShapeNode, source: SourceGraphic | undefined, role: DefinitionRole): Own {
	const rId = source?.ids[role]
	const part = rId === undefined ? undefined : context.parts.target(rId)

	return part !== undefined && !sharedElsewhere(context, shape, part) ? { part, rId } : NOT_OWN
}

// Replaces a part the slide owns: a package part, or this save's copy of one.
function replaceOwn(context: EmitContext, part: string, bytes: Uint8Array): boolean {
	const parts = context.parts as Replacing

	return parts.replacePart?.(part, bytes) === true || parts.replaceCopy?.(part, bytes) === true
}

// Whether `part` is the frame's part `named`: the same, or this save's copy of it on a duplicated slide.
function isNamed(context: EmitContext, part: string | undefined, named: string | undefined): boolean {
	return sameName(part, named) || (part !== undefined && sameName((context.parts as Partial<RelatingWithId>).copiedFrom?.(part), named))
}

// The diagram drawing relationship `id` of the slide names; undefined when the id is free or names a part of another kind
// (a copied slide's id another relationship of its source holds).
function drawingTarget(context: EmitContext, id: string): string | undefined {
	const type = (context.parts as Partial<RelatingWithId>).relationshipType?.(id)

	return type === undefined || type === RELATIONSHIP_TYPES.diagramDrawing ? context.parts.target(id) : undefined
}

// Writes `bytes` for `role`: into the slide's own part (keeping its relationship) when it has one, else as a new part
// related from the slide.
function writePart(context: EmitContext, role: DiagramPart, bytes: Uint8Array, own: Own): string {
	if (own.part !== undefined && own.rId !== undefined && replaceOwn(context, own.part, bytes)) return own.rId

	return context.parts.addPart(KINDS[role], bytes, DIAGRAM_CONTENT_TYPES[role]).rId
}

// A held drawing written as a part of its own under relationship `relId` of the slide, relating the pictures it names
// (r:embed, r:link) through the targets read for it (apply/smartart.ts diagramRelationshipTargets). Undefined, adding
// nothing, when it names a picture whose target is not known.
function addDrawing(
	context: EmitContext,
	drawing: string,
	document: XmlDocument,
	relId: string
): { part: string; rId: string } | undefined {
	const parts = context.parts
	const targets = diagramRelationshipTargets(context.deck, drawing)
	const named: string[] = []

	if (
		pendDataRelationships(document, id => {
			named.push(id)

			return targets?.get(id)
		}) !== undefined &&
		(targets === undefined || named.some(id => targets.get(id) === undefined))
	)
		return undefined
	if (named.length > 0 && parts.relateFrom === undefined) return undefined

	const added = parts.addPart(KINDS.drawing, document.bytes, DIAGRAM_CONTENT_TYPES.drawing, { id: relId })

	for (const id of named) parts.relateFrom?.(added.part, targets?.get(id) as string, IMAGE_RELATIONSHIP, { id })

	return added
}

// Held data as it was (apply/smartart.ts diagramDataAsItWas: an undo's after a save rewrote the parts, a duplicated
// slide's copy) goes into the slide's own data part as it is, and the drawing it names into the part its relationship
// names (or under that id, where the slide has none now). Data with pictures goes only into a part whose relationships
// name them (its own, or this save's copy of it). Returns the data's relationship id; undefined when the parts cannot
// take them as they are.
function writeAsItWas(context: EmitContext, shape: ShapeNode, frame: DiagramFrame, document: XmlDocument, own: Own): string | undefined {
	const parts = context.parts as PartsApi & Partial<RelatingWithId>
	const relId = diagramDrawingRelId(document)
	const drawing = frame.drawing

	if (!diagramDataAsItWas(context.deck, frame.data) || own.part === undefined || own.rId === undefined) return undefined
	if (dataHasRelationships(document) && !isNamed(context, own.part, diagramRelationshipOwner(context.deck, frame.data))) return undefined
	if (relId === undefined) return replaceOwn(context, own.part, document.bytes) ? own.rId : undefined
	if (drawing === undefined) return undefined

	const type = parts.relationshipType?.(relId)

	// The id names a part of another kind here (a copied slide's): the data cannot name its drawing by it.
	if (type !== undefined && type !== RELATIONSHIP_TYPES.diagramDrawing) return undefined

	const target = parts.target(relId)

	if (isHeld(drawing)) {
		const held = context.rawDocument?.(drawing)

		if (held === undefined) return undefined

		if (target !== undefined) {
			if (sharedElsewhere(context, shape, target) || !replaceOwn(context, target, held.bytes)) return undefined
		} else if (addDrawing(context, drawing, held, relId)?.rId !== relId) return undefined
	} else if (target === undefined) {
		if (parts.relateWithId?.(drawing, RELATIONSHIP_TYPES.diagramDrawing, relId) !== true) return undefined
	} else if (!isNamed(context, target, drawing)) return undefined

	return replaceOwn(context, own.part, document.bytes) ? own.rId : undefined
}

function graphicXml(prefix: string, ids: Readonly<Record<DefinitionRole, string>>): string {
	return (
		`<${prefix}graphic><${prefix}graphicData uri="${GRAPHIC_DIAGRAM}">` +
		`<dgm:relIds xmlns:dgm="${GRAPHIC_DIAGRAM}" xmlns:r="${R_URI}" r:dm="${escapeAttribute(ids.data)}" r:lo="${escapeAttribute(ids.layout)}" r:qs="${escapeAttribute(ids.style)}" r:cs="${escapeAttribute(ids.colors)}"/>` +
		`</${prefix}graphicData></${prefix}graphic>`
	)
}

// What a frame's write names: its parts' relationship ids, and the drawing relationship its data names (`known` false
// when that data is a package part the save did not read).
interface Written {
	readonly ids: Record<DefinitionRole, string>
	readonly drawing: string | undefined
	readonly known: boolean
}

// Diagram data written as new parts: the data's relationship id, and its drawing's.
interface DataWritten {
	readonly data: string
	readonly drawing: string | undefined
}

// The relationships of the diagram's four parts, writing those the session holds (and the drawing with the data).
function writeParts(context: EmitContext, shape: ShapeNode, frame: DiagramFrame, source: SourceGraphic | undefined): Written | Refused {
	const ids: Partial<Record<DefinitionRole, string>> = {}
	const own = (role: DefinitionRole): Own => ownPart(context, shape, source, role)
	let drawing: string | undefined
	let known = true

	for (const role of ROLES) {
		const part = frame[role]

		if (part === "") return refused("malformed", `a diagram without its ${role} part`)

		if (!isHeld(part)) {
			const id = source?.ids[role]

			if (role === "data") {
				const named = packageDataDrawing(context.deck, part)

				drawing = named.relId
				known = named.known
			}

			// The part its markup names already (on a duplicated slide, this save's copy of it).
			if (id !== undefined && isNamed(context, context.parts.target(id), part)) {
				ids[role] = id

				continue
			}

			// Package data names its drawing by a relationship of the slide: a slide that names it anew (an undo past a
			// save) relates the drawing under that id, or, where the slide holds that id for another part, gets a copy of
			// the data that names the drawing by an id of its own.
			if (role === "data" && frame.drawing !== undefined && drawing !== undefined) {
				const relating = context.parts as PartsApi & Partial<RelatingWithId>
				const relId = drawing
				let target = frame.drawing
				let related: boolean

				// A drawing an undo holds again (the package lost it): written back as a part under the id the data names.
				if (isHeld(target)) {
					const document = context.rawDocument?.(target)

					if (document === undefined) return refused("stale", `the diagram part ${target} is no longer held`)

					const added = addDrawing(context, target, document, relId)

					if (added === undefined) return refused("stale", `the pictures of the diagram drawing ${target} are not known`)

					target = added.part
					related = added.rId === relId
				} else
					related =
						relating.relateWithId === undefined ||
						relating.relateWithId(
							target,
							RELATIONSHIP_TYPES.diagramDrawing,
							relId,
							current => !namedOnSlide(context, shape).has(current.toLowerCase())
						)

				if (!related) {
					const copied = writeDataCopy(context, shape, frame, part, target)

					if (isRefusal(copied)) return copied

					relating.letGo?.(part)
					ids.data = copied.data
					drawing = copied.drawing

					continue
				}
			}

			ids[role] = context.parts.relate(part, RELATIONSHIP_TYPES[KINDS[role]])

			continue
		}

		const document = context.rawDocument?.(part)

		if (document === undefined) return refused("stale", `the diagram part ${part} is no longer held`)
		if (role !== "data") {
			ids[role] = writePart(context, role, document.bytes, own(role))

			continue
		}

		// Data naming pictures an edit put in (pending ids, apply/smartart.ts setPicture): written with its drawing as new
		// parts that relate every picture themselves.
		if (pendingImageIds(document).length > 0) {
			const written = writePictureData(context, shape, frame, document)

			if (isRefusal(written)) return written

			ids.data = written.data
			drawing = written.drawing

			continue
		}

		// Data as it was (a copy's, an undo's): with its drawing, as they are.
		const kept = writeAsItWas(context, shape, frame, document, own("data"))

		if (kept !== undefined) {
			ids.data = kept
			drawing = diagramDrawingRelId(document)

			continue
		}

		// Data with pictures of its own goes back into the part whose relationships name them, with no drawing (one laid
		// out from it names the data part's relationship ids; PowerPoint lays it out again).
		if (dataHasRelationships(document)) {
			const target = own("data")
			const owner = diagramRelationshipOwner(context.deck, part)

			if (
				target.part !== undefined &&
				target.rId !== undefined &&
				isNamed(context, target.part, owner) &&
				replaceOwn(context, target.part, withDrawingReference(document, undefined))
			) {
				ids.data = target.rId
				drawing = undefined

				continue
			}

			// Its own part cannot take it: written as new parts that relate the pictures themselves, through the
			// relationships the edit read.
			const owned =
				owner === undefined
					? undefined
					: (packageDiagramData(context.deck, owner)?.targets ??
						knownTargets.get(context.deck)?.get(owner.toLowerCase()) ??
						diagramOwnerTargets(context.deck, owner))
			const targets = diagramRelationshipTargets(context.deck, part) ?? owned
			const pended = targets === undefined ? undefined : pendDataRelationships(document, id => targets.get(id))

			if (pended === undefined || isRefusal(pended))
				return refused("failed", "a diagram with pictures whose own data part cannot take the edit")

			let pictured: XmlDocument

			try {
				pictured = parseXml(pended)
			} catch {
				return refused("malformed", "diagram data")
			}

			const written = writePictureData(context, shape, frame, pictured)

			if (isRefusal(written)) return written

			ids.data = written.data
			drawing = written.drawing

			continue
		}

		// The drawing first: the data part names it. A data part that held pictures is never replaced in place (its
		// relationships would stay with it): the diagram is written as new parts and the old ones stay, so an undo past
		// this save names them again, pictures and all (as a replaced picture's image stays).
		const box = shape.xfrm
		const drawingXml =
			box === undefined ? undefined : rememberedDrawing(document, drawingKey(frame.layout, frame.style, frame.colors, box.cx, box.cy))
		const previous = own("data")
		const pictured = previous.part !== undefined && diagramDataHadPictures(context.deck, previous.part)
		const detached = detachedDrawingRelId(document)
		const oldDrawing = detached === undefined ? undefined : drawingTarget(context, detached)
		const fresh = pictured || oldDrawing === undefined || sharedElsewhere(context, shape, oldDrawing)

		drawing =
			drawingXml === undefined
				? undefined
				: writePart(context, "drawing", encodeUtf8(drawingXml), fresh ? NOT_OWN : { part: oldDrawing, rId: detached })
		ids.data = writePart(context, "data", withDrawingReference(document, drawing), pictured ? NOT_OWN : previous)
	}

	return { ids: ids as Record<DefinitionRole, string>, drawing, known }
}

// A diagram whose data names pictures by pending ids: its drawing (when laid out) and its data written as new parts,
// each picture related from both under the same id (rId1… in parts that have no other relationships), an inserted
// image stored once per save (the save's shared part for its bytes; a committed save's part related again), the
// parts the frame had before kept for an undo past the save. Returns the data's and the drawing's relationship ids.
function writePictureData(context: EmitContext, shape: ShapeNode, frame: DiagramFrame, document: XmlDocument): DataWritten | Refused {
	const parts = context.parts
	const pending = pendingImageIds(document)
	const ids = new Map(pending.map((id, index) => [id, `rId${String(index + 1)}`]))
	const box = shape.xfrm
	const drawingXml =
		box === undefined ? undefined : rememberedDrawing(document, drawingKey(frame.layout, frame.style, frame.colors, box.cx, box.cy))
	let drawing: { part: string; rId: string } | undefined

	if (parts.relateFrom === undefined) return refused("failed", "this writer cannot relate a diagram's pictures")

	if (drawingXml !== undefined) {
		let bytes: Uint8Array

		try {
			bytes = withImageRelationships(parseXml(encodeUtf8(drawingXml)), ids)
		} catch {
			return refused("malformed", "a laid-out diagram drawing")
		}

		drawing = parts.addPart(KINDS.drawing, bytes, DIAGRAM_CONTENT_TYPES.drawing)
	}

	let dataBytes: Uint8Array

	try {
		dataBytes = withImageRelationships(parseXml(withDrawingReference(document, drawing?.rId)), ids)
	} catch {
		return refused("malformed", "diagram data")
	}

	const data = parts.addPart(KINDS.data, dataBytes, DIAGRAM_CONTENT_TYPES.data)

	for (const [pendingId, rId] of ids) {
		let target: string

		if (pendingId.startsWith(INSERTED_IMAGE_ID)) {
			const registry = Number(pendingId.slice(INSERTED_IMAGE_ID.length))
			const image = insertedImage(context.deck, registry)

			if (image !== undefined) {
				target = parts.addPart("image", image.bytes, image.contentType, { from: data.part, id: rId, shared: image.bytes }).part
			} else {
				const saved = insertedImageWritten(context.deck, registry)

				if (saved === undefined) return refused("stale", `the inserted image ${String(registry)} is not held`)

				target = saved.part
			}
		} else {
			target = pendingId.slice(PART_IMAGE_ID.length)

			if (parts.has?.(target) === false) return refused("stale", `the picture ${target} is no longer in the package`)
		}

		// A part this save had stored already for the same bytes is related here too.
		if (parts.targetFrom?.(data.part, rId) === undefined) parts.relateFrom(data.part, target, IMAGE_RELATIONSHIP, { id: rId })
		if (drawing !== undefined) parts.relateFrom(drawing.part, target, IMAGE_RELATIONSHIP, { id: rId })
	}

	// The frame's earlier parts stay as they are: an undo past this save names them again, their pictures with them.
	return { data: data.rId, drawing: drawing?.rId }
}

// A new frame (Insert ▸ SmartArt): written whole from the model (a copy of one names its parts by `ids` too).
export function newFrame(shape: ShapeNode, ids: Readonly<Record<DefinitionRole, string>>): EmitResult {
	const xfrm = shape.xfrm

	if (xfrm === undefined) return refused("malformed", "a new diagram without its box")

	const markup =
		`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr${attr("id", shape.id)}${attr("name", shape.name)}${attr("descr", shape.alt?.descr)}${attr("title", shape.alt?.title)}${shape.hidden ? ' hidden="1"' : ""}/>` +
		`<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrmXml("p:xfrm", xfrm, false)}${graphicXml("a:", ids)}</p:graphicFrame>`

	return { kind: "markup", pieces: [markup] }
}

// Whether the frame names the parts its source's dgm:relIds name (on a duplicated slide, this save's copies of them):
// an undo past a save may name the package parts an earlier save wrote instead.
function namesSourceParts(context: EmitContext, source: SourceGraphic | undefined, frame: DiagramFrame): boolean {
	if (source === undefined) return true

	return ROLES.every(role => {
		const id = source.ids[role]
		const target = id === undefined ? undefined : context.parts.target(id)

		return target === undefined || isNamed(context, target, frame[role])
	})
}

function emitDiagram(context: EmitContext, shape: ShapeNode): EmitResult {
	const frame = shape.frame
	const source = sourceGraphic(context, shape)

	// A diagram whose parts are all the package's: the shape family keeps its a:graphic as written (a new frame naming
	// parts a save wrote, an insert redone after it, is written whole below).
	if (
		frame?.kind !== "smartart" ||
		(!heldParts(frame) && sourceNode(context, shape.src) >= 0 && namesSourceParts(context, source, frame))
	)
		return shapeElement(context, shape)

	const written = writeParts(context, shape, frame, source)

	if (isRefusal(written)) return written

	if (heldParts(frame)) noteDiagramFrameWritten(frame)

	const ids = written.ids

	if (source === undefined) {
		if (sourceNode(context, shape.src) >= 0) return refused("malformed", "a diagram frame without dgm:relIds")

		return newFrame(shape, ids)
	}

	const element = shapeElement(context, shape)

	if (element.kind !== "markup") return element

	releaseUnnamed(context, shape, source, written)

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

// A copy of package data part `part` for a slide that holds the id its drawing relationship has for another part: the
// copy names `drawing` by a relationship of its own; data with pictures of its own relates them itself.
function writeDataCopy(context: EmitContext, shape: ShapeNode, frame: DiagramFrame, part: string, drawing: string): DataWritten | Refused {
	const data = packageDiagramData(context.deck, part)

	if (data === undefined) return refused("failed", `the diagram data ${part} names a relationship this slide holds for another part`)

	if (dataHasRelationships(data.document)) {
		const pended = pendDataRelationships(data.document, id => data.targets.get(id))

		if (pended === undefined || isRefusal(pended)) return refused("failed", `the pictures of the diagram data ${part}`)

		let own: XmlDocument

		try {
			own = parseXml(pended)
		} catch {
			return refused("malformed", "diagram data")
		}

		return writePictureData(context, shape, frame, own)
	}

	const drawingId = context.parts.relate(drawing, RELATIONSHIP_TYPES.diagramDrawing)

	return {
		data: context.parts.addPart(KINDS.data, withDrawingReference(data.document, drawingId), DIAGRAM_CONTENT_TYPES.data).rId,
		drawing: drawingId
	}
}

// The parts of the slide's frames other than `shape`, by key.
function namedOnSlide(context: EmitContext, shape: ShapeNode): Set<string> {
	const out = new Set<string>()
	const contains = (shapes: readonly ShapeNode[], depth: number): boolean =>
		depth <= 128 && shapes.some(each => each === shape || (each.children !== undefined && contains(each.children, depth + 1)))
	const collect = (shapes: readonly ShapeNode[], depth: number): void => {
		if (depth > 128) return

		for (const each of shapes) {
			const frame = each.frame

			if (each !== shape && frame?.kind === "smartart")
				for (const part of [...ROLES.map(role => frame[role]), frame.drawing]) if (part !== undefined) out.add(part.toLowerCase())
			if (each.children !== undefined) collect(each.children, depth + 1)
		}
	}

	for (const node of context.deck.nodes.values()) if (contains(node.shapes, 0)) collect(node.shapes, 0)

	return out
}

function walkShapes(shapes: readonly ShapeNode[], depth: number, visit: (shape: ShapeNode) => void): void {
	if (depth > 128) return

	for (const shape of shapes) {
		visit(shape)

		if (shape.children !== undefined) walkShapes(shape.children, depth + 1, visit)
	}
}

function containsShape(shapes: readonly ShapeNode[], shape: ShapeNode, depth: number): boolean {
	return (
		depth <= 128 &&
		shapes.some(each => each === shape || (each.children !== undefined && containsShape(each.children, shape, depth + 1)))
	)
}

// The slide's diagram relationships a written frame leaves unnamed go: those its source markup named for parts it
// writes elsewhere now, and drawings no diagram data of the slide names (one its data stopped naming). Their parts go
// with the save once nothing relates them and no step the history holds names them.
function releaseUnnamed(context: EmitContext, shape: ShapeNode, source: SourceGraphic, written: Written): void {
	const parts = context.parts as PartsApi & Partial<RelatingWithId>
	const document = context.document

	if (document === undefined || parts.unrelate === undefined || parts.letGo === undefined || parts.relationshipIds === undefined) return

	const candidates = new Set<string>()

	for (const role of ROLES) {
		const id = source.ids[role]

		if (id !== undefined && id !== written.ids[role]) candidates.add(id)
	}

	const named = new Set<string>(ROLES.map(role => written.ids[role]))
	let known = written.known

	if (written.drawing !== undefined) named.add(written.drawing)

	// The drawings the slide's other diagrams' data name (held data: the one an edit detached too, written back there).
	for (const node of context.deck.nodes.values()) {
		if (!containsShape(node.shapes, shape, 0)) continue

		walkShapes(node.shapes, 0, each => {
			const other = each.frame

			if (each === shape || other?.kind !== "smartart") return

			if (isHeld(other.data)) {
				const data = context.rawDocument?.(other.data)

				if (data === undefined) known = false

				for (const id of data === undefined ? [] : [diagramDrawingRelId(data), detachedDrawingRelId(data)])
					if (id !== undefined) named.add(id)

				return
			}

			const drawing = packageDataDrawing(context.deck, other.data)

			if (!drawing.known) known = false
			else if (drawing.relId !== undefined) named.add(drawing.relId)
		})
	}

	if (known) for (const id of parts.relationshipIds(RELATIONSHIP_TYPES.diagramDrawing)) candidates.add(id)
	if (candidates.size === 0) return

	// Any id the slide's other markup names (an attribute outside this frame's a:graphic) stays.
	const from = document.start(source.graphic)
	const to = document.end(source.graphic)

	for (let node = 1; node < document.count; node++) {
		if (document.kind(node) !== NodeKind.Element || (document.start(node) >= from && document.end(node) <= to)) continue

		for (const attribute of document.attributes(node)) named.add(attribute.value)
	}

	for (const id of candidates) {
		if (named.has(id)) continue

		const target = parts.target(id)

		parts.unrelate(id)

		if (target !== undefined) parts.letGo(target)
	}
}

export const emitPptxSmartArt: PptxEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		return shape === undefined ? refused("failed", "A diagram emit without a shape") : emitDiagram(context, shape)
	}
}

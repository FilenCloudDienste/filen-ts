import { D, drawingReader } from "../../../drawingml/reader"
import {
	DIAGRAM_CONTENT_TYPES,
	DIAGRAM_PARTS,
	dataHasRelationships,
	definitionIds,
	detachDrawingCache,
	editDiagramData,
	newDiagramData,
	pendDataRelationships,
	type DiagramEdit,
	type DiagramPart
} from "../../../smartart/edit"
import { smartArtColorsDef, smartArtLayoutDef, smartArtStyleDef } from "../../../smartart/gallery/defs"
import { SMARTART_COLORS, SMARTART_STYLES } from "../../../smartart/gallery/index"
import { encodeUtf8, parseXml, type XmlDocument } from "../../../xml/index"
import { refused, type Deck, type FrameRef, type Refused, type ShapeNode, type ShapeRef, type SlideNode, type SlideRef } from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Touch } from "../apply"
import { findShape } from "../changes"
import { matcherOf } from "../find"
import type { DeckOp, RawPart, SmartArtDefRef, SmartArtOp } from "../ops"
import { INSERTED_IMAGE_ID } from "../../../smartart/emit"
import { imageWithinBudget } from "../../../opc/mediaPolicy"
import { DEFAULT_PRESENTATION_BUDGETS } from "../../budget"
import { registerInsertedImage } from "./picture"
import { applyShape } from "./shape"
import { isRefused } from "../../refusal"
import { sameBytes } from "../../../docx/write/bytes"

// Applies the smartart ops: each edit makes the diagram's data part anew (core/smartart/edit.ts), holds it beside the
// package (a "raw:N" part the renderer, later ops and the writer resolve) and points the frame at it with no drawing
// cache, so the diagram is laid out again; a switch of layout, style or colours holds the chosen definition the same
// way. The inverse is a restore of the frame's parts as they were, by bytes (an inverse survives a save's rebase): a
// part still held with those bytes is named again, else read back from them. Insert makes a frame whose parts are all
// held; its inverse is the shape family's delete. The parts are read before the op applies (the engine's prepare,
// diagramPartsToRead), so apply stays synchronous.

// What apply reads diagram parts through (the engine's apply context adds it).
export interface SmartArtSourceReading {
	// A diagram part's document: a package part read before the op, or one an earlier op held. Undefined when not read.
	diagramDocument(part: string): XmlDocument | undefined
	// Holds a document an op made under a new name the renderer, later ops and the writer resolve; under `name` when
	// that is a held name nothing holds now (an undo's restore holds its part under the name it had).
	holdDiagram(document: XmlDocument, name?: string): string
	// Drops a held part no diagram names any more (an undo holds it again from the bytes its inverse keeps).
	releaseDiagram?(name: string): void
	// The package's parts of a content type (the deck's own definitions, whichever diagram names them now).
	partsOfType?(contentType: string): readonly string[]
	// The part relationship `id` of package part `part` names ("/ppt/media/image1.png"), read before the op (a
	// setPicture on a diagram whose data holds pictures); undefined when none or external.
	diagramRelationshipTarget?(part: string, id: string): string | undefined
}

// Find & Replace in a diagram (FIND_IN_SMARTART's node index and offsets), written out so this family compiles before
// and after the op union carries it.
interface SmartArtReplace {
	readonly family: "smartart"
	readonly kind: "replace"
	readonly target: ShapeRef
	readonly query: string
	readonly replacement: string
	readonly caseSensitive?: boolean
	readonly wholeWord?: boolean
	readonly match?: readonly [number, number, number]
}

type SmartArtSetPicture = Extract<SmartArtOp, { readonly kind: "setPicture" }>

type Op = SmartArtOp | SmartArtReplace
type DiagramFrame = Extract<FrameRef, { kind: "smartart" }>

// The names the session holds parts under (the writer's raw sources).
const HELD_PREFIX = "raw:"
const DEFINITION_ROOTS = { layout: "layoutDef", style: "styleDef", colors: "colorsDef" } as const
const MAX_GROUP_DEPTH = 128
const NO_INVERSE = { ops: [], bytes: 0 } as const
const NONE: readonly string[] = []

function readingOf(context: ApplyContext): SmartArtSourceReading | undefined {
	const candidate = context as ApplyContext & Partial<SmartArtSourceReading>

	return typeof candidate.diagramDocument === "function" && typeof candidate.holdDiagram === "function"
		? (candidate as ApplyContext & SmartArtSourceReading)
		: undefined
}

function diagramAt(deck: Deck, target: ShapeRef): { node: SlideNode; shape: ShapeNode; frame: DiagramFrame } | Refused {
	const node = deck.nodes.get(target.slide)

	if (node === undefined) return refused("notFound", `slide ${String(target.slide)} is not parsed`)

	const shape = findShape(node.shapes, target.id)?.shape
	const frame = shape?.frame

	if (shape === undefined) return refused("notFound", `shape ${String(target.id)}`)
	if (frame?.kind !== "smartart") return refused("unsupported", `a ${shape.kind} is no diagram`)
	if (shape.lock !== undefined) return refused("locked", shape.lock)

	return { node, shape, frame }
}

function* diagramFrames(shapes: readonly ShapeNode[], depth = 0): Generator<DiagramFrame> {
	if (depth > MAX_GROUP_DEPTH) return

	for (const shape of shapes) {
		if (shape.frame?.kind === "smartart") yield shape.frame
		if (shape.children !== undefined) yield* diagramFrames(shape.children, depth + 1)
	}
}

function definitionKind(op: Op): "layout" | "style" | "colors" | undefined {
	switch (op.kind) {
		case "insert":
		case "setLayout":
			return "layout"
		case "setStyle":
			return "style"
		case "setColors":
			return "colors"
		default:
			return undefined
	}
}

// The content type of the deck's own definitions an op looks among (the engine reads the package's parts of it first).
export function deckDefinitionType(op: DeckOp): string | undefined {
	if (op.family !== "smartart") return undefined

	const kind = definitionKind(op)
	const ref =
		op.kind === "insert" ? op.layout : op.kind === "setLayout" || op.kind === "setStyle" || op.kind === "setColors" ? op.def : undefined

	return kind === undefined || ref?.source !== "deck" ? undefined : DIAGRAM_CONTENT_TYPES[kind]
}

// The parts an op reads: the target frame's, a restore's, and for a definition the deck embeds, every parsed
// diagram's part of that kind (the engine reads them before the op applies).
export function diagramPartsToRead(deck: Deck, op: Op): string[] {
	const out = new Set<string>()

	if (op.kind !== "insert") {
		const frame = findShape(deck.nodes.get(op.target.slide)?.shapes ?? [], op.target.id)?.shape.frame

		if (frame?.kind === "smartart") {
			for (const name of DIAGRAM_PARTS) {
				const part = frame[name]

				if (part !== undefined && part !== "") out.add(part)
			}
		}
	}

	if (op.kind === "restore") for (const part of op.parts) out.add(part.name)

	const kind = definitionKind(op)
	const ref =
		op.kind === "insert" ? op.layout : op.kind === "setLayout" || op.kind === "setStyle" || op.kind === "setColors" ? op.def : undefined

	if (kind !== undefined && ref?.source === "deck") {
		for (const node of deck.nodes.values()) for (const frame of diagramFrames(node.shapes)) if (frame[kind] !== "") out.add(frame[kind])
	}

	return [...out]
}

// A definition's document, and the part that holds it when it is the deck's own.
interface Definition {
	readonly document: XmlDocument
	readonly part?: string
}

// A layout, style or colours definition: our gallery's, or one a diagram of this deck embeds (the file's own
// definitions serve that file only).
function definition(
	deck: Deck,
	reading: SmartArtSourceReading,
	kind: "layout" | "style" | "colors",
	ref: SmartArtDefRef
): Definition | Refused {
	if (ref.source === "gallery") {
		const text =
			kind === "layout"
				? smartArtLayoutDef(ref.uniqueId)
				: kind === "style"
					? smartArtStyleDef(ref.uniqueId)
					: smartArtColorsDef(ref.uniqueId)

		if (text === undefined) return refused("notFound", `${kind} ${ref.uniqueId}`)

		try {
			return { document: parseXml(encodeUtf8(text)) }
		} catch {
			return refused("malformed", `${kind} ${ref.uniqueId}`)
		}
	}

	const candidates = new Set<string>()

	for (const node of deck.nodes.values())
		for (const frame of diagramFrames(node.shapes)) if (frame[kind] !== "") candidates.add(frame[kind])
	for (const part of reading.partsOfType?.(DIAGRAM_CONTENT_TYPES[kind]) ?? []) candidates.add(part)

	for (const part of candidates) {
		const document = reading.diagramDocument(part)

		if (document === undefined) continue

		const root = document.documentElement()
		const reader = drawingReader(document)

		if (reader.is(root, D.Dgm, DEFINITION_ROOTS[kind]) && reader.attr(root, "uniqueId") === ref.uniqueId) return { document, part }
	}

	return refused("notFound", `${kind} ${ref.uniqueId} in this deck`)
}

// The frame's parts as they are now, by bytes (the inverse's restore).
function heldParts(frame: DiagramFrame, reading: SmartArtSourceReading): RawPart[] | Refused {
	const out: RawPart[] = []

	for (const name of DIAGRAM_PARTS) {
		const part = frame[name]

		if (part === undefined || part === "") continue

		const document = reading.diagramDocument(part)

		if (document === undefined) {
			// A drawing cache the package lacks (a dangling relationship) has nothing to hold: the frame names it again.
			if (name === "drawing") {
				out.push({ name: part, contentType: DIAGRAM_CONTENT_TYPES.drawing, bytes: new Uint8Array(0) })

				continue
			}

			return refused("notFound", `diagram part ${part} not read`)
		}

		out.push({ name: part, contentType: DIAGRAM_CONTENT_TYPES[name], bytes: document.bytes })
	}

	return out
}

function inverseOf(target: ShapeRef, parts: readonly RawPart[]): { ops: DeckOp[]; bytes: number } {
	let bytes = 0

	for (const part of parts) bytes += part.bytes.length + part.name.length * 2

	return { ops: [{ family: "smartart", kind: "restore", target, parts }], bytes }
}

function hold(reading: SmartArtSourceReading, bytes: Uint8Array, name?: string): string | Refused {
	try {
		return reading.holdDiagram(parseXml(bytes), name)
	} catch {
		return refused("malformed", "diagram part")
	}
}

function holdData(reading: SmartArtSourceReading, bytes: Uint8Array): string | Refused {
	try {
		return hold(reading, detachDrawingCache(parseXml(bytes)))
	} catch {
		return refused("malformed", "diagram data")
	}
}

function isHeld(part: string): boolean {
	return part.startsWith(HELD_PREFIX)
}

// Points the frame at its new parts; the held parts it named before that no diagram names now are dropped (bounded
// memory over a long editing session: an inverse keeps their bytes).
function setFrame(deck: Deck, reading: SmartArtSourceReading, node: SlideNode, shape: ShapeNode, frame: DiagramFrame): void {
	const before = shape.frame?.kind === "smartart" ? shape.frame : undefined

	shape.frame = frame
	node.revision++

	if (before === undefined || reading.releaseDiagram === undefined) return

	const named = new Set<string>()

	for (const each of deck.nodes.values())
		for (const other of diagramFrames(each.shapes)) for (const part of DIAGRAM_PARTS) named.add(other[part] ?? "")

	for (const part of DIAGRAM_PARTS) {
		const name = before[part]

		if (name !== undefined && isHeld(name) && !named.has(name)) reading.releaseDiagram(name)
	}
}

interface Editing {
	readonly reading: SmartArtSourceReading
	readonly node: SlideNode
	readonly shape: ShapeNode
	readonly frame: DiagramFrame
	readonly data: XmlDocument
	readonly back: RawPart[]
	readonly owner: string | undefined
}

// Data parts with relationships of their own (pictures in placeholders): each held edit's part → the package data part
// whose relationships it keeps. The writer saves the edit into that part (its relationships stay), the renderer reads
// the edit's pictures through it.
const relationshipOwners = new WeakMap<Deck, Map<string, string>>()

// Package data parts that held pictures of their own when an op read them: a writer that writes the diagram without
// them writes new parts (a part's relationships stay with it when its bytes are replaced in place).
const picturedParts = new WeakMap<Deck, Set<string>>()

export function diagramDataHadPictures(deck: Deck, part: string): boolean {
	return picturedParts.get(deck)?.has(part) === true
}

function notePictured(deck: Deck, reading: SmartArtSourceReading, frame: DiagramFrame): void {
	if (isHeld(frame.data)) return

	const document = reading.diagramDocument(frame.data)

	if (document === undefined || !dataHasRelationships(document)) return

	let parts = picturedParts.get(deck)

	if (parts === undefined) {
		parts = new Set()
		picturedParts.set(deck, parts)
	}

	parts.add(frame.data)
}

export function diagramRelationshipOwner(deck: Deck, part: string): string | undefined {
	return relationshipOwners.get(deck)?.get(part)
}

// The relationship (of the slide) a data part's dsp:dataModelExt names its drawing cache by (MS-ODRAWXML §2.3.4);
// undefined when it names none or an edit detached it.
export function diagramDrawingRelId(document: XmlDocument): string | undefined {
	const reader = drawingReader(document)
	let relId: string | undefined

	for (const ext of reader.children(reader.child(document.documentElement(), D.Dgm, "extLst"), D.A, "ext")) {
		const model = reader.child(ext, D.Dsp, "dataModelExt")

		if (model >= 0) relId = reader.attr(model, "relId")
	}

	return relId === "" ? undefined : relId
}

// Held data that is a package part's bytes as they were (an undo's after a save rewrote that part, a duplicated
// slide's copy): the writer writes it as it is, with the drawing it names, and it is not laid out again. By name, kept
// when the name is released (an undo holds the bytes again under it).
const asItWas = new WeakMap<Deck, Set<string>>()

export function diagramDataAsItWas(deck: Deck, held: string): boolean {
	return asItWas.get(deck)?.has(held) === true
}

function noteAsItWas(deck: Deck, held: string): void {
	let names = asItWas.get(deck)

	if (names === undefined) {
		names = new Set()
		asItWas.set(deck, names)
	}

	names.add(held)
}

// The frames (by object: an edit makes a new one; a copied slide's writer may emit a copy of the shape) a save's
// writer wrote the held parts of, for the rebase to bind them to the parts written once that save lands.
const writtenFrames = new WeakSet<object>()

export function noteDiagramFrameWritten(frame: DiagramFrame): void {
	writtenFrames.add(frame)
}

export function diagramFrameWritten(frame: DiagramFrame): boolean {
	return writtenFrames.has(frame)
}

// The relationship (of a slide) a package data part's dsp:dataModelExt names its drawing by, as a save wrote it: a slide
// that comes to name that data again (a redo after an undo-all) relates the drawing under that id.
const packageDrawingRels = new WeakMap<Deck, Map<string, string>>()

export function notePackageDrawingRel(deck: Deck, data: string, relId: string): void {
	let map = packageDrawingRels.get(deck)

	if (map === undefined) {
		map = new Map()
		packageDrawingRels.set(deck, map)
	}

	map.set(data.toLowerCase(), relId)
}

export function packageDrawingRel(deck: Deck, data: string): string | undefined {
	return packageDrawingRels.get(deck)?.get(data.toLowerCase())
}

// The diagram frames (by object) a save's snapshot saw: the rebase binds those it wrote to the parts written; one an
// edit replaced since is the edit's.
const snapshotFrames = new WeakMap<Deck, WeakSet<object>>()

export function noteSnapshotFrames(deck: Deck): void {
	const frames = new WeakSet<object>()
	const visit = (shapes: readonly ShapeNode[], depth: number): void => {
		if (depth > MAX_GROUP_DEPTH) return

		for (const shape of shapes) {
			if (shape.frame?.kind === "smartart") frames.add(shape.frame)
			if (shape.children !== undefined) visit(shape.children, depth + 1)
		}
	}

	for (const node of deck.nodes.values()) visit(node.shapes, 0)

	snapshotFrames.set(deck, frames)
}

export function frameInSnapshot(deck: Deck, frame: object): boolean {
	return snapshotFrames.get(deck)?.has(frame) ?? false
}

// The parts a held data's own relationships name (by relationship id, through its owner's relationships), for a writer
// that writes it into parts of its own (the slide's part is not the owner): an edit's data, when every one is a part.
const relationshipTargets = new WeakMap<Deck, Map<string, ReadonlyMap<string, string>>>()

export function diagramRelationshipTargets(deck: Deck, held: string): ReadonlyMap<string, string> | undefined {
	return relationshipTargets.get(deck)?.get(held)
}

// The parts each package data part's picture relationships name, as an op read them (by owner): held data that names
// its pictures through a part a later save dropped relates them through these.
const ownerTargets = new WeakMap<Deck, Map<string, Map<string, string>>>()

function ownerKey(owner: string): string {
	return (owner.startsWith("/") ? owner.slice(1) : owner).toLowerCase()
}

export function diagramOwnerTargets(deck: Deck, owner: string): ReadonlyMap<string, string> | undefined {
	return ownerTargets.get(deck)?.get(ownerKey(owner))
}

function noteOwnerTargets(deck: Deck, owner: string, targets: ReadonlyMap<string, string>): void {
	let owners = ownerTargets.get(deck)

	if (owners === undefined) {
		owners = new Map()
		ownerTargets.set(deck, owners)
	}

	const known = owners.get(ownerKey(owner)) ?? new Map<string, string>()

	for (const [id, part] of targets) known.set(id, part)

	owners.set(ownerKey(owner), known)
}

function noteTargets(deck: Deck, held: string, data: XmlDocument, owner: string | undefined, reading: SmartArtSourceReading): void {
	const target = reading.diagramRelationshipTarget

	if (owner === undefined || target === undefined) return

	const targets = new Map<string, string>()
	const pended = pendDataRelationships(data, id => {
		const part = target(owner, id)

		if (part !== undefined) targets.set(id, part)

		return part
	})

	if (pended === undefined || isRefused(pended)) return

	noteOwnerTargets(deck, owner, targets)

	let map = relationshipTargets.get(deck)

	if (map === undefined) {
		map = new Map()
		relationshipTargets.set(deck, map)
	}

	map.set(held, targets)
}

function noteOwner(deck: Deck, held: string, owner: string | undefined): void {
	if (owner === undefined) return

	let owners = relationshipOwners.get(deck)

	if (owners === undefined) {
		owners = new Map()
		relationshipOwners.set(deck, owners)
	}

	owners.set(held, owner)
}

// The package data part whose relationships a picture-holding diagram's data names its pictures by: its own, or the
// one its held edit keeps them through. Where the slide's own part is not that one, the writer writes the edit into
// parts of its own that relate the pictures themselves (emit/smartart.ts).
function pictureOwner(data: string, deck: Deck): string | Refused {
	const owner = isHeld(data) ? diagramRelationshipOwner(deck, data) : data

	return owner ?? refused("unsupported", "a diagram with pictures whose data part is not the package's")
}

// What every edit of a diagram needs: the frame, its data part (with relationships of its own, the package part that
// keeps them: `owner`) and its parts as they are, for the inverse.
function editing(deck: Deck, target: ShapeRef, context: ApplyContext): Editing | Refused {
	const reading = readingOf(context)

	if (reading === undefined) return refused("unsupported", "diagrams cannot be edited in this format")

	const found = diagramAt(deck, target)

	if (isRefused(found)) return found

	const data = reading.diagramDocument(found.frame.data)

	if (data === undefined) return refused("notFound", `diagram data ${found.frame.data} not read`)

	notePictured(deck, reading, found.frame)

	const owner = dataHasRelationships(data) ? pictureOwner(found.frame.data, deck) : undefined

	if (owner !== undefined && isRefused(owner)) return owner

	const back = heldParts(found.frame, reading)

	if (isRefused(back)) return back

	return { reading, ...found, data, back, owner }
}

// An edit of the data part: the frame names the new data with no drawing.
function editData(deck: Deck, op: Exclude<Op, { kind: "insert" }>, edit: DiagramEdit, context: ApplyContext): ApplyResult<SmartArtOp> {
	const at = editing(deck, op.target, context)

	if (isRefused(at)) return at

	const result = editDiagramData(at.data, edit)

	if (isRefused(result)) return result
	if (result.kind === "unchanged") return { kind: "applied", inverse: NO_INVERSE, op: op as SmartArtOp }

	const name = hold(at.reading, result.bytes)

	if (isRefused(name)) return name

	noteOwner(deck, name, at.owner)
	noteTargets(deck, name, at.data, at.owner, at.reading)

	const { drawing: _drawing, ...rest } = at.frame

	setFrame(deck, at.reading, at.node, at.shape, { ...rest, data: name })

	const applied = op.kind === "addNode" && result.id !== undefined && op.id !== result.id ? { ...op, id: result.id } : op

	return { kind: "applied", inverse: inverseOf(op.target, at.back), op: applied as SmartArtOp }
}

function setDefinition(
	deck: Deck,
	op: SmartArtOp & { readonly kind: "setLayout" | "setStyle" | "setColors" },
	context: ApplyContext
): ApplyResult<SmartArtOp> {
	const at = editing(deck, op.target, context)

	if (isRefused(at)) return at

	const kind = definitionKind(op) ?? "layout"
	const found = definition(deck, at.reading, kind, op.def)

	if (isRefused(found)) return found

	const ids = definitionIds(found.document)
	const pictureName = kind === "layout" ? picturePlaceholderName(found.document) : undefined
	const result = editDiagramData(at.data, {
		kind: "setDefinition",
		which: kind,
		uniqueId: ids.uniqueId,
		...(ids.category === undefined ? {} : { category: ids.category }),
		...(pictureName === undefined ? {} : { pictureName })
	})

	if (isRefused(result)) return result
	if (result.kind === "unchanged") return { kind: "applied", inverse: NO_INVERSE, op }

	const dataName = hold(at.reading, result.bytes)

	if (isRefused(dataName)) return dataName

	noteOwner(deck, dataName, at.owner)
	noteTargets(deck, dataName, at.data, at.owner, at.reading)

	const { drawing: _drawing, ...rest } = at.frame
	// A definition of the deck's own is named where it is; one of the gallery is held.
	setFrame(deck, at.reading, at.node, at.shape, { ...rest, data: dataName, [kind]: found.part ?? at.reading.holdDiagram(found.document) })

	return { kind: "applied", inverse: inverseOf(op.target, at.back), op }
}

// The name of a layout's first picture placeholder (the layoutNode whose dgm:shape has blipPhldr), if any.
function picturePlaceholderName(layout: XmlDocument): string | undefined {
	const reader = drawingReader(layout)

	for (let node = 1; node < layout.count; node++) {
		if (!reader.is(node, D.Dgm, "shape") || !reader.bool(node, "blipPhldr", false)) continue

		for (let at = layout.parent(node); at > 0; at = layout.parent(at))
			if (reader.is(at, D.Dgm, "layoutNode")) return reader.attr(at, "name") ?? ""
	}

	return undefined
}

// The image types a placeholder takes (the page's preparePicture pipeline re-encodes anything else).
const PICTURE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/svg+xml"])

// A picture into a placeholder: the data part's own pictures first named by their parts (so the edit needs no
// relationships of the part it came from: the writer relates every picture from the part it writes), the image into
// the deck's registry (named "inserted:<id>" until a save gives it a part), then the placeholder's presentation point
// filled with it. One undo step: the inverse restores the frame's parts as they were.
function setPicture(deck: Deck, op: SmartArtSetPicture, context: ApplyContext): ApplyResult<SmartArtOp> {
	const reading = readingOf(context)

	if (reading === undefined) return refused("unsupported", "diagrams cannot be edited in this format")
	if (!PICTURE_TYPES.has(op.image.contentType)) return refused("unsupported", `a ${op.image.contentType} picture`)
	if (op.image.bytes.length === 0 || !(op.image.width > 0) || !(op.image.height > 0)) return refused("malformed", "an empty picture")
	if (op.image.width * op.image.height > DEFAULT_PRESENTATION_BUDGETS.decodedPixels || !imageWithinBudget(op.image.bytes))
		return refused("tooLarge", "the picture")

	const found = diagramAt(deck, op.target)

	if (isRefused(found)) return found

	let data = reading.diagramDocument(found.frame.data)

	if (data === undefined) return refused("notFound", `diagram data ${found.frame.data} not read`)

	notePictured(deck, reading, found.frame)

	const back = heldParts(found.frame, reading)

	if (isRefused(back)) return back

	if (dataHasRelationships(data)) {
		const owner = isHeld(found.frame.data) ? diagramRelationshipOwner(deck, found.frame.data) : found.frame.data
		const target = reading.diagramRelationshipTarget

		if (owner === undefined || target === undefined) return refused("unsupported", "a diagram whose pictures cannot be read")

		const read = new Map<string, string>()
		const pended = pendDataRelationships(data, id => {
			const part = target(owner, id)

			if (part !== undefined) read.set(id, part)

			return part
		})

		noteOwnerTargets(deck, owner, read)

		if (isRefused(pended)) return pended

		if (pended !== undefined) {
			try {
				data = parseXml(pended)
			} catch {
				return refused("malformed", "diagram data")
			}
		}
	}

	const inserted = registerInsertedImage(deck, op.image, op.inserted)
	const result = editDiagramData(data, {
		kind: "setPicture",
		node: op.node,
		placeholder: op.placeholder,
		embed: `${INSERTED_IMAGE_ID}${String(inserted)}`,
		...(op.crop === undefined ? {} : { crop: op.crop })
	})

	if (isRefused(result)) return result
	if (result.kind === "unchanged") return { kind: "applied", inverse: NO_INVERSE, op }

	const name = hold(reading, result.bytes)

	if (isRefused(name)) return name

	const { drawing: _drawing, ...rest } = found.frame

	setFrame(deck, reading, found.node, found.shape, { ...rest, data: name })

	return { kind: "applied", inverse: inverseOf(op.target, back), op: { ...op, inserted } }
}

function restore(deck: Deck, op: SmartArtOp & { readonly kind: "restore" }, context: ApplyContext): ApplyResult<SmartArtOp> {
	const reading = readingOf(context)

	if (reading === undefined) return refused("unsupported", "diagrams cannot be edited in this format")

	const found = diagramAt(deck, op.target)

	if (isRefused(found)) return found

	notePictured(deck, reading, found.frame)

	const back = heldParts(found.frame, reading)

	if (isRefused(back)) return back

	const names: Partial<Record<DiagramPart, string>> = {}
	let rewritten: RawPart | undefined

	for (const part of op.parts) {
		const role = DIAGRAM_PARTS.find(name => DIAGRAM_CONTENT_TYPES[name] === part.contentType)

		if (role === undefined) return refused("malformed", `diagram part ${part.name}`)

		const live = reading.diagramDocument(part.name)

		if ((live !== undefined && sameBytes(live.bytes, part.bytes)) || (role === "drawing" && part.bytes.length === 0)) {
			names[role] = part.name

			continue
		}

		// A package data part a save has rewritten since is held once the drawing is known (below).
		if (role === "data" && !isHeld(part.name)) {
			rewritten = part

			continue
		}

		// A held part comes back under its own name (the frame is as it was, saved state included).
		const name = isHeld(part.name) ? hold(reading, part.bytes, part.name) : hold(reading, part.bytes)

		if (isRefused(name)) return name

		names[role] = name
	}

	if (rewritten !== undefined) {
		// With its drawing back too, the data keeps its bytes (the frame names the drawing, and the writer puts both
		// back into the parts they were); without one its drawing cache is detached (the relationship it names holds
		// another drawing now).
		const name = names.drawing === undefined ? holdData(reading, rewritten.bytes) : hold(reading, rewritten.bytes)

		if (isRefused(name)) return name

		// A package data part held again keeps its relationships through that part (one a later save dropped: the
		// writer relates its pictures from parts of its own, by the targets it read that part's relationships as).
		noteOwner(deck, name, rewritten.name)
		noteAsItWas(deck, name)
		names.data = name
	}

	if (names.data === undefined) return refused("malformed", "a diagram restore without its data")

	setFrame(deck, reading, found.node, found.shape, {
		kind: "smartart",
		data: names.data,
		layout: names.layout ?? "",
		style: names.style ?? "",
		colors: names.colors ?? "",
		...(names.drawing === undefined ? {} : { drawing: names.drawing })
	})

	return { kind: "applied", inverse: inverseOf(op.target, back), op }
}

// The first of our gallery's styles or colours, which a new diagram takes.
function galleryDefault(deck: Deck, reading: SmartArtSourceReading, kind: "style" | "colors"): Definition | Refused {
	const entry = (kind === "style" ? SMARTART_STYLES : SMARTART_COLORS)[0]

	if (entry === undefined) return refused("notFound", `the gallery has no ${kind}`)

	return definition(deck, reading, kind, { uniqueId: entry.uniqueId, source: "gallery" })
}

// Diagrams inserted by an op, by the op as applied (its slide and shape), and those a committed save wrote: the frame
// naming the parts written. A redo of the op after that save names those parts again instead of adding new ones.
// Each insert as applied has a token of its own (a later insert may take the same slide and shape id once the first
// is undone); the shape a slide holds at an id is the latest insert's there.
const insertedBy = new WeakMap<object, string>()
const writtenDiagrams = new WeakMap<Deck, Map<string, Extract<NonNullable<ShapeNode["frame"]>, { kind: "smartart" }>>>()
const insertedAt = new WeakMap<Deck, Map<string, string>>()
let inserts = 0

function diagramKey(slide: SlideRef, id: number): string {
	return `${String(slide)}:${String(id)}`
}

function noteInsertedAt(deck: Deck, slide: SlideRef, id: number, token: string): void {
	let at = insertedAt.get(deck)

	if (at === undefined) {
		at = new Map()
		insertedAt.set(deck, at)
	}

	at.set(diagramKey(slide, id), token)
}

// The rebase after a save: the inserted diagram `id` of `slide` is the frame the save wrote.
export function noteDiagramWritten(
	deck: Deck,
	slide: SlideRef,
	id: number,
	frame: Extract<NonNullable<ShapeNode["frame"]>, { kind: "smartart" }>
): void {
	let written = writtenDiagrams.get(deck)

	if (written === undefined) {
		written = new Map()
		writtenDiagrams.set(deck, written)
	}

	written.set(insertedAt.get(deck)?.get(diagramKey(slide, id)) ?? diagramKey(slide, id), frame)
}

// The parts a committed save wrote for the diagram an insert op (as applied) made: what a redo of it names again.
export function insertedDiagramParts(deck: Deck, op: object): readonly string[] {
	const key = insertedBy.get(op)
	const frame = key === undefined ? undefined : writtenDiagrams.get(deck)?.get(key)

	return frame === undefined
		? NONE
		: DIAGRAM_PARTS.flatMap(role => (frame[role] === undefined || frame[role] === "" ? [] : [frame[role]]))
}

function insert(deck: Deck, op: SmartArtOp & { readonly kind: "insert" }, context: ApplyContext): ApplyResult<SmartArtOp> {
	const reading = readingOf(context)

	if (reading === undefined) return refused("unsupported", "diagrams cannot be inserted in this format")

	const key = insertedBy.get(op)
	const saved = key === undefined ? undefined : writtenDiagrams.get(deck)?.get(key)

	if (saved !== undefined) {
		const result = applyShape.apply(
			deck,
			{ family: "shape", kind: "insert", slide: op.slide, shape: { ...op.shape, kind: "frame", frame: { ...saved } } },
			context
		)

		if (isRefused(result)) return result

		const id = result.op.kind === "insert" ? result.op.shape.id : op.shape.id

		if (id !== op.shape.id) return refused("stale", "the diagram's place was taken")

		noteInsertedAt(deck, op.slide, id, key as string)

		return { kind: "applied", inverse: result.inverse, op }
	}

	const layout = definition(deck, reading, "layout", op.layout)

	if (isRefused(layout)) return layout

	const style = galleryDefault(deck, reading, "style")

	if (isRefused(style)) return style

	const colors = galleryDefault(deck, reading, "colors")

	if (isRefused(colors)) return colors

	const data = newDiagramData(op.texts, {
		layout: definitionIds(layout.document),
		style: definitionIds(style.document),
		colors: definitionIds(colors.document)
	})
	const dataName = hold(reading, encodeUtf8(data))

	if (isRefused(dataName)) return dataName

	const shape: ShapeNode = {
		...op.shape,
		kind: "frame",
		frame: {
			kind: "smartart",
			data: dataName,
			layout: layout.part ?? reading.holdDiagram(layout.document),
			style: reading.holdDiagram(style.document),
			colors: reading.holdDiagram(colors.document)
		}
	}
	const result = applyShape.apply(deck, { family: "shape", kind: "insert", slide: op.slide, shape }, context)

	if (isRefused(result)) return result

	const id = result.op.kind === "insert" ? result.op.shape.id : op.shape.id
	const applied = id === op.shape.id ? op : { ...op, shape: { ...op.shape, id } }

	const token = `${diagramKey(op.slide, id)}#${String(++inserts)}`

	insertedBy.set(applied, token)
	noteInsertedAt(deck, op.slide, id, token)

	return { kind: "applied", inverse: result.inverse, op: applied }
}

function apply(deck: Deck, op: Op, context: ApplyContext): ApplyResult<SmartArtOp> {
	switch (op.kind) {
		case "insert":
			return insert(deck, op, context)
		case "setNodeText":
			return editData(deck, op, { kind: "setNodeText", node: op.node, text: op.text }, context)
		case "addNode":
			return editData(
				deck,
				op,
				{
					kind: "addNode",
					relativeTo: op.relativeTo,
					position: op.position,
					...(op.text === undefined ? {} : { text: op.text }),
					...(op.id === undefined ? {} : { id: op.id })
				},
				context
			)
		case "removeNode":
			return editData(deck, op, { kind: "removeNode", node: op.node }, context)
		case "promote":
		case "demote":
			return editData(deck, op, { kind: op.kind, node: op.node }, context)
		case "moveNode":
			return editData(deck, op, { kind: "moveNode", node: op.node, direction: op.direction }, context)
		case "setLayout":
		case "setStyle":
		case "setColors":
			return setDefinition(deck, op, context)
		case "restore":
			return restore(deck, op, context)
		case "setPicture":
			return setPicture(deck, op, context)
		case "replace": {
			const matcher = matcherOf(op)

			if (matcher === undefined) return refused("malformed", "an empty query")

			return editData(
				deck,
				op,
				{ kind: "replace", matcher, replacement: op.replacement, ...(op.match === undefined ? {} : { match: op.match }) },
				context
			)
		}
	}
}

function touches(op: Op): readonly Touch[] {
	if (op.kind === "insert") return applyShape.touches({ family: "shape", kind: "insert", slide: op.slide, shape: op.shape })

	return [{ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "node" } }]
}

export const applySmartArt: ApplyFamily<SmartArtOp> = {
	apply: (deck, op, context) => apply(deck, op, context),
	touches: op => touches(op)
}

// The parts a step's diagram ops read (a batch's members each), for the engine's prepare: a duplicate reads every part
// its slide's diagrams name (holdDiagramCopies).
export function diagramPartsOf(deck: Deck, op: DeckOp): string[] {
	if (op.family === "batch") return [...new Set(op.ops.flatMap(each => diagramPartsOf(deck, each)))]
	if (op.family === "slide" && op.kind === "duplicate") {
		const out: string[] = []

		for (const frame of diagramFrames(deck.nodes.get(op.slide)?.shapes ?? []))
			for (const role of DIAGRAM_PARTS) {
				const part = frame[role]

				if (part !== undefined && part !== "" && !isHeld(part)) out.push(part)
			}

		return out
	}

	return op.family === "smartart" ? diagramPartsToRead(deck, op) : []
}

// The package data parts whose relationships a step's setPicture ops read (the engine's prepare loads them).
export function diagramPicturePartsOf(deck: Deck, op: DeckOp): string[] {
	if (op.family === "batch") return [...new Set(op.ops.flatMap(each => diagramPicturePartsOf(deck, each)))]
	if (op.family === "slide" && op.kind === "duplicate") {
		const out: string[] = []

		for (const frame of diagramFrames(deck.nodes.get(op.slide)?.shapes ?? [])) {
			const owner = isHeld(frame.data) ? diagramRelationshipOwner(deck, frame.data) : frame.data

			if (owner !== undefined) out.push(owner)
			// The drawing's own pictures, for a copy written as a part of its own.
			if (frame.drawing !== undefined && !isHeld(frame.drawing)) out.push(frame.drawing)
		}

		return out
	}
	// Every edit of a diagram whose data may hold pictures of its own: the relationships name them (setPicture pends
	// them; an edit keeps them for a writer that cannot put the data back into its own part).
	if (op.family !== "smartart" || op.kind === "insert" || op.kind === "restore") return []

	const target = op.target
	const frame = findShape(deck.nodes.get(target.slide)?.shapes ?? [], target.id)?.shape.frame

	if (frame?.kind !== "smartart") return []

	const owner = isHeld(frame.data) ? diagramRelationshipOwner(deck, frame.data) : frame.data

	return owner === undefined ? [] : [owner]
}

// A duplicated slide's diagrams (`shapes`, the copy's) take parts of their own, as PowerPoint's copy does: every part a
// frame names is held again under a new name (the same document: no bytes are copied until a save writes them), so a
// copy and its source never name one part, and an edit, undo or save of either touches only its own. Data with
// pictures keeps reading them through the package part it came from. Read before the op (diagramPartsOf).
export function holdDiagramCopies(deck: Deck, shapes: readonly ShapeNode[], context: object): Refused | undefined {
	const reading = readingOf(context as ApplyContext)

	if (reading === undefined) return undefined

	const copies = new Map<string, string>()
	const visit = (list: readonly ShapeNode[], depth: number): Refused | undefined => {
		if (depth > MAX_GROUP_DEPTH) return refused("tooDeep", "groups nested past the diagram copy's depth")

		for (const shape of list) {
			if (shape.children !== undefined) {
				const nested = visit(shape.children, depth + 1)

				if (nested !== undefined) return nested
			}

			const frame = shape.frame

			if (frame?.kind !== "smartart") continue

			const own: Partial<Record<DiagramPart, string>> = {}

			for (const role of DIAGRAM_PARTS) {
				const part = frame[role]

				if (part === undefined || part === "") continue

				const done = copies.get(part)

				if (done !== undefined) {
					own[role] = done

					continue
				}

				const document = reading.diagramDocument(part)

				if (document === undefined) {
					// A drawing cache the package lacks (a dangling relationship): the copy has none.
					if (role === "drawing") continue

					return refused("notFound", `diagram part ${part} not read`)
				}

				const name = reading.holdDiagram(document)

				copies.set(part, name)
				own[role] = name

				// A drawing names its pictures by relationships of its own part: their targets go with the copy.
				if (role === "drawing") {
					const targets = isHeld(part) ? diagramRelationshipTargets(deck, part) : undefined

					if (targets !== undefined) relationshipTargets.get(deck)?.set(name, targets)
					else if (!isHeld(part)) noteTargets(deck, name, document, part, reading)
				}

				if (role !== "data") continue
				if (!isHeld(part) || diagramDataAsItWas(deck, part)) noteAsItWas(deck, name)

				const owner = isHeld(part) ? diagramRelationshipOwner(deck, part) : dataHasRelationships(document) ? part : undefined

				noteOwner(deck, name, owner)

				const targets = isHeld(part) ? diagramRelationshipTargets(deck, part) : undefined

				if (targets !== undefined) relationshipTargets.get(deck)?.set(name, targets)
				else noteTargets(deck, name, document, owner, reading)
			}

			shape.frame = {
				kind: "smartart",
				data: own.data ?? frame.data,
				layout: own.layout ?? frame.layout,
				style: own.style ?? frame.style,
				colors: own.colors ?? frame.colors,
				...(own.drawing === undefined ? {} : { drawing: own.drawing })
			}
		}

		return undefined
	}

	return visit(shapes, 0)
}

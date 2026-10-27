import { D, drawingReader } from "../../../drawingml/reader"
import {
	DIAGRAM_CONTENT_TYPES,
	DIAGRAM_PARTS,
	dataHasRelationships,
	definitionIds,
	detachDrawingCache,
	editDiagramData,
	newDiagramData,
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
import { applyShape } from "./shape"

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

type Op = SmartArtOp | SmartArtReplace
type DiagramFrame = Extract<FrameRef, { kind: "smartart" }>

// The names the session holds parts under (the writer's raw sources).
const HELD_PREFIX = "raw:"
const DEFINITION_ROOTS = { layout: "layoutDef", style: "styleDef", colors: "colorsDef" } as const
const MAX_GROUP_DEPTH = 128
const NO_INVERSE = { ops: [], bytes: 0 } as const

function isRefused(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "refused"
}

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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false

	return true
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

export function diagramRelationshipOwner(deck: Deck, part: string): string | undefined {
	return relationshipOwners.get(deck)?.get(part)
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

// The package data part a picture-holding diagram's edits are written into: its own (or the one its held edit keeps
// the relationships of); a refusal when another diagram names that part too (the writer writes a shared part under a
// new name, which would lose the relationships).
function pictureOwner(deck: Deck, shape: ShapeNode, data: string): string | Refused {
	const owner = isHeld(data) ? diagramRelationshipOwner(deck, data) : data

	if (owner === undefined) return refused("unsupported", "a diagram with pictures whose data part is not the package's")

	for (const node of deck.nodes.values())
		for (const frame of diagramFrames(node.shapes)) {
			if (frame === shape.frame) continue
			if (frame.data === owner || diagramRelationshipOwner(deck, frame.data) === owner)
				return refused("unsupported", "a diagram with pictures whose data another diagram shares")
		}

	return owner
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
	const owner = dataHasRelationships(data) ? pictureOwner(deck, found.shape, found.frame.data) : undefined

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
	const result = editDiagramData(at.data, {
		kind: "setDefinition",
		which: kind,
		uniqueId: ids.uniqueId,
		...(ids.category === undefined ? {} : { category: ids.category })
	})

	if (isRefused(result)) return result
	if (result.kind === "unchanged") return { kind: "applied", inverse: NO_INVERSE, op }

	const dataName = hold(at.reading, result.bytes)

	if (isRefused(dataName)) return dataName

	noteOwner(deck, dataName, at.owner)

	const { drawing: _drawing, ...rest } = at.frame
	// A definition of the deck's own is named where it is; one of the gallery is held.
	setFrame(deck, at.reading, at.node, at.shape, { ...rest, data: dataName, [kind]: found.part ?? at.reading.holdDiagram(found.document) })

	return { kind: "applied", inverse: inverseOf(op.target, at.back), op }
}

function restore(deck: Deck, op: SmartArtOp & { readonly kind: "restore" }, context: ApplyContext): ApplyResult<SmartArtOp> {
	const reading = readingOf(context)

	if (reading === undefined) return refused("unsupported", "diagrams cannot be edited in this format")

	const found = diagramAt(deck, op.target)

	if (isRefused(found)) return found

	const back = heldParts(found.frame, reading)

	if (isRefused(back)) return back

	const names: Partial<Record<DiagramPart, string>> = {}

	for (const part of op.parts) {
		const role = DIAGRAM_PARTS.find(name => DIAGRAM_CONTENT_TYPES[name] === part.contentType)

		if (role === undefined) return refused("malformed", `diagram part ${part.name}`)

		const live = reading.diagramDocument(part.name)

		if ((live !== undefined && sameBytes(live.bytes, part.bytes)) || (role === "drawing" && part.bytes.length === 0)) {
			names[role] = part.name

			continue
		}

		// A held part comes back under its own name (the frame is as it was, saved state included); a package data part
		// a save has rewritten since has its drawing cache detached (the relationship it names holds another drawing).
		const name = isHeld(part.name)
			? hold(reading, part.bytes, part.name)
			: role === "data"
				? holdData(reading, part.bytes)
				: hold(reading, part.bytes)

		if (isRefused(name)) return name
		// A package data part held again keeps its relationships through that part.
		if (role === "data" && !isHeld(part.name)) noteOwner(deck, name, part.name)

		names[role] = name
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
const insertedBy = new WeakMap<object, string>()
const writtenDiagrams = new WeakMap<Deck, Map<string, Extract<NonNullable<ShapeNode["frame"]>, { kind: "smartart" }>>>()

function diagramKey(slide: SlideRef, id: number): string {
	return `${String(slide)}:${String(id)}`
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

	written.set(diagramKey(slide, id), frame)
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

	insertedBy.set(applied, diagramKey(op.slide, id))

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

// The parts a step's diagram ops read (a batch's members each), for the engine's prepare.
export function diagramPartsOf(deck: Deck, op: DeckOp): string[] {
	if (op.family === "batch") return [...new Set(op.ops.flatMap(each => diagramPartsOf(deck, each)))]

	return op.family === "smartart" ? diagramPartsToRead(deck, op) : []
}

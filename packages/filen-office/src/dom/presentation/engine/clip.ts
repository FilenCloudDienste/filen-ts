import { relationshipKind } from "../../../core/docx/index"
import { partKey, Relationships, type PartBytes } from "../../../core/opc/index"
import { insertedMediaId } from "../../../core/presentation/edit/apply/media"
import type { PictureReading } from "../../../core/presentation/edit/apply/picture"
import type { SlideSourceReading } from "../../../core/presentation/edit/apply/slide"
import { inheritedDeclarations } from "../../../core/presentation/edit/canonical"
import { cloneModel, findShape } from "../../../core/presentation/edit/changes"
import {
	shapeText,
	type ClipRelationship,
	type PresentationClip,
	type ShapeClip,
	type SlideClip
} from "../../../core/presentation/edit/clip"
import { planDelete } from "../../../core/presentation/edit/integrity"
import { shownThrough } from "../../../core/presentation/groupSpace"
import type { PastedShape } from "../../../core/presentation/edit/ops"
import { markupBytes } from "../../../core/presentation/edit/proof"
import {
	PresentationError,
	refused,
	type PresentationRefusal,
	type Refused,
	type ShapeNode,
	type SlideNode,
	type SlideRef,
	type Xfrm
} from "../../../core/presentation/model"
import { isRefused } from "../../../core/presentation/refusal"
import { namedRelationshipIds, withHeldRelationships } from "../../../core/pptx/write/carry"
import { emitFamilyOf, emitPptx } from "../../../core/pptx/write/emit"
import { URIS, type EmitContext } from "../../../core/pptx/write/emit/shape"
import { releasedMediaBytes } from "../../../core/pptx/write/parts"
import type { EmitRequest, EmitResult, PartsApi, PptxPartKind } from "../../../core/pptx/write/types"
import { encodeUtf8, escapeAttribute, type XmlDocument } from "../../../core/xml/index"
import type { CallContext, ClipCapability } from "../engine"
import type { ClipPart, ClipPartsResult, ClipRequest, ClipResult } from "../protocol"
import { sessionEdits, withClipReading } from "./edit"
import { pptxParts } from "./open/pptx"

// Cut and Copy in the worker (core/presentation/edit/clip.ts holds the rest): the clip a copy of shapes or slides makes,
// and the parts a paste into another deck asks for.
//
// A PresentationML shape is written out whole as a save writes it (its edits in, what the model does not hold copied
// from its source), its namespaces declared on it, with the relationships its markup names: a self-contained element any
// deck reads. An ODP shape is its source element and its typed state (a clip of one deck). The file's own locks, held
// markup and parts a copy would share with its original (charts, diagrams, embedded objects, ink) are not copied.

const RAW_PREFIX = "raw:"
// The relationship kinds a pasted element may name: pictures, media, links.
const CARRIED_KINDS: ReadonlySet<string> = new Set(["image", "video", "audio", "media", "hdphoto", "hyperlink", "slide"])
const IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
// What clipParts hands over at most (a medium past it is not pasted into another deck).
export const CLIP_PARTS_BYTES = 256 * 1024 * 1024

function uncopyable(shape: ShapeNode): PresentationRefusal | undefined {
	if (shape.lock !== undefined) return "locked"
	if (shape.synthetic === true || shape.kind === "opaque" || shape.kind === "ink" || shape.ink === true) return "unsupported"
	if (shape.kind === "frame" && shape.frame?.kind !== "table") return "unsupported"
	// A medium an edit inserted lives in the worker's registry until a save stores it.
	if (shape.media !== undefined && insertedMediaId(shape.media.part) !== undefined) return "unsupported"

	for (const child of shape.children ?? []) {
		const inner = uncopyable(child)

		if (inner !== undefined) return inner
	}

	return undefined
}

interface Made {
	readonly type: string
	// A zip name, or an external URL.
	readonly target: string
	readonly external: boolean
	readonly bytes?: Uint8Array
	readonly contentType?: string
}

// The emits' parts for one clip: relationships they make are recorded under ids of their own (never one the source
// part has), an inserted image's part with its bytes.
class ClipParts implements PartsApi {
	readonly owner: string
	readonly made = new Map<string, Made>()
	private readonly relationships: Relationships
	private next = 0

	constructor(owner: string, relationships: Relationships) {
		this.owner = owner
		this.relationships = relationships
	}

	private freeId(): string {
		let id: string

		do id = `rIdClip${String(++this.next)}`
		while (this.relationships.byId(id) !== undefined)

		return id
	}

	addPart(kind: PptxPartKind, content: PartBytes, contentType: string): { readonly part: string; readonly rId: string } {
		if (!(content instanceof Uint8Array)) throw new PresentationError("unsupported", `a ${kind} part made while copying`)

		const id = this.freeId()
		const part = `ppt/media/clip${String(this.next)}`

		this.made.set(id, { type: IMAGE, target: part, external: false, bytes: content, contentType })

		return { part: `/${part}`, rId: id }
	}

	relate(target: string, type: string, external = false): string {
		const name = external || !target.startsWith("/") ? target : target.slice(1)

		for (const [id, made] of this.made) if (made.type === type && made.external === external && made.target === name) return id

		const id = this.freeId()

		this.made.set(id, { type, target: name, external })

		return id
	}

	target(rId: string): string | undefined {
		const made = this.made.get(rId)

		if (made !== undefined) return made.external ? made.target : `/${made.target}`

		const relationship = this.relationships.byId(rId)

		if (relationship === undefined) return undefined

		return relationship.external || relationship.partName === undefined ? relationship.target : `/${relationship.partName}`
	}

	removePart(): never {
		throw new PresentationError("unsupported", "a part removed while copying")
	}

	editor(): never {
		throw new PresentationError("unsupported", "a part edited while copying")
	}
}

function isSpace(byte: number | undefined): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

// The element's markup with the namespaces it uses declared on its start tag: those of its source's scope and the
// writer's prefixes the scope does not bind.
function selfContained(raw: Uint8Array, scope: ReadonlyMap<string, string>): Uint8Array | Refused {
	let declarations = ""

	for (const [prefix, uri] of scope) {
		if (uri === "") continue

		declarations += prefix === "" ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${prefix}="${escapeAttribute(uri)}"`
	}

	for (const [prefix, uri] of Object.entries(URIS)) {
		const bound = scope.get(prefix)

		if (bound !== undefined && bound !== uri) return refused("unsupported", `the prefix ${prefix} names another namespace`)
		if (bound === undefined) declarations += ` xmlns:${prefix}="${escapeAttribute(uri)}"`
	}

	// After the element's name ("<p:sp" of "<p:sp>" or "<p:sp a=…>").
	let end = 1

	while (end < raw.length && !isSpace(raw[end]) && raw[end] !== 0x3e && raw[end] !== 0x2f) end++

	const head = encodeUtf8(declarations)
	const out = new Uint8Array(raw.length + head.length)

	out.set(raw.subarray(0, end), 0)
	out.set(head, end)
	out.set(raw.subarray(end), end + head.length)

	return out
}

// A PresentationML shape written out whole and self-contained, and the ids its markup names.
function emitShape(
	context: CallContext,
	node: SlideNode,
	shape: ShapeNode,
	recorder: ClipParts,
	relationships: Relationships
): { readonly raw: Uint8Array; readonly named: ReadonlySet<string> } | Refused {
	const deck = context.session.deck
	const parts = pptxParts(deck)

	if (parts === undefined) return refused("notImplemented", "copy")

	const edits = sessionEdits(context.session)
	const src = shape.src?.format === "pptx" ? shape.src : undefined
	const held = src !== undefined && src.part.startsWith(RAW_PREFIX)
	const document: XmlDocument | undefined = src === undefined ? undefined : held ? edits.rawDocument(src.part) : parts.document(src.part)

	if (src !== undefined && (document === undefined || (!held && src.epoch !== parts.epoch)))
		return refused("stale", "the copied shape's source")

	const emit: EmitContext = {
		deck,
		document,
		parts: recorder,
		mode: "model",
		slidePart: ref => parts.partOf(ref),
		dispatch: (request, inner) => emitPptx(emitFamilyOf(request), request, inner),
		relationships,
		rawDocument: name => edits.rawDocument(name),
		...(src === undefined ? {} : { documentPart: src.part })
	}
	const request: EmitRequest = { slide: node, shape, touch: { kind: "shape", slide: node.ref, shape: shape.id, dirt: { kind: "node" } } }
	let result: EmitResult

	try {
		result = emitPptx(emitFamilyOf(request), request, emit)

		if (result.kind === "refused" && result.reason === "notImplemented") result = emitPptx("shape", request, emit)
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)

		throw error
	}

	if (result.kind === "refused") return result

	let bytes: Uint8Array

	if (result.kind === "unchanged") {
		if (src === undefined || document === undefined) return refused("failed", "a new shape emitted as unchanged")

		bytes = document.raw(src.node)
	} else bytes = markupBytes(result, document)

	const scope = src === undefined || document === undefined ? new Map<string, string>() : inheritedDeclarations(document, src.node)
	const raw = selfContained(bytes, scope)

	if (isRefused(raw)) return raw

	try {
		return { raw, named: namedRelationshipIds(raw) }
	} catch {
		return refused("malformed", "the copied shape's markup")
	}
}

// What a clip names, from the recorder's relationships and the slide's.
function clipRelationships(
	context: CallContext,
	named: ReadonlySet<string>,
	recorder: ClipParts,
	relationships: Relationships
): ClipRelationship[] | Refused {
	const deck = context.session.deck
	const parts = pptxParts(deck)
	const out: ClipRelationship[] = []

	for (const id of named) {
		const made = recorder.made.get(id)
		const relationship = relationships.byId(id)
		const type = made?.type ?? relationship?.type
		const external = made?.external ?? relationship?.external ?? false
		const target = made?.target ?? (external ? relationship?.target : relationship?.partName)

		if (type === undefined || target === undefined) return refused("malformed", `relationship ${id} of the copied shape names nothing`)

		const kind = relationshipKind(type) ?? ""

		if (!CARRIED_KINDS.has(kind)) return refused("unsupported", `a ${kind} relationship`)

		if (external) {
			out.push({ id, type, target, external: true })

			continue
		}

		const contentType = made?.contentType ?? parts?.contentTypes.typeOf(target) ?? releasedMediaBytes(deck, target)?.contentType
		const size = made?.bytes?.length ?? parts?.opc.entry(target)?.uncompressedSize

		out.push({
			id,
			type,
			target,
			...(contentType === undefined ? {} : { contentType }),
			...(size === undefined ? {} : { size }),
			...(made?.bytes === undefined ? {} : { bytes: made.bytes }),
			...(kind === "slide" ? { jump: true as const } : {})
		})
	}

	return out
}

// The shapes named, in z-order (a child of a group named with its group goes with it). A group's member is copied with
// its box as it shows on the slide (PowerPoint pastes it there, outside any group).
function namedShapes(node: SlideNode, ids: readonly number[]): ShapeNode[] | Refused {
	for (const id of ids) if (findShape(node.shapes, id) === undefined) return refused("notFound", `shape ${String(id)}`)

	const wanted = new Set(ids)
	const out: ShapeNode[] = []
	const visit = (shapes: readonly ShapeNode[], chain: readonly Xfrm[]): void => {
		for (const shape of shapes) {
			if (wanted.has(shape.id))
				out.push(chain.length === 0 || shape.xfrm === undefined ? shape : { ...shape, xfrm: shownThrough(chain, shape.xfrm) })
			else if (shape.children !== undefined) visit(shape.children, shape.xfrm === undefined ? chain : [...chain, shape.xfrm])
		}
	}

	visit(node.shapes, [])

	return out
}

type ClipReading = SlideSourceReading & Partial<PictureReading>

// The image a lone picture shows (its part), for the clipboard's picture.
function pictureOf(node: SlideNode, shape: ShapeNode, reading: ClipReading): string | undefined {
	const fill = shape.props?.fill
	const typed = fill !== undefined && fill !== "none" && fill.kind === "picture" ? fill : undefined

	if (typed !== undefined) return typed.part ?? (typed.inserted === undefined ? undefined : `inserted:${String(typed.inserted)}`)

	const read = reading.pictureFill?.(node, shape)

	return read === undefined || isRefused(read) ? undefined : read.part
}

function shapeClip(context: CallContext, slide: SlideRef, ids: readonly number[]): Promise<ShapeClip | Refused> {
	const deck = context.session.deck

	return withClipReading(context, { family: "shape", kind: "delete", slide, shapes: ids }, async reading => {
		const node = deck.nodes.get(slide)

		if (node === undefined) return refused("notFound", `slide ${String(slide)}`)

		const chosen = namedShapes(node, ids)

		if (isRefused(chosen)) return chosen
		if (chosen.length === 0) return refused("notFound", "no shapes")

		for (const shape of chosen) {
			const blocked = uncopyable(shape)

			if (blocked !== undefined) return refused(blocked, "this object is not copied")
		}

		const shapes: PastedShape[] = []
		let relationships: ClipRelationship[] = []

		if (deck.format === "pptx") {
			const parts = pptxParts(deck)

			if (parts === undefined) return refused("notImplemented", "copy")

			const base = parts.opc.has(node.part.slice(1)) ? await parts.opc.relationships(node.part.slice(1)) : new Relationships([])
			const rels = withHeldRelationships(deck, node.part, base)
			const recorder = new ClipParts(node.part, rels)
			const named = new Set<string>()

			for (const shape of chosen) {
				const emitted = emitShape(context, node, shape, recorder, rels)

				if (isRefused(emitted)) return emitted

				for (const id of emitted.named) named.add(id)

				shapes.push({ raw: emitted.raw })
			}

			const listed = clipRelationships(context, named, recorder, rels)

			if (isRefused(listed)) return listed

			relationships = listed
		} else {
			for (const shape of chosen) {
				const raw = shape.src === undefined ? undefined : reading.sourceBytes(shape.src)

				if (raw !== undefined && isRefused(raw)) return raw

				shapes.push({ shape: cloneModel(shape), ...(raw === undefined ? {} : { raw: raw.slice() }) })
			}
		}

		const lone = chosen.length === 1 ? chosen[0] : undefined
		const picture = lone?.kind === "pic" && lone.media === undefined ? pictureOf(node, lone, reading) : undefined

		return {
			kind: "shapes",
			format: deck.format,
			slide,
			shapes,
			boxes: chosen.map((shape): Xfrm | undefined => (shape.xfrm === undefined ? undefined : { ...shape.xfrm })),
			relationships,
			text: chosen.map(shape => shapeText(shape)),
			...(picture === undefined ? {} : { picture })
		} satisfies ShapeClip
	})
}

function slideClip(context: CallContext, refs: readonly SlideRef[], cut: boolean): Promise<SlideClip | Refused> {
	const deck = context.session.deck

	if (refs.length === 0) return Promise.resolve(refused("notFound", "no slides"))

	for (const ref of refs) if (!deck.slides.includes(ref)) return Promise.resolve(refused("notFound", `slide ${String(ref)}`))

	const slides = [...new Set(refs)].sort((a, b) => deck.slides.indexOf(a) - deck.slides.indexOf(b))

	return withClipReading(context, { family: "slide", kind: "delete", slides }, reading => {
		const text: string[][] = []
		const held: NonNullable<SlideClip["held"]>[number][] = []
		const removed = cut ? new Set(planDelete(deck, slides, reading.facts, reading.partOf).remove) : undefined

		for (const ref of slides) {
			const node = deck.nodes.get(ref)

			if (node === undefined) return refused("notFound", `slide ${String(ref)} is not parsed`)

			text.push(node.shapes.flatMap(shape => shapeText(shape)))

			if (!cut) continue

			// What the cut's delete holds for its undo: the slide's parts, the shared ones it takes, its typed nodes.
			const parts = node.src === undefined ? [] : reading.rawParts(node, removed)

			if (isRefused(parts)) return parts

			const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

			held.push({ ref, parts, nodes: [cloneModel(node), ...(notes === undefined ? [] : [cloneModel(notes)])] })
		}

		return { kind: "slides", format: deck.format, slides, text, ...(cut ? { held } : {}) } satisfies SlideClip
	})
}

export async function clip(context: CallContext, request: ClipRequest): Promise<ClipResult> {
	let made: PresentationClip | Refused

	try {
		made =
			request.kind === "shapes"
				? await shapeClip(context, request.slide, request.shapes)
				: await slideClip(context, request.slides, request.cut === true)
	} catch (error) {
		if (error instanceof PresentationError) return { ok: false, refusal: error.reason }

		throw error
	}

	return isRefused(made) ? { ok: false, refusal: made.reason } : { ok: true, clip: made }
}

export const clipCapability: ClipCapability = {
	clip: (context, request) => clip(context, request),
	clipParts: (context, names) => clipParts(context, names)
}

// The bytes of parts a clip names (the package's, or a part a save let go of whose bytes are held), within
// CLIP_PARTS_BYTES in all.
export async function clipParts(context: CallContext, names: readonly string[]): Promise<ClipPartsResult> {
	const deck = context.session.deck
	const parts = pptxParts(deck)

	if (parts === undefined) return { ok: false, refusal: "notImplemented" }

	const out: ClipPart[] = []
	let total = 0

	for (const name of new Set(names)) {
		const key = partKey(name)
		const released = releasedMediaBytes(deck, name)
		const entry = released === undefined ? parts.opc.entry(key) : undefined
		const size = released?.bytes.length ?? entry?.uncompressedSize

		if (size === undefined) return { ok: false, refusal: "notFound" }

		total += size

		if (total > CLIP_PARTS_BYTES) return { ok: false, refusal: "tooLarge" }

		// A held part's bytes are copied: the answer transfers what it sends.
		const bytes = released?.bytes.slice() ?? (await parts.opc.read(entry?.name ?? name))

		out.push({ name, bytes, contentType: released?.contentType ?? parts.contentTypes.typeOf(key) ?? "application/octet-stream" })
	}

	return { ok: true, parts: out }
}

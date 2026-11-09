import { relationshipKind } from "../../../core/docx/index"
import { partKey, Relationships, type PartBytes } from "../../../core/opc/index"
import {
	heldChart,
	INSERTED_WORKBOOK_ID,
	isHeldChart,
	versionWorkbook,
	type ChartPartSource
} from "../../../core/presentation/edit/apply/chart"
import { diagramDrawingRelId, diagramRelationshipOwner } from "../../../core/presentation/edit/apply/smartart"
import type { CarriedPart, ImportedSlide, PastedShape } from "../../../core/presentation/edit/ops"
import { notesBody } from "../../../core/presentation/notes"
import { exportSlides } from "../../../core/pptx/write/splice"
import { pptxSaveSource } from "./save"
import { layoutEditedDiagrams } from "./smartart"
import { newFrame as newChartFrame } from "../../../core/pptx/write/emit/chart"
import { newFrame as newDiagramFrame } from "../../../core/pptx/write/emit/smartart"
import { G, partReader } from "../../../core/pptx/read/xml"
import { DIAGRAM_CONTENT_TYPES, pendingImageIds, withDrawingReference } from "../../../core/smartart/edit"
import { CHART_TYPE } from "../../../core/xlsx/charts/parts"
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
import { markupBytes } from "../../../core/presentation/edit/proof"
import {
	PresentationError,
	refused,
	type PresentationRefusal,
	type Refused,
	type ShapeNode,
	type SlideNode,
	type SlideRef,
	type TextBody,
	type Xfrm
} from "../../../core/presentation/model"
import { isRefused } from "../../../core/presentation/refusal"
import { namedRelationshipIds, withHeldRelationships } from "../../../core/pptx/write/carry"
import { emitFamilyOf, emitPptx } from "../../../core/pptx/write/emit"
import { URIS, type EmitContext } from "../../../core/pptx/write/emit/shape"
import { carriedPart, RELATIONSHIP_TYPES, releasedMediaBytes } from "../../../core/pptx/write/parts"
import type { EmitRequest, EmitResult, PartsApi, PptxPartKind } from "../../../core/pptx/write/types"
import { decodeUtf8, encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../../core/xml/index"
import type { CallContext, ClipCapability } from "../engine"
import type { ClipPart, ClipPartsResult, ClipRequest, ClipResult, ClipSlidesResult } from "../protocol"
import { chartPartSource, sessionEdits, withClipReading } from "./edit"
import { pptxParts } from "./open/pptx"

// Cut and Copy in the worker (core/presentation/edit/clip.ts holds the rest): the clip a copy of shapes or slides makes,
// and the parts a paste into another deck asks for.
//
// A PresentationML shape is written out whole as a save writes it (its edits in, what the model does not hold copied
// from its source), its namespaces declared on it, with the relationships its markup names: a self-contained element any
// deck reads. One the file locks (markup kept whole: mc:AlternateContent, an unknown frame) is its source element as
// written. The parts it owns (a chart with its workbook, style and colours; a diagram's data, layout, style, colours and
// drawing; an embedded object; ink) come with it, every part they reach, as the session holds them now (an edited
// chart's version, an edited diagram's data): a paste gives the slide copies of its own. An ODP shape is its source
// element and its typed state (a clip of one deck), never one holding an object of its own.

const RAW_PREFIX = "raw:"
// The relationship kinds a pasted element may name: pictures, media, links.
const CARRIED_KINDS: ReadonlySet<string> = new Set(["image", "video", "audio", "media", "hdphoto", "hyperlink", "slide"])
// The kinds whose targets a pasted element owns: copied with it.
const OWNED_KINDS: ReadonlySet<string> = new Set([
	"chart",
	"diagramData",
	"diagramLayout",
	"diagramQuickStyle",
	"diagramColors",
	"diagramDrawing",
	"oleObject",
	"package",
	"customXml"
])
const CHARTEX = "http://schemas.microsoft.com/office/2014/relationships/chartEx"
const IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
// What clipParts hands over at most (a medium past it is not pasted into another deck), and what a copy's owned parts
// come to at most.
export const CLIP_PARTS_BYTES = 256 * 1024 * 1024

function ownedType(type: string): boolean {
	return type === CHARTEX || OWNED_KINDS.has(relationshipKind(type) ?? "")
}

function uncopyable(shape: ShapeNode, format: string): PresentationRefusal | undefined {
	if (shape.synthetic === true) return "unsupported"
	// A medium an edit inserted lives in the worker's registry until a save stores it.
	if (shape.media !== undefined && insertedMediaId(shape.media.part) !== undefined) return "unsupported"
	if (shape.kind === "frame" && shape.frame?.kind === "media") return "unsupported"

	if (format === "odp") {
		// An ODP object's markup names the document's own sub-directories, which a paste would share.
		if (shape.lock !== undefined) return "locked"
		if (shape.kind === "opaque" || shape.kind === "ink" || shape.ink === true) return "unsupported"
		if (shape.kind === "frame" && shape.frame?.kind !== "table") return "unsupported"
	} else if (shape.kind === "opaque" && shape.src === undefined) return "unsupported"

	for (const child of shape.children ?? []) {
		const inner = uncopyable(child, format)

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

// The prefixes the element's own start tag declares ("" for its default namespace).
function ownDeclarations(raw: Uint8Array): Set<string> {
	let end = 0
	let quote = 0

	for (; end < raw.length; end++) {
		const byte = raw[end]

		if (quote !== 0) {
			if (byte === quote) quote = 0
		} else if (byte === 0x22 || byte === 0x27) quote = byte ?? 0
		else if (byte === 0x3e) break
	}

	const out = new Set<string>()

	for (const match of decodeUtf8(raw.subarray(0, end)).matchAll(/\sxmlns(?::([\w.-]+))?\s*=/gu)) out.add(match[1] ?? "")

	return out
}

// The element's markup with the namespaces it uses declared on its start tag: those of its source's scope and the
// writer's prefixes the scope does not bind, but for those the tag declares itself.
function selfContained(raw: Uint8Array, scope: ReadonlyMap<string, string>): Uint8Array | Refused {
	const own = ownDeclarations(raw)
	let declarations = ""

	for (const [prefix, uri] of scope) {
		if (uri === "" || own.has(prefix)) continue

		declarations += prefix === "" ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${prefix}="${escapeAttribute(uri)}"`
	}

	for (const [prefix, uri] of Object.entries(URIS)) {
		const bound = scope.get(prefix)

		if (own.has(prefix)) continue
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

// The parts a copy takes as the session holds them rather than as the package does (an edited chart's version, an
// edited diagram's data), by part key; and the relationships a part of the copy names that its markup does not (a
// diagram's drawing, by its data part's id), by id: the id of the one naming it.
interface Owned {
	readonly overrides: Map<string, CarriedPart>
	readonly accompany: Map<string, string>
	// Names the copy gave parts no save stored yet, by key.
	readonly named: Set<string>
}

// A name for a part no save stored yet (an inserted chart, its workbook, an inserted diagram's parts), its stem and
// extension `like`'s: one no part of the deck has, nor another the copy named.
function unsavedName(context: CallContext, owned: Owned, like: string): string {
	const deck = context.session.deck
	const parts = pptxParts(deck)
	const dot = like.lastIndexOf(".")
	const stem = like.slice(0, dot).replace(/\d+$/u, "")
	const extension = like.slice(dot)

	for (let n = 1; ; n++) {
		const name = `${stem}${String(n)}${extension}`
		const key = partKey(name)

		if (owned.named.has(key) || owned.overrides.has(key) || parts?.opc.has(name) === true || carriedPart(deck, name) !== undefined)
			continue

		owned.named.add(key)

		return name
	}
}

const WORKBOOK_TYPES: ReadonlySet<string> = new Set([RELATIONSHIP_TYPES.embeddedWorkbook, RELATIONSHIP_TYPES.oleObject])
const DIAGRAM_ROLES = [
	{ attribute: "dm", field: "data", type: RELATIONSHIP_TYPES.diagramData, like: "ppt/diagrams/data1.xml" },
	{ attribute: "lo", field: "layout", type: RELATIONSHIP_TYPES.diagramLayout, like: "ppt/diagrams/layout1.xml" },
	{ attribute: "qs", field: "style", type: RELATIONSHIP_TYPES.diagramStyle, like: "ppt/diagrams/quickStyle1.xml" },
	{ attribute: "cs", field: "colors", type: RELATIONSHIP_TYPES.diagramColors, like: "ppt/diagrams/colors1.xml" }
] as const

function zip(name: string): string {
	return name.startsWith("/") ? name.slice(1) : name
}

// The first element under `node` (itself included) of `group` named `local`, depth first.
function descendant(document: XmlDocument, node: number, group: G, local: string): number {
	const r = partReader(document)
	const stack = [node]

	while (stack.length > 0) {
		const at = stack.pop() ?? -1

		if (at < 0) continue
		if (r.is(at, group, local)) return at

		const children: number[] = []

		for (let child = r.first(at); child >= 0; child = r.next(child)) children.push(child)

		stack.push(...children.reverse())
	}

	return -1
}

// A part of this deck as the session holds it: the package's, one a paste carried or a save let go of, one a restored
// slide holds (its bytes copied: what the clip holds is its own).
async function sessionPart(context: CallContext, source: ChartPartSource, name: string): Promise<CarriedPart | Refused> {
	const deck = context.session.deck
	const parts = pptxParts(deck)
	const part = zip(name)

	if (parts === undefined) return refused("notImplemented", "copy")

	const inPackage = parts.opc.has(part)
	const held = inPackage ? undefined : carriedPart(deck, part)
	const contentType =
		(inPackage ? parts.contentTypes.typeOf(part) : undefined) ?? held?.contentType ?? releasedMediaBytes(deck, part)?.contentType

	if (contentType === undefined || source.opc.entry(part) === undefined) return refused("stale", `the copied part ${part}`)

	const read = held?.bytes ?? (await source.opc.read(part))
	const relationships = (await source.opc.relationships?.(part))?.all ?? []
	const links: CarriedPart["links"][number][] = []

	for (const relationship of relationships) {
		if (relationship.external) {
			links.push({ id: relationship.id, type: relationship.type, target: relationship.target, external: true })

			continue
		}

		if (relationship.partName === undefined) return refused("malformed", `a relationship of ${part} names nothing`)

		links.push({ id: relationship.id, type: relationship.type, target: zip(relationship.partName) })
	}

	return { name: part, contentType, bytes: inPackage ? read : read.slice(), links }
}

// The parts `root` reaches, itself first, as the session holds them (`owned` before the package), within `budget`.
async function treeOf(
	context: CallContext,
	source: ChartPartSource,
	root: string,
	owned: Owned,
	budget: { left: number }
): Promise<CarriedPart[] | Refused> {
	const out: CarriedPart[] = []
	const seen = new Set<string>()
	const queue = [zip(root)]

	for (let at = 0; at < queue.length; at++) {
		const name = queue[at] ?? ""
		const key = partKey(name)

		if (seen.has(key)) continue

		seen.add(key)

		const part = owned.overrides.get(key) ?? (await sessionPart(context, source, name))

		if (isRefused(part)) return part

		budget.left -= part.bytes.length

		if (budget.left < 0) return refused("tooLarge", "the copied objects' parts")

		out.push(part)

		for (const link of part.links) if (link.external !== true) queue.push(link.target)
	}

	return out
}

// An edited chart's version as the parts a copy takes for it: the chart under `name`, its workbook, the relationships
// its source part had.
function chartVersionParts(context: CallContext, version: NonNullable<ReturnType<typeof heldChart>>, name: string, owned: Owned): void {
	const workbook = versionWorkbook(version)
	const rels = version.lineage.rels
	const workbookRel = rels.find(rel => !rel.external && WORKBOOK_TYPES.has(rel.type))
	const links: CarriedPart["links"][number][] = []

	for (const rel of rels) {
		if (rel === workbookRel && workbook !== undefined) continue

		links.push(
			rel.external
				? { id: rel.id, type: rel.type, target: rel.target, external: true }
				: { id: rel.id, type: rel.type, target: zip(rel.target) }
		)
	}

	if (workbook !== undefined) {
		const xls = workbook.kind === "xls"
		const extension = xls ? ".xls" : ".xlsx"
		const target =
			workbookRel !== undefined && zip(workbookRel.target).toLowerCase().endsWith(extension)
				? zip(workbookRel.target)
				: unsavedName(
						context,
						owned,
						xls ? "ppt/embeddings/Microsoft_Excel_97-2003_Worksheet.xls" : "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx"
					)

		links.push({
			id: workbookRel?.id ?? INSERTED_WORKBOOK_ID,
			type: xls ? RELATIONSHIP_TYPES.oleObject : RELATIONSHIP_TYPES.embeddedWorkbook,
			target
		})
		owned.overrides.set(partKey(target), { name: target, contentType: workbook.contentType, bytes: workbook.bytes.slice(), links: [] })
	}

	owned.overrides.set(partKey(name), { name, contentType: CHART_TYPE, bytes: version.bytes.slice(), links })
}

// What a diagram frame's parts are as the session holds them, under the names its relationships `targets` give each
// role: an edited one's held parts (its data naming no drawing: the consumer lays it out, as a save without one
// writes it), a part another than the relationship's (a layout switched to), and the drawing the package's data names.
async function diagramParts(
	context: CallContext,
	source: ChartPartSource,
	frame: Extract<NonNullable<ShapeNode["frame"]>, { kind: "smartart" }>,
	targets: readonly ({ readonly id: string; readonly name: string } | undefined)[],
	relationships: Relationships,
	owned: Owned
): Promise<Refused | undefined> {
	const deck = context.session.deck
	const edits = sessionEdits(context.session)
	const parts = pptxParts(deck)

	for (const [k, role] of DIAGRAM_ROLES.entries()) {
		const target = targets[k]
		const field = frame[role.field]

		if (target === undefined || field === "") continue

		if (field.startsWith(RAW_PREFIX)) {
			const document = edits.rawDocument(field)

			if (document === undefined) return refused("stale", `the diagram part ${field} is not held`)

			if (role.field !== "data") {
				owned.overrides.set(partKey(target.name), {
					name: target.name,
					contentType: DIAGRAM_CONTENT_TYPES[role.field],
					bytes: document.bytes.slice(),
					links: []
				})

				continue
			}

			// A picture an edit put in that no save stored yet lives in the worker's registry.
			if (pendingImageIds(document).length > 0) return refused("unsupported", "a diagram picture no save stored yet")

			const owner = diagramRelationshipOwner(deck, field)
			const pictures = owner === undefined ? undefined : await sessionPart(context, source, owner)

			if (pictures !== undefined && isRefused(pictures)) return pictures

			owned.overrides.set(partKey(target.name), {
				name: target.name,
				contentType: DIAGRAM_CONTENT_TYPES.data,
				bytes: withDrawingReference(document, undefined),
				links: pictures?.links ?? []
			})

			continue
		}

		if (partKey(field) !== partKey(target.name)) {
			const part = await sessionPart(context, source, field)

			if (isRefused(part)) return part

			owned.overrides.set(partKey(target.name), { ...part, name: target.name })
		}

		if (role.field !== "data") continue

		let document = parts?.document(field)

		if (document === undefined) {
			const part = owned.overrides.get(partKey(target.name)) ?? (await sessionPart(context, source, field))

			if (isRefused(part)) return part

			try {
				document = parseXml(part.bytes)
			} catch {
				return refused("malformed", `the diagram data ${field}`)
			}
		}

		const drawing = diagramDrawingRelId(document)
		const related = drawing === undefined ? undefined : relationships.byId(drawing)

		if (drawing !== undefined && related !== undefined && !related.external) owned.accompany.set(drawing, target.id)
	}

	return undefined
}

// The parts a copied shape's frames own as the session holds them (its group's members' too).
async function framesOwned(
	context: CallContext,
	source: ChartPartSource,
	shape: ShapeNode,
	document: XmlDocument | undefined,
	relationships: Relationships,
	owned: Owned
): Promise<Refused | undefined> {
	const deck = context.session.deck
	const frame = shape.frame
	const src = shape.src?.format === "pptx" ? shape.src : undefined

	if (frame !== undefined && src !== undefined && document !== undefined && shape.lock === undefined) {
		if (frame.kind === "chart" && isHeldChart(frame.part)) {
			const version = heldChart(deck, frame.part)
			const element = descendant(document, src.node, G.C, "chart")
			const id = element < 0 ? undefined : partReader(document).rel(element, "id")
			const target = id === undefined ? undefined : relationships.byId(id)?.partName

			if (version === undefined || target === undefined) return refused("stale", "the copied chart's version")

			chartVersionParts(context, version, target, owned)
		}

		if (frame.kind === "smartart") {
			const element = descendant(document, src.node, G.Dgm, "relIds")
			const r = partReader(document)
			const targets = DIAGRAM_ROLES.map(role => {
				const id = element < 0 ? undefined : r.rel(element, role.attribute)
				const name = id === undefined ? undefined : relationships.byId(id)?.partName

				return id === undefined || name === undefined ? undefined : { id, name }
			})
			const failed = await diagramParts(context, source, frame, targets, relationships, owned)

			if (failed !== undefined) return failed
		}
	}

	for (const child of shape.children ?? []) {
		const failed = await framesOwned(context, source, child, document, relationships, owned)

		if (failed !== undefined) return failed
	}

	return undefined
}

// The source document a shape is read from, or why there is none to copy it from.
function sourceDocument(context: CallContext, shape: ShapeNode): XmlDocument | undefined | Refused {
	const parts = pptxParts(context.session.deck)

	if (parts === undefined) return refused("notImplemented", "copy")

	const src = shape.src?.format === "pptx" ? shape.src : undefined
	const held = src !== undefined && src.part.startsWith(RAW_PREFIX)
	const document = src === undefined ? undefined : held ? sessionEdits(context.session).rawDocument(src.part) : parts.document(src.part)

	if (src !== undefined && (document === undefined || (!held && src.epoch !== parts.epoch)))
		return refused("stale", "the copied shape's source")

	return document
}

// The family that writes a copied element: a frame's own parts are the copy's (framesOwned), so a chart or a diagram
// frame is written as the shape family writes it (its a:graphic as its source has it).
function copyFamily(request: EmitRequest): ReturnType<typeof emitFamilyOf> {
	const family = emitFamilyOf(request)

	return family === "chart" || family === "smartart" ? "shape" : family
}

// A frame no save wrote yet (an inserted chart or diagram): written whole from the model, naming its parts by ids the
// recorder gives them, the parts as the session holds them.
async function newFrameMarkup(
	context: CallContext,
	source: ChartPartSource,
	shape: ShapeNode,
	recorder: ClipParts,
	relationships: Relationships,
	owned: Owned
): Promise<EmitResult | undefined> {
	const deck = context.session.deck
	const frame = shape.frame

	if (frame?.kind === "chart") {
		const version = isHeldChart(frame.part) ? heldChart(deck, frame.part) : undefined
		const home = version?.lineage.home
		const name =
			home !== undefined ? zip(home) : isHeldChart(frame.part) ? unsavedName(context, owned, "ppt/charts/chart.xml") : zip(frame.part)

		if (version !== undefined) chartVersionParts(context, version, name, owned)
		else if (isHeldChart(frame.part)) return refused("stale", "the copied chart's version")

		return newChartFrame(shape, recorder.relate(name, RELATIONSHIP_TYPES.chart))
	}

	if (frame?.kind === "smartart") {
		const targets = DIAGRAM_ROLES.map(role => {
			const field = frame[role.field]

			if (field === "") return undefined

			const name = field.startsWith(RAW_PREFIX) ? unsavedName(context, owned, role.like) : zip(field)

			return { id: recorder.relate(name, role.type), name }
		})
		const failed = await diagramParts(context, source, frame, targets, relationships, owned)

		if (failed !== undefined) return failed

		const [data, layout, style, colors] = targets

		return newDiagramFrame(shape, { data: data?.id ?? "", layout: layout?.id ?? "", style: style?.id ?? "", colors: colors?.id ?? "" })
	}

	return undefined
}

// A PresentationML shape written out whole and self-contained, and the ids its markup names. Markup the file locks is
// its source element as written.
async function emitShape(
	context: CallContext,
	source: ChartPartSource,
	node: SlideNode,
	shape: ShapeNode,
	recorder: ClipParts,
	relationships: Relationships,
	owned: Owned
): Promise<{ readonly raw: Uint8Array; readonly named: ReadonlySet<string> } | Refused> {
	const deck = context.session.deck
	const parts = pptxParts(deck)

	if (parts === undefined) return refused("notImplemented", "copy")

	const edits = sessionEdits(context.session)
	const src = shape.src?.format === "pptx" ? shape.src : undefined
	const document = sourceDocument(context, shape)

	if (isRefused(document)) return document

	const failed = await framesOwned(context, source, shape, document, relationships, owned)

	if (failed !== undefined) return failed

	const emit: EmitContext = {
		deck,
		document,
		parts: recorder,
		mode: "model",
		slidePart: ref => parts.partOf(ref),
		dispatch: (request, inner) => emitPptx(copyFamily(request), request, inner),
		relationships,
		rawDocument: name => edits.rawDocument(name),
		...(src === undefined ? {} : { documentPart: src.part })
	}
	const request: EmitRequest = { slide: node, shape, touch: { kind: "shape", slide: node.ref, shape: shape.id, dirt: { kind: "node" } } }
	let bytes: Uint8Array

	if (shape.lock !== undefined && src !== undefined && document !== undefined) bytes = document.raw(src.node)
	else {
		let result: EmitResult

		try {
			const fresh = src === undefined ? await newFrameMarkup(context, source, shape, recorder, relationships, owned) : undefined

			result = fresh ?? emitPptx(copyFamily(request), request, emit)

			if (result.kind === "refused" && result.reason === "notImplemented") result = emitPptx("shape", request, emit)
		} catch (error) {
			if (error instanceof PresentationError) return refused(error.reason, error.message)

			throw error
		}

		if (result.kind === "refused") return result

		if (result.kind === "unchanged") {
			if (src === undefined || document === undefined) return refused("failed", "a new shape emitted as unchanged")

			bytes = document.raw(src.node)
		} else bytes = markupBytes(result, document)
	}

	const scope = src === undefined || document === undefined ? new Map<string, string>() : inheritedDeclarations(document, src.node)
	const raw = selfContained(bytes, scope)

	if (isRefused(raw)) return raw

	try {
		return { raw, named: namedRelationshipIds(raw) }
	} catch {
		return refused("malformed", "the copied shape's markup")
	}
}

// What a clip names, from the recorder's relationships and the slide's: a part the copy owns with every part it
// reaches.
async function clipRelationships(
	context: CallContext,
	source: ChartPartSource,
	named: ReadonlySet<string>,
	recorder: ClipParts,
	relationships: Relationships,
	owned: Owned
): Promise<ClipRelationship[] | Refused> {
	const deck = context.session.deck
	const parts = pptxParts(deck)
	const out: ClipRelationship[] = []
	const budget = { left: CLIP_PARTS_BYTES }
	const ids = [...named]

	// A drawing its diagram's data names, with that diagram.
	for (const [id, by] of owned.accompany) if (named.has(by) && !named.has(id)) ids.push(id)

	for (const id of ids) {
		const made = recorder.made.get(id)
		const relationship = relationships.byId(id)
		const type = made?.type ?? relationship?.type
		const external = made?.external ?? relationship?.external ?? false
		const target = made?.target ?? (external ? relationship?.target : relationship?.partName)

		if (type === undefined || target === undefined) return refused("malformed", `relationship ${id} of the copied shape names nothing`)

		const kind = relationshipKind(type) ?? ""

		if (!external && ownedType(type) && made?.bytes === undefined) {
			const tree = await treeOf(context, source, target, owned, budget)

			if (isRefused(tree)) return tree

			const root = tree[0]

			if (root === undefined) return refused("failed", "an empty copied part")

			const accompanies = owned.accompany.get(id)

			out.push({
				id,
				type,
				target: root.name,
				contentType: root.contentType,
				size: root.bytes.length,
				bytes: root.bytes,
				tree,
				...(accompanies === undefined ? {} : { with: accompanies })
			})

			continue
		}

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
			const blocked = uncopyable(shape, deck.format)

			if (blocked !== undefined) return refused(blocked, "this object is not copied")
			// Markup the file locks is copied as written, its box in its group's space: never out of its group alone.
			if (shape.lock !== undefined && (findShape(node.shapes, shape.id)?.parent ?? 0) !== 0)
				return refused("locked", "a locked member of a group")
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
			const source = chartPartSource(context.session, parts)
			const owned: Owned = { overrides: new Map(), accompany: new Map(), named: new Set() }

			for (const shape of chosen) {
				const emitted = await emitShape(context, source, node, shape, recorder, rels, owned)

				if (isRefused(emitted)) return emitted

				for (const id of emitted.named) named.add(id)

				shapes.push({ raw: emitted.raw })
			}

			const listed = await clipRelationships(context, source, named, recorder, rels, owned)

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

	return withClipReading(context, { family: "slide", kind: "delete", slides }, async reading => {
		// A cut's slides leave this deck: a paste into another takes them as they were cut.
		const foreign = cut && deck.format === "pptx" ? await exportedSlides(context, slides) : undefined

		if (foreign !== undefined && isRefused(foreign)) return foreign

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

		return {
			kind: "slides",
			format: deck.format,
			slides,
			text,
			...(cut ? { held } : {}),
			...(foreign === undefined ? {} : { foreign })
		} satisfies SlideClip
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
	clipParts: (context, names) => clipParts(context, names),
	clipSlides: (context, slides) => clipSlides(context, slides)
}

// A notes body as new notes of another deck take it: text, breaks and fields, without what is kept as source.
function portableNotes(node: SlideNode | undefined): TextBody | undefined {
	const body = notesBody(node)?.text

	if (body === undefined) return undefined

	return {
		...cloneModel(body),
		paragraphs: body.paragraphs.map(paragraph => ({
			...cloneModel(paragraph),
			runs: paragraph.runs.filter(run => run.kind !== "opaque")
		}))
	}
}

// The slides a paste into another deck takes (pptx): each as a save writes a copy of it (its edits in, its charts,
// diagrams, embedded objects and notes copied), with its layout's type and name and its notes' body, within
// CLIP_PARTS_BYTES in all. Asked when the paste comes, as a paste within the deck duplicates the slides as they are.
export async function clipSlides(context: CallContext, refs: readonly SlideRef[]): Promise<ClipSlidesResult> {
	const session = context.session
	const deck = session.deck

	if (deck.format !== "pptx" || pptxParts(deck) === undefined) return { ok: false, refusal: "unsupported" }
	if (refs.length === 0) return { ok: false, refusal: "notFound" }

	for (const ref of refs) if (!deck.slides.includes(ref)) return { ok: false, refusal: "notFound" }

	const slides = [...new Set(refs)].sort((a, b) => deck.slides.indexOf(a) - deck.slides.indexOf(b))

	try {
		return await withClipReading(context, { family: "slide", kind: "hide", slides, hidden: false }, async () => {
			const out = await exportedSlides(context, slides)

			return isRefused(out) ? { ok: false, refusal: out.reason } : { ok: true, slides: out }
		})
	} catch (error) {
		if (error instanceof PresentationError) return { ok: false, refusal: error.reason }

		throw error
	}
}

// The slides (parsed, in deck order) as clipSlides hands them over; run with commands queued (withClipReading).
async function exportedSlides(context: CallContext, slides: readonly SlideRef[]): Promise<ImportedSlide[] | Refused> {
	const session = context.session
	const deck = session.deck
	const edits = sessionEdits(session)
	const changes = edits.changes()

	// Edited diagrams laid out first, as a save does: the copy holds the drawing the renderer draws.
	await layoutEditedDiagrams(session, changes, context.slicing)

	const exported = await exportSlides(
		{ deck, source: pptxSaveSource(session), changes, revision: edits.history.savePoint().revision },
		slides
	)

	if (isRefused(exported)) return exported

	let total = 0
	const out: ImportedSlide[] = []

	for (const [k, parts] of exported.entries()) {
		for (const part of parts) total += part.bytes.length + (part.rels?.length ?? 0)

		if (total > CLIP_PARTS_BYTES) return refused("tooLarge", "the copied slides' parts")

		const node = deck.nodes.get(slides[k] as SlideRef)
		const layout = node?.parent === undefined ? undefined : deck.nodes.get(node.parent)
		const notes = node?.notes === undefined ? undefined : portableNotes(deck.nodes.get(node.notes))

		out.push({
			parts,
			layout: {
				...(layout?.layoutType === undefined ? {} : { type: layout.layoutType }),
				...(layout?.name === undefined ? {} : { name: layout.name })
			},
			...(notes === undefined ? {} : { notes })
		})
	}

	return out
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

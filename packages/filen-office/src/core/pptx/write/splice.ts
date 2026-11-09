import { relationshipKind } from "../../docx/index"
import { Relationships, crc32, parseRelationships, partKey } from "../../opc/index"
import { classifyAction } from "../../presentation/actions"
import { DeckTally, DEFAULT_PRESENTATION_BUDGETS } from "../../presentation/budget"
import type { DeckChanges, Dirt, PartChanges } from "../../presentation/edit/apply"
import { creationId, nextSlideId } from "../../presentation/ids"
import {
	PresentationError,
	refused,
	type Deck,
	type Paragraph,
	type Refused,
	type ShapeNode,
	type SlideNode,
	type SlideRef,
	type Xfrm
} from "../../presentation/model"
import { decodeUtf8, encodeUtf8, escapeAttribute, escapeText, parseXml, type XmlDocument, type XmlEditor } from "../../xml/index"
import { readSlidePart, SlidePartError } from "../read/slide"
import { timingContainer } from "./emit/timing"
import { G, P_MAIN, partReader, type PartReader } from "../read/xml"
import { emitFamilyOf, emitPptx } from "./emit"
import { notePackageDiagramData, noteSharedDiagramParts, type PackageDiagramData } from "./emit/smartart"
import { URIS, alternateUnit, childElements, sameModel, xfrmXml, type EmitContext, type Pristine } from "./emit/shape"
import { slideRoot } from "./emit/slide"
import { placeTransition } from "./emit/transition"
import { builtinTableStyleIds, builtinTableStylesPart } from "./emit/table"
import { showPrMarkup, spliceShowPr } from "./emit/presentation"
import { spliceDesign } from "./emit/design"
import { spliceNotes } from "./emit/notes"
import { spliceComments } from "./emit/comment"
import { DEFAULT_SHOW } from "../read/props"
import {
	PART_CONTENT_TYPES,
	PackageWriter,
	RELATIONSHIPS,
	heldDeckParts,
	noteDeckReleased,
	copiedKind,
	modelName,
	zipName,
	type PendingRelationship,
	type SaveNotice
} from "./parts"
import type { RawPart } from "../../presentation/edit/ops"
import { copiedWithoutNotes } from "../../presentation/edit/apply/slide"
import { diagramDrawingRelId, diagramRelationshipOwner, notePackageDrawingRel } from "../../presentation/edit/apply/smartart"
import type { EmitPiece, EmitRequest, EmitResult, PptxPartIndex, PptxSaveInput, PptxSnapshot, PptxSource } from "./types"
import { normalSlide, type GateExpectation, type NormalSlide } from "./verify"
import { isRefused } from "../../presentation/refusal"
import { rescaleMarkup, scaledValues, type ScaledValues } from "../../presentation/edit/apply/designScale"

// The splice writer (same-format source): every touched part gets one XmlEditor and the smallest edit its dirt needs
// (an xfrm's attributes; an element replaced by its family's markup, holes copying the source by span; the whole root
// when the shape tree changed shape); parts nobody touched are copied as their raw zip entries. Slide lists, sections,
// custom shows, docProps/app.xml, relationships and content types follow the slides added, copied and removed, and a
// removal takes the parts only that slide used with it (orphans are never left).

// Markup an undo re-read after a save's rebase, held by the session under "raw:N" names (dom/presentation engine
// edit state): a shape whose source is one is written from that document; a restored slide from its bytes.
export interface RawSources {
	document(name: string): XmlDocument | undefined
	part(name: string): RawPart | undefined
	// Every part a restored slide's "raw:N" holds: the slide first, then the parts it owned and the shared ones its
	// removal took (each with its relationships).
	parts?(name: string): readonly RawPart[] | undefined
}

export type PptxSpliceSource = PptxSource & { readonly raw?: RawSources }

export function isRawPart(part: string): boolean {
	return part.startsWith("raw:")
}

const SLIDE_RELATIONSHIP = `${RELATIONSHIPS}slide`
const DIAGRAM_DRAWING_RELATIONSHIP = "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing"
const MAX_DIAGRAM_DEPTH = 128
const DIAGRAM_KINDS: ReadonlySet<string> = new Set(["diagramData", "diagramLayout", "diagramQuickStyle", "diagramColors", "diagramDrawing"])
const LAYOUT_RELATIONSHIP = `${RELATIONSHIPS}slideLayout`
const SECTIONS_EXT = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"
const P14_URI = URIS["p14"] ?? ""

export interface SpliceSnapshot extends PptxSnapshot {
	readonly kind: "snapshot"
	// What gate 2 compares the written package with: every slide written as the snapshot held it, the slide list
	// and sections by part.
	readonly expectation: GateExpectation
	readonly notices: readonly SaveNotice[]
	readonly source: PptxSpliceSource
}

interface BaseSlide {
	readonly id: number
	readonly rId: string
	readonly part: string
	readonly node: number
}

// One element's byte range replaced while assembling holes (an xfrm inside a kept mc:AlternateContent).
type Overlay = Map<number, string>

// Pieces as bytes: holes copied from `document` by span, with `overlay`'s elements replaced inside them.
export function assemble(document: XmlDocument | undefined, pieces: readonly EmitPiece[], overlay: Overlay = new Map()): Uint8Array {
	const chunks: Uint8Array[] = []
	let total = 0
	const push = (chunk: Uint8Array): void => {
		chunks.push(chunk)
		total += chunk.length
	}
	const ranges = [...overlay].map(([node, markup]) => ({
		from: document?.start(node) ?? 0,
		to: document?.end(node) ?? 0,
		bytes: encodeUtf8(markup)
	}))

	ranges.sort((a, b) => a.from - b.from)

	for (const piece of pieces) {
		if (typeof piece === "string") {
			push(encodeUtf8(piece))

			continue
		}

		if (piece instanceof Uint8Array) {
			push(piece)

			continue
		}

		if (document === undefined) throw new PresentationError("failed", "A hole without a source document")

		const from = document.start(piece.hole)
		const to = document.end(piece.hole)
		let at = from

		for (const range of ranges) {
			if (range.from < from || range.to > to || range.from < at) continue

			push(document.bytes.subarray(at, range.from))
			push(range.bytes)
			at = range.to
		}

		push(document.bytes.subarray(at, to))
	}

	const out = new Uint8Array(total)
	let offset = 0

	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.length
	}

	return out
}

function markupOf(result: EmitResult): readonly EmitPiece[] | Refused {
	if (result.kind === "refused") return result
	if (result.kind === "unchanged") return []

	return result.pieces
}

function walk(shapes: readonly ShapeNode[], visit: (shape: ShapeNode) => void): void {
	for (const shape of shapes) {
		visit(shape)
		if (shape.children !== undefined) walk(shape.children, visit)
	}
}

function findShape(shapes: readonly ShapeNode[], id: number): ShapeNode | undefined {
	let found: ShapeNode | undefined

	walk(shapes, shape => {
		if (found === undefined && shape.id === id) found = shape
	})

	return found
}

// The shape elements of a source tree (spTree or grpSp) in order: shapes, opaque content and mc:AlternateContent
// wrappers; the tree's own properties and extension list are not shapes.
function sourceUnits(r: PartReader, tree: number): number[] {
	const out: number[] = []

	for (let child = r.first(tree); child >= 0; child = r.next(child)) {
		const group = r.group(child)
		const local = r.local(child)

		if (group === G.P && (local === "nvGrpSpPr" || local === "grpSpPr" || local === "extLst")) continue
		if (group !== G.P && group !== G.P14 && group !== G.MC) continue

		out.push(child)
	}

	return out
}

// The model's tree matches the source's element for element (no shape added, removed or moved), so edits can stay
// inside the shapes.
function sameStructure(context: EmitContext, r: PartReader, tree: number, shapes: readonly ShapeNode[], epoch: number): boolean {
	const units = sourceUnits(r, tree)
	const modelUnits: number[] = []

	for (const shape of shapes) {
		if (shape.src?.format !== "pptx" || shape.src.epoch !== epoch || partKey(shape.src.part) !== partKey(context.pristine?.part ?? ""))
			return false

		const unit = alternateUnit(context, shape.src.node)

		if (modelUnits[modelUnits.length - 1] === unit && unit !== shape.src.node) continue

		modelUnits.push(unit)
	}

	if (units.length !== modelUnits.length || units.some((unit, index) => unit !== modelUnits[index])) return false

	for (const shape of shapes) {
		if (shape.kind !== "grpSp" || shape.children === undefined || shape.lock === "alternateContent") continue
		if (shape.src === undefined || !sameStructure(context, r, shape.src.node, shape.children, epoch)) return false
	}

	return true
}

// The xfrm element of a source shape element, -1 when it has none.
function xfrmNode(r: PartReader, element: number): number {
	switch (r.local(element)) {
		case "sp":
		case "cxnSp":
		case "pic":
			return r.child(r.child(element, G.P, "spPr"), G.A, "xfrm")
		case "grpSp":
			return r.child(r.child(element, G.P, "grpSpPr"), G.A, "xfrm")
		case "graphicFrame":
			return r.child(element, G.P, "xfrm")
		case "contentPart": {
			const p14 = r.child(element, G.P14, "xfrm")

			return p14 >= 0 ? p14 : r.child(element, G.P, "xfrm")
		}
		default:
			return -1
	}
}

function xfrmTag(r: PartReader, element: number): string {
	switch (r.local(element)) {
		case "graphicFrame":
			return "p:xfrm"
		case "contentPart":
			return r.child(element, G.P14, "xfrm") >= 0 ? "p14:xfrm" : "p:xfrm"
		default:
			return "a:xfrm"
	}
}

// The xfrm of a shape as attribute edits on its source xfrm (the smallest edit); false when that cannot express it
// (no source xfrm, or one without a:off and a:ext).
function setXfrmAttributes(editor: XmlEditor, r: PartReader, element: number, xfrm: Xfrm | undefined, group: boolean): boolean {
	const node = xfrmNode(r, element)

	if (node < 0 || xfrm === undefined) return false

	const off = r.child(node, G.A, "off")
	const ext = r.child(node, G.A, "ext")
	const chOff = r.child(node, G.A, "chOff")
	const chExt = r.child(node, G.A, "chExt")

	if (off < 0 || ext < 0 || (group && (chOff < 0 || chExt < 0))) return false

	const set = (target: number, name: string, value: number): void => {
		if (r.attr(target, name) !== String(value)) editor.setAttribute(target, name, String(value))
	}
	const flag = (name: string, on: boolean): void => {
		if ((r.bool(node, name) ?? false) === on) return

		if (on) editor.setAttribute(node, name, "1")
		else editor.removeAttribute(node, name)
	}

	set(off, "x", Math.round(xfrm.x))
	set(off, "y", Math.round(xfrm.y))
	set(ext, "cx", Math.max(0, Math.round(xfrm.cx)))
	set(ext, "cy", Math.max(0, Math.round(xfrm.cy)))

	if ((r.int(node, "rot") ?? 0) !== Math.round(xfrm.rot)) {
		if (xfrm.rot === 0) editor.removeAttribute(node, "rot")
		else editor.setAttribute(node, "rot", String(Math.round(xfrm.rot)))
	}

	flag("flipH", xfrm.flipH)
	flag("flipV", xfrm.flipV)

	if (group) {
		set(chOff, "x", Math.round(xfrm.chX ?? xfrm.x))
		set(chOff, "y", Math.round(xfrm.chY ?? xfrm.y))
		set(chExt, "cx", Math.max(0, Math.round(xfrm.chCx ?? xfrm.cx)))
		set(chExt, "cy", Math.max(0, Math.round(xfrm.chCy ?? xfrm.cy)))
	}

	return true
}

// The branches' copies of a shape inside an mc:AlternateContent (same cNvPr id, same element), so a move updates
// every branch.
function branchCopies(r: PartReader, unit: number, element: number): number[] {
	const document = r.document
	const local = r.local(element)
	const idOf = (node: number): string | undefined => {
		for (let child = r.first(node); child >= 0; child = r.next(child)) {
			if (r.local(child).startsWith("nv")) return r.attr(r.child(child, r.group(child), "cNvPr"), "id")
		}

		return undefined
	}
	const id = idOf(element)
	const out: number[] = []

	for (let node = unit + 1; node < document.count && document.start(node) < document.end(unit); node++) {
		if (r.group(node) === r.group(element) && r.local(node) === local && idOf(node) === id) out.push(node)
	}

	return out
}

// Builds the reader's view of a part again from its source (a fresh tally, nothing counted against the deck).
function readPristine(
	writer: PackageWriter,
	index: PptxPartIndex,
	baseSlides: ReadonlySet<SlideRef>,
	node: SlideNode,
	part: string,
	document: XmlDocument,
	relationships: Relationships,
	epoch: number = index.epoch
): Pristine {
	const read = readSlidePart({
		ref: node.ref,
		part,
		document,
		relationships,
		epoch,
		tally: new DeckTally(DEFAULT_PRESENTATION_BUDGETS),
		media: {
			contentType: name => writer.contentTypes.typeOf(zipName(name)),
			size: name => writer.opc.entry(zipName(name))?.uncompressedSize
		},
		refOf: name => index.refOf(name),
		themeOf: name => (node.theme !== undefined && partKey(node.theme.part) === partKey(name) ? node.theme : undefined),
		action: (reader, rels, target) => {
			const id = reader.rel(target, "id")
			const relationship = id === undefined || id === "" ? undefined : rels.byId(id)
			const action = reader.attr(target, "action")

			return classifyAction(
				{
					...(action === undefined ? {} : { action }),
					...(relationship === undefined
						? {}
						: {
								target: {
									external: relationship.external,
									target: relationship.target,
									...(relationship.partName === undefined ? {} : { partName: `/${relationship.partName}` })
								}
							})
				},
				{
					slideOf: name => {
						const ref = index.refOf(name)

						return ref !== undefined && baseSlides.has(ref) ? ref : undefined
					}
				}
			)
		}
	})
	const shapes = new Map<number, ShapeNode>()
	const paragraphs = new Map<number, Paragraph>()

	walk(read.node.shapes, shape => {
		if (shape.src !== undefined) shapes.set(shape.src.node, shape)

		for (const paragraph of shape.text?.paragraphs ?? []) if (paragraph.src !== undefined) paragraphs.set(paragraph.src.node, paragraph)
	})

	return { part, epoch, slide: read.node, shapes, paragraphs }
}

// The index of a deck opened without one: parsed nodes only.
function deckIndex(deck: Deck): PptxPartIndex {
	const byPart = new Map<string, SlideRef>()

	for (const node of deck.nodes.values()) byPart.set(partKey(node.part), node.ref)

	return {
		epoch: [...deck.nodes.values()].find(node => node.src !== undefined)?.src?.epoch ?? 0,
		partOf: ref => deck.nodes.get(ref)?.part,
		slideId: () => undefined,
		refOf: part => byPart.get(partKey(part))
	}
}

// Prefixes p, a and r bound to the Transitional namespaces at the root, as every markup the families write assumes.
function checkPrefixes(document: XmlDocument, part: string): Refused | undefined {
	const r = partReader(document)
	const root = document.documentElement()
	const scope = r.namespaces.inScope(root)

	for (const prefix of ["p", "a", "r"]) {
		const uri = scope.get(prefix)

		if (uri !== undefined && uri !== URIS[prefix]) return refused("unsupported", `${part} binds ${prefix}: to ${uri}`)
	}

	return undefined
}

// Child shapes go to the family that writes them.
function dispatch(request: EmitRequest, context: EmitContext): EmitResult {
	return emitPptx(emitFamilyOf(request), request, context)
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

class Splice {
	readonly writer: PackageWriter
	readonly input: PptxSaveInput
	readonly source: PptxSpliceSource
	readonly index: PptxPartIndex
	readonly deck: Deck
	readonly written: NormalSlide[] = []
	readonly notices: SaveNotice[] = []
	private mainPart = ""
	private baseSlides: BaseSlide[] = []
	private baseRefs = new Set<SlideRef>()
	// Final slide parts (zip names) by ref.
	private readonly finalParts = new Map<SlideRef, string>()
	private readonly removedSlides = new Set<string>()
	private readonly rawPristines = new Map<string, Pristine | undefined>()
	// The sections as written (slides in no section joined to the one before them), when the list was rewritten.
	private writtenSections: { name: string; id: string; slides: string[] }[] | undefined
	// Each slide's p:sldId as presentation.xml is written.
	private writtenIds = new Map<SlideRef, number>()

	constructor(input: PptxSaveInput, writer: PackageWriter) {
		this.input = input
		this.writer = writer
		this.source = input.source as PptxSpliceSource
		this.index = this.source.index ?? deckIndex(input.deck)
		this.deck = input.deck
	}

	private changesOf(part: string): PartChanges | undefined {
		const key = partKey(part)

		for (const [name, change] of this.input.changes.parts) if (partKey(name) === key) return change

		return undefined
	}

	// The part a slide is written to after this save (the model's name for one the index does not know).
	slidePart = (ref: SlideRef): string | undefined => {
		const part = this.finalParts.get(ref)

		return part === undefined ? undefined : modelName(part)
	}

	async run(): Promise<SpliceSnapshot | Refused> {
		const { writer, deck } = this
		const packageRelationships = await writer.opc.relationships("")
		const main = packageRelationships.all.find(
			relationship => !relationship.external && relationshipKind(relationship.type) === "officeDocument"
		)

		if (main?.partName === undefined) return refused("malformed", "The package has no main part")

		this.mainPart = main.partName

		const presentation = await writer.loadDocument(this.mainPart)
		const presentationRels = await writer.loadRelationships(this.mainPart)
		const r = partReader(presentation)
		const root = presentation.documentElement()

		for (const entry of r.children(r.child(root, G.P, "sldIdLst"), G.P, "sldId")) {
			const rId = r.rel(entry, "id")
			const target = rId === undefined ? undefined : presentationRels.byId(rId)

			if (target === undefined || target.external || !writer.opc.has(target.target)) continue

			this.baseSlides.push({ id: r.int(entry, "id") ?? 0, rId: target.id, part: target.target, node: entry })

			const ref = this.index.refOf(modelName(target.target))

			if (ref !== undefined) this.baseRefs.add(ref)
		}

		// Which slides stay, which are new, which go.
		const kept = new Set<string>()
		const added: { ref: SlideRef; node: SlideNode }[] = []

		for (const ref of deck.slides) {
			const part = this.index.partOf(ref) ?? deck.nodes.get(ref)?.part
			const name = part === undefined ? undefined : zipName(part)
			const base = name === undefined ? undefined : this.baseSlides.find(slide => partKey(slide.part) === partKey(name))

			// The package's part is this slide's only when the index binds it to this slide: a slide the session holds
			// under a name a save gave another node (deleted while that save landed, then restored) is written anew.
			if (
				base !== undefined &&
				!kept.has(partKey(base.part)) &&
				this.changesOf(base.part)?.change !== "added" &&
				this.index.refOf(modelName(base.part)) === ref
			) {
				kept.add(partKey(base.part))
				this.finalParts.set(ref, base.part)

				continue
			}

			const node = deck.nodes.get(ref)

			if (node === undefined) return refused("failed", `The new slide ${String(ref)} was not parsed before the save`)

			const own = zipName(node.part)
			const nameOf =
				own !== "" && !writer.opc.has(own) && writer.claim(own) ? own : writer.allocate("slide", PART_CONTENT_TYPES.slide)

			this.finalParts.set(ref, nameOf)
			added.push({ ref, node })
		}

		for (const slide of this.baseSlides) if (!kept.has(partKey(slide.part))) this.removedSlides.add(partKey(slide.part))

		// New slides first, so what a removal takes is judged against every part that stays, copies included (a copy
		// shares its original's pictures and media).
		// Diagram parts more than one slide of the package relates (an edit of one diagram writes parts of its own).
		await this.noteSharedDiagramParts()
		await this.notePackageDiagramData()

		// A slide written from the model whose diagrams name parts this save adds (a slide an undo restored brings them
		// back) comes after those, so it relates what they are.
		const later = added.filter(({ node }) => this.namesAddedDiagramData(node))

		for (const { ref, node } of [...added.filter(each => !later.includes(each)), ...later]) {
			const result = await this.addSlide(ref, node)

			if (result !== undefined) return result
		}

		const removedParts = this.baseSlides.filter(slide => this.removedSlides.has(partKey(slide.part))).map(slide => slide.part)
		const planned = removedParts.length > 0 ? await writer.planRemoval(removedParts) : new Set<string>()
		const skipped: string[] = []

		// Changed parts that stay: slides, and any other node (layouts, masters, notes) an op touched.
		for (const [part, change] of this.input.changes.parts) {
			if (change.change !== "changed") continue

			const name = zipName(part)

			if (!writer.exists(name) || writer.isAdded(name)) continue

			if (planned.has(partKey(name))) {
				skipped.push(name)

				continue
			}

			const ref = this.index.refOf(modelName(name))
			const node = ref === undefined ? undefined : deck.nodes.get(ref)

			if (node === undefined) return refused("failed", `The changed part ${part} has no parsed node`)

			const result = await this.spliceNode(node, name, change)

			if (result !== undefined) return result
		}

		// Chart parts a frame no longer names (its chart written into another part), with what only they kept.
		await writer.removeUnrelated((source, relationship) => this.dangling(source, relationship))

		// Parts this session wrote that nothing reaches any more (dom/presentation/prune.ts), with what only they kept.
		const proposed = (this.input.prune ?? []).filter(name => writer.exists(name) && !writer.isAdded(name) && !writer.isReplaced(name))
		// The save's own output is the judge: a part a part it writes names stays.
		const named = await writer.namedByWritten(new Set(proposed.map(name => partKey(name))))
		const prune = proposed.filter(name => !named.has(partKey(name)))

		if (prune.length > 0) await writer.removeWithOrphans(prune, (source, relationship) => this.dangling(source, relationship))

		// Removals last: what they take with them, and the jumps that pointed at them.
		if (removedParts.length > 0) {
			const gone = await writer.removeWithOrphans(removedParts, (source, relationship) => this.dangling(source, relationship))

			for (const name of skipped)
				if (!gone.has(partKey(name))) return refused("failed", `The changed part ${name} stays, but was planned for removal`)
		}

		// The built-in table styles named by the tables this save writes from the model (on added slides, and the
		// edited shapes of changed ones), defined in the deck; an untouched table keeps the deck as it was.
		const styled = new Set<string>()

		for (const { node } of added) builtinTableStyleIds(node.shapes, styled)

		for (const [part, change] of this.input.changes.parts) {
			if (change.change === "removed" || change.shapes.size === 0) continue

			const ref = this.index.refOf(modelName(zipName(part)))
			const node = ref === undefined ? undefined : deck.nodes.get(ref)

			if (node !== undefined) builtinTableStyleIds(node.shapes, styled, change.shapes)
		}

		if (styled.size > 0) await this.tableStyles(styled)

		// The slide size and the masters a theme change added or dropped (emit/design.ts).
		const designResult = await spliceDesign({
			writer,
			deck,
			changes: this.input.changes,
			mainPart: this.mainPart,
			slidePart: ref => this.finalParts.get(ref)
		})

		if (designResult !== undefined) return designResult

		const presentationResult = await this.presentation(presentation)

		if (presentationResult !== undefined) return presentationResult

		// Notes slides and notes masters the session made or took back, then the comment and author parts.
		const review = {
			writer,
			deck,
			changes: this.input.changes,
			mainPart: this.mainPart,
			slidePart: (ref: SlideRef) => this.finalParts.get(ref),
			slideId: (ref: SlideRef) => this.writtenIds.get(ref)
		}
		const notesResult = await spliceNotes(review)

		if (notesResult !== undefined) return notesResult

		const commentsResult = await spliceComments(review)

		if (commentsResult !== undefined) return commentsResult

		await this.appProperties()

		const { changes } = await writer.changes()
		const copies = this.source.archive.entries.length - (changes.replace?.length ?? 0) - (changes.remove?.length ?? 0)
		const sections =
			this.writtenSections ??
			deck.sections.map(section => ({
				name: section.name,
				id: section.id,
				slides: section.slides.flatMap(ref => {
					const part = this.finalParts.get(ref)

					return part === undefined ? [] : [modelName(part)]
				})
			}))

		return {
			kind: "snapshot",
			revision: this.input.revision,
			changes,
			copies,
			expectation: {
				slides: this.written,
				slideParts: deck.slides.flatMap(ref => {
					const part = this.finalParts.get(ref)

					return part === undefined ? [] : [modelName(part)]
				}),
				sections,
				mainPart: this.mainPart,
				inheritedMissing: [...writer.inheritedMissing],
				seeded: writer.seeded
			},
			notices: [...this.notices, ...writer.notices],
			source: this.source
		}
	}

	// A surviving part's relationship to a removed slide: a slide jump becomes "next slide" (reported); the
	// presentation's own (its slide list, custom shows) are rebuilt; anything else loses the relationship.
	private async dangling(source: string, relationship: PendingRelationship): Promise<void> {
		const writer = this.writer
		const edit = await writer.loadRelationships(source)

		edit.remove(relationship.id)

		if (partKey(source) === partKey(this.mainPart)) return
		if (relationshipKind(relationship.type) !== "slide") return

		writer.patchAfter(source, (document, editor) => {
			const r = partReader(document)

			for (let node = 1; node < document.count; node++) {
				// A view's slide list entry (p:sldLst/p:sld in viewProps) goes with the slide.
				if (r.is(node, G.P, "sld") && r.rel(node, "id") === relationship.id) {
					editor.remove(node)

					continue
				}

				if (r.group(node) !== G.A || !/^hlink(Click|Hover|MouseOver)$/u.test(r.local(node))) continue
				if (r.rel(node, "id") !== relationship.id) continue

				const prefix = r.namespaces.prefixFor(node, URIS["r"] ?? "") ?? "r"

				editor.setAttribute(node, `${prefix}:id`, "")
				editor.setAttribute(node, "action", "ppaction://hlinkshowjump?jump=nextslide")
			}
		})
		this.notices.push({ kind: "jumpRetargeted", part: modelName(source) })
	}

	// A slide new in this save: a copy of the slide it duplicates (with its notes, comments, charts and diagrams
	// copied, its layout and media shared), or written whole from the model.
	private async addSlide(ref: SlideRef, node: SlideNode): Promise<Refused | undefined> {
		const writer = this.writer
		const name = this.finalParts.get(ref)

		if (name === undefined) return refused("failed", "A new slide without a part name")

		const original = node.src?.format === "pptx" && node.src.epoch === this.index.epoch ? zipName(node.src.part) : undefined
		const layoutPart = node.parent === undefined ? undefined : this.index.partOf(node.parent)

		// A slide restored by an undo after the save it was deleted in: its parts' bytes as the session holds them.
		if (node.src?.format === "pptx" && isRawPart(node.src.part)) {
			const raw = this.source.raw?.part(node.src.part)

			if (raw === undefined) return refused("stale", `The restored slide ${node.src.part} is not held`)

			return this.addRawSlide(name, node, raw, layoutPart)
		}

		if (original !== undefined && writer.opc.has(original)) {
			const notes = node.notes === undefined ? undefined : this.deck.nodes.get(node.notes)
			// The copy's notes slide is written under the name the model gave it (the rebase finds it there).
			const notesName = notes === undefined ? undefined : zipName(notes.part)

			writer.add(name, writer.typeOf(original) ?? PART_CONTENT_TYPES.slide, await writer.opc.read(original))
			// The package's notes slide unless the copy was made without notes (its source had none then: an undo since
			// the last save may have left the package's, and the source may have notes again now). Notes not read yet
			// are still the source's: copied.
			const notesGone = notes === undefined && copiedWithoutNotes(this.deck, ref)

			await writer.copyRelationships(
				original,
				name,
				original,
				name,
				relationship => (relationshipKind(relationship.type) === "notesSlide" ? notesName : undefined),
				relationship => !notesGone || relationshipKind(relationship.type) !== "notesSlide"
			)

			const refusal = await this.writeFromSource(
				name,
				node,
				modelName(original),
				await writer.opc.relationships(original),
				this.index.epoch,
				true
			)

			if (refusal !== undefined) return refusal

			// Relationships an element pasted onto the source (not saved since) names: the copy's markup names them too.
			if (writer.hasReleasedMedia(original)) writer.restoreMedia(name, await writer.writtenText(name), original)

			await writer.dropUnnamedCopies(name)

			if (layoutPart !== undefined) await this.retargetLayout(name, layoutPart)

			// Its notes slide, with the notes node's edits spliced in.
			const copiedNotes = (await writer.loadRelationships(name))
				.all()
				.find(relationship => relationshipKind(relationship.type) === "notesSlide")

			// Notes the session made (no source: a save wrote them from the model, and the rebase left them so) are
			// written from the model under the copy's notes name, as any made notes slide is (emit/notes.ts).
			if (notes !== undefined && notes.src === undefined) return undefined

			if (notes !== undefined && copiedNotes !== undefined && !copiedNotes.external) {
				const source = notes.src?.format === "pptx" && notes.src.epoch === this.index.epoch ? zipName(notes.src.part) : undefined
				const sourceNotes = (await writer.opc.relationships(original)).all.find(
					relationship => relationshipKind(relationship.type) === "notesSlide"
				)

				if (source === undefined || sourceNotes?.partName === undefined || partKey(sourceNotes.partName) !== partKey(source))
					return refused("failed", `The notes of the copied slide ${modelName(original)} are not its source's`)

				return this.writeFromSource(
					copiedNotes.target,
					notes,
					modelName(source),
					await writer.opc.relationships(source),
					this.index.epoch,
					false
				)
			}

			return undefined
		}

		await writer.loadRelationships(name)
		writer.add(name, PART_CONTENT_TYPES.slide, undefined)

		if (layoutPart === undefined) return refused("failed", "A new slide without a layout")

		// First, while the new part's relationship ids are all free: the ones its diagrams' data parts name.
		const drawings = await this.diagramDrawings(name, node.shapes, 0)

		if (drawings !== undefined) return drawings

		writer.relate(name, zipName(layoutPart), LAYOUT_RELATIONSHIP)

		// The parts the session holds resolve here too (a diagram inserted on a slide added since the last save).
		const context: EmitContext = {
			deck: this.deck,
			document: undefined,
			parts: writer.api(modelName(name)),
			mode: "model",
			slidePart: this.slidePart,
			dispatch,
			...(this.source.raw === undefined ? {} : { rawDocument: this.source.raw.document.bind(this.source.raw) })
		}
		const result = markupOf(slideRoot(context, node))

		if (isRefused(result)) return result

		writer.replace(name, concat(encodeUtf8(XML_DECLARATION), assemble(undefined, result)))
		this.expect(name, node)

		// Relationships an element pasted onto the new slide names.
		if (writer.hasReleasedMedia(name)) writer.restoreMedia(name, await writer.writtenText(name))

		return undefined
	}

	// A slide written from the model relates every part its diagrams name: a diagram whose data is a package part
	// names its drawing by a relationship of the slide (dsp:dataModelExt@relId, MS-ODRAWXML §2.3.4), which the new part
	// takes under that id (the frame's drawing is its target). A held data part is the diagram emitter's to write.
	private async noteSharedDiagramParts(): Promise<void> {
		let held = false

		for (const node of this.deck.nodes.values())
			walk(node.shapes, shape => {
				const frame = shape.frame

				if (
					frame?.kind === "smartart" &&
					(isRawPart(frame.data) || isRawPart(frame.layout) || isRawPart(frame.style) || isRawPart(frame.colors))
				)
					held = true
			})

		// Only a save that writes a diagram's parts asks.
		if (!held) {
			noteSharedDiagramParts(this.deck, new Set())

			return
		}

		const seen = new Map<string, number>()

		for (const slide of this.baseSlides)
			for (const relationship of (await this.writer.opc.relationships(slide.part)).all)
				if (
					!relationship.external &&
					relationship.partName !== undefined &&
					DIAGRAM_KINDS.has(relationshipKind(relationship.type) ?? "")
				)
					seen.set(partKey(relationship.partName), (seen.get(partKey(relationship.partName)) ?? 0) + 1)

		noteSharedDiagramParts(this.deck, new Set([...seen].filter(([, count]) => count > 1).map(([key]) => key)))
	}

	// The package diagram data the frames of the slides this save writes name (held data: the package part it was read
	// from): its drawing relationship id for the emitter, and its document and picture targets, for data written into
	// parts of its own (a slide that holds that id for another part, a part another diagram shares).
	private async notePackageDiagramData(): Promise<void> {
		const names = new Set<string>()
		const changed = new Set([...this.input.changes.parts.keys()].map(part => partKey(part)))
		const nodes = [...this.deck.nodes.values()]
		let writes = false

		// Only a save that writes a slide with a diagram reads them (every diagram's: a copy names its source's).
		for (const node of nodes)
			if (changed.has(partKey(node.part)) || this.finalParts.has(node.ref))
				walk(node.shapes, shape => {
					if (shape.frame?.kind === "smartart") writes = true
				})

		if (!writes) {
			notePackageDiagramData(this.deck, new Map())

			return
		}

		for (const node of nodes) {
			walk(node.shapes, shape => {
				const frame = shape.frame

				if (frame?.kind !== "smartart") return

				// Held data with pictures of its own names them through its package part's relationships.
				const data = isRawPart(frame.data) ? diagramRelationshipOwner(this.deck, frame.data) : frame.data

				if (data !== undefined) names.add(data)
			})
		}

		const out = new Map<string, PackageDiagramData>()

		// Parts a slide an undo restored holds (this save writes them back), as the session holds them.
		for (const node of nodes) {
			if (node.src?.format !== "pptx" || !isRawPart(node.src.part)) continue

			for (const part of this.source.raw?.parts?.(node.src.part) ?? []) {
				if (!names.has(part.name) || out.has(part.name.toLowerCase())) continue

				let document: XmlDocument

				try {
					document = parseXml(part.bytes)
				} catch {
					continue
				}

				const relationships = part.rels === undefined ? new Relationships([]) : parseRelationships(part.rels, zipName(part.name))
				const relId = diagramDrawingRelId(document)

				if (relId !== undefined) notePackageDrawingRel(this.deck, part.name, relId)

				out.set(part.name.toLowerCase(), {
					document,
					targets: new Map(
						relationships.all.flatMap(relationship =>
							relationship.external || relationship.partName === undefined
								? []
								: [[relationship.id, `/${relationship.partName}`] as const]
						)
					)
				})
			}
		}

		for (const name of names) {
			const zip = zipName(name)

			if (out.has(name.toLowerCase()) || !this.writer.opc.has(zip)) continue

			const document = await this.writer.loadDocument(zip)
			const relId = diagramDrawingRelId(document)
			const targets = new Map<string, string>()

			for (const relationship of (await this.writer.opc.relationships(zip)).all)
				if (!relationship.external && relationship.partName !== undefined) targets.set(relationship.id, `/${relationship.partName}`)

			if (relId !== undefined) notePackageDrawingRel(this.deck, name, relId)

			out.set(name.toLowerCase(), { document, targets })
		}

		notePackageDiagramData(this.deck, out)
	}

	private namesAddedDiagramData(node: SlideNode): boolean {
		let found = false

		walk(node.shapes, shape => {
			const frame = shape.frame

			if (frame?.kind === "smartart" && !isRawPart(frame.data) && !this.writer.opc.has(zipName(frame.data))) found = true
		})

		return found
	}

	private async diagramDrawings(name: string, shapes: readonly ShapeNode[], depth: number): Promise<Refused | undefined> {
		if (depth > MAX_DIAGRAM_DEPTH) return refused("tooDeep", "groups nested past the writer's depth")

		for (const shape of shapes) {
			if (shape.children !== undefined) {
				const nested = await this.diagramDrawings(name, shape.children, depth + 1)

				if (nested !== undefined) return nested
			}

			const frame = shape.frame

			if (frame?.kind !== "smartart" || frame.drawing === undefined || isRawPart(frame.data) || isRawPart(frame.drawing)) continue

			const data = zipName(frame.data)
			const drawing = zipName(frame.drawing)

			if (!this.writer.exists(data) || !this.writer.exists(drawing)) continue

			const relId = diagramDrawingRelId(await this.writer.loadDocument(data))

			if (relId === undefined) continue

			const edit = this.writer.relationshipsOf(name)
			const held = edit.all().find(relationship => relationship.id === relId)

			if (held !== undefined) {
				if (held.external || partKey(held.target) !== partKey(drawing))
					return refused("failed", `Two diagrams of ${modelName(name)} name relationship ${relId} for different drawings`)

				continue
			}

			if (edit.add(DIAGRAM_DRAWING_RELATIONSHIP, drawing, false, relId) !== relId)
				return refused("failed", `The relationship ${relId} of ${modelName(name)} is taken`)
		}

		return undefined
	}

	// The slide as gate 2 expects it to read back.
	private expect(name: string, node: SlideNode): void {
		const layout = node.parent === undefined ? undefined : this.index.partOf(node.parent)
		// A removed slide has no part: a jump to it reads back as "next slide" (what the removal writes).
		const partOf = (ref: SlideRef): string | undefined =>
			this.slidePart(ref) ?? (this.baseRefs.has(ref) ? undefined : this.index.partOf(ref))

		this.written.push(normalSlide(modelName(name), node, layout, partOf))
	}

	// A new part written from the markup it was made from (a copy's source, a held part), with its node's model spliced
	// in: holes copy that markup, so what the model does not hold stays. `sourcePart` and `relationships` are the
	// source's (what the node's refs name); `copy` gives a copied slide its own p14:creationId.
	private async writeFromSource(
		name: string,
		node: SlideNode,
		sourcePart: string,
		relationships: Relationships,
		epoch: number,
		copy: boolean
	): Promise<Refused | undefined> {
		const writer = this.writer
		const document = await writer.loadDocument(name)
		const refusal = checkPrefixes(document, name)

		if (refusal !== undefined) return refusal

		const pristine = readPristine(writer, this.index, this.baseRefs, node, sourcePart, document, relationships, epoch)
		const context = this.context(document, modelName(name), pristine, relationships)
		const r = partReader(document)
		const overlay: Overlay = new Map()

		// A copied slide gets its own p14:creationId (PowerPoint tells slides apart by it).
		if (copy) {
			for (let at = 1; at < document.count; at++) {
				if (r.is(at, G.P14, "creationId")) {
					const id = creationId(count =>
						Uint32Array.from({ length: count }, (_, k) => crcWord(`${name}:${String(k)}:${r.attr(at, "val") ?? ""}`))
					)

					overlay.set(at, `<${document.name(at)}${unprefixedAttributes(document, at, "val")} val="${String(id)}"/>`)
				}
			}
		}

		const alternates = this.alternateXfrms(context, r, node.shapes)

		if (isRefused(alternates)) return alternates

		for (const [at, markup] of alternates) overlay.set(at, markup)

		const result = markupOf(slideRoot(context, node))

		if (isRefused(result)) return result

		const root = document.documentElement()

		writer.replace(
			name,
			concat(
				document.bytes.subarray(0, document.start(root)),
				assemble(document, result, overlay),
				document.bytes.subarray(document.end(root))
			)
		)
		this.expect(name, node)

		return undefined
	}

	// A slide restored by an undo after the save that removed it, from the parts the session holds (RawSources.parts:
	// the slide first, then the parts it owned and the shared ones its removal took). Every held part the slide reaches
	// is written again under a free name (the notes slide under its node's), with the relationships between them
	// rewritten; a shared one the package still has with the same bytes is reused. A relationship to a part that is
	// neither held nor in the package refuses the save (never a dangling relationship); one to a slide gone since
	// becomes a "next slide" jump, as a removal writes it. One the source itself lacked (RawPart.absent) is written back
	// as the source had it.
	private async addRawSlide(name: string, node: SlideNode, raw: RawPart, layoutPart: string | undefined): Promise<Refused | undefined> {
		const writer = this.writer
		const src = node.src?.format === "pptx" ? node.src : undefined
		const held = (src === undefined ? undefined : this.source.raw?.parts?.(src.part)) ?? [raw]
		const slide = held[0] ?? raw
		const byKey = new Map(held.map(part => [partKey(zipName(part.name)), part]))
		const relationshipsOf = new Map<string, Relationships>()
		const relsOf = (part: RawPart): Relationships => {
			const key = partKey(zipName(part.name))
			let relationships = relationshipsOf.get(key)

			if (relationships === undefined) {
				relationships = part.rels === undefined ? new Relationships([]) : parseRelationships(part.rels, zipName(part.name))
				relationshipsOf.set(key, relationships)
			}

			return relationships
		}
		const slideKey = partKey(zipName(slide.name))
		const notesNode = node.notes === undefined ? undefined : this.deck.nodes.get(node.notes)
		// The held parts the slide reaches, in order; owned ones (reached by a copied kind) are always written anew.
		const reached: RawPart[] = []
		const owned = new Set<string>()
		const seen = new Set<string>([slideKey])
		let notesKey: string | undefined
		// The held slide's notes when the slide has none now (an undo took them away): neither written nor related.
		const notesGone = (part: RawPart, relationship: { readonly type: string }): boolean =>
			notesNode === undefined && partKey(zipName(part.name)) === slideKey && relationshipKind(relationship.type) === "notesSlide"
		const walk = (part: RawPart): void => {
			for (const relationship of relsOf(part).all) {
				if (relationship.external || relationship.partName === undefined || notesGone(part, relationship)) continue

				const key = partKey(relationship.partName)
				const target = byKey.get(key)

				if (target === undefined) continue
				if (copiedKind(relationship.type)) owned.add(key)
				if (partKey(zipName(part.name)) === slideKey && relationshipKind(relationship.type) === "notesSlide") notesKey = key
				if (seen.has(key)) continue

				seen.add(key)
				reached.push(target)
				walk(target)
			}
		}

		walk(slide)

		// Written names, by held part key.
		const names = new Map<string, string>([[slideKey, name]])
		const reused = new Set<string>()

		for (const part of reached) {
			const key = partKey(zipName(part.name))
			const heldName = zipName(part.name)
			const entry = writer.opc.entry(heldName)

			if (
				!owned.has(key) &&
				entry !== undefined &&
				writer.exists(heldName) &&
				entry.uncompressedSize === part.bytes.length &&
				entry.crc32 === crc32(part.bytes)
			) {
				names.set(key, entry.name)
				reused.add(key)

				continue
			}

			const wanted = key === notesKey && notesNode !== undefined ? zipName(notesNode.part) : heldName

			names.set(
				key,
				!writer.opc.has(wanted) && writer.claim(wanted) ? wanted : writer.allocate(undefined, part.contentType, heldName)
			)
		}

		const gone: { source: string; relationship: PendingRelationship }[] = []

		for (const part of [slide, ...reached]) {
			const key = partKey(zipName(part.name))
			const written = names.get(key)

			if (written === undefined || reused.has(key)) continue

			writer.add(written, part.contentType, part.bytes)
			if (partKey(written) === partKey(zipName(part.name))) writer.restored.add(partKey(written))

			const edit = await writer.loadRelationships(written)
			const relationships = relsOf(part).all

			writer.seed(written, relationships)

			for (const relationship of relationships) {
				let target = relationship.external ? relationship.target : relationship.partName

				if (target === undefined || notesGone(part, relationship)) continue

				if (!relationship.external) {
					const mapped = names.get(partKey(target))

					if (mapped !== undefined) {
						target = mapped
					} else if (!writer.exists(target) && inherited(part, target)) {
						// The source already lacked it when the part was held: written back as it was (gate 2: inherited).
						writer.inheritedMissing.add(partKey(target))
					} else if (!writer.exists(target)) {
						if (relationshipKind(relationship.type) !== "slide")
							return refused("stale", `The restored ${part.name} relates to ${target}, neither held nor in the package`)

						gone.push({
							source: written,
							relationship: { id: relationship.id, type: relationship.type, target, external: false }
						})
					}
				}

				edit.add(relationship.type, target, relationship.external, relationship.id)
			}
		}

		for (const { source, relationship } of gone) await this.dangling(source, relationship)

		const refusal = await this.writeFromSource(name, node, src?.part ?? name, relsOf(slide), src?.epoch ?? this.index.epoch, false)

		if (refusal !== undefined) return refusal
		if (layoutPart !== undefined) await this.retargetLayout(name, layoutPart)

		// Its notes slide, from the held markup with the notes node's edits spliced in.
		const notesHeld = notesKey === undefined ? undefined : byKey.get(notesKey)
		const notesName = notesKey === undefined ? undefined : names.get(notesKey)
		const notesSrc = notesNode?.src?.format === "pptx" ? notesNode.src : undefined

		if (
			notesNode !== undefined &&
			notesHeld !== undefined &&
			notesName !== undefined &&
			notesSrc !== undefined &&
			isRawPart(notesSrc.part)
		) {
			if (this.source.raw?.document(notesSrc.part) === undefined)
				return refused("stale", `The restored notes ${notesSrc.part} are not held`)

			return this.writeFromSource(notesName, notesNode, notesSrc.part, relsOf(notesHeld), notesSrc.epoch, false)
		}

		return undefined
	}

	private context(document: XmlDocument, owner: string, pristine: Pristine, relationships: Relationships): EmitContext {
		return {
			deck: this.deck,
			document,
			parts: this.writer.api(owner),
			mode: "splice",
			pristine,
			slidePart: this.slidePart,
			dispatch,
			...(this.source.raw === undefined
				? {}
				: {
						rawDocument: this.source.raw.document.bind(this.source.raw),
						rawPristine: (name: string) => this.rawPristine(name, pristine.slide, relationships)
					})
		}
	}

	// A held shape document read as the reader reads it, once per save (its shapes are spliced against it, so what
	// still reads as it was is copied as its bytes); undefined when it is not held or does not read.
	private rawPristine(name: string, node: SlideNode, relationships: Relationships): Pristine | undefined {
		if (this.rawPristines.has(name)) return this.rawPristines.get(name)

		const document = this.source.raw?.document(name)
		let pristine: Pristine | undefined

		try {
			pristine =
				document === undefined
					? undefined
					: readPristine(this.writer, this.index, this.baseRefs, node, name, document, relationships)
		} catch (error) {
			// A held element that is no slide tree (no reader's view of it): written from the model over it.
			if (!(error instanceof PresentationError) && !(error instanceof SlidePartError)) throw error
		}

		this.rawPristines.set(name, pristine)

		return pristine
	}

	private async retargetLayout(name: string, layoutPart: string): Promise<void> {
		const edit = await this.writer.loadRelationships(name)
		const current = edit.all().find(relationship => relationship.type.endsWith("/slideLayout"))

		if (current === undefined) {
			edit.add(LAYOUT_RELATIONSHIP, zipName(layoutPart), false)
		} else if (partKey(current.target) !== partKey(zipName(layoutPart))) {
			edit.retarget(current.id, zipName(layoutPart))
		}
	}

	// Shapes kept inside mc:AlternateContent: every branch's copy gets the new xfrm of one that moved, and the scaled
	// values of one a slide size change scaled (its text's stated sizes, spacing and indents, rewritten by attribute in
	// each txBody); refused when a branch states a value the model does not say the scale of.
	private alternateXfrms(context: EmitContext, r: PartReader, shapes: readonly ShapeNode[]): Overlay | Refused {
		const out: Overlay = new Map()
		const pristine = context.pristine
		const document = r.document
		let failure: Refused | undefined

		walk(shapes, shape => {
			if (shape.lock !== "alternateContent" || shape.src === undefined || pristine === undefined || failure !== undefined) return

			const before = pristine.shapes.get(shape.src.node)

			if (before === undefined) return

			const moved = shape.xfrm !== undefined && !sameModel(shape.xfrm, before.xfrm)
			const values = keptScale(shape, before)

			if (!moved && values === undefined) return

			const unit = alternateUnit(context, shape.src.node)

			for (const copy of branchCopies(r, unit, shape.src.node)) {
				const node = xfrmNode(r, copy)

				if (moved && shape.xfrm !== undefined && node >= 0)
					out.set(node, xfrmXml(xfrmTag(r, copy), shape.xfrm, shape.kind === "grpSp"))
				if (values === undefined) continue

				for (let at = copy + 1; at < document.count && document.start(at) < document.end(copy); at++) {
					if (!r.is(at, G.P, "txBody")) continue

					const markup = decodeUtf8(document.raw(at))
					const scaled = rescaleMarkup(markup, values)

					if (scaled === undefined) {
						failure = refused(
							"locked",
							`Shape ${String(shape.id)} sits in mc:AlternateContent with text the scale cannot rewrite`
						)

						return
					}

					if (scaled !== markup) out.set(at, scaled)
				}
			}
		})

		return failure ?? out
	}

	// A part that stays, edited in place: attribute edits for moves, an element replaced for anything else, the whole
	// root when shapes were added, removed or reordered (or the slide itself changed).
	private async spliceNode(node: SlideNode, name: string, change: PartChanges): Promise<Refused | undefined> {
		const writer = this.writer
		const document = await writer.loadDocument(name)
		const relationships = await writer.opc.relationships(name)

		await writer.loadRelationships(name)

		const refusal = checkPrefixes(document, name)

		if (refusal !== undefined) return refusal

		const pristine = readPristine(writer, this.index, this.baseRefs, node, modelName(name), document, relationships)
		const context = this.context(document, modelName(name), pristine, relationships)
		const r = partReader(document)
		const root = document.documentElement()
		const tree = r.path(root, G.P, "cSld", "spTree")
		const editor = writer.editor(name)
		const slideDirt = change.slide
		const surgical =
			sameStructure(context, r, tree, node.shapes, this.index.epoch) &&
			(slideDirt === undefined ||
				(slideDirt.kind === "slidePart" && slideDirt.part !== "hf" && slideDirt.part !== "clrMapOvr") ||
				(slideDirt.kind === "node" && node.kind === "slide" && onlyRelayout(node, pristine.slide)))

		// Slide parts written by their own families (p:timing, p:transition, the background): asked for, never assumed.
		if (
			slideDirt?.kind === "slidePart" &&
			(slideDirt.part === "timing" || slideDirt.part === "transition" || slideDirt.part === "background")
		) {
			const result = emitPptx(
				emitFamilyOf({ slide: node, touch: { kind: "slide", slide: node.ref, dirt: slideDirt } }),
				{ slide: node, touch: { kind: "slide", slide: node.ref, dirt: slideDirt } },
				context
			)

			if (result.kind === "refused") return result

			// A whole-root rewrite writes the timing and the transition in their slots; a surgical one puts them in place here.
			if (surgical && slideDirt.part === "timing" && result.kind === "markup") placeTiming(editor, document, r, root, result.pieces)
			if (surgical && slideDirt.part === "transition" && result.kind === "markup")
				placeTransition(editor, document, assemble(document, result.pieces))
		}

		if (node.kind === "slide" && node.parent !== undefined) {
			const layout = this.index.partOf(node.parent)

			if (layout !== undefined) await this.retargetLayout(name, layout)
		}

		if (!surgical) {
			const result = markupOf(slideRoot(context, node))

			if (isRefused(result)) return result

			const alternates = this.alternateXfrms(context, r, node.shapes)

			if (isRefused(alternates)) return alternates

			replaceChanged(editor, document, root, assemble(document, result, alternates))
			this.expect(name, node)

			return this.media(name, node, change)
		}

		if (slideDirt !== undefined) rootAttributes(editor, r, root, node, pristine.slide)

		const overlay = this.alternateXfrms(context, r, node.shapes)

		if (isRefused(overlay)) return overlay

		for (const [at, markup] of overlay) editor.replace(at, markup)

		for (const [id, dirt] of change.shapes) {
			const shape = findShape(node.shapes, id)

			if (shape?.src === undefined) continue

			const element = shape.src.node

			if (shape.lock === "alternateContent") {
				const before = pristine.shapes.get(element)

				if (dirt.kind !== "xfrm" && !sameShapeExceptXfrm(shape, before) && !scaledOnly(shape, before))
					return refused("locked", `Shape ${String(id)} sits in mc:AlternateContent`)

				continue
			}

			if (
				dirt.kind === "xfrm" &&
				sameShapeExceptXfrm(shape, pristine.shapes.get(element)) &&
				setXfrmAttributes(editor, r, element, shape.xfrm, shape.kind === "grpSp")
			)
				continue

			const request = { slide: node, shape, touch: { kind: "shape", slide: node.ref, shape: id, dirt } } as const
			let result = emitPptx(emitFamilyOf(request), request, context)

			if (
				result.kind === "refused" &&
				result.reason === "notImplemented" &&
				sameShapeExceptXfrmAndNv(shape, pristine.shapes.get(element))
			) {
				result = emitPptx("shape", request, context)
			}

			const markup = markupOf(result)

			if (isRefused(markup)) return markup

			replaceChanged(editor, document, element, assemble(document, markup))
		}

		this.expect(name, node)

		return this.media(name, node, change)
	}

	// The media a written part's markup stopped naming (a picture, medium or object deleted, a picture's image or the
	// background replaced) let go of; those it names again (an undo after the save that let them go) related again.
	// Read only where a change can have done either.
	private async media(name: string, node: SlideNode, change: PartChanges): Promise<undefined> {
		const writer = this.writer
		const slide = change.slide
		// A shape deleted, an image or the background replaced (restoredMedia.ts mediaDropped, for this part).
		const dropped =
			(slide?.kind === "slidePart" && slide.part === "background") ||
			[...change.shapes].some(
				([id, dirt]) => (dirt.kind === "props" && dirt.group === "fill") || findShape(node.shapes, id) === undefined
			)
		const restoring = writer.hasReleasedMedia(name)

		if (!dropped && !restoring) return undefined

		const text = await writer.writtenText(name)

		if (dropped) await writer.releaseMedia(name, text)
		if (restoring) writer.restoreMedia(name, text)

		return undefined
	}

	// presentation.xml: the slide list, sections and custom shows, when they changed.
	private async presentation(document: XmlDocument): Promise<Refused | undefined> {
		const writer = this.writer
		const r = partReader(document)
		const root = document.documentElement()
		const main = this.mainPart
		const deck = this.deck
		const touched = this.input.changes.presentation
		const finalOrder = deck.slides.map(ref => this.finalParts.get(ref) ?? "")
		const baseOrder = this.baseSlides.map(slide => slide.part)
		const listChanged =
			finalOrder.length !== baseOrder.length || finalOrder.some((part, index) => partKey(part) !== partKey(baseOrder[index] ?? ""))
		const ids = new Map<SlideRef, number>()
		const used = this.baseSlides.map(slide => slide.id)
		const prefix = (uri: string, fallback: string): string => r.namespaces.prefixFor(root, uri) ?? fallback
		const p = prefix(P_MAIN, "p")
		const rel = prefix(URIS["r"] ?? "", "r")
		const q = (local: string): string => (p === "" ? local : `${p}:${local}`)

		if (r.namespaces.prefixFor(root, URIS["r"] ?? "") === undefined && listChanged)
			return refused("unsupported", "presentation.xml declares no relationships prefix")

		const editor = writer.editor(main)
		const rIds = new Map<SlideRef, string>()

		this.writtenIds = ids

		for (const ref of deck.slides) {
			const part = this.finalParts.get(ref) ?? ""
			const base = this.baseSlides.find(slide => partKey(slide.part) === partKey(part))

			if (base !== undefined) {
				ids.set(ref, base.id)
				rIds.set(ref, base.rId)

				continue
			}

			const id = nextSlideId(used)

			if (id === undefined) return refused("tooLarge", "No free slide id")

			used.push(id)
			ids.set(ref, id)
			rIds.set(ref, writer.relate(main, part, SLIDE_RELATIONSHIP))
		}

		if (listChanged) {
			const list = r.child(root, G.P, "sldIdLst")
			// A kept slide's entry is its source element (its p:extLst stays); a new one is written.
			const entries: EmitPiece[] = deck.slides.map(ref => {
				const part = this.finalParts.get(ref) ?? ""
				const base = this.baseSlides.find(slide => partKey(slide.part) === partKey(part))

				return base !== undefined
					? { hole: base.node }
					: `<${q("sldId")} id="${String(ids.get(ref) ?? 0)}" ${rel}:id="${escapeAttribute(rIds.get(ref) ?? "")}"/>`
			})
			const markup = entries.length === 0 ? "" : assemble(document, [`<${q("sldIdLst")}>`, ...entries, `</${q("sldIdLst")}>`])

			if (list >= 0) {
				if (typeof markup === "string") editor.remove(list)
				else editor.replace(list, markup)
			} else if (typeof markup !== "string") {
				const before = r.child(root, G.P, "sldSz")
				const after = [
					r.child(root, G.P, "handoutMasterIdLst"),
					r.child(root, G.P, "notesMasterIdLst"),
					r.child(root, G.P, "sldMasterIdLst")
				].find(node => node >= 0)

				if (after !== undefined) editor.insertAfter(after, markup)
				else if (before >= 0) editor.insertBefore(before, markup)
				else editor.prepend(root, markup)
			}
		}

		const removed = this.removedSlides.size > 0

		if (touched.has("sections") || listChanged || removed) this.sections(document, editor, ids)
		if (touched.has("customShows") || removed) this.customShows(document, editor, rIds, q, rel)

		return touched.has("show") ? this.showProperties() : undefined
	}

	// A deck without a tableStyles part (§19.3.3.1) gets one holding every built-in style in `ids`, related from
	// presentation.xml with its content type: LibreOffice 7.5 draws no table style without the part.
	private async tableStyles(ids: ReadonlySet<string>): Promise<void> {
		const writer = this.writer
		const main = this.mainPart
		const relationships = await writer.loadRelationships(main)
		const existing = relationships
			.all()
			.find(
				relationship =>
					!relationship.external && relationshipKind(relationship.type) === "tableStyles" && writer.exists(relationship.target)
			)

		// A deck with the part keeps it as it is: readers draw a built-in style its tables name from the part's presence
		// (LibreOffice 7.5 measured, PowerPoint knows them), and a save that rewrote it would change an untouched deck.
		if (existing !== undefined) return

		const markup = builtinTableStylesPart(ids)

		if (markup === undefined) return

		const name = writer.claim("ppt/tableStyles.xml")
			? "ppt/tableStyles.xml"
			: writer.allocate(undefined, PART_CONTENT_TYPES.tableStyles, "ppt/tableStyles.xml")

		writer.add(name, PART_CONTENT_TYPES.tableStyles, encodeUtf8(markup))
		writer.relate(main, name, `${RELATIONSHIPS}tableStyles`)
	}

	// presProps.xml's p:showPr as the deck's show settings; the part, its relationship and its content type made when
	// the package has none and the settings are not the defaults.
	private async showProperties(): Promise<Refused | undefined> {
		const writer = this.writer
		const main = this.mainPart
		const relationships = await writer.loadRelationships(main)
		const existing = relationships
			.all()
			.find(
				relationship =>
					!relationship.external && relationshipKind(relationship.type) === "presProps" && writer.exists(relationship.target)
			)

		if (existing !== undefined) {
			const document = await writer.loadDocument(existing.target)

			return spliceShowPr(document, writer.editor(existing.target), this.deck.show)
		}

		if (sameModel(this.deck.show, DEFAULT_SHOW)) return undefined

		const name = writer.claim("ppt/presProps.xml")
			? "ppt/presProps.xml"
			: writer.allocate(undefined, PART_CONTENT_TYPES.presProps, "ppt/presProps.xml")

		writer.add(
			name,
			PART_CONTENT_TYPES.presProps,
			encodeUtf8(
				`${XML_DECLARATION}<p:presentationPr xmlns:a="${URIS["a"] ?? ""}" xmlns:r="${URIS["r"] ?? ""}" xmlns:p="${P_MAIN}">${showPrMarkup(this.deck.show)}</p:presentationPr>`
			)
		)
		writer.relate(main, name, `${RELATIONSHIPS}presProps`)

		return undefined
	}

	// p14:sectionLst from the deck's sections: removed slides dropped, a slide in no section joins the section of the
	// slide before it (the first section for the first slide).
	private sections(document: XmlDocument, editor: XmlEditor, ids: ReadonlyMap<SlideRef, number>): void {
		this.writtenSections = undefined

		const r = partReader(document)
		const root = document.documentElement()
		const extLst = r.child(root, G.P, "extLst")
		const ext = r.children(extLst, G.P, "ext").find(node => r.attr(node, "uri") === SECTIONS_EXT)
		const deck = this.deck

		if (deck.sections.length === 0) {
			if (ext !== undefined) editor.remove(ext)

			return
		}

		const membership = new Map<SlideRef, number>()

		deck.sections.forEach((section, index) => {
			for (const ref of section.slides) if (ids.has(ref) && !membership.has(ref)) membership.set(ref, index)
		})

		let previous = 0

		for (const ref of deck.slides) {
			const index = membership.get(ref)

			if (index === undefined) membership.set(ref, previous)
			else previous = index
		}

		this.writtenSections = deck.sections.map((section, index) => ({
			name: section.name,
			id: section.id,
			slides: deck.slides.filter(ref => membership.get(ref) === index).map(ref => modelName(this.finalParts.get(ref) ?? ""))
		}))

		const sourceList = ext === undefined ? -1 : r.child(ext, G.P14, "sectionLst")
		const sourceSections = new Map(r.children(sourceList, G.P14, "section").map(node => [r.attr(node, "id") ?? "", node]))
		// A section the source has keeps its element (its p14:extLst and attributes): only its name and slide list are
		// written; a new one is written whole.
		const sections = deck.sections.flatMap((section, index): EmitPiece[] => {
			const slides = `<p14:sldIdLst>${deck.slides
				.filter(ref => membership.get(ref) === index)
				.map(ref => `<p14:sldId id="${String(ids.get(ref) ?? 0)}"/>`)
				.join("")}</p14:sldIdLst>`
			const source = sourceSections.get(section.id)

			if (source === undefined)
				return [`<p14:section name="${escapeAttribute(section.name)}" id="${escapeAttribute(section.id)}">${slides}</p14:section>`]

			const attributes = document
				.attributes(source)
				.map(attribute =>
					attribute.name === "name"
						? ` name="${escapeAttribute(section.name)}"`
						: ` ${attribute.name}="${escapeAttribute(attribute.value)}"`
				)
				.join("")
			const pieces: EmitPiece[] = [`<${document.name(source)}${attributes}>`]
			let listed = false

			for (let child = r.first(source); child >= 0; child = r.next(child)) {
				if (r.is(child, G.P14, "sldIdLst")) {
					pieces.push(slides)
					listed = true
				} else {
					pieces.push({ hole: child })
				}
			}

			if (!listed) pieces.splice(1, 0, slides)

			pieces.push(`</${document.name(source)}>`)

			return pieces
		})
		const ownDeclarations =
			sourceList < 0
				? ""
				: document
						.attributes(sourceList)
						.filter(attribute => attribute.name.startsWith("xmlns:") && attribute.name !== "xmlns:p14")
						.map(attribute => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
						.join("")
		const list = assemble(document, [`<p14:sectionLst xmlns:p14="${P14_URI}"${ownDeclarations}>`, ...sections, "</p14:sectionLst>"])

		if (sourceList >= 0) {
			editor.replace(sourceList, list)
		} else if (ext !== undefined) {
			editor.append(ext, list)
		} else {
			const p = r.namespaces.prefixFor(root, P_MAIN) ?? "p"
			const q = (local: string): string => (p === "" ? local : `${p}:${local}`)
			const markup = concat(encodeUtf8(`<${q("ext")} uri="${SECTIONS_EXT}">`), list, encodeUtf8(`</${q("ext")}>`))

			if (extLst >= 0) editor.append(extLst, markup)
			else editor.append(root, concat(encodeUtf8(`<${q("extLst")}>`), markup, encodeUtf8(`</${q("extLst")}>`)))
		}
	}

	// p:custShowLst from the deck's custom shows (removed slides dropped).
	private customShows(
		document: XmlDocument,
		editor: XmlEditor,
		rIds: ReadonlyMap<SlideRef, string>,
		q: (local: string) => string,
		rel: string
	): void {
		const r = partReader(document)
		const root = document.documentElement()
		const list = r.child(root, G.P, "custShowLst")
		const shows = this.deck.customShows
		const sldLst = (slides: readonly SlideRef[]): string =>
			`<${q("sldLst")}>${slides.flatMap(ref => (rIds.has(ref) ? [`<${q("sld")} ${rel}:id="${escapeAttribute(rIds.get(ref) ?? "")}"/>`] : [])).join("")}</${q("sldLst")}>`
		const seen = new Set<number>()

		for (const node of r.children(list, G.P, "custShow")) {
			const id = r.int(node, "id")
			const show = shows.find(candidate => candidate.id === id)

			if (show === undefined || id === undefined) {
				editor.remove(node)

				continue
			}

			seen.add(id)

			const slides = r.child(node, G.P, "sldLst")

			if (r.attr(node, "name") !== show.name) editor.setAttribute(node, "name", show.name)
			if (slides >= 0) editor.replace(slides, sldLst(show.slides))
			else editor.prepend(node, sldLst(show.slides))
		}

		const added = shows.filter(show => !seen.has(show.id))

		if (added.length === 0) return

		const markup = added
			.map(
				show =>
					`<${q("custShow")} name="${escapeAttribute(show.name)}" id="${String(show.id)}">${sldLst(show.slides)}</${q("custShow")}>`
			)
			.join("")

		if (list >= 0) {
			editor.append(list, markup)
		} else {
			const after = [r.child(root, G.P, "custDataLst"), r.child(root, G.P, "embeddedFontLst"), r.child(root, G.P, "notesSz")].find(
				node => node >= 0
			)

			if (after !== undefined) editor.insertAfter(after, `<${q("custShowLst")}>${markup}</${q("custShowLst")}>`)
		}
	}

	// docProps/app.xml: the slide, notes and hidden-slide counts and the slide titles, when slides came or went.
	private async appProperties(): Promise<void> {
		const writer = this.writer
		const relationships = await writer.opc.relationships("")
		const app = relationships.all.find(
			relationship => !relationship.external && relationshipKind(relationship.type) === "extended-properties"
		)

		if (app?.partName === undefined || !writer.opc.has(app.partName)) return

		const finalCount = this.deck.slides.length

		if (
			finalCount === this.baseSlides.length &&
			this.removedSlides.size === 0 &&
			![...this.finalParts.values()].some(part => writer.isAdded(part))
		)
			return

		const document = await writer.loadDocument(app.partName)
		const editor = writer.editor(app.partName)
		const root = document.documentElement()
		const child = (local: string): number => {
			for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node))
				if (document.localName(node) === local) return node

			return -1
		}
		const setCount = (local: string, value: number): void => {
			const node = child(local)

			if (node >= 0 && document.textContent(node).trim() !== String(value)) editor.setText(node, String(value))
		}
		let hidden = 0
		let notes = 0

		for (const ref of this.deck.slides) {
			const node = this.deck.nodes.get(ref)

			if (node?.hidden ?? this.deck.hiddenSlides?.has(ref) === true) hidden++
		}

		for (const part of this.finalParts.values()) {
			const edit = await writer.loadRelationships(part)

			if (edit.all().some(relationship => relationshipKind(relationship.type) === "notesSlide")) notes++
		}

		setCount("Slides", finalCount)
		setCount("Notes", notes)
		setCount("HiddenSlides", hidden)
		this.slideTitles(document, editor, child)
	}

	// TitlesOfParts and HeadingPairs: the slide titles group (the last pair, counting the base deck's slides) follows
	// the new slide order; kept slides keep their titles, new ones take their title placeholder's text.
	private slideTitles(document: XmlDocument, editor: XmlEditor, child: (local: string) => number): void {
		const vectorOf = (node: number): number => (node < 0 ? -1 : document.firstChildElement(node))
		const pairs = vectorOf(child("HeadingPairs"))
		const titles = vectorOf(child("TitlesOfParts"))

		if (pairs < 0 || titles < 0) return

		const variants = childElements(document, pairs)
		const counts: number[] = []

		for (let k = 1; k < variants.length; k += 2) {
			const variant = variants[k] ?? -1
			const value = variant < 0 ? -1 : document.firstChildElement(variant)

			counts.push(value < 0 ? 0 : Number(document.textContent(value).trim()))
		}

		const last = counts.length - 1
		const entries = childElements(document, titles)

		if (last < 0 || counts[last] !== this.baseSlides.length || counts.reduce((sum, count) => sum + count, 0) !== entries.length) return

		const firstSlide = entries.length - this.baseSlides.length
		const oldTitle = new Map<string, string>()

		this.baseSlides.forEach((slide, index) => {
			const entry = entries[firstSlide + index]

			if (entry !== undefined) oldTitle.set(partKey(slide.part), document.textContent(entry))
		})

		const lpstr = entries[0] === undefined ? "vt:lpstr" : document.name(entries[0])
		const newTitles = this.deck.slides.map(ref => {
			const part = this.finalParts.get(ref) ?? ""
			const kept = oldTitle.get(partKey(part))

			return kept ?? titleOf(this.deck.nodes.get(ref))
		})
		const countVariant = variants[last * 2 + 1] ?? -1
		const countValue = countVariant < 0 ? -1 : document.firstChildElement(countVariant)

		if (countValue >= 0) editor.setText(countValue, String(newTitles.length))

		for (let k = firstSlide; k < entries.length; k++) {
			const entry = entries[k]

			if (entry !== undefined) editor.remove(entry)
		}

		editor.append(titles, newTitles.map(title => `<${lpstr}>${escapeText(title)}</${lpstr}>`).join(""))
		editor.setAttribute(titles, "size", String(firstSlide + newTitles.length))
	}
}

// A slide whose node differs from its source only in its layout (a theme change): spliced in place, only its layout
// relationship retargeted.
function onlyRelayout(node: SlideNode, pristine: SlideNode): boolean {
	const { parent: _parent, revision: _revision, shapes: _shapes, ...own } = node
	const { parent: _before, revision: _was, shapes: _sourceShapes, ...source } = pristine

	return sameModel(own, source)
}

// The slide's own attributes (show, showMasterSp, the cSld name) as attribute edits.
function rootAttributes(editor: XmlEditor, r: PartReader, root: number, node: SlideNode, pristine: SlideNode): void {
	if (node.kind === "slide" && node.hidden !== pristine.hidden) {
		if (node.hidden) editor.setAttribute(root, "show", "0")
		else editor.removeAttribute(root, "show")
	}

	if ((node.kind === "slide" || node.kind === "layout") && node.showMasterShapes !== pristine.showMasterShapes) {
		if (node.showMasterShapes) editor.removeAttribute(root, "showMasterSp")
		else editor.setAttribute(root, "showMasterSp", "0")
	}

	const cSld = r.child(root, G.P, "cSld")

	if (node.name !== pristine.name && cSld >= 0) {
		if (node.name === undefined) editor.removeAttribute(cSld, "name")
		else editor.setAttribute(cSld, "name", node.name)
	}
}

// The slide's p:timing (ECMA-376 Part 1 §19.3.1.38: after p:transition, before p:extLst) replaced, removed or added.
// The timing family's markup (a bare p:timing, or the mc:AlternateContent holding it) in place of the slide's timing
// container, or after the root's last child before its extLst.
function placeTiming(editor: XmlEditor, document: XmlDocument, r: PartReader, root: number, pieces: readonly EmitPiece[]): void {
	const bytes = assemble(document, pieces)
	const current = timingContainer(r, root)

	if (current >= 0) {
		if (bytes.length === 0) editor.remove(current)
		else replaceChanged(editor, document, current, bytes)

		return
	}

	if (bytes.length === 0) return

	let anchor = -1

	for (let child = r.first(root); child >= 0; child = r.next(child)) if (!r.is(child, G.P, "extLst")) anchor = child

	if (anchor >= 0) editor.insertAfter(anchor, bytes)
	else editor.prepend(root, bytes)
}

// Replaces a node only when its bytes change (an unchanged UTF-16 part stays as it was, never transcoded).
function replaceChanged(editor: XmlEditor, document: XmlDocument, node: number, bytes: Uint8Array): void {
	const from = document.start(node)
	const to = document.end(node)

	if (to - from === bytes.length) {
		let same = true

		for (let k = 0; k < bytes.length && same; k++) same = document.bytes[from + k] === bytes[k]

		if (same) return
	}

	editor.replace(node, bytes)
}

function titleOf(node: SlideNode | undefined): string {
	const title = node?.shapes.find(shape => shape.ph?.type === "title" || shape.ph?.type === "ctrTitle")

	return (title?.text?.paragraphs ?? [])
		.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? " " : run.text)).join(""))
		.join(" ")
		.trim()
}

// What a slide size change did to a kept shape's text (and its members'): its stated values before → after; undefined
// when they are as they were or the text changed otherwise.
function keptScale(shape: ShapeNode, before: ShapeNode): ScaledValues | undefined {
	const values = scaledValues(before, shape)

	return values !== undefined && [...values.values()].some(pairs => [...pairs].some(([from, to]) => from !== to)) ? values : undefined
}

// A kept shape whose text (and members') a scale changed and nothing else but its box: the overlays write it.
function scaledOnly(shape: ShapeNode, before: ShapeNode | undefined): boolean {
	return (
		before !== undefined &&
		keptScale(shape, before) !== undefined &&
		sameShapeExceptXfrm(
			{
				...shape,
				...(before.text === undefined ? {} : { text: before.text }),
				...(before.children === undefined ? {} : { children: before.children })
			},
			before
		)
	)
}

function sameShapeExceptXfrm(shape: ShapeNode, pristine: ShapeNode | undefined): boolean {
	return (
		pristine !== undefined &&
		sameModel({ ...shape, xfrm: undefined, children: undefined }, { ...pristine, xfrm: undefined, children: undefined })
	)
}

function sameShapeExceptXfrmAndNv(shape: ShapeNode, pristine: ShapeNode | undefined): boolean {
	return (
		pristine !== undefined &&
		sameModel(shape.props, undefined) &&
		sameModel(shape.text, pristine.text) &&
		sameModel(shape.style, pristine.style)
	)
}

function unprefixedAttributes(document: XmlDocument, node: number, skip: string): string {
	return document
		.attributes(node)
		.filter(attribute => attribute.name !== skip)
		.map(attribute => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
		.join("")
}

// A 32-bit word from a string (deterministic: the same copy gets the same creation id on a second save).
function crcWord(text: string): number {
	let hash = 0x811c9dc5

	for (let k = 0; k < text.length; k++) {
		hash ^= text.charCodeAt(k)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}

	return hash >>> 0
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let offset = 0

	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}

	return out
}

// Serializes every changed part at revision R (bounded by the changed parts), before any copy streams.
export async function spliceSnapshot(input: PptxSaveInput): Promise<SpliceSnapshot | Refused> {
	// A gated deck (signed, strict, write-protected, malformed markup) is view-only: it saves only as a new file.
	if (input.deck.gate.length > 0) return refused("viewOnly", `The deck is view-only (${input.deck.gate.join(", ")})`)

	const writer = new PackageWriter(input.source.package, await input.source.package.contentTypes())

	writer.issue(input.deck)

	writer.keepParts(input.keep ?? [])
	writer.holdParts(heldDeckParts(input.deck))

	try {
		const snapshot = await new Splice(input, writer).run()

		noteDeckReleased(input.deck, [...writer.releasedParts()])

		return snapshot
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)

		throw error
	}
}

export type { DeckChanges, Dirt }

// Whether a held part's relationship target was already missing from the package it was held from.
function inherited(part: RawPart, target: string): boolean {
	const key = partKey(target)

	return part.absent?.some(name => partKey(name) === key) === true
}

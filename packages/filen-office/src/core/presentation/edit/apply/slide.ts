import { matchShapes } from "./match"
import { copiedCommentCharacters, copiedCommentsFit, countCopiedComments, setSlideComments, slideComments } from "../../comments"
import { layoutPlaceholder } from "../../inherit"
import {
	refused,
	type Action,
	type CustomShow,
	type Deck,
	type PlaceholderType,
	type Refused,
	type Section,
	type ShapeNode,
	type SlideNode,
	type SlideRef
} from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Dirt, Touch } from "../apply"
import { cloneModel, findShape, sameDigest } from "../changes"
import { holdDiagramCopies } from "./smartart"
import { planDelete, sectionsAfterInsert, sectionsAfterMove, type JumpRewrite, type PartOf, type ReferenceFacts } from "../integrity"
import type { DeckOp, OpOf, RawPart, SlideOp } from "../ops"
import { type SourceReading } from "./shape"
import { isRefused } from "../../refusal"

// The slide ops on the model, in place, with the integrity graph's model half (edit/integrity.ts): a delete takes
// the slides out of their sections and custom shows and turns jumps to them into "next slide"; an add or a
// duplicate joins the section of the slide before it. A deleted slide is undone by restore, which holds its parts'
// bytes (read back after a save's rebase) and the nodes' typed state (the edits on them); a slide an op made has no
// parts and comes back from its typed state alone.

// What the engine adds to ApplyContext for slide ops.
export interface SlideSourceReading extends SourceReading {
	// A slide's parts as they are in the package now, for an inverse: the slide, the parts it owns (notes, comments,
	// charts with their workbooks, diagram parts...), then the shared parts it refers to that are in `removed` (the
	// ones its delete takes out of the package: a picture only it shows) when they were read. Empty for a slide an
	// op made. Without `removed`, the slide and its owned parts.
	rawParts(slide: SlideNode, removed?: ReadonlySet<string>): readonly RawPart[] | Refused
	// The slide (first) and its notes read back from parts an inverse held.
	readSlides(ref: SlideRef, parts: readonly RawPart[]): readonly SlideNode[] | Refused
	// A new part name for a slide or a notes slide, unused in the package and the session.
	newPart(kind: "slide" | "notesSlide"): string
	// ODP, which keeps header and footer settings per page: a slide an add made takes `neighbour`'s (as LibreOffice
	// gives an inserted page the current page's), with the master footers they show.
	headerFooterFrom?(slide: SlideNode, neighbour: SlideRef): void
	// Whether a part name an op gave before can be given again (a redo) to `ref`: no node has it, and the package
	// either has no such part or binds it to `ref` itself (a slide an undo after a save took out, made again).
	partFree?(name: string, ref: SlideRef): boolean
	// The package's epoch (pptx): a held node whose parts the package still has byte for byte reads from them now.
	readonly epoch?: number
	// A slide restored onto the package's parts (bound to `epoch`), with the parts its delete held: a save in flight
	// may commit a file without them, and the engine then gives the slide its held parts back.
	restoredLive?(ref: SlideRef, parts: readonly RawPart[]): void
	readonly facts: ReferenceFacts
	readonly partOf: PartOf
}

// A restore entry: the parts' bytes, the nodes' typed state, and on the first entry the custom shows and jumps.
type RestoreEntry = Extract<SlideOp, { kind: "restore" }>["slides"][number]

function reading(context: ApplyContext): SlideSourceReading | undefined {
	return "readSlides" in context ? (context as SlideSourceReading) : undefined
}

function clone<T>(value: T): T {
	return cloneModel(value)
}

// A list op names at least one slide, each in the deck: a missing one is refused, never skipped.
function listed(deck: Deck, refs: readonly SlideRef[]): Refused | undefined {
	if (refs.length === 0) return refused("malformed", "no slides")

	for (const ref of refs) if (!deck.slides.includes(ref)) return refused("notFound", `slide ${String(ref)}`)

	return undefined
}

function presentation(what: Extract<Touch, { kind: "presentation" }>["what"]): Touch {
	return { kind: "presentation", what }
}

function slideTouch(slide: SlideRef, dirt: Dirt): Touch {
	return { kind: "slide", slide, dirt }
}

// setSections back to the deck's sections now, when an op changes them.
function sectionsBack(deck: Deck, next: readonly Section[] | undefined): DeckOp[] {
	return next === undefined ? [] : [{ family: "slide", kind: "setSections", sections: clone(deck.sections) }]
}

// PowerPoint's placeholder names on a new slide.
const PLACEHOLDER_NAMES: Partial<Record<PlaceholderType, string>> = {
	title: "Title",
	ctrTitle: "Title",
	subTitle: "Subtitle",
	body: "Text Placeholder",
	obj: "Content Placeholder",
	pic: "Picture Placeholder",
	chart: "Chart Placeholder",
	tbl: "Table Placeholder",
	dgm: "SmartArt Placeholder",
	media: "Media Placeholder",
	clipArt: "Clip Art Placeholder"
}

// Header and footer placeholders are not put on a new slide (they follow the deck's header and footer settings).
const SKIPPED_ON_NEW: ReadonlySet<PlaceholderType> = new Set(["dt", "ftr", "sldNum", "hdr", "sldImg"])
const TEXT_PLACEHOLDERS: ReadonlySet<PlaceholderType> = new Set(["title", "ctrTitle", "subTitle", "body", "obj"])

// A slide on `layout`: an empty placeholder for each of the layout's content placeholders.
function newSlide(ref: SlideRef, part: string, layout: SlideNode): SlideNode {
	const shapes: ShapeNode[] = []
	let id = 2

	for (const shape of layout.shapes) {
		const ph = shape.ph

		if (ph === undefined || SKIPPED_ON_NEW.has(ph.type)) continue

		shapes.push({
			id,
			name: `${PLACEHOLDER_NAMES[ph.type] ?? "Placeholder"} ${String(id - 1)}`,
			hidden: false,
			kind: "sp",
			ph: { ...ph },
			...(TEXT_PLACEHOLDERS.has(ph.type) ? { text: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [] }] } } : {})
		})
		id++
	}

	return { ref, kind: "slide", part, parent: layout.ref, showMasterShapes: true, hidden: false, shapes, comments: [], revision: 0 }
}

function freshRef(deck: Deck, wanted: SlideRef | undefined, context: ApplyContext): SlideRef {
	return wanted !== undefined && !deck.nodes.has(wanted) && !deck.slides.includes(wanted) ? wanted : context.newSlideRef()
}

function add(deck: Deck, op: OpOf<"slide"> & { kind: "add" }, context: SlideSourceReading): ApplyResult<typeof op> {
	const layout = deck.nodes.get(op.layout)

	if (layout?.kind !== "layout") return refused("notFound", `layout ${String(op.layout)}`)

	const ref = freshRef(deck, op.ref, context)
	const at = Math.max(0, Math.min(op.at, deck.slides.length))
	const order = [...deck.slides]

	order.splice(at, 0, ref)

	const sections = sectionsAfterInsert(deck.sections, order, ref)
	const back: DeckOp[] = [{ family: "slide", kind: "delete", slides: [ref] }, ...sectionsBack(deck, sections)]

	const part = partFor(context, MADE_PARTS.get(op)?.slide, "slide", ref)
	const node = newSlide(ref, part, layout)
	// The slide before it, else (first) the one after.
	const neighbour = deck.slides[at - 1] ?? deck.slides[at]

	if (neighbour !== undefined) context.headerFooterFrom?.(node, neighbour)

	deck.nodes.set(ref, node)
	deck.slides = order

	if (sections !== undefined) deck.sections = sections

	const applied = { ...op, ref, at }

	MADE_PARTS.set(applied, { slide: part })

	return { kind: "applied", inverse: { ops: back, bytes: 0 }, op: applied }
}

// The notes slide a duplicate made, by the op as applied (the history's): a redo of it makes the copy's notes under
// the same ref again, so the later steps that name them (an edit of the copy's notes) still find them. Kept beside the
// op, never in its contract (as notes.ts keeps what setNotes made).
const DUPLICATED_NOTES = new WeakMap<object, SlideRef>()
// Copies a duplicate made without notes because its source had none: their writer gives them none, whatever the
// package's source slide relates (an undo since the last save may have left notes there, and the source may have
// notes again by the save). A copy whose source's notes were not read is not here: it keeps the package's.
const NOTELESS_COPIES = new WeakMap<Deck, Set<SlideRef>>()

export function copiedWithoutNotes(deck: Deck, ref: SlideRef): boolean {
	return NOTELESS_COPIES.get(deck)?.has(ref) === true
}

function noteCopyNotes(deck: Deck, ref: SlideRef, none: boolean): void {
	let held = NOTELESS_COPIES.get(deck)

	if (held === undefined) {
		if (!none) return

		held = new Set()
		NOTELESS_COPIES.set(deck, held)
	}

	if (none) held.add(ref)
	else held.delete(ref)
}

// The part names an add or a duplicate gave (the slide's, its notes'), by the op as applied: a redo gives them again
// while they are free, so saving the same state again writes the same package.
const MADE_PARTS = new WeakMap<object, { readonly slide: string; readonly notes?: string }>()

function partFor(context: SlideSourceReading, made: string | undefined, kind: "slide" | "notesSlide", ref: SlideRef): string {
	return made !== undefined && context.partFree?.(made, ref) === true ? made : context.newPart(kind)
}

function duplicate(deck: Deck, op: OpOf<"slide"> & { kind: "duplicate" }, context: SlideSourceReading): ApplyResult<typeof op> {
	const source = deck.nodes.get(op.slide)
	const index = deck.slides.indexOf(op.slide)

	if (source === undefined || index < 0) return refused("notFound", `slide ${String(op.slide)}`)

	// The copy brings its source's comments (read by prepareReview), counted against the deck's bound.
	const copied = copiedCommentCharacters(deck, op.slide) ?? 0

	if (!copiedCommentsFit(deck, copied)) return refused("tooLarge", "comment characters of the copy over the deck's bound")

	const ref = freshRef(deck, op.ref, context)
	const at = Math.max(0, Math.min(op.at ?? index + 1, deck.slides.length))
	// The copy (and its shapes) keep the source's refs: it reads from the source slide's markup until it is written.
	const copy = clone(source)

	copy.ref = ref
	const madeParts = MADE_PARTS.get(op)

	copy.part = partFor(context, madeParts?.slide, "slide", ref)
	copy.revision = 0

	// The copy's diagrams take parts of their own.
	const diagrams = holdDiagramCopies(deck, copy.shapes, context)

	if (diagrams !== undefined) return diagrams

	noteCopyNotes(deck, ref, source.notes === undefined)

	if (source.notes !== undefined) {
		const notes = deck.nodes.get(source.notes)

		if (notes === undefined) {
			delete copy.notes
		} else {
			const notesCopy = clone(notes)
			const made = DUPLICATED_NOTES.get(op)
			const notesRef = made !== undefined && !deck.nodes.has(made) ? made : context.newSlideRef()

			notesCopy.ref = notesRef
			notesCopy.part = partFor(context, madeParts?.notes, "notesSlide", notesRef)
			notesCopy.revision = 0
			deck.nodes.set(notesRef, notesCopy)
			copy.notes = notesRef
		}
	}

	const order = [...deck.slides]

	order.splice(at, 0, ref)

	const sections = sectionsAfterInsert(deck.sections, order, ref)
	const back: DeckOp[] = [{ family: "slide", kind: "delete", slides: [ref] }, ...sectionsBack(deck, sections)]

	deck.nodes.set(ref, copy)
	deck.slides = order
	// The source's comments as the session holds them (edited, added to, replied to since the file was read): the
	// copy's, not the package's.
	const held = slideComments(deck, op.slide)

	if (held !== undefined) setSlideComments(deck, ref, { entries: [...held.entries], scope: held.scope })

	countCopiedComments(deck, ref, copied)

	if (sections !== undefined) deck.sections = sections

	const applied = { ...op, ref, at }

	if (copy.notes !== undefined) DUPLICATED_NOTES.set(applied, copy.notes)

	const notesPart = copy.notes === undefined ? undefined : deck.nodes.get(copy.notes)?.part

	MADE_PARTS.set(applied, { slide: copy.part, ...(notesPart === undefined ? {} : { notes: notesPart }) })

	return { kind: "applied", inverse: { ops: back, bytes: 0 }, op: applied }
}

function setSiteAction(node: SlideNode, rewrite: JumpRewrite, action: Action): void {
	const site = rewrite.site
	const shape = findShape(node.shapes, site.shape.id)?.shape

	if (shape === undefined) return

	if (site.kind === "shape") {
		shape.actions = { ...shape.actions, [site.trigger]: action }

		return
	}

	const body =
		site.cell === undefined
			? shape.text
			: shape.frame?.kind === "table"
				? shape.frame.table.rows[site.cell.row]?.cells[site.cell.col]?.text
				: undefined
	const paragraph = body?.paragraphs[site.paragraph]
	const run = paragraph?.runs[site.run]

	if (paragraph === undefined || run === undefined || run.kind === "opaque") return

	paragraph.runs[site.run] = { ...run, rPr: { ...run.rPr, [site.trigger]: action } }
}

function rewriteJumps(deck: Deck, jumps: readonly JumpRewrite[], to: "from" | "to"): void {
	for (const rewrite of jumps) {
		const node = deck.nodes.get(rewrite.site.shape.slide)

		if (node === undefined) continue

		setSiteAction(node, rewrite, rewrite[to])
		node.revision++
	}
}

function remove(deck: Deck, op: OpOf<"slide"> & { kind: "delete" }, context: SlideSourceReading): ApplyResult<typeof op> {
	const missing = listed(deck, op.slides)

	if (missing !== undefined) return missing

	const refs = [...new Set(op.slides)].sort((a, b) => deck.slides.indexOf(a) - deck.slides.indexOf(b))
	if (refs.length >= deck.slides.length) return refused("unsupported", "a deck keeps one slide")

	const plan = planDelete(deck, refs, context.facts, context.partOf)

	if (plan.parse.length > 0) return refused("notFound", "slides that jump to a deleted one are not parsed")

	// A jump is rewritten in its shape's markup: a locked shape (proof gate 1, or a reader's lock) is never re-emitted.
	for (const { site } of plan.jumps) {
		const shape = findShape(deck.nodes.get(site.shape.slide)?.shapes ?? [], site.shape.id)?.shape

		if (shape?.lock !== undefined) return refused("locked", `shape ${String(site.shape.id)} jumps to a deleted slide`)
	}

	const entries: RestoreEntry[] = []
	const removed = new Set(plan.remove)
	let bytes = 0

	for (const ref of refs) {
		const node = deck.nodes.get(ref)

		if (node === undefined) return refused("notFound", `slide ${String(ref)} is not parsed`)

		const parts = node.src === undefined ? [] : context.rawParts(node, removed)

		if (isRefused(parts)) return parts

		const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

		for (const part of parts) bytes += part.bytes.length + (part.rels?.length ?? 0)

		entries.push({ ref, at: deck.slides.indexOf(ref), parts, nodes: [clone(node), ...(notes === undefined ? [] : [clone(notes)])] })
	}

	entries[0] = {
		...(entries[0] as RestoreEntry),
		...(plan.customShows === undefined ? {} : { customShows: clone(deck.customShows) }),
		...(plan.jumps.length === 0 ? {} : { jumps: clone(plan.jumps) })
	}

	const back: DeckOp[] = [{ family: "slide", kind: "restore", slides: entries }, ...sectionsBack(deck, plan.sections)]
	const gone = new Set(refs)

	for (const ref of gone) {
		const node = deck.nodes.get(ref)

		if (node?.notes !== undefined) deck.nodes.delete(node.notes)

		deck.nodes.delete(ref)
	}

	deck.slides = deck.slides.filter(ref => !gone.has(ref))

	if (plan.sections !== undefined) deck.sections = plan.sections.map(section => ({ ...section, slides: [...section.slides] }))
	if (plan.customShows !== undefined) deck.customShows = plan.customShows.map(show => ({ ...show, slides: [...show.slides] }))

	rewriteJumps(deck, plan.jumps, "to")

	return { kind: "applied", inverse: { ops: back, bytes }, op: { ...op, slides: refs } }
}

function sameRawParts(live: readonly RawPart[] | Refused, held: readonly RawPart[]): boolean {
	if (isRefused(live) || live.length !== held.length) return false

	return live.every((part, index) => {
		const other = held[index] as RawPart

		if (part.name !== other.name || part.bytes.length !== other.bytes.length) return false

		for (let at = 0; at < part.bytes.length; at++) if (part.bytes[at] !== other.bytes[at]) return false

		return true
	})
}

// A held node with the source refs of its re-read (shapes matched by matchShapes): every typed field from the held copy.
export function overlayNode(typed: SlideNode, read: SlideNode | undefined): SlideNode {
	if (read === undefined) return typed

	const out: SlideNode = { ...typed }

	if (read.src === undefined) delete out.src
	else out.src = read.src

	const rebind = (shapes: readonly ShapeNode[], read: readonly ShapeNode[]): void => {
		const matches = matchShapes(shapes, read)

		shapes.forEach((shape, k) => {
			const match = matches[k]

			if (match?.src === undefined) delete shape.src
			else shape.src = match.src

			if (match?.text !== undefined && shape.text !== undefined && sameDigest(shape.text, match.text)) shape.text = match.text
			if (shape.children !== undefined) rebind(shape.children, match?.children ?? [])
		})
	}

	rebind(out.shapes, read.shapes)

	return out
}

// Every pptx source ref in `value` (a node's, its shapes', their text's) bound to `epoch`: the same part bytes, read
// from the package as it is now.
export function rebindEpoch(value: unknown, epoch: number): void {
	if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return

	if (Array.isArray(value)) {
		for (const item of value) rebindEpoch(item, epoch)

		return
	}

	const record = value as Record<string, unknown>

	for (const [key, item] of Object.entries(record)) {
		if (key === "src" && typeof item === "object" && item !== null) {
			const src = item as { readonly format?: unknown; readonly epoch?: unknown }

			if (src.format === "pptx" && typeof src.epoch === "number" && src.epoch !== epoch) record[key] = { ...src, epoch }
		} else rebindEpoch(item, epoch)
	}
}

function restore(deck: Deck, op: OpOf<"slide"> & { kind: "restore" }, context: SlideSourceReading): ApplyResult<typeof op> {
	const entries = op.slides
	const restored: SlideRef[] = []

	for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
		if (deck.slides.includes(entry.ref)) return refused("malformed", `slide ${String(entry.ref)} is in the deck`)

		const typed = entry.nodes?.map(node => clone(node))
		const main = typed?.[0]
		let nodes: readonly SlideNode[]

		if (
			main !== undefined &&
			(entry.parts.length === 0 || sameRawParts(context.rawParts(main, new Set(entry.parts.map(part => part.name))), entry.parts))
		) {
			// A slide an op made, or parts still in the package as they were: the held nodes' refs are live (bound to the
			// package as it is now, a save's rebase since the delete gave it a new epoch).
			nodes = typed ?? []

			if (context.epoch !== undefined && entry.parts.length > 0) {
				for (const node of nodes) rebindEpoch(node, context.epoch)

				context.restoredLive?.(entry.ref, entry.parts)
			}
		} else {
			const read = context.readSlides(entry.ref, entry.parts)

			if (isRefused(read)) return read

			nodes = typed === undefined ? read : typed.map((node, index) => overlayNode(node, read[index]))
		}

		const slide = nodes[0]

		if (slide === undefined) return refused("malformed", "a restore without its slide")

		slide.ref = entry.ref

		for (const node of nodes) deck.nodes.set(node.ref, node)

		deck.slides.splice(Math.max(0, Math.min(entry.at, deck.slides.length)), 0, entry.ref)
		restored.push(entry.ref)

		if (entry.customShows !== undefined) deck.customShows = clone(entry.customShows) as CustomShow[]

		rewriteJumps(deck, entry.jumps ?? [], "from")
	}

	return { kind: "applied", inverse: { ops: [{ family: "slide", kind: "delete", slides: restored }], bytes: 0 }, op }
}

function move(deck: Deck, op: OpOf<"slide"> & { kind: "move" }): ApplyResult<typeof op> {
	const missing = listed(deck, op.slides)

	if (missing !== undefined) return missing

	const moving = new Set(op.slides)

	const before = [...deck.slides]
	const staying = before.filter(ref => !moving.has(ref))
	const moved = before.filter(ref => moving.has(ref))
	const to = Math.max(0, Math.min(op.to, staying.length))
	const order = [...staying.slice(0, to), ...moved, ...staying.slice(to)]
	const sections = sectionsAfterMove(deck.sections, order, moving)
	// The moved slides to the end (the others keep their order), then each back to its index, lowest first: every
	// earlier position holds its slide when a later one moves, and the ones still to place are behind it. Sections
	// go back as they were (the inverse's own moves may change them).
	const back: DeckOp[] = []

	if (moved.length > 1) back.push({ family: "slide", kind: "move", slides: moved, to: staying.length })

	for (const ref of moved) back.push({ family: "slide", kind: "move", slides: [ref], to: before.indexOf(ref) })

	if (sections !== undefined || deck.sections.length > 0)
		back.push({ family: "slide", kind: "setSections", sections: clone(deck.sections) })
	deck.slides = order

	if (sections !== undefined) deck.sections = sections

	return { kind: "applied", inverse: { ops: back, bytes: 0 }, op }
}

function hide(deck: Deck, op: OpOf<"slide"> & { kind: "hide" }): ApplyResult<typeof op> {
	const shown: SlideRef[] = []
	const hidden: SlideRef[] = []

	const missing = listed(deck, op.slides)

	if (missing !== undefined) return missing

	for (const ref of op.slides) if (deck.nodes.get(ref)?.kind !== "slide") return refused("notFound", `slide ${String(ref)} is not parsed`)

	for (const ref of op.slides) {
		const node = deck.nodes.get(ref) as SlideNode

		if (node.hidden) hidden.push(ref)
		else shown.push(ref)

		node.hidden = op.hidden
		node.revision++
	}

	const back: DeckOp[] = []

	if (shown.length > 0) back.push({ family: "slide", kind: "hide", slides: shown, hidden: false })
	if (hidden.length > 0) back.push({ family: "slide", kind: "hide", slides: hidden, hidden: true })

	return { kind: "applied", inverse: { ops: back, bytes: 0 }, op }
}

// The idx a placeholder takes on `layout` when that layout has no placeholder of its idx but one of its type.
function renumbers(layout: SlideNode, shape: ShapeNode): number | undefined {
	if (shape.ph === undefined) return undefined

	const match = layoutPlaceholder(layout, { ...shape, ph: { ...shape.ph, idxWritten: undefined } as ShapeNode["ph"] & object })

	if (match.shape?.ph === undefined || match.shape.ph.idx === shape.ph.idx || layoutPlaceholder(layout, shape).match === "idx")
		return undefined

	return match.shape.ph.idx
}

function setLayout(deck: Deck, op: OpOf<"slide"> & { kind: "setLayout" }, context: ApplyContext): ApplyResult<typeof op> {
	const node = deck.nodes.get(op.slide)
	const layout = deck.nodes.get(op.layout)

	if (node?.kind !== "slide") return refused("notFound", `slide ${String(op.slide)} is not parsed`)
	if (layout?.kind !== "layout") return refused("notFound", `layout ${String(op.layout)}`)
	if (node.parent === undefined) return refused("malformed", "a slide without a layout")

	// A placeholder the new layout has no placeholder of its idx for takes the idx of one of its type (PowerPoint's
	// re-parenting); the inverse puts those shapes back as they were.
	const back: DeckOp[] = [{ family: "slide", kind: "setLayout", slide: op.slide, layout: node.parent }]
	const renumbered: { shape: ShapeNode; idx: number }[] = []

	for (const [index, shape] of node.shapes.entries()) {
		if (shape.ph === undefined || shape.lock !== undefined) continue

		const idx = renumbers(layout, shape)

		if (idx === undefined) continue

		const raw = shape.src === undefined ? undefined : context.sourceBytes(shape.src)

		if (isRefused(raw)) return raw

		back.push(
			{ family: "shape", kind: "delete", slide: op.slide, shapes: [shape.id] },
			{
				family: "shape",
				kind: "insert",
				slide: op.slide,
				shape: clone(shape),
				index,
				...(raw === undefined ? {} : { raw: raw.slice() })
			}
		)
		renumbered.push({ shape, idx })
	}

	for (const { shape, idx } of renumbered) if (shape.ph !== undefined) shape.ph = { ...shape.ph, idx, idxWritten: true }

	// The inverse's setLayout renumbers too: a placeholder it would renumber that this op left alone is put back
	// as it is now, after it.
	const previous = deck.nodes.get(node.parent)
	const moved = new Set(renumbered.map(({ shape }) => shape))

	if (previous?.kind === "layout") {
		for (const [index, shape] of node.shapes.entries()) {
			if (shape.ph === undefined || shape.lock !== undefined || moved.has(shape) || !renumbers(previous, shape)) continue

			const raw = shape.src === undefined ? undefined : context.sourceBytes(shape.src)

			if (isRefused(raw)) return raw

			back.push(
				{ family: "shape", kind: "delete", slide: op.slide, shapes: [shape.id] },
				{
					family: "shape",
					kind: "insert",
					slide: op.slide,
					shape: clone(shape),
					index,
					...(raw === undefined ? {} : { raw: raw.slice() })
				}
			)
		}
	}

	node.parent = op.layout
	node.revision++

	return { kind: "applied", inverse: { ops: back, bytes: 0 }, op }
}

function reset(deck: Deck, op: OpOf<"slide"> & { kind: "reset" }): ApplyResult<typeof op> {
	const node = deck.nodes.get(op.slide)

	if (node?.kind !== "slide") return refused("notFound", `slide ${String(op.slide)} is not parsed`)

	const back: DeckOp[] = []

	for (const shape of node.shapes) {
		if (shape.ph === undefined || shape.lock !== undefined) continue

		if (shape.xfrm !== undefined) {
			back.push({ family: "shape", kind: "setXfrm", target: { slide: op.slide, id: shape.id }, xfrm: { ...shape.xfrm } })
			delete shape.xfrm
		}

		if (shape.props !== undefined) {
			back.push({ family: "shape", kind: "setProps", target: { slide: op.slide, id: shape.id }, props: clone(shape.props) })
			delete shape.props
		}
	}

	node.revision++

	return { kind: "applied", inverse: { ops: back, bytes: 0 }, op }
}

function setSections(deck: Deck, op: OpOf<"slide"> & { kind: "setSections" }): ApplyResult<typeof op> {
	const listed = new Set(deck.slides)
	const seen = new Set<SlideRef>()

	for (const section of op.sections) {
		for (const ref of section.slides) {
			if (!listed.has(ref) || seen.has(ref)) return refused("malformed", "a section names a slide twice or one not in the deck")

			seen.add(ref)
		}
	}

	const back: DeckOp[] = [{ family: "slide", kind: "setSections", sections: clone(deck.sections) }]

	deck.sections = op.sections.map(section => ({ ...section, slides: [...section.slides] }))

	return { kind: "applied", inverse: { ops: back, bytes: 0 }, op }
}

function applyOne(deck: Deck, op: SlideOp, context: ApplyContext): ApplyResult<SlideOp> {
	if (deck.gate.length > 0) return refused("viewOnly", deck.gate.join(","))

	const source = reading(context)

	switch (op.kind) {
		case "add":
			return source === undefined ? refused("unsupported", "new parts") : add(deck, op, source)
		case "duplicate":
			return source === undefined ? refused("unsupported", "new parts") : duplicate(deck, op, source)
		case "delete":
			return source === undefined ? refused("unsupported", "the reference graph") : remove(deck, op, source)
		case "restore":
			return source === undefined ? refused("unsupported", "source markup cannot be read back here") : restore(deck, op, source)
		case "move":
			return move(deck, op)
		case "hide":
			return hide(deck, op)
		case "setLayout":
			return setLayout(deck, op, context)
		case "reset":
			return reset(deck, op)
		case "setSections":
			return setSections(deck, op)
	}
}

function jumpTouches(jumps: readonly JumpRewrite[] | undefined): Touch[] {
	return (jumps ?? []).map(({ site }) => ({
		kind: "shape",
		slide: site.shape.slide,
		shape: site.shape.id,
		dirt: site.kind === "shape" || site.cell !== undefined ? { kind: "node" } : { kind: "text" }
	}))
}

// What a slide op names. Shapes an op changes inside slides (reset, setLayout's re-numbered placeholders) are named
// by its inverse, which the history adds (engine: touches of the op as applied and of its inverse).
function slideTouches(op: SlideOp): readonly Touch[] {
	switch (op.kind) {
		case "add":
		case "duplicate":
			return [
				...(op.ref === undefined ? [] : [slideTouch(op.ref, { kind: "node" })]),
				presentation("customShows"),
				presentation("slideList"),
				presentation("sections")
			]
		case "delete":
			return [
				...op.slides.map(ref => slideTouch(ref, { kind: "node" })),
				presentation("slideList"),
				presentation("sections"),
				presentation("customShows")
			]
		case "restore":
			return op.slides
				.flatMap(entry => {
					const held = entry

					return [
						slideTouch(held.ref, { kind: "node" }),
						...(held.nodes ?? []).slice(1).map(node => slideTouch(node.ref, { kind: "node" })),
						...jumpTouches(held.jumps)
					]
				})
				.concat([presentation("slideList"), presentation("sections"), presentation("customShows")])
		case "move":
			return [presentation("slideList"), presentation("sections")]
		case "hide":
			return op.slides.map(ref => slideTouch(ref, { kind: "slidePart", part: "attributes" }))
		case "setLayout":
			return [slideTouch(op.slide, { kind: "node" })]
		case "reset":
		case "setSections":
			return op.kind === "reset" ? [] : [presentation("sections")]
	}
}

export const applySlide: ApplyFamily<SlideOp> = {
	apply: applyOne,
	touches: slideTouches
}

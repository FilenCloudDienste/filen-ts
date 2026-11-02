import { bytesSource, memorySink, OpcPackage, partKey, PRESENTATION_ZIP_LIMITS, ZipArchive } from "@filen/office/core/opc"
import { openPptx, type PptxParts } from "../core/pptx/package"
import type { DeckChanges, Dirt, PartChanges, Touch } from "../core/presentation/edit/apply"
import { slideRef, type Deck, type ShapeNode, type SlideNode, type SlideRef } from "../core/presentation/model"
import { savePptx } from "../core/pptx/write/save"
import type { PptxSpliceSource } from "../core/pptx/write/splice"
import type { PptxSaveOptions, PptxSaveOutcome } from "../core/pptx/write/types"
import type { XmlDocument } from "../core/xml/index"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { pptxSaveSource } from "../dom/presentation/engine/save"
import { rebindSources } from "../dom/presentation/save"
import type { EditHarness } from "./presentationEditFixtures"

// Opening a deck for a writer test, describing what an edit dirtied (the writer's contract input; the apply families
// produce the same at run time), and saving it.

export interface OpenedDeck {
	readonly bytes: Uint8Array
	readonly deck: Deck
	readonly parts: PptxParts
	readonly source: PptxSpliceSource
}

export async function openDeck(bytes: Uint8Array): Promise<OpenedDeck> {
	const open = await openPptx(bytesSource(bytes))

	if (open.kind !== "opened") throw new Error(`refused: ${open.reason} ${open.detail ?? ""}`)

	await open.parts.parseAll()

	const archive = await ZipArchive.open(bytesSource(bytes))

	return { bytes, deck: open.deck, parts: open.parts, source: { archive, package: open.parts.opc, index: open.parts } }
}

export class Changes {
	private readonly parts = new Map<string, { change: PartChanges["change"]; shapes: Map<number, Dirt>; slide?: Dirt }>()
	private readonly presentation = new Set<Extract<Touch, { kind: "presentation" }>["what"]>()

	shape(part: string, id: number, dirt: Dirt): this {
		this.part(part).shapes.set(id, dirt)

		return this
	}

	slide(part: string, dirt: Dirt, change: PartChanges["change"] = "changed"): this {
		const entry = this.part(part, change)

		entry.slide = dirt

		return this
	}

	removed(part: string): this {
		this.part(part, "removed")

		return this
	}

	deck(what: Extract<Touch, { kind: "presentation" }>["what"]): this {
		this.presentation.add(what)

		return this
	}

	private part(
		part: string,
		change: PartChanges["change"] = "changed"
	): { change: PartChanges["change"]; shapes: Map<number, Dirt>; slide?: Dirt } {
		let entry = this.parts.get(part)

		if (entry === undefined) {
			entry = { change, shapes: new Map() }
			this.parts.set(part, entry)
		}

		return entry
	}

	build(): DeckChanges {
		return {
			empty: this.parts.size === 0 && this.presentation.size === 0,
			parts: new Map(
				[...this.parts].map(([part, entry]) => [
					part,
					{ change: entry.change, shapes: entry.shapes, ...(entry.slide === undefined ? {} : { slide: entry.slide }) }
				])
			),
			presentation: this.presentation
		}
	}
}

export async function save(
	opened: OpenedDeck,
	changes: DeckChanges,
	options: PptxSaveOptions = {}
): Promise<{ readonly outcome: PptxSaveOutcome; readonly bytes: Uint8Array }> {
	const sink = memorySink()
	const outcome = await savePptx({ deck: opened.deck, source: opened.source, changes, revision: 1 }, sink, options)

	return { outcome, bytes: outcome.kind === "written" ? sink.bytes() : new Uint8Array(0) }
}

export function slideNode(opened: OpenedDeck, index: number): SlideNode {
	const ref = opened.deck.slides[index]
	const node = ref === undefined ? undefined : opened.deck.nodes.get(ref)

	if (node === undefined) throw new Error(`no slide ${String(index)}`)

	return node
}

export function shapeOf(node: SlideNode, id: number): ShapeNode {
	const found = findShape(node.shapes, id)

	if (found === undefined) throw new Error(`no shape ${String(id)}`)

	return found
}

function findShape(shapes: readonly ShapeNode[], id: number): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.id === id) return shape

		const inner = shape.children === undefined ? undefined : findShape(shape.children, id)

		if (inner !== undefined) return inner
	}

	return undefined
}

// The part bytes of a package by entry name.
export async function partsOf(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const out = new Map<string, Uint8Array>()

	for (const entry of archive.entries) out.set(entry.name, await archive.read(entry))

	return out
}

export function text(bytes: Uint8Array | undefined): string {
	return new TextDecoder().decode(bytes)
}

export async function opcOf(bytes: Uint8Array): Promise<OpcPackage> {
	return OpcPackage.open(bytesSource(bytes))
}

// A duplicate of `node` as the slide family's apply makes one: a new ref and part, the same source.
export function duplicateNode(node: SlideNode, ref: SlideRef, part: string): SlideNode {
	const { notes: _notes, ...rest } = node

	return { ...rest, ref, part, shapes: node.shapes.map(shape => ({ ...shape })), comments: [], revision: 0 }
}

function walkShapes(shapes: readonly ShapeNode[], visit: (shape: ShapeNode) => void): void {
	for (const shape of shapes) {
		visit(shape)
		if (shape.children !== undefined) walkShapes(shape.children, visit)
	}
}

// What the ES2 edit set did, for the checks after a reopen.
export interface Es2Report {
	readonly moved?: {
		readonly slide: number
		readonly id: number
		readonly name: string
		readonly index: number
		readonly out?: number | undefined
	}
	// Indices in the saved deck: the hidden slide, the copy, the added slide (and its layout's name).
	readonly out?: {
		readonly hidden?: number | undefined
		readonly duplicate?: number | undefined
		readonly duplicateOf?: number | undefined
		readonly added?: number | undefined
		readonly addedLayout?: string | undefined
	}
	readonly hidden?: number
	readonly relaid?: { readonly slide: number; readonly layout: string }
	readonly duplicated?: number
	readonly added: boolean
	readonly deleted?: string
	readonly slides: number
}

// Edit set ES2 (no text edits) on a parsed deck, as the slide and shape families apply it: move, resize and rotate
// a shape and set its fill; hide a slide; change a slide's layout; duplicate a slide; add a Title and Content
// slide; delete a slide (a slide-jump target and section member where the deck has one); move the first slide last.
export function applyEs2(opened: OpenedDeck): { readonly changes: DeckChanges; readonly report: Es2Report } {
	const deck = opened.deck
	const changes = new Changes()
	const report: { -readonly [K in keyof Es2Report]: Es2Report[K] } = { added: false, slides: 0 }
	let nextRef = 100_000
	let movedRef: SlideRef | undefined
	let copyOf: SlideRef | undefined
	let copyMade: SlideRef | undefined
	let addedRef: SlideRef | undefined
	let addedLayout: string | undefined
	const slideAt = (index: number): SlideNode | undefined => {
		const ref = deck.slides[index]

		return ref === undefined ? undefined : deck.nodes.get(ref)
	}

	// The shape edit: the first unlocked sp with its own xfrm.
	for (let index = 0; index < deck.slides.length && report.moved === undefined; index++) {
		const node = slideAt(index)

		if (node === undefined) continue

		for (const shape of node.shapes) {
			if (shape.kind !== "sp" || shape.lock !== undefined || shape.xfrm === undefined || shape.src === undefined) continue

			shape.xfrm = {
				...shape.xfrm,
				x: shape.xfrm.x + 12700,
				y: shape.xfrm.y + 12700,
				cx: Math.round(shape.xfrm.cx * 1.1),
				rot: 600000
			}
			shape.props = { fill: { kind: "solid", color: { kind: "srgb", rgb: "4472C4" } } }
			changes.shape(node.part, shape.id, { kind: "props", group: "fill" })
			report.moved = { slide: index, id: shape.sourceId ?? shape.id, name: shape.name, index: node.shapes.indexOf(shape) }
			movedRef = node.ref

			break
		}
	}

	const first = slideAt(0)

	if (first !== undefined) {
		first.hidden = !first.hidden
		changes.slide(first.part, { kind: "slidePart", part: "attributes" })
		report.hidden = 0

		// Change layout: another layout of the same master.
		const current = first.parent === undefined ? undefined : deck.nodes.get(first.parent)
		const other = deck.layouts
			.map(ref => deck.nodes.get(ref))
			.find(layout => layout !== undefined && layout.ref !== first.parent && layout.parent === current?.parent)

		if (other !== undefined) {
			first.parent = other.ref
			changes.slide(first.part, { kind: "node" })
			report.relaid = { slide: 0, layout: other.part }
		}

		// Duplicate slide 1 (or the first) after itself.
		const source = slideAt(1) ?? first
		const copyRef = slideRef(nextRef++)
		const copy = duplicateNode(source, copyRef, `/ppt/slides/slide${String(deck.slides.length + 50)}.xml`)

		deck.nodes.set(copyRef, copy)
		copyOf = source.ref
		copyMade = copyRef
		deck.slides.splice(deck.slides.indexOf(source.ref) + 1, 0, copyRef)
		changes.slide(copy.part, { kind: "node" }, "added")
		report.duplicated = deck.slides.indexOf(source.ref)

		for (const section of deck.sections) {
			const at = section.slides.indexOf(source.ref)

			if (at >= 0) section.slides.splice(at + 1, 0, copyRef)
		}
	}

	// Add a Title and Content slide (the first layout of type obj, else the first layout).
	const layout =
		deck.layouts.map(ref => deck.nodes.get(ref)).find(node => node?.layoutType === "obj") ??
		deck.nodes.get(deck.layouts[0] ?? (0 as SlideRef))

	if (layout !== undefined) {
		const ref = slideRef(nextRef++)
		const shapes: ShapeNode[] = []
		let id = 2

		for (const shape of layout.shapes) {
			if (shape.ph === undefined || ["dt", "ftr", "sldNum", "hdr"].includes(shape.ph.type)) continue

			shapes.push({
				id: id++,
				name: shape.name,
				hidden: false,
				kind: "sp",
				ph: shape.ph,
				text: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [], endRPr: { lang: "en-US" } }] }
			})
		}

		deck.nodes.set(ref, {
			ref,
			kind: "slide",
			part: `/ppt/slides/slide${String(deck.slides.length + 60)}.xml`,
			parent: layout.ref,
			showMasterShapes: true,
			hidden: false,
			shapes,
			comments: [],
			revision: 0
		})
		deck.slides.push(ref)
		changes.slide(`/ppt/slides/slide${String(deck.slides.length + 59)}.xml`, { kind: "node" }, "added")
		report.added = true
		addedRef = ref
		addedLayout = layout.name
	}

	// Delete a slide-jump target (and section member) when there is one, else the last base slide not edited above.
	const targets = new Set<SlideRef>()

	for (const node of deck.nodes.values()) {
		if (node.kind !== "slide") continue

		walkShapes(node.shapes, shape => {
			for (const action of [shape.actions?.click, shape.actions?.hover]) if (action?.kind === "slide") targets.add(action.slide)
		})
	}

	const deletable = deck.slides.filter(ref => {
		const index = deck.slides.indexOf(ref)

		return index > 1 && ref < 100_000 && index !== report.moved?.slide && opened.parts.partOf(ref) !== undefined
	})
	const victim = deletable.find(ref => targets.has(ref)) ?? deletable.at(-1)

	if (victim !== undefined && deck.slides.length > 2) {
		const part = opened.parts.partOf(victim) ?? ""

		deck.slides.splice(deck.slides.indexOf(victim), 1)
		for (const section of deck.sections) section.slides = section.slides.filter(ref => ref !== victim)
		for (const show of deck.customShows) show.slides = show.slides.filter(ref => ref !== victim)
		changes.removed(part).deck("sections").deck("customShows")
		report.deleted = part

		// A jump to it becomes "next slide" (the slide family's delete).
		for (const node of deck.nodes.values()) {
			if (node.kind !== "slide" || !deck.slides.includes(node.ref)) continue

			walkShapes(node.shapes, shape => {
				const click = shape.actions?.click
				const hover = shape.actions?.hover

				if (click?.kind === "slide" && click.slide === victim) {
					shape.actions = { ...shape.actions, click: { kind: "internal", jump: "next" } }
					changes.shape(node.part, shape.id, { kind: "node" })
				}

				if (hover?.kind === "slide" && hover.slide === victim) {
					shape.actions = { ...shape.actions, hover: { kind: "internal", jump: "next" } }
					changes.shape(node.part, shape.id, { kind: "node" })
				}
			})
		}
	}

	// Move the first slide last.
	if (deck.slides.length > 1) {
		const [head] = deck.slides.splice(0, 1)

		if (head !== undefined) deck.slides.push(head)
	}

	changes.deck("slideList")
	report.slides = deck.slides.length

	const at = (ref: SlideRef | undefined): number | undefined =>
		ref === undefined || !deck.slides.includes(ref) ? undefined : deck.slides.indexOf(ref)

	if (report.moved !== undefined) report.moved = { ...report.moved, ...(at(movedRef) === undefined ? {} : { out: at(movedRef) }) }

	report.out = {
		...(first === undefined || at(first.ref) === undefined ? {} : { hidden: at(first.ref) }),
		...(at(copyMade) === undefined ? {} : { duplicate: at(copyMade), duplicateOf: report.duplicated }),
		...(at(addedRef) === undefined ? {} : { added: at(addedRef), addedLayout })
	}
	void copyOf

	return { changes: changes.build(), report }
}

// An edit session's changes saved at `revision` and committed as its save point; the saved bytes.
export async function saveEdits(h: EditHarness, revision: number): Promise<Uint8Array> {
	const point = sessionEdits(h.session).history.savePoint()
	const sink = memorySink()
	const base = pptxSaveSource(h.session)
	// The parts a restored slide holds, as the engine's save source hands them on.
	const source = { ...base, raw: { ...base.raw, parts: (name: string) => sessionEdits(h.session).rawParts(name) } }
	const outcome = await savePptx({ deck: h.session.deck, source, changes: sessionEdits(h.session).changes(), revision }, sink, {})

	if (outcome.kind !== "written") throw new Error(`save: ${JSON.stringify(outcome)}`)

	sessionEdits(h.session).history.commit(point)

	return sink.bytes().slice()
}

// Part names whose bytes differ between two packages (added ones included).
export async function changedParts(before: Uint8Array, after: Uint8Array): Promise<string[]> {
	const a = await partsOf(before)
	const b = await partsOf(after)

	return [...b].filter(([name, data]) => text(a.get(name)) !== text(data)).map(([name]) => name)
}

// A session moved onto its saved file as engine/save.ts rebasePptx moves it: the package re-opened over the saved
// bytes, the rewritten documents rebound, the part index moved onto it.
export async function rebaseSession(h: EditHarness, before: Uint8Array, saved: Uint8Array): Promise<void> {
	const parts = pptxParts(h.session.deck)

	if (parts === undefined) throw new Error("no parts")

	const source = bytesSource(saved)
	const opc = await OpcPackage.open(source, { limits: PRESENTATION_ZIP_LIMITS })
	const contentTypes = await opc.contentTypes()
	const epoch = parts.epoch + 1
	const rewritten = new Map<string, { readonly from: XmlDocument; readonly to: XmlDocument }>()
	const documents = new Map<string, XmlDocument | undefined>()

	for (const name of await changedParts(before, saved)) {
		const from = parts.document(`/${name}`)

		if (from === undefined || !opc.has(name)) {
			documents.set(`/${name}`, undefined)

			continue
		}

		const to = await opc.xml(name)

		rewritten.set(partKey(`/${name}`), { from, to })
		documents.set(`/${name}`, to)
	}

	for (const entry of h.session.package.archive?.entries ?? []) if (!opc.has(entry.name)) documents.set(`/${entry.name}`, undefined)

	const plan = await parts.prepareRebase(opc)

	rebindSources(h.session.deck, epoch, rewritten)
	parts.rebase(opc, contentTypes, epoch, documents, plan)
	h.session.package = { ...h.session.package, bytes: source.size, source, archive: opc.zip, opc }
}

// Every internal relationship of a package names a part it has, every relationship id a part's markup names is one of
// its relationships, and every diagram's data names its drawing (dsp:dataModelExt@relId, unprefixed) by a relationship of
// each slide that relates the data: the problems found.
export async function danglingReferences(bytes: Uint8Array): Promise<string[]> {
	const opc = await opcOf(bytes)
	const problems: string[] = []

	for (const entry of opc.entries()) {
		const match = /^(.*?)_rels\/([^/]*)\.rels$/iu.exec(entry.name)

		if (match !== null) {
			const source = `${match[1] ?? ""}${match[2] ?? ""}`

			for (const relationship of (await opc.relationships(source)).all)
				if (!relationship.external && relationship.partName !== undefined && !opc.has(relationship.partName))
					problems.push(`${source} -> ${relationship.partName}`)

			continue
		}

		if (!/\.xml$/iu.test(entry.name) || entry.name === "[Content_Types].xml") continue

		const markup = text(await opc.read(entry.name))
		const relationships = await opc.relationships(entry.name)
		const ids = new Set(relationships.all.map(relationship => relationship.id))

		for (const found of markup.matchAll(/\sr:(?:id|embed|link|pict|dm|lo|qs|cs)="([^"]+)"/gu))
			if (!ids.has(found[1] ?? "")) problems.push(`${entry.name} names ${found[1] ?? ""}`)

		for (const found of markup.matchAll(/\sr:dm="([^"]+)"/gu)) {
			const data = relationships.byId(found[1] ?? "")?.partName

			if (data === undefined || !opc.has(data)) continue

			const drawing = /\brelId="([^"]+)"/u.exec(text(await opc.read(data)))?.[1]

			// A relationship whose part is missing is the relationship check's (above).
			if (drawing !== undefined && relationships.byId(drawing) === undefined)
				problems.push(`${entry.name}: its diagram data names drawing ${drawing}, which it does not relate`)
		}
	}

	return problems
}

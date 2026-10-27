import { openOdp, type OdpParts } from "../read/document"
import { readOdpTiming } from "../../anim/odf"
import { Fragment, type OdpContext } from "../read/context"
import { OdfStyleResolver, OdfStyleSheet, readContentPrologue } from "../../odf/index"
import { pageFragment, type PageSpan } from "../read/scan"
import { readShapeElements, type ShapeScope } from "../read/shapes"
import {
	PresentationError,
	refused,
	type Deck,
	type Refused,
	type SlideNode,
	type SlideRef,
	type SourceRef
} from "../../presentation/model"
import { Namespaces, encodeUtf8, escapeAttribute, type XmlDocument } from "../../xml/index"
import { inheritedDeclarations } from "../../presentation/edit/canonical"

// The source an ODP save writes from: the package the deck was read from, its pages in content order with their byte
// spans, each page parsed again on demand as the fragment its nodes' refs index into, and a pristine reading of any
// page (the reader's own, from the same bytes, never edited) that the writer compares the session's slides with.
// Also what the edit session reads source markup through for its inverses (sourceBytes).

// What the writer needs of the reader's parts beyond its public reading API (OdpParts gains these; until then they
// are derived from a second reading, valid while the deck was never rebased).
interface PageIndex {
	pageRefs?(): readonly SlideRef[]
	span?(ref: SlideRef): PageSpan | undefined
}

// Held markup names are unique in the worker: refs into one source's held markup stay distinct from another's.
let heldNames = 0

// Page fragments kept parsed at once (the touched pages of a save, the slides an inverse reads): the rest are parsed
// again when asked for.
const FRAGMENTS = 64

export class OdpWriteSource {
	readonly parts: OdpParts
	private readonly fragments = new Map<number, Fragment>()
	// Markup an inverse held, read back (a deleted page restored after a rebase, a re-inserted shape): "raw:N".
	private readonly held = new Map<string, Fragment>()
	// Automatic styles of content.xml a save took out once nothing referenced them (a deleted shape's), by name, as
	// markup: an undo can put back markup that names them, so the session keeps them across saves and a page written
	// with such markup gets them back.
	readonly retired = new Map<string, string>()
	private heldContextCache: { readonly size: number; readonly context: OdpContext } | undefined
	private shadow: Promise<{ readonly deck: Deck; readonly parts: OdpParts }> | undefined
	private order: readonly SlideRef[] | undefined

	constructor(parts: OdpParts) {
		this.parts = parts
	}

	get epoch(): number {
		return this.parts.epoch
	}

	// A second reading of the same bytes, never edited: what each page said before the session's edits.
	private pristineReading(): Promise<{ readonly deck: Deck; readonly parts: OdpParts }> {
		this.shadow ??= openOdp(this.parts.odf.archive.source, { epoch: this.parts.epoch, budgets: this.parts.budgets }).then(opened => {
			if (opened.kind !== "opened") throw new PresentationError(opened.reason, opened.detail ?? "the source reads differently now")

			return opened
		})

		return this.shadow
	}

	// The package's pages in content order, by the refs the deck names them with.
	async pages(): Promise<readonly SlideRef[]> {
		const index = this.parts as OdpParts & PageIndex

		if (index.pageRefs !== undefined) return index.pageRefs()
		if (this.order !== undefined) return this.order
		if (this.parts.epoch !== 0) throw new PresentationError("notImplemented", "the page order of a rebased deck")

		// A first reading allots page refs in content order, deterministically: the second reading's are the deck's.
		this.order = [...(await this.pristineReading()).deck.slides]

		return this.order
	}

	async span(ref: SlideRef): Promise<PageSpan | undefined> {
		const index = this.parts as OdpParts & PageIndex

		if (index.span !== undefined) return index.span(ref)

		const at = (await this.pages()).indexOf(ref)

		return at < 0 ? undefined : this.parts.content.pages[at]
	}

	// The span starting at a byte offset of content.xml (a fragment offset of a SourceRef).
	spanAt(offset: number): PageSpan | undefined {
		const pages = this.parts.content.pages
		let low = 0
		let high = pages.length - 1

		while (low <= high) {
			const middle = (low + high) >>> 1
			const span = pages[middle] as PageSpan

			if (span.start === offset) return span
			if (span.start < offset) low = middle + 1
			else high = middle - 1
		}

		return undefined
	}

	// A page parsed as the fragment its nodes' refs index into (the reader's pageFragment, so node indexes agree).
	fragment(span: PageSpan): Fragment {
		const held = this.fragments.get(span.start)

		if (held !== undefined) return held

		const document = pageFragment(this.parts.content, span)
		const fragment = new Fragment(
			document,
			new Namespaces(document, { lenient: true }),
			"content.xml",
			span.start,
			"content",
			this.parts.epoch
		)

		if (this.fragments.size >= FRAGMENTS) this.fragments.delete(this.fragments.keys().next().value as number)

		this.fragments.set(span.start, fragment)

		return fragment
	}

	// The context held markup is read with: the deck's, its automatic styles grown by the retired ones.
	heldContext(): OdpContext {
		const parts = this.parts

		if (this.retired.size === 0) return parts.context
		if (this.heldContextCache?.size === this.retired.size) return this.heldContextCache.context

		const content = parts.content.bytes
		const prologue = readContentPrologue(content)
		const head = content.subarray(0, prologue.bodyStart)
		const marker = encodeUtf8(`<office:automatic-styles>${[...this.retired.values()].join("")}</office:automatic-styles>`)
		const sheet = new OdfStyleSheet(
			parts.sheet.stylesDocument,
			readContentPrologue(concat(head, marker, encodeUtf8("<office:body/>"), parts.content.rootClose))
		)
		// The deck's context in all but its styles (pages, package facts, tallies).
		const context = Object.create(parts.context) as OdpContext

		Object.defineProperty(context, "sheet", { value: sheet })
		Object.defineProperty(context, "resolver", { value: new OdfStyleResolver(sheet) })
		Object.defineProperty(context, "owned", { value: new Map() })
		this.heldContextCache = { size: this.retired.size, context }

		return context
	}

	// Held markup as a fragment of its own (refs into it name "raw:N"; it is never stale: the inverse holds its bytes).
	hold(document: XmlDocument): Fragment {
		const name = `raw:${String(++heldNames)}`
		const fragment = new Fragment(document, new Namespaces(document, { lenient: true }), name, -1, "content", this.parts.epoch)

		this.held.set(name, fragment)

		return fragment
	}

	// Held markup another source of the same deck kept (the one before a rebase): its refs still read.
	adoptHeld(from: OdpWriteSource): void {
		for (const [name, fragment] of from.held) if (!this.held.has(name)) this.held.set(name, fragment)
	}

	// The fragment a source ref indexes into (a page of content.xml, styles.xml whole, or held markup), or undefined.
	fragmentOf(src: SourceRef): Fragment | undefined {
		if (src.format !== "odp") return undefined

		const held = this.held.get(src.part)

		if (held !== undefined) return held
		if (src.epoch !== this.parts.epoch) return undefined
		if (src.part === "styles.xml") return this.parts.stylesFragment

		const span = this.spanAt(src.fragment)

		return span === undefined ? undefined : this.fragment(span)
	}

	// A held page read as the reader reads its shapes (the pristine side of a page an undo restored).
	readHeld(fragment: Fragment): { readonly slide: SlideNode; readonly notes: SlideNode | undefined } {
		const document = fragment.document
		const page = document.firstChildElement(document.documentElement())
		const read = (container: number, kind: "slide" | "notes"): SlideNode => {
			let next = 1
			const scope: ShapeScope = {
				fragment,
				text: {},
				masterBoxes: new Map(),
				nextId: () => ++next,
				images: new Set(),
				charts: new Set(),
				clips: [],
				unread: 0
			}
			const nodes: number[] = []

			for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child))
				nodes.push(child)

			return {
				ref: -1 as SlideRef,
				kind,
				part: "/content.xml",
				src: fragment.src(container),
				name: fragment.attributes(container).get("draw:name") ?? "",
				showMasterShapes: true,
				hidden: false,
				shapes: readShapeElements(this.heldContext(), scope, nodes),
				comments: [],
				revision: 0
			}
		}
		let notes: SlideNode | undefined

		for (let child = document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child))
			if (fragment.name(child) === "presentation:notes") notes = read(child, "notes")

		return { slide: read(page, "slide"), notes }
	}

	// A held page (an undo put back after a save took it out) as the reader reads it, page fields and all: what the
	// writer compares the restored slide with.
	readHeldPage(fragment: Fragment): { readonly slide: SlideNode; readonly notes: SlideNode | undefined } {
		const held = this.readHeld(fragment)
		const document = fragment.document
		const page = document.firstChildElement(document.documentElement())
		const attributes = fragment.attributes(page)
		// The page's styles may be ones a save retired (the deleted page's own): read with them.
		const context = this.heldContext()
		const style = this.parts.pageStyle(attributes.get("draw:style-name"), "content", context).attributes
		const { background, transition } = this.parts.pageFields(fragment, page, context)
		const timing = readOdpTiming(fragment, page, held.slide.shapes, this.parts.budgets.timing)
		const parent = this.layoutOf(
			attributes.get("draw:master-page-name") ?? "",
			attributes.get("presentation:presentation-page-layout-name")
		)
		const { background: _background, transition: _transition, timing: _timing, parent: _parent, ...base } = held.slide
		const slide: SlideNode = {
			...base,
			name: attributes.get("draw:name") ?? "",
			hidden: style.get("presentation:visibility") === "hidden",
			showMasterShapes: style.get("presentation:background-objects-visible") !== "false",
			...(parent === undefined ? {} : { parent }),
			...(background === undefined ? {} : { background }),
			...(transition === undefined ? {} : { transition }),
			...(timing === undefined ? {} : { timing })
		}

		return { slide, notes: held.notes }
	}

	// The deck's layout for a page naming a master page and a presentation page layout (the reader lists masters in
	// the order styles.xml holds their master pages).
	private layoutOf(master: string, pageLayout: string | undefined): SlideRef | undefined {
		const deck = this.parts.deck
		const order = this.parts.sheet.masterOrder
		const masterRef = deck.masters[Math.max(0, order.indexOf(master))]

		return deck.layouts.find(ref => {
			const layout = deck.nodes.get(ref)

			return layout !== undefined && layout.parent === masterRef && (layout.layoutType ?? "") === (pageLayout ?? "")
		})
	}

	// A page as the reader reads it from the source, untouched by edits (its notes with it, under the reading's refs).
	async pristine(ref: SlideRef): Promise<{ readonly slide: SlideNode; readonly notes: SlideNode | undefined } | undefined> {
		const index = (await this.pages()).indexOf(ref)

		if (index < 0) return undefined

		const reading = await this.pristineReading()
		const shadowRef = reading.deck.slides[index]

		if (shadowRef === undefined) return undefined

		const slide = await reading.parts.slide(shadowRef)
		const notes = slide.notes === undefined ? undefined : reading.deck.nodes.get(slide.notes)
		// The second reading numbers its pages itself: a jump it read names the page at the same place in the deck's
		// reading, so the two compare by the page they land on.
		const pages = await this.pages()
		const refs = new Map(reading.deck.slides.map((ref, at) => [ref as number, pages[at]]))
		const relink = (node: SlideNode): SlideNode => ({ ...node, shapes: node.shapes.map(shape => withJumps(shape, refs)) })

		return { slide: relink(slide), notes: notes === undefined ? undefined : relink(notes) }
	}

	// The source pages that link to any of `targets` by name ("#name" in an xlink:href, §19.910): what a delete of
	// those pages parses, so their jumps are rewritten. Found by a byte search of each page's span, no parse.
	async linkingTo(targets: readonly SlideRef[], deck: Deck): Promise<SlideRef[]> {
		const names = targets
			.map(ref => deck.nodes.get(ref)?.name ?? this.parts.pageName(ref))
			.filter((name): name is string => name !== undefined && name !== "")
			.flatMap(name => [`"#${escapeAttribute(name)}"`, `"#${escapeAttribute(encodeURIComponent(name))}"`])
			.map(needle => encodeUtf8(needle))

		if (names.length === 0) return []

		const out: SlideRef[] = []
		const pages = await this.pages()
		const bytes = this.parts.content.bytes

		for (const [index, ref] of pages.entries()) {
			const span = this.parts.content.pages[index]

			if (span === undefined || targets.includes(ref)) continue
			if (names.some(needle => contains(bytes, span.start, span.end, needle))) out.push(ref)
		}

		return out
	}

	// The markup a source ref names, with the namespace declarations it needs to be read on its own (an inverse holds
	// it as bytes, so it survives a rebase).
	sourceBytes(src: SourceRef): Uint8Array | Refused {
		if (src.format !== "odp") return refused("unsupported", `${src.format} source in an ODP deck`)
		if (src.epoch !== this.parts.epoch && !this.held.has(src.part)) return refused("stale", src.part)

		const fragment = this.fragmentOf(src)

		if (fragment === undefined) return refused("notFound", `${src.part} at ${String(src.fragment)}`)

		const document = fragment.document

		if (src.node <= 0 || src.node >= document.count) return refused("notFound", src.part)

		return withDeclarations(document, src.node)
	}
}

function contains(bytes: Uint8Array, from: number, to: number, needle: Uint8Array): boolean {
	const first = needle[0] ?? 0

	for (let at = bytes.indexOf(first, from); at >= 0 && at + needle.length <= to; at = bytes.indexOf(first, at + 1)) {
		let k = 1

		while (k < needle.length && bytes[at + k] === needle[k]) k++

		if (k === needle.length) return true
	}

	return false
}

// An element's bytes with the namespace declarations in scope at it added to its start tag.
export function withDeclarations(document: XmlDocument, node: number): Uint8Array {
	const raw = document.raw(node)
	const own = new Set(document.attributes(node).map(attribute => attribute.name))
	let extra = ""

	for (const [prefix, uri] of inheritedDeclarations(document, node)) {
		const name = prefix === "" ? "xmlns" : `xmlns:${prefix}`

		if (own.has(name) || uri === "") continue

		extra += ` ${name}="${escapeAttribute(uri)}"`
	}

	if (extra === "") return raw

	const nameEnd = 1 + encodeUtf8(document.name(node)).length
	const head = encodeUtf8(extra)
	const out = new Uint8Array(raw.length + head.length)

	out.set(raw.subarray(0, nameEnd), 0)
	out.set(head, nameEnd)
	out.set(raw.subarray(nameEnd), nameEnd + head.length)

	return out
}

// One source per reading of a deck (the engine's session and the writer share it; a rebase makes a new one).
const sources = new WeakMap<OdpParts, OdpWriteSource>()

export function odpWriteSource(parts: OdpParts): OdpWriteSource {
	let source = sources.get(parts)

	if (source === undefined) {
		source = new OdpWriteSource(parts)
		sources.set(parts, source)
	}

	return source
}

function concat(...chunks: readonly Uint8Array[]): Uint8Array {
	let length = 0

	for (const chunk of chunks) length += chunk.length

	const out = new Uint8Array(length)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

// A value with each slide jump in it ({kind: "slide", slide}) naming the slide `refs` maps its ref to (copied where
// one changes; a jump to a page the map has not is left naming no page).
function withJumps<T>(value: T, refs: ReadonlyMap<number, SlideRef | undefined>): T {
	if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return value
	if (Array.isArray(value)) {
		let changed = false
		const out = value.map(item => {
			const next = withJumps(item as unknown, refs)

			if (next !== item) changed = true

			return next
		})

		return (changed ? out : value) as T
	}

	const record = value as Record<string, unknown>

	if (record["kind"] === "slide" && typeof record["slide"] === "number") {
		return { ...record, slide: refs.get(record["slide"]) ?? (-1 as SlideRef) } as T
	}

	let out: Record<string, unknown> | undefined

	for (const key of Object.keys(record)) {
		if (key === "src") continue

		const next = withJumps(record[key], refs)

		if (next !== record[key]) {
			out ??= { ...record }
			out[key] = next
		}
	}

	return (out ?? value) as T
}

import { readContentPrologue } from "../../odf/index"
import { emitOdp } from "./emit"
import { emitFamilyOf } from "../../pptx/write/emit"
import { markupBytes, type ProofTally } from "../../presentation/edit/proof"
import { DeckTally } from "../../presentation/budget"
import {
	refused,
	type Deck,
	type LockReason,
	type ShapeNode,
	type SlideNode,
	type SlideRef,
	type SourceRef
} from "../../presentation/model"
import { Namespaces, decodeUtf8, encodeUtf8, parseXml } from "../../xml/index"
import { Fragment, OdpContext } from "../read/context"
import { readShapeElements, type ShapeScope } from "../read/shapes"
import { IDENTITY, OdpShapeWriter, type Aspects } from "./emit/shape"
import { slideDiffers } from "./meaning"
import { pageNames } from "./integrity"
import type { OdpWriteSource } from "./source"
import { OdpStyles, isRefused, takenInStreams } from "./styles"

// Proof gate 1 for ODP (§1.5.3): before the first edit on a slide, each source shape is written by the emitters as an
// edit of what it already says (its box, its text, its name, title and visibility rewritten from the model) and read
// back by the reader; a shape that does not read back as the model holds it is locked (proofFailed): selectable,
// its bytes kept, moved only when its box alone writes back (isBoxWritable). A locked shape's content is never
// rewritten. Fill, line, shadow and text-area edits are checked by gate 2 when they are made.

const BOXED =
	/^(draw:(frame|custom-shape|rect|ellipse|circle|polygon|polyline|path|regular-polygon|caption|control|page-thumbnail)|dr3d:scene)$/u
const LINE = /^draw:(line|measure|connector)$/u

// Whether a shape's own draw:transform (§19.229) is one the box writes back: none, or turns and moves only (a scale or
// skew the reader folds into the box would be lost by a rewrite). A group's members are its box.
function boxProves(fragment: Fragment, shape: ShapeNode): boolean {
	const src = shape.src

	if (src?.format !== "odp" || src.node <= 0 || src.node >= fragment.document.count) return true
	if (fragment.name(src.node) === "draw:g") return (shape.children ?? []).every(child => boxProves(fragment, child))

	const transform = fragment.attributes(src.node).get("draw:transform")

	if (transform === undefined) return true

	for (const name of transformNames(transform)) if (name !== "rotate" && name !== "translate") return false

	return true
}

// The names of draw:transform's functions, lower case, as /([a-zA-Z]+)\s*\(/g finds them; a name starts where a run of
// letters does (the lookbehind): tried inside every run, the scan was quadratic in it.
export function transformNames(transform: string): string[] {
	return [...transform.matchAll(/(?<![a-zA-Z])([a-zA-Z]+)\s*\(/gu)].map(match => (match[1] ?? "").toLowerCase())
}

// Whether a shape's box is written by attributes alone (svg:x/y/width/height, draw:transform, a line's ends): what a
// move or a resize of a locked shape needs.
export function isBoxWritable(shape: ShapeNode, fragmentOf: (src: SourceRef) => Fragment | undefined): boolean {
	if (shape.lock === undefined) return true
	if (shape.lock !== "proofFailed" || shape.src === undefined) return false

	const fragment = fragmentOf(shape.src)

	if (fragment === undefined || shape.src.format !== "odp" || shape.src.node <= 0 || shape.src.node >= fragment.document.count)
		return false

	const name = fragment.name(shape.src.node)

	if (LINE.test(name)) return !fragment.attributes(shape.src.node).has("svg:d")
	if (name === "draw:g") return (shape.children ?? []).every(child => isBoxWritable(child, fragmentOf))
	if (!BOXED.test(name)) return false

	if (!boxProves(fragment, shape)) return false

	return name === "draw:custom-shape" || (shape.xfrm?.flipH !== true && shape.xfrm?.flipV !== true)
}

const PROVED: Aspects = { xfrm: true, text: true, alt: true, name: true, hidden: true }

export interface OdpProofInput {
	readonly deck: Deck
	readonly slide: SlideNode
	readonly source: OdpWriteSource
}

function walk(shapes: readonly ShapeNode[], visit: (shape: ShapeNode) => void): void {
	for (const shape of shapes) {
		visit(shape)
		if (shape.children !== undefined) walk(shape.children, visit)
	}
}

interface DeckPages {
	readonly slides: readonly SlideRef[]
	readonly length: number
	readonly revision: number
	// Each page's name as the writer names it, the page a name reads back as, and each page's place.
	readonly names: ReadonlyMap<SlideRef, string>
	readonly pages: ReadonlyMap<string, SlideRef>
	readonly index: ReadonlyMap<SlideRef, number>
}

// The deck's pages as every page's proof reads them, made once per deck state (an op proving every page reads them
// a thousand times over).
const deckPagesCache = new WeakMap<Deck, DeckPages>()

function deckPages(deck: Deck, parts: OdpWriteSource["parts"]): DeckPages {
	const held = deckPagesCache.get(deck)

	if (held !== undefined && held.slides === deck.slides && held.length === deck.slides.length && held.revision === deck.revision)
		return held

	const names = pageNames(
		deck,
		ref => deck.nodes.get(ref)?.name ?? parts.pageName(ref),
		ref => {
			const own = parts.pageName(ref)

			return own !== undefined && own === (deck.nodes.get(ref)?.name ?? own)
		}
	)
	// A jump written to a page reads back as the session's ref for it.
	const pages = new Map<string, SlideRef>()

	for (const [ref, name] of names) if (!pages.has(name)) pages.set(name, ref)

	const made: DeckPages = {
		slides: deck.slides,
		length: deck.slides.length,
		revision: deck.revision,
		names,
		pages,
		index: new Map(deck.slides.map((ref, at) => [ref, at]))
	}

	deckPagesCache.set(deck, made)

	return made
}

// Proves every source shape of a slide once, locking the ones that fail (as proveSlide does for pptx).
export function proveOdpSlide(input: OdpProofInput): ProofTally {
	const { deck, slide, source } = input
	const parts = source.parts
	const locked: Partial<Record<LockReason, number>> = {}
	const failures: Record<string, number> = {}
	let shapes = 0
	let movable = 0
	const src = slide.src
	const fragment = src === undefined ? undefined : source.fragmentOf(src)

	walk(slide.shapes, () => shapes++)

	if (fragment === undefined || src?.format !== "odp") return { shapes, locked, movable, failures }

	const { names, pages, index } = deckPages(deck, parts)
	const taken = takenInStreams(parts)
	const fragments = new WeakMap([[fragment.document, fragment]])
	const styles = new OdpStyles(
		{
			context: parts.context,
			stylesFragment: parts.stylesFragment,
			fragmentOf: document => fragments.get(document),
			sourceFragment: ref => source.fragmentOf(ref),
			pageName: ref => names.get(ref),
			dispatch: emitOdp,
			familyOf: emitFamilyOf
		},
		"content",
		taken
	)
	const context = { deck, document: fragment.document, editor: undefined, styles }
	const writer = new OdpShapeWriter(context, fragment, slide, () => undefined)
	const attempts: { readonly shape: ShapeNode; readonly bytes: Uint8Array }[] = []

	for (const shape of slide.shapes) {
		if (shape.synthetic === true || shape.lock !== undefined) continue
		if (shape.frame !== undefined && shape.frame.kind !== "unknown") continue

		if (!boxProves(fragment, shape)) {
			lock(shape, "a transform other than a turn")

			continue
		}

		const pieces = writer.element(shape, IDENTITY, { ...PROVED, text: shape.text !== undefined, pristine: shape }, true)

		if (isRefused(pieces)) {
			lock(shape, `refused ${pieces.detail ?? pieces.reason}`)

			continue
		}

		attempts.push({ shape, bytes: markupBytes({ kind: "markup", pieces }, fragment.document) })
	}

	if (attempts.length > 0) {
		const read = readBack(
			parts,
			fragment,
			styles,
			attempts.map(attempt => attempt.bytes),
			pages
		)
		const at = index.get(slide.ref) ?? -1
		const jumps =
			at < 0
				? undefined
				: {
						at,
						count: deck.slides.length,
						expected: (ref: SlideRef) => index.get(ref) ?? -1,
						read: (ref: SlideRef) => index.get(ref) ?? -1
					}

		attempts.forEach((attempt, index) => {
			const back = isRefused(read) ? undefined : read[index]
			// Only what the proof rewrote is compared: the style (fill, line, shadow) is not written by it, and what the
			// page's reading adds after the shapes (a picture's crop from its pixel size) is not read here.
			const { props: _wantProps, ...want } = attempt.shape
			const { props: _gotProps, ...got } = back ?? attempt.shape
			const differs =
				back === undefined
					? "unreadable"
					: slideDiffers(
							{ ...slide, shapes: [want] },
							{ ...slide, name: slide.name ?? "", shapes: [got] },
							slide.name ?? "",
							jumps
						)

			if (differs !== undefined) lock(attempt.shape, differs.replace(/^shape \d+ \([^)]*\) /u, ""))
		})
	}

	return { shapes, locked, movable, failures }

	function lock(shape: ShapeNode, detail: string): void {
		shape.lock = "proofFailed"
		locked.proofFailed = (locked.proofFailed ?? 0) + 1
		failures[detail] = (failures[detail] ?? 0) + 1

		if (isBoxWritable(shape, ref => source.fragmentOf(ref))) movable++
	}
}

// The content root's start tag (its namespace declarations), read once per reading's stream.
const rootOpens = new WeakMap<Uint8Array, Uint8Array>()

function rootOpen(content: Uint8Array): Uint8Array {
	let open = rootOpens.get(content)

	if (open === undefined) {
		const { document, root } = readContentPrologue(content)

		open = document.bytes.slice(document.start(root), document.isSelfClosing(root) ? document.start(root) : document.contentStart(root))
		rootOpens.set(content, open)
	}

	return open
}

// The written elements read by the reader, with the styles the writing made added to the content's automatic ones.
function readBack(
	parts: OdpWriteSource["parts"],
	fragment: Fragment,
	styles: OdpStyles,
	elements: readonly Uint8Array[],
	pages: ReadonlyMap<string, SlideRef>
): ShapeNode[] | ReturnType<typeof refused> {
	const added = styles.markup(elements.map(element => decodeUtf8(element, 0, element.length)))
	let sheet = parts.sheet

	// The new styles read over the reading's sheet: the content stream is never read again for a page.
	if (!styles.empty) {
		const marker = encodeUtf8(`<office:automatic-styles>${added}</office:automatic-styles>`)

		// A stream of the new styles alone: nothing before office:body to cut out, so it is read as it is.
		const document = parseXml(concat(rootOpen(parts.content.bytes), marker, encodeUtf8("<office:body/>"), parts.content.rootClose))

		sheet = parts.sheet.withAutomatic({
			document,
			namespaces: new Namespaces(document),
			root: document.documentElement(),
			bodyStart: -1,
			sliced: false
		})
	}

	// A context of its own: the reading never counts against the deck's tallies.
	const context = new OdpContext(sheet, parts.budgets, new DeckTally(parts.budgets), pages, {
		mediaType: part => parts.context.mediaType(part),
		has: part => parts.context.hasPart(part),
		templates: new Map()
	})

	const page = fragment.document.firstChildElement(fragment.document.documentElement())
	const head = fragment.document.bytes.subarray(
		fragment.document.start(fragment.document.documentElement()),
		fragment.document.start(page)
	)
	const pageOpen = fragment.document.bytes.subarray(
		fragment.document.start(page),
		fragment.document.isSelfClosing(page) ? fragment.document.start(page) : fragment.document.contentStart(page)
	)
	let document

	try {
		document = parseXml(
			concat(
				head,
				pageOpen.length === 0 ? encodeUtf8("<draw:page>") : pageOpen,
				...elements,
				encodeUtf8(`</${fragment.document.name(page)}>`),
				encodeUtf8(`</${fragment.document.name(fragment.document.documentElement())}>`)
			)
		)
	} catch {
		return refused("proofFailed", "written markup is not well formed")
	}

	const read = new Fragment(
		document,
		new Namespaces(document, { lenient: true }),
		fragment.part,
		fragment.offset,
		"content",
		fragment.epoch
	)
	const container = document.firstChildElement(document.documentElement())
	const nodes: number[] = []

	for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) nodes.push(child)

	let next = 1
	const masterName = fragment.attributes(page).get("draw:master-page-name") ?? parts.sheet.masterOrder[0]
	const scope: ShapeScope = {
		fragment: read,
		text: {},
		masterBoxes: new Map(),
		nextId: () => ++next,
		images: new Set(),
		charts: new Set(),
		clips: [],
		unread: 0,
		...(masterName === undefined ? {} : { masterName })
	}

	return nodes.map(node => readShapeElements(context, scope, [node])[0]).filter(shape => shape !== undefined)
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

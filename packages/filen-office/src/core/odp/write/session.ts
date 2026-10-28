import { OdfStyleResolver, OdfStyleSheet } from "../../odf/index"
import { nextShapeId } from "../../presentation/ids"
import type { DesignReading } from "../../presentation/edit/apply/design"
import type { SlideSourceReading } from "../../presentation/edit/apply/slide"
import type { ReferenceFacts } from "../../presentation/edit/integrity"
import { refused, type Deck, type Refused, type ShapeNode, type SlideNode, type SlideRef } from "../../presentation/model"
import { XmlError, decodeUtf8, encodeUtf8, parseXml } from "../../xml/index"
import { Fragment, type OdpContext } from "../read/context"
import { fillOf } from "../read/fills"
import { readShapeElements, readShapes, type ShapeScope } from "../read/shapes"
import { masterMoveRefusal } from "./emit/design"
import { isBoxWritable } from "./proof"
import type { OdpWriteSource } from "./source"

// What the edit session reads an ODP deck's source through, for the apply families (ApplyContext and the slide
// family's SlideSourceReading): source markup an inverse holds as bytes, a held shape or page read back as the ODP
// reader reads it (into fragments the source keeps under "raw:" names, which the writer copies from), new shape ids
// and refs. A page is one "part" of its own here (content.xml holds them all): `/content.xml#<ref>`, so a delete
// plans per page and a refused save reverts only the steps of the pages it names. A page's notes are a part of their
// own the same way. ODF has no relationships: the reference graph is empty (jumps are found in the model).

const PAGE_TYPE = "application/vnd.oasis.opendocument.presentation-page"
const NO_FACTS: ReferenceFacts = { references: () => undefined, parts: () => [] }

// The model part of a page or notes page of content.xml.
export function odpPagePart(ref: SlideRef): string {
	return `/content.xml#${String(ref)}`
}

export interface OdpSessionRefs {
	// A slide reference never used in the session.
	next(): SlideRef
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

// Master page names design ops gave out in a session (each deck's), so two unsaved gallery masters never share one.
const DESIGN_NAMES = new WeakMap<Deck, Set<string>>()

// A master page name for a gallery theme: "Filen<n>", with no style, master page or resource of styles.xml named by it
// or starting with it and a separator, and not given out before in the session.
function newMasterName(deck: Deck, styles: Uint8Array | undefined): string {
	let given = DESIGN_NAMES.get(deck)

	if (given === undefined) {
		given = new Set()
		DESIGN_NAMES.set(deck, given)
	}

	const used = new Set<number>()

	if (styles !== undefined)
		for (const match of decodeUtf8(styles, 0, styles.length).matchAll(/="Filen(\d+)(?:[_"-])/gu)) used.add(Number(match[1]))

	let n = 1

	while (used.has(n) || given.has(`Filen${String(n)}`)) n++

	const name = `Filen${String(n)}`

	given.add(name)

	return name
}

// A master page a design op made (a styles document of its own: themes/odp.ts odpGalleryMaster), read as the reader
// reads styles.xml's: against a style sheet of the document's own styles and the deck's default styles, its shapes
// referring into the held document.
function readDesignMaster(source: OdpWriteSource, bytes: Uint8Array, ref: SlideRef): SlideNode | Refused {
	const parts = source.parts
	let document

	try {
		document = parseXml(bytes)
	} catch (error) {
		if (error instanceof XmlError) return refused("malformed", "a generated master page")

		throw error
	}

	const sheet = new OdfStyleSheet(document, undefined)

	for (const [family, style] of parts.sheet.defaults) if (!sheet.defaults.has(family)) sheet.defaults.set(family, style)

	const context = Object.create(parts.context) as OdpContext

	Object.defineProperty(context, "sheet", { value: sheet })
	Object.defineProperty(context, "resolver", { value: new OdfStyleResolver(sheet) })
	Object.defineProperty(context, "owned", { value: new Map() })

	const name = sheet.masterOrder[0]
	const page = name === undefined ? undefined : sheet.masterPages.get(name)

	if (name === undefined || page === undefined) return refused("malformed", "a generated styles document without its master page")

	const fragment = source.hold(document, "styles")
	let next = 1
	const scope: ShapeScope = {
		fragment,
		text: {},
		masterBoxes: new Map(),
		nextId: () => ++next,
		images: new Set(),
		charts: new Set(),
		clips: [],
		unread: 0,
		masterName: name
	}
	const shapes = readShapes(context, scope, page.node)
	const background =
		page.drawStyle === undefined
			? undefined
			: fillOf(context.resolver.resolve("drawing-page", page.drawStyle, "styles").properties("drawing-page"), sheet.drawResources)

	return {
		ref,
		kind: "master",
		part: "/styles.xml",
		src: fragment.src(page.node),
		name: page.displayName ?? name,
		...(background === undefined || background === "none" ? {} : { background: { kind: "fill" as const, fill: background } }),
		showMasterShapes: true,
		hidden: false,
		shapes,
		comments: [],
		revision: 0
	}
}

export function odpSourceReading(deck: Deck, source: OdpWriteSource, refs: OdpSessionRefs): SlideSourceReading & DesignReading {
	const parts = source.parts
	const content = parts.content
	// A held fragment: markup an inverse held, parsed under the content root (so it reads with content.xml's scope).
	const hold = (markup: Uint8Array, wrap: boolean): Fragment | Refused => {
		let document

		try {
			document = parseXml(
				concat(
					content.rootOpen,
					wrap ? encodeUtf8('<draw:page xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0">') : new Uint8Array(0),
					markup,
					wrap ? encodeUtf8("</draw:page>") : new Uint8Array(0),
					content.rootClose
				)
			)
		} catch (error) {
			if (error instanceof XmlError) return refused("malformed", "held markup")

			throw error
		}

		return source.hold(document)
	}
	const shapesOf = (fragment: Fragment, container: number): ShapeNode[] => {
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

		for (let child = fragment.document.firstChildElement(container); child >= 0; child = fragment.document.nextSiblingElement(child))
			nodes.push(child)

		const shapes = readShapeElements(source.heldContext(), scope, nodes)

		return shapes
	}

	return {
		sourceBytes: src => source.sourceBytes(src),
		newShapeId: slide => nextShapeId(deck.nodes.get(slide)?.shapes ?? []),
		newSlideRef: () => refs.next(),
		movable: shape => isBoxWritable(shape, src => source.fragmentOf(src)),
		readShape(_slide, raw) {
			const fragment = hold(raw, true)

			if (fragment instanceof Fragment) {
				const page = fragment.document.firstChildElement(fragment.document.documentElement())
				const shape = shapesOf(fragment, page)[0]

				return shape === undefined ? refused("malformed", "held shape markup") : shape
			}

			return fragment
		},
		rawParts(slide) {
			const src = slide.src

			if (src === undefined) return []

			const bytes = source.pageMarkup(src) ?? source.sourceBytes(src)

			if (bytes instanceof Uint8Array) return [{ name: `/content.xml#${String(slide.ref)}`, contentType: PAGE_TYPE, bytes }]

			return bytes
		},
		readSlides(ref, held) {
			const part = held[0]

			if (part === undefined) return refused("malformed", "a restore without its page")

			const fragment = hold(part.bytes, false)

			if (!(fragment instanceof Fragment)) return fragment

			const document = fragment.document
			const page = document.firstChildElement(document.documentElement())
			const node: SlideNode = {
				ref,
				kind: "slide",
				part: odpPagePart(ref),
				src: fragment.src(page),
				showMasterShapes: true,
				hidden: false,
				shapes: shapesOf(fragment, page),
				comments: [],
				revision: 0
			}

			for (let child = document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
				if (fragment.name(child) !== "presentation:notes") continue

				const notesRef = refs.next()
				const notes: SlideNode = {
					ref: notesRef,
					kind: "notes",
					part: odpPagePart(notesRef),
					src: fragment.src(child),
					showMasterShapes: true,
					hidden: false,
					shapes: shapesOf(fragment, child),
					comments: [],
					revision: 0
				}

				node.notes = notes.ref

				return [node, notes]
			}

			return [node]
		},
		// A new page (an add or a duplicate) is a part of its own under a ref nothing else names.
		newPart: () => odpPagePart(refs.next()),
		facts: NO_FACTS,
		partOf: ref => deck.nodes.get(ref)?.part ?? (deck.slides.includes(ref) ? odpPagePart(ref) : undefined),
		// A gallery theme is a master page of styles.xml: only a master is held (ODP has no theme or layout parts; layouts
		// are synthesized per master and page layout).
		holdDesign(part, ref) {
			if (part.kind !== "slideMaster") return refused("unsupported", `an ODP deck's ${part.kind} part`)

			return readDesignMaster(source, part.bytes, ref ?? refs.next())
		},
		newDesignPart: kind => (kind === "slideMaster" ? newMasterName(deck, parts.stylesFragment?.document.bytes) : ""),
		stylesBytes: () => parts.stylesFragment?.document.bytes,
		masterMoveRefusal: deck => (parts.stylesFragment === undefined ? undefined : masterMoveRefusal(deck, parts.stylesFragment))
	}
}

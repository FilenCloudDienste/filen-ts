import { nextShapeId } from "../../presentation/ids"
import type { SlideSourceReading } from "../../presentation/edit/apply/slide"
import type { ReferenceFacts } from "../../presentation/edit/integrity"
import { refused, type Deck, type Refused, type ShapeNode, type SlideNode, type SlideRef } from "../../presentation/model"
import { XmlError, encodeUtf8, parseXml } from "../../xml/index"
import { Fragment } from "../read/context"
import { readShapeElements, type ShapeScope } from "../read/shapes"
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

export function odpSourceReading(deck: Deck, source: OdpWriteSource, refs: OdpSessionRefs): SlideSourceReading {
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

			const bytes = source.sourceBytes(src)

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
		partOf: ref => deck.nodes.get(ref)?.part ?? (deck.slides.includes(ref) ? odpPagePart(ref) : undefined)
	}
}

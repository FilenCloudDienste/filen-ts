import { appendAll } from "../../arrays"
import { canonicalName, readContentPrologue } from "../../odf/index"
import { emitFamilyOf } from "../../pptx/write/emit"
import type { PartChange } from "../../opc/index"
import type { DeckChanges } from "../../presentation/edit/apply"
import { digestOf } from "../../presentation/edit/changes"
import { markupBytes } from "../../presentation/edit/proof"
import { parseInScope } from "../../presentation/edit/canonical"
import {
	PresentationError,
	refused,
	type Deck,
	type Refused,
	type ShapeNode,
	type SlideNode,
	type SlideRef
} from "../../presentation/model"
import { inScope } from "../../anim/prune"
import {
	Namespaces,
	NodeKind,
	XmlEditor,
	decodeCharacterData,
	decodeUtf8,
	encodeUtf8,
	escapeAttribute,
	parseXml,
	type XmlDocument
} from "../../xml/index"
import type { Fragment } from "../read/context"
import type { OdpParts } from "../read/document"
import type { PageSpan } from "../read/scan"
import type { EmitPiece } from "../../pptx/write/types"
import { emitOdp, type OdpEmitContext } from "./emit"
import { copyObject, isChartObject } from "./emit/chart"
import { odpDesignStyles } from "./emit/design"
import { IDENTITY, OdpShapeWriter, hasAspects, type Aspects } from "./emit/shape"
import { newPage, pageAspects, pageChanges, startTag, timingPieces } from "./emit/slide"
import { odpTransitionPar, odpTransitionSound, pageIdOf, placeTransitionPar, transitionParOf, withTransitionPar } from "./emit/transition"
import { odpOwnParagraphSource, odpParagraphKey, odpParagraphTargets, odpTargetIds, odpTimingRoot } from "../../anim/odf"
import { newSettingsMarkup, pageNames, renameIds, settingsMarkup } from "./integrity"
import { settingsAttributes, type SettingsAttribute } from "./emit/presentation"
import { OdpWriteSource, odpWriteSource } from "./source"
import { notesDiffer, slideDiffers } from "./meaning"
import { spliceOdpNotes } from "./emit/notes"
import { spliceOdpComments } from "./emit/comment"
import {
	MASTER_PAGE_NAME_SUFFIX,
	OdpStyles,
	STYLE_NAME_SUFFIX,
	attributeValues,
	declared,
	styleDeclarations,
	takenInStreams,
	type OdpWriteEnv
} from "./styles"
import { isRefused } from "../../presentation/refusal"
import { sameBytes } from "../../docx/write/bytes"

// The splice of an ODP save (§1.5.4): content.xml is written as the pages of the deck in order, each untouched page
// copied as its byte span of the source (no parse), each touched page parsed as its fragment and spliced element by
// element (only the shapes that differ from the source's reading of the same page are written, the rest copied by
// span), a page an op made written whole. New automatic styles go at the end of office:automatic-styles; custom shows
// and the show's start page follow the pages' names; a duplicated page gets a free name and fresh IDs. styles.xml,
// the manifest and every other entry are copied. Which shapes differ is measured, not trusted from the history's
// dirt: each touched page is compared with a pristine reading of its source (source.ts).

export interface OdpSaveSource {
	readonly parts: OdpParts
}

export interface OdpSaveInput {
	readonly deck: Deck
	readonly source: OdpSaveSource
	readonly changes: DeckChanges
	readonly revision: number
	// Entries this session's saves added that nothing reaches any more: left out, with their manifest entries.
	readonly prune?: readonly string[]
	// Entries a step the history holds names (a deleted picture an undo puts back): one a save leaves out is held for it.
	readonly keep?: readonly string[]
	// The entries this session's saves wrote (judged by the prune, not as the source's media).
	readonly own?: readonly string[]
}

// One page of the written content.xml: copied from the source (its span), or written (and read back by gate 2).
export type WrittenPage =
	| { readonly kind: "copied"; readonly ref: SlideRef; readonly span: PageSpan }
	| { readonly kind: "written"; readonly ref: SlideRef; readonly bytes: Uint8Array; readonly name: string; readonly source?: PageSpan }

export interface OdpSplice {
	readonly revision: number
	readonly content: Uint8Array | undefined
	readonly pages: readonly WrittenPage[]
	readonly names: ReadonlyMap<SlideRef, string>
	// Entries replaced and added (content.xml, and the manifest when an entry is added).
	readonly replace: readonly PartChange[]
	readonly add: readonly PartChange[]
}

// The element naming an embedded object (ODF 1.3 Part 3 §10.4.6.2) and its link (canonical names).
const DRAW_OBJECT = "draw:object"
const XLINK_HREF = "xlink:href"

// Presentation-level changes the ODP writer writes (the slide list, the custom shows and the show settings); the rest
// belong to the families that edit them.
const WRITTEN_PRESENTATION: ReadonlySet<string> = new Set(["slideList", "customShows", "sections", "show", "size"])

function concat(chunks: readonly Uint8Array[]): Uint8Array {
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

function walk(shapes: readonly ShapeNode[], visit: (shape: ShapeNode) => void): void {
	for (const shape of shapes) {
		visit(shape)
		if (shape.children !== undefined) walk(shape.children, visit)
	}
}

// A body with its fields' ids left out (each reading numbers them anew).
function fieldless(body: ShapeNode["text"]): unknown {
	if (body === undefined) return undefined

	return {
		...body,
		paragraphs: body.paragraphs.map(paragraph => ({
			...paragraph,
			runs: paragraph.runs.map(run => (run.kind === "fld" ? { ...run, id: "" } : run))
		}))
	}
}

// A shape's identity in the source: the element its ref names in its fragment (a page of content.xml, or markup an
// undo held), never the node index alone (a held fragment numbers its nodes from 1 too).
function sourceKey(shape: ShapeNode): string | undefined {
	const src = shape.src

	return src?.format === "odp" ? `${src.part}\u0000${String(src.fragment)}\u0000${String(src.epoch)}\u0000${String(src.node)}` : undefined
}

// What of each shape differs from the pristine reading of its page (matched by source element).
export function shapeAspects(target: readonly ShapeNode[], pristine: readonly ShapeNode[]): Map<ShapeNode, Aspects> {
	const before = new Map<string, ShapeNode>()
	const out = new Map<ShapeNode, Aspects>()
	const same = (a: unknown, b: unknown): boolean => digestOf(a) === digestOf(b)

	walk(pristine, shape => {
		const key = sourceKey(shape)

		if (key !== undefined) before.set(key, shape)
	})

	walk(target, shape => {
		const key = sourceKey(shape)
		const was = key === undefined ? undefined : before.get(key)

		if (was === undefined) return

		const aspects: Aspects = {
			pristine: was,
			...(same(shape.xfrm, was.xfrm) ? {} : { xfrm: true }),
			...(same(shape.props?.fill, was.props?.fill) ? {} : { fill: true }),
			...(same(shape.props?.ln, was.props?.ln) ? {} : { ln: true }),
			...(same(shape.props?.effects, was.props?.effects) ? {} : { effects: true }),
			...(same(shape.props?.bodyPr, was.props?.bodyPr) ? {} : { bodyPr: true }),
			...(same(outline(shape), outline(was)) ? {} : { geometry: true }),
			...(same(fieldless(shape.text), fieldless(was.text)) ? {} : { text: true }),
			...(same(shape.alt, was.alt) ? {} : { alt: true }),
			...(shape.name === was.name ? {} : { name: true }),
			...(shape.hidden === was.hidden ? {} : { hidden: true }),
			...(same(shape.actions, was.actions) ? {} : { actions: true }),
			...((shape.frame?.kind === "table" || shape.frame?.kind === "chart") && !same(shape.frame, was.frame) ? { frame: true } : {})
		}

		out.set(shape, aspects)
	})

	return out
}

// A shape's outline: none given is a rectangle (a frame, a session's notes body), as the reader reads one back.
function outline(shape: ShapeNode): unknown {
	return shape.props?.geometry ?? (shape.kind === "sp" ? { kind: "preset", preset: "rect", guides: [] } : undefined)
}

function placeholderKind(ph: ShapeNode["ph"]): unknown {
	return ph === undefined ? undefined : { type: ph.type, idx: ph.idx }
}

// Content a shape's family alone writes (a chart, media): differs → refused until that family is built, never
// dropped. A table's cells are written by the table family (the frame aspect).
function familyContent(target: readonly ShapeNode[], pristine: readonly ShapeNode[]): Refused | undefined {
	const before = new Map<string, ShapeNode>()

	walk(pristine, shape => {
		const key = sourceKey(shape)

		if (key !== undefined) before.set(key, shape)
	})

	let found: Refused | undefined

	walk(target, shape => {
		if (found !== undefined) return

		const key = sourceKey(shape)
		const was = key === undefined ? undefined : before.get(key)

		if (was === undefined) return
		if (shape.kind !== was.kind) found = refused("unsupported", "a shape of another kind")
		else if (
			(shape.frame?.kind !== "table" && shape.frame?.kind !== "chart" && digestOf(shape.frame) !== digestOf(was.frame)) ||
			digestOf(shape.media) !== digestOf(was.media)
		)
			found = refused("notImplemented", `odp emit ${shape.frame?.kind ?? "media"}`)
		// What a placeholder is (ODF holds its kind; idxWritten is how a pptx writes its idx).
		else if (digestOf(placeholderKind(shape.ph)) !== digestOf(placeholderKind(was.ph)))
			found = refused("unsupported", "a placeholder of another kind")
	})

	return found
}

const TRAILING: ReadonlySet<string> = new Set(["presentation:animations", "presentation:notes"])

// Whether two readings of a shape hold the same paragraphs, text for text, in order.
function sameParagraphs(shape: ShapeNode, other: ShapeNode | undefined): boolean {
	const a = shape.text?.paragraphs ?? []
	const b = other?.text?.paragraphs

	const plain = (paragraph: (typeof a)[number]) => paragraph.runs.map(run => (run.kind === "r" ? run.text : run.kind)).join("")

	return b !== undefined && a.length === b.length && a.every((paragraph, at) => plain(paragraph) === plain(b[at] as (typeof a)[number]))
}

// The `index`-th paragraph element (text:p, text:h) of a shape whose element is on `fragment`, in document order; -1
// when the shape is not there or has fewer.
function paragraphElement(fragment: Fragment, shape: ShapeNode, index: number): number {
	const src = shape.src

	if (src?.format !== "odp" || src.fragment !== fragment.offset || src.epoch !== fragment.epoch) return -1

	const document = fragment.document
	const stack = [src.node]
	let seen = 0

	// Depth first in document order (children pushed last first).
	while (stack.length > 0) {
		const node = stack.pop() as number
		const name = fragment.name(node)

		if (node !== src.node && (name === "text:p" || name === "text:h")) {
			if (seen === index) return node

			seen++
			continue
		}

		const children: number[] = []

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) children.push(child)
		for (let k = children.length - 1; k >= 0; k--) stack.push(children[k] as number)
	}

	return -1
}

// The parts of content.xml around its pages: where office:automatic-styles takes new styles, and the settings.
interface ContentLayout {
	readonly stylesAt: number
	// Markup that opens and closes the automatic styles when the stream has none or an empty element.
	readonly stylesOpen: string
	readonly stylesClose: string
	readonly stylesEnd: number
	readonly declarations: string
}

function contentLayout(bytes: Uint8Array): ContentLayout | Refused {
	const prologue = readContentPrologue(bytes)

	if (!prologue.sliced) return refused("unsupported", "a content stream that is not UTF-8")

	const document = prologue.document
	const root = prologue.root

	for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
		if (
			prologue.namespaces.elementUri(node) !== "urn:oasis:names:tc:opendocument:xmlns:office:1.0" ||
			document.localName(node) !== "automatic-styles"
		)
			continue

		if (document.isSelfClosing(node)) {
			const name = document.name(node)

			return {
				stylesAt: document.start(node),
				stylesEnd: document.end(node),
				stylesOpen: `<${name}>`,
				stylesClose: `</${name}>`,
				declarations: ""
			}
		}

		return {
			stylesAt: document.contentEnd(node),
			stylesEnd: document.contentEnd(node),
			stylesOpen: "",
			stylesClose: "",
			declarations: ""
		}
	}

	const office = prologue.namespaces.prefixFor(root, "urn:oasis:names:tc:opendocument:xmlns:office:1.0")
	const name = office === undefined || office === "" ? "office:automatic-styles" : `${office}:automatic-styles`
	const declarations = office === undefined ? ' xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' : ""

	return {
		stylesAt: prologue.bodyStart,
		stylesEnd: prologue.bodyStart,
		stylesOpen: `<${name}${declarations}>`,
		stylesClose: `</${name}>`,
		declarations
	}
}

// The presentation:settings element after the last page (its byte range in content.xml), found by its name.
function settingsRange(bytes: Uint8Array, from: number, prefix: string): { readonly start: number; readonly end: number } | undefined {
	const needle = encodeUtf8(`<${prefix}:settings`)
	let at = -1

	for (let k = bytes.indexOf(0x3c, from); k >= 0; k = bytes.indexOf(0x3c, k + 1)) {
		let match = true

		for (let j = 0; j < needle.length && match; j++) if (bytes[k + j] !== needle[j]) match = false

		const next = bytes[k + needle.length]

		if (match && (next === 0x20 || next === 0x3e || next === 0x2f || next === 0x0a || next === 0x0d || next === 0x09)) {
			at = k

			break
		}
	}

	if (at < 0) return undefined

	const closing = encodeUtf8(`</${prefix}:settings>`)
	let quote = 0
	let tagEnd = -1

	for (let k = at + 1; k < bytes.length; k++) {
		const byte = bytes[k]

		if (quote !== 0) {
			if (byte === quote) quote = 0
		} else if (byte === 0x22 || byte === 0x27) quote = byte as number
		else if (byte === 0x3e) {
			tagEnd = k

			break
		}
	}

	if (tagEnd < 0) return undefined
	if (bytes[tagEnd - 1] === 0x2f) return { start: at, end: tagEnd + 1 }

	for (let k = bytes.indexOf(0x3c, tagEnd); k >= 0; k = bytes.indexOf(0x3c, k + 1)) {
		let match = true

		for (let j = 0; j < closing.length && match; j++) if (bytes[k + j] !== closing[j]) match = false

		if (match) return { start: at, end: k + closing.length }
	}

	return undefined
}

function isWhitespace(bytes: Uint8Array): boolean {
	for (const byte of bytes) if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false

	return true
}

// IDs every page of the content holds, by a byte scan of `…:id="` attributes (an over-count is harmless).
function contentIds(bytes: Uint8Array): Set<string> {
	const out = new Set<string>()
	const text = decodeUtf8(bytes, 0, bytes.length)

	for (const match of text.matchAll(/:id="([^"]*)"/gu)) out.add(match[1] ?? "")

	return out
}

class Splicer {
	readonly deck: Deck
	readonly parts: OdpParts
	readonly source: OdpWriteSource
	readonly styles: OdpStyles
	readonly context: OdpEmitContext
	readonly names: Map<SlideRef, string>
	// The namespaces content.xml's root binds (new pages and styles declare what it does not).
	readonly scope: ReadonlyMap<string, string>
	// Generated markup (the styles it names are the ones kept).
	readonly written: string[] = []
	private readonly fragments = new WeakMap<XmlDocument, Fragment>()
	private ids: Set<string> | undefined
	// Ids this save gave the elements of a source page fragment, by fragment and target: a page duplicated in the same
	// save takes the same ones before its copy is renamed, as it would after a rebase (so a state writes the same ids).
	private readonly givenIds = new Map<string, string>()
	// The ids the page being written gives source elements (an animated shape's, a targeted paragraph's), by node of its
	// fragment's document: a source span copied into rewritten markup carries them (bytes()).
	private given: { readonly document: XmlDocument; readonly ids: Map<number, readonly (readonly [string, string])[]> } | undefined

	constructor(deck: Deck, parts: OdpParts, source: OdpWriteSource, names: Map<SlideRef, string>) {
		this.deck = deck
		this.parts = parts
		this.source = source
		this.names = names

		const env: OdpWriteEnv = {
			context: parts.context,
			stylesFragment: parts.stylesFragment,
			fragmentOf: document => this.fragments.get(document),
			sourceFragment: src => this.source.fragmentOf(src),
			pageName: ref => names.get(ref),
			placeholderBoxes: source.placeholderBoxes,
			mirrorValues: source.mirrorValues,
			dispatch: emitOdp,
			familyOf: emitFamilyOf
		}
		const taken = takenInStreams(parts)

		// A retired style's name stays taken: held markup may name it again.
		for (const name of source.retired.keys()) taken.add(name)

		const prologue = readContentPrologue(parts.content.bytes)

		this.scope = prologue.namespaces.inScope(prologue.root)
		this.styles = new OdpStyles(env, "content", taken, styleDeclarations(this.scope))
		// The styles a save retired first (what an undo returns to had them; a source may hold equal copies, as Google's
		// export does), then the stream's own: a style written again in the form one of them has takes its name, so a state
		// saved again (an undo back to it) writes the same bytes.
		const own = new Map<string, string>(source.retired)

		if (prologue.sliced) {
			const document = prologue.document

			for (let section = document.firstChildElement(prologue.root); section >= 0; section = document.nextSiblingElement(section)) {
				if (document.localName(section) !== "automatic-styles") continue

				for (let style = document.firstChildElement(section); style >= 0; style = document.nextSiblingElement(style)) {
					const name = document.attributes(style).find(attribute => attribute.name === "style:name")?.value
					const raw = document.raw(style)

					if (name !== undefined && document.localName(style) === "style" && !own.has(name))
						own.set(name, decodeUtf8(raw, 0, raw.length))
				}
			}
		}

		this.styles.reuseRetired(own)
		this.context = { deck, document: undefined, editor: undefined, styles: this.styles }
	}

	fragment(span: PageSpan): Fragment {
		const fragment = this.source.fragment(span)

		this.fragments.set(fragment.document, fragment)

		return fragment
	}

	// The bytes of pieces, holes copied from `document`, generated strings kept for the style collection.
	// A shape's markup where it goes: the prefixes it writes that the scope there does not bind declared on its start tag
	// (a page whose document binds no xlink, a picture written into it).
	private shapeBytes(
		pieces: readonly EmitPiece[],
		fragment: { readonly document: XmlDocument; readonly namespaces: Namespaces },
		at: number
	): Uint8Array {
		const bytes = this.bytes(pieces, fragment.document)

		return encodeUtf8(declared(decodeUtf8(bytes, 0, bytes.length), fragment.namespaces.inScope(at)))
	}

	bytes(pieces: readonly EmitPiece[], document: XmlDocument | undefined): Uint8Array {
		for (const piece of pieces) if (typeof piece === "string") this.written.push(piece)

		const given = this.given
		const out =
			given === undefined || given.document !== document
				? pieces
				: pieces.map(piece =>
						typeof piece === "object" && "hole" in piece ? withGivenIds(given.document, piece.hole, given.ids) : piece
					)

		return markupBytes({ kind: "markup", pieces: out }, document)
	}

	// A page written from its source: its start tag patched, its shapes and notes spliced against the pristine reading
	// of the same markup. `span`: the source page it was read from (a page held by an undo has none).
	async page(
		node: SlideNode,
		fragment: Fragment,
		pristine: { readonly slide: SlideNode; readonly notes: SlideNode | undefined },
		duplicate: boolean,
		span: PageSpan | undefined
	): Promise<Uint8Array | undefined | Refused> {
		this.fragments.set(fragment.document, fragment)

		const document = fragment.document
		const page = document.firstChildElement(document.documentElement())

		const name = this.names.get(node.ref) ?? node.name ?? ""
		const targetIds = this.targetIds(fragment, node)
		// Only a page whose timing is written names paragraphs anew.
		const paragraphIds =
			pageAspects(node, pristine.slide, name).timing === true ? this.paragraphIds(fragment, node, pristine.slide) : new Map()

		if (isRefused(paragraphIds)) return paragraphIds

		const context: OdpEmitContext = {
			...this.context,
			document,
			...(targetIds.size === 0 ? {} : { targetIds }),
			...(paragraphIds.size === 0 ? {} : { paragraphIds: new Map([...paragraphIds].map(([key, given]) => [key, given.name])) })
		}
		const aspects = pageAspects(node, pristine.slide, name)
		const attributes = pageChanges(this.deck, node, aspects, fragment.attributes(page), context)

		if (isRefused(attributes)) return attributes

		// The ids this save gives source elements, set on them below, and carried by any copy of them a rewrite makes.
		const given = new Map<number, (readonly [string, string])[]>()

		if (aspects.timing === true) {
			for (const [id, name] of targetIds) {
				const src = findTarget(node.shapes, id)?.src

				if (src?.format === "odp" && src.fragment === fragment.offset)
					given.set(src.node, [
						["xml:id", name],
						["draw:id", name]
					])
			}

			for (const entry of paragraphIds.values()) if (entry.node >= 0) given.set(entry.node, [["xml:id", entry.name]])
		}

		this.given = given.size === 0 ? undefined : { document, ids: given }

		const editor = new XmlEditor(document)
		const slideEdits = this.container(editor, fragment, page, node, node.shapes, pristine.slide.shapes, context)

		if (isRefused(slideEdits)) return slideEdits

		// The transition par begins by the page's id; a page without one is given one.
		let par: string | undefined

		if (aspects.transition === true && odpTransitionPar(node.transition, "") !== undefined) {
			let id = pageIdOf(fragment.attributes(page))

			if (id === undefined) {
				id = this.freshId()
				attributes.set("xml:id", id)
				attributes.set("draw:id", id)
			}

			const sound = odpTransitionSound(node.transition, context)

			if (isRefused(sound)) return sound

			par = odpTransitionPar(node.transition, id, sound)
		}

		// An element still in place takes its ids here; one a rewrite covers has them in the new markup already (its copy
		// through bytes(), a shape's rewritten tag in emit/shape.ts, a paragraph the text family wrote). A paragraph target is
		// the text:p's own xml:id, as LibreOffice writes it.
		for (const [at, ids] of given)
			if (!editor.covered(at)) for (const [attribute, value] of ids) editor.setAttribute(at, attribute, value)

		this.given = undefined

		const placed =
			aspects.timing === true ? this.timing(editor, fragment, page, node, context, aspects.transition === true, par) : false

		if (isRefused(placed)) return placed
		if (aspects.transition === true && !placed) placeTransitionPar(editor, fragment, page, par)

		const notesNode = node.notes === undefined ? undefined : this.deck.nodes.get(node.notes)

		if (notesNode?.src?.format === "odp" && pristine.notes !== undefined) {
			// The page's timing names its own shapes: the notes' shapes number apart and take none of its ids.
			const { targetIds: _targetIds, paragraphIds: _paragraphIds, ...notesContext } = context
			const notesEdits = this.container(
				editor,
				fragment,
				notesNode.src.node,
				notesNode,
				notesNode.shapes,
				pristine.notes.shapes,
				notesContext
			)

			if (isRefused(notesEdits)) return notesEdits
		} else if (notesNode !== undefined || pristine.notes !== undefined) {
			// Notes the session made (or an undo took back after the save that wrote them): the page's presentation:notes.
			const made = spliceOdpNotes(
				node,
				notesNode,
				pristine.notes,
				this.deck.slides.indexOf(node.ref) + 1,
				fragment,
				page,
				editor,
				context
			)

			if (made !== undefined) return made
		}

		spliceOdpComments(this.deck, node, fragment, page, editor)

		if (attributes.size === 0 && !editor.changed && !duplicate) return undefined

		const out = editor.changed ? editor.serialize() : document.bytes
		const head = startTag(fragment, page, attributes, document.isSelfClosing(page))
		// The page's content as edited: everything between its start and end tags (edits stay inside the page).
		const tailLength = document.bytes.length - document.contentEnd(page)
		const contentStart = document.contentStart(page)
		const content = document.isSelfClosing(page) ? new Uint8Array(0) : out.subarray(contentStart, out.length - tailLength)
		const close = document.isSelfClosing(page) ? "" : `</${document.name(page)}>`

		this.written.push(head)

		let bytes = concat([encodeUtf8(head), content, encodeUtf8(close)])

		// A page written back as the bytes it was (a model the file reads in another form: a relative jump the file
		// names by page) is copied.
		if (!duplicate && span !== undefined && sameBytes(bytes, this.parts.content.bytes.subarray(span.start, span.end))) return undefined

		if (duplicate && span !== undefined) {
			const renamed = this.renamed(bytes, span, node.ref)

			if (isRefused(renamed)) return renamed

			bytes = renamed
		}

		return bytes
	}

	// Every shape the page's timing targets that has no id of its own gets one unique in the document.
	private targetIds(fragment: Fragment, node: SlideNode): Map<number, string> {
		const out = new Map<number, string>()

		this.ids ??= contentIds(this.parts.content.bytes)

		for (const id of odpTargetIds(node.timing)) {
			const shape = findTarget(node.shapes, id)

			if (shape === undefined) continue

			if (shape.src?.format === "odp" && shape.src.fragment === fragment.offset) {
				const a = fragment.attributes(shape.src.node)

				if (a.has("xml:id") || a.has("draw:id")) continue
			}

			const key = `${String(fragment.offset)}:${String(fragment.epoch)}:${String(id)}`
			let name = this.givenIds.get(key)

			if (name === undefined) {
				name = `id${String(id)}`

				for (let n = 2; this.ids.has(name); n++) name = `id${String(id)}_${String(n)}`

				this.ids.add(name)
				this.givenIds.set(key, name)
			}

			out.set(id, name)
		}

		return out
	}

	// Every text:p the page's timing targets on its own that has no id gets one unique in the document: a source
	// paragraph on its element (node), a paragraph the save writes new (of a shape inserted or a body edited since) by
	// the text family as it writes it (node -1). A paragraph the shape does not have refuses.
	private paragraphIds(
		fragment: Fragment,
		node: SlideNode,
		pristine: SlideNode
	): Map<string, { readonly node: number; readonly name: string }> | Refused {
		const out = new Map<string, { readonly node: number; readonly name: string }>()

		for (const { shape: id, paragraph } of odpParagraphTargets(node.timing)) {
			const shape = findTarget(node.shapes, id)

			if (shape === undefined || (shape.src !== undefined && shape.src.format !== "odp")) continue

			const own = shape.text?.paragraphs[paragraph]

			if (own === undefined) return refused("malformed", `a paragraph target past the text of shape ${String(id)}`)

			// A shape written from markup an undo held: a paragraph of that markup is named by its own id there, any other
			// is given one (its body is written anew, with the ids given here).
			if (shape.src?.format === "odp" && shape.src.fragment !== fragment.offset) {
				const held = this.source.fragmentOf(shape.src)

				if (held === undefined) continue

				const from = odpOwnParagraphSource(shape, paragraph)
				const inHeld =
					from?.format === "odp" && from.part === held.part && from.fragment === held.offset && from.epoch === held.epoch
				const a = inHeld ? held.attributes(from.node) : undefined

				out.set(odpParagraphKey(id, paragraph), {
					node: -1,
					name: a?.get("xml:id") ?? a?.get("text:id") ?? this.paragraphName(fragment, id, paragraph)
				})

				continue
			}

			const src = odpOwnParagraphSource(shape, paragraph)
			const sourced = src?.format === "odp" && src.fragment === fragment.offset && src.epoch === fragment.epoch
			// The paragraph's element on this page: its source's, else (a paragraph an undo put back, its ref from an earlier
			// file) the shape's paragraph element at its place, where the page holds the same paragraphs in order.
			const element = sourced
				? src.node
				: sameParagraphs(shape, findTarget(pristine.shapes, id))
					? paragraphElement(fragment, shape, paragraph)
					: -1

			if (element >= 0) {
				const a = fragment.attributes(element)
				const existing = a.get("xml:id") ?? a.get("text:id")

				if (existing !== undefined) {
					// Named already: the timing names it so (its ref cannot say which element it is).
					if (!sourced) out.set(odpParagraphKey(id, paragraph), { node: -1, name: existing })

					continue
				}
			}

			out.set(odpParagraphKey(id, paragraph), { node: element, name: this.paragraphName(fragment, id, paragraph) })
		}

		return out
	}

	// The id a save gives paragraph `paragraph` of shape `id` on a page (the same for the page however often it asks),
	// unique in the content.
	private paragraphName(fragment: Fragment, id: number, paragraph: number): string {
		const ids = (this.ids ??= contentIds(this.parts.content.bytes))
		const key = `${String(fragment.offset)}:${String(fragment.epoch)}:${String(id)}p${String(paragraph)}`
		let name = this.givenIds.get(key)

		if (name === undefined) {
			name = `id${String(id)}p${String(paragraph)}`

			for (let n = 2; ids.has(name); n++) name = `id${String(id)}p${String(paragraph)}_${String(n)}`

			ids.add(name)
			this.givenIds.set(key, name)
		}

		return name
	}

	// An id no element of the content holds: `base` when it is free, else `base` with a number.
	newId(base?: string): string {
		if (base === undefined) return this.freshId()

		const ids = (this.ids ??= contentIds(this.parts.content.bytes))
		let name = base

		for (let n = 2; ids.has(name); n++) name = `${base}_${String(n)}`

		ids.add(name)

		return name
	}

	private freshId(): string {
		const ids = (this.ids ??= contentIds(this.parts.content.bytes))

		for (let n = ids.size + 1; ; n++) {
			const id = `id${String(n)}`

			if (!ids.has(id)) {
				ids.add(id)

				return id
			}
		}
	}

	// The page's timing root replaced by the timing family's element (removed when the slide lost its timing), or
	// inserted after the shapes and before presentation:notes when the source has none. With `transition`, the root
	// carries the page's transition par as it now is: true when it was placed so, false when the root stayed its
	// source span (the par is placed in the source then).
	private timing(
		editor: XmlEditor,
		fragment: Fragment,
		page: number,
		node: SlideNode,
		context: OdpEmitContext,
		transition = false,
		par: string | undefined = undefined
	): boolean | Refused {
		const own = timingPieces(node, context)

		if (isRefused(own)) return own

		const sourcePar = transition ? -1 : transitionParOf(fragment, odpTimingRoot(fragment, page))
		const holdsPar = own.some(piece => typeof piece === "object" && !(piece instanceof Uint8Array) && piece.hole === sourcePar)
		// The page's own par (its transition unchanged) stays first in a root written anew from the model (an undo's).
		const withPar = transition
			? withTransitionPar(own, fragment, page, par)
			: sourcePar >= 0 && own.length > 0 && !holdsPar
				? (withTransitionPar(own, fragment, page, this.markupOf(fragment, sourcePar)) ?? own)
				: own

		if (withPar === undefined) return false

		const kept = transition || withPar.length > 0 ? -1 : transitionParOf(fragment, odpTimingRoot(fragment, page))
		// A page that lost its animations keeps its transition par in a root of its own.
		const pieces: readonly EmitPiece[] =
			kept < 0 ? withPar : ['<anim:par presentation:node-type="timing-root">', { hole: kept }, "</anim:par>"]

		const document = fragment.document
		// Sources that bind anim: only on each page's own timing root (Google's export) need it declared on the new one.
		const bytes = this.shapeBytes(pieces, fragment, page)
		const root = odpTimingRoot(fragment, page)

		if (root >= 0) {
			if (bytes.length === 0) editor.remove(root)
			else editor.replace(root, bytes)

			return true
		}

		if (bytes.length === 0) return true

		for (let child = document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
			if (fragment.name(child) === "presentation:notes") {
				editor.insertBefore(child, bytes)

				return true
			}
		}

		editor.append(page, bytes)

		return true
	}

	// An element of a page's source as it is written there.
	private markupOf(fragment: Fragment, node: number): string {
		const document = fragment.document

		return decodeUtf8(document.bytes, document.start(node), document.end(node))
	}

	// A copied page's xml:id and draw:id values made unique in the document, and each chart object its frames name from
	// the package copied to one of the page's own (emit/chart.ts copyObject): two pages never share a chart the session
	// may edit (other objects are kept as the file has them, shared: nothing edits them).
	private renamed(bytes: Uint8Array, span: PageSpan, ref: SlideRef): Uint8Array | Refused {
		const content = this.parts.content

		this.ids ??= contentIds(content.bytes)

		const document = parseXml(
			concat([content.rootOpen, span.inject === undefined ? bytes : withInjection(bytes, span.inject), content.rootClose])
		)
		const namespaces = new Namespaces(document, { lenient: true })
		const canonical = (node: number, name: string): string => {
			const colon = name.indexOf(":")

			return colon < 0 || name.startsWith("xml:")
				? name
				: canonicalName(namespaces.uri(node, name.slice(0, colon)), name.slice(colon + 1))
		}
		const page = document.firstChildElement(document.documentElement())
		const elementName = (node: number): string => canonicalName(namespaces.elementUri(node), document.localName(node))
		let editor = renameIds(document, page, this.ids, canonical, elementName)
		const objects: number[] = []
		const stack = [page]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			if (elementName(node) === DRAW_OBJECT) objects.push(node)

			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) stack.push(child)
		}

		const rewritten = new Set(this.styles.replaced().map(entry => entry.path))

		for (const object of objects) {
			const attribute = document.attributes(object).find(each => canonical(object, each.name) === XLINK_HREF)
			const path = attribute?.value.replace(/^\.\//u, "").replace(/\/$/u, "")

			// An object this save wrote a chart version into (the chart family's: its frame's own) stays the frame's.
			if (attribute === undefined || path === undefined || !isChartObject(this.parts, path) || rewritten.has(`${path}/content.xml`))
				continue

			const copy = copyObject(this.context, this.parts, path, `${String(ref)} ${path}`)

			if (isRefused(copy)) return copy

			editor ??= new XmlEditor(document)
			editor.setAttribute(object, attribute.name, `./${copy}`)
		}

		if (editor === undefined) return bytes

		const out = editor.serialize()
		const start = document.start(page)
		const end = out.length - (document.bytes.length - document.end(page))
		const edited = out.subarray(start, end)

		return span.inject === undefined ? edited.slice() : withoutInjection(edited, span.inject)
	}

	// The shapes held markup (other than the page's own fragment) reads as, for each held fragment `target` names.
	private heldPristine(target: readonly ShapeNode[], page: Fragment): ShapeNode[] {
		const out: ShapeNode[] = []
		const seen = new Set<string>()

		walk(target, shape => {
			const src = shape.src

			if (src?.format !== "odp" || src.part === page.part || !src.part.startsWith("raw:") || seen.has(src.part)) return

			seen.add(src.part)

			const held = this.source.fragmentOf(src)

			if (held !== undefined) out.push(...this.source.readHeld(held).slide.shapes)
		})

		return out
	}

	// The shapes of one container (a page or its notes) spliced into `editor`.
	private container(
		editor: XmlEditor,
		fragment: Fragment,
		container: number,
		node: SlideNode,
		target: readonly ShapeNode[],
		pristine: readonly ShapeNode[],
		context: OdpEmitContext
	): Refused | undefined {
		// Shapes an undo put back from held markup compare with what that markup reads as.
		const compared = [...pristine, ...this.heldPristine(target, fragment)]
		const familyRefusal = familyContent(target, compared)

		if (familyRefusal !== undefined) return familyRefusal

		const aspects = shapeAspects(target, compared)
		const writer = new OdpShapeWriter(context, fragment, node, shape => aspects.get(shape))
		const document = fragment.document
		const sourceOuter = pristine
			.filter(
				shape =>
					shape.synthetic !== true &&
					shape.src?.format === "odp" &&
					shape.src.part === fragment.part &&
					shape.src.fragment === fragment.offset
			)
			.map(shape => writer.outerNode((shape.src as { node: number }).node))
		const targetShapes = target.filter(shape => shape.synthetic !== true)
		const targetOuter = targetShapes.map(shape => {
			const at = writer.sourceNode(shape)

			return at === undefined ? undefined : writer.outerNode(at)
		})
		const inPlace = targetOuter.length === sourceOuter.length && targetOuter.every((at, k) => at === sourceOuter[k])

		if (inPlace) {
			for (let k = 0; k < targetShapes.length; k++) {
				const shape = targetShapes[k] as ShapeNode
				const outer = targetOuter[k] as number

				if (!hasAspects(aspects.get(shape)) && (shape.kind !== "grpSp" || !groupChanged(shape, aspects, fragment))) continue

				const pieces = writer.element(shape, IDENTITY)

				if (isRefused(pieces)) return pieces
				if (
					pieces.length === 1 &&
					typeof pieces[0] === "object" &&
					"hole" in (pieces[0] as object) &&
					(pieces[0] as { hole: number }).hole === outer
				)
					continue

				editor.replace(outer, this.shapeBytes(pieces, fragment, outer))
			}

			return undefined
		}

		// The shapes reordered, added or taken out: the source's shapes go, each with the whitespace before it, and the
		// deck's are written where the first was, the k-th after the whitespace the k-th source shape had (past them,
		// the last one's): a pretty-printed page keeps its layout, and writing the same shapes again gives the same bytes.
		const ordered = [...sourceOuter].sort((a, b) => a - b)
		const leads = leadingSpaces(document, ordered)
		const markup: Uint8Array[] = []

		for (let k = 0; k < targetShapes.length; k++) {
			const pieces = writer.element(targetShapes[k] as ShapeNode, IDENTITY)

			if (isRefused(pieces)) return pieces

			const lead = leads[Math.min(k, leads.length - 1)]

			if (lead !== undefined) markup.push(document.raw(lead))

			markup.push(this.shapeBytes(pieces, fragment, container))
		}

		const all = concat(markup)
		const first = ordered[0]

		if (first !== undefined) {
			const lead = leads[0]

			if (lead === undefined) editor.insertBefore(first, all)
			else editor.replace(lead, all)

			for (const other of leads.slice(1)) if (other !== undefined) editor.remove(other)
		} else {
			let anchor = -1

			for (let child = document.firstChildElement(container); child >= 0 && anchor < 0; child = document.nextSiblingElement(child)) {
				const name = fragment.name(child)

				if (TRAILING.has(name) || name.startsWith("anim:")) anchor = child
			}

			if (anchor >= 0) editor.insertBefore(anchor, all)
			else if (all.length > 0) editor.append(container, all)
		}

		for (const outer of ordered) editor.remove(outer)

		return undefined
	}
}

// Per element, the whitespace-only text right before it (its indentation in a pretty-printed page), or undefined; each
// parent's children are walked once.
function leadingSpaces(document: XmlDocument, nodes: readonly number[]): (number | undefined)[] {
	const before = new Map<number, number>()
	const walked = new Set<number>()

	for (const node of nodes) {
		const parent = document.parent(node)

		if (parent < 0 || walked.has(parent)) continue

		walked.add(parent)

		let previous = -1

		for (let child = document.firstChild(parent); child >= 0; child = document.nextSibling(child)) {
			if (previous >= 0 && document.kind(previous) === NodeKind.Text) before.set(child, previous)

			previous = child
		}
	}

	return nodes.map(node => {
		const text = before.get(node)

		if (text === undefined) return undefined

		const raw = document.raw(text)

		if (raw.length === 0) return undefined

		for (const byte of raw) if (byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09) return undefined

		return text
	})
}

// Whether a group's members are written anew: one differs from what it was read as, is new (no aspects), or was read
// from other markup than the page's (an undo put it back from markup it held: the page's bytes do not have it).
function groupChanged(group: ShapeNode, aspects: ReadonlyMap<ShapeNode, Aspects>, fragment: Fragment): boolean {
	let changed = false

	walk(group.children ?? [], shape => {
		const src = shape.src

		if (hasAspects(aspects.get(shape))) changed = true
		if (src?.format === "odp" && (src.part !== fragment.part || src.fragment !== fragment.offset || src.epoch !== fragment.epoch))
			changed = true
	})

	return changed || (group.children ?? []).some(child => !aspects.has(child))
}

function withInjection(bytes: Uint8Array, inject: Uint8Array): Uint8Array {
	const end = startTagEnd(bytes)

	return concat([bytes.subarray(0, end), inject, bytes.subarray(end)])
}

// A source span with the ids this save gives elements in it added to their start tags (each lacks the attribute).
function withGivenIds(document: XmlDocument, hole: number, ids: ReadonlyMap<number, readonly (readonly [string, string])[]>): EmitPiece {
	const start = document.start(hole)
	const end = document.end(hole)
	const inserts: { readonly at: number; readonly text: string }[] = []

	for (const [node, attributes] of ids) {
		if (document.start(node) < start || document.end(node) > end) continue

		const at = document.openEnd(node) - (document.isSelfClosing(node) ? 2 : 1)

		inserts.push({ at, text: attributes.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("") })
	}

	if (inserts.length === 0) return { hole }

	inserts.sort((a, b) => a.at - b.at)

	const chunks: Uint8Array[] = []
	let from = start

	for (const insert of inserts) {
		chunks.push(document.bytes.subarray(from, insert.at), encodeUtf8(insert.text))
		from = insert.at
	}

	chunks.push(document.bytes.subarray(from, end))

	return concat(chunks)
}

function withoutInjection(bytes: Uint8Array, inject: Uint8Array): Uint8Array {
	const end = startTagEnd(bytes)
	const from = end - inject.length

	for (let k = 0; k < inject.length; k++) if (bytes[from + k] !== inject[k]) return bytes.slice()

	return concat([bytes.subarray(0, from), bytes.subarray(end)])
}

// Where a start tag's ">" or "/>" is (the injection point a page fragment uses).
function startTagEnd(bytes: Uint8Array): number {
	let quote = 0

	for (let k = 1; k < bytes.length; k++) {
		const byte = bytes[k]

		if (quote !== 0) {
			if (byte === quote) quote = 0
		} else if (byte === 0x22 || byte === 0x27) quote = byte as number
		else if (byte === 0x3e) return bytes[k - 1] === 0x2f ? k - 1 : k
	}

	return bytes.length
}

// What an edited slide whose page the splice copies (nothing found to write) still holds that its source page does not
// say, or undefined: the slide against the source's reading, as gate 2 compares a written page.
export function copiedPageDiffers(
	deck: Deck,
	node: SlideNode,
	pristine: { readonly slide: SlideNode; readonly notes: SlideNode | undefined },
	name: string
): string | undefined {
	const at = deck.slides.indexOf(node.ref)
	const index = deck.slides.indexOf.bind(deck.slides)
	const differs = slideDiffers(node, pristine.slide, name, { at, count: deck.slides.length, expected: index, read: index })

	if (differs !== undefined) return differs

	return notesDiffer(node.notes === undefined ? undefined : deck.nodes.get(node.notes), pristine.notes)
}

// The save's splice: content.xml as the deck now is, or undefined parts when nothing differs from the source.
export async function odpSplice(input: OdpSaveInput): Promise<OdpSplice | Refused> {
	const { deck, changes } = input
	const parts = input.source.parts

	if (deck.format !== "odp") return refused("unsupported", `a ${deck.format} deck in the ODP writer`)
	if (deck.gate.length > 0) return refused("viewOnly", deck.gate.join(","))

	for (const what of changes.presentation) if (!WRITTEN_PRESENTATION.has(what)) return refused("notImplemented", `odp emit ${what}`)

	const source = odpWriteSource(parts)
	const base = await source.pages()
	const content = parts.content
	const baseIndex = new Map(base.map((ref, index) => [ref, index]))
	const names = pageNames(
		deck,
		ref => deck.nodes.get(ref)?.name ?? parts.pageName(ref),
		ref => {
			const own = parts.pageName(ref)

			return own !== undefined && own === (deck.nodes.get(ref)?.name ?? own)
		}
	)
	const splicer = new Splicer(deck, parts, source, names)
	const pages: WrittenPage[] = []
	let structural = deck.slides.length !== base.length

	try {
		for (const [index, ref] of deck.slides.entries()) {
			const node = deck.nodes.get(ref)

			if (base[index] !== ref) structural = true

			if (node === undefined) {
				const at = baseIndex.get(ref)
				const span = at === undefined ? undefined : content.pages[at]

				if (span === undefined) return refused("notFound", `slide ${String(ref)} is neither parsed nor in the source`)

				pages.push({ kind: "copied", ref, span })

				continue
			}

			if (node.src === undefined) {
				const name = names.get(ref) ?? ""
				const page = newPage(deck, node, name, splicer.context, base => splicer.newId(base))

				if (isRefused(page)) return page

				const markup = declared(page, splicer.scope)

				splicer.written.push(markup)
				pages.push({ kind: "written", ref, bytes: encodeUtf8(markup), name })

				continue
			}

			if (node.src.format !== "odp") return refused("unsupported", "a slide read from another format")

			const held = node.src.part.startsWith("raw:") ? source.fragmentOf(node.src) : undefined

			if (held !== undefined) {
				// A page an undo held (deleted, saved, then restored): written from the held markup.
				const name = names.get(ref) ?? ""
				const bytes = await splicer.page(node, held, source.readHeldPage(held), false, undefined)

				if (isRefused(bytes)) return bytes

				// The declarations it carried to be read on its own that the content's root makes come off again.
				pages.push({
					kind: "written",
					ref,
					bytes: inScope(
						bytes ?? held.document.raw(held.document.firstChildElement(held.document.documentElement())),
						splicer.scope
					),
					name
				})

				continue
			}

			if (node.src.epoch !== parts.epoch) return refused("stale", "a slide read from an older source")

			const span = source.spanAt(node.src.fragment)
			const spanIndex = span === undefined ? -1 : content.pages.indexOf(span)
			const baseRef = base[spanIndex]

			if (span === undefined || baseRef === undefined) return refused("notFound", "the page a slide was read from")

			const duplicate = baseRef !== ref
			const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)
			const touched = duplicate || node.revision > 0 || (notes?.revision ?? 0) > 0 || names.get(ref) !== parts.pageName(ref)

			if (!touched) {
				pages.push({ kind: "copied", ref, span })

				continue
			}

			const pristine = await source.pristine(baseRef)

			if (pristine === undefined) return refused("notFound", "the page's source")

			const bytes = await splicer.page(node, splicer.fragment(span), pristine, duplicate, span)

			if (isRefused(bytes)) return bytes

			if (bytes === undefined) {
				// Nothing written for an edited page: decisive only when the page's source reads as the slide does.
				const differs = copiedPageDiffers(deck, node, pristine, names.get(ref) ?? "")

				if (differs !== undefined)
					return refused("failed", `page ${String(index + 1)} (${node.part}) differs from its source unwritten: ${differs}`)

				pages.push({ kind: "copied", ref, span })
			} else pages.push({ kind: "written", ref, bytes, name: names.get(ref) ?? "", source: span })
		}
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)

		throw error
	}

	const show = changes.presentation.has("show") ? settingsAttributes(deck, deck.show, names) : undefined

	if (show !== undefined && isRefused(show)) return show

	const settingsChanged = structural || changes.presentation.has("customShows") || show !== undefined
	const rewritten = pages.some(page => page.kind === "written")
	// styles.xml: a slide size change (page layouts, moved master shapes), the drawing resources the written pages
	// name, and the gallery master pages (emit/design.ts).
	const sized = odpDesignStyles(deck, parts.stylesFragment, splicer.styles, changes.presentation.has("size"))

	if (isRefused(sized)) return sized

	const stylesReplaced = sized === undefined ? [] : [{ name: "styles.xml", bytes: utf8Declared(sized) }]

	// Nothing of content.xml changed: unchanged, unless styles.xml did (written with content.xml as it is).
	if (
		!rewritten &&
		!structural &&
		!settingsChanged &&
		splicer.styles.empty &&
		splicer.styles.replaced().length === 0 &&
		stylesReplaced.length === 0
	)
		return { revision: input.revision, content: undefined, pages, names, replace: stylesReplaced, add: [] }

	const whole = assemble(parts, pages, splicer, structural, settingsChanged, show)

	if (isRefused(whole)) return whole

	const assembled = utf8Declared(
		withRetired(withoutOrphans(parts.content.bytes, whole, source.retired, source.retiredAfter), source.retired, source.retiredAfter)
	)

	// Entries the written pages added (an inserted picture), each with its manifest entry.
	const added = splicer.styles.added()
	const manifest = parts.odf.manifest

	if (added.length > 0 && manifest === undefined) return refused("unsupported", "a package without a manifest")

	// The manifest as the package has it (its version, its namespaces, every entry byte for byte), the new entries
	// added before its end tag.
	const manifestEntry = parts.odf.archive.entries.find(entry => entry.name === "META-INF/manifest.xml")
	const manifestBytes =
		added.length === 0 || manifestEntry === undefined
			? undefined
			: withManifestEntries(
					await parts.odf.archive.read(manifestEntry),
					added.map(entry => ({ path: entry.path, mediaType: entry.mediaType }))
				)

	if (added.length > 0 && manifestBytes === undefined) return refused("unsupported", "a manifest that cannot take new entries")

	return {
		revision: input.revision,
		content: assembled,
		pages,
		names,
		replace: [
			{ name: "content.xml", bytes: assembled },
			...stylesReplaced,
			...(manifestBytes === undefined ? [] : [{ name: "META-INF/manifest.xml", bytes: manifestBytes }]),
			...splicer.styles.replaced().map(entry => ({ name: entry.path, bytes: entry.content }))
		],
		// Pictures (PNG, JPEG, GIF) and media are compressed already: stored, as LibreOffice stores them; a medium streams
		// once, checked against its CRC-32.
		add: added.map(entry => ({
			name: entry.path,
			bytes: entry.content,
			compress: entry.compress ?? !/^(?:image\/(?:png|jpeg|gif)|video\/|audio\/)/u.test(entry.mediaType),
			...(entry.crc32 === undefined ? {} : { crc32: entry.crc32 })
		}))
	}
}

// META-INF/manifest.xml with `entries` added as manifest:file-entry elements (Part 2 §4.3) before the root's end tag,
// in the prefix the root uses; undefined when the root's end cannot be found.
export function withManifestEntries(
	bytes: Uint8Array,
	entries: readonly { readonly path: string; readonly mediaType: string }[]
): Uint8Array | undefined {
	const text = decodeUtf8(bytes, 0, bytes.length)
	const close = /<\/([\w.-]+:)?manifest>\s*$/u.exec(text)

	if (close === null) return undefined

	const prefix = close[1] ?? ""
	const lines = entries
		.map(
			entry =>
				` <${prefix}file-entry ${prefix}full-path="${escapeAttribute(entry.path)}" ${prefix}media-type="${escapeAttribute(entry.mediaType)}"/>\n`
		)
		.join("")
	const at = encodeUtf8(text.slice(0, close.index)).length

	return concat([bytes.subarray(0, at), encodeUtf8(lines), bytes.subarray(at)])
}

// Names a stream refers to styles by (§19.4xx *-style-name, list styles, data styles, master pages): every value of
// an attribute whose local name ends in "style-name" or "master-page-name", either quote, the value decoded (a style
// name spelled with a character reference names the style it decodes to); a byte scan linear in the stream
// (styles.ts attributeValues).
export function styleReferences(bytes: Uint8Array): Set<string> {
	const out = new Set<string>()

	attributeValues(bytes, REFERENCE_SUFFIXES, true, (start, end) => {
		out.add(bytes.subarray(start, end).includes(AMP) ? decodeAttribute(bytes, start, end) : decodeUtf8(bytes, start, end))
	})

	return out
}

const REFERENCE_SUFFIXES = [STYLE_NAME_SUFFIX, MASTER_PAGE_NAME_SUFFIX]
const AMP = 0x26

// A value with references as an attribute decodes it; one that does not decode stays as written.
function decodeAttribute(bytes: Uint8Array, start: number, end: number): string {
	try {
		return decodeCharacterData(bytes, start, end, true)
	} catch {
		return decodeUtf8(bytes, start, end)
	}
}

// A part declared encoding="us-ascii" (XML 1.0 §4.3.3) that holds a byte past ASCII (text a save wrote, always UTF-8)
// declared UTF-8: its ASCII bytes are UTF-8 as they are. Any other part is returned as it is.
export function utf8Declared(bytes: Uint8Array): Uint8Array {
	const head = decodeUtf8(bytes, 0, Math.min(bytes.length, 256))
	const declaration = /^(\uFEFF?<\?xml\s[^>]*?\bencoding\s*=\s*)(["'])((?:us-)?ascii)\2/iu.exec(head)

	if (declaration === null || !bytes.some(byte => byte >= 0x80)) return bytes

	const start = encodeUtf8(declaration[1] ?? "").length + 1
	const end = start + (declaration[3] ?? "").length

	const name = encodeUtf8("UTF-8")
	const out = new Uint8Array(bytes.length - (end - start) + name.length)

	out.set(bytes.subarray(0, start))
	out.set(name, start)
	out.set(bytes.subarray(end), start + name.length)

	return out
}

// The automatic styles of content.xml an edit left without a reference (a deleted page's, a style a patched copy
// replaced) taken out, until none is: the source's own unreferenced ones stay as they were. Each one taken out is
// kept in `retired` (markup an undo puts back may name it), with the style it followed in `after` (null: the first).
function withoutOrphans(
	source: Uint8Array,
	output: Uint8Array,
	retired: Map<string, string>,
	after: Map<string, string | null>
): Uint8Array {
	const before = styleReferences(source)
	let current = output

	for (let pass = 0; pass < 8; pass++) {
		const prologue = readContentPrologue(current)

		if (!prologue.sliced) return current

		const document = prologue.document
		const ranges: { readonly start: number; readonly end: number }[] = []
		const now = styleReferences(current)

		for (let section = document.firstChildElement(prologue.root); section >= 0; section = document.nextSiblingElement(section)) {
			if (
				prologue.namespaces.elementUri(section) !== "urn:oasis:names:tc:opendocument:xmlns:office:1.0" ||
				document.localName(section) !== "automatic-styles"
			)
				continue

			let previous: string | null = null

			for (let style = document.firstChildElement(section); style >= 0; style = document.nextSiblingElement(style)) {
				const name = document.attributes(style).find(attribute => attribute.name.endsWith(":name"))?.value

				if (name !== undefined && before.has(name) && !now.has(name)) {
					// The whitespace after a style goes with it (an undo puts both back where they were).
					const end = afterSpace(document, current, style)

					ranges.push({ start: document.start(style), end })

					if (!retired.has(name)) {
						retired.set(name, decodeUtf8(current, document.start(style), end))
						after.set(name, previous)
					}
				}

				if (name !== undefined) previous = name
			}
		}

		if (ranges.length === 0) return current

		const chunks: Uint8Array[] = []
		let at = 0

		for (const range of ranges) {
			chunks.push(current.subarray(at, range.start))
			at = range.end
		}

		chunks.push(current.subarray(at))
		current = concat(chunks)
	}

	return current
}

// The retired automatic styles the written content names but no longer defines (markup an undo put back) added to
// office:automatic-styles again, with the retired ones they name in turn: each after the style it followed when it
// was retired (first, when it was the first), so content an undo returned to its source state is written as the
// source had it; last when that style is gone.
function withRetired(output: Uint8Array, retired: ReadonlyMap<string, string>, after: ReadonlyMap<string, string | null>): Uint8Array {
	if (retired.size === 0) return output

	const prologue = readContentPrologue(output)

	if (!prologue.sliced) return output

	const document = prologue.document
	let section = -1
	const defined = new Map<string, number>()

	for (let node = document.firstChildElement(prologue.root); node >= 0; node = document.nextSiblingElement(node)) {
		if (
			prologue.namespaces.elementUri(node) !== "urn:oasis:names:tc:opendocument:xmlns:office:1.0" ||
			document.localName(node) !== "automatic-styles"
		)
			continue

		section = node

		for (let style = document.firstChildElement(node); style >= 0; style = document.nextSiblingElement(style)) {
			const name = document.attributes(style).find(attribute => attribute.name.endsWith(":name"))?.value

			if (name !== undefined) defined.set(name, afterSpace(document, output, style))
		}
	}

	const added: string[] = []
	const adding = new Set<string>()
	let wanted = [...styleReferences(output)]

	while (wanted.length > 0) {
		const more: string[] = []

		for (const name of wanted) {
			const markup = retired.get(name)

			if (markup === undefined || defined.has(name) || adding.has(name)) continue

			adding.add(name)
			added.push(name)
			appendAll(more, styleReferences(encodeUtf8(markup)))
		}

		wanted = more
	}

	if (added.length === 0) return output

	if (section < 0 || document.isSelfClosing(section)) {
		const at = section < 0 ? prologue.bodyStart : document.start(section)
		const end = section < 0 ? prologue.bodyStart : document.end(section)

		return concat([
			output.subarray(0, at),
			encodeUtf8('<office:automatic-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0">'),
			encodeUtf8(added.map(name => retired.get(name) ?? "").join("")),
			encodeUtf8("</office:automatic-styles>"),
			output.subarray(end)
		])
	}

	// Each one's place: after the style it followed (one being added goes before it in the same run), the section's
	// start for the first, its end when that style is gone.
	const opening = document.firstChild(section)
	const first =
		opening >= 0 &&
		document.kind(opening) !== NodeKind.Element &&
		isWhitespace(output.subarray(document.start(opening), document.end(opening)))
			? document.end(opening)
			: document.contentStart(section)
	const last = document.contentEnd(section)
	const placeOf = (name: string): { readonly at: number; readonly depth: number } => {
		let depth = 0
		let anchor = after.get(name)

		for (const seen = new Set([name]); anchor !== undefined && anchor !== null && adding.has(anchor) && !seen.has(anchor); depth++) {
			seen.add(anchor)
			anchor = after.get(anchor)
		}

		const at = anchor === null ? first : anchor === undefined ? last : (defined.get(anchor) ?? last)

		return { at, depth }
	}
	const placed = added
		.map((name, order) => ({ name, order, ...placeOf(name) }))
		.sort((a, b) => a.at - b.at || a.depth - b.depth || a.order - b.order)
	const chunks: Uint8Array[] = []
	let at = 0

	for (const each of placed) {
		chunks.push(output.subarray(at, each.at), encodeUtf8(retired.get(each.name) ?? ""))
		at = each.at
	}

	chunks.push(output.subarray(at))

	return concat(chunks)
}

// The end of an element and the whitespace-only text right after it.
function afterSpace(document: XmlDocument, bytes: Uint8Array, node: number): number {
	const next = document.nextSibling(node)

	return next >= 0 && document.kind(next) !== NodeKind.Element && isWhitespace(bytes.subarray(document.start(next), document.end(next)))
		? document.end(next)
		: document.end(node)
}

// content.xml from its parts: the prologue with the new automatic styles, the body's head, the pages, the tail with
// the settings as the deck now has them.
function assemble(
	parts: OdpParts,
	pages: readonly WrittenPage[],
	splicer: Splicer,
	structural: boolean,
	settingsChanged: boolean,
	show: readonly SettingsAttribute[] | undefined
): Uint8Array | Refused {
	const content = parts.content
	const bytes = content.bytes
	const layout = contentLayout(bytes)

	if (isRefused(layout)) return layout

	const sourcePages = content.pages
	const firstStart = sourcePages[0]?.start
	const lastEnd = sourcePages[sourcePages.length - 1]?.end
	const chunks: Uint8Array[] = []
	const styles = splicer.styles.markup(splicer.written)
	const presentationPrefix = (() => {
		const located = readContentPrologue(bytes)

		return located.namespaces.prefixFor(located.root, "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0")
	})()

	if (show !== undefined && (presentationPrefix === undefined || presentationPrefix === ""))
		return refused("unsupported", "content.xml binds no presentation prefix")

	// The settings as the deck has them after the pages (which end at `from`): rewritten, written new, or kept.
	const tail = (from: number): Refused | undefined => {
		const settings = settingsChanged && presentationPrefix !== undefined ? settingsRange(bytes, from, presentationPrefix) : undefined

		if (settings === undefined) {
			const fresh =
				settingsChanged && presentationPrefix !== undefined
					? newSettingsMarkup(splicer.deck, splicer.names, presentationPrefix, show)
					: ""

			if (fresh !== "") {
				const close = lastClose(bytes)

				if (close < from) return refused("malformed", "content.xml without its presentation's end")

				chunks.push(bytes.subarray(from, close), encodeUtf8(fresh), bytes.subarray(close))
			} else {
				chunks.push(bytes.subarray(from))
			}

			return undefined
		}

		const scope = new Map<string, string>()
		const rootDocument = parseXml(concat([content.rootOpen, content.rootClose]))
		const rootNamespaces = new Namespaces(rootDocument)

		for (const [prefix, uri] of rootNamespaces.inScope(rootDocument.documentElement())) scope.set(prefix, uri)

		const parsed = parseInScope(bytes.subarray(settings.start, settings.end), scope)
		const settingsNamespaces = new Namespaces(parsed.document, { lenient: true })
		const canonical = (node: number, name: string): string => {
			const colon = name.indexOf(":")

			return colon < 0 ? name : canonicalName(settingsNamespaces.uri(node, name.slice(0, colon)), name.slice(colon + 1))
		}
		const rewritten = settingsMarkup(
			parsed.document,
			parsed.node,
			splicer.deck,
			splicer.names,
			canonical,
			node => canonicalName(settingsNamespaces.elementUri(node), parsed.document.localName(node)),
			show === undefined || presentationPrefix === undefined ? undefined : { attributes: show, prefix: presentationPrefix }
		)

		if (isRefused(rewritten)) return rewritten

		chunks.push(bytes.subarray(from, settings.start), rewritten, bytes.subarray(settings.end))

		return undefined
	}

	// The prologue, its automatic styles grown.
	chunks.push(bytes.subarray(0, layout.stylesAt))
	if (styles !== "") chunks.push(encodeUtf8(layout.stylesOpen + styles + layout.stylesClose))
	else if (layout.stylesOpen !== "" && layout.stylesEnd > layout.stylesAt) chunks.push(bytes.subarray(layout.stylesAt, layout.stylesEnd))

	const bodyFrom = layout.stylesOpen !== "" && styles !== "" ? layout.stylesEnd : layout.stylesAt

	if (firstStart === undefined || lastEnd === undefined) {
		// A deck whose source has no page: the new pages go before the settings, or before office:presentation ends.
		const settings = presentationPrefix === undefined ? undefined : settingsRange(bytes, bodyFrom, presentationPrefix)
		const insertAt = settings?.start ?? lastClose(bytes)

		if (insertAt < 0) return refused("malformed", "content.xml without its presentation's end")

		chunks.push(bytes.subarray(bodyFrom, insertAt))

		for (const page of pages) chunks.push(page.kind === "copied" ? bytes.subarray(page.span.start, page.span.end) : page.bytes)

		const failed = tail(insertAt)

		return failed ?? concat(chunks)
	}

	chunks.push(bytes.subarray(bodyFrom, firstStart))

	if (!structural) {
		// The same pages in the same order: each in its place, the bytes between pages kept.
		for (const [index, page] of pages.entries()) {
			const span = sourcePages[index] as PageSpan

			if (index > 0) chunks.push(bytes.subarray((sourcePages[index - 1] as PageSpan).end, span.start))

			chunks.push(page.kind === "copied" ? bytes.subarray(span.start, span.end) : page.bytes)
		}
	} else {
		for (let index = 1; index < sourcePages.length; index++) {
			const gap = bytes.subarray((sourcePages[index - 1] as PageSpan).end, (sourcePages[index] as PageSpan).start)

			if (!isWhitespace(gap)) return refused("unsupported", "markup between pages")
		}

		for (const page of pages) chunks.push(page.kind === "copied" ? bytes.subarray(page.span.start, page.span.end) : page.bytes)
	}

	// The tail: the settings (custom shows, start page, the show's attributes) as the deck has them.
	const failed = tail(lastEnd)

	return failed ?? concat(chunks)
}

// The start of office:presentation's end tag (the last "</" before office:body ends): where pages and settings go
// when there is no page to follow.
function lastClose(bytes: Uint8Array): number {
	const text = decodeUtf8(bytes, Math.max(0, bytes.length - 4096), bytes.length)
	const at = text.search(/<\/[\w.-]*:?presentation>\s*<\/[\w.-]*:?body>\s*<\/[\w.-]*:?document-content>\s*$/u)

	return at < 0 ? -1 : Math.max(0, bytes.length - 4096) + encodeUtf8(text.slice(0, at)).length
}

function findTarget(shapes: readonly ShapeNode[], id: number): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.id === id) return shape

		const inner = shape.children === undefined ? undefined : findTarget(shape.children, id)

		if (inner !== undefined) return inner
	}

	return undefined
}

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
import { Namespaces, XmlEditor, decodeUtf8, encodeUtf8, parseXml, type XmlDocument } from "../../xml/index"
import type { Fragment } from "../read/context"
import type { OdpParts } from "../read/document"
import type { PageSpan } from "../read/scan"
import type { EmitPiece } from "../../pptx/write/types"
import { emitOdp, type OdpEmitContext } from "./emit"
import { IDENTITY, OdpShapeWriter, hasAspects, type Aspects } from "./emit/shape"
import { newPage, pageAspects, pageChanges, startTag, timingPieces } from "./emit/slide"
import { odpTimingRoot } from "../../anim/odf"
import { newSettingsMarkup, pageNames, renameIds, settingsMarkup } from "./integrity"
import { OdpWriteSource, odpWriteSource } from "./source"
import { OdpStyles, declared, isRefused, styleDeclarations, takenInStreams, type OdpWriteEnv } from "./styles"

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

// Presentation-level changes the ODP writer writes (the slide list and the custom shows); the rest belong to the
// families that edit them.
const WRITTEN_PRESENTATION: ReadonlySet<string> = new Set(["slideList", "customShows", "sections"])

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
			...(same(shape.props?.geometry, was.props?.geometry) ? {} : { geometry: true }),
			...(same(fieldless(shape.text), fieldless(was.text)) ? {} : { text: true }),
			...(same(shape.alt, was.alt) ? {} : { alt: true }),
			...(shape.name === was.name ? {} : { name: true }),
			...(shape.hidden === was.hidden ? {} : { hidden: true }),
			...(same(shape.actions, was.actions) ? {} : { actions: true })
		}

		out.set(shape, aspects)
	})

	return out
}

// Content a shape's family alone writes (a table's cells, a chart, media): differs → refused until that family is
// built, never dropped.
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
		else if (digestOf(shape.frame) !== digestOf(was.frame) || digestOf(shape.media) !== digestOf(was.media))
			found = refused("notImplemented", `odp emit ${shape.frame?.kind ?? "media"}`)
		else if (digestOf(shape.ph) !== digestOf(was.ph)) found = refused("unsupported", "a placeholder of another kind")
	})

	return found
}

const TRAILING: ReadonlySet<string> = new Set(["presentation:animations", "presentation:notes"])

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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
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
			dispatch: emitOdp,
			familyOf: emitFamilyOf
		}
		const taken = takenInStreams(parts)

		// A retired style's name stays taken: held markup may name it again.
		for (const name of source.retired.keys()) taken.add(name)

		const prologue = readContentPrologue(parts.content.bytes)

		this.scope = prologue.namespaces.inScope(prologue.root)
		this.styles = new OdpStyles(env, "content", taken, styleDeclarations(this.scope))
		this.context = { deck, document: undefined, editor: undefined, styles: this.styles }
	}

	fragment(span: PageSpan): Fragment {
		const fragment = this.source.fragment(span)

		this.fragments.set(fragment.document, fragment)

		return fragment
	}

	// The bytes of pieces, holes copied from `document`, generated strings kept for the style collection.
	bytes(pieces: readonly EmitPiece[], document: XmlDocument | undefined): Uint8Array {
		for (const piece of pieces) if (typeof piece === "string") this.written.push(piece)

		return markupBytes({ kind: "markup", pieces }, document)
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
		const context: OdpEmitContext = { ...this.context, document }
		const aspects = pageAspects(node, pristine.slide, name)
		const attributes = pageChanges(this.deck, node, aspects, fragment.attributes(page), context)

		if (isRefused(attributes)) return attributes

		const editor = new XmlEditor(document)
		const slideEdits = this.container(editor, fragment, page, node, node.shapes, pristine.slide.shapes, context)

		if (isRefused(slideEdits)) return slideEdits

		if (aspects.timing === true) {
			const timing = this.timing(editor, fragment, page, node, context)

			if (timing !== undefined) return timing
		}

		const notesNode = node.notes === undefined ? undefined : this.deck.nodes.get(node.notes)

		if (notesNode !== undefined || pristine.notes !== undefined) {
			if (notesNode === undefined || pristine.notes === undefined || notesNode.src?.format !== "odp")
				return refused("notImplemented", "odp emit notes")

			const notesEdits = this.container(editor, fragment, notesNode.src.node, notesNode, notesNode.shapes, pristine.notes.shapes, {
				...context
			})

			if (isRefused(notesEdits)) return notesEdits
		}

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
			const renamed = this.renamed(bytes, span)

			if (isRefused(renamed)) return renamed

			bytes = renamed
		}

		return bytes
	}

	// The page's timing root replaced by the timing family's element (removed when the slide lost its timing), or
	// inserted after the shapes and before presentation:notes when the source has none.
	private timing(editor: XmlEditor, fragment: Fragment, page: number, node: SlideNode, context: OdpEmitContext): Refused | undefined {
		const pieces = timingPieces(node, context)

		if (isRefused(pieces)) return pieces

		const document = fragment.document
		const bytes = this.bytes(pieces, document)
		const root = odpTimingRoot(fragment, page)

		if (root >= 0) {
			if (bytes.length === 0) editor.remove(root)
			else editor.replace(root, bytes)

			return undefined
		}

		if (bytes.length === 0) return undefined

		for (let child = document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
			if (fragment.name(child) === "presentation:notes") {
				editor.insertBefore(child, bytes)

				return undefined
			}
		}

		editor.append(page, bytes)

		return undefined
	}

	// A copied page's xml:id and draw:id values made unique in the document.
	private renamed(bytes: Uint8Array, span: PageSpan): Uint8Array | Refused {
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
		const editor = renameIds(document, page, this.ids, canonical, node =>
			canonicalName(namespaces.elementUri(node), document.localName(node))
		)

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

				if (!hasAspects(aspects.get(shape)) && (shape.kind !== "grpSp" || !groupChanged(shape, aspects))) continue

				const pieces = writer.element(shape, IDENTITY)

				if (isRefused(pieces)) return pieces
				if (
					pieces.length === 1 &&
					typeof pieces[0] === "object" &&
					"hole" in (pieces[0] as object) &&
					(pieces[0] as { hole: number }).hole === outer
				)
					continue

				editor.replace(outer, this.bytes(pieces, document))
			}

			return undefined
		}

		// The shapes reordered, added or taken out: the source's shapes go and the deck's are written where the first was.
		const markup: Uint8Array[] = []

		for (const shape of targetShapes) {
			const pieces = writer.element(shape, IDENTITY)

			if (isRefused(pieces)) return pieces

			markup.push(this.bytes(pieces, document))
		}

		const all = concat(markup)
		const first = sourceOuter[0]

		if (first !== undefined) {
			editor.insertBefore(first, all)
		} else {
			let anchor = -1

			for (let child = document.firstChildElement(container); child >= 0 && anchor < 0; child = document.nextSiblingElement(child)) {
				const name = fragment.name(child)

				if (TRAILING.has(name) || name.startsWith("anim:")) anchor = child
			}

			if (anchor >= 0) editor.insertBefore(anchor, all)
			else if (all.length > 0) editor.append(container, all)
		}

		for (const outer of sourceOuter) editor.remove(outer)

		return undefined
	}
}

function groupChanged(group: ShapeNode, aspects: ReadonlyMap<ShapeNode, Aspects>): boolean {
	let changed = false

	walk(group.children ?? [], shape => {
		if (hasAspects(aspects.get(shape))) changed = true
	})

	return changed || (group.children ?? []).some(child => !aspects.has(child))
}

function withInjection(bytes: Uint8Array, inject: Uint8Array): Uint8Array {
	const end = startTagEnd(bytes)

	return concat([bytes.subarray(0, end), inject, bytes.subarray(end)])
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
				const page = newPage(deck, node, name, splicer.context)

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

				pages.push({
					kind: "written",
					ref,
					bytes: bytes ?? held.document.raw(held.document.firstChildElement(held.document.documentElement())),
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

			if (bytes === undefined) pages.push({ kind: "copied", ref, span })
			else pages.push({ kind: "written", ref, bytes, name: names.get(ref) ?? "", source: span })
		}
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)

		throw error
	}

	const settingsChanged = structural || changes.presentation.has("customShows")
	const rewritten = pages.some(page => page.kind === "written")

	if (!rewritten && !structural && !settingsChanged && splicer.styles.empty)
		return { revision: input.revision, content: undefined, pages, names, replace: [], add: [] }

	const whole = assemble(parts, pages, splicer, structural, settingsChanged)

	if (isRefused(whole)) return whole

	const assembled = withRetired(withoutOrphans(parts.content.bytes, whole, source.retired), source.retired)

	return {
		revision: input.revision,
		content: assembled,
		pages,
		names,
		replace: [{ name: "content.xml", bytes: assembled }],
		add: []
	}
}

// Names a stream refers to styles by (§19.4xx *-style-name, list styles, data styles, master pages): every value of
// an attribute whose local name ends in "style-name" or "-name" of those kinds.
const REFERENCE = /[\w.-]*(?:style-name|-style-name|list-style-name|data-style-name|master-page-name)="([^"]*)"/gu

function referenced(text: string): Set<string> {
	const out = new Set<string>()

	for (const match of text.matchAll(REFERENCE)) out.add(match[1] ?? "")

	return out
}

// The automatic styles of content.xml an edit left without a reference (a deleted page's, a style a patched copy
// replaced) taken out, until none is: the source's own unreferenced ones stay as they were. Each one taken out is
// kept in `retired` (markup an undo puts back may name it).
function withoutOrphans(source: Uint8Array, output: Uint8Array, retired: Map<string, string>): Uint8Array {
	const before = referenced(decodeUtf8(source, 0, source.length))
	let current = output

	for (let pass = 0; pass < 8; pass++) {
		const prologue = readContentPrologue(current)

		if (!prologue.sliced) return current

		const document = prologue.document
		const ranges: { readonly start: number; readonly end: number }[] = []
		const text = decodeUtf8(current, 0, current.length)
		const now = referenced(text)

		for (let section = document.firstChildElement(prologue.root); section >= 0; section = document.nextSiblingElement(section)) {
			if (
				prologue.namespaces.elementUri(section) !== "urn:oasis:names:tc:opendocument:xmlns:office:1.0" ||
				document.localName(section) !== "automatic-styles"
			)
				continue

			for (let style = document.firstChildElement(section); style >= 0; style = document.nextSiblingElement(style)) {
				const name = document.attributes(style).find(attribute => attribute.name.endsWith(":name"))?.value

				if (name !== undefined && before.has(name) && !now.has(name)) {
					ranges.push({ start: document.start(style), end: document.end(style) })

					if (!retired.has(name)) retired.set(name, decodeUtf8(current, document.start(style), document.end(style)))
				}
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
// office:automatic-styles again, with the retired ones they name in turn.
function withRetired(output: Uint8Array, retired: ReadonlyMap<string, string>): Uint8Array {
	if (retired.size === 0) return output

	const prologue = readContentPrologue(output)

	if (!prologue.sliced) return output

	const document = prologue.document
	let section = -1
	const defined = new Set<string>()

	for (let node = document.firstChildElement(prologue.root); node >= 0; node = document.nextSiblingElement(node)) {
		if (
			prologue.namespaces.elementUri(node) !== "urn:oasis:names:tc:opendocument:xmlns:office:1.0" ||
			document.localName(node) !== "automatic-styles"
		)
			continue

		section = node

		for (let style = document.firstChildElement(node); style >= 0; style = document.nextSiblingElement(style)) {
			const name = document.attributes(style).find(attribute => attribute.name.endsWith(":name"))?.value

			if (name !== undefined) defined.add(name)
		}
	}

	const added: string[] = []
	let wanted = [...referenced(decodeUtf8(output, 0, output.length))]

	while (wanted.length > 0) {
		const more: string[] = []

		for (const name of wanted) {
			const markup = retired.get(name)

			if (markup === undefined || defined.has(name)) continue

			defined.add(name)
			added.push(markup)
			more.push(...referenced(markup))
		}

		wanted = more
	}

	if (added.length === 0) return output

	const markup = encodeUtf8(added.join(""))

	if (section < 0 || document.isSelfClosing(section)) {
		const at = section < 0 ? prologue.bodyStart : document.start(section)
		const end = section < 0 ? prologue.bodyStart : document.end(section)

		return concat([
			output.subarray(0, at),
			encodeUtf8('<office:automatic-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0">'),
			markup,
			encodeUtf8("</office:automatic-styles>"),
			output.subarray(end)
		])
	}

	const at = document.contentEnd(section)

	return concat([output.subarray(0, at), markup, output.subarray(at)])
}

// content.xml from its parts: the prologue with the new automatic styles, the body's head, the pages, the tail with
// the settings as the deck now has them.
function assemble(
	parts: OdpParts,
	pages: readonly WrittenPage[],
	splicer: Splicer,
	structural: boolean,
	settingsChanged: boolean
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

		chunks.push(bytes.subarray(insertAt))

		return concat(chunks)
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

	// The tail: the settings (custom shows, start page) as the deck has them.
	const settings = settingsChanged && presentationPrefix !== undefined ? settingsRange(bytes, lastEnd, presentationPrefix) : undefined

	if (settings === undefined) {
		if (settingsChanged && splicer.deck.customShows.length > 0 && presentationPrefix !== undefined) {
			const close = lastClose(bytes)

			if (close < lastEnd) return refused("malformed", "content.xml without its presentation's end")

			chunks.push(bytes.subarray(lastEnd, close), encodeUtf8(newSettingsMarkup(splicer.deck, splicer.names)), bytes.subarray(close))
		} else {
			chunks.push(bytes.subarray(lastEnd))
		}

		return concat(chunks)
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
	const rewritten = settingsMarkup(parsed.document, parsed.node, splicer.deck, splicer.names, canonical, node =>
		canonicalName(settingsNamespaces.elementUri(node), parsed.document.localName(node))
	)

	if (isRefused(rewritten)) return rewritten

	chunks.push(bytes.subarray(lastEnd, settings.start), rewritten, bytes.subarray(settings.end))

	return concat(chunks)
}

// The start of office:presentation's end tag (the last "</" before office:body ends): where pages and settings go
// when there is no page to follow.
function lastClose(bytes: Uint8Array): number {
	const text = decodeUtf8(bytes, Math.max(0, bytes.length - 4096), bytes.length)
	const at = text.search(/<\/[\w.-]*:?presentation>\s*<\/[\w.-]*:?body>\s*<\/[\w.-]*:?document-content>\s*$/u)

	return at < 0 ? -1 : Math.max(0, bytes.length - 4096) + encodeUtf8(text.slice(0, at)).length
}

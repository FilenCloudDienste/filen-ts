import { decodeUtf8, encodeUtf8, parseXml, type XmlDocument } from "../../xml/index"
import { OdfNs, type OdfElement, type OdfStyle, type OdfStyleSheet, type StyleScope } from "../../odf/index"
import { runProperties, type Attributes } from "../props"
import { StyleMapper } from "../styles"
import { esc, escText } from "../wml"
import {
	borderAttributes,
	neutralRun,
	paragraphAttributes,
	paragraphSources,
	paragraphTextSources,
	runAttributes,
	runSources,
	type FontFaces
} from "./inverse"
import { PARAGRAPH_SKIPPED, StyleChains, canonicalElement, descendant, readProps, type Props, type PropertyValue } from "./meaning"
import { mapText, wmlText, type SourceText, type TextMapping } from "./sourceText"
import { ByteKeyMap } from "./byteKeys"
import { effectiveTable, gridSpan, type EffectiveTable } from "./tables"
import { levelGeometry } from "../lists"

// WordprocessingML blocks written as ODF text (Part 3 §5, §9, §6): paragraphs and headings with their runs as
// text:span, lists from their numbering, table rows and cells. What the source already says is reused rather than
// restated: a paragraph whose properties are those the source paragraph's style gave keeps that style (its start
// tag), a run whose properties a source span style gives takes that span style, and a new style is the source's
// patched where the properties changed. Pictures, notes and comments the edit left as they were are copied as the
// source has them (atoms).

export class OdtWriteRefusal extends Error {
	readonly reason: string

	constructor(reason: string, message: string) {
		super(message)
		this.name = "OdtWriteRefusal"
		this.reason = reason
	}
}

const W_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
// Entries a cache of the emitter keeps before it starts again.
const CACHE_LIMIT = 4096
const NO_BYTES = new Uint8Array(0)

// New automatic styles of one stream, deduplicated by what they say, named past every name either stream uses. A
// style the stream already has with the same markup is that style (so saves do not pile up copies of it).
const ALIGNED = Uint8Array.of(1)

export class StyleRegistry {
	private readonly taken: Set<string>
	private readonly byKey = new Map<string, string>()
	// The stream's own automatic styles of a family by their written form (writtenForm), read when first asked.
	existing: ((family: string) => ReadonlyMap<string, string>) | undefined
	readonly markup: string[] = []
	// Whether a name is taken in the stream's body (an id or a name a frame, table or change region has there), asked
	// for names given to body elements only (`name(prefix, true)`).
	inBody: ((name: string) => boolean) | undefined
	// The name each markup entry defines, and whether it is a paragraph or text style (others are always kept).
	readonly names: string[] = []
	private readonly collectable: boolean[] = []
	private readonly counters = new Map<string, number>()
	private readonly declarations: string

	constructor(taken: Set<string>, declarations: string) {
		this.taken = taken
		this.declarations = declarations
	}

	// A new name. `body`: one for a body element (a frame, a table, a list's or change region's id), checked against
	// the body's names too.
	name(prefix: string, body = false): string {
		let next = this.counters.get(prefix) ?? 1
		let name = `${prefix}${next}`

		while (this.taken.has(name) || (body && this.inBody?.(name) === true)) name = `${prefix}${++next}`

		this.counters.set(prefix, next + 1)
		this.taken.add(name)

		return name
	}

	// A style:style of `family` with its attributes (style:parent-style-name...) and properties markup.
	style(family: string, prefix: string, attributes: string, properties: string): string {
		const key = `${family}\u0000${attributes}\u0000${properties}`
		const known = this.byKey.get(key) ?? this.existing?.(family).get(`${attributes}\u0000${properties}`)

		if (known !== undefined) return known

		const name = this.name(prefix)

		this.names.push(name)
		this.collectable.push(family === "text" || family === "paragraph")
		this.markup.push(
			`<style:style${this.declarations} style:name="${esc(name)}" style:family="${family}"${attributes}${properties === "" ? "/>" : `>${properties}</style:style>`}`
		)
		this.byKey.set(key, name)

		return name
	}

	// The markup of the styles something written names (`written`, or another such style): a style made for a rewrite
	// that was then written another way names nothing.
	used(written: readonly string[]): string {
		const referenced = new Set<string>()
		const collect = (text: string): void => {
			for (const match of text.matchAll(/="([^"]*)"/gu)) referenced.add(match[1] ?? "")
		}

		for (const text of written) collect(text)

		const kept = new Uint8Array(this.markup.length)

		this.collectable.forEach((collectable, k) => {
			if (!collectable) {
				kept[k] = 1
				collect(this.markup[k] ?? "")
			}
		})

		for (let changed = true; changed;) {
			changed = false

			this.names.forEach((name, k) => {
				if (kept[k] === 0 && referenced.has(esc(name))) {
					kept[k] = 1
					changed = true
					collect(this.markup[k] ?? "")
				}
			})
		}

		return this.markup.filter((_markup, k) => kept[k] === 1).join("")
	}

	// Any other automatic style element (a list style), named from `make`.
	element(key: string, prefix: string, make: (name: string) => string): string {
		const known = this.byKey.get(key)

		if (known !== undefined) return known

		const name = this.name(prefix)

		this.names.push(name)
		this.collectable.push(false)
		this.markup.push(make(name))
		this.byKey.set(key, name)

		return name
	}
}

function attributeList(attributes: Iterable<readonly [string, string]>): string {
	let out = ""

	for (const [name, value] of attributes) out += ` ${name}="${esc(value)}"`

	return out
}

function sortedAttributes(attributes: ReadonlyMap<string, string>): string {
	return attributeList([...attributes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

const NO_SINK = { lossy: (): void => undefined }

function propsOfMarkup(markup: string, cache: Map<string, Props>): Props {
	let props = cache.get(markup)

	if (props === undefined) {
		props = new Map()

		if (markup !== "") {
			const document = parseXml(encodeUtf8(`<w:rPr xmlns:w="${W_NAMESPACE}">${markup}</w:rPr>`))

			readProps(document, document.documentElement(), props)
		}

		cache.set(markup, props)
	}

	return props
}

export function propsKey(props: Props): string {
	const out: string[] = []

	for (const [local, value] of props) out.push(`<${local}${sortedAttributes(value.attributes)}>${value.children}`)

	return out.sort().join("")
}

function propsOf(document: XmlDocument, node: number, skip?: ReadonlySet<string>): Props {
	const props: Props = new Map()

	if (node >= 0) readProps(document, node, props, skip)

	return props
}

function child(document: XmlDocument, node: number, local: string): number {
	for (let at = document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at)) {
		if (document.localName(at) === local) return at
	}

	return -1
}

// The xml:ids of lists written: each written list's start tag holds a mark, given an id (Part 3 §19.920 xml:id)
// only when a later list continues it (text:continue-list, §19.785); marks are resolved as the stream is written.
export class ListIds {
	private readonly ids: (string | undefined)[] = []
	private readonly fresh: () => string

	constructor(fresh: () => string) {
		this.fresh = fresh
	}

	mark(): number {
		this.ids.push(undefined)

		return this.ids.length - 1
	}

	static markup(mark: number): string {
		return `\u0002${mark}\u0003`
	}

	id(mark: number): string {
		let id = this.ids[mark]

		if (id === undefined) {
			id = this.fresh()
			this.ids[mark] = id
		}

		return id
	}

	resolve(text: string): string {
		let at = text.indexOf("\u0002")

		if (at < 0) return text

		let out = ""
		let from = 0

		for (; at >= 0; at = text.indexOf("\u0002", from)) {
			const end = text.indexOf("\u0003", at)
			const id = this.ids[Number(text.slice(at + 1, end))]

			out += `${text.slice(from, at)}${id === undefined ? "" : ` xml:id="${esc(id)}"`}`
			from = end + 1
		}

		return out + text.slice(from)
	}
}

// A copied source element (a picture, a note, a comment) keyed by what its translation means.
export interface Atom {
	readonly bytes: string
	// For a range comment: the name its office:annotation-end refers to.
	readonly name?: string
	used: boolean
}

export class AtomPool {
	private readonly atoms = new Map<string, Atom[]>()

	add(key: string, atom: Atom): void {
		const list = this.atoms.get(key)

		if (list === undefined) this.atoms.set(key, [atom])
		else list.push(atom)
	}

	take(key: string): Atom | undefined {
		const atom = this.atoms.get(key)?.find(item => !item.used)

		if (atom !== undefined) atom.used = true

		return atom
	}
}

// A source paragraph a written one may take after: its start tag, the style it names, and what its translation said.
export interface ParagraphSource {
	readonly element: "text:p" | "text:h"
	// Its start tag's attributes by qualified name as the file spells them, in order.
	readonly attributes: readonly (readonly [string, string])[]
	readonly styleName: string | undefined
	readonly pPr: string
	readonly mark: string
	// Its translation is numbered (it sits in a list).
	readonly listed: boolean
}

// Numbering as the ODF writer sees it: the list style a w:num is an instance of.
export interface ListTarget {
	readonly style: string
	// The outline style numbers headings: those are text:h, not list items.
	readonly outline: boolean
}

// The notes written so far, by kind and id: each note's body is written once, a later reference to it is a
// text:note-ref showing its citation (ODF 1.2 Part 1 §7.7.7, text:ref-name naming the note's text:id, §19.809). A
// refused block's notes are rolled back with it.
export class WrittenNotes {
	// Citation text by kind and id: a custom mark, else the note's number among its kind's numbered ones.
	private readonly citations = new Map<string, string>()
	private readonly log: { readonly key: string; readonly kind: "footnote" | "endnote"; readonly numbered: boolean }[] = []
	private readonly numbered = { footnote: 0, endnote: 0 }

	// Notes (and comments) being written: a note referenced in one is its text there. The notes among them, by kind
	// and id (a flattened note leaves them out).
	depth = 0
	readonly open = new Set<string>()

	get size(): number {
		return this.log.length
	}

	citation(kind: "footnote" | "endnote", id: string): string | undefined {
		return this.citations.get(`${kind}:${id}`)
	}

	add(kind: "footnote" | "endnote", id: string, label: string | undefined): void {
		const key = `${kind}:${id}`
		const numbered = label === undefined || label === ""

		if (numbered) this.numbered[kind]++

		this.citations.set(key, numbered ? String(this.numbered[kind]) : label)
		this.log.push({ key, kind, numbered })
	}

	rollback(size: number): void {
		while (this.log.length > size) {
			const entry = this.log.pop()

			if (entry === undefined) break

			this.citations.delete(entry.key)

			if (entry.numbered) this.numbered[entry.kind]--
		}
	}
}

// The text and tabs of a run's children after `after` (all of `run`'s when `after` is -1); undefined when anything else
// is among them.
function markText(document: XmlDocument, after: number, run = -1): string | undefined {
	let out = ""

	for (
		let at = after >= 0 ? document.nextSiblingElement(after) : document.firstChildElement(run);
		at >= 0;
		at = document.nextSiblingElement(at)
	) {
		const local = document.localName(at)

		if (local === "t" || local === "delText") out += document.textContent(at)
		else if (local === "tab") out += "\t"
		else if (local !== "rPr") return undefined
	}

	return out
}

type NoteResolver = (kind: "footnote" | "endnote", id: string) => { readonly document: XmlDocument; readonly node: number } | undefined

// How many notes deep a flattened note's own notes are written; deeper ones are left out (counted).
const FLATTENED_DEPTH = 16

// A note referenced where ODF holds no note (in a note, a comment, a header or footer), as text: " (mark text)", its
// mark a custom one's, its paragraphs one after another, the notes it references flattened in turn (each once).
export function flattenedNote(
	resolve: NoteResolver,
	kind: "footnote" | "endnote",
	id: string,
	mark: string,
	lose: () => void,
	visited = new Set<string>(),
	depth = 0
): string {
	const note = resolve(kind, id)
	const key = `${kind}:${id}`

	if (note === undefined || visited.has(key)) return mark === "" ? "" : ` (${mark})`
	if (depth >= FLATTENED_DEPTH) {
		lose()

		return ""
	}

	visited.add(key)

	const { document } = note
	const parts: string[] = []
	const walk = (node: number): string => {
		let out = ""

		for (let at = document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at)) {
			const local = document.localName(at)

			if (local === "t" || local === "delText") out += document.textContent(at)
			else if (local === "tab") out += "\t"
			else if (local === "footnoteReference" || local === "endnoteReference") {
				const reference = at
				// A custom mark: the text after it in its run.
				let inner = ""

				if (document.attribute(reference, "w:customMarkFollows") === "1")
					for (
						let next = document.nextSiblingElement(at);
						next >= 0 && document.localName(next) === "t";
						next = document.nextSiblingElement(at)
					) {
						inner += document.textContent(next)
						at = next
					}

				out += flattenedNote(
					resolve,
					local === "footnoteReference" ? "footnote" : "endnote",
					document.attribute(reference, "w:id") ?? "",
					inner,
					lose,
					visited,
					depth + 1
				)
			} else out += walk(at)
		}

		return out
	}

	for (let at = document.firstChildElement(note.node); at >= 0; at = document.nextSiblingElement(at)) parts.push(walk(at))

	return ` (${mark === "" ? "" : `${mark} `}${parts.join(" ")})`
}

// A written note's text:id.
export function noteId(kind: "footnote" | "endnote", id: string): string {
	return `filen-${kind}-${id}`
}

// A reference to a note already written: its citation (`shown`, as the note's citation shows it; its readers update it).
export function noteReference(kind: "footnote" | "endnote", id: string, shown: string): string {
	return `<text:note-ref text:note-class="${kind}" text:reference-format="text" text:ref-name="${esc(noteId(kind, id))}">${escText(shown)}</text:note-ref>`
}

// A table written in pieces: how many rows it has, its columns, whether header rows are open (and body rows begun),
// the cells spanning down still open by column (their slot's id and rows so far), the closed spans by id.
export interface TableStream {
	readonly total: number
	readonly columns: number
	header: boolean
	body: boolean
	readonly merges: Map<number, { readonly id: number; readonly rows: number }>
	readonly spans: Map<number, number>
	next: number
}

// A row of a table written in pieces, and where its cells spanning down take their spans (offsets in it).
export interface StreamedRow {
	readonly markup: string
	readonly slots: readonly { readonly at: number; readonly id: number }[]
}

export interface EmitContext {
	readonly scope: StyleScope
	readonly sheet: OdfStyleSheet
	readonly mapper: StyleMapper
	readonly chains: StyleChains
	readonly registry: StyleRegistry
	readonly listIds: ListIds
	readonly fonts: FontFaces
	readonly tabsRelativeToIndent: boolean
	readonly atoms: AtomPool
	// Namespace declarations a written top-level element needs (empty where the root binds the prefixes).
	readonly declarations: string
	// The ODF paragraph (character) style a style id names; undefined when the document has none by that id.
	paragraphStyle(id: string): string | undefined
	characterStyle(id: string): string | undefined
	// Relationship targets of the part being written: a hyperlink's URL, a picture's package path.
	hyperlink(id: string): string | undefined
	// A tracked change recorded in text:tracked-changes (Part 3 §5.5): its id.
	change(kind: "insertion" | "deletion", author: string, date: string | undefined, deleted: string): string
	// A new or changed inline picture as a draw:frame holding a draw:image (Part 3 §10.4.2, §10.4.4); refuses what
	// one cannot show as it does.
	picture(document: XmlDocument, drawing: number): string
	list(numId: string): ListTarget | undefined
	// The master page a paragraph starts (a section break before it): its name, "" for none; undefined when the
	// paragraph's own says.
	masterOf(document: XmlDocument, paragraph: number): string | undefined
	// The indents a w:num's level gives (its definition's w:lvl pPr), and the value it restarts the level at
	// (w:lvlOverride w:startOverride).
	levelIndent(numId: string, ilvl: number): PropertyValue | undefined
	levelStart(numId: string, ilvl: number): number | undefined
	// The style of the source span at a w:rsidR the translation gave a run (its offset in content.xml), and whether a
	// span style is one the translation names so.
	originStyle?: (rsid: string) => string | undefined
	tracksOrigin?: (style: string) => boolean
	// The xml:id of the source list a written list of `numId` continues (one the writer keeps), given one if need be.
	sourceListId(numId: string): string | undefined
	// The document's ODF version has text:continue-list: new in ODF 1.2 (Part 1 §19.780, Appendix G.1); ODF 1.0 (second
	// edition) and 1.1 give text:list only text:style-name and text:continue-numbering (§4.3.1 List Block).
	readonly continuesLists: boolean
	// The document's ODF version (office:version; none: 1.1, ODF 1.2 Part 1 Appendix G.1); undefined: 1.3, a document
	// written anew.
	readonly version?: number
	// The w:num of the list before a paragraph of the body in the edit's order (undefined: none, or not the body's).
	precedingList?: (document: XmlDocument, paragraph: number) => string | undefined
	note(kind: "footnote" | "endnote", id: string): { readonly document: XmlDocument; readonly node: number } | undefined
	comment(id: string): { readonly document: XmlDocument; readonly node: number } | undefined
	// The atom key of a drawing, footnote or comment as the edited part has it.
	drawingKey(document: XmlDocument, drawing: number): string
	// The key of a text box's drawing without its text: the source frame a changed text box is written into.
	shellKey(document: XmlDocument, drawing: number): string
	noteKey(kind: "footnote" | "endnote", id: string): string
	// The notes a conversion has written (each written once); undefined where every reference writes its note.
	readonly notes?: WrittenNotes
	// A conversion's byte budget, charged as text is written and with the rest of each top-level block (a table: each
	// row); `held`: the markup the block being written holds so far.
	spend?(bytes: number, held: number): void
	// What a conversion leaves out, counted.
	lose?(kind: "nestedNote"): void
	commentKey(id: string): string
	fieldKey(document: XmlDocument, field: number): string
	// Names of the source's reference marks and bookmarks.
	readonly referenceMarks: Set<string>
	readonly sourceBookmarks: Set<string>
	// Source paragraphs whose start tag a written paragraph with the same properties takes.
	paragraphSources: Map<string, ParagraphSource>
	// Source link start tags by target.
	readonly links: Map<string, string>
	// The name of the bookmark a w:id starts anywhere in the story.
	bookmarkName(document: XmlDocument, id: string): string | undefined
	// A table the source has (as it was, or with rows changed), by the edited w:tbl.
	table?: ((document: XmlDocument, table: number) => string | undefined) | undefined
}

// A paragraph's inline content as written: a trailing raw space as text:s, which consumers keep (Part 3 §6.1.2 step 5).
function paragraphEnd(state: InlineState): string {
	const at = state.space

	if (!state.trimLeading || at === undefined) return state.out

	return `${state.out.slice(0, at)}<text:s/>${state.out.slice(at + 1)}`
}

interface InlineState {
	trimLeading: boolean
	out: string
	// The span style open ("" for none).
	open: string
	// Characters of the paragraph walked (wmlText's count), and their source span styles where known.
	offset: number
	readonly mapping: TextMapping | undefined
	// A run written already as a note's custom mark (-1: none).
	skip?: number
	// Notes met where ODF holds none (a ruby's base), written after it.
	deferred?: string[]
	// Index in out of the last raw single space; trailing while trimLeading holds (only that space sets it).
	space?: number
}

// What span styles give text over one paragraph text base (its properties, size and scope), learned as asked and
// shared by every paragraph style with that base: each span style is learned once per base, not once per paragraph
// style (a document's paragraph and span styles would make that quadratic).
interface SpanLearning {
	// Run properties key -> the first span style giving them.
	readonly spans: Map<string, string>
	readonly learned: Set<string>
	// Span style -> the run properties it gives (their key).
	readonly keys: Map<string, string>
}

// What one emitter learns of run properties: rPr markup read as properties, and span styles by text base.
interface RunLearning {
	readonly props: Map<string, Props>
	readonly bases: Map<string, SpanLearning>
}

function runLearning(): RunLearning {
	return { props: new Map(), bases: new Map() }
}

// Run properties a paragraph of ODF style `name` gives its text, and the span styles it knows, as the translator
// writes them.
class ParagraphStyling {
	readonly baseKey: string
	readonly baseText: Attributes
	readonly fontSize: number
	private readonly context: EmitContext
	private readonly learning: RunLearning
	private readonly shared: SpanLearning
	private readonly baseProps: Props

	constructor(context: EmitContext, learning: RunLearning, name: string | undefined, text?: Attributes, fontSize?: number) {
		this.context = context
		this.learning = learning

		const style = context.mapper.paragraph(name, context.scope)

		this.baseText = text ?? style.text
		this.fontSize = fontSize ?? style.fontSize

		const markup =
			text === undefined
				? context.mapper.runProperties(
						`${context.scope}\u0000${name ?? ""}\u0000`,
						undefined,
						this.baseText,
						this.fontSize,
						NO_SINK
					)
				: runProperties(context.sheet, this.baseText, NO_SINK, this.fontSize)

		this.baseProps = propsOfMarkup(markup, learning.props)
		this.baseKey = propsKey(this.baseProps)

		const base = `${context.scope}\u0000${this.fontSize}\u0000${sortedAttributes(this.baseText)}`
		let shared = learning.bases.get(base)

		if (shared === undefined) {
			shared = { spans: new Map(), learned: new Set(), keys: new Map() }
			learning.bases.set(base, shared)
		}

		this.shared = shared
	}

	get base(): Props {
		return this.baseProps
	}

	// The span style giving text of this paragraph style the rPr `key`, among `candidates` (learned as asked).
	span(key: string, candidates: Iterable<string>): string | undefined {
		const { spans, learned } = this.shared
		const known = spans.get(key)

		if (known !== undefined) return known

		for (const spanName of candidates) {
			if (learned.has(spanName)) continue

			learned.add(spanName)

			const found = this.keyOf(spanName)

			if (!spans.has(found)) spans.set(found, spanName)
			if (found === key) return spanName
		}

		return undefined
	}

	// The run properties (their key) a span of style `spanName` gives text of this paragraph style.
	keyOf(spanName: string): string {
		const keys = this.shared.keys
		let key = keys.get(spanName)

		if (key === undefined) {
			key = propsKey(this.propsOf(spanName))
			keys.set(spanName, key)
		}

		return key
	}

	propsOf(spanName: string): Props {
		const text = this.context.mapper.text(spanName, this.context.scope)
		const merged =
			text.own.size === 0 ? this.baseText : new Map([...this.baseText, ...StyleMapper.relativeSize(text.own, this.fontSize)])
		// Uncached: learned once per base, as the mapper's run cache would hold it once per paragraph style.
		const markup = `${text.styleId === undefined ? "" : `<w:rStyle w:val="${esc(text.styleId)}"/>`}${runProperties(this.context.sheet, merged, NO_SINK, this.fontSize)}`

		return propsOfMarkup(markup, this.learning.props)
	}
}

function textProperties(attributes: ReadonlyMap<string, string>): string {
	return attributes.size === 0 ? "" : `<style:text-properties${sortedAttributes(attributes)}/>`
}

// A paragraph style's properties as the writer writes them: paragraph properties (tab stops, then other children
// as markup) and text properties.
function paragraphMarkup(paragraph: ReadonlyMap<string, string>, tabs: string, others: string, text: ReadonlyMap<string, string>): string {
	const inner = `${tabs === "" ? "" : `<style:tab-stops>${tabs}</style:tab-stops>`}${others}`

	return `${paragraph.size === 0 && inner === "" ? "" : `<style:paragraph-properties${sortedAttributes(paragraph)}${inner === "" ? "/>" : `>${inner}</style:paragraph-properties>`}`}${textProperties(text)}`
}

// A style element read from the source as markup; undefined when a name is in no namespace the writer declares.
function elementMarkup(element: OdfElement): string | undefined {
	if (element.name.startsWith("{")) return undefined

	let out = `<${element.name}`

	for (const [name, value] of [...element.attributes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (name.startsWith("{")) return undefined

		out += ` ${name}="${esc(value)}"`
	}

	let inner = escText(element.text)

	for (const item of element.children) {
		const markup = elementMarkup(item)

		if (markup === undefined) return undefined

		inner += markup
	}

	return inner === "" ? `${out}/>` : `${out}>${inner}</${element.name}>`
}

// The markup the writer would give an existing automatic style (StyleRegistry's key): its attributes and properties;
// undefined for one whose properties it writes in no such form.
export function writtenForm(style: OdfStyle): { readonly attributes: string; readonly properties: string } | undefined {
	const attributes = new Map<string, string>()

	for (const [name, value] of style.attributes) {
		if (name === "style:name" || name === "style:family" || name === "style:display-name") continue

		attributes.set(name, value)
	}

	const text = style.properties.get("text")

	if (text !== undefined && text.children.length > 0) return undefined

	if (style.family === "text") {
		if (style.properties.size > (text === undefined ? 0 : 1)) return undefined

		return { attributes: sortedAttributes(attributes), properties: textProperties(text?.attributes ?? new Map()) }
	}

	if (style.family !== "paragraph") return undefined

	const paragraph = style.properties.get("paragraph")

	if (style.properties.size > (text === undefined ? 0 : 1) + (paragraph === undefined ? 0 : 1)) return undefined

	let tabs = ""
	let others = ""

	for (const item of paragraph?.children ?? []) {
		if (item.name === "style:tab-stops") {
			tabs = item.children
				.filter(stop => stop.name === "style:tab-stop")
				.map(stop => `<style:tab-stop${sortedAttributes(stop.attributes)}/>`)
				.join("")

			continue
		}

		const markup = elementMarkup(item)

		if (markup === undefined) return undefined

		others += markup
	}

	return {
		attributes: sortedAttributes(attributes),
		properties: paragraphMarkup(paragraph?.attributes ?? new Map(), tabs, others, text?.attributes ?? new Map())
	}
}

export class OdfEmitter {
	private readonly context: EmitContext
	// The span styles a written run may take: those the region's source paragraphs use.
	readonly spanNames = new Set<string>()
	private readonly styling = new Map<string, ParagraphStyling>()
	private readonly learning = runLearning()

	constructor(context: EmitContext) {
		this.context = context
	}

	// A property with no ODF form. A tracked formatting change is one: text:format-change records that formatting
	// changed, not the formatting it replaced (ODF 1.3 Part 3 §5.5.6 text:format-change), which the edit's w:rPrChange holds.
	private refuseProperty(kind: "run" | "paragraph", local: string): never {
		if (local === "rPrChange" || local === "pPrChange")
			this.refuse("tracked", "a tracked formatting change (ODF records no formatting a change replaced)")

		return this.refuse(kind, `the ${kind} property ${local}`)
	}

	private refuse(reason: string, message: string): never {
		throw new OdtWriteRefusal(reason, message)
	}

	// --- Blocks ---

	// Whether paragraphs written now get an xml:id of their own (the halves a split adds to a paragraph with one).
	freshIds = false

	// A run of body (or note, cell, header) blocks, lists formed from their numbering. `texts`: the source text a
	// paragraph takes after (its characters' span styles).
	blocks(document: XmlDocument, nodes: readonly number[], texts?: (node: number) => SourceText | undefined): string {
		this.nesting++

		try {
			return this.blockList(document, nodes, texts)
		} finally {
			this.nesting--
		}
	}

	// How deep in blocks() the emitter is: a top-level block is charged at 1, a top-level table's rows inside it.
	private nesting = 0

	// Text charged as it was written (`text`), so a block is charged only for the rest of its markup.
	private textCharged = 0

	private charge(build: () => string): string {
		const before = this.textCharged
		const markup = build()

		if (this.nesting === 1) this.context.spend?.(Math.max(0, markup.length - (this.textCharged - before)), markup.length)

		return markup
	}

	private blockList(document: XmlDocument, nodes: readonly number[], texts?: (node: number) => SourceText | undefined): string {
		let out = ""
		let list: { numId: string; target: ListTarget; depth: number } | undefined

		const close = (): void => {
			if (list === undefined) return

			out += "</text:list-item></text:list>".repeat(list.depth)
			list = undefined
		}

		for (const node of nodes) {
			const local = document.localName(node)

			if (local === "tbl") {
				close()
				out += this.context.table?.(document, node) ?? this.table(document, node)

				continue
			}

			if (local !== "p") {
				if (local === "bookmarkStart" || local === "bookmarkEnd" || local === "proofErr") continue

				this.refuse("unsupported", `a ${local} block`)
			}

			const numbering = this.numbering(document, node)

			if (numbering === undefined || numbering.target.outline) {
				close()
				out += this.charge(() =>
					this.paragraph(
						document,
						node,
						undefined,
						numbering?.target.outline === true ? numbering.ilvl : undefined,
						texts?.(node)
					)
				)

				continue
			}

			const depth = numbering.ilvl + 1

			if (list !== undefined && list.numId === numbering.numId) {
				if (depth > list.depth) {
					out += "<text:list><text:list-item>".repeat(depth - list.depth - 1)
					out += `<text:list>${this.item(numbering.numId, numbering.ilvl)}`
				} else {
					out += "</text:list-item></text:list>".repeat(list.depth - depth)
					out += `</text:list-item>${this.item(numbering.numId, numbering.ilvl)}`
				}

				list.depth = depth
			} else {
				close()

				const continued = this.continuation(numbering.numId, this.context.precedingList?.(document, node) ?? this.last)
				const mark = this.context.listIds.mark()

				if (!this.used.has(numbering.numId)) this.fresh.add(numbering.numId)

				out += `<text:list${this.context.declarations} text:style-name="${esc(numbering.target.style)}"${ListIds.markup(mark)}${continued}>`
				out += "<text:list-item><text:list>".repeat(depth - 1)
				out += this.item(numbering.numId, numbering.ilvl)
				list = { numId: numbering.numId, target: numbering.target, depth }
				this.marks.set(numbering.numId, mark)
			}

			this.lastList.set(numbering.target.style, numbering.numId)
			this.last = numbering.numId
			this.used.add(numbering.numId)
			out += this.charge(() => this.paragraph(document, node, undefined, undefined, texts?.(node)))
		}

		close()

		return out
	}

	// The last w:num each list style was written with, every w:num written, and the last list's: a list of a w:num met
	// before continues it.
	readonly lastList = new Map<string, string>()
	readonly used = new Set<string>()
	last: string | undefined
	// The mark of the last list this emitter wrote of each w:num.
	private readonly marks = new Map<string, number>()
	// W:nums first numbered by a list this emitter wrote, and their levels numbered so far.
	private readonly fresh = new Set<string>()
	private readonly levels = new Set<string>()

	// A list item's start tag: the first item of a level a w:num restarts (w:startOverride) starts at that value
	// (text:start-value, Part 3 §19.874), where the w:num is first numbered here.
	private item(numId: string, ilvl: number): string {
		const level = `${numId}\u0000${ilvl}`

		if (this.levels.has(level)) return "<text:list-item>"

		this.levels.add(level)

		const start = this.fresh.has(numId) ? this.context.levelStart(numId, ilvl) : undefined

		return start === undefined ? "<text:list-item>" : `<text:list-item text:start-value="${start}">`
	}

	// The xml:id of the last list of `numId` before what is written now: one this emitter wrote, or a kept source list.
	listIdOf(numId: string): string | undefined {
		const mark = this.marks.get(numId)

		return mark === undefined ? this.context.sourceListId(numId) : this.context.listIds.id(mark)
	}

	// text:continue-numbering continues the preceding list (Part 3 §19.786): it says so where that is the list
	// continued; otherwise text:continue-list names the list continued (§19.785), one this emitter wrote.
	private continuation(numId: string, preceding: string | undefined): string {
		if (!this.used.has(numId)) return ""
		if (preceding === numId) return ' text:continue-numbering="true"'

		if (!this.context.continuesLists)
			this.refuse(
				"list",
				"a list continuing one another list interrupts, in an ODF 1.0 or 1.1 document: text:list has only text:style-name and text:continue-numbering there (ODF 1.1 and 1.0 second edition §4.3.1); text:continue-list is new in ODF 1.2 (Part 1 §19.780, Appendix G.1)"
			)

		const id = this.listIdOf(numId)

		if (id !== undefined) return ` text:continue-list="${esc(id)}"`

		return this.refuse("list", "a list continuing one that another list interrupts")
	}

	private numbering(document: XmlDocument, paragraph: number): { numId: string; ilvl: number; target: ListTarget } | undefined {
		const pPr = child(document, paragraph, "pPr")
		const numPr = pPr < 0 ? -1 : child(document, pPr, "numPr")
		const styleId = pPr < 0 ? undefined : attributeOf(document, child(document, pPr, "pStyle"), "w:val")
		let numId: string | undefined
		let ilvl = 0

		if (numPr >= 0) {
			numId = attributeOf(document, child(document, numPr, "numId"), "w:val")
			ilvl = Number(attributeOf(document, child(document, numPr, "ilvl"), "w:val") ?? "0") || 0
		} else {
			const inherited = this.context.chains.paragraph(styleId).pPr.get("numPr")

			if (inherited !== undefined) this.refuse("list", "numbering a paragraph style gives")
		}

		if (numId === undefined || numId === "0") return undefined

		const target = this.context.list(numId)

		if (target === undefined) return this.refuse("list", `numbering ${numId}`)
		if (ilvl > 8 || ilvl < 0) return this.refuse("list", "a list level past nine")

		return { numId, ilvl, target }
	}

	// --- Paragraphs ---

	// A paragraph. `source`: the source paragraph it takes the place of. `heading`: the outline level (0-based) of
	// a heading numbered by the outline style. `text`: the source text its characters take their span styles from.
	paragraph(
		document: XmlDocument,
		node: number,
		source: ParagraphSource | undefined,
		heading: number | undefined,
		text?: SourceText
	): string {
		const context = this.context
		const pPr = child(document, node, "pPr")
		const markNode = pPr < 0 ? -1 : child(document, pPr, "rPr")
		const { props: mark, key: markKey } = this.runProps(document, markNode)

		if (pPr >= 0 && child(document, pPr, "pPrChange") >= 0) this.refuseProperty("paragraph", "pPrChange")

		const own = this.paragraphProps(document, pPr)
		const direct = this.listIndents(own.props)
		// Numbering is where the paragraph sits (its list), not how it looks: a source paragraph matches without it.
		const pPrKey = direct === own.props ? own.key : propsKey(withoutNumbering(direct))
		const outline = direct.get("outlineLvl")
		const level = heading ?? (outline === undefined ? undefined : Number(outline.attributes.get("val") ?? "9"))
		// A source paragraph in a list owes its indents to the list: its start tag reads the same in one only.
		const listed = direct.has("numPr")
		// Put in a list, a plain paragraph's own indents combine with the list's: its start tag fits only without them.
		const fits = (candidate: ParagraphSource | undefined): boolean =>
			candidate !== undefined &&
			candidate.pPr === pPrKey &&
			candidate.mark === markKey &&
			(listed ? candidate.listed || !pPrKey.includes("<ind") : !candidate.listed)
		// A paragraph starting a page style (its source style names a master page, Part 3 §19.501) keeps starting it.
		const sourceStyle = source?.styleName === undefined ? undefined : context.sheet.style("paragraph", source.styleName, context.scope)
		const master = context.masterOf(document, node) ?? (sourceStyle?.attributes.get("style:master-page-name") || undefined)
		const known =
			master !== undefined
				? undefined
				: fits(source)
					? source
					: context.paragraphSources.get(`${pPrKey}|${markKey}|${listed ? "listed" : "plain"}`)
		let element: "text:p" | "text:h"
		let attributes: [string, string][]
		let styleName: string | undefined
		let styling: ParagraphStyling

		if (known !== undefined) {
			element = known.element
			// Its own start tag keeps its ids (xml:id, Part 3 §19.920, and text:id): metadata naming the paragraph
			// still names it; another paragraph's start tag names that one.
			attributes = known.attributes
				.filter(([name]) => known === source || !/(^|:)id$/u.test(name))
				.map(([name, value]) => [name, value])
			styleName = known.styleName
			styling = this.stylingOf(styleName)
		} else {
			// A new paragraph's style follows from its properties alone: made once for each set of them.
			const cacheKey = source === undefined && master === undefined ? `${pPrKey}\u0000${markKey}` : undefined
			let made = cacheKey === undefined ? undefined : this.paragraphStyles.get(cacheKey)

			if (made === undefined) {
				made = this.paragraphStyle(direct, mark, source, master)

				if (cacheKey !== undefined) {
					if (this.paragraphStyles.size >= CACHE_LIMIT) this.paragraphStyles.clear()

					this.paragraphStyles.set(cacheKey, made)
				}
			}

			styleName = made.name
			styling = made.styling
			element = level !== undefined && level >= 0 && level < 9 ? "text:h" : "text:p"
			attributes = made.name === context.mapper.defaultParagraphStyle ? [] : [["text:style-name", made.name]]

			if (element === "text:h") attributes.push(["text:outline-level", String((level ?? 0) + 1)])
		}

		this.currentStyle = styleName

		const starts = this.startsBefore(document, node)
		const content = this.inline(document, node, styling, text === undefined ? undefined : mapText(text, wmlText(document, node)))

		const inner = `${starts}${content}`

		// A split's second half of a paragraph that had an id: an id of its own.
		if (this.freshIds && !attributes.some(([name]) => name === "xml:id"))
			attributes.push(["xml:id", context.registry.name("para", true)])

		return `<${element}${context.declarations}${attributeList(attributes)}${inner === "" ? "/>" : `>${inner}</${element}>`}`
	}

	private readonly paragraphStyles = new Map<string, { name: string; styling: ParagraphStyling }>()

	// Bookmarks started between blocks before a paragraph (the paragraph holding the start was deleted, Part 3
	// §6.2.1.3: a bookmark marks text): started at its start, the first paragraph after them.
	private readonly pendingStarts = new WeakMap<XmlDocument, Map<number, string[]>>()

	private startsBefore(document: XmlDocument, paragraph: number): string {
		let byParagraph = this.pendingStarts.get(document)

		if (byParagraph === undefined) {
			byParagraph = new Map()
			this.pendingStarts.set(document, byParagraph)

			const names: string[] = []
			const visit = (container: number): void => {
				for (let at = document.firstChildElement(container); at >= 0; at = document.nextSiblingElement(at)) {
					const local = document.localName(at)

					if (local === "bookmarkStart" && container !== paragraph) {
						const parentLocal = document.localName(container)

						if (parentLocal !== "p") {
							names.push(document.attribute(at, "w:name") ?? "")
							this.bookmarks.set(document.attribute(at, "w:id") ?? "", document.attribute(at, "w:name") ?? "")

							continue
						}
					}

					if (local === "p") {
						if (names.length > 0) byParagraph?.set(at, names.splice(0))
					} else if (local !== "r" && local !== "pPr" && local !== "rPr") visit(at)
				}
			}

			visit(document.documentElement())
		}

		const names = byParagraph.get(paragraph)

		return names === undefined ? "" : names.map(name => `<${this.markOf(name)}-start text:name="${esc(name)}"/>`).join("")
	}

	// A list paragraph without indents of its own, in a level that places its label from the paragraph's margin
	// (label-width-and-position, Part 3 §20.431): LibreOffice adds the style's margin to the level's, where
	// WordprocessingML takes the level's over the style's. Its indents as they show are written as its own.
	private listIndents(direct: Props): Props {
		const numPr = direct.get("numPr")

		if (numPr === undefined || direct.has("ind")) return direct

		const numId = /<numId val="([^"]*)">/u.exec(numPr.children)?.[1]
		const ilvl = Number(/<ilvl val="([^"]*)">/u.exec(numPr.children)?.[1] ?? "0")
		const target = numId === undefined ? undefined : this.context.list(numId)

		if (numId === undefined || target === undefined || target.outline) return direct

		const level = this.context.sheet.listStyle(target.style, this.context.scope)?.levels.get(ilvl + 1)

		if (level === undefined || levelGeometry(level).mode !== "label-width-and-position") return direct

		const styleId = direct.get("pStyle")?.attributes.get("val")
		const fromStyle = this.context.chains.paragraph(styleId).pPr.get("ind")
		const fromLevel = this.context.levelIndent(numId, ilvl)
		const attributes = new Map([...(fromStyle?.attributes ?? []), ...(fromLevel?.attributes ?? [])])

		return attributes.size > 0 ? new Map([...direct, ["ind", { attributes, children: "" }]]) : direct
	}

	private stylingOf(name: string | undefined): ParagraphStyling {
		const key = name ?? ""
		let styling = this.styling.get(key)

		if (styling === undefined) {
			styling = new ParagraphStyling(this.context, this.learning, name)
			this.styling.set(key, styling)
		}

		return styling
	}

	// A new automatic paragraph style for these properties: the source paragraph's style patched where its
	// properties changed, else written out from them.
	private paragraphStyle(
		direct: Props,
		mark: Props,
		source: ParagraphSource | undefined,
		master?: string
	): { name: string; styling: ParagraphStyling } {
		const context = this.context
		const styleId = direct.get("pStyle")?.attributes.get("val")
		const parent = styleId === undefined ? context.mapper.defaultParagraphStyle : context.paragraphStyle(styleId)

		if (styleId !== undefined && parent === undefined) this.refuse("styles", `the paragraph style ${styleId}`)

		const base = source?.styleName === undefined ? undefined : context.sheet.style("paragraph", source.styleName, context.scope)
		const automatic = base?.automatic === true ? base : undefined
		const paragraph = new Map<string, string>(automatic?.properties.get("paragraph")?.attributes ?? [])
		let tabs: string | undefined
		const sourceDirect = source === undefined ? new Map<string, PropertyValue>() : this.sourceProps(source.pPr)
		const marginLeft = Number(direct.get("ind")?.attributes.get("left") ?? "0") / 20
		const changed = new Set<string>()
		// Paragraph properties that are the style's text properties in ODF (hyphenation): undefined to remove.
		const paragraphText = new Map<string, string | undefined>()

		for (const local of new Set([...direct.keys(), ...sourceDirect.keys()])) {
			if (local === "pStyle" || local === "numPr" || local === "outlineLvl") continue

			const now = direct.get(local)
			const was = sourceDirect.get(local)

			// A list paragraph's indents come from its list: out of it, they are the paragraph's own.
			const fromList = local === "ind" && source?.listed === true && !direct.has("numPr")

			if (automatic !== undefined && now !== undefined && was !== undefined && sameValue(now, was) && !fromList) continue

			changed.add(local)

			for (const name of paragraphSources(local)) paragraph.delete(name)
			for (const name of paragraphTextSources(local)) paragraphText.set(name, undefined)

			if (local === "tabs") tabs = ""
			if (now === undefined) continue

			const written = paragraphAttributes(local, local === "ind" ? this.indentOf(styleId, now) : now, {
				tabsRelativeToIndent: context.tabsRelativeToIndent,
				marginLeft
			})

			if (written === undefined) this.refuseProperty("paragraph", local)

			for (const [name, value] of written.attributes) paragraph.set(name, value)
			for (const [name, value] of written.text ?? []) paragraphText.set(name, value)

			if (written.tabs !== undefined) tabs = written.tabs
		}

		if (automatic === undefined) {
			// A new style: every property written out.
			for (const [local, now] of direct) {
				if (changed.has(local) || local === "pStyle" || local === "numPr" || local === "outlineLvl") continue

				const written = paragraphAttributes(local, local === "ind" ? this.indentOf(styleId, now) : now, {
					tabsRelativeToIndent: context.tabsRelativeToIndent,
					marginLeft
				})

				if (written === undefined) this.refuseProperty("paragraph", local)

				for (const [name, value] of written.attributes) paragraph.set(name, value)
				for (const [name, value] of written.text ?? []) paragraphText.set(name, value)

				if (written.tabs !== undefined) tabs = written.tabs
			}
		}

		const sourceChildren = automatic?.properties.get("paragraph")?.children ?? []
		const sourceTabs = sourceChildren.find(item => item.name === "style:tab-stops")

		if (tabs === undefined && sourceTabs !== undefined) {
			tabs = sourceTabs.children
				.filter(stop => stop.name === "style:tab-stop")
				.map(stop => `<style:tab-stop${sortedAttributes(stop.attributes)}/>`)
				.join("")
		}

		// What else the source's paragraph properties hold (a drop cap, a background image: Part 3 §17.9, §17.3),
		// which no edit reaches, in schema order after the tab stops; a background image goes with a changed
		// background colour.
		let others = ""

		for (const item of sourceChildren) {
			if (item.name === "style:tab-stops") continue
			if (item.name === "style:background-image" && changed.has("shd")) continue

			const markup = elementMarkup(item)

			if (markup === undefined) this.refuse("paragraph", `the paragraph property ${item.name}`)

			others += markup
		}

		// Text properties: the paragraph mark's.
		const sourceMark = source === undefined ? new Map<string, PropertyValue>() : this.sourceProps(source.mark)
		const text = new Map<string, string>(automatic?.properties.get("text")?.attributes ?? [])
		const fontSize = this.fontSizeOf(styleId, mark)

		for (const local of new Set([...mark.keys(), ...sourceMark.keys()])) {
			const now = mark.get(local)
			const was = sourceMark.get(local)

			if (automatic !== undefined && now !== undefined && was !== undefined && sameValue(now, was)) continue

			for (const name of runSources(local)) text.delete(name)

			if (now === undefined) continue

			const written = runAttributes(local, now, context.fonts, fontSize)

			if (written === undefined) this.refuseProperty("run", local)

			for (const [name, value] of written) text.set(name, value)
		}

		if (automatic === undefined) {
			for (const [local, now] of mark) {
				const written = runAttributes(local, now, context.fonts, fontSize)

				if (written === undefined) this.refuseProperty("run", local)

				for (const [name, value] of written) text.set(name, value)
			}
		}

		const attributes = new Map<string, string>()

		for (const [name, value] of automatic?.attributes ?? []) {
			if (name === "style:name" || name === "style:family" || name === "style:parent-style-name" || name === "style:display-name")
				continue

			attributes.set(name, value)
		}

		if (parent !== undefined) attributes.set("style:parent-style-name", parent)

		if (master === "") attributes.delete("style:master-page-name")
		else if (master !== undefined) attributes.set("style:master-page-name", master)

		for (const [name, value] of paragraphText) {
			if (value === undefined) text.delete(name)
			else text.set(name, value)
		}

		const properties = paragraphMarkup(paragraph, tabs ?? "", others, text)

		// Nothing of its own: the common style itself.
		if (properties === "" && attributes.size <= 1 && parent !== undefined && master === undefined)
			return { name: parent, styling: this.stylingOf(parent) }

		const name = context.registry.style("paragraph", "P", sortedAttributes(attributes), properties)
		const resolvedText = new Map<string, string>()

		for (const [key, value] of text) resolvedText.set(key, value)

		return { name, styling: new ParagraphStyling(context, this.learning, name, resolvedText, this.fontSizeOf(styleId, mark)) }
	}

	// A paragraph's indents as they take effect: an ODF automatic style's indents are one item (the sides it leaves
	// out are 0), WordprocessingML's sides each fall back to the style's.
	private indentOf(styleId: string | undefined, direct: PropertyValue): PropertyValue {
		const inherited = this.context.chains.paragraph(styleId).pPr.get("ind")

		return inherited === undefined ? direct : { attributes: new Map([...inherited.attributes, ...direct.attributes]), children: "" }
	}

	private readonly sourceCache = new Map<string, Props>()

	// A props key back as props (keys are canonical: element names without prefix).
	private sourceProps(key: string): Props {
		let props = this.sourceCache.get(key)

		if (props === undefined) {
			props = new Map()

			const markup = key.replace(/<([a-zA-Z]+)((?: [a-zA-Z:]+="[^"]*")*)>/gu, (_match, local: string, attributes: string) => {
				return `<w:${local}${attributes.replace(/ ([a-zA-Z]+)=/gu, " w:$1=")}/>`
			})

			try {
				const document = parseXml(encodeUtf8(`<w:pPr xmlns:w="${W_NAMESPACE}">${markup}</w:pPr>`))

				readProps(document, document.documentElement(), props)
			} catch {
				props = new Map()
			}

			this.sourceCache.set(key, props)
		}

		return props
	}

	private fontSizeOf(styleId: string | undefined, rPr: Props): number {
		const size = rPr.get("sz") ?? this.context.chains.paragraph(styleId).rPr.get("sz")
		const value = Number(size?.attributes.get("val") ?? "24")

		return Number.isFinite(value) && value > 0 ? value / 2 : 12
	}

	// --- Inline content ---

	private inline(document: XmlDocument, paragraph: number, styling: ParagraphStyling, mapping: TextMapping | undefined): string {
		const state: InlineState = { trimLeading: true, out: "", open: "", offset: 0, mapping }

		this.content(document, paragraph, styling, state)
		this.closeSpan(state)

		return paragraphEnd(state)
	}

	private closeSpan(state: InlineState): void {
		if (state.open !== "") state.out += "</text:span>"

		state.open = ""
	}

	private content(document: XmlDocument, node: number, styling: ParagraphStyling, state: InlineState): void {
		for (let at = document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at)) {
			const local = document.localName(at)

			switch (local) {
				case "pPr":
				case "proofErr":
				case "lastRenderedPageBreak":
					break
				case "r":
					if (at === state.skip) {
						state.offset += document.textContent(at).length
						state.skip = -1
					} else this.run(document, at, styling, state)
					break
				case "hyperlink": {
					this.closeSpan(state)

					const id = document.attribute(at, "r:id")
					const anchor = document.attribute(at, "w:anchor")
					const href = id !== undefined ? this.context.hyperlink(id) : anchor !== undefined ? `#${anchor}` : undefined

					if (href === undefined) this.refuse("link", "a link without a target")

					const known = this.context.links.get(href)

					state.out += known ?? `<text:a xlink:type="simple" xlink:href="${esc(href)}">`
					this.content(document, at, styling, state)
					this.closeSpan(state)
					state.out += "</text:a>"
					break
				}
				case "fldSimple": {
					const instruction = (document.attribute(at, "w:instr") ?? "").trim().split(/\s+/u)[0]?.toUpperCase()
					const tag = instruction === "PAGE" ? "text:page-number" : instruction === "NUMPAGES" ? "text:page-count" : undefined

					if (tag === undefined) {
						// A cross-reference as the source has it, while its code and result stay; a current date or time
						// (DATE, TIME) whatever result an update gave it, shown as that.
						const atom = this.context.atoms.take(this.context.fieldKey(document, at))
						const live =
							atom === undefined && (instruction === "DATE" || instruction === "TIME")
								? this.context.atoms.take(`live:${(document.attribute(at, "w:instr") ?? "").trim().replace(/\s+/gu, " ")}`)
								: undefined
						const bytes =
							atom?.bytes ?? (live === undefined ? undefined : withContent(live.bytes, escText(document.textContent(at))))

						if (bytes === undefined) this.refuse("field", `the field ${instruction ?? ""}`)

						// In the style of its result's first run, as the span around it gave.
						this.openSpan(document, child(document, at, "r"), styling, state, state.offset++)
						state.out += bytes
						state.trimLeading = false
						break
					}

					// The field's shown text, in the style of its first run.
					const run = child(document, at, "r")

					this.openSpan(document, run, styling, state, state.offset++)
					state.out += `<${tag}${tag === "text:page-number" ? ' text:select-page="current"' : ""}>${escText(document.textContent(at))}</${tag}>`
					state.trimLeading = false
					break
				}
				case "bookmarkStart": {
					this.closeSpan(state)

					const name = document.attribute(at, "w:name") ?? ""
					const next = document.nextSiblingElement(at)

					if (
						next >= 0 &&
						document.localName(next) === "bookmarkEnd" &&
						document.attribute(next, "w:id") === document.attribute(at, "w:id")
					) {
						state.out += `<${this.markOf(name)} text:name="${esc(name)}"/>`
						at = next
					} else {
						this.bookmarks.set(document.attribute(at, "w:id") ?? "", name)
						state.out += `<${this.markOf(name)}-start text:name="${esc(name)}"/>`
					}

					break
				}
				case "bookmarkEnd": {
					this.closeSpan(state)

					const id = document.attribute(at, "w:id") ?? ""
					// A range started in another paragraph ends here: its name is the start's.
					const name = this.bookmarks.get(id) ?? this.context.bookmarkName(document, id)

					if (name !== undefined) state.out += `<${this.markOf(name)}-end text:name="${esc(name)}"/>`

					break
				}
				case "commentRangeStart": {
					this.closeSpan(state)
					state.offset++

					const id = document.attribute(at, "w:id") ?? ""
					const atom = this.context.atoms.take(this.context.commentKey(id))

					if (atom !== undefined) {
						state.out += atom.bytes

						if (atom.name !== undefined) this.annotationEnds.set(id, atom.name)
						else this.pointComments.add(id)
					} else {
						const next = document.nextSiblingElement(at)
						const point = next >= 0 && document.localName(next) === "commentRangeEnd" && document.attribute(next, "w:id") === id
						const range = this.newAnnotation(id, point)

						state.out += range.markup

						if (range.name !== undefined) this.annotationEnds.set(id, range.name)
						else this.pointComments.add(id)
					}

					break
				}
				case "commentRangeEnd": {
					this.closeSpan(state)

					const id = document.attribute(at, "w:id") ?? ""
					const name = this.annotationEnds.get(id)

					if (name !== undefined) state.out += `<office:annotation-end office:name="${esc(name)}"/>`
					else if (!this.pointComments.has(id)) this.refuse("comment", "a comment's end before its start")

					break
				}
				case "ins": {
					// A tracked insertion (Part 3 §5.5.4): its text between change marks, the change recorded in
					// text:tracked-changes.
					this.closeSpan(state)

					const id = this.context.change(
						"insertion",
						document.attribute(at, "w:author") ?? "",
						document.attribute(at, "w:date"),
						""
					)

					state.out += `<text:change-start text:change-id="${esc(id)}"/>`
					this.content(document, at, styling, state)
					this.closeSpan(state)
					state.out += `<text:change-end text:change-id="${esc(id)}"/>`
					break
				}
				case "del": {
					// A tracked deletion (§5.5.5): a change mark where the text was, the text in the change's record.
					this.closeSpan(state)

					const deleted: InlineState = { trimLeading: true, out: "", open: "", offset: 0, mapping: undefined }

					this.content(document, at, styling, deleted)
					this.closeSpan(deleted)
					deleted.out = paragraphEnd(deleted)

					const style = this.currentStyle === undefined ? "" : ` text:style-name="${esc(this.currentStyle)}"`
					const id = this.context.change(
						"deletion",
						document.attribute(at, "w:author") ?? "",
						document.attribute(at, "w:date"),
						`<text:p${style}>${deleted.out}</text:p>`
					)

					state.out += `<text:change text:change-id="${esc(id)}"/>`
					break
				}
				case "moveFrom":
				case "moveTo":
					throw new OdtWriteRefusal("trackedChange", "a tracked move (ODF records insertions, deletions and format changes)")
				default:
					this.refuse("unsupported", `${local} in a paragraph`)
			}
		}
	}

	private readonly bookmarks = new Map<string, string>()
	// The ODF style of the paragraph being written.
	private currentStyle: string | undefined

	// A WordprocessingML bookmark as the ODF mark it was read from: a reference mark (§6.2.2) where the source has one by
	// that name and no bookmark, else a bookmark.
	private markOf(name: string): string {
		return this.context.referenceMarks.has(name) && !this.context.sourceBookmarks.has(name) ? "text:reference-mark" : "text:bookmark"
	}
	private readonly annotationEnds = new Map<string, string>()
	private readonly pointComments = new Set<string>()

	// The span a run's content at character `at` (-1: none counted) is written in, opened unless it is open.
	private openSpan(document: XmlDocument, run: number, styling: ParagraphStyling, state: InlineState, at: number): void {
		const rPr = run < 0 ? -1 : child(document, run, "rPr")
		const { props, key } = this.runProps(document, rPr)
		const origin = this.originOf(document, run)

		this.toSpan(
			origin === undefined ? this.spanOf(props, key, styling, state.mapping, at) : this.spanOf(props, key, styling, origin, 0),
			state
		)
	}

	// A paragraph's own properties and the key of them without numbering, by the pPr's bytes. Read only.
	private readonly paragraphPropsCache = new ByteKeyMap<{ readonly props: Props; readonly key: string }>(CACHE_LIMIT)

	private paragraphProps(document: XmlDocument, pPr: number): { readonly props: Props; readonly key: string } {
		const raw = pPr < 0 ? NO_BYTES : document.raw(pPr)
		let known = this.paragraphPropsCache.get(raw)

		if (known === undefined) {
			const props = propsOf(document, pPr, PARAGRAPH_SKIPPED)

			known = { props, key: propsKey(withoutNumbering(props)) }

			this.paragraphPropsCache.set(raw, known)
		}

		return known
	}

	// A run's properties and their key, by the rPr's bytes (documents repeat a few run property sets). Read only.
	private readonly runPropsCache = new ByteKeyMap<{ readonly props: Props; readonly key: string }>(CACHE_LIMIT)

	private runProps(document: XmlDocument, rPr: number): { readonly props: Props; readonly key: string } {
		const raw = rPr < 0 ? NO_BYTES : document.raw(rPr)
		let known = this.runPropsCache.get(raw)

		if (known === undefined) {
			const props = propsOf(document, rPr)

			known = { props, key: propsKey(props) }

			this.runPropsCache.set(raw, known)
		}

		return known
	}

	// The source span a run came from, where the translation named it on the run (w:rsidR, see Translator): its
	// characters are that span's whatever was edited around them.
	private originOf(document: XmlDocument, run: number): TextMapping | undefined {
		const value = run < 0 ? undefined : document.attribute(run, "w:rsidR")
		const style = value === undefined ? undefined : this.context.originStyle?.(value)

		return style === undefined ? undefined : { styles: [style], aligned: ALIGNED }
	}

	private toSpan(name: string, state: InlineState): void {
		if (name === state.open) return

		this.closeSpan(state)

		if (name === "") return

		state.open = name
		state.out += `<text:span text:style-name="${esc(name)}">`
	}

	// The span style ("" for none) giving text the run properties `props` (`key`): the source span style of the
	// character at `at` where it gives them, or patched where they changed; else one giving them.
	private spanOf(props: Props, key: string, styling: ParagraphStyling, mapping: TextMapping | undefined, at: number): string {
		const mapped = mapping === undefined || at < 0 ? null : mapping.styles[at]
		// A span the translation names on its runs (originOf): a character of a run not naming it is none of its.
		const style =
			mapped !== null && mapped !== undefined && mapping?.origins === true && this.context.tracksOrigin?.(mapped) === true
				? null
				: mapped

		if (style !== null && style !== undefined && mapping !== undefined) {
			if (styling.keyOf(style) === key) return style
			if (mapping.aligned[at] === 1) {
				const patched = this.patchedSpan(style, props, key, styling)

				if (patched !== undefined) return patched
			}
		}

		if (key === styling.baseKey) return ""

		return styling.span(key, this.spanNames) ?? this.spanStyle(props, styling, key)
	}

	private readonly patched = new Map<string, string | undefined>()

	// A source automatic span style patched where the run properties differ from what it gave: what it says beyond
	// them (properties WordprocessingML has no form for) stays. Undefined when it is no automatic style, or its
	// character style changed.
	private patchedSpan(style: string, props: Props, key: string, styling: ParagraphStyling): string | undefined {
		const cacheKey = `${styling.baseKey}\u0000${styling.fontSize}\u0000${style}\u0000${key}`

		if (this.patched.has(cacheKey)) return this.patched.get(cacheKey)

		const context = this.context
		const source = context.sheet.style("text", style, context.scope)
		let name: string | undefined

		if (source?.automatic === true) {
			const was = styling.propsOf(style)
			const styleId = props.get("rStyle")?.attributes.get("val")

			if (styleId === was.get("rStyle")?.attributes.get("val")) {
				const attributes = new Map<string, string>(source.properties.get("text")?.attributes ?? [])
				const fontSize = Number(props.get("sz")?.attributes.get("val") ?? "NaN") / 2 || styling.fontSize

				for (const local of new Set([...props.keys(), ...was.keys()])) {
					if (local === "rStyle") continue

					const now = props.get(local)
					const before = was.get(local)

					if (now !== undefined && before !== undefined && sameValue(now, before)) continue

					for (const item of runSources(local)) attributes.delete(item)

					let written: ReadonlyMap<string, string> | readonly (readonly [string, string])[] | undefined

					if (now !== undefined) written = runAttributes(local, now, context.fonts, fontSize)
					else if (styling.base.has(local)) {
						// What shows without it: the character style's or the paragraph style's value, or nothing.
						const inherited = context.chains.character(styleId).get(local) ?? context.chains.paragraph(undefined).rPr.get(local)

						written = neutralRun(local, context.fonts, inherited, fontSize)
					} else written = []

					if (written === undefined) this.refuseProperty("run", local)

					for (const [item, value] of written) attributes.set(item, value)
				}

				const own = new Map<string, string>()

				for (const [item, value] of source.attributes) {
					if (item === "style:name" || item === "style:family" || item === "style:display-name") continue

					own.set(item, value)
				}

				name =
					attributes.size === 0 && own.size === 0
						? key === styling.baseKey
							? ""
							: undefined
						: context.registry.style("text", "T", sortedAttributes(own), textProperties(attributes))
			}
		}

		this.patched.set(cacheKey, name)

		return name
	}

	// A new automatic text style giving `props` over the paragraph's own text properties.
	private readonly spanStyles = new Map<string, string>()

	private spanStyle(props: Props, styling: ParagraphStyling, key: string): string {
		const cacheKey = `${styling.baseKey}\u0000${String(styling.fontSize)}\u0000${key}`
		let name = this.spanStyles.get(cacheKey)

		if (name === undefined) {
			name = this.newSpanStyle(props, styling)

			if (this.spanStyles.size >= CACHE_LIMIT) this.spanStyles.clear()

			this.spanStyles.set(cacheKey, name)
		}

		return name
	}

	private newSpanStyle(props: Props, styling: ParagraphStyling): string {
		const context = this.context
		const attributes = new Map<string, string>()
		const styleId = props.get("rStyle")?.attributes.get("val")
		const parent = styleId === undefined ? undefined : context.characterStyle(styleId)

		if (styleId !== undefined && parent === undefined) this.refuse("styles", `the character style ${styleId}`)

		const fontSize = Number(props.get("sz")?.attributes.get("val") ?? "NaN") / 2 || styling.fontSize
		const base = styling.base

		for (const [local, value] of props) {
			const known = base.get(local)

			if (known !== undefined && sameValue(known, value)) continue

			const written = runAttributes(local, value, context.fonts, fontSize)

			if (written === undefined) this.refuseProperty("run", local)

			for (const [name, item] of written) attributes.set(name, item)
		}

		for (const [local] of base) {
			if (props.has(local) || local === "rStyle") continue

			// What shows without it: the character style's or the paragraph style's value, or nothing.
			const inherited = context.chains.character(styleId).get(local) ?? context.chains.paragraph(undefined).rPr.get(local)
			const written = neutralRun(local, context.fonts, inherited, fontSize)

			if (written === undefined) this.refuse("run", `turning off the run property ${local}`)

			for (const [name, item] of written) attributes.set(name, item)
		}

		return context.registry.style(
			"text",
			"T",
			parent === undefined ? "" : ` style:parent-style-name="${esc(parent)}"`,
			textProperties(attributes)
		)
	}

	private run(document: XmlDocument, run: number, styling: ParagraphStyling, state: InlineState): void {
		for (let at = document.firstChildElement(run); at >= 0; at = document.nextSiblingElement(at)) {
			const local = document.localName(at)

			switch (local) {
				case "rPr":
				case "lastRenderedPageBreak":
					break
				case "t":
				case "delText":
					this.runText(document, run, document.textContent(at), styling, state)
					break
				case "tab":
					this.openSpan(document, run, styling, state, state.offset++)
					state.out += "<text:tab/>"
					state.trimLeading = false
					break
				case "br": {
					const type = document.attribute(at, "w:type")

					if (type !== undefined && type !== "textWrapping") this.refuse("break", `a ${type} break in a paragraph`)

					this.openSpan(document, run, styling, state, state.offset++)
					state.out += "<text:line-break/>"
					state.trimLeading = false
					break
				}
				case "cr":
					this.openSpan(document, run, styling, state, state.offset++)
					state.out += "<text:line-break/>"
					state.trimLeading = false
					break
				case "softHyphen":
					this.openSpan(document, run, styling, state, state.offset++)
					state.out += "­"
					state.trimLeading = false
					break
				case "noBreakHyphen":
					this.openSpan(document, run, styling, state, state.offset++)
					state.out += "‑"
					state.trimLeading = false
					break
				case "drawing": {
					const atom = this.context.atoms.take(this.context.drawingKey(document, at))

					// Inside the run's span: a frame in a span takes its text properties (Part 3 §6.1.7).
					this.openSpan(document, run, styling, state, state.offset++)

					// A text box the edit wrote into: its frame as the source has it, its text written anew; a picture
					// the edit made or changed: a frame of its own.
					const box = atom === undefined ? this.textBox(document, at) : undefined

					state.out += atom?.bytes ?? box ?? this.context.picture(document, at)
					state.trimLeading = false
					break
				}
				case "ruby": {
					// Text with its guide text above (Part 3 §6.4): the base's runs as spans, the guide its text; a note in
					// the base after the ruby.
					const base = child(document, at, "rubyBase")
					const guide = child(document, at, "rt")
					const inner: InlineState = { trimLeading: false, out: "", open: "", offset: 0, mapping: undefined, deferred: [] }

					this.closeSpan(state)

					if (base >= 0) this.content(document, base, styling, inner)

					this.closeSpan(inner)
					state.out += `<text:ruby><text:ruby-base>${inner.out}</text:ruby-base><text:ruby-text>${escText(guide < 0 ? "" : document.textContent(guide))}</text:ruby-text></text:ruby>${(inner.deferred ?? []).join("")}`
					state.trimLeading = false
					break
				}
				case "footnoteReference":
				case "endnoteReference": {
					const kind = local === "footnoteReference" ? "footnote" : "endnote"
					const id = document.attribute(at, "w:id") ?? ""
					const atom = this.context.atoms.take(this.context.noteKey(kind, id))
					// A custom mark (w:customMarkFollows) is the text after the reference in its run, else the next run's:
					// the note citation's text:label (Part 3 §6.3.4), consumed.
					const mark =
						document.attribute(at, "w:customMarkFollows") === "1"
							? this.customMark(document, run, at, state)
							: { text: "", own: false }
					const label = mark.text === "" ? undefined : mark.text

					this.closeSpan(state)
					state.offset++

					const notes = this.context.notes
					const shown = notes?.citation(kind, id)
					const markup =
						atom !== undefined
							? atom.bytes
							: notes !== undefined && (notes.depth > 0 || this.context.scope === "styles")
								? escText(
										flattenedNote(
											(noteKind, noteId) => this.context.note(noteKind, noteId),
											kind,
											id,
											label ?? "",
											() => this.context.lose?.("nestedNote"),
											new Set(notes.open)
										)
									)
								: shown !== undefined
									? noteReference(kind, id, shown)
									: this.newNote(kind, id, label)

					if (state.deferred !== undefined) state.deferred.push(markup)
					else state.out += markup

					state.trimLeading = false

					if (mark.own) return

					break
				}
				case "commentReference":
					break
				case "footnoteRef":
				case "endnoteRef":
				case "annotationRef":
					// A note's own number at the start of its text (the translator writes it), a comment's mark in its text.
					break
				default:
					this.refuse("unsupported", `${local} in a run`)
			}
		}
	}

	// A run's text, each stretch in the span its characters take.
	private runText(document: XmlDocument, run: number, text: string, styling: ParagraphStyling, state: InlineState): void {
		const mapping = state.mapping

		if (mapping === undefined || this.originOf(document, run) !== undefined) {
			state.offset += mapping === undefined ? 0 : text.length
			this.openSpan(document, run, styling, state, -1)
			this.text(text, state)

			return
		}

		const rPr = run < 0 ? -1 : child(document, run, "rPr")
		const { props, key } = this.runProps(document, rPr)
		const from = state.offset
		let start = 0
		let name = ""

		state.offset += text.length

		for (let k = 0; k < text.length; k++) {
			const at = from + k
			const next =
				k > 0 && mapping.styles[at] === mapping.styles[at - 1] && mapping.aligned[at] === mapping.aligned[at - 1]
					? name
					: this.spanOf(props, key, styling, mapping, at)

			if (k > 0 && next !== name) {
				this.toSpan(name, state)
				this.text(text.slice(start, k), state)
				start = k
			}

			name = next
		}

		if (start < text.length) {
			this.toSpan(name, state)
			this.text(text.slice(start), state)
		}
	}

	// A custom mark's text: after the reference in its run, else the next run's when that holds text only (its text and
	// tabs, as LibreOffice reads them); "" for none, which is numbered as LibreOffice numbers it.
	// `own`: the mark is the rest of the reference's run (consumed with it).
	private customMark(document: XmlDocument, run: number, reference: number, state: InlineState): { text: string; own: boolean } {
		const own = markText(document, reference)

		if (own !== undefined && own !== "") {
			state.offset += own.length

			return { text: own, own: true }
		}

		const next = document.nextSiblingElement(run)
		const text = next >= 0 && document.localName(next) === "r" ? markText(document, -1, next) : undefined

		if (text === undefined || text === "") return { text: "", own: false }

		state.skip = next

		return { text, own: false }
	}

	// Text with ODF's whitespace rule (Part 3 §6.1.2): runs of spaces as text:s past the first, a leading one too.
	private text(text: string, state: InlineState): void {
		let out = ""
		let spaces = 0
		const flush = (): void => {
			if (spaces === 0) return

			if (state.trimLeading) {
				out += spaces === 1 ? "<text:s/>" : `<text:s text:c="${spaces}"/>`
				state.trimLeading = false
			} else {
				state.space = state.out.length + out.length
				out += " "

				if (spaces > 1) {
					out += spaces === 2 ? "<text:s/>" : `<text:s text:c="${spaces - 1}"/>`
					state.trimLeading = false
				} else state.trimLeading = true
			}

			spaces = 0
		}

		for (let at = 0; at < text.length;) {
			const code = text.charCodeAt(at)

			if (code === 0x20) {
				spaces++
				at++

				continue
			}

			flush()

			// Charged as it grows: a block of text never outgrows the budget before it is refused.
			if (out.length > 65_536) {
				state.out += out
				this.textCharged += out.length
				this.context.spend?.(out.length, state.out.length)
				out = ""
			}

			state.trimLeading = false

			if (code === 0x09) {
				out += "<text:tab/>"
				at++
			} else if (code === 0x0a || code === 0x0d) {
				out += "<text:line-break/>"
				at++
			} else {
				// A stretch without spaces, tabs or line ends, escaped at once (at most 64 Ki units, a surrogate pair whole).
				let end = at + 1

				while (end < text.length && end - at < 65_536) {
					const next = text.charCodeAt(end)

					if (next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d) break

					end++
				}

				if (end < text.length && end - at >= 65_536 && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--

				out += escText(text.slice(at, end))
				at = end
			}
		}

		flush()
		state.out += out
		this.textCharged += out.length
		this.context.spend?.(out.length, state.out.length)
	}

	// --- Notes and comments ---

	private newNote(kind: "footnote" | "endnote", id: string, label: string | undefined): string {
		const note = this.context.note(kind, id)

		if (note === undefined) return this.refuse("note", "a note without content")

		const blocks: number[] = []

		for (let at = note.document.firstChildElement(note.node); at >= 0; at = note.document.nextSiblingElement(at)) blocks.push(at)

		const notes = this.context.notes
		const written = notes?.size ?? 0

		// Counted written before its body: a reference to it inside its own body is a text:note-ref.
		notes?.add(kind, id, label)

		let body: string

		if (notes !== undefined) {
			notes.depth++
			notes.open.add(`${kind}:${id}`)
		}

		try {
			body = this.storyBlocks(note.document, blocks, true)
		} catch (error) {
			notes?.rollback(written)

			throw error
		} finally {
			if (notes !== undefined) {
				notes.depth--
				notes.open.delete(`${kind}:${id}`)
			}
		}

		return `<text:note text:note-class="${kind}"${notes === undefined ? "" : ` text:id="${esc(noteId(kind, id))}"`}><text:note-citation${label === undefined ? "" : ` text:label="${esc(label)}"`}>${escText(label ?? "")}</text:note-citation><text:note-body>${body}</text:note-body></text:note>`
	}

	// A changed text box: the source frame its shell matches, its draw:text-box holding the edit's blocks (Part 3
	// §10.4.3); undefined when no source frame matches.
	private textBox(document: XmlDocument, drawing: number): string | undefined {
		const content = descendant(document, drawing, "txbxContent")

		if (content < 0) return undefined

		const shell = this.context.atoms.take(this.context.shellKey(document, drawing))

		if (shell === undefined) return undefined

		const open = /<([A-Za-z0-9_.-]+:)?text-box\b[^>]*?(\/?)>/u.exec(shell.bytes)

		if (open === null) this.refuse("drawing", "a text box the source does not hold as one")

		const prefix = open[1] ?? ""
		const blocks: number[] = []

		for (let child = document.firstChildElement(content); child >= 0; child = document.nextSiblingElement(child)) blocks.push(child)

		const markup = this.blocks(document, blocks)
		const start = open.index + open[0].length

		if (open[2] === "/")
			return `${shell.bytes.slice(0, open.index)}${open[0].slice(0, -2)}>${markup}</${prefix}text-box>${shell.bytes.slice(start)}`

		const end = shell.bytes.lastIndexOf(`</${prefix}text-box>`)

		if (end < start) this.refuse("drawing", "a text box the source does not hold as one")

		return `${shell.bytes.slice(0, start)}${markup}${shell.bytes.slice(end)}`
	}

	// A new comment as office:annotation (Part 3 §14.1), named when it marks a range: office:name and
	// office:annotation-end (§14.2) are new in ODF 1.2, so an ODF 1.0 or 1.1 annotation marks a point. Its author's
	// initials are meta:creator-initials, new in ODF 1.3; before it, LibreOffice's own loext:sender-initials, which
	// LibreOffice and the translator read: a foreign element (ODF 1.2 Part 1 §3.17, ODF 1.1 §1.5) whose content
	// office:process-content false keeps out of the annotation's text for any other reader.
	private newAnnotation(id: string, point: boolean): { markup: string; name: string | undefined } {
		const comment = this.context.comment(id)

		if (comment === undefined) return this.refuse("comment", "a comment without content")
		if (!point && (this.context.version ?? 1.3) < 1.2)
			return this.refuse("comment", "a comment over a range (ODF 1.0 and 1.1 annotations mark a point)")

		const { document, node } = comment
		const author = document.attribute(node, "w:author") ?? ""
		const date = document.attribute(node, "w:date")
		const initials = document.attribute(node, "w:initials")
		const blocks: number[] = []

		for (let at = document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at)) blocks.push(at)

		const name = point ? undefined : this.context.registry.name("__Annotation__", true)
		const notes = this.context.notes
		let body: string

		if (notes !== undefined) notes.depth++

		try {
			body = this.storyBlocks(document, blocks, false)
		} finally {
			if (notes !== undefined) notes.depth--
		}

		return {
			markup: `<office:annotation${name === undefined ? "" : ` office:name="${esc(name)}"`}><dc:creator>${escText(author)}</dc:creator>${date === undefined ? "" : `<dc:date>${escText(date.replace(/Z$/u, ""))}</dc:date>`}${initials === undefined ? "" : (this.context.version ?? 1.3) >= 1.3 ? `<meta:creator-initials>${escText(initials)}</meta:creator-initials>` : `<loext:sender-initials office:process-content="false" xmlns:loext="${OdfNs.loext}">${escText(initials)}</loext:sender-initials>`}${body}</office:annotation>`,
			name
		}
	}

	// A story's blocks (a note's or comment's). In a note, the reference the translator puts first is left out.
	private storyBlocks(document: XmlDocument, blocks: readonly number[], note: boolean): string {
		if (!note) return this.blocks(document, blocks)

		const first = blocks[0]

		if (first === undefined || document.localName(first) !== "p") return this.blocks(document, blocks)

		// The translator starts a note's first paragraph with its number and a space: those are not the note's text.
		const markup = decodeUtf8(document.raw(first))
		const stripped = markup.replace(
			/^(<[^>]*:p\b[^>]*>(?:<[^>]*:pPr\b[\s\S]*?<\/[^>]*:pPr>)?)<[^>]*:r>(?:<[^>]*:rPr>[\s\S]*?<\/[^>]*:rPr>)?<[^>]*:(?:footnoteRef|endnoteRef|t)\b[^>]*\/?>(?:[^<]*<\/[^>]*:t>)?<\/[^>]*:r><[^>]*:r><[^>]*:t[^>]*> <\/[^>]*:t><\/[^>]*:r>/u,
			"$1"
		)
		const reparsed = parseXml(
			encodeUtf8(
				`<w:root xmlns:w="${W_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${stripped}</w:root>`
			)
		)
		const root = reparsed.documentElement()
		const head = this.blocks(reparsed, [reparsed.firstChildElement(root)])

		return head + this.blocks(document, blocks.slice(1))
	}

	// --- Tables ---

	// A new table (Part 3 §9.1): its width and columns from its grid (ODF columns have fixed widths), its alignment,
	// each cell's borders, padding, shading and alignment as they show (tables.ts), header rows first.
	private table(document: XmlDocument, table: number): string {
		const effective = effectiveTable(document, table, this.context.chains)
		let out = this.tableOpening(document, table, effective)
		const header = effective.rows.findIndex(
			row => row.trPr.get("tblHeader") === undefined || row.trPr.get("tblHeader")?.attributes.get("val") === "off"
		)
		const headers = header < 0 ? effective.rows.length : header

		effective.rows.forEach((_row, index) => {
			if (index === 0 && headers > 0) out += "<table:table-header-rows>"

			out += this.charge(() => this.newRow(document, effective, index))

			if (index === headers - 1) out += "</table:table-header-rows>"
		})

		return `${out}</table:table>`
	}

	// A new table's start (Part 3 §9.1): its width and columns from its grid (ODF columns have fixed widths), its
	// alignment.
	private tableOpening(document: XmlDocument, table: number, effective: EffectiveTable): string {
		const context = this.context

		// ODF's form for a table style, table:table-template, has first and last rows and columns, odd and even rows and
		// columns, body and background only: no corner cells (w:tblStylePr nwCell...) and no band sizes.
		if (context.chains.conditional(effective.tblPr.get("tblStyle")?.attributes.get("val")))
			this.refuse("table", "a table style's conditional formatting (ODF table templates have no corner cells or band sizes)")
		if (effective.grid.length === 0 || effective.grid.length > 63) this.refuse("table", "a table without columns or past 63 of them")

		const jc = effective.tblPr.get("jc")?.attributes.get("val") ?? "left"
		const align = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : "left"
		const indent = effective.tblPr.get("tblInd")
		const width = effective.grid.reduce((sum, column) => sum + column, 0)
		const shd = effective.tblPr.get("shd")?.attributes.get("fill")
		let properties = ` style:width="${round(width / 20)}pt" table:align="${align}"`

		if (align === "left" && indent !== undefined && (indent.attributes.get("type") ?? "dxa") === "dxa")
			properties += ` fo:margin-left="${round(Number(indent.attributes.get("w") ?? "0") / 20)}pt"`
		if (shd !== undefined && shd !== "auto" && /^[0-9a-fA-F]{6}$/u.test(shd))
			properties += ` fo:background-color="#${shd.toLowerCase()}"`

		// A table that starts a page style (a section break before it).
		const master = context.masterOf(document, table)
		const tableStyle = context.registry.style(
			"table",
			"Table",
			master === undefined || master === "" ? "" : ` style:master-page-name="${esc(master)}"`,
			`<style:table-properties${properties}/>`
		)
		let out = `<table:table${context.declarations} table:name="${esc(context.registry.name("Table", true))}" table:style-name="${esc(tableStyle)}">`

		for (const column of effective.grid) {
			const columnStyle = context.registry.style(
				"table-column",
				"TableColumn",
				"",
				`<style:table-column-properties style:column-width="${round(column / 20)}pt"/>`
			)

			out += `<table:table-column table:style-name="${esc(columnStyle)}"/>`
		}

		return out
	}

	// --- A table written in pieces (a long one: its rows lowered and written a few at a time) ---

	// The table's start: its style and columns (refused as `table` is), and the state its rows are written with.
	tableStart(document: XmlDocument, table: number, total: number): { readonly markup: string; readonly state: TableStream } {
		const effective = effectiveTable(document, table, this.context.chains, { offset: 0, total })
		const markup = this.tableOpening(document, table, effective)

		return {
			markup,
			state: { total, columns: effective.grid.length, header: false, body: false, merges: new Map(), spans: new Map(), next: 0 }
		}
	}

	// The rows `table` holds (rows `offset`... of the whole), each written by `row` (a refused one written otherwise).
	tableRows(
		document: XmlDocument,
		table: number,
		offset: number,
		state: TableStream,
		row: (write: () => StreamedRow, node: number) => void
	): void {
		const effective = effectiveTable(document, table, this.context.chains, { offset, total: state.total })

		// Each row charged as a top-level block's is.
		this.nesting++

		try {
			effective.rows.forEach((item, index) =>
				row(() => {
					let written: StreamedRow = { markup: "", slots: [] }

					this.charge(() => {
						written = this.streamedRow(document, effective, index, state)

						return written.markup
					})

					return written
				}, item.node)
			)
		} finally {
			this.nesting--
		}
	}

	private streamedRow(document: XmlDocument, table: EffectiveTable, index: number, state: TableStream): StreamedRow {
		const row = table.rows[index]

		if (row === undefined) return { markup: "", slots: [] }

		const slots: { at: number; id: number }[] = []

		// The spans down as this row leaves them, and those it closes: the state takes them once it is written.
		const merges = new Map(state.merges)
		const closed: [number, number][] = []
		let next = state.next
		let out = `<table:table-row${this.rowStyleAttribute(row.trPr)}>`

		for (const cell of row.cells) {
			const merge = cell.props.get("vMerge")
			const open = merges.get(cell.column)

			if (merge !== undefined && merge.attributes.get("val") !== "restart") {
				out += "<table:covered-table-cell/>".repeat(cell.span)

				if (open !== undefined) merges.set(cell.column, { id: open.id, rows: open.rows + 1 })

				continue
			}

			if (open !== undefined) {
				closed.push([open.id, open.rows])
				merges.delete(cell.column)
			}

			// A cell spanning down: its start tag's slot for the span, filled in once the span is known.
			const slot = merge === undefined ? undefined : next

			if (slot !== undefined) {
				merges.set(cell.column, { id: slot, rows: 1 })
				next++
			}

			out += this.cellMarkup(document, cell.node, this.cellStyle(cell.props), cell.span, 1, at => {
				if (slot !== undefined) slots.push({ at: out.length + at, id: slot })
			})
		}

		out += "</table:table-row>"

		const header = row.trPr.get("tblHeader") !== undefined && row.trPr.get("tblHeader")?.attributes.get("val") !== "off" && !state.body
		const prefix = header && !state.header ? "<table:table-header-rows>" : !header && state.header ? "</table:table-header-rows>" : ""

		state.header = header
		state.body ||= !header
		state.next = next
		state.merges.clear()

		for (const [column, item] of merges) state.merges.set(column, item)
		for (const [id, rows] of closed) state.spans.set(id, rows)

		return { markup: prefix + out, slots: slots.map(slot => ({ at: slot.at + prefix.length, id: slot.id })) }
	}

	// Before a row written otherwise: the header rows end, and the cells spanning down stop spanning.
	tableInterrupt(state: TableStream): string {
		const out = state.header ? "</table:table-header-rows>" : ""

		state.header = false
		state.body = true

		for (const open of state.merges.values()) state.spans.set(open.id, open.rows)

		state.merges.clear()

		return out
	}

	// Whether the rows written so far hold no span still open: their markup is final (`tableResolve`).
	tableSettled(state: TableStream): boolean {
		return state.merges.size === 0
	}

	// Written rows with each cell's span down written into its slot (by offset in `markup`, in order; none for one row).
	tableResolve(markup: string, slots: readonly { readonly at: number; readonly id: number }[], state: TableStream): string {
		let out = ""
		let from = 0

		for (const { at, id } of slots) {
			const rows = state.spans.get(id) ?? 1

			state.spans.delete(id)
			out += markup.slice(from, at)

			if (rows > 1) out += ` table:number-rows-spanned="${String(rows)}"`

			from = at
		}

		return out + markup.slice(from)
	}

	tableEnd(state: TableStream): string {
		return `${this.tableInterrupt(state)}</table:table>`
	}

	// A row of a new table, each cell's style from the properties it shows.
	private newRow(document: XmlDocument, table: ReturnType<typeof effectiveTable>, index: number): string {
		const row = table.rows[index]

		if (row === undefined) return ""

		let out = `<table:table-row${this.rowStyleAttribute(row.trPr)}>`

		for (const cell of row.cells) {
			const merge = cell.props.get("vMerge")

			if (merge !== undefined && merge.attributes.get("val") !== "restart") {
				out += "<table:covered-table-cell/>".repeat(cell.span)

				continue
			}

			let rows = 1

			if (merge !== undefined) {
				for (let next = index + 1; next < table.rows.length; next++) {
					const below = table.rows[next]?.cells.find(item => item.column === cell.column)
					const continued = below?.props.get("vMerge")

					if (continued === undefined || continued.attributes.get("val") === "restart") break

					rows++
				}
			}

			out += this.cellMarkup(document, cell.node, this.cellStyle(cell.props), cell.span, rows)
		}

		return `${out}</table:table-row>`
	}

	private rowStyleAttribute(trPr: Props): string {
		const attributes: string[] = []

		for (const [local, value] of trPr) {
			if (local === "trHeight") {
				const rule = value.attributes.get("hRule") ?? "atLeast"
				const points = round(Number(value.attributes.get("val") ?? "0") / 20)

				attributes.push(rule === "exact" ? ` style:row-height="${points}pt"` : ` style:min-row-height="${points}pt"`)
			} else if (local === "cantSplit") {
				if (value.attributes.get("val") !== "off") attributes.push(' fo:keep-together="always"')
			} else if (local !== "tblHeader" && local !== "cnfStyle" && local !== "jc") {
				this.refuse("table", `the row property ${local}`)
			}
		}

		if (attributes.length === 0) return ""

		const name = this.context.registry.style("table-row", "TableRow", "", `<style:table-row-properties${attributes.sort().join("")}/>`)

		return ` table:style-name="${esc(name)}"`
	}

	// A cell style giving what a cell shows: its borders, padding, shading, vertical alignment and writing direction.
	// Cell styles by the effective cell properties (effectiveTable shares one Props among the cells that show alike).
	private readonly cellStyles = new WeakMap<Props, string>()

	cellStyle(props: Props): string {
		let name = this.cellStyles.get(props)

		if (name === undefined) {
			name = this.newCellStyle(props)
			this.cellStyles.set(props, name)
		}

		return name
	}

	private newCellStyle(props: Props): string {
		const attributes = new Map<string, string>()

		for (const [local, value] of props) {
			switch (local) {
				case "gridSpan":
				case "vMerge":
				case "tcW":
				case "cnfStyle":
				case "hideMark":
					break
				case "tcBorders": {
					const borders = borderAttributes(value.children, false)

					if (borders === undefined) this.refuse("table", "a cell border ODF has no form for")

					for (const [name, item] of borders) attributes.set(name, item)

					break
				}
				case "tcMar":
					for (const match of value.children.matchAll(
						/<(top|left|bottom|right|start|end)(?: [a-zA-Z:]+="[^"]*")*? w="(-?\d+)"/gu
					)) {
						const side = match[1] === "start" ? "left" : match[1] === "end" ? "right" : (match[1] ?? "")

						attributes.set(`fo:padding-${side}`, `${round(Number(match[2] ?? "0") / 20)}pt`)
					}

					break
				case "shd": {
					const fill = value.attributes.get("fill")

					if ((value.attributes.get("val") ?? "clear") !== "clear" && value.attributes.get("val") !== "nil")
						this.refuse("table", "a patterned cell shading")
					if (fill !== undefined && fill !== "auto") attributes.set("fo:background-color", `#${fill.toLowerCase()}`)

					break
				}
				case "vAlign": {
					const align = value.attributes.get("val")

					attributes.set("style:vertical-align", align === "center" ? "middle" : align === "bottom" ? "bottom" : "top")

					break
				}
				case "textDirection":
					if (value.attributes.get("val") !== "tbRl") this.refuse("table", "a cell's text direction")

					attributes.set("style:writing-mode", "tb-rl")

					break
				default:
					this.refuse("table", `the cell property ${local}`)
			}
		}

		return this.context.registry.style(
			"table-cell",
			"TableCell",
			"",
			attributes.size === 0 ? "" : `<style:table-cell-properties${sortedAttributes(attributes)}/>`
		)
	}

	// `slot`: given where in the markup a span down not yet known goes (a table written in pieces).
	private cellMarkup(
		document: XmlDocument,
		cell: number,
		style: string,
		span: number,
		rows: number,
		slot?: (at: number) => void
	): string {
		const blocks: number[] = []

		for (let at = document.firstChildElement(cell); at >= 0; at = document.nextSiblingElement(at)) {
			if (document.localName(at) !== "tcPr") blocks.push(at)
		}

		const start = `<table:table-cell${style === "" ? "" : ` table:style-name="${esc(style)}"`}${span > 1 ? ` table:number-columns-spanned="${span}"` : ""}${rows > 1 ? ` table:number-rows-spanned="${rows}"` : ""}`

		slot?.(start.length)

		return `${start} office:value-type="string">${this.blocks(document, blocks)}</table:table-cell>${"<table:covered-table-cell/>".repeat(span - 1)}`
	}

	// A table row written anew: cells by their properties (`cellStyle`), spans as covered cells.
	row(
		document: XmlDocument,
		row: number,
		styles: { row: (trPr: string) => string | undefined; cell: (tcPr: string) => string | undefined; columns: number },
		below: (column: number) => number
	): string {
		const trPr = child(document, row, "trPr")
		const trKey = trPr < 0 ? "" : canonicalElement(document, trPr)
		const rowStyle = styles.row(trKey)
		const rowAttribute =
			rowStyle !== undefined
				? rowStyle === ""
					? ""
					: ` table:style-name="${esc(rowStyle)}"`
				: this.rowStyleAttribute(propsOf(document, trPr))

		let out = `<table:table-row${this.context.declarations}${rowAttribute}>`
		let column = 0

		for (let cell = document.firstChildElement(row); cell >= 0; cell = document.nextSiblingElement(cell)) {
			const local = document.localName(cell)

			if (local === "trPr" || local === "tblPrEx") continue
			if (local !== "tc") this.refuse("table", `${local} in a row`)

			const tcPr = child(document, cell, "tcPr")
			const props = propsOf(document, tcPr)
			const span = gridSpan(props)
			const merge = props.get("vMerge")

			props.delete("gridSpan")
			props.delete("vMerge")
			props.delete("tcW")

			const style = styles.cell(propsKey(props)) ?? this.cellStyle(props)

			if (merge !== undefined && merge.attributes.get("val") !== "restart") {
				out += "<table:covered-table-cell/>".repeat(span)
				column += span

				continue
			}

			const rows = merge === undefined ? 1 : below(column)
			const blocks: number[] = []

			for (let at = document.firstChildElement(cell); at >= 0; at = document.nextSiblingElement(at)) {
				if (document.localName(at) !== "tcPr") blocks.push(at)
			}

			out += `<table:table-cell table:style-name="${esc(style)}"${span > 1 ? ` table:number-columns-spanned="${span}"` : ""}${rows > 1 ? ` table:number-rows-spanned="${rows}"` : ""} office:value-type="string">${this.blocks(document, blocks)}</table:table-cell>`
			out += "<table:covered-table-cell/>".repeat(span - 1)
			column += span
		}

		return `${out}</table:table-row>`
	}
}

export function withoutNumbering(props: Props): Props {
	if (!props.has("numPr")) return props

	const out = new Map(props)

	out.delete("numPr")

	return out
}

function round(value: number): string {
	return String(Math.round(value * 10_000) / 10_000)
}

function attributeOf(document: XmlDocument, node: number, name: string): string | undefined {
	return node < 0 ? undefined : document.attribute(node, name)
}

// A source element's markup (its start tag as written) holding `content` in place of what it held.
function withContent(bytes: string, content: string): string {
	const close = bytes.indexOf(">")
	const name = /^<([^\s/>]+)/u.exec(bytes)?.[1]

	if (close < 0 || name === undefined) return bytes

	const start = bytes[close - 1] === "/" ? `${bytes.slice(0, close - 1).trimEnd()}>` : bytes.slice(0, close + 1)

	return `${start}${content}</${name}>`
}

function sameValue(a: PropertyValue, b: PropertyValue): boolean {
	return a.children === b.children && sortedAttributes(a.attributes) === sortedAttributes(b.attributes)
}

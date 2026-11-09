import { appendAll, minOf } from "../../arrays"
import {
	BytePieces,
	bytesSource,
	crc32,
	planZip,
	writeZip,
	type ByteSink,
	type PartBytes,
	type PartChange,
	ZipArchive,
	ZipError
} from "../../opc/index"
import { metaDate, metaOnSave } from "../../odf/meta"
import {
	OdfNs,
	OdfPackage,
	OdfStyleResolver,
	elementName,
	parseLength,
	parseRelativeLength,
	readContentPrologue,
	type StyleScope
} from "../../odf/index"
import { readContentPrologueSliced } from "../../odf/prologue"
import { OdfStyleSheet } from "../../odf/styles"
import { sliceClock } from "../../slicing"
import { inflateChunks } from "../scan"
import { RtfAborted, jobOf, turn, type RtfJob, type RtfTurns } from "../../rtf/turns"
import { joinChunks } from "../../rtf/write/out"
import type { RtfLockedBlock } from "../../rtf/write/proof"
import {
	Namespaces,
	NodeKind,
	assertWellFormed,
	assertWellFormedSliced,
	decodeUtf8,
	encodeUtf8,
	parseXml,
	parseXmlSliced,
	type Slicing,
	type XmlDocument
} from "../../xml/index"
import { nativeDeflate, nativeDeflateChunks } from "../../docx/write/zip"
import { StyleMapper } from "../styles"
import { configBoolean, translateOdt } from "../translate"
import { dateCode, FIELDS_AS_TEXT, PASS_THROUGH_INLINE, referenceCode } from "../translator"
import type { OdtOrigin, OdtTranslation } from "../types"
import { esc, escText, twips as twipsOf } from "../wml"
import {
	AtomPool,
	ListIds,
	OdfEmitter,
	OdtWriteRefusal,
	StyleRegistry,
	propsKey,
	withoutNumbering,
	writtenForm,
	type EmitContext,
	type ListTarget,
	type ParagraphSource
} from "./emit"
import { paragraphAttributes, paragraphSources, paragraphTextSources, runAttributes, runSources, type ParagraphAttributes } from "./inverse"
import { Meaning, PARAGRAPH_SKIPPED, StyleChains, canonicalElement, descendant, readProps, type PropertyValue, type Props } from "./meaning"
import { runMeaning, translateRun, type SpanFrame } from "./span"
import { odfText, sourceTextOf, wmlText, type SourceText } from "./sourceText"
import { runProperties } from "../props"
import type { OdtSource } from "./source"
import { TableSpacing, withoutTableSpacing, type SpacingShift } from "./tableSpacing"

// The source-preserving ODT writer. The document was edited as the WordprocessingML package the translator made
// of it; the docx writer wrote the edited parts, unchanged blocks byte for byte. Each top-level block of the body
// translated from an element of content.xml (the origin table) whose blocks are unchanged keeps that element's
// bytes; a changed one is rewritten where it changed (a paragraph, a table row or cell, in place in its element) or,
// where its structure changed, as a whole from its WordprocessingML (emit.ts), with new automatic styles. Every other
// part of the package is copied as stored. The result is translated again and every block compared with what the
// edit made (meaning.ts): a copied block that reads differently is rewritten in turn; a rewritten block that reads
// differently refuses the save.

export interface OdtEdits {
	readonly parts: ReadonlyMap<string, Uint8Array>
	readonly removed?: readonly string[]
}

export interface OdtWritten {
	readonly bytes: Uint8Array
	// Blocks rewritten, and how many reads the proof took.
	readonly written: number
	readonly rounds: number
	// Which proof proved it: the changed blocks' alone (span.ts), or the whole file's.
	readonly proof?: "span" | "whole"
	// What the save wrote otherwise than the edit has it, for the user to be told.
	readonly notices?: readonly OdtWriteNotice[]
}

// commentPoint: comments over a range kept at the start of their text, an ODF 1.0 or 1.1 annotation marking a point
// (office:annotation-end is new in ODF 1.2).
export interface OdtWriteNotice {
	readonly kind: "commentPoint"
	readonly count: number
}

const COMMENT_STORIES = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u

// The edit with each new or changed comment's range collapsed to its start (its end and reference moved there), for a
// document whose annotations mark points; how many it collapsed.
function pointComments(translation: OdtTranslation, edits: OdtEdits): { edits: OdtEdits; count: number } {
	const edited = edits.parts.get("word/comments.xml")

	if (edited === undefined) return { edits, count: 0 }

	const comments = (bytes: Uint8Array | undefined): Map<string, string> =>
		new Map(
			bytes === undefined
				? []
				: [...decodeUtf8(bytes).matchAll(/<w:comment\b[^>]*?\sw:id="([^"]*)"(?:[^>]*?\/>|[\s\S]*?<\/w:comment>)/gu)].map(
						match => [match[1] ?? "", match[0]] as const
					)
		)
	const before = comments(translation.parts.get("word/comments.xml") as Uint8Array | undefined)
	const changed = [...comments(edited)].filter(([id, markup]) => before.get(id) !== markup).map(([id]) => id)

	if (changed.length === 0) return { edits, count: 0 }

	const parts = new Map(edits.parts)
	let count = 0

	for (const [name, bytes] of edits.parts) {
		if (!COMMENT_STORIES.test(name)) continue

		let text = decodeUtf8(bytes)
		const was = text

		for (const id of changed) {
			const start = `<w:commentRangeStart w:id="${id}"/>`
			const end = `<w:commentRangeEnd w:id="${id}"/>`
			const at = text.indexOf(start)

			if (at < 0 || !text.includes(end) || text.startsWith(end, at + start.length)) continue

			const reference = new RegExp(`<w:r>(?:<w:rPr>(?:(?!</w:rPr>)[\\s\\S])*</w:rPr>)?<w:commentReference w:id="${id}"/></w:r>`, "u")
			const run = reference.exec(text)?.[0] ?? ""

			text = text.replace(end, "")

			if (run !== "") text = text.replace(run, "")

			text = text.replace(start, `${start}${end}${run}`)
			count++
		}

		if (text !== was) parts.set(name, encodeUtf8(text))
	}

	return { edits: { ...edits, parts }, count }
}

export interface OdtProofResult {
	readonly locked: readonly RtfLockedBlock[]
	readonly written: number
	// Why each locked unit is (one entry per locked source element).
	readonly reasons: readonly string[]
}

export { OdtWriteRefusal }

const BODY_PART = "word/document.xml"
const RELS_PART = "word/_rels/document.xml.rels"
const MAX_ROUNDS = 4
// Parts the writer reads nothing from: the package's bookkeeping, and document properties the translation has none of.
const IGNORED_PARTS = new Set([
	"[Content_Types].xml",
	"_rels/.rels",
	"docProps/core.xml",
	"docProps/app.xml",
	"docProps/custom.xml",
	"word/fontTable.xml",
	"word/webSettings.xml"
])
// Header and footer parts: written into styles.xml's master pages (OdtWrite.writeStories).
const STORY_PART = /^word\/(header|footer)\d+\.xml$|^word\/_rels\/(header|footer)\d+\.xml\.rels$/u
const NOTE_PARTS = new Set(["word/footnotes.xml", "word/endnotes.xml", "word/comments.xml"])
// The prefixes written markup uses.
const PREFIXES = ["office", "style", "text", "table", "draw", "fo", "svg", "xlink", "dc", "meta"] as const

// Elements a block may hold and still be rewritten: what the translator turns into WordprocessingML a reader can
// tell apart. Atoms (pictures, notes, comments, fields) are copied whole; anything else (index marks, ruby, metadata
// fields...) would be lost by a rewrite, so the block stays as the source has it.
const REWRITABLE = new Set([
	"text:p",
	"text:h",
	"text:span",
	"text:s",
	"text:tab",
	"text:line-break",
	"text:a",
	"text:soft-page-break",
	"text:list",
	"text:list-item",
	"text:list-header",
	"text:page-number",
	"text:page-count",
	"text:bookmark",
	"text:bookmark-start",
	"text:bookmark-end",
	"text:reference-mark",
	"text:reference-mark-start",
	"text:reference-mark-end",
	"office:annotation-end",
	// Inside a paragraph, around a change this paragraph alone holds (OdtPlan.changeOpaque).
	"text:change",
	"text:change-start",
	"text:change-end",
	"table:table",
	"table:table-column",
	"table:table-columns",
	"table:table-header-columns",
	"table:table-column-group",
	"table:table-row",
	"table:table-rows",
	"table:table-header-rows",
	"table:table-row-group",
	"table:table-cell",
	"table:covered-table-cell"
])
// Fields the translator keeps as w:fldSimple results (copied whole when their code and result stay).
const FIELD_ATOMS: ReadonlySet<string> = new Set([
	"text:reference-ref",
	"text:bookmark-ref",
	"text:sequence-ref",
	"text:note-ref",
	"text:bibliography-mark",
	...FIELDS_AS_TEXT,
	...[...PASS_THROUGH_INLINE].filter(name => name !== "text:meta" && name !== "text:ruby-base")
])
const ATOMS = new Set(["text:note", "office:annotation", ...FIELD_ATOMS])
const NO_NODES: ReadonlySet<number> = new Set()
// Attributes a rewrite keeps or restates, by element; any other keeps the block as it is. Paragraphs keep their start
// tags (or restate these); links keep theirs while their target stays; table elements are kept or copied whole.
const PARAGRAPH_ATTRIBUTES = new Set([
	"text:style-name",
	"text:outline-level",
	"text:is-list-header",
	"text:restart-numbering",
	"text:start-value",
	"xml:id",
	"text:id",
	"text:cond-style-name"
])
const ATTRIBUTES: Readonly<Record<string, ReadonlySet<string> | undefined>> = {
	"text:p": PARAGRAPH_ATTRIBUTES,
	"text:h": PARAGRAPH_ATTRIBUTES,
	"text:span": new Set(["text:style-name"]),
	"text:s": new Set(["text:c"]),
	"text:tab": new Set(["text:tab-ref"]),
	"text:line-break": new Set(),
	"text:soft-page-break": new Set(),
	"text:bookmark": new Set(["text:name", "xml:id"]),
	"text:bookmark-start": new Set(["text:name", "xml:id"]),
	"text:bookmark-end": new Set(["text:name"]),
	"text:reference-mark": new Set(["text:name"]),
	"text:reference-mark-start": new Set(["text:name"]),
	"text:reference-mark-end": new Set(["text:name"]),
	"text:page-number": new Set(["text:select-page"]),
	"text:page-count": new Set(),
	"text:list": new Set(["text:style-name", "text:continue-numbering", "text:continue-list", "xml:id"]),
	"text:list-item": new Set(["text:start-value", "xml:id"]),
	"text:list-header": new Set(["xml:id"]),
	"office:annotation-end": new Set(["office:name"]),
	"text:change": new Set(["text:change-id"]),
	"text:change-start": new Set(["text:change-id"]),
	"text:change-end": new Set(["text:change-id"])
}
const CHANGE_MARKS: ReadonlySet<string> = new Set(["text:change", "text:change-start", "text:change-end"])

interface Replacement {
	readonly start: number
	readonly end: number
	readonly text: string
	// The segment it writes (-1: before the body).
	segment?: number
}

// One stream (content.xml, styles.xml) as written: its bytes, what replaces spans of them, its new automatic styles.
// The translation's narrowest grid column (twips).
const MIN_GRID_COLUMN = 23

class Stream {
	readonly name: string
	readonly bytes: Uint8Array
	readonly declarations: string
	readonly registry: StyleRegistry
	readonly lists: ListIds
	readonly replacements: Replacement[] = []
	private readonly automatic: { at: number; end: number; open: string; close: string }
	readonly fontFaces: { at: number; end: number; open: string; close: string }
	readonly newFaces: string[] = []
	readonly faceNames = new Map<string, string>()
	declaredFaces: Map<string, string> | undefined
	readonly rootOpen: string
	private readonly unbound: string[] = []
	// Where the root's start tag ends ("> "): declarations go before it.
	private readonly rootTagEnd: number
	private readonly rootStart: number

	constructor(name: string, bytes: Uint8Array, document: XmlDocument, taken: Set<string>) {
		this.name = name
		this.bytes = bytes

		const namespaces = new Namespaces(document)
		const root = document.documentElement()
		let declarations = ""

		// A prefix the root leaves unbound is declared on it (when written markup uses it); one it binds to another
		// namespace is declared again on each written element.
		for (const prefix of PREFIXES) {
			const uri = namespaces.uri(root, prefix)

			if (uri === undefined) this.unbound.push(prefix)
			else if (uri !== OdfNs[prefix]) declarations += ` xmlns:${prefix}="${OdfNs[prefix]}"`
		}

		this.rootTagEnd = document.openEnd(root) - 1
		this.rootStart = document.start(root)
		this.declarations = declarations
		this.registry = new StyleRegistry(taken, declarations)
		this.lists = new ListIds(() => this.registry.name("list", true))

		// Names in the stream's body, looked for only as a body element is named.
		this.registry.inBody = candidate => indexOf(bytes, encodeUtf8(`"${candidate}"`), 0) >= 0
		this.rootOpen = decodeUtf8(bytes.subarray(document.start(root), document.openEnd(root)))

		const officePrefix = namespaces.prefixFor(root, OdfNs.office)
		const office = officePrefix === undefined || officePrefix === "" ? "office:" : `${officePrefix}:`
		const declared = officePrefix === undefined ? ` xmlns:office="${OdfNs.office}"` : ""
		let automatic: { at: number; end: number; open: string; close: string } | undefined
		let fontFaces: { at: number; end: number; open: string; close: string } | undefined
		let before = -1
		let faceBefore = -1

		for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
			const canonical = elementName(document, namespaces, node)

			if (canonical === "office:automatic-styles") {
				automatic = document.isSelfClosing(node)
					? {
							at: document.start(node),
							end: document.end(node),
							open: `<${document.name(node)}>`,
							close: `</${document.name(node)}>`
						}
					: { at: document.contentEnd(node), end: document.contentEnd(node), open: "", close: "" }
			} else if (canonical === "office:font-face-decls") {
				fontFaces = document.isSelfClosing(node)
					? {
							at: document.start(node),
							end: document.end(node),
							open: `<${document.name(node)}>`,
							close: `</${document.name(node)}>`
						}
					: { at: document.contentEnd(node), end: document.contentEnd(node), open: "", close: "" }
			} else if (before < 0 && (canonical === "office:body" || canonical === "office:master-styles")) {
				before = document.start(node)
			}

			if (
				faceBefore < 0 &&
				(canonical === "office:styles" ||
					canonical === "office:automatic-styles" ||
					canonical === "office:body" ||
					canonical === "office:master-styles")
			) {
				faceBefore = document.start(node)
			}
		}

		const fallback = before < 0 ? document.contentEnd(root) : before

		this.automatic = automatic ?? {
			at: fallback,
			end: fallback,
			open: `<${office}automatic-styles${declared}>`,
			close: `</${office}automatic-styles>`
		}

		const faceAt = faceBefore < 0 ? fallback : faceBefore

		this.fontFaces = fontFaces ?? {
			at: faceAt,
			end: faceAt,
			open: `<${office}font-face-decls${declared}>`,
			close: `</${office}font-face-decls>`
		}
	}

	// Every replacement, the new automatic styles and font faces included.
	all(): Replacement[] {
		const all = this.replacements.map(replacement => {
			const text = this.lists.resolve(replacement.text)

			return text === replacement.text ? replacement : { ...replacement, text }
		})
		const styles = this.registry.markup.length === 0 ? "" : this.registry.used(all.map(replacement => replacement.text))

		if (styles !== "") {
			all.push({
				start: this.automatic.at,
				end: this.automatic.end,
				text: `${this.automatic.open}${styles}${this.automatic.close}`,
				segment: -1
			})
		}

		if (this.newFaces.length > 0) {
			all.push({
				start: this.fontFaces.at,
				end: this.fontFaces.end,
				text: `${this.fontFaces.open}${this.newFaces.join("")}${this.fontFaces.close}`,
				segment: -1
			})
		}

		if (all.length > 0 && this.unbound.length > 0) {
			const used = this.unbound.filter(prefix => all.some(replacement => replacement.text.includes(`${prefix}:`)))

			if (used.length > 0) {
				all.push({
					start: this.rootTagEnd,
					end: this.rootTagEnd,
					text: used.map(prefix => ` xmlns:${prefix}="${OdfNs[prefix as (typeof PREFIXES)[number]]}"`).join(""),
					segment: -1
				})
			}
		}

		return all
	}

	// The root's start tag as written (with the declarations `all` adds to it).
	rootTag(all: readonly Replacement[]): Uint8Array {
		const tag = this.bytes.subarray(this.rootStart, this.rootTagEnd + 1)
		const added = all
			.filter(replacement => replacement.start === this.rootTagEnd && replacement.end === this.rootTagEnd)
			.map(replacement => replacement.text)
			.join("")
		const at = this.rootTagEnd - this.rootStart

		return encodeUtf8(`${decodeUtf8(tag.subarray(0, at))}${added}${decodeUtf8(tag.subarray(at))}`)
	}

	// Font faces and automatic styles this write adds, as markup.
	get addedFaces(): string {
		return this.newFaces.join("")
	}

	// The stream as written, as views of its bytes between the new markup (never joined: the zip writer streams
	// them); undefined when nothing changed.
	output(all: Replacement[] = this.all()): BytePieces | undefined {
		if (all.length === 0) return undefined

		// Stable by start: an insertion at a position comes before a replacement starting there.
		all.sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start))

		const pieces: Uint8Array[] = []
		let at = 0

		for (const replacement of all) {
			if (replacement.start < at) throw new OdtWriteRefusal("internal", "overlapping rewrites")

			pieces.push(this.bytes.subarray(at, replacement.start), encodeUtf8(replacement.text))
			at = replacement.end
		}

		pieces.push(this.bytes.subarray(at))

		return BytePieces.of(pieces)
	}
}

function fnv(bytes: Uint8Array): number {
	let hash = 0x811c9dc5

	for (let k = 0; k < bytes.length; k++) hash = Math.imul(hash ^ (bytes[k] ?? 0), 0x01000193)

	return hash >>> 0
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

function bodyOf(document: XmlDocument): number {
	const root = document.documentElement()

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === "body") return child
	}

	return -1
}

function blocksOf(document: XmlDocument, container: number): { blocks: number[]; section: number } {
	const blocks: number[] = []
	let section = -1

	for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		// Bookmark ends left between blocks (a paragraph that held a start was deleted) mark nothing: no block.
		if (local === "sectPr") section = child
		else if (local !== "bookmarkStart" && local !== "bookmarkEnd" && local !== "proofErr") blocks.push(child)
	}

	return { blocks, section }
}

function childNamed(document: XmlDocument, node: number, local: string): number {
	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === local) return child
	}

	return -1
}

function relationshipsOf(bytes: Uint8Array | undefined): Map<string, { target: string; external: boolean; type: string }> {
	const out = new Map<string, { target: string; external: boolean; type: string }>()

	if (bytes === undefined) return out

	const document = parseXml(bytes)
	const root = document.documentElement()

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		out.set(document.attribute(child, "Id") ?? "", {
			target: document.attribute(child, "Target") ?? "",
			external: document.attribute(child, "TargetMode") === "External",
			type: document.attribute(child, "Type") ?? ""
		})
	}

	return out
}

// Notes, comments and others by w:id, as the bytes of their elements.
function byId(document: XmlDocument | undefined): Map<string, { node: number; bytes: Uint8Array }> {
	const out = new Map<string, { node: number; bytes: Uint8Array }>()

	if (document === undefined) return out

	const root = document.documentElement()

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		out.set(document.attribute(child, "w:id") ?? "", { node: child, bytes: document.raw(child) })
	}

	return out
}

// A source element of content.xml parsed on its own (inside the root's start tag, so its prefixes resolve).
interface UnitTree {
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	readonly node: number
	// Absolute offset of the parsed bytes' start in the stream.
	readonly shift: number
	// The flow blocks the translator made of it, in order: paragraphs and tables, with their elements.
	readonly emitters: readonly number[] | undefined
	// Why it may not be rewritten (an element a rewrite would lose); undefined when it may.
	readonly opaque: string | undefined
	// The same for each block (by emitter), and for the structure around them (a list's attributes...): a block
	// holding what a rewrite would lose stays as it is, the others of its element may change.
	readonly blockOpaque: readonly (string | undefined)[] | undefined
	readonly structuralOpaque: string | undefined
	// A section, an index or a page-anchored frame: the element must stay, only its paragraphs may change.
	readonly structural: boolean
}

// A tracked change's record in the source (OdtPlan.changeRecords).
interface ChangeRecord {
	readonly kind: "insertion" | "deletion" | "other"
	readonly simple: boolean
	// The text:changed-region's span in content.xml.
	readonly start: number
	readonly end: number
}

// office:text's text:tracked-changes in content.xml: its start tag's span, prefix and other attributes, and where
// its end tag starts (-1: it is empty-element); or, with none, where one goes (after office:text's forms, Part 3
// §3.4).
interface TrackedChanges {
	readonly container: { tagStart: number; tagEnd: number; prefix: string; attributes: string; close: number } | undefined
	readonly insertAt: number
}

function trackedChangesOf(plan: OdtPlan): TrackedChanges {
	const bytes = plan.contentBytes
	const start = plan.textStart()
	const text = decodeUtf8(bytes.subarray(start, Math.min(bytes.length, start + 4 * 1024 * 1024)))
	const offset = (characters: number): number => start + encodeUtf8(text.slice(0, characters)).length
	const container =
		/^\s*(?:<([A-Za-z0-9_.-]+:)?forms\b[^>]*?(?:\/>|>[\s\S]*?<\/\1?forms>)\s*)?(<([A-Za-z0-9_.-]+:)?tracked-changes\b([^>]*?)(\/?)>)/u.exec(
			text
		)

	if (container === null) {
		const forms = /^\s*<([A-Za-z0-9_.-]+:)?forms\b[^>]*?(?:\/>|>[\s\S]*?<\/\1?forms>)/u.exec(text)

		return { container: undefined, insertAt: forms === null ? start : offset(forms[0].length) }
	}

	const prefix = container[3] ?? ""
	const tagStart = offset(container.index + container[0].length - (container[2] ?? "").length)
	const tagEnd = offset(container.index + container[0].length)
	let close = -1

	if (container[5] !== "/") {
		const at = text.indexOf(`</${prefix}tracked-changes>`, container.index)

		if (at < 0) throw new OdtWriteRefusal("package", "content.xml's tracked changes have no end")

		close = offset(at)
	}

	return { container: { tagStart, tagEnd, prefix, attributes: container[4] ?? "", close }, insertAt: tagStart }
}

interface Unit {
	readonly origin: OdtOrigin
	readonly index: number
	tree?: UnitTree | undefined
}

interface Region {
	readonly units: Unit[]
	// Edited blocks [from, to) taking their place.
	readonly from: number
	readonly to: number
	// Where an insertion goes when the region has no units of its own.
	readonly at: number
}

interface Segment {
	readonly id: number
	readonly start: number
	readonly end: number
	readonly kind: "kept" | "written"
	readonly units: readonly Unit[]
	// Edited blocks [from, to) the segment's reading must equal.
	readonly from: number
	readonly to: number
}

// What a plan reads of the source's style streams: held while a write runs, let go while the proof reads.
interface PlanStyles {
	readonly stylesDocument: XmlDocument
	readonly prologueDocument: XmlDocument
	readonly sheet: OdfStyleSheet
	readonly mapper: StyleMapper
}

// Everything one write of an edit needs: the source's streams and translation, the edited parts, and how they meet.
class OdtPlan {
	readonly source: OdtSource
	readonly translation: OdtTranslation
	readonly edits: OdtEdits
	readonly contentBytes: Uint8Array
	readonly stylesBytes: Uint8Array
	readonly tabsRelativeToIndent: boolean
	readonly translated: Map<string, XmlDocument> = new Map()
	readonly edited: Map<string, XmlDocument> = new Map()
	readonly units: Unit[]
	readonly rootOpen: string
	readonly rootClose: string
	private readonly bodyStart: number
	private styleState: PlanStyles | undefined

	// Where content.xml's prologue (font faces, automatic styles) ends: office:body.
	get prologueEnd(): number {
		return this.bodyStart < 0 ? this.contentBytes.length : this.bodyStart
	}

	private constructor(
		source: OdtSource,
		edits: OdtEdits,
		content: Uint8Array,
		styles: Uint8Array,
		settings: XmlDocument | undefined,
		read: PlanStyles & { readonly bodyStart: number }
	) {
		this.source = source
		this.translation = source.translation
		this.edits = edits
		this.contentBytes = content
		this.stylesBytes = styles
		this.tabsRelativeToIndent = configBoolean(settings, "TabsRelativeToIndent") ?? true
		this.bodyStart = read.bodyStart
		this.styleState = read

		const prologue = read.prologueDocument
		const root = prologue.documentElement()

		this.rootOpen = decodeUtf8(content.subarray(prologue.start(root), prologue.openEnd(root)))
		this.rootClose = `</${prologue.name(root)}>`
		this.units = this.translation.origins
			.filter(origin => origin.part === BODY_PART && origin.stream === "content.xml")
			.sort((a, b) => a.start - b.start)
			.map((origin, index) => ({ origin, index }))
	}

	// styles.xml and content.xml's prologue parsed, and their style sheet (in slices on a job).
	private static async readStyles(
		content: Uint8Array,
		styles: Uint8Array,
		tabsRelativeToIndent: boolean,
		job: RtfJob | undefined
	): Promise<PlanStyles & { readonly bodyStart: number }> {
		const slicing = job?.aborting
		const stylesDocument = slicing === undefined ? parseXml(styles) : await parseXmlSliced(styles, slicing)

		await turn(job)

		const prologue = slicing === undefined ? readContentPrologue(content) : await readContentPrologueSliced(content, slicing)

		await turn(job)

		const sheet =
			slicing === undefined
				? new OdfStyleSheet(stylesDocument, prologue)
				: await OdfStyleSheet.build(stylesDocument, prologue, slicing)
		const mapper = new StyleMapper(sheet, new OdfStyleResolver(sheet), { tabsRelativeToIndent })

		return { stylesDocument, prologueDocument: prologue.document, sheet, mapper, bodyStart: prologue.bodyStart }
	}

	private get styled(): PlanStyles {
		if (this.styleState === undefined) throw new Error("The plan's styles were let go")

		return this.styleState
	}

	get stylesDocument(): XmlDocument {
		return this.styled.stylesDocument
	}

	get prologueDocument(): XmlDocument {
		return this.styled.prologueDocument
	}

	get sheet(): OdfStyleSheet {
		return this.styled.sheet
	}

	get mapper(): StyleMapper {
		return this.styled.mapper
	}

	static async create(source: OdtSource, edits: OdtEdits, job: RtfJob | undefined): Promise<OdtPlan> {
		const read = async (name: string): Promise<Uint8Array | undefined> => {
			const entry = source.archive.get(name)

			if (entry === undefined) return undefined
			if (job === undefined) return source.archive.read(entry)

			const chunks: Uint8Array[] = []

			for await (const chunk of inflateChunks(source.archive, entry, sliceClock(job.aborting))) chunks.push(chunk)

			return chunks.length === 1 ? (chunks[0] as Uint8Array) : joinChunks(chunks)
		}
		const content = await read("content.xml")

		await turn(job)

		const styles = (await read("styles.xml")) ?? encodeUtf8(`<office:document-styles xmlns:office="${OdfNs.office}"/>`)
		let settings: XmlDocument | undefined

		try {
			const bytes = await read("settings.xml")

			settings = bytes === undefined ? undefined : parseXml(bytes)
		} catch {
			settings = undefined
		}

		if (content === undefined) throw new OdtWriteRefusal("package", "the package has no content.xml")
		if (!source.translation.originsExact) throw new OdtWriteRefusal("package", "content.xml is not UTF-8")

		const tabs = configBoolean(settings, "TabsRelativeToIndent") ?? true

		return new OdtPlan(source, edits, content, styles, settings, await OdtPlan.readStyles(content, styles, tabs, job))
	}

	// The styles read again after they were let go (a further write round).
	async restyle(job: RtfJob | undefined): Promise<void> {
		this.styleState ??= await OdtPlan.readStyles(this.contentBytes, this.stylesBytes, this.tabsRelativeToIndent, job)
	}

	// The parts the writer reads, parsed in slices ahead of the steps that read them at once.
	async preload(job: RtfJob | undefined): Promise<void> {
		if (job === undefined) return

		for (const name of [
			BODY_PART,
			"word/styles.xml",
			"word/numbering.xml",
			"word/footnotes.xml",
			"word/endnotes.xml",
			"word/comments.xml"
		]) {
			const translated = this.translation.parts.get(name)

			if (translated instanceof Uint8Array && !this.translated.has(name))
				this.translated.set(name, await parseXmlSliced(translated, job.aborting))

			const edited = this.edits.parts.get(name)

			if (edited !== undefined && !this.edited.has(name)) this.edited.set(name, await parseXmlSliced(edited, job.aborting))
		}
	}

	// Lets go of what was parsed for a write (the bodies, the unit trees): parsed again when asked for. `styles`: the
	// style sheet too (read again by restyle).
	release(styles = false): void {
		this.translated.clear()
		this.edited.clear()

		for (const unit of this.units) unit.tree = undefined

		if (styles) this.styleState = undefined
	}

	translatedXml(name: string): XmlDocument | undefined {
		let document = this.translated.get(name)

		if (document === undefined) {
			const part = this.translation.parts.get(name)

			if (!(part instanceof Uint8Array)) return undefined

			document = parseXml(part)
			this.translated.set(name, document)
		}

		return document
	}

	editedXml(name: string): XmlDocument | undefined {
		if (this.edits.removed?.includes(name) === true) return undefined

		let document = this.edited.get(name)

		if (document === undefined) {
			const part = this.edits.parts.get(name)

			if (part === undefined) return this.translatedXml(name)

			document = parseXml(part)
			this.edited.set(name, document)
		}

		return document
	}

	// The unit's source element parsed, with its flow blocks found.
	tree(unit: Unit): UnitTree {
		if (unit.tree !== undefined) return unit.tree

		const { start, end } = unit.origin
		const open = encodeUtf8(this.rootOpen)
		const close = encodeUtf8(this.rootClose)
		const bytes = new Uint8Array(open.length + (end - start) + close.length)

		bytes.set(open)
		bytes.set(this.contentBytes.subarray(start, end), open.length)
		bytes.set(close, open.length + end - start)

		const document = parseXml(bytes)
		const namespaces = new Namespaces(document)
		const node = document.firstChildElement(document.documentElement())
		const emitters: number[] = []
		let opaque: string | undefined
		let structuralOpaque: string | undefined
		let structural = false
		const flow = (at: number): void => {
			const name = elementName(document, namespaces, at)

			switch (name) {
				case "text:p":
				case "text:h":
				case "table:table":
					emitters.push(at)
					break
				case "text:list":
				case "text:list-item":
				case "text:list-header":
				case "text:section":
				case "text:numbered-paragraph":
					if (name === "text:section" || name === "text:numbered-paragraph") structural = true

					for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) flow(child)

					break
				default:
					structural = true
			}
		}
		// Why an element (with what it holds) may not be rewritten; undefined when it may.
		const attributesOpaque = (at: number, name: string): string | undefined => {
			const allowed = ATTRIBUTES[name]

			if (allowed === undefined) return undefined

			for (const attribute of document.attributes(at)) {
				if (attribute.name.startsWith("xmlns")) continue

				const canonical = canonicalAttribute(namespaces, at, attribute.name)

				// A page number of another page than the current one is written back as the current one's.
				if (!allowed.has(canonical) || (canonical === "text:select-page" && attribute.value !== "current"))
					return `${name} ${canonical}`
			}

			return undefined
		}
		// `inParagraph`: `at` is a paragraph or inside one (change marks between blocks stay as they are).
		const scan = (at: number, skip: ReadonlySet<number>, inParagraph: boolean): string | undefined => {
			for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) {
				if (skip.has(child)) continue

				const name = elementName(document, namespaces, child)

				if (name.startsWith("draw:") || name.startsWith("dr3d:") || ATOMS.has(name)) continue
				if (!REWRITABLE.has(name) && name !== "text:section") return name
				if (CHANGE_MARKS.has(name) && !inParagraph) return name

				const paragraph = name === "text:p" || name === "text:h"
				const found =
					attributesOpaque(child, name) ??
					(paragraph ? this.changeOpaque(document, namespaces, child) : undefined) ??
					scan(child, skip, inParagraph || paragraph)

				if (found !== undefined) return found
			}

			return undefined
		}
		let blockOpaque: (string | undefined)[] = []

		if (node >= 0) {
			flow(node)
			// Each block's own, and what the structure around them holds.
			blockOpaque = emitters.map(emitter => {
				const name = elementName(document, namespaces, emitter)
				const paragraph = name === "text:p" || name === "text:h"

				return (
					attributesOpaque(emitter, name) ??
					(paragraph ? this.changeOpaque(document, namespaces, emitter) : undefined) ??
					scan(emitter, NO_NODES, paragraph)
				)
			})
			structuralOpaque = scan(document.documentElement(), new Set(emitters), false)
			opaque = structuralOpaque ?? blockOpaque.find(reason => reason !== undefined)
		}

		unit.tree = {
			document,
			namespaces,
			node,
			shift: start - open.length,
			emitters: emitters.length === unit.origin.count ? emitters : undefined,
			opaque,
			blockOpaque: emitters.length === unit.origin.count ? blockOpaque : undefined,
			structuralOpaque,
			structural
		}

		return unit.tree
	}

	// Why a unit's rewrite would lose what its translation approximates; undefined when it would not. Most of what the
	// translator approximates a rewrite keeps as the source has it: common styles (only named), properties of
	// automatic styles the edit left (patched, not restated), pictures, objects and shapes (copied whole), sections
	// and lists (their elements kept). What it would lose: content past what WordprocessingML holds (columns past 63,
	// repeated rows cut short), indexes, unknown elements, tracked changes (also caught as
	// elements a rewrite cannot write), and text effects of an automatic style a new span style would not restate.
	lossy(unit: Unit): string | undefined {
		const reasons = unit.origin.lossy.filter(reason => LOCKING_REASONS.has(reason))

		if (reasons.length > 0) return reasons.join(", ")
		if (!unit.origin.lossy.some(reason => reason === "textTransform" || reason === "textEffect")) return undefined

		const tree = this.tree(unit)
		const stack = tree.node < 0 ? [] : [tree.node]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			const name = attributeNamed(tree, node, "text:style-name")
			const family = elementName(tree.document, tree.namespaces, node) === "text:span" ? "text" : "paragraph"
			const style = name === undefined ? undefined : this.sheet.style(family, name, "content")
			const text = style?.automatic === true ? style.properties.get("text")?.attributes : undefined

			if (text !== undefined && hasTextEffect(text)) return "a text effect of the block's own style"

			for (let child = tree.document.firstChildElement(node); child >= 0; child = tree.document.nextSiblingElement(child))
				stack.push(child)
		}

		return undefined
	}

	// Why a paragraph's change marks (Part 3 §5.5.7-§5.5.9) may not be rewritten; undefined when they may. A rewrite
	// writes the paragraph's tracked changes as new changes and leaves out the records of those it replaced
	// (OdtWrite.recordChanges): each change the paragraph marks must be one it alone marks (an insertion's start and
	// end, a deletion's one mark), whose record says nothing the translation does not read (OdtPlan.changeRecords).
	changeOpaque(document: XmlDocument, namespaces: Namespaces, paragraph: number): string | undefined {
		const seen = new Map<string, string[]>()
		// Insertions open where the walk is, and those holding something (an empty one would be left out unseen).
		const open = new Set<string>()
		const filled = new Set<string>()
		const fill = (): void => {
			for (const id of open) filled.add(id)
		}
		const walk = (node: number): void => {
			for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
				const kind = document.kind(child)

				if (kind === NodeKind.Text || kind === NodeKind.CData) {
					if (document.text(child) !== "") fill()

					continue
				}

				if (kind !== NodeKind.Element) continue

				const name = elementName(document, namespaces, child)

				if (name.startsWith("draw:") || name.startsWith("dr3d:") || ATOMS.has(name)) {
					fill()

					continue
				}

				if (CHANGE_MARKS.has(name)) {
					const id = attributeOf(document, namespaces, child, "text:change-id") ?? ""
					const marks = seen.get(id)

					if (marks === undefined) seen.set(id, [name])
					else marks.push(name)

					if (name === "text:change-start") open.add(id)
					else if (name === "text:change-end") open.delete(id)
				} else {
					if (name === "text:s" || name === "text:tab" || name === "text:line-break") fill()

					walk(child)
				}
			}
		}

		walk(paragraph)

		if (seen.size === 0) return undefined

		const records = this.changeRecords()

		for (const [id, marks] of seen) {
			const record = records.get(id)
			const shape = marks.join(" ")
			const fits =
				record?.simple === true &&
				(record.kind === "insertion" ? shape === "text:change-start text:change-end" && filled.has(id) : shape === "text:change") &&
				this.changeMarks().get(id)?.length === marks.length

			if (!fits) return marks[0]
		}

		return undefined
	}

	private records: Map<string, ChangeRecord> | undefined

	// The source's tracked-change records by id (text:changed-region in text:tracked-changes, Part 3 §5.5.2), each
	// with its span in content.xml. Simple: one insertion or deletion whose change info is an author and a date and,
	// for a deletion, one paragraph with content holding no change marks (all a rewrite records anew).
	changeRecords(): Map<string, ChangeRecord> {
		if (this.records !== undefined) return this.records

		const records = new Map<string, ChangeRecord>()
		// The body's text:tracked-changes is a unit of its own, holding no blocks.
		const unit = this.units.find(
			item => item.origin.count === 0 && /^<([A-Za-z0-9_.-]+:)?tracked-changes[\s>]/u.test(this.headOf(item))
		)

		this.records = records

		if (unit === undefined) return records

		const { start: tagStart, end } = unit.origin
		const open = encodeUtf8(this.rootOpen)
		const closing = encodeUtf8(this.rootClose)
		const bytes = new Uint8Array(open.length + end - tagStart + closing.length)

		bytes.set(open)
		bytes.set(this.contentBytes.subarray(tagStart, end), open.length)
		bytes.set(closing, open.length + end - tagStart)

		const document = parseXml(bytes)
		const namespaces = new Namespaces(document)
		const container = document.firstChildElement(document.documentElement())
		const shift = tagStart - open.length
		const named = (node: number): string => elementName(document, namespaces, node)

		for (let region = document.firstChildElement(container); region >= 0; region = document.nextSiblingElement(region)) {
			if (named(region) !== "text:changed-region") continue

			const id = attributeOf(document, namespaces, region, "text:id") ?? attributeOf(document, namespaces, region, "xml:id")

			if (id === undefined) continue

			const changes: number[] = []

			for (let child = document.firstChildElement(region); child >= 0; child = document.nextSiblingElement(child)) changes.push(child)

			const change = changes.length === 1 ? (changes[0] ?? -1) : -1
			const kind =
				change < 0
					? "other"
					: named(change) === "text:insertion"
						? "insertion"
						: named(change) === "text:deletion"
							? "deletion"
							: "other"
			let simple =
				kind !== "other" &&
				document.attributes(region).every(attribute => {
					const name = canonicalAttribute(namespaces, region, attribute.name)

					return attribute.name.startsWith("xmlns") || name === "text:id" || name === "xml:id"
				})
			let info = 0
			let paragraphs = 0

			for (
				let child = change < 0 ? -1 : document.firstChildElement(change);
				simple && child >= 0;
				child = document.nextSiblingElement(child)
			) {
				const name = named(child)

				if (name === "office:change-info") {
					info++

					const parts: string[] = []

					for (let item = document.firstChildElement(child); item >= 0; item = document.nextSiblingElement(item))
						parts.push(named(item))

					simple = parts.every((part, k) => (part === "dc:creator" || part === "dc:date") && parts.indexOf(part) === k)
				} else if ((name === "text:p" || name === "text:h") && kind === "deletion") {
					paragraphs++

					const raw = decodeUtf8(document.raw(child))

					// Text to record: a deletion of nothing the translation reads would be left out unseen.
					simple =
						(document.textContent(child).trim() !== "" || /:(?:s|tab|line-break)[\s/>]/u.test(raw)) &&
						!/change-id\s*=/u.test(raw)
				} else simple = false
			}

			records.set(id, {
				kind,
				simple: simple && info === 1 && paragraphs === (kind === "deletion" ? 1 : 0),
				start: document.start(region) + shift,
				end: document.end(region) + shift
			})
		}

		return records
	}

	// The start of a unit's markup (enough for its element's name).
	private headOf(unit: Unit): string {
		const bytes = this.contentBytes
		let at = unit.origin.start

		while (at < unit.origin.end && (bytes[at] === 0x20 || bytes[at] === 0x09 || bytes[at] === 0x0a || bytes[at] === 0x0d)) at++

		return decodeUtf8(bytes.subarray(at, Math.min(unit.origin.end, at + 128)))
	}

	private marks: Map<string, number[]> | undefined

	// Where office:text's change marks are (their start tags' offsets in content.xml), by the change they mark.
	changeMarks(): Map<string, number[]> {
		if (this.marks !== undefined) return this.marks

		const marks = new Map<string, number[]>()
		const bytes = this.contentBytes
		const needle = encodeUtf8('change-id="')

		this.marks = marks

		for (let at = indexOf(bytes, needle, this.prologueEnd); at >= 0; at = indexOf(bytes, needle, at + needle.length)) {
			const tag = bytes.lastIndexOf(0x3c, at)
			const head = decodeUtf8(bytes.subarray(tag + 1, at))

			if (!/^([A-Za-z0-9_.-]+:)?change(?:-start|-end)?\s(?:[^>]*\s)?(?:[A-Za-z0-9_.-]+:)?$/u.test(head)) continue

			const valueEnd = bytes.indexOf(0x22, at + needle.length)
			const id = decodeUtf8(bytes.subarray(at + needle.length, valueEnd < 0 ? at + needle.length : valueEnd))
			const list = marks.get(id)

			if (list === undefined) marks.set(id, [tag])
			else list.push(tag)
		}

		return marks
	}

	// Where an insertion into an empty body goes: the start of office:text's content.
	textStart(): number {
		const bytes = this.contentBytes

		for (let at = this.bodyStart; at >= 0 && at < bytes.length; at = bytes.indexOf(0x3c, at + 1)) {
			const end = bytes.indexOf(0x3e, at)
			const tag = decodeUtf8(bytes.subarray(at, end + 1))

			if (/^<([A-Za-z0-9_.-]+:)?text[\s>/]/u.test(tag)) return end + 1
		}

		throw new OdtWriteRefusal("package", "content.xml has no office:text")
	}
}

// Approximations a rewrite would lose (see OdtPlan.lossy).
const LOCKING_REASONS: ReadonlySet<string> = new Set(["tableLimit", "index", "unknownElement", "trackedChange", "bookmark"])

function hasTextEffect(text: ReadonlyMap<string, string>): boolean {
	const transform = text.get("fo:text-transform")

	return (
		transform === "lowercase" ||
		transform === "capitalize" ||
		(text.get("style:text-rotation-angle") ?? "0") !== "0" ||
		(text.get("style:text-combine") ?? "none") !== "none" ||
		text.get("style:text-blinking") === "true"
	)
}

function canonicalAttribute(namespaces: Namespaces, node: number, name: string): string {
	const colon = name.indexOf(":")

	if (colon < 0) return name

	const prefix = name.slice(0, colon)

	if (prefix === "xml") return name

	const uri = namespaces.uri(node, prefix)
	const known = Object.entries(OdfNs).find(([, value]) => value === uri)

	return known === undefined ? `{${uri ?? ""}}${name.slice(colon + 1)}` : `${known[0]}:${name.slice(colon + 1)}`
}

// Longest common subsequence of two key arrays, past their common head and tail; a middle too large to compare
// cell by cell is left unmatched (rewritten whole).
function matchBlocks(a: readonly string[], b: readonly string[]): Int32Array {
	const out = new Int32Array(a.length).fill(-1)
	let head = 0

	while (head < a.length && head < b.length && a[head] === b[head]) {
		out[head] = head
		head++
	}

	let tail = 0

	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
		out[a.length - 1 - tail] = b.length - 1 - tail
		tail++
	}

	const n = a.length - head - tail
	const m = b.length - head - tail

	if (n === 0 || m === 0) return out

	if (n * m > 4_000_000) {
		// Too large to compare cell by cell: each source block takes the next edited block with its key (a local edit
		// leaves the rest in order, matched).
		const positions = new Map<string, number[]>()

		for (let j = m - 1; j >= 0; j--) {
			const key = b[head + j] ?? ""
			const list = positions.get(key)

			if (list === undefined) positions.set(key, [head + j])
			else list.push(head + j)
		}

		let last = head - 1

		for (let i = 0; i < n; i++) {
			const list = positions.get(a[head + i] ?? "")

			while (list !== undefined && list.length > 0 && (list[list.length - 1] ?? 0) <= last) list.pop()

			const next = list?.[list.length - 1]

			// Never jump far ahead past unmatched blocks: a block repeated later would otherwise swallow the edit's span.
			if (next !== undefined && next - last <= 64) {
				out[head + i] = next
				last = next
				list?.pop()
			}
		}

		return out
	}

	const table = new Uint32Array((n + 1) * (m + 1))

	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * (m + 1) + j] =
				a[head + i] === b[head + j]
					? (table[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
					: Math.max(table[(i + 1) * (m + 1) + j] ?? 0, table[i * (m + 1) + j + 1] ?? 0)
		}
	}

	for (let i = 0, j = 0; i < n && j < m;) {
		if (a[head + i] === b[head + j]) {
			out[head + i] = head + j
			i++
			j++
		} else if ((table[(i + 1) * (m + 1) + j] ?? 0) >= (table[i * (m + 1) + j + 1] ?? 0)) i++
		else j++
	}

	return out
}

interface WriteMode {
	// Gate 1: every block that may be rewritten is, each on its own; failures lock instead of refusing.
	readonly prove: boolean
	// Units rewritten though their blocks are unchanged (a reading that differed).
	readonly forced: ReadonlySet<number>
}

interface WriteResult {
	// content.xml as written, and styles.xml where it changed.
	readonly content: PartBytes
	readonly styles: PartBytes | undefined
	readonly segments: readonly Segment[]
	readonly written: number
	// Units that could not be written (Gate 1 only), with why; single blocks likewise.
	readonly failed: Map<number, string>
	readonly failedBlocks: Map<number, string>
	readonly pictures: ReadonlyMap<string, Uint8Array>
	readonly pictureParts: ReadonlyMap<string, string>
	readonly contentChanged: boolean
}

// What the writer writes from: the edited body and stories, and what changed besides.
class EditedDocument {
	readonly plan: OdtPlan
	readonly tBody: XmlDocument
	readonly eBody: XmlDocument
	readonly tBlocks: number[]
	readonly eBlocks: number[]
	readonly tSection: number
	readonly eSection: number
	readonly tRels: Map<string, { target: string; external: boolean; type: string }>
	readonly eRels: Map<string, { target: string; external: boolean; type: string }>
	readonly dirtyNotes = new Set<string>()
	readonly dirtyComments = new Set<string>()
	readonly eNotes: Record<"footnote" | "endnote", Map<string, { node: number; bytes: Uint8Array }>>
	readonly eComments: Map<string, { node: number; bytes: Uint8Array }>
	readonly newStyles = new Map<string, number>()
	// Definitions the edit changed (w:abstractNumId -> before and after), and styles (w:styleId -> before and after).
	readonly changedLists = new Map<string, { before: number; after: number }>()
	readonly changedStyles = new Map<string, { before: number; after: number }>()
	// Edited blocks written though their bytes are as they were (a paragraph a section now starts at).
	readonly forced = new Set<number>()
	// Edited paragraphs that start a page style (a new section): the master page to name, "" for none.
	readonly masters = new Map<number, string>()
	// The meaning of the edited body (verify's, kept across writes).
	expected: { blocks: string[]; sections: string[] } | undefined
	// The edit switched tracking changes on (or off); undefined when it left it.
	tracking: boolean | undefined

	constructor(plan: OdtPlan) {
		this.plan = plan

		const tBody = plan.translatedXml(BODY_PART)
		const eBody = plan.editedXml(BODY_PART)

		if (tBody === undefined || eBody === undefined) throw new OdtWriteRefusal("part", "the edit has no document body")

		this.tBody = tBody
		this.eBody = eBody

		const t = blocksOf(tBody, bodyOf(tBody))
		const e = blocksOf(eBody, bodyOf(eBody))

		this.tBlocks = t.blocks
		this.eBlocks = e.blocks
		this.tSection = t.section
		this.eSection = e.section
		// A bookmark started between blocks (the paragraph holding its start was deleted) starts at the next block,
		// which is written with it.
		let started = false

		for (let child = eBody.firstChildElement(bodyOf(eBody)); child >= 0; child = eBody.nextSiblingElement(child)) {
			const local = eBody.localName(child)

			if (local === "bookmarkStart") started = true
			else if (local === "p" || local === "tbl") {
				if (started) this.forced.add(child)

				started = false
			}
		}

		this.tRels = relationshipsOf(plan.translation.parts.get(RELS_PART) as Uint8Array | undefined)
		this.eRels = relationshipsOf(plan.edits.parts.get(RELS_PART) ?? (plan.translation.parts.get(RELS_PART) as Uint8Array | undefined))
		this.checkParts()

		for (const kind of ["footnote", "endnote"] as const) {
			const name = `word/${kind}s.xml`
			const before = byId(plan.translatedXml(name))
			const after = byId(plan.editedXml(name))

			for (const [id, note] of after) {
				const was = before.get(id)

				if (was === undefined || !equalBytes(was.bytes, note.bytes)) this.dirtyNotes.add(`${kind}:${id}`)
			}
		}

		this.eNotes = { footnote: byId(plan.editedXml("word/footnotes.xml")), endnote: byId(plan.editedXml("word/endnotes.xml")) }

		const comments = byId(plan.translatedXml("word/comments.xml"))

		this.eComments = byId(plan.editedXml("word/comments.xml"))

		for (const [id, comment] of this.eComments) {
			const was = comments.get(id)

			if (was === undefined || !equalBytes(was.bytes, comment.bytes)) this.dirtyComments.add(id)
		}
	}

	// Parts besides the body: what the writer can write of their changes, and refusals for the rest.
	private checkParts(): void {
		const plan = this.plan

		for (const name of plan.edits.removed ?? []) {
			if (!NOTE_PARTS.has(name)) throw new OdtWriteRefusal("part", `the edit removed ${name}`)
		}

		for (const [name, bytes] of plan.edits.parts) {
			if (name === BODY_PART || name === RELS_PART || IGNORED_PARTS.has(name) || NOTE_PARTS.has(name)) continue

			const before = plan.translation.parts.get(name)

			if (before instanceof Uint8Array && equalBytes(before, bytes)) continue

			if (STORY_PART.test(name) || name.startsWith("word/media/")) continue
			if (name === "word/styles.xml") this.checkStyles()
			else if (name === "word/numbering.xml") this.checkNumbering()
			else if (name === "word/settings.xml") this.checkSettings()
			else if (name === "word/commentsExtended.xml") this.checkCommentsExtended(bytes)
			// Comments' durable ids and UTC dates: an annotation has its own date (Part 3 §14.1).
			else if (name === "word/commentsIds.xml" || name === "word/commentsExtensible.xml") continue
			else throw new OdtWriteRefusal("part", `the edit changed ${name}`)
		}
	}

	// A comment's thread and state (w15:commentEx): a reply or a resolved comment has no form in ODF 1.3's
	// office:annotation (Part 3 §14.1), a comment of its own (done 0, no parent) is just that.
	private checkCommentsExtended(bytes: Uint8Array): void {
		const document = parseXml(bytes)
		const root = document.documentElement()

		for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) !== "commentEx") continue

			for (const attribute of document.attributes(child)) {
				const local = attribute.name.slice(attribute.name.indexOf(":") + 1)

				if ((local === "done" && attribute.value !== "0" && attribute.value !== "false") || local === "paraIdParent")
					throw new OdtWriteRefusal("comment", "a reply or a resolved comment (ODF 1.3 annotations record neither)")
			}
		}
	}

	// Styles: new ones are written to styles.xml; a changed one is refused.
	private checkStyles(): void {
		const before = this.plan.translatedXml("word/styles.xml")
		const after = this.plan.editedXml("word/styles.xml")

		if (before === undefined || after === undefined) throw new OdtWriteRefusal("styles", "the edit removed the styles")

		const known = new Map<string, number>()
		const rootBefore = before.documentElement()

		for (let child = before.firstChildElement(rootBefore); child >= 0; child = before.nextSiblingElement(child)) {
			known.set(styleKey(before, child), child)
		}

		const root = after.documentElement()

		for (let child = after.firstChildElement(root); child >= 0; child = after.nextSiblingElement(child)) {
			const key = styleKey(after, child)
			const was = known.get(key)

			if (was === undefined) {
				if (after.localName(child) !== "style")
					throw new OdtWriteRefusal("styles", `the edit added ${after.localName(child)} to the styles`)

				this.newStyles.set(after.attribute(child, "w:styleId") ?? "", child)
			} else if (canonicalElement(before, was) !== canonicalElement(after, child)) {
				const type = after.attribute(child, "w:type")

				// A paragraph or character style is written where it is (its name kept); the rest are refused.
				if (after.localName(child) !== "style" || (type !== "paragraph" && type !== "character")) {
					throw new OdtWriteRefusal("styles", `the edit changed the style ${key}`)
				}

				this.changedStyles.set(after.attribute(child, "w:styleId") ?? "", { before: was, after: child })
			}
		}
	}

	// Numbering: new w:num and w:abstractNum are written as lists; a changed one is refused.
	private checkNumbering(): void {
		const before = this.plan.translatedXml("word/numbering.xml")
		const after = this.plan.editedXml("word/numbering.xml")

		if (after === undefined) throw new OdtWriteRefusal("numbering", "the edit removed the numbering")

		const known = new Map<string, number>()

		if (before !== undefined) {
			const root = before.documentElement()

			for (let child = before.firstChildElement(root); child >= 0; child = before.nextSiblingElement(child)) {
				known.set(numberingKey(before, child), child)
			}
		}

		const root = after.documentElement()

		for (let child = after.firstChildElement(root); child >= 0; child = after.nextSiblingElement(child)) {
			const key = numberingKey(after, child)
			const was = known.get(key)

			if (before === undefined || was === undefined || canonicalElement(before, was) === canonicalElement(after, child)) continue

			// A definition's levels are its list style's (kept by name, Part 3 §16.32); a w:num's overrides have no
			// form of their own there (a list restarts with text:continue-numbering or a start value of its own).
			if (after.localName(child) !== "abstractNum")
				throw new OdtWriteRefusal("numbering", `the edit changed the list definition ${key}`)

			this.changedLists.set(after.attribute(child, "w:abstractNumId") ?? "", { before: was, after: child })
		}
	}

	private checkSettings(): void {
		const before = this.plan.translatedXml("word/settings.xml")
		const after = this.plan.editedXml("word/settings.xml")

		if (before === undefined || after === undefined) throw new OdtWriteRefusal("settings", "the edit removed the settings")

		const read = (document: XmlDocument): { tracking: boolean; rest: string } => {
			const rest: string[] = []
			let tracking = false
			const root = document.documentElement()

			for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
				const local = document.localName(child)

				if (local === "trackRevisions") tracking = !["0", "false", "off"].includes(document.attribute(child, "w:val") ?? "true")
				else if (local !== "rsids" && local !== "proofState") rest.push(canonicalElement(document, child))
			}

			return { tracking, rest: rest.sort().join("") }
		}
		const was = read(before)
		const now = read(after)

		if (now.tracking !== was.tracking) this.tracking = now.tracking
		if (was.rest !== now.rest) throw new OdtWriteRefusal("settings", "the edit changed the document settings")
	}

	// A block's key for matching: its bytes, or a key of its own where a note or comment it holds changed.
	keys(document: XmlDocument, blocks: readonly number[], edited: boolean): string[] {
		return blocks.map((block, index) => {
			const bytes = document.raw(block)

			if (edited && (this.touchesDirty(document, block) || this.forced.has(block))) return `dirty${index}`

			return `${fnv(bytes)}:${bytes.length}`
		})
	}

	private touchesDirty(document: XmlDocument, block: number): boolean {
		if (this.dirtyNotes.size === 0 && this.dirtyComments.size === 0) return false

		const stack = [block]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				const local = document.localName(child)

				if (local === "footnoteReference" && this.dirtyNotes.has(`footnote:${document.attribute(child, "w:id") ?? ""}`)) return true
				if (local === "endnoteReference" && this.dirtyNotes.has(`endnote:${document.attribute(child, "w:id") ?? ""}`)) return true
				if (local === "commentRangeStart" && this.dirtyComments.has(document.attribute(child, "w:id") ?? "")) return true

				stack.push(child)
			}
		}

		return false
	}
}

function styleKey(document: XmlDocument, node: number): string {
	const local = document.localName(node)

	return local === "style" ? `style:${document.attribute(node, "w:type") ?? ""}:${document.attribute(node, "w:styleId") ?? ""}` : local
}

function numberingKey(document: XmlDocument, node: number): string {
	const local = document.localName(node)

	return local === "num"
		? `num:${document.attribute(node, "w:numId") ?? ""}`
		: local === "abstractNum"
			? `abstract:${document.attribute(node, "w:abstractNumId") ?? ""}`
			: `${local}:${canonicalElement(document, node)}`
}

const W_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

// One write of the edited document.
class OdtWrite {
	private readonly plan: OdtPlan
	private readonly doc: EditedDocument
	private readonly mode: WriteMode
	private readonly content: Stream
	private readonly styles: Stream
	private readonly taken: Set<string>
	private readonly emitter: OdfEmitter
	private readonly context: EmitContext
	private readonly segments: Segment[] = []
	private readonly failed = new Map<number, string>()
	// Single blocks Gate 1 locks (of units otherwise rewritten), by translation block index.
	private readonly failedBlocks = new Map<number, string>()
	private written = 0
	private readonly newLists = new Map<string, ListTarget>()
	private readonly newCommonStyles = new Map<string, string>()
	// content.xml's replacements as written.
	private replaced: Replacement[] = []

	constructor(doc: EditedDocument, mode: WriteMode) {
		this.plan = doc.plan
		this.doc = doc
		this.mode = mode

		const plan = this.plan

		this.taken = takenNames(plan)
		this.content = new Stream("content.xml", plan.contentBytes, plan.prologueDocument, this.taken)
		this.styles = new Stream("styles.xml", plan.stylesBytes, plan.stylesDocument, this.taken)

		for (const [stream, scope] of [
			[this.content, "content"],
			[this.styles, "styles"]
		] as const) {
			const forms = new Map<string, Map<string, string>>()

			stream.registry.existing = family => {
				let known = forms.get(family)

				if (known === undefined) {
					known = new Map()

					if (family === "text" || family === "paragraph") {
						for (const name of plan.sheet.automaticNames(family, scope)) {
							const style = plan.sheet.style(family, name, scope)
							const form = style?.automatic === true ? writtenForm(style) : undefined
							const key = form === undefined ? undefined : `${form.attributes}\u0000${form.properties}`

							if (key !== undefined && !known.has(key)) known.set(key, name)
						}
					}

					forms.set(family, known)
				}

				return known
			}
		}

		const eStyles = plan.editedXml("word/styles.xml")
		const chains = new StyleChains(eStyles)
		this.context = {
			scope: "content",
			sheet: plan.sheet,
			mapper: plan.mapper,
			chains,
			registry: this.content.registry,
			listIds: this.content.lists,
			fonts: { face: family => this.face(family) },
			tabsRelativeToIndent: plan.tabsRelativeToIndent,
			atoms: new AtomPool(),
			declarations: this.content.declarations,
			paragraphStyle: id => this.paragraphStyleName(id),
			characterStyle: id => this.characterStyleName(id),
			hyperlink: id => {
				const relationship = doc.eRels.get(id)

				return relationship?.external === true ? relationship.target : undefined
			},
			list: numId => this.listTarget(numId),
			levelIndent: (numId, ilvl) => this.levelIndent(numId, ilvl),
			levelStart: (numId, ilvl) => this.levelStart(numId, ilvl),
			sourceListId: numId => this.sourceListId(numId),
			originStyle: rsid => this.originStyle(rsid),
			tracksOrigin: style => this.untranslated(style, "content"),
			continuesLists: odfVersion(plan.rootOpen) >= 1.2,
			version: odfVersion(plan.rootOpen),
			precedingList: (document, paragraph) => (document === doc.eBody ? this.precedingList(paragraph) : undefined),
			masterOf: (_document, paragraph) => doc.masters.get(paragraph),
			picture: (document, drawing) => this.picture(document, drawing, doc.eRels, this.content),
			change: (kind, author, date, deleted) => {
				const id = this.content.registry.name("ctFilen", true)

				this.changes.push(
					`<text:changed-region${this.content.declarations} xml:id="${esc(id)}" text:id="${esc(id)}"><text:${kind}><office:change-info><dc:creator>${escText(author)}</dc:creator><dc:date>${escText((date ?? "").replace(/Z$/u, ""))}</dc:date></office:change-info>${deleted}</text:${kind}></text:changed-region>`
				)

				return id
			},
			note: (kind, id) => {
				const note = doc.eNotes[kind].get(id)
				const document = plan.editedXml(`word/${kind}s.xml`)

				return note === undefined || document === undefined ? undefined : { document, node: note.node }
			},
			comment: id => {
				const comment = doc.eComments.get(id)
				const document = plan.editedXml("word/comments.xml")

				return comment === undefined || document === undefined ? undefined : { document, node: comment.node }
			},
			drawingKey: (document, drawing) => drawingKey(document, drawing, doc.eRels, plan.translation),
			shellKey: (document, drawing) => drawingKey(document, drawing, doc.eRels, plan.translation, true),
			noteKey: (kind, id) => (doc.dirtyNotes.has(`${kind}:${id}`) ? `new:${kind}:${id}` : `${kind}:${id}`),
			fieldKey: (document, field) => fieldKey(document, field),
			...markNames(plan.contentBytes),
			commentKey: id => (doc.dirtyComments.has(id) ? `new:comment:${id}` : `comment:${id}`),
			bookmarkName: (document, id) => {
				let names = this.bookmarkNames.get(document)

				if (names === undefined) {
					names = new Map()

					const stack = [document.documentElement()]

					for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
						for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
							if (document.localName(child) === "bookmarkStart")
								names.set(document.attribute(child, "w:id") ?? "", document.attribute(child, "w:name") ?? "")
							else stack.push(child)
						}
					}

					this.bookmarkNames.set(document, names)
				}

				return names.get(id)
			},
			paragraphSources: new Map(),
			links: new Map()
		}
		this.emitter = new OdfEmitter(this.context)
	}

	// The font face a stream declares for a family, declared there when it has none (a face content.xml declares is
	// not one styles.xml's styles may name).
	private face(family: string, stream: Stream = this.content): string {
		stream.declaredFaces ??= declaredFaces(stream === this.content ? stream.bytes.subarray(0, this.plan.prologueEnd) : stream.bytes)

		const declared = stream.declaredFaces.get(family) ?? stream.faceNames.get(family)

		if (declared !== undefined) return declared

		let name = family
		let next = 2

		while (this.plan.sheet.fontFaces.has(name) || this.taken.has(`face:${name}`)) name = `${family}${next++}`

		this.taken.add(`face:${name}`)
		stream.faceNames.set(family, name)
		stream.newFaces.push(
			`<style:font-face${stream.declarations} style:name="${esc(name)}" svg:font-family="${esc(family.includes(" ") ? `'${family}'` : family)}"/>`
		)

		return name
	}

	private paragraphStyleName(id: string): string | undefined {
		if (this.plan.sheet.commonStyle("paragraph", id) !== undefined) return id

		return this.newCommonStyle(id, "paragraph")
	}

	private characterStyleName(id: string): string | undefined {
		if (id.startsWith("T_") && this.plan.sheet.commonStyle("text", id.slice(2)) !== undefined) return id.slice(2)

		return this.newCommonStyle(id, "text")
	}

	// A style the edit added (a built-in style applied), written to styles.xml as a common style.
	private newCommonStyle(id: string, family: "paragraph" | "text"): string | undefined {
		const known = this.newCommonStyles.get(id)

		if (known !== undefined) return known

		const node = this.doc.newStyles.get(id)
		const document = this.plan.editedXml("word/styles.xml")

		if (node === undefined || document === undefined) return undefined

		const type = document.attribute(node, "w:type")

		if ((family === "paragraph" ? "paragraph" : "character") !== type) return undefined

		let name = family === "paragraph" ? id : id.startsWith("T_") ? id.slice(2) : id
		let next = 2

		while (this.taken.has(name)) name = `${id}${next++}`

		this.taken.add(name)
		this.newCommonStyles.set(id, name)

		let displayName = name
		let parent: string | undefined
		let outline = ""
		const paragraph = new Map<string, string>()
		const text = new Map<string, string>()
		let tabs = ""

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "name") displayName = document.attribute(child, "w:val") ?? name
			else if (local === "basedOn") {
				const based = document.attribute(child, "w:val")

				parent =
					based === undefined
						? undefined
						: family === "paragraph"
							? this.paragraphStyleName(based)
							: this.characterStyleName(based)
			} else if (local === "pPr") {
				const props: Props = new Map()

				readProps(document, child, props, PARAGRAPH_SKIPPED)

				for (const [property, value] of props) {
					if (property === "outlineLvl") {
						outline = ` style:default-outline-level="${Number(value.attributes.get("val") ?? "0") + 1}"`

						continue
					}

					const written = paragraphAttributesOrRefuse(property, value, this.plan.tabsRelativeToIndent)

					for (const [attribute, item] of written.attributes) paragraph.set(attribute, item)
					for (const [attribute, item] of written.text ?? []) text.set(attribute, item)

					if (written.tabs !== undefined) tabs = written.tabs
				}
			} else if (local === "rPr") {
				const props: Props = new Map()

				readProps(document, child, props)

				for (const [property, value] of props) {
					const written = runAttributesOrRefuse(property, value, this.context.fonts)

					for (const [attribute, item] of written) text.set(attribute, item)
				}
			}
		}

		const properties = `${paragraph.size === 0 && tabs === "" ? "" : `<style:paragraph-properties${sorted(paragraph)}${tabs === "" ? "/>" : `><style:tab-stops>${tabs}</style:tab-stops></style:paragraph-properties>`}`}${text.size === 0 ? "" : `<style:text-properties${sorted(text)}/>`}`

		this.newStylesMarkup.push(
			`<style:style${this.styles.declarations} style:name="${esc(name)}" style:display-name="${esc(displayName === name ? name : displayName.replace(/^./u, letter => letter.toUpperCase()))}" style:family="${family}"${parent === undefined ? "" : ` style:parent-style-name="${esc(parent)}"`}${outline}>${properties}</style:style>`
		)

		return name
	}

	private readonly newStylesMarkup: string[] = []

	// Page setup the edit changed (w:sectPr of the same sections): written to the page layout each section reads
	// (style:page-layout-properties, Part 3 §17.2): size, orientation, margins and columns. A layout two sections share
	// changes for both; one a section changed differently from another is refused.
	private pageSetup(): void {
		const doc = this.doc
		const sections = (document: XmlDocument, body: readonly number[], last: number): number[] => {
			const out: number[] = []

			for (const block of body) {
				if (document.localName(block) !== "p") continue

				const pPr = childNamed(document, block, "pPr")
				const sectPr = pPr < 0 ? -1 : childNamed(document, pPr, "sectPr")

				if (sectPr >= 0) out.push(sectPr)
			}

			if (last >= 0) out.push(last)

			return out
		}
		let before = sections(doc.tBody, doc.tBlocks, doc.tSection)
		let after = sections(doc.eBody, doc.eBlocks, doc.eSection)

		this.editedSections = after
		let layouts = this.plan.translation.sections
		let split = new Set<number>()
		// Each section's header and footer references, those it leaves out the previous section's (ECMA-376 Part 1
		// §17.10.5); continuous sections take none.
		const references = new Map<number, Map<string, string>>()
		const inherit = (document: XmlDocument, list: readonly number[]): void => {
			const running = new Map<string, string>()

			for (const sectPr of list) {
				if (document.attribute(childNamed(document, sectPr, "type"), "w:val") !== "continuous") {
					for (let child = document.firstChildElement(sectPr); child >= 0; child = document.nextSiblingElement(child)) {
						const local = document.localName(child)

						if (local === "headerReference" || local === "footerReference")
							running.set(`${local}:${document.attribute(child, "w:type") ?? "default"}`, canonicalElement(document, child))
					}
				}

				references.set(sectPr, new Map(running))
			}
		}

		inherit(doc.tBody, before)
		inherit(doc.eBody, after)

		if (before.length !== after.length) {
			const paired = this.sectionBreaks(before, after)

			before = paired.before
			after = paired.after
			layouts = paired.layouts
			split = paired.split
		}

		const patches = new Map<string, Replacement>()
		const pairs = new Map(before.map((node, k) => [node, after[k] ?? -1]))
		const setup = (document: XmlDocument, sectPr: number): string => {
			let out = ""

			for (let child = document.firstChildElement(sectPr); child >= 0; child = document.nextSiblingElement(child)) {
				const local = document.localName(child)

				if (local === "headerReference" || local === "footerReference") continue
				if (local === "type" && document.attribute(child, "w:val") === "nextPage") continue
				// A split section's restart of page numbering went with its first part (written where it was).
				if (local === "pgNumType" && (split.has(sectPr) || split.has(pairs.get(sectPr) ?? -1))) continue

				out += canonicalElement(document, child)
			}

			return out + [...(references.get(sectPr) ?? [])].sort().join("")
		}
		const columns = (document: XmlDocument, sectPr: number): string => {
			const cols = childNamed(document, sectPr, "cols")

			return cols < 0 ? "" : canonicalElement(document, cols)
		}
		const left: number[] = []
		const columnsChanged = new Set<string>()
		const targets: { k: number; edited: number; layout: string; first: boolean; patch: Replacement; spacers: boolean }[] = []

		before.forEach((section, k) => {
			const edited = after[k] ?? -1

			if (setup(doc.tBody, section) === setup(doc.eBody, edited)) {
				left.push(k)

				return
			}

			if (doc.tBody.attribute(childNamed(doc.tBody, section, "type"), "w:val") === "continuous" && k < before.length - 1) {
				this.sectionColumns(section, edited)

				return
			}

			if (columns(doc.tBody, section) !== columns(doc.eBody, edited)) columnsChanged.add(layouts[k]?.layout ?? "")

			const layout = layouts[k]?.layout

			if (layout === undefined) {
				this.firstPageLayout(edited, before.length)

				return
			}

			// A section with a first page of its own (titlePg, a style:next-style-name chain, §16.9) shows its first
			// page on the first master's layout and the rest on its master's: each set up with the headers it shows.
			const refs = references.get(edited) ?? new Map<string, string>()
			const master = layouts[k]?.master
			const start = layouts[k]?.start
			const titled = start !== undefined && start !== master && childNamed(doc.eBody, edited, "titlePg") >= 0
			const target = (name: string, first: boolean): void => {
				const spacers = this.spacers.length
				// Each layout shows the headers of its own pages: the first page's, or the rest's.
				const own = titled ? new Map([...refs].filter(([key]) => key.endsWith(":first") === first)) : refs
				const patch = this.layoutPatch(doc.tBody, section, doc.eBody, edited, name, own, split.has(edited))

				targets.push({ k, edited, layout: name, first, patch, spacers: this.spacers.length > spacers })
			}

			target(layout, false)

			if (titled) {
				const firstLayout = this.plan.sheet.masterPages.get(start)?.pageLayout

				if (firstLayout !== undefined) target(firstLayout, true)
			}
		})

		// The layouts each section left as it was shows.
		const leftLayouts = new Map<number, string[]>()

		for (const k of left) {
			const names = [layouts[k]?.layout]
			const start = layouts[k]?.start

			if (start !== undefined) names.push(this.plan.sheet.masterPages.get(start)?.pageLayout)

			leftLayouts.set(
				k,
				names.filter((name): name is string => name !== undefined)
			)
		}

		// A page layout is the page's for every section on it (Part 3 §16.5): set up in place where every section on it
		// is set up alike; otherwise each changed section takes copies of its master pages on copies of their layouts.
		// A section of its own (an ODF text:section, continuous) shows the page; it takes its columns too (§16.9).
		const copied = new Set<number>()

		for (let settled = false; !settled;) {
			settled = true

			for (const layout of new Set(targets.map(item => item.layout))) {
				const group = targets.filter(item => item.layout === layout && !copied.has(item.k))

				if (group.length === 0) continue

				const others = left.filter(k => leftLayouts.get(k)?.includes(layout) === true)
				const paged = others.filter(
					k => doc.tBody.attribute(childNamed(doc.tBody, before[k] ?? -1, "type"), "w:val") !== "continuous"
				)

				if (paged.length > 0 || this.sharedLayouts.has(layout) || new Set(group.map(item => item.patch.text)).size > 1) {
					if (others.length > paged.length)
						throw new OdtWriteRefusal(
							"sections",
							"a page layout a section of its own shares, set up apart from the pages around it"
						)

					for (const item of group) copied.add(item.k)

					settled = false
				}
			}
		}

		for (const item of targets) {
			if (copied.has(item.k)) continue

			for (const k of left.filter(other => leftLayouts.get(other)?.includes(item.layout) === true)) {
				// Text on a page with columns flows in them, a text:section's included (Part 3, style:columns of
				// style:page-layout-properties): no part of one page style can keep a column count of its own.
				if (columnsChanged.has(layouts[item.k]?.layout ?? "") && childNamed(doc.tBody, before[k] ?? -1, "cols") < 0) {
					throw new OdtWriteRefusal(
						"sections",
						"the page's columns where a section of its own follows them (ODF page columns hold every section on the page)"
					)
				}
			}

			patches.set(item.layout, item.patch)
		}

		for (const k of copied) {
			const own = targets.filter(item => item.k === k)
			const pagesTarget = own.find(item => !item.first)
			const firstTarget = own.find(item => item.first)

			if (own.some(item => item.spacers))
				throw new OdtWriteRefusal("sections", "a header's or footer's spacing on a page layout other sections share")

			const block = this.sectionStart(after, k)
			const master = layouts[k]?.master
			const start = layouts[k]?.start

			if (block < 0 || master === undefined || pagesTarget === undefined)
				throw new OdtWriteRefusal("sections", "a section starting where no block starts")

			this.pageChanged = true

			const copy = this.layoutCopy(pagesTarget.layout, pagesTarget.patch)
			const first = start === undefined || start === master ? undefined : this.plan.sheet.masterPages.get(start)

			if (start !== undefined && start !== master && (first === undefined || first.next !== master))
				throw new OdtWriteRefusal("sections", "a first page whose next page style is not its section's")

			// The master page the section starts at, whose next is the section's (style:next-style-name, §16.9).
			const firstCopy =
				firstTarget === undefined
					? undefined
					: firstTarget.layout === pagesTarget.layout && firstTarget.patch.text === pagesTarget.patch.text
						? copy
						: this.layoutCopy(firstTarget.layout, firstTarget.patch)
			// A page style of its own at `at`: copies of the section's master pages (each start its own, so two
			// sections in a row stay two).
			const startAt = (at: number): void => {
				const pages = this.copyMaster(master, copy)

				doc.masters.set(at, start === undefined || start === master ? pages : this.copyMaster(start, firstCopy, pages))
				doc.forced.add(at)
			}

			startAt(block)

			// The part a new break split off, set up as this one, shows the same pages.
			const follower = this.followers.get(pagesTarget.edited)

			if (follower !== undefined && follower >= 0) startAt(follower)
		}

		for (const patch of patches.values()) this.styles.replacements.push(patch)

		for (const layout of patches.keys()) this.patchedLayouts.add(layout)

		if (patches.size > 0 || this.newMasters.some(master => master.layout !== undefined)) this.pageChanged = true
	}

	private pageChanged = false
	// The space the body's tables add to the paragraphs beside them (tableSpacing.ts); undefined: no table has any.
	private tableSpacing: TableSpacing | undefined = undefined
	// A new section's first part set up as the rest of the section it split, by that rest's w:sectPr: its start block.
	private readonly followers = new Map<number, number>()
	// Layouts a new section's first part shows as the source had them (a page setup elsewhere keeps them).
	private readonly sharedLayouts = new Set<string>()
	// Every section of the edit, by its w:sectPr, in order.
	private editedSections: readonly number[] | undefined
	private readonly patchedLayouts = new Set<string>()

	// Header and footer tables that follow the page of a layout set up anew in place keep the widths they show
	// (those a rewritten header writes anew aside).
	private fixRegionTables(): void {
		const styles = this.plan.stylesDocument

		for (const master of this.plan.sheet.masterPages.values()) {
			if (master.pageLayout === undefined || !this.patchedLayouts.has(master.pageLayout) || master.node < 0) continue

			for (const fix of this.regionTableFixes(styles.start(master.node), styles.end(master.node))) {
				if (!this.styles.replacements.some(item => item.start < fix.end && fix.start < item.end)) this.styles.replacements.push(fix)
			}
		}
	}

	// A document without master pages shows a default page (Part 3 §16.9): set up, it gains a page layout and the
	// master page that names it, the first, which every page without one of its own takes (§16.5).
	private firstPageLayout(edited: number, sections: number): void {
		const styles = this.plan.stylesDocument
		const namespaces = new Namespaces(styles)
		const root = styles.documentElement()
		let automatic = false
		let masters = -1

		for (let child = styles.firstChildElement(root); child >= 0; child = styles.nextSiblingElement(child)) {
			const element = elementName(styles, namespaces, child)

			if (element === "office:master-styles") masters = child
			if (element === "office:automatic-styles") automatic = true
		}

		if (masters >= 0 && styles.firstChildElement(masters) >= 0)
			throw new OdtWriteRefusal("sections", "page setup of a section without a page layout")

		if (!automatic || sections !== 1 || this.plan.sheet.masterPages.size > 0) {
			throw new OdtWriteRefusal("sections", "page setup of a section without a page layout")
		}

		const eDoc = this.doc.eBody

		if (childNamed(eDoc, edited, "headerReference") >= 0 || childNamed(eDoc, edited, "footerReference") >= 0) {
			throw new OdtWriteRefusal("sections", "a header or footer on a page without a master page")
		}

		const value = (local: string, key: string): number => Number(eDoc.attribute(childNamed(eDoc, edited, local), `w:${key}`) ?? "0")
		const point = (twips: number): string => `${Math.round((twips / 20) * 10_000) / 10_000}pt`
		const cols = childNamed(eDoc, edited, "cols")
		const count = Number(eDoc.attribute(cols, "w:num") ?? "1") || 1

		if (eDoc.attribute(cols, "w:equalWidth") === "0") throw new OdtWriteRefusal("sections", "columns of unequal widths")

		for (let child = eDoc.firstChildElement(edited); child >= 0; child = eDoc.nextSiblingElement(child)) {
			const local = eDoc.localName(child)

			if (local !== "pgSz" && local !== "pgMar" && local !== "cols" && local !== "type")
				throw new OdtWriteRefusal("sections", `the section property ${local}`)
		}

		const columns =
			count > 1
				? `<style:columns fo:column-count="${count}" fo:column-gap="${point(value("cols", "space"))}">${eDoc.attribute(cols, "w:sep") === "1" ? '<style:column-sep style:width="0.0071in" style:color="#000000" style:height="100%"/>' : ""}</style:columns>`
				: ""
		const properties = `<style:page-layout-properties fo:page-width="${point(value("pgSz", "w"))}" fo:page-height="${point(value("pgSz", "h"))}" style:print-orientation="${eDoc.attribute(childNamed(eDoc, edited, "pgSz"), "w:orient") === "landscape" ? "landscape" : "portrait"}" fo:margin-top="${point(value("pgMar", "top"))}" fo:margin-bottom="${point(value("pgMar", "bottom"))}" fo:margin-left="${point(value("pgMar", "left"))}" fo:margin-right="${point(value("pgMar", "right"))}"${columns === "" ? "/>" : `>${columns}</style:page-layout-properties>`}`
		const registry = this.styles.registry
		const layout = registry.element(
			`page-layout\u0000${properties}`,
			"pm",
			name => `<style:page-layout${this.styles.declarations} style:name="${esc(name)}">${properties}</style:page-layout>`
		)
		const master = registry.name("Standard")
		const page = `<style:master-page${this.styles.declarations} style:name="${esc(master)}" style:page-layout-name="${esc(layout)}"/>`

		if (masters < 0) {
			const at = styles.contentEnd(root)

			this.styles.replacements.push({
				start: at,
				end: at,
				text: `<office:master-styles${this.styles.declarations}>${page}</office:master-styles>`
			})
		} else if (styles.isSelfClosing(masters)) {
			this.styles.replacements.push({
				start: styles.start(masters),
				end: styles.end(masters),
				text: `<${styles.name(masters)}>${page}</${styles.name(masters)}>`
			})
		} else this.styles.replacements.push({ start: styles.contentEnd(masters), end: styles.contentEnd(masters), text: page })
		this.pageChanged = true
	}

	// Paragraph and character styles the edit changed: the common style of that name rewritten in styles.xml where
	// its properties changed (Part 3 §16.2), everything else of it kept.
	private changedCommonStyles(): void {
		const doc = this.doc

		if (doc.changedStyles.size === 0) return

		const before = this.plan.translatedXml("word/styles.xml")
		const after = this.plan.editedXml("word/styles.xml")

		if (before === undefined || after === undefined) return

		const document = this.plan.stylesDocument
		const namespaces = new Namespaces(document)
		const fonts = { face: (family: string) => this.face(family, this.styles) }

		for (const [id, nodes] of doc.changedStyles) {
			const paragraphStyle = after.attribute(nodes.after, "w:type") === "paragraph"
			const family = paragraphStyle ? "paragraph" : "text"
			const name = paragraphStyle ? id : id.startsWith("T_") ? id.slice(2) : undefined

			if (name === undefined || this.plan.sheet.commonStyle(family, name) === undefined) {
				throw new OdtWriteRefusal("styles", `the edit changed the style ${id}, which the document does not have`)
			}

			// What besides the properties changed has no place to go: refused.
			const others = (xml: XmlDocument, node: number): string => {
				let out = ""

				for (let child = xml.firstChildElement(node); child >= 0; child = xml.nextSiblingElement(child)) {
					const local = xml.localName(child)

					if (local !== "pPr" && local !== "rPr" && local !== "name" && local !== "rsid") out += canonicalElement(xml, child)
				}

				return out
			}

			if (others(before, nodes.before) !== others(after, nodes.after))
				throw new OdtWriteRefusal("styles", `the style ${id} beyond its properties`)

			const props = (xml: XmlDocument, node: number, local: string): Props => {
				const out: Props = new Map()
				const element = childNamed(xml, node, local)

				if (element >= 0) readProps(xml, element, out, local === "pPr" ? PARAGRAPH_SKIPPED : undefined)

				return out
			}
			const paragraph = new Map<string, string | undefined>()
			const text = new Map<string, string | undefined>()
			let tabs: string | undefined
			const wasP = props(before, nodes.before, "pPr")
			const nowP = props(after, nodes.after, "pPr")

			for (const local of new Set([...wasP.keys(), ...nowP.keys()])) {
				const was = wasP.get(local)
				const now = nowP.get(local)

				if (was !== undefined && now !== undefined && samePropertyValue(was, now)) continue
				if (local === "outlineLvl" || local === "numPr") throw new OdtWriteRefusal("styles", `the style ${id}'s ${local}`)

				for (const attribute of paragraphSources(local)) paragraph.set(attribute, undefined)
				for (const attribute of paragraphTextSources(local)) text.set(attribute, undefined)

				if (local === "tabs") tabs = ""
				if (now === undefined) continue

				const written = paragraphAttributesOrRefuse(local, now, this.plan.tabsRelativeToIndent)

				for (const [attribute, value] of written.attributes) paragraph.set(attribute, value)
				for (const [attribute, value] of written.text ?? []) text.set(attribute, value)

				if (written.tabs !== undefined) tabs = written.tabs
			}

			const wasR = props(before, nodes.before, "rPr")
			const nowR = props(after, nodes.after, "rPr")

			for (const local of new Set([...wasR.keys(), ...nowR.keys()])) {
				const was = wasR.get(local)
				const now = nowR.get(local)

				if (was !== undefined && now !== undefined && samePropertyValue(was, now)) continue

				for (const attribute of runSources(local)) text.set(attribute, undefined)

				if (now === undefined) continue

				for (const [attribute, value] of runAttributesOrRefuse(local, now, fonts)) text.set(attribute, value)
			}

			const element = this.commonStyleElement(document, namespaces, family, name)

			if (element < 0) throw new OdtWriteRefusal("styles", `the style ${name} in styles.xml`)

			const rewrite = (kind: string, changes: Map<string, string | undefined>, newTabs: string | undefined): string | undefined => {
				if (changes.size === 0 && newTabs === undefined) return undefined

				const tag = `style:${kind}-properties`
				let source = -1

				for (let child = document.firstChildElement(element); child >= 0; child = document.nextSiblingElement(child)) {
					if (elementName(document, namespaces, child) === tag) source = child
				}

				const attributes = new Map<string, string>()

				if (source >= 0)
					for (const attribute of document.attributes(source))
						attributes.set(canonicalAttribute(namespaces, source, attribute.name), attribute.value)

				for (const [key, value] of changes) {
					if (value === undefined) attributes.delete(key)
					else attributes.set(key, value)
				}

				let inner = ""

				for (
					let child = source < 0 ? -1 : document.firstChildElement(source);
					child >= 0;
					child = document.nextSiblingElement(child)
				) {
					if (newTabs !== undefined && elementName(document, namespaces, child) === "style:tab-stops") continue

					inner += decodeUtf8(document.raw(child))
				}

				if (newTabs !== undefined && newTabs !== "") inner = `<style:tab-stops>${newTabs}</style:tab-stops>${inner}`

				return `<${tag}${this.styles.declarations}${[...attributes].map(([key, value]) => ` ${key}="${esc(value)}"`).join("")}${inner === "" ? "/>" : `>${inner}</${tag}>`}`
			}
			// The properties first, paragraph before text (their schema order, Part 3 §16.2), then the rest as it is.
			let properties = ""
			let rest = ""
			const sourceOf = (tag: string): string => {
				for (let child = document.firstChildElement(element); child >= 0; child = document.nextSiblingElement(child)) {
					if (elementName(document, namespaces, child) === tag) return decodeUtf8(document.raw(child))
				}

				return ""
			}

			properties += rewrite("paragraph", paragraph, tabs) ?? sourceOf("style:paragraph-properties")
			properties += rewrite("text", text, undefined) ?? sourceOf("style:text-properties")

			for (let child = document.firstChildElement(element); child >= 0; child = document.nextSiblingElement(child)) {
				const tag = elementName(document, namespaces, child)

				if (tag !== "style:paragraph-properties" && tag !== "style:text-properties") rest += decodeUtf8(document.raw(child))
			}

			const children = properties + rest
			const open = decodeUtf8(document.raw(element).subarray(0, document.openEnd(element) - document.start(element)))
			const start = document.isSelfClosing(element) ? open.replace(/\s*\/>$/u, ">") : open

			this.styles.replacements.push({
				start: document.start(element),
				end: document.end(element),
				text: `${start}${children}</${document.name(element)}>`
			})
		}
	}

	private commonStyleElement(document: XmlDocument, namespaces: Namespaces, family: string, name: string): number {
		const root = document.documentElement()

		for (let container = document.firstChildElement(root); container >= 0; container = document.nextSiblingElement(container)) {
			if (elementName(document, namespaces, container) !== "office:styles") continue

			for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
				if (
					elementName(document, namespaces, child) === "style:style" &&
					attributeOf(document, namespaces, child, "style:family") === family &&
					attributeOf(document, namespaces, child, "style:name") === name
				)
					return child
			}
		}

		return -1
	}

	// List definitions the edit changed: each list style made from one (by its w:num) has its changed levels
	// rewritten, its name and other levels kept (Part 3 §16.32 to §16.35; the outline style's §16.36, §16.37).
	private changedListStyles(): void {
		const doc = this.doc

		if (doc.changedLists.size === 0) return

		const before = this.plan.translatedXml("word/numbering.xml")
		const after = this.plan.editedXml("word/numbering.xml")

		if (before === undefined || after === undefined) return

		const styles = new Map<string, Set<string>>()
		const root = before.documentElement()

		for (let child = before.firstChildElement(root); child >= 0; child = before.nextSiblingElement(child)) {
			if (before.localName(child) !== "num") continue

			const abstract = before.attribute(childNamed(before, child, "abstractNumId"), "w:val") ?? ""

			if (!doc.changedLists.has(abstract)) continue

			const known = this.plan.translation.numbering.get(Number(before.attribute(child, "w:numId") ?? ""))

			if (known === undefined) continue

			const key = `${known.scope}\u0000${known.style}`
			const set = styles.get(abstract) ?? new Set<string>()

			set.add(key)
			styles.set(abstract, set)
		}

		for (const [abstract, nodes] of doc.changedLists) {
			const levels = (document: XmlDocument, node: number): Map<string, number> => {
				const out = new Map<string, number>()

				for (let level = document.firstChildElement(node); level >= 0; level = document.nextSiblingElement(level)) {
					if (document.localName(level) === "lvl") out.set(document.attribute(level, "w:ilvl") ?? "0", level)
					else if (
						document.localName(level) !== "multiLevelType" &&
						document.localName(level) !== "nsid" &&
						document.localName(level) !== "tmpl"
					) {
						const twin = childNamed(before, nodes.before, document.localName(level))

						if (twin < 0 || canonicalElement(before, twin) !== canonicalElement(document, level)) {
							throw new OdtWriteRefusal("numbering", `the list definition's ${document.localName(level)}`)
						}
					}
				}

				return out
			}
			const was = levels(before, nodes.before)
			const now = levels(after, nodes.after)
			const changed: string[] = []

			for (const ilvl of new Set([...was.keys(), ...now.keys()])) {
				const old = was.get(ilvl)
				const level = now.get(ilvl)

				if (level === undefined) throw new OdtWriteRefusal("numbering", "a list level the edit removed")
				if (old === undefined || canonicalElement(before, old) !== canonicalElement(after, level)) changed.push(ilvl)
			}

			for (const key of styles.get(abstract) ?? []) {
				const [scope, name] = key.split("\u0000") as ["styles" | "content", string]
				const outline = name === "\u0000outline" || name === ""
				const stream = scope === "styles" || outline ? this.styles : this.content
				const document = scope === "styles" || outline ? this.plan.stylesDocument : this.plan.prologueDocument
				const element = this.listStyleElement(document, outline ? undefined : name)

				if (element < 0) throw new OdtWriteRefusal("numbering", `the list style ${name} the translation read`)

				const namespaces = new Namespaces(document)
				const at = new Map<number, number>()

				for (let child = document.firstChildElement(element); child >= 0; child = document.nextSiblingElement(child)) {
					at.set(Number(attributeOf(document, namespaces, child, "text:level") ?? "0"), child)
				}

				for (const ilvl of changed) {
					const markup = levelStyle(
						after,
						now.get(ilvl) ?? -1,
						{ face: family => this.face(family, stream) },
						outline ? "text:outline-level-style" : "text:list-level-style"
					)

					if (markup === undefined) throw new OdtWriteRefusal("numbering", `list level ${Number(ilvl) + 1} as it is now`)
					if (markup === "") continue

					const text = markup.replace(/^<([^\s>]+)/u, `<$1${stream.declarations}`)
					const source = at.get(Number(ilvl) + 1)

					if (source !== undefined)
						stream.replacements.push({ start: document.start(source), end: document.end(source), text, segment: -1 })
					else {
						if (document.isSelfClosing(element)) throw new OdtWriteRefusal("numbering", "a level added to an empty list style")

						stream.replacements.push({
							start: document.contentEnd(element),
							end: document.contentEnd(element),
							text,
							segment: -1
						})
					}
				}
			}
		}
	}

	// A list style by name (the outline style when undefined) in office:styles or office:automatic-styles.
	private listStyleElement(document: XmlDocument, name: string | undefined): number {
		const namespaces = new Namespaces(document)
		const root = document.documentElement()

		for (let container = document.firstChildElement(root); container >= 0; container = document.nextSiblingElement(container)) {
			const element = elementName(document, namespaces, container)

			if (element !== "office:styles" && element !== "office:automatic-styles") continue

			for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
				const local = elementName(document, namespaces, child)

				if (
					name === undefined
						? local === "text:outline-style"
						: local === "text:list-style" && attributeOf(document, namespaces, child, "style:name") === name
				)
					return child
			}
		}

		return -1
	}

	// Section breaks the edit added or removed (Part 3 §16.9: a page style starts where a paragraph's style names a
	// master page). An added break: the paragraph after it starts a copy of its section's master page (ODF has no
	// section break within one page style); a removed one: the paragraph after it names none. Returns the sections
	// both have, paired, for their page setup.
	private sectionBreaks(
		before: readonly number[],
		after: readonly number[]
	): { before: number[]; after: number[]; layouts: { master: string; layout: string | undefined }[]; split: Set<number> } {
		const doc = this.doc
		const sections = this.plan.translation.sections
		// Sections pair by where each ends: the source's ending paragraph's place in the edit (through the blocks'
		// texts matched in order, from the nearest matched block before it), aligned with the edit's ending paragraphs
		// at the least distance, in order. Page setup changes the sections' own properties, edits a few paragraphs'
		// texts; neither moves a section's end. The body's own sectPr pairs with the other's (below).
		const text = (document: XmlDocument, block: number): string =>
			`${document.localName(block)}:${document.textContent(block).slice(0, 200)}`
		const blocks = matchBlocks(
			doc.tBlocks.map(block => text(doc.tBody, block)),
			doc.eBlocks.map(block => text(doc.eBody, block))
		)
		const eIndex = new Map(doc.eBlocks.map((block, k) => [block, k]))
		const tIndex = new Map(doc.tBlocks.map((block, k) => [block, k]))
		const inBody = (document: XmlDocument, node: number): boolean => document.localName(document.parent(node)) === "body"
		const sources = before.map((_node, k) => k).filter(k => !inBody(doc.tBody, before[k] ?? -1))
		const targets = after.map((_node, k) => k).filter(k => !inBody(doc.eBody, after[k] ?? -1))
		// Where a source section's end should be: from the nearest matched block before it and the nearest after it.
		const expectedAt = sources.map(k => {
			const i = tIndex.get(doc.tBody.parent(doc.tBody.parent(before[k] ?? -1))) ?? 0
			const out: number[] = []

			for (let back = i; back >= 0; back--) {
				const j = blocks[back] ?? -1

				if (j >= 0) {
					out.push(j + (i - back))
					break
				}
			}

			for (let ahead = i + 1; ahead < doc.tBlocks.length; ahead++) {
				const j = blocks[ahead] ?? -1

				if (j >= 0) {
					out.push(j - (ahead - i))
					break
				}
			}

			return out.length === 0 ? [i] : out
		})
		// The header and footer parts a section names: a section keeps its own (a new one copies or inherits them).
		const parts = (document: XmlDocument, sectPr: number): string => {
			const ids: string[] = []

			for (let child = document.firstChildElement(sectPr); child >= 0; child = document.nextSiblingElement(child)) {
				const local = document.localName(child)

				if (local === "headerReference" || local === "footerReference") ids.push(document.attribute(child, "r:id") ?? "")
			}

			return ids.sort().join(" ")
		}
		const distance = (a: number, b: number): number => {
			const was = parts(doc.tBody, before[sources[a] ?? -1] ?? -1)
			const now = parts(doc.eBody, after[targets[b] ?? -1] ?? -1)

			// The paragraph ending it as it was (its section's own break, a new one beside it) pairs first.
			const same = equalBytes(
				doc.tBody.raw(doc.tBody.parent(doc.tBody.parent(before[sources[a] ?? -1] ?? -1))),
				doc.eBody.raw(doc.eBody.parent(doc.eBody.parent(after[targets[b] ?? -1] ?? -1)))
			)

			return (
				(same ? 0 : minOf((expectedAt[a] ?? [0]).map(place => Math.abs((at[b] ?? 0) - place))) + 1) +
				(was !== "" && now !== "" && was !== now ? 1.5 : 0)
			)
		}
		const at = targets.map(e => eIndex.get(doc.eBody.parent(doc.eBody.parent(after[e] ?? -1))) ?? 0)
		// Least total distance, skipping an edit's section (added) or a source's (removed) at a cost past any move.
		const skip = doc.eBlocks.length + doc.tBlocks.length + 1
		const width = targets.length + 1
		const cost = new Float64Array((sources.length + 1) * width)

		for (let a = sources.length; a >= 0; a--) {
			for (let b = targets.length; b >= 0; b--) {
				if (a === sources.length && b === targets.length) continue

				let best = Infinity

				if (a < sources.length && b < targets.length) best = distance(a, b) + (cost[(a + 1) * width + b + 1] ?? 0)
				if (a < sources.length) best = Math.min(best, skip + (cost[(a + 1) * width + b] ?? 0))
				if (b < targets.length) best = Math.min(best, skip + (cost[a * width + b + 1] ?? 0))

				cost[a * width + b] = best
			}
		}

		const match = before.map(() => -1)

		for (let a = 0, b = 0; a < sources.length && b < targets.length;) {
			const here = cost[a * width + b] ?? 0
			const pair = distance(a, b) + (cost[(a + 1) * width + b + 1] ?? 0)

			if (here === pair) {
				match[sources[a] ?? -1] = targets[b] ?? -1
				a++
				b++
			} else if (here === skip + (cost[(a + 1) * width + b] ?? 0)) a++
			else b++
		}

		const lastBefore = before.length - 1
		const lastAfter = after.length - 1

		// The last sections pair whatever their setup (a page set up anew is the page setup's to write).
		if (doc.tSection >= 0 && doc.eSection >= 0 && before[lastBefore] === doc.tSection && after[lastAfter] === doc.eSection) {
			for (let k = 0; k < match.length; k++) if (match[k] === lastAfter) match[k] = -1

			match[lastBefore] = lastAfter
		}
		const matched = new Set(match)

		matched.delete(-1)
		const paired = {
			before: [] as number[],
			after: [] as number[],
			layouts: [] as { master: string; layout: string | undefined }[],
			split: new Set<number>()
		}
		const paragraphOf = (document: XmlDocument, sectPr: number): number => document.parent(document.parent(sectPr))

		before.forEach((node, k) => {
			const e = match[k] ?? -1

			if (e >= 0) {
				paired.before.push(node)
				paired.after.push(after[e] ?? -1)
				paired.layouts.push(sections[k] ?? { master: "", layout: undefined })

				return
			}

			// Removed: the paragraph after the break the source's next section starts at names no master page.
			const index = doc.tBlocks.indexOf(paragraphOf(doc.tBody, node))
			const next = doc.tBlocks[index + 1]
			// The same place where the edit kept the blocks' count, else the paragraph as it was.
			const edited =
				next === undefined
					? -1
					: doc.tBlocks.length === doc.eBlocks.length
						? index + 1
						: doc.eBlocks.findIndex(block => equalBytes(doc.eBody.raw(block), doc.tBody.raw(next)))

			if (edited < 0) throw new OdtWriteRefusal("sections", "a removed section break before a changed paragraph")

			const block = doc.eBlocks[edited] ?? -1

			doc.masters.set(block, "")
			doc.forced.add(block)
		})

		after.forEach((node, e) => {
			if (matched.has(e)) return

			const paragraph = paragraphOf(doc.eBody, node)
			const index = doc.eBlocks.indexOf(paragraph)
			const next = doc.eBlocks[index + 1]

			// A page style starts at a paragraph or a table (Part 3 style:master-page-name of either's style).
			if (index < 0 || next === undefined || (doc.eBody.localName(next) !== "p" && doc.eBody.localName(next) !== "tbl")) {
				throw new OdtWriteRefusal("sections", "a section break before something other than a paragraph or a table")
			}

			const type = doc.eBody.attribute(childNamed(doc.eBody, node, "type"), "w:val") ?? "nextPage"

			if (type !== "nextPage") throw new OdtWriteRefusal("sections", `a ${type} section break (a page style starts on a new page)`)

			// The section the break splits is the next one both have: its master page, copied under a new name.
			const following = after.slice(e + 1).findIndex((_node, k) => matched.has(e + 1 + k))
			const source = following < 0 ? -1 : match.indexOf(e + 1 + following)
			const section = sections[source]

			if (section === undefined) throw new OdtWriteRefusal("sections", "a section break in a section the writer cannot place")
			// Header and footer references the next section leaves out are the new one's (ECMA-376 Part 1 §17.10.5).
			const setup = (sectPr: number, references: boolean): string => {
				let out = ""

				for (let child = doc.eBody.firstChildElement(sectPr); child >= 0; child = doc.eBody.nextSiblingElement(child)) {
					const local = doc.eBody.localName(child)
					const reference = local === "headerReference" || local === "footerReference"

					// The page numbering's restart is the first part's: the second continues it.
					if (local === "pgNumType") continue
					if (reference === references && !(local === "type" && doc.eBody.attribute(child, "w:val") === "nextPage"))
						out += canonicalElement(doc.eBody, child)
				}

				return out
			}
			const nextSection = after[e + 1 + following] ?? -1

			if (
				(setup(nextSection, true) !== "" && setup(nextSection, true) !== setup(node, true)) ||
				childNamed(doc.eBody, nextSection, "pgNumType") >= 0
			) {
				throw new OdtWriteRefusal("sections", "a new section with headers unlike the one it splits")
			}

			paired.split.add(nextSection)

			// A second part that keeps a title page starts at the first-page master its chain begins with
			// (style:next-style-name, Part 3 §16.9), else at the page style the section continues in.
			const titled = childNamed(doc.eBody, nextSection, "titlePg") >= 0

			doc.masters.set(next, this.copyMaster(titled && section.start !== undefined ? section.start : section.master))

			// The part split off, set up apart from the source section (its page size, margins, columns), starts on
			// copies of its master pages on copies of their layouts set up so.
			const sourceSection = before[source] ?? -1
			const firstTitled =
				childNamed(doc.eBody, node, "titlePg") >= 0 && section.start !== undefined && section.start !== section.master
			const references = new Map<string, string>()

			for (let child = doc.eBody.firstChildElement(node); child >= 0; child = doc.eBody.nextSiblingElement(child)) {
				const local = doc.eBody.localName(child)

				if (local === "headerReference" || local === "footerReference")
					references.set(`${local}:${doc.eBody.attribute(child, "w:type") ?? "default"}`, canonicalElement(doc.eBody, child))
			}

			const patched = (master: string, own: boolean): { layout: string; patch: Replacement } | undefined => {
				const layout = this.plan.sheet.masterPages.get(master)?.pageLayout

				if (layout === undefined) return undefined

				const shown = firstTitled ? new Map([...references].filter(([key]) => key.endsWith(":first") === own)) : references
				const spacers = this.spacers.length
				const patch = this.layoutPatch(doc.tBody, sourceSection, doc.eBody, node, layout, shown, true)
				const changed = decodeUtf8(this.plan.stylesBytes.subarray(patch.start, patch.end)) !== patch.text

				// A spacing paragraph goes into the headers of every master page on the layout: a copy's has none.
				if (this.spacers.length > spacers) {
					if (changed)
						throw new OdtWriteRefusal("sections", "a header's or footer's spacing on a page layout other sections share")

					this.spacers.length = spacers
				}

				if (changed) return { layout, patch }

				// Set up as the section was: it stays on the layout, which a page setup of the rest must then leave.
				this.sharedLayouts.add(layout)

				return undefined
			}
			const all = this.editedSections ?? after
			const at = all.indexOf(node)
			const previous = at <= 0 ? -1 : (all[at - 1] ?? -1)
			const previousParagraph = previous < 0 ? -1 : doc.eBody.parent(doc.eBody.parent(previous))
			const startsAt = previous < 0 ? (doc.eBlocks[0] ?? -1) : (doc.eBlocks[doc.eBlocks.indexOf(previousParagraph) + 1] ?? -1)

			doc.forced.add(next)
			doc.forced.add(paragraph)

			// A part split off before the section's first paragraph (that paragraph now starts the part after the
			// break): the paragraph the part starts at starts the section's page style the source's first one started.
			const sourceStarts =
				before.indexOf(sourceSection) <= 0
					? (doc.tBlocks[0] ?? -1)
					: (() => {
							const previous = before[before.indexOf(sourceSection) - 1] ?? -1
							const at =
								previous < 0 || this.inBodyLevel(doc.tBody, previous)
									? -1
									: doc.tBlocks.indexOf(doc.tBody.parent(doc.tBody.parent(previous)))

							return at < 0 ? -1 : (doc.tBlocks[at + 1] ?? -1)
						})()

			if (
				startsAt >= 0 &&
				sourceStarts >= 0 &&
				!doc.masters.has(startsAt) &&
				startsAt !== next &&
				equalBytes(doc.tBody.raw(sourceStarts), doc.eBody.raw(next))
			) {
				doc.masters.set(startsAt, section.start ?? section.master)
				doc.forced.add(startsAt)
			}

			// Set up as the rest of the section: its pages are the rest's, whatever a page setup makes of those.
			if (setup(node, false) === setup(nextSection, false)) {
				this.followers.set(nextSection, startsAt)

				return
			}

			const pagesPatch = patched(section.master, false)
			const firstPatch = firstTitled && section.start !== undefined ? patched(section.start, true) : undefined

			if (pagesPatch !== undefined || firstPatch !== undefined) {
				if (startsAt < 0 || doc.masters.has(startsAt))
					throw new OdtWriteRefusal("sections", "a new section set up unlike the one it splits")

				this.pageChanged = true

				const pages = this.copyMaster(
					section.master,
					pagesPatch === undefined ? undefined : this.layoutCopy(pagesPatch.layout, pagesPatch.patch)
				)

				doc.masters.set(
					startsAt,
					firstTitled && section.start !== undefined
						? this.copyMaster(
								section.start,
								firstPatch === undefined ? undefined : this.layoutCopy(firstPatch.layout, firstPatch.patch),
								pages
							)
						: pages
				)
				doc.forced.add(startsAt)
			}

			doc.forced.add(next)
			doc.forced.add(paragraph)
		})

		return paired
	}

	// A copy of a master page under a new name, added to office:master-styles.
	// Tables in the headers and footers of styles.xml's span [start, end) (a master page) whose width follows the page,
	// restyled to the widths their translation shows (the page under them was set up anew): start tag replacements.
	private regionTableFixes(start: number, end: number): Replacement[] {
		const plan = this.plan
		const styles = plan.stylesDocument
		const namespaces = new Namespaces(styles)
		const out: Replacement[] = []

		for (const origin of plan.translation.origins) {
			if (origin.stream !== "styles.xml" || origin.start < start || origin.end > end) continue

			const node = elementAt(styles, origin.start)
			const translated = plan.translation.parts.get(origin.part)

			if (node < 0 || !(translated instanceof Uint8Array)) continue

			const flow = elementsOf(styles, node).filter(child => {
				const name = elementName(styles, namespaces, child)

				return name === "text:p" || name === "text:h" || name === "table:table"
			})

			if (flow.length !== origin.count) continue

			const tDoc = parseXml(translated)
			const tBlocks = elementsOf(tDoc, tDoc.documentElement())
			const tree = this.regionTree(styles, namespaces, node)

			flow.forEach((child, k) => {
				if (elementName(styles, namespaces, child) !== "table:table") return

				const fixed = this.fixedTable(tree, child, tBlocks[origin.first + k] ?? -1, undefined, {
					tDoc,
					scope: "styles",
					stream: this.styles
				})

				if (fixed !== undefined) out.push(fixed)
			})
		}

		return out
	}

	// The edited block section `k` starts with: the first after the paragraph ending the section before.
	private sectionStart(after: readonly number[], k: number): number {
		const doc = this.doc
		// The edit's sections all (a new one's break too): the one before this one ends where it starts.
		const all = this.editedSections ?? after
		const at = all.indexOf(after[k] ?? -1)

		if (at <= 0) return doc.eBlocks[0] ?? -1

		const sectPr = all[at - 1] ?? -1
		const paragraph = sectPr < 0 ? -1 : doc.eBody.parent(doc.eBody.parent(sectPr))
		const index = doc.eBlocks.indexOf(paragraph)

		return index < 0 ? -1 : (doc.eBlocks[index + 1] ?? -1)
	}

	// A copy of page layout `name` with `patch` (a replacement inside it) applied, under a name of its own.
	private layoutCopy(name: string, patch: Replacement): string {
		const styles = this.plan.stylesDocument
		const namespaces = new Namespaces(styles)
		const stack = [styles.documentElement()]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			for (let child = styles.firstChildElement(node); child >= 0; child = styles.nextSiblingElement(child)) {
				const element = elementName(styles, namespaces, child)

				if (element === "office:automatic-styles" || element === "office:styles") stack.push(child)
				else if (element === "style:page-layout" && attributeOf(styles, namespaces, child, "style:name") === name) {
					const bytes = this.plan.stylesBytes
					const start = styles.start(child)
					const end = styles.end(child)

					if (patch.start < start || patch.end > end) throw new OdtWriteRefusal("sections", "page setup outside its page layout")

					const markup = `${decodeUtf8(bytes.subarray(start, patch.start))}${patch.text}${decodeUtf8(bytes.subarray(patch.end, end))}`

					return this.styles.registry.element(`page-layout\u0000${markup}`, `${name}_`, made =>
						markup.replace(
							/^(<[^>]*?\s[A-Za-z0-9_.-]*:?name=")[^"]*(")/u,
							(_match, open: string, close: string) => `${open}${esc(made)}${close}`
						)
					)
				}
			}
		}

		throw new OdtWriteRefusal("sections", `page setup of a page layout styles.xml does not have (${name})`)
	}

	private copyMaster(name: string, layout?: string, next?: string): string {
		const styles = this.plan.stylesDocument
		const namespaces = new Namespaces(styles)
		const stack = [styles.documentElement()]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			for (let child = styles.firstChildElement(node); child >= 0; child = styles.nextSiblingElement(child)) {
				const element = elementName(styles, namespaces, child)

				if (element === "office:master-styles") stack.push(child)
				else if (element === "style:master-page" && attributeOf(styles, namespaces, child, "style:name") === name) {
					const copy = this.content.registry.name(`${name}_`)

					this.newMasters.push({
						start: styles.start(child),
						end: styles.end(child),
						name: copy,
						layout,
						next,
						// On a page layout of its own, its tables that follow the page keep the widths they show.
						extra: layout === undefined ? [] : this.regionTableFixes(styles.start(child), styles.end(child))
					})
					this.masterAt ??= styles.contentEnd(node)

					return copy
				}
			}
		}

		throw new OdtWriteRefusal("sections", `a section of a master page styles.xml does not have (${name})`)
	}

	private masterAt: number | undefined
	// Master pages copied for new sections: the source's span and the copy's name.
	private readonly newMasters: {
		start: number
		end: number
		name: string
		layout: string | undefined
		next: string | undefined
		extra: Replacement[]
	}[] = []

	// The page layout's properties element rewritten for a section's new size, margins and columns.
	private layoutPatch(
		tDoc: XmlDocument,
		before: number,
		eDoc: XmlDocument,
		after: number,
		name: string,
		references: ReadonlyMap<string, string>,
		splitSection: boolean
	): Replacement {
		const styles = this.plan.stylesDocument
		const namespaces = new Namespaces(styles)
		let layout = -1
		const stack = [styles.documentElement()]

		for (let node = stack.pop(); node !== undefined && layout < 0; node = stack.pop()) {
			for (let child = styles.firstChildElement(node); child >= 0; child = styles.nextSiblingElement(child)) {
				const element = elementName(styles, namespaces, child)

				if (element === "style:page-layout" && attributeOf(styles, namespaces, child, "style:name") === name) layout = child
				else if (element === "office:automatic-styles" || element === "office:styles") stack.push(child)
			}
		}

		const properties = layout < 0 ? -1 : childNamed(styles, layout, "page-layout-properties")

		if (properties < 0) throw new OdtWriteRefusal("sections", "page setup of a page layout styles.xml does not have")

		const read = (document: XmlDocument, sectPr: number): Map<string, Map<string, string>> => {
			const out = new Map<string, Map<string, string>>()

			for (let child = document.firstChildElement(sectPr); child >= 0; child = document.nextSiblingElement(child)) {
				const values = new Map<string, string>()

				for (const attribute of document.attributes(child)) values.set(attribute.name.replace(/^w:/u, ""), attribute.value)

				out.set(document.localName(child), values)
			}

			return out
		}
		const was = read(tDoc, before)
		const now = read(eDoc, after)

		for (const local of new Set([...was.keys(), ...now.keys()])) {
			if (local === "pgSz" || local === "pgMar" || local === "cols" || local === "headerReference" || local === "footerReference")
				continue
			if (local === "pgNumType" && splitSection) continue
			// Starting on a new page is what a section does without w:type.
			if (
				local === "type" &&
				(was.get(local)?.get("val") ?? "nextPage") === "nextPage" &&
				(now.get(local)?.get("val") ?? "nextPage") === "nextPage"
			)
				continue
			if (JSON.stringify([...(was.get(local) ?? [])]) !== JSON.stringify([...(now.get(local) ?? [])])) {
				throw new OdtWriteRefusal("sections", `the section property ${local}`)
			}
		}

		const twips = (values: Map<string, string> | undefined, key: string): number => Number(values?.get(key) ?? "0")
		const point = (value: number): string => `${Math.round((value / 20) * 10_000) / 10_000}pt`
		const attributes = new Map<string, string>()

		for (const attribute of styles.attributes(properties)) attributes.set(attribute.name, attribute.value)

		// In place where the source states it (its order kept), else added.
		const set = (canonical: string, value: string): void => {
			for (const key of attributes.keys()) {
				if (canonicalAttribute(namespaces, properties, key) === canonical) {
					attributes.set(key, value)

					return
				}
			}

			attributes.set(canonical, value)
		}
		const size = now.get("pgSz")
		const margins = now.get("pgMar")
		const oldMargins = was.get("pgMar")

		set("fo:page-width", point(twips(size, "w")))
		set("fo:page-height", point(twips(size, "h")))
		set("style:print-orientation", size?.get("orient") === "landscape" ? "landscape" : "portrait")
		set("fo:margin-left", point(twips(margins, "left")))
		set("fo:margin-right", point(twips(margins, "right")))
		// A header's or footer's extent sits inside the ODF margin (Part 3 §17.5): the margin is where the header starts
		// (w:header), and the header style's minimum height, its spacing included, reaches to where the text starts (w:top).
		const regions = new Map<string, string>()
		const region = (kind: "header" | "footer", edge: "top" | "bottom", spacing: string): void => {
			const shown = [...references.keys()].some(key => key.startsWith(`${kind}Reference`))
			const distance = twips(margins, shown ? kind : edge)
			const extent = shown ? twips(margins, edge) - distance : 0
			const oldExtent = shown ? twips(oldMargins, edge) - twips(oldMargins, kind) : 0

			set(`fo:margin-${edge}`, point(distance))

			if (extent === oldExtent) return
			if (extent < 0) throw new OdtWriteRefusal("sections", `a ${kind} starting past the text`)

			const style = childNamed(styles, layout, `${kind}-style`)
			const own = style < 0 ? -1 : childNamed(styles, style, "header-footer-properties")
			const values = new Map<string, string>()

			if (own >= 0)
				for (const attribute of styles.attributes(own))
					values.set(canonicalAttribute(namespaces, own, attribute.name), attribute.value)

			let gap = twipsOf(parseLength(values.get(spacing)) ?? 0)

			// The translation shows the spacing as a paragraph of the header's own (the edit keeps it): where the text
			// starts closer than the spacing, the spacing becomes that paragraph in the header itself.
			if (extent < gap) {
				this.spacers.push({ layout: name, kind, gap })
				gap = 0
			}

			values.delete("svg:height")
			// The minimum height includes the spacing (LibreOffice, measured; the translation reads it so).
			values.set("fo:min-height", point(extent))
			values.set(spacing, point(gap))

			let inner = ""

			for (let child = own < 0 ? -1 : styles.firstChildElement(own); child >= 0; child = styles.nextSiblingElement(child))
				inner += decodeUtf8(styles.raw(child))

			regions.set(
				`style:${kind}-style`,
				`<style:${kind}-style${this.styles.declarations}><style:header-footer-properties${[...values].map(([key, value]) => ` ${key}="${esc(value)}"`).join("")}${inner === "" ? "/>" : `>${inner}</style:header-footer-properties>`}</style:${kind}-style>`
			)
		}

		region("header", "top", "fo:margin-bottom")
		region("footer", "bottom", "fo:margin-top")

		const cols = now.get("cols")
		const count = Number(cols?.get("num") ?? "1") || 1

		if (cols?.get("equalWidth") === "0") throw new OdtWriteRefusal("sections", "columns of unequal widths")

		const columns =
			count > 1
				? `<style:columns fo:column-count="${count}" fo:column-gap="${point(twips(cols, "space"))}">${cols?.get("sep") === "1" ? '<style:column-sep style:width="0.0071in" style:color="#000000" style:height="100%"/>' : ""}</style:columns>`
				: ""
		let inner = ""

		for (let child = styles.firstChildElement(properties); child >= 0; child = styles.nextSiblingElement(child)) {
			if (elementName(styles, namespaces, child) !== "style:columns") inner += decodeUtf8(styles.raw(child))
		}

		inner = columns + inner

		const tag = styles.name(properties)
		const markup = `<${tag}${[...attributes].map(([key, value]) => ` ${key}="${esc(value)}"`).join("")}${inner === "" ? "/>" : `>${inner}</${tag}>`}`

		if (regions.size === 0) return { start: styles.start(properties), end: styles.end(properties), text: markup }

		// The header and footer styles too: the page layout's children rewritten, in their order (properties first).
		let children = ""

		for (let child = styles.firstChildElement(layout); child >= 0; child = styles.nextSiblingElement(child)) {
			const element = elementName(styles, namespaces, child)
			const replaced = child === properties ? markup : regions.get(element)

			regions.delete(element)
			children += replaced ?? decodeUtf8(styles.raw(child))
		}

		for (const added of regions.values()) children += added

		const open = decodeUtf8(styles.raw(layout)).match(/^<[^>]*?(?=\/?>)/u)?.[0] ?? ""

		return { start: styles.start(layout), end: styles.end(layout), text: `${open}>${children}</${styles.name(layout)}>` }
	}

	// Headers and footers whose spacing became a paragraph of their own (layout name, kind, spacing in twips).
	private readonly spacers: { layout: string; kind: "header" | "footer"; gap: number }[] = []

	// The spacing paragraph, exactly that tall (as the translation shows a spacing), at the end of each header (the
	// start of each footer) of the master pages on that layout; in a region the edit rewrote, in its rewrite.
	private placeSpacers(): void {
		if (this.spacers.length === 0) return

		const styles = this.plan.stylesDocument
		const namespaces = new Namespaces(styles)
		const root = styles.documentElement()

		for (const spacer of this.spacers) {
			const style = this.styles.registry.style(
				"paragraph",
				"P",
				"",
				`<style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="0pt" fo:line-height="${Math.round((spacer.gap / 20) * 10_000) / 10_000}pt"/><style:text-properties fo:font-size="1pt"/>`
			)
			const markup = `<text:p${this.styles.declarations} text:style-name="${esc(style)}"/>`

			for (let container = styles.firstChildElement(root); container >= 0; container = styles.nextSiblingElement(container)) {
				if (elementName(styles, namespaces, container) !== "office:master-styles") continue

				for (let master = styles.firstChildElement(container); master >= 0; master = styles.nextSiblingElement(master)) {
					if (attributeOf(styles, namespaces, master, "style:page-layout-name") !== spacer.layout) continue

					for (let region = styles.firstChildElement(master); region >= 0; region = styles.nextSiblingElement(region)) {
						const element = elementName(styles, namespaces, region)

						if (!element.startsWith(`style:${spacer.kind}`)) continue
						if (attributeOf(styles, namespaces, region, "style:display") === "false") continue

						const header = spacer.kind === "header"
						const replacements = this.styles.replacements
						const index = replacements.findIndex(
							replacement =>
								replacement.start === styles.contentStart(region) && replacement.end === styles.contentEnd(region)
						)
						const rewritten = replacements[index]

						if (rewritten !== undefined) {
							replacements[index] = { ...rewritten, text: header ? rewritten.text + markup : markup + rewritten.text }
						} else if (styles.isSelfClosing(region)) {
							const tag = styles.name(region)
							const open = decodeUtf8(styles.raw(region)).replace(/\s*\/>$/u, ">")

							this.styles.replacements.push({
								start: styles.start(region),
								end: styles.end(region),
								text: `${open}${markup}</${tag}>`
							})
						} else {
							const at = header ? styles.contentEnd(region) : styles.contentStart(region)

							this.styles.replacements.push({ start: at, end: at, text: markup })
						}
					}
				}
			}
		}
	}

	// Tracked changes the written file records, as text:changed-region markup.
	private readonly changes: string[] = []

	// The changes recorded where office:text keeps them: added to its text:tracked-changes, or in one made at its start
	// (after its forms, Part 3 §3.4 office:text), its track-changes switch set as the edit's.
	private recordChanges(): void {
		const tracking = this.doc.tracking
		const dropped = this.replacedChanges()

		if (this.changes.length === 0 && tracking === undefined && dropped.length === 0) return

		const located = trackedChangesOf(this.plan)
		const switchOf = tracking === undefined ? "" : ` text:track-changes="${tracking ? "true" : "false"}"`

		if (located.container === undefined) {
			this.content.replacements.push({
				start: located.insertAt,
				end: located.insertAt,
				text: `<text:tracked-changes${this.content.declarations}${switchOf}>${this.changes.join("")}</text:tracked-changes>`,
				segment: -1
			})

			return
		}

		const { tagStart, tagEnd, prefix, close } = located.container
		const attributes = located.container.attributes.replace(/\s[A-Za-z0-9_.-]*:?track-changes="[^"]*"/u, "")

		if (close < 0) {
			this.content.replacements.push({
				start: tagStart,
				end: tagEnd,
				text: `<${prefix}tracked-changes${attributes}${switchOf}>${this.changes.join("")}</${prefix}tracked-changes>`,
				segment: -1
			})

			return
		}

		if (tracking !== undefined)
			this.content.replacements.push({
				start: tagStart,
				end: tagEnd,
				text: `<${prefix}tracked-changes${attributes}${switchOf}>`,
				segment: -1
			})

		for (const record of dropped) this.content.replacements.push({ start: record.start, end: record.end, text: "", segment: -1 })

		if (this.changes.length > 0) this.content.replacements.push({ start: close, end: close, text: this.changes.join(""), segment: -1 })
	}

	// Whether the write leaves out records of source changes (see replacedChanges).
	private droppedChanges = false

	// The records of the source's changes no written mark names any more: a rewrite wrote their paragraphs' changes
	// anew (or the edit removed them). A change some mark still names keeps its record.
	private replacedChanges(): ChangeRecord[] {
		if (this.plan.changeRecords().size === 0) return []

		const marks = this.plan.changeMarks()

		if (marks.size === 0) return []

		const replaced = this.content.replacements
			.filter(replacement => replacement.end > replacement.start)
			.sort((a, b) => a.start - b.start)
		const inside = (at: number): boolean => {
			let low = 0
			let high = replaced.length - 1

			while (low <= high) {
				const middle = (low + high) >> 1
				const item = replaced[middle]

				if (item === undefined) break
				if (at < item.start) high = middle - 1
				else if (at >= item.end) low = middle + 1
				else return true
			}

			return false
		}
		const named = new Set<string>()

		for (const replacement of this.content.replacements)
			for (const match of replacement.text.matchAll(/change-id="([^"]*)"/gu)) named.add(match[1] ?? "")

		const records = this.plan.changeRecords()
		const out: ChangeRecord[] = []

		for (const [id, at] of marks) {
			if (named.has(id) || at.some(offset => !inside(offset))) continue

			const record = records.get(id)

			if (record !== undefined) out.push(record)
		}

		this.droppedChanges = out.length > 0

		return out
	}

	// Pictures the written file adds (entry name -> bytes), and the edit's picture parts they hold.
	readonly pictures = new Map<string, Uint8Array>()
	readonly pictureParts = new Map<string, string>()

	private picture(
		document: XmlDocument,
		drawing: number,
		rels: Map<string, { target: string; external: boolean }>,
		stream: Stream
	): string {
		const find = (node: number, local: string): number => {
			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				if (document.localName(child) === local) return child

				const found = find(child, local)

				if (found >= 0) return found
			}

			return -1
		}
		const inline = find(drawing, "inline")

		if (inline < 0) {
			const shape = find(drawing, "txbx") >= 0 || find(drawing, "wsp") >= 0

			throw new OdtWriteRefusal("drawing", shape ? "a changed text box or shape" : "a new or moved floating picture")
		}

		const data = find(inline, "graphicData")

		if (data < 0 || document.attribute(data, "uri") !== "http://schemas.openxmlformats.org/drawingml/2006/picture") {
			throw new OdtWriteRefusal("drawing", "a new or changed shape")
		}

		const crop = find(data, "srcRect")
		const xfrm = find(data, "xfrm")
		const blip = find(data, "blip")
		const extent = find(inline, "extent")
		const docPr = find(inline, "docPr")

		if (crop >= 0 && [...document.attributes(crop)].some(attribute => attribute.value !== "0"))
			throw new OdtWriteRefusal("drawing", "a cropped picture")
		if (xfrm >= 0 && ["rot", "flipH", "flipV"].some(name => (document.attribute(xfrm, name) ?? "0") !== "0")) {
			throw new OdtWriteRefusal("drawing", "a rotated or flipped picture")
		}

		const descr = docPr < 0 ? "" : (document.attribute(docPr, "descr") ?? "")
		const title = docPr < 0 ? "" : (document.attribute(docPr, "title") ?? "")

		if (title !== "" && title !== descr) throw new OdtWriteRefusal("drawing", "a picture's title beside its description")

		const relationship = rels.get(blip < 0 ? "" : (document.attribute(blip, "r:embed") ?? ""))

		if (relationship === undefined || relationship.external) throw new OdtWriteRefusal("drawing", "a picture held outside the file")

		const part = relationship.target.startsWith("/") ? relationship.target.slice(1) : `word/${relationship.target}`
		let href = this.plan.translation.media.get(part) ?? this.pictureParts.get(part)

		if (href === undefined) {
			const bytes = this.plan.edits.parts.get(part)

			if (bytes === undefined) throw new OdtWriteRefusal("drawing", "a picture whose part the edit does not hold")

			const extension = /\.([A-Za-z0-9]+)$/u.exec(part)?.[1]?.toLowerCase() ?? "png"

			const stem = `Pictures/${fnv(bytes).toString(16).padStart(8, "0")}${bytes.length.toString(16)}`
			const archive = this.plan.source.archive
			let crc: number | undefined

			// A picture the package already holds (a second insertion of it) is that entry; another one by the name
			// takes a free name.
			for (let k = 0; href === undefined; k++) {
				const name = `${stem}${k === 0 ? "" : `-${k}`}.${extension}`
				const entry = archive.get(name)
				const held = this.pictures.get(name)

				if (entry !== undefined) {
					crc ??= crc32(bytes)

					if (entry.uncompressedSize === bytes.length && entry.crc32 === crc) href = name
				} else if (held === undefined || equalBytes(held, bytes)) {
					href = name
					this.pictures.set(href, bytes)
				}
			}

			this.pictureParts.set(part, href)
		}

		const size = (name: string): string => {
			const emu = Number(document.attribute(extent, name) ?? "0")

			return `${Math.round((emu / 12_700) * 1_000_000) / 1_000_000}pt`
		}

		// Its own graphic style: the default graphic style's stroke and fill are for shapes, a picture has neither.
		const style = stream.registry.style("graphic", "fr", "", '<style:graphic-properties draw:stroke="none" draw:fill="none"/>')

		return `<draw:frame${stream.declarations} draw:style-name="${esc(style)}" draw:name="${esc(stream.registry.name("Image", true))}" text:anchor-type="as-char" svg:width="${size("cx")}" svg:height="${size("cy")}" draw:z-index="0"><draw:image xlink:href="${esc(href)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${descr === "" ? "" : `<svg:desc>${escText(descr)}</svg:desc>`}</draw:frame>`
	}

	private levelIndents: Map<string, Map<number, PropertyValue>> | undefined

	private levelIndent(numId: string, ilvl: number): PropertyValue | undefined {
		if (this.levelIndents === undefined) {
			this.levelIndents = new Map()

			const numbering = this.plan.editedXml("word/numbering.xml")

			if (numbering !== undefined) {
				const root = numbering.documentElement()
				const abstracts = new Map<string, Map<number, PropertyValue>>()

				for (let child = numbering.firstChildElement(root); child >= 0; child = numbering.nextSiblingElement(child)) {
					if (numbering.localName(child) !== "abstractNum") continue

					const levels = new Map<number, PropertyValue>()

					for (let level = numbering.firstChildElement(child); level >= 0; level = numbering.nextSiblingElement(level)) {
						const pPr = numbering.localName(level) === "lvl" ? childNamed(numbering, level, "pPr") : -1

						if (pPr < 0) continue

						const props: Props = new Map()

						readProps(numbering, pPr, props)

						const ind = props.get("ind")

						if (ind !== undefined) levels.set(Number(numbering.attribute(level, "w:ilvl") ?? "0"), ind)
					}

					abstracts.set(numbering.attribute(child, "w:abstractNumId") ?? "", levels)
				}

				for (let child = numbering.firstChildElement(root); child >= 0; child = numbering.nextSiblingElement(child)) {
					if (numbering.localName(child) !== "num") continue

					const abstract = numbering.attribute(childNamed(numbering, child, "abstractNumId"), "w:val") ?? ""

					this.levelIndents.set(numbering.attribute(child, "w:numId") ?? "", abstracts.get(abstract) ?? new Map())
				}
			}
		}

		return this.levelIndents.get(numId)?.get(ilvl)
	}

	private levelStarts: Map<string, number> | undefined
	private readonly origins = new Map<string, string | undefined>()

	// The style of the text:span at the content.xml offset a run's w:rsidR names (Translator: spans whose style says
	// what their WordprocessingML does not).
	private originStyle(rsid: string): string | undefined {
		if (this.origins.has(rsid)) return this.origins.get(rsid)

		const offset = Number.parseInt(rsid, 16)
		const units = this.plan.units
		let low = 0
		let high = units.length - 1
		let style: string | undefined

		while (low <= high) {
			const middle = (low + high) >> 1
			const unit = units[middle]

			if (unit === undefined) break
			if (unit.origin.end <= offset) low = middle + 1
			else if (unit.origin.start > offset) high = middle - 1
			else {
				const tree = this.plan.tree(unit)
				const node = elementAt(tree.document, offset - tree.shift)

				if (node >= 0 && elementName(tree.document, tree.namespaces, node) === "text:span")
					style = attributeNamed(tree, node, "text:style-name")

				break
			}
		}

		this.origins.set(rsid, style)

		return style
	}

	private listsBefore: Map<number, string | undefined> | undefined
	// Each w:num's first paragraph in the edited body.
	private readonly listFirst = new Map<string, number>()

	// The start tag of a kept top-level text:list whose first paragraph is `paragraph`, where how it continues
	// (Part 3 §19.785, §19.786) is no longer what the edit says: a new list, the preceding list's continuation, or
	// the continuation of the last list of its w:num before it.
	private listContinuation(tree: UnitTree, paragraph: number): Replacement | undefined {
		const document = tree.document
		const node = tree.node
		const numId = numIdOf(this.doc.eBody, paragraph)

		if (node < 0 || numId === undefined || elementName(document, tree.namespaces, node) !== "text:list") return undefined

		const preceding = this.precedingList(paragraph)
		const continues = this.listFirst.get(numId) !== paragraph
		const continueList = attributeOf(document, tree.namespaces, node, "text:continue-list")
		const continueNumbering = attributeOf(document, tree.namespaces, node, "text:continue-numbering") === "true"

		if (
			continueList !== undefined
				? continues && preceding !== numId
				: continueNumbering
					? continues && preceding === numId
					: !continues
		)
			return undefined

		if (continues && preceding !== numId && !this.context.continuesLists)
			throw new OdtWriteRefusal(
				"list",
				"a list continuing one another list interrupts, in an ODF 1.0 or 1.1 document: text:list has only text:style-name and text:continue-numbering there (ODF 1.1 and 1.0 second edition §4.3.1); text:continue-list is new in ODF 1.2 (Part 1 §19.780, Appendix G.1)"
			)

		const id = continues && preceding !== numId ? this.emitter.listIdOf(numId) : undefined

		if (continues && preceding !== numId && id === undefined)
			throw new OdtWriteRefusal("list", "a list continuing one that another list interrupts")

		const open = decodeUtf8(document.raw(node).subarray(0, document.openEnd(node) - document.start(node)))
		let tag = open

		for (const attribute of document.attributes(node)) {
			const canonical = canonicalAttribute(tree.namespaces, node, attribute.name)

			if (canonical === "text:continue-list" || canonical === "text:continue-numbering")
				tag = tag.replace(new RegExp(`\\s${attribute.name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "u"), "")
		}

		const prefix = document.prefix(node)
		const name = (local: string): string => `${prefix === "" ? "" : `${prefix}:`}${local}`
		const added = !continues
			? ""
			: id === undefined
				? ` ${name("continue-numbering")}="true"`
				: ` ${name("continue-list")}="${esc(id)}"`
		const close = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1
		const start = document.start(node) + tree.shift

		return { start, end: start + encodeUtf8(open).length, text: `${tag.slice(0, close)}${added}${tag.slice(close)}` }
	}

	// The w:num numbering the last list paragraph before a top-level paragraph of the edited body (in tables too):
	// the list text:continue-numbering continues (Part 3 §19.786), in the edit's order whatever order it is written in.
	private precedingList(paragraph: number): string | undefined {
		if (this.listsBefore === undefined) {
			const doc = this.doc
			const before = new Map<number, string | undefined>()
			let last: string | undefined
			const visit = (node: number): void => {
				if (doc.eBody.localName(node) === "p") {
					before.set(node, last)

					const numId = numIdOf(doc.eBody, node)

					if (numId !== undefined && !this.listFirst.has(numId)) this.listFirst.set(numId, node)

					if (
						numId !== undefined &&
						numId !== "0" &&
						this.plan.translation.numbering.get(Number(numId))?.style !== "\u0000outline"
					)
						last = numId

					return
				}

				for (let child = doc.eBody.firstChildElement(node); child >= 0; child = doc.eBody.nextSiblingElement(child)) visit(child)
			}

			for (const block of doc.eBlocks) visit(block)

			this.listsBefore = before
		}

		return this.listsBefore.get(paragraph)
	}

	// Where the markup being written goes in content.xml (a list continuing one kept before it looks there).
	private writingAt = -1

	// The xml:id of the last source list before the markup being written that numbers with `numId`, given one where
	// it has none (its start tag gains it); undefined where no such list is kept.
	private sourceListId(numId: string): string | undefined {
		const doc = this.doc

		for (let index = this.plan.units.length - 1; index >= 0; index--) {
			const unit = this.plan.units[index]

			if (unit === undefined || unit.origin.count === 0 || unit.origin.end > this.writingAt) continue

			let numbers = false

			for (let k = unit.origin.first; k < unit.origin.first + unit.origin.count && !numbers; k++) {
				const block = doc.tBlocks[k] ?? -1

				numbers = block >= 0 && numIdOf(doc.tBody, block) === numId
			}

			if (!numbers) continue

			const tree = this.plan.tree(unit)
			const document = tree.document

			if (tree.node < 0 || elementName(document, tree.namespaces, tree.node) !== "text:list") return undefined

			const known = attributeOf(document, tree.namespaces, tree.node, "xml:id")

			if (known !== undefined) return known

			const id = this.content.registry.name("list", true)
			const at = document.openEnd(tree.node) + tree.shift - (document.isSelfClosing(tree.node) ? 2 : 1)

			// Part of the unit's segment (a kept one grows by it), or of the one it will be.
			const patch = { start: at, end: at, text: ` xml:id="${esc(id)}"` }
			const segment = this.segments.find(item => item.units.includes(unit))

			if (segment !== undefined) this.content.replacements.push({ ...patch, segment: segment.id })
			else {
				const patches = this.unitPatches.get(unit.index) ?? []

				patches.push(patch)
				this.unitPatches.set(unit.index, patches)
			}

			return id
		}

		return undefined
	}

	private levelStart(numId: string, ilvl: number): number | undefined {
		if (this.levelStarts === undefined) {
			this.levelStarts = new Map()

			const numbering = this.plan.editedXml("word/numbering.xml")

			if (numbering !== undefined) {
				const root = numbering.documentElement()

				for (let num = numbering.firstChildElement(root); num >= 0; num = numbering.nextSiblingElement(num)) {
					if (numbering.localName(num) !== "num") continue

					for (
						let override = numbering.firstChildElement(num);
						override >= 0;
						override = numbering.nextSiblingElement(override)
					) {
						const start =
							numbering.localName(override) === "lvlOverride" ? childNamed(numbering, override, "startOverride") : -1
						const value = start < 0 ? Number.NaN : Number(numbering.attribute(start, "w:val"))

						if (Number.isInteger(value))
							this.levelStarts.set(
								`${numbering.attribute(num, "w:numId") ?? ""}\u0000${numbering.attribute(override, "w:ilvl") ?? "0"}`,
								value
							)
					}
				}
			}
		}

		return this.levelStarts.get(`${numId}\u0000${ilvl}`)
	}

	// The list style a w:num is an instance of: the translation's, or one written for a list the edit made.
	private listTarget(numId: string): ListTarget | undefined {
		const known = this.plan.translation.numbering.get(Number(numId))

		if (known !== undefined) {
			if (known.style === "\u0000outline") return { style: "", outline: true }
			if (known.scope === "styles" || this.plan.sheet.listStyle(known.style, "content") !== undefined)
				return { style: known.style, outline: false }
		}

		const made = this.newLists.get(numId)

		if (made !== undefined) return made

		const numbering = this.plan.editedXml("word/numbering.xml")

		if (numbering === undefined) return undefined

		const list = newListStyle(
			numbering,
			numId,
			this.plan.translation,
			this.content.registry,
			this.context.fonts,
			this.content.declarations
		)

		if (list === undefined) return undefined

		this.newLists.set(numId, list)

		return list
	}

	async run(job: RtfJob | undefined): Promise<WriteResult> {
		const plan = this.plan
		const doc = this.doc

		await turn(job)
		this.pageSetup()
		this.changedListStyles()
		this.changedCommonStyles()

		const tKeys = doc.keys(doc.tBody, doc.tBlocks, false)

		await turn(job)

		const eKeys = doc.keys(doc.eBody, doc.eBlocks, true)

		await turn(job)

		const match = matchBlocks(tKeys, eKeys)

		await turn(job)

		const spacing = plan.translation.tableSpacing

		if (spacing !== undefined) {
			const tables = new TableSpacing(doc, spacing, match, this.context.chains)

			this.tableSpacing = tables
			this.context.tableSpacing = (document, paragraph) => tables.shift(document, paragraph)
		}

		// Units kept as they are: every block matched, in order, with nothing inserted between.
		const kept = new Map<number, { from: number; to: number }>()

		for (const unit of plan.units) {
			const { first, count } = unit.origin

			if (count === 0) continue
			if (job?.due() === true) await turn(job)

			let ok = !this.mode.prove && !this.mode.forced.has(unit.index)
			const from = match[first] ?? -1

			for (let k = 0; ok && k < count; k++) if (match[first + k] !== from + k || from < 0) ok = false

			const lossy = this.mode.prove ? this.plan.lossy(unit) : undefined

			if (!ok && this.mode.prove && (lossy !== undefined || this.locksAlways(unit))) {
				// Gate 1 locks what it cannot rewrite, and leaves it as it is.
				this.failed.set(unit.index, lossy ?? this.plan.tree(unit).structuralOpaque ?? "structure")
				ok = from >= 0 && [...Array(count).keys()].every(k => match[first + k] === from + k)
				unit.tree = undefined
			}

			if (ok) kept.set(unit.index, { from, to: from + count })
		}

		// Regions between kept units.
		const regions: Region[] = []
		let pending: Unit[] = []
		let previousEnd = 0
		const flush = (nextFrom: number, nextAt: number): void => {
			const units = pending.filter(unit => unit.origin.count > 0)

			if (units.length > 0 || nextFrom > previousEnd) {
				if (this.mode.prove) {
					for (const unit of units) {
						regions.push({ units: [unit], from: kept.get(unit.index)?.from ?? -1, to: -1, at: unit.origin.start })
					}
				} else {
					regions.push({
						units,
						from: previousEnd,
						to: nextFrom,
						at: units.length === 0 ? nextAt : (units[0]?.origin.start ?? nextAt)
					})
				}
			}

			pending = []
		}

		for (const unit of plan.units) {
			const span = kept.get(unit.index)

			if (unit.origin.count === 0) {
				pending.push(unit)

				continue
			}

			if (span === undefined) {
				pending.push(unit)

				continue
			}

			flush(span.from, unit.origin.start)
			previousEnd = span.to
			this.segment({ start: unit.origin.start, end: unit.origin.end, kind: "kept", units: [unit], from: span.from, to: span.to }, [
				...this.fixedTables(unit),
				...this.framePatches(unit)
			])
		}

		flush(
			doc.eBlocks.length,
			plan.units.length === 0 ? plan.textStart() : (plan.units[plan.units.length - 1]?.origin.end ?? plan.textStart())
		)

		for (const region of regions) {
			if (job?.due() === true) await turn(job)

			// What was parsed of the region's sources is not needed past it.
			for (const done of this.released.splice(0)) done.tree = undefined

			appendAll(this.released, region.units)

			if (this.mode.prove) {
				const unit = region.units[0]

				if (unit === undefined) continue

				try {
					await this.proveUnit(unit, job)
				} catch (error) {
					if (!(error instanceof OdtWriteRefusal)) throw error

					this.failed.set(unit.index, error.message)
				}

				continue
			}

			this.writeRegion(region)
		}

		await this.writeStories(job)
		this.fixRegionTables()
		this.placeSpacers()
		this.recordChanges()

		if (this.newMasters.length > 0 && this.masterAt !== undefined) {
			// Each copy as its master is written: with the edit's headers and footers in it.
			const bytes = this.plan.stylesBytes
			const copies = this.newMasters.map(master => {
				let markup = ""
				let at = master.start

				const own = [...this.styles.replacements].filter(item => item.start >= master.start && item.end <= master.end)
				// A table a rewritten header writes anew needs no restyling.
				const extra = master.extra.filter(fix => !own.some(item => item.start < fix.end && fix.start < item.end))

				for (const replacement of [...own, ...extra].sort((a, b) => a.start - b.start)) {
					if (replacement.start < master.start || replacement.end > master.end) continue

					markup += decodeUtf8(bytes.subarray(at, replacement.start)) + replacement.text
					at = replacement.end
				}

				markup += decodeUtf8(bytes.subarray(at, master.end))

				return (
					markup
						.replace(
							/^(<[^>]*?\bstyle:name=")[^"]*(")/u,
							(_match, open: string, close: string) => `${open}${esc(master.name)}${close}`
						)
						.replace(/\s[A-Za-z0-9_.-]*:?display-name="[^"]*"/u, "")
						// A copy on a page layout of its own names it.
						.replace(/^(<[^>]*?\s[A-Za-z0-9_.-]*:?page-layout-name=")[^"]*(")/u, (whole, open: string, close: string) =>
							master.layout === undefined ? whole : `${open}${esc(master.layout)}${close}`
						)
						.replace(/^(<[^>]*?\s[A-Za-z0-9_.-]*:?next-style-name=")[^"]*(")/u, (whole, open: string, close: string) =>
							master.next === undefined ? whole : `${open}${esc(master.next)}${close}`
						)
						// Identifiers stay the source's own: a copy holding them would repeat them.
						.replace(/\s(?:xml:id|[A-Za-z0-9_.-]+:id)="[^"]*"/gu, "")
						// A link the copy writes states its kind (xlink:type is required, Part 3 text:a).
						.replace(/<(text:a)(?![^>]*\sxlink:type=)(?=[\s>])/gu, '<$1 xlink:type="simple"')
				)
			})

			this.styles.replacements.push({ start: this.masterAt, end: this.masterAt, text: copies.join("") })
		}

		if (this.newStylesMarkup.length > 0) {
			// New common styles go at the end of office:styles.
			const styles = this.plan.stylesDocument
			const root = styles.documentElement()
			const namespaces = new Namespaces(styles)
			let at = -1

			for (let node = styles.firstChildElement(root); node >= 0; node = styles.nextSiblingElement(node)) {
				if (elementName(styles, namespaces, node) === "office:styles" && !styles.isSelfClosing(node)) at = styles.contentEnd(node)
			}

			if (at < 0) throw new OdtWriteRefusal("styles", "styles.xml has no office:styles")

			this.styles.replacements.push({ start: at, end: at, text: this.newStylesMarkup.join("") })
		}

		const replacements = this.content.all()
		const content = this.content.output(replacements)
		const styles = this.styles.output()
		const bytes = content ?? plan.contentBytes

		this.segments.sort((a, b) => a.start - b.start)
		this.replaced = replacements

		return {
			content: bytes,
			styles,
			segments: movedAll(this.segments, replacements),
			written: this.written,
			failed: this.failed,
			failedBlocks: this.failedBlocks,
			pictures: this.pictures,
			pictureParts: this.pictureParts,
			contentChanged: content !== undefined || styles !== undefined
		}
	}

	// What the span proof reads (span.ts) where this write changed only some top-level blocks of the body, each
	// checked as the source has it; undefined leaves the save to the whole file's proof. Run before the plan's styles
	// are let go.
	spanPlan(result: WriteResult, odf: OdfPackage): SpanPlan | undefined {
		const plan = this.plan
		const doc = this.doc

		if (this.mode.prove || this.mode.forced.size > 0 || !result.contentChanged || !(result.content instanceof BytePieces))
			return undefined
		if (
			result.styles !== undefined ||
			result.pictures.size > 0 ||
			this.changes.length > 0 ||
			this.droppedChanges ||
			doc.tracking !== undefined
		)
			return undefined
		if (doc.masters.size > 0 || doc.forced.size > 0 || this.newLists.size > 0 || this.newMasters.length > 0) return undefined
		if (this.newStylesMarkup.length > 0 || this.newCommonStyles.size > 0 || (plan.edits.removed?.length ?? 0) > 0) return undefined

		// Every part but the body as the translation has it.
		for (const [name, bytes] of plan.edits.parts) {
			if (name === BODY_PART || IGNORED_PARTS.has(name)) continue

			const before = plan.translation.parts.get(name)

			if (!(before instanceof Uint8Array) || !equalBytes(before, bytes)) return undefined
		}

		if (doc.tSection < 0 !== doc.eSection < 0) return undefined
		if (doc.tSection >= 0 && !equalBytes(doc.tBody.raw(doc.tSection), doc.eBody.raw(doc.eSection))) return undefined

		const sectioned = (document: XmlDocument, block: number | undefined): boolean => {
			if (block === undefined || document.localName(block) !== "p") return false

			const pPr = childNamed(document, block, "pPr")

			return pPr >= 0 && childNamed(document, pPr, "sectPr") >= 0
		}
		const dirty = new Set(this.replaced.map(replacement => replacement.segment ?? -1).filter(segment => segment >= 0))
		const moved = new Map(result.segments.map(segment => [segment.id, segment]))
		const units = plan.units
		const unitAt = (offset: number): Unit | undefined => units.find(unit => unit.origin.start >= offset)
		const stateAt = (unit: Unit | undefined): string | undefined => (unit === undefined ? plan.translation.endState : unit.origin.state)
		const textEnd = plan.textStart()
		const frame = (root: Uint8Array): SpanFrame => {
			const containers = plan.contentBytes.subarray(plan.prologueEnd, textEnd)
			const names = [...decodeUtf8(containers).matchAll(/<([^\s/>]+)/gu)].map(match => match[1] ?? "")
			const open = new Uint8Array(root.length + containers.length)

			open.set(root)
			open.set(containers, root.length)

			return {
				open,
				close: encodeUtf8(
					`${[...names]
						.reverse()
						.map(name => `</${name}>`)
						.join("")}${plan.rootClose}`
				)
			}
		}
		const sourceFrame = frame(encodeUtf8(plan.rootOpen))
		const writtenFrame = frame(this.content.rootTag(this.replaced))
		const sourceStyles = { odf, sheet: plan.sheet, settings: { tabsRelativeToIndent: plan.tabsRelativeToIndent } }
		const windows: SpanWindow[] = []
		let cursor = 0

		for (const segment of [...this.segments].sort((a, b) => a.from - b.from || a.start - b.start)) {
			if (segment.from !== cursor || segment.to < segment.from) return undefined

			cursor = segment.to

			const window = segment.kind === "written" || dirty.has(segment.id)
			const first = segment.units[0]
			const last = segment.units[segment.units.length - 1]

			if (!window) {
				// A kept unit's blocks are the source's, byte for byte (matched by digest).
				for (let k = segment.from; k < segment.to; k++) {
					const edited = doc.eBlocks[k]
					const translated = doc.tBlocks[(first?.origin.first ?? 0) + k - segment.from]

					if (edited === undefined || translated === undefined || !equalBytes(doc.eBody.raw(edited), doc.tBody.raw(translated)))
						return undefined
				}

				continue
			}

			// Where the window's source ends, the unit after it, and the translation's blocks it had.
			const sourceEnd = last?.origin.end ?? segment.start
			const after = unitAt(sourceEnd)
			const tFrom = first?.origin.first ?? after?.origin.first ?? doc.tBlocks.length
			const tTo = last === undefined ? tFrom : last.origin.first + last.origin.count
			const state = first === undefined ? stateAt(after) : first.origin.state

			if (state === undefined || stateAt(after) !== state) return undefined

			// No section ends in the window or at its edges (the block before it, the first after it).
			for (let k = Math.max(0, tFrom - 1); k <= tTo; k++) if (sectioned(doc.tBody, doc.tBlocks[k])) return undefined
			for (let k = segment.from; k < segment.to; k++) if (sectioned(doc.eBody, doc.eBlocks[k])) return undefined

			if (first !== undefined) {
				const source = plan.contentBytes.subarray(first.origin.start, sourceEnd)

				if (translateRun(sourceStyles, sourceFrame, source, state) === undefined) return undefined
			}

			const at = moved.get(segment.id)

			if (at === undefined) return undefined

			windows.push({ from: segment.from, to: segment.to, start: at.start, end: at.end, state })
		}

		if (cursor !== doc.eBlocks.length || windows.length === 0) return undefined

		// Where the written prologue ends: the source's, grown by what was written before it.
		let prologueEnd = plan.prologueEnd

		for (const replacement of this.replaced) {
			if (replacement.end <= plan.prologueEnd)
				prologueEnd += encodeUtf8(replacement.text).length - (replacement.end - replacement.start)
			else if (replacement.start < plan.prologueEnd) return undefined
		}

		return {
			windows,
			blocks: doc.eBlocks.length,
			frame: writtenFrame,
			prologueEnd,
			settings: sourceStyles.settings,
			stylesPart: plan.translation.parts.get("word/styles.xml") as Uint8Array | undefined
		}
	}

	// Gate 1 never tries a unit a rewrite would lose something of.
	private locksAlways(unit: Unit): boolean {
		const tree = this.plan.tree(unit)

		return tree.structuralOpaque !== undefined || tree.emitters === undefined
	}

	// Headers and footers the edit changed: each master page region's content written anew in styles.xml (its start
	// and end tags kept), with styles.xml's own automatic styles and font faces; what the edit left as it was (a
	// picture, a page number field...) copied as the region has it.
	private async writeStories(job: RtfJob | undefined): Promise<void> {
		const plan = this.plan
		const styles = plan.stylesDocument
		const namespaces = new Namespaces(styles)

		for (const origin of plan.translation.origins) {
			if (origin.stream !== "styles.xml") continue

			const edited = plan.edits.parts.get(origin.part)
			const translated = plan.translation.parts.get(origin.part)

			if (edited === undefined || !(translated instanceof Uint8Array) || equalBytes(edited, translated)) continue
			if (job?.due() === true) await turn(job)

			const node = elementAt(styles, origin.start)

			if (node < 0 || styles.isSelfClosing(node))
				throw new OdtWriteRefusal("header", "a header or footer the file has no content element for")
			if (origin.lossy.some(reason => LOCKING_REASONS.has(reason)))
				throw new OdtWriteRefusal("locked", `a header or footer the editor shows approximated (${origin.lossy.join(", ")})`)

			const tDoc = parseXml(translated)
			const eDoc = plan.editedXml(origin.part)

			if (eDoc === undefined) throw new OdtWriteRefusal("header", "the edit removed a header or footer")

			const tBlocks = elementsOf(tDoc, tDoc.documentElement())
			const eBlocks = elementsOf(eDoc, eDoc.documentElement())
			// The translator's own paragraphs around the region's (the spacing below a header or above a footer, a closing
			// paragraph) stay where they were.
			const tail = tBlocks.length - origin.first - origin.count

			if (eBlocks.length < origin.first + tail)
				throw new OdtWriteRefusal("header", "the edit removed the spacing of a header or footer")

			const blocks = eBlocks.slice(origin.first, eBlocks.length - tail)

			// A header's paragraphs are written anew, their spans not followed.
			this.refuseUntranslated(styles, namespaces, node, "styles")

			const tree: UnitTree = this.regionTree(styles, namespaces, node)
			const emitter = new OdfEmitter(
				this.storyContext(
					origin.part,
					tree,
					tDoc,
					tBlocks.slice(origin.first, origin.first + origin.count),
					styles,
					namespaces,
					node
				)
			)
			const text = emitter.blocks(eDoc, blocks)

			this.styles.replacements.push({ start: styles.contentStart(node), end: styles.contentEnd(node), text })
			this.written += blocks.length
		}
	}

	// A master page region as a parsed source element (styles.xml is parsed whole: no shift).
	private regionTree(document: XmlDocument, namespaces: Namespaces, node: number): UnitTree {
		return {
			document,
			namespaces,
			node,
			shift: 0,
			emitters: undefined,
			opaque: undefined,
			blockOpaque: undefined,
			structuralOpaque: undefined,
			structural: false
		}
	}

	// The emit context of a header or footer: styles.xml's scope, styles and faces; the region's atoms and paragraphs.
	private storyContext(
		part: string,
		tree: UnitTree,
		tDoc: XmlDocument,
		tBlocks: readonly number[],
		styles: XmlDocument,
		namespaces: Namespaces,
		region: number
	): EmitContext {
		const pool = new AtomPool()
		const context: EmitContext = {
			...this.context,
			scope: "styles",
			// Headers' runs name no spans.
			tracksOrigin: () => false,
			registry: this.styles.registry,
			listIds: this.styles.lists,
			declarations: this.styles.declarations,
			fonts: { face: family => this.face(family, this.styles) },
			atoms: pool,
			paragraphSources: new Map(),
			links: new Map(),
			picture: (document, drawing) => {
				const rels = this.plan.edits.parts.get(part.replace(/^word\//u, "word/_rels/") + ".rels")

				return this.picture(document, drawing, rels === undefined ? this.doc.eRels : relationshipsOf(rels), this.styles)
			}
		}
		const sources = { drawings: [] as string[], fields: [] as { name: string; bytes: string }[], paragraphs: [] as number[] }
		const sourceNodes: number[] = []
		const walk = (at: number): void => {
			for (let child = styles.firstChildElement(at); child >= 0; child = styles.nextSiblingElement(child)) {
				const name = elementName(styles, namespaces, child)

				if (name.startsWith("draw:") || name.startsWith("dr3d:")) {
					sources.drawings.push(decodeUtf8(styles.raw(child)))
					sourceNodes.push(child)
				} else if (FIELD_ATOMS.has(name)) sources.fields.push({ name, bytes: decodeUtf8(styles.raw(child)) })
				else if (name === "text:page-number" || name === "text:page-count") continue
				else {
					if (name === "text:p" || name === "text:h") sources.paragraphs.push(child)

					walk(child)
				}
			}
		}

		walk(region)

		const drawings: string[] = []
		const drawingNodes: number[] = []
		const fields: string[] = []
		const paragraphs: number[] = []
		const collect = (at: number): void => {
			for (let child = tDoc.firstChildElement(at); child >= 0; child = tDoc.nextSiblingElement(child)) {
				const local = tDoc.localName(child)

				if (local === "drawing") {
					drawings.push(drawingKey(tDoc, child, this.doc.tRels, this.plan.translation))
					drawingNodes.push(child)
				} else if (local === "fldSimple" && fieldAtom(tDoc, child)) fields.push(fieldKey(tDoc, child))
				else {
					if (local === "p") paragraphs.push(child)

					collect(child)
				}
			}
		}

		for (const block of tBlocks) {
			if (tDoc.localName(block) === "p") paragraphs.push(block)

			collect(block)
		}

		if (drawings.length === sources.drawings.length) {
			drawings.forEach((key, k) =>
				this.addDrawing(pool, key, sources.drawings[k] ?? "", tDoc, drawingNodes[k] ?? -1, this.doc.tRels, {
					document: styles,
					namespaces,
					node: sourceNodes[k] ?? -1
				})
			)
		}
		pairFields(fields, sources.fields, pool)

		// The region's paragraphs pair with the translation's in order where they are as many.
		if (paragraphs.length === sources.paragraphs.length) {
			paragraphs.forEach((paragraph, k) => {
				const source = paragraphSource(tree, sources.paragraphs[k] ?? -1, tDoc, paragraph)

				if (source !== undefined)
					context.paragraphSources.set(`${source.pPr}|${source.mark}|${source.listed ? "listed" : "plain"}`, source)
			})
		}

		return context
	}

	private readonly released: Unit[] = []
	private readonly bookmarkNames = new WeakMap<XmlDocument, Map<string, string>>()

	private segment(segment: Omit<Segment, "id">, replacements: Replacement[], whole = false): void {
		const id = this.segments.length

		this.segments.push({ ...segment, id })

		for (const replacement of replacements) this.content.replacements.push({ ...replacement, segment: id })

		// Start tags restyled within kept or in-place units (a whole rewrite writes them anew).
		if (!whole) {
			for (const unit of segment.units) {
				for (const replacement of this.unitPatches.get(unit.index) ?? [])
					this.content.replacements.push({ ...replacement, segment: id })
			}
		}
	}

	// --- Regions ---

	private atomsOf(units: readonly Unit[]): void {
		const plan = this.plan
		const doc = this.doc
		const pool = this.context.atoms

		for (const unit of units) {
			const tree = plan.tree(unit)
			const sources = {
				drawings: [] as string[],
				notes: [] as string[],
				fields: [] as { name: string; bytes: string }[],
				comments: [] as { bytes: string; name: string | undefined }[]
			}
			const sourceNodes: number[] = []
			const walk = (node: number): void => {
				for (let child = tree.document.firstChildElement(node); child >= 0; child = tree.document.nextSiblingElement(child)) {
					const name = elementName(tree.document, tree.namespaces, child)
					const bytes = (): string => decodeUtf8(tree.document.raw(child))

					if (name.startsWith("draw:") || name.startsWith("dr3d:")) {
						sources.drawings.push(bytes())
						sourceNodes.push(child)
					} else if (name === "text:note") sources.notes.push(bytes())
					else if (FIELD_ATOMS.has(name)) sources.fields.push({ name, bytes: bytes() })
					else if (name === "office:annotation") {
						const officeName = [...tree.document.attributes(child)].find(
							attribute => canonicalAttribute(tree.namespaces, child, attribute.name) === "office:name"
						)

						sources.comments.push({ bytes: bytes(), name: officeName?.value })
					} else walk(child)
				}
			}

			if (tree.node >= 0) walk(tree.document.documentElement())

			const drawings: string[] = []
			const drawingNodes: number[] = []
			const notes: string[] = []
			const fields: string[] = []
			const comments: string[] = []
			const { first, count } = unit.origin

			for (let k = first; k < first + count; k++) {
				const block = doc.tBlocks[k]

				if (block === undefined) continue

				// In document order: drawings, note references and comment starts as the translator wrote them.
				const walk = (node: number): void => {
					for (let child = doc.tBody.firstChildElement(node); child >= 0; child = doc.tBody.nextSiblingElement(child)) {
						const local = doc.tBody.localName(child)

						if (local === "drawing") {
							drawings.push(drawingKey(doc.tBody, child, doc.tRels, plan.translation))
							drawingNodes.push(child)
						} else if (local === "footnoteReference" || local === "endnoteReference") {
							notes.push(
								`${local === "footnoteReference" ? "footnote" : "endnote"}:${doc.tBody.attribute(child, "w:id") ?? ""}`
							)
						} else if (local === "commentRangeStart") comments.push(`comment:${doc.tBody.attribute(child, "w:id") ?? ""}`)
						else if (local === "fldSimple" && fieldAtom(doc.tBody, child)) fields.push(fieldKey(doc.tBody, child))
						else walk(child)
					}
				}

				walk(block)
			}

			// Page-anchored frames before the unit sit in its first paragraph: they stay where they are.
			const external = this.anchorsBefore(unit)

			for (let k = 0; k < external && k < drawings.length; k++) pool.add(drawings[k] ?? "", { bytes: "", used: false })

			const inline = drawings.slice(Math.min(external, drawings.length))

			if (inline.length === sources.drawings.length) {
				inline.forEach((key, k) => {
					const node = drawingNodes[Math.min(external, drawings.length) + k] ?? -1

					this.addDrawing(pool, key, this.fixedFrameMarkup(sources.drawings[k] ?? "", node), doc.tBody, node, doc.tRels, {
						document: tree.document,
						namespaces: tree.namespaces,
						node: sourceNodes[k] ?? -1
					})
				})
			}
			pairFields(fields, sources.fields, pool)
			if (notes.length === sources.notes.length)
				notes.forEach((key, k) => pool.add(key, { bytes: sources.notes[k] ?? "", used: false }))
			if (comments.length === sources.comments.length) {
				comments.forEach((key, k) => {
					const source = sources.comments[k]

					if (source !== undefined)
						pool.add(key, { bytes: source.bytes, ...(source.name === undefined ? {} : { name: source.name }), used: false })
				})
			}

			this.learnParagraphs(unit, tree)
		}
	}

	// How many page-anchored frames (count-0 drawing units) come right before a unit.
	private anchorsBefore(unit: Unit): number {
		let count = 0

		for (let index = unit.index - 1; index >= 0; index--) {
			const before = this.plan.units[index]

			if (before === undefined || before.origin.count > 0) break

			const tree = this.plan.tree(before)
			const name = tree.node < 0 ? "" : elementName(tree.document, tree.namespaces, tree.node)

			if (name.startsWith("draw:") || name.startsWith("dr3d:")) count++
		}

		return count
	}

	// Source paragraphs a written paragraph with the same properties takes the start tag of, and link start tags.
	private learnParagraphs(unit: Unit, tree: UnitTree): void {
		const doc = this.doc
		const emitters = tree.emitters

		if (emitters !== undefined) {
			emitters.forEach((emitter, k) => {
				const block = doc.tBlocks[unit.origin.first + k]

				if (block === undefined || doc.tBody.localName(block) !== "p") return

				const source = paragraphSource(tree, emitter, doc.tBody, block, this.tableSpacing?.shift(doc.tBody, block))

				if (source === undefined || this.breaksPage(source.styleName)) return

				// A plain paragraph's start tag reads the same in a list too (the list adds the indents).
				this.context.paragraphSources.set(`${source.pPr}|${source.mark}|${source.listed ? "listed" : "plain"}`, source)

				if (
					!source.listed &&
					!source.pPr.includes("<ind") &&
					!this.context.paragraphSources.has(`${source.pPr}|${source.mark}|listed`)
				) {
					this.context.paragraphSources.set(`${source.pPr}|${source.mark}|listed`, source)
				}
			})
		}

		const stack = tree.node < 0 ? [] : [tree.node]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			for (let child = tree.document.firstChildElement(node); child >= 0; child = tree.document.nextSiblingElement(child)) {
				const name = elementName(tree.document, tree.namespaces, child)

				if (name === "text:span") {
					const spanStyle = attributeNamed(tree, child, "text:style-name")

					if (spanStyle !== undefined) this.emitter.spanNames.add(spanStyle)
				}

				if (name === "text:a") {
					const href = [...tree.document.attributes(child)].find(
						attribute => canonicalAttribute(tree.namespaces, child, attribute.name) === "xlink:href"
					)

					if (href !== undefined && !this.context.links.has(href.value)) {
						const open = decodeUtf8(
							tree.document.raw(child).subarray(0, tree.document.openEnd(child) - tree.document.start(child))
						)

						// An empty link's tag is self-closed; the link written anew wraps its text.
						this.context.links.set(href.value, tree.document.isSelfClosing(child) ? open.replace(/\s*\/>$/u, ">") : open)
					}
				}

				if (!name.startsWith("draw:") && !ATOMS.has(name)) stack.push(child)
			}
		}
	}

	private inBodyLevel(document: XmlDocument, sectPr: number): boolean {
		return document.localName(document.parent(sectPr)) === "body"
	}

	// A paragraph written anew in place of `node` that started a page style keeps starting it (its style's master
	// page, Part 3 §19.501).
	private keepMaster(tree: UnitTree, node: number, block: number): void {
		if (this.doc.masters.has(block)) return

		const name = attributeNamed(tree, node, "text:style-name")
		const master =
			name === undefined ? undefined : this.plan.sheet.style("paragraph", name, "content")?.attributes.get("style:master-page-name")

		if (master !== undefined && master !== "") this.doc.masters.set(block, master)
	}

	// Whether a paragraph style breaks the page or starts a page style: what its translation says of that depends
	// on where the paragraph stands (the document's first paragraph has no break), so its start tag is no other's.
	private breaksPage(name: string | undefined): boolean {
		if (name === undefined) return false

		this.resolver ??= new OdfStyleResolver(this.plan.sheet)

		const resolved = this.resolver.resolve("paragraph", name, "content")
		const paragraph = resolved.properties("paragraph").attributes
		const before = paragraph.get("fo:break-before") ?? "auto"
		const after = paragraph.get("fo:break-after") ?? "auto"

		return (
			before !== "auto" ||
			after !== "auto" ||
			resolved.chain.some(style => (style.attributes.get("style:master-page-name") ?? "") !== "")
		)
	}

	private writeRegion(region: Region): void {
		const doc = this.doc
		const eBlocks = doc.eBlocks.slice(region.from, region.to)
		const tBlocks = region.units.flatMap(unit => doc.tBlocks.slice(unit.origin.first, unit.origin.first + unit.origin.count))

		this.atomsOf(region.units)

		for (const unit of region.units) {
			const tree = this.plan.tree(unit)

			if (tree.structuralOpaque !== undefined) throw new OdtWriteRefusal("locked", `a block holding ${tree.structuralOpaque}`)
			const lossy = this.plan.lossy(unit)

			if (lossy !== undefined) throw new OdtWriteRefusal("locked", `a block the editor shows approximated (${lossy})`)
		}

		const start = region.units[0]?.origin.start ?? region.at
		const end = region.units[region.units.length - 1]?.origin.end ?? region.at

		if (tBlocks.length > 0) {
			const replacements = this.inPlace(region.units, tBlocks, eBlocks)

			if (replacements !== undefined) {
				this.segment({ start, end, kind: "written", units: region.units, from: region.from, to: region.to }, replacements)

				return
			}
		}

		const opaque = region.units.map(unit => this.plan.tree(unit).opaque).find(reason => reason !== undefined)

		if (opaque !== undefined) throw new OdtWriteRefusal("locked", `a block holding ${opaque}`)

		if (region.units.some(unit => this.plan.tree(unit).structural)) {
			throw new OdtWriteRefusal("structure", "changing the paragraphs of a section, an index or an anchored frame")
		}

		// Units holding no blocks keep their place (declarations, tracked-change records), ahead of the rewrite.
		let markup = ""

		for (const unit of region.units)
			if (unit.origin.count === 0) markup += decodeUtf8(this.plan.contentBytes.subarray(unit.origin.start, unit.origin.end))

		this.seedLists(region)
		this.writingAt = start
		this.context.table = this.regionTables(region.units, tBlocks, eBlocks)
		markup += this.emitter.blocks(doc.eBody, eBlocks, this.textsOf(region.units, tBlocks, eBlocks))
		this.context.table = undefined

		this.written += eBlocks.length
		this.segment(
			{ start, end, kind: "written", units: region.units, from: region.from, to: region.to },
			[{ start, end, text: markup }],
			true
		)
	}

	private readonly untranslatedStyles = new Map<string, boolean>()

	// Whether a span style says what its WordprocessingML does not (props.ts: untranslatedText).
	private untranslated(name: string, scope: StyleScope): boolean {
		const key = `${scope}\u0000${name}`
		let found = this.untranslatedStyles.get(key)

		if (found === undefined) {
			const own = this.plan.mapper.text(name, scope).own
			let lossy = false

			runProperties(this.plan.sheet, own, { lossy: reason => (lossy ||= reason === "untranslatedText") })
			found = lossy
			this.untranslatedStyles.set(key, found)
		}

		return found
	}

	// The source text of a paragraph a rewrite follows: a paragraph holding a span style that says what its
	// WordprocessingML does not is rewritten only where each of its characters' styles is known (sourceText.ts),
	// as that style is kept from the source.
	private followed(
		document: XmlDocument,
		namespaces: Namespaces,
		node: number,
		tDoc: XmlDocument,
		t: number,
		scope: StyleScope = "content"
	): SourceText | undefined {
		const text = sourceTextOf(document, namespaces, node, tDoc, t)

		if (text !== undefined && !text.styles.includes(null)) return text

		this.refuseUntranslated(document, namespaces, node, scope)

		return text
	}

	// Refuses a rewrite of `node` that could not follow its spans when one says what its WordprocessingML does not.
	private refuseUntranslated(document: XmlDocument, namespaces: Namespaces, node: number, scope: StyleScope): void {
		const stack = [node]

		for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
			for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) {
				const name = elementName(document, namespaces, child)

				if (name === "text:span" || name === "text:a") {
					const style = attributeOf(document, namespaces, child, "text:style-name")

					if (style !== undefined && this.untranslated(style, scope))
						throw new OdtWriteRefusal(
							"locked",
							"a span with text properties the editor does not show, in text the writer cannot follow"
						)
				}

				if (!name.startsWith("draw:") && !ATOMS.has(name)) stack.push(child)
			}
		}
	}

	// A paragraph's source text with the removed source paragraph after it, where the edited paragraph (`edited`)
	// ends with that one's text (Backspace at its start joined them): the characters of both keep their spans.
	private joined(
		text: SourceText | undefined,
		own: { readonly tree: UnitTree; readonly node: number },
		block: number,
		next: { readonly tree: UnitTree; readonly node: number },
		nextBlock: number,
		edited: number
	): SourceText | undefined {
		const doc = this.doc

		if (nextBlock < 0 || doc.tBody.localName(nextBlock) !== "p" || doc.tBody.localName(block) !== "p") return text

		const read = sourceTextOf(next.tree.document, next.tree.namespaces, next.node, doc.tBody, nextBlock)

		if (read === undefined || !wmlText(doc.eBody, edited).endsWith(read.text)) return text

		const after = this.followed(next.tree.document, next.tree.namespaces, next.node, doc.tBody, nextBlock)
		const first = text ?? odfText(own.tree.document, own.tree.namespaces, own.node)

		if (after === undefined || first === undefined) return text

		return { text: first.text + after.text, styles: [...first.styles, ...after.styles] }
	}

	// The source text each edited paragraph of a region takes its characters' span styles from: the source paragraph
	// it pairs with, or for one inserted, the source paragraph before it (a split's second half).
	private textsOf(
		units: readonly Unit[],
		tBlocks: readonly number[],
		eBlocks: readonly number[]
	): (node: number) => SourceText | undefined {
		const doc = this.doc
		const sources: ({ tree: UnitTree; node: number } | undefined)[] = []

		for (const unit of units) {
			if (unit.origin.count === 0) continue

			const tree = this.plan.tree(unit)

			for (let b = 0; b < unit.origin.count; b++) {
				const node = tree.emitters?.[b]

				sources.push(node === undefined ? undefined : { tree, node })
			}
		}

		const { pairs, inserted } = this.pairBlocks(tBlocks, eBlocks)
		const byBlock = new Map<number, number>()

		pairs.forEach((e, t) => {
			if (e < 0) return

			const block = eBlocks[e] ?? -1
			const source = sources[t]

			byBlock.set(block, t)

			if (source !== undefined) this.keepMaster(source.tree, source.node, block)
		})

		const fresh = new Set<number>()

		for (const [after, blocks] of inserted)
			for (const e of blocks) {
				byBlock.set(eBlocks[e] ?? -1, Math.max(0, after))
				fresh.add(eBlocks[e] ?? -1)
			}

		// Each source paragraph an edited one follows (deleted ones need none), read once.
		const texts = new Map<number, SourceText | undefined>()

		for (const t of new Set(byBlock.values())) {
			const source = sources[t]
			const block = tBlocks[t] ?? -1

			texts.set(
				t,
				source === undefined || block < 0 || doc.tBody.localName(block) !== "p"
					? undefined
					: this.followed(source.tree.document, source.tree.namespaces, source.node, doc.tBody, block)
			)
		}

		// A paragraph joined with the removed one after it: the characters of both.
		const referenced = new Set(byBlock.values())

		for (const [node, t] of byBlock) {
			const own = sources[t]
			const next = sources[t + 1]

			if (own === undefined || next === undefined || referenced.has(t + 1)) continue

			texts.set(t, this.joined(texts.get(t), own, tBlocks[t] ?? -1, next, tBlocks[t + 1] ?? -1, node))
		}

		return node => {
			const t = byBlock.get(node)
			const text = t === undefined ? undefined : texts.get(t)

			return text === undefined || !fresh.has(node) ? text : { ...text, fresh: true }
		}
	}

	// The region's source tables an edited table is written from: one unchanged as its bytes, one changed (paired by
	// order between unchanged ones) with its changed rows rewritten.
	private regionTables(
		units: readonly Unit[],
		tBlocks: readonly number[],
		eBlocks: readonly number[]
	): (document: XmlDocument, table: number) => string | undefined {
		const doc = this.doc
		const sources: { t: number; tree: UnitTree; node: number }[] = []
		let k = 0

		for (const unit of units) {
			if (unit.origin.count === 0) continue

			const tree = this.plan.tree(unit)

			for (let b = 0; b < unit.origin.count; b++, k++) {
				const t = tBlocks[k] ?? -1
				const node = tree.emitters?.[b]

				if (
					node !== undefined &&
					doc.tBody.localName(t) === "tbl" &&
					elementName(tree.document, tree.namespaces, node) === "table:table"
				)
					sources.push({ t, tree, node })
			}
		}

		const tables = eBlocks.filter(block => doc.eBody.localName(block) === "tbl")
		const key = (document: XmlDocument, node: number): string => `${fnv(document.raw(node))}:${document.raw(node).length}`
		const match = matchBlocks(
			sources.map(source => key(doc.tBody, source.t)),
			tables.map(table => key(doc.eBody, table))
		)
		const byTable = new Map<number, string>()
		const raw = (source: { t: number; tree: UnitTree; node: number }, table: number): string => {
			const markup = decodeUtf8(source.tree.document.raw(source.node))
			const fixed = this.fixedTable(source.tree, source.node, source.t, this.doc.masters.get(table))

			if (fixed === undefined) return markup

			const document = source.tree.document

			return (
				fixed.text +
				markup.slice(
					decodeUtf8(document.raw(source.node).subarray(0, document.openEnd(source.node) - document.start(source.node))).length
				)
			)
		}
		const spliced = (source: { t: number; tree: UnitTree; node: number }, table: number): string | undefined => {
			const replacements = this.replaceTable(doc.tBody, source.t, doc.eBody, table, source.tree, source.node)

			if (replacements === undefined) return undefined

			// The replacements applied to the table's own bytes.
			const start = source.tree.document.start(source.node) + source.tree.shift
			const bytes = this.plan.contentBytes
			let out = ""
			let at = start

			for (const replacement of [...replacements].sort((a, b) => a.start - b.start)) {
				out += decodeUtf8(bytes.subarray(at, replacement.start)) + replacement.text
				at = replacement.end
			}

			return out + decodeUtf8(bytes.subarray(at, source.tree.document.end(source.node) + source.tree.shift))
		}
		// Between two matched pairs, unmatched source and edited tables pair in order.
		let previousT = -1
		let previousE = -1

		for (let t = 0; t <= sources.length; t++) {
			const e = t < sources.length ? (match[t] ?? -1) : tables.length

			if (e < 0) continue

			for (let k = 0; previousT + 1 + k < t && previousE + 1 + k < e; k++) {
				const source = sources[previousT + 1 + k]
				const table = tables[previousE + 1 + k] ?? -1
				const markup = source === undefined ? undefined : spliced(source, table)

				if (markup !== undefined) byTable.set(table, markup)
			}

			const source = sources[t]

			if (source !== undefined) byTable.set(tables[e] ?? -1, raw(source, tables[e] ?? -1))

			previousT = t
			previousE = e
		}

		return (_document, table) => byTable.get(table)
	}

	// Lists before a rewrite: the w:num each list style last numbered, so a list the rewrite starts can continue it.
	private seedLists(region: Region): void {
		const doc = this.doc

		for (let k = 0; k < region.from; k++) {
			const block = doc.eBlocks[k]

			if (block === undefined || doc.eBody.localName(block) !== "p") continue

			const pPr = childNamed(doc.eBody, block, "pPr")
			const numPr = pPr < 0 ? -1 : childNamed(doc.eBody, pPr, "numPr")
			const numId = numPr < 0 ? undefined : doc.eBody.attribute(childNamed(doc.eBody, numPr, "numId"), "w:val")

			if (numId === undefined) continue

			const target = this.listTarget(numId)

			if (target === undefined || target.outline) continue

			this.emitter.lastList.set(target.style, numId)
			this.emitter.last = numId
			this.emitter.used.add(numId)
		}
	}

	// Each changed block rewritten inside its element, where the blocks pair one to one and keep their kind and list
	// place; undefined when they do not.
	private inPlace(units: readonly Unit[], tBlocks: readonly number[], eBlocks: readonly number[]): Replacement[] | undefined {
		const doc = this.doc
		const emitters: { tree: UnitTree; node: number; opaque: string | undefined; block: number }[] = []

		for (const unit of units) {
			if (unit.origin.count === 0) continue

			const tree = this.plan.tree(unit)

			if (tree.emitters === undefined) return undefined

			tree.emitters.forEach((node, k) => emitters.push({ tree, node, opaque: tree.blockOpaque?.[k], block: unit.origin.first + k }))
		}

		const out: Replacement[] = []
		// Fewer edited blocks: those removed are found by matching (unmatched ones between two matched pair in order,
		// the rest of the source's are removed); an inserted block is no in-place rewrite.
		// Paired by what they hold (a block removed and another added keep the count, not the places).
		const paired = this.pairBlocks(tBlocks, eBlocks)

		if (paired === undefined) return undefined

		const pairs = paired.pairs
		// Blocks the edit inserted, written beside the source block before them (or before the first): never inside a
		// list item, where they would join its item.
		const insert = (after: number): boolean => {
			const blocks = paired.inserted.get(after)

			if (blocks === undefined) return true

			const anchor = emitters[after < 0 ? 0 : after]

			if (anchor === undefined) return false

			const parent = anchor.tree.document.parent(anchor.node)
			const parentName = parent > 0 ? elementName(anchor.tree.document, anchor.tree.namespaces, parent) : ""

			if (parentName === "text:list-item" || parentName === "text:list-header") return false

			const at = (after < 0 ? anchor.tree.document.start(anchor.node) : anchor.tree.document.end(anchor.node)) + anchor.tree.shift
			const index = this.doc.eBlocks.indexOf(blocks[0] ?? -1)

			if (index >= 0) this.seedLists({ units: [], from: index, to: index, at: 0 })

			this.writingAt = at

			// A split's new half: its characters take their span styles from the source paragraph it came from.
			const t = tBlocks[after < 0 ? 0 : after] ?? -1
			const source =
				doc.tBody.localName(t) === "p"
					? this.followed(anchor.tree.document, anchor.tree.namespaces, anchor.node, doc.tBody, t)
					: undefined

			// The halves a split adds to a paragraph with an id get ids of their own (the first keeps the source's).
			this.emitter.freshIds =
				after >= 0 && attributeOf(anchor.tree.document, anchor.tree.namespaces, anchor.node, "xml:id") !== undefined

			out.push({
				start: at,
				end: at,
				text: this.emitter.blocks(
					doc.eBody,
					blocks.map(block => eBlocks[block] ?? -1),
					() => (source === undefined ? undefined : { ...source, fresh: true })
				)
			})
			this.emitter.freshIds = false
			this.written += blocks.length

			return true
		}

		if (!insert(-1)) return undefined

		for (let k = 0; k < tBlocks.length; k++) {
			const t = tBlocks[k] ?? -1
			const paired = pairs[k] ?? -1
			const e = paired < 0 ? -1 : (eBlocks[paired] ?? -1)
			const emitter = emitters[k]

			if (emitter === undefined) return undefined

			if (e < 0) {
				if (emitter.opaque !== undefined) throw new OdtWriteRefusal("locked", `a block holding ${emitter.opaque}`)

				out.push({ ...this.removal(emitter.tree, emitter.node), text: "" })
				this.written++

				continue
			}

			if (!this.mode.prove && equalBytes(doc.tBody.raw(t), doc.eBody.raw(e)) && !this.touchesDirty(e)) {
				const fixed = this.fixedTable(emitter.tree, emitter.node, t, this.doc.masters.get(e))

				if (fixed !== undefined) out.push(fixed)

				appendAll(out, this.framesWithin(emitter.tree, emitter.node, t))

				continue
			}

			if (emitter.opaque !== undefined) {
				// Gate 1 locks the block; an edit that reached it anyway is refused.
				if (!this.mode.prove) throw new OdtWriteRefusal("locked", `a block holding ${emitter.opaque}`)

				this.failedBlocks.set(emitter.block, emitter.opaque)

				continue
			}

			const following = emitters[k + 1]
			const joins = following !== undefined && (pairs[k + 1] ?? -1) < 0 ? { ...following, block: tBlocks[k + 1] ?? -1 } : undefined
			const replaced = this.replaceBlock(doc.tBody, t, doc.eBody, e, emitter.tree, emitter.node, joins)

			if (replaced === undefined) return undefined

			appendAll(out, replaced)
		}

		for (let k = 0; k < tBlocks.length; k++) if (!insert(k)) return undefined

		// A list kept in its element continues what it continues in the edit (lists written before it may have changed).
		let first = 0

		for (const unit of units) {
			if (unit.origin.count === 0) continue

			const e = eBlocks[pairs[first] ?? -1] ?? -1

			first += unit.origin.count
			this.writingAt = unit.origin.start

			const patch = e < 0 ? undefined : this.listContinuation(this.plan.tree(unit), e)

			if (patch !== undefined) out.push(patch)
		}

		return out
	}

	// For each source block, the edited block it became (-1: removed); undefined where a block was inserted.
	private pairBlocks(tBlocks: readonly number[], eBlocks: readonly number[]): { pairs: number[]; inserted: Map<number, number[]> } {
		const doc = this.doc
		const key = (document: XmlDocument, block: number): string => `${fnv(document.raw(block))}:${document.raw(block).length}`
		const match = matchBlocks(
			tBlocks.map(block => key(doc.tBody, block)),
			eBlocks.map(block => key(doc.eBody, block))
		)
		const out = Array.from(match)
		const inserted = new Map<number, number[]>()
		let previousT = -1
		let previousE = -1

		for (let t = 0; t <= tBlocks.length; t++) {
			const e = t < tBlocks.length ? (match[t] ?? -1) : eBlocks.length

			if (e < 0) continue

			const removed = t - previousT - 1
			const added = e - previousE - 1
			const changed = Math.min(removed, added)

			// Changed blocks pair in order with the first source blocks between; the rest were removed, or inserted after
			// the last of them.
			for (let k = 0; k < changed; k++) out[previousT + 1 + k] = previousE + 1 + k

			if (added > removed)
				inserted.set(
					t - 1,
					Array.from({ length: added - removed }, (_unused, k) => previousE + 1 + changed + k)
				)

			previousT = t
			previousE = e
		}

		return { pairs: out, inserted }
	}

	// The span a removed block takes with it: its element, or the list item it alone made.
	private removal(tree: UnitTree, node: number): { start: number; end: number } {
		let at = node
		const parent = tree.document.parent(node)
		const parentName = parent > 0 ? elementName(tree.document, tree.namespaces, parent) : ""

		if (
			(parentName === "text:list-item" || parentName === "text:list-header") &&
			tree.document.firstChildElement(parent) === node &&
			tree.document.nextSiblingElement(node) < 0
		) {
			at = parent
		}

		return { start: tree.document.start(at) + tree.shift, end: tree.document.end(at) + tree.shift }
	}

	private touchesDirty(block: number): boolean {
		return this.doc.keys(this.doc.eBody, [block], true)[0]?.startsWith("dirty") === true
	}

	// One block rewritten in its source element: a paragraph's content and style, a table's changed rows.
	private replaceBlock(
		tDoc: XmlDocument,
		t: number,
		eDoc: XmlDocument,
		e: number,
		tree: UnitTree,
		node: number,
		joins?: { readonly tree: UnitTree; readonly node: number; readonly block: number }
	): Replacement[] | undefined {
		const tLocal = tDoc.localName(t)
		const eLocal = eDoc.localName(e)
		const name = elementName(tree.document, tree.namespaces, node)
		const start = tree.document.start(node) + tree.shift
		const end = tree.document.end(node) + tree.shift

		if (tLocal === "p" && eLocal === "p" && (name === "text:p" || name === "text:h")) {
			if (numberingOf(tDoc, t) !== numberingOf(eDoc, e)) {
				// A paragraph put in a list where it stood: its element becomes the list (the lists before it known).
				if (tDoc !== this.doc.tBody || numberingOf(tDoc, t) !== "" || inList(tree, node) || numberingOf(eDoc, e) === "")
					return undefined

				const index = this.doc.eBlocks.indexOf(e)

				if (index < 0) return undefined

				this.seedLists({ units: [], from: index, to: index, at: 0 })
				this.written++
				this.writingAt = start
				this.keepMaster(tree, node, e)

				const text = this.followed(tree.document, tree.namespaces, node, tDoc, t)

				return [{ start, end, text: this.emitter.blocks(eDoc, [e], () => text) }]
			}

			// Its text as it was, only its page style now another: its start tag restyled, its content kept.
			const master = eDoc === this.doc.eBody ? this.doc.masters.get(e) : undefined
			const restyled =
				master === undefined || !equalBytes(tDoc.raw(t), eDoc.raw(e)) ? undefined : this.restyledStart(tree, node, master)

			if (restyled !== undefined) {
				this.written++

				return [restyled]
			}

			const source = paragraphSource(tree, node, tDoc, t, this.tableSpacing?.shift(tDoc, t))

			this.written++

			return [
				{
					start,
					end,
					text: this.emitter.paragraph(
						eDoc,
						e,
						source,
						this.outlineLevel(tDoc, t),
						joins === undefined || eDoc !== this.doc.eBody
							? this.followed(tree.document, tree.namespaces, node, tDoc, t)
							: this.joined(
									this.followed(tree.document, tree.namespaces, node, tDoc, t),
									{ tree, node },
									t,
									joins,
									joins.block,
									e
								)
					)
				}
			]
		}

		if (tLocal === "tbl" && eLocal === "tbl" && name === "table:table") return this.replaceTable(tDoc, t, eDoc, e, tree, node)

		return undefined
	}

	// The outline level of a heading the outline style numbers (its text:h keeps that numbering).
	outlineLevel(document: XmlDocument, paragraph: number): number | undefined {
		const pPr = childNamed(document, paragraph, "pPr")
		const numPr = pPr < 0 ? -1 : childNamed(document, pPr, "numPr")

		if (numPr < 0) return undefined

		const numId = document.attribute(childNamed(document, numPr, "numId"), "w:val")

		if (numId === undefined || this.listTarget(numId)?.outline !== true) return undefined

		return Number(document.attribute(childNamed(document, numPr, "ilvl"), "w:val") ?? "0")
	}

	private resolver: OdfStyleResolver | undefined
	// Start tags of kept or rewritten-in-place units the edit restyles (a text:section given its new columns).
	private readonly unitPatches = new Map<number, Replacement[]>()

	// A section on the page before it (an ODF text:section, Part 3 §5.4): its columns are its section style's
	// (§17.12 style:columns), written as a style of its own; the page is the page's, and set up there.
	private sectionColumns(section: number, edited: number): void {
		const doc = this.doc
		const tDoc = doc.tBody
		const eDoc = doc.eBody
		const page = (document: XmlDocument, sectPr: number): string => {
			let out = ""

			for (let child = document.firstChildElement(sectPr); child >= 0; child = document.nextSiblingElement(child)) {
				const local = document.localName(child)

				if (local !== "cols" && local !== "type") out += canonicalElement(document, child)
			}

			return out
		}

		// style:section-properties (Part 3) holds a section's columns, background and side indents: no page size,
		// orientation, vertical margins or headers. A page set up otherwise is a page style, which starts a new page
		// (style:master-page-name), and a continuous section has none.
		if (page(tDoc, section) !== page(eDoc, edited)) {
			throw new OdtWriteRefusal(
				"sections",
				"page setup of a section that shares its page (an ODF text:section has no page of its own)"
			)
		}

		const paragraph = tDoc.parent(tDoc.parent(section))
		const index = doc.tBlocks.indexOf(paragraph)
		const unit =
			index < 0
				? undefined
				: this.plan.units.find(item => item.origin.first <= index && index < item.origin.first + item.origin.count)
		const tree = unit === undefined ? undefined : this.plan.tree(unit)
		let node = tree?.emitters?.[index - (unit?.origin.first ?? 0)] ?? -1

		while (tree !== undefined && node > 0 && elementName(tree.document, tree.namespaces, node) !== "text:section")
			node = tree.document.parent(node)

		if (unit === undefined || tree === undefined || node <= 0)
			throw new OdtWriteRefusal("sections", "the columns of a section the writer cannot find")

		const cols = childNamed(eDoc, edited, "cols")
		const count = Number(eDoc.attribute(cols, "w:num") ?? "1") || 1

		if (eDoc.attribute(cols, "w:equalWidth") === "0") throw new OdtWriteRefusal("sections", "columns of unequal widths")

		const gap = Number(eDoc.attribute(cols, "w:space") ?? "0") / 20
		const columns =
			count > 1
				? `<style:columns fo:column-count="${count}" fo:column-gap="${Math.round(gap * 10_000) / 10_000}pt">${eDoc.attribute(cols, "w:sep") === "1" ? '<style:column-sep style:width="0.0071in" style:color="#000000" style:height="100%"/>' : ""}</style:columns>`
				: ""
		const sourceName = attributeNamed(tree, node, "text:style-name")
		const prologue = this.plan.prologueDocument
		const namespaces = new Namespaces(prologue)
		let attributes = ""
		let inner = ""
		let rest = ""

		// The source style's other properties kept.
		for (
			let container = prologue.firstChildElement(prologue.documentElement());
			container >= 0;
			container = prologue.nextSiblingElement(container)
		) {
			if (elementName(prologue, namespaces, container) !== "office:automatic-styles") continue

			for (let style = prologue.firstChildElement(container); style >= 0; style = prologue.nextSiblingElement(style)) {
				if (
					elementName(prologue, namespaces, style) !== "style:style" ||
					attributeOf(prologue, namespaces, style, "style:name") !== sourceName
				)
					continue
				if (attributeOf(prologue, namespaces, style, "style:family") !== "section") continue

				for (const attribute of prologue.attributes(style)) {
					const canonical = canonicalAttribute(namespaces, style, attribute.name)

					if (canonical !== "style:name" && canonical !== "style:family" && !attribute.name.startsWith("xmlns"))
						attributes += ` ${canonical}="${esc(attribute.value)}"`
				}

				for (let child = prologue.firstChildElement(style); child >= 0; child = prologue.nextSiblingElement(child)) {
					if (elementName(prologue, namespaces, child) !== "style:section-properties") {
						rest += decodeUtf8(prologue.raw(child))

						continue
					}

					for (const attribute of prologue.attributes(child)) {
						if (!attribute.name.startsWith("xmlns"))
							inner += ` ${canonicalAttribute(namespaces, child, attribute.name)}="${esc(attribute.value)}"`
					}

					inner = `${inner}>`

					for (let item = prologue.firstChildElement(child); item >= 0; item = prologue.nextSiblingElement(item)) {
						if (elementName(prologue, namespaces, item) !== "style:columns") inner += decodeUtf8(prologue.raw(item))
					}
				}
			}
		}

		const properties = `<style:section-properties${inner === "" ? ">" : inner}${columns}</style:section-properties>`
		const name = this.content.registry.element(
			`section\u0000${attributes}\u0000${properties}${rest}`,
			"Sect",
			made =>
				`<style:style${this.content.declarations} style:name="${esc(made)}" style:family="section"${attributes}>${properties}${rest}</style:style>`
		)
		const document = tree.document
		const open = decodeUtf8(document.raw(node).subarray(0, document.openEnd(node) - document.start(node)))
		const attribute = [...document.attributes(node)].find(
			item => canonicalAttribute(tree.namespaces, node, item.name) === "text:style-name"
		)
		const tag =
			attribute === undefined
				? open.replace(/^(<[^\s/>]+)/u, `$1 text:style-name="${esc(name)}"`)
				: open.replace(
						new RegExp(`(\\s${attribute.name.replace(/[.]/gu, "\\.")}\\s*=\\s*)(["'])[^"']*\\2`, "u"),
						`$1"${esc(name)}"`
					)
		const patches = this.unitPatches.get(unit.index) ?? []

		patches.push({ start: document.start(node) + tree.shift, end: document.openEnd(node) + tree.shift, text: tag })
		this.unitPatches.set(unit.index, patches)
	}

	// The width (points) a table shows its grid at: the one its columns' rounded widths came from (each its share of
	// the width, Part 3 §20.338 style:rel-column-width), so the columns read back as they show.
	private tableWidth(
		tree: UnitTree,
		node: number,
		table: number,
		tDoc: XmlDocument = this.doc.tBody,
		scope: StyleScope = "content"
	): number {
		const grid: number[] = []
		const tblGrid = childNamed(tDoc, table, "tblGrid")

		for (let column = tblGrid < 0 ? -1 : tDoc.firstChildElement(tblGrid); column >= 0; column = tDoc.nextSiblingElement(column)) {
			grid.push(Number(tDoc.attribute(column, "w:w") ?? "0"))
		}

		const sum = grid.reduce((total, column) => total + column, 0)
		const columns: { absolute: number | undefined; relative: number | undefined }[] = []
		const document = tree.document
		const resolver = (this.resolver ??= new OdfStyleResolver(this.plan.sheet))
		const collect = (container: number): void => {
			for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
				const name = elementName(document, tree.namespaces, child)

				if (name === "table:table-column") {
					const style = resolver
						.resolve("table-column", attributeNamed(tree, child, "table:style-name"), scope)
						.properties("table-column").attributes
					const info = {
						absolute: parseLength(style.get("style:column-width")),
						relative: parseRelativeLength(style.get("style:rel-column-width"))
					}
					const repeat = Math.max(1, Number(attributeNamed(tree, child, "table:number-columns-repeated") ?? "1") || 1)

					for (let k = 0; k < repeat && columns.length < grid.length; k++) columns.push(info)
				} else if (name === "table:table-columns" || name === "table:table-header-columns" || name === "table:table-column-group")
					collect(child)
			}
		}

		collect(node)

		while (columns.length < grid.length) columns.push({ absolute: undefined, relative: undefined })

		const weights = columns.every(column => column.relative !== undefined)
			? columns.map(column => column.relative ?? 0)
			: columns.some(column => (column.absolute ?? 0) > 0)
				? columns.map(column => column.absolute ?? 0)
				: columns.map(() => 1)
		const total = weights.reduce((sum, weight) => sum + weight, 0)
		let low = 0
		let high = Infinity

		grid.forEach((column, k) => {
			const share = (weights[k] ?? 0) / total

			// A column at the minimum width says nothing of the table's.
			if (share <= 0 || column <= MIN_GRID_COLUMN) return

			low = Math.max(low, (column - 0.5) / (20 * share))
			high = Math.min(high, (column + 0.5) / (20 * share))
		})

		return total > 0 && low < high ? (low + high) / 2 : sum / 20
	}

	// A source drawing as an atom; a text box's also by its shell (its key without the text), the same atom.
	// A text box's drawings (a picture, a caption's frame) pair with the source frame's in order, as atoms too.
	private addDrawing(
		pool: AtomPool,
		key: string,
		bytes: string,
		document: XmlDocument,
		drawing: number,
		rels: Map<string, { target: string }>,
		source?: { document: XmlDocument; namespaces: Namespaces; node: number }
	): void {
		const atom = { bytes, used: false }

		pool.add(key, atom)

		const content = drawing < 0 ? -1 : descendant(document, drawing, "txbxContent")

		if (content < 0) return

		pool.add(drawingKey(document, drawing, rels, this.plan.translation, true), atom)

		if (source === undefined || source.node < 0) return

		const nested: number[] = []
		const fields: string[] = []
		const walk = (at: number): void => {
			for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) {
				if (document.localName(child) === "drawing") nested.push(child)
				else if (document.localName(child) === "fldSimple" && fieldAtom(document, child)) fields.push(fieldKey(document, child))
				else walk(child)
			}
		}
		const frames: number[] = []
		const sourceFields: { name: string; bytes: string }[] = []
		const sourceWalk = (at: number): void => {
			for (let child = source.document.firstChildElement(at); child >= 0; child = source.document.nextSiblingElement(child)) {
				const name = elementName(source.document, source.namespaces, child)

				if (name.startsWith("draw:") || name.startsWith("dr3d:")) frames.push(child)
				else if (FIELD_ATOMS.has(name)) sourceFields.push({ name, bytes: decodeUtf8(source.document.raw(child)) })
				else if (name !== "text:page-number" && name !== "text:page-count") sourceWalk(child)
			}
		}

		walk(content)

		for (let child = source.document.firstChildElement(source.node); child >= 0; child = source.document.nextSiblingElement(child)) {
			if (elementName(source.document, source.namespaces, child) === "draw:text-box") sourceWalk(child)
		}

		pairFields(fields, sourceFields, pool)

		if (nested.length !== frames.length) return

		nested.forEach((inner, k) => {
			const frame = frames[k] ?? -1

			this.addDrawing(
				pool,
				drawingKey(document, inner, rels, this.plan.translation),
				decodeUtf8(source.document.raw(frame)),
				document,
				inner,
				rels,
				{
					...source,
					node: frame
				}
			)
		})
	}

	private readonly frameStyles = new Map<string, string>()
	private readonly unitFrames = new Map<number, Replacement[]>()

	// The wrap a translated drawing shows, as ODF's style:wrap (Part 3 §20.400).
	private static wrapOf(document: XmlDocument, drawing: number): string | undefined {
		const anchor = descendant(document, drawing, "anchor")

		if (anchor < 0) return undefined

		for (let child = document.firstChildElement(anchor); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "wrapTopAndBottom") return "none"
			if (local === "wrapNone") return "run-through"
			if (local === "wrapSquare" || local === "wrapTight" || local === "wrapThrough") {
				const side = document.attribute(child, "wp:wrapText") ?? document.attribute(child, "wrapText") ?? "bothSides"

				return side === "left" ? "left" : side === "right" ? "right" : side === "largest" ? "biggest" : "parallel"
			}
		}

		return undefined
	}

	// Optimal wrapping (style:wrap="dynamic" or "biggest", Part 3 §20.400) takes the wider side of the page: where
	// the page setup changed, a frame keeps the side it shows through a style stating it.
	private fixedFrameStyle(name: string | undefined, wrap: string | undefined): string | undefined {
		if (!this.pageChanged || name === undefined || wrap === undefined) return undefined

		this.resolver ??= new OdfStyleResolver(this.plan.sheet)

		const resolved = this.resolver.resolve("graphic", name, "content")
		const mode = resolved.properties("graphic").attributes.get("style:wrap")

		if (mode !== "dynamic" && mode !== "biggest") return undefined

		const key = `${name}\u0000${wrap}`
		const known = this.frameStyles.get(key)

		if (known !== undefined) return known

		const own = resolved.chain[resolved.chain.length - 1]
		const style = own !== undefined && !own.isDefault && own.name === name ? own : undefined
		let made: string

		if (style !== undefined && style.automatic) {
			// An automatic style cannot be a parent: copied, its wrap restated.
			const prologue = this.plan.prologueDocument
			const namespaces = new Namespaces(prologue)
			let raw = ""

			for (
				let container = prologue.firstChildElement(prologue.documentElement());
				container >= 0;
				container = prologue.nextSiblingElement(container)
			) {
				if (elementName(prologue, namespaces, container) !== "office:automatic-styles") continue

				for (let child = prologue.firstChildElement(container); child >= 0; child = prologue.nextSiblingElement(child)) {
					if (
						elementName(prologue, namespaces, child) === "style:style" &&
						attributeOf(prologue, namespaces, child, "style:family") === "graphic" &&
						attributeOf(prologue, namespaces, child, "style:name") === name
					)
						raw = decodeUtf8(prologue.raw(child))
				}
			}

			if (raw === "") return undefined

			made = this.content.registry.element(`graphic\u0000${key}`, "fr", fresh => {
				const renamed = raw.replace(/(\sstyle:name=")[^"]*(")/u, `$1${esc(fresh)}$2`)
				const restated = renamed.replace(/(\sstyle:wrap=")[^"]*(")/u, `$1${wrap}$2`)

				if (restated !== renamed) return restated

				if (/<style:graphic-properties\b/u.test(renamed))
					return renamed.replace(/<style:graphic-properties\b/u, `<style:graphic-properties style:wrap="${wrap}"`)

				const properties = `<style:graphic-properties style:wrap="${wrap}"/>`

				return renamed.endsWith("/>")
					? `${renamed.slice(0, -2)}>${properties}</style:style>`
					: renamed.replace(/(<\/[^>]+>)$/u, `${properties}$1`)
			})
		} else {
			made = this.content.registry.style(
				"graphic",
				"fr",
				` style:parent-style-name="${esc(name)}"`,
				`<style:graphic-properties style:wrap="${wrap}"/>`
			)
		}

		this.frameStyles.set(key, made)

		return made
	}

	// A frame's markup with the style that keeps its wrap, when it needs one.
	private fixedFrameMarkup(bytes: string, drawing: number): string {
		const open = /^<[^>]*>/u.exec(bytes)?.[0] ?? ""
		const name = /\s[A-Za-z0-9_.-]+:style-name="([^"]*)"/u.exec(open)?.[1]
		const fixed = this.fixedFrameStyle(name === undefined ? undefined : unescape(name), OdtWrite.wrapOf(this.doc.tBody, drawing))

		if (fixed === undefined) return bytes

		return open.replace(/(\s[A-Za-z0-9_.-]+:style-name=")[^"]*(")/u, `$1${esc(fixed)}$2`) + bytes.slice(open.length)
	}

	// A unit's frames (paired with the translation's drawings, as its atoms are) whose wrap needs a style of its own.
	private framePatches(unit: Unit): Replacement[] {
		if (!this.pageChanged) return []

		const known = this.unitFrames.get(unit.index)

		if (known !== undefined) return known

		const doc = this.doc
		const drawings: number[] = []

		for (let k = unit.origin.first; k < unit.origin.first + unit.origin.count; k++) {
			const walk = (node: number): void => {
				for (let child = doc.tBody.firstChildElement(node); child >= 0; child = doc.tBody.nextSiblingElement(child)) {
					if (doc.tBody.localName(child) === "drawing") drawings.push(child)
					else walk(child)
				}
			}

			walk(doc.tBlocks[k] ?? -1)
		}

		const out: Replacement[] = []

		if (drawings.some(drawing => OdtWrite.wrapOf(doc.tBody, drawing) !== undefined)) {
			const tree = this.plan.tree(unit)
			const frames: number[] = []
			const walk = (node: number): void => {
				for (let child = tree.document.firstChildElement(node); child >= 0; child = tree.document.nextSiblingElement(child)) {
					const name = elementName(tree.document, tree.namespaces, child)

					if (name.startsWith("draw:") || name.startsWith("dr3d:")) frames.push(child)
					else walk(child)
				}
			}

			if (tree.node >= 0) walk(tree.document.documentElement())

			const inline = drawings.slice(Math.min(this.anchorsBefore(unit), drawings.length))

			if (inline.length === frames.length) {
				frames.forEach((frame, k) => {
					const drawing = inline[k] ?? -1
					const fixed = this.fixedFrameStyle(attributeNamed(tree, frame, "draw:style-name"), OdtWrite.wrapOf(doc.tBody, drawing))

					if (fixed === undefined) return

					const document = tree.document
					const start = document.start(frame) + tree.shift
					const open = decodeUtf8(document.raw(frame).subarray(0, document.openEnd(frame) - document.start(frame)))

					out.push({
						start,
						end: document.openEnd(frame) + tree.shift,
						text: open.replace(/(\s[A-Za-z0-9_.-]+:style-name=")[^"]*(")/u, `$1${esc(fixed)}$2`)
					})
				})
			}
		}

		this.unitFrames.set(unit.index, out)

		return out
	}

	// The unit's frame patches inside one of its source elements.
	private framesWithin(tree: UnitTree, node: number, block: number): Replacement[] {
		if (!this.pageChanged) return []

		const index = this.doc.tBlocks.indexOf(block)
		const unit = this.plan.units.find(item => item.origin.first <= index && index < item.origin.first + item.origin.count)

		if (unit === undefined) return []

		const start = tree.document.start(node) + tree.shift
		const end = tree.document.end(node) + tree.shift

		return this.framePatches(unit).filter(patch => patch.start >= start && patch.end <= end)
	}

	// A kept unit's tables that follow the page, where the page setup changed.
	private fixedTables(unit: Unit): Replacement[] {
		const reduced = this.tableSpacing?.reduced

		if (!this.pageChanged && (reduced === undefined || reduced.size === 0)) return []

		const tables: number[] = []

		for (let k = 0; k < unit.origin.count; k++) {
			const block = this.doc.tBlocks[unit.origin.first + k] ?? -1

			if (this.doc.tBody.localName(block) === "tbl") tables.push(block)
		}

		if (tables.length === 0 || (!this.pageChanged && !tables.some(table => reduced?.has(table) === true))) return []

		// The unit's tables in their order (a section's translation may add blocks of its own).
		const tree = this.plan.tree(unit)
		const document = tree.document
		const nodes: number[] = []
		const flow = (at: number): void => {
			for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) {
				const name = elementName(document, tree.namespaces, child)

				if (name === "table:table") nodes.push(child)
				else if (name === "text:section" || name === "text:list" || name === "text:list-item" || name === "text:list-header")
					flow(child)
			}
		}

		flow(document.documentElement())

		if (nodes.length !== tables.length)
			throw new OdtWriteRefusal("sections", "page setup of tables the writer cannot pair with their source")

		const out: Replacement[] = []

		tables.forEach((table, k) => {
			const fixed = this.fixedTable(tree, nodes[k] ?? -1, table)

			if (fixed !== undefined) out.push(fixed)
		})

		return out
	}

	// A source table whose width follows the page (table:align="margins" or style:rel-width, Part 3 §20.414,
	// §20.340) where the page setup changed: its start tag names a style of the widths it shows, which the edit keeps
	// as a WordprocessingML grid does.
	// `master`: the master page the table starts (a section break before it, Part 3 style:master-page-name).
	private fixedTable(
		tree: UnitTree,
		node: number,
		table: number,
		master?: string,
		story: { readonly tDoc: XmlDocument; readonly scope: StyleScope; readonly stream: Stream } = {
			tDoc: this.doc.tBody,
			scope: "content",
			stream: this.content
		}
	): Replacement | undefined {
		const tDoc = story.tDoc

		// Space above or below the edit leaves less of than the table has (tableSpacing.ts).
		const spacing = tDoc === this.doc.tBody ? this.tableSpacing?.reduced.get(table) : undefined

		if (tDoc.localName(table) !== "tbl" || (!this.pageChanged && master === undefined && spacing === undefined)) return undefined

		const name = attributeNamed(tree, node, "table:style-name")

		this.resolver ??= new OdfStyleResolver(this.plan.sheet)

		const resolved = this.resolver.resolve("table", name, story.scope)
		const properties = resolved.properties("table")
		const align = properties.attributes.get("table:align") ?? "margins"
		const follows = this.pageChanged && (align === "margins" || properties.attributes.has("style:rel-width"))

		if (!follows && master === undefined && spacing === undefined) return undefined
		if (properties.children.length > 0) throw new OdtWriteRefusal("sections", "restyling a table with a background image")

		const own = resolved.chain[resolved.chain.length - 1]
		const style = own !== undefined && !own.isDefault && own.name === name ? own : undefined
		let attributes = ""

		for (const [key, value] of style?.attributes ?? []) {
			if (key === "style:master-page-name" && master !== undefined) continue
			if (key !== "style:name" && key !== "style:family" && key !== "style:parent-style-name" && key !== "style:display-name")
				attributes += ` ${key}="${esc(value)}"`
		}

		const parent = style === undefined ? undefined : style.automatic ? style.parent : style.name

		if (parent !== undefined) attributes += ` style:parent-style-name="${esc(parent)}"`
		if (master !== undefined) attributes += ` style:master-page-name="${esc(master)}"`

		let props = ""

		for (const [key, value] of properties.attributes) {
			if (spacing !== undefined && (key === "fo:margin-top" || key === "fo:margin-bottom"))
				props += ` ${key}="${(key === "fo:margin-top" ? spacing.top : spacing.bottom) / 20}pt"`
			else if (!follows || (key !== "style:rel-width" && key !== "style:width" && key !== "table:align"))
				props += ` ${key}="${esc(value)}"`
		}

		if (follows) {
			props += ` style:width="${Math.round(this.tableWidth(tree, node, table, tDoc, story.scope) * 1_000_000) / 1_000_000}pt" table:align="${align === "margins" ? "left" : align}"`
		}

		const fixed = story.stream.registry.style("table", "Table", attributes, `<style:table-properties${props}/>`)
		const document = tree.document
		const open = decodeUtf8(document.raw(node).subarray(0, document.openEnd(node) - document.start(node)))
		const attribute = [...document.attributes(node)].find(
			item => canonicalAttribute(tree.namespaces, node, item.name) === "table:style-name"
		)
		const tag =
			attribute === undefined
				? open.replace(/^(<[^\s/>]+)/u, `$1 table:style-name="${esc(fixed)}"`)
				: open.replace(
						new RegExp(`(\\s${attribute.name.replace(/[.]/gu, "\\.")}\\s*=\\s*)(["'])[^"']*\\2`, "u"),
						`$1"${esc(fixed)}"`
					)

		return { start: document.start(node) + tree.shift, end: document.openEnd(node) + tree.shift, text: tag }
	}

	// A table whose grid and properties stayed: rows kept, removed, rewritten in their cells or written anew.
	private replaceTable(
		tDoc: XmlDocument,
		t: number,
		eDoc: XmlDocument,
		e: number,
		tree: UnitTree,
		node: number
	): Replacement[] | undefined {
		const tblPr = (document: XmlDocument, table: number): string => {
			let out = ""

			for (let child = document.firstChildElement(table); child >= 0; child = document.nextSiblingElement(child)) {
				const local = document.localName(child)

				if (local === "tblPr" || local === "tblGrid") out += decodeUtf8(document.raw(child))
			}

			return out
		}

		if (tblPr(tDoc, t) !== tblPr(eDoc, e)) return undefined

		const sourceRows: { node: number; repeat: number }[] = []
		const collect = (container: number): void => {
			const document = tree.document

			for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
				const name = elementName(document, tree.namespaces, child)

				if (name === "table:table-row") {
					const repeated = [...document.attributes(child)].find(
						attribute => canonicalAttribute(tree.namespaces, child, attribute.name) === "table:number-rows-repeated"
					)

					sourceRows.push({ node: child, repeat: Math.max(1, Number(repeated?.value ?? "1") || 1) })
				} else if (name === "table:table-header-rows" || name === "table:table-rows" || name === "table:table-row-group")
					collect(child)
			}
		}

		collect(node)

		const tRows = rowsOf(tDoc, t)
		const eRows = rowsOf(eDoc, e)

		if (sourceRows.reduce((sum, row) => sum + row.repeat, 0) !== tRows.length) return undefined

		const rowOf: { source: number; copy: number }[] = []

		sourceRows.forEach((row, index) => {
			for (let copy = 0; copy < row.repeat; copy++) rowOf.push({ source: index, copy })
		})

		// Styles of the source's rows and cells, by the properties the translator gave them.
		const rowStyles = new Map<string, string | undefined>()
		const cellStyles = new Map<string, string | undefined>()

		tRows.forEach((tr, index) => {
			const source = sourceRows[rowOf[index]?.source ?? -1]

			if (source === undefined) return

			const trPr = childNamed(tDoc, tr, "trPr")

			rowStyles.set(trPr < 0 ? "" : canonicalElement(tDoc, trPr), attributeNamed(tree, source.node, "table:style-name"))

			const cells = sourceCells(tree, source.node)
			let k = 0

			for (let tc = tDoc.firstChildElement(tr); tc >= 0; tc = tDoc.nextSiblingElement(tc)) {
				if (tDoc.localName(tc) !== "tc") continue

				const tcPr = childNamed(tDoc, tc, "tcPr")
				const props: Props = new Map()

				if (tcPr >= 0) readProps(tDoc, tcPr, props)

				const merge = props.get("vMerge")

				props.delete("gridSpan")
				props.delete("vMerge")
				props.delete("tcW")

				if (merge !== undefined && merge.attributes.get("val") !== "restart") continue

				const cell = cells[k++]

				if (cell !== undefined && !cell.covered) cellStyles.set(propsKey(props), cell.style)
			}
		})

		const rowKeys = (document: XmlDocument, rows: readonly number[]): string[] =>
			rows.map(row => `${fnv(document.raw(row))}:${document.raw(row).length}`)
		const match = matchBlocks(rowKeys(tDoc, tRows), rowKeys(eDoc, eRows))
		const out: Replacement[] = []
		const columnsOf = (row: number): Map<number, number> => {
			const columns = new Map<number, number>()
			let column = 0

			for (let tc = eDoc.firstChildElement(row); tc >= 0; tc = eDoc.nextSiblingElement(tc)) {
				if (eDoc.localName(tc) !== "tc") continue

				columns.set(column, tc)

				const tcPr = childNamed(eDoc, tc, "tcPr")
				const span = tcPr < 0 ? 1 : Number(eDoc.attribute(childNamed(eDoc, tcPr, "gridSpan"), "w:val") ?? "1") || 1

				column += span
			}

			return columns
		}
		const below =
			(index: number) =>
			(column: number): number => {
				let rows = 1

				for (let next = index + 1; next < eRows.length; next++) {
					const tc = columnsOf(eRows[next] ?? -1).get(column)
					const tcPr = tc === undefined ? -1 : childNamed(eDoc, tc, "tcPr")
					const merge = tcPr < 0 ? -1 : childNamed(eDoc, tcPr, "vMerge")

					if (merge < 0 || (eDoc.attribute(merge, "w:val") ?? "continue") === "restart") break

					rows++
				}

				return rows
			}
		const styles = (index: number) => ({
			row: (trPr: string) => (rowStyles.has(trPr) ? (rowStyles.get(trPr) ?? "") : undefined),
			cell: (tcPr: string) => (cellStyles.has(tcPr) ? (cellStyles.get(tcPr) ?? "") : undefined),
			columns: 0,
			index
		})
		const rowMarkup = (index: number): string => {
			const markup = this.emitter.row(eDoc, eRows[index] ?? -1, styles(index), below(index))

			// A style lookup that found the default (no style name) wrote an empty one.
			return markup.replace(/ table:style-name=""/gu, "")
		}
		// Edited rows not matched, in place of the source rows not matched between the same kept rows.
		let eNext = 0
		const sourceSpan = (index: number): { start: number; end: number } => {
			const row = sourceRows[index]

			return { start: tree.document.start(row?.node ?? -1) + tree.shift, end: tree.document.end(row?.node ?? -1) + tree.shift }
		}
		let tIndex = 0

		while (tIndex <= tRows.length) {
			// The next kept row (or the end).
			let next = tIndex

			while (next < tRows.length && (match[next] ?? -1) < 0) next++

			const eUntil = next < tRows.length ? (match[next] ?? eRows.length) : eRows.length
			const removed = Array.from({ length: next - tIndex }, (_, k) => tIndex + k)
			const added = Array.from({ length: eUntil - eNext }, (_, k) => eNext + k)

			// Pairs of a removed and an added row with the same cells: the row rewritten in its cells.
			const paired = Math.min(removed.length, added.length)
			const sources = new Set<number>()

			for (const index of removed) sources.add(rowOf[index]?.source ?? -1)

			const whole = [...sources].every(source =>
				rowOf.filter(item => item.source === source).every(item => removed.includes(rowOf.indexOf(item)))
			)

			if (!whole) return undefined

			if (removed.length === added.length && removed.every(index => (sourceRows[rowOf[index]?.source ?? -1]?.repeat ?? 1) === 1)) {
				for (let k = 0; k < paired; k++) {
					const replaced = this.replaceRow(
						tDoc,
						tRows[removed[k] ?? -1] ?? -1,
						eDoc,
						eRows[added[k] ?? -1] ?? -1,
						tree,
						sourceRows[rowOf[removed[k] ?? -1]?.source ?? -1]?.node ?? -1
					)

					if (replaced === undefined) {
						const span = sourceSpan(rowOf[removed[k] ?? -1]?.source ?? -1)

						out.push({ ...span, text: rowMarkup(added[k] ?? -1) })
						this.written++
					} else appendAll(out, replaced)
				}
			} else {
				const spans = [...sources].map(sourceSpan).sort((a, b) => a.start - b.start)
				const markup = added.map(rowMarkup).join("")

				this.written += added.length

				if (spans.length > 0) {
					spans.forEach((span, k) => out.push({ ...span, text: k === 0 ? markup : "" }))
				} else if (added.length > 0) {
					// Inserted between kept rows: after the previous one, or before the first.
					const previous = tIndex > 0 ? sourceSpan(rowOf[tIndex - 1]?.source ?? -1).end : sourceSpan(rowOf[0]?.source ?? -1).start

					out.push({ start: previous, end: previous, text: markup })
				}
			}

			eNext = eUntil + 1
			tIndex = next + 1
		}

		// A kept row whose cells start a vertical merge that rows inserted or removed below made longer or shorter: the
		// cells' table:number-rows-spanned (Part 3 §19.682) as the merge now is.
		tRows.forEach((_tr, index) => {
			const edited = match[index] ?? -1
			const source = sourceRows[rowOf[index]?.source ?? -1]

			if (edited < 0 || source === undefined || source.repeat !== 1) return

			const cells = sourceCells(tree, source.node)
			let column = 0
			let k = 0

			for (let tc = eDoc.firstChildElement(eRows[edited] ?? -1); tc >= 0; tc = eDoc.nextSiblingElement(tc)) {
				if (eDoc.localName(tc) !== "tc") continue

				const tcPr = childNamed(eDoc, tc, "tcPr")
				const merge = tcPr < 0 ? -1 : childNamed(eDoc, tcPr, "vMerge")
				const restart = merge >= 0 && eDoc.attribute(merge, "w:val") === "restart"
				const at = column

				column += tcPr < 0 ? 1 : Number(eDoc.attribute(childNamed(eDoc, tcPr, "gridSpan"), "w:val") ?? "1") || 1

				if (merge >= 0 && !restart) continue

				const cell = cells[k++]

				if (cell === undefined || cell.covered) continue

				const want = restart ? below(edited)(at) : 1
				const has = Number(attributeNamed(tree, cell.node, "table:number-rows-spanned") ?? "1") || 1

				if (want !== has) out.push(this.spannedRows(tree, cell.node, want))
			}
		})

		const fixed = this.fixedTable(tree, node, t, this.doc.masters.get(e))

		if (fixed !== undefined) out.push(fixed)

		return out
	}

	// A source paragraph's start tag naming a style that is its own with master page `master` ("" for none, Part 3
	// §19.501); undefined where its style is not one the writer restates.
	private restyledStart(tree: UnitTree, node: number, master: string): Replacement | undefined {
		const document = tree.document
		const name = attributeNamed(tree, node, "text:style-name")
		const style = name === undefined ? undefined : this.plan.sheet.style("paragraph", name, "content")
		let attributes: string
		let properties: string

		if (style === undefined) {
			const parent = this.plan.mapper.defaultParagraphStyle

			attributes = parent === undefined ? "" : ` style:parent-style-name="${esc(parent)}"`
			properties = ""
		} else if (style.automatic) {
			const form = writtenForm(style)

			if (form === undefined) return undefined

			attributes = form.attributes.replace(/\sstyle:master-page-name="[^"]*"/u, "")
			properties = form.properties
		} else {
			attributes = ` style:parent-style-name="${esc(style.name)}"`
			properties = ""
		}

		if (master !== "") attributes = sortedAttributesOf(`${attributes} style:master-page-name="${esc(master)}"`)

		const fixed = this.content.registry.style("paragraph", "P", attributes, properties)
		const open = decodeUtf8(document.raw(node).subarray(0, document.openEnd(node) - document.start(node)))
		const attribute = [...document.attributes(node)].find(
			item => canonicalAttribute(tree.namespaces, node, item.name) === "text:style-name"
		)
		const tag =
			attribute === undefined
				? open.replace(/^(<[^\s/>]+)/u, `$1 text:style-name="${esc(fixed)}"`)
				: open.replace(
						new RegExp(`(\\s${attribute.name.replace(/[.]/gu, "\\.")}\\s*=\\s*)(["'])[^"']*\\2`, "u"),
						`$1"${esc(fixed)}"`
					)
		const start = document.start(node) + tree.shift

		return { start, end: start + encodeUtf8(open).length, text: tag }
	}

	// A source cell's start tag with the rows it spans set to `rows`.
	private spannedRows(tree: UnitTree, cell: number, rows: number): Replacement {
		const document = tree.document
		const open = decodeUtf8(document.raw(cell).subarray(0, document.openEnd(cell) - document.start(cell)))
		const attribute = [...document.attributes(cell)].find(
			item => canonicalAttribute(tree.namespaces, cell, item.name) === "table:number-rows-spanned"
		)
		const prefix = document.prefix(cell)
		const name = attribute?.name ?? `${prefix === "" ? "" : `${prefix}:`}number-rows-spanned`
		const without = attribute === undefined ? open : open.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "u"), "")
		const close = without.endsWith("/>") ? without.length - 2 : without.length - 1
		const text = rows === 1 ? without : `${without.slice(0, close)} ${name}="${rows}"${without.slice(close)}`
		const start = document.start(cell) + tree.shift

		return { start, end: start + encodeUtf8(open).length, text }
	}

	// A row whose cells pair with the source row's: changed cells' paragraphs rewritten in place.
	private replaceRow(
		tDoc: XmlDocument,
		tr: number,
		eDoc: XmlDocument,
		er: number,
		tree: UnitTree,
		sourceRow: number
	): Replacement[] | undefined {
		const trPr = (document: XmlDocument, row: number): string => {
			const node = childNamed(document, row, "trPr")

			return node < 0 ? "" : decodeUtf8(document.raw(node))
		}

		if (trPr(tDoc, tr) !== trPr(eDoc, er)) return undefined

		const tCells = cellsOf(tDoc, tr)
		const eCells = cellsOf(eDoc, er)
		const cells = sourceCells(tree, sourceRow)

		if (tCells.length !== eCells.length) return undefined

		const out: Replacement[] = []
		let sourceIndex = 0

		for (let k = 0; k < tCells.length; k++) {
			const tc = tCells[k] ?? -1
			const ec = eCells[k] ?? -1
			const tcPr = (document: XmlDocument, cell: number): string => {
				const node = childNamed(document, cell, "tcPr")

				return node < 0 ? "" : decodeUtf8(document.raw(node))
			}

			if (tcPr(tDoc, tc) !== tcPr(eDoc, ec)) return undefined

			const merged = tcPr(tDoc, tc).includes("vMerge") && !tcPr(tDoc, tc).includes('"restart"')

			if (merged) continue

			const cell = cells[sourceIndex++]

			if (cell === undefined || cell.covered) return undefined
			if (equalBytes(tDoc.raw(tc), eDoc.raw(ec)) && !this.mode.prove) continue

			const tBlocks = blocksIn(tDoc, tc)
			const eBlocks = blocksIn(eDoc, ec)
			const emitters = cellEmitters(tree, cell.node)

			if (emitters !== undefined && emitters.length === tBlocks.length && tBlocks.length === eBlocks.length) {
				for (let b = 0; b < tBlocks.length; b++) {
					const t = tBlocks[b] ?? -1
					const e = eBlocks[b] ?? -1

					if (!this.mode.prove && equalBytes(tDoc.raw(t), eDoc.raw(e))) continue

					const replaced = this.replaceBlock(tDoc, t, eDoc, e, tree, emitters[b] ?? -1)

					if (replaced === undefined) return undefined

					appendAll(out, replaced)
				}
			} else {
				if (cellEmitters(tree, cell.node) === undefined) return undefined

				// The cell's content written anew inside its element.
				const start = tree.document.contentStart(cell.node) + tree.shift
				const end = tree.document.contentEnd(cell.node) + tree.shift

				if (tree.document.isSelfClosing(cell.node)) return undefined

				out.push({ start, end, text: this.emitter.blocks(eDoc, eBlocks) })
				this.written += eBlocks.length
			}
		}

		return out
	}

	// Gate 1 of one unit: its blocks rewritten from their translation, in place.
	private async proveUnit(unit: Unit, job: RtfJob | undefined): Promise<void> {
		const tree = this.plan.tree(unit)
		const lossy = this.plan.lossy(unit)

		if (lossy !== undefined) throw new OdtWriteRefusal("lossy", lossy)
		if (tree.structuralOpaque !== undefined) throw new OdtWriteRefusal("opaque", tree.structuralOpaque)
		if (tree.emitters === undefined) throw new OdtWriteRefusal("structure", "blocks the writer cannot pair with their elements")

		this.atomsOf([unit])

		const doc = this.doc
		const from = this.keptFrom(unit) ?? -1
		const replacements: Replacement[] = []

		// A block at a time, the thread given back between (a unit can be a whole section).
		for (let k = 0; k < unit.origin.count; k++) {
			if (job?.due() === true) await turn(job)

			const block = doc.tBlocks[unit.origin.first + k] ?? -1
			const node = tree.emitters[k] ?? -1
			const opaque = tree.blockOpaque?.[k]

			if (opaque !== undefined) {
				this.failedBlocks.set(unit.origin.first + k, opaque)

				const fixed = this.fixedTable(tree, node, block)

				if (fixed !== undefined) replacements.push(fixed)

				appendAll(replacements, this.framesWithin(tree, node, block))

				continue
			}

			const replaced = this.replaceBlock(doc.tBody, block, doc.eBody, doc.eBlocks[from + k] ?? -1, tree, node)

			if (replaced === undefined) throw new OdtWriteRefusal("structure", "blocks the writer cannot rewrite in place")

			appendAll(replacements, replaced)
		}

		this.segment(
			{ start: unit.origin.start, end: unit.origin.end, kind: "written", units: [unit], from, to: from + unit.origin.count },
			replacements
		)
	}

	private keptFrom(unit: Unit): number | undefined {
		// Gate 1 runs on the untouched translation: blocks are the translation's.
		return unit.origin.first
	}
}

function attributeNamed(tree: UnitTree, node: number, canonical: string): string | undefined {
	for (const attribute of tree.document.attributes(node)) {
		if (canonicalAttribute(tree.namespaces, node, attribute.name) === canonical) return attribute.value
	}

	return undefined
}

function sourceCells(tree: UnitTree, row: number): { node: number; style: string | undefined; covered: boolean }[] {
	const out: { node: number; style: string | undefined; covered: boolean }[] = []
	const document = tree.document

	for (let cell = document.firstChildElement(row); cell >= 0; cell = document.nextSiblingElement(cell)) {
		const name = elementName(document, tree.namespaces, cell)

		if (name !== "table:table-cell" && name !== "table:covered-table-cell") continue

		const repeat = Math.max(1, Number(attributeNamed(tree, cell, "table:number-columns-repeated") ?? "1") || 1)

		for (let k = 0; k < repeat; k++) {
			if (name === "table:covered-table-cell") continue

			out.push({ node: repeat > 1 ? -1 : cell, style: attributeNamed(tree, cell, "table:style-name"), covered: repeat > 1 })
		}
	}

	return out
}

// A cell's paragraphs (and nested tables) as the translator writes them: one block each, nothing else.
function cellEmitters(tree: UnitTree, cell: number): number[] | undefined {
	const out: number[] = []

	if (cell < 0) return undefined

	for (let child = tree.document.firstChildElement(cell); child >= 0; child = tree.document.nextSiblingElement(child)) {
		const name = elementName(tree.document, tree.namespaces, child)

		if (name === "text:p" || name === "text:h" || name === "table:table") out.push(child)
		else if (name !== "text:soft-page-break") return undefined
	}

	return out
}

function rowsOf(document: XmlDocument, table: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(table); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === "tr") out.push(child)
	}

	return out
}

function cellsOf(document: XmlDocument, row: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(row); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === "tc") out.push(child)
	}

	return out
}

function blocksIn(document: XmlDocument, cell: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(cell); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "p" || local === "tbl") out.push(child)
	}

	return out
}

// The office:version a stream's root states; absent, 1.1 (ODF 1.0 and 1.1 make it optional, §2.1.2; 1.2 on requires it).
function odfVersion(rootOpen: string): number {
	const version = Number(/\s[A-Za-z0-9_.-]*:?version="([0-9.]+)"/u.exec(rootOpen)?.[1] ?? "1.1")

	return Number.isFinite(version) ? version : 1.1
}

// The w:num a paragraph's own numbering names.
function numIdOf(document: XmlDocument, paragraph: number): string | undefined {
	const pPr = childNamed(document, paragraph, "pPr")
	const numPr = pPr < 0 ? -1 : childNamed(document, pPr, "numPr")

	return numPr < 0 ? undefined : document.attribute(childNamed(document, numPr, "numId"), "w:val")
}

function numberingOf(document: XmlDocument, paragraph: number): string {
	const pPr = childNamed(document, paragraph, "pPr")
	const numPr = pPr < 0 ? -1 : childNamed(document, pPr, "numPr")

	return numPr < 0 ? "" : canonicalElement(document, numPr)
}

// A source paragraph as a written one may take after: its start tag, and its translation's properties (less what the
// tables beside it add, `shift`).
function paragraphSource(
	tree: UnitTree,
	node: number,
	tDoc: XmlDocument,
	paragraph: number,
	shift?: SpacingShift
): ParagraphSource | undefined {
	const name = elementName(tree.document, tree.namespaces, node)

	if (name !== "text:p" && name !== "text:h") return undefined

	const pPr = childNamed(tDoc, paragraph, "pPr")
	let direct: Props = new Map()
	const mark: Props = new Map()

	if (pPr >= 0) {
		readProps(tDoc, pPr, direct, PARAGRAPH_SKIPPED)

		const markNode = childNamed(tDoc, pPr, "rPr")

		if (markNode >= 0) readProps(tDoc, markNode, mark)
	}

	// The translation writes both sides beside a table (Translator.addSpacing): nothing is inherited.
	if (shift !== undefined) direct = withoutTableSpacing(direct, shift, undefined)

	return {
		element: name,
		attributes: tree.document.attributes(node).map(attribute => [attribute.name, attribute.value] as const),
		styleName: attributeNamed(tree, node, "text:style-name"),
		pPr: propsKey(withoutNumbering(direct)),
		mark: propsKey(mark),
		listed: direct.has("numPr") || inList(tree, node)
	}
}

function attributeOf(document: XmlDocument, namespaces: Namespaces, node: number, canonical: string): string | undefined {
	for (const attribute of document.attributes(node)) {
		if (canonicalAttribute(namespaces, node, attribute.name) === canonical) return attribute.value
	}

	return undefined
}

// The element starting at a byte offset of a document parsed whole; -1 when none does.
function elementAt(document: XmlDocument, offset: number): number {
	const stack = [document.documentElement()]

	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		if (document.start(node) === offset) return node

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.start(child) <= offset && document.end(child) > offset) stack.push(child)
		}
	}

	return -1
}

function elementsOf(document: XmlDocument, container: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) out.push(child)

	return out
}

// The font faces a stream declares, by family.
function declaredFaces(bytes: Uint8Array): Map<string, string> {
	const out = new Map<string, string>()
	const text = decodeUtf8(bytes)

	for (const match of text.matchAll(/<[A-Za-z0-9_.-]*:?font-face\s([^>]*)>/gu)) {
		const name = /(?:^|\s)[A-Za-z0-9_.-]*:?name="([^"]*)"/u.exec(match[1] ?? "")?.[1]
		const family = /font-family="([^"]*)"/u.exec(match[1] ?? "")?.[1]

		if (name !== undefined && family !== undefined) {
			const unquoted = unescape(family).replace(/^['"]|['"]$/gu, "")

			if (!out.has(unquoted)) out.set(unquoted, unescape(name))
		}
	}

	return out
}

const PICTURE_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp",
	svg: "image/svg+xml",
	tif: "image/tiff",
	tiff: "image/tiff",
	emf: "image/x-emf",
	wmf: "image/x-wmf"
}

// The names of content.xml's reference marks and bookmarks (a range may start in one paragraph and end in another
// written apart from it).
function markNames(content: Uint8Array): { referenceMarks: Set<string>; sourceBookmarks: Set<string> } {
	const referenceMarks = new Set<string>()
	const sourceBookmarks = new Set<string>()

	// Each tag found by its name in the bytes and read alone (the stream is never decoded whole).
	for (const [needle, into] of [
		[encodeUtf8("reference-mark"), referenceMarks],
		[encodeUtf8("bookmark"), sourceBookmarks]
	] as const) {
		for (let at = indexOf(content, needle, 0); at >= 0; at = indexOf(content, needle, at + needle.length)) {
			const open = content.lastIndexOf(0x3c, at)
			const close = content.indexOf(0x3e, at)

			if (open < 0 || close < 0) continue

			const tag = decodeUtf8(content.subarray(open, close + 1))
			const match = /^<[A-Za-z0-9_.-]*:?(reference-mark|bookmark)(?:-start|-end)?\s[^>]*?name="([^"]*)"/u.exec(tag)

			if (match !== null) into.add(unescape(match[2] ?? ""))
		}
	}

	return { referenceMarks, sourceBookmarks }
}

function indexOf(bytes: Uint8Array, needle: Uint8Array, from: number): number {
	for (let at = bytes.indexOf(needle[0] ?? 0, from); at >= 0; at = bytes.indexOf(needle[0] ?? 0, at + 1)) {
		let k = 1

		while (k < needle.length && bytes[at + k] === needle[k]) k++

		if (k === needle.length) return at
	}

	return -1
}

function unescape(value: string): string {
	return value.replace(
		/&(lt|gt|amp|quot|apos);/gu,
		(_entity, name: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[name] ?? ""
	)
}

// The field code the translator writes for a field element (its instruction's first word, and for DOCPROPERTY the
// element it names).
function fieldCode(name: string, bytes: string): string {
	if (name === "text:note-ref" || name === "text:reference-ref" || name === "text:bookmark-ref" || name === "text:sequence-ref")
		return referenceCode(name, startTagAttribute(bytes, "reference-format"))
	if (name === "text:date" || name === "text:time") {
		const code = dateCode(name, startTagAttribute(bytes, "fixed"), startTagAttribute(bytes, `${name.slice(5)}-adjust`) !== undefined)

		if (code !== undefined) return code
	}
	if (name === "text:bibliography-mark") return "CITATION"
	if (name === "text:sequence") return "SEQ"
	if (FIELDS_AS_TEXT.has(name)) return "DOCVARIABLE"

	return `DOCPROPERTY ${name.replace(":", "_")}`
}

// The translation's fields paired with the source's in order, by code: a source field the translator wrote no field
// for (one shown as nothing) is passed over.
function pairFields(keys: readonly string[], sources: readonly { name: string; bytes: string }[], pool: AtomPool): void {
	let at = 0

	for (const key of keys) {
		const instruction = key.slice("field:".length).split("|")[0] ?? ""
		const words = instruction.split(" ")
		const code = words[0] === "DOCPROPERTY" ? `DOCPROPERTY ${words[1] ?? ""}` : (words[0] ?? "")

		while (at < sources.length && fieldCode(sources[at]?.name ?? "", sources[at]?.bytes ?? "") !== code) at++

		const source = sources[at++]

		if (source === undefined) return

		const atom = { bytes: source.bytes, used: false }

		pool.add(key, atom)

		// A date or time shown as the current one is the same field whatever result an update gave it.
		if (code === "DATE" || code === "TIME") pool.add(`live:${instruction}`, atom)
	}
}

// An attribute of a source element's start tag by its local name, entities left as written (the values read are
// enumerations), undefined when absent.
function startTagAttribute(bytes: string, local: string): string | undefined {
	const end = bytes.indexOf(">")
	const tag = end < 0 ? bytes : bytes.slice(0, end)

	return new RegExp(`\\s(?:[A-Za-z0-9_.-]+:)?${local}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "u").exec(tag)?.slice(1).find(Boolean)
}

// A field the translator wrote that holds a source element (cross-references, citations, variables, metadata, dates).
export function fieldAtom(document: XmlDocument, field: number): boolean {
	return /^\s*(REF|PAGEREF|NOTEREF|CITATION|SEQ|DOCVARIABLE|DOCPROPERTY|DATE|TIME)\s/u.test(document.attribute(field, "w:instr") ?? "")
}

export function fieldKey(document: XmlDocument, field: number): string {
	return `field:${(document.attribute(field, "w:instr") ?? "").trim().replace(/\s+/gu, " ")}|${document.textContent(field)}`
}

// Whether a source element sits in a list item (its translation's indents may be the list's).
function inList(tree: UnitTree, node: number): boolean {
	for (let at = tree.document.parent(node); at > 0; at = tree.document.parent(at)) {
		const name = elementName(tree.document, tree.namespaces, at)

		if (name === "text:list-item" || name === "text:list-header") return true
	}

	return false
}

// A drawing's key: its markup without the ids that only number drawings, pictures by the package entry they show.
// `shell`: without a text box's content (txbxContent), for a text box the edit wrote into.
function drawingKey(
	document: XmlDocument,
	drawing: number,
	rels: Map<string, { target: string }>,
	translation: OdtTranslation,
	shell = false
): string {
	const walk = (at: number): string => {
		const local = document.localName(at)

		if (shell && local === "txbxContent") return "<txbxContent>"
		const out: string[] = []

		for (const attribute of document.attributes(at)) {
			const name = attribute.name

			if (name.startsWith("xmlns")) continue
			if ((local === "docPr" || local === "cNvPr") && (name === "id" || name === "name")) continue

			if (name === "r:embed" || name === "r:link" || name === "r:id") {
				const target = rels.get(attribute.value)?.target ?? attribute.value
				const part = target.startsWith("/") ? target.slice(1) : `word/${target}`

				out.push(`${name}=${translation.media.get(part) ?? part}`)
			} else out.push(`${name}=${attribute.value}`)
		}

		let children = ""

		for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) children += walk(child)

		return `<${local} ${out.sort().join(" ")}>${children}${document.firstChildElement(at) < 0 ? document.textContent(at) : ""}`
	}

	return walk(drawing)
}

function takenNames(plan: OdtPlan): Set<string> {
	const taken = new Set<string>()
	const scan = (bytes: Uint8Array, until: number): void => {
		const text = decodeUtf8(bytes.subarray(0, until < 0 ? bytes.length : until))

		for (const match of text.matchAll(/:name="([^"]*)"/gu)) taken.add(match[1] ?? "")
	}

	scan(plan.contentBytes, plan.prologueDocument.end(plan.prologueDocument.documentElement()))
	scan(plan.stylesBytes, -1)

	return taken
}

// Attribute markup ( name="value"...) sorted by name, as StyleRegistry keys take it.
function sortedAttributesOf(markup: string): string {
	return [...markup.matchAll(/\s([^\s=]+)="([^"]*)"/gu)]
		.sort((a, b) => ((a[1] ?? "") < (b[1] ?? "") ? -1 : (a[1] ?? "") > (b[1] ?? "") ? 1 : 0))
		.map(match => ` ${match[1] ?? ""}="${match[2] ?? ""}"`)
		.join("")
}

function sorted(attributes: ReadonlyMap<string, string>): string {
	return [...attributes]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, value]) => ` ${name}="${esc(value)}"`)
		.join("")
}

function samePropertyValue(a: PropertyValue, b: PropertyValue): boolean {
	return a.children === b.children && JSON.stringify([...a.attributes].sort()) === JSON.stringify([...b.attributes].sort())
}

function paragraphAttributesOrRefuse(local: string, value: PropertyValue, tabsRelativeToIndent: boolean): ParagraphAttributes {
	const marginLeft = Number(value.attributes.get("left") ?? "0") / 20
	const written = paragraphAttributes(local, value, { tabsRelativeToIndent, marginLeft })

	if (written === undefined) throw new OdtWriteRefusal("styles", `the paragraph property ${local} of a new style`)

	return written
}

function runAttributesOrRefuse(local: string, value: PropertyValue, fonts: { face(family: string): string }): [string, string][] {
	// A style's sizes are absolute: the size raised text is a share of does not matter here.
	const written = runAttributes(local, value, fonts, 12)

	if (written === undefined) throw new OdtWriteRefusal("styles", `the run property ${local} of a new style`)

	return written
}

// A list style for a w:num the edit added: the translation's own where it restarts one of its lists, else written
// from its definition's levels (Part 3 §16.32).
function newListStyle(
	numbering: XmlDocument,
	numId: string,
	translation: OdtTranslation,
	registry: StyleRegistry,
	fonts: { face(family: string): string },
	declarations: string
): ListTarget | undefined {
	const root = numbering.documentElement()
	let abstractId: string | undefined

	for (let child = numbering.firstChildElement(root); child >= 0; child = numbering.nextSiblingElement(child)) {
		if (numbering.localName(child) === "num" && numbering.attribute(child, "w:numId") === numId) {
			abstractId = numbering.attribute(childNamed(numbering, child, "abstractNumId"), "w:val")
		}
	}

	if (abstractId === undefined) return undefined

	// An abstract definition the translation made: its list style (a new instance of it).
	const translated = translation.parts.get("word/numbering.xml")

	if (translated instanceof Uint8Array) {
		const document = parseXml(translated)
		const translatedRoot = document.documentElement()

		for (let child = document.firstChildElement(translatedRoot); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) !== "num") continue
			if (document.attribute(childNamed(document, child, "abstractNumId"), "w:val") !== abstractId) continue

			const known = translation.numbering.get(Number(document.attribute(child, "w:numId") ?? ""))

			if (known !== undefined && known.style !== "\u0000outline") return { style: known.style, outline: false }
		}
	}

	let abstract = -1

	for (let child = numbering.firstChildElement(root); child >= 0; child = numbering.nextSiblingElement(child)) {
		if (numbering.localName(child) === "abstractNum" && numbering.attribute(child, "w:abstractNumId") === abstractId) abstract = child
	}

	if (abstract < 0) return undefined

	let levels = ""

	for (let level = numbering.firstChildElement(abstract); level >= 0; level = numbering.nextSiblingElement(level)) {
		if (numbering.localName(level) !== "lvl") continue

		const markup = levelStyle(numbering, level, fonts, "text:list-level-style")

		if (markup === undefined) return undefined

		levels += markup
	}

	const style = registry.element(
		`list\u0000${levels}`,
		"L",
		name => `<text:list-style${declarations} style:name="${esc(name)}">${levels}</text:list-style>`
	)

	return { style, outline: false }
}

// A w:lvl as an ODF list level style (Part 3 §16.33 to §16.35, §16.37), "" for a level past the nine ODF has; undefined for
// what has no form. `element`: text:list-level-style (a list style's -bullet/-number) or text:outline-level-style.
export function levelStyle(
	numbering: XmlDocument,
	level: number,
	fonts: { face(family: string): string },
	element: "text:list-level-style" | "text:outline-level-style"
): string | undefined {
	const ilvl = Number(numbering.attribute(level, "w:ilvl") ?? "0")
	const value = (local: string): string | undefined => numbering.attribute(childNamed(numbering, level, local), "w:val")
	const format = value("numFmt") ?? "decimal"
	const text = value("lvlText") ?? ""
	const start = value("start") ?? "1"
	const suffix = value("suff") ?? "tab"
	const jc = value("lvlJc") ?? "left"
	const pPr = childNamed(numbering, level, "pPr")
	const rPr = childNamed(numbering, level, "rPr")
	const ind = pPr < 0 ? -1 : childNamed(numbering, pPr, "ind")
	const left = Number(numbering.attribute(ind, "w:left") ?? numbering.attribute(ind, "w:start") ?? "0") / 20
	const hanging = Number(numbering.attribute(ind, "w:hanging") ?? "0") / 20
	const firstLine =
		numbering.attribute(ind, "w:firstLine") === undefined ? -hanging : Number(numbering.attribute(ind, "w:firstLine")) / 20
	const font = rPr < 0 ? undefined : numbering.attribute(childNamed(numbering, rPr, "rFonts"), "w:ascii")
	const followed = suffix === "space" ? "space" : suffix === "nothing" ? "nothing" : "listtab"
	const properties = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"${jc === "left" ? "" : ` fo:text-align="${jc === "center" ? "center" : "end"}"`}><style:list-level-label-alignment text:label-followed-by="${followed}" fo:margin-left="${left}pt" fo:text-indent="${firstLine}pt"/></style:list-level-properties>`

	if (ilvl < 0 || ilvl > 8) return ""

	if (format === "bullet") {
		if (element === "text:outline-level-style") return undefined

		return `<text:list-level-style-bullet text:level="${ilvl + 1}" text:bullet-char="${esc(text === "" ? "•" : text)}">${properties}${font === undefined ? "" : `<style:text-properties style:font-name="${esc(fonts.face(font))}"/>`}</text:list-level-style-bullet>`
	}

	const formats: Readonly<Record<string, string>> = {
		decimal: "1",
		lowerLetter: "a",
		upperLetter: "A",
		lowerRoman: "i",
		upperRoman: "I",
		none: ""
	}
	const numFormat = formats[format]

	if (numFormat === undefined) return undefined

	// lvlText "%1." with the levels it shows: the prefix, the levels from the first shown to this one, the suffix.
	const match = /^([^%]*)((?:%\d[^%]*?)*%\d)?([^%]*)$/u.exec(text)

	if (match === null) return undefined

	const shown = (match[2] ?? "").match(/%\d/gu) ?? []
	const display = shown.length

	if (shown.length > 0 && shown[shown.length - 1] !== `%${ilvl + 1}`) return undefined

	const tag = element === "text:outline-level-style" ? element : "text:list-level-style-number"

	return `<${tag} text:level="${ilvl + 1}" style:num-format="${numFormat}"${match[1] === "" ? "" : ` style:num-prefix="${esc(match[1] ?? "")}"`}${match[3] === "" ? "" : ` style:num-suffix="${esc(match[3] ?? "")}"`}${display > 1 ? ` text:display-levels="${display}"` : ""}${start === "1" ? "" : ` text:start-value="${esc(start)}"`}>${properties}</${tag}>`
}

// Segments' spans in the written stream: each moved by the replacements of others before it, grown by its own (one
// pass over both, in order; a segment's own replacements lie within it).
function movedAll(segments: readonly Segment[], replacements: readonly Replacement[]): Segment[] {
	const deltas = replacements
		.map(replacement => ({
			end: replacement.end,
			segment: replacement.segment ?? -1,
			delta: encodeUtf8(replacement.text).length - (replacement.end - replacement.start)
		}))
		.sort((a, b) => a.end - b.end)
	const own = new Map<number, number>()
	const byId = new Map(segments.map(segment => [segment.id, segment]))
	// A segment's own replacements ending at its start (an insertion there): counted as its growth, not its move.
	const early = new Map<number, number>()

	for (const delta of deltas) {
		own.set(delta.segment, (own.get(delta.segment) ?? 0) + delta.delta)

		const segment = byId.get(delta.segment)

		if (segment !== undefined && delta.end <= segment.start) early.set(delta.segment, (early.get(delta.segment) ?? 0) + delta.delta)
	}

	const order = [...segments].sort((a, b) => a.start - b.start || a.end - b.end)
	const out = new Map<number, Segment>()
	let total = 0
	let k = 0

	for (const segment of order) {
		while (k < deltas.length && (deltas[k]?.end ?? 0) <= segment.start) total += deltas[k++]?.delta ?? 0

		const start = segment.start + total - (early.get(segment.id) ?? 0)

		out.set(segment.id, { ...segment, start, end: start + (segment.end - segment.start) + (own.get(segment.id) ?? 0) })
	}

	return segments.map(segment => out.get(segment.id) ?? segment)
}

// A sink writing into one buffer (grown when it must be): the written package is never held twice.
function bufferSink(size: number): ByteSink & { bytes(): Uint8Array } {
	let buffer = new Uint8Array(Math.max(1024, Math.ceil(size)))
	let length = 0

	return {
		write(chunk) {
			if (length + chunk.length > buffer.length) {
				const grown = new Uint8Array(Math.max(length + chunk.length, Math.ceil(buffer.length * 1.25)))

				grown.set(buffer.subarray(0, length))
				buffer = grown
			}

			buffer.set(chunk, length)
			length += chunk.length

			return Promise.resolve()
		},
		close() {
			return Promise.resolve()
		},
		bytes: () => buffer.subarray(0, length)
	}
}

// The preview image (Part 2 §3.8): a picture of the first page, which an edit may change and the writer cannot draw.
const THUMBNAIL = "Thumbnails/thumbnail.png"
const META = "meta.xml"

// The source's meta.xml as a save at `date` leaves it (metaOnSave); undefined: copied as it is (none, or it does not
// read).
async function savedMeta(source: OdtSource, date: string): Promise<Uint8Array | undefined> {
	const entry = source.archive.get(META)

	if (entry === undefined) return undefined

	try {
		return metaOnSave(await source.archive.read(entry), date)
	} catch (error) {
		if (error instanceof ZipError) return undefined

		throw error
	}
}

// The package with content.xml (and styles.xml, meta.xml) replaced; every other entry copied as stored, mimetype
// first. A preview image goes: Part 2 §3.8 says a producer should make one of the first page, never that a stale one
// may stay. The manifest as written (undefined: the source's, copied).
async function writePackage(
	source: OdtSource,
	content: PartBytes,
	styles: PartBytes | undefined,
	meta: Uint8Array | undefined,
	pictures: ReadonlyMap<string, Uint8Array>,
	job: RtfJob | undefined
): Promise<{ readonly bytes: Uint8Array; readonly manifest: Uint8Array | undefined }> {
	const replace: PartChange[] = [{ name: "content.xml", bytes: content }]
	const add: PartChange[] = []
	const remove: string[] = []
	const thumbnail = source.archive.get(THUMBNAIL) !== undefined
	let written: Uint8Array | undefined

	if (styles !== undefined) replace.push({ name: "styles.xml", bytes: styles })
	if (meta !== undefined) replace.push({ name: META, bytes: meta })
	if (thumbnail) remove.push(THUMBNAIL)

	if (pictures.size > 0 || thumbnail) {
		// New pictures as entries of their own (stored: they are compressed already), listed in the manifest (Part 2 §4).
		const entry = source.archive.get("META-INF/manifest.xml")

		if (entry === undefined) throw new OdtWriteRefusal("package", "the package has no manifest")

		const read = decodeUtf8(await source.archive.read(entry))
		const manifest = thumbnail ? withoutThumbnail(read) : read
		const prefix = /<([A-Za-z0-9_.-]+:)?manifest[\s>]/u.exec(manifest)?.[1] ?? ""
		let entries = ""

		const close = manifest.lastIndexOf("</")

		for (const [name, bytes] of pictures) {
			const extension = name.slice(name.lastIndexOf(".") + 1)
			const type = PICTURE_TYPES[extension] ?? "application/octet-stream"

			entries += `<${prefix}file-entry ${prefix}full-path="${esc(name)}" ${prefix}media-type="${type}"/>`
			add.push({ name, bytes, compress: false })
		}

		if (close < 0) throw new OdtWriteRefusal("package", "the manifest has no end")

		written = encodeUtf8(`${manifest.slice(0, close)}${entries}${manifest.slice(close)}`)

		assertWellFormed(parseXml(written))
		replace.push({ name: "META-INF/manifest.xml", bytes: written })
	}

	const sink = bufferSink(
		source.bytes.length +
			content.length / 4 +
			(styles?.length ?? 0) / 4 +
			(meta?.length ?? 0) / 4 +
			[...pictures.values()].reduce((sum, picture) => sum + picture.length, 0)
	)
	const deflate = nativeDeflate()
	const deflateChunks = nativeDeflateChunks()
	const slicing = job === undefined ? {} : { slicing: job.aborting }

	await writeZip(planZip(source.archive, { replace, add, remove }), source.archive, sink, {
		...(deflate === undefined ? { level: 6 } : { deflate }),
		...(deflateChunks === undefined ? {} : { deflateChunks }),
		...slicing
	})

	return { bytes: sink.bytes(), manifest: written }
}

// The meaning of a translation's body blocks and sections, and of the edit's.
// A meaning as a digest: two independent 32-bit hashes of its UTF-16 code units and its length.
function digestOf(text: string): string {
	let a = 0x811c9dc5
	let b = 0x01000193

	for (let k = 0; k < text.length; k++) {
		const code = text.charCodeAt(k)

		a = Math.imul(a ^ code, 0x01000193)
		b = Math.imul(b ^ code, 0x5bd1e995) ^ (b >>> 15)
	}

	return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${text.length.toString(36)}`
}

async function meaningOf(
	parts: (name: string) => XmlDocument | undefined,
	rels: Map<string, { target: string; external: boolean; type: string }>,
	media: (part: string) => string,
	job: RtfJob | undefined
): Promise<{ blocks: string[]; sections: string[] }> {
	const body = parts(BODY_PART)

	if (body === undefined) return { blocks: [], sections: [] }

	const stories = new Map<string, string>()
	const target = (id: string): string => {
		const relationship = rels.get(id)

		if (relationship === undefined) return `?${id}`
		if (relationship.external) return `url:${relationship.target}`

		const part = relationship.target.startsWith("/") ? relationship.target.slice(1) : `word/${relationship.target}`

		return `part:${media(part)}`
	}
	const meaning: Meaning = new Meaning({
		styles: parts("word/styles.xml"),
		numbering: parts("word/numbering.xml"),
		footnotes: parts("word/footnotes.xml"),
		endnotes: parts("word/endnotes.xml"),
		comments: parts("word/comments.xml"),
		target,
		compact: digestOf,
		story: id => {
			const known = stories.get(id)

			if (known !== undefined) return known

			const relationship = rels.get(id)
			const name = relationship === undefined ? undefined : `word/${relationship.target}`
			const document = name === undefined ? undefined : parts(name)
			const text = document === undefined ? "?" : digestOf(meaning.story(document, document.documentElement()).join("\u0002"))

			stories.set(id, text)

			return text
		}
	})

	return meaning.bodyIn(body, bodyOf(body), job === undefined ? undefined : async () => (job.due() ? turn(job) : undefined))
}

// Compares the written file's reading with the edit, segment by segment. Units whose kept bytes read differently
// come back to be rewritten; a rewritten segment that reads differently refuses (or, in Gate 1, locks).
// What the edit means (verify's expectation); the same from one write to the next.
async function expectedOf(
	plan: OdtPlan,
	doc: EditedDocument,
	result: WriteResult,
	job: RtfJob | undefined
): Promise<{ blocks: string[]; sections: string[] }> {
	doc.expected ??= await meaningOf(
		name => plan.editedXml(name),
		doc.eRels,
		part => plan.translation.media.get(part) ?? result.pictureParts.get(part) ?? part,
		job
	)

	return doc.expected
}

async function verify(
	expected: { readonly blocks: readonly string[]; readonly sections: readonly string[] },
	result: WriteResult,
	packaged: Uint8Array,
	source: ZipArchive,
	job: RtfJob | undefined
): Promise<{
	readonly again: Set<number>
	readonly wrong: Set<number>
	readonly wrongBlocks: Set<number>
	readonly message: string | undefined
}> {
	// Every part listed in the manifest and every listing a part (Part 2 §3.2, §4.3), as far as the source had them so.
	const written = await ZipArchive.open(bytesSource(packaged))
	const was = await manifestGaps(source)

	for (const gap of await manifestGaps(written)) {
		if (!was.has(gap)) throw new OdtWriteRefusal("proof", `the written manifest does not match the package (${gap})`)
	}

	const read = await translateOdt(bytesSource(packaged), job === undefined ? { strict: true } : { slicing: job.aborting, strict: true })

	if (!read.ok) throw new OdtWriteRefusal("proof", `the written file does not open (${read.message})`)

	await turn(job)

	const reread = read.translation
	const rereadDocs = new Map<string, XmlDocument>()
	const rereadPart = (name: string): XmlDocument | undefined => {
		let document = rereadDocs.get(name)

		if (document === undefined) {
			const part = reread.parts.get(name)

			if (!(part instanceof Uint8Array)) return undefined

			document = parseXml(part)
			rereadDocs.set(name, document)
		}

		return document
	}
	await turn(job)

	const actual = await meaningOf(
		rereadPart,
		relationshipsOf(reread.parts.get(RELS_PART) as Uint8Array | undefined),
		part => reread.media.get(part) ?? part,
		job
	)

	await turn(job)

	const again = new Set<number>()
	const wrong = new Set<number>()
	const wrongBlocks = new Set<number>()
	const wholeUnits = new Set<number>()
	let message: string | undefined

	const origins = reread.origins.filter(origin => origin.part === BODY_PART && origin.stream === "content.xml")
	// The reread blocks of each segment, by where their source elements start.
	const rangeOf = (segment: Segment): { from: number; to: number } => {
		let from = Number.MAX_SAFE_INTEGER
		let to = -1

		for (const origin of origins) {
			if (origin.start >= segment.start && origin.end <= segment.end && origin.count > 0) {
				from = Math.min(from, origin.first)
				to = Math.max(to, origin.first + origin.count)
			}
		}

		return to < 0 ? { from: 0, to: 0 } : { from, to }
	}

	for (const segment of result.segments) {
		const range = rangeOf(segment)
		const want = expected.blocks.slice(segment.from, segment.to)
		const got = actual.blocks.slice(range.from, range.to)
		const same = want.length === got.length && want.every((block, k) => block === got[k])

		if (same) continue

		const units = segment.units.map(unit => unit.index)

		if (segment.kind === "kept") for (const unit of units) again.add(unit)
		else if (want.length === got.length && segment.from >= 0) {
			// Block by block where they pair (Gate 1 locks only the blocks that read differently).
			want.forEach((block, k) => {
				if (block !== got[k]) wrongBlocks.add(segment.from + k)
			})

			for (const unit of units) wrong.add(unit)
		} else
			for (const unit of units) {
				wrong.add(unit)
				wholeUnits.add(unit)
			}

		if (message === undefined) {
			const k = want.findIndex((block, index) => block !== got[index])

			message = `block ${segment.from + Math.max(0, k)} reads ${(got[Math.max(0, k)] ?? "nothing").slice(0, 300)} for ${(want[Math.max(0, k)] ?? "nothing").slice(0, 300)}`
		}
	}

	// The whole body, for what no segment covers (blocks the writer added where the source had none).
	if (again.size === 0 && wrong.size === 0) {
		if (expected.blocks.length !== actual.blocks.length || expected.blocks.some((block, k) => block !== actual.blocks[k])) {
			const k = expected.blocks.findIndex((block, index) => block !== actual.blocks[index])

			message = `block ${k} reads ${(actual.blocks[k] ?? "nothing").slice(0, 300)} for ${(expected.blocks[k] ?? "nothing").slice(0, 300)}`
			wrong.add(-1)
		} else if (expected.sections.join("\u0001") !== actual.sections.join("\u0001")) {
			message = "the sections read differently"
			wrong.add(-1)
		}
	}

	// A unit whose blocks did not pair locks whole: its blocks then stand for the unit.
	for (const unit of wholeUnits) wrongBlocks.add(-1 - unit)

	return { again, wrong, wrongBlocks, message }
}

// One changed run of top-level blocks: the edit's blocks [from, to) it must read as, the bytes [start, end) of the
// written content.xml holding it, and the translator's state where it starts (Translator.blockState).
interface SpanWindow {
	readonly from: number
	readonly to: number
	readonly start: number
	readonly end: number
	readonly state: string
}

interface SpanPlan {
	readonly windows: readonly SpanWindow[]
	// The edit's top-level blocks.
	readonly blocks: number
	readonly frame: SpanFrame
	// Where office:body starts in the written content.xml.
	readonly prologueEnd: number
	readonly settings: { readonly tabsRelativeToIndent: boolean }
	// The translation's styles part: the windows' translation must make the same.
	readonly stylesPart: Uint8Array | undefined
}

// The span proof (span.ts) of `packaged` as the file of an edit planned as `span`: true when it reads as `expected`
// (content.xml as written outside the windows, each window as the edit's blocks there); false leaves the save to
// the whole file's proof.
async function proveSpans(
	span: SpanPlan,
	expected: { readonly blocks: readonly string[] },
	content: BytePieces,
	packaged: Uint8Array,
	source: ZipArchive,
	manifest: Uint8Array | undefined,
	meta: Uint8Array | undefined,
	job: RtfJob | undefined
): Promise<boolean> {
	if (span.stylesPart === undefined) return false

	const opened = await OdfPackage.open(bytesSource(packaged), { kinds: ["text", "text-master", "text-web"] })

	if (!opened.ok) return false

	const odf = opened.package

	// Every entry but content.xml is the source's as stored (styles.xml, settings...), the manifest and meta.xml the
	// ones written and the preview image gone: the proof reads only content.xml, so what it takes as copied is checked,
	// not assumed.
	const dropped = source.get(THUMBNAIL) === undefined ? 0 : 1

	if (odf.archive.entries.length !== source.entries.length - dropped || odf.archive.get(THUMBNAIL) !== undefined) return false

	for (const entry of odf.archive.entries) {
		if (entry.name === "content.xml") continue

		if (entry.name === "META-INF/manifest.xml" && manifest !== undefined) {
			if (!equalBytes(await odf.archive.read(entry), manifest)) return false

			continue
		}

		if (entry.name === META && meta !== undefined) {
			if (!equalBytes(await odf.archive.read(entry), meta)) return false

			continue
		}

		const was = source.get(entry.name)

		if (
			was === undefined ||
			was.crc32 !== entry.crc32 ||
			was.method !== entry.method ||
			was.compressedSize !== entry.compressedSize ||
			was.uncompressedSize !== entry.uncompressedSize
		)
			return false
	}
	const entry = odf.archive.get("content.xml")
	const clock = job === undefined ? undefined : sliceClock(job.aborting)

	if (entry === undefined || entry.uncompressedSize !== content.length) return false

	// content.xml read from the file: as written outside the windows; the windows' bytes as the file has them.
	const windows = span.windows.map(window => ({ window, bytes: new Uint8Array(window.end - window.start) }))
	let offset = 0

	try {
		for await (const chunk of inflateChunks(odf.archive, entry, clock)) {
			let at = 0

			for (const { window, bytes } of windows) {
				const from = Math.max(window.start - offset, at)
				const to = Math.min(window.end - offset, chunk.length)

				if (from >= to) continue
				if (!sameAs(content, offset + at, chunk, at, from - at)) return false

				bytes.set(chunk.subarray(from, to), offset + from - window.start)
				at = to
			}

			if (!sameAs(content, offset + at, chunk, at, chunk.length - at)) return false

			offset += chunk.length
		}
	} catch (error) {
		if (error instanceof RtfAborted) throw error

		return false
	}

	await turn(job)

	if (expected.blocks.length !== span.blocks) return false

	try {
		// The written prologue (read as the file has it: content.xml was just compared with it) and styles.xml.
		const slicing = job?.aborting
		const head = content.copy(0, Math.min(content.length, span.prologueEnd + 64))
		const prologue = slicing === undefined ? readContentPrologue(head) : await readContentPrologueSliced(head, slicing)

		if (prologue.bodyStart !== span.prologueEnd) return false

		// What was written in the prologue (automatic styles, font faces, declarations) is checked strictly: the
		// lenient parse that reads it would take markup a reader refuses.
		await strictly(prologue.document, slicing)

		const stylesXml = await odf.xml("styles.xml", slicing)
		const sheet =
			slicing === undefined ? new OdfStyleSheet(stylesXml, prologue) : await OdfStyleSheet.build(stylesXml, prologue, slicing)
		const styles = { odf, sheet, settings: span.settings }
		const stylesPart = decodeUtf8(span.stylesPart)
		const stylesDocument = parseXml(span.stylesPart)

		for (const { window, bytes } of windows) {
			await turn(job)

			const run = translateRun(styles, span.frame, bytes, window.state, true)

			if (run === undefined || run.styles !== stylesPart) return false

			const got = runMeaning(run.blocks, stylesDocument, digestOf)
			const want = expected.blocks.slice(window.from, window.to)

			if (got === undefined || got.length !== want.length || got.some((block, k) => block !== want[k])) return false
		}
	} catch (error) {
		// What does not read here is left to the whole file's proof.
		if (error instanceof RtfAborted || !(error instanceof Error)) throw error

		return false
	}

	return true
}

async function strictly(document: XmlDocument, slicing: Slicing | undefined): Promise<void> {
	if (slicing === undefined) assertWellFormed(document)
	else await assertWellFormedSliced(document, slicing)
}

// Whether `count` bytes of `chunk` from `chunkFrom` are those written at `from`.
function sameAs(written: BytePieces, from: number, chunk: Uint8Array, chunkFrom: number, count: number): boolean {
	return written.visit(from, count, (piece, pieceFrom, length, at) => {
		for (let k = 0; k < length; k++) if (piece[pieceFrom + k] !== chunk[chunkFrom + at + k]) return false

		return true
	})
}

// Writes the edited document as ODT; refuses (OdtWriteRefusal) what it cannot write as edited, and any failure on the
// way is such a refusal. `turns`: in slices. `now`: the save time in epoch milliseconds (meta.xml's dc:date).
export async function writeOdt(
	source: OdtSource,
	edits: OdtEdits,
	options: { readonly turns?: RtfTurns; readonly spanProof?: boolean; readonly now?: () => number } = {}
): Promise<OdtWritten> {
	try {
		return await write(source, edits, options)
	} catch (error) {
		if (error instanceof OdtWriteRefusal || error instanceof RtfAborted) throw error

		throw new OdtWriteRefusal("failed", error instanceof Error ? `${error.name}: ${error.message}` : String(error))
	}
}

async function write(
	source: OdtSource,
	edits: OdtEdits,
	options: { readonly turns?: RtfTurns; readonly spanProof?: boolean; readonly now?: () => number }
): Promise<OdtWritten> {
	if (edits.parts.size === 0 && (edits.removed?.length ?? 0) === 0) return { bytes: source.bytes, written: 0, rounds: 0 }

	// The package's other entries are copied as stored: META-INF/documentsignatures.xml would keep digests the edit
	// no longer matches (the document opens view-only: odtGate).
	if (source.translation.facts.signed)
		throw new OdtWriteRefusal("signed", "The document is digitally signed: an edit saved in place would invalidate its signatures")

	// Read once, on the first round that writes; every round writes the same.
	let meta: Promise<Uint8Array | undefined> | undefined

	const job = jobOf(options.turns)
	let plan = await OdtPlan.create(source, edits, job)
	const pointed = odfVersion(plan.rootOpen) < 1.2 ? pointComments(source.translation, edits) : undefined
	const notices: OdtWriteNotice[] = pointed !== undefined && pointed.count > 0 ? [{ kind: "commentPoint", count: pointed.count }] : []

	if (pointed !== undefined && pointed.count > 0) plan = await OdtPlan.create(source, pointed.edits, job)

	await plan.preload(job)
	await turn(job)

	let doc: EditedDocument | undefined
	let expected: { blocks: string[]; sections: string[] } | undefined
	const forced = new Set<number>()

	for (let round = 1; round <= MAX_ROUNDS; round++) {
		await turn(job)

		if (doc === undefined) {
			await plan.restyle(job)
			await plan.preload(job)
			doc = new EditedDocument(plan)
			doc.expected = expected
		}

		let write: OdtWrite | undefined = new OdtWrite(doc, { prove: false, forced })
		const result = await write.run(job)

		expected = await expectedOf(plan, doc, result, job)

		const span = options.spanProof === false || !result.contentChanged ? undefined : write.spanPlan(result, await sourcePackage(source))

		write = undefined

		// The write's parsed bodies, unit trees and style sheet make way for the proof's reading (a next round reads
		// them again).
		doc = undefined
		plan.release(true)

		if (!result.contentChanged) {
			// Nothing to write: the edit reads as the source does (its parts the translation's, byte for byte).
			const unchanged = await verify(expected, result, source.bytes, source.archive, job)

			if (unchanged.again.size === 0 && unchanged.wrong.size === 0) return { bytes: source.bytes, written: 0, rounds: round, notices }
			if (unchanged.wrong.size > 0) throw new OdtWriteRefusal("proof", unchanged.message ?? "the edit does not read back")

			for (const unit of unchanged.again) forced.add(unit)

			continue
		}

		const { content, styles } = result

		meta ??= savedMeta(source, new Date((options.now ?? Date.now)()).toISOString())

		const metaBytes = await meta
		const { bytes: packaged, manifest } = await writePackage(source, content, styles, metaBytes, result.pictures, job)

		await turn(job)

		if (
			span !== undefined &&
			content instanceof BytePieces &&
			(await proveSpans(span, expected, content, packaged, source.archive, manifest, metaBytes, job))
		)
			return { bytes: packaged, written: result.written, rounds: round, proof: "span", notices }

		const checked = await verify(expected, result, packaged, source.archive, job)

		if (checked.wrong.size > 0) throw new OdtWriteRefusal("proof", checked.message ?? "the written file reads differently")
		if (checked.again.size === 0) return { bytes: packaged, written: result.written, rounds: round, proof: "whole", notices }

		for (const unit of checked.again) forced.add(unit)
	}

	throw new OdtWriteRefusal("proof", "the written file does not settle")
}

// Where a package and its manifest disagree: entries the manifest does not list ("unlisted:"), and files it lists
// that the package does not hold ("missing:"). The mimetype stream and META-INF/ need no listing (Part 2 §3.2).
async function manifestGaps(archive: ZipArchive): Promise<Set<string>> {
	const gaps = new Set<string>()
	const entry = archive.get("META-INF/manifest.xml")

	if (entry === undefined) return gaps

	const document = parseXml(await archive.read(entry))
	const listed = new Set<string>()

	for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node)) {
		const path = [...document.attributes(node)].find(
			attribute => attribute.name.endsWith(":full-path") || attribute.name === "full-path"
		)?.value

		if (path !== undefined) listed.add(path)
	}

	for (const item of archive.entries) {
		if (item.name === "mimetype" || item.name.startsWith("META-INF/") || item.name.endsWith("/")) continue
		if (!listed.has(item.name)) gaps.add(`unlisted:${item.name}`)
	}

	for (const path of listed) {
		if (path === "/" || path.endsWith("/")) continue
		if (archive.get(path) === undefined) gaps.add(`missing:${path}`)
	}

	return gaps
}

// The manifest a write without new pictures writes (undefined: the source's, copied).
async function expectedManifest(source: OdtSource): Promise<Uint8Array | undefined> {
	const entry = source.archive.get("META-INF/manifest.xml")

	if (source.archive.get(THUMBNAIL) === undefined || entry === undefined) return undefined

	return encodeUtf8(withoutThumbnail(decodeUtf8(await source.archive.read(entry))))
}

// The meta.xml a write saved when `written` was dated: the source's as a save then leaves it (undefined: copied).
async function expectedMeta(source: OdtSource, written: Uint8Array): Promise<Uint8Array | undefined> {
	const archive = await ZipArchive.open(bytesSource(written))
	const entry = archive.get(META)
	const date = entry === undefined ? undefined : metaDate(await archive.read(entry))

	return date === undefined ? undefined : savedMeta(source, date)
}

// A manifest without the preview image's entry.
function withoutThumbnail(manifest: string): string {
	const prefix = /<([A-Za-z0-9_.-]+:)?manifest[\s>]/u.exec(manifest)?.[1] ?? ""

	return manifest.replace(new RegExp(`<${prefix}file-entry\\s[^>]*full-path="Thumbnails/thumbnail\\.png"[^>]*/>\\s*`, "u"), "")
}

// The source file as an ODF package (what a translation of some of its blocks is given).
async function sourcePackage(source: OdtSource): Promise<OdfPackage> {
	const opened = await OdfPackage.open(bytesSource(source.bytes), { kinds: ["text", "text-master", "text-web"] })

	if (!opened.ok) throw new OdtWriteRefusal("package", opened.message)

	return opened.package
}

// Both proofs of `written` as the file of `edits` (bytes the writer need not have written: what a test hands in):
// whether the span proof proves it, and the whole file's verdict ("done", "again", or why it refuses).
export async function proveOdtWritten(
	source: OdtSource,
	edits: OdtEdits,
	written: Uint8Array
): Promise<{ readonly span: boolean; readonly whole: string }> {
	const plan = await OdtPlan.create(source, edits, undefined)
	const doc = new EditedDocument(plan)
	const write = new OdtWrite(doc, { prove: false, forced: new Set() })
	const result = await write.run(undefined)
	const expected = await expectedOf(plan, doc, result, undefined)
	const spanned = result.contentChanged ? write.spanPlan(result, await sourcePackage(source)) : undefined
	const span =
		spanned !== undefined &&
		result.content instanceof BytePieces &&
		(await proveSpans(
			spanned,
			expected,
			result.content,
			written,
			source.archive,
			await expectedManifest(source),
			await expectedMeta(source, written),
			undefined
		))

	try {
		const checked = await verify(expected, result, written, source.archive, undefined)

		return { span, whole: checked.wrong.size > 0 ? (checked.message ?? "wrong") : checked.again.size > 0 ? "again" : "done" }
	} catch (error) {
		if (!(error instanceof OdtWriteRefusal)) throw error

		return { span, whole: error.message }
	}
}

// Gate 1: every block rewritten from its translation, in place, and read back; the top-level blocks that do not come
// back as they were (or hold what a rewrite would lose, or show approximated) are locked.
export async function proveOdt(source: OdtSource, turns?: RtfTurns): Promise<OdtProofResult> {
	const job = jobOf(turns)
	const plan = await OdtPlan.create(source, { parts: new Map() }, job)

	await plan.preload(job)
	await turn(job)

	const doc = new EditedDocument(plan)
	const result = await new OdtWrite(doc, { prove: true, forced: new Set() }).run(job)
	const lockedUnits = new Set<number>(result.failed.keys())
	const expected = result.contentChanged ? await expectedOf(plan, doc, result, job) : undefined

	// What the write parsed besides the bodies (unit trees, the style sheet) makes way for the proof's reading.
	plan.release(true)
	const reasons = new Map<number, string>(result.failed)

	if (result.contentChanged) {
		const { content, styles } = result
		// Gate 1 proves the blocks only: meta.xml is copied.
		const { bytes: packaged } = await writePackage(source, content, styles, undefined, result.pictures, job)

		await turn(job)

		try {
			const checked = await verify(expected ?? (await expectedOf(plan, doc, result, job)), result, packaged, source.archive, job)

			// Kept units that read differently (a neighbour's rewrite reached them) and units whose blocks did not pair
			// lock whole; a rewritten block that reads differently locks alone.
			for (const unit of [...checked.again, ...[...checked.wrongBlocks].filter(block => block < 0).map(block => -1 - block)]) {
				lockedUnits.add(unit)
				reasons.set(unit, "proof")
			}

			for (const block of checked.wrongBlocks) if (block >= 0) result.failedBlocks.set(block, "proof")

			// A reading that differs where no segment says: every rewritten unit is suspect.
			if (checked.wrong.has(-1))
				for (const segment of result.segments)
					if (segment.kind === "written") for (const unit of segment.units) lockedUnits.add(unit.index)
		} catch (error) {
			if (!(error instanceof OdtWriteRefusal)) throw error

			for (const segment of result.segments) for (const unit of segment.units) lockedUnits.add(unit.index)
		}
	}

	const locked: RtfLockedBlock[] = []
	const why: string[] = []

	for (const unit of plan.units) {
		const whole = lockedUnits.has(unit.index)

		for (let k = unit.origin.first; k < unit.origin.first + unit.origin.count; k++) {
			const block = doc.tBlocks[k]
			const single = result.failedBlocks.get(k)

			if (block === undefined || (!whole && single === undefined)) continue

			locked.push({ part: BODY_PART, offset: doc.tBody.start(block) })
		}

		if (whole) why.push(reasons.get(unit.index) ?? "proof")
		else {
			for (let k = unit.origin.first; k < unit.origin.first + unit.origin.count; k++) {
				const single = result.failedBlocks.get(k)

				if (single !== undefined) why.push(single)
			}
		}
	}

	return { locked, written: result.written, reasons: why }
}

export { RtfAborted as OdtAborted }
export type { RtfTurns as OdtTurns }
export { W_NAMESPACE }

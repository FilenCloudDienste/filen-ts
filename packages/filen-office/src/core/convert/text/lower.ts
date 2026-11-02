import { appendAll } from "../../arrays"
import { symbolTable, symbolToUnicode } from "../../fonts/symbols"
import { ByteKeyMap } from "../../odt/write/byteKeys"
import { paragraphAttributes, runAttributes } from "../../odt/write/inverse"
import { readProps, StyleChains, type Props } from "../../odt/write/meaning"
import { encodeUtf8, NodeKind, parseXml, type XmlDocument } from "../../xml/index"
import { TextConversionError, type LossyCounts, type TextLossyKind } from "./report"

// A WordprocessingML story (the body, a header or footer, the notes, the comments) lowered to what the ODF emitter
// (core/odt/write/emit.ts) writes: content controls, smart tags and custom XML unwrapped to their content; complex
// fields to their results (PAGE and NUMPAGES as simple fields, HYPERLINK as a hyperlink); moves as insertions and
// deletions; symbols as characters; page and column breaks as paragraph breaks; highlighting as shading; theme fonts
// as the fonts they name; properties without an ODF form left out, and each counted. Drawings come out in one
// normalized form the converter's picture writer reads (an inline or an anchor holding a picture's blip or a text
// box's lowered content); text a drawing holds that no frame can show is written after its paragraph. Relationship
// ids become ids of the whole package (hyperlinks "h…", pictures "i…"). Element and attribute names keep the prefixes
// the converter declares (w, r, wp, a).

export const LOWERED_NAMESPACES =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

export interface PartLinks {
	// A relationship of the part being lowered: its target and whether it is external.
	relationship(id: string): { readonly target: string; readonly external: boolean } | undefined
}

export interface Theme {
	readonly major: { readonly latin?: string; readonly eastAsia?: string; readonly cs?: string }
	readonly minor: { readonly latin?: string; readonly eastAsia?: string; readonly cs?: string }
}

// Package-wide ids the lowered stories name.
export class LoweredIds {
	readonly hyperlinks = new Map<string, string>()
	readonly pictures = new Map<string, string>()
	private readonly byTarget = new Map<string, string>()

	hyperlink(target: string): string {
		const key = `h\u0000${target}`
		let id = this.byTarget.get(key)

		if (id === undefined) {
			id = `h${String(this.hyperlinks.size + 1)}`
			this.hyperlinks.set(id, target)
			this.byTarget.set(key, id)
		}

		return id
	}

	picture(part: string): string {
		const key = `i\u0000${part}`
		let id = this.byTarget.get(key)

		if (id === undefined) {
			id = `i${String(this.pictures.size + 1)}`
			this.pictures.set(id, part)
			this.byTarget.set(key, id)
		}

		return id
	}
}

export interface LoweredSection {
	// The w:sectPr element as lowered markup ("" for none).
	readonly sectPr: string
	readonly first: number
}

// ST_HighlightColor.
const HIGHLIGHTS: Readonly<Record<string, string>> = {
	black: "000000",
	blue: "0000FF",
	cyan: "00FFFF",
	green: "00FF00",
	magenta: "FF00FF",
	red: "FF0000",
	yellow: "FFFF00",
	white: "FFFFFF",
	darkBlue: "000080",
	darkCyan: "008080",
	darkGreen: "008000",
	darkMagenta: "800080",
	darkRed: "800000",
	darkYellow: "808000",
	darkGray: "808080",
	lightGray: "C0C0C0"
}

const KEPT_PREFIXES = new Set(["w", "r", "wp", "a", "xml"])
// Lowered markup that shows something.
const VISIBLE = /<w:(?:t|delText|tab|br|cr|drawing|sym|footnoteReference|endnoteReference|softHyphen|noBreakHyphen)\b/u
// Attributes without a prefix (DrawingML's cx, relativeFrom...) are kept too.
const KEPT_ATTRIBUTE_PREFIXES = new Set([...KEPT_PREFIXES, ""])
// Properties that say nothing visible, left out without a count.
const SILENT = new Set(["cnfStyle", "divId", "rsid", "noProof", "webHidden", "specVanish", "proofErr", "adjustRightInd"])
const EAST_ASIAN = new Set(["autoSpaceDE", "autoSpaceDN", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct"])
// ST_OnOff false.
const OFF = new Set(["0", "false", "off"])
// Paragraph properties the emitter reads itself.
const PARAGRAPH_OWN = new Set(["pStyle", "numPr", "outlineLvl", "rPr"])
const MARK_REVISIONS = new Set(["ins", "del", "moveFrom", "moveTo", "rPrChange"])
const UNWRAPPED = new Set(["smartTag", "customXml", "dir", "bdo", "sdtContent"])
const DROPPED_INLINE = new Set([
	"proofErr",
	"permEnd",
	"moveFromRangeStart",
	"moveFromRangeEnd",
	"moveToRangeStart",
	"moveToRangeEnd",
	"customXmlInsRangeStart",
	"customXmlInsRangeEnd",
	"customXmlDelRangeStart",
	"customXmlDelRangeEnd",
	"customXmlMoveFromRangeStart",
	"customXmlMoveFromRangeEnd",
	"customXmlMoveToRangeStart",
	"customXmlMoveToRangeEnd",
	"lastRenderedPageBreak"
])
// Row and cell properties the emitter writes (emit.ts rowStyleAttribute, cellStyle).
// Bounds on what a hostile file's tables make the conversion write, checked before anything is laid out per column:
// WordprocessingML sets no column limit (ECMA-376 Part 1 CT_TblGridBase: gridCol maxOccurs unbounded), so these are past any
// real table (the corpus' widest has 22 grid columns, its most cells 119 266 in all) and bound the output: a row past
// MAX_TABLE_COLUMNS refuses, and so do the cells of every table together past MAX_TABLE_CELLS (counted for a table's
// rows at its grid's width before any is lowered).
export const MAX_TABLE_COLUMNS = 1024
// A sanity bound known before any row is lowered: a long top-level table is lowered and written a few rows at a time,
// so the conversion's written budget bounds the rest (about a million plain cells).
const MAX_TABLE_CELLS = 2_000_000

const ROW_PROPERTIES = new Set(["trHeight", "cantSplit", "tblHeader", "cnfStyle", "jc"])
const CELL_PROPERTIES = new Set([
	"gridSpan",
	"vMerge",
	"tcW",
	"cnfStyle",
	"hideMark",
	"tcBorders",
	"tcMar",
	"shd",
	"vAlign",
	"textDirection"
])
const CELL_SIDES = new Set(["top", "left", "bottom", "right", "start", "end"])

const NEEDS_ESCAPE = /[&<>"]/u

function escText(text: string): string {
	return NEEDS_ESCAPE.test(text) ? text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;") : text
}

function escAttribute(text: string): string {
	return NEEDS_ESCAPE.test(text) ? escText(text).replace(/"/gu, "&quot;") : text
}

function prefixOf(name: string): string {
	const colon = name.indexOf(":")

	return colon < 0 ? "" : name.slice(0, colon)
}

interface FieldFrame {
	// "code" until the separator, then "result".
	phase: "code" | "result"
	code: string
	// Where its result starts in the paragraph's output (-1: another paragraph).
	resultAt: number
	paragraph: number
}

interface ParagraphOut {
	out: string
	// Inline nesting depth (hyperlinks, changes): a break splits a paragraph at depth 0 only.
	depth: number
	// Offsets in `out` where a page or column break splits it, and the break.
	splits: { at: number; kind: "page" | "column" }[]
	// Blocks written after the paragraph (text that drawings hold).
	after: string[]
	id: number
}

// What the converted styles and lists hold, which lowered properties may name.
export interface LoweringStyles {
	readonly chains: StyleChains
	readonly paragraphStyles: ReadonlyMap<string, string>
	readonly characterStyles: ReadonlyMap<string, string>
	readonly lists: { has(numId: string): boolean }
	// Table styles with conditional formatting.
	readonly conditionalTables: ReadonlySet<string>
}

interface Counts {
	add(kind: TextLossyKind, count?: number): void
}

// Lowered property markup by the source's, with what lowering it counted (documents repeat a few property sets).
interface Memo {
	readonly markup: string
	readonly kinds: readonly TextLossyKind[]
}

const MEMO_LIMIT = 4096

export class Lowering {
	private lossy: Counts
	private readonly ids: LoweredIds
	private readonly theme: Theme | undefined
	private styles: LoweringStyles = {
		chains: new StyleChains(undefined),
		paragraphStyles: new Map(),
		characterStyles: new Map(),
		lists: { has: () => false },
		conditionalTables: new Set()
	}
	private links: PartLinks = { relationship: () => undefined }
	private document!: XmlDocument
	private fields: FieldFrame[] = []
	private paragraphs = 0
	private readonly startedComments = new Set<string>()
	// Whether tracked changes can stay tracked in the story (ODF records them in the body only).
	private tracked = true
	private readonly fonts = { face: (family: string) => family }

	private readonly memos = new Map<string, ByteKeyMap<Memo>>()
	// Cells the tables lowered so far are written with (each row as wide as its table), and the table being lowered's width.
	private cells = 0
	private tableWidth = 0
	// Tables the block being lowered is in; what a lowered block or outermost row costs the conversion's byte budget.
	private tableDepth = 0
	// Bytes a lowering call may make (`budget`), and what the current one has.
	private limit = Number.POSITIVE_INFINITY
	private made = 0
	// Lowering notes, comments, headers or footers: a note referenced in one is written as text there (ODF notes hold
	// no notes, and LibreOffice opens no note in a header or footer).
	private inNotes = false
	// A page (column) break that ended the last paragraph: a break before the next.
	private pendingBreak: "page" | "column" | undefined

	// `compute`'s markup for the element's bytes, its counts replayed on each use.
	private memo(kind: string, node: number, compute: () => string): string {
		let memos = this.memos.get(kind)

		if (memos === undefined) {
			memos = new ByteKeyMap<Memo>(MEMO_LIMIT)
			this.memos.set(kind, memos)
		}

		const raw = this.document.raw(node)
		const known = memos.get(raw)

		if (known !== undefined) {
			for (const counted of known.kinds) this.lossy.add(counted)

			return known.markup
		}

		const outer = this.lossy
		const kinds: TextLossyKind[] = []

		this.lossy = {
			add: (counted, count = 1) => {
				for (let k = 0; k < count; k++) kinds.push(counted)

				outer.add(counted, count)
			}
		}

		let markup: string

		try {
			markup = compute()
		} finally {
			this.lossy = outer
		}

		memos.set(raw, { markup, kinds })

		return markup
	}

	constructor(lossy: LossyCounts, ids: LoweredIds, theme: Theme | undefined) {
		this.lossy = lossy
		this.ids = ids
		this.theme = theme
	}

	// What one call (a run of blocks, a notes, header or footer part) may lower, charged as blocks and rows are.
	budget(limit: number): void {
		this.limit = limit
	}

	private spend(bytes: number): void {
		this.made += bytes

		if (this.made > this.limit) throw new TextConversionError("tooLarge", `Lowered markup past ${String(this.limit)} bytes.`)
	}

	// What the converted styles hold, set once they are converted (from the parts `normalize` gave).
	use(styles: LoweringStyles): void {
		this.styles = styles
	}

	// A part (styles, numbering) as the lowered stories have their markup: measures as numbers, language tags as
	// BCP 47, only the prefixes the converter declares.
	normalize(document: XmlDocument): XmlDocument {
		this.reset(document, { relationship: () => undefined }, true)

		return parseXml(
			encodeUtf8(
				this.clean(document.documentElement()).replace(/^<([A-Za-z0-9]+:)?[A-Za-z0-9]+/u, match => `${match} ${LOWERED_NAMESPACES}`)
			)
		)
	}

	private reset(document: XmlDocument, links: PartLinks, tracked: boolean): void {
		this.made = 0
		this.document = document
		this.links = links
		this.fields = []
		this.startedComments.clear()
		this.tracked = tracked
		this.pendingBreak = undefined
	}

	// --- Stories ---

	// The body's top-level blocks and its sections: each section's properties and the index (into `blocks`) of its
	// first block. A section ends at a paragraph whose properties hold a w:sectPr, wherever it sits within
	// a top-level block (a content control...): the next top-level block starts the next one.
	openBody(
		document: XmlDocument,
		links: PartLinks
	): { readonly blocks: readonly number[]; readonly sections: readonly LoweredSection[] } {
		this.reset(document, links, true)

		const body = this.child(document.documentElement(), "body")
		const blocks: number[] = []
		const sections: LoweredSection[] = []
		let first = 0
		let final = ""

		for (let node = body < 0 ? -1 : document.firstChildElement(body); node >= 0; node = document.nextSiblingElement(node)) {
			if (document.localName(node) === "sectPr") {
				final = this.clean(node)

				continue
			}

			blocks.push(node)

			const ends = this.sectionEnds(node)

			if (ends !== undefined) {
				sections.push({ sectPr: ends, first })
				first = blocks.length
			}
		}

		sections.push({ sectPr: final, first })

		return { blocks, sections }
	}

	// The last section properties a block's paragraphs end a section with (not looking into tables).
	private sectionEnds(node: number): string | undefined {
		const document = this.document
		const local = document.localName(node)

		if (local === "p") {
			const pPr = this.child(node, "pPr")
			const sectPr = pPr < 0 ? -1 : this.child(pPr, "sectPr")

			return sectPr < 0 ? undefined : this.clean(sectPr)
		}

		if (local === "tbl") return undefined

		let found: string | undefined

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
			found = this.sectionEnds(child) ?? found

		return found
	}

	// Top-level blocks of the body lowered, as one document; `firsts`: per block, the index of the first lowered block
	// it became (-1: none).
	// `last`: the body's last run (a page break ending its last paragraph starts an empty page).
	lowerBlocks(nodes: readonly number[], last: boolean): { readonly xml: string; readonly firsts: readonly number[] } {
		this.made = 0

		const blocks: string[] = []
		const firsts: number[] = []

		for (const node of nodes) {
			const before = blocks.length

			this.block(node, blocks, () => undefined)
			firsts.push(blocks.length > before ? before : -1)
		}

		if (last) appendAll(blocks, this.flushBreak())

		return { xml: `<w:document ${LOWERED_NAMESPACES}><w:body>${blocks.join("")}</w:body></w:document>`, firsts }
	}

	private flushBreak(): string[] {
		const kind = this.pendingBreak

		this.pendingBreak = undefined

		return kind === undefined ? [] : [`<w:p><w:pPr>${this.breakBefore("", kind)}</w:pPr></w:p>`]
	}

	// A header's or footer's blocks (tracked changes there shown as accepted: ODF tracks the body only).
	story(document: XmlDocument, links: PartLinks, root: "hdr" | "ftr"): string {
		this.reset(document, links, false)
		this.inNotes = true

		const blocks: string[] = []

		try {
			for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node))
				this.block(node, blocks, () => this.lossy.add("sectionLayout"))
		} finally {
			this.inNotes = false
		}

		return `<w:${root} ${LOWERED_NAMESPACES}>${blocks.join("")}</w:${root}>`
	}

	// The notes or comments part: each note's (comment's) blocks under its own element.
	notes(document: XmlDocument, links: PartLinks, kind: "footnotes" | "endnotes" | "comments"): string {
		this.reset(document, links, true)
		this.inNotes = true

		try {
			return this.notesOf(document, kind)
		} finally {
			this.inNotes = false
		}
	}

	private notesOf(document: XmlDocument, kind: "footnotes" | "endnotes" | "comments"): string {
		const item = kind === "footnotes" ? "footnote" : kind === "endnotes" ? "endnote" : "comment"
		let out = ""

		for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node)) {
			if (document.localName(node) !== item) continue

			const type = document.attribute(node, "w:type")

			// Separators are page furniture ODF has no form for (its note separator is the page style's line).
			if (type === "separator" || type === "continuationSeparator" || type === "continuationNotice") continue

			const blocks: string[] = []

			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
				this.block(child, blocks, () => undefined)

			out += `<w:${item}${this.attributes(node)}>${blocks.join("")}</w:${item}>`
		}

		return `<w:${kind} ${LOWERED_NAMESPACES}>${out}</w:${kind}>`
	}

	// --- Blocks ---

	private block(node: number, out: string[], sectionEnd: (sectPr: string) => void): void {
		const from = out.length

		this.lowerBlock(node, out, sectionEnd)

		// A table's rows are charged as they are lowered.
		if (this.tableDepth === 0 && this.document.localName(node) !== "tbl")
			for (let k = from; k < out.length; k++) this.spend(out[k]?.length ?? 0)
	}

	private lowerBlock(node: number, out: string[], sectionEnd: (sectPr: string) => void): void {
		const document = this.document
		const local = document.localName(node)

		if (document.prefix(node) !== "w") {
			if (document.localName(node) === "AlternateContent") {
				const branch = this.alternate(node)

				if (branch >= 0)
					for (let child = document.firstChildElement(branch); child >= 0; child = document.nextSiblingElement(child))
						this.block(child, out, sectionEnd)
			} else if (document.textContent(node).trim() !== "") {
				this.lossy.add("unknownElement")
				out.push(`<w:p><w:r><w:t xml:space="preserve">${escText(document.textContent(node))}</w:t></w:r></w:p>`)
			}

			return
		}

		switch (local) {
			case "p":
				this.paragraph(node, out, sectionEnd)
				break
			case "tbl":
				// A table cannot start a page here: an empty paragraph does, before it.
				if (this.pendingBreak !== undefined) out.push(`<w:p><w:pPr>${this.breakBefore("", this.pendingBreak)}</w:pPr></w:p>`)

				this.pendingBreak = undefined
				out.push(this.table(node))
				break
			case "sdt": {
				this.lossy.add("contentControl")

				const content = this.child(node, "sdtContent")

				if (content >= 0)
					for (let child = document.firstChildElement(content); child >= 0; child = document.nextSiblingElement(child))
						this.block(child, out, sectionEnd)

				break
			}
			case "customXml":
				for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
					if (document.localName(child) !== "customXmlPr") this.block(child, out, sectionEnd)

				break
			case "bookmarkStart":
			case "bookmarkEnd":
				out.push(this.clean(node))
				break
			case "ins":
			case "del":
			case "moveFrom":
			case "moveTo":
				// Block-level revisions hold whole paragraphs or tables: their content as it shows.
				this.lossy.add("trackedChange")

				if (local === "ins" || local === "moveTo")
					for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
						this.block(child, out, sectionEnd)
				else if (document.textContent(node).trim() !== "") appendAll(out, this.deletedBlocks(node))

				break
			case "altChunk":
				this.lossy.add("altChunk")
				break
			case "permStart":
				this.lossy.add("documentProtection")
				break
			case "sectPr":
			case "proofErr":
			case "permEnd":
			case "commentRangeStart":
			case "commentRangeEnd":
				break
			default:
				if (document.textContent(node).trim() !== "") {
					this.lossy.add("unknownElement")
					out.push(`<w:p><w:r><w:t xml:space="preserve">${escText(document.textContent(node))}</w:t></w:r></w:p>`)
				}
		}
	}

	// Paragraphs a block-level deletion held, as tracked deletions of their text.
	private deletedBlocks(node: number): string[] {
		const document = this.document
		const blocks: string[] = []

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const text = document.textContent(child)

			if (text.trim() === "") continue

			blocks.push(
				this.tracked
					? `<w:p><w:del${this.attributes(node)}><w:r><w:delText xml:space="preserve">${escText(text)}</w:delText></w:r></w:del></w:p>`
					: ""
			)
		}

		return blocks.filter(block => block !== "")
	}

	private paragraph(node: number, out: string[], sectionEnd: (sectPr: string) => void): void {
		const pPr = this.child(node, "pPr")
		const sectPr = pPr < 0 ? -1 : this.child(pPr, "sectPr")
		const state: ParagraphOut = { out: "", depth: 0, splits: [], after: [], id: ++this.paragraphs }

		this.inline(node, state)

		// The paragraph mark's run properties (w:pPr/w:rPr) format the mark itself: they show in an empty paragraph only
		// (ODF has no mark; the emitter gives them to the paragraph's text).
		const empty = !/<w:(?:t|tab|br|cr|drawing|sym|footnoteReference|endnoteReference)\b/u.test(state.out)
		const properties = pPr < 0 ? "" : this.memo(empty ? "p" : "q", pPr, () => this.paragraphProperties(pPr, empty))

		// Pieces between page (column) breaks, as LibreOffice reads them: a break before anything visible is a break
		// before the paragraph; one after everything visible, a break before the next paragraph. A piece after a break
		// continues the paragraph on a new page, not numbered again.
		const continued = properties.replace(/<w:numPr>[\s\S]*?<\/w:numPr>|<w:numPr\/>/u, '<w:numPr><w:numId w:val="0"/></w:numPr>')
		const pieces: { markup: string; kind: "page" | "column" | undefined; properties: string }[] = []
		let from = 0
		let kind = this.pendingBreak

		this.pendingBreak = undefined

		for (const split of state.splits) {
			pieces.push({ markup: state.out.slice(from, split.at), kind, properties: pieces.length === 0 ? properties : continued })
			from = split.at
			kind = split.kind
		}

		pieces.push({ markup: state.out.slice(from), kind, properties: pieces.length === 0 ? properties : continued })

		while (pieces.length > 1 && !VISIBLE.test(pieces[0]?.markup ?? "")) {
			const [first, second] = pieces as [(typeof pieces)[number], (typeof pieces)[number]]

			pieces.splice(0, 2, { markup: first.markup + second.markup, kind: second.kind ?? first.kind, properties: first.properties })
		}

		while (pieces.length > 1 && !VISIBLE.test(pieces.at(-1)?.markup ?? "")) {
			const last = pieces.pop()
			const before = pieces.at(-1)

			if (last === undefined || before === undefined) break

			before.markup += last.markup
			this.pendingBreak = last.kind
		}

		for (const piece of pieces) {
			const head = piece.kind === undefined ? piece.properties : this.breakBefore(piece.properties, piece.kind)

			out.push(`<w:p>${head === "" ? "" : `<w:pPr>${head}</w:pPr>`}${piece.markup}</w:p>`)
		}

		appendAll(out, state.after)

		if (sectPr >= 0) sectionEnd(this.clean(sectPr))
	}

	private breakBefore(properties: string, kind: "page" | "column"): string {
		const without = properties.replace(/<w:pageBreakBefore[^>]*\/>/u, "")

		// A column break has no form in the emitter's properties (fo:break-before="column" is not one of them).
		if (kind === "column") {
			this.lossy.add("paragraphFormat")

			return without
		}

		// pageBreakBefore sits after pStyle, keepNext and keepLines (CT_PPr order).
		const match = /^(<w:pStyle[^>]*\/>)?(<w:keepNext[^>]*\/>)?(<w:keepLines[^>]*\/>)?/u.exec(without)
		const head = match?.[0] ?? ""

		return `${head}<w:pageBreakBefore/>${without.slice(head.length)}`
	}

	// --- Properties ---

	private paragraphProperties(pPr: number, mark = true): string {
		const document = this.document
		let props: Props | undefined
		let out = ""
		let styleId: string | undefined
		let numbered = false

		for (let child = document.firstChildElement(pPr); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (document.prefix(child) !== "w") continue
			if (local === "sectPr") continue
			if (local === "pPrChange") {
				this.lossy.add("trackedChange")

				continue
			}

			if (local === "rPr") {
				const markup = mark ? this.memo("m", child, () => this.runProperties(child, true)) : ""

				if (markup !== "") out += `<w:rPr>${markup}</w:rPr>`

				continue
			}

			if (local === "pStyle") {
				// A style the document does not define is its default paragraph style.
				const id = document.attribute(child, "w:val") ?? ""

				if (this.styles.paragraphStyles.has(id)) {
					styleId = id
					out += this.clean(child)
				}

				continue
			}

			if (local === "numPr") {
				const numId = document.attribute(this.child(child, "numId"), "w:val")

				numbered = true

				// Numbering the document does not define numbers nothing.
				if (numId === undefined || numId === "0" || this.styles.lists.has(numId)) out += this.clean(child)
				else out += '<w:numPr><w:numId w:val="0"/></w:numPr>'

				continue
			}

			if (PARAGRAPH_OWN.has(local)) {
				out += this.clean(child)

				continue
			}

			if (SILENT.has(local)) continue

			if (EAST_ASIAN.has(local)) {
				// East Asian line breaking and spacing (,,,,
				//): on by default, which ODF shows as it is; off has no form the writer gives.
				if (OFF.has(document.attribute(child, "w:val") ?? "true")) this.lossy.add("eastAsianTypography")

				continue
			}

			if (local === "spacing" || local === "ind") {
				const markup = this.measured(child)

				if (markup !== undefined) {
					out += markup

					continue
				}
			}

			if (local === "pBdr" && document.firstChildElement(child) < 0) continue

			props ??= readAll(document, pPr)

			const value = props.get(local)

			if (value !== undefined && paragraphAttributes(local, value, { tabsRelativeToIndent: true, marginLeft: 0 }) !== undefined)
				out += this.clean(child)
			else this.lossy.add("paragraphFormat")
		}

		out += this.fromStyle(styleId, numbered)

		// A numbered paragraph with an outline level of its own: written as the list item it is (a heading, text:h, in a
		// list does not show the list's label in LibreOffice); its outline level is not kept.
		if (/<w:outlineLvl\b/u.test(out) && /<w:numPr>(?![\s\S]*?<w:numId w:val="0"\/>)/u.test(out)) {
			this.lossy.add("paragraphFormat")
			out = out.replace(/<w:outlineLvl\b[^>]*\/>/u, "")
		}

		return out
	}

	// Spacing and indents in twips . Their East Asian forms in lines and characters (used
	// with a document grid) give way to the twips Word writes beside them; automatic spacing (an HTML paragraph's)
	// is 14 pt before and after, as LibreOffice 7.5 imports it. Undefined: written as it is.
	private measured(node: number): string | undefined {
		const document = this.document
		const local = document.localName(node)
		const attributes = document.attributes(node)
		const lines =
			local === "spacing"
				? ["beforeLines", "afterLines"]
				: ["leftChars", "rightChars", "firstLineChars", "hangingChars", "startChars", "endChars"]
		const automatic = local === "spacing" ? ["beforeAutospacing", "afterAutospacing"] : []

		if (!attributes.some(attribute => lines.includes(attribute.name.slice(2)) || automatic.includes(attribute.name.slice(2))))
			return undefined

		const kept = new Map<string, string>()

		for (const attribute of attributes) {
			const name = attribute.name.slice(2)

			if (!attribute.name.startsWith("w:") || lines.includes(name) || automatic.includes(name)) continue

			kept.set(attribute.name, attribute.value)
		}

		for (const name of lines) {
			const value = document.attribute(node, `w:${name}`)
			const twips = name.replace(/Lines$|Chars$/u, "")

			// Only a line or character count: its twips unknown without the grid.
			if (value !== undefined && Number(value) !== 0 && !kept.has(`w:${twips}`)) this.lossy.add("paragraphFormat")
		}

		for (const [name, side] of [
			["beforeAutospacing", "before"],
			["afterAutospacing", "after"]
		] as const) {
			if (!OFF.has(document.attribute(node, `w:${name}`) ?? "0")) {
				kept.set(`w:${side}`, "280")
				this.lossy.add("paragraphFormat")
			}
		}

		return `<w:${local}${[...kept].map(([name, value]) => ` ${name}="${escAttribute(value)}"`).join("")}/>`
	}

	// The numbering a paragraph's style gives, as its own (the emitter writes a paragraph's lists from its own
	// properties). A style's outline level stays the style's (style:default-outline-level).
	private fromStyle(styleId: string | undefined, numbered: boolean): string {
		const chain = this.styles.chains.paragraph(styleId).pPr
		let out = ""

		const numPr = numbered ? undefined : chain.get("numPr")

		if (numPr !== undefined) {
			const numId = /<numId val="([^"]*)"/u.exec(numPr.children)?.[1]
			const ilvl = /<ilvl val="([^"]*)"/u.exec(numPr.children)?.[1]

			// Numbering the document does not define numbers nothing.
			out +=
				numId !== undefined && numId !== "0" && this.styles.lists.has(numId)
					? `<w:numPr><w:ilvl w:val="${escAttribute(ilvl ?? "0")}"/><w:numId w:val="${escAttribute(numId)}"/></w:numPr>`
					: '<w:numPr><w:numId w:val="0"/></w:numPr>'
		}

		return out
	}

	private runProperties(rPr: number, mark = false): string {
		const document = this.document
		let props: Props | undefined
		let out = ""
		let shading = false
		let highlight: string | undefined

		for (let child = document.firstChildElement(rPr); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (document.prefix(child) !== "w") continue

			if (mark && MARK_REVISIONS.has(local)) {
				this.lossy.add("trackedChange")

				continue
			}

			if (local === "rPrChange") {
				this.lossy.add("trackedChange")

				continue
			}

			if (local === "rStyle") {
				if (this.styles.characterStyles.has(document.attribute(child, "w:val") ?? "")) out += this.clean(child)

				continue
			}

			if (local === "highlight") {
				const color = HIGHLIGHTS[document.attribute(child, "w:val") ?? ""]

				if (color !== undefined) highlight = color

				continue
			}

			if (local === "rFonts") {
				const fonts = this.fontsOf(child)

				if (fonts !== "") out += fonts

				continue
			}

			if (local === "shd") shading = true
			if (SILENT.has(local)) continue

			props ??= readAll(document, rPr)

			const value = props.get(local)

			if (value !== undefined && runAttributes(local, value, this.fonts, 12) !== undefined) out += this.clean(child)
			else this.lossy.add("runFormat")
		}

		// Highlighting as a background colour (ODF has one text background, fo:background-color).
		if (highlight !== undefined && !shading) out += `<w:shd w:val="clear" w:color="auto" w:fill="${highlight}"/>`

		return out
	}

	// w:rFonts with theme fonts resolved to the families the theme names.
	private fontsOf(node: number): string {
		const document = this.document
		const attributes: [string, string][] = []
		const theme = (value: string | undefined, script: "latin" | "eastAsia" | "cs"): string | undefined => {
			if (value === undefined || this.theme === undefined) return undefined

			const scheme = value.startsWith("major") ? this.theme.major : this.theme.minor
			const family = value.endsWith("EastAsia") ? scheme.eastAsia : value.endsWith("Bidi") ? scheme.cs : scheme[script]

			return family === "" ? undefined : family
		}

		for (const [name, themed, script] of [
			["ascii", "asciiTheme", "latin"],
			["hAnsi", "hAnsiTheme", "latin"],
			["eastAsia", "eastAsiaTheme", "eastAsia"],
			["cs", "cstheme", "cs"]
		] as const) {
			const fromTheme = theme(document.attribute(node, `w:${themed}`), script)
			const value = fromTheme ?? document.attribute(node, `w:${name}`)

			if (fromTheme !== undefined) this.lossy.add("theme")
			if (value !== undefined) attributes.push([`w:${name}`, value])
		}

		return attributes.length === 0
			? ""
			: `<w:rFonts${attributes.map(([name, value]) => ` ${name}="${escAttribute(value)}"`).join("")}/>`
	}

	// --- Inline content ---

	private inline(container: number, state: ParagraphOut): void {
		const document = this.document

		for (let node = document.firstChildElement(container); node >= 0; node = document.nextSiblingElement(node)) {
			const local = document.localName(node)
			const prefix = document.prefix(node)

			if (prefix === "m") {
				// Office Math: its text, as the equation's run of text.
				this.lossy.add("math")
				this.text(document.textContent(node), state)

				continue
			}

			if (prefix !== "w") {
				if (local === "AlternateContent") {
					const branch = this.alternate(node)

					if (branch >= 0) this.inline(branch, state)
				} else if (document.textContent(node).trim() !== "") {
					this.lossy.add("unknownElement")
					this.text(document.textContent(node), state)
				}

				continue
			}

			switch (local) {
				case "pPr":
					break
				case "r":
					this.run(node, state)
					break
				case "hyperlink":
					this.hyperlink(node, state)
					break
				case "fldSimple":
					this.simpleField(node, state)
					break
				case "ins":
				case "moveTo":
				case "del":
				case "moveFrom":
					this.change(node, local === "ins" || local === "moveTo" ? "ins" : "del", local.startsWith("move"), state)
					break
				case "sdt": {
					this.lossy.add("contentControl")

					const content = this.child(node, "sdtContent")

					if (content >= 0) this.inline(content, state)

					break
				}
				case "dir":
				case "bdo":
					// Their text's direction (embedding, override) has no ODF form: the text is kept in its own order.
					this.lossy.add("runFormat")
					this.inline(node, state)
					break
				case "smartTag":
				case "customXml":
					this.inline(node, state)
					break
				case "bookmarkStart":
				case "bookmarkEnd":
				case "commentRangeEnd":
					if (this.suppressed()) break

					state.out += this.clean(node)
					break
				case "commentRangeStart":
					this.startedComments.add(document.attribute(node, "w:id") ?? "")
					state.out += this.clean(node)
					break
				case "subDoc":
					this.lossy.add("subDocument")
					break
				case "permStart":
					// A range a restriction leaves editable: an OpenDocument text has no such range.
					this.lossy.add("documentProtection")
					break
				default:
					if (!DROPPED_INLINE.has(local) && !UNWRAPPED.has(local) && document.textContent(node).trim() !== "") {
						this.lossy.add("unknownElement")
						this.text(document.textContent(node), state)
					} else if (UNWRAPPED.has(local)) this.inline(node, state)
			}
		}
	}

	// Whether output is held back: inside a field's code.
	private suppressed(): boolean {
		return this.fields.some(field => field.phase === "code")
	}

	private hyperlink(node: number, state: ParagraphOut): void {
		const document = this.document
		const id = document.attribute(node, "r:id")
		const anchor = document.attribute(node, "w:anchor")
		const relationship = id === undefined ? undefined : this.links.relationship(id)
		let target: string | undefined

		// The anchor names a place in the target (ECMA-376 Part 1 §17.16.22): its fragment.
		if (relationship !== undefined && relationship.external)
			target = anchor === undefined ? relationship.target : `${relationship.target}#${fragment(anchor)}`
		else if (anchor !== undefined) target = `#${fragment(anchor)}`

		const linked = target === undefined || this.suppressed() ? undefined : this.linkId(target)

		if (linked === undefined) {
			this.inline(node, state)

			return
		}

		state.out += `<w:hyperlink r:id="${linked}">`
		state.depth++
		this.inline(node, state)
		state.depth--
		state.out += "</w:hyperlink>"
	}

	private change(node: number, kind: "ins" | "del", moved: boolean, state: ParagraphOut): void {
		if (moved) this.lossy.add("trackedChange")

		if (!this.tracked) {
			// Shown as accepted where ODF cannot track it.
			this.lossy.add("trackedChange")

			if (kind === "ins") this.inline(node, state)

			return
		}

		state.out += `<w:${kind}${this.attributes(node, ["w:author", "w:date", "w:id"])}>`
		state.depth++
		this.inline(node, state)
		state.depth--
		state.out += `</w:${kind}>`
	}

	// A simple field: PAGE and NUMPAGES as such, HYPERLINK as a hyperlink, any other as its result.
	private simpleField(node: number, state: ParagraphOut): void {
		const instruction = this.document.attribute(node, "w:instr") ?? ""
		const code = fieldCode(instruction)

		if (code === "PAGE" || code === "NUMPAGES") {
			state.out += `<w:fldSimple w:instr=" ${code} ">`
			this.inline(node, state)
			state.out += "</w:fldSimple>"

			return
		}

		const target = code === "HYPERLINK" ? hyperlinkTarget(instruction) : undefined
		const id = target === undefined ? undefined : this.linkId(target)

		if (id !== undefined) {
			state.out += `<w:hyperlink r:id="${id}">`
			this.inline(node, state)
			state.out += "</w:hyperlink>"

			return
		}

		this.lossy.add("field")
		this.inline(node, state)
	}

	private run(node: number, state: ParagraphOut): void {
		const document = this.document
		const rPrNode = this.child(node, "rPr")
		const rPr = rPrNode < 0 ? "" : this.memo("r", rPrNode, () => this.runProperties(rPrNode))
		const open = `<w:r>${rPr === "" ? "" : `<w:rPr>${rPr}</w:rPr>`}`
		let content = ""
		const flush = (): void => {
			if (content !== "") state.out += `${open}${content}</w:r>`
			content = ""
		}

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "fldChar") {
				flush()
				this.fieldChar(child, state)

				continue
			}

			if (local === "instrText") {
				const field = this.fields.at(-1)

				if (field !== undefined && field.phase === "code") field.code += document.textContent(child)

				continue
			}

			if (this.suppressed()) continue

			switch (local) {
				case "rPr":
				case "lastRenderedPageBreak":
				case "delInstrText":
				case "separator":
				case "continuationSeparator":
					break
				case "t":
				case "delText":
					content += `<w:${local} xml:space="preserve">${escText(document.textContent(child))}</w:${local}>`
					break
				case "tab":
				case "ptab":
					content += "<w:tab/>"
					break
				case "br": {
					const type = document.attribute(child, "w:type")

					if (type === "page" || type === "column") {
						if (state.depth === 0) {
							flush()
							state.splits.push({ at: state.out.length, kind: type })
						} else this.lossy.add("paragraphFormat")
					} else content += "<w:br/>"

					break
				}
				case "cr":
				case "softHyphen":
				case "noBreakHyphen":
				case "footnoteRef":
				case "endnoteRef":
				case "annotationRef":
					content += `<w:${local}/>`
					break
				case "footnoteReference":
				case "endnoteReference":
					if (this.inNotes) this.lossy.add("nestedNote")

					content += this.clean(child)
					break
				case "commentReference": {
					const id = document.attribute(child, "w:id") ?? ""

					// A comment with no range: a point comment where its mark is.
					if (!this.startedComments.has(id)) {
						flush()
						state.out += `<w:commentRangeStart w:id="${escAttribute(id)}"/>`
						this.startedComments.add(id)
					}

					content += this.clean(child)
					break
				}
				case "sym": {
					// A symbol (w:sym): its character in its font; a symbol font's (Symbol, Wingdings...) as the Unicode
					// character that font draws, in the run's own font.
					const char = Number.parseInt(document.attribute(child, "w:char") ?? "", 16)
					const font = document.attribute(child, "w:font")

					if (!Number.isFinite(char) || char <= 0 || char > 0x10ffff) break

					flush()

					const table = font === undefined ? undefined : symbolTable(font)
					const mapped = table === undefined ? 0 : symbolToUnicode(table, char)
					const symbolProps =
						font === undefined || mapped !== 0
							? rPr
							: `${rPr.replace(/<w:rFonts[^>]*\/>/u, "")}<w:rFonts w:ascii="${escAttribute(font)}" w:hAnsi="${escAttribute(font)}"/>`

					state.out += `<w:r>${symbolProps === "" ? "" : `<w:rPr>${sortedRun(symbolProps)}</w:rPr>`}<w:t xml:space="preserve">${escText(String.fromCodePoint(mapped === 0 ? char : mapped))}</w:t></w:r>`
					break
				}
				case "drawing":
					flush()
					this.drawing(child, open, state)
					break
				case "pict":
				case "object":
					flush()
					this.vml(child, open, state)
					break
				case "ruby": {
					// Its text and guide text, as text:ruby (Part 3 §6.4), each lowered as runs; its alignment and sizes
					// (w:rubyPr) are not kept.
					this.lossy.add("runFormat")
					flush()

					const piece = (local: string): string => {
						const container = this.child(child, local)
						const inner: ParagraphOut = { out: "", depth: state.depth + 1, splits: [], after: state.after, id: state.id }

						if (container >= 0) this.inline(container, inner)

						return inner.out
					}

					state.out += `${open}<w:ruby><w:rt>${piece("rt")}</w:rt><w:rubyBase>${piece("rubyBase")}</w:rubyBase></w:ruby></w:r>`

					break
				}
				case "AlternateContent": {
					const branch = this.alternate(child)

					if (branch >= 0) {
						flush()
						this.run(branch, state)
					}

					break
				}
				default:
					if (document.textContent(child).trim() !== "") {
						this.lossy.add("unknownElement")
						content += `<w:t xml:space="preserve">${escText(document.textContent(child))}</w:t>`
					}
			}
		}

		flush()
	}

	private fieldChar(node: number, state: ParagraphOut): void {
		const type = this.document.attribute(node, "w:fldCharType")

		if (type === "begin") {
			this.fields.push({ phase: "code", code: "", resultAt: -1, paragraph: state.id })

			return
		}

		const field = this.fields.at(-1)

		if (field === undefined) return

		if (type === "separate") {
			field.phase = "result"
			field.resultAt = this.suppressed() ? -1 : state.out.length
			field.paragraph = state.id

			return
		}

		if (type !== "end") return

		this.fields.pop()

		if (this.suppressed()) return

		const code = fieldCode(field.code)
		const local = field.paragraph === state.id && field.resultAt >= 0 && field.resultAt <= state.out.length

		if (local && (code === "PAGE" || code === "NUMPAGES")) {
			state.out = `${state.out.slice(0, field.resultAt)}<w:fldSimple w:instr=" ${code} ">${state.out.slice(field.resultAt)}</w:fldSimple>`

			return
		}

		const target = code === "HYPERLINK" ? hyperlinkTarget(field.code) : undefined

		if (local && target !== undefined && !state.splits.some(split => split.at > field.resultAt)) {
			const id = this.linkId(target)

			// A target no URI can name: the result stays as text, counted.
			if (id !== undefined)
				state.out = `${state.out.slice(0, field.resultAt)}<w:hyperlink r:id="${id}">${state.out.slice(field.resultAt)}</w:hyperlink>`

			return
		}

		// MACROBUTTON and GOTOBUTTON show the text their instruction ends with: as text.
		if ((code === "MACROBUTTON" || code === "GOTOBUTTON") && field.resultAt < 0) {
			const shown = field.code
				.trim()
				.split(/\s+/u)
				.slice(2)
				.join(" ")
				.replace(/^"(.*)"$/u, "$1")

			this.lossy.add("field")
			this.text(shown, state)

			return
		}

		// Fields without a result shown are nothing to keep (XE, TC, bookmarks of a TOC...).
		if (code !== "" && field.resultAt >= 0) this.lossy.add("field")
	}

	// A link target's package id, as a URI; undefined (counted) for a target no URI names.
	private linkId(target: string): string | undefined {
		const uri = linkUri(target)

		if (uri === undefined) this.lossy.add("linkTarget")

		return uri === undefined ? undefined : this.ids.hyperlink(uri)
	}

	// A text the converter could not keep as what it was, as plain text in a run.
	private text(text: string, state: ParagraphOut): void {
		if (text === "" || this.suppressed()) return

		state.out += `<w:r><w:t xml:space="preserve">${escText(text)}</w:t></w:r>`
	}

	// --- Drawings ---

	private drawing(node: number, runOpen: string, state: ParagraphOut): void {
		const document = this.document
		const holder = document.firstChildElement(node)

		if (holder < 0) return

		const placement = document.localName(holder)
		const blip = this.descendant(holder, "blip")
		const embed = blip < 0 ? undefined : (document.attribute(blip, "r:embed") ?? document.attribute(blip, "r:link"))
		const relationship = embed === undefined ? undefined : this.links.relationship(embed)
		const boxes = this.descendants(holder, "txbxContent")
		const shapes = this.descendants(holder, "wsp").length
		const keep = ["extent", "docPr", "positionH", "positionV", "simplePos", "effectExtent"]
		const wraps = ["wrapNone", "wrapSquare", "wrapTight", "wrapThrough", "wrapTopAndBottom"]
		let inner = ""

		for (let child = document.firstChildElement(holder); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (keep.includes(local) || wraps.includes(local)) inner += this.clean(child)
		}

		const attributes = this.attributes(holder, [
			"distT",
			"distB",
			"distL",
			"distR",
			"behindDoc",
			"relativeHeight",
			"allowOverlap",
			"layoutInCell"
		])

		// A picture, or a single text box shape: a frame of its own.
		if (relationship !== undefined && !relationship.external && boxes.length === 0 && this.descendants(holder, "pic").length > 0) {
			state.out += `${runOpen}<w:drawing><wp:${placement}${attributes}>${inner}<a:blip r:embed="${this.ids.picture(relationship.target)}"/></wp:${placement}></w:drawing></w:r>`

			return
		}

		if (boxes.length === 1 && shapes === 1 && this.descendants(holder, "wgp").length === 0) {
			const content = this.boxBlocks(boxes[0] ?? -1)

			state.out += `${runOpen}<w:drawing><wp:${placement}${attributes}>${inner}${this.boxLook(holder)}<w:txbxContent>${content}</w:txbxContent></wp:${placement}></w:drawing></w:r>`

			return
		}

		// Shapes, groups, charts, diagrams: not drawn; the text they hold written after the paragraph.
		this.lossy.add("drawing")

		for (const box of boxes) state.after.push(this.boxBlocks(box))
	}

	// A text box shape's insets (wps:bodyPr), outline (a:ln) and fill (a:solidFill) as the
	// converter's frame writer reads them: a:bodyPr insets, a:line value (an fo:border), a:fill color.
	private boxLook(holder: number): string {
		const document = this.document
		const body = this.descendant(holder, "bodyPr")
		let out = `<a:bodyPr${this.attributes(body, ["lIns", "tIns", "rIns", "bIns"])}/>`
		const shape = this.descendant(holder, "spPr")
		const rgb = (node: number): string | undefined => {
			const value = document.attribute(this.child(node, "srgbClr"), "val")

			return value !== undefined && /^[0-9A-Fa-f]{6}$/u.test(value) ? `#${value.toLowerCase()}` : undefined
		}

		if (shape < 0) return out

		const fill = this.child(shape, "solidFill")
		const fillColor = fill < 0 ? undefined : rgb(fill)

		if (fillColor !== undefined) out += `<a:fill color="${fillColor}"/>`

		const line = this.child(shape, "ln")

		if (line >= 0 && this.child(line, "noFill") < 0) {
			const lineFill = this.child(line, "solidFill")
			const color = lineFill < 0 ? undefined : rgb(lineFill)
			const width = Number(document.attribute(line, "w") ?? "9525") / 12_700

			if (color !== undefined) out += `<a:line value="${String(Math.round(width * 100) / 100)}pt solid ${color}"/>`
		}

		return out
	}

	// VML: an image's data as a picture; a text box's text after the paragraph; anything else not drawn.
	private vml(node: number, runOpen: string, state: ParagraphOut): void {
		const document = this.document
		const image = this.descendant(node, "imagedata")
		const id = image < 0 ? undefined : (document.attribute(image, "r:id") ?? document.attribute(image, "r:pict"))
		const relationship = id === undefined ? undefined : this.links.relationship(id)
		const boxes = this.descendants(node, "txbxContent")

		if (document.localName(node) === "object") this.lossy.add("embeddedObject")

		if (relationship !== undefined && !relationship.external) {
			const shape = document.parent(image)
			const style = document.attribute(shape, "style") ?? ""
			const size = (property: string): number => {
				const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([0-9.]+)(pt|in|cm|mm|px)?`, "u").exec(style)
				const value = Number(match?.[1] ?? "0")
				const unit = match?.[2] ?? "px"
				const points =
					unit === "pt"
						? value
						: unit === "in"
							? value * 72
							: unit === "cm"
								? (value * 72) / 2.54
								: unit === "mm"
									? (value * 72) / 25.4
									: value * 0.75

				return Math.round(points * 12_700)
			}

			state.out += `${runOpen}<w:drawing><wp:inline><wp:extent cx="${size("width")}" cy="${size("height")}"/><a:blip r:embed="${this.ids.picture(relationship.target)}"/></wp:inline></w:drawing></w:r>`

			if (boxes.length > 0 || this.descendants(node, "shape").length > 1) this.lossy.add("drawing")
		} else if (document.textContent(node).trim() !== "" || boxes.length > 0 || this.descendants(node, "shape").length > 0)
			this.lossy.add("drawing")

		for (const box of boxes) state.after.push(this.boxBlocks(box))

		// WordArt (v:textpath,: a watermark's "DRAFT"...): its text in a text box where the shape is.
		for (const path of this.descendants(node, "textpath")) {
			const text = document.attribute(path, "string") ?? ""

			if (text.trim() === "") continue

			this.lossy.add("drawing")
			state.out += `${runOpen}${this.textPathFrame(document.parent(path), text)}</w:r>`
		}
	}

	// A VML shape's place (CSS-like style: position, margins, mso-position-*) as the normalized anchor, holding `text`.
	private textPathFrame(shape: number, text: string): string {
		const style = this.document.attribute(shape, "style") ?? ""
		const property = (name: string): string | undefined =>
			new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "u").exec(style)?.[1]?.trim()
		const emu = (name: string): number => {
			const match = /^(-?[0-9.]+)(pt|in|cm|mm|px)?$/u.exec(property(name) ?? "0")
			const value = Number(match?.[1] ?? "0")
			const unit = match?.[2] ?? "px"
			const points =
				unit === "pt"
					? value
					: unit === "in"
						? value * 72
						: unit === "cm"
							? (value * 72) / 2.54
							: unit === "mm"
								? (value * 72) / 25.4
								: value * 0.75

			return Number.isFinite(points) ? Math.round(points * 12_700) : 0
		}
		const relative = (name: string, fallback: string): string => {
			const value = property(name)

			return value === "page" ? "page" : value === "text" || value === undefined ? fallback : value === "margin" ? "margin" : fallback
		}
		const axis = (tag: "positionH" | "positionV", align: string | undefined, offset: number, from: string): string =>
			`<wp:${tag} relativeFrom="${from}">${align === undefined || align === "absolute" ? `<wp:posOffset>${String(offset)}</wp:posOffset>` : `<wp:align>${escText(align)}</wp:align>`}</wp:${tag}>`
		const behind = /z-index:\s*-/u.test(style)

		return (
			`<w:drawing><wp:anchor${behind ? ' behindDoc="1"' : ""}><wp:extent cx="${String(emu("width"))}" cy="${String(emu("height"))}"/>` +
			axis(
				"positionH",
				property("mso-position-horizontal"),
				emu("margin-left"),
				relative("mso-position-horizontal-relative", "column")
			) +
			axis(
				"positionV",
				property("mso-position-vertical"),
				emu("margin-top"),
				relative("mso-position-vertical-relative", "paragraph")
			) +
			`<wp:wrapNone/><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"/><w:txbxContent><w:p><w:r><w:t xml:space="preserve">${escText(text)}</w:t></w:r></w:p></w:txbxContent></wp:anchor></w:drawing>`
		)
	}

	private boxBlocks(content: number): string {
		if (content < 0) return ""

		const document = this.document
		const saved = this.fields
		const pending = this.pendingBreak
		const blocks: string[] = []

		this.fields = []
		this.pendingBreak = undefined

		for (let child = document.firstChildElement(content); child >= 0; child = document.nextSiblingElement(child))
			this.block(child, blocks, () => undefined)

		this.fields = saved
		this.pendingBreak = pending

		return blocks.join("")
	}

	// --- Tables ---

	private table(node: number): string {
		this.tableDepth++

		try {
			return this.lowerTable(node)
		} finally {
			this.tableDepth--
		}
	}

	private lowerTable(node: number): string {
		const outer = this.tableWidth
		const parts = this.tableParts(node)
		let out = parts.head

		for (const row of parts.rows) out += this.row(row)

		this.tableWidth = outer

		return `${out}</w:tbl>`
	}

	// A table's start (w:tbl, its properties, its grid when it has rows) and its rows (in content controls too); the
	// table's width set, its cells counted.
	private tableParts(node: number): { readonly head: string; readonly rows: readonly number[] } {
		const document = this.document
		const rows: number[] = []
		let properties = ""

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (document.prefix(child) !== "w") {
				if (local === "AlternateContent") this.lossy.add("unknownElement")

				continue
			}

			if (local === "tblPr") {
				properties += this.tableProperties(child)

				if (this.styles.conditionalTables.has(document.attribute(this.child(child, "tblStyle"), "w:val") ?? ""))
					this.lossy.add("tableStyle")
			} else if (local === "tr") rows.push(child)
			else if (local === "sdt" || local === "customXml") appendAll(rows, this.wrapped(child, "tr"))
		}

		this.tableWidth = 0

		if (rows.length === 0) return { head: `<w:tbl>${properties}`, rows }

		// The grid goes before the first row (CT_Tbl: tblPr, tblGrid, rows).
		const grid = this.grid(node, this.child(node, "tblGrid"), rows.length)

		// Every row at the grid's width, before any is lowered.
		this.addCells(rows.length * this.tableWidth)

		return { head: `<w:tbl>${properties}${grid}`, rows }
	}

	// A long top-level table, lowered a few rows at a time (`tableRows`): what goes before it (a page break's
	// paragraph), its start, its rows and width.
	tableStream(node: number): {
		readonly before: string
		readonly head: string
		readonly rows: readonly number[]
		readonly width: number
	} {
		this.made = 0

		const before = this.pendingBreak === undefined ? "" : `<w:p><w:pPr>${this.breakBefore("", this.pendingBreak)}</w:pPr></w:p>`

		this.pendingBreak = undefined
		this.tableDepth++

		try {
			const parts = this.tableParts(node)

			return { before, head: parts.head, rows: parts.rows, width: this.tableWidth }
		} finally {
			this.tableDepth--
			this.tableWidth = 0
		}
	}

	tableRows(rows: readonly number[], width: number): string {
		this.made = 0
		this.tableDepth++
		this.tableWidth = width

		try {
			let out = ""

			for (const row of rows) out += this.row(row)

			return out
		} finally {
			this.tableDepth--
			this.tableWidth = 0
		}
	}

	// The table's grid, with as many columns as its widest row spans: Word lays a table out from its
	// rows when its grid has fewer (the extra cells would be hidden in an ODF table of the grid's columns).
	private grid(table: number, grid: number, rows: number): string {
		const document = this.document
		const columns = grid < 0 ? [] : this.children(grid).filter(column => document.localName(column) === "gridCol")
		let widest: number[] = []
		// Refused as soon as the rows at the widest width known are past the cells a conversion holds.
		const check = (width: number): void => {
			if (this.cells + rows * width > MAX_TABLE_CELLS)
				throw new TextConversionError("tooLarge", `Tables past ${String(MAX_TABLE_CELLS)} cells.`)
		}

		for (const row of this.children(table)) {
			if (document.localName(row) !== "tr") continue

			check(Math.max(widest.length, this.columns(row)))

			const widths: number[] = []
			const trPr = this.child(row, "trPr")
			const skip = (local: string): number => Number(document.attribute(this.child(trPr, local), "w:val") ?? "0") || 0

			for (let k = 0; k < skip("gridBefore"); k++) widths.push(Number.NaN)

			for (const cell of this.children(row)) {
				if (document.localName(cell) !== "tc") continue

				const tcPr = this.child(cell, "tcPr")
				const span = Math.max(1, Number(document.attribute(this.child(tcPr, "gridSpan"), "w:val") ?? "1") || 1)
				const width = this.child(tcPr, "tcW")
				const twips = document.attribute(width, "w:type") === "dxa" ? Number(document.attribute(width, "w:w")) : Number.NaN

				for (let k = 0; k < span; k++) widths.push(twips / span)
			}

			for (let k = 0; k < skip("gridAfter"); k++) widths.push(Number.NaN)

			if (widths.length > widest.length) widest = widths
		}

		this.tableWidth = Math.max(widest.length, columns.length)

		if (widest.length <= columns.length) {
			// Grid columns past what any row reaches, past what a table holds: left out (they hold no cell).
			if (columns.length <= MAX_TABLE_COLUMNS || widest.length === 0) return grid < 0 ? "" : this.clean(grid)

			this.lossy.add("tableLayout")
			this.tableWidth = widest.length

			return `<w:tblGrid>${columns
				.slice(0, widest.length)
				.map(column => this.clean(column))
				.join("")}</w:tblGrid>`
		}

		this.lossy.add("tableLayout")

		const known = columns.reduce((sum, column) => sum + (Number(document.attribute(column, "w:w")) || 0), 0)
		const fallback = Math.max(240, Math.round((known > 0 ? known : 9000) / widest.length))

		return `<w:tblGrid>${widest.map(width => `<w:gridCol w:w="${String(Number.isFinite(width) && width > 0 ? Math.round(width) : fallback)}"/>`).join("")}</w:tblGrid>`
	}

	// The grid columns a row spans (skipped ones included), read as numbers only; refused past MAX_TABLE_COLUMNS.
	private columns(row: number): number {
		const document = this.document
		const count = (node: number, fallback: number): number => {
			const value = Number(document.attribute(node, "w:val") ?? String(fallback))

			return Number.isNaN(value) ? fallback : Math.max(fallback, value)
		}
		let total = 0

		for (let child = document.firstChildElement(row); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) === "trPr") {
				for (let item = document.firstChildElement(child); item >= 0; item = document.nextSiblingElement(item)) {
					const name = document.localName(item)

					if (name === "gridBefore" || name === "gridAfter") total += count(item, 0)
				}
			} else for (const cell of this.wrapped(child, "tc")) total += count(this.child(this.child(cell, "tcPr"), "gridSpan"), 1)

			if (total > MAX_TABLE_COLUMNS)
				throw new TextConversionError("tooLarge", `A table row spans more than ${String(MAX_TABLE_COLUMNS)} columns.`)
		}

		return total
	}

	// Rows (cells) a row-level (cell-level) content control or custom XML element holds, at any depth; the element
	// itself when it is one.
	private wrapped(node: number, local: string): number[] {
		const name = node < 0 ? "" : this.document.localName(node)

		if (name === local) return [node]
		if (name === "permStart") this.lossy.add("documentProtection")
		if (name === "sdt") {
			this.lossy.add("contentControl")

			return this.wrapped(this.child(node, "sdtContent"), local)
		}

		return name === "customXml" || name === "sdtContent" ? this.children(node).flatMap(child => this.wrapped(child, local)) : []
	}

	private children(node: number): number[] {
		const out: number[] = []

		for (let child = this.document.firstChildElement(node); child >= 0; child = this.document.nextSiblingElement(child)) out.push(child)

		return out
	}

	private tableProperties(node: number): string {
		const document = this.document
		let out = ""

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "tblPrChange") {
				this.lossy.add("trackedChange")

				continue
			}

			out += this.clean(child)
		}

		return `<w:tblPr>${out}</w:tblPr>`
	}

	private row(node: number): string {
		const document = this.document

		// A row wider than the grid (one a content control holds): its cells past it.
		this.addCells(Math.max(0, this.columns(node) - this.tableWidth))

		let properties = ""
		let cells = ""
		let before = 0
		let after = 0

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "trPr") {
				for (let item = document.firstChildElement(child); item >= 0; item = document.nextSiblingElement(item)) {
					const name = document.localName(item)

					if (name === "gridBefore") before = Number(document.attribute(item, "w:val") ?? "0") || 0
					else if (name === "gridAfter") after = Number(document.attribute(item, "w:val") ?? "0") || 0
					else if (ROW_PROPERTIES.has(name)) properties += this.clean(item)
					else if (name === "ins" || name === "del" || name === "trPrChange") this.lossy.add("trackedChange")
					else if (name !== "wBefore" && name !== "wAfter" && name !== "cantSplit") this.lossy.add("tableLayout")
				}
			} else for (const cell of this.wrapped(child, "tc")) cells += this.cell(cell)
		}

		// Grid columns a row skips (w:gridBefore, w:gridAfter): empty cells without borders spanning them.
		const empty = (span: number): string =>
			span <= 0
				? ""
				: `<w:tc><w:tcPr>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders></w:tcPr><w:p/></w:tc>`

		const markup = `<w:tr>${properties === "" ? "" : `<w:trPr>${properties}</w:trPr>`}${empty(before)}${cells}${empty(after)}</w:tr>`

		if (this.tableDepth === 1) this.spend(markup.length)

		return markup
	}

	private addCells(cells: number): void {
		this.cells += cells

		if (this.cells > MAX_TABLE_CELLS) throw new TextConversionError("tooLarge", `Tables past ${String(MAX_TABLE_CELLS)} cells.`)
	}

	private cell(node: number): string {
		const document = this.document
		let properties = ""
		const blocks: string[] = []
		const pending = this.pendingBreak

		// A break ending a cell's last paragraph starts nothing outside the cell.
		this.pendingBreak = undefined

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "tcPr") properties += this.memo("c", child, () => this.cellProperties(child))
			else this.block(child, blocks, () => this.lossy.add("sectionLayout"))
		}

		this.pendingBreak = pending

		if (!blocks.some(block => block.startsWith("<w:p>") || block.startsWith("<w:p "))) blocks.push("<w:p/>")

		return `<w:tc>${properties === "" ? "" : `<w:tcPr>${properties}</w:tcPr>`}${blocks.join("")}</w:tc>`
	}

	private cellProperties(tcPr: number): string {
		const document = this.document
		let properties = ""

		for (let item = document.firstChildElement(tcPr); item >= 0; item = document.nextSiblingElement(item)) {
			const name = document.localName(item)

			if (!CELL_PROPERTIES.has(name)) {
				if (name === "tcPrChange" || name === "cellIns" || name === "cellDel" || name === "cellMerge")
					this.lossy.add("trackedChange")
				else if (name !== "noWrap" && name !== "tcFitText" && name !== "headers") this.lossy.add("tableLayout")

				continue
			}

			if (name === "textDirection" && document.attribute(item, "w:val") !== "tbRl") {
				this.lossy.add("tableLayout")

				continue
			}

			if (name === "tcBorders") {
				properties += this.cellBorders(item)

				continue
			}

			if (name === "shd") {
				const value = document.attribute(item, "w:val")
				const fill = document.attribute(item, "w:fill")

				if (value !== undefined && value !== "clear" && value !== "solid" && value !== "nil") {
					this.lossy.add("tableLayout")

					if (fill !== undefined && fill !== "auto")
						properties += `<w:shd w:val="clear" w:color="auto" w:fill="${escAttribute(fill)}"/>`

					continue
				}
			}

			properties += this.clean(item)
		}

		return properties
	}

	private cellBorders(node: number): string {
		const document = this.document
		let out = ""

		for (let side = document.firstChildElement(node); side >= 0; side = document.nextSiblingElement(side)) {
			if (CELL_SIDES.has(document.localName(side))) out += this.clean(side)
			else this.lossy.add("tableLayout")
		}

		return out === "" ? "" : `<w:tcBorders>${out}</w:tcBorders>`
	}

	// --- Helpers ---

	private alternate(node: number): number {
		const document = this.document
		let fallback = -1

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			// The Office 2010 drawing branch (wps, wpg, wp14) is what the converter reads; others fall back.
			if (local === "Choice" && /^(?:wps|wpg|wp14|w14)(?:\s|$)/u.test(document.attribute(child, "Requires") ?? "")) return child
			if (local === "Fallback" && fallback < 0) fallback = child
		}

		return fallback
	}

	private child(node: number, local: string): number {
		const document = this.document

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
			if (document.localName(child) === local) return child

		return -1
	}

	private descendant(node: number, local: string): number {
		return this.descendants(node, local, 1)[0] ?? -1
	}

	// Elements named `local` under `node`, in document order (not looking inside a match).
	private descendants(node: number, local: string, limit = Number.POSITIVE_INFINITY): number[] {
		const document = this.document
		const out: number[] = []
		const visit = (at: number): void => {
			for (let child = document.firstChildElement(at); child >= 0 && out.length < limit; child = document.nextSiblingElement(child)) {
				if (document.localName(child) === local) out.push(child)
				else visit(child)
			}
		}

		if (node >= 0) visit(node)

		return out
	}

	// The element's start tag attributes as markup, those with a kept prefix (or, with `only`, those named).
	private attributes(node: number, only?: readonly string[]): string {
		let out = ""

		for (const attribute of this.document.attributes(node)) {
			const name = attribute.name

			if (
				only !== undefined
					? !only.includes(name) && !only.includes(name.replace(/^w:/u, ""))
					: !KEPT_ATTRIBUTE_PREFIXES.has(prefixOf(name))
			)
				continue
			if (name.startsWith("xmlns")) continue

			const value = valueOf(this.document.localName(node), name, attribute.value)

			if (value === undefined) {
				this.lossy.add(this.document.localName(node) === "lang" ? "runFormat" : "unknownElement")

				continue
			}

			out += ` ${name}="${escAttribute(value)}"`
		}

		return out
	}

	// A border (a side of w:pBdr, w:tcBorders, w:tblBorders) the emitter draws: a style it has no form for (double,
	// thick, wave, art...) as a single line of its width, counted.
	private borderAttributes(node: number): string | undefined {
		const document = this.document

		if (!BORDER_CONTAINERS.has(document.localName(document.parent(node)))) return undefined

		const value = document.attribute(node, "w:val")

		if (value === undefined || BORDER_STYLES.has(value)) return undefined

		this.lossy.add("borderStyle")

		return this.attributes(node).replace(/ w:val="[^"]*"/u, ' w:val="single"')
	}

	// Spacing and indents with their East Asian forms (lines, characters) given way to the twips beside them
	// (or, without, left out and counted), and automatic spacing "off" left out: the forms the emitter reads.
	private measuredAttributes(node: number): string | undefined {
		const document = this.document
		const local = document.localName(node)

		if ((local !== "ind" && local !== "spacing") || document.prefix(node) !== "w") return undefined

		const attributes = this.attributes(node)
		let changed = attributes
		let found = false

		changed = changed.replace(
			/ w:(beforeLines|afterLines|leftChars|rightChars|firstLineChars|hangingChars|startChars|endChars)="([^"]*)"/gu,
			(_match, name: string, value: string) => {
				found = true

				if (Number(value) !== 0 && document.attribute(node, `w:${name.replace(/Lines$|Chars$/u, "")}`) === undefined)
					this.lossy.add("paragraphFormat")

				return ""
			}
		)
		changed = changed.replace(/ w:(beforeAutospacing|afterAutospacing)="([^"]*)"/gu, (match, name: string, value: string) => {
			if (!OFF.has(value)) return match

			found = true

			return name === "" ? match : ""
		})

		return found ? changed : undefined
	}

	// An element re-serialized with the prefixes the lowered story declares.
	private clean(node: number): string {
		const document = this.document
		const name = document.name(node)

		if (!KEPT_PREFIXES.has(prefixOf(name))) return ""

		let out = `<${name}${this.measuredAttributes(node) ?? this.borderAttributes(node) ?? this.attributes(node)}`
		let inner = ""

		for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
			const kind = document.kind(child)

			if (kind === NodeKind.Element) inner += this.clean(child)
			else if (kind === NodeKind.Text || kind === NodeKind.CData) inner += escText(document.text(child))
		}

		out += inner === "" ? "/>" : `>${inner}</${name}>`

		return out
	}
}

// Border styles the emitter writes (inverse.ts BORDER_STYLES, nil and none); containers of border sides.
const BORDER_STYLES = new Set([
	"single",
	"dotted",
	"dashed",
	"threeDEngrave",
	"threeDEmboss",
	"inset",
	"outset",
	"dotDash",
	"dotDotDash",
	"nil",
	"none"
])
const BORDER_CONTAINERS = new Set(["pBdr", "tcBorders", "tblBorders"])

// Half-point measures (ST_HpsMeasure), the others in twips or EMU as their element has them.
const HALF_POINTS = new Set(["sz", "szCs", "kern", "position"])
// ISO/IEC 29500-1 Strict writes measures with units (ST_UniversalMeasure): as transitional numbers here.
const UNIT = /^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/u
const POINTS_PER: Readonly<Record<string, number>> = { mm: 72 / 25.4, cm: 72 / 2.54, in: 72, pt: 1, pc: 12, pi: 12 }
const MEASURES = new Set([
	"w:val",
	"w:w",
	"w:h",
	"w:left",
	"w:right",
	"w:start",
	"w:end",
	"w:top",
	"w:bottom",
	"w:header",
	"w:footer",
	"w:gutter",
	"w:firstLine",
	"w:hanging",
	"w:before",
	"w:after",
	"w:line",
	"w:pos",
	"w:space"
])
// A language tag ST_Lang holds that BCP 47 does not (Word writes "es-ES_tradnl"): its language and region.
const LANGUAGE = /^([A-Za-z]{2,3})(?:-([A-Za-z]{2}|\d{3}))?/u

// An attribute value as the lowered story holds it; undefined to leave the attribute out.
function valueOf(element: string, name: string, value: string): string | undefined {
	if (element === "lang" && (name === "w:val" || name === "w:eastAsia" || name === "w:bidi")) {
		const match = LANGUAGE.exec(value)

		return match === null ? undefined : `${match[1] ?? ""}${match[2] === undefined ? "" : `-${match[2]}`}`
	}

	if (!MEASURES.has(name)) return value

	const unit = UNIT.exec(value)

	if (unit !== null) {
		const points = Number(unit[1]) * (POINTS_PER[unit[2] ?? "pt"] ?? 1)

		return String(Math.round(HALF_POINTS.has(element) ? points * 2 : points * 20))
	}

	if (HALF_POINTS.has(element) && name === "w:val" && !/^-?\d+$/u.test(value)) return undefined
	// A font size is positive.
	if ((element === "sz" || element === "szCs") && name === "w:val" && Number(value) <= 0) return undefined

	return value
}

// A field instruction's code: its first word, upper case.
export function fieldCode(instruction: string): string {
	return (instruction.trim().split(/\s+/u)[0] ?? "").toUpperCase()
}

// HYPERLINK's target: its URL, its \l bookmark as the fragment, or both. Quoted text holds a backslash or quotation
// mark preceded by a backslash (ECMA-376 Part 1 §17.16.1).
export function hyperlinkTarget(instruction: string): string | undefined {
	const anchor = /\\l\s+"((?:[^"\\]|\\.)*)"|\\l\s+(\S+)/u.exec(instruction)
	const place = anchor === null ? undefined : `#${fragment(unescapeField(anchor[1]) ?? anchor[2] ?? "")}`
	const url = /HYPERLINK\s+"((?:[^"\\]|\\.)*)"|HYPERLINK\s+(\S+)/iu.exec(instruction)
	const found = unescapeField(url?.[1]) ?? url?.[2]
	const target = found === undefined || found === "" || found.startsWith("\\") ? undefined : found

	return target === undefined ? place : `${target}${place ?? ""}`
}

function unescapeField(text: string | undefined): string | undefined {
	return text?.replace(/\\([\\"])/gu, "$1")
}

// A bookmark or anchor name as a URI fragment (RFC 3986 §3.5): every character but pchar, "/" and "?" percent-encoded
// as UTF-8, "#" among them, and "%" but where it begins an escape already (§2.4).
function fragment(name: string): string {
	let out = ""
	let at = 0

	for (const char of name) {
		if (URI_CHARACTERS.includes(char) || (char === "%" && /^[0-9A-Fa-f]{2}$/u.test(name.slice(at + 1, at + 3)))) out += char
		else for (const byte of UTF8.encode(char)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`

		at += char.length
	}

	return out
}

// Characters a URI holds as they are (RFC 3986 §2.2, §2.3), but "#" (one only) and "%" (an escape only).
const URI_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?@!$&'()*+,;="
const UTF8 = new TextEncoder()

// A link target as a URI (RFC 3986), encoded the way LibreOffice encodes one: a Windows path as a file URI, every other character
// percent-encoded as UTF-8 (RFC 3987 §3.1), a fragment's further "#" too; a relative reference whose first segment
// holds ":" behind "./" (RFC 3986 §4.2). Undefined for a target that names nothing: empty, or a scheme alone.
export function linkUri(target: string): string | undefined {
	let text = target.trim()

	if (/^[A-Za-z]:[\\/]/u.test(text)) text = `file:///${text.replaceAll("\\", "/")}`
	else if (text.startsWith("\\\\")) text = `file:${text.replaceAll("\\", "/")}`

	const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.exec(text)?.[0]

	if (text === "" || (scheme !== undefined && scheme.length === text.length)) return undefined

	// An IP literal's brackets (§3.2.2) stay in the authority only.
	const authority = scheme !== undefined && text.startsWith("//", scheme.length) ? scheme.length + 2 : -1
	const authorityLength = authority < 0 ? -1 : (/[/?#]|$/u.exec(text.slice(authority))?.index ?? 0)
	let out = ""
	let fragment = false

	for (let at = 0; at < text.length;) {
		const char = String.fromCodePoint(text.codePointAt(at) ?? 0)
		const kept =
			URI_CHARACTERS.includes(char) ||
			((char === "[" || char === "]") && at >= authority && at < authority + authorityLength) ||
			(char === "#" && !fragment) ||
			(char === "%" && /^[0-9A-Fa-f]{2}$/u.test(text.slice(at + 1, at + 3)))

		if (char === "#") fragment = true

		if (kept) out += char
		else for (const byte of UTF8.encode(char)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`

		at += char.length
	}

	return scheme === undefined && /^[^/?#]*:/u.test(out) ? `./${out}` : out
}

// Run property children in schema order once rFonts was moved (sym).
function sortedRun(markup: string): string {
	const fonts = /<w:rFonts[^>]*\/>/u.exec(markup)?.[0]

	if (fonts === undefined) return markup

	const rest = markup.replace(fonts, "")
	const style = /^<w:rStyle[^>]*\/>/u.exec(rest)?.[0] ?? ""

	return `${style}${fonts}${rest.slice(style.length)}`
}

function readAll(document: XmlDocument, container: number): Props {
	const props: Props = new Map()

	readProps(document, container, props)

	return props
}

import { NodeKind, type Namespaces, type XmlDocument } from "../xml/index"
import {
	canonicalAttributes,
	elementName,
	parseLength,
	type OdfDataStyle,
	type OdfPackage,
	type OdfStyleResolver,
	type OdfStyleSheet,
	type StyleScope
} from "../odf/index"
import { MarkupFlow, paragraph, type Flow, type ParagraphBlock } from "./flow"
import { Frames } from "./frames"
import { listIndent, levelGeometry, Lists } from "./lists"
import { Pages } from "./pages"
import { modeRtl, paragraphProperties, runProperties, type Attributes, type PropsSink } from "./props"
import { StyleMapper } from "./styles"
import { translateTable } from "./tables"
import type { OdtLossyReason } from "./types"
import { OdtScanError } from "./scan"
import { esc, escText, PartWriter, REL } from "./wml"

// Nested blocks and spans (each frame, table cell, note or list level adds about two).
const MAX_NESTING = 128

// The ODT body and stories as WordprocessingML. Blocks come from the body scanner a batch at a time (or from
// styles.xml for headers and footers); the translator reads them through `document`/`namespaces`, which
// point at whichever tree holds the element being translated.

export interface TranslatorSettings {
	readonly tabsRelativeToIndent: boolean
	// What the style caches keep at most (StyleOptions.keepAtMost): a document read once, in order.
	readonly keepAtMost?: number
}

// Where a paragraph sits in a list.
export interface ListContext {
	readonly instance: ReturnType<Lists["open"]>
	// 1-based nesting level.
	readonly level: number
	// The list item's first paragraph gets the label; later ones (and list headers) are indented without.
	labelled: boolean
}

interface ChangeRecord {
	readonly kind: "insertion" | "deletion" | "format"
	readonly author: string
	readonly date: string
	// For a deletion: the deleted text as runs (w:delText).
	deleted: string
	// For a deletion: it holds one paragraph at most and nothing else, which `deleted` shows whole.
	readonly whole: boolean
}

// Elements that carry nothing to show or are read elsewhere.
const IGNORED_BLOCKS: ReadonlySet<string> = new Set([
	"text:sequence-decls",
	"text:variable-decls",
	"text:user-field-decls",
	"text:dde-connection-decls",
	"office:forms",
	"text:soft-page-break",
	"table:calculation-settings",
	"table:content-validations",
	"table:label-ranges",
	"text:alphabetical-index-auto-mark-file",
	"office:event-listeners"
])

export const PASS_THROUGH_INLINE: ReadonlySet<string> = new Set([
	"text:meta",
	"text:ruby-base",
	"text:date",
	"text:time",
	"text:title",
	"text:subject",
	"text:author-name",
	"text:author-initials",
	"text:file-name",
	"text:template-name",
	"text:sheet-name",
	"text:chapter",
	"text:initial-creator",
	"text:creation-date",
	"text:creation-time",
	"text:description",
	"text:keywords",
	"text:editing-cycles",
	"text:editing-duration",
	"text:print-date",
	"text:print-time",
	"text:printed-by",
	"text:modification-date",
	"text:modification-time",
	"text:creator",
	"text:word-count",
	"text:paragraph-count",
	"text:character-count",
	"text:table-count",
	"text:image-count",
	"text:object-count",
	"text:drop-down",
	"text:text-input",
	"text:placeholder",
	"text:sender-firstname",
	"text:sender-lastname",
	"text:sender-company",
	"text:sender-email",
	"text:sender-street",
	"text:sender-city",
	"text:sender-postal-code",
	"text:sender-country",
	"text:sender-phone-work",
	"text:sender-fax",
	"text:sender-title",
	"text:sender-position",
	"text:sender-initials",
	"text:sender-phone-private",
	"text:sender-state-or-province",
	"text:measure",
	"text:script",
	"text:execute-macro",
	"text:dde-connection",
	"text:alphabetical-index-mark",
	"field:fieldmark"
])

// Fields whose shown result is kept as text with no WordprocessingML field behind it.
export const FIELDS_AS_TEXT: ReadonlySet<string> = new Set([
	"text:sequence",
	"text:variable-get",
	"text:variable-set",
	"text:variable-input",
	"text:user-field-get",
	"text:user-field-input",
	"text:expression",
	"text:conditional-text",
	"text:database-display",
	"text:database-name",
	"text:database-next",
	"text:database-row-number",
	"text:database-row-select",
	"text:user-defined",
	"text:table-formula"
])

const SKIPPED_INLINE: ReadonlySet<string> = new Set([
	"text:soft-page-break",
	"text:alphabetical-index-mark-start",
	"text:alphabetical-index-mark-end",
	"text:toc-mark",
	"text:toc-mark-start",
	"text:toc-mark-end",
	"text:user-index-mark",
	"text:user-index-mark-start",
	"text:user-index-mark-end",
	"field:fieldmark-start",
	"field:fieldmark-end",
	"text:hidden-paragraph",
	"draw:glue-point"
])

// Whitespace and run state while a paragraph's content is walked (Part 3 §6.1.2).
interface InlineState {
	// No character written yet, or the last one written was a collapsible space.
	trimLeading: boolean
}

class Runs {
	private out = ""
	private text = ""
	private rPr = ""
	// The run's origin attribute (w:rsidR naming the text:span it came from), "" for none.
	private origin = ""
	private readonly translator: Translator

	constructor(translator: Translator) {
		this.translator = translator
	}

	addText(text: string, rPr: string, origin = ""): void {
		if (text === "") return
		if (rPr !== this.rPr || origin !== this.origin) this.flush()

		this.rPr = rPr
		this.origin = origin
		this.text += text
	}

	addRun(inner: string, rPr: string, origin = ""): void {
		this.flush()
		this.out += this.wrap(`<w:r${origin}>${rPr === "" ? "" : `<w:rPr>${rPr}</w:rPr>`}${inner}</w:r>`)
	}

	addRaw(markup: string): void {
		this.flush()
		this.out += markup
	}

	flush(): void {
		if (this.text === "") return

		let inner = ""
		let from = 0
		const text = this.text
		const tag = this.translator.deleting ? "w:delText" : "w:t"

		for (let k = 0; k < text.length; k++) {
			const code = text.charCodeAt(k)

			if (code !== 0xad && code !== 0x2011) continue
			if (k > from) inner += `<${tag} xml:space="preserve">${escText(text.slice(from, k))}</${tag}>`

			inner += code === 0xad ? "<w:softHyphen/>" : "<w:noBreakHyphen/>"
			from = k + 1
		}

		if (from < text.length) inner += `<${tag} xml:space="preserve">${escText(text.slice(from))}</${tag}>`

		this.out += this.wrap(`<w:r${this.origin}>${this.rPr === "" ? "" : `<w:rPr>${this.rPr}</w:rPr>`}${inner}</w:r>`)
		this.text = ""
	}

	result(): string {
		this.flush()

		return this.out
	}

	private wrap(run: string): string {
		const insertion = this.translator.insertion

		return insertion === undefined
			? run
			: `<w:ins w:id="${this.translator.id()}" w:author="${esc(insertion.author)}" w:date="${esc(insertion.date)}">${run}</w:ins>`
	}
}

export class Translator implements PropsSink {
	readonly sheet: OdfStyleSheet
	readonly resolver: OdfStyleResolver
	readonly odf: OdfPackage
	readonly styles: StyleMapper
	readonly lists: Lists
	readonly pages: Pages
	readonly frames: Frames
	readonly settings: TranslatorSettings
	document!: XmlDocument
	namespaces!: Namespaces
	scope: StyleScope = "content"

	// Relationships of word/document.xml beyond the fixed ones, media to copy, and the story parts.
	readonly relationships: string[] = []
	readonly footnotes = new PartWriter()
	readonly endnotes = new PartWriter()
	readonly comments = new PartWriter()
	commentCount = 0
	noteCount = 0
	endnoteCount = 0
	private nextRelationship = 100
	private nextId = 1
	// Blocks and spans open (see enter).
	private depth = 0
	private readonly bookmarkIds = new Map<string, number>()
	private readonly changes = new Map<string, ChangeRecord>()
	// Comment ranges open where the walk is (office:annotation name to comment id), of the story being translated.
	private openAnnotations = new Map<string, number>()
	// The tracked insertion open where the walk is: each run and paragraph mark it covers gets a w:ins of its own id.
	insertion: { readonly author: string; readonly date: string } | undefined = undefined
	deleting = false

	// Lossy reasons of the top-level block being translated, and across the document.
	readonly blockLossy = new Set<OdtLossyReason>()
	readonly lossyCounts = new Map<OdtLossyReason, number>()
	readonly objectKinds = new Map<string, number>()
	// Frames anchored to the page, waiting for the next paragraph to carry them.
	readonly pendingAnchors: string[] = []
	// A page break the last block asked for after itself (fo:break-after).
	breakAfter = false
	// The available width of the story being translated (points), for relative table widths.
	readonly widths: number[] = []
	// The direction a paragraph's "page" writing mode takes when a header or footer, table cell or frame sets it
	// (true right to left); undefined: the current section's page.
	direction: boolean | undefined = undefined

	constructor(odf: OdfPackage, sheet: OdfStyleSheet, resolver: OdfStyleResolver, settings: TranslatorSettings) {
		this.odf = odf
		this.sheet = sheet
		this.resolver = resolver
		this.settings = settings
		this.styles = new StyleMapper(sheet, resolver, {
			tabsRelativeToIndent: settings.tabsRelativeToIndent,
			...(settings.keepAtMost === undefined ? {} : { keepAtMost: settings.keepAtMost })
		})
		this.lists = new Lists(sheet)
		this.pages = new Pages(this)
		this.frames = new Frames(this)
	}

	lossy(reason: OdtLossyReason): void {
		this.blockLossy.add(reason)
	}

	// Ends a top-level block's bookkeeping: its lossy reasons, counted for the document.
	takeLossy(): OdtLossyReason[] {
		const reasons = [...this.blockLossy]

		for (const reason of reasons) this.lossyCounts.set(reason, (this.lossyCounts.get(reason) ?? 0) + 1)

		this.blockLossy.clear()

		return reasons
	}

	// Reasons outside any block (styles.xml's defaults and common styles, note settings): each counts once
	// where no block had it.
	takeDocumentLossy(): void {
		for (const reason of this.blockLossy) if (!this.lossyCounts.has(reason)) this.lossyCounts.set(reason, 1)

		this.blockLossy.clear()
	}

	id(): number {
		return this.nextId++
	}

	// The state a top-level block of the body starts in, as a key: the master page it is on; undefined when it
	// carries more than that (a page break or frames waiting for the next paragraph, an annotation or tracked change
	// open, columns).
	blockState(): string | undefined {
		if (
			this.breakAfter ||
			this.pendingAnchors.length > 0 ||
			this.openAnnotations.size > 0 ||
			this.insertion !== undefined ||
			this.deleting ||
			this.depth !== 0
		)
			return undefined

		return this.pages.plainMaster()
	}

	// Whether what was translated left nothing a later block reads (lists, notes, comments, relationships, ids,
	// bookmarks, tracked changes, pictures, sections, header and footer parts) and ends in state `state`.
	leftAsIn(state: string): boolean {
		return (
			this.lists.empty &&
			this.noteCount === 0 &&
			this.endnoteCount === 0 &&
			this.commentCount === 0 &&
			this.relationships.length === 0 &&
			this.nextRelationship === 100 &&
			this.nextId === 1 &&
			this.bookmarkIds.size === 0 &&
			this.changes.size === 0 &&
			this.objectKinds.size === 0 &&
			this.frames.media.length === 0 &&
			this.pages.sections.length === 0 &&
			this.pages.parts.size === 0 &&
			this.blockState() === state
		)
	}

	relationship(type: string, target: string, external: boolean): string {
		const id = `rId${this.nextRelationship++}`

		this.relationships.push(
			`<Relationship Id="${id}" Type="${REL}${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ""}/>`
		)

		return id
	}

	name(node: number): string {
		return elementName(this.document, this.namespaces, node)
	}

	attributes(node: number): Map<string, string> {
		return canonicalAttributes(this.document, this.namespaces, node)
	}

	get width(): number {
		return this.widths[this.widths.length - 1] ?? this.pages.textWidth
	}

	// --- Blocks ---

	// The block-level children of `container` (a list item, cell, note body, text box, section, region).
	blocks(container: number, flow: Flow, list?: ListContext): void {
		for (let child = this.document.firstChildElement(container); child >= 0; child = this.document.nextSiblingElement(child)) {
			this.block(child, flow, list)
		}
	}

	// The blocks of a story of its own (a cell, note body, text box, header or footer): comment ranges it opens end in
	// it, as ranges of the body end in the body.
	storyBlocks(container: number, flow: Flow): void {
		const outer = this.openAnnotations

		this.openAnnotations = new Map()
		this.blocks(container, flow)
		this.closeOpenAnnotations(flow)
		this.openAnnotations = outer
	}

	// Comment ranges no office:annotation-end closed: ended after the content of the story's last paragraph.
	closeOpenAnnotations(flow: Flow): void {
		if (this.openAnnotations.size === 0) return

		const runs = new Runs(this)

		for (const id of this.openAnnotations.values()) this.closeAnnotation(id, runs)

		this.openAnnotations.clear()
		flow.appendToLast(runs.result())
	}

	// One block element, its translation added to `flow`.
	block(node: number, flow: Flow, list?: ListContext): void {
		this.enter()
		this.blockAt(node, flow, list)
		this.leave()
	}

	// Blocks and spans nest through frames, tables, notes and lists; past MAX_NESTING the document is refused as
	// malformed rather than overflowing the stack (a worker's is smaller than Node's).
	enter(): void {
		if (++this.depth > MAX_NESTING) throw new OdtScanError("Content is nested too deeply")
	}

	leave(): void {
		this.depth--
	}

	private blockAt(node: number, flow: Flow, list?: ListContext): void {
		const name = this.name(node)

		switch (name) {
			case "text:p":
				this.paragraph(node, false, flow, list)
				break
			case "text:h":
				this.paragraph(node, true, flow, list)
				break
			case "text:list":
				this.list(node, flow, list)
				break
			case "text:numbered-paragraph":
				this.lossy("listLevel")
				this.blocks(node, flow)
				break
			case "table:table":
				translateTable(this, node, flow)
				break
			case "text:section":
				this.section(node, flow, list)
				break
			case "text:table-of-content":
			case "text:alphabetical-index":
			case "text:illustration-index":
			case "text:table-index":
			case "text:object-index":
			case "text:user-index":
			case "text:bibliography":
				this.lossy("index")

				for (let child = this.document.firstChildElement(node); child >= 0; child = this.document.nextSiblingElement(child)) {
					if (this.name(child) === "text:index-body") this.blocks(child, flow, list)
				}

				break
			case "text:index-title":
			case "text:index-body":
				this.blocks(node, flow, list)
				break
			case "text:tracked-changes":
				this.trackedChanges(node)
				break
			case "draw:frame":
			case "draw:custom-shape":
			case "draw:rect":
			case "draw:ellipse":
			case "draw:circle":
			case "draw:line":
			case "draw:polyline":
			case "draw:polygon":
			case "draw:path":
			case "draw:connector":
			case "draw:g":
			case "draw:a":
			case "draw:caption":
			case "draw:measure":
			case "dr3d:scene":
				// Frames anchored to the page sit in the body: the next paragraph carries them.
				this.pendingAnchors.push(this.frames.translate(node, "page"))
				break
			case "text:change": {
				// A deletion between blocks (Part 3 §5.5.8.4): the deleted paragraph shown deleted, its mark too
				// (ECMA-376 Part 1 §17.13.5.15), so rejecting it brings the paragraph back.
				const record = this.changes.get(this.attributes(node).get("text:change-id") ?? "")

				// What the paragraph cannot show (more paragraphs, a table) is left out.
				if (record?.kind === "deletion" && !record.whole) this.lossy("trackedChange")

				if (record?.kind === "deletion" && record.deleted !== "") {
					const author = esc(record.author)
					const date = esc(record.date)

					flow.add(
						paragraph(
							"",
							`<w:del w:id="${this.id()}" w:author="${author}" w:date="${date}"/>`,
							`<w:del w:id="${this.id()}" w:author="${author}" w:date="${date}">${record.deleted}</w:del>`
						)
					)
				}

				break
			}
			case "text:change-start":
			case "text:change-end":
				this.inlineChange(name, this.attributes(node))
				break
			case "text:bookmark":
			case "text:bookmark-start":
			case "text:bookmark-end":
				this.lossy("bookmark")
				break
			default:
				if (!IGNORED_BLOCKS.has(name)) {
					this.lossy("unknownElement")
					this.blocks(node, flow, list)
				}
		}
	}

	private list(node: number, flow: Flow, outer: ListContext | undefined): void {
		const attributes = this.attributes(node)
		const styleName = attributes.get("text:style-name")
		let instance = outer?.instance

		if (outer === undefined || (styleName !== undefined && styleName !== outer.instance?.style)) {
			const name = styleName ?? outer?.instance?.style

			instance =
				name === undefined
					? undefined
					: this.lists.open(
							name,
							this.scope,
							attributes.get("text:continue-numbering") === "true",
							attributes.get("text:continue-list"),
							attributes.get("xml:id"),
							this
						)
		}

		const level = (outer?.level ?? 0) + 1

		if (level > 9) this.lossy("listLevel")

		for (let item = this.document.firstChildElement(node); item >= 0; item = this.document.nextSiblingElement(item)) {
			const itemName = this.name(item)

			if (itemName !== "text:list-item" && itemName !== "text:list-header") {
				if (itemName !== "text:soft-page-break") this.lossy("unknownElement")

				continue
			}

			const start = Number(this.attributes(item).get("text:start-value") ?? "NaN")

			if (instance !== undefined && Number.isInteger(start)) this.lists.restart(instance, Math.min(level, 9) - 1, start)

			this.blocks(item, flow, { instance, level, labelled: itemName === "text:list-header" })
		}
	}

	private section(node: number, flow: Flow, list: ListContext | undefined): void {
		const steps = this.sectionSteps(node, flow, list)

		while (steps.next().done !== true) continue
	}

	// As block, a step given between the blocks of a section (one can hold most of a document).
	// The offset in content.xml of the parsed document's byte 0 for the block being translated (undefined: no
	// offsets are known, as in styles.xml or a run read on its own).
	blockBase: number | undefined

	private readonly untranslatedSpans = new Map<string, boolean>()

	// Whether a span style says what its WordprocessingML does not (props.ts: untranslatedText).
	private untranslatedSpan(name: string): boolean {
		let found = this.untranslatedSpans.get(name)

		if (found === undefined) {
			let lossy = false

			runProperties(this.sheet, this.styles.text(name, this.scope).own, {
				lossy: reason => (lossy ||= reason === "untranslatedText")
			})
			found = lossy
			this.untranslatedSpans.set(name, found)
		}

		return found
	}

	*blockSteps(node: number, flow: Flow): Generator<void> {
		if (this.name(node) !== "text:section") {
			this.block(node, flow)

			return
		}

		this.enter()
		yield* this.sectionSteps(node, flow, undefined)
		this.leave()
	}

	private *sectionSteps(node: number, flow: Flow, list: ListContext | undefined): Generator<void> {
		const attributes = this.attributes(node)

		const display = attributes.get("text:display")

		if (display === "none") return

		if (display === "condition") {
			// Hidden while its condition is true (Part 3 §5.4): only a constant one is known; one that is not stays hidden,
			// flagged.
			const hidden = constantCondition(attributes.get("text:condition"))

			if (hidden === undefined) this.lossy("sectionProperties")
			if (hidden !== false) return
		}

		if (attributes.get("text:protected") === "true") this.lossy("sectionProperties")

		const style = this.sheet.style("section", attributes.get("text:style-name") ?? "", this.scope)
		const properties = style?.properties.get("section")
		const columns = properties?.children.find(child => child.name === "style:columns")
		const count = Number(columns?.attributes.get("fo:column-count") ?? "1") || 1

		if (
			properties?.attributes.get("text:dont-balance-text-columns") === "true" ||
			properties?.attributes.has("fo:margin-left") === true
		) {
			this.lossy("sectionProperties")
		}

		const columned = flow.body && count > 1

		if (columned) this.pages.openColumns(columns)

		for (let child = this.document.firstChildElement(node); child >= 0; child = this.document.nextSiblingElement(child)) {
			if (list === undefined) yield* this.blockSteps(child, flow)
			else this.block(child, flow, list)

			yield
		}

		if (columned) this.pages.closeColumns()
	}

	// --- Paragraphs ---

	paragraph(node: number, heading: boolean, flow: Flow, list: ListContext | undefined): void {
		const attributes = this.attributes(node)
		const styleName = attributes.get("text:style-name")
		const style = this.styles.paragraph(styleName, this.scope)
		let pPr = ""

		for (const reason of style.reasons) this.lossy(reason)
		let pageBreak = this.breakAfter

		this.breakAfter = false

		if (flow.body) {
			const master = this.resolver.inherited("paragraph", styleName, this.scope, "style:master-page-name")
			const pageNumber = style.resolvedParagraph.get("style:page-number")

			if (master !== undefined && master !== "" && this.sheet.masterPages.has(master)) {
				if (this.pages.pageStyle(master, pageNumber)) pageBreak = false
				else pageBreak = true
			} else {
				this.pages.begin()
			}
		}

		if (style.paragraph.get("fo:break-after") === "page") this.breakAfter = true
		if (style.paragraph.get("fo:break-before") === "column") this.lossy("sectionProperties")

		// Numbering: the list around the paragraph, else a heading's outline numbering, else its style's list.
		let numPr = ""
		let indent: { left: number; firstLine: number } | undefined
		// Where tab stops count from (TabsRelativeToIndent): a label-alignment list level's indent where it applies
		// (SwTextNode::GetLeftMarginForTabCalculation), else the paragraph's own left margin.
		let tabLeft = parseLength((style.ownIndent ? style.paragraph : style.resolvedParagraph).get("fo:margin-left")) ?? 0
		const listStyleName = this.resolver.inherited("paragraph", styleName, this.scope, "style:list-style-name")

		if (list !== undefined && list.instance !== undefined) {
			const ilvl = Math.min(list.level, 9) - 1
			const levelStyle = this.lists.level(list.instance, Math.min(list.level, 10))
			const geometry = levelGeometry(levelStyle)
			const paragraphLeft = parseLength(style.resolvedParagraph.get("fo:margin-left")) ?? 0

			if (geometry.mode === "label-alignment" && !style.ownIndent) tabLeft = geometry.marginLeft

			if (!list.labelled) {
				numPr = this.lists.numPr(list.instance, ilvl)
				list.labelled = true

				if (geometry.mode === "label-width-and-position") indent = listIndent(geometry, paragraphLeft)
			} else {
				// A list header or an item's later paragraph: at the text position, without a label.
				indent = { left: listIndent(geometry, paragraphLeft).left, firstLine: 0 }
			}
		} else if (heading && attributes.get("text:is-list-header") !== "true" && (listStyleName === undefined || listStyleName === "")) {
			// Measured: LibreOffice numbers every heading by the outline style, whatever its paragraph style.
			const level = Number(attributes.get("text:outline-level") ?? "0")
			const instance = level >= 1 ? this.lists.outline(Math.min(level, 10), this) : undefined

			if (instance !== undefined) {
				const start = Number(attributes.get("text:start-value") ?? "NaN")

				if (attributes.get("text:restart-numbering") === "true" || Number.isInteger(start)) {
					this.lists.restart(instance, Math.min(level, 9) - 1, Number.isInteger(start) ? start : 1)
				}

				numPr = this.lists.numPr(instance, Math.min(level, 9) - 1)

				const geometry = levelGeometry(this.lists.level(instance, Math.min(level, 10)))

				if (geometry.mode === "label-alignment" && !style.ownIndent) tabLeft = geometry.marginLeft
			}
		}

		const pageRtl = this.direction ?? this.pages.rtl
		const inheritedMode = style.resolvedParagraph.get("style:writing-mode")
		// A paragraph taking its page's direction where its styles were translated with the first page style's.
		const bidi =
			!style.paragraph.has("style:writing-mode") &&
			(inheritedMode === undefined || modeRtl(inheritedMode) === undefined) &&
			pageRtl !== this.styles.pageRtl
				? pageRtl
				: undefined
		const props = paragraphProperties(
			style.paragraph,
			style.children,
			style.resolvedParagraph,
			{
				tabsRelativeToIndent: this.settings.tabsRelativeToIndent,
				marginLeft: tabLeft,
				inheritedTabs: style.inheritedTabs,
				indents: style.ownIndent,
				ownIndents: true,
				fontSize: style.fontSize,
				hyphenate: style.text.get("fo:hyphenate"),
				pageRtl,
				bidi,
				...(indent === undefined ? {} : { listIndent: indent })
			},
			this
		)
		let head = props.head

		if (pageBreak)
			head = `${head.replace(/<w:pageBreakBefore[^>]*\/>/, "")}`.replace(/(<w:widowControl[^>]*\/>)?$/, "<w:pageBreakBefore/>$1")

		const outline = heading ? Number(attributes.get("text:outline-level") ?? "0") : 0

		pPr = `${style.styleId === undefined ? "" : `<w:pStyle w:val="${esc(style.styleId)}"/>`}${head}${numPr}${props.tail}${outline >= 1 && outline <= 9 ? `<w:outlineLvl w:val="${outline - 1}"/>` : ""}`

		const runs = new Runs(this)

		if (this.pendingAnchors.length > 0) {
			for (const anchor of this.pendingAnchors) runs.addRaw(anchor)

			this.pendingAnchors.length = 0
		}

		const base = { styleKey: `${this.scope}\u0000${styleName ?? ""}`, text: style.text, fontSize: style.fontSize }

		this.inline(node, runs, base, undefined, { trimLeading: true })

		// Comment ranges still open run on to their office:annotation-end (or the end of the story, storyBlocks).
		const markRPr = this.styles.runProperties(`mark\u0000${base.styleKey}`, undefined, style.text, style.fontSize, this)
		const insertion = this.insertion

		// A paragraph ending inside a tracked insertion has its mark inserted too (ECMA-376 Part 1 §17.13.5.16): rejecting
		// the insertion joins it with the next.
		flow.add(
			paragraph(
				pPr,
				insertion === undefined
					? markRPr
					: `<w:ins w:id="${this.id()}" w:author="${esc(insertion.author)}" w:date="${esc(insertion.date)}"/>${markRPr}`,
				runs.result()
			)
		)
	}

	// --- Inline content ---

	private inline(
		node: number,
		runs: Runs,
		base: { readonly styleKey: string; readonly text: Attributes; readonly fontSize: number },
		span:
			{ readonly key: string; readonly styleId: string | undefined; readonly own: Attributes; readonly origin?: string } | undefined,
		state: InlineState
	): void {
		this.enter()
		this.inlineAt(node, runs, base, span, state)
		this.leave()
	}

	private inlineAt(
		node: number,
		runs: Runs,
		base: { readonly styleKey: string; readonly text: Attributes; readonly fontSize: number },
		span:
			{ readonly key: string; readonly styleId: string | undefined; readonly own: Attributes; readonly origin?: string } | undefined,
		state: InlineState
	): void {
		const document = this.document
		// Built once per span level: every text node, space, tab and break under it has the same properties.
		let cached: string | undefined
		const rPr = (): string => {
			if (cached !== undefined) return cached

			const merged =
				span === undefined || span.own.size === 0
					? base.text
					: new Map([...base.text, ...StyleMapper.relativeSize(span.own, base.fontSize)])

			cached = this.styles.runProperties(`${base.styleKey}\u0000${span?.key ?? ""}`, span?.styleId, merged, base.fontSize, this)

			return cached
		}

		for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
			const kind = document.kind(child)

			if (kind === NodeKind.Text || kind === NodeKind.CData) {
				let text = document.text(child).replace(/[\t\n\r ]+/g, " ")

				if (state.trimLeading) text = text.replace(/^ /, "")
				if (text === "") continue

				state.trimLeading = text.endsWith(" ")
				runs.addText(text, rPr(), span?.origin)

				continue
			}

			if (kind !== NodeKind.Element) continue

			const name = this.name(child)

			switch (name) {
				case "text:span": {
					const styleName = this.attributes(child).get("text:style-name")
					const text = this.styles.text(styleName, this.scope)

					for (const reason of text.reasons) this.lossy(reason)

					const own = span === undefined ? text.own : new Map([...span.own, ...text.own])

					// A span whose style says what its WordprocessingML does not names itself on its runs (w:rsidR, its
					// offset in content.xml), so a rewrite of the paragraph finds it again whatever the edit did around it.
					const origin =
						span === undefined && styleName !== undefined && this.blockBase !== undefined && this.untranslatedSpan(styleName)
							? ` w:rsidR="${(this.blockBase + this.document.start(child)).toString(16).toUpperCase().padStart(8, "0")}"`
							: undefined

					this.inline(
						child,
						runs,
						base,
						{
							key: `${span?.key ?? ""}/${styleName ?? ""}`,
							styleId: text.styleId ?? span?.styleId,
							own,
							...(origin === undefined ? {} : { origin })
						},
						state
					)
					break
				}
				case "text:s": {
					const count = Math.max(1, Math.min(10_000, Number(this.attributes(child).get("text:c") ?? "1") || 1))

					runs.addText(" ".repeat(count), rPr(), span?.origin)
					state.trimLeading = false
					break
				}
				case "text:tab":
					runs.addRun("<w:tab/>", rPr(), span?.origin)
					state.trimLeading = false
					break
				case "text:line-break":
					runs.addRun("<w:br/>", rPr(), span?.origin)
					state.trimLeading = false
					break
				case "text:a":
					this.hyperlink(child, runs, base, span, state)
					break
				case "text:page-number":
				case "text:page-count": {
					const instruction = name === "text:page-number" ? "PAGE" : "NUMPAGES"
					const shown = document.textContent(child).trim() || "1"

					runs.addRaw(`<w:fldSimple w:instr=" ${instruction} ">`)
					runs.addRun(`<w:t>${escText(shown)}</w:t>`, rPr())
					runs.addRaw("</w:fldSimple>")
					state.trimLeading = false
					break
				}
				case "text:note":
					this.note(child, runs, rPr())
					// Its citation is a character: a space after it shows (Part 3 §6.1.2).
					state.trimLeading = false
					break
				case "office:annotation":
					this.annotation(child, runs)
					break
				case "text:bookmark":
				case "text:bookmark-start":
				case "text:bookmark-end":
				case "text:reference-mark":
				case "text:reference-mark-start":
				case "text:reference-mark-end":
					this.bookmark(name, this.attributes(child).get("text:name") ?? "", runs)
					break
				case "text:bibliography-mark": {
					// A citation: its shown text as a field's result (§8.1.11), kept whole for the writer to copy.
					const identifier = this.attributes(child).get("text:identifier") ?? ""

					runs.addRaw(`<w:fldSimple w:instr=" CITATION ${esc(identifier.replace(/[\s"\\]/gu, "_"))} ">`)
					this.inline(child, runs, base, span, state)
					runs.addRaw("</w:fldSimple>")
					break
				}
				case "text:change":
				case "text:change-start":
				case "text:change-end":
					runs.flush()
					this.inlineChange(name, this.attributes(child), runs)
					break
				case "text:hidden-text":
					if (this.attributes(child).get("text:is-hidden") !== "true") this.inline(child, runs, base, span, state)
					break
				case "text:ruby":
					this.lossy("textEffect")
					this.inline(child, runs, base, span, state)
					break
				case "text:ruby-text":
					break
				case "office:annotation-end": {
					const name = this.attributes(child).get("office:name") ?? ""
					const id = this.openAnnotations.get(name)

					if (id !== undefined) {
						this.openAnnotations.delete(name)
						this.closeAnnotation(id, runs)
					}

					break
				}
				case "draw:a":
				case "draw:frame":
				case "draw:custom-shape":
				case "draw:rect":
				case "draw:ellipse":
				case "draw:circle":
				case "draw:line":
				case "draw:polyline":
				case "draw:polygon":
				case "draw:path":
				case "draw:connector":
				case "draw:g":
				case "draw:caption":
				case "draw:measure":
				case "dr3d:scene":
					runs.addRaw(this.frames.translate(child, "paragraph"))

					// A frame anchored as a character is one: a space after it shows (Part 3 §6.1.2).
					if (this.attributes(child).get("text:anchor-type") === "as-char") state.trimLeading = false

					break
				case "text:reference-ref":
				case "text:bookmark-ref":
				case "text:sequence-ref":
				case "text:note-ref": {
					// A cross-reference: its shown text as the result of a field (§7.7.5 to §7.7.8), which keeps it whole
					// for the writer to copy; what it refers to is the source's.
					const attributes = this.attributes(child)
					const reference = referenceField(name, attributes.get("text:ref-name") ?? "", attributes.get("text:reference-format"))

					// What an update could not find (a sequence or note names no bookmark) or not compute keeps its result.
					if (reference.locked) this.lossy("fieldAsText")

					runs.addRaw(`<w:fldSimple w:instr="${esc(reference.instruction)}"${reference.locked ? ' w:fldLock="1"' : ""}>`)
					this.inline(child, runs, base, span, state)
					runs.addRaw("</w:fldSimple>")
					break
				}
				default:
					if (SKIPPED_INLINE.has(name)) break

					if (FIELDS_AS_TEXT.has(name)) {
						// Its shown result as a field's, kept whole for the writer to copy (a sequence is SEQ, §7.4.13; the
						// others name the variable or field they show).
						const attributes = this.attributes(child)
						const target = (attributes.get("text:name") ?? attributes.get("text:ref-name") ?? "").replace(/[\s"\\]/gu, "_")

						this.lossy("fieldAsText")
						runs.addRaw(
							`<w:fldSimple w:instr=" ${name === "text:sequence" ? "SEQ" : "DOCVARIABLE"} ${esc(target === "" ? name.slice(5) : target)} ">`
						)
						this.inline(child, runs, base, span, state)
						runs.addRaw("</w:fldSimple>")

						break
					}

					if (name === "text:date" || name === "text:time") {
						const attributes = this.attributes(child)
						const code = dateCode(name, attributes.get("text:fixed"), attributes.has(`${name}-adjust`))

						if (code !== undefined) {
							// A date or time that is not fixed shows the current one (Part 3 §19.817), as DATE and TIME do
							// (§17.16.5.14, §17.16.5.70), in the data style's form; the result is the one saved.
							const picture = datePicture(this.sheet.dataStyle(attributes.get("style:data-style-name") ?? "", this.scope))

							runs.addRaw(`<w:fldSimple w:instr="${esc(` ${code} ${picture === undefined ? "" : `\\@ "${picture}" `}`)}">`)
							this.inline(child, runs, base, span, state)
							runs.addRaw("</w:fldSimple>")

							break
						}
					}

					if (PASS_THROUGH_INLINE.has(name) && name !== "text:meta" && name !== "text:ruby-base") {
						// A field (metadata, dates, chapters, form fields...): its shown text as a field's result, kept whole
						// for the writer to copy.
						runs.addRaw(`<w:fldSimple w:instr=" DOCPROPERTY ${name.replace(":", "_")} ">`)
						this.inline(child, runs, base, span, state)
						runs.addRaw("</w:fldSimple>")

						break
					}

					if (!PASS_THROUGH_INLINE.has(name)) this.lossy("unknownElement")

					this.inline(child, runs, base, span, state)
			}
		}
	}

	private hyperlink(
		node: number,
		runs: Runs,
		base: { readonly styleKey: string; readonly text: Attributes; readonly fontSize: number },
		span:
			{ readonly key: string; readonly styleId: string | undefined; readonly own: Attributes; readonly origin?: string } | undefined,
		state: InlineState
	): void {
		const attributes = this.attributes(node)
		const href = attributes.get("xlink:href") ?? ""
		const styleName = attributes.get("text:style-name")
		const text = this.styles.text(styleName, this.scope)

		for (const reason of text.reasons) this.lossy(reason)

		const inner = {
			key: `${span?.key ?? ""}/a:${styleName ?? ""}`,
			styleId: text.styleId ?? span?.styleId,
			own: span === undefined ? text.own : new Map([...span.own, ...text.own])
		}
		let open: string

		if (href.startsWith("#")) {
			open = `<w:hyperlink w:anchor="${esc(decodeAnchor(href.slice(1)))}">`
		} else if (href !== "") {
			open = `<w:hyperlink r:id="${this.relationship("hyperlink", href, true)}">`
		} else {
			this.inline(node, runs, base, inner, state)

			return
		}

		runs.addRaw(open)
		this.inline(node, runs, base, inner, state)
		runs.addRaw("</w:hyperlink>")
	}

	// Bookmarks and reference marks (§6.2.1, §6.2.2) as WordprocessingML bookmarks: both name a span to refer to. Their
	// names are kept apart as ODF keeps them.
	private bookmark(kind: string, name: string, runs: Runs): void {
		const key = kind.startsWith("text:reference-mark") ? `\u0000${name}` : name

		if (kind === "text:bookmark-end" || kind === "text:reference-mark-end") {
			const id = this.bookmarkIds.get(key)

			if (id !== undefined) runs.addRaw(`<w:bookmarkEnd w:id="${id}"/>`)

			return
		}

		const id = this.id()

		if (kind === "text:bookmark-start" || kind === "text:reference-mark-start") this.bookmarkIds.set(key, id)

		runs.addRaw(`<w:bookmarkStart w:id="${id}" w:name="${esc(name)}"/>`)

		if (kind === "text:bookmark" || kind === "text:reference-mark") runs.addRaw(`<w:bookmarkEnd w:id="${id}"/>`)
	}

	private note(node: number, runs: Runs, rPr: string): void {
		const attributes = this.attributes(node)
		const endnote = attributes.get("text:note-class") === "endnote"
		let citation = -1
		let body = -1

		for (let child = this.document.firstChildElement(node); child >= 0; child = this.document.nextSiblingElement(child)) {
			const name = this.name(child)

			if (name === "text:note-citation") citation = child
			else if (name === "text:note-body") body = child
		}

		const label = citation < 0 ? undefined : this.attributes(citation).get("text:label")
		const id = endnote ? ++this.endnoteCount : ++this.noteCount
		const tag = endnote ? "endnote" : "footnote"
		const custom = label !== undefined && label !== ""
		const style = '<w:vertAlign w:val="superscript"/>'

		runs.addRun(`<w:${tag}Reference${custom ? ' w:customMarkFollows="1"' : ""} w:id="${id}"/>`, `${rPr}${style}`)

		if (custom) runs.addRun(`<w:t>${escText(label)}</w:t>`, `${rPr}${style}`)

		const flow = new MarkupFlow()

		if (body >= 0) this.storyBlocks(body, flow)

		const first = flow.blocks.find((block): block is ParagraphBlock => block.kind === "p")
		const reference = `<w:r><w:rPr>${style}</w:rPr>${custom ? `<w:t>${escText(label)}</w:t>` : `<w:${tag}Ref/>`}</w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>`

		if (first === undefined) flow.add(paragraph("", "", reference))
		else first.content = reference + first.content

		;(endnote ? this.endnotes : this.footnotes).add(`<w:${tag} w:id="${id}">${flow.xml()}</w:${tag}>`)
	}

	private annotation(node: number, runs: Runs): void {
		const attributes = this.attributes(node)
		const id = this.commentCount++
		let author = ""
		let date = ""
		let initials = ""
		const flow = new MarkupFlow()
		const outer = this.openAnnotations

		this.openAnnotations = new Map()

		for (let child = this.document.firstChildElement(node); child >= 0; child = this.document.nextSiblingElement(child)) {
			const name = this.name(child)

			if (name === "dc:creator") author = this.document.textContent(child)
			else if (name === "dc:date") date = this.document.textContent(child)
			else if (name === "meta:creator-initials" || name === "loext:sender-initials") initials = this.document.textContent(child)
			else this.block(child, flow)
		}

		if (flow.blocks.length === 0) flow.add(paragraph("", "", ""))

		this.closeOpenAnnotations(flow)
		this.openAnnotations = outer

		this.comments.add(
			`<w:comment w:id="${id}" w:author="${esc(author)}"${date === "" ? "" : ` w:date="${esc(wmlDate(date))}"`}${initials === "" ? "" : ` w:initials="${esc(initials)}"`}>${flow.xml()}</w:comment>`
		)

		const name = attributes.get("office:name")

		// A point comment, or the start of a range office:annotation-end closes (or the end of the story).
		runs.addRaw(`<w:commentRangeStart w:id="${id}"/>`)

		if (name !== undefined) this.openAnnotations.set(name, id)
		else this.closeAnnotation(id, runs)
	}

	private closeAnnotation(id: number, runs: Runs): void {
		runs.addRaw(`<w:commentRangeEnd w:id="${id}"/>`)
		runs.addRun(`<w:commentReference w:id="${id}"/>`, "")
	}

	// --- Tracked changes ---

	private trackedChanges(node: number): void {
		for (let region = this.document.firstChildElement(node); region >= 0; region = this.document.nextSiblingElement(region)) {
			if (this.name(region) !== "text:changed-region") continue

			const attributes = this.attributes(region)
			const id = attributes.get("text:id") ?? attributes.get("xml:id")

			if (id === undefined) continue

			for (let change = this.document.firstChildElement(region); change >= 0; change = this.document.nextSiblingElement(change)) {
				const kind = this.name(change)

				if (kind !== "text:insertion" && kind !== "text:deletion" && kind !== "text:format-change") continue

				let author = ""
				let date = ""
				let deleted = ""
				let paragraphs = 0
				let whole = true

				for (let child = this.document.firstChildElement(change); child >= 0; child = this.document.nextSiblingElement(child)) {
					const name = this.name(child)

					if (name === "office:change-info") {
						for (let info = this.document.firstChildElement(child); info >= 0; info = this.document.nextSiblingElement(info)) {
							const infoName = this.name(info)

							if (infoName === "dc:creator") author = this.document.textContent(info)
							else if (infoName === "dc:date") date = wmlDate(this.document.textContent(info))
						}
					} else if (name === "text:p" || name === "text:h") {
						paragraphs++
						deleted += this.deletedRuns(child)
					} else {
						this.lossy("trackedChange")
						whole = false
					}
				}

				if (paragraphs > 1 || kind === "text:format-change") this.lossy("trackedChange")

				this.changes.set(id, {
					kind: kind === "text:insertion" ? "insertion" : kind === "text:deletion" ? "deletion" : "format",
					author,
					date,
					deleted,
					whole: whole && paragraphs <= 1
				})
			}
		}
	}

	private deletedRuns(node: number): string {
		const runs = new Runs(this)
		const style = this.styles.paragraph(this.attributes(node).get("text:style-name"), this.scope)
		const saved = this.insertion

		for (const reason of style.reasons) this.lossy(reason)

		this.insertion = undefined
		this.deleting = true
		this.inline(
			node,
			runs,
			{
				styleKey: `${this.scope}\u0000${this.attributes(node).get("text:style-name") ?? ""}`,
				text: style.text,
				fontSize: style.fontSize
			},
			undefined,
			{ trimLeading: true }
		)

		const deleted = runs.result()

		this.deleting = false
		this.insertion = saved

		return deleted
	}

	private inlineChange(name: string, attributes: Attributes, runs?: Runs): void {
		const id = attributes.get("text:change-id") ?? ""
		const record = this.changes.get(id)

		if (record === undefined) return

		if (name === "text:change") {
			if (record.kind === "deletion" && runs !== undefined && record.deleted !== "") {
				runs.addRaw(
					`<w:del w:id="${this.id()}" w:author="${esc(record.author)}" w:date="${esc(record.date)}">${record.deleted}</w:del>`
				)
			}
		} else if (name === "text:change-start") {
			if (record.kind === "insertion") this.insertion = { author: record.author, date: record.date }
		} else if (record.kind === "insertion") {
			this.insertion = undefined
		}
	}

	// A story translated on its own (a text box, a cell): its blocks' markup, ending with a paragraph.
	// `mode`: the container's style:writing-mode, which its paragraphs' "page" mode takes when it sets a direction.
	story(container: number, width: number, mode?: string): string {
		const flow = new MarkupFlow()
		const direction = this.direction

		this.direction = modeRtl(mode) ?? direction
		this.widths.push(width)
		this.storyBlocks(container, flow)
		this.widths.pop()
		this.direction = direction

		if (!flow.endsWithParagraph) flow.add(paragraph("", "", ""))

		return flow.xml()
	}
}

// What a cross-reference's text:reference-format (Part 3 §19.866) shows, as REF switches (ECMA-376 Part 1
// §17.16.5.51): the referenced text, above or below, the list number in context, without context and in full. A page
// number is PAGEREF (§17.16.5.43); a chapter, caption, category or value has no field.
const REFERENCE_SWITCHES: ReadonlyMap<string, string> = new Map([
	["text", ""],
	["page", ""],
	["direction", " \\p"],
	["number", " \\r"],
	["number-no-superior", " \\n"],
	["number-all-superior", " \\w"]
])

// The field type a cross-reference element becomes (the ODT writer pairs fields with their sources by it).
export function referenceCode(name: string, format: string | undefined): string {
	if (format === "page") return "PAGEREF"

	return name === "text:note-ref" ? "NOTEREF" : "REF"
}

// A cross-reference (§7.7.5 to §7.7.8) as a field naming the bookmark or reference mark by its own name. Locked
// where an update would not show what LibreOffice does: a sequence or note is no bookmark, and some formats have no
// field.
export function referenceField(
	name: string,
	target: string,
	format: string | undefined
): { readonly instruction: string; readonly locked: boolean } {
	const switches = REFERENCE_SWITCHES.get(format ?? "text")
	const locked = name === "text:sequence-ref" || name === "text:note-ref" || switches === undefined

	return { instruction: ` ${referenceCode(name, format)} ${fieldArgument(target)}${switches ?? ""} \\h `, locked }
}

// A field argument as written in an instruction: quoted, a quote or backslash escaped, where it has white space or
// those (§17.16.1).
function fieldArgument(value: string): string {
	return value !== "" && !/[\s"\\]/u.test(value) ? value : `"${value.replace(/["\\]/gu, "\\$&")}"`
}

// A text:condition that is a constant (after its formula namespace prefix, "ooow:"): true, false, or a number (true
// unless 0); undefined for anything else.
function constantCondition(condition: string | undefined): boolean | undefined {
	if (condition === undefined) return undefined

	const formula = condition
		.replace(/^[A-Za-z][\w.-]*:(?!=)/u, "")
		.trim()
		.toLowerCase()

	if (formula === "true") return true
	if (formula === "false") return false

	const value = formula === "" ? Number.NaN : Number(formula)

	return Number.isFinite(value) ? value !== 0 : undefined
}

// The field a text:date or text:time becomes: DATE or TIME when it is not fixed (text:fixed, Part 3 §19.817) and not
// moved off the current date or time (text:date-adjust, text:time-adjust: no field says that); undefined: its saved
// result (DOCPROPERTY). The ODT writer pairs fields with their sources by it.
export function dateCode(name: string, fixed: string | undefined, adjusted: boolean): "DATE" | "TIME" | undefined {
	if (fixed === "true" || adjusted) return undefined

	return name === "text:time" ? "TIME" : "DATE"
}

// A number:date-style or number:time-style (Part 3 §16.29.11, §16.29.19) as a date-time picture (ECMA-376 Part 1
// §17.16.4.1); undefined for no style, the language's own format or a part no picture has (eras, quarters, weeks).
function datePicture(style: OdfDataStyle | undefined): string | undefined {
	if (style === undefined || (style.kind !== "date" && style.kind !== "time")) return undefined
	if (style.attributes.get("number:format-source") === "language") return undefined

	const twelveHour = style.parts.some(part => part.name === "number:am-pm")
	let picture = ""

	for (const part of style.parts) {
		const long = part.attributes.get("number:style") === "long"

		switch (part.name) {
			case "number:day":
				picture += long ? "dd" : "d"
				break
			case "number:day-of-week":
				picture += long ? "dddd" : "ddd"
				break
			case "number:month":
				picture += part.attributes.get("number:textual") === "true" ? (long ? "MMMM" : "MMM") : long ? "MM" : "M"
				break
			case "number:year":
				picture += long ? "yyyy" : "yy"
				break
			case "number:hours":
				picture += twelveHour ? (long ? "hh" : "h") : long ? "HH" : "H"
				break
			case "number:minutes":
				picture += long ? "mm" : "m"
				break
			case "number:seconds":
				picture += long ? "ss" : "s"
				break
			case "number:am-pm":
				picture += "AM/PM"
				break
			case "number:text":
				// Literal text, quoted where a picture would read it (letters); a quote has no form inside one.
				if (/['"]/u.test(part.text)) return undefined

				picture += /\p{L}/u.test(part.text) ? `'${part.text}'` : part.text
				break
			default:
				return undefined
		}
	}

	return picture === "" ? undefined : picture
}

// A link target after "#": percent-decoded, without LibreOffice's "|outline" style suffixes.
function decodeAnchor(target: string): string {
	let decoded = target

	try {
		decoded = decodeURIComponent(target)
	} catch {
		decoded = target
	}

	const bar = decoded.lastIndexOf("|")

	return bar > 0 ? decoded.slice(0, bar) : decoded
}

// A dc:date as WordprocessingML's date and time (ECMA-376 Part 1 ST_DateTime, an xsd:dateTime): without fractions of a
// second, a date alone at its midnight.
function wmlDate(value: string): string {
	const trimmed = value.trim().replace(/\.\d+$/u, "")

	return /^\d{4}-\d{2}-\d{2}$/u.test(trimmed) ? `${trimmed}T00:00:00` : trimmed
}

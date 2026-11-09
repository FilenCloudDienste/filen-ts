import {
	parseLength,
	type MasterRegionKind,
	type OdfElement,
	type OdfMasterPage,
	type OdfPageLayout,
	type OdfProperties,
	type OdfStyleSheet
} from "../odf/index"
import { blockXml, MarkupFlow, paragraph, type Block, type Flow } from "./flow"
import { border, layoutRtl } from "./props"
import type { Translator } from "./translator"
import type { OdtOrigin } from "./types"
import { encodeUtf8 } from "../xml/index"
import { PART_NAMESPACES, PartWriter, twips, XML_DECLARATION } from "./wml"

// Master pages as sections. A paragraph or table whose style names a master page starts a new page in that
// page style (Part 3 §19.501 style:master-page-name): a section break, with style:page-number restarting
// the page count. A master page whose style:next-style-name names another is a first page: the section
// gets a title page (w:titlePg) with the first master's headers, and the next master's for the rest.

// LibreOffice's page when a document has no page layout: A4, 2 cm margins.
const A4 = { width: 595.28, height: 841.89, margin: 56.69 }

const NUMBER_FORMATS: Readonly<Record<string, string>> = {
	"1": "decimal",
	a: "lowerLetter",
	A: "upperLetter",
	i: "lowerRoman",
	I: "upperRoman"
}

interface SectionState {
	readonly master: string
	// style:columns of a text:section the section is, when it has columns.
	readonly columns: OdfElement | undefined
	readonly type: "nextPage" | "continuous"
	readonly pageStart: number | undefined
}

// The master page the document's first section is on unless a block names one.
function firstMasterName(sheet: OdfStyleSheet): string {
	return sheet.masterPages.has("Standard") ? "Standard" : (sheet.masterOrder[0] ?? "Standard")
}

function masterLayout(sheet: OdfStyleSheet, master: OdfMasterPage | undefined): OdfPageLayout | undefined {
	return master?.pageLayout === undefined
		? sheet.defaultPageLayout
		: (sheet.pageLayouts.get(master.pageLayout) ?? sheet.defaultPageLayout)
}

// The master page the first page's next-style-name leads to, when it is another.
function followerOf(sheet: OdfStyleSheet, master: OdfMasterPage | undefined): OdfMasterPage | undefined {
	const next = master?.next

	if (master === undefined || next === undefined || next === "" || next === master.name) return undefined

	return sheet.masterPages.get(next)
}

// Whether the pages of a section on master page `name` run right to left (its sectPr's page layout).
function masterRtl(sheet: OdfStyleSheet, name: string): boolean {
	const master = sheet.masterPages.get(name)

	return layoutRtl(masterLayout(sheet, followerOf(sheet, master) ?? master))
}

// The direction of the document's first page style: what the translated styles' "page" writing mode takes.
export function defaultPageRtl(sheet: OdfStyleSheet): boolean {
	return masterRtl(sheet, firstMasterName(sheet))
}

export class BodyFlow implements Flow {
	readonly body = true
	readonly writer = new PartWriter()
	count = 0
	private held: Block | undefined

	add(block: Block): void {
		if (this.held !== undefined) this.writer.add(blockXml(this.held))

		this.held = block
		this.count++
	}

	appendToLast(content: string): void {
		if (this.held?.kind === "p") this.held.content += content
		else this.add(paragraph("", "", content))
	}

	// Ends a section: its sectPr goes into the last paragraph, or a paragraph of its own after a table.
	closeSection(sectPr: string): void {
		if (this.held?.kind === "p" && this.held.sectPr === "") {
			this.held.sectPr = sectPr

			return
		}

		const carrier = paragraph("", "", "")

		carrier.sectPr = sectPr
		this.add(carrier)
	}

	finish(sectPr: string): void {
		if (this.held !== undefined) this.writer.add(blockXml(this.held))

		this.held = undefined
		this.writer.add(sectPr)
	}
}

function length(properties: OdfProperties | undefined, name: string, fallback: number): number {
	return parseLength(properties?.attributes.get(name)) ?? fallback
}

function geometryKey(layout: OdfPageLayout | undefined): string {
	const properties = layout?.properties

	return ["fo:page-width", "fo:page-height", "fo:margin-top", "fo:margin-bottom", "fo:margin-left", "fo:margin-right"]
		.map(name => properties?.attributes.get(name) ?? "")
		.join("|")
}

export class Pages {
	private readonly translator: Translator
	body: BodyFlow | undefined = undefined
	private state: SectionState | undefined = undefined
	private readonly saved: SectionState[] = []
	private readonly regionParts = new Map<string, string | undefined>()
	readonly parts = new Map<string, Uint8Array>()
	readonly contentTypes: string[] = []
	readonly origins: OdtOrigin[] = []
	// Each section's master page and page layout, in the order their sectPr come.
	readonly sections: { readonly master: string; readonly layout: string | undefined; readonly start: string }[] = []
	readonly evenAndOdd: boolean
	private nextPart = 1

	constructor(translator: Translator) {
		this.translator = translator
		this.evenAndOdd = [...translator.sheet.masterPages.values()].some(master =>
			master.regions.some(region => region.display && (region.kind === "header-left" || region.kind === "footer-left"))
		)
	}

	// The master page the next block is on when nothing but it is set (no columns open); undefined otherwise.
	plainMaster(): string | undefined {
		if (this.state === undefined) return this.firstMaster

		return this.state.columns === undefined && this.saved.length === 0 ? this.state.master : undefined
	}

	// Continues on master page `master` (a run of blocks translated on its own, from where the document had it).
	resume(master: string): void {
		this.state = { master, columns: undefined, type: "nextPage", pageStart: undefined }
	}

	private get firstMaster(): string {
		return firstMasterName(this.translator.sheet)
	}

	// Whether the current section's pages run right to left.
	get rtl(): boolean {
		return masterRtl(this.translator.sheet, this.state?.master ?? this.firstMaster)
	}

	// The document's first section starts with the default page style unless a block names one.
	begin(): void {
		this.state ??= { master: this.firstMaster, columns: undefined, type: "nextPage", pageStart: undefined }
	}

	// A block names master page `master`: true when that made a section break (which starts the new page);
	// false when the block only needs a page break of its own (same page style, page count continuing).
	pageStyle(master: string, pageNumber: string | undefined): boolean {
		const start = pageNumber === undefined || pageNumber === "auto" ? undefined : Number(pageNumber)
		const restart = start !== undefined && Number.isInteger(start) && start >= 0 ? start : undefined

		if (this.state === undefined) {
			this.state = { master, columns: undefined, type: "nextPage", pageStart: restart }

			return true
		}

		if (master === this.state.master && restart === undefined) return false

		this.close()
		this.state = { master, columns: undefined, type: "nextPage", pageStart: restart }

		return true
	}

	openColumns(columns: OdfElement | undefined): void {
		this.begin()

		const state = this.current

		this.close()
		this.saved.push(state)
		this.state = { master: state.master, columns, type: "continuous", pageStart: undefined }
	}

	closeColumns(): void {
		const state = this.saved.pop() ?? this.current

		this.close()
		this.state = { master: this.current.master, columns: state.columns, type: "continuous", pageStart: undefined }
	}

	private get current(): SectionState {
		this.begin()

		return this.state ?? { master: this.firstMaster, columns: undefined, type: "nextPage", pageStart: undefined }
	}

	private close(): void {
		this.body?.closeSection(this.sectPr(this.current))
	}

	finalSectPr(): string {
		return this.sectPr(this.current)
	}

	private layout(master: OdfMasterPage | undefined): OdfPageLayout | undefined {
		return masterLayout(this.translator.sheet, master)
	}

	// The current page's left margin (points): frames placed from the page edge.
	get marginLeft(): number {
		const master = this.translator.sheet.masterPages.get(this.current.master)

		return length(this.layout(this.follower(master) ?? master)?.properties, "fo:margin-left", A4.margin)
	}

	// The width text runs in on the current page, in points: for tables sized relative to it.
	get textWidth(): number {
		const state = this.current
		const master = this.translator.sheet.masterPages.get(state.master)
		const main = this.follower(master) ?? master
		const properties = this.layout(main)?.properties
		const width =
			length(properties, "fo:page-width", A4.width) -
			length(properties, "fo:margin-left", A4.margin) -
			length(properties, "fo:margin-right", A4.margin)
		const columns = state.columns ?? properties?.children.find(child => child.name === "style:columns")
		const count = Math.max(1, Number(columns?.attributes.get("fo:column-count") ?? "1") || 1)
		const gap = parseLength(columns?.attributes.get("fo:column-gap")) ?? 0

		return Math.max(1, (width - gap * (count - 1)) / count)
	}

	// The master page the first page's next-style-name leads to, when it is another.
	private follower(master: OdfMasterPage | undefined): OdfMasterPage | undefined {
		return followerOf(this.translator.sheet, master)
	}

	private sectPr(state: SectionState): string {
		const sheet = this.translator.sheet
		const master = sheet.masterPages.get(state.master)
		const follower = this.follower(master)
		const main = follower ?? master
		const layout = this.layout(main)

		this.sections.push({ master: main?.name ?? state.master, layout: layout?.name, start: state.master })
		const properties = layout?.properties

		if (follower !== undefined) {
			if (geometryKey(this.layout(master)) !== geometryKey(layout)) this.translator.lossy("masterPageChain")
			if (this.follower(follower) !== undefined) this.translator.lossy("masterPageChain")
		}

		let references = ""
		// One region's first-page variant makes a title page for both; the other keeps its regular region on page 1
		// (ODF 1.3 Part 3 §16.11, §16.13), since titlePg with no first reference blanks it (ECMA-376 Part 1 §17.10.5).
		const titlePage =
			follower !== undefined || this.region(master, "header-first") !== undefined || this.region(master, "footer-first") !== undefined
		const reference = (tag: "header" | "footer", type: string, part: string | undefined): void => {
			if (part !== undefined) references += `<w:${tag}Reference w:type="${type}" r:id="${part}"/>`
		}

		for (const tag of ["header", "footer"] as const) {
			const main_ = this.region(main, tag)

			reference(tag, "default", main_)

			if (this.evenAndOdd) reference(tag, "even", this.region(main, `${tag}-left`) ?? main_)

			const first =
				follower !== undefined
					? (this.region(master, `${tag}-first`) ?? this.region(master, tag) ?? this.emptyRegion(tag))
					: (this.region(master, `${tag}-first`) ?? (titlePage ? main_ : undefined))

			reference(tag, "first", first)
		}

		const pageWidth = length(properties, "fo:page-width", A4.width)
		const pageHeight = length(properties, "fo:page-height", A4.height)
		const top = length(properties, "fo:margin-top", A4.margin)
		const bottom = length(properties, "fo:margin-bottom", A4.margin)
		const left = length(properties, "fo:margin-left", A4.margin)
		const right = length(properties, "fo:margin-right", A4.margin)
		const headerExtent = this.displays(main, "header") ? this.extent(layout?.header, "fo:margin-bottom") : 0
		const footerExtent = this.displays(main, "footer") ? this.extent(layout?.footer, "fo:margin-top") : 0
		// A header only the first page shows sits where the first page's layout puts it (w:header, w:footer: the edge
		// of the page to the header, ECMA-376 Part 1 §17.6.11).
		const firstLayout = follower === undefined ? undefined : this.layout(master)
		const headerAt =
			!this.displays(main, "header") && firstLayout !== undefined && this.displays(master, "header")
				? length(firstLayout.properties, "fo:margin-top", top)
				: top
		const footerAt =
			!this.displays(main, "footer") && firstLayout !== undefined && this.displays(master, "footer")
				? length(firstLayout.properties, "fo:margin-bottom", bottom)
				: bottom
		const orientation = properties?.attributes.get("style:print-orientation") === "landscape" ? ' w:orient="landscape"' : ""
		const borders = ["top", "left", "bottom", "right"]
			.map(side => border(side, properties?.attributes.get(`fo:border-${side}`), properties?.attributes.get(`fo:padding-${side}`)))
			.join("")
		const columns = state.columns ?? properties?.children.find(child => child.name === "style:columns")
		const format = NUMBER_FORMATS[properties?.attributes.get("style:num-format") ?? "1"]
		const numbering =
			state.pageStart !== undefined || (format !== undefined && format !== "decimal")
				? `<w:pgNumType${format === undefined || format === "decimal" ? "" : ` w:fmt="${format}"`}${state.pageStart === undefined ? "" : ` w:start="${state.pageStart}"`}/>`
				: ""

		return `<w:sectPr>${references}<w:type w:val="${state.type}"/><w:pgSz w:w="${twips(pageWidth)}" w:h="${twips(pageHeight)}"${orientation}/><w:pgMar w:top="${twips(top + headerExtent)}" w:right="${twips(right)}" w:bottom="${twips(bottom + footerExtent)}" w:left="${twips(left)}" w:header="${twips(headerAt)}" w:footer="${twips(footerAt)}" w:gutter="0"/>${borders === "" || !/w:val="(?!nil)/.test(borders) ? "" : `<w:pgBorders w:offsetFrom="text">${borders}</w:pgBorders>`}${numbering}${this.columnsXml(columns)}${titlePage ? "<w:titlePg/>" : ""}${layoutRtl(layout) ? "<w:bidi/>" : ""}</w:sectPr>`
	}

	private columnsXml(columns: OdfElement | undefined): string {
		const count = Math.max(1, Math.min(45, Number(columns?.attributes.get("fo:column-count") ?? "1") || 1))

		if (columns === undefined || count <= 1) return ""

		const gap = parseLength(columns.attributes.get("fo:column-gap")) ?? 0
		const separator = columns.children.some(
			child => child.name === "style:column-sep" && (child.attributes.get("style:style") ?? "solid") !== "none"
		)
		const widths = columns.children.filter(child => child.name === "style:column")
		const weights = widths.map(column => Number((column.attributes.get("style:rel-width") ?? "").replace("*", "")) || 0)
		const equal = widths.length !== count || weights.every(weight => weight === weights[0])

		if (equal) return `<w:cols w:num="${count}" w:space="${twips(gap)}"${separator ? ' w:sep="1"' : ""}/>`

		// Unequal columns: rel-widths share the text width; each column's start and end indents form the gaps.
		const total = weights.reduce((sum, weight) => sum + weight, 0) || 1
		const width = this.textWidthOfPage()
		let xml = `<w:cols w:num="${count}" w:equalWidth="0"${separator ? ' w:sep="1"' : ""}>`

		for (let k = 0; k < widths.length; k++) {
			const column = widths[k]
			const start = parseLength(column?.attributes.get("fo:start-indent")) ?? 0
			const end = parseLength(column?.attributes.get("fo:end-indent")) ?? 0
			const nextStart = parseLength(widths[k + 1]?.attributes.get("fo:start-indent")) ?? 0
			const share = (width * (weights[k] ?? 0)) / total

			xml += `<w:col w:w="${twips(Math.max(1, share - start - end))}" w:space="${twips(k + 1 < widths.length ? end + nextStart : 0)}"/>`
		}

		return `${xml}</w:cols>`
	}

	private textWidthOfPage(): number {
		const master = this.translator.sheet.masterPages.get(this.current.master)
		const properties = this.layout(this.follower(master) ?? master)?.properties

		return (
			length(properties, "fo:page-width", A4.width) -
			length(properties, "fo:margin-left", A4.margin) -
			length(properties, "fo:margin-right", A4.margin)
		)
	}

	// How far a header (footer) reaches into the page beyond the margin at least: its minimum (or fixed) height, which
	// includes its spacing, never less than that spacing (LibreOffice, measured). Taller content grows it, as a Word
	// header grows past w:top.
	private extent(properties: OdfProperties | undefined, spacing: string): number {
		if (properties === undefined) return 0

		const fixed = parseLength(properties.attributes.get("svg:height"))
		const minimum = parseLength(properties.attributes.get("fo:min-height"))

		if (fixed !== undefined && minimum === undefined) this.translator.lossy("fixedHeaderHeight")

		return Math.max(minimum ?? fixed ?? 0, parseLength(properties.attributes.get(spacing)) ?? 0)
	}

	private displays(master: OdfMasterPage | undefined, kind: MasterRegionKind): boolean {
		return master?.regions.some(region => region.kind === kind && region.display) === true
	}

	// The relationship id of a master page region's part, translated once.
	private region(master: OdfMasterPage | undefined, kind: MasterRegionKind): string | undefined {
		if (master === undefined) return undefined

		const key = `${master.name}\u0000${kind}`

		if (this.regionParts.has(key)) return this.regionParts.get(key)

		const region = master.regions.find(item => item.kind === kind && item.display)
		const sheet = this.translator.sheet
		let id: string | undefined

		if (region !== undefined && sheet.stylesDocument !== undefined && sheet.stylesNamespaces !== undefined) {
			const header = kind.startsWith("header")
			const layout = this.layout(master)
			const properties = header ? layout?.header : layout?.footer
			const spacing = parseLength(properties?.attributes.get(header ? "fo:margin-bottom" : "fo:margin-top")) ?? 0
			const translator = this.translator
			const saved = {
				document: translator.document,
				namespaces: translator.namespaces,
				scope: translator.scope,
				direction: translator.direction
			}

			translator.document = sheet.stylesDocument
			translator.namespaces = sheet.stylesNamespaces
			translator.scope = "styles"
			// A header or footer runs in its own master page's direction.
			translator.direction = layoutRtl(layout)

			const flow = new MarkupFlow()
			const lossyBefore = new Set(translator.blockLossy)

			translator.blockLossy.clear()
			translator.widths.push(this.textWidthOfMaster(master))
			translator.storyBlocks(region.node, flow)
			translator.widths.pop()

			const lossy = translator.takeLossy()

			for (const reason of lossyBefore) translator.blockLossy.add(reason)

			translator.document = saved.document
			translator.namespaces = saved.namespaces
			translator.scope = saved.scope
			translator.direction = saved.direction

			const count = flow.blocks.length
			const spacer = spacing > 0 ? spacerParagraph(spacing) : undefined

			if (spacer !== undefined && header) flow.add(spacer)
			if (!flow.endsWithParagraph) flow.add(paragraph("", "", ""))

			const tag = header ? "hdr" : "ftr"
			const name = `${header ? "header" : "footer"}${this.nextPart++}.xml`
			const markup = `${spacer !== undefined && !header ? blockXml(spacer) : ""}${flow.xml()}`

			this.parts.set(`word/${name}`, encodeUtf8(`${XML_DECLARATION}<w:${tag} ${PART_NAMESPACES}>${markup}</w:${tag}>`))
			this.contentTypes.push(
				`<Override PartName="/word/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${header ? "header" : "footer"}+xml"/>`
			)
			this.origins.push({
				stream: "styles.xml",
				start: sheet.stylesDocument.start(region.node),
				end: sheet.stylesDocument.end(region.node),
				part: `word/${name}`,
				first: spacer !== undefined && !header ? 1 : 0,
				count,
				lossy
			})
			id = translator.relationship(header ? "header" : "footer", name, false)
		}

		this.regionParts.set(key, id)

		return id
	}

	private textWidthOfMaster(master: OdfMasterPage): number {
		const properties = this.layout(master)?.properties

		return (
			length(properties, "fo:page-width", A4.width) -
			length(properties, "fo:margin-left", A4.margin) -
			length(properties, "fo:margin-right", A4.margin)
		)
	}

	// An empty header or footer: the first page of a first-page chain whose first master has none.
	private emptyRegion(tag: "header" | "footer"): string {
		const key = `\u0000empty\u0000${tag}`
		const known = this.regionParts.get(key)

		if (known !== undefined) return known

		const name = `${tag}${this.nextPart++}.xml`
		const root = tag === "header" ? "hdr" : "ftr"

		this.parts.set(`word/${name}`, encodeUtf8(`${XML_DECLARATION}<w:${root} ${PART_NAMESPACES}><w:p/></w:${root}>`))
		this.contentTypes.push(
			`<Override PartName="/word/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${tag}+xml"/>`
		)

		const id = this.translator.relationship(tag, name, false)

		this.regionParts.set(key, id)

		return id
	}
}

// A paragraph exactly `points` tall: the spacing between a header (footer) and the body.
function spacerParagraph(points: number): Block {
	return paragraph(
		`<w:spacing w:before="0" w:after="0" w:line="${Math.max(1, twips(points))}" w:lineRule="exact"/>`,
		'<w:sz w:val="2"/>',
		""
	)
}

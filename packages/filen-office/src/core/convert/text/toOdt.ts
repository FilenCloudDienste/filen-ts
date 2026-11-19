import { openDocxPackage, type DocxPackage } from "../../docx/package"
import { nativeDeflate, nativeDeflateChunks } from "../../docx/write/zip"
import { OdfStyleResolver, readContentPrologue } from "../../odf/index"
import { OdfStyleSheet } from "../../odf/styles"
import { BytePieces, bytesSource, memorySink, writeZip, type Relationships } from "../../opc/index"
import { StyleMapper } from "../../odt/styles"
import {
	AtomPool,
	ListIds,
	noteId,
	noteReference,
	flattenedNote,
	OdfEmitter,
	OdtWriteRefusal,
	StyleRegistry,
	WrittenNotes,
	type EmitContext,
	type TableStream
} from "../../odt/write/emit"
import { StyleChains } from "../../odt/write/meaning"
import { RtfAborted, jobOf, turn, type RtfJob, type RtfTurns } from "../../rtf/turns"
import { decodeUtf8, encodeUtf8, escapeAttribute, escapeText, parseXml, type XmlDocument } from "../../xml/index"
import { LOWERED_NAMESPACES, LoweredIds, Lowering, MAX_TABLE_COLUMNS, type PartLinks, type Theme } from "./lower"
import { convertLists, convertStyles, FontFaces, pt, StyleNames, type ConvertedLists } from "./odtStyles"
import { LossyCounts, TextConversionError, type TextRefusalReason } from "./report"
import { isOn, NUMBER_FORMATS } from "./shared"
import { docToDocx } from "./toDocx"

// A WordprocessingML document (.docx, .docm, .dotx, .dotm) as an OpenDocument text (ODF 1.3): each story lowered to
// what the ODF writer's emitter writes (lower.ts), the styles, lists and sections converted (odtStyles.ts), the blocks
// written by the emitter the ODT writer rewrites blocks with (core/odt/write/emit.ts), pictures and text boxes as
// frames, headers and footers in master pages. A block the emitter cannot write is written with its text and
// paragraph style only, and counted; nothing is dropped silently.

export interface ToOdtOptions {
	readonly turns?: RtfTurns | undefined
}

const NS = {
	office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
	style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
	text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
	table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
	draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
	fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
	xlink: "http://www.w3.org/1999/xlink",
	dc: "http://purl.org/dc/elements/1.1/",
	meta: "urn:oasis:names:tc:opendocument:xmlns:meta:1.0",
	svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
	config: "urn:oasis:names:tc:opendocument:xmlns:config:1.0"
} as const
const ROOT_NAMESPACES = Object.entries(NS)
	.map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
	.join(" ")
const MEDIA_TYPE = "application/vnd.oasis.opendocument.text"
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'
// Blocks the emitter writes at once (a list stays one list within a run); a run that refuses is written block by block.
const RUN = 64
// A top-level table past so many rows is lowered and written that many rows at a time.
const STREAMED_ROWS = 256
// The most a conversion writes in all, charged per block and table row as it goes (so a hostile file is refused
// before its markup is held): within what our own reader opens (DEFAULT_ZIP_LIMITS, 512 MiB inflated) and what a
// browser worker holds, past 4 times the corpus' largest content.xml (Tariff's, 28 MB).
const WRITTEN_BUDGET = 192 * 1024 * 1024
// The most of a body this converts, refused before it is parsed: half again the corpus' largest (Tariff's
// document.xml, 131 MB); parsed and lowered it takes several times its size.
const SOURCE_BUDGET = 192 * 1024 * 1024
// The most one block's markup holds while it is written (UTF-16 units): its lowered form past 32 MiB is refused, and
// written it may grow several times (a space each becomes text:s).
const BLOCK_BUDGET = 16 * 1024 * 1024
// What lowering one run of blocks (or a notes, header or footer part) may make, held while it is written.
const LOWERED_BUDGET = 32 * 1024 * 1024
const IMAGE_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
	svg: "image/svg+xml",
	emf: "image/x-emf",
	wmf: "image/x-wmf",
	webp: "image/webp"
}
const EMU_PER_CM = 360_000
// LibreOffice's layout compatibility settings. A set it reads that misses one takes the value a document from before
// that setting would have (no external leading, the former line spacing, printer metrics), so every one is written:
// the values LibreOffice 7.5's Word import sets for a Word 2013 document (TabsRelativeToIndent false among them, as Word
// measures tab stops from the page margin), then what the document's own options change (below). Printing, the
// printer, the database, font embedding, saving and session ids are no layout and left out; protection is written
// when the source sets it.
const COMPATIBILITY_SETTINGS: readonly (readonly [name: string, type: string, value: string])[] = [
	["AddExternalLeading", "boolean", "true"],
	["AddFrameOffsets", "boolean", "false"],
	["AddParaLineSpacingToTableCells", "boolean", "true"],
	["AddParaSpacingToTableCells", "boolean", "true"],
	["AddParaTableSpacing", "boolean", "false"],
	["AddParaTableSpacingAtStart", "boolean", "true"],
	["AddVerticalFrameOffsets", "boolean", "true"],
	["AlignTabStopPosition", "boolean", "true"],
	["ApplyParagraphMarkFormatToNumbering", "boolean", "true"],
	["AutoFirstLineIndentDisregardLineSpace", "boolean", "true"],
	["BackgroundParaOverDrawings", "boolean", "true"],
	["CharacterCompressionType", "short", "0"],
	["ClipAsCharacterAnchoredWriterFlyFrames", "boolean", "false"],
	["ClippedPictures", "boolean", "true"],
	["CollapseEmptyCellPara", "boolean", "true"],
	["ConsiderTextWrapOnObjPos", "boolean", "true"],
	["ContinuousEndnotes", "boolean", "false"],
	["DisableOffPagePositioning", "boolean", "true"],
	["DoNotCaptureDrawObjsOnPage", "boolean", "false"],
	["DoNotJustifyLinesWithManualBreak", "boolean", "false"],
	["DoNotResetParaAttrsForNumFont", "boolean", "false"],
	["DropCapPunctuation", "boolean", "true"],
	["EmptyDbFieldHidesPara", "boolean", "true"],
	["FloattableNomargins", "boolean", "true"],
	["FootnoteInColumnToPageEnd", "boolean", "true"],
	["FrameAutowidthWithMorePara", "boolean", "true"],
	["GutterAtTop", "boolean", "false"],
	["HeaderSpacingBelowLastPara", "boolean", "true"],
	["IgnoreFirstLineIndentInNumbering", "boolean", "false"],
	["IgnoreTabsAndBlanksForLineCalculation", "boolean", "true"],
	["InvertBorderSpacing", "boolean", "true"],
	["IsKernAsianPunctuation", "boolean", "false"],
	["MathBaselineAlignment", "boolean", "true"],
	["MsWordCompMinLineHeightByFly", "boolean", "false"],
	["MsWordCompTrailingBlanks", "boolean", "true"],
	["NoNumberingShowFollowBy", "boolean", "true"],
	["OutlineLevelYieldsNumbering", "boolean", "false"],
	["PrinterIndependentLayout", "string", "high-resolution"],
	["PropLineSpacingShrinksFirstLine", "boolean", "true"],
	["SmallCapsPercentage66", "boolean", "false"],
	["SubtractFlysAnchoredAtFlys", "boolean", "false"],
	["SurroundTextWrapSmall", "boolean", "true"],
	["TabAtLeftIndentForParagraphsInList", "boolean", "true"],
	["TabOverMargin", "boolean", "false"],
	["TabOverSpacing", "boolean", "true"],
	["TabOverflow", "boolean", "true"],
	["TableRowKeep", "boolean", "true"],
	["TabsRelativeToIndent", "boolean", "false"],
	["TreatSingleColumnBreakAsPageBreak", "boolean", "true"],
	["UnbreakableNumberings", "boolean", "true"],
	["UnxForceZeroExtLeading", "boolean", "false"],
	["UseFormerLineSpacing", "boolean", "false"],
	["UseFormerObjectPositioning", "boolean", "false"],
	["UseFormerTextWrapping", "boolean", "false"],
	["UseOldNumbering", "boolean", "false"],
	["UseOldPrinterMetrics", "boolean", "false"],
	["WordLikeWrapForAsCharFlys", "boolean", "true"]
]
// Word's compatibility options (ECMA-376 Part 1 §17.15.3, Part 4 §14.8.3) and the setting LibreOffice 7.5's Word
// import gives each.
const COMPATIBILITY_OPTIONS: Readonly<Record<string, readonly [name: string, value: string]>> = {
	doNotExpandShiftReturn: ["DoNotJustifyLinesWithManualBreak", "true"],
	doNotUseHTMLParagraphAutoSpacing: ["AddParaTableSpacing", "true"],
	noLeading: ["AddExternalLeading", "false"],
	usePrinterMetrics: ["PrinterIndependentLayout", "disabled"]
}
// What LibreOffice 7.5's Word import sets for a layout before Word 2013's (compatibilityMode below 15, or none).
const BEFORE_WORD_2013 = ["AddFrameOffsets", "MsWordCompMinLineHeightByFly", "TabOverMargin"]
const WORD_URI = "http://schemas.microsoft.com/office/word"

function cm(emu: number): string {
	return `${String(Math.round((emu / EMU_PER_CM) * 10_000) / 10_000)}cm`
}

const DOCX_REFUSALS: Readonly<Record<string, TextRefusalReason>> = {
	encrypted: "encrypted",
	legacyBinary: "notSource",
	compoundFile: "notSource",
	notZip: "notSource",
	notWordprocessing: "notSource",
	invalidPackage: "corrupt",
	tooLarge: "tooLarge"
}

const NOTE_RESTARTS: Readonly<Record<string, string>> = { continuous: "document", eachPage: "page", eachSect: "chapter" }
const FOOTNOTE_POSITIONS: Readonly<Record<string, string>> = {
	pageBottom: "page",
	beneathText: "text",
	sectEnd: "section",
	docEnd: "document"
}
function child(document: XmlDocument, node: number, local: string): number {
	for (let at = document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at))
		if (document.localName(at) === local) return at

	return -1
}

function children(document: XmlDocument, node: number): number[] {
	const out: number[] = []

	for (let at = document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at)) out.push(at)

	return out
}

function descendant(document: XmlDocument, node: number, local: string): number {
	for (let at = document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at)) {
		if (document.localName(at) === local) return at

		const found = descendant(document, at, local)

		if (found >= 0) return found
	}

	return -1
}

// The registry's automatic styles markup names: only names are kept, not every attribute value (a substring would
// keep the whole markup string alive).
function collectReferences(text: string, registry: StyleRegistry, into: Set<string>): void {
	for (const match of text.matchAll(/="([^"]*)"/gu)) {
		const value = match[1] ?? ""

		if (registry.has(value)) into.add(value)
	}
}

// Table styles with conditional formatting (w:tblStylePr).
function conditionalTables(document: XmlDocument): Set<string> {
	const out = new Set<string>()

	for (const node of children(document, document.documentElement())) {
		if (document.localName(node) === "style" && child(document, node, "tblStylePr") >= 0)
			out.add(document.attribute(node, "w:styleId") ?? "")
	}

	return out
}

function partLinks(relationships: Relationships | undefined): PartLinks {
	return {
		relationship: id => {
			const relationship = relationships?.byId(id)

			if (relationship === undefined) return undefined

			return relationship.external
				? { target: relationship.target, external: true }
				: relationship.partName === undefined
					? undefined
					: { target: relationship.partName, external: false }
		}
	}
}

async function themeOf(pkg: DocxPackage): Promise<Theme | undefined> {
	const part = pkg.part("theme")

	if (part === undefined) return undefined

	try {
		const document = await pkg.xml(part)
		const scheme = (local: "majorFont" | "minorFont"): Theme["major"] => {
			const font = descendant(document, document.documentElement(), local)
			const face = (name: string): string | undefined => {
				const value = font < 0 ? undefined : document.attribute(child(document, font, name), "typeface")

				return value === "" ? undefined : value
			}
			const latin = face("latin")
			const eastAsia = face("ea")
			const cs = face("cs")

			return {
				...(latin === undefined ? {} : { latin }),
				...(eastAsia === undefined ? {} : { eastAsia }),
				...(cs === undefined ? {} : { cs })
			}
		}

		return { major: scheme("majorFont"), minor: scheme("minorFont") }
	} finally {
		pkg.release(part)
	}
}

// The emitter's view of one output stream (content.xml or styles.xml).
interface Stream {
	readonly registry: StyleRegistry
	readonly listIds: ListIds
	readonly context: EmitContext
	readonly emitter: OdfEmitter
}

interface Section {
	readonly sectPr: XmlDocument
	readonly root: number
	readonly first: number
}

interface StreamInputs {
	readonly sheet: OdfStyleSheet
	readonly mapper: StyleMapper
	readonly chains: StyleChains
	readonly styles: { readonly paragraph: ReadonlyMap<string, string>; readonly character: ReadonlyMap<string, string> }
	readonly lists: ConvertedLists
	readonly masterOf: ReadonlyMap<number, string>
	// The body run being written.
	readonly body: { readonly document: XmlDocument | undefined }
}

interface MasterPage {
	readonly name: string
	readonly layout: string
	// Each header or footer element, its part ("" for an empty one), and whether it shows.
	readonly stories: readonly (readonly [string, string, boolean])[]
}

class Converter {
	private readonly lossy: LossyCounts
	private readonly pkg: DocxPackage
	private readonly job: RtfJob | undefined
	private readonly ids = new LoweredIds()
	private readonly fonts = new FontFaces()
	private readonly taken = new Set<string>()
	private readonly names = new StyleNames(this.taken)
	// Pictures by source part: their path in the ODF package.
	private readonly media = new Map<string, string>()
	// Tracked changes' regions as written (text:tracked-changes), and those whose blocks are still being written.
	private readonly changes: Uint8Array[] = []
	private pendingChanges: { readonly open: string; readonly deleted: string; readonly close: string }[] = []
	private readonly lowered = new Map<string, XmlDocument>()
	private readonly stories = new Map<string, XmlDocument | undefined>()
	private readonly headerParts = new Map<string, string>()
	// Notes and comments by element and id, per lowered part.
	private readonly noteIndex = new WeakMap<XmlDocument, Map<string, number>>()
	// Lists written so far, by xml:id (continuable).
	private readonly listNames = new Set<string>()
	private spent = 0

	constructor(pkg: DocxPackage, lossy: LossyCounts, job: RtfJob | undefined) {
		this.pkg = pkg
		this.lossy = lossy
		this.job = job
	}

	private async xml(part: string | undefined): Promise<XmlDocument | undefined> {
		return part === undefined ? undefined : this.pkg.xml(part, this.job?.aborting)
	}

	private async links(part: string): Promise<PartLinks> {
		return partLinks(await this.pkg.relationships(part))
	}

	async run(): Promise<Uint8Array> {
		const pkg = this.pkg
		const lossy = this.lossy
		const facts = pkg.facts

		if (facts.macros) lossy.add("macros")
		if (facts.glossary) lossy.add("glossary")

		for (const entry of pkg.opc.zip.entries) {
			if (/^customXml\/item\d+\.xml$/iu.test(entry.name)) lossy.add("customXml")
			if (/\.odttf$/iu.test(entry.name)) lossy.add("embeddedFont")
		}

		const mainRelationships = await pkg.relationships(pkg.mainPart)

		for (const relationship of mainRelationships.all) {
			if (!relationship.external && relationship.partName !== undefined && /\/(?:header|footer)$/u.test(relationship.type))
				this.headerParts.set(relationship.id, relationship.partName)
		}

		const settings = await this.xml(pkg.settingsPart)
		const settingsRoot = settings?.documentElement() ?? -1
		const defaultTab = Number(
			settings === undefined ? Number.NaN : settings.attribute(child(settings, settingsRoot, "defaultTabStop"), "w:val")
		)
		const evenAndOdd = settings !== undefined && child(settings, settingsRoot, "evenAndOddHeaders") >= 0
		const protection = this.protection(settings)
		const tracking = protection.tracking || (settings !== undefined && isOn(settings, child(settings, settingsRoot, "trackRevisions")))
		const theme = await themeOf(pkg)
		const lowering = new Lowering(lossy, this.ids, theme)

		lowering.budget(LOWERED_BUDGET)
		const normalized = async (kind: string): Promise<XmlDocument | undefined> => {
			const part = pkg.part(kind)
			const document = await this.xml(part)

			if (part === undefined || document === undefined) return undefined

			pkg.release(part)

			return lowering.normalize(document)
		}
		const stylesDocument = await normalized("styles")
		const numberingDocument = await normalized("numbering")
		const styles = convertStyles(
			stylesDocument,
			this.fonts,
			this.names,
			lossy,
			Number.isFinite(defaultTab) && defaultTab > 0 ? defaultTab : 720
		)
		const lists = convertLists(numberingDocument, this.fonts, this.names, lossy)
		// A table style's conditional formatting has no ODF form: the chains read the styles without it.
		const chains = new StyleChains(stylesDocument === undefined ? undefined : this.withoutConditional(stylesDocument))
		lowering.use({
			chains,
			paragraphStyles: styles.paragraph,
			characterStyles: styles.character,
			lists,
			conditionalTables: stylesDocument === undefined ? new Set() : conditionalTables(stylesDocument)
		})

		await turn(this.job)

		// Notes and comments first (the body's references write them), lowered and parsed again.
		for (const kind of ["footnotes", "endnotes", "comments"] as const) {
			const part = pkg.part(kind)

			if (part === undefined) continue

			const lowered = lowering.notes(await pkg.xml(part, this.job?.aborting), await this.links(part), kind)

			pkg.release(part)
			this.lowered.set(kind, parseXml(encodeUtf8(lowered)))
			await turn(this.job)
		}

		const extended = pkg.part("commentsExtended")

		if (extended !== undefined) await this.commentThreads(extended)

		const main = pkg.mainPart

		if ((pkg.opc.entry(main)?.uncompressedSize ?? 0) > SOURCE_BUDGET)
			throw new TextConversionError("tooLarge", `The document's body is past ${String(SOURCE_BUDGET)} bytes.`)

		const source = await pkg.xml(main, this.job?.aborting)
		const body = lowering.openBody(source, partLinks(mainRelationships))
		const sections = body.sections.map(section => {
			const document = parseXml(encodeUtf8(`<w:root ${LOWERED_NAMESPACES}>${section.sectPr}</w:root>`))

			return { sectPr: document, root: document.firstChildElement(document.documentElement()), first: section.first }
		})

		// The style sheet the emitter reads (the converted common styles), and a content prologue to go with it.
		const commonStyles = `${styles.markup}${lists.markup}`
		const sheetStyles = parseXml(
			encodeUtf8(
				`${XML_DECLARATION}<office:document-styles ${ROOT_NAMESPACES} office:version="1.3">${this.fonts.markup()}<office:styles>${commonStyles}</office:styles></office:document-styles>`
			)
		)
		const prologue = readContentPrologue(
			encodeUtf8(
				`${XML_DECLARATION}<office:document-content ${ROOT_NAMESPACES} office:version="1.3"><office:automatic-styles/><office:body><office:text/></office:body></office:document-content>`
			)
		)
		const sheet = new OdfStyleSheet(sheetStyles, prologue)
		const mapper = new StyleMapper(sheet, new OdfStyleResolver(sheet), { tabsRelativeToIndent: false })
		const masters = this.masters(sections, body.blocks.length, evenAndOdd)
		const notesConfiguration = this.notesConfiguration(settings, sections)
		const masterOf = new Map<number, string>()
		const run: { document: XmlDocument | undefined } = { document: undefined }
		const content = this.stream("content", { sheet, mapper, chains, styles, lists, masterOf, body: run })
		const stylesStream = this.stream("styles", {
			sheet,
			mapper,
			chains,
			styles,
			lists,
			masterOf: new Map(),
			body: { document: undefined }
		})

		// The body, lowered, parsed and written a run of blocks at a time: no whole lowered copy is held, and what is
		// written is held as bytes.
		const written: Uint8Array[] = []
		const referenced = new Set<string>()
		// Forms protection: from each section's first block, whether Word protects it (w:formProt, on unless set off),
		// written as a protected text:section (Part 3 §5.4) as LibreOffice reads it.
		const formSections = new Map<number, boolean>()

		if (protection.forms)
			for (const section of sections) {
				const formProt = child(section.sectPr, section.root, "formProt")

				formSections.set(section.first, formProt < 0 || isOn(section.sectPr, formProt))
			}

		let inSection = false
		const sectionAt = (at: number): void => {
			const wanted = formSections.get(at)

			if (wanted === undefined || wanted === inSection) return

			written.push(
				encodeUtf8(
					inSection
						? "</text:section>"
						: `<text:section text:name="${escapeAttribute(this.names.name("Section"))}" text:protected="true">`
				)
			)
			inSection = wanted
		}

		for (let from = 0; from < body.blocks.length;) {
			await turn(this.job)
			sectionAt(from)

			// A long top-level table is written on its own, a few rows at a time.
			const table = body.blocks[from] ?? -1

			if (this.streamed(source, table)) {
				const name = masters.starts.get(from)

				for await (const piece of this.streamTable(content, lowering, table, name, from + 1 >= body.blocks.length, run, masterOf)) {
					collectReferences(piece, content.registry, referenced)
					written.push(encodeUtf8(piece))
					this.flushChanges(content.registry, referenced)
				}

				from++

				continue
			}

			let to = from + 1

			while (to < body.blocks.length && to - from < RUN && !this.streamed(source, body.blocks[to] ?? -1) && !formSections.has(to))
				to++

			const lowered = lowering.lowerBlocks(body.blocks.slice(from, to), to >= body.blocks.length)
			const document = parseXml(encodeUtf8(lowered.xml))
			const nodes = children(document, child(document, document.documentElement(), "body"))

			masterOf.clear()
			lowered.firsts.forEach((first, k) => {
				const name = masters.starts.get(from + k)

				if (name === undefined) return

				// A block that lowered to nothing: the page style starts with the next one that did.
				const at = first >= 0 ? first : lowered.firsts.slice(k + 1).find(next => next >= 0)
				const node = at === undefined ? undefined : nodes[at]

				if (node !== undefined && !masterOf.has(node)) masterOf.set(node, name)
			})
			run.document = document

			const text = this.continuable(this.resolved(content, this.blocks(content, document, nodes)))

			collectReferences(text, content.registry, referenced)

			// Charged as each block was written.
			written.push(encodeUtf8(text))
			this.flushChanges(content.registry, referenced)
			from = to
		}

		if (inSection) written.push(encodeUtf8("</text:section>"))

		pkg.release(main)

		// Master pages with their headers and footers.
		let masterStyles = ""
		// A header or footer each master page holds a copy of (ODF master pages share no content): written once and
		// copied where it names no unique id, each copy charged to the budget.
		const copies = new Map<string, string>()

		for (const master of masters.pages) {
			await turn(this.job)

			let inner = ""

			for (const [element, part, shown] of master.stories) {
				const document =
					part === "" ? undefined : await this.story(part, lowering, element.startsWith("style:header") ? "hdr" : "ftr")
				const copy = copies.get(part)
				let markup: string

				if (copy !== undefined) {
					this.spend(copy.length)
					markup = copy
				} else {
					markup =
						document === undefined ? "" : this.blocks(stylesStream, document, children(document, document.documentElement()))

					if (!/ (?:xml:id|office:name)="/u.test(markup)) copies.set(part, markup)
				}

				inner += `<${element}${shown ? "" : ' style:display="false"'}>${markup === "" ? "<text:p/>" : markup}</${element}>`
			}

			masterStyles += `<style:master-page style:name="${escapeAttribute(master.name)}" style:page-layout-name="${escapeAttribute(master.layout)}"${inner === "" ? "/>" : `>${inner}</style:master-page>`}`
		}

		await turn(this.job)
		this.flushChanges(content.registry, referenced)

		// Whether changes are tracked (w:trackRevisions, or forced by the editing restriction): Part 3 §5.5.1.
		const trackedChanges =
			this.changes.length === 0
				? tracking
					? [encodeUtf8('<text:tracked-changes text:track-changes="true"/>')]
					: []
				: [
						encodeUtf8(`<text:tracked-changes text:track-changes="${String(tracking)}">`),
						...this.changes,
						encodeUtf8("</text:tracked-changes>")
					]
		const contentHead =
			`${XML_DECLARATION}<office:document-content ${ROOT_NAMESPACES} office:version="1.3">${this.fonts.markup()}` +
			`<office:automatic-styles>${content.registry.used([], referenced)}</office:automatic-styles>` +
			"<office:body><office:text>"
		const contentXml = [
			encodeUtf8(contentHead),
			...trackedChanges,
			...written,
			encodeUtf8("</office:text></office:body></office:document-content>")
		]
		const masterText = this.continuable(this.resolved(stylesStream, masterStyles))
		const stylesXml =
			`${XML_DECLARATION}<office:document-styles ${ROOT_NAMESPACES} office:version="1.3">${this.fonts.markup()}` +
			`<office:styles>${commonStyles}${notesConfiguration}</office:styles>` +
			`<office:automatic-styles>${masters.layouts}${stylesStream.registry.used([masterText])}</office:automatic-styles>` +
			`<office:master-styles>${masterText}</office:master-styles></office:document-styles>`
		const settingsXml =
			// LibreOffice reads the set's name as a qualified name: without the ooo prefix declared it applies none of it.
			`${XML_DECLARATION}<office:document-settings ${ROOT_NAMESPACES} xmlns:ooo="http://openoffice.org/2004/office" office:version="1.3"><office:settings>` +
			`<config:config-item-set config:name="ooo:configuration-settings">${this.compatibility(settings)}` +
			(protection.readOnly ? '<config:config-item config:name="LoadReadonly" config:type="boolean">true</config:config-item>' : "") +
			(protection.forms ? '<config:config-item config:name="ProtectForm" config:type="boolean">true</config:config-item>' : "") +
			"</config:config-item-set>" +
			"</office:settings></office:document-settings>"

		return this.packageOf(contentXml, stylesXml, settingsXml, await this.metaXml())
	}

	// The layout compatibility settings for this document: its compatibility mode and options as LibreOffice's Word
	// import reads them (ECMA-376 Part 1 §17.15.1.50 gutterAtTop, §17.15.1.21 compat, §17.15.3.4 compatSetting).
	private compatibility(settings: XmlDocument | undefined): string {
		const changed = new Map<string, string>()
		const root = settings?.documentElement() ?? -1
		const compat = settings === undefined ? -1 : child(settings, root, "compat")
		let mode = Number.NaN

		if (settings !== undefined && compat >= 0)
			for (const option of children(settings, compat)) {
				const local = settings.localName(option)
				const setting = COMPATIBILITY_OPTIONS[local]

				if (setting !== undefined && isOn(settings, option)) changed.set(setting[0], setting[1])
				else if (
					local === "compatSetting" &&
					settings.attribute(option, "w:name") === "compatibilityMode" &&
					settings.attribute(option, "w:uri") === WORD_URI
				)
					mode = Number(settings.attribute(option, "w:val")?.trim() ?? "")
			}

		if (!(mode >= 15)) for (const name of BEFORE_WORD_2013) changed.set(name, "true")
		// Without settings LibreOffice keeps the fixed spacing that w:doNotUseHTMLParagraphAutoSpacing asks for.
		if (settings === undefined) changed.set("AddParaTableSpacing", "true")
		if (settings !== undefined && isOn(settings, child(settings, root, "gutterAtTop"))) changed.set("GutterAtTop", "true")

		let out = ""

		for (const [name, type, value] of COMPATIBILITY_SETTINGS)
			out += `<config:config-item config:name="${name}" config:type="${type}">${changed.get(name) ?? value}</config:config-item>`

		return out
	}

	// Word's editing restriction (w:documentProtection, when enforced) and its recommendation to open read-only
	// (w:writeProtection) as LibreOffice keeps them: read-only as LoadReadonly, forms as ProtectForm (and protected
	// sections), forced change tracking as tracking on. What an OpenDocument text has no form for is counted.
	private protection(settings: XmlDocument | undefined): { readOnly: boolean; forms: boolean; tracking: boolean } {
		const root = settings?.documentElement() ?? -1
		const restriction = settings === undefined ? -1 : child(settings, root, "documentProtection")
		const recommended = settings === undefined ? -1 : child(settings, root, "writeProtection")
		const enforced = settings !== undefined && restriction >= 0 && isOn(settings, restriction, "w:enforcement", false)
		const edit = enforced ? (settings.attribute(restriction, "w:edit") ?? "none") : "none"
		const password = (node: number): boolean =>
			settings !== undefined &&
			node >= 0 &&
			(settings.attribute(node, "w:hash") ?? settings.attribute(node, "w:hashValue")) !== undefined

		// Comments-only editing has no ODF form; forced tracking's lock and a restriction's password neither.
		if (edit === "comments" || edit === "trackedChanges") this.lossy.add("documentProtection")
		if ((edit === "readOnly" || edit === "forms") && password(restriction)) this.lossy.add("documentProtection")
		if (password(recommended)) this.lossy.add("documentProtection")

		return { readOnly: edit === "readOnly" || recommended >= 0, forms: edit === "forms", tracking: edit === "trackedChanges" }
	}

	// Footnote and endnote numbering and placement (w:footnotePr, w:endnotePr: the document's, then each section's) as
	// text:notes-configuration (Part 3 §16.31.3). Numbering from 1 leaves text:start-value out (its default, §19.874.5);
	// another start is written counted from 0, as LibreOffice reads and writes it.
	private notesConfiguration(settings: XmlDocument | undefined, sections: readonly Section[]): string {
		let out = ""

		for (const kind of ["footnote", "endnote"] as const) {
			const fromSettings = settings === undefined ? -1 : child(settings, settings.documentElement(), `${kind}Pr`)
			const value = (local: string, fallback: string): string[] =>
				(sections.length === 0 ? [undefined] : sections).map(section => {
					const own =
						section === undefined || section.root < 0
							? undefined
							: section.sectPr.attribute(
									child(section.sectPr, child(section.sectPr, section.root, `${kind}Pr`), local),
									"w:val"
								)

					return own ?? settings?.attribute(child(settings, fromSettings, local), "w:val") ?? fallback
				})
			const settled = (values: readonly string[]): string => {
				if (values.some(other => other !== values[0])) this.lossy.add("noteSettings")

				return values[0] ?? ""
			}
			const format = settled(value("numFmt", kind === "footnote" ? "decimal" : "lowerRoman"))
			const start = Number(settled(value("numStart", "1")))
			const restart = settled(value("numRestart", "continuous"))
			const position = settled(value("pos", kind === "footnote" ? "pageBottom" : "docEnd"))
			const written = NUMBER_FORMATS[format]

			if (written === undefined) this.lossy.add("noteSettings")

			let attributes = ` style:num-format="${written ?? "1"}"${written === "a" || written === "A" ? ' style:num-letter-sync="true"' : ""}`

			if (Number.isInteger(start) && start > 1) attributes += ` text:start-value="${String(start - 1)}"`

			if (kind === "footnote") {
				const at = FOOTNOTE_POSITIONS[position]
				const restarts = NOTE_RESTARTS[restart]

				// Numbering per section has none (chapter: LibreOffice's nearest, §19.875).
				if (at === undefined) this.lossy.add("noteSettings")
				if (restarts === undefined || restart === "eachSect") this.lossy.add("noteSettings")

				attributes += ` text:footnotes-position="${at ?? "page"}" text:start-numbering-at="${restarts ?? "document"}"`
			} else {
				// Endnotes number through the document, after its end.
				if (restart !== "continuous") this.lossy.add("noteSettings")
				if (position !== "docEnd") this.lossy.add("noteSettings")
			}

			out += `<text:notes-configuration text:note-class="${kind}"${attributes}/>`
		}

		return out
	}

	private withoutConditional(document: XmlDocument): XmlDocument {
		const text = decodeUtf8(document.bytes)

		if (!text.includes("tblStylePr")) return document

		return parseXml(encodeUtf8(text.replace(/<w:tblStylePr\b[\s\S]*?<\/w:tblStylePr>/gu, "")))
	}

	private async commentThreads(part: string): Promise<void> {
		const document = await this.xml(part)

		if (document === undefined) return

		const text = decodeUtf8(document.bytes)

		this.lossy.add("commentThread", (text.match(/paraIdParent=/gu) ?? []).length + (text.match(/done="1"/gu) ?? []).length)
		this.pkg.release(part)
	}

	private async story(part: string, lowering: Lowering, root: "hdr" | "ftr"): Promise<XmlDocument | undefined> {
		if (this.stories.has(part)) return this.stories.get(part)

		let document: XmlDocument | undefined

		if (this.pkg.has(part)) {
			const source = await this.pkg.xml(part, this.job?.aborting)

			document = parseXml(encodeUtf8(lowering.story(source, await this.links(part), root)))
			this.pkg.release(part)
		}

		this.stories.set(part, document)

		return document
	}

	// --- Emitting ---

	private stream(scope: "content" | "styles", inputs: StreamInputs): Stream {
		const registry = new StyleRegistry(this.taken, "")
		const listIds = new ListIds(() => registry.name("list", true))
		const bookmarkNames = new WeakMap<XmlDocument, Map<string, string>>()
		const item = (
			kind: "footnotes" | "endnotes" | "comments",
			local: string,
			id: string
		): { document: XmlDocument; node: number } | undefined => {
			const document = this.lowered.get(kind)

			if (document === undefined) return undefined

			let index = this.noteIndex.get(document)

			if (index === undefined) {
				index = new Map()

				for (const node of children(document, document.documentElement()))
					index.set(`${document.localName(node)}\u0000${document.attribute(node, "w:id") ?? ""}`, node)

				this.noteIndex.set(document, index)
			}

			const node = index.get(`${local}\u0000${id}`)

			return node === undefined ? undefined : { document, node }
		}
		const holder: { stream?: Stream } = {}
		const context: EmitContext = {
			scope,
			sheet: inputs.sheet,
			mapper: inputs.mapper,
			chains: inputs.chains,
			registry,
			listIds,
			fonts: this.fonts,
			tabsRelativeToIndent: false,
			atoms: new AtomPool(),
			declarations: "",
			paragraphStyle: id => inputs.styles.paragraph.get(id),
			characterStyle: id => inputs.styles.character.get(id),
			hyperlink: id => this.ids.hyperlinks.get(id),
			change: (kind, author, date, deleted) => {
				const id = registry.name("ct", true)
				const open = `<text:changed-region xml:id="${escapeAttribute(id)}" text:id="${escapeAttribute(id)}"><text:${kind}><office:change-info><dc:creator>${escapeText(author)}</dc:creator><dc:date>${escapeText((date ?? "1970-01-01T00:00:00").replace(/Z$/u, ""))}</dc:date></office:change-info>`
				const close = `</text:${kind}></text:changed-region>`
				// Its lists named by the stream that wrote it, and charged as written: held as bytes once its blocks are.
				const region = { open, deleted: holder.stream === undefined ? deleted : this.resolved(holder.stream, deleted), close }

				this.spend(open.length + region.deleted.length + close.length)
				this.pendingChanges.push(region)

				return id
			},
			picture: (document, drawing) => this.frame(document, drawing, holder.stream),
			list: numId => inputs.lists.target(numId),
			masterOf: (document, node) => (document === inputs.body.document ? inputs.masterOf.get(node) : undefined),
			levelIndent: (numId, ilvl) => inputs.lists.indent(numId, ilvl),
			levelStart: (numId, ilvl) => inputs.lists.start(numId, ilvl),
			sourceListId: () => undefined,
			continuesLists: true,
			note: (kind, id) => item(kind === "footnote" ? "footnotes" : "endnotes", kind, id),
			comment: id => item("comments", "comment", id),
			drawingKey: () => "",
			shellKey: () => "",
			noteKey: (kind, id) => `${kind}:${id}`,
			notes: new WrittenNotes(),
			spend: (bytes, held) => this.spend(bytes, held),
			lose: kind => this.lossy.add(kind),
			commentKey: id => `comment:${id}`,
			fieldKey: () => "",
			referenceMarks: new Set(),
			sourceBookmarks: new Set(),
			paragraphSources: new Map(),
			links: new Map(),
			bookmarkName: (document, id) => {
				let names = bookmarkNames.get(document)

				if (names === undefined) {
					names = new Map()

					for (let node = 0; node < document.count; node++) {
						if (document.localName(node) === "bookmarkStart")
							names.set(document.attribute(node, "w:id") ?? "", document.attribute(node, "w:name") ?? "")
					}

					bookmarkNames.set(document, names)
				}

				return names.get(id)
			}
		}
		const stream: Stream = { registry, listIds, context, emitter: new OdfEmitter(context) }

		holder.stream = stream

		return stream
	}

	// Written markup with its lists' ids: every list it holds named, as a list written later may continue any of them.
	private resolved(stream: Stream, text: string): string {
		for (let at = text.indexOf("\u0002"); at >= 0; at = text.indexOf("\u0002", at + 1)) {
			const end = text.indexOf("\u0003", at)

			if (end > at) stream.listIds.id(Number(text.slice(at + 1, end)))
		}

		return stream.listIds.resolve(text)
	}

	// A list continuing one that was not written (its paragraphs fell back to plain text) numbers anew: its
	// text:continue-list (Part 3 §19.785) left out, counted.
	private continuable(text: string): string {
		for (const match of text.matchAll(/<text:list\b[^>]*?\sxml:id="([^"]*)"/gu)) this.listNames.add(match[1] ?? "")

		return text.replace(/ text:continue-list="([^"]*)"/gu, (attribute, id: string) => {
			if (this.listNames.has(id)) return attribute

			this.lossy.add("listFormat")

			return ""
		})
	}

	// The change regions of blocks now written, as bytes: a list they continue is known by now (continuable).
	// `registry`: the content stream's, whose styles `referenced` collects.
	private flushChanges(registry: StyleRegistry, referenced: Set<string>): void {
		if (this.pendingChanges.length === 0) return

		let text = ""

		for (const { open, deleted, close } of this.pendingChanges) {
			const written = deleted.includes("<text:list") ? this.continuable(deleted) : deleted

			collectReferences(written, registry, referenced)
			text += `${open}${written}${close}`
		}

		this.changes.push(encodeUtf8(text))
		this.pendingChanges = []
	}

	// `held`: the markup of the block being written so far, past what one block may hold.
	private spend(bytes: number, held = 0): void {
		this.spent += bytes

		if (held > BLOCK_BUDGET) throw new TextConversionError("tooLarge", `A block past ${String(BLOCK_BUDGET)} characters.`)

		if (this.spent > WRITTEN_BUDGET)
			throw new TextConversionError("tooLarge", `The OpenDocument text would be past ${String(WRITTEN_BUDGET)} bytes.`)
	}

	// Whether a top-level block is a table long enough to be written a few rows at a time.
	private streamed(source: XmlDocument, node: number): boolean {
		if (node < 0 || source.localName(node) !== "tbl") return false

		let rows = 0

		for (let at = source.firstChildElement(node); at >= 0; at = source.nextSiblingElement(at))
			if (source.localName(at) === "tr" && ++rows > STREAMED_ROWS) return true

		return false
	}

	// A long table lowered and written STREAMED_ROWS rows at a time, its markup given as it is final (a cell spanning
	// down held until its span is known): memory follows what is written. A row the emitter refuses is written with
	// its text only (counted); a table it refuses whole, every row so.
	private async *streamTable(
		content: Stream,
		lowering: Lowering,
		table: number,
		master: string | undefined,
		last: boolean,
		run: { document: XmlDocument | undefined },
		masterOf: Map<number, string>
	): AsyncGenerator<string> {
		const parts = lowering.tableStream(table)
		const lowered = (inner: string): XmlDocument =>
			parseXml(encodeUtf8(`<w:document ${LOWERED_NAMESPACES}><w:body>${inner}</w:body></w:document>`))
		const columns = Math.min(MAX_TABLE_COLUMNS, Math.max(1, parts.width))
		let emitted: { readonly state: TableStream } | undefined
		let held = ""
		// Where in `held` the cells spanning down take their spans, by offset.
		const slots: { at: number; id: number }[] = []

		if (parts.before !== "") {
			const document = lowered(parts.before)
			const nodes = children(document, child(document, document.documentElement(), "body"))

			masterOf.clear()

			if (master !== undefined && nodes[0] !== undefined) masterOf.set(nodes[0], master)

			run.document = document

			yield this.continuable(this.resolved(content, this.blocks(content, document, nodes)))
		}

		for (let from = 0; from < parts.rows.length; from += STREAMED_ROWS) {
			await turn(this.job)

			const document = lowered(
				`${parts.head}${lowering.tableRows(parts.rows.slice(from, from + STREAMED_ROWS), parts.width)}</w:tbl>`
			)
			const node = child(document, child(document, document.documentElement(), "body"), "tbl")

			run.document = document

			masterOf.clear()

			if (from === 0) {
				// The table starts the page style a section break before it names (the paragraph before it took it).
				if (master !== undefined && parts.before === "") masterOf.set(node, master)

				const spent = this.spent

				try {
					const start = content.emitter.tableStart(document, node, parts.rows.length)

					this.spend(start.markup.length)
					held = start.markup
					emitted = { state: start.state }
				} catch (error) {
					if (!(error instanceof OdtWriteRefusal)) throw error

					this.spent = spent
					this.lossy.add("blockFormat")
					held = this.plainTableStart(content, columns)
					this.spend(held.length)
				}
			}

			const state = emitted?.state

			if (state === undefined) {
				for (const row of children(document, node)) {
					if (document.localName(row) !== "tr") continue

					const plain = this.plainRow(content, document, row, columns)

					this.spend(plain.length)
					held += plain
				}
			} else {
				content.emitter.tableRows(document, node, from, state, (write, row) => {
					const changes = this.pendingChanges.length
					const notes = content.context.notes?.size ?? 0
					const spent = this.spent

					try {
						// Charged as it was written.
						const row = write()

						for (const slot of row.slots) slots.push({ at: held.length + slot.at, id: slot.id })

						held += row.markup
					} catch (error) {
						if (!(error instanceof OdtWriteRefusal)) throw error

						this.pendingChanges.length = changes
						content.context.notes?.rollback(notes)
						this.spent = spent
						this.lossy.add("blockFormat")

						const plain = content.emitter.tableInterrupt(state) + this.plainRow(content, document, row, state.columns)

						this.spend(plain.length)
						held += plain
					}
				})
			}

			// What is final goes; what a cell spanning down still waits on stays.
			if (state === undefined || content.emitter.tableSettled(state)) {
				yield this.continuable(
					this.resolved(content, state === undefined ? held : content.emitter.tableResolve(held, slots, state))
				)
				held = ""
				slots.length = 0
			}
		}

		held += emitted === undefined ? "</table:table>" : content.emitter.tableEnd(emitted.state)

		if (emitted !== undefined) held = content.emitter.tableResolve(held, slots, emitted.state)

		yield this.continuable(this.resolved(content, held))

		if (last) {
			const tail = lowering.lowerBlocks([], true)
			const document = parseXml(encodeUtf8(tail.xml))

			yield this.continuable(
				this.resolved(
					content,
					this.blocks(content, document, children(document, child(document, document.documentElement(), "body")))
				)
			)
		}
	}

	// Blocks written by the emitter: a run at once, or (when the run refuses) each block on its own; a block that
	// refuses alone is written plain.
	private blocks(stream: Stream, document: XmlDocument, nodes: readonly number[]): string {
		const changes = this.pendingChanges.length
		const notes = stream.context.notes?.size ?? 0
		const spent = this.spent

		try {
			return stream.emitter.blocks(document, nodes)
		} catch (error) {
			if (!(error instanceof OdtWriteRefusal)) throw error

			this.pendingChanges.length = changes
			stream.context.notes?.rollback(notes)
			this.spent = spent
		}

		let out = ""

		for (const node of nodes) {
			const before = this.pendingChanges.length
			const notesBefore = stream.context.notes?.size ?? 0
			const spentBefore = this.spent

			try {
				out += stream.emitter.blocks(document, [node])
			} catch (error) {
				if (!(error instanceof OdtWriteRefusal)) throw error

				this.pendingChanges.length = before
				stream.context.notes?.rollback(notesBefore)
				this.spent = spentBefore
				this.lossy.add("blockFormat")

				const plain = this.plainBlock(stream, document, node)

				this.spend(plain.length)
				out += plain
			}
		}

		return out
	}

	// A block with its text and paragraph style only (a table: its rows and cells), its notes with it.
	private plainBlock(stream: Stream, document: XmlDocument, node: number): string {
		const local = document.localName(node)

		if (local === "tbl") {
			const rows = children(document, node).filter(row => document.localName(row) === "tr")
			const grid = child(document, node, "tblGrid")
			// The lowering bounded both (a grid past what a table holds is cut to its widest row).
			const columns = Math.min(
				MAX_TABLE_COLUMNS,
				Math.max(1, grid < 0 ? 0 : children(document, grid).length, ...rows.map(row => this.rowWidth(document, row)))
			)
			let out = this.plainTableStart(stream, columns)

			for (const row of rows) out += this.plainRow(stream, document, row, columns)

			return `${out}</table:table>`
		}

		if (local !== "p") return ""

		const pPr = child(document, node, "pPr")
		const styleId = pPr < 0 ? undefined : document.attribute(child(document, pPr, "pStyle"), "w:val")
		const style = styleId === undefined ? undefined : stream.context.paragraphStyle(styleId)
		const after: string[] = []
		const inner = this.plainInline(stream, document, node, after)

		return `<text:p${style === undefined ? "" : ` text:style-name="${escapeAttribute(style)}"`}>${inner}</text:p>${after.join("")}`
	}

	private plainTableStart(stream: Stream, columns: number): string {
		return `<table:table table:name="${escapeAttribute(stream.registry.name("Table", true))}"><table:table-column table:number-columns-repeated="${String(columns)}"/>`
	}

	// A row with its cells' text and paragraph styles only, as wide as the table's `columns`.
	private plainRow(stream: Stream, document: XmlDocument, row: number, columns: number): string {
		let cells = ""
		let used = 0

		for (const cell of children(document, row)) {
			if (document.localName(cell) !== "tc") continue

			const span = this.cellSpan(document, cell)
			const inner = children(document, cell)
				.filter(block => document.localName(block) === "p" || document.localName(block) === "tbl")
				.map(block => this.plainBlock(stream, document, block))
				.join("")

			cells += `<table:table-cell${span > 1 ? ` table:number-columns-spanned="${String(span)}"` : ""} office:value-type="string">${inner === "" ? "<text:p/>" : inner}</table:table-cell>`
			cells += "<table:covered-table-cell/>".repeat(span - 1)
			used += span
		}

		if (used < columns) cells += "<table:table-cell/>".repeat(columns - used)

		return `<table:table-row>${cells}</table:table-row>`
	}

	private rowWidth(document: XmlDocument, row: number): number {
		let width = 0

		for (const cell of children(document, row)) if (document.localName(cell) === "tc") width += this.cellSpan(document, cell)

		return width
	}

	private cellSpan(document: XmlDocument, cell: number): number {
		const tcPr = child(document, cell, "tcPr")
		const span = Number(tcPr < 0 ? "1" : (document.attribute(child(document, tcPr, "gridSpan"), "w:val") ?? "1"))

		return Number.isInteger(span) && span > 0 ? Math.min(span, MAX_TABLE_COLUMNS) : 1
	}

	private plainInline(stream: Stream, document: XmlDocument, node: number, after: string[]): string {
		let out = ""
		let spaces = 0
		let leading = true
		// Characters written: every so many, what the block holds is checked.
		let written = 0
		const flushSpaces = (): void => {
			if (spaces === 0) return

			if (leading) out += spaces === 1 ? "<text:s/>" : `<text:s text:c="${String(spaces)}"/>`
			else out += spaces === 1 ? " " : ` <text:s${spaces === 2 ? "" : ` text:c="${String(spaces - 1)}"`}/>`

			spaces = 0
		}
		const walk = (at: number): void => {
			for (let item = document.firstChildElement(at); item >= 0; item = document.nextSiblingElement(item)) {
				const local = document.localName(item)

				switch (local) {
					case "pPr":
					case "rPr":
					case "del":
						break
					case "t":
						for (const character of document.textContent(item)) {
							if (character === " ") {
								spaces++

								continue
							}

							flushSpaces()

							// Charged with the block once written; refused here as soon as it outgrows one.
							if (++written % 65_536 === 0) this.spend(0, out.length)
							leading = false
							out += escapeText(character)
						}

						break
					case "tab":
						flushSpaces()
						out += "<text:tab/>"
						leading = false
						break
					case "br":
					case "cr":
						flushSpaces()
						out += "<text:line-break/>"
						leading = false
						break
					case "footnoteReference":
					case "endnoteReference": {
						const kind = local === "footnoteReference" ? "footnote" : "endnote"
						const id = document.attribute(item, "w:id") ?? ""
						const note = stream.context.note(kind, id)
						const notes = stream.context.notes

						if (note !== undefined && notes !== undefined) {
							flushSpaces()

							const shown = notes.citation(kind, id)

							if (notes.depth > 0 || stream.context.scope === "styles")
								out += escapeText(
									flattenedNote(
										(noteKind, noteId) => stream.context.note(noteKind, noteId),
										kind,
										id,
										"",
										() => this.lossy.add("nestedNote"),
										new Set(notes.open)
									)
								)
							else if (shown !== undefined) out += noteReference(kind, id, shown)
							else {
								notes.add(kind, id, undefined)
								notes.depth++
								notes.open.add(`${kind}:${id}`)

								let blocks: string

								try {
									blocks = children(note.document, note.node)
										.map(block => this.plainBlock(stream, note.document, block))
										.join("")
								} finally {
									notes.depth--
									notes.open.delete(`${kind}:${id}`)
								}

								out += `<text:note text:note-class="${kind}" text:id="${escapeAttribute(noteId(kind, id))}"><text:note-citation/><text:note-body>${blocks === "" ? "<text:p/>" : blocks}</text:note-body></text:note>`
							}

							leading = false
						}

						break
					}
					case "drawing": {
						const box = descendant(document, item, "txbxContent")

						if (box >= 0) for (const block of children(document, box)) after.push(this.plainBlock(stream, document, block))

						break
					}
					default:
						walk(item)
				}
			}
		}

		walk(node)
		flushSpaces()

		return out
	}

	// --- Frames ---

	// A picture or a text box as a draw:frame: inline as a character, else anchored to its paragraph's
	// character where Word positions it, with its wrapping and distances; "" (counted) for what is neither.
	private frame(document: XmlDocument, drawing: number, stream: Stream | undefined): string {
		const holder = document.firstChildElement(drawing)

		if (holder < 0 || stream === undefined) return ""

		const inline = document.localName(holder) === "inline"
		const extent = child(document, holder, "extent")
		const width = Number(document.attribute(extent, "cx") ?? "0")
		const height = Number(document.attribute(extent, "cy") ?? "0")
		const docPr = child(document, holder, "docPr")
		const title = document.attribute(docPr, "title") ?? ""
		const description = document.attribute(docPr, "descr") ?? ""
		const graphic = new Map<string, string>()
		let anchor = ' text:anchor-type="as-char"'
		let position = ""

		if (inline) {
			graphic.set("style:vertical-pos", "top")
			graphic.set("style:vertical-rel", "baseline")
		} else {
			anchor = ' text:anchor-type="char"'

			const horizontal = this.axis(document, child(document, holder, "positionH"), "H")
			const vertical = this.axis(document, child(document, holder, "positionV"), "V")

			graphic.set("style:horizontal-pos", horizontal.pos)
			graphic.set("style:horizontal-rel", horizontal.rel)
			graphic.set("style:vertical-pos", vertical.pos)
			graphic.set("style:vertical-rel", vertical.rel)

			if (horizontal.offset !== undefined) position += ` svg:x="${cm(horizontal.offset)}"`
			if (vertical.offset !== undefined) position += ` svg:y="${cm(vertical.offset)}"`

			this.wrap(document, holder, graphic)
		}

		for (const [side, attribute] of [
			["top", "distT"],
			["bottom", "distB"],
			["left", "distL"],
			["right", "distR"]
		] as const) {
			const value = Number(document.attribute(holder, attribute) ?? "0")

			if (value > 0) graphic.set(`fo:margin-${side}`, cm(value))
		}

		const box = child(document, holder, "txbxContent")
		let content: string

		if (box >= 0) {
			const blocks = children(document, box)
			// An emitter of its own: the text box's lists and spans are its own.
			const nested = new OdfEmitter(stream.context)
			const notes = stream.context.notes?.size ?? 0
			let markup: string

			try {
				markup = nested.blocks(document, blocks)
			} catch (error) {
				if (!(error instanceof OdtWriteRefusal)) throw error

				stream.context.notes?.rollback(notes)
				this.lossy.add("blockFormat")
				markup = blocks.map(block => this.plainBlock(stream, document, block)).join("")
			}

			const insets = child(document, holder, "bodyPr")

			for (const [side, attribute, fallback] of [
				["top", "tIns", 45_720],
				["bottom", "bIns", 45_720],
				["left", "lIns", 91_440],
				["right", "rIns", 91_440]
			] as const)
				graphic.set(`fo:padding-${side}`, cm(Number(document.attribute(insets, attribute) ?? String(fallback))))

			graphic.set("fo:border", document.attribute(child(document, holder, "line"), "value") ?? "none")

			const fill = document.attribute(child(document, holder, "fill"), "color")

			if (fill !== undefined) {
				graphic.set("draw:fill", "solid")
				graphic.set("draw:fill-color", fill)
			} else graphic.set("draw:fill", "none")

			content = `<draw:text-box>${markup === "" ? "<text:p/>" : markup}</draw:text-box>`
		} else {
			const blip = child(document, holder, "blip")
			const part = this.ids.pictures.get(document.attribute(blip, "r:embed") ?? "")

			if (part === undefined) {
				this.lossy.add("drawing")

				return ""
			}

			let path = this.media.get(part)

			if (path === undefined) {
				const extension = (/\.([A-Za-z0-9]+)$/u.exec(part)?.[1] ?? "png").toLowerCase()

				path = `Pictures/${String(this.media.size + 1)}.${extension}`
				this.media.set(part, path)
			}

			content = `<draw:image xlink:href="${escapeAttribute(path)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>`
		}

		const attributes = [...graphic]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
			.join("")
		const style = stream.registry.style("graphic", "fr", "", `<style:graphic-properties${attributes}/>`)
		const name = stream.registry.name(box >= 0 ? "Frame" : "Image", true)
		const titled = `${title === "" ? "" : `<svg:title>${escapeText(title)}</svg:title>`}${description === "" ? "" : `<svg:desc>${escapeText(description)}</svg:desc>`}`

		return `<draw:frame draw:style-name="${escapeAttribute(style)}" draw:name="${escapeAttribute(name)}"${anchor}${position} svg:width="${cm(width)}" svg:height="${cm(height)}">${content}${titled}</draw:frame>`
	}

	// wp:positionH / wp:positionV as ODF's horizontal and vertical position and relation
	// (style:horizontal-pos, style:horizontal-rel, style:vertical-pos, style:vertical-rel).
	private axis(document: XmlDocument, node: number, axis: "H" | "V"): { pos: string; rel: string; offset?: number } {
		const from = document.attribute(node, "relativeFrom") ?? (axis === "H" ? "column" : "paragraph")
		const relations: Readonly<Record<string, string>> =
			axis === "H"
				? {
						page: "page",
						margin: "page-content",
						column: "paragraph",
						character: "char",
						leftMargin: "page-start-margin",
						rightMargin: "page-end-margin",
						insideMargin: "page-start-margin",
						outsideMargin: "page-end-margin"
					}
				: {
						page: "page",
						margin: "page-content",
						paragraph: "paragraph",
						line: "line",
						topMargin: "page",
						bottomMargin: "page",
						insideMargin: "page",
						outsideMargin: "page"
					}
		const rel = relations[from] ?? "paragraph"
		const alignNode = child(document, node, "align")

		if (alignNode >= 0) {
			const align = document.textContent(alignNode).trim()
			const positions: Readonly<Record<string, string>> =
				axis === "H"
					? { left: "left", center: "center", right: "right", inside: "inside", outside: "outside" }
					: { top: "top", center: "middle", bottom: "bottom", inside: "top", outside: "bottom" }

			return { pos: positions[align] ?? (axis === "H" ? "left" : "top"), rel }
		}

		const value = Number(document.textContent(child(document, node, "posOffset")))

		return { pos: axis === "H" ? "from-left" : "from-top", rel, offset: Number.isFinite(value) ? value : 0 }
	}

	// Word's wrapping as style:wrap and style:run-through.
	private wrap(document: XmlDocument, holder: number, graphic: Map<string, string>): void {
		const behind = document.attribute(holder, "behindDoc") === "1"

		for (const node of children(document, holder)) {
			const local = document.localName(node)

			if (local === "wrapTopAndBottom") {
				graphic.set("style:wrap", "none")

				return
			}

			if (local === "wrapSquare" || local === "wrapTight" || local === "wrapThrough") {
				const side = document.attribute(node, "wrapText") ?? "bothSides"

				graphic.set(
					"style:wrap",
					side === "left" ? "left" : side === "right" ? "right" : side === "largest" ? "dynamic" : "parallel"
				)

				// Contour wrapping: wrapped around the frame's box.
				if (local !== "wrapSquare") this.lossy.add("drawing")

				return
			}
		}

		graphic.set("style:wrap", "run-through")
		graphic.set("style:run-through", behind ? "background" : "foreground")
	}

	// --- Sections ---

	private masters(
		sections: readonly Section[],
		blocks: number,
		evenAndOdd: boolean
	): { readonly layouts: string; readonly pages: readonly MasterPage[]; readonly starts: ReadonlyMap<number, string> } {
		const layouts = new Map<string, string>()
		const pages = new Map<string, MasterPage>()
		const starts = new Map<number, string>()
		const inherited = new Map<string, string>()
		let layoutMarkup = ""
		let previous: string | undefined

		sections.forEach((section, k) => {
			const { sectPr, root } = section
			const value = (local: string, attribute: string): string | undefined =>
				root < 0 ? undefined : sectPr.attribute(child(sectPr, root, local), `w:${attribute}`)
			const number = (local: string, attribute: string, fallback: number): number => {
				const parsed = Number(value(local, attribute) ?? Number.NaN)

				return Number.isFinite(parsed) ? parsed : fallback
			}

			// Headers and footers a section does not name are the previous section's.
			if (root >= 0) {
				for (const reference of children(sectPr, root)) {
					const local = sectPr.localName(reference)

					if (local !== "headerReference" && local !== "footerReference") continue

					const part = this.headerParts.get(sectPr.attribute(reference, "r:id") ?? "")

					if (part !== undefined) inherited.set(`${local}:${sectPr.attribute(reference, "w:type") ?? "default"}`, part)
				}
			}

			const titlePage = root >= 0 && isOn(sectPr, child(sectPr, root, "titlePg"))
			const stories: [string, string, boolean][] = []

			for (const kind of ["header", "footer"] as const) {
				const reference = `${kind}Reference`
				const part = (type: string): string | undefined => inherited.get(`${reference}:${type}`)

				if (part("default") === undefined && part("even") === undefined && part("first") === undefined) continue

				const shown =
					part("default") !== undefined ||
					(evenAndOdd && part("even") !== undefined) ||
					(titlePage && part("first") !== undefined)

				stories.push([`style:${kind}`, part("default") ?? "", shown])

				// Even and first-page headers Word does not show (no w:evenAndOddHeaders, no w:titlePg) are kept, not
				// shown (style:display false, ODF 1.3 schema common-style-header-footer-attlist): their text stays in the file.
				if (part("even") !== undefined) stories.push([`style:${kind}-left`, part("even") ?? "", evenAndOdd])
				if (titlePage || part("first") !== undefined) stories.push([`style:${kind}-first`, part("first") ?? "", titlePage])
			}

			const header = stories.some(([element, , shown]) => shown && element.startsWith("style:header"))
			const footer = stories.some(([element, , shown]) => shown && element.startsWith("style:footer"))
			const top = Math.abs(number("pgMar", "top", 1440))
			const bottom = Math.abs(number("pgMar", "bottom", 1440))
			const left = number("pgMar", "left", 1440) + number("pgMar", "gutter", 0)
			const right = number("pgMar", "right", 1440)
			const headerDistance = number("pgMar", "header", 720)
			const footerDistance = number("pgMar", "footer", 720)
			const columns = number("cols", "num", 1)
			const format = NUMBER_FORMATS[value("pgNumType", "fmt") ?? "decimal"]
			// With a header, the page's top margin is the header's distance from the edge and the header area reaches down
			// to where the body starts (dynamic spacing: a taller header pushes the body down, as in Word).
			let properties = `fo:page-width="${pt(number("pgSz", "w", 12_240))}" fo:page-height="${pt(number("pgSz", "h", 15_840))}" style:print-orientation="${value("pgSz", "orient") === "landscape" ? "landscape" : "portrait"}"`

			properties += ` fo:margin-top="${pt(header ? Math.min(headerDistance, top) : top)}" fo:margin-bottom="${pt(footer ? Math.min(footerDistance, bottom) : bottom)}" fo:margin-left="${pt(Math.max(0, left))}" fo:margin-right="${pt(Math.max(0, right))}"`

			if (format !== undefined) properties += ` style:num-format="${format}"`
			else this.lossy.add("sectionLayout")

			if (columns > 1 && value("cols", "equalWidth") === "0") this.lossy.add("sectionLayout")

			for (const local of ["pgBorders", "lnNumType", "vAlign", "textDirection", "bidi", "rtlGutter"])
				if (root >= 0 && child(sectPr, root, local) >= 0) this.lossy.add("sectionLayout")

			const start = value("pgNumType", "start")

			if (start !== undefined && (k > 0 || start !== "1")) this.lossy.add("sectionLayout")

			const columnsMarkup =
				columns > 1
					? `<style:columns fo:column-count="${String(Math.min(columns, 50))}" fo:column-gap="${pt(number("cols", "space", 720))}"/>`
					: ""
			const area = (distance: number, edge: number, side: "bottom" | "top"): string =>
				`<style:header-footer-properties fo:min-height="${pt(Math.max(0, edge - distance))}" fo:margin-${side}="0pt" style:dynamic-spacing="true"/>`
			const layout =
				`<style:page-layout-properties ${properties}${columnsMarkup === "" ? "/>" : `>${columnsMarkup}</style:page-layout-properties>`}` +
				(header ? `<style:header-style>${area(headerDistance, top, "bottom")}</style:header-style>` : "") +
				(footer ? `<style:footer-style>${area(footerDistance, bottom, "top")}</style:footer-style>` : "")
			let layoutName = layouts.get(layout)

			if (layoutName === undefined) {
				layoutName = this.names.name(`pm${String(layouts.size + 1)}`)
				layouts.set(layout, layoutName)
				layoutMarkup += `<style:page-layout style:name="${escapeAttribute(layoutName)}">${layout}</style:page-layout>`
			}

			const key = `${layoutName}\u0000${stories.map(([element, part, shown]) => `${element}=${part}=${String(shown)}`).join("\u0000")}`
			let page = pages.get(key)

			if (page === undefined) {
				page = { name: this.names.name(pages.size === 0 ? "Standard" : `MP${String(pages.size + 1)}`), layout: layoutName, stories }
				pages.set(key, page)
			}

			const type = value("type", "val") ?? "nextPage"

			// ODF changes page style at a page break only: a continuous section break keeps the page style it is in.
			if (k > 0 && (type === "continuous" || type === "nextColumn")) {
				if (page.name !== previous) this.lossy.add("sectionLayout")

				return
			}

			if (type === "evenPage" || type === "oddPage") this.lossy.add("sectionLayout")

			if (section.first < blocks) starts.set(section.first, page.name)

			previous = page.name
		})

		return { layouts: layoutMarkup, pages: [...pages.values()], starts }
	}

	// --- Package ---

	private async metaXml(): Promise<string | undefined> {
		const part = "docProps/core.xml"

		if (!this.pkg.has(part)) return undefined

		let document: XmlDocument

		try {
			document = await this.pkg.xml(part)
		} catch {
			return undefined
		}

		const root = document.documentElement()
		const value = (local: string): string | undefined => {
			const node = child(document, root, local)
			const text = node < 0 ? "" : document.textContent(node).trim()

			return text === "" ? undefined : text
		}
		const fields: [string, string | undefined][] = [
			["dc:title", value("title")],
			["dc:subject", value("subject")],
			["dc:description", value("description")],
			["meta:initial-creator", value("creator")],
			["meta:keyword", value("keywords")]
		]

		this.pkg.release(part)

		const inner = fields
			.filter((field): field is [string, string] => field[1] !== undefined)
			.map(([name, text]) => `<${name}>${escapeText(text)}</${name}>`)
			.join("")

		return inner === ""
			? undefined
			: `${XML_DECLARATION}<office:document-meta ${ROOT_NAMESPACES} office:version="1.3"><office:meta>${inner}</office:meta></office:document-meta>`
	}

	private async packageOf(
		content: readonly Uint8Array[],
		styles: string,
		settings: string,
		meta: string | undefined
	): Promise<Uint8Array> {
		const streams: [string, Uint8Array][] = [
			["styles.xml", encodeUtf8(styles)],
			["settings.xml", encodeUtf8(settings)],
			...(meta === undefined ? [] : ([["meta.xml", encodeUtf8(meta)]] as [string, Uint8Array][]))
		]
		const pictures: { name: string; bytes: Uint8Array; type: string }[] = []

		// The body and the master pages' stories are charged as written: content.xml's head, settings and metadata.
		this.spend((content[0]?.length ?? 0) + streams.slice(1).reduce((sum, [, bytes]) => sum + bytes.length, 0))

		for (const [part, path] of this.media) {
			await turn(this.job)

			const extension = path.slice(path.lastIndexOf(".") + 1)
			const bytes = await this.pkg.opc.read(part)

			this.spend(bytes.length)
			pictures.push({ name: path, bytes, type: IMAGE_TYPES[extension] ?? "application/octet-stream" })
		}

		const manifest =
			`${XML_DECLARATION}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">` +
			`<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${MEDIA_TYPE}"/>` +
			["content.xml", ...streams.map(([name]) => name)]
				.map(name => `<manifest:file-entry manifest:full-path="${name}" manifest:media-type="text/xml"/>`)
				.join("") +
			pictures
				.map(
					picture =>
						`<manifest:file-entry manifest:full-path="${escapeAttribute(picture.name)}" manifest:media-type="${picture.type}"/>`
				)
				.join("") +
			"</manifest:manifest>"
		const sink = memorySink()
		const deflate = nativeDeflate()
		const deflateChunks = nativeDeflateChunks()

		await writeZip(
			{
				items: [
					// mimetype first and stored (ODF 1.3 Part 2 §3.3).
					{ kind: "data", name: "mimetype", bytes: encodeUtf8(MEDIA_TYPE), compress: false },
					{ kind: "data", name: "content.xml", bytes: BytePieces.of(content), compress: true },
					...streams.map(([name, bytes]) => ({ kind: "data" as const, name, bytes, compress: true })),
					...pictures.map(picture => ({
						kind: "data" as const,
						name: picture.name,
						bytes: picture.bytes,
						compress: !/^image\/(?:png|jpeg|gif|webp)$/u.test(picture.type)
					})),
					{ kind: "data", name: "META-INF/manifest.xml", bytes: encodeUtf8(manifest), compress: true }
				]
			},
			null,
			sink,
			{
				level: 6,
				...(deflate === undefined ? {} : { deflate }),
				...(deflateChunks === undefined ? {} : { deflateChunks }),
				...(this.job === undefined ? {} : { slicing: this.job.aborting })
			}
		)

		return sink.bytes()
	}
}

export async function docxToOdt(source: Uint8Array, options: ToOdtOptions): Promise<{ bytes: Uint8Array; lossy: LossyCounts }> {
	const job = jobOf(options.turns)

	try {
		const opened = await openDocxPackage(bytesSource(source), job === undefined ? {} : { slicing: job.aborting })

		// A Word 97–2003 document under a .docx name (the viewer sniffs it too): converted to its package first.
		if (!opened.ok && opened.reason === "legacyBinary") {
			const converted = await docToDocx(source, options)
			const inner = await docxToOdt(converted.bytes, options)

			for (const feature of converted.lossy.report("doc", "docx").features) inner.lossy.add(feature.kind, feature.count)

			return inner
		}

		if (!opened.ok) throw new TextConversionError(DOCX_REFUSALS[opened.reason] ?? "corrupt", opened.message)

		const lossy = new LossyCounts()

		return { bytes: await new Converter(opened.package, lossy, job).run(), lossy }
	} catch (error) {
		if (error instanceof RtfAborted) throw new TextConversionError("aborted", "aborted")
		if (error instanceof TextConversionError) throw error

		throw new TextConversionError("corrupt", error instanceof Error ? `${error.name}: ${error.message}` : String(error))
	}
}

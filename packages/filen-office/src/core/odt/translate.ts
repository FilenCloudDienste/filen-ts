import { appendAll } from "../arrays"
import { ZipError, sliceClock, type ByteSource, type SliceClock, type Slicing, type ZipLimits } from "../opc/index"
import { runSliced } from "../slicing"
import type { LinkedPart } from "../opc/package"
import { METHOD_STORED } from "../opc/zipReader"
import {
	OdfPackage,
	OdfStyleResolver,
	OdfStyleSheet,
	OdfTreeError,
	canonicalAttributes,
	elementName,
	locateBody,
	parseLength,
	readContentPrologue,
	type ContentPrologue
} from "../odf/index"
import { ODF_LINE_GAP, ODF_OBJECT_LINES, ODF_PADDING, ODF_STYLE_NS } from "../docx/layout/geometry"
import { metaTitle } from "../odf/meta"
import {
	Namespaces,
	XmlError,
	assertWellFormed,
	assertWellFormedSliced,
	decodeUtf8,
	encodeUtf8,
	escapeText,
	parseXml,
	transcodeUtf16,
	type XmlDocument
} from "../xml/index"
import { paragraph } from "./flow"
import { imageKind } from "./frames"
import { GeometryError } from "./geometry"
import { readContentPrologueSliced } from "../odf/prologue"
import { BodyFlow } from "./pages"
import { BodyScanner, inflateChunks, OdtScanError, type BodyBatch } from "./scan"
import { Translator, type TranslatorSettings } from "./translator"
import type { OdtOrigin, OdtTranslateResult, OdtTranslation } from "./types"
import { PART_NAMESPACES, REL, twips, XML_DECLARATION } from "./wml"

const CORE_PROPERTIES_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
const CORE_PROPERTIES_REL = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"
const CORE_PROPERTIES_OVERRIDE =
	'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'

export interface OdtTranslateOptions {
	readonly slicing?: Slicing
	readonly limits?: Partial<ZipLimits>
	// Every stream read is checked for every well-formedness rule (a written file's proof), not only its structure.
	readonly strict?: boolean
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp",
	svg: "image/svg+xml",
	wmf: "image/x-wmf",
	emf: "image/x-emf",
	tiff: "image/tiff"
}

const NOTE_FORMATS: Readonly<Record<string, string>> = {
	"1": "decimal",
	a: "lowerLetter",
	A: "upperLetter",
	i: "lowerRoman",
	I: "upperRoman"
}
const NOTE_RESTARTS: Readonly<Record<string, string>> = { document: "continuous", chapter: "eachSect", page: "eachPage" }

// Automatic styles, their resolutions and mappings kept while translating (a body uses most of its automatic styles
// once, in order: past this many, the oldest are let go and read again if a later block asks).
const KEEP_STYLES = 512

// Streams that are never pictures.
function mayBePicture(name: string): boolean {
	return !(
		name.endsWith("/") ||
		name.endsWith(".xml") ||
		name === "mimetype" ||
		name.startsWith("META-INF/") ||
		name.startsWith("Configurations2/") ||
		name.startsWith("Thumbnails/") ||
		name.startsWith("Basic/") ||
		name.startsWith("Scripts/")
	)
}

// The first bytes of a stream, inflating no more than one step.
async function head(odf: OdfPackage, name: string, clock: SliceClock | undefined): Promise<Uint8Array> {
	const entry = odf.archive.get(name)

	if (entry === undefined) return new Uint8Array(0)

	if (entry.method === METHOD_STORED) {
		const { dataOffset } = await odf.archive.layout(entry)

		return odf.archive.source.read(dataOffset, Math.min(64, entry.compressedSize))
	}

	try {
		for await (const chunk of inflateChunks(odf.archive, entry, clock)) return chunk.subarray(0, 64)
	} catch (error) {
		if (error instanceof ZipError) return new Uint8Array(0)

		throw error
	}

	return new Uint8Array(0)
}

export function configBoolean(settings: XmlDocument | undefined, name: string): boolean | undefined {
	if (settings === undefined) return undefined

	const namespaces = new Namespaces(settings)
	const stack = [settings.documentElement()]

	while (stack.length > 0) {
		const node = stack.pop() ?? -1

		for (let child = settings.firstChildElement(node); child >= 0; child = settings.nextSiblingElement(child)) {
			if (elementName(settings, namespaces, child) === "config:config-item") {
				const attributes = settings.attributes(child)

				if (attributes.some(attribute => attribute.name.endsWith("name") && attribute.value === name)) {
					const value = settings.textContent(child).trim()

					return value === "true" ? true : value === "false" ? false : undefined
				}
			} else {
				stack.push(child)
			}
		}
	}

	return undefined
}

function failure(reason: "malformed", error: Error): OdtTranslateResult {
	return { ok: false, reason, message: error.message }
}

function isDamage(error: unknown): error is Error {
	return (
		error instanceof XmlError ||
		error instanceof ZipError ||
		error instanceof OdtScanError ||
		error instanceof OdfTreeError ||
		error instanceof GeometryError
	)
}

// Translates an ODF text document into a WordprocessingML package held in memory. content.xml is read once,
// streamed: its prologue (automatic styles) first, then the body a batch of top-level blocks at a time.
async function wellFormed(document: XmlDocument, clock: SliceClock | undefined): Promise<void> {
	if (clock === undefined) assertWellFormed(document)
	else await assertWellFormedSliced(document, clock)
}

export async function translateOdt(source: ByteSource, options: OdtTranslateOptions = {}): Promise<OdtTranslateResult> {
	const opened = await OdfPackage.open(source, {
		kinds: ["text", "text-master", "text-web"],
		...(options.limits === undefined ? {} : { limits: options.limits })
	})

	if (!opened.ok) {
		return {
			ok: false,
			reason: opened.reason,
			message: opened.message,
			...(opened.encryption === undefined ? {} : { encryption: opened.encryption })
		}
	}

	try {
		return await translate(opened.package, options)
	} catch (error) {
		if (isDamage(error)) return failure("malformed", error)

		throw error
	}
}

const OOO_NS = "http://openoffice.org/2004/office"

// The items of settings.xml's "ooo:configuration-settings" set (its prefix resolved, as LibreOffice reads it), by name;
// undefined when the document has none.
function configurationSettings(settings: XmlDocument | undefined): Map<string, string> | undefined {
	if (settings === undefined) return undefined

	const namespaces = new Namespaces(settings)

	for (let block = settings.firstChildElement(settings.documentElement()); block >= 0; block = settings.nextSiblingElement(block)) {
		if (elementName(settings, namespaces, block) !== "office:settings") continue

		for (let set = settings.firstChildElement(block); set >= 0; set = settings.nextSiblingElement(set)) {
			if (elementName(settings, namespaces, set) !== "config:config-item-set") continue

			const name = canonicalAttributes(settings, namespaces, set).get("config:name") ?? ""
			const colon = name.indexOf(":")

			if (name.slice(colon + 1) !== "configuration-settings" || namespaces.uri(set, name.slice(0, Math.max(0, colon))) !== OOO_NS) {
				continue
			}

			const items = new Map<string, string>()

			for (let item = settings.firstChildElement(set); item >= 0; item = settings.nextSiblingElement(item)) {
				const itemName = canonicalAttributes(settings, namespaces, item).get("config:name")

				if (elementName(settings, namespaces, item) === "config:config-item" && itemName !== undefined) {
					items.set(itemName, settings.textContent(item).trim())
				}
			}

			return items
		}
	}

	return undefined
}

// Whether LibreOffice adds a font's line gap (external leading) under each line (ODF_LINE_GAP; measured, LibreOffice
// 7.5). A document without its configuration gets a new document's: external leading on, the high-resolution layout,
// no forced zero leading. One with it, as an older document, has external leading off unless AddExternalLeading says
// true, and the high-resolution layout's zero leading unless UnxForceZeroExtLeading says false.
function lineGap(configuration: ReadonlyMap<string, string> | undefined): "below" | "none" {
	if (configuration === undefined) return "below"

	if (configuration.get("AddExternalLeading") !== "true") return "none"

	return configuration.get("PrinterIndependentLayout") === "high-resolution" && configuration.get("UnxForceZeroExtLeading") !== "false"
		? "none"
		: "below"
}

async function translate(odf: OdfPackage, options: OdtTranslateOptions): Promise<OdtTranslateResult> {
	const clock = options.slicing === undefined ? undefined : sliceClock(options.slicing)
	const styles = await odf.xml("styles.xml", clock)

	if (options.strict === true && styles !== undefined) await wellFormed(styles, clock)

	let settingsXml: XmlDocument | undefined

	try {
		settingsXml = await odf.xml("settings.xml", clock)
	} catch (error) {
		if (!(error instanceof XmlError || error instanceof ZipError)) throw error
	}

	const title = await metaTitle(odf, clock)
	const settings: TranslatorSettings = {
		tabsRelativeToIndent: configBoolean(settingsXml, "TabsRelativeToIndent") ?? true,
		keepAtMost: KEEP_STYLES
	}
	// Drawing shapes stay on their anchor's page (ODF 1.3 Part 3 §20.267, style:flow-with-text false) unless the
	// document lets LibreOffice place them past it.
	const floatsOnPage = !(configBoolean(settingsXml, "DoNotCaptureDrawObjsOnPage") ?? false)
	const gap = lineGap(configurationSettings(settingsXml))
	const kinds = new Map<string, ReturnType<typeof imageKind>>()

	for (const entry of odf.archive.entries) {
		if (mayBePicture(entry.name) && kinds.size < 10_000) kinds.set(entry.name, imageKind(await head(odf, entry.name, clock)))
	}

	const content = odf.archive.get("content.xml")

	if (content === undefined) throw new OdtScanError("The package has no content.xml")

	let translator: Translator | undefined
	let scanner: BodyScanner | undefined
	const body = new BodyFlow()
	const origins: OdtOrigin[] = []
	let originsExact = true
	const start = async (prologue: ContentPrologue): Promise<Translator> => {
		const sheet = clock === undefined ? new OdfStyleSheet(styles, prologue) : await OdfStyleSheet.build(styles, prologue, clock)
		sheet.keepAtMost = KEEP_STYLES

		const created = new Translator(odf, sheet, new OdfStyleResolver(sheet, { keepAtMost: KEEP_STYLES }), settings)

		for (const [name, kind] of kinds) created.frames.kinds.set(name, kind)

		created.pages.body = body
		created.document = prologue.document
		created.namespaces = prologue.namespaces

		return created
	}
	const take = async (batches: readonly BodyBatch[]): Promise<void> => {
		if (translator === undefined) return

		for (const batch of batches) {
			translator.document = batch.document
			translator.namespaces = batch.namespaces
			translator.scope = "content"

			for (const block of batch.blocks) {
				if (clock?.due === true) await clock.pause()

				const first = body.count
				const state = translator.blockState()

				translator.blockBase = block.start - batch.document.start(block.node)
				await runSliced(translator.blockSteps(block.node, body), clock)
				translator.blockBase = undefined
				origins.push({
					stream: "content.xml",
					start: block.start,
					end: block.end,
					part: "word/document.xml",
					first,
					count: body.count - first,
					lossy: translator.takeLossy(),
					state
				})
			}

			if (clock?.due === true) await clock.pause()
		}
	}

	body.writer.add(`${XML_DECLARATION}<w:document ${PART_NAMESPACES}><w:body>`)

	// The stream until office:body is located, then the body through the scanner.
	let prefix = new Uint8Array(0)
	let offset = 0
	let looked = 0

	for await (const chunk of inflateChunks(odf.archive, content, clock)) {
		if (scanner !== undefined) {
			await take(scanner.push(chunk, offset))
			offset += chunk.length

			continue
		}

		const grown = new Uint8Array(prefix.length + chunk.length)

		grown.set(prefix)
		grown.set(chunk, prefix.length)
		prefix = grown
		offset += chunk.length

		if (indexOfBody(prefix, Math.max(0, looked - 8)) < 0) {
			looked = prefix.length

			continue
		}

		looked = prefix.length

		const located = locateBody(prefix)

		if (located === undefined) continue

		const head = prefix.subarray(0, Math.min(prefix.length, located.bodyStart + 64))

		const prologue = clock === undefined ? readContentPrologue(head) : await readContentPrologueSliced(head, clock)

		if (options.strict === true) await wellFormed(prologue.document, clock)

		translator = await start(prologue)
		scanner = new BodyScanner(prefix.subarray(located.rootStart, located.openEnd), located.bodyStart, {
			strict: options.strict === true
		})
		await take(scanner.push(prefix, 0))
		prefix = new Uint8Array(0)
	}

	if (scanner === undefined) {
		// No office:body found by the byte scan (UTF-16, a document type declaration...): the whole stream parsed.
		originsExact = false

		const utf16 = (prefix[0] === 0xfe && prefix[1] === 0xff) || (prefix[0] === 0xff && prefix[1] === 0xfe)
		const bytes = utf16 ? transcodeUtf16(prefix, 2, prefix[0] === 0xff) : prefix
		const document = parseXml(bytes)

		if (options.strict === true) await wellFormed(document, clock)

		const namespaces = new Namespaces(document)
		const root = document.documentElement()

		translator = await start({ document, namespaces, root, bodyStart: -1, sliced: false })

		for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
			if (elementName(document, namespaces, node) !== "office:body") continue

			for (let text = document.firstChildElement(node); text >= 0; text = document.nextSiblingElement(text)) {
				const blocks = []

				for (let block = document.firstChildElement(text); block >= 0; block = document.nextSiblingElement(block)) {
					blocks.push({ node: block, start: document.start(block), end: document.end(block) })
				}

				await take([{ document, namespaces, blocks }])
			}
		}
	} else if (!scanner.finished) {
		scanner.finish()
	}

	if (translator === undefined) throw new OdtScanError("content.xml has no document")

	const endState = translator.blockState()

	// Comment ranges of the body with no office:annotation-end end with it.
	translator.closeOpenAnnotations(body)

	// Frames anchored to the page with no paragraph after them.
	if (translator.pendingAnchors.length > 0) {
		body.add(paragraph("", "", translator.pendingAnchors.join("")))
		translator.pendingAnchors.length = 0
	}

	body.finish(translator.pages.finalSectPr())
	body.writer.add("</w:body></w:document>")

	return { ok: true, translation: { ...assemble(odf, translator, body, origins, originsExact, floatsOnPage, gap, title), endState } }
}

const BODY = encodeUtf8("body")

function indexOfBody(bytes: Uint8Array, from: number): number {
	for (let at = bytes.indexOf(BODY[0] ?? 0, from); at >= 0 && at + 4 <= bytes.length; at = bytes.indexOf(BODY[0] ?? 0, at + 1)) {
		if (bytes[at + 1] === BODY[1] && bytes[at + 2] === BODY[2] && bytes[at + 3] === BODY[3]) return at
	}

	return -1
}

function notesProperties(translator: Translator, noteClass: "footnote" | "endnote"): string {
	const configuration = translator.sheet.notesConfiguration.get(noteClass)

	if (configuration === undefined) return ""

	const format = NOTE_FORMATS[configuration.get("style:num-format") ?? "1"]
	const start = Number(configuration.get("text:start-value") ?? "0")
	const restart = noteClass === "footnote" ? NOTE_RESTARTS[configuration.get("text:start-numbering-at") ?? "document"] : undefined

	if (noteClass === "footnote" && configuration.get("text:footnotes-position") === "document") translator.lossy("sectionProperties")

	return `<w:${noteClass}Pr>${format === undefined ? "" : `<w:numFmt w:val="${format}"/>`}${Number.isInteger(start) && start > 0 ? `<w:numStart w:val="${start + 1}"/>` : ""}${restart === undefined ? "" : `<w:numRestart w:val="${restart}"/>`}</w:${noteClass}Pr>`
}

function assemble(
	odf: OdfPackage,
	translator: Translator,
	body: BodyFlow,
	origins: OdtOrigin[],
	originsExact: boolean,
	floatsOnPage: boolean,
	gap: "below" | "none",
	title: string | undefined
): OdtTranslation {
	const parts = new Map<string, Uint8Array | LinkedPart>()
	const overrides: string[] = []
	const relationships: string[] = []
	const override = (part: string, type: string): void => {
		overrides.push(
			`<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`
		)
	}
	const relate = (type: string, target: string): void => {
		relationships.push(`<Relationship Id="rIdOdt${relationships.length + 1}" Type="${REL}${type}" Target="${target}"/>`)
	}
	const stylesMarkup = translator.styles.stylesXml(translator)

	parts.set("word/styles.xml", encodeUtf8(`${XML_DECLARATION}<w:styles ${PART_NAMESPACES}>${stylesMarkup}</w:styles>`))
	override("word/styles.xml", "styles")
	relate("styles", "styles.xml")

	if (!translator.lists.empty) {
		parts.set(
			"word/numbering.xml",
			encodeUtf8(`${XML_DECLARATION}<w:numbering ${PART_NAMESPACES}>${translator.lists.numberingXml()}</w:numbering>`)
		)
		override("word/numbering.xml", "numbering")
		relate("numbering", "numbering.xml")
	}

	const defaults = translator.sheet.defaults.get("paragraph")?.properties.get("paragraph")?.attributes
	const tabStop = parseLength(defaults?.get("style:tab-stop-distance")) ?? (1.25 / 2.54) * 72
	const footnotePr = notesProperties(translator, "footnote")
	const endnotePr = notesProperties(translator, "endnote")

	// What the common styles, defaults and note settings approximate, past the last block's bookkeeping.
	translator.takeDocumentLossy()

	// A line of only as-char objects is as tall as they are (ODF_OBJECT_LINES, measured); paragraph borders and padding
	// join as LibreOffice joins them (ODF_PADDING); lines are measured as LibreOffice measures them (ODF_LINE_GAP).
	// LibreOffice adds one paragraph's space after to the next one's space before whatever AddParaTableSpacing says
	// (measured: that setting is about tables); the layout adds them only under w:doNotUseHTMLParagraphAutoSpacing,
	// which otherwise changes only auto spacing, which a translation never writes.
	parts.set(
		"word/settings.xml",
		encodeUtf8(
			`${XML_DECLARATION}<w:settings ${PART_NAMESPACES}><w:defaultTabStop w:val="${Math.max(1, twips(tabStop))}"/>${translator.pages.evenAndOdd ? "<w:evenAndOddHeaders/>" : ""}${footnotePr}${endnotePr}<w:compat><w:doNotUseHTMLParagraphAutoSpacing/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>${floatsOnPage ? `<w:compatSetting w:name="flow-with-text" w:uri="${ODF_STYLE_NS}" w:val="false"/>` : ""}<w:compatSetting w:name="${ODF_OBJECT_LINES}" w:uri="${ODF_STYLE_NS}" w:val="objects"/><w:compatSetting w:name="${ODF_PADDING}" w:uri="${ODF_STYLE_NS}" w:val="borders"/><w:compatSetting w:name="${ODF_LINE_GAP}" w:uri="${ODF_STYLE_NS}" w:val="${gap}"/></w:compat></w:settings>`
		)
	)
	override("word/settings.xml", "settings")
	relate("settings", "settings.xml")

	const separators = (tag: string): string =>
		`<w:${tag} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${tag}><w:${tag} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>`

	if (translator.noteCount > 0) {
		parts.set(
			"word/footnotes.xml",
			encodeUtf8(
				`${XML_DECLARATION}<w:footnotes ${PART_NAMESPACES}>${separators("footnote")}${decodeUtf8(translator.footnotes.bytes())}</w:footnotes>`
			)
		)
		override("word/footnotes.xml", "footnotes")
		relate("footnotes", "footnotes.xml")
	}

	if (translator.endnoteCount > 0) {
		parts.set(
			"word/endnotes.xml",
			encodeUtf8(
				`${XML_DECLARATION}<w:endnotes ${PART_NAMESPACES}>${separators("endnote")}${decodeUtf8(translator.endnotes.bytes())}</w:endnotes>`
			)
		)
		override("word/endnotes.xml", "endnotes")
		relate("endnotes", "endnotes.xml")
	}

	if (translator.commentCount > 0) {
		parts.set(
			"word/comments.xml",
			encodeUtf8(`${XML_DECLARATION}<w:comments ${PART_NAMESPACES}>${decodeUtf8(translator.comments.bytes())}</w:comments>`)
		)
		override("word/comments.xml", "comments")
		relate("comments", "comments.xml")
	}

	for (const [name, bytes] of translator.pages.parts) parts.set(name, bytes)

	appendAll(overrides, translator.pages.contentTypes)
	// Headers and footers are translated as pages first use them: their origins go in styles.xml's stream order.
	appendAll(
		origins,
		translator.pages.origins.slice().sort((a, b) => a.start - b.start)
	)

	const archive = odf.archive

	for (const media of translator.frames.media) {
		const entry = archive.get(media.source)

		if (entry === undefined) continue

		parts.set(media.part, { size: entry.uncompressedSize, read: () => archive.read(entry) })
	}

	parts.set("word/document.xml", body.writer.bytes())
	parts.set(
		"word/_rels/document.xml.rels",
		encodeUtf8(
			`${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}${translator.relationships.join("")}</Relationships>`
		)
	)
	// The title as the package's core properties (ECMA-376 Part 2 §11): what the PDF export and a .docx copy show.
	if (title !== undefined) {
		parts.set(
			"docProps/core.xml",
			encodeUtf8(
				`${XML_DECLARATION}<cp:coreProperties xmlns:cp="${CORE_PROPERTIES_NS}" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeText(title)}</dc:title></cp:coreProperties>`
			)
		)
	}

	const coreRelationship = title === undefined ? "" : `<Relationship Id="rId2" Type="${CORE_PROPERTIES_REL}" Target="docProps/core.xml"/>`

	parts.set(
		"_rels/.rels",
		encodeUtf8(
			`${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}officeDocument" Target="word/document.xml"/>${coreRelationship}</Relationships>`
		)
	)

	const defaultsXml = Object.entries(IMAGE_TYPES)
		.map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`)
		.join("")

	parts.set(
		"[Content_Types].xml",
		encodeUtf8(
			`${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defaultsXml}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${title === undefined ? "" : CORE_PROPERTIES_OVERRIDE}${overrides.join("")}</Types>`
		)
	)

	return {
		parts,
		origins,
		originsExact,
		facts: odf.facts,
		lossy: translator.lossyCounts,
		objects: translator.objectKinds,
		numbering: translator.lists.numStyles,
		media: new Map(translator.frames.media.map(media => [media.part, media.source])),
		sections: translator.pages.sections
	}
}

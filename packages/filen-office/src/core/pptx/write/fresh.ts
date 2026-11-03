import { relationshipKind } from "../../docx/index"
import { XmlError } from "../../xml/errors"
import {
	BytePieces,
	OpcPackage,
	partKey,
	writeZip,
	type ByteSink,
	type OpcPackage as OpcPackageType,
	type Relationships,
	type ZipPlanItem
} from "../../opc/index"
import { MEDIA_LIMITS } from "../../opc/mediaPolicy"
import type { ByteChunks } from "../../opc/pieces"
import { DEFAULT_PRESENTATION_BUDGETS } from "../../presentation/budget"
import { MIN_MASTER_LAYOUT_ID, MIN_SLIDE_ID } from "../../presentation/ids"
import { PresentationError, refused, slideRef, type Deck, type Refused, type SlideNode, type SlideRef } from "../../presentation/model"
import { NodeKind, decodeUtf8, encodeUtf8, escapeAttribute, escapeText, parseXml, type XmlDocument } from "../../xml/index"
import { G, partReader, type PartReader } from "../read/xml"
import { IMAGE_RELATIONSHIP, PREFIXES, URIS, attr, type EmitContext, type SourceCopier } from "./emit/shape"
import { emitFamilyOf, emitPptx } from "./emit"
import { slideRoot } from "./emit/slide"
import { spliceShowPr } from "./emit/presentation"
import { listStyleXml } from "./emit/text"
import { XLSX_CONTENT_TYPE } from "../../presentation/edit/apply/chart"
import { PART_CONTENT_TYPES, PackageWriter, RELATIONSHIPS, modelName, zipName } from "./parts"
import type { EmitPiece, EmitRequest, EmitResult, FreshPptx, PptxSaveOptions, PptxSaveOutcome, PptxSource } from "./types"

// The fresh writer: a whole PresentationML package from the model, in a fixed order (presentation, masters, layouts,
// slides, notes masters and notes, handout master, themes, properties, then the media and other parts the content
// relates to), for conversions, templates and the Save as of ppt and Strict decks. Shapes, text and the slides' own
// levels come from the model; what the model does not hold (geometry and fills before an edit, charts, diagrams,
// pictures, extension lists) is copied from the source part, re-prefixed to Transitional and with its relationships
// carried over. Media, images, charts and embeddings are copied by bytes (Strict XML parts re-serialized as
// Transitional). Every node must be parsed first.

const P14 = URIS["p14"] ?? ""
const SECTIONS_EXT = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const TRANSITIONAL_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
const STRICT_RELATIONSHIPS = "http://purl.oclc.org/ooxml/officeDocument/relationships/"
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships/"
const MAIN_TYPES: Readonly<Record<Deck["variant"], string>> = {
	pptx: PART_CONTENT_TYPES.presentation,
	pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
	potx: "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
	potm: "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
	ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
	ppsm: "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml",
	odp: PART_CONTENT_TYPES.presentation,
	otp: "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
	ppt: PART_CONTENT_TYPES.presentation,
	pps: "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
	pot: "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml"
}

// Every root of a fresh part declares the namespaces copied content may use, under the writer's prefixes.
const ROOT_NAMESPACES = Object.entries(URIS)
	.map(([prefix, uri]) => ` xmlns:${prefix}="${uri}"`)
	.join("")

const CONTENT_TYPES =
	`${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
	'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
	'<Default Extension="xml" ContentType="application/xml"/></Types>'

// Our own theme for a deck that brings none (an ODP source): Office font names over metric-compatible faces, as the
// renderer substitutes them.
const DEFAULT_THEME =
	`<a:theme xmlns:a="${URIS["a"] ?? ""}" name="Filen"><a:themeElements><a:clrScheme name="Filen">` +
	'<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2>' +
	'<a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="F97316"/></a:accent2>' +
	'<a:accent3><a:srgbClr val="6B7280"/></a:accent3><a:accent4><a:srgbClr val="EAB308"/></a:accent4><a:accent5><a:srgbClr val="0EA5E9"/></a:accent5>' +
	'<a:accent6><a:srgbClr val="16A34A"/></a:accent6><a:hlink><a:srgbClr val="1D4ED8"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>' +
	'<a:fontScheme name="Filen"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
	'<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
	'<a:fmtScheme name="Filen"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
	'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
	'<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
	"<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
	'<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
	"</a:fmtScheme></a:themeElements></a:theme>"

const DEFAULT_COLOR_MAP: Required<NonNullable<SlideNode["clrMap"]>> = {
	bg1: "lt1",
	tx1: "dk1",
	bg2: "lt2",
	tx2: "dk2",
	accent1: "accent1",
	accent2: "accent2",
	accent3: "accent3",
	accent4: "accent4",
	accent5: "accent5",
	accent6: "accent6",
	hlink: "hlink",
	folHlink: "folHlink"
}

// --- Copying source markup into another part ---

// ST_Percentage and universal measures as Strict writes them ("50%", "2.5in") into Transitional integers.
const PERCENT = /^(-?\d+(?:\.\d+)?)%$/u
const MEASURE = /^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/u
const EMU_PER: Readonly<Record<string, number>> = { mm: 36000, cm: 360000, in: 914400, pt: 12700, pc: 152400, pi: 152400 }

function transitionalValue(value: string): string {
	const percent = PERCENT.exec(value)

	if (percent !== null) return String(Math.round(Number(percent[1]) * 1000))

	const measure = MEASURE.exec(value)

	return measure === null ? value : String(Math.round(Number(measure[1]) * (EMU_PER[measure[2] ?? ""] ?? 1)))
}

// A copied XML part: a Strict part as Transitional, anything else as it is.
function transitionalPart(bytes: Uint8Array): Uint8Array {
	try {
		const document = parseXml(bytes)
		const root = partReader(document).namespaces.elementUri(document.documentElement()) ?? ""

		if (/purl\.oclc\.org\/ooxml/u.test(root)) return encodeUtf8(XML_DECLARATION + new Copier(document, id => id).document_())
	} catch {
		// Not XML after all: copied as it is.
	}

	return bytes
}

// Copies elements of one source part into a fresh part: names under the writer's prefixes (Strict URIs become
// Transitional), other namespaces declared where they are used, relationship ids remapped.
class Copier implements SourceCopier {
	private readonly document: XmlDocument
	private readonly reader: PartReader
	private readonly remap: (id: string) => string
	private readonly strict: boolean
	private readonly extra = new Map<string, string>()

	constructor(document: XmlDocument, remap: (id: string) => string) {
		this.document = document
		this.reader = partReader(document)
		this.remap = remap
		this.strict = /purl\.oclc\.org\/ooxml/u.test(this.reader.namespaces.elementUri(document.documentElement()) ?? "")
	}

	// The prefix of a namespace in the fresh part: the writer's own for the groups it knows, else the source's (readers
	// match some by name, as mc:Choice Requires="v" for VML), else a new one where the source's is taken.
	private prefixOf(
		uri: string,
		declared: Map<string, string>,
		sourcePrefix?: string
	): { readonly prefix: string; readonly declare: string } {
		const group = G_OF(uri)
		const known = group === undefined ? undefined : PREFIXES[group]

		if (known !== undefined) return { prefix: known, declare: "" }

		const held = declared.get(uri) ?? this.extra.get(uri)

		if (held !== undefined && declared.has(uri)) return { prefix: held, declare: "" }

		const free =
			sourcePrefix !== undefined &&
			sourcePrefix !== "" &&
			URIS[sourcePrefix] === undefined &&
			![...this.extra].some(([other, prefix]) => prefix === sourcePrefix && other !== uri)
		const prefix = held ?? (free ? sourcePrefix : `x${String(this.extra.size + 1)}`)

		this.extra.set(uri, prefix)
		declared.set(uri, prefix)

		return { prefix, declare: ` xmlns:${prefix}="${escapeAttribute(uri)}"` }
	}

	private tag(node: number, declared: Map<string, string>): string {
		const document = this.document
		const r = this.reader
		const uri = r.namespaces.elementUri(node)
		let declarations = ""
		let name = document.localName(node)

		if (uri !== undefined && uri !== "") {
			const { prefix, declare } = this.prefixOf(uri, declared, document.prefix(node))

			declarations += declare
			name = `${prefix}:${name}`
		}

		let attributes = ""

		for (const attribute of document.attributes(node)) {
			if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) continue

			const colon = attribute.name.indexOf(":")
			let value = this.strict ? transitionalValue(attribute.value) : attribute.value

			if (colon < 0) {
				attributes += ` ${attribute.name}="${escapeAttribute(value)}"`

				continue
			}

			const sourcePrefix = attribute.name.slice(0, colon)
			const local = attribute.name.slice(colon + 1)

			if (sourcePrefix === "xml") {
				attributes += ` ${attribute.name}="${escapeAttribute(value)}"`

				continue
			}

			const attributeUri = r.namespaces.uri(node, sourcePrefix)

			if (attributeUri === undefined) continue

			const { prefix, declare } = this.prefixOf(attributeUri, declared, sourcePrefix)

			declarations += declare

			if (G_OF(attributeUri) === G.R && value !== "") value = this.remap(value)
			// Markup-compatibility attributes name prefixes: theirs become ours.
			if (G_OF(attributeUri) === G.MC && (local === "Ignorable" || local === "ProcessContent" || local === "MustUnderstand")) {
				value = this.prefixList(node, value, declared, extra => {
					declarations += extra
				})
			}

			attributes += ` ${prefix}:${local}="${escapeAttribute(value)}"`
		}

		// mc:Choice/@Requires names prefixes too.
		if (r.is(node, G.MC, "Choice")) {
			const requires = document.attribute(node, "Requires")

			if (requires !== undefined) {
				attributes = attributes.replace(/ Requires="[^"]*"/u, "")
				attributes += ` Requires="${escapeAttribute(this.prefixList(node, requires, declared, extra => (declarations += extra)))}"`
			}
		}

		return `<${name}${declarations}${attributes}`
	}

	private prefixList(node: number, value: string, declared: Map<string, string>, declare: (markup: string) => void): string {
		return value
			.split(/\s+/u)
			.filter(token => token !== "")
			.map(token => {
				const uri = this.reader.namespaces.uri(node, token)

				if (uri === undefined) return token

				const written = this.prefixOf(uri, declared, token)

				declare(written.declare)

				return written.prefix
			})
			.join(" ")
	}

	start(node: number): string {
		return `${this.tag(node, new Map())}>`
	}

	copy(node: number, declared: Map<string, string> = new Map(), depth = 0): string {
		const document = this.document

		if (depth > 256) throw new PresentationError("tooDeep", "Copied markup nested too deep")

		// Whitespace and text between elements (a hole can be one) are written as text; comments are not carried.
		if (document.kinds[node] !== NodeKind.Element) {
			const kind = document.kinds[node]

			return kind === NodeKind.Text || kind === NodeKind.CData ? escapeText(document.text(node)) : ""
		}

		const inner: string[] = []
		const scope = new Map(declared)
		const open = this.tag(node, scope)

		for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
			const kind = document.kinds[child]

			if (kind === NodeKind.Element) inner.push(this.copy(child, scope, depth + 1))
			else if (kind === NodeKind.Text || kind === NodeKind.CData) inner.push(escapeText(document.text(child)))
		}

		const name = open.slice(1).split(/[\s>]/u)[0] ?? ""

		return inner.length === 0 ? `${open}/>` : `${open}>${inner.join("")}</${name}>`
	}

	// The whole document (a Strict part copied as Transitional), the writer's prefixes declared on its root.
	document_(): string {
		const root = this.copy(this.document.documentElement())
		const end = root.search(/[\s/>]/u)

		return `${root.slice(0, end)}${ROOT_NAMESPACES}${root.slice(end)}`
	}
}

function G_OF(uri: string): number | undefined {
	for (const [group, prefix] of Object.entries(PREFIXES)) {
		if (prefix !== undefined && (URIS[prefix] === uri || STRICT_URIS[prefix] === uri)) return Number(group)
	}

	return undefined
}

const STRICT_URIS: Readonly<Record<string, string>> = {
	p: "http://purl.oclc.org/ooxml/presentationml/main",
	a: "http://purl.oclc.org/ooxml/drawingml/main",
	r: "http://purl.oclc.org/ooxml/officeDocument/relationships",
	dgm: "http://purl.oclc.org/ooxml/drawingml/diagram",
	c: "http://purl.oclc.org/ooxml/drawingml/chart",
	pic: "http://purl.oclc.org/ooxml/drawingml/picture"
}

// Strict relationship names that differ from their Transitional ones (ECMA-376 Part 1, Strict and Transitional).
const STRICT_NAMES: Readonly<Record<string, string>> = { extendedProperties: "extended-properties", customProperties: "custom-properties" }

function transitionalType(type: string): string {
	if (!type.startsWith(STRICT_RELATIONSHIPS)) return type

	const name = type.slice(STRICT_RELATIONSHIPS.length)

	return TRANSITIONAL_RELATIONSHIPS + (STRICT_NAMES[name] ?? name)
}

function assemble(pieces: readonly EmitPiece[], copier: Copier | undefined): string {
	let out = ""

	for (const piece of pieces) {
		if (typeof piece === "string") out += piece
		else if (piece instanceof Uint8Array) out += decodeUtf8(piece, 0, piece.length)
		else if (copier !== undefined) out += copier.copy(piece.hole)
		else throw new PresentationError("failed", "A hole without a source")
	}

	return out
}

// Adds `ROOT_NAMESPACES` to a root written by the slide family (which declares only p, a and r).
function withNamespaces(root: string): string {
	return root
		.replace(/^<([A-Za-z0-9:]+) xmlns:a="[^"]*" xmlns:r="[^"]*" xmlns:p="[^"]*"/u, `<$1${ROOT_NAMESPACES}`)
		.replace(/^<([A-Za-z0-9:]+)(?=[ >])(?![^>]*xmlns:p=)/u, `<$1${ROOT_NAMESPACES}`)
}

// Relationships the fresh writer makes itself (between nodes, to themes and properties) or never carries (a signature
// is void once the package is written anew).
const NODE_KINDS: ReadonlySet<string> = new Set([
	"slideLayout",
	"slideMaster",
	"notesSlide",
	"notesMaster",
	"handoutMaster",
	"theme",
	"slide"
])
const PRESENTATION_KINDS: ReadonlySet<string> = new Set([...NODE_KINDS, "presProps", "viewProps", "tableStyles", "font"])
const PACKAGE_KINDS: ReadonlySet<string> = new Set([
	"officeDocument",
	"extended-properties",
	"extendedProperties",
	"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
	"http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin"
])

// --- The writer ---

// Parts of a source that is no PresentationML package (an ODP deck's pictures and media), which the model names by
// their path there: copied by bytes into ppt/media under a fresh name when markup relates to them.
export interface FreshForeignParts {
	has(name: string): boolean
	contentType(name: string): string | undefined
	read(name: string): Promise<Uint8Array>
	// A part's content streamed from its zip entry (never held whole), with the CRC-32 the entry declares; undefined
	// for a part made in memory.
	stream?(name: string): StreamedPart | undefined
	// The relationships of a part made for the copy (a chart's to its workbook), their targets foreign parts.
	relationships?(name: string): readonly { readonly id: string; readonly type: string; readonly target: string }[]
}

export interface StreamedPart extends ByteChunks {
	readonly crc32: number
}

export interface FreshExtras {
	readonly foreign?: FreshForeignParts
	// Each node as it is written (a conversion's nearer forms of what PresentationML cannot hold as the source has it).
	readonly adapt?: (node: SlideNode) => SlideNode
	// A shape's element written by the conversion (content the model names in the other format, as a chart object),
	// else undefined for its family to write.
	readonly element?: (request: EmitRequest, context: EmitContext) => EmitResult | undefined
	// The slide size written in place of the deck's (one PresentationML cannot hold).
	readonly size?: { readonly cx: number; readonly cy: number }
	// The PNG an SVG picture among the foreign parts is shown by where SVG is not drawn: PowerPoint writes an SVG
	// picture as a:blip of a PNG with the SVG in its asvg:svgBlip extension (MS-ODRAWXML §2.3.1.30).
	readonly svgFallback?: (name: string) => Promise<Uint8Array>
	// For a source that is no PresentationML package: a slide's comments as a legacy comments part (p:cmLst, ECMA-376
	// Part 1 §19.4) and the deck's comment authors (p:cmAuthorLst), its core properties (docProps/core.xml, Part 2
	// §11) and custom properties (docProps/custom.xml, Part 1 §22.3).
	readonly comments?: (node: SlideNode) => string | undefined
	readonly commentAuthors?: string
	readonly coreProperties?: string
	readonly customProperties?: string
}

// Media whose content is compressed already: stored, not deflated again.
const STORED_MEDIA = /^(?:image\/(?:png|jpeg|gif|webp)|video\/|audio\/)/u
// A copied part larger than this is stored as it streams: deflating it would hold its whole deflated content.
const DEFLATE_HELD = 16 * 1024 * 1024
const XML_TYPE = /xml$/iu
const CUSTOM_PROPERTIES_TYPE = "application/vnd.openxmlformats-officedocument.custom-properties+xml"
const SVG_TYPE = "image/svg+xml"
const SVG_BLIP_EXT = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}"
const ASVG = "http://schemas.microsoft.com/office/drawing/2016/SVG/main"

// Each a:blip naming `svg` made to name `png`, the SVG in its asvg:svgBlip extension (the extension list a:blip's last
// child, CT_Blip §20.1.8.13).
function withSvgBlip(markup: string, svg: string, png: string): string {
	const start = `<a:blip r:embed="${svg}"`
	const ext = `<a:ext uri="${SVG_BLIP_EXT}"><asvg:svgBlip xmlns:asvg="${ASVG}" r:embed="${svg}"/></a:ext>`
	let out = ""
	let from = 0

	for (let at = markup.indexOf(start); at >= 0; at = markup.indexOf(start, from)) {
		const close = markup.indexOf(">", at)

		if (close < 0) break

		const head = `<a:blip r:embed="${png}"${markup.slice(at + start.length, close)}`

		out += markup.slice(from, at)

		if (markup[close - 1] === "/") {
			out += `${head.slice(0, -1)}><a:extLst>${ext}</a:extLst></a:blip>`
			from = close + 1
			continue
		}

		const end = markup.indexOf("</a:blip>", close)

		if (end < 0) break

		const inner = markup.slice(close + 1, end)
		const list = inner.lastIndexOf("</a:extLst>")

		out += `${head}>${list < 0 ? `${inner}<a:extLst>${ext}</a:extLst>` : `${inner.slice(0, list)}${ext}${inner.slice(list)}`}</a:blip>`
		from = end + "</a:blip>".length
	}

	return out + markup.slice(from)
}

// What a copied part of `contentType` may declare (core/opc/mediaPolicy.ts classes: media streamed, images, the rest),
// its XML parsed whole within the reader's per-part budget.
function copyLimit(contentType: string): number {
	if (/^(?:video|audio)\//u.test(contentType)) return MEDIA_LIMITS.mediaEntry
	if (contentType.startsWith("image/")) return MEDIA_LIMITS.imageEntry
	if (XML_TYPE.test(contentType)) return Math.min(MEDIA_LIMITS.otherEntry, DEFAULT_PRESENTATION_BUDGETS.xmlPartBytes)

	return MEDIA_LIMITS.otherEntry
}

function checkCopy(name: string, contentType: string, size: number): void {
	const limit = copyLimit(contentType)

	if (size > limit) throw new PresentationError("tooLarge", `${name} declares ${String(size)} bytes, over ${String(limit)}`)
}
class Fresh {
	private readonly deck: Deck
	private readonly source: PptxSource | undefined
	private readonly extras: FreshExtras
	private readonly foreignPending: { from: string; to: string }[] = []
	readonly writer: PackageWriter
	// Source part key → fresh part name, for nodes (written from the model) and copied parts.
	private readonly mapped = new Map<string, string>()
	private readonly pending: { from: string; to: string }[] = []
	private readonly nodeParts = new Map<SlideRef, string>()
	// Fresh part → its image relationships naming a foreign SVG picture (id → the SVG's source name).
	private readonly svgBlips = new Map<string, Map<string, string>>()
	// Foreign SVG picture → the fresh name of its PNG.
	private readonly svgPngs = new Map<string, string>()

	constructor(deck: Deck, source: PptxSource | undefined, writer: PackageWriter, extras: FreshExtras = {}) {
		this.deck = deck
		this.source = source
		this.writer = writer
		this.extras = extras
	}

	// The fresh name of a foreign source part, its copy queued.
	private foreignTarget(sourceName: string): string {
		const key = `foreign:${sourceName}`
		const held = this.mapped.get(key)

		if (held !== undefined) return held

		const contentType = this.extras.foreign?.contentType(sourceName) ?? "application/octet-stream"
		const name = this.writer.allocate(
			contentType === PART_CONTENT_TYPES.chart
				? "chart"
				: contentType === XLSX_CONTENT_TYPE
					? "embeddedWorkbook"
					: contentType.startsWith("image/")
						? "image"
						: "media",
			contentType
		)

		this.mapped.set(key, name)
		this.writer.add(name, contentType, undefined, { compress: !STORED_MEDIA.test(contentType) })
		this.foreignPending.push({ from: sourceName, to: name })

		return name
	}

	private node(ref: SlideRef | undefined): SlideNode {
		const node = ref === undefined ? undefined : this.deck.nodes.get(ref)

		if (node === undefined) throw new PresentationError("failed", `The node ${String(ref)} was not parsed before the fresh write`)

		return node
	}

	// The fresh name of a source part: a node's, or a copy queued under the source's own name where it is free.
	private target(sourceName: string): string {
		const key = partKey(sourceName)
		const held = this.mapped.get(key)

		if (held !== undefined) return held

		const opc = this.source?.package
		const contentType = opc === undefined ? PART_CONTENT_TYPES.xml : (this.contentTypeOf(sourceName) ?? PART_CONTENT_TYPES.xml)
		const name = this.writer.claim(sourceName) ? sourceName : this.writer.allocate(undefined, contentType, sourceName)

		this.mapped.set(key, name)
		this.writer.add(name, contentType, undefined, { compress: opc?.entry(sourceName)?.method !== 0 })
		this.pending.push({ from: sourceName, to: name })

		return name
	}

	private contentTypeCache: import("../../opc/index").ContentTypes | undefined

	private contentTypeOf(name: string): string | undefined {
		return this.contentTypeCache?.typeOf(name)
	}

	// A relationship of a source part remapped onto a fresh part.
	private relate(owner: string, relationships: Relationships, id: string): string {
		const relationship = relationships.byId(id)

		if (relationship === undefined) return id
		if (relationship.external) return this.keep(owner, relationship.id, transitionalType(relationship.type), relationship.target, true)
		if (relationship.partName === undefined) return id
		// A target the source lacks (a damaged package) is carried as it is, never dropped.
		if (this.source?.package.has(relationship.partName) !== true)
			return this.keep(owner, relationship.id, transitionalType(relationship.type), relationship.partName, false)

		return this.keep(owner, relationship.id, transitionalType(relationship.type), this.target(relationship.partName), false)
	}

	// A relationship of the fresh part, under the source's id where it is free: parts copied by bytes name the ids of
	// the part that relates to them (a diagram's data names its cached drawing by the slide's relationship id).
	private keep(owner: string, id: string, type: string, target: string, external: boolean): string {
		const edit = this.writer.relationshipsOf(owner)
		const key = external ? target : partKey(target)
		const held = edit
			.all()
			.find(
				relationship =>
					relationship.type === type &&
					relationship.external === external &&
					(external ? relationship.target : partKey(relationship.target)) === key
			)

		return held?.id ?? edit.add(type, target, external, id)
	}

	private async copier(
		owner: string,
		sourcePart: string | undefined
	): Promise<{ document: XmlDocument | undefined; copier: Copier | undefined; relationships: Relationships | undefined }> {
		const opc = this.source?.package

		await this.writer.loadRelationships(owner)

		if (opc === undefined || sourcePart === undefined || !opc.has(zipName(sourcePart)))
			return { document: undefined, copier: undefined, relationships: undefined }

		const document = await opc.xml(zipName(sourcePart))
		const relationships = await opc.relationships(zipName(sourcePart))

		return { document, copier: new Copier(document, id => this.relate(owner, relationships, id)), relationships }
	}

	// A node written from the model into `name`, its source copied where the model does not hold it.
	private async emitNode(written: SlideNode, name: string, options: { layoutList?: string } = {}): Promise<void> {
		const node = this.extras.adapt === undefined ? written : this.extras.adapt(written)
		const sourcePart = node.src?.format === "pptx" ? node.src.part : undefined
		const { document, copier, relationships } = await this.copier(name, sourcePart)
		const api = this.writer.api(modelName(name))
		const context: EmitContext = {
			deck: this.deck,
			document,
			// Parts the model names (a picture bullet's image, a picture fill's) are the source's: copied, and related
			// under their fresh names.
			parts: {
				...api,
				relate: (target, type, external) =>
					external !== true && this.extras.foreign?.has(zipName(target)) === true
						? this.relateForeign(name, api, zipName(target), type)
						: external === true || this.source?.package.has(zipName(target)) !== true
							? api.relate(target, type, external)
							: api.relate(modelName(this.target(zipName(target))), type)
			},
			mode: "model",
			...(copier === undefined ? {} : { copier }),
			...(relationships === undefined ? {} : { relationships }),
			slidePart: ref => this.nodeParts.get(ref),
			dispatch: (request, inner) => this.extras.element?.(request, inner) ?? emitPptx(emitFamilyOf(request), request, inner)
		}
		// The source document is the node's own part, not the fresh part being written.
		const scoped: EmitContext = document === undefined || sourcePart === undefined ? context : { ...context, documentPart: sourcePart }
		const result = slideRoot(scoped, node, options)

		if (result.kind === "refused") throw new PresentationError(result.reason, result.detail)

		const markup = await this.withSvgFallbacks(name, api, assemble(result.kind === "markup" ? result.pieces : [], copier))

		this.writer.replace(name, encodeUtf8(XML_DECLARATION + withNamespaces(markup)))

		if (document !== undefined && sourcePart !== undefined) await this.carryImplicit(zipName(sourcePart), name, document, NODE_KINDS)
	}

	// A foreign part related from the fresh part `owner`; an SVG picture's relationship noted for its PNG.
	private relateForeign(owner: string, api: ReturnType<PackageWriter["api"]>, source: string, type: string): string {
		const id = api.relate(modelName(this.foreignTarget(source)), type)

		if (type === IMAGE_RELATIONSHIP && this.extras.svgFallback !== undefined && this.extras.foreign?.contentType(source) === SVG_TYPE) {
			let blips = this.svgBlips.get(owner)

			if (blips === undefined) {
				blips = new Map()
				this.svgBlips.set(owner, blips)
			}

			blips.set(id, source)
		}

		return id
	}

	// The markup of `owner` with each of its SVG pictures shown by a PNG, the SVG in the blip's extension.
	private async withSvgFallbacks(owner: string, api: ReturnType<PackageWriter["api"]>, markup: string): Promise<string> {
		const blips = this.svgBlips.get(owner)
		const fallback = this.extras.svgFallback

		if (blips === undefined || fallback === undefined) return markup

		let out = markup

		for (const [id, source] of blips) {
			let png = this.svgPngs.get(source)

			if (png === undefined) {
				png = this.writer.allocate("image", "image/png")
				this.writer.add(png, "image/png", await fallback(source), { compress: false })
				this.svgPngs.set(source, png)
			}

			out = withSvgBlip(out, id, api.relate(modelName(png), IMAGE_RELATIONSHIP))
		}

		this.svgBlips.delete(owner)

		return out
	}

	// The source part's relationships no markup names (comments, a legacy VML drawing, macros, custom XML): carried
	// over to the fresh part, their targets copied. The kinds the writer builds itself are left out.
	private async carryImplicit(
		sourcePart: string,
		name: string,
		document: XmlDocument | undefined,
		built: ReadonlySet<string>
	): Promise<void> {
		const opc = this.source?.package

		if (opc === undefined) return

		const named = new Set<string>()

		if (document !== undefined) {
			const r = partReader(document)

			for (let node = 1; node < document.count; node++) {
				if (document.kinds[node] !== NodeKind.Element) continue

				for (const attribute of document.attributes(node)) {
					const colon = attribute.name.indexOf(":")

					if (colon > 0 && G_OF(r.namespaces.uri(node, attribute.name.slice(0, colon)) ?? "") === G.R) named.add(attribute.value)
				}
			}
		}

		for (const relationship of (await opc.relationships(sourcePart)).all) {
			if (named.has(relationship.id) || built.has(relationshipKind(relationship.type) ?? relationship.type)) continue

			if (relationship.external) this.keep(name, relationship.id, transitionalType(relationship.type), relationship.target, true)
			else if (relationship.partName !== undefined && opc.has(relationship.partName))
				this.keep(name, relationship.id, transitionalType(relationship.type), this.target(relationship.partName), false)
		}
	}

	// Copies queued source parts (images, media, charts, diagrams, embeddings, fonts) with their relationships.
	private async drain(): Promise<void> {
		const foreign = this.extras.foreign

		// A part's relationships may queue more (a chart's workbook).
		for (let next = this.foreignPending.shift(); foreign !== undefined && next !== undefined; next = this.foreignPending.shift()) {
			const { from, to } = next
			const type = this.writer.typeOf(to) ?? ""
			const streamed = XML_TYPE.test(type) ? undefined : foreign.stream?.(from)

			if (streamed === undefined) this.writer.replace(to, await foreign.read(from))
			else this.streamed(to, type, streamed)

			const relationships = foreign.relationships?.(from) ?? []

			if (relationships.length === 0) continue

			const edit = await this.writer.loadRelationships(to)

			for (const relationship of relationships)
				if (foreign.has(relationship.target))
					edit.add(relationship.type, this.foreignTarget(relationship.target), false, relationship.id)
		}

		const opc = this.source?.package

		if (opc === undefined) return

		while (this.pending.length > 0) {
			const { from, to } = this.pending.shift() as { from: string; to: string }
			const type = this.writer.typeOf(to) ?? ""
			const entry = opc.entry(from)
			const archive = this.source?.archive
			const relationships = await opc.relationships(from)
			const edit = await this.writer.loadRelationships(to)

			if (entry !== undefined) checkCopy(from, type, entry.uncompressedSize)

			// Any part but XML streams from its entry; XML is read whole (a Strict part is written as Transitional).
			if (!XML_TYPE.test(type) && entry !== undefined && archive !== undefined && archive.get(entry.name) === entry)
				this.streamed(to, type, { length: entry.uncompressedSize, crc32: entry.crc32, chunks: () => archive.stream(entry) })
			else this.writer.replace(to, XML_TYPE.test(type) ? transitionalPart(await opc.read(from)) : await opc.read(from))

			for (const relationship of relationships.all) {
				const target = relationship.external ? relationship.target : relationship.partName

				if (target === undefined) continue
				if (!relationship.external && !opc.has(target)) continue

				edit.add(
					transitionalType(relationship.type),
					relationship.external ? target : this.target(target),
					relationship.external,
					relationship.id
				)
			}
		}
	}

	// A copied part streamed into the package: stored when its type is stored media or it is too large to deflate held.
	private streamed(name: string, contentType: string, part: StreamedPart): void {
		checkCopy(name, contentType, part.length)
		this.writer.add(name, contentType, part, {
			compress: !STORED_MEDIA.test(contentType) && part.length <= DEFLATE_HELD,
			crc32: part.crc32
		})
	}

	async run(sink: ByteSink): Promise<number> {
		const deck = this.deck
		const writer = this.writer

		this.contentTypeCache = this.source === undefined ? undefined : await this.source.package.contentTypes()

		// Names first: every node's fresh part, so relationships between them resolve whatever the write order.
		const masters = deck.masters.map((ref, index) => ({
			ref,
			node: this.node(ref),
			name: `ppt/slideMasters/slideMaster${String(index + 1)}.xml`
		}))
		const layouts = deck.layouts.map((ref, index) => ({
			ref,
			node: this.node(ref),
			name: `ppt/slideLayouts/slideLayout${String(index + 1)}.xml`
		}))
		const slides = deck.slides.map((ref, index) => ({ ref, node: this.node(ref), name: `ppt/slides/slide${String(index + 1)}.xml` }))
		const notes = slides.flatMap((slide, index) =>
			slide.node.notes === undefined || !deck.nodes.has(slide.node.notes)
				? []
				: [
						{
							ref: slide.node.notes,
							node: this.node(slide.node.notes),
							name: `ppt/notesSlides/notesSlide${String(index + 1)}.xml`,
							slide: slide.name
						}
					]
		)
		// Notes pages need a notes master (§19.3.1.26): one of no shapes when the deck has none (an ODF deck whose master
		// pages bring no presentation:notes).
		const notesMaster =
			notes.length === 0
				? undefined
				: {
						node:
							deck.notesMaster === undefined
								? {
										ref: slideRef(-1),
										kind: "notesMaster" as const,
										part: "",
										showMasterShapes: true,
										hidden: false,
										shapes: [],
										comments: [],
										revision: 0
									}
								: this.node(deck.notesMaster),
						name: "ppt/notesMasters/notesMaster1.xml"
					}
		const handoutMaster =
			deck.handoutMaster === undefined
				? undefined
				: { node: this.node(deck.handoutMaster), name: "ppt/handoutMasters/handoutMaster1.xml" }

		for (const entry of [
			...masters,
			...layouts,
			...slides,
			...notes,
			...(notesMaster === undefined ? [] : [notesMaster]),
			...(handoutMaster === undefined ? [] : [handoutMaster])
		]) {
			writer.claim(entry.name)
			this.nodeParts.set(entry.node.ref, modelName(entry.name))
			this.mapped.set(partKey(entry.node.part), entry.name)
		}

		const main = "ppt/presentation.xml"
		const mainType = MAIN_TYPES[deck.variant]

		writer.claim(main)
		writer.add("docProps/app.xml", PART_CONTENT_TYPES.extendedProperties, undefined)
		writer.add("docProps/core.xml", PART_CONTENT_TYPES.coreProperties, undefined)
		writer.add(main, mainType, undefined)

		const packageRels = await writer.loadRelationships("")

		packageRels.add(`${TRANSITIONAL_RELATIONSHIPS}officeDocument`, main, false)
		packageRels.add(`${PACKAGE_RELATIONSHIPS}metadata/core-properties`, "docProps/core.xml", false)
		packageRels.add(`${TRANSITIONAL_RELATIONSHIPS}extended-properties`, "docProps/app.xml", false)

		const presentationRels = await writer.loadRelationships(main)

		// Themes: each master's and the notes master's, copied (or ours).
		const themeOf = async (node: SlideNode): Promise<string> => {
			const theme = node.theme?.part

			if (theme !== undefined && this.source?.package.has(zipName(theme)) === true) {
				const name = this.target(zipName(theme))

				return name
			}

			const name = writer.allocate("theme", PART_CONTENT_TYPES.theme)

			writer.add(name, PART_CONTENT_TYPES.theme, encodeUtf8(XML_DECLARATION + DEFAULT_THEME))

			return name
		}

		let nextLayoutId = MIN_MASTER_LAYOUT_ID + masters.length
		const masterIds: string[] = []

		for (const [index, master] of masters.entries()) {
			writer.add(master.name, PART_CONTENT_TYPES.slideMaster, undefined)

			const rels = await writer.loadRelationships(master.name)
			const own = layouts.filter(layout => layout.node.parent === master.ref)
			const list = own.map(
				layout =>
					`<p:sldLayoutId id="${String(nextLayoutId++)}" r:id="${rels.add(`${RELATIONSHIPS}slideLayout`, layout.name, false)}"/>`
			)

			rels.add(`${RELATIONSHIPS}theme`, await themeOf(master.node), false)
			await this.emitNode(
				master.node.clrMap === undefined ? { ...master.node, clrMap: DEFAULT_COLOR_MAP } : master.node,
				master.name,
				{
					layoutList: list.length === 0 ? "" : `<p:sldLayoutIdLst>${list.join("")}</p:sldLayoutIdLst>`
				}
			)
			masterIds.push(
				`<p:sldMasterId id="${String(MIN_MASTER_LAYOUT_ID + index)}" r:id="${presentationRels.add(`${RELATIONSHIPS}slideMaster`, master.name, false)}"/>`
			)
		}

		for (const layout of layouts) {
			const master = masters.find(candidate => candidate.ref === layout.node.parent) ?? masters[0]

			if (master === undefined) throw new PresentationError("malformed", "A layout without a master")

			writer.add(layout.name, PART_CONTENT_TYPES.slideLayout, undefined)
			await this.emitNode(layout.node, layout.name)
			;(await writer.loadRelationships(layout.name)).add(`${RELATIONSHIPS}slideMaster`, master.name, false)
		}

		const slideIds: string[] = []

		for (const [index, slide] of slides.entries()) {
			const layout = layouts.find(candidate => candidate.ref === slide.node.parent) ?? layouts[0]

			if (layout === undefined) throw new PresentationError("malformed", "A slide without a layout")

			writer.add(slide.name, PART_CONTENT_TYPES.slide, undefined)

			// The content's relationships first (they keep the source's ids), then the layout and notes.
			await this.emitNode(slide.node, slide.name)

			const rels = await writer.loadRelationships(slide.name)

			rels.add(`${RELATIONSHIPS}slideLayout`, layout.name, false)

			const own = notes.find(entry => entry.slide === slide.name)

			if (own !== undefined) rels.add(`${RELATIONSHIPS}notesSlide`, own.name, false)

			const comments = this.extras.comments?.(slide.node)

			if (comments !== undefined) {
				const name = writer.allocate("comments", PART_CONTENT_TYPES.comments)

				writer.add(name, PART_CONTENT_TYPES.comments, encodeUtf8(comments))
				rels.add(`${RELATIONSHIPS}comments`, name, false)
			}
			slideIds.push(
				`<p:sldId id="${String(MIN_SLIDE_ID + index)}" r:id="${presentationRels.add(`${RELATIONSHIPS}slide`, slide.name, false)}"/>`
			)
		}

		let notesMasterId = ""

		if (notesMaster !== undefined) {
			writer.add(notesMaster.name, PART_CONTENT_TYPES.notesMaster, undefined)
			;(await writer.loadRelationships(notesMaster.name)).add(`${RELATIONSHIPS}theme`, await themeOf(notesMaster.node), false)
			await this.emitNode(
				notesMaster.node.clrMap === undefined ? { ...notesMaster.node, clrMap: DEFAULT_COLOR_MAP } : notesMaster.node,
				notesMaster.name
			)
			notesMasterId = `<p:notesMasterIdLst><p:notesMasterId r:id="${presentationRels.add(`${RELATIONSHIPS}notesMaster`, notesMaster.name, false)}"/></p:notesMasterIdLst>`

			for (const entry of notes) {
				writer.add(entry.name, PART_CONTENT_TYPES.notesSlide, undefined)

				await this.emitNode(entry.node, entry.name)

				const rels = await writer.loadRelationships(entry.name)

				rels.add(`${RELATIONSHIPS}notesMaster`, notesMaster.name, false)
				rels.add(`${RELATIONSHIPS}slide`, entry.slide, false)
			}
		}

		let handoutId = ""

		if (handoutMaster !== undefined) {
			writer.add(handoutMaster.name, PART_CONTENT_TYPES.handoutMaster, undefined)
			;(await writer.loadRelationships(handoutMaster.name)).add(`${RELATIONSHIPS}theme`, await themeOf(handoutMaster.node), false)
			await this.emitNode(
				handoutMaster.node.clrMap === undefined ? { ...handoutMaster.node, clrMap: DEFAULT_COLOR_MAP } : handoutMaster.node,
				handoutMaster.name
			)
			handoutId = `<p:handoutMasterIdLst><p:handoutMasterId r:id="${presentationRels.add(`${RELATIONSHIPS}handoutMaster`, handoutMaster.name, false)}"/></p:handoutMasterIdLst>`
		}

		// The presentation's own properties: the source's presProps and tableStyles copied, a fresh viewProps.
		for (const kind of ["presProps", "tableStyles"] as const) {
			const sourcePart = await this.related(kind)
			const name = `ppt/${kind}.xml`

			if (sourcePart !== undefined) {
				this.mapped.set(partKey(sourcePart), name)
				writer.claim(name)
				writer.add(name, PART_CONTENT_TYPES[kind], undefined)
				this.pending.push({ from: sourcePart, to: name })
			} else {
				writer.add(
					name,
					PART_CONTENT_TYPES[kind],
					encodeUtf8(
						XML_DECLARATION +
							(kind === "presProps"
								? `<p:presentationPr${ROOT_NAMESPACES}/>`
								: `<a:tblStyleLst xmlns:a="${URIS["a"] ?? ""}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`)
					)
				)
			}

			presentationRels.add(`${RELATIONSHIPS}${kind}`, name, false)
		}

		// p:showPr says the deck's show settings, not the source's.
		writer.patchAfter("ppt/presProps.xml", (document, editor) => {
			const failed = spliceShowPr(document, editor, deck.show)

			if (failed !== undefined) throw new PresentationError(failed.reason, failed.detail)
		})

		if (this.extras.commentAuthors !== undefined) {
			writer.add("ppt/commentAuthors.xml", PART_CONTENT_TYPES.commentAuthors, encodeUtf8(this.extras.commentAuthors))
			presentationRels.add(`${RELATIONSHIPS}commentAuthors`, "ppt/commentAuthors.xml", false)
		}

		if (this.extras.customProperties !== undefined) {
			writer.add("docProps/custom.xml", CUSTOM_PROPERTIES_TYPE, encodeUtf8(this.extras.customProperties))
			packageRels.add(`${TRANSITIONAL_RELATIONSHIPS}custom-properties`, "docProps/custom.xml", false)
		}

		writer.add("ppt/viewProps.xml", PART_CONTENT_TYPES.viewProps, encodeUtf8(`${XML_DECLARATION}<p:viewPr${ROOT_NAMESPACES}/>`))
		presentationRels.add(`${RELATIONSHIPS}viewProps`, "ppt/viewProps.xml", false)

		const presentation = await this.presentationXml(masterIds, notesMasterId, handoutId, slideIds, presentationRels)
		const sourceMain = await this.mainOfSource()

		// What the source's presentation and package relate to that no markup names (comment authors, macros, custom
		// XML, the thumbnail, custom properties).
		if (sourceMain !== undefined)
			await this.carryImplicit(sourceMain, main, await this.source?.package.xml(sourceMain), PRESENTATION_KINDS)
		if (this.source !== undefined) await this.carryImplicit("", "", undefined, PACKAGE_KINDS)

		writer.replace(main, encodeUtf8(XML_DECLARATION + presentation))
		writer.replace("docProps/app.xml", encodeUtf8(this.appXml()))
		writer.replace("docProps/core.xml", encodeUtf8(await this.coreXml()))

		await this.drain()

		// Parts no relationship ended up naming are not written (a theme shared by masters is queued once).
		const { changes } = await writer.changes()
		const items: ZipPlanItem[] = [
			...(changes.replace ?? []).map(change => ({
				kind: "data" as const,
				name: change.name,
				bytes: BytePieces.of([change.bytes as Uint8Array]),
				compress: true
			})),
			...(changes.add ?? []).map(change => ({
				kind: "data" as const,
				name: change.name,
				bytes: change.bytes instanceof Uint8Array ? BytePieces.of([change.bytes]) : change.bytes,
				compress: change.compress ?? true,
				...(change.crc32 === undefined ? {} : { crc32: change.crc32 })
			}))
		]

		return (await writeZip({ items }, null, sink)).size
	}

	private async mainOfSource(): Promise<string | undefined> {
		const opc = this.source?.package

		if (opc === undefined) return undefined

		const main = (await opc.relationships("")).all.find(
			relationship => relationshipKind(relationship.type) === "officeDocument"
		)?.partName

		return main !== undefined && opc.has(main) ? main : undefined
	}

	private async related(kind: string): Promise<string | undefined> {
		const opc = this.source?.package

		if (opc === undefined) return undefined

		const main = (await opc.relationships("")).all.find(
			relationship => relationshipKind(relationship.type) === "officeDocument"
		)?.partName

		if (main === undefined) return undefined

		return (await opc.relationships(main)).all.find(
			relationship =>
				!relationship.external &&
				relationshipKind(relationship.type) === kind &&
				relationship.partName !== undefined &&
				opc.has(relationship.partName)
		)?.partName
	}

	private async presentationXml(
		masterIds: readonly string[],
		notesMasterId: string,
		handoutId: string,
		slideIds: readonly string[],
		rels: Awaited<ReturnType<PackageWriter["loadRelationships"]>>
	): Promise<string> {
		const deck = this.deck
		const sized = this.extras.size ?? deck.size
		const size = `<p:sldSz${attr("cx", sized.cx)}${attr("cy", sized.cy)}${attr("type", this.extras.size === undefined ? deck.size.type : undefined)}/>`
		const notesSize = `<p:notesSz${attr("cx", deck.notesSize.cx)}${attr("cy", deck.notesSize.cy)}/>`
		const fonts = await this.embeddedFonts(rels)
		const idOf = new Map(deck.slides.map((ref, index) => [ref, MIN_SLIDE_ID + index]))
		const rIdOf = (ref: SlideRef): string | undefined => {
			const part = this.nodeParts.get(ref)

			return part === undefined
				? undefined
				: rels.all().find(relationship => partKey(relationship.target) === partKey(zipName(part)))?.id
		}
		const shows = deck.customShows
			.map(
				show =>
					`<p:custShow${attr("name", show.name)}${attr("id", show.id)}><p:sldLst>${show.slides
						.flatMap(ref => {
							const rId = rIdOf(ref)

							return rId === undefined ? [] : [`<p:sld r:id="${rId}"/>`]
						})
						.join("")}</p:sldLst></p:custShow>`
			)
			.join("")
		const defaults = listStyleXml(this.emptyContext(), deck.defaultTextStyle, -1, "p:defaultTextStyle")
		const sections = deck.sections
			.map(
				section =>
					`<p14:section${attr("name", section.name)}${attr("id", section.id)}><p14:sldIdLst>${section.slides
						.flatMap(ref => (idOf.has(ref) ? [`<p14:sldId id="${String(idOf.get(ref))}"/>`] : []))
						.join("")}</p14:sldIdLst></p14:section>`
			)
			.join("")

		if (!Array.isArray(defaults)) throw new PresentationError((defaults as Refused).reason, (defaults as Refused).detail)

		return (
			`<p:presentation${ROOT_NAMESPACES}${deck.firstSlideNumber === 1 ? "" : attr("firstSlideNum", deck.firstSlideNumber)}>` +
			`<p:sldMasterIdLst>${masterIds.join("")}</p:sldMasterIdLst>${notesMasterId}${handoutId}` +
			(slideIds.length === 0 ? "" : `<p:sldIdLst>${slideIds.join("")}</p:sldIdLst>`) +
			`${size}${notesSize}${fonts}${shows === "" ? "" : `<p:custShowLst>${shows}</p:custShowLst>`}` +
			assemble(defaults as readonly EmitPiece[], undefined) +
			(sections === ""
				? ""
				: `<p:extLst><p:ext uri="${SECTIONS_EXT}"><p14:sectionLst xmlns:p14="${P14}">${sections}</p14:sectionLst></p:ext></p:extLst>`) +
			"</p:presentation>"
		)
	}

	private emptyContext(): EmitContext {
		return { deck: this.deck, document: undefined, parts: this.writer.api("/ppt/presentation.xml"), mode: "model" }
	}

	// p:embeddedFontLst: the deck's embedded fonts, their font parts copied.
	private async embeddedFonts(rels: Awaited<ReturnType<PackageWriter["loadRelationships"]>>): Promise<string> {
		const opc = this.source?.package
		const fonts: string[] = []

		for (const font of this.deck.embeddedFonts) {
			let faces = ""

			for (const style of ["regular", "bold", "italic", "boldItalic"] as const) {
				const part = font[style]

				if (part === undefined || opc?.has(zipName(part)) !== true) continue

				faces += `<p:${style} r:id="${rels.add(`${RELATIONSHIPS}font`, this.target(zipName(part)), false)}"/>`
			}

			if (faces === "") continue

			fonts.push(
				`<p:embeddedFont><p:font${attr("typeface", font.typeface)}${attr("pitchFamily", font.pitchFamily)}${attr("charset", font.charset)}/>${faces}</p:embeddedFont>`
			)
		}

		return fonts.length === 0 ? "" : `<p:embeddedFontLst>${fonts.join("")}</p:embeddedFontLst>`
	}

	private appXml(): string {
		const hidden = this.deck.slides.filter(ref => this.deck.nodes.get(ref)?.hidden === true).length

		return (
			`${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
			`<Application>Filen</Application><Slides>${String(this.deck.slides.length)}</Slides>` +
			`<Notes>${String(this.deck.slides.filter(ref => this.deck.nodes.get(ref)?.notes !== undefined).length)}</Notes>` +
			`<HiddenSlides>${String(hidden)}</HiddenSlides></Properties>`
		)
	}

	// The source's core properties as they are, or none written but the required root.
	private async coreXml(): Promise<string> {
		const opc = this.source?.package

		if (opc !== undefined) {
			const core = (await opc.relationships("")).all.find(
				relationship => relationship.type.endsWith("/metadata/core-properties") && relationship.partName !== undefined
			)

			if (core?.partName !== undefined && opc.has(core.partName)) {
				const bytes = await opc.read(core.partName)

				return decodeUtf8(bytes, 0, bytes.length)
			}
		}

		return (
			this.extras.coreProperties ??
			`${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"/>`
		)
	}
}

// The whole package of a deck written from its model (every node parsed), with media and other parts copied from
// `source` when the deck has one.
export const freshPptx: FreshPptx = (deck, source, sink, options) => freshPptxWith(deck, source, sink, options)

// freshPptx with what a conversion from another format adds: its foreign parts and nearer forms.
export async function freshPptxWith(
	deck: Deck,
	source: PptxSource | undefined,
	sink: ByteSink,
	options: PptxSaveOptions,
	extras: FreshExtras = {}
): Promise<PptxSaveOutcome> {
	void options

	const empty: OpcPackageType = OpcPackage.fromParts(new Map([["[Content_Types].xml", encodeUtf8(CONTENT_TYPES)]]))
	const writer = new PackageWriter(empty, await empty.contentTypes())

	try {
		const size = await new Fresh(deck, source, writer, extras).run(sink)

		return { kind: "written", report: { size, entries: 0, crcs: new Map(), copies: new Map() }, revision: deck.revision }
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)
		// Markup copied from the source that does not decode (an attribute's invalid character reference): no
		// well-formed part can carry it, so the package is refused rather than written without it.
		if (error instanceof XmlError) return refused("malformed", error.message)

		throw error
	}
}

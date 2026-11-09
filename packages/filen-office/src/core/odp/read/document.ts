import { chartOf, translateChart } from "../../ods/charts/read"
import { NO_PROPERTIES, OdfPackage, OdfStyleSheet, parseLength, type OdfElement, type OdfProperties } from "../../odf/index"
import { readContentPrologueSliced, readContentPrologue } from "../../odf/prologue"
import { PRESENTATION_ZIP_LIMITS } from "../../opc/mediaPolicy"
import { Relationships, ZipError, partKey, type ByteSource, type Slicing, type ZipEntry } from "../../opc/index"
import { DeckTally, DEFAULT_PRESENTATION_BUDGETS, type PresentationBudgets } from "../../presentation/budget"
import { SlideRefs } from "../../presentation/ids"
import {
	PresentationError,
	refused,
	type CommentRef,
	type CustomShow,
	type Deck,
	type OdpHeaderFooter,
	type Refused,
	type ShapeNode,
	type ShowSettings,
	type SlideNode,
	type SlideRef,
	type Xfrm
} from "../../presentation/model"
import { tooLarge } from "../../presentation/refusal"
import { Namespaces, XmlError, decodeUtf8, encodeUtf8, parseXml, parseXmlSliced, type XmlDocument } from "../../xml/index"
import { Fragment, OdpContext, type TableTemplate } from "./context"
import { EMU_PER_PT, fillOf, packagePart } from "./fills"
import { pageFragment, scanPages, ScanError, type ContentPages, type PageSpan } from "./scan"
import { CLASS_TYPES, readShapeElements, readShapes, type ShapeScope } from "./shapes"
import { levelStyle, listStyleOf } from "./text"
import { readOdpTiming } from "../../anim/odf"
import { readTransition } from "./transitions"
import { isPageTransitionPar, pageTransitionSound } from "../../anim/presets/transitions/odf"
import type { Transition } from "../../anim/model"

// Opening an OpenDocument presentation (.odp, .otp; ODF 1.3 Part 3 §3.2, §10) into the shared model, the reader
// building the model directly (sources are page fragments, `src.format = "odp"`):
//   style:master-page   → a master (its shapes; its presentation:notes → that master's notes master);
//   (master, style:presentation-page-layout) pairs, every page layout on every master, and pairs pages name that
//                        styles.xml lacks → synthesized layouts (`synthetic`, never written to ODP) holding the page
//                        layout's placeholder boxes (§16.43–44);
//   draw:page           → a slide, parsed when first needed from its byte span (scan.ts); its presentation:notes →
//                        its notes page;
//   a master's header, footer, date-time and page-number frames → the slide's own shapes where the page's style
//                        displays them, their fields resolved from the page's declarations (synthetic);
//   drawing-page styles → backgrounds, hidden slides, master-shape visibility and transitions;
//   presentation:settings → show settings and custom shows.
// Encrypted packages are refused "encrypted" (as ODT and ODS are); packages signed in META-INF/documentsignatures.xml
// open view-only (gate "signed"). A page's animations are read into its timing (core/anim/odf.ts).

export interface OdpOpenOptions {
	readonly slicing?: Slicing
	readonly budgets?: PresentationBudgets
	// The base source's generation (SourceRef.epoch): 0 at open, +1 per save rebase.
	readonly epoch?: number
	// A rebase onto the deck's saved file: the reading takes over this deck (its nodes, refs and history stay the
	// session's) instead of the one it builds. The saved file's pages are the deck's slides in order and its master
	// pages the deck's masters in order (the writer keeps both); layouts match by master and layout name.
	readonly adopt?: Deck
	// With adopt: refs at or below this number are never handed out (the previous reading's, which the session's
	// history may still name); OdpParts.refsIssued() of that reading.
	readonly refsAbove?: number
	// With adopt: the deck's slides the saved file's pages are, in order (the order its save wrote; slides added,
	// removed or moved since are the next save's). The deck's slides when absent.
	readonly adoptOrder?: readonly SlideRef[]
}

export type OdpOpen = { readonly kind: "opened"; readonly deck: Deck; readonly parts: OdpParts } | Refused

const CHART_TYPE = "application/vnd.oasis.opendocument.chart"
const MAX_OBJECT_BYTES = 16 * 1024 * 1024
// The picture types whose header states a size (pictureSize).
const SIZED_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/bmp"])
const MAX_CLIP_BYTES = 64 * 1024 * 1024

// Media types of package streams as the renderer and the image service read them.
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp",
	svg: "image/svg+xml",
	tif: "image/tiff",
	tiff: "image/tiff",
	wmf: "image/x-wmf",
	emf: "image/x-emf",
	svm: "image/x-svm"
}

type PictureSize = { readonly width: number; readonly height: number }

// A raster picture's size in points from its header: PNG (IHDR, pHYs), JPEG (SOFn, JFIF APP0), GIF and BMP.
export function pictureSize(bytes: Uint8Array): PictureSize | undefined {
	const size = pictureHeader(bytes, true)

	return size === "more" ? undefined : size
}

// pictureSize of the first bytes of a picture: "more" while the header may lie past them (`complete` false).
function pictureHeader(bytes: Uint8Array, complete: boolean): PictureSize | undefined | "more" {
	const u16 = (at: number): number => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
	const u32 = (at: number): number =>
		(bytes[at] ?? 0) * 0x1000000 + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0)
	const le16 = (at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
	const le32 = (at: number): number => le16(at) + le16(at + 2) * 0x10000
	const points = (pixels: number, perInch: number): number => (pixels * 72) / (perInch > 0 ? perInch : 96)

	if (!complete && bytes.length < 4) return "more"

	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		const width = u32(16)
		const height = u32(20)
		let dpiX = 96
		let dpiY = 96
		let at = 8

		for (; at + 12 <= bytes.length && at < 1_048_576;) {
			const length = u32(at)
			const type = String.fromCharCode(bytes[at + 4] ?? 0, bytes[at + 5] ?? 0, bytes[at + 6] ?? 0, bytes[at + 7] ?? 0)

			if (type === "pHYs" && bytes[at + 16] === 1) {
				if (!complete && at + 17 > bytes.length) return "more"

				dpiX = u32(at + 8) * 0.0254
				dpiY = u32(at + 12) * 0.0254
			}

			if (type === "IDAT" || type === "IEND") break

			at += 12 + length
		}

		if (!complete && at + 12 > bytes.length && at < 1_048_576) return "more"

		return { width: points(width, dpiX), height: points(height, dpiY) }
	}

	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let dpiX = 96
		let dpiY = 96

		for (let at = 2; at + 9 < bytes.length;) {
			if (bytes[at] !== 0xff) return undefined

			const marker = bytes[at + 1] ?? 0
			const length = u16(at + 2)

			if (marker === 0xe0 && bytes[at + 4] === 0x4a && bytes[at + 5] === 0x46 && (bytes[at + 11] === 1 || bytes[at + 11] === 2)) {
				if (!complete && at + 16 > bytes.length) return "more"

				const scale = bytes[at + 11] === 2 ? 2.54 : 1

				dpiX = u16(at + 12) * scale
				dpiY = u16(at + 14) * scale
			}

			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
				return { width: points(u16(at + 7), dpiX), height: points(u16(at + 5), dpiY) }

			at += 2 + length
		}

		return complete ? undefined : "more"
	}

	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		if (!complete && bytes.length < 10) return "more"

		return { width: points(le16(6), 96), height: points(le16(8), 96) }
	}

	if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
		if (!complete && bytes.length < 46) return "more"

		const perMeterX = le32(38)
		const perMeterY = le32(42)

		return { width: points(le32(18), perMeterX * 0.0254), height: points(Math.abs(le32(22) | 0), perMeterY * 0.0254) }
	}

	return undefined
}

function sniff(head: Uint8Array): string | undefined {
	const at = (k: number): number => head[k] ?? -1

	if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png"
	if (at(0) === 0xff && at(1) === 0xd8) return "image/jpeg"
	if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif"
	if (at(0) === 0x42 && at(1) === 0x4d) return "image/bmp"
	if (at(0) === 0xd7 && at(1) === 0xcd && at(2) === 0xc6 && at(3) === 0x9a) return "image/x-wmf"
	if (at(0) === 0x01 && at(1) === 0x00 && at(2) === 0x09 && at(3) === 0x00) return "image/x-wmf"
	if (at(0) === 0x01 && at(1) === 0x00 && at(2) === 0x00 && at(3) === 0x00 && at(40) === 0x20 && at(41) === 0x45) return "image/x-emf"
	if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45) return "image/webp"
	if (at(0) === 0x56 && at(1) === 0x43 && at(2) === 0x4c && at(3) === 0x4d) return "image/x-svm"

	const text = decodeUtf8(head, 0, Math.min(256, head.length))

	return /<svg[\s>]/u.test(text) ? "image/svg+xml" : undefined
}

// A manifest media type as a renderable image type: LibreOffice names metafiles with Windows clipboard formats.
function imageType(mediaType: string | undefined): string | undefined {
	if (mediaType === undefined) return undefined

	const lower = mediaType.toLowerCase()

	if (/^image\/(png|jpeg|gif|bmp|webp|svg\+xml|tiff|x-wmf|x-emf|wmf|emf)$/u.test(lower)) return lower
	if (lower.includes("x-openoffice-wmf")) return "image/x-wmf"
	if (lower.includes("x-openoffice-emf")) return "image/x-emf"
	if (lower.includes("gdimetafile")) return "image/x-svm"

	return undefined
}

const DECL_KINDS = ["header", "footer", "date-time"] as const
const DISPLAY_KINDS = ["header", "footer", "date-time", "page-number"] as const

// A page's header and footer settings as written: the declarations its start tag names and its drawing-page style's
// display flags (the style's chain resolved), or undefined when it has none.
function headerFooterOf(page: ReadonlyMap<string, string>, style: ReadonlyMap<string, string>): OdpHeaderFooter | undefined {
	const use: { -readonly [K in keyof OdpHeaderFooter["use"]]: string } = {}
	const display: { -readonly [K in keyof OdpHeaderFooter["display"]]: boolean } = {}
	let any = false

	for (const kind of DECL_KINDS) {
		const name = page.get(`presentation:use-${kind}-name`)

		if (name === undefined) continue

		use[kind] = name
		any = true
	}

	for (const kind of DISPLAY_KINDS) {
		const value = style.get(`presentation:display-${kind}`)

		if (value === undefined) continue

		display[kind] = value === "true"
		any = true
	}

	return any ? { use, display } : undefined
}

interface PageHead {
	readonly name: string
	readonly style: string | undefined
	readonly master: string
	readonly layout: string
	readonly attributes: ReadonlyMap<string, string>
}

interface MasterInfo {
	readonly ref: SlideRef
	readonly name: string
	readonly boxes: Map<string, Xfrm>
	// The header, footer, date-time and page-number frames (element of styles.xml) by class.
	readonly footers: Map<string, number>
	readonly notesMaster: SlideRef | undefined
	readonly notesBoxes: Map<string, Xfrm>
	readonly size: { cx: number; cy: number } | undefined
	// The page size of its presentation:notes' style:page-layout-name (§19.506), when written.
	readonly notesSize: { cx: number; cy: number } | undefined
}

// The view a package stream offers the renderer and the image service (OPC-shaped; ODF has no relationships).
export interface OdpPackageView {
	entry(name: string): ZipEntry | undefined
	has(name: string): boolean
	read(name: string, slicing?: Slicing): Promise<Uint8Array>
	xml(name: string, slicing?: Slicing): Promise<XmlDocument>
	relationships(name: string): Promise<Relationships>
}

const NO_RELATIONSHIPS = new Relationships([])

// A deck's parts: the package, the scanned content, the style sheet, and the lazy parse of pages and their notes.
// Core functions on the deck are synchronous and need the nodes they touch present: callers `await parts.slide(ref)`.
export class OdpParts {
	readonly odf: OdfPackage
	readonly content: ContentPages
	readonly sheet: OdfStyleSheet
	readonly context: OdpContext
	readonly budgets: PresentationBudgets
	readonly tally: DeckTally
	readonly epoch: number
	readonly opc: OdpPackageView
	readonly contentTypes: { typeOf(name: string): string | undefined }
	readonly stylesFragment: Fragment | undefined
	// Shapes the reader kept in the source without modelling them (form controls, unknown frames, 3D scenes).
	unread = 0
	// Charts drawn without some of what their object holds (a trend line, a secondary axis, combined plots).
	approximatedCharts = 0
	deck!: Deck
	private readonly entries = new Map<string, ZipEntry>()
	private readonly types = new Map<string, string>()
	// Pictures' own sizes by part (pictureSizeOf), undefined for one whose header states none.
	private readonly sizes = new Map<string, PictureSize | undefined>()
	private readonly documents = new Map<string, XmlDocument>()
	private readonly pending = new Map<SlideRef, Promise<SlideNode>>()
	private readonly spans = new Map<SlideRef, PageSpan>()
	private readonly heads = new Map<SlideRef, PageHead>()
	private readonly masters = new Map<string, MasterInfo>()
	private readonly layoutOf = new Map<string, SlideRef>()
	private readonly decls = new Map<string, Map<string, { readonly text: string; readonly fixed: boolean }>>()
	private readonly slicing: Slicing | undefined
	private readonly refs = new SlideRefs()
	// Refs a reading must never hand out: those of the deck it took over (adopt).
	private taken: ReadonlySet<SlideRef> | undefined

	// Entries a save let go of that the session still holds (an undo put their shape back): read as the package's.
	private held: ((part: string) => { readonly bytes: Uint8Array; readonly mediaType: string } | undefined) | undefined

	holdMedia(lookup: (part: string) => { readonly bytes: Uint8Array; readonly mediaType: string } | undefined): void {
		this.held = lookup
	}

	constructor(
		odf: OdfPackage,
		content: ContentPages,
		sheet: OdfStyleSheet,
		budgets: PresentationBudgets,
		options: OdpOpenOptions,
		pages: ReadonlyMap<string, SlideRef>,
		templates: ReadonlyMap<string, TableTemplate>
	) {
		this.odf = odf
		this.content = content
		this.sheet = sheet
		this.budgets = budgets
		this.tally = new DeckTally(budgets)
		this.epoch = options.epoch ?? 0
		this.slicing = options.slicing

		for (const entry of odf.archive.entries) if (!entry.name.endsWith("/")) this.entries.set(partKey(entry.name), entry)

		const manifest = new Map((odf.manifest?.entries ?? []).map(entry => [partKey(entry.fullPath.replace(/\/$/u, "")), entry.mediaType]))

		this.context = new OdpContext(sheet, budgets, this.tally, pages, {
			mediaType: part => manifest.get(partKey(part)) ?? this.held?.(part)?.mediaType,
			has: part => this.entries.has(partKey(part)) || this.held?.(part) !== undefined,
			templates,
			pictureSize: part => this.sizes.get(partKey(part))
		})
		this.opc = {
			entry: name => this.entries.get(partKey(name)),
			has: name => this.entries.has(partKey(name)) || this.held?.(name) !== undefined,
			read: async (name, slicing) => {
				const entry = this.entries.get(partKey(name))
				const held = entry === undefined ? this.held?.(name) : undefined

				if (held !== undefined) return held.bytes
				if (entry === undefined) throw new PresentationError("notFound", `No stream ${name}`)

				return slicing === undefined ? odf.archive.read(entry) : odf.archive.readSliced(entry, slicing)
			},
			xml: async (name, slicing) => {
				const bytes = await this.opc.read(name, slicing)

				return slicing === undefined ? parseXml(bytes) : parseXmlSliced(bytes, slicing)
			},
			relationships: () => Promise.resolve(NO_RELATIONSHIPS)
		}
		this.contentTypes = {
			typeOf: name => {
				const key = partKey(name)
				const held = this.types.get(key)

				if (held !== undefined) return held

				const extension = /\.([a-z0-9]+)$/u.exec(key)?.[1]

				return imageType(manifest.get(key)) ?? (extension === undefined ? undefined : IMAGE_EXTENSIONS[extension])
			}
		}

		const stylesDocument = sheet.stylesDocument
		const stylesNamespaces = sheet.stylesNamespaces

		this.stylesFragment =
			stylesDocument === undefined || stylesNamespaces === undefined
				? undefined
				: new Fragment(stylesDocument, stylesNamespaces, "styles.xml", -1, "styles", this.epoch)
	}

	// Parsed XML the renderer reads outside the deck's nodes: the charts translated from embedded chart objects.
	document(part: string): XmlDocument | undefined {
		return this.documents.get(partKey(part))
	}

	// A rebase's reading keeps the charts `from` translated whose object the saved file holds unchanged (same content.xml
	// by CRC-32 and size): the pages the session parsed before the save are not read again, and their frames name them.
	carryCharts(from: OdpParts): void {
		// The translations by their object's content (CRC and size): a copy the save made of an object (a duplicated
		// page's chart, emit/chart.ts copyObject) reads as its source did.
		const byContent = new Map<string, XmlDocument>()
		const contentKey = (entry: ZipEntry): string => `${String(entry.crc32)}:${String(entry.uncompressedSize)}`

		for (const [key, document] of from.documents) {
			if (!key.endsWith("/chart.xml")) continue

			const content = `${key.slice(0, key.length - "/chart.xml".length)}/content.xml`
			const before = from.entries.get(content)
			const after = this.entries.get(content)

			if (before !== undefined) byContent.set(contentKey(before), document)
			if (this.documents.has(key)) continue
			if (
				before !== undefined &&
				after !== undefined &&
				before.crc32 === after.crc32 &&
				before.uncompressedSize === after.uncompressedSize
			)
				this.documents.set(key, document)
		}

		if (byContent.size === 0) return

		for (const [name, entry] of this.entries) {
			if (!name.endsWith("/content.xml")) continue

			const key = `${name.slice(0, name.length - "/content.xml".length)}/chart.xml`
			const document = this.documents.has(key) ? undefined : byContent.get(contentKey(entry))

			if (document !== undefined) this.documents.set(key, document)
		}
	}

	theme(): undefined {
		return undefined
	}

	refOf(): SlideRef | undefined {
		return undefined
	}

	// A node, parsed when it is a page not read yet (with its notes).
	slide(ref: SlideRef, slicing?: Slicing): Promise<SlideNode> {
		const held = this.deck.nodes.get(ref)

		if (held !== undefined) return Promise.resolve(held)

		let pending = this.pending.get(ref)

		if (pending === undefined) {
			pending = this.parsePage(ref, slicing ?? this.slicing).finally(() => this.pending.delete(ref))
			this.pending.set(ref, pending)
		}

		return pending
	}

	async parseAll(slicing?: Slicing): Promise<void> {
		for (const ref of this.deck.slides) await this.slide(ref, slicing)
	}

	private async parsePage(ref: SlideRef, slicing: Slicing | undefined): Promise<SlideNode> {
		const span = this.spans.get(ref)
		const head = this.heads.get(ref)

		if (span === undefined || head === undefined) throw new PresentationError("notFound", "slide")

		let document: XmlDocument

		try {
			document = pageFragment(this.content, span)
		} catch (error) {
			if (error instanceof XmlError) throw new PresentationError("malformed", `Page ${head.name}: ${error.message}`)

			throw error
		}

		const fragment = new Fragment(
			document,
			new Namespaces(document, { lenient: true }),
			"content.xml",
			span.start,
			"content",
			this.epoch
		)
		const images = new Set<string>()
		const charts = new Set<string>()
		const clips: ShapeScope["clips"] = []
		let node: SlideNode

		try {
			node = this.tally.count(ref, () => this.readPage(ref, fragment, head, images, charts, clips))
		} catch (error) {
			// Markup the parse let through and a value read later refuses (a character reference to NUL).
			if (error instanceof XmlError) throw new PresentationError("malformed", `Page ${head.name}: ${error.message}`)

			throw error
		}

		// What the renderer reads beside the page: the charts, and the types of pictures the manifest leaves open.
		for (const path of charts) await this.translateChart(path, node, slicing)
		for (const part of images) await this.sniffImage(part)
		for (const clip of clips) await this.cropPicture(clip)

		return node
	}

	// The sizes of the bitmap fills' pictures (§16.42 draw:fill-image), read before anything is read: a tile sized by
	// a length scales by its picture's own size, and every reading (pages, masters, held pages) is synchronous. The
	// header of each picture only.
	async readFillImageSizes(): Promise<void> {
		for (const element of this.sheet.drawResources.get("draw:fill-image")?.values() ?? []) {
			const part = packagePart(element.attributes.get("xlink:href"))

			if (part !== undefined) await this.pictureSizeOf(part)
		}
	}

	// A page's background and transition as a reading of the page gives them, for a page in any fragment (one an
	// undo holds, read again by the writer), its styles resolved through `context` (the deck's by default).
	pageFields(
		fragment: Fragment,
		page: number,
		context: OdpContext = this.context
	): { readonly background: SlideNode["background"]; readonly transition: SlideNode["transition"] } {
		let filter: ReadonlyMap<string, string> | undefined
		let sound: Transition["sound"]

		for (let child = fragment.document.firstChildElement(page); child >= 0; child = fragment.document.nextSiblingElement(child)) {
			if (fragment.name(child) === "anim:par") {
				filter = transitionFilter(fragment, child)
				sound = transitionSoundOf(fragment, child)
			}
		}

		return this.fieldsOf(this.pageStyle(fragment.attributes(page).get("draw:style-name"), "content", context), filter, sound)
	}

	private fieldsOf(
		style: OdfProperties,
		filter: ReadonlyMap<string, string> | undefined,
		sound: Transition["sound"]
	): { readonly background: SlideNode["background"]; readonly transition: SlideNode["transition"] } {
		const attributes = style.attributes
		const transition = readTransition(attributes, filter, sound)
		// The page's own fill, else (when the page hides its master's background) white paper, else the master's.
		const own = fillOf(style, this.sheet.drawResources, this.context.pictureSizes)
		const fill =
			own !== undefined && own !== "none"
				? own
				: attributes.get("presentation:background-visible") === "false"
					? { kind: "solid" as const, color: { kind: "srgb" as const, rgb: "FFFFFF" } }
					: undefined

		return { background: fill === undefined ? undefined : { kind: "fill", fill }, transition }
	}

	private readPage(
		ref: SlideRef,
		fragment: Fragment,
		head: PageHead,
		images: Set<string>,
		charts: Set<string>,
		clips: ShapeScope["clips"]
	): SlideNode {
		const document = fragment.document
		const page = document.firstChildElement(document.documentElement())
		const master = this.masters.get(head.master) ?? this.masters.values().next().value
		const style = this.pageStyle(head.style, "content")
		const attributes = style.attributes
		const headerFooter = headerFooterOf(head.attributes, attributes)
		let next = 1
		const fields = this.declFields(headerFooter)
		const scope: ShapeScope = {
			fragment,
			text: { fields },
			masterBoxes: master?.boxes ?? new Map(),
			nextId: () => ++next,
			images,
			charts,
			clips,
			unread: 0,
			...(master === undefined ? {} : { masterName: master.name })
		}
		const shapes = page < 0 ? [] : readShapes(this.context, scope, page)

		this.pushMasterFooters(shapes, master, headerFooter, scope)
		this.unread += scope.unread

		let notes: SlideRef | undefined
		const comments: CommentRef[] = []
		let filter: ReadonlyMap<string, string> | undefined
		let sound: Transition["sound"]

		for (let child = page < 0 ? -1 : document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
			const name = fragment.name(child)

			if (name === "presentation:notes") notes = this.readNotes(fragment, child, master)
			else if (name === "officeooo:annotation" || name === "office:annotation")
				comments.push({ id: `odf-${String(fragment.offset)}-${String(child)}`, part: "content.xml", kind: "odf" })
			else if (name === "anim:par") {
				filter = transitionFilter(fragment, child)
				sound = transitionSoundOf(fragment, child)
			}
		}

		const { background, transition } = this.fieldsOf(style, filter, sound)
		const timing = page < 0 ? undefined : readOdpTiming(fragment, page, shapes, this.budgets.timing)
		const layout = this.layoutOf.get(`${head.master}\u0000${head.layout}`)
		const node: SlideNode = {
			ref,
			kind: "slide",
			part: `/content.xml#${String(ref)}`,
			src: fragment.src(page < 0 ? document.documentElement() : page),
			name: head.name,
			...(layout === undefined ? {} : { parent: layout }),
			...(background === undefined ? {} : { background }),
			showMasterShapes: attributes.get("presentation:background-objects-visible") !== "false",
			hidden: attributes.get("presentation:visibility") === "hidden",
			...(headerFooter === undefined ? {} : { odpHeaderFooter: headerFooter }),
			shapes,
			...(transition === undefined ? {} : { transition }),
			...(timing === undefined ? {} : { timing }),
			...(notes === undefined ? {} : { notes }),
			comments,
			revision: 0
		}

		this.deck.nodes.set(ref, node)

		return node
	}

	// The pages in content order, by the refs the deck names them with.
	pageRefs(): readonly SlideRef[] {
		return [...this.spans.keys()]
	}

	// A page's byte span in content.xml (the writer copies an untouched page by it).
	span(ref: SlideRef): PageSpan | undefined {
		return this.spans.get(ref)
	}

	// This reading takes over `target` (OdpOpenOptions.adopt): the refs it built are mapped onto the deck's (pages and
	// masters by position, notes masters by master, layouts by master and name; a layout the deck lacks is added to it
	// under a ref the deck does not use), and every table keyed by ref is keyed by the deck's.
	// The highest ref this reading's allocator has handed out (what a rebase reading must stay above).
	refsIssued(): number {
		return this.refs.issued
	}

	adopt(target: Deck, refsAbove = 0, order: readonly SlideRef[] = target.slides): void {
		const built = this.deck

		// Never at or below the previous reading's refs.
		while (this.refs.issued < refsAbove) this.refs.next()

		if (built.slides.length !== order.length || built.masters.length !== target.masters.length)
			throw new PresentationError("stale", "the saved file's pages are not the deck's")

		this.taken = new Set<SlideRef>([...target.nodes.keys(), ...target.slides, ...order, ...target.masters, ...target.layouts])

		const map = new Map<SlideRef, SlideRef>()

		built.slides.forEach((ref, index) => map.set(ref, order[index] as SlideRef))
		built.masters.forEach((ref, index) => map.set(ref, target.masters[index] as SlideRef))

		for (const master of built.masters) {
			const notes = [...this.masters.values()].find(info => info.ref === master)?.notesMaster
			const targetMaster = target.nodes.get(map.get(master) as SlideRef)
			const targetNotes = [...target.nodes.values()].find(node => node.kind === "notesMaster" && node.name === targetMaster?.name)

			if (notes !== undefined && targetNotes !== undefined) map.set(notes, targetNotes.ref)
		}

		const key = (deck: Deck, ref: SlideRef, parent: (ref: SlideRef) => SlideRef | undefined): string => {
			const node = deck.nodes.get(ref)

			return `${String(node?.parent === undefined ? "" : parent(node.parent))}\u0000${node?.layoutType ?? node?.name ?? ""}`
		}
		const targetLayouts = new Map(target.layouts.map(ref => [key(target, ref, parent => parent), ref]))

		for (const ref of built.layouts) {
			const found = targetLayouts.get(key(built, ref, parent => map.get(parent)))

			if (found !== undefined) {
				map.set(ref, found)

				continue
			}

			const node = built.nodes.get(ref) as SlideNode
			const fresh = this.nextRef()

			map.set(ref, fresh)
			target.layouts.push(fresh)
			target.nodes.set(fresh, {
				...node,
				ref: fresh,
				...(node.parent === undefined ? {} : { parent: map.get(node.parent) ?? node.parent })
			})
		}

		const rekey = <T>(table: Map<SlideRef, T>): void => {
			const entries = [...table]

			table.clear()

			for (const [ref, value] of entries) table.set(map.get(ref) ?? ref, value)
		}

		rekey(this.spans)
		rekey(this.heads)

		for (const [name, ref] of this.layoutOf) this.layoutOf.set(name, map.get(ref) ?? ref)
		for (const [name, info] of this.masters)
			this.masters.set(name, {
				...info,
				ref: map.get(info.ref) ?? info.ref,
				notesMaster: info.notesMaster === undefined ? undefined : (map.get(info.notesMaster) ?? info.notesMaster)
			})

		this.deck = target
	}

	private nextRef(): SlideRef {
		let ref = this.refs.next()

		while (this.taken?.has(ref) === true) ref = this.refs.next()

		return ref
	}

	private readNotes(fragment: Fragment, element: number, master: MasterInfo | undefined): SlideRef {
		const ref = this.nextRef()
		let next = 1
		const scope: ShapeScope = {
			fragment,
			text: {},
			masterBoxes: master?.notesBoxes ?? new Map(),
			nextId: () => ++next,
			images: new Set(),
			charts: new Set(),
			clips: [],
			unread: 0,
			...(master === undefined ? {} : { masterName: master.name })
		}
		const shapes = readShapes(this.context, scope, element)

		this.deck.nodes.set(ref, {
			ref,
			kind: "notes",
			part: `/content.xml#${String(ref)}`,
			src: fragment.src(element),
			...(master?.notesMaster === undefined ? {} : { parent: master.notesMaster }),
			showMasterShapes: true,
			hidden: false,
			shapes,
			comments: [],
			revision: 0
		})

		return ref
	}

	private decl(kind: string, name: string | undefined): { readonly text: string; readonly fixed: boolean } | undefined {
		return name === undefined ? undefined : this.decls.get(kind)?.get(name)
	}

	// The field texts a page's declarations give (a name with no declaration: empty, the date-time current).
	private declFields(settings: OdpHeaderFooter | undefined): NonNullable<ShapeScope["text"]["fields"]> {
		const use = settings?.use

		return {
			...(use?.header === undefined ? {} : { header: this.decl("header", use.header)?.text ?? "" }),
			...(use?.footer === undefined ? {} : { footer: this.decl("footer", use.footer)?.text ?? "" }),
			...(use?.["date-time"] === undefined ? {} : { dateTime: this.decl("date-time", use["date-time"]) ?? { fixed: false } })
		}
	}

	// The master's footers a page with `settings` shows, pushed onto its shapes (§20.233–§20.236; LibreOffice's defaults
	// when unwritten: header, footer and date-time shown, the page number not). Each is the master's frame (ODF holds
	// no per-page copy of it): synthetic, and no edit of the slide can change it.
	private pushMasterFooters(
		shapes: ShapeNode[],
		master: MasterInfo | undefined,
		settings: OdpHeaderFooter | undefined,
		scope: ShapeScope
	): void {
		if (master === undefined || this.stylesFragment === undefined) return

		const fields = scope.text.fields
		const display = (name: "date-time" | "footer" | "page-number", fallback: boolean): boolean => settings?.display[name] ?? fallback
		const shown: readonly [string, boolean][] = [
			["date-time", display("date-time", true) && fields?.dateTime !== undefined],
			["footer", display("footer", true) && (fields?.footer ?? "") !== ""],
			["page-number", display("page-number", false)]
		]

		for (const [kind, visible] of shown) {
			const element = master.footers.get(kind)

			if (!visible || element === undefined) continue

			const footerScope: ShapeScope = { ...scope, fragment: this.stylesFragment, masterBoxes: new Map() }
			const footer: ShapeNode | undefined = readShapeElements(this.context, footerScope, [element])[0]

			if (footer === undefined) continue

			footer.synthetic = true
			footer.lock = "master"
			shapes.push(footer)
		}
	}

	// A source page's header and footer settings (parsed or not), from its start tag and drawing-page style.
	headerFooter(ref: SlideRef): OdpHeaderFooter | undefined {
		const head = this.heads.get(ref)

		return head === undefined ? undefined : headerFooterOf(head.attributes, this.pageStyle(head.style, "content").attributes)
	}

	// The master footers a page an op made on `master` shows with `settings`, as a read page with them shows them,
	// pushed onto its shapes with ids from `nextId`.
	pushNewPageFooters(shapes: ShapeNode[], master: SlideRef | undefined, settings: OdpHeaderFooter, nextId: () => number): void {
		let info: MasterInfo | undefined

		for (const each of this.masters.values()) if (each.ref === master) info = each

		if (info === undefined || this.stylesFragment === undefined) return

		const scope: ShapeScope = {
			fragment: this.stylesFragment,
			text: { fields: this.declFields(settings) },
			masterBoxes: new Map(),
			nextId,
			images: new Set(),
			charts: new Set(),
			clips: [],
			unread: 0,
			...(info === undefined ? {} : { masterName: info.name })
		}

		this.pushMasterFooters(shapes, info, settings, scope)
	}

	// A drawing-page style's properties (§17.25), its chain resolved.
	pageStyle(name: string | undefined, scope: "content" | "styles", context: OdpContext = this.context): OdfProperties {
		return name === undefined ? NO_PROPERTIES : context.resolver.resolve("drawing-page", name, scope).properties("drawing-page")
	}

	private async translateChart(path: string, node: SlideNode, slicing: Slicing | undefined): Promise<void> {
		const target = partKey(`${path}/chart.xml`)

		if (this.documents.has(target)) return

		const entry = this.entries.get(partKey(`${path}/content.xml`))
		let translated: XmlDocument | undefined

		if (entry !== undefined && entry.uncompressedSize <= MAX_OBJECT_BYTES) {
			try {
				const bytes = slicing === undefined ? await this.odf.archive.read(entry) : await this.odf.archive.readSliced(entry, slicing)
				const found = chartOf(parseXml(bytes))
				// The chart reads its own table (§11.1 local-table) as literals: the spreadsheet converter's cell
				// references have no sheet to point at here. What it cannot carry (a trend line, a secondary axis) is
				// left out of the drawing and counted; the object keeps it.
				const result = found === null ? undefined : translateChart(withLocalTable(found.chart), found.styles)

				if (result !== undefined) {
					translated = parseXml(encodeUtf8(result.markup))
					if (result.refusal !== null) this.approximatedCharts++
				}
			} catch (error) {
				if (!(error instanceof XmlError) && !(error instanceof ZipError)) throw error
			}
		}

		if (translated !== undefined) {
			this.documents.set(target, translated)

			return
		}

		// A chart the translation cannot draw shows its replacement picture, as an object would.
		replaceChart(node.shapes, `${path}/chart.xml`, path)
	}

	// A clipped picture's crop as fractions of its size: the picture's pixels at its own resolution (PNG pHYs, JFIF,
	// BMP), else 96 per inch, as LibreOffice sizes a picture that states none.
	private async cropPicture(entry: ShapeScope["clips"][number]): Promise<void> {
		const isPicture = (props: typeof entry.shape.props): boolean =>
			props?.fill !== undefined && props.fill !== "none" && props.fill.kind === "picture"

		if (!isPicture(entry.shape.props)) return

		const size = await this.pictureSizeOf(entry.part)
		const fill = entry.shape.props?.fill

		if (size === undefined || size.width <= 0 || size.height <= 0 || fill === undefined || fill === "none" || fill.kind !== "picture")
			return

		const [top, right, bottom, left] = entry.clip
		const fraction = (value: number, whole: number): number => Math.round(Math.min(1, Math.max(-1, value / whole)) * 100_000)

		entry.shape.props = {
			...entry.shape.props,
			fill: {
				...fill,
				crop: {
					l: fraction(left, size.width),
					t: fraction(top, size.height),
					r: fraction(right, size.width),
					b: fraction(bottom, size.height)
				}
			}
		}
	}

	private async sniffImage(part: string): Promise<void> {
		const key = partKey(part)

		if (this.types.has(key) || (this.contentTypes.typeOf(part) !== undefined && this.contentTypes.typeOf(part) !== "image/x-svm"))
			return

		const entry = this.entries.get(key)

		if (entry === undefined) return

		const type = await this.head(entry, bytes => (bytes.length >= 256 ? sniff(bytes) : "more"), sniff)

		if (type !== undefined) this.types.set(key, type)
	}

	// A picture's own size from its entry's header, read once per part (the header only: the entry is streamed until
	// the header is in). Only PNG, JPEG, GIF and BMP state one.
	private async pictureSizeOf(part: string): Promise<PictureSize | undefined> {
		const key = partKey(part)

		if (this.sizes.has(key)) return this.sizes.get(key)

		const entry = this.entries.get(key)
		const type = this.contentTypes.typeOf(part)
		const size =
			entry === undefined || entry.uncompressedSize > MAX_CLIP_BYTES || (type !== undefined && !SIZED_TYPES.has(type))
				? undefined
				: await this.head(
						entry,
						bytes => pictureHeader(bytes, false),
						bytes => pictureSize(bytes)
					)

		this.sizes.set(key, size)

		return size
	}

	// What `read` makes of an entry's first bytes, streamed chunk by chunk until it has enough ("more" asks for the
	// next); `end` reads what the whole entry gave when it ends first. Undefined when the entry cannot be read.
	private async head<T>(
		entry: ZipEntry,
		read: (bytes: Uint8Array) => T | "more",
		end: (bytes: Uint8Array) => T | undefined
	): Promise<T | undefined> {
		let held: Uint8Array | undefined
		let length = 0

		try {
			for await (const chunk of this.odf.archive.stream(entry)) {
				let bytes = chunk

				// A stream's chunk is its own only until the next is asked for: a header across chunks is copied.
				if (held !== undefined) {
					if (length + chunk.length > held.length) {
						const grown = new Uint8Array(Math.max(length + chunk.length, held.length * 2))

						grown.set(held.subarray(0, length))
						held = grown
					}

					held.set(chunk, length)
					length += chunk.length
					bytes = held.subarray(0, length)
				}

				const result = read(bytes)

				if (result !== "more") return result
				if (held === undefined) {
					held = chunk.slice()
					length = chunk.length
				}
			}
		} catch (error) {
			if (!(error instanceof ZipError)) throw error

			return undefined
		}

		return end(held === undefined ? new Uint8Array(0) : held.subarray(0, length))
	}

	// A page's draw:name, or undefined.
	pageName(ref: SlideRef): string | undefined {
		return this.heads.get(ref)?.name
	}

	// Builds the deck: masters, layouts and notes masters now; pages listed, parsed on demand.
	build(template: boolean, signed: boolean, macros: boolean): Deck {
		const sheet = this.sheet
		const refs = this.refs
		const nodes = new Map<SlideRef, SlideNode>()
		const masters: SlideRef[] = []
		const layouts: SlideRef[] = []
		const stylesFragment = this.stylesFragment

		this.readDecls()

		for (const name of sheet.masterOrder) {
			const page = sheet.masterPages.get(name)

			if (page === undefined) continue
			if (masters.length >= this.budgets.masters) tooLarge("master pages", this.budgets.masters)

			const ref = refs.next()
			let next = 1
			const images = new Set<string>()
			const scope: ShapeScope | undefined =
				stylesFragment === undefined
					? undefined
					: {
							fragment: stylesFragment,
							text: {},
							masterBoxes: new Map(),
							nextId: () => ++next,
							images,
							charts: new Set(),
							clips: [],
							unread: 0,
							masterName: name
						}
			const shapes = scope === undefined ? [] : this.tally.count(ref, () => readShapes(this.context, scope, page.node))
			const boxes = new Map<string, Xfrm>()
			const footers = new Map<string, number>()
			let notesElement = -1

			for (const shape of shapes) {
				const src = shape.src

				if (src?.format !== "odp" || stylesFragment === undefined) continue

				const presentationClass = stylesFragment.attributes(src.node).get("presentation:class")

				if (presentationClass === undefined) continue
				if (shape.xfrm !== undefined && !boxes.has(presentationClass)) boxes.set(presentationClass, shape.xfrm)
				if (["header", "footer", "date-time", "page-number"].includes(presentationClass) && !footers.has(presentationClass))
					footers.set(presentationClass, src.node)
			}

			if (stylesFragment !== undefined) {
				const document = stylesFragment.document

				for (let child = document.firstChildElement(page.node); child >= 0; child = document.nextSiblingElement(child))
					if (stylesFragment.name(child) === "presentation:notes") notesElement = child
			}

			const style = this.pageStyle(page.drawStyle, "styles")
			const background = fillOf(style, sheet.drawResources, this.context.pictureSizes)
			let notesMaster: SlideRef | undefined
			const notesBoxes = new Map<string, Xfrm>()

			if (notesElement >= 0 && stylesFragment !== undefined && scope !== undefined) {
				notesMaster = refs.next()

				let notesNext = 1
				const notesShapes = readShapes(this.context, { ...scope, nextId: () => ++notesNext }, notesElement)

				for (const shape of notesShapes) {
					const src = shape.src
					const presentationClass =
						src?.format === "odp" ? stylesFragment.attributes(src.node).get("presentation:class") : undefined

					if (presentationClass !== undefined && shape.xfrm !== undefined && !notesBoxes.has(presentationClass))
						notesBoxes.set(presentationClass, shape.xfrm)
				}

				nodes.set(notesMaster, {
					ref: notesMaster,
					kind: "notesMaster",
					part: "/styles.xml",
					src: stylesFragment.src(notesElement),
					name,
					showMasterShapes: true,
					hidden: false,
					shapes: notesShapes,
					comments: [],
					revision: 0
				})
			}

			const notesSize =
				notesElement < 0 || stylesFragment === undefined
					? undefined
					: this.pageSize(stylesFragment.attributes(notesElement).get("style:page-layout-name"))

			nodes.set(ref, {
				ref,
				kind: "master",
				part: "/styles.xml",
				...(stylesFragment === undefined ? {} : { src: stylesFragment.src(page.node) }),
				name: page.displayName ?? name,
				...(background === undefined || background === "none" ? {} : { background: { kind: "fill" as const, fill: background } }),
				showMasterShapes: true,
				hidden: false,
				shapes,
				comments: [],
				revision: 0
			})
			masters.push(ref)
			this.unread += scope?.unread ?? 0
			this.masters.set(name, {
				ref,
				name,
				boxes,
				footers,
				notesMaster,
				notesBoxes,
				size: this.pageSize(page.pageLayout),
				notesSize
			})
		}

		// A deck whose styles name no master page (a damaged or minimal package) gets one empty master.
		if (masters.length === 0) {
			const ref = refs.next()

			nodes.set(ref, {
				ref,
				kind: "master",
				part: "/styles.xml",
				synthetic: true,
				name: "",
				showMasterShapes: true,
				hidden: false,
				shapes: [],
				comments: [],
				revision: 0
			})
			masters.push(ref)
			this.masters.set("", {
				ref,
				name: "",
				boxes: new Map(),
				footers: new Map(),
				notesMaster: undefined,
				notesBoxes: new Map(),
				size: undefined,
				notesSize: undefined
			})
		}

		const firstMaster = this.masters.values().next().value
		const slides: SlideRef[] = []
		const hiddenSlides = new Set<SlideRef>()
		const pageLayouts = this.presentationPageLayouts()
		const pageLayoutNames = this.pageLayoutNames()
		// The page layout names the pages use, by master, in first use.
		const usedLayouts = new Map<string, string[]>()

		for (const [index, span] of this.content.pages.entries()) {
			const ref = refs.next()
			const document = span.head
			const element = document.firstChildElement(document.documentElement())
			const namespaces = new Namespaces(document, { lenient: true })
			const fragment = new Fragment(document, namespaces, "content.xml", span.start, "content", this.epoch)
			const attributes = fragment.attributes(element)
			const masterName = attributes.get("draw:master-page-name") ?? ""
			const master = this.masters.get(masterName) ?? firstMaster
			const layoutName = attributes.get("presentation:presentation-page-layout-name") ?? ""
			const key = `${master?.name ?? ""}\u0000${layoutName}`
			let layout = this.layoutOf.get(key)

			if (layout === undefined && master !== undefined) {
				if (this.layoutOf.size >= this.budgets.layouts) tooLarge("layouts", this.budgets.layouts)

				layout = refs.next()
				this.layoutOf.set(key, layout)

				const own = usedLayouts.get(master.name)

				if (own === undefined) usedLayouts.set(master.name, [layoutName])
				else own.push(layoutName)
			}

			const head: PageHead = {
				name: attributes.get("draw:name") ?? `page${String(index + 1)}`,
				style: attributes.get("draw:style-name"),
				master: master?.name ?? "",
				layout: layoutName,
				attributes
			}

			this.spans.set(ref, span)
			this.heads.set(ref, head)
			this.context.pageCount++
			slides.push(ref)

			if (this.pageStyle(head.style, "content").attributes.get("presentation:visibility") === "hidden") hiddenSlides.add(ref)
		}

		// Every master offers every presentation page layout of styles.xml, in its order, as PowerPoint's masters offer
		// their whole layout set (LibreOffice offers all its AutoLayouts on any master), then the ones pages name that
		// styles.xml lacks. The budget is the pages' to spend first: layouts no page uses stop at what it leaves.
		let spare = this.budgets.layouts - this.layoutOf.size

		for (const master of this.masters.values()) {
			const own = usedLayouts.get(master.name) ?? []
			const shownNames = new Map<string, number>()

			for (const layoutName of [...pageLayouts.keys(), ...own.filter(name => !pageLayouts.has(name))]) {
				const key = `${master.name}\u0000${layoutName}`
				let layout = this.layoutOf.get(key)

				if (layout === undefined) {
					if (spare <= 0) continue

					spare--
					layout = refs.next()
					this.layoutOf.set(key, layout)
				}

				layouts.push(layout)

				// Shown by the names the file gives for display: the presentation page layout's (§16.41 style:display-name,
				// else the style:name of one styles.xml defines), else its master page's style:display-name (§16.9). A
				// master's internal style:name and LibreOffice's "AL<n>T<k>" page layout names are never shown: the layout
				// has no name and the page names it by its type, else "Layout N", as PowerPoint shows an unnamed layout. Two
				// layouts of a master that would read the same are numbered.
				const pageLayout = pageLayoutNames.get(layoutName)
				let display =
					pageLayout === undefined ? (sheet.masterPages.get(master.name)?.displayName ?? "") : (pageLayout.display ?? "")
				const seen = shownNames.get(display) ?? 0

				shownNames.set(display, seen + 1)

				if (seen > 0 && display !== "") display = `${display} ${String(seen + 1)}`

				nodes.set(layout, {
					ref: layout,
					kind: "layout",
					part: "/styles.xml",
					synthetic: true,
					...(display === "" ? {} : { name: display }),
					...(layoutName === "" ? {} : { layoutType: layoutName }),
					parent: master.ref,
					showMasterShapes: true,
					hidden: false,
					shapes: this.layoutShapes(pageLayouts.get(layoutName), this.deckSize(master)),
					comments: [],
					revision: 0
				})
			}
		}

		const size = this.deckSize(this.masters.get(this.heads.get(slides[0] ?? (-1 as SlideRef))?.master ?? "") ?? firstMaster)
		const notesInfo = [...this.masters.values()].find(master => master.notesMaster !== undefined)
		const notesMaster = notesInfo?.notesMaster
		// The notes page's own size (its master's notes page layout), else the slide's turned (no notes page layout).
		const notesSize = notesInfo?.notesSize ?? { cx: size.cy, cy: size.cx }
		const settings = this.settings(slides)
		const graphicDefaults = sheet.defaults.get("graphic")
		const defaultLevel = levelStyle(graphicDefaults?.properties.get("paragraph"), graphicDefaults?.properties.get("text"), this.context)

		const deck: Deck = {
			format: "odp",
			variant: template ? "otp" : "odp",
			size,
			notesSize,
			firstSlideNumber: 1,
			slides,
			masters,
			layouts,
			...(notesMaster === undefined ? {} : { notesMaster }),
			nodes,
			hiddenSlides,
			sections: [],
			customShows: settings.customShows,
			show: settings.show,
			defaultTextStyle: listStyleOf([defaultLevel]),
			embeddedFonts: [],
			protection: {},
			gate: signed ? ["signed"] : [],
			authors: [],
			opaque: macros ? [{ part: "/Basic", kind: "other" }] : [],
			revision: 0
		}

		this.deck = deck

		return deck
	}

	// A style:page-layout's fo:page-width and fo:page-height (§17.2) in EMU, when both are written.
	private pageSize(name: string | undefined): { cx: number; cy: number } | undefined {
		const layout = name === undefined ? undefined : this.sheet.pageLayouts.get(name)
		const width = parseLength(layout?.properties.attributes.get("fo:page-width"))
		const height = parseLength(layout?.properties.attributes.get("fo:page-height"))

		return width === undefined || height === undefined
			? undefined
			: { cx: Math.round(width * EMU_PER_PT), cy: Math.round(height * EMU_PER_PT) }
	}

	private deckSize(master: MasterInfo | undefined): { cx: number; cy: number } {
		// LibreOffice's default page: 28 cm × 21 cm.
		return master?.size ?? { cx: Math.round((28 / 2.54) * 72 * EMU_PER_PT), cy: Math.round((21 / 2.54) * 72 * EMU_PER_PT) }
	}

	// style:presentation-page-layout (§16.43): its placeholders' classes and boxes (lengths, or percents of the page).
	// style:presentation-page-layout display names by style:name (§16.41: style:display-name, else style:name; none for
	// LibreOffice's internal "AL<n>T<AutoLayout>" names, which it never shows).
	private pageLayoutNames(): Map<string, { readonly display: string | undefined }> {
		const out = new Map<string, { readonly display: string | undefined }>()
		const fragment = this.stylesFragment

		if (fragment === undefined) return out

		const document = fragment.document

		for (
			let section = document.firstChildElement(document.documentElement());
			section >= 0;
			section = document.nextSiblingElement(section)
		) {
			if (fragment.name(section) !== "office:styles") continue

			for (let layout = document.firstChildElement(section); layout >= 0; layout = document.nextSiblingElement(layout)) {
				if (fragment.name(layout) !== "style:presentation-page-layout") continue

				const attributes = fragment.attributes(layout)
				const name = attributes.get("style:name")

				if (name !== undefined && !out.has(name))
					out.set(name, { display: attributes.get("style:display-name") ?? (/^AL\d+T\d+$/u.test(name) ? undefined : name) })
			}
		}

		return out
	}

	private presentationPageLayouts(): Map<string, { readonly kind: string; readonly box: readonly (string | undefined)[] }[]> {
		const out = new Map<string, { readonly kind: string; readonly box: readonly (string | undefined)[] }[]>()
		const fragment = this.stylesFragment

		if (fragment === undefined) return out

		const document = fragment.document

		for (
			let section = document.firstChildElement(document.documentElement());
			section >= 0;
			section = document.nextSiblingElement(section)
		) {
			if (fragment.name(section) !== "office:styles") continue

			for (let layout = document.firstChildElement(section); layout >= 0; layout = document.nextSiblingElement(layout)) {
				if (fragment.name(layout) !== "style:presentation-page-layout") continue

				const name = fragment.attributes(layout).get("style:name")

				if (name === undefined || out.has(name)) continue

				const placeholders: { kind: string; box: (string | undefined)[] }[] = []

				for (let child = document.firstChildElement(layout); child >= 0; child = document.nextSiblingElement(child)) {
					if (fragment.name(child) !== "presentation:placeholder") continue

					const attributes = fragment.attributes(child)

					placeholders.push({
						kind: attributes.get("presentation:object") ?? "",
						box: [attributes.get("svg:x"), attributes.get("svg:y"), attributes.get("svg:width"), attributes.get("svg:height")]
					})
				}

				out.set(name, placeholders)
			}
		}

		return out
	}

	private layoutShapes(
		placeholders: readonly { readonly kind: string; readonly box: readonly (string | undefined)[] }[] | undefined,
		size: { cx: number; cy: number }
	): ShapeNode[] {
		const out: ShapeNode[] = []
		const counts = new Map<string, number>()

		for (const placeholder of placeholders ?? []) {
			const type = CLASS_TYPES[placeholder.kind]

			if (type === undefined) continue

			const value = (text: string | undefined, whole: number): number => {
				const percent = /^\s*(-?\d+(?:\.\d+)?)%\s*$/u.exec(text ?? "")

				if (percent !== null) return Math.round((Number(percent[1]) / 100) * whole)

				return Math.round((parseLength(text) ?? 0) * EMU_PER_PT)
			}
			const idx = counts.get(type) ?? 0

			counts.set(type, idx + 1)
			out.push({
				id: out.length + 2,
				name: placeholder.kind,
				hidden: false,
				kind: "sp",
				ph: { type, idx },
				xfrm: {
					x: value(placeholder.box[0], size.cx),
					y: value(placeholder.box[1], size.cy),
					cx: value(placeholder.box[2], size.cx),
					cy: value(placeholder.box[3], size.cy),
					rot: 0,
					flipH: false,
					flipV: false
				}
			})
		}

		return out
	}

	// presentation:header-decl, footer-decl and date-time-decl (§10.9.x) of the body.
	private readDecls(): void {
		const document = this.content.skeleton
		const namespaces = new Namespaces(document, { lenient: true })
		const fragment = new Fragment(document, namespaces, "content.xml", -1, "content", this.epoch)
		const walk = (node: number, depth: number): void => {
			if (depth > 4) return

			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				const name = fragment.name(child)
				const match = /^presentation:(header|footer|date-time)-decl$/u.exec(name)

				if (match !== null) {
					const attributes = fragment.attributes(child)
					const declName = attributes.get("presentation:name")
					const kind = match[1] ?? ""

					if (declName === undefined) continue

					let table = this.decls.get(kind)

					if (table === undefined) {
						table = new Map()
						this.decls.set(kind, table)
					}

					table.set(declName, {
						text: document.textContent(child),
						fixed: kind !== "date-time" || attributes.get("presentation:source") !== "current-date"
					})
				} else if (name === "office:body" || name === "office:presentation") {
					walk(child, depth + 1)
				}
			}
		}

		walk(document.documentElement(), 0)
	}

	// presentation:settings (§9.6): the show's range, looping and pauses, and the custom shows (§9.7).
	private settings(slides: readonly SlideRef[]): { show: ShowSettings; customShows: CustomShow[] } {
		const document = this.content.skeleton
		const namespaces = new Namespaces(document, { lenient: true })
		const fragment = new Fragment(document, namespaces, "content.xml", -1, "content", this.epoch)
		const show: ShowSettings = {
			kind: "present",
			loop: false,
			showNarration: false,
			showAnimation: true,
			useTimings: true,
			range: { kind: "all" }
		}
		const customShows: CustomShow[] = []
		const byName = new Map<string, SlideRef>()

		for (const ref of slides) {
			const name = this.heads.get(ref)?.name

			if (name !== undefined && !byName.has(name)) byName.set(name, ref)
		}

		const find = (node: number, depth: number): number => {
			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
				const name = fragment.name(child)

				if (name === "presentation:settings") return child
				if (depth < 3 && (name === "office:body" || name === "office:presentation")) {
					const found = find(child, depth + 1)

					if (found >= 0) return found
				}
			}

			return -1
		}
		const settings = find(document.documentElement(), 0)

		if (settings < 0) return { show, customShows }

		const attributes = fragment.attributes(settings)

		for (let child = document.firstChildElement(settings); child >= 0; child = document.nextSiblingElement(child)) {
			if (fragment.name(child) !== "presentation:show" || customShows.length >= this.budgets.customShows) continue

			const showAttributes = fragment.attributes(child)
			const name = showAttributes.get("presentation:name")

			if (name === undefined) continue

			customShows.push({
				name,
				id: customShows.length,
				slides: (showAttributes.get("presentation:pages") ?? "")
					.split(",")
					.map(page => byName.get(page.trim()))
					.filter(ref => ref !== undefined)
			})
		}

		const custom = attributes.get("presentation:show")
		const start = attributes.get("presentation:start-page")
		const startIndex = start === undefined ? -1 : slides.indexOf(byName.get(start) ?? (-1 as SlideRef))
		const customShow = custom === undefined ? undefined : customShows.find(item => item.name === custom)

		show.loop = attributes.get("presentation:endless") === "true"
		show.useTimings = attributes.get("presentation:force-manual") !== "true"
		show.showAnimation = attributes.get("presentation:animations") !== "disabled"
		if (attributes.get("presentation:full-screen") === "false") show.kind = "browse"
		if (customShow !== undefined) show.range = { kind: "customShow", id: customShow.id }
		else if (startIndex >= 0) show.range = { kind: "range", start: startIndex + 1, end: slides.length }

		const pause = attributes.get("presentation:pause")

		if (show.loop && pause !== undefined) {
			const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/u.exec(pause)

			if (match !== null)
				show.restartMs = Math.round((Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000)
		}

		return { show, customShows }
	}
}

// The sound of a page's transition par (the first child of its timing root that is one), else undefined.
function transitionSoundOf(fragment: Fragment, root: number): Transition["sound"] {
	for (let child = fragment.document.firstChildElement(root); child >= 0; child = fragment.document.nextSiblingElement(child)) {
		if (isPageTransitionPar(fragment, child)) return pageTransitionSound(fragment, child, packagePart)
	}

	return undefined
}

// The transition filter of a page's timing root: the first anim:transitionFilter of the root's first par (§19.391).
function transitionFilter(fragment: Fragment, root: number): ReadonlyMap<string, string> | undefined {
	const document = fragment.document
	const search = (node: number, depth: number): ReadonlyMap<string, string> | undefined => {
		if (depth > 3) return undefined

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const name = fragment.name(child)

			if (name === "anim:transitionFilter") return fragment.attributes(child)
			if (name === "anim:par" && depth === 0) {
				const found = search(child, depth + 1)

				if (found !== undefined) return found
			}
		}

		return undefined
	}

	return search(root, 0)
}

// A chart's own table (§11.1 local-table) as a grid: header rows first, cells by column (repeats expanded).
function localGrid(table: OdfElement): { readonly text: string; readonly value: number | null }[][] {
	const grid: { text: string; value: number | null }[][] = []
	const rowsOf = (container: OdfElement | undefined): void => {
		for (const row of container?.children ?? []) {
			if (row.name !== "table:table-row" || grid.length >= 10_000) continue

			const cells: { text: string; value: number | null }[] = []

			for (const cell of row.children) {
				if (cell.name !== "table:table-cell" && cell.name !== "table:covered-table-cell") continue

				const repeat = Math.min(1000, Math.max(1, Number(cell.attributes.get("table:number-columns-repeated") ?? "1") || 1))
				const raw = cell.attributes.get("office:value")
				const value = raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw)
				const text = cell.children.map(child => (child.name === "text:p" ? elementTextOf(child) : "")).join("\n")

				for (let k = 0; k < repeat && cells.length < 1000; k++) cells.push({ text, value })
			}

			grid.push(cells)
		}
	}

	rowsOf(table.children.find(child => child.name === "table:table-header-rows"))
	rowsOf(table.children.find(child => child.name === "table:table-rows"))

	for (const child of table.children) if (child.name === "table:table-row") rowsOf({ ...table, children: [child] })

	return grid
}

function elementTextOf(element: OdfElement): string {
	return element.text + element.children.map(elementTextOf).join("")
}

// "local-table.$B$2:.$D$2" as cell positions in reading order; undefined for any other reference.
function localCells(address: string | undefined): [number, number][] | undefined {
	const match = /^\s*local-table\.\$?([A-Z]{1,3})\$?(\d+)(?::\s*(?:local-table)?\.\$?([A-Z]{1,3})\$?(\d+))?\s*$/u.exec(address ?? "")

	if (match === null) return undefined

	const column = (letters: string): number => [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1
	const c1 = column(match[1] ?? "A")
	const r1 = Number(match[2]) - 1
	const c2 = match[3] === undefined ? c1 : column(match[3])
	const r2 = match[4] === undefined ? r1 : Number(match[4]) - 1
	const out: [number, number][] = []

	for (let r = Math.min(r1, r2); r <= Math.max(r1, r2) && out.length < 10_000; r++)
		for (let c = Math.min(c1, c2); c <= Math.max(c1, c2) && out.length < 10_000; c++) out.push([r, c])

	return out
}

function named(name: string, attributes: ReadonlyMap<string, string>, children: readonly OdfElement[], text = ""): OdfElement {
	return { name, attributes, children, text }
}

function tableCell(text: string, value: number | null): OdfElement {
	return named(
		"table:table-cell",
		new Map(
			value === null
				? [["office:value-type", "string"]]
				: [
						["office:value-type", "float"],
						["office:value", String(value)]
					]
		),
		[named("text:p", new Map(), [], text)]
	)
}

// The chart with its series, names and categories taken out of its own table whatever their layout (series in rows
// or columns, §19.15 chart:values-cell-range-address), laid out again as the chart converter reads a table without
// references: the categories in the first column, one column per series, the names in a header row.
function withLocalTable(chart: OdfElement): OdfElement {
	const table = chart.children.find(child => child.name === "table:table")
	const plot = chart.children.find(child => child.name === "chart:plot-area")

	if (table === undefined || plot === undefined) return chart

	const grid = localGrid(table)
	const at = ([row, column]: [number, number]): { readonly text: string; readonly value: number | null } | undefined =>
		grid[row]?.[column]
	const series = plot.children.filter(child => child.name === "chart:series")
	const columns = series.map(item => ({
		values: (localCells(item.attributes.get("chart:values-cell-range-address")) ?? []).map(cell => at(cell)?.value ?? null),
		name:
			localCells(item.attributes.get("chart:label-cell-address"))
				?.map(cell => at(cell)?.text ?? "")
				.join(" ") ?? ""
	}))
	const categoryAddress = plot.children
		.find(child => child.name === "chart:axis" && child.attributes.get("chart:dimension") === "x")
		?.children.find(child => child.name === "chart:categories")
		?.attributes.get("table:cell-range-address")
	// Without categories, a series' cells are labelled by the first column (series in columns) or the first row
	// (series in rows) of the table.
	const firstCells = localCells(series[0]?.attributes.get("chart:values-cell-range-address")) ?? []
	const vertical = firstCells.length < 2 || firstCells[0]?.[1] === firstCells[1]?.[1]
	const categories =
		localCells(categoryAddress)?.map(cell => at(cell)?.text ?? "") ??
		firstCells.map(([row, column]) => (vertical ? (at([row, 0])?.text ?? "") : (at([0, column])?.text ?? "")))
	const length = Math.max(categories.length, ...columns.map(column => column.values.length))

	if (columns.length === 0 || length === 0 || columns.every(column => column.values.length === 0)) return chart

	const strip = (element: OdfElement): OdfElement => {
		const attributes = new Map(
			[...element.attributes].filter(([name, value]) => !(LOCAL_REFERENCES.has(name) && /^\s*local-table\./u.test(value)))
		)

		return named(element.name, attributes, element.children.map(strip), element.text)
	}
	const header = named("table:table-header-rows", new Map(), [
		named("table:table-row", new Map(), [tableCell("", null), ...columns.map(column => tableCell(column.name, null))])
	])
	const rows = named(
		"table:table-rows",
		new Map(),
		Array.from({ length }, (_, row) =>
			named("table:table-row", new Map(), [
				tableCell(categories[row] ?? String(row + 1), null),
				...columns.map(column => tableCell("", column.values[row] ?? null))
			])
		)
	)
	const rebuilt = named("table:table", table.attributes, [
		named("table:table-header-columns", new Map(), [named("table:table-column", new Map(), [])]),
		header,
		rows
	])

	return named(
		chart.name,
		chart.attributes,
		chart.children.map(child => (child === table ? rebuilt : strip(child))),
		chart.text
	)
}

const LOCAL_REFERENCES: ReadonlySet<string> = new Set([
	"chart:values-cell-range-address",
	"chart:label-cell-address",
	"table:cell-range-address"
])

function replaceChart(shapes: ShapeNode[], part: string, object: string): void {
	for (const shape of shapes) {
		if (shape.frame?.kind === "chart" && shape.frame.part === part) shape.frame = { kind: "ole", progId: CHART_TYPE, part: object }
		if (shape.children !== undefined) replaceChart(shape.children, part, object)
	}
}

// table:table-template elements of styles.xml (§9.4): role → cell style.
function tableTemplates(fragment: Fragment | undefined): Map<string, TableTemplate> {
	const out = new Map<string, TableTemplate>()

	if (fragment === undefined) return out

	const document = fragment.document

	for (
		let section = document.firstChildElement(document.documentElement());
		section >= 0;
		section = document.nextSiblingElement(section)
	) {
		if (fragment.name(section) !== "office:styles") continue

		for (let template = document.firstChildElement(section); template >= 0; template = document.nextSiblingElement(template)) {
			if (fragment.name(template) !== "table:table-template") continue

			const attributes = fragment.attributes(template)
			const name = attributes.get("table:name") ?? attributes.get("text:style-name") ?? attributes.get("style:name")

			if (name === undefined) continue

			const roles = new Map<string, string>()

			for (let child = document.firstChildElement(template); child >= 0; child = document.nextSiblingElement(child)) {
				const role = fragment.name(child).replace(/^table:/u, "")
				const childAttributes = fragment.attributes(child)
				// LibreOffice names the role's style with text:style-name, ODF 1.3 with table:style-name.
				const style = childAttributes.get("table:style-name") ?? childAttributes.get("text:style-name")

				if (style !== undefined) roles.set(role, style)
			}

			out.set(name, roles)
		}
	}

	return out
}

function odfRefusal(reason: string, message: string): Refused {
	switch (reason) {
		case "encrypted":
			return refused("encrypted", "A password-protected OpenDocument presentation")
		case "tooLarge":
			return refused("tooLarge", message)
		case "compoundFile":
		case "notOdf":
		case "wrongKind":
			return refused("unsupported", message)
		default:
			return refused("malformed", message)
	}
}

// Opens a presentation package from bytes or a range source.
export async function openOdp(source: ByteSource, options: OdpOpenOptions = {}): Promise<OdpOpen> {
	const budgets = options.budgets ?? DEFAULT_PRESENTATION_BUDGETS
	const opened = await OdfPackage.open(source, {
		limits: { ...PRESENTATION_ZIP_LIMITS, maxEntries: budgets.zipEntries },
		kinds: ["presentation"]
	})

	if (!opened.ok) return odfRefusal(opened.reason, opened.message)

	const odf = opened.package

	try {
		const slicing = options.slicing
		const contentEntry = odf.archive.get("content.xml")
		const stylesEntry = odf.archive.get("styles.xml")

		if (contentEntry === undefined) return refused("malformed", "The package has no content.xml")

		for (const entry of [contentEntry, stylesEntry])
			if (entry !== undefined && entry.uncompressedSize > budgets.xmlPartBytes) tooLarge(entry.name, budgets.xmlPartBytes)

		const contentBytes =
			slicing === undefined ? await odf.archive.read(contentEntry) : await odf.archive.readSliced(contentEntry, slicing)
		const stylesDocument =
			stylesEntry === undefined
				? undefined
				: slicing === undefined
					? parseXml(await odf.archive.read(stylesEntry))
					: await parseXmlSliced(await odf.archive.readSliced(stylesEntry, slicing), slicing)
		const prologue = slicing === undefined ? readContentPrologue(contentBytes) : await readContentPrologueSliced(contentBytes, slicing)
		const sheet =
			slicing === undefined
				? new OdfStyleSheet(stylesDocument, prologue)
				: await OdfStyleSheet.build(stylesDocument, prologue, slicing)
		const content = scanPages(contentBytes, budgets.slides, count => tooLarge(`slides (${String(count)})`, budgets.slides))
		const pages = new Map<string, SlideRef>()
		const parts = new OdpParts(
			odf,
			content,
			sheet,
			budgets,
			options,
			pages,
			tableTemplates(
				sheet.stylesDocument === undefined || sheet.stylesNamespaces === undefined
					? undefined
					: new Fragment(sheet.stylesDocument, sheet.stylesNamespaces, "styles.xml", -1, "styles", 0)
			)
		)
		await parts.readFillImageSizes()
		parts.build(odf.facts.template, odf.facts.signed, odf.facts.macros)

		if (options.adopt !== undefined) parts.adopt(options.adopt, options.refsAbove, options.adoptOrder)

		for (const [index, ref] of (options.adoptOrder ?? parts.deck.slides).entries()) {
			const name = parts.pageName(ref) ?? `page${String(index + 1)}`

			if (!pages.has(name)) pages.set(name, ref)
		}

		return { kind: "opened", deck: parts.deck, parts }
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)
		if (error instanceof ZipError) return refused(error.code === "tooLarge" ? "tooLarge" : "malformed", error.message)
		if (error instanceof XmlError || error instanceof ScanError) return refused("malformed", error.message)

		throw error
	}
}

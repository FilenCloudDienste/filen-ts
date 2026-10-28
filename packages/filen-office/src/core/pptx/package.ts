import { CfbError, CfbFile, isCompoundFile } from "../cfb/index"
import { relationshipKind } from "../docx/index"
import { isEncryptedContainer } from "../encryption/index"
import { checkPackage, checkStructure, mediaCandidates, mediaTargets, PRESENTATION_ZIP_LIMITS, type MediaNotice } from "../opc/mediaPolicy"
import {
	OpcError,
	OpcPackage,
	ZipError,
	partKey,
	type ByteSource,
	type ContentTypes,
	type InflateHook,
	type Relationships,
	type Slicing
} from "../opc/index"
import { DeckTally, DEFAULT_PRESENTATION_BUDGETS, type PresentationBudgets } from "../presentation/budget"
import { classifyAction } from "../presentation/actions"
import { addGate, gateReasons } from "../presentation/gate"
import { SlideRefs } from "../presentation/ids"
import {
	PresentationError,
	refused,
	type Action,
	type Deck,
	type DeckVariant,
	type FrameRef,
	type EncryptionInfoSummary,
	type ObjectDefaults,
	type OpaqueRef,
	type Refused,
	type ShapeNode,
	type SlideKind,
	type SlideNode,
	type SlideRef,
	type SourceRef,
	type ThemeRef
} from "../presentation/model"
import { tooDeep, tooLarge } from "../presentation/refusal"
import { readTheme, type PresentationTheme } from "../presentation/theme"
import { decodeUtf8, XmlError, type XmlDocument } from "../xml/index"
import { type ReadContext } from "./read/drawing"
import { readPresentation } from "./read/presentation"
import { readLegacyAuthors, readModernAuthors, readShowSettings, DEFAULT_SHOW } from "./read/props"
import { readCustomShows, readSections } from "./read/sections"
import { legacyOlePreviews } from "./read/legacyOle"
import { readSlidePart, SlidePartError } from "./read/slide"
import { readObjectDefaults } from "./read/objectDefaults"
import { resolvePath, structuralPath, visitSources } from "./sourcePath"
import { G, partReader, STRICT_P, type PartReader } from "./read/xml"

// Opening a PresentationML package (pptx, pptm, potx, potm, ppsx, ppsm; ECMA-376 Part 1 §19, Part 2 OPC): the
// refusals and view-only gates first, then the presentation, masters, layouts, themes and notes master into the
// shared model. Slides (and their notes) are parsed on demand through PptxParts, so a deck of thousands of slides
// opens in the time its masters take. Encrypted packages are refused as "encrypted" here: the realm that holds the
// password (dom/encryption) decrypts them and opens the decrypted bytes with `encrypted` set.

export interface PptxOpenOptions {
	readonly slicing?: Slicing
	readonly inflate?: InflateHook
	readonly budgets?: PresentationBudgets
	// The decrypted package of an encrypted file: its scheme, carried into deck.protection.
	readonly encrypted?: EncryptionInfoSummary
	// The base source's generation (SourceRef.epoch): 0 at open, +1 per save rebase.
	readonly epoch?: number
}

export type PptxOpen = { readonly kind: "opened"; readonly deck: Deck; readonly parts: PptxParts } | Refused

const PRESENTATION_TYPES: ReadonlyMap<string, DeckVariant> = new Map([
	["application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", "pptx"],
	["application/vnd.ms-powerpoint.presentation.macroenabled.main+xml", "pptm"],
	["application/vnd.openxmlformats-officedocument.presentationml.template.main+xml", "potx"],
	["application/vnd.ms-powerpoint.template.macroenabled.main+xml", "potm"],
	["application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml", "ppsx"],
	["application/vnd.ms-powerpoint.slideshow.macroenabled.main+xml", "ppsm"]
])

const MACRO_VARIANTS: Readonly<Record<string, DeckVariant>> = { pptx: "pptm", potx: "potm", ppsx: "ppsm" }

const STRICT_RELATIONSHIPS = "http://purl.oclc.org/ooxml/officeDocument/relationships/"
const SIGNATURE_ORIGIN = "http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin"
const SIGNATURE = "http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/signature"
const MODERN_AUTHORS = "http://schemas.microsoft.com/office/2018/10/relationships/authors"

// The root element's start tag (after the XML declaration, comments and processing instructions), decoded alone,
// when it is a p:sld; "" otherwise.
function rootTag(head: Uint8Array): string {
	for (let at = 0; at < head.length; at++) {
		if (head[at] !== 0x3c) continue

		const next = head[at + 1]

		if (next === 0x3f || next === 0x21) continue

		const end = head.indexOf(0x3e, at)
		const tag = decodeUtf8(head, at, end < 0 ? head.length : end)

		return /^<(?:[A-Za-z_][\w.-]*:)?sld[\s/>]/u.test(`${tag}>`) ? tag : ""
	}

	return ""
}

// How much of a slide part the hidden-flag peek reads: its root start tag, namespace declarations and all.
const HEAD_BYTES = 64 * 1024

// The streams at the root of the binary formats a .pptx name may hide.
const LEGACY_STREAMS = ["PowerPoint Document", "WordDocument", "Workbook", "Book"]

async function compoundRefusal(source: ByteSource): Promise<Refused> {
	let cfb: CfbFile

	try {
		cfb = await CfbFile.open(source)
	} catch (error) {
		if (error instanceof CfbError) return refused("malformed", "An OLE2 compound file this reader cannot open")

		throw error
	}

	if (isEncryptedContainer(cfb)) return refused("encrypted", "A password-protected or rights-managed package")
	if (LEGACY_STREAMS.some(name => cfb.entry([name])?.kind === "stream")) {
		return refused("unsupported", "A legacy binary Office file, not a PresentationML package")
	}

	return refused("unsupported", "An OLE2 compound file, not a PresentationML package")
}

function zipRefusal(error: ZipError): Refused {
	switch (error.code) {
		case "tooManyEntries":
		case "tooLarge":
			return refused("tooLarge", error.message)
		case "encrypted":
			return refused("unsupportedEncryption", error.message)
		case "unsupported":
			return refused("unsupported", error.message)
		default:
			return refused("malformed", error.message)
	}
}

// Opens a presentation package from bytes or a range source.
export async function openPptx(source: ByteSource, options: PptxOpenOptions = {}): Promise<PptxOpen> {
	if (source.size >= 8 && isCompoundFile(await source.read(0, 8))) return compoundRefusal(source)

	let opc: OpcPackage

	try {
		opc = await OpcPackage.open(source, {
			limits: { ...PRESENTATION_ZIP_LIMITS, maxEntries: (options.budgets ?? DEFAULT_PRESENTATION_BUDGETS).zipEntries },
			...(options.inflate === undefined ? {} : { inflate: options.inflate })
		})
	} catch (error) {
		if (error instanceof ZipError) return zipRefusal(error)
		if (error instanceof OpcError) return refused("malformed", error.message)

		throw error
	}

	return openPptxPackage(opc, options)
}

// Opens a presentation package already at hand (OpcPackage.open or OpcPackage.fromParts: a deck converted from
// another format).
export async function openPptxPackage(opc: OpcPackage, options: PptxOpenOptions = {}): Promise<PptxOpen> {
	try {
		return await openParts(opc, options)
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)
		if (error instanceof ZipError) return zipRefusal(error)
		if (error instanceof OpcError || error instanceof XmlError || error instanceof SlidePartError) {
			return refused("malformed", error.message)
		}

		throw error
	}
}

// The deepest element nesting of a parsed part, refused past the budget (readers recurse only over shape groups,
// bounded on their own; this bounds every later walk of the part).
function checkDepth(document: XmlDocument, limit: number): void {
	const { count, parents } = document
	const depths = new Uint16Array(count)

	for (let node = 1; node < count; node++) {
		const depth = (depths[parents[node] ?? 0] ?? 0) + 1

		if (depth > limit) tooDeep("XML element nesting", limit)

		depths[node] = depth
	}
}

async function signatureCount(opc: OpcPackage, packageRelationships: Relationships): Promise<number> {
	let count = 0

	for (const origin of packageRelationships.byType(SIGNATURE_ORIGIN)) {
		if (origin.external || origin.partName === undefined || !opc.has(origin.partName)) continue

		const relationships = await opc.relationships(origin.partName)

		count += relationships.all.filter(relationship => relationship.type === SIGNATURE && !relationship.external).length
	}

	return count
}

function relatedParts(relationships: Relationships, kind: string): string[] {
	const out: string[] = []

	for (const relationship of relationships.all) {
		if (!relationship.external && relationship.partName !== undefined && relationshipKind(relationship.type) === kind) {
			out.push(`/${relationship.partName}`)
		}
	}

	return out
}

async function openParts(opc: OpcPackage, options: PptxOpenOptions): Promise<PptxOpen> {
	const budgets = options.budgets ?? DEFAULT_PRESENTATION_BUDGETS
	const entries = [...opc.entries()]
	// The content types and every relationships part, by declared size, before any of them is inflated.
	const structure = checkStructure(entries, budgets.xmlPartBytes)

	if (structure !== undefined) return policyRefusal(structure)

	const [contentTypes, packageRelationships] = await Promise.all([opc.contentTypes(), opc.relationships("")])
	const main = packageRelationships.all.find(
		relationship => !relationship.external && relationshipKind(relationship.type) === "officeDocument"
	)

	if (main?.partName === undefined || !opc.has(main.partName)) return refused("malformed", "The package has no main part")

	const mainPart = opc.entry(main.partName)?.name ?? main.partName
	const mainType = contentTypes.typeOf(mainPart)?.toLowerCase()
	let variant = mainType === undefined ? undefined : PRESENTATION_TYPES.get(mainType)

	if (variant === undefined) {
		if (mainType !== undefined && !mainType.includes("presentationml") && !mainType.includes("powerpoint")) {
			return refused("unsupported", `The main part is ${mainType}, not a presentation`)
		}

		variant = "pptx"
	}

	// Package limits and media classes from the central directory, before any other part is read.
	const notices: MediaNotice[] = []
	let media: ReadonlySet<string> = new Set()
	{
		let targets: ReadonlySet<string> = new Set()
		const candidates = mediaCandidates(entries, contentTypes)

		if (candidates.size > 0) {
			// What holds whichever candidates the relationships make media, checked before they are read.
			const provisional = checkPackage(entries, contentTypes, candidates)

			if (provisional.kind === "tooLarge") return policyRefusal(provisional)

			const relationships: Relationships[] = []

			for (const entry of entries) {
				if (!entry.name.toLowerCase().endsWith(".rels")) continue

				const source = relsSource(entry.name)

				if (source !== undefined) relationships.push(await opc.relationships(source))
			}

			targets = mediaTargets(relationships)
		}

		const policy = checkPackage(entries, contentTypes, targets)

		if (policy.kind === "tooLarge") return policyRefusal(policy)

		media = policy.media
		notices.push(...policy.notices)
	}

	const parts = new PptxParts(opc, contentTypes, budgets, options, media, notices)

	return parts.open(`/${mainPart}`, variant, main.type.startsWith(STRICT_RELATIONSHIPS), await signatureCount(opc, packageRelationships))
}

function policyRefusal(policy: { readonly part: string; readonly class: string; readonly size: number; readonly limit: number }): Refused {
	return refused("tooLarge", `${policy.part} (${policy.class}) declares ${String(policy.size)} bytes, over ${String(policy.limit)}`)
}

// The source part of a .rels part ("ppt/slides/_rels/slide1.xml.rels" → "ppt/slides/slide1.xml", "_rels/.rels" → "").
function relsSource(name: string): string | undefined {
	const match = /^(.*?)_rels\/([^/]*)\.rels$/iu.exec(name)

	if (match === null) return undefined

	return `${match[1] ?? ""}${match[2] ?? ""}`
}

// A slide or notes part a save added, bound to its node (prepareRebase).
export interface RebasedPart {
	readonly ref: SlideRef
	readonly kind: "slide" | "notes"
	readonly part: string
	readonly document: XmlDocument | undefined
	// The charts the part relates, by relationship id (a duplicated slide's own copies of its source's charts).
	readonly charts?: ReadonlyMap<string, ChartFrameRef>
}

type ChartFrameRef = Extract<FrameRef, { kind: "chart" }>

export interface RebasePlan {
	// p:sldId/@id by slide part key, as the saved presentation lists them.
	readonly slideIds: ReadonlyMap<string, number>
	readonly added: readonly RebasedPart[]
}

interface Listed {
	readonly ref: SlideRef
	readonly kind: SlideKind
	readonly part: string
	// p:sldId/@id of slides, master/layout ids where written.
	readonly id?: number
}

// A deck's parts: the parsed documents, the themes, and the lazy parse of slides and their notes. Core functions
// on the deck are synchronous and need the nodes they touch present: callers `await parts.slide(ref)` first.
export class PptxParts {
	get opc(): OpcPackage {
		return this.package
	}

	get contentTypes(): ContentTypes {
		return this.types
	}

	get epoch(): number {
		return this.generation
	}

	readonly budgets: PresentationBudgets
	readonly tally: DeckTally
	private package: OpcPackage
	private types: ContentTypes
	private generation: number
	// Part keys of the entries classed media (core/opc/mediaPolicy.ts).
	readonly media: ReadonlySet<string>
	readonly notices: MediaNotice[]
	// Slides hidden in the show, known at open from each slide's root tag (before the slides are parsed).
	readonly hiddenAtOpen = new Set<SlideRef>()
	// cNvPr ids written twice on some slide and reassigned on read (sourceId keeps the written one).
	reassignedIds = 0
	deck!: Deck
	private readonly options: PptxOpenOptions
	private readonly refs = new SlideRefs()
	private readonly byPart = new Map<string, Listed>()
	private readonly documents = new Map<string, XmlDocument>()
	private readonly themes = new Map<string, PresentationTheme>()
	// a:objectDefaults of each theme read (shared by every ThemeRef to it).
	private readonly objectDefaults = new Map<string, ObjectDefaults | undefined>()
	private readonly pending = new Map<SlideRef, Promise<SlideNode>>()
	// The main part ("/ppt/presentation.xml").
	private mainPart = ""

	constructor(
		opc: OpcPackage,
		contentTypes: ContentTypes,
		budgets: PresentationBudgets,
		options: PptxOpenOptions,
		media: ReadonlySet<string>,
		notices: MediaNotice[]
	) {
		this.package = opc
		this.types = contentTypes
		this.budgets = budgets
		this.tally = new DeckTally(budgets)
		this.generation = options.epoch ?? 0
		this.options = options
		this.media = media
		this.notices = notices
	}

	// A document the session holds under a name of its own ("raw:N": source markup an inverse held, read back after a
	// rebase made the old refs stale), so document(name) resolves such a src like a part's. rebase() keeps it.
	adopt(name: string, document: XmlDocument): void {
		this.documents.set(partKey(name), document)
	}

	// A theme the session made (a design op's gallery theme), held under its part name like one read from the
	// package; holding the name again replaces it.
	adoptTheme(name: string, document: XmlDocument): void {
		const key = partKey(name)

		this.documents.set(key, document)
		this.themes.set(key, readTheme(name, document))
		this.objectDefaults.delete(key)
	}

	forget(name: string): void {
		this.documents.delete(partKey(name))
	}

	// What a rebase needs of the saved package, read before anything moves (so the rebase itself is one synchronous
	// step): its slide list (part → p:sldId/@id) and the slide and notes parts the save added, each bound to the node
	// the model named it for and parsed.
	async prepareRebase(opc: OpcPackage): Promise<RebasePlan> {
		const slideIds = new Map<string, number>()
		const added: RebasedPart[] = []
		const document = await opc.xml(this.mainPart)
		const reader = partReader(document)
		const relationships = await opc.relationships(this.mainPart.slice(1))

		for (const entry of reader.children(reader.child(document.documentElement(), G.P, "sldIdLst"), G.P, "sldId")) {
			const rId = reader.rel(entry, "id")
			const target = rId === undefined ? undefined : relationships.byId(rId)
			const id = reader.int(entry, "id")

			if (target?.partName !== undefined && !target.external && id !== undefined) slideIds.set(partKey(`/${target.partName}`), id)
		}

		const listed = new Set(this.deck.slides)
		// One node per part: a part two nodes name goes to the one the deck lists (a slide in deck.slides, its notes).
		const chosen = new Map<string, SlideNode>()

		for (const node of this.unindexed(opc)) {
			const key = partKey(node.part)
			const held = chosen.get(key)

			if (node.kind === "slide" && !slideIds.has(key)) continue
			if (held === undefined || (!this.inDeck(held.ref, listed) && this.inDeck(node.ref, listed))) chosen.set(key, node)
		}

		for (const node of chosen.values()) {
			if ((opc.entry(node.part)?.uncompressedSize ?? 0) > this.budgets.xmlPartBytes)
				tooLarge(`XML part ${node.part}`, this.budgets.xmlPartBytes)

			const parsed = await opc.xml(node.part)

			checkDepth(parsed, this.budgets.elementDepth)
			const charts = await relatedCharts(opc, node.part)

			added.push({
				ref: node.ref,
				kind: node.kind as "slide" | "notes",
				part: node.part,
				document: parsed,
				...(charts === undefined ? {} : { charts })
			})
		}

		return { slideIds, added }
	}

	// Slide and notes nodes whose part the index does not know and `opc` has (new in a save).
	private unindexed(opc: OpcPackage): SlideNode[] {
		const out: SlideNode[] = []

		for (const node of this.deck.nodes.values()) {
			if ((node.kind === "slide" || node.kind === "notes") && !this.byPart.has(partKey(node.part)) && opc.has(node.part))
				out.push(node)
		}

		return out
	}

	private inDeck(ref: SlideRef, listed: ReadonlySet<SlideRef>): boolean {
		if (listed.has(ref)) return true

		for (const slide of listed) if (this.deck.nodes.get(slide)?.notes === ref) return true

		return false
	}

	// A save's rebase (dom/presentation/save.ts): the package reads from the saved file from now on, `epoch` the new
	// base generation. `documents` replaces the parsed documents of the parts the save rewrote or removed (undefined:
	// dropped, read again on demand); every other parsed document holds the same bytes, so the model's node indices
	// into it stand. Slides parsed from now on carry the new epoch. The part index follows the saved package: the slide
	// and notes parts the save removed are dropped, the ones it added are bound to their nodes (whose refs into the
	// markup they were written from move into the saved part), and slide ids are the saved list's (`plan`, from
	// prepareRebase; without one the added parts are found by name and keep no id).
	rebase(
		opc: OpcPackage,
		contentTypes: ContentTypes,
		epoch: number,
		documents: ReadonlyMap<string, XmlDocument | undefined>,
		plan?: RebasePlan
	): void {
		const fresh = new Map<string, XmlDocument | undefined>()

		for (const [part, document] of documents) fresh.set(partKey(part), document)

		const added: readonly RebasedPart[] =
			plan?.added ??
			this.unindexed(opc).map(node => ({ ref: node.ref, kind: node.kind as "slide" | "notes", part: node.part, document: undefined }))

		// Refs into the markup an added part was written from (its source slide's, or held markup) move into the part,
		// while the documents they index are still held.
		for (const part of added) {
			const node = this.deck.nodes.get(part.ref)
			const own = node?.src?.format === "pptx" ? node.src.part : undefined

			if (node === undefined || own === undefined || part.document === undefined) continue

			const to = part.document
			const from = (src: SourceRef): XmlDocument | undefined =>
				(src.epoch === epoch ? fresh.get(partKey(src.part)) : undefined) ?? this.documents.get(partKey(src.part))
			const memo = new Map<number, number | undefined>()

			visitSources(node, src => {
				if (src.format !== "pptx" || partKey(src.part) !== partKey(own)) return src

				if (!memo.has(src.node)) {
					const document = from(src)

					memo.set(src.node, document === undefined ? undefined : resolvePath(to, structuralPath(document, src.node)))
				}

				const mapped = memo.get(src.node)

				return mapped === undefined ? src : { format: "pptx", part: part.part, node: mapped, epoch }
			})

			// A copy's chart frames still name its source's chart parts: they name the copies the save wrote for it.
			if (part.charts !== undefined) ownCharts(node.shapes, part.part, to, part.charts)
		}

		this.package = opc
		this.types = contentTypes
		this.generation = epoch

		for (const [key, document] of fresh) {
			if (document === undefined) this.documents.delete(key)
			else this.documents.set(key, document)
		}

		for (const [key, listed] of this.byPart) {
			if ((listed.kind !== "slide" && listed.kind !== "notes") || opc.has(listed.part)) continue

			this.byPart.delete(key)
			this.slideParts.delete(listed.ref)
			this.slideIds.delete(listed.ref)
		}

		for (const part of added) {
			const key = partKey(part.part)

			if (this.byPart.has(key)) continue

			const id = part.kind === "slide" ? plan?.slideIds.get(key) : undefined

			this.byPart.set(key, { ref: part.ref, kind: part.kind, part: part.part, ...(id === undefined ? {} : { id }) })
			this.slideParts.set(part.ref, part.part)
			if (id !== undefined) this.slideIds.set(part.ref, id)
			if (part.document !== undefined) this.documents.set(key, part.document)
		}

		for (const [key, id] of plan?.slideIds ?? []) {
			const listed = this.byPart.get(key)

			if (listed?.kind !== "slide" || listed.id === id) continue

			this.byPart.set(key, { ...listed, id })
			this.slideIds.set(listed.ref, id)
		}
	}

	// The parsed document of a part read so far (presentation, masters, layouts, themes, parsed slides), or undefined.
	document(part: string): XmlDocument | undefined {
		return this.documents.get(partKey(part))
	}

	theme(part: string): PresentationTheme | undefined {
		return this.themes.get(partKey(part))
	}

	// The node a part is, by part name ("/ppt/slides/slide3.xml").
	refOf(part: string): SlideRef | undefined {
		return this.byPart.get(partKey(part))?.ref
	}

	// p:sldId/@id of a slide.
	slideId(ref: SlideRef): number | undefined {
		const node = this.deck.nodes.get(ref)
		const listed = node === undefined ? undefined : this.byPart.get(partKey(node.part))

		return listed?.id ?? this.slideIds.get(ref)
	}

	private readonly slideIds = new Map<SlideRef, number>()
	private readonly slideParts = new Map<SlideRef, string>()

	// The part of a listed node, parsed or not.
	partOf(ref: SlideRef): string | undefined {
		return this.slideParts.get(ref) ?? this.deck.nodes.get(ref)?.part
	}

	private async xml(part: string, slicing?: Slicing): Promise<XmlDocument> {
		const key = partKey(part)
		const held = this.documents.get(key)

		if (held !== undefined) return held

		const entry = this.opc.entry(part)

		if (entry === undefined) throw new OpcError("missingPart", `No part ${part}`)
		if (entry.uncompressedSize > this.budgets.xmlPartBytes) tooLarge(`XML part ${part}`, this.budgets.xmlPartBytes)

		const document = await this.opc.xml(part, slicing ?? this.options.slicing)

		checkDepth(document, this.budgets.elementDepth)
		this.documents.set(key, document)

		return document
	}

	// PowerPoint 2007-style OLE objects keep their preview in the part's legacy VML drawing: spid → the preview part.
	// Undefined without a VML drawing; an unreadable one gives no previews (the objects draw without one).
	private async legacyPreviews(relationships: Relationships): Promise<((spid: string) => string | undefined) | undefined> {
		const vml = relatedParts(relationships, "vmlDrawing")[0]

		if (vml === undefined || !this.opc.has(vml)) return undefined

		let previews: Map<string, string>
		let vmlRelationships: Relationships

		try {
			previews = legacyOlePreviews(await this.xml(vml))
			vmlRelationships = await this.opc.relationships(vml.slice(1))
		} catch (error) {
			if (error instanceof PresentationError) throw error

			return undefined
		}

		return spid => {
			const relId = previews.get(spid)
			const relationship = relId === undefined ? undefined : vmlRelationships.byId(relId)

			return relationship === undefined || relationship.external || relationship.partName === undefined
				? undefined
				: `/${relationship.partName}`
		}
	}

	private context(part: string, reader: PartReader, relationships: Relationships): ReadContext {
		return {
			reader,
			part,
			epoch: this.epoch,
			relationships,
			tally: this.tally,
			action: node => this.action(reader, relationships, node)
		}
	}

	action(reader: PartReader, relationships: Relationships, node: number): Action | undefined {
		const id = reader.rel(node, "id")
		const target = id === undefined || id === "" ? undefined : relationships.byId(id)
		const action = reader.attr(node, "action")

		return classifyAction(
			{
				...(action === undefined ? {} : { action }),
				...(target === undefined
					? {}
					: {
							target: {
								external: target.external,
								target: target.target,
								...(target.partName === undefined ? {} : { partName: `/${target.partName}` })
							}
						})
			},
			{
				slideOf: part => {
					const listed = this.byPart.get(partKey(part))

					return listed?.kind === "slide" ? listed.ref : undefined
				}
			}
		)
	}

	private list(kind: SlideKind, part: string, id?: number): SlideRef {
		const key = partKey(part)
		const held = this.byPart.get(key)

		if (held !== undefined) return held.ref

		const ref = this.refs.next()

		this.byPart.set(key, { ref, kind, part, ...(id === undefined ? {} : { id }) })
		this.slideParts.set(ref, part)
		if (id !== undefined && kind === "slide") this.slideIds.set(ref, id)

		return ref
	}

	private async loadTheme(part: string): Promise<ThemeRef | undefined> {
		if (!this.opc.has(part)) return undefined

		const key = partKey(part)

		if (!this.themes.has(key)) {
			const document = await this.xml(part)
			const theme = readTheme(part, document)

			if (theme.malformed) addGate(this.deck.gate, "malformed")

			this.themes.set(key, theme)

			const relationships = await this.opc.relationships(part.slice(1))

			this.objectDefaults.set(key, readObjectDefaults(this.context(part, partReader(document), relationships), document))
		}

		const objectDefaults = this.objectDefaults.get(key)

		return { part, revision: 0, ...(objectDefaults === undefined ? {} : { objectDefaults }) }
	}

	private async parse(ref: SlideRef, kind: SlideKind, part: string, slicing?: Slicing): Promise<SlideNode> {
		const document = await this.xml(part, slicing)
		const relationships = await this.opc.relationships(part.slice(1))
		const themeParts = relatedParts(relationships, "theme")
		const themeRef = themeParts[0] === undefined ? undefined : await this.loadTheme(themeParts[0])
		const legacyPreview = await this.legacyPreviews(relationships)
		const read = this.tally.count(ref, () =>
			readSlidePart({
				ref,
				part,
				document,
				relationships,
				epoch: this.epoch,
				tally: this.tally,
				media: {
					contentType: name => this.contentTypes.typeOf(name.slice(1)),
					size: name => this.opc.entry(name)?.uncompressedSize
				},
				refOf: name => this.refOf(name),
				themeOf: name => (themeRef !== undefined && partKey(name) === partKey(themeRef.part) ? themeRef : undefined),
				action: (reader, rels, node) => this.action(reader, rels, node),
				...(legacyPreview === undefined ? {} : { legacyPreview })
			})
		)

		if (read.node.kind !== kind) {
			this.tally.release(ref)

			throw new SlidePartError(`${part} is a ${read.node.kind}, listed as a ${kind}`)
		}

		if (read.malformed) addGate(this.deck.gate, "malformed")

		this.reassignedIds += read.reassignedIds
		const unlinked: ShapeNode[] = []

		try {
			await this.linkFrames(read.node.shapes, relationships, unlinked)
		} catch (error) {
			// A read that does not land gives back what it counted.
			this.tally.release(ref)

			throw error
		}

		this.pairDrawings(unlinked, relationships)
		this.deck.nodes.set(ref, read.node)

		if (read.notesPart !== undefined && this.opc.has(read.notesPart)) {
			const notes = this.list("notes", read.notesPart)

			read.node.notes = notes
			this.deck.nodes.set(notes, await this.parse(notes, "notes", read.notesPart, slicing))
		}

		return read.node
	}

	// What a frame's own parts link to: a SmartArt diagram's cached drawing (dsp:dataModelExt/@relId in its data part
	// names the slide's relationship, MS-ODRAWXML §2.3.1), a chart's embedded workbook (the chart part's package or
	// oleObject relationship).
	private async linkFrames(shapes: ShapeNode[], relationships: Relationships, unlinked: ShapeNode[]): Promise<void> {
		for (const shape of shapes) {
			if (shape.children !== undefined) await this.linkFrames(shape.children, relationships, unlinked)

			const frame = shape.frame

			if (frame?.kind === "smartart" && frame.drawing === undefined && this.opc.has(frame.data)) {
				const data = await this.xml(frame.data)
				const reader = partReader(data)
				let relId: string | undefined

				for (let node = 0; node < data.count && relId === undefined; node++) {
					if (reader.is(node, G.Dsp, "dataModelExt")) relId = reader.attr(node, "relId")
				}

				const target = relId === undefined ? undefined : relationships.byId(relId)

				this.documents.delete(partKey(frame.data))

				if (target?.partName !== undefined && !target.external && this.opc.has(target.partName)) {
					shape.frame = { ...frame, drawing: `/${target.partName}` }
				} else {
					unlinked.push(shape)
				}
			} else if (frame?.kind === "chart" && frame.workbook === undefined && this.opc.has(frame.part)) {
				const chartRels = await this.opc.relationships(frame.part.slice(1))
				const embedded = chartRels.all.find(
					relationship =>
						!relationship.external &&
						relationship.partName !== undefined &&
						(relationshipKind(relationship.type) === "package" || relationshipKind(relationship.type) === "oleObject")
				)

				if (embedded?.partName !== undefined && this.opc.has(embedded.partName)) {
					const kind = relationshipKind(embedded.type) === "package" ? "xlsx" : "xls"

					shape.frame = { ...frame, workbook: { part: `/${embedded.partName}`, kind } }
				}
			}
		}
	}

	// Diagrams whose data part names no drawing (writers that leave dsp:dataModelExt out): when the slide has exactly
	// as many drawing relationships left as such diagrams, they pair in document order, as PowerPoint writes them.
	private pairDrawings(unlinked: readonly ShapeNode[], relationships: Relationships): void {
		if (unlinked.length === 0) return

		const used = new Set<string>()

		for (const node of this.deck.nodes.values()) {
			for (const shape of node.shapes)
				if (shape.frame?.kind === "smartart" && shape.frame.drawing !== undefined) used.add(partKey(shape.frame.drawing))
		}

		const drawings = relatedParts(relationships, "diagramDrawing").filter(part => !used.has(partKey(part)) && this.opc.has(part))

		if (drawings.length !== unlinked.length) return

		unlinked.forEach((shape, index) => {
			const drawing = drawings[index]

			if (shape.frame?.kind === "smartart" && drawing !== undefined) shape.frame = { ...shape.frame, drawing }
		})
	}

	// A slide (or any listed node) parsed into deck.nodes, with its notes; once per node.
	slide(ref: SlideRef, slicing?: Slicing): Promise<SlideNode> {
		const held = this.deck.nodes.get(ref)

		if (held !== undefined) return Promise.resolve(held)

		let pending = this.pending.get(ref)

		if (pending === undefined) {
			const part = this.slideParts.get(ref)
			const listed = part === undefined ? undefined : this.byPart.get(partKey(part))

			if (listed === undefined) return Promise.reject(new PresentationError("notFound", `No node ${String(ref)}`))

			pending = this.parse(ref, listed.kind, listed.part, slicing)
				.catch((error: unknown) => {
					// A slide that cannot be read is refused on its own; the rest of the deck stays open.
					if (
						error instanceof XmlError ||
						error instanceof OpcError ||
						error instanceof ZipError ||
						error instanceof SlidePartError
					) {
						throw new PresentationError("malformed", error.message)
					}

					throw error
				})
				.finally(() => this.pending.delete(ref))
			this.pending.set(ref, pending)
		}

		return pending
	}

	// Every slide parsed (tests, conversions, find over the whole deck).
	async parseAll(slicing?: Slicing): Promise<void> {
		for (const ref of this.deck.slides) await this.slide(ref, slicing)
	}

	// Drops a parsed slide and its notes (memory in long sessions); a later slide() parses them again.
	release(ref: SlideRef): void {
		const node = this.deck.nodes.get(ref)

		if (node?.kind !== "slide") return

		this.documents.delete(partKey(node.part))
		this.deck.nodes.delete(ref)
		this.tally.release(ref)

		if (node.notes !== undefined) {
			const notes = this.deck.nodes.get(node.notes)

			if (notes !== undefined) this.documents.delete(partKey(notes.part))

			this.deck.nodes.delete(node.notes)
			this.tally.release(node.notes)
		}
	}

	// Whether a slide part's root start tag says show="0", read from its first bytes only.
	private async peekHidden(part: string): Promise<boolean> {
		const entry = this.opc.entry(part)

		if (entry === undefined) return false

		let head: Uint8Array | undefined
		const memory = !this.hasArchive()

		if (memory) {
			head = (await this.opc.read(part)).subarray(0, HEAD_BYTES)
		} else {
			for await (const chunk of this.opc.zip.stream(entry)) {
				head = chunk.subarray(0, HEAD_BYTES)

				break
			}
		}

		if (head === undefined) return false

		const tag = rootTag(head)
		const show = /\sshow\s*=\s*["']([^"']*)["']/u.exec(tag)?.[1]?.trim().toLowerCase()

		return show === "0" || show === "false" || show === "off"
	}

	private hasArchive(): boolean {
		try {
			return this.opc.zip !== undefined
		} catch {
			return false
		}
	}

	async open(mainPart: string, variant: DeckVariant, strict: boolean, signatures: number): Promise<PptxOpen> {
		this.mainPart = mainPart

		const document = await this.xml(mainPart)
		const reader = partReader(document)
		const root = document.documentElement()

		if (!reader.is(root, G.P, "presentation")) return refused("malformed", `${mainPart} is not a p:presentation`)

		const relationships = await this.opc.relationships(mainPart.slice(1))
		const context = this.context(mainPart, reader, relationships)
		const read = readPresentation(context)
		const macros = relatedParts(relationships, "vbaProject")
		const opaque: OpaqueRef[] = macros.map(part => ({ part, kind: "vbaProject" }))

		for (const part of relatedParts(relationships, "tags")) opaque.push({ part, kind: "tags" })

		const deck: Deck = {
			format: "pptx",
			variant: macros.length > 0 ? (MACRO_VARIANTS[variant] ?? variant) : variant,
			size: read.size,
			notesSize: read.notesSize,
			firstSlideNumber: read.firstSlideNumber,
			slides: [],
			masters: [],
			layouts: [],
			nodes: new Map(),
			sections: [],
			customShows: [],
			show: { ...DEFAULT_SHOW },
			defaultTextStyle: read.defaultTextStyle,
			embeddedFonts: read.embeddedFonts,
			protection: {
				...(read.modifyVerifier === undefined ? {} : { modifyVerifier: read.modifyVerifier }),
				...(this.options.encrypted === undefined ? {} : { encrypted: this.options.encrypted })
			},
			gate: gateReasons({
				signatures,
				strict: strict || reader.namespaces.elementUri(root) === STRICT_P,
				modifyVerifier: read.modifyVerifier !== undefined,
				malformed: reader.malformed
			}),
			authors: [],
			opaque,
			revision: 0
		}

		this.deck = deck

		// Masters, their layouts (in each master's sldLayoutIdLst order) and themes: parsed now, they are what every
		// slide inherits from and what "change layout" lists.
		for (const master of read.masters) {
			if (!this.opc.has(master.part)) continue

			const ref = this.list("master", master.part, master.id)

			deck.masters.push(ref)

			await this.parse(ref, "master", master.part)
			const masterDocument = await this.xml(master.part)
			const masterReader = partReader(masterDocument)
			const masterRelationships = await this.opc.relationships(master.part.slice(1))
			const layoutList = masterReader.child(masterDocument.documentElement(), G.P, "sldLayoutIdLst")

			for (const entry of masterReader.children(layoutList, G.P, "sldLayoutId")) {
				const id = masterReader.rel(entry, "id")
				const target = id === undefined ? undefined : masterRelationships.byId(id)

				if (target === undefined || target.external || target.partName === undefined || !this.opc.has(target.partName)) continue

				const part = `/${target.partName}`

				if (this.byPart.has(partKey(part))) continue
				if (deck.layouts.length >= this.budgets.layouts) tooLarge("slide layouts", this.budgets.layouts)

				const layout = this.list("layout", part, masterReader.int(entry, "id"))

				deck.layouts.push(layout)
				await this.parse(layout, "layout", part)
			}
		}

		if (read.notesMaster !== undefined && this.opc.has(read.notesMaster)) {
			deck.notesMaster = this.list("notesMaster", read.notesMaster)
			await this.parse(deck.notesMaster, "notesMaster", read.notesMaster)
		}

		if (read.handoutMaster !== undefined && this.opc.has(read.handoutMaster)) {
			deck.handoutMaster = this.list("handoutMaster", read.handoutMaster)
			await this.parse(deck.handoutMaster, "handoutMaster", read.handoutMaster)
		}

		const bySlideId = new Map<number, SlideRef>()

		for (const slide of read.slides) {
			if (!this.opc.has(slide.part)) continue

			const ref = this.list("slide", slide.part, slide.id)

			deck.slides.push(ref)
			bySlideId.set(slide.id, ref)
		}

		// A slide whose layout is not in any master's list (a damaged deck): its layout is listed and parsed on its
		// own, so inheritance still finds it.
		for (const ref of deck.slides) {
			const part = this.slideParts.get(ref) ?? ""
			const slideRels = await this.opc.relationships(part.slice(1))

			for (const layoutPart of relatedParts(slideRels, "slideLayout")) {
				if (this.byPart.has(partKey(layoutPart)) || !this.opc.has(layoutPart)) continue

				const layout = this.list("layout", layoutPart)

				deck.layouts.push(layout)
				await this.parse(layout, "layout", layoutPart)
			}

			if (await this.peekHidden(part)) this.hiddenAtOpen.add(ref)
		}

		deck.sections = readSections(context, root, bySlideId)
		deck.customShows = readCustomShows(context, reader.child(root, G.P, "custShowLst"), id => {
			const target = relationships.byId(id)

			return target?.partName === undefined ? undefined : this.refOf(`/${target.partName}`)
		})

		for (const part of relatedParts(relationships, "presProps")) {
			if (!this.opc.has(part)) continue

			const props = await this.xml(part)
			const propsReader = partReader(props)

			deck.show = readShowSettings(
				this.context(part, propsReader, await this.opc.relationships(part.slice(1))),
				props.documentElement()
			)
			if (propsReader.malformed) addGate(deck.gate, "malformed")
		}

		for (const part of relatedParts(relationships, "commentAuthors")) {
			if (!this.opc.has(part)) continue

			const authors = await this.xml(part)

			deck.authors.push(...readLegacyAuthors(this.context(part, partReader(authors), relationships), authors.documentElement()))
		}

		for (const relationship of relationships.byType(MODERN_AUTHORS)) {
			if (relationship.external || relationship.partName === undefined || !this.opc.has(relationship.partName)) continue

			const part = `/${relationship.partName}`
			const authors = await this.xml(part)

			deck.authors.push(...readModernAuthors(this.context(part, partReader(authors), relationships), authors.documentElement()))
		}

		if (this.hiddenAtOpen.size > 0) deck.hiddenSlides = this.hiddenAtOpen

		return { kind: "opened", deck, parts: this }
	}
}

// The chart parts `part` relates (pptx chart and chartEx), each with its embedded workbook, by relationship id.
async function relatedCharts(opc: OpcPackage, part: string): Promise<ReadonlyMap<string, ChartFrameRef> | undefined> {
	let charts: Map<string, ChartFrameRef> | undefined

	for (const relationship of (await opc.relationships(part.slice(1))).all) {
		const kind = relationshipKind(relationship.type)

		if ((kind !== "chart" && kind !== "chartEx") || relationship.external || relationship.partName === undefined) continue
		if (!opc.has(relationship.partName)) continue

		const embedded = (await opc.relationships(relationship.partName)).all.find(
			each =>
				!each.external &&
				each.partName !== undefined &&
				(relationshipKind(each.type) === "package" || relationshipKind(each.type) === "oleObject")
		)
		const workbook =
			embedded?.partName === undefined || !opc.has(embedded.partName)
				? undefined
				: {
						part: `/${embedded.partName}`,
						kind: relationshipKind(embedded.type) === "package" ? ("xlsx" as const) : ("xls" as const)
					}

		charts ??= new Map()
		charts.set(relationship.id, { kind: "chart", part: `/${relationship.partName}`, ...(workbook === undefined ? {} : { workbook }) })
	}

	return charts
}

// The chart frames read from `part` (their refs moved into it) named again by the relationship their c:chart (or
// cx:chart) names there. A frame naming a version the session holds is the chart family's.
function ownCharts(shapes: readonly ShapeNode[], part: string, document: XmlDocument, charts: ReadonlyMap<string, ChartFrameRef>): void {
	const r = partReader(document)

	for (const shape of shapes) {
		if (shape.children !== undefined) ownCharts(shape.children, part, document, charts)

		const frame = shape.frame
		const src = shape.src

		if (frame?.kind !== "chart" || !frame.part.startsWith("/") || src?.format !== "pptx" || partKey(src.part) !== partKey(part))
			continue

		const data = r.child(r.child(src.node, G.A, "graphic"), G.A, "graphicData")
		const chart = r.child(data, G.C, "chart") >= 0 ? r.child(data, G.C, "chart") : r.child(data, G.Cx, "chart")
		const id = chart < 0 ? undefined : r.rel(chart, "id")
		const own = id === undefined ? undefined : charts.get(id)

		if (own !== undefined && partKey(own.part) !== partKey(frame.part)) shape.frame = own
	}
}

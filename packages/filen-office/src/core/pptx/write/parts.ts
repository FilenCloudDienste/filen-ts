import { relationshipKind } from "../../docx/index"
import {
	CONTENT_TYPES_PART,
	ContentTypes,
	editContentTypes,
	joinBytes,
	partKey,
	relationshipsPartName,
	relativeTarget,
	type OpcPackage,
	type PartBytes,
	type PartChange,
	type Relationship,
	type ZipChanges
} from "../../opc/index"
import { formerName, issuedNames, noteFormerName, noteIssuedNames } from "../../presentation/issuedNames"
import { PresentationError } from "../../presentation/model"
import { noteRestoredMedia } from "../../presentation/restoredMedia"
import { XmlEditor, decodeUtf8, encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../xml/index"
import type { PartsApi, PptxPartKind } from "./types"

// The package as a save edits it: names for new parts, relationships with their ids, content types, and the
// referential integrity of slide copies and removals (ECMA-376 Part 2 §8–§9: every relationship target exists,
// nothing is left unreferenced by a removal). Part names here are zip item names (no leading "/"), as core/opc
// keeps them; the model's names carry a leading "/". Everything is collected in memory and turned into one set of
// zip changes at the end, so an error midway leaves nothing half written.

export const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
const MS_RELATIONSHIPS_2007 = "http://schemas.microsoft.com/office/2007/relationships/"
const MS_RELATIONSHIPS_2011 = "http://schemas.microsoft.com/office/2011/relationships/"
const PML = "application/vnd.openxmlformats-officedocument.presentationml."
const DML = "application/vnd.openxmlformats-officedocument.drawingml."
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const RELS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"

export const RELATIONSHIP_TYPES: { readonly [K in PptxPartKind]: string } = {
	slide: `${RELATIONSHIPS}slide`,
	notesSlide: `${RELATIONSHIPS}notesSlide`,
	slideLayout: `${RELATIONSHIPS}slideLayout`,
	slideMaster: `${RELATIONSHIPS}slideMaster`,
	theme: `${RELATIONSHIPS}theme`,
	image: `${RELATIONSHIPS}image`,
	media: `${MS_RELATIONSHIPS_2007}media`,
	chart: `${RELATIONSHIPS}chart`,
	chartStyle: `${MS_RELATIONSHIPS_2011}chartStyle`,
	chartColors: `${MS_RELATIONSHIPS_2011}chartColorStyle`,
	embeddedWorkbook: `${RELATIONSHIPS}package`,
	oleObject: `${RELATIONSHIPS}oleObject`,
	diagramData: `${RELATIONSHIPS}diagramData`,
	diagramLayout: `${RELATIONSHIPS}diagramLayout`,
	diagramStyle: `${RELATIONSHIPS}diagramQuickStyle`,
	diagramColors: `${RELATIONSHIPS}diagramColors`,
	diagramDrawing: `${MS_RELATIONSHIPS_2007}diagramDrawing`,
	comments: `${RELATIONSHIPS}comments`,
	commentAuthors: `${RELATIONSHIPS}commentAuthors`,
	font: `${RELATIONSHIPS}font`,
	other: `${RELATIONSHIPS}customData`
}

export const PART_CONTENT_TYPES = {
	slide: `${PML}slide+xml`,
	notesSlide: `${PML}notesSlide+xml`,
	slideLayout: `${PML}slideLayout+xml`,
	slideMaster: `${PML}slideMaster+xml`,
	notesMaster: `${PML}notesMaster+xml`,
	handoutMaster: `${PML}handoutMaster+xml`,
	presentation: `${PML}presentation.main+xml`,
	presProps: `${PML}presProps+xml`,
	viewProps: `${PML}viewProps+xml`,
	tableStyles: `${PML}tableStyles+xml`,
	theme: "application/vnd.openxmlformats-officedocument.theme+xml",
	chart: `${DML}chart+xml`,
	comments: `${PML}comments+xml`,
	commentAuthors: `${PML}commentAuthors+xml`,
	coreProperties: "application/vnd.openxmlformats-package.core-properties+xml",
	extendedProperties: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
	relationships: "application/vnd.openxmlformats-package.relationships+xml",
	xml: "application/xml"
} as const

// Where each kind of new part goes and what it is called (PowerPoint's own layout: ppt/slides/slideN.xml…).
const NAME_TEMPLATES: { readonly [K in PptxPartKind]: readonly [string, string, string] } = {
	slide: ["ppt/slides/", "slide", ".xml"],
	notesSlide: ["ppt/notesSlides/", "notesSlide", ".xml"],
	slideLayout: ["ppt/slideLayouts/", "slideLayout", ".xml"],
	slideMaster: ["ppt/slideMasters/", "slideMaster", ".xml"],
	theme: ["ppt/theme/", "theme", ".xml"],
	image: ["ppt/media/", "image", ""],
	media: ["ppt/media/", "media", ""],
	chart: ["ppt/charts/", "chart", ".xml"],
	chartStyle: ["ppt/charts/", "style", ".xml"],
	chartColors: ["ppt/charts/", "colors", ".xml"],
	embeddedWorkbook: ["ppt/embeddings/", "Microsoft_Excel_Worksheet", ".xlsx"],
	oleObject: ["ppt/embeddings/", "Microsoft_Excel_97-2003_Worksheet", ".xls"],
	diagramData: ["ppt/diagrams/", "data", ".xml"],
	diagramLayout: ["ppt/diagrams/", "layout", ".xml"],
	diagramStyle: ["ppt/diagrams/", "quickStyle", ".xml"],
	diagramColors: ["ppt/diagrams/", "colors", ".xml"],
	diagramDrawing: ["ppt/diagrams/", "drawing", ".xml"],
	comments: ["ppt/comments/", "comment", ".xml"],
	commentAuthors: ["ppt/", "commentAuthors", ".xml"],
	font: ["ppt/fonts/", "font", ".fntdata"],
	other: ["ppt/", "part", ".bin"]
}

const EXTENSIONS: ReadonlyMap<string, string> = new Map([
	["image/png", ".png"],
	["image/jpeg", ".jpeg"],
	["image/gif", ".gif"],
	["image/bmp", ".bmp"],
	["image/tiff", ".tiff"],
	["image/svg+xml", ".svg"],
	["image/x-emf", ".emf"],
	["image/x-wmf", ".wmf"],
	["image/webp", ".webp"],
	["video/mp4", ".mp4"],
	["video/quicktime", ".mov"],
	["video/webm", ".webm"],
	["video/x-ms-wmv", ".wmv"],
	["video/x-msvideo", ".avi"],
	["audio/mpeg", ".mp3"],
	["audio/mp4", ".m4a"],
	["audio/x-wav", ".wav"],
	["audio/wav", ".wav"],
	["audio/ogg", ".ogg"]
])

// Relationship kinds whose targets a duplicated slide gets its own copy of (the targets belong to one slide: a notes
// slide points back at it, comments and charts are edited per slide); everything else is shared (layouts, images,
// media, fonts, hyperlinks).
const COPIED_KINDS: ReadonlySet<string> = new Set([
	"notesSlide",
	"comments",
	"chart",
	"chartUserShapes",
	"package",
	"chartStyle",
	"chartColorStyle",
	"themeOverride",
	"diagramData",
	"diagramLayout",
	"diagramQuickStyle",
	"diagramColors",
	"diagramDrawing",
	"vmlDrawing"
])

const MODERN_COMMENTS = "http://schemas.microsoft.com/office/2018/10/relationships/comments"

export function copiedKind(type: string): boolean {
	return type === MODERN_COMMENTS || COPIED_KINDS.has(relationshipKind(type) ?? "")
}

export interface PendingRelationship {
	readonly id: string
	readonly type: string
	// Target part name (zip item name), or the URL of an external target.
	readonly target: string
	readonly external: boolean
}

// One part's relationships as edited: the base ones (removed or retargeted) and new ones.
class RelationshipsEdit {
	readonly source: string
	readonly base: readonly Relationship[]
	readonly removed = new Set<string>()
	readonly retargeted = new Map<string, string>()
	readonly added: PendingRelationship[] = []
	private highest = 0
	private readonly taken = new Set<string>()

	constructor(source: string, base: readonly Relationship[], retired: Iterable<string> = []) {
		this.source = source
		this.base = base

		for (const relationship of base) this.claim(relationship.id)
		for (const id of retired) this.claim(id)
	}

	private claim(id: string): void {
		this.taken.add(id)

		const numbered = /^rId(\d+)$/u.exec(id)

		if (numbered !== null) this.highest = Math.max(this.highest, Number(numbered[1]))
	}

	get changed(): boolean {
		return this.removed.size > 0 || this.retargeted.size > 0 || this.added.length > 0
	}

	// Live relationships: base ones not removed (retargets applied), then the added ones.
	all(): PendingRelationship[] {
		const out: PendingRelationship[] = []

		for (const relationship of this.base) {
			if (this.removed.has(relationship.id)) continue

			const target = this.retargeted.get(relationship.id) ?? (relationship.external ? relationship.target : relationship.partName)

			if (target === undefined) continue

			out.push({ id: relationship.id, type: relationship.type, target, external: relationship.external })
		}

		return [...out, ...this.added]
	}

	byId(id: string): PendingRelationship | undefined {
		return this.all().find(relationship => relationship.id === id)
	}

	add(type: string, target: string, external: boolean, id?: string): string {
		let next = id

		if (next === undefined || this.taken.has(next)) {
			next = `rId${String(++this.highest)}`

			while (this.taken.has(next)) next = `rId${String(++this.highest)}`
		}

		this.claim(next)
		this.added.push({ id: next, type, target, external })

		return next
	}

	// A relationship under an id of its own that no live relationship has (a retired one an undo's markup names).
	restore(type: string, target: string, id: string, external = false): void {
		this.claim(id)
		this.added.push({ id, type, target, external })
	}

	remove(id: string): void {
		const index = this.added.findIndex(relationship => relationship.id === id)

		if (index >= 0) this.added.splice(index, 1)
		else this.removed.add(id)
	}

	retarget(id: string, target: string): void {
		const index = this.added.findIndex(relationship => relationship.id === id)
		const added = this.added[index]

		if (added !== undefined) this.added[index] = { ...added, target }
		else this.retargeted.set(id, target)
	}

	// The .rels part: the base one spliced (removed relationships dropped, retargets in place, additions appended),
	// or a new one.
	serialize(baseBytes: Uint8Array | undefined): Uint8Array {
		const line = (relationship: PendingRelationship): string => {
			const target = relationship.external ? relationship.target : relativeTarget(this.source, relationship.target)

			return `<Relationship Id="${escapeAttribute(relationship.id)}" Type="${escapeAttribute(relationship.type)}" Target="${escapeAttribute(target)}"${relationship.external ? ' TargetMode="External"' : ""}/>`
		}

		if (baseBytes === undefined) {
			return encodeUtf8(`${XML_DECLARATION}<Relationships xmlns="${RELS_NAMESPACE}">${this.added.map(line).join("")}</Relationships>`)
		}

		const document = parseXml(baseBytes)
		const editor = new XmlEditor(document)
		const root = document.documentElement()
		const prefix = document.prefix(root)

		for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
			const id = document.attribute(node, "Id")

			if (id === undefined) continue
			if (this.removed.has(id)) {
				editor.remove(node)

				continue
			}

			const target = this.retargeted.get(id)

			if (target !== undefined) editor.setAttribute(node, "Target", relativeTarget(this.source, target))
		}

		const lines = this.added.map(line).join("")

		if (lines !== "") editor.append(root, prefix === "" ? lines : lines.replaceAll("<Relationship ", `<${prefix}:Relationship `))

		return editor.serialize()
	}
}

interface AddedPart {
	readonly name: string
	readonly contentType: string
	bytes: PartBytes | undefined
	// Media and images are stored, never deflated again.
	readonly compress: boolean
	readonly crc32?: number
}

export interface SaveNotice {
	readonly kind: "jumpRetargeted"
	// The part whose action pointed at a removed slide.
	readonly part: string
}

// The editable package: one per save. Base parts are read through `opc`; every document a writer edits is loaded
// first (loadDocument), so the PartsApi calls the emit families make stay synchronous.
// A relationship of the emitted part under a given id (one its parts' markup names already): true when the part has it
// (made now, or there already with that target and type), false when the id holds another.
export interface RelatingWithId {
	// replaceable: whether the part the id relates now may be let go of for it (nothing else of the part names it).
	relateWithId(target: string, type: string, id: string, replaceable?: (part: string) => boolean): boolean
	// A part the emitted markup stops naming: it goes with the save when nothing relates it once every part is written
	// (and no step the history holds names it).
	letGo(part: string): void
	// The part `part` is a copy of (a duplicated slide's own copy, made by this save); undefined for any other part.
	copiedFrom(part: string): string | undefined
	// The ids of the emitted part's relationships of `type` that this save's emits did not make.
	relationshipIds(type: string): readonly string[]
	// The type of the emitted part's relationship `id`; undefined when it has none by that id.
	relationshipType(id: string): string | undefined
}

// What the session's history names, for the deck's next save (dom/presentation/prune.ts prunePlan.hold; undefined: not
// known, so nothing an emit lets go of is left out), and the parts that save's emits let go of (for the session to
// leave out once nothing names them): by deck.
const deckHeld = new WeakMap<object, readonly string[] | undefined>()
const deckReleased = new WeakMap<object, readonly string[]>()

export function holdDeckParts(deck: object, parts: readonly string[] | undefined): void {
	deckHeld.set(deck, parts)
}

export function heldDeckParts(deck: object): readonly string[] | undefined {
	return deckHeld.has(deck) ? deckHeld.get(deck) : []
}

function zipNameOf(part: string): string {
	return part.startsWith("/") ? part.slice(1) : part
}

// Every part name a package of the deck's session has had (core/presentation/issuedNames.ts, shared with ODP): a part a
// save adds never takes one, so nothing a step the history holds still names (a slide an undo restores relates the
// parts it had) is handed to another part.
export { issuedNames as issuedPartNames } from "../../presentation/issuedNames"

// Media a save let go of (a picture, a medium or an embedded object of the source deleted): what each owner related,
// by its relationship id, with the part's bytes when the part left the package, while a step the history holds names
// the part (an undo puts the shape back: the save writing it relates them again, the part re-added). By deck, then
// owner part key.
// A pasted element's relationships (carryRelationship) are held the same way, under the ids its markup names.
interface ReleasedMedia {
	readonly type: string
	// The part (a zip name), or an external target's URL.
	readonly name: string
	readonly contentType: string | undefined
	readonly bytes: Uint8Array | undefined
	readonly external?: true
}

const releasedMedia = new WeakMap<object, Map<string, Map<string, ReleasedMedia>>>()
// Relationship ids released media had, by deck and owner part key: never given to another relationship (an undo's
// markup names them).
const retiredIds = new WeakMap<object, Map<string, Set<string>>>()

// The relationship kinds of media a slide's markup names (pictures, video, audio, embedded objects).
const MEDIA_KINDS: ReadonlySet<string> = new Set(["image", "video", "audio", "media", "oleObject", "package", "hdphoto"])

export function hasReleasedMedia(deck: object): boolean {
	return (releasedMedia.get(deck)?.size ?? 0) > 0
}

// What `owner` (a part name) related by relationship `id` before a save let it go, while an undo may name it again.
export function releasedMediaRelationship(
	deck: object,
	owner: string,
	id: string
): { readonly type: string; readonly name: string; readonly external: boolean } | undefined {
	const media = releasedMedia.get(deck)?.get(partKey(owner))?.get(id)

	return media === undefined ? undefined : { type: media.type, name: media.name, external: media.external === true }
}

// The bytes of a part a save let go of, held for an undo (by part name).
export function releasedMediaBytes(deck: object, part: string): { readonly bytes: Uint8Array; readonly contentType: string } | undefined {
	const key = partKey(part)

	for (const byId of releasedMedia.get(deck)?.values() ?? [])
		for (const media of byId.values())
			if (media.external !== true && partKey(media.name) === key && media.bytes !== undefined && media.contentType !== undefined)
				return { bytes: media.bytes, contentType: media.contentType }

	return undefined
}

// A relationship a pasted element's markup names under `id` that `owner` (a slide part) does not have: held as
// released media are, so the render resolves it and the save writing the slide relates it under that id (the part
// added from `bytes` when the package has none by its name). The id is never handed to another relationship.
export function carryRelationship(
	deck: object,
	owner: string,
	id: string,
	relationship: {
		readonly type: string
		readonly target: string
		readonly external?: boolean
		readonly contentType?: string
		readonly bytes?: Uint8Array
	}
): void {
	const key = partKey(owner)
	let owners = releasedMedia.get(deck)

	if (owners === undefined) {
		owners = new Map()
		releasedMedia.set(deck, owners)
	}

	let retired = retiredIds.get(deck)

	if (retired === undefined) {
		retired = new Map()
		retiredIds.set(deck, retired)
	}

	const byId = owners.get(key) ?? new Map<string, ReleasedMedia>()

	owners.set(key, byId)
	byId.set(id, {
		type: relationship.type,
		name: relationship.target,
		contentType: relationship.contentType,
		bytes: relationship.bytes,
		...(relationship.external === true ? { external: true as const } : {})
	})
	retired.set(key, (retired.get(key) ?? new Set()).add(id))
}

// The released and carried relationships `owner` holds, by id.
export function heldRelationships(
	deck: object,
	owner: string
): ReadonlyMap<string, { readonly type: string; readonly name: string; readonly external: boolean }> {
	const out = new Map<string, { readonly type: string; readonly name: string; readonly external: boolean }>()

	for (const [id, media] of releasedMedia.get(deck)?.get(partKey(owner)) ?? [])
		out.set(id, { type: media.type, name: media.name, external: media.external === true })

	return out
}

// The relationship ids `owner` holds for released or carried relationships, and ids retired there: not free for
// another relationship.
export function heldRelationshipIds(deck: object, owner: string): ReadonlySet<string> {
	return retiredIds.get(deck)?.get(partKey(owner)) ?? new Set()
}

// Lets go of released media no step the history holds names: `named` (owner part key → relationship ids the held
// markup of its shapes names).
export function keepReleasedMedia(deck: object, named: ReadonlyMap<string, ReadonlySet<string>>): void {
	const owners = releasedMedia.get(deck)

	if (owners === undefined) return

	for (const [owner, byId] of owners) {
		const ids = named.get(owner)

		for (const id of byId.keys()) if (ids?.has(id) !== true) byId.delete(id)

		if (byId.size === 0) owners.delete(owner)
	}
}

export function noteDeckReleased(deck: object, parts: readonly string[]): void {
	deckReleased.set(deck, parts)
}

export function releasedDeckParts(deck: object): readonly string[] {
	return deckReleased.get(deck) ?? []
}

export class PackageWriter {
	readonly opc: OpcPackage
	readonly contentTypes: ContentTypes
	readonly notices: SaveNotice[] = []
	// Targets of copied relationships that the base package already lacked.
	readonly inheritedMissing = new Set<string>()
	// Held parts an undone slide brought back, added under their own names: a chart version whose home this is may
	// replace it (its bytes are only the held state).
	readonly restored = new Set<string>()
	private readonly documents = new Map<string, XmlDocument>()
	private readonly editors = new Map<string, XmlEditor>()
	private readonly replaced = new Map<string, PartBytes>()
	private readonly relationshipEdits = new Map<string, RelationshipsEdit>()
	private readonly added = new Map<string, AddedPart>()
	// Relationships this save's emits made (api: addPart, relate, relateWithId), as "<owner key>|<id>".
	private readonly emitted = new Set<string>()
	// Parts this save added as copies of another (copyPart): the source's model name, by the copy's key.
	private readonly copies = new Map<string, string>()
	// Targets of relationships an emit dropped (unrelate), removed with their orphans when nothing relates them.
	private readonly unrelated: string[] = []
	// Parts added under an addPart `shared` key in this save.
	private readonly sharedParts = new WeakMap<object, string>()
	private readonly removed = new Set<string>()
	private readonly overrides = new Map<string, string>()
	// Every name taken: base parts (removed ones too: a removed name is never reused in the same save) and new ones.
	private readonly taken = new Set<string>()
	// Names no new part is allocated (issue()), and the deck whose session issued them.
	private issued: ReadonlySet<string> = new Set()
	private deck: object | undefined
	private allRelationships: Map<string, readonly Relationship[]> | undefined
	// Relationship ids each new part's markup came with (seed()).
	readonly seeded = new Map<string, readonly string[]>()
	// Edits made on a part's final bytes, after everything else (a jump to a removed slide in a part also spliced).
	private readonly patches = new Map<string, { name: string; patch: (document: XmlDocument, editor: XmlEditor) => void }[]>()

	constructor(opc: OpcPackage, contentTypes: ContentTypes) {
		this.opc = opc
		this.contentTypes = contentTypes

		for (const entry of opc.entries()) this.taken.add(partKey(entry.name))
	}

	// The names the deck's session has issued (issuedPartNames), this package's among them from now on: allocate never
	// gives them out (a name the model chose is still claimed as it is).
	issue(deck: object): void {
		noteIssuedNames(
			deck,
			Array.from(this.opc.entries(), entry => entry.name)
		)
		this.issued = issuedNames(deck)
		this.deck = deck
	}

	// A name for the logical part `key` names (its owner and role): the one a save of the deck's session gave it, when
	// the package written has no part by it (a redo writing it again), else a new one (allocate), its own from now on.
	allocateOwn(key: string, kind: PptxPartKind | undefined, contentType: string, like?: string): string {
		const deck = this.deck
		const own = deck === undefined ? undefined : formerName(deck, key)
		const name = own !== undefined && this.claim(own) ? own : this.allocate(kind, contentType, like)

		if (deck !== undefined) noteFormerName(deck, key, name)

		return name
	}

	// The part exists after the edits so far.
	exists(name: string): boolean {
		const key = partKey(name)

		return this.added.has(key) || (this.opc.has(name) && !this.removed.has(key))
	}

	isAdded(name: string): boolean {
		return this.added.has(partKey(name))
	}

	// Replaced in place by this save (its relationships kept).
	isReplaced(name: string): boolean {
		return this.replaced.has(partKey(name))
	}

	isRemoved(name: string): boolean {
		return this.removed.has(partKey(name))
	}

	typeOf(name: string): string | undefined {
		const key = partKey(name)

		return this.added.get(key)?.contentType ?? this.overrides.get(key) ?? this.contentTypes.typeOf(name)
	}

	// A free name for a new part of `kind` (slideN with the next free N…), or after `like` ("ppt/charts/chart3.xml"
	// gives the next free "ppt/charts/chartN.xml").
	allocate(kind: PptxPartKind | undefined, contentType: string, like?: string): string {
		let directory: string
		let base: string
		let extension: string

		if (like !== undefined) {
			const slash = like.lastIndexOf("/")
			const file = like.slice(slash + 1)
			const dot = file.lastIndexOf(".")
			const stem = dot > 0 ? file.slice(0, dot) : file

			directory = like.slice(0, slash + 1)
			base = withoutTrailingDigits(stem)
			extension = dot > 0 ? file.slice(dot) : ""
		} else {
			const template = NAME_TEMPLATES[kind ?? "other"]

			directory = template[0]
			base = template[1]
			extension = template[2] === "" ? (EXTENSIONS.get(contentType.toLowerCase()) ?? ".bin") : template[2]
		}

		for (let n = 1; ; n++) {
			const name = `${directory}${base}${String(n)}${extension}`

			if (!this.taken.has(partKey(name)) && !this.issued.has(partKey(name))) {
				this.taken.add(partKey(name))

				return name
			}
		}
	}

	// Claims `name` for a new part when it is free (a name the model already chose); false when taken.
	claim(name: string): boolean {
		const key = partKey(name)

		if (this.taken.has(key)) return false

		this.taken.add(key)

		return true
	}

	async loadDocument(name: string): Promise<XmlDocument> {
		const key = partKey(name)
		const held = this.documents.get(key)

		if (held !== undefined) return held

		const added = this.added.get(key)
		const document = added !== undefined ? parseXml(await this.bytesOf(added)) : await this.opc.xml(name)

		this.documents.set(key, document)

		return document
	}

	document(name: string): XmlDocument | undefined {
		return this.documents.get(partKey(name))
	}

	// The one editor of a loaded part.
	editor(name: string): XmlEditor {
		const key = partKey(name)
		let editor = this.editors.get(key)

		if (editor === undefined) {
			const document = this.documents.get(key)

			if (document === undefined) throw new PresentationError("failed", `The part ${name} was not loaded before its edit`)

			editor = new XmlEditor(document)
			this.editors.set(key, editor)
		}

		return editor
	}

	hasEditor(name: string): boolean {
		return this.editors.has(partKey(name))
	}

	// Replaces a base part's bytes whole (a part rebuilt rather than spliced).
	replace(name: string, bytes: PartBytes): void {
		const key = partKey(name)
		const added = this.added.get(key)

		if (added !== undefined) added.bytes = bytes
		else this.replaced.set(key, bytes)
	}

	// Of `candidates` (part keys), those a part this save writes names (the save's own output, whatever the session
	// predicted): by a relationship id its markup names, or, from a slide, the drawing relationship its diagram data
	// names (dsp:dataModelExt@relId); with what those relate in turn.
	// A copy's relationships to charts this save copied for it that its written markup names by no id: the copy's
	// frame was written into a chart part of its own (a chart the session holds), so the copied chart goes, with what
	// only it related, unless something else relates it. (Notes and comments are related by type, never named.)
	async dropUnnamedCopies(name: string): Promise<void> {
		const key = partKey(name)
		const added = this.added.get(key)
		const edit = this.relationshipEdits.get(key)

		if (added === undefined || edit === undefined) return

		const text = decodeUtf8(await this.bytesOf(added))

		for (const relationship of edit.all()) {
			if (relationship.external || relationshipKind(relationship.type) !== "chart" || !this.copies.has(partKey(relationship.target)))
				continue
			if (text.includes(`"${relationship.id}"`) || text.includes(`'${relationship.id}'`)) continue

			edit.remove(relationship.id)
			this.unrelated.push(relationship.target)
		}
	}

	async namedByWritten(candidates: ReadonlySet<string>): Promise<Set<string>> {
		const named = new Set<string>()

		if (candidates.size === 0) return named

		const texts = new Map<string, string>()
		const textOf = async (key: string): Promise<string> => {
			let text = texts.get(key)

			if (text === undefined) {
				const added = this.added.get(key)
				const replaced = this.replaced.get(key)
				const editor = this.editors.get(key)
				const entry = this.opc.entry(key)
				const bytes =
					added !== undefined
						? await this.bytesOf(added)
						: replaced !== undefined
							? await joinBytes(replaced)
							: editor?.changed === true
								? editor.serialize()
								: entry === undefined
									? new Uint8Array(0)
									: await this.opc.read(entry.name)

				text = decodeUtf8(bytes)
				texts.set(key, text)
			}

			return text
		}
		const live = this.liveRelationships(await this.everyRelationship())
		const written = new Set([
			...this.added.keys(),
			...this.replaced.keys(),
			...[...this.editors].filter(([, editor]) => editor.changed).map(([key]) => key)
		])

		for (const [key, { all }] of live) {
			const relationships = all.filter(relationship => !relationship.external)
			const hits = relationships.filter(relationship => candidates.has(partKey(relationship.target)))

			if (hits.length === 0) continue

			// A part this save writes names them by its markup.
			const text = written.has(key) ? await textOf(key) : undefined
			// Any part's drawing relationships the diagram data it relates names, where this save writes the one or the
			// other (data written in place names the drawing of the slide that relates it).
			const drawingIds = new Set<string>()

			for (const relationship of relationships) {
				const data = partKey(relationship.target)

				if (relationshipKind(relationship.type) !== "diagramData" || (!written.has(key) && !written.has(data))) continue

				for (const match of (await textOf(data)).matchAll(/(?<![:\w])relId="([^"]+)"/gu)) drawingIds.add(match[1] ?? "")
			}

			for (const relationship of hits)
				if (text?.includes(`"${relationship.id}"`) === true || drawingIds.has(relationship.id))
					named.add(partKey(relationship.target))
		}

		// What a part kept relates stays with it.
		for (const queue = [...named]; queue.length > 0;) {
			const key = queue.pop() as string

			for (const relationship of live.get(key)?.all ?? []) {
				const target = partKey(relationship.target)

				if (!relationship.external && candidates.has(target) && !named.has(target)) {
					named.add(target)
					queue.push(target)
				}
			}
		}

		return named
	}

	private async bytesOf(part: AddedPart): Promise<Uint8Array> {
		if (part.bytes === undefined) throw new PresentationError("failed", `The new part ${part.name} has no content`)
		return part.bytes instanceof Uint8Array ? part.bytes : joinBytes(part.bytes)
	}

	// A new part under `name` (claimed or allocated before), with its content type as an Override.
	add(name: string, contentType: string, bytes: PartBytes | undefined, options: { compress?: boolean; crc32?: number } = {}): void {
		const key = partKey(name)

		this.taken.add(key)
		this.added.set(key, {
			name,
			contentType,
			bytes,
			compress: options.compress ?? !/^(image|video|audio)\//u.test(contentType),
			...(options.crc32 === undefined ? {} : { crc32: options.crc32 })
		})
	}

	setOverride(name: string, contentType: string): void {
		this.overrides.set(partKey(name), contentType)
	}

	// Removes a part and its relationships part.
	remove(name: string): void {
		const key = partKey(name)

		if (this.added.delete(key)) {
			this.relationshipEdits.delete(key)

			return
		}

		if (!this.opc.has(name)) return

		this.removed.add(key)
		this.editors.delete(key)
		this.replaced.delete(key)
	}

	async loadRelationships(source: string): Promise<RelationshipsEdit> {
		const key = partKey(source)
		let edit = this.relationshipEdits.get(key)

		if (edit === undefined) {
			const base = this.added.has(key) || !this.opc.has(source) ? [] : (await this.opc.relationships(source)).all

			edit = new RelationshipsEdit(
				this.opc.entry(source)?.name ?? source,
				base,
				this.deck === undefined ? [] : (retiredIds.get(this.deck)?.get(key) ?? [])
			)
			this.relationshipEdits.set(key, edit)
		}

		return edit
	}

	relationshipsOf(source: string): RelationshipsEdit {
		const edit = this.relationshipEdits.get(partKey(source))

		if (edit === undefined) throw new PresentationError("failed", `The relationships of ${source} were not loaded before their edit`)

		return edit
	}

	// The zip name of a part this save added, its relationships edit made (a new part has none to load).
	private addedSource(part: string): string {
		const name = part.startsWith("/") ? part.slice(1) : part
		const key = partKey(name)

		if (!this.added.has(key)) throw new PresentationError("failed", `${name} is not a part this save added`)
		if (!this.relationshipEdits.has(key)) this.relationshipEdits.set(key, new RelationshipsEdit(name, []))

		return name
	}

	// A relationship from `source` to `target` of `type`, reused when one exists.
	relate(source: string, target: string, type: string, external = false): string {
		const edit = this.relationshipsOf(source)
		const key = external ? target : partKey(target)

		for (const relationship of edit.all()) {
			if (
				relationship.type === type &&
				relationship.external === external &&
				(external ? relationship.target : partKey(relationship.target)) === key
			) {
				return relationship.id
			}
		}

		return edit.add(type, target, external)
	}

	// The PartsApi of the emits for `owner`.
	api(owner: string): PartsApi & RelatingWithId {
		const ownerName = owner.startsWith("/") ? owner.slice(1) : owner
		const made = (rId: string): string => {
			this.emitted.add(`${partKey(ownerName)}|${rId}`)

			return rId
		}

		return {
			letGo: part => {
				const name = part.startsWith("/") ? part.slice(1) : part

				this.unrelated.push(name)
				this.released.push(name)
			},
			relationshipType: id => this.relationshipsOf(ownerName).byId(id)?.type,
			relationshipIds: type =>
				this.relationshipsOf(ownerName)
					.all()
					.flatMap(relationship =>
						relationship.type === type &&
						!relationship.external &&
						!this.emitted.has(`${partKey(ownerName)}|${relationship.id}`)
							? [relationship.id]
							: []
					),
			copiedFrom: part => this.copies.get(partKey(part.startsWith("/") ? part.slice(1) : part)),
			relateWithId: (target, type, id, replaceable) => {
				const edit = this.relationshipsOf(ownerName)
				const to = target.startsWith("/") ? target.slice(1) : target
				const held = edit.all().find(relationship => relationship.id === id)

				if (held !== undefined) {
					if (held.external || held.type !== type) return false
					if (partKey(held.target) === partKey(to)) return true
					if (replaceable?.(`/${held.target}`) !== true) return false

					edit.retarget(id, to)
					this.unrelated.push(held.target)
					made(id)

					return true
				}

				return made(edit.add(type, to, false, id)) === id
			},
			owner,
			addPart: (kind, content, contentType, options) => {
				const shared = options?.shared === undefined ? undefined : this.sharedParts.get(options.shared)

				if (shared !== undefined) return { part: `/${shared}`, rId: made(this.relate(ownerName, shared, RELATIONSHIP_TYPES[kind])) }

				const former = options?.name === undefined ? undefined : zipNameOf(options.name)
				const name = former !== undefined && this.claim(former) ? former : this.allocate(kind, contentType)

				if (options?.shared !== undefined) this.sharedParts.set(options.shared, name)

				this.add(name, contentType, content, options?.crc32 === undefined ? {} : { crc32: options.crc32 })

				const source = options?.from === undefined ? ownerName : this.addedSource(options.from)
				const rId =
					options?.id === undefined
						? this.relate(source, name, RELATIONSHIP_TYPES[kind])
						: this.relationshipsOf(source).add(RELATIONSHIP_TYPES[kind], name, false, options.id)

				return { part: `/${name}`, rId: source === ownerName ? made(rId) : rId }
			},
			relateFrom: (from, target, type, options) => {
				const source = this.addedSource(from)
				const external = options?.external === true
				const to = external ? target : target.startsWith("/") ? target.slice(1) : target

				return options?.id === undefined
					? this.relate(source, to, type, external)
					: this.relationshipsOf(source).add(type, to, external, options.id)
			},
			has: part => this.exists(part.startsWith("/") ? part.slice(1) : part),
			relate: (target, type, external) =>
				made(
					this.relate(
						ownerName,
						external === true ? target : target.startsWith("/") ? target.slice(1) : target,
						type,
						external === true
					)
				),
			target: rId => {
				const relationship = this.relationshipsOf(ownerName).byId(rId)

				return relationship === undefined || relationship.external ? undefined : `/${relationship.target}`
			},
			removePart: part => this.remove(part.startsWith("/") ? part.slice(1) : part),
			replacePart: (part, content) => {
				const name = part.startsWith("/") ? part.slice(1) : part

				if (!this.exists(name) || (this.isAdded(name) && !this.restored.has(partKey(name)))) return false

				this.replace(name, content)

				return true
			},
			replaceCopy: (part, content) => {
				const name = part.startsWith("/") ? part.slice(1) : part

				if (!this.copies.has(partKey(name))) return false

				this.replace(name, content)

				return true
			},
			unrelate: rId => {
				const edit = this.relationshipsOf(ownerName)
				const relationship = edit.byId(rId)

				if (relationship === undefined) return

				edit.remove(rId)

				if (!relationship.external) this.unrelated.push(relationship.target)
			},
			targetFrom: (from, rId) => {
				const relationship = this.relationshipEdits.get(partKey(from.startsWith("/") ? from.slice(1) : from))?.byId(rId)

				return relationship === undefined || relationship.external ? undefined : `/${relationship.target}`
			},
			editor: part => this.editor(part.startsWith("/") ? part.slice(1) : part)
		}
	}

	// Every base relationships part, parsed once (removals look for what still references a part).
	async everyRelationship(): Promise<Map<string, readonly Relationship[]>> {
		if (this.allRelationships !== undefined) return this.allRelationships

		const out = new Map<string, readonly Relationship[]>()

		for (const entry of this.opc.entries()) {
			const match = /^(.*?)_rels\/([^/]*)\.rels$/iu.exec(entry.name)

			if (match === null) continue

			const source = `${match[1] ?? ""}${match[2] ?? ""}`

			if (source !== "" && !this.opc.has(source)) continue

			out.set(partKey(source), (await this.opc.relationships(source)).all)
		}

		this.allRelationships = out

		return out
	}

	// Copies `source` and the parts only it should own (COPIED_KINDS, recursively) under new names (`name` when given
	// and free); relationships to `backFrom` (the original slide, from its notes slide) point at `backTo` instead.
	// Returns the new name.
	async copyPart(source: string, like: string | undefined, backFrom?: string, backTo?: string, name?: string): Promise<string> {
		const contentType = this.typeOf(source) ?? PART_CONTENT_TYPES.xml
		const target =
			name !== undefined && !this.opc.has(name) && this.claim(name) ? name : this.allocate(undefined, contentType, like ?? source)

		this.add(target, contentType, await this.opc.read(source), { compress: this.opc.entry(source)?.method !== 0 })
		this.copies.set(partKey(target), `/${source}`)
		await this.copyRelationships(source, target, backFrom ?? source, backTo ?? target)

		return target
	}

	// The relationships of `from` given to `to`: copied targets for COPIED_KINDS, the same targets otherwise; ids kept
	// (the copied markup names them). `nameOf` picks the name of a copied target (a notes slide the model named).
	async copyRelationships(
		from: string,
		to: string,
		backFrom: string,
		backTo: string,
		nameOf?: (relationship: PendingRelationship) => string | undefined,
		keep?: (relationship: PendingRelationship) => boolean
	): Promise<void> {
		// The source's relationships as the base has them (edits to the original in this save are its own).
		const base: PendingRelationship[] = this.added.has(partKey(from))
			? (await this.loadRelationships(from)).all()
			: (await this.opc.relationships(from)).all.flatMap(relationship => {
					const target = relationship.external ? relationship.target : relationship.partName

					return target === undefined
						? []
						: [{ id: relationship.id, type: relationship.type, target, external: relationship.external }]
				})
		const edit = await this.loadRelationships(to)

		this.seed(to, keep === undefined ? base : base.filter(relationship => keep(relationship)))

		for (const relationship of base) {
			if (keep?.(relationship) === false) continue

			let target = relationship.target

			if (!relationship.external) {
				// A target the source already lacked (a damaged package) is copied as it is, and remembered as the source's.
				if (!this.opc.has(target)) this.inheritedMissing.add(partKey(target))

				if (partKey(target) === partKey(backFrom)) target = backTo
				else if (copiedKind(relationship.type) && this.opc.has(target))
					target = await this.copyPart(target, undefined, backFrom, backTo, nameOf?.(relationship))
			}

			edit.add(relationship.type, target, relationship.external, relationship.id)
		}
	}

	// The relationship ids a new part's markup came with (a copy's or a restored part's): gate 2 tells an id this save
	// dropped from one the source already lacked.
	seed(name: string, relationships: readonly { readonly id: string }[]): void {
		this.seeded.set(
			partKey(name),
			relationships.map(relationship => relationship.id)
		)
	}

	// Every live relationship by source (part key): the base ones with this save's edits applied, and the new parts'.
	private liveRelationships(
		base: ReadonlyMap<string, readonly Relationship[]>
	): Map<string, { name: string; all: PendingRelationship[] }> {
		const live = new Map<string, { name: string; all: PendingRelationship[] }>()

		for (const [source, relationships] of base) {
			if (this.removed.has(source)) continue

			const edit = this.relationshipEdits.get(source)

			live.set(source, {
				name: this.opc.entry(source)?.name ?? source,
				all:
					edit?.all() ??
					relationships.flatMap(relationship => {
						const target = relationship.external ? relationship.target : relationship.partName

						return target === undefined
							? []
							: [{ id: relationship.id, type: relationship.type, target, external: relationship.external }]
					})
			})
		}

		for (const [source, edit] of this.relationshipEdits) {
			if (live.has(source) || this.removed.has(source) || !this.exists(edit.source)) continue

			live.set(source, { name: edit.source, all: edit.all() })
		}

		return live
	}

	// What removing `parts` takes with it: they and every part only they referenced, transitively, judged against every
	// surviving referrer (new parts included, so a copy keeps what it shares with a removed original). A part that was
	// already unreferenced is not touched. Returns the part keys that go.
	// Parts a removal never takes with it (keepParts), by key.
	private readonly kept = new Set<string>()
	// Parts a step the history holds names (holdParts): never let go of when nothing relates them, by key.
	private readonly held = new Set<string>()
	private holdAll = false
	// Parts emits stopped naming (letGo), by zip name.
	private readonly released: string[] = []
	// Media relationships written slides stopped naming (releaseMedia), by owner part key.
	private readonly releasing: { owner: string; id: string; type: string; target: string }[] = []

	// undefined: what the history names is not known, so no part an emit lets go of goes with this save.
	holdParts(parts: readonly string[] | undefined): void {
		if (parts === undefined) this.holdAll = true
		else for (const part of parts) this.held.add(partKey(part))
	}

	// The parts this save's emits stopped naming: from now on the session's to leave out once nothing names them.
	releasedParts(): readonly string[] {
		return this.released
	}

	// Parts that stay whatever removal would orphan them (a part an undo or redo may name again: the session's own, a
	// picture held diagram data names); one a removal leaves unrelated becomes the session's to leave out later.
	keepParts(parts: readonly string[]): void {
		for (const part of parts) this.kept.add(partKey(part))
	}

	async planRemoval(parts: readonly string[]): Promise<Set<string>> {
		return this.plan(parts, this.liveRelationships(await this.everyRelationship()))
	}

	private plan(parts: readonly string[], live: ReadonlyMap<string, { name: string; all: PendingRelationship[] }>): Set<string> {
		const gone = new Set(parts.map(partKey))
		// Referrers of every internal target.
		const referrers = new Map<string, string[]>()

		for (const [source, { all }] of live) {
			for (const relationship of all) {
				if (relationship.external) continue

				const key = partKey(relationship.target)
				const list = referrers.get(key)

				if (list === undefined) referrers.set(key, [source])
				else if (list[list.length - 1] !== source) list.push(source)
			}
		}

		const candidates: string[] = []
		const seen = new Set<string>()
		const visit = (key: string): void => {
			for (const relationship of live.get(key)?.all ?? []) {
				if (relationship.external) continue

				const target = partKey(relationship.target)

				if (gone.has(target) || seen.has(target)) continue

				seen.add(target)
				candidates.push(target)
			}
		}

		for (const key of gone) visit(key)

		// A candidate goes when nothing outside the removed set references it; repeat until nothing changes.
		for (let changed = true; changed;) {
			changed = false

			for (const key of candidates) {
				if (gone.has(key) || !this.opc.has(key)) continue
				if ((referrers.get(key) ?? []).some(source => source !== key && !gone.has(source))) continue

				// A part the session may name again stays, the session's to leave out once nothing names it.
				if (this.kept.has(key)) {
					this.released.push(this.opc.entry(key)?.name ?? key)

					continue
				}

				gone.add(key)
				visit(key)
				changed = true
			}
		}

		return gone
	}

	// Removes `parts` and what they take with them (planRemoval). Relationships from surviving parts (new ones
	// included) to a removed one are handed to `dangling`. Returns the part keys removed.
	async removeWithOrphans(
		parts: readonly string[],
		dangling: (source: string, relationship: PendingRelationship) => Promise<void>
	): Promise<Set<string>> {
		const live = this.liveRelationships(await this.everyRelationship())
		const gone = this.plan(parts, live)

		for (const key of gone) {
			const entry = this.opc.entry(key)

			if (entry !== undefined) this.remove(entry.name)
		}

		// Surviving parts that still point at a removed one.
		for (const [source, { name, all }] of live) {
			if (gone.has(source)) continue

			for (const relationship of all) {
				if (!relationship.external && gone.has(partKey(relationship.target))) await dangling(name, relationship)
			}
		}

		return gone
	}

	// A part's markup as this save writes it.
	async writtenText(name: string): Promise<string> {
		const key = partKey(name)
		const editor = this.editors.get(key)
		const added = this.added.get(key)
		const entry = this.opc.entry(key)
		const bytes =
			editor?.changed === true
				? editor.serialize()
				: added?.bytes !== undefined
					? await this.bytesOf(added)
					: entry === undefined
						? new Uint8Array(0)
						: await this.opc.read(entry.name)

		return decodeUtf8(bytes)
	}

	// Whether media `owner` once related were released while a step the history holds names them.
	hasReleasedMedia(owner: string): boolean {
		return this.deck !== undefined && (releasedMedia.get(this.deck)?.get(partKey(owner))?.size ?? 0) > 0
	}

	// The media relationships of `owner` its source markup named and its written markup (`text`) names by no id (a
	// picture, medium or object deleted, an image replaced): dropped, their parts left to removeUnrelated (gone when
	// nothing relates them). A relationship the source already named by no id stays as it was.
	async releaseMedia(owner: string, text: string): Promise<void> {
		const edit = await this.loadRelationships(owner)
		const entry = this.opc.entry(partKey(owner))
		const source = entry === undefined ? "" : decodeUtf8(await this.opc.read(entry.name))

		for (const relationship of edit.all()) {
			const quoted = `"${relationship.id}"`

			if (
				relationship.external ||
				!MEDIA_KINDS.has(relationshipKind(relationship.type) ?? "") ||
				text.includes(quoted) ||
				!source.includes(quoted)
			)
				continue

			edit.remove(relationship.id)
			this.unrelated.push(relationship.target)
			this.releasing.push({ owner: partKey(owner), id: relationship.id, type: relationship.type, target: relationship.target })
		}
	}

	// Released media `owner`'s written markup (`text`) names again (an undo put the shape back): related under their
	// ids, a part that left the package added again from its held bytes, under its own name where it is free. Carried
	// relationships (carryRelationship) are written the same way. `from`: the part whose held relationships these are
	// (a copy's source slide; the owner itself otherwise).
	restoreMedia(owner: string, text: string, from: string = owner): void {
		const byId = this.deck === undefined ? undefined : releasedMedia.get(this.deck)?.get(partKey(from))

		if (byId === undefined) return

		const edit = this.relationshipsOf(owner)

		for (const [id, media] of byId) {
			if (!text.includes(`"${id}"`) || edit.byId(id) !== undefined) continue

			if (media.external === true) {
				edit.restore(media.type, media.name, id, true)

				continue
			}

			let name = media.name

			if (!this.exists(name)) {
				if (media.bytes === undefined || media.contentType === undefined) continue

				name = this.claim(name) ? name : this.allocate(undefined, media.contentType, name)
				this.add(name, media.contentType, media.bytes)
				noteRestoredMedia(this.deck as object, name)
			}

			edit.restore(media.type, name, id)
		}
	}

	// The base parts emits unrelated (PartsApi.unrelate) that nothing relates now, removed with what only they kept.
	async removeUnrelated(dangling: (source: string, relationship: PendingRelationship) => Promise<void>): Promise<void> {
		if (this.unrelated.length === 0) return

		const live = this.liveRelationships(await this.everyRelationship())
		const related = new Set<string>()

		for (const { all } of live.values())
			for (const relationship of all) if (!relationship.external) related.add(partKey(relationship.target))

		const keys = [...new Set(this.unrelated.map(partKey))]
		// Media a written slide no longer names go whatever the history names: an undo adds them again (restoreMedia).
		const media = new Set(this.releasing.map(each => partKey(each.target)))
		const loose = keys.filter(
			key =>
				!related.has(key) &&
				!this.kept.has(key) &&
				(media.has(key) || (!this.held.has(key) && !(this.holdAll && this.released.some(name => partKey(name) === key)))) &&
				this.opc.entry(key) !== undefined
		)

		this.unrelated.length = 0

		// A part this save added (a copy's own) that nothing relates now goes, and what only it related after it.
		for (let added = keys.filter(key => !related.has(key) && this.added.has(key)); added.length > 0;) {
			const next: string[] = []

			for (const key of added) {
				const part = this.added.get(key)

				if (part === undefined || this.kept.has(key)) continue

				const targets = this.relationshipEdits.get(key)?.all() ?? []

				this.remove(part.name)

				const live = this.liveRelationships(await this.everyRelationship())
				const still = new Set<string>()

				for (const { all } of live.values())
					for (const relationship of all) if (!relationship.external) still.add(partKey(relationship.target))
				for (const relationship of targets)
					if (!relationship.external && this.added.has(partKey(relationship.target)) && !still.has(partKey(relationship.target)))
						next.push(partKey(relationship.target))
			}

			added = next
		}

		const gone = loose.length > 0 ? await this.removeWithOrphans(loose, dangling) : new Set<string>()

		await this.holdReleased(gone)
	}

	// What the save released that a step the history holds names: kept for an undo (restoreMedia), with the part's
	// bytes when it left the package; its relationship id never given out again.
	private async holdReleased(gone: ReadonlySet<string>): Promise<void> {
		const deck = this.deck

		if (deck === undefined || this.releasing.length === 0) return

		for (const { owner, id, type, target } of this.releasing.splice(0)) {
			const key = partKey(target)

			if (!this.holdAll && !this.held.has(key)) continue

			const entry = this.opc.entry(key)
			const bytes = gone.has(key) && entry !== undefined ? await this.opc.read(entry.name) : undefined
			let owners = releasedMedia.get(deck)

			if (owners === undefined) {
				owners = new Map()
				releasedMedia.set(deck, owners)
			}

			const byId = owners.get(owner) ?? new Map<string, ReleasedMedia>()
			let retired = retiredIds.get(deck)

			if (retired === undefined) {
				retired = new Map()
				retiredIds.set(deck, retired)
			}

			owners.set(owner, byId)
			byId.set(id, { type, name: entry?.name ?? target, contentType: this.typeOf(entry?.name ?? target), bytes })
			retired.set(owner, (retired.get(owner) ?? new Set()).add(id))
		}
	}

	patchAfter(name: string, patch: (document: XmlDocument, editor: XmlEditor) => void): void {
		const key = partKey(name)
		const list = this.patches.get(key) ?? []

		list.push({ name, patch })
		this.patches.set(key, list)
	}

	// Applies the patches to each part's final bytes.
	private async applyPatches(): Promise<void> {
		for (const [key, list] of this.patches) {
			if (this.removed.has(key)) continue

			const editor = this.editors.get(key)
			const added = this.added.get(key)
			const name = list[0]?.name ?? key
			let bytes: Uint8Array

			if (editor?.changed === true) bytes = editor.serialize()
			else if (added !== undefined) bytes = await this.bytesOf(added)
			else bytes = this.replaced.has(key) ? await joinBytes(this.replaced.get(key) ?? new Uint8Array(0)) : await this.opc.read(name)

			const document = parseXml(bytes)
			const patched = new XmlEditor(document)

			for (const { patch } of list) patch(document, patched)

			this.editors.delete(key)

			if (added !== undefined) added.bytes = patched.serialize()
			else this.replaced.set(key, patched.serialize())
		}

		this.patches.clear()
	}

	// The zip changes of everything edited: spliced and replaced parts, relationships, content types.
	async changes(): Promise<{ readonly changes: ZipChanges; readonly copies: number }> {
		await this.applyPatches()

		const replace: PartChange[] = []
		const add: PartChange[] = []
		const remove: string[] = []
		const changedKeys = new Set<string>()

		// A part whose new bytes equal its old ones stays a copy (a rewrite with nothing changed copies every entry).
		const replaceIfChanged = async (key: string, bytes: PartBytes): Promise<void> => {
			const entry = this.opc.entry(key)

			if (entry === undefined || changedKeys.has(key)) return

			const joined = await joinBytes(bytes)

			if (entry.uncompressedSize === joined.length && equalBytes(await this.opc.read(entry.name), joined)) return

			replace.push({ name: entry.name, bytes: joined })
			changedKeys.add(key)
		}

		for (const [key, editor] of this.editors) {
			if (editor.changed && !this.added.has(key)) await replaceIfChanged(key, editor.serialize())
		}

		for (const [key, bytes] of this.replaced) await replaceIfChanged(key, bytes)

		for (const [key, part] of this.added) {
			const editor = this.editors.get(key)
			const bytes = editor?.changed === true ? editor.serialize() : part.bytes

			if (bytes === undefined) throw new PresentationError("failed", `The new part ${part.name} has no content`)

			add.push({ name: part.name, bytes, compress: part.compress, ...(part.crc32 === undefined ? {} : { crc32: part.crc32 }) })
		}

		for (const [key, edit] of this.relationshipEdits) {
			if (this.removed.has(key)) continue

			const relsName = relationshipsPartName(edit.source)
			const relsEntry = this.opc.entry(relsName)

			if (this.added.has(key) || relsEntry === undefined) {
				if (edit.all().length > 0) {
					add.push({ name: relsName, bytes: edit.serialize(undefined) })

					// A package without a Default for .rels names each relationships part.
					if (this.contentTypes.typeOf(relsName) === undefined)
						this.overrides.set(partKey(relsName), PART_CONTENT_TYPES.relationships)
				}

				continue
			}

			if (!edit.changed) continue

			await replaceIfChanged(partKey(relsEntry.name), edit.serialize(await this.opc.read(relsEntry.name)))
		}

		for (const key of this.removed) {
			const entry = this.opc.entry(key)

			if (entry === undefined) continue

			remove.push(entry.name)

			const rels = this.opc.entry(relationshipsPartName(entry.name))

			if (rels !== undefined) remove.push(rels.name)
		}

		const overrides = [
			...[...this.added.values()].map(part => ({ partName: part.name, contentType: part.contentType })),
			...[...this.overrides].map(([key, contentType]) => ({
				partName: this.opc.entry(key)?.name ?? add.find(change => partKey(change.name) === key)?.name ?? key,
				contentType
			}))
		]
		const removeOverrides = [...this.removed].map(key => this.opc.entry(key)?.name ?? key)

		if (overrides.length > 0 || removeOverrides.length > 0) {
			const entry = this.opc.entry(CONTENT_TYPES_PART)

			if (entry === undefined) throw new PresentationError("malformed", "The package has no [Content_Types].xml")

			replace.push({ name: entry.name, bytes: editContentTypes(await this.opc.read(entry.name), { overrides, removeOverrides }) })
			changedKeys.add(partKey(entry.name))
		}

		const removedEntries = new Set(remove.map(partKey))
		let copies = 0

		for (const entry of this.opc.entries()) {
			const key = partKey(entry.name)

			if (!changedKeys.has(key) && !removedEntries.has(key)) copies++
		}

		return { changes: { replace, add, remove }, copies }
	}
}

// A part name's stem without its number ("slide12" → "slide"); a loop, where /\d+$/ would try every digit of a long run
// as its start.
export function withoutTrailingDigits(stem: string): string {
	let end = stem.length

	while (end > 0 && stem.charCodeAt(end - 1) >= 0x30 && stem.charCodeAt(end - 1) <= 0x39) end--

	return stem.slice(0, end)
}

export function zipName(modelPart: string): string {
	return modelPart.startsWith("/") ? modelPart.slice(1) : modelPart
}

export function modelName(zipPart: string): string {
	return zipPart.startsWith("/") ? zipPart : `/${zipPart}`
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

export { ContentTypes }

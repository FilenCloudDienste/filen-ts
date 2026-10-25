import { Fragment, type Node } from "prosemirror-model"
import type { Transaction } from "prosemirror-state"
import { AddNodeMarkStep, AttrStep, RemoveNodeMarkStep, ReplaceAroundStep, ReplaceStep, StepMap } from "prosemirror-transform"
import { markStepsOf } from "../edit/marks"
import { Relationships } from "../../opc/index"
import { decodeUtf8, encodeUtf8, parseXml, XmlError, type XmlDocument } from "../../xml/index"
import { parseNumbering, type Numbering } from "../numbering/index"
import { PropsStore } from "../props/index"
import { parseStyles, type DocxStyles } from "../styles/index"
import { DocxDocBuilder, FormatResolver, RunBases, docxSchema, type DocxEditContext, type NewStoryKind, type StoryDoc } from "../edit/index"
import { SetAttrsStep } from "../edit/attrs"
import { knowOrigins } from "../edit/origin"
import { tableMap } from "../edit/tables/map"
import type { NewList } from "../edit/formats"
import { ref, refItem, refPart, type BodyBlocks, type DirtyBlock, type LayoutEdits } from "../layout/index"
import type { Compaction } from "../layout/edits"
import { tableRows } from "../layout/table"
import {
	Item,
	ModelTables,
	RevisionView,
	buildPart,
	partReader,
	type DocxModel,
	type ModelExtension,
	type Section,
	type Story,
	type StoryPart
} from "../model/index"
import { StringTable } from "../model/columns"
import { Ns, STRICT_WORDPROCESSINGML } from "../model/namespaces"
import { DocxWriteError, StoryWriter, planNumbering, stylesWithDefinitions, type WriteEnvironment } from "../write/index"
import { inCell, sectionWritten } from "../write/story"
import type { StoryTemplate } from "../stories/clone"
import { EditedSections, finalSectionEnd, inheritedSections, sameSection, sectionEndOf, type SectionEnd } from "../stories/sections"
import { sniffImage } from "../objects/images"
import type { NestedSplice } from "../write/nested"
import { noteCopyTarget, registerNoteCopy } from "../write/parts/notes"

// What the layout lays out while a document is edited, kept in step with the editing sessions: every
// edited block is written as it will be saved (StoryWriter), parsed again into a small overlay part and laid
// out in place of its source ("lay out what you save"); blocks added, removed or moved change the body's
// block list. Pages map back to the editing document through the same records.

const nodes = docxSchema.nodes
const HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
const IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
const PENDING_PICTURE = "filenMedia"

const WORDPROCESSINGML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const MARKUP_COMPATIBILITY_URI = "http://schemas.openxmlformats.org/markup-compatibility/2006"
// Roots of parts whose stories are elements of their own.
const NOTE_ROOTS = new Set(["footnotes", "endnotes", "comments"])
// The root and story elements of a new story's part.
// The root of a part a copied story is laid out from.
const COPIED_ROOTS: Readonly<Record<Exclude<NewStoryKind, "comment">, string>> = {
	header: "hdr",
	footer: "ftr",
	footnote: "footnotes",
	endnote: "endnotes"
}
const NEW_STORY_ELEMENTS: Readonly<Record<NewStoryKind, readonly [string, string | undefined]>> = {
	footnote: ["w:footnotes", "w:footnote"],
	endnote: ["w:endnotes", "w:endnote"],
	comment: ["w:comments", "w:comment"],
	header: ["w:hdr", undefined],
	footer: ["w:ftr", undefined]
}

// Whether `bytes` contain ASCII `text`.
function containsAscii(bytes: Uint8Array, text: string): boolean {
	const first = text.charCodeAt(0)

	for (let at = bytes.indexOf(first); at >= 0 && at + text.length <= bytes.length; at = bytes.indexOf(first, at + 1)) {
		let k = 1

		while (k < text.length && bytes[at + k] === text.charCodeAt(k)) k++

		if (k === text.length) return true
	}

	return false
}

// The styles and numbering parts as opened (the planned definitions are added to them as a save adds them).
export interface EditDefinitions {
	readonly context: DocxEditContext
	readonly styles: XmlDocument | undefined
	readonly numbering: XmlDocument | undefined
}

// A block laid out from an overlay part.
export interface OverlayRecord {
	readonly part: StoryPart
	// The block (paragraph or table) in the overlay part.
	readonly item: number
	// The source block it stands for (a ref), or -1 for a block the editor created.
	readonly base: number
	// The block as written (the document's own while unchanged: see StoryEdits.adopt).
	node: Node
	readonly story: StoryEdits
	// The top-level entry holding the block, and its position inside the entry's node.
	entry: TopEntry
	offset: number
	// The block as the editor builds it from the overlay part (lazily; maps pages to the editing document).
	shadow: Node | null | undefined
	// Inside a table laid out with rows of its own (see TableRows): the editing row holding the block (the
	// row itself for a row written again).
	holder?: Node | undefined
}

// A table laid out from its source with the rows edits gave it (LayoutEdits.rows): per row of the editing
// table `node`, the row laid out (a ref, -1 while not placed) and the overlay record of a row written again.
interface TableRows {
	// The table laid out (a ref) and the rows of its own part.
	readonly table: number
	readonly sourceRows: number
	node: Node
	readonly refs: number[]
	readonly records: (OverlayRecord | undefined)[]
	// As published (NaN for a row not placed).
	readonly list: Float64Array
}

// An overlay part: the blocks one edit wrote, parsed together. It lives while a block of it is laid out.
interface OverlayPart {
	// By item, ascending. Dropped records leave it at the next read (a large undo drops thousands).
	records: OverlayRecord[]
	readonly dropped: Set<OverlayRecord>
	// The live records by their first item.
	readonly byItem: Map<number, OverlayRecord>
	// What the part's build added to the model's lists, dropped with it.
	readonly stories: readonly [number, number]
	readonly drawings: readonly [number, number]
	readonly vml: readonly [number, number]
}

// A top-level block of a story's editing document and the blocks it is laid out as.
export interface TopEntry {
	node: Node
	index: number
	section: number
	// Refs as the layout addresses them before substitution (the story's block list), refs as laid out, and
	// per ref the offset of the editing node it comes from inside `node` (-1 inside a locked block).
	readonly base: number[]
	readonly laid: number[]
	readonly offsets: number[]
	// Overlay records and substituted source refs this entry owns.
	readonly records: OverlayRecord[]
	readonly substituted: number[]
	// The source refs of its blocks, laid out from or not (a copy of another block's source).
	readonly sources: number[]
	// Where its blocks end sections: after how many of its refs, per block carrying a section break (none:
	// undefined).
	breaks: number[] | undefined
	// Tables among its blocks whose rows and cells' paragraphs alone the edit that built it changed: per laid
	// ref, those paragraphs and rows (refs, see DirtyBlock.cells).
	cells?: Map<number, number[]> | undefined
	// Those of them whose rows came, went or moved (see DirtyBlock.moved).
	moved?: Set<number> | undefined
	// Its tables laid out with rows of their own, by laid ref.
	tables?: Map<number, TableRows> | undefined
}

// The part of an edit the layout must redo: the changed top-level blocks as laid out now, the entries the
// edit replaced and, when blocks came or went, their neighbours (layout restarts at the first page showing
// any of those).
// Transactions a story applied, folded as applyAll reads them: what is kept of them is their first document and
// their last, never those between.
export interface PendingChange {
	readonly before: Node
	readonly after: Node
	// Every transaction applied to the one before it.
	readonly chained: boolean
	// Some transaction has steps.
	readonly stepped: boolean
	// The span the steps changed, of `after`.
	readonly span: { readonly from: number; readonly to: number; readonly whole: boolean } | undefined
}

// `transactions` folded onto `into` (applied after it).
export function foldTransactions(into: PendingChange | undefined, transactions: readonly Transaction[]): PendingChange | undefined {
	const first = transactions[0]

	if (first === undefined) return into

	let span = into?.span
	let chained = into === undefined || (into.chained && first.before === into.after)
	let stepped = into?.stepped ?? false
	let previous: Transaction | undefined

	for (const tr of transactions) {
		if (previous !== undefined && tr.before !== previous.doc) chained = false

		previous = tr

		if (tr.steps.length === 0) continue

		stepped = true

		if (span !== undefined && !span.whole) span = { from: tr.mapping.map(span.from, -1), to: tr.mapping.map(span.to, 1), whole: false }

		const own = changedSpan(tr)

		if (own !== undefined)
			span =
				span === undefined
					? own
					: { from: Math.min(span.from, own.from), to: Math.max(span.to, own.to), whole: span.whole || own.whole }
	}

	return { before: into?.before ?? first.before, after: previous?.doc ?? first.doc, chained, stepped, span }
}

export interface StoryChange {
	readonly dirty: DirtyBlock[]
	readonly replaced: readonly TopEntry[]
	readonly around: readonly TopEntry[]
	// The section properties or the story's own structure changed beyond what the dirty blocks cover: lay
	// out from the story's start.
	readonly whole: boolean
}

// One document's edits for layout: the derived model the layout reads (overlay parts added), the
// substitutions and block lists of every edited story.
// The prefixes the element and attribute names in `bytes` (XML the writer made) need declared, added to `out`
// ("" for an element without one); false when the names alone do not tell which namespaces it needs: an
// attribute that names prefixes in its value (Markup Compatibility's Requires, Ignorable...), a namespace
// declaration, or markup other than elements (comments, processing instructions, CDATA). One pass; a string
// only for each new prefix.
export function namePrefixes(bytes: Uint8Array, out: Set<string>): boolean {
	const length = bytes.length
	let at = 0
	// The last prefix added, as bytes of `bytes` ([lastStart, lastEnd)).
	let lastStart = 0
	let lastEnd = -1
	// Reads a name at `at`; whether it may stand (not a declaration or a Markup Compatibility attribute).
	const name = (attribute: boolean): boolean => {
		const start = at
		let colon = -1

		while (at < length) {
			const byte = bytes[at] ?? 0

			if (byte === 0x3a && colon < 0) colon = at
			else if (byte <= 0x20 || byte === 0x3e || byte === 0x2f || byte === 0x3d) break

			at++
		}

		const prefixEnd = colon < 0 ? start : colon
		// An attribute without a prefix is in no namespace, and `xml` is bound without a declaration.
		const declared = colon < 0 ? !attribute : !equalsAscii(bytes, start, colon, "xml")

		if (declared && !sameBytes(bytes, start, prefixEnd, lastStart, lastEnd)) {
			out.add(colon < 0 ? "" : String.fromCharCode(...bytes.subarray(start, colon)))
			lastStart = start
			lastEnd = prefixEnd
		}

		if (!attribute) return true

		const local = colon < 0 ? start : colon + 1

		return (
			!(colon < 0 ? equalsAscii(bytes, local, at, "xmlns") : equalsAscii(bytes, start, colon, "xmlns")) &&
			!isCompatibility(bytes, local, at)
		)
	}

	while (at < length) {
		if (bytes[at] !== 0x3c) {
			at++

			continue
		}

		at++

		const first = bytes[at]

		if (first === 0x21 || first === 0x3f) return false
		if (first === 0x2f) at++

		name(false)

		for (;;) {
			while (at < length && (bytes[at] ?? 0) <= 0x20) at++

			const byte = bytes[at]

			if (byte === undefined) return false
			if (byte === 0x3e) break
			if (byte === 0x2f) {
				at++

				continue
			}

			if (!name(true)) return false

			while (at < length && bytes[at] !== 0x22 && bytes[at] !== 0x27) at++

			const quote = bytes[at]

			at++

			while (at < length && bytes[at] !== quote) at++

			at++
		}

		at++
	}

	return true
}

function sameBytes(bytes: Uint8Array, start: number, end: number, otherStart: number, otherEnd: number): boolean {
	if (end - start !== otherEnd - otherStart) return false

	for (let k = 0; k < end - start; k++) if (bytes[start + k] !== bytes[otherStart + k]) return false

	return true
}

function equalsAscii(bytes: Uint8Array, start: number, end: number, text: string): boolean {
	if (end - start !== text.length) return false

	for (let k = 0; k < text.length; k++) if (bytes[start + k] !== text.charCodeAt(k)) return false

	return true
}

// Attributes whose values name namespace prefixes.
const MARKUP_COMPATIBILITY = ["Requires", "Ignorable", "ProcessContent", "PreserveElements", "PreserveAttributes", "MustUnderstand"]

function isCompatibility(bytes: Uint8Array, start: number, end: number): boolean {
	for (const name of MARKUP_COMPATIBILITY) if (equalsAscii(bytes, start, end, name)) return true

	return false
}

export class DocumentEdits implements LayoutEdits {
	readonly model: DocxModel
	readonly extension: ModelExtension
	readonly substitutes = new Map<number, number>()
	readonly rows = new Map<number, Float64Array>()
	private viewValue: RevisionView
	body: BodyBlocks | undefined = undefined
	// Stories other than the body whose block structure changed: their blocks (refs).
	readonly stories = new Map<number, Float64Array>()
	private readonly overlays = new Map<number, OverlayPart>()
	// Stories of the document itself; those after them belong to overlay parts.
	readonly storyCount: number
	private readonly bodyIndex: number
	private readonly bodyParts = new Set<number>()
	// Per source document: its root's declarations (undefined when elements below the root declare
	// namespaces too) and root start tags made from them, by the prefixes they declare.
	private readonly roots = new WeakMap<
		XmlDocument,
		{ readonly declarations: ReadonlyMap<string, string> | undefined; readonly tags: Map<string, Uint8Array> }
	>()
	// The sections as opened, by their w:sectPr, and those edits gave other properties.
	private readonly openedSections: readonly Section[]
	private readonly editedSections: EditedSections
	// The document-wide switch for even pages' headers and footers as edited (LayoutEdits).
	evenAndOddHeaders: boolean | undefined = undefined
	// Mirror margins as edited (LayoutEdits).
	mirrorMargins: boolean | undefined = undefined
	// Where notes go as edited, document-wide (LayoutEdits).
	footnotePosition: string | undefined = undefined
	endnotePosition: string | undefined = undefined
	private ownStore: PropsStore | undefined = undefined
	// The w:numId each list a command started will get when saved (the overlays write them).
	numIds: ReadonlyMap<number, number> = new Map()
	private definitions: EditDefinitions | undefined = undefined
	private plannedKey = ""
	// Relationship ids of hyperlinks commands inserted, per source part, and the parts' relationships with them.
	private readonly links = new Map<string, Map<string, string>>()
	private readonly relationships = new Map<string, Relationships>()
	// The edits of every story (a revision view switch lays them out again).
	private readonly storyEdits = new Set<StoryEdits>()
	// Stories the editor added (they are entered like the document's own).
	private readonly added = new Set<number>()

	constructor(model: DocxModel, view: RevisionView = RevisionView.Final) {
		const derived = model.derive()

		this.model = derived.model
		this.extension = derived.extension
		this.viewValue = view
		this.storyCount = model.stories.length
		this.openedSections = model.sections
		this.bodyIndex = model.body?.part ?? -1

		const body = model.body === undefined ? undefined : model.parts[model.body.part]

		// The document's property store once defined (edited sections' properties intern with the rest).
		this.editedSections = new EditedSections(model.sections, body, (document, node) =>
			(this.definitions?.context.store ?? (this.ownStore ??= new PropsStore())).section(document, node)
		)
	}

	// Which tracked changes the layout shows.
	get view(): RevisionView {
		return this.viewValue
	}

	// Shows the document in another revision view: every story's blocks are read again as that view lays
	// them out (wrappers of deleted or inserted blocks entered or not). The layout must then be laid out again
	// from the start in the same view (DocumentLayout.setView).
	setView(view: RevisionView): boolean {
		if (view === this.viewValue) return false

		this.viewValue = view

		for (const story of this.storyEdits) story.reread()

		return true
	}

	register(story: StoryEdits): void {
		this.storyEdits.add(story)
	}

	// ---- merging overlays (LayoutEdits.compact) -----------------------------------------------------------

	// Live overlay parts past which the body's are merged, how many a merge takes at least, how long input is to
	// have been idle first, and past how many parts a merge waits for that no longer and takes parts however far
	// apart they show (input that never pauses still has them merged; tests lower them).
	compaction: { parts: number; minimum: number; quietMs: number; cap: number } = { parts: 64, minimum: 4, quietMs: 750, cap: 96 }
	// Saves under way (holdCompaction).
	private holds = 0
	// The overlay count a merge last found nothing to do at.
	private fruitless = -1
	private retired: OverlayRecord[] = []

	compactDue(): boolean {
		return (
			this.pending() ||
			(this.retired.length === 0 && this.overlays.size >= this.compaction.parts && this.overlays.size !== this.fruitless)
		)
	}

	pending(): boolean {
		return this.bodyEdits()?.lagging === true
	}

	compactWait(): number {
		return this.pending() || this.overlays.size >= this.compaction.cap ? 0 : this.compaction.quietMs
	}

	compactHeld(): boolean {
		return this.holds > 0
	}

	// A save under way: no merge starts until the returned release (what the save reads stays as it is, and
	// its slices have the CPU).
	holdCompaction(): () => void {
		let held = true

		this.holds++

		return () => {
			if (!held) return

			held = false
			this.holds--
		}
	}

	private bodyEdits(): StoryEdits | undefined {
		for (const story of this.storyEdits) if (story.story.story.kind === "body") return story

		return undefined
	}

	compact(pages: ReadonlyMap<number, readonly [number, number]>, due: () => boolean = () => false): Compaction | undefined {
		const body = this.bodyEdits()

		if (body?.lagging === true) return body.catchUp(due)

		const batch = body?.compactRegion(pages, this.liveOverlays(), due, this.overlays.size >= this.compaction.cap)

		if (batch === undefined) {
			this.fruitless = this.overlays.size

			return undefined
		}

		for (const record of batch.retired) this.retired.push(record)

		return batch
	}

	// Keeps `record` readable while a page shows it (compacted()).
	retire(record: OverlayRecord): void {
		this.retired.push(record)
	}

	retiredParts(): ReadonlySet<number> {
		const parts = new Set<number>()

		for (const record of this.retired) parts.add(record.part.index)

		return parts
	}

	compacted(shown: ReadonlySet<number>): void {
		const retired = this.retired

		this.retired = []

		for (const record of retired) {
			if (shown.has(record.part.index)) this.retired.push(record)
			else this.dropRecord(record)
		}
	}

	// The live records of each overlay part.
	private *liveOverlays(): Generator<readonly [number, readonly OverlayRecord[]]> {
		for (const [index, overlay] of this.overlays) {
			const records = compacted(overlay).filter(record => !overlay.dropped.has(record))

			if (records.length > 0) yield [index, records]
		}
	}

	// Whether `story` is one the editor added.
	addedStory(story: number): boolean {
		return this.added.has(story)
	}

	// Adds a story the editor made (a new note, comment, header or footer), with no source of its own (item
	// -1, every block of it new): on the part of the document that holds stories of its kind when `partName`
	// is one, else on a part made from a template of that part (empty, notes' separators included), which the
	// save adds. Layout and an editing session use it like any other story (its blocks are laid out from the
	// edits); a note goes into the note map layout finds references in. Undefined when no part could be made.
	// With `template` (a header or footer copied from another part, stories/clone.ts), the story is that part's,
	// built from its bytes.
	addStory(kind: NewStoryKind, id: string | undefined, partName: string, template?: StoryTemplate): Story | undefined {
		if (template !== undefined) return this.copiedStory(kind, partName, template)

		const extension = this.extension
		const existing = extension.parts.find(part => part !== undefined && part.name === partName && !this.overlays.has(part.index))

		// A part the package has that the model could not read is no place for a story.
		if (existing === undefined && this.model.package.has(partName)) return undefined

		const part = existing ?? this.templatePart(kind, partName)

		if (part === undefined) return undefined

		const story: Story = {
			index: extension.stories.length,
			kind,
			part: part.index,
			item: -1,
			id,
			noteType: kind === "footnote" || kind === "endnote" ? "normal" : undefined,
			parent: -1,
			owner: -1
		}

		extension.stories.push(story)
		this.added.add(story.index)

		if (kind === "footnote" && id !== undefined) extension.footnotes.set(id, story)
		if (kind === "endnote" && id !== undefined) extension.endnotes.set(id, story)

		return story
	}

	// A header or footer on a part of its own made from `template`, as the save writes it: the part's story (with
	// its text boxes, stories of the derived model too), its pictures and drawings in the derived model's lists.
	// A copied note (stories/clone.ts cloneNote) is laid out from a part of its own too, the notes part's root
	// around it; the save writes it into that notes part (write/parts/notes.ts).
	private copiedStory(kind: NewStoryKind, partName: string, template: StoryTemplate): Story | undefined {
		const note = kind === "footnote" || kind === "endnote"
		const into = note ? this.notesPart(kind, partName) : undefined

		if (kind === "comment" || (note ? into === undefined : this.model.package.has(partName))) return undefined

		let parsed: XmlDocument

		try {
			parsed = parseXml(template.bytes)
		} catch (error) {
			if (error instanceof XmlError) return undefined

			throw error
		}

		const reader = partReader(parsed)

		if (!reader.is(parsed.documentElement(), Ns.W, COPIED_ROOTS[kind])) return undefined

		const extension = this.extension
		const first = extension.stories.length
		// Strings the document has keep their ids (revision authors read through the model).
		const strings = new StringTable()

		for (const value of this.model.strings) strings.intern(value)

		const tables = Object.assign(new ModelTables(), {
			strings,
			stories: extension.stories,
			drawings: extension.drawings,
			vml: extension.vml
		})
		const part = buildPart(reader, tables as ModelTables, extension.parts.length, partName, template.relationships)
		const story = extension.stories[first]

		if (story === undefined) return undefined

		extension.parts.push(part)

		for (let index = first; index < extension.stories.length; index++) this.added.add(index)

		if (into !== undefined && story.id !== undefined && story.kind === kind) {
			registerNoteCopy(part, into, template.from)

			if (kind === "footnote") extension.footnotes.set(story.id, story)
			else extension.endnotes.set(story.id, story)
		}

		return story
	}

	// The notes part new notes of `kind` go into (`partName`): the document's, or the one the save will make
	// (made now where no new note made it yet).
	notesPart(kind: "footnote" | "endnote", partName: string): StoryPart | undefined {
		const existing = this.extension.parts.find(
			part => part !== undefined && part.name === partName && !this.overlays.has(part.index) && noteCopyTarget(part) === undefined
		)

		if (existing !== undefined) return existing

		return this.model.package.has(partName) ? undefined : this.templatePart(kind, partName)
	}

	// A part of `kind` the document does not have, as the save will make it before adding the story: the
	// main document's namespaces, no story (a notes part has its separator notes). Its stories are not the
	// document's.
	private templatePart(kind: NewStoryKind, partName: string): StoryPart | undefined {
		const [root, element] = NEW_STORY_ELEMENTS[kind]
		const body = this.model.body === undefined ? undefined : this.model.parts[this.model.body.part]
		const declared =
			body === undefined ? undefined : partReader(body.document).namespaces.declarations().get(body.document.documentElement())
		const escape = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
		const w = declared?.get("w") ?? (this.model.strict ? STRICT_WORDPROCESSINGML : WORDPROCESSINGML)
		let open = `<${root} xmlns:w="${escape(w)}"`

		for (const [prefix, uri] of declared ?? [])
			if (prefix !== "w") open += ` ${prefix === "" ? "xmlns" : `xmlns:${prefix}`}="${escape(uri)}"`

		// The prefixes the main document marks ignorable (w14, w15...) are ignorable here too.
		const mc = [...(declared ?? [])].find(([, uri]) => uri === MARKUP_COMPATIBILITY_URI)?.[0]
		const ignorable =
			mc === undefined || mc === "" || body === undefined
				? undefined
				: body.document.attribute(body.document.documentElement(), `${mc}:Ignorable`)
		const kept = (ignorable ?? "").split(/\s+/).filter(prefix => prefix !== "" && declared?.has(prefix) === true)

		if (mc !== undefined && kept.length > 0) open += ` ${mc}:Ignorable="${escape(kept.join(" "))}"`

		const content =
			element === undefined || kind === "comment"
				? ""
				: `<${element} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></${element}>` +
					`<${element} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></${element}>`
		let parsed: XmlDocument

		try {
			parsed = parseXml(encodeUtf8(`${open}>${content}</${root}>`))
		} catch (error) {
			if (error instanceof XmlError) return undefined

			throw error
		}

		const extension = this.extension
		const tables = new ModelTables()
		// Its own tables: what the template holds is no story of the document...
		const part = buildPart(partReader(parsed), tables, extension.parts.length, partName, new Relationships([]))

		extension.parts.push(part)

		// ...but its separator notes are notes of the derived model, laid out where the saved part has them.
		for (const story of tables.stories) {
			const index = extension.stories.length
			const registered: Story = { ...story, index, part: part.index }

			part.aux[story.item] = index
			extension.stories.push(registered)

			if (story.kind === "footnote" && story.id !== undefined) extension.footnotes.set(story.id, registered)
			if (story.kind === "endnote" && story.id !== undefined) extension.endnotes.set(story.id, registered)
		}

		return part
	}

	// The parts a save rewrites when commands added lists or styles: the overlays and the layout use what
	// the save will write.
	define(definitions: EditDefinitions): void {
		this.definitions = definitions

		const store = definitions.context.media

		// New pictures are laid out from the editor's media store (see pendingMedia).
		this.model.pendingMedia = {
			media(partName) {
				const handle = /\/media\/filen-media-(\d+)$/.exec(partName)?.[1]
				const bytes = handle === undefined ? undefined : store.bytes(Number(handle))
				const image = bytes === undefined ? undefined : sniffImage(bytes)

				return bytes === undefined || image === undefined || typeof image === "string"
					? undefined
					: { bytes, contentType: image.contentType }
			}
		}
	}

	// Plans the definitions for `lists` and `missing` (the sessions' new lists and styles); the styles and
	// numbering to lay out with when they changed, else undefined.
	plan(
		lists: ReadonlyMap<number, NewList>,
		missing: ReadonlyMap<string, string>
	): { readonly styles: DocxStyles; readonly numbering: Numbering | undefined } | undefined {
		const definitions = this.definitions

		if (definitions === undefined) return undefined

		const key =
			[...lists].map(([id, list]) => `${id}:${list.kind}:${String(list.basedOn)}`).join(",") + "|" + [...missing.keys()].join(",")

		if (key === this.plannedKey) return undefined

		this.plannedKey = key

		const context = definitions.context
		const stylesBytes = missing.size === 0 ? null : stylesWithDefinitions(definitions.styles, context.styles, missing)
		const styles = stylesBytes === null ? context.styles : parseStyles(parseXml(stylesBytes), context.store)
		const numbering = planNumbering(definitions.numbering, context.numbering, lists)
		const numberingBytes = numbering.bytes()

		this.numIds = numbering.numIds

		return {
			styles,
			numbering: numberingBytes === null ? context.numbering : parseNumbering(parseXml(numberingBytes), context.store, styles)
		}
	}

	// The relationship id overlays write for a hyperlink a command inserted (the save assigns its own; the
	// target is the same).
	linkId(partName: string, target: string): string {
		let ids = this.links.get(partName)

		if (ids === undefined) {
			ids = new Map()
			this.links.set(partName, ids)
		}

		let id = ids.get(target)

		if (id === undefined) {
			id = `filenPlannedLink${String(ids.size + 1)}`
			ids.set(target, id)
			this.relationships.delete(partName)
		}

		return id
	}

	// A part's relationships for blocks written for layout (`bytes`): with the new pictures they show
	// (r:embed="filenMediaN", see write/atoms/drawings.ts), to the editor's media store (pendingMedia).
	private withPictures(source: StoryPart, bytes: Uint8Array): Relationships {
		const relationships = this.relationshipsOf(source)

		if (!containsAscii(bytes, PENDING_PICTURE)) return relationships

		const handles = new Set(decodeUtf8(bytes).match(/filenMedia\d+/g) ?? [])
		const folder = source.name.slice(0, source.name.lastIndexOf("/") + 1)
		const added = [...handles].map(id => ({
			id,
			type: IMAGE,
			target: `media/filen-media-${id.slice(PENDING_PICTURE.length)}`,
			external: false,
			partName: `${folder}media/filen-media-${id.slice(PENDING_PICTURE.length)}`
		}))

		return new Relationships([...relationships.all, ...added])
	}

	// A part's relationships with the hyperlinks commands added.
	private relationshipsOf(source: StoryPart): Relationships {
		const ids = this.links.get(source.name)

		if (ids === undefined) return source.relationships

		let relationships = this.relationships.get(source.name)

		if (relationships === undefined) {
			const added = [...ids].map(([target, id]) => ({ id, type: HYPERLINK, target, external: true, partName: undefined }))

			relationships = new Relationships([...source.relationships.all, ...added])
			this.relationships.set(source.name, relationships)
		}

		return relationships
	}

	memoKey(part: number, item: number): number {
		const record = this.recordAt(part, item)

		return record !== undefined && record.base >= 0 && record.item === item ? record.base : ref(part, item)
	}

	sourceBlock(part: number, item: number): number {
		return this.recordAt(part, item)?.base ?? -1
	}

	bodyPart(part: number): boolean {
		return part === this.bodyIndex || this.bodyParts.has(part)
	}

	part(index: number): StoryPart | undefined {
		return this.extension.parts[index]
	}

	// The body's sections become those ending at the blocks carrying section breaks `ends` (each a source
	// paragraph's or one an edit made, with what edits changed of its properties) and the body's own (`last`): a
	// section break copied or removed adds or drops one, an edit of its properties gives it others. Without the
	// body's own, a last section of default properties follows when blocks or markup come after the last break
	// (`trailing`), as when a document is opened. The first section that changed, or -1.
	resection(ends: readonly SectionEnd[], last: SectionEnd, trailing: boolean): number {
		const sections = this.extension.sections
		const bases: Section[] = []

		for (const end of ends) {
			if (end.key < 0 && end.edit === undefined) continue
			if (end.key >= 0 && end.edit === undefined && !this.openedSections.some(section => section.item === end.key)) continue

			bases.push(this.editedSections.base(end))
		}

		if (last.key >= 0 || trailing || bases.length === 0) bases.push(this.editedSections.base(last))

		let changed = 0

		while (changed < bases.length && sameSection(sections[changed], bases[changed])) changed++

		if (changed === bases.length && sections.length === bases.length) return -1

		const previous = sections[changed - 1]

		sections.length = changed
		sections.push(...inheritedSections(bases, changed, previous))

		return changed
	}

	// Whether the body's sections end where they did when the document was opened (their properties aside).
	sectionsAsOpened(): boolean {
		const sections = this.extension.sections
		const opened = this.openedSections

		return sections.length === opened.length && sections.every((section, k) => section.item === opened[k]?.item)
	}

	// The start tag of the root `bytes` (blocks written by StoryWriter, to go inside `container`) are parsed in:
	// the source's root declaring only the namespaces their element and attribute names use, so a keystroke
	// does not parse the document's every declaration again; the source's own start tag when that cannot be
	// told (names in attribute values, declarations of their own, markup other than elements) or the source
	// declares namespaces below its root.
	private rootTag(document: XmlDocument, bytes: Uint8Array, container: number): Uint8Array {
		const root = document.documentElement()
		const full = document.bytes.subarray(document.start(root), document.openEnd(root))
		let roots = this.roots.get(document)

		if (roots === undefined) {
			const declarations = partReader(document).namespaces.declarations()
			const own = declarations.get(root)

			roots = { declarations: declarations.size === (own === undefined ? 0 : 1) ? own : undefined, tags: new Map() }
			this.roots.set(document, roots)
		}

		const declared = roots.declarations
		const prefixes = new Set<string>()

		// A large write is parsed under the root as it is: finding the prefixes it uses would read every byte once
		// more for a few declarations less.
		if (declared === undefined || bytes.length > FULL_ROOT_BYTES || !namePrefixes(bytes, prefixes)) return full

		prefixes.add(document.prefix(root))

		if (container >= 0) prefixes.add(document.prefix(container))

		const key = [...prefixes].sort().join(" ")
		let tag = roots.tags.get(key)

		if (tag === undefined) {
			let text = `<${document.name(root)}`

			for (const prefix of [...prefixes].sort()) {
				const uri = declared.get(prefix)

				// A prefix the root does not declare: as the source has it (the parse reports what it reports).
				if (uri === undefined) return full

				text += ` ${prefix === "" ? "xmlns" : `xmlns:${prefix}`}="${uri.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`
			}

			tag = encodeUtf8(`${text}>`)
			roots.tags.set(key, tag)
		}

		return tag
	}

	// The model's text boxes per source part: their w:txbxContent start offsets (ascending), nodes and stories.
	private readonly textboxNodes = new Map<
		number,
		{ readonly starts: Int32Array; readonly nodes: Int32Array; readonly stories: Int32Array }
	>()

	// Written for layout, a source text box carries its story (data-filen-story on its w:txbxContent): an
	// overlay part laid out in place of the block holding it lays the text box out as that story, edits
	// included, not as the copy the block's bytes hold (see addPart).
	readonly textboxMarkers = (part: StoryPart, from: number, to: number): readonly NestedSplice[] | undefined => {
		let found = this.textboxNodes.get(part.index)

		if (found === undefined) {
			const entries: [number, number, number][] = []

			for (let index = 0; index < this.storyCount; index++) {
				const story = this.model.stories[index]

				if (story?.kind !== "textbox" || story.part !== part.index) continue

				const node = part.node(story.item)

				entries.push([part.document.start(node), node, index])
			}

			entries.sort((a, b) => a[0] - b[0])
			found = {
				starts: Int32Array.from(entries.map(entry => entry[0])),
				nodes: Int32Array.from(entries.map(entry => entry[1])),
				stories: Int32Array.from(entries.map(entry => entry[2]))
			}
			this.textboxNodes.set(part.index, found)
		}

		const starts = found.starts

		if (starts.length === 0) return undefined

		let low = 0
		let high = starts.length

		while (low < high) {
			const middle = (low + high) >> 1

			if ((starts[middle] ?? 0) < from) low = middle + 1
			else high = middle
		}

		let out: NestedSplice[] | undefined
		const document = part.document

		for (let k = low; k < starts.length && (starts[k] ?? 0) < to; k++) {
			const node = found.nodes[k] ?? -1
			const openEnd = document.openEnd(node)
			const close = document.isSelfClosing(node) ? openEnd - 2 : openEnd - 1
			const head = decodeUtf8(document.bytes, document.start(node), close)

			;(out ??= []).push({
				from: document.start(node),
				to: close,
				bytes: encodeUtf8(`${head} data-filen-story="${String(found.stories[k] ?? -1)}"`)
			})
		}

		return out
	}

	// Parses `bytes` (blocks written by StoryWriter) inside the root of `source` into a new overlay part, and
	// its top-level paragraphs and tables in order; undefined when it does not parse.
	addPart(
		source: StoryPart,
		container: number,
		bytes: Uint8Array,
		body: boolean
	): { readonly part: StoryPart; readonly items: readonly number[]; readonly offset: number } | undefined {
		const document = source.document
		const root = document.documentElement()
		const node = source.node(container)
		const open = this.rootTag(document, bytes, node)
		const rootName = document.name(root)
		// A text box's blocks are parsed as the part's own story (w:txbxContent alone is no story to the model).
		const textbox = node !== root && node >= 0 && document.localName(node) === "txbxContent"
		const rootPrefix = document.prefix(root)
		// A story the editor added to a notes or comments part (no element of its own yet) goes into one.
		const element = textbox
			? document.localName(root) === "document"
				? rootPrefix === ""
					? "body"
					: `${rootPrefix}:body`
				: NOTE_ROOTS.has(document.localName(root))
					? rootName.slice(0, -1)
					: undefined
			: node !== root && node >= 0
				? document.name(node)
				: container < 0 && NOTE_ROOTS.has(document.localName(root))
					? rootName.slice(0, -1)
					: undefined
		// A body block goes into a w:body; the content of a header or footer sits in the root itself.
		const inner =
			element !== undefined
				? { open: encodeUtf8(`<${element}>`), close: encodeUtf8(`</${element}>`) }
				: { open: new Uint8Array(0), close: new Uint8Array(0) }
		const close = encodeUtf8(`</${document.name(root)}>`)
		const wrapped = new Uint8Array(open.length + inner.open.length + bytes.length + inner.close.length + close.length)
		let at = 0

		for (const chunk of [open, inner.open, bytes, inner.close, close]) {
			wrapped.set(chunk, at)
			at += chunk.length
		}

		let parsed

		try {
			parsed = parseXml(wrapped)
		} catch (error) {
			if (error instanceof XmlError) return undefined

			throw error
		}

		const extension = this.extension
		const index = extension.parts.length
		const stories = extension.stories.length
		const drawings = extension.drawings.length
		const vml = extension.vml.length
		const tables = Object.assign(new ModelTables(), { stories: extension.stories, drawings: extension.drawings, vml: extension.vml })
		const part = buildPart(partReader(parsed), tables as ModelTables, index, source.name, this.withPictures(source, bytes))

		extension.parts.push(part)

		// Text boxes written from the source (see textboxMarkers) are laid out as their source stories.
		for (let k = stories; k < extension.stories.length; k++) {
			const story = extension.stories[k]

			if (story?.kind !== "textbox") continue

			const source = Number(parsed.attribute(part.node(story.item), "data-filen-story") ?? Number.NaN)

			if (Number.isInteger(source) && source >= 0 && source < this.storyCount && this.model.stories[source]?.kind === "textbox")
				part.aux[story.item] = source
		}

		if (body) this.bodyParts.add(index)

		this.overlays.set(index, {
			records: [],
			dropped: new Set(),
			byItem: new Map(),
			stories: [stories, extension.stories.length],
			drawings: [drawings, extension.drawings.length],
			vml: [vml, extension.vml.length]
		})

		const story = extension.stories[stories]
		const items: number[] = []

		if (story !== undefined) {
			for (let child = story.item + 1; child < part.end(story.item); child = part.end(child)) {
				const kind = part.kinds[child]

				if (kind === Item.Paragraph || kind === Item.Table) items.push(child)
			}
		}

		return { part, items, offset: open.length + inner.open.length }
	}

	// The record of the overlay block holding item `item` of part `part`, or undefined.
	recordAt(part: number, item: number): OverlayRecord | undefined {
		const overlay = this.overlays.get(part)

		if (overlay === undefined) return undefined

		const exact = overlay.byItem.get(item)

		if (exact !== undefined) return exact

		const records = compacted(overlay)

		if (records.length === 0) return undefined

		// A part's records are sibling blocks: the last starting at or before `item` is the only one that can hold
		// it (none when it was dropped).
		const record = records[recordIndex(records, item)]

		return record !== undefined && !overlay.dropped.has(record) && record.item <= item && item < record.part.end(record.item)
			? record
			: undefined
	}

	// Every block laid out from an overlay part.
	*overlayRecords(): Generator<OverlayRecord> {
		for (const overlay of this.overlays.values()) for (const record of overlay.records) if (!overlay.dropped.has(record)) yield record
	}

	addRecord(record: OverlayRecord): void {
		const overlay = this.overlays.get(record.part.index)

		if (overlay === undefined) return

		const records = compacted(overlay)

		// A part's blocks are added in item order: this finds the end at once.
		let at = records.length

		while (at > 0 && (records[at - 1]?.item ?? 0) > record.item) at--

		records.splice(at, 0, record)
		overlay.byItem.set(record.item, record)
	}

	// Drops a block laid out from an overlay part, and the part with its last block.
	dropRecord(record: OverlayRecord): void {
		const index = record.part.index
		const overlay = this.overlays.get(index)

		if (overlay === undefined) return

		const records = overlay.records
		const at = recordIndex(records, record.item)

		if (records[at] === record) {
			overlay.dropped.add(record)

			if (overlay.byItem.get(record.item) === record) overlay.byItem.delete(record.item)
		}

		this.dropUnused(record.part)
	}

	// Drops an overlay part no block is laid out from, and what its build added to the model's lists.
	dropUnused(part: StoryPart): void {
		const index = part.index
		const overlay = this.overlays.get(index)

		if (overlay === undefined || overlay.records.length > overlay.dropped.size) return

		const extension = this.extension

		extension.parts[index] = undefined
		this.bodyParts.delete(index)
		this.overlays.delete(index)

		for (let k = overlay.stories[0]; k < overlay.stories[1]; k++) extension.stories[k] = undefined
		for (let k = overlay.drawings[0]; k < overlay.drawings[1]; k++) extension.drawings[k] = undefined
		for (let k = overlay.vml[0]; k < overlay.vml[1]; k++) extension.vml[k] = undefined
	}

	// The blocks the layout's flow of a source container (a story root, a cell, a locked wrapper) finds in
	// [start, end) of `part`: paragraphs and tables, wrappers entered as layout enters them.
	expand(part: StoryPart, start: number, end: number, out: number[]): void {
		const kinds = part.kinds
		const view = this.view

		for (let item = start; item < end;) {
			const kind = kinds[item] ?? 0

			if (kind === Item.Paragraph || kind === Item.Table) {
				out.push(ref(part.index, item))
				item = part.end(item)
			} else if (
				kind === Item.Sdt ||
				kind === Item.CustomXml ||
				kind === Item.AlternateContent ||
				((kind === Item.Insertion || kind === Item.MoveTo) && view !== RevisionView.Original) ||
				((kind === Item.Deletion || kind === Item.MoveFrom) && view !== RevisionView.Final)
			) {
				item++
			} else {
				item = part.end(item)
			}
		}
	}
}

// The edits of one story (the body, a header, a footer, a note) for layout, and the index from its editing
// document to what the layout laid out.
export class StoryEdits {
	readonly edits: DocumentEdits
	readonly story: StoryDoc
	readonly context: DocxEditContext
	private readonly writer: StoryWriter
	private readonly body: boolean
	readonly entries: TopEntry[] = []
	// Start position of each entry's node in the document.
	starts = new Int32Array(0)
	private doc: Node
	// Whether the story's block structure differs from its part's (the layout then reads a block list).
	structured = false
	// Entries by the source items they lay out, ascending (rebuilt when the structure changes).
	private sourceFrom = new Int32Array(0)
	private sourceTo = new Int32Array(0)
	private sourceEntry = new Int32Array(0)
	private sourcesValid = false
	// The entry laying out each source block (ref): when an edit leaves two blocks with the same source (a
	// split paragraph keeps its identity in both halves), the first owns it and the other is a new block.
	private readonly owners = new Map<number, TopEntry>()
	// The live entries holding each source ref, the owner among them: a save writes the first in document
	// order as the source and later ones as copies, so layout does the same.
	private readonly holders = new Map<number, TopEntry | TopEntry[]>()
	// While ownership is set right (reconcile): an entry earlier in the document takes a source over.
	private ordered = false
	// Entries built by the edit being applied, not in `entries` yet.
	private readonly building = new Set<TopEntry>()
	// Page indexes over the story (see PageIndex.replace).
	private readonly indexes = new Set<{ replace(pairs: readonly (readonly [TopEntry, TopEntry])[]): void }>()
	// Tables of the document as opened (the builder records paragraphs only): written as their source.
	private readonly openedTables = new WeakSet<Node>()
	// The story's top-level tables (those in content controls too) as opened, by source item.
	private readonly originalTables = new Map<number, Node>()
	private readonly openedRows = new WeakMap<Node, Map<number, Node>>()
	// Blocks the edit being applied wrote, parsed into one overlay part when it is done (place()).
	private readonly queued: QueuedBlock[] = []

	// `doc` is the session's document now (blocks the proof locked replaced).
	constructor(edits: DocumentEdits, story: StoryDoc, doc: Node, context: DocxEditContext, env?: WriteEnvironment) {
		this.edits = edits
		this.story = story
		this.context = context
		this.body = story.story.kind === "body"

		let revision = Math.max(0, context.model.maxIds.revision)

		this.writer = new StoryWriter(
			env ?? {
				context,
				nextRevisionId: () => ++revision,
				numId: id => {
					const numId = edits.numIds.get(id)

					if (numId === undefined) throw new DocxWriteError("missingSource", `Unknown new list ${String(id)}`)

					return numId
				},
				hyperlink: (part, target) => edits.linkId(part, target),
				nested: edits.textboxMarkers
			},
			story
		)
		edits.register(this)
		this.doc = doc
		doc.descendants(node => {
			if (node.type === nodes.table) this.openedTables.add(node)

			return !node.isTextblock
		})

		const tables = (container: Node): void =>
			container.forEach(child => {
				if (child.type === nodes.table && (child.attrs["src"] as number) >= 0)
					this.originalTables.set(child.attrs["src"] as number, child)
				else if (child.type === nodes.sdt) tables(child)
			})

		tables(doc)
		this.rebuildAll(doc)
	}

	get part(): StoryPart {
		return this.story.part
	}

	// Its overlays are laid out with the body's counts (list numbers, note numbers): the body's, and the text
	// boxes the body's part holds.
	private get countsAsBody(): boolean {
		return this.body || (this.story.story.kind === "textbox" && this.edits.bodyPart(this.part.index))
	}

	// Tells `index` of entries an edit replaced by others for the same blocks.
	watch(index: { replace(pairs: readonly (readonly [TopEntry, TopEntry])[]): void }): void {
		this.indexes.add(index)
	}

	// Reads every block again (the revision view changed what the layout makes of the source).
	reread(): StoryChange {
		const replaced = this.entries.slice()

		this.rebuildAll(this.doc)

		return { dirty: this.dirtyOf(0, this.entries.length - 1), replaced, around: [], whole: true }
	}

	get document(): Node {
		return this.doc
	}

	// The top-level entries holding [from, to) of the document as laid out (see document), with their blocks
	// as layout knows them; undefined for a range outside it.
	blocksOf(from: number, to: number): { readonly entries: readonly TopEntry[]; readonly dirty: DirtyBlock[] } | undefined {
		const doc = this.doc

		if (from < 0 || to < from || to > doc.content.size || doc.childCount === 0) return undefined

		const first = doc.resolve(from).index(0)
		const last = Math.max(first, doc.resolve(Math.max(from, to - 1)).index(0))

		return { entries: this.entries.slice(first, last + 1), dirty: this.dirtyOf(first, last) }
	}

	// ---- keeping up with the editing document -------------------------------------------------------------

	// Brings the layout's view of the story up to date with transactions the session applied (the one applied
	// and those the invariants appended), as one change to the last one's document: blocks are written and laid
	// out only as the session holds them, never in a state between two repairs. Undefined when nothing the
	// layout shows changed.
	applyAll(transactions: readonly Transaction[]): StoryChange | undefined {
		const pending = foldTransactions(undefined, transactions)

		return pending === undefined ? undefined : this.applyPending(pending)
	}

	// applyAll over the transactions folded into `pending` (see foldTransactions).
	applyPending(pending: PendingChange): StoryChange | undefined {
		if (!pending.stepped) return undefined

		const after = pending.after

		return this.change(
			after,
			pending.chained && pending.before === this.doc ? pending.span : { from: 0, to: after.content.size, whole: true }
		)
	}

	apply(tr: Transaction): StoryChange | undefined {
		if (tr.steps.length === 0) return undefined

		return this.change(tr.doc, this.doc === tr.before ? changedSpan(tr) : { from: 0, to: tr.doc.content.size, whole: true })
	}

	// The layout's view taken from this.doc to `after`, which differs from it in `span` (of `after`).
	private change(after: Node, span: { from: number; to: number; whole: boolean } | undefined): StoryChange | undefined {
		const before = this.doc

		this.doc = after

		if (span === undefined) return undefined

		if (span.whole || before.attrs["sectPr"] !== after.attrs["sectPr"]) {
			const replaced = this.entries.slice()

			this.rebuildAll(after)

			return { dirty: this.dirtyOf(0, this.entries.length - 1), replaced, around: [], whole: true }
		}

		const oldCount = before.childCount
		const newCount = after.childCount
		let first = childAt(after, span.from, false)
		let last = Math.max(first - 1, childAt(after, span.to, true))

		// Unchanged neighbours are the same node objects: widen until they are.
		while (first > 0 && after.child(first - 1) !== before.child(first - 1)) first--

		let oldLast = last + (oldCount - newCount)

		while (last + 1 < newCount && oldLast + 1 < oldCount && after.child(last + 1) !== before.child(oldLast + 1)) {
			last++
			oldLast++
		}

		if (oldLast < first - 1 || last < first - 1 || oldLast >= oldCount) {
			const replaced = this.entries.slice()

			this.rebuildAll(after)

			return { dirty: this.dirtyOf(0, this.entries.length - 1), replaced, around: [], whole: true }
		}

		// Marks over much of the body (bold over everything): its blocks are written in the layout's idle slices
		// (catchUp), shown as they were until then; every position is where it was.
		if (
			this.body &&
			newCount === oldCount &&
			oldLast === last &&
			spanSize(after, first, last) >= DEFER_SIZE &&
			marksOnly(before, after, first, last)
		) {
			this.lagFrom = this.lagFrom < 0 ? first : Math.min(this.lagFrom, first)
			this.lagTo = Math.max(this.lagTo, last)

			const at = this.entries[first]

			return { dirty: [], replaced: [], around: at === undefined ? [] : [at], whole: false }
		}

		// Blocks still to catch up move with what came or went before them: every entry is looked at.
		if (this.lagFrom >= 0 && newCount !== oldCount) {
			this.lagFrom = 0
			this.lagTo = Infinity
		}

		const removed = this.entries.slice(first, oldLast + 1)
		const reuse = new Map<Node, TopEntry>()
		const children = new Set<Node>()

		for (const entry of removed) reuse.set(entry.node, entry)
		for (let k = first; k <= last; k++) children.add(after.child(k))

		// Entries not taken over by a node of the new document give up their overlays at the end.
		const pending = new Set(removed)
		const fresh: TopEntry[] = []
		let structural = last - first !== oldLast - first

		for (let k = first; k <= last; k++) {
			const node = after.child(k)
			const kept = reuse.get(node)

			if (kept !== undefined) {
				reuse.delete(node)
				pending.delete(kept)
				kept.index = k
				// Unchanged by this edit: no cells of an earlier one.
				kept.cells = undefined
				kept.moved = undefined
				fresh.push(kept)

				if (removed[k - first] !== kept) structural = true

				continue
			}

			// The entry that stood here is the block's previous version unless its node lives on elsewhere.
			const candidate = removed[k - first]
			const old = candidate !== undefined && pending.has(candidate) && !children.has(candidate.node) ? candidate : undefined

			if (old !== undefined) pending.delete(old)

			const entry = this.entry(node, k, old)

			if (old === undefined || !sameRefs(old.base, entry.base)) structural = true

			fresh.push(entry)
		}

		this.place()

		for (const entry of pending) this.release(entry)

		this.entries.splice(first, oldLast - first + 1, ...fresh)
		this.building.clear()

		if (newCount !== oldCount) {
			for (let k = first + fresh.length; k < this.entries.length; k++) {
				const entry = this.entries[k]

				if (entry !== undefined) entry.index = k
			}
		}

		// A copy pasted before its source, or a source removed while copies stay: the first holder owns.
		const moved = this.reconcile(removed.concat(fresh))

		if (moved.length > 0) structural = true

		const delta = after.content.size - before.content.size
		const sectionStart: TopEntry[] = []
		let sectionsChanged = false
		// Section boundaries move only when a block carrying section properties came or went (or gained or
		// lost them).
		const sections =
			removed.some(entry => entry.breaks !== undefined) ||
			fresh.some(entry => entry.breaks !== undefined) ||
			// A body without section properties of its own has a last section while anything follows its last break.
			(this.body && (after.attrs["sectPr"] as number) < 0 && first + fresh.length >= this.entries.length)

		if (structural || newCount !== oldCount || sections) {
			for (let k = first; k < this.entries.length; k++) {
				const entry = this.entries[k]

				if (entry !== undefined) entry.index = k
			}

			this.reposition(after, first)
			this.structured = true
			this.sourcesValid = false

			if (sections) {
				const changed = this.renumberSections()

				// Sections that changed may show other headers and footers on pages a relayout would keep: laid out
				// again whole, as an edit of the document's attributes is.
				if (changed >= 0) sectionsChanged = true

				// A section whose properties changed is laid out again from its start, with the block before it: the
				// page before then closes the section before (page numbering and notes start anew after it).
				if (changed >= 0) {
					const start = this.entries.findIndex(entry => entry.section >= changed)
					const at = start < 0 ? this.entries.length : start

					for (const entry of [this.entries[at - 1], this.entries[at]]) if (entry !== undefined) sectionStart.push(entry)
				}
			} else {
				// The section of the blocks replaced; for blocks added, that of the block before (or the section
				// after the ones that block ends). Entries laid out again elsewhere keep theirs.
				const previous = this.entries[first - 1]
				const section = removed[0]?.section ?? (previous === undefined ? 0 : previous.section + (previous.breaks?.length ?? 0))

				for (let k = first; k < first + fresh.length; k++) {
					const entry = this.entries[k]

					if (entry !== undefined) entry.section = section
				}
			}

			// Blocks laid out again outside the change: the whole list.
			if (sections || moved.length > 0) this.publish()
			else this.publish(first, removed, fresh)
		} else {
			// One transaction may have resized several of the blocks it changed.
			for (let k = first + 1; k <= last; k++) this.starts[k] = (this.starts[k - 1] ?? 0) + after.child(k - 1).nodeSize
			for (let k = last + 1; k < this.entries.length; k++) this.starts[k] = (this.starts[k] ?? 0) + delta
		}

		// A removal dirties its neighbours: what comes after it moves up.
		const from = last >= first ? first : Math.max(0, first - 1)
		const to = last >= first ? last : Math.min(this.entries.length - 1, first)
		const around = sectionStart

		if (structural) {
			const before = this.entries[first - 1]
			const after = this.entries[first + fresh.length]

			if (before !== undefined) around.push(before)
			if (after !== undefined) around.push(after)
		}

		// Only cells' paragraphs changed: layout restarts at the rows holding them and may stop after them, so
		// pages showing the tables may stay: they show the new entries.
		const cells =
			!structural && !sections && moved.length === 0 && around.length === 0 && fresh.every(entry => entry.cells !== undefined)
		const dirty = this.dirtyOf(from, to, cells)

		if (cells) {
			const pairs = removed.map((entry, k) => [entry, fresh[k] ?? entry] as const)

			for (const index of this.indexes) index.replace(pairs)
		}

		for (const [, entry] of moved) dirtyBlocks(entry, dirty)

		return { dirty, replaced: moved.length === 0 ? removed : removed.concat(moved.map(([old]) => old)), around, whole: sectionsChanged }
	}

	// Gives each source among those `changed` entries hold to its first holder in document order; the entries
	// laid out again for it, with the ones they replace.
	private reconcile(changed: readonly TopEntry[]): [TopEntry, TopEntry][] {
		const moved: [TopEntry, TopEntry][] = []
		const lost = new Map<number, TopEntry>()
		const values = new Set<number>()

		for (const entry of changed) for (const value of entry.sources) values.add(value)

		for (const value of values) {
			const held = this.holders.get(value)
			let first: TopEntry | undefined

			for (const holder of held === undefined ? NO_ENTRIES : Array.isArray(held) ? held : [held]) {
				if (this.entries[holder.index] === holder && (first === undefined || holder.index < first.index)) first = holder
			}

			const owner = this.owners.get(value)

			if (first === undefined || owner === first) continue

			// Rebuilt, it claims every source it holds, not only this one: their owners as they were.
			for (const source of first.sources) {
				const was = this.owners.get(source)

				if (was !== undefined && was !== first && !lost.has(source)) lost.set(source, was)
			}

			this.ordered = true

			const taken = this.rebuild(first)

			moved.push([first, taken])

			if (owner !== undefined && this.entries[owner.index] === owner) moved.push([owner, this.rebuild(owner)])

			this.ordered = false
		}

		// An entry that lost a source to a rebuilt one lays its block out again (from an overlay of its own).
		for (const [source, was] of lost) {
			if (this.owners.get(source) === was || this.entries[was.index] !== was) continue

			this.ordered = true
			moved.push([was, this.rebuild(was)])
			this.ordered = false
		}

		if (moved.length > 0) {
			this.place()
			this.building.clear()
		}

		return moved
	}

	private rebuild(entry: TopEntry): TopEntry {
		const rebuilt = this.entry(entry.node, entry.index, entry)

		rebuilt.section = entry.section
		this.entries[entry.index] = rebuilt

		return rebuilt
	}

	// `cells`: with the paragraphs changed in tables (see TopEntry.cells), when the change was only theirs.
	private dirtyOf(from: number, to: number, cells = false): DirtyBlock[] {
		const out: DirtyBlock[] = []

		for (let k = Math.max(0, from); k <= to && k < this.entries.length; k++) {
			const entry = this.entries[k]

			if (entry !== undefined) dirtyBlocks(entry, out, cells)
		}

		return out
	}

	private rebuildAll(doc: Node): void {
		this.lagFrom = -1
		this.lagTo = -1
		this.caught = undefined

		for (const entry of this.entries) this.release(entry)

		this.owners.clear()
		this.holders.clear()
		this.entries.length = 0
		doc.forEach((node, _offset, index) => {
			this.entries.push(this.entry(node, index, undefined))
		})
		this.place()
		this.building.clear()
		this.reposition(doc)
		this.sourcesValid = false
		this.structured = !this.matchesSource()
		this.renumberSections()
		this.publish()
	}

	// Start positions of the entries from `from` on (those before it are unchanged).
	private reposition(doc: Node, from = 0): void {
		const count = doc.childCount
		const starts = this.starts.length === count ? this.starts : new Int32Array(count)

		if (starts !== this.starts) starts.set(this.starts.subarray(0, Math.min(from, this.starts.length, count)))

		let pos = from === 0 ? 0 : (starts[from - 1] ?? 0) + doc.child(from - 1).nodeSize

		for (let k = from; k < count; k++) {
			starts[k] = pos
			pos += doc.child(k).nodeSize
		}

		this.starts = starts
	}

	// Whether the story's blocks are exactly what the layout reads from its part.
	private matchesSource(): boolean {
		const part = this.part
		const expected: number[] = []

		this.edits.expand(part, this.story.story.item + 1, part.end(this.story.story.item), expected)

		let at = 0

		for (const entry of this.entries) {
			for (const value of entry.base) if (expected[at++] !== value) return false
		}

		return at === expected.length
	}

	// Section of each body entry (that of its first block): sections end with the blocks carrying their
	// properties. The first section whose properties changed, or -1.
	private renumberSections(): number {
		if (!this.body) return -1

		const ends: SectionEnd[] = []

		for (const entry of this.entries) sectionEnds(this.part, entry.node, ends)

		const last = this.entries[this.entries.length - 1]
		const end = this.doc.attrs["end"]
		const trailing = last === undefined || !endsLast(this.part, last.node) || (Array.isArray(end) && end.length > 0)
		const changes: unknown = this.doc.attrs["sectionChanges"]
		const settings = changes as {
			evenAndOddHeaders?: unknown
			mirrorMargins?: unknown
			footnotePosition?: unknown
			endnotePosition?: unknown
		} | null
		const evenAndOdd = settings?.evenAndOddHeaders

		this.edits.evenAndOddHeaders = typeof evenAndOdd === "boolean" ? evenAndOdd : undefined
		this.edits.mirrorMargins = typeof settings?.mirrorMargins === "boolean" ? settings.mirrorMargins : undefined
		this.edits.footnotePosition = typeof settings?.footnotePosition === "string" ? settings.footnotePosition : undefined
		this.edits.endnotePosition = typeof settings?.endnotePosition === "string" ? settings.endnotePosition : undefined

		const changed = this.edits.resection(ends, finalSectionEnd(this.doc), trailing)

		// A break an edit took away (or added) leaves the opened sections' item ranges behind: the layout reads the
		// body's blocks from here.
		if (!this.structured && !this.edits.sectionsAsOpened()) this.structured = true
		const sections = this.edits.model.sections
		let section = 0

		for (const entry of this.entries) {
			entry.section = Math.min(section, Math.max(0, sections.length - 1))
			section += entry.breaks?.length ?? 0
		}

		return changed
	}

	// Hands the story's block list to the layout once its structure is its own. With the change (entries
	// `fresh` at `first` replacing `removed`, sections unchanged) the previous list is patched instead.
	private publish(first?: number, removed?: readonly TopEntry[], fresh?: readonly TopEntry[]): void {
		if (!this.structured) {
			if (this.body) this.edits.body = undefined
			else this.edits.stories.delete(this.story.story.index)

			return
		}

		const previous = this.body ? this.edits.body : this.edits.stories.get(this.story.story.index)
		const previousRefs = previous === undefined ? undefined : "refs" in previous ? previous.refs : previous

		if (first !== undefined && removed !== undefined && fresh !== undefined && previousRefs !== undefined) {
			let at = 0

			for (let k = 0; k < first; k++) at += this.entries[k]?.base.length ?? 0

			let gone = 0
			let added = 0

			for (const entry of removed) gone += entry.base.length
			for (const entry of fresh) added += entry.base.length

			const refs = new Float64Array(previousRefs.length - gone + added)

			refs.set(previousRefs.subarray(0, at))

			let write = at

			for (const entry of fresh) for (const value of entry.base) refs[write++] = value

			refs.set(previousRefs.subarray(at + gone), write)

			if (!this.body) {
				this.edits.stories.set(this.story.story.index, refs)

				return
			}

			const ends = (previous !== undefined && "sectionEnds" in previous ? previous.sectionEnds : new Int32Array(1)).slice()

			// Blocks at a section's end belong to the next section; at the end of the last, to the last.
			for (let k = 0; k < ends.length; k++) {
				const end = ends[k] ?? 0

				if (end > at || (k === ends.length - 1 && end === at)) ends[k] = end - gone + added
			}

			this.edits.body = { refs, count: refs.length, sectionEnds: ends }

			return
		}

		let count = 0

		for (const entry of this.entries) count += entry.base.length

		const refs = new Float64Array(count)
		let at = 0

		for (const entry of this.entries) for (const value of entry.base) refs[at++] = value

		if (!this.body) {
			this.edits.stories.set(this.story.story.index, refs)

			return
		}

		const sections = this.edits.model.sections
		const ends = new Int32Array(Math.max(1, sections.length))
		let section = 0

		at = 0

		for (const entry of this.entries) {
			for (const end of entry.breaks ?? NO_BREAKS) if (section < ends.length - 1) ends[section++] = at + end

			at += entry.base.length
		}

		while (section < ends.length) ends[section++] = at

		this.edits.body = { refs, count, sectionEnds: ends }
	}

	// ---- entries ------------------------------------------------------------------------------------------

	private entry(node: Node, index: number, old: TopEntry | undefined): TopEntry {
		const entry: TopEntry = {
			node,
			index,
			section: old?.section ?? 0,
			base: [],
			laid: [],
			offsets: [],
			records: [],
			substituted: [],
			sources: [],
			breaks: undefined
		}

		this.building.add(entry)

		this.block(entry, node, 0, old)

		if (old !== undefined) this.release(old)

		for (const source of entry.sources) this.hold(source, entry)

		return entry
	}

	private block(entry: TopEntry, node: Node, offset: number, old: TopEntry | undefined): void {
		this.blockRefs(entry, node, offset, old)

		// A block ending a section ends it after its refs (a content control's children each say).
		if (node.type !== nodes.sdt && endsSection(this.part, node)) (entry.breaks ??= []).push(entry.base.length)
	}

	private blockRefs(entry: TopEntry, node: Node, offset: number, old: TopEntry | undefined): void {
		const part = this.part
		const src = (node.attrs["src"] as number | undefined) ?? -1
		// A paragraph an undo made its source again counts too.
		const pristine =
			this.story.pristine.has(node) || this.openedTables.has(node) || (node.type === nodes.paragraph && this.writer.isSource(node))

		switch (node.type) {
			case nodes.paragraph:
			case nodes.table: {
				// The empty paragraph of a story without blocks, untouched: no block, as the save writes it.
				if (src < 0 && this.story.pristine.has(node)) return

				// A copy of a block from inside a table cell stays a copy: the table lays its source out.
				const own = src >= 0 && !inCell(part, src) ? src : -1

				if (own >= 0) entry.sources.push(ref(part.index, own))

				const base = own >= 0 && this.claim(ref(part.index, own), entry, old) ? ref(part.index, own) : -1

				if (base >= 0 && pristine) {
					this.source(entry, base, offset)

					return
				}

				if (
					node.type === nodes.table &&
					(old === undefined
						? this.rowEdits(entry, node, offset, base, undefined, -1)
						: this.cellEdits(entry, node, offset, base, old))
				)
					return

				this.overlay(entry, node, offset, base)

				return
			}
			case nodes.sdt:
				node.forEach((child, childOffset) => this.block(entry, child, offset + 1 + childOffset, old))

				return
			default: {
				// A locked block: what layout finds inside its element, never edited.
				if (src < 0) return

				const refs: number[] = []

				this.edits.expand(part, src, part.end(src), refs)

				for (const value of refs) {
					entry.base.push(value)
					entry.laid.push(value)
					entry.offsets.push(-1)
				}
			}
		}
	}

	// Whether `entry` (replacing `old`) lays out source block `base`: no other live entry does.
	private claim(base: number, entry: TopEntry, old: TopEntry | undefined): boolean {
		const owner = this.owners.get(base)
		const live = owner !== undefined && (this.entries[owner.index] === owner || this.building.has(owner))

		if (live && owner !== old && owner !== entry && !(this.ordered && owner.index > entry.index)) return false
		// Two blocks of one entry (a paragraph split inside a content control): the first has the source.
		if (owner === entry && entry.base.includes(base)) return false

		this.owners.set(base, entry)

		return true
	}

	// A source block laid out as it is.
	private source(entry: TopEntry, value: number, offset: number): void {
		const substitutes = this.edits.substitutes
		const substitute = substitutes.get(value)

		// An earlier edit's overlay is dropped: the block is its source again (undo back to the original).
		if (substitute !== undefined) {
			substitutes.delete(value)

			const record = this.edits.recordAt(refPart(substitute), refItem(substitute))

			if (record !== undefined) this.edits.dropRecord(record)
		}

		entry.base.push(value)
		entry.laid.push(value)
		entry.offsets.push(offset)
	}

	// A table edited inside. Laid out from its own overlay (the editor made it, or an edit changed its
	// properties) with rows and cells as they were: the paragraphs changed are laid out from overlays. Otherwise
	// see rowEdits. False when it is written again whole.
	private cellEdits(entry: TopEntry, node: Node, offset: number, base: number, old: TopEntry): boolean {
		const substitute = base >= 0 ? this.edits.substitutes.get(base) : old.laid[0]
		// The table as `old` laid it out: where it stood in its entry (the entry itself, or a block of a content
		// control).
		const index = old.laid.indexOf(substitute ?? base)
		const oldOffset = index < 0 ? -1 : (old.offsets[index] ?? -1)
		const candidate = oldOffset === 0 ? old.node : oldOffset > 0 ? old.node.nodeAt(oldOffset - 1) : null
		const previous =
			candidate !== null && candidate.type === nodes.table && candidate.attrs["src"] === node.attrs["src"] ? candidate : undefined
		// The table's own overlay, as last written.
		const table =
			substitute === undefined
				? undefined
				: old.records.find(record => record.node.type === nodes.table && ref(record.part.index, record.item) === substitute)

		if (table === undefined) {
			// Laid out from its source last time (with rows of its own or not): edited from there.
			const fromSource = previous !== undefined && base >= 0 && substitute === undefined && old.laid.includes(base)

			return this.rowEdits(entry, node, offset, base, fromSource ? old : undefined, oldOffset)
		}

		if (
			previous === undefined ||
			table.offset !== offset ||
			oldOffset !== offset ||
			!sameShape(table.node, node) ||
			!sameShape(previous, node)
		)
			return this.rowEdits(entry, node, offset, base, undefined, -1)

		const changed: ChangedParagraph[] = []

		changedParagraphs(previous, node, offset, [], changed)

		const shadow = this.shadowOf(table)

		if (shadow === null) return false

		// Paragraphs of the overlay table are those at the same place in the table it was written from.
		for (const paragraph of changed) {
			const src = atPath(shadow, paragraph.path)?.attrs["src"]

			if (typeof src !== "number" || src < 0) return false

			paragraph.base = ref(table.part.index, src)
		}

		const moved = this.takeOver(entry, old, oldOffset, oldOffset + previous.nodeSize, base)
		const replaced = new Set<OverlayRecord>()

		for (const paragraph of changed) this.substitute(entry, paragraph, false, replaced, undefined)

		if (replaced.size > 0) keepRecords(entry, replaced)

		// Paragraphs edited before move by what the changed ones before them grew (positions as they were).
		const shifts: number[] = []
		let grown = 0

		for (const paragraph of changed) {
			const size = atPath(previous, paragraph.path)?.nodeSize ?? 0

			shifts.push(paragraph.offset - offset - grown, paragraph.node.nodeSize - size)
			grown += paragraph.node.nodeSize - size
		}

		for (const record of moved) {
			if (record === table || changed.some(paragraph => paragraph.node === record.node)) continue

			const at = record.offset - offset

			// Outside this table (another block of the entry).
			if (at <= 0 || at >= previous.nodeSize) continue

			let shift = 0

			for (let k = 0; k < shifts.length && (shifts[k] ?? 0) < at; k += 2) shift += shifts[k + 1] ?? 0

			record.offset = offset + at + shift
		}

		const laid = ref(table.part.index, table.item)

		if (changed.length > 0)
			(entry.cells ??= new Map()).set(
				laid,
				changed.map(paragraph => paragraph.base)
			)

		entry.base.push(base >= 0 ? base : laid)
		entry.laid.push(laid)
		entry.offsets.push(offset)

		return true
	}

	// rowEdits for a table laid out from its source rows before and after whose rows are where they were, those
	// changed with only their paragraphs' content changed: just those rows are looked at. False (nothing done)
	// otherwise.
	private paragraphEdits(
		entry: TopEntry,
		node: Node,
		offset: number,
		base: number,
		old: TopEntry,
		previous: Node,
		oldOffset: number
	): boolean {
		const count = node.childCount

		if (count !== previous.childCount) return false

		const changed: number[] = []

		for (let k = 0; k < count; k++) {
			const row = node.child(k)
			const prevRow = previous.child(k)

			if (row === prevRow) continue

			const src = row.attrs["src"] as number

			if (src < 0 || prevRow.attrs["src"] !== src || !sameStructure(prevRow, row)) return false

			changed.push(k)
		}

		const moved = this.takeOver(entry, old, oldOffset, oldOffset + previous.nodeSize, base)
		const part = this.part
		const replaced = new Set<OverlayRecord>()
		const cells: number[] = []
		const changedRows = new Set<Node>()
		// Per changed row: where it started before (relative to the table) and what it grew by.
		const shifts: number[] = []
		let at = 1
		let next = 0
		let grown = 0

		for (let k = 0; next < changed.length && k < count; k++) {
			const prevRow = previous.child(k)

			if (k === changed[next]) {
				const row = node.child(k)
				const rowOffset = offset + at + grown
				const paragraphs: ChangedParagraph[] = []

				next++
				// Records placed in the row now are not moved again with the rows after it.
				changedRows.add(prevRow).add(row)
				changedParagraphs(prevRow, row, rowOffset, [], paragraphs)

				// Paragraphs edited before, unchanged now: where they stand in the row now.
				for (const record of moved) {
					if (record.holder !== prevRow || paragraphs.some(paragraph => paragraph.node === record.node)) continue

					record.offset = offsetOf(row, rowOffset, record.node) ?? record.offset
					record.holder = row
				}

				for (const paragraph of paragraphs) {
					this.substitute(entry, paragraph, true, replaced, row)
					cells.push(paragraph.base >= 0 ? paragraph.base : ref(part.index, paragraph.node.attrs["src"] as number))
				}

				shifts.push(at, row.nodeSize - prevRow.nodeSize)
				grown += row.nodeSize - prevRow.nodeSize
			}

			at += prevRow.nodeSize
		}

		// Paragraphs edited before in other rows: where the table stands now, moved by what changed rows before
		// them grew.
		if (grown !== 0 || offset !== oldOffset) {
			for (const record of moved) {
				if (record.holder === undefined || changedRows.has(record.holder)) continue

				const relative = record.offset - oldOffset
				let shift = 0

				for (let k = 0; k < shifts.length && (shifts[k] ?? 0) < relative; k += 2) shift += shifts[k + 1] ?? 0

				record.offset = offset + relative + shift
			}
		}

		if (replaced.size > 0) keepRecords(entry, replaced)
		if (cells.length > 0) (entry.cells ??= new Map()).set(base, cells)

		entry.base.push(base)
		entry.laid.push(base)
		entry.offsets.push(offset)

		return true
	}

	// The rows of table `item` as opened, by source item (made when first asked).
	private originalRows(item: number): Map<number, Node> | undefined {
		const table = this.originalTables.get(item)

		if (table === undefined) return undefined

		let rows = this.openedRows.get(table)

		if (rows === undefined) {
			rows = new Map()

			for (let k = 0; k < table.childCount; k++) {
				const row = table.child(k)
				const src = row.attrs["src"] as number

				if (src >= 0) rows.set(src, row)
			}

			this.openedRows.set(table, rows)
		}

		return rows
	}

	// The records, substitutions and tables of `old`, which `entry` replaces, are its own now.
	// Those of the table at [from, to) of `old` (with laid ref `table`): `old` is a content control holding other
	// blocks too, which are laid out anew.
	private takeOver(entry: TopEntry, old: TopEntry, from: number, to: number, table: number): ReadonlySet<OverlayRecord> {
		const moved = new Set<OverlayRecord>()

		// All of them when the table is the whole of `old`.
		const whole = from <= 0 && to >= old.node.nodeSize

		for (const record of old.records) if (whole || (record.offset >= from && record.offset < to)) moved.add(record)

		if (moved.size === old.records.length) {
			for (const kept of old.substituted) entry.substituted.push(kept)

			old.substituted.length = 0
		} else {
			const left: number[] = []

			for (const value of old.substituted) {
				const substitute = this.edits.substitutes.get(value)
				const record = substitute === undefined ? undefined : this.edits.recordAt(refPart(substitute), refItem(substitute))

				if (record !== undefined && moved.has(record)) entry.substituted.push(value)
				else left.push(value)
			}

			old.substituted.length = 0
			for (const value of left) old.substituted.push(value)
		}

		keepRecords(old, moved)

		for (const record of moved) {
			entry.records.push(record)
			record.entry = entry
		}

		const rows = old.tables?.get(table)

		if (rows !== undefined) {
			old.tables?.delete(table)
			;(entry.tables ??= new Map()).set(table, rows)
		}

		return moved
	}

	// Lays changed paragraph `paragraph` of a table out from an overlay (`value`: the block it stands for), or
	// from its source again when it is that again (`fromSource`: in a row laid out from its source). Records
	// it replaces are added to `replaced`.
	private substitute(
		entry: TopEntry,
		paragraph: ChangedParagraph,
		fromSource: boolean,
		replaced: Set<OverlayRecord>,
		holder: Node | undefined
	): void {
		const part = this.part
		const value = paragraph.base >= 0 ? paragraph.base : ref(part.index, paragraph.node.attrs["src"] as number)
		const existing = this.edits.substitutes.get(value)
		const record = existing === undefined ? undefined : this.edits.recordAt(refPart(existing), refItem(existing))

		if (record !== undefined) {
			this.edits.dropRecord(record)
			replaced.add(record)
		}

		// A paragraph of a row laid out from its source that is its source again (an undo): no overlay.
		if (fromSource && this.writer.isSource(paragraph.node)) {
			this.edits.substitutes.delete(value)

			return
		}

		if (existing === undefined) entry.substituted.push(value)

		const bytes = this.written(paragraph.node, true)

		if (bytes === undefined) this.edits.substitutes.delete(value)
		else this.queued.push({ entry, node: paragraph.node, offset: paragraph.offset, base: value, bytes, slot: -1, holder })
	}

	// A table laid out from its source (`old`: the entry that laid it out so last, else as the story was opened)
	// whose properties are as they were: rows unchanged keep what they were laid out from, rows whose paragraphs
	// alone changed have those laid out from overlays, and rows added or changed otherwise (a paragraph split or
	// joined in a cell) are written again alone, into one overlay part, and laid out from it (LayoutEdits.rows).
	// False when the table is written again whole (most of its rows are).
	// `oldOffset`: where the table stood in `old`.
	private rowEdits(entry: TopEntry, node: Node, offset: number, base: number, old: TopEntry | undefined, oldOffset: number): boolean {
		const part = this.part
		const tableItem = refItem(base)

		if (base < 0 || refPart(base) !== part.index || part.kinds[tableItem] !== Item.Table) return false

		const known = old?.tables?.get(base)
		const previous =
			old === undefined
				? this.originalTables.get(tableItem)
				: oldOffset === 0
					? old.node
					: oldOffset > 0
						? (old.node.nodeAt(oldOffset - 1) ?? undefined)
						: undefined
		const state = known !== undefined && known.node === previous ? known : undefined

		if (previous === undefined || previous.type !== nodes.table || !previous.sameMarkup(node)) return false

		// A keystroke's usual change: laid out from its source rows before and after, only rows' paragraphs changed.
		if (old !== undefined && known === undefined && this.paragraphEdits(entry, node, offset, base, old, previous, oldOffset))
			return true

		const count = node.childCount
		const prevCount = previous.childCount
		let sourceRows = state?.sourceRows ?? -1
		let prevRefs = state?.refs

		// Rows as the source has them: each editing row is its source row, in order.
		if (prevRefs === undefined) {
			const rows = tableRows(part, tableItem, RevisionView.Markup)

			if (rows.length !== prevCount) return false

			prevRefs = []

			for (let k = 0; k < prevCount; k++) {
				const row = rows[k] ?? -1

				if (previous.child(k).attrs["src"] !== row) return false

				prevRefs.push(ref(part.index, row))
			}

			sourceRows = rows.length
		}

		const prevRecords = state?.records
		const prevAt = new Map<Node, number>()
		const bySource = new Map<number, number>()
		const prevOffsets: number[] = []
		let unique = true

		previous.forEach((row, rowOffset, k) => {
			prevAt.set(row, k)
			prevOffsets.push(1 + rowOffset)

			const src = row.attrs["src"] as number

			if (src < 0) return
			if (bySource.has(src)) unique = false

			bySource.set(src, k)
		})

		// A row pasted as a copy of another: the save writes it as one, so the table is written whole.
		const sources = new Set<number>()

		node.forEach(row => {
			const src = row.attrs["src"] as number

			if (src < 0) return
			if (sources.has(src)) unique = false

			sources.add(src)
		})

		if (!unique) return false

		const SAME = 0
		const CONTENT = 1
		const WRITE = 2
		// As opened again (an undo): laid out from its source row.
		const SOURCE = 3
		const original = this.originalRows(tableItem)
		const plans: { kind: number; from: number; offset: number; paragraphs: ChangedParagraph[] | undefined }[] = []
		let writes = 0

		// Rows of the table before still there as they were.
		const kept = new Set<number>()

		node.forEach(row => {
			const same = prevAt.get(row)

			if (same !== undefined) kept.add(same)
		})

		node.forEach((row, rowOffset, k) => {
			const at = offset + 1 + rowOffset
			const same = prevAt.get(row)

			if (same !== undefined) {
				plans.push({ kind: SAME, from: same, offset: at, paragraphs: undefined })

				return
			}

			const src = row.attrs["src"] as number
			// A row the editor made (no source) is the one at its place before, when the rows are as many.
			const from =
				src >= 0
					? (bySource.get(src) ?? -1)
					: count === prevCount && !kept.has(k) && previous.child(k).attrs["src"] === src
						? k
						: -1
			const record = prevRecords?.[from]
			const prevRow = from >= 0 ? previous.child(from) : undefined
			const opened = src >= 0 ? original?.get(src) : undefined

			if (opened !== undefined && row.eq(opened)) {
				plans.push({ kind: SOURCE, from, offset: at, paragraphs: undefined })

				return
			}

			if (prevRow !== undefined && (prevRefs[from] ?? -1) >= 0) {
				const fits = record === undefined ? sameStructure(prevRow, row) : sameShape(record.node, row) && sameShape(prevRow, row)
				const shadow = fits && record !== undefined ? this.shadowOf(record) : undefined

				if (fits && shadow !== null) {
					const paragraphs: ChangedParagraph[] = []
					let mapped = true

					changedParagraphs(prevRow, row, at, [], paragraphs)

					// In a row written again: the paragraph at the same place in it.
					if (shadow !== undefined && record !== undefined) {
						for (const paragraph of paragraphs) {
							const inner = atPath(shadow, paragraph.path)?.attrs["src"]

							if (typeof inner !== "number" || inner < 0) mapped = false
							else paragraph.base = ref(record.part.index, inner)
						}
					}

					if (mapped) {
						plans.push({ kind: CONTENT, from, offset: at, paragraphs })

						return
					}
				}
			}

			plans.push({ kind: WRITE, from, offset: at, paragraphs: undefined })
			writes++
		})

		if (writes * 2 > count + 1) return false

		// The rows written again, as a table of their own (written before anything changes: a refusal writes the
		// table whole).
		let bytes: Uint8Array | undefined

		if (writes > 0) {
			const rows: Node[] = []

			plans.forEach((plan, k) => {
				if (plan.kind === WRITE) rows.push(node.child(k))
			})

			const alone = node.copy(Fragment.fromArray(rows))

			// Wider than the grid: the save writes the table with a wider one.
			if (tableMap(alone, part, this.context.store).width > ((node.attrs["grid"] as readonly number[] | undefined)?.length ?? 0))
				return false

			bytes = this.written(alone, false)

			if (bytes === undefined) return false
		}

		// What `old` laid out this table with carries over (as opened: nothing, it was laid out from its source).
		const reused = old !== undefined

		const moved = old === undefined ? NO_MOVED : this.takeOver(entry, old, oldOffset, oldOffset + previous.nodeSize, base)
		const byHolder = new Map<Node, OverlayRecord[]>()
		const dropped = new Set<OverlayRecord>()

		if (reused) {
			for (const record of moved) {
				const holder = record.holder

				if (holder === undefined) continue

				const list = byHolder.get(holder)

				if (list === undefined) byHolder.set(holder, [record])
				else list.push(record)
			}
		}

		// Drops the overlays of a row of the table before (one written again, or gone).
		const dropRow = (from: number): void => {
			if (from < 0) return

			const row = previous.child(from)
			const record = prevRecords?.[from]

			if (record !== undefined) {
				this.edits.dropRecord(record)
				dropped.add(record)
			}

			for (const inner of byHolder.get(row) ?? NO_RECORDS) {
				if (inner === record) continue

				this.edits.dropRecord(inner)
				dropped.add(inner)

				if (this.edits.substitutes.get(inner.base) === ref(inner.part.index, inner.item)) this.edits.substitutes.delete(inner.base)
			}
		}

		const refs: number[] = []
		const records: (OverlayRecord | undefined)[] = []
		const used = new Set<number>()
		const cells: number[] = []
		const replaced = new Set<OverlayRecord>()
		const group: RowGroup = { table: base, state: undefined, indices: [], nodes: [], offsets: [] }
		let first = -1

		plans.forEach((plan, k) => {
			const row = node.child(k)
			const from = plan.from

			if (from >= 0) used.add(from)
			if (first < 0 && (plan.kind !== SAME || from !== k)) first = k

			if (plan.kind === WRITE) {
				dropRow(from)
				refs.push(-1)
				records.push(undefined)
				group.indices.push(k)
				group.nodes.push(row)
				group.offsets.push(plan.offset)

				return
			}

			if (plan.kind === SOURCE) {
				dropRow(from)
				refs.push(ref(part.index, row.attrs["src"] as number))
				records.push(undefined)
				cells.push(ref(part.index, row.attrs["src"] as number))

				return
			}

			const record = prevRecords?.[from]
			const prevRow = previous.child(from)

			refs.push(prevRefs[from] ?? -1)
			records.push(record)

			if (!reused) {
				for (const paragraph of plan.paragraphs ?? NO_PARAGRAPHS) {
					this.substitute(entry, paragraph, true, replaced, row)
					cells.push(paragraph.base >= 0 ? paragraph.base : ref(part.index, paragraph.node.attrs["src"] as number))
				}

				return
			}

			const delta = plan.offset - (oldOffset + (prevOffsets[from] ?? 0))
			const changed = plan.paragraphs
			const inside = byHolder.get(prevRow) ?? NO_RECORDS

			if (record !== undefined) {
				record.offset = plan.offset
				record.holder = row
			}

			for (const inner of inside) {
				if (inner === record) continue

				if (changed === undefined) {
					inner.offset += delta

					continue
				}

				// A paragraph edited before, unchanged now: where it stands in the row now.
				if (!changed.some(paragraph => paragraph.node === inner.node)) {
					inner.offset = offsetOf(row, plan.offset, inner.node) ?? inner.offset
					inner.holder = row
				}
			}

			for (const paragraph of changed ?? NO_PARAGRAPHS) {
				this.substitute(entry, paragraph, record === undefined, replaced, row)
				cells.push(paragraph.base >= 0 ? paragraph.base : ref(part.index, paragraph.node.attrs["src"] as number))
			}
		})

		// Rows of the table before that are gone.
		for (let from = 0; from < prevCount; from++) if (!used.has(from)) dropRow(from)

		// Rows moved up into the place of rows removed (or the last row, when they were last): they may now fit
		// earlier.
		if (first < 0 && prevCount !== count) first = count - 1
		if (first >= 0 && (refs[first] ?? -1) >= 0 && plans[first]?.kind !== CONTENT) cells.push(refs[first] ?? -1)

		for (const record of replaced) dropped.add(record)

		if (dropped.size > 0) keepRecords(entry, dropped)

		// Paragraph overlays of rows gone stand for nothing now (those written by this edit are placed later).
		if (dropped.size > 0) {
			const substitutes = this.edits.substitutes
			const queued = new Set(this.queued.map(block => block.base))
			const live = entry.substituted.filter(value => substitutes.has(value) || queued.has(value))

			entry.substituted.length = 0
			for (const value of live) entry.substituted.push(value)
		}

		let plain = writes === 0 && count === sourceRows

		for (let k = 0; plain && k < refs.length; k++) {
			const value = refs[k] ?? -1

			plain = refPart(value) === part.index && (k === 0 || value > (refs[k - 1] ?? 0))
		}

		if (plain) {
			entry.tables?.delete(base)
			this.edits.rows.delete(base)
		} else {
			const list = Float64Array.from(refs, value => (value < 0 ? Number.NaN : value))
			const rows: TableRows = { table: base, sourceRows, node, refs, records, list }

			;(entry.tables ??= new Map()).set(base, rows)
			this.edits.rows.set(base, list)
			group.state = rows
		}

		if (bytes !== undefined && group.state !== undefined)
			this.queued.push({ entry, node, offset, base: -1, bytes, slot: -1, holder: undefined, rows: group })

		if (cells.length > 0 || bytes !== undefined) (entry.cells ??= new Map()).set(base, cells)

		// Rows that came, went or show in the view or not (tracked) move the rest: their indices among the rows
		// laid out are not the earlier layout's.
		if (
			count !== prevCount ||
			plans.some((plan, k) => plan.from !== k || node.child(k).attrs["revision"] !== previous.child(plan.from).attrs["revision"])
		)
			(entry.moved ??= new Set()).add(base)

		entry.base.push(base)
		entry.laid.push(base)
		entry.offsets.push(offset)

		return true
	}

	// A block laid out from an overlay of what it writes as (once the edit's blocks are parsed, see place()).
	private overlay(entry: TopEntry, node: Node, offset: number, base: number): void {
		const bytes = this.written(node, false, base < 0 && ((node.attrs["src"] as number | undefined) ?? -1) >= 0)

		// What the writer refuses (the save refuses it too) is laid out as its source.
		if (bytes === undefined) {
			if (base >= 0) {
				this.edits.substitutes.delete(base)
				entry.base.push(base)
				entry.laid.push(base)
				entry.offsets.push(offset)
			}

			return
		}

		if (base >= 0) entry.substituted.push(base)

		// Placeholders until placed.
		entry.base.push(base)
		entry.laid.push(base)
		entry.offsets.push(offset)
		this.queued.push({ entry, node, offset, base, bytes, slot: entry.laid.length - 1 })
	}

	// `cell`: whether the block is in a table cell.
	private written(node: Node, cell: boolean, copy = false): Uint8Array | undefined {
		try {
			return this.writer.writeBlockAlone(node, copy, cell).finish()
		} catch (error) {
			if (error instanceof DocxWriteError) return undefined

			throw error
		}
	}

	// Parses the blocks the edit wrote into one overlay part and lays them out from it. A block the batch
	// cannot place (its output does not parse) is laid out as its source, or left out when it has none.
	private place(): void {
		if (this.queued.length === 0) return

		const blocks = this.queued.splice(0)
		let size = 0

		for (const block of blocks) size += block.bytes.length

		const bytes = new Uint8Array(size)
		let at = 0

		for (const block of blocks) {
			bytes.set(block.bytes, at)
			at += block.bytes.length
		}

		const added = this.edits.addPart(this.part, this.story.story.item, bytes, this.countsAsBody)
		const left: QueuedBlock[] = []

		if (added === undefined) {
			left.push(...blocks)
		} else {
			// Each block gets the first paragraph or table that starts within its bytes.
			const document = added.part.document
			let next = 0
			let start = 0

			for (const block of blocks) {
				const end = start + block.bytes.length

				while (next < added.items.length && document.start(added.part.node(added.items[next] ?? -1)) - added.offset < start) next++

				const item = added.items[next]

				if (
					item === undefined ||
					document.start(added.part.node(item)) - added.offset >= end ||
					!this.placed(block, added.part, item)
				)
					left.push(block)

				start = end
			}

			this.edits.dropUnused(added.part)
		}

		const unplaced = new Map<TopEntry, Set<number>>()

		for (const block of left) {
			const one = this.edits.addPart(this.part, this.story.story.item, block.bytes, this.countsAsBody)
			const item = one?.items[0]

			if (one !== undefined && item !== undefined && this.placed(block, one.part, item)) continue

			if (one !== undefined) this.edits.dropUnused(one.part)

			if (block.base >= 0) {
				this.edits.substitutes.delete(block.base)
			} else if (block.slot >= 0) {
				const slots = unplaced.get(block.entry) ?? new Set<number>()

				slots.add(block.slot)
				unplaced.set(block.entry, slots)
			}
		}

		for (const [entry, slots] of unplaced) {
			const keep = (_: number, k: number): boolean => !slots.has(k)
			const base = entry.base.filter(keep)
			const laid = entry.laid.filter(keep)
			const offsets = entry.offsets.filter(keep)

			entry.base.splice(0, entry.base.length, ...base)
			entry.laid.splice(0, entry.laid.length, ...laid)
			entry.offsets.splice(0, entry.offsets.length, ...offsets)

			const breaks = entry.breaks

			if (breaks !== undefined) {
				for (let k = 0; k < breaks.length; k++) {
					let gone = 0

					for (const slot of slots) if (slot < (breaks[k] ?? 0)) gone++

					breaks[k] = (breaks[k] ?? 0) - gone
				}
			}
		}
	}

	private placed(block: QueuedBlock, part: StoryPart, item: number): boolean {
		const group = block.rows

		if (group !== undefined) return this.placedRows(block, group, part, item)

		const record: OverlayRecord = {
			part,
			item,
			base: block.base,
			node: block.node,
			story: this,
			entry: block.entry,
			offset: block.offset,
			shadow: undefined,
			holder: block.holder
		}
		const laid = ref(part.index, item)

		this.edits.addRecord(record)
		block.entry.records.push(record)

		if (block.base >= 0) this.edits.substitutes.set(block.base, laid)

		if (block.slot >= 0) {
			block.entry.laid[block.slot] = laid

			if (block.base < 0) block.entry.base[block.slot] = laid
		}

		return true
	}

	// The rows of `group`, the rows of table `item` of `part` (false when they are not as many).
	private placedRows(block: QueuedBlock, group: RowGroup, part: StoryPart, item: number): boolean {
		const state = group.state
		const rows = part.kinds[item] === Item.Table ? tableRows(part, item, RevisionView.Markup) : []

		if (state === undefined || rows.length !== group.indices.length) return false

		const cells = (block.entry.cells ??= new Map()).get(group.table) ?? []

		block.entry.cells.set(group.table, cells)

		group.indices.forEach((index, k) => {
			const row = rows[k] ?? -1
			const node = group.nodes[k]

			if (node === undefined) return

			const record: OverlayRecord = {
				part,
				item: row,
				// A row stands for its table (see DocumentEdits.sourceBlock).
				base: group.table,
				node,
				story: this,
				entry: block.entry,
				offset: group.offsets[k] ?? 0,
				shadow: undefined,
				holder: node
			}
			const laid = ref(part.index, row)

			this.edits.addRecord(record)
			block.entry.records.push(record)
			state.records[index] = record
			state.refs[index] = laid
			state.list[index] = laid
			cells.push(laid)
		})

		return true
	}

	// Records that `entry` holds source `source` (one holder is kept as itself, more as a list).
	private hold(source: number, entry: TopEntry): void {
		const held = this.holders.get(source)

		if (held === undefined) this.holders.set(source, entry)
		else if (!Array.isArray(held)) {
			if (held !== entry) this.holders.set(source, [held, entry])
		} else if (!held.includes(entry)) held.push(entry)
	}

	private unhold(source: number, entry: TopEntry): void {
		const held = this.holders.get(source)

		if (held === entry) {
			this.holders.delete(source)

			return
		}

		if (!Array.isArray(held)) return

		const at = held.indexOf(entry)

		if (at >= 0) held.splice(at, 1)

		const only = held.length === 1 ? held[0] : undefined

		if (only !== undefined) this.holders.set(source, only)
	}

	private release(entry: TopEntry): void {
		for (const base of entry.base) if (this.owners.get(base) === entry) this.owners.delete(base)

		for (const source of entry.sources) this.unhold(source, entry)

		const retiring = this.retiring
		const kept = retiring === undefined ? undefined : new Set(entry.records)

		if (retiring === undefined) for (const record of entry.records) this.edits.dropRecord(record)
		else for (const record of entry.records) retiring.push(record)

		for (const base of entry.substituted) {
			const substitute = this.edits.substitutes.get(base)

			if (substitute === undefined) continue

			const record = this.edits.recordAt(refPart(substitute), refItem(substitute))

			if (record === undefined || kept?.has(record) === true) this.edits.substitutes.delete(base)
		}

		entry.records.length = 0
		entry.substituted.length = 0

		for (const rows of entry.tables?.values() ?? NO_TABLES)
			if (this.edits.rows.get(rows.table) === rows.list) this.edits.rows.delete(rows.table)

		entry.tables = undefined
	}

	// ---- blocks an edit left for later -----------------------------------------------------------------

	// Entries in [lagFrom, lagTo] may stand for an earlier version of their block (see change()).
	private lagFrom = -1
	private lagTo = -1
	// The entries brought up to date so far, laid out again once they all are: the first of them and its changed
	// rows when a table (where layout restarts), and the last (where it may stop).
	private caught: { first: TopEntry; cells: (readonly number[] | undefined)[] | undefined; last: TopEntry } | undefined
	// Records of entries brought up to date, readable until that layout ends (pages show them meanwhile).
	private retiring: OverlayRecord[] | undefined

	get lagging(): boolean {
		return this.lagFrom >= 0
	}

	// Brings entries an edit left behind up to the document until `due` (one at least; a long table some rows
	// at a time). Once they all are, the batch to lay out again; undefined before (the pages show the blocks as
	// they were, at the same positions).
	catchUp(due: () => boolean): Compaction | undefined {
		const doc = this.doc
		const end = Math.min(this.lagTo, this.entries.length - 1, doc.childCount - 1)
		const pairs: [TopEntry, TopEntry][] = []
		const retiring: OverlayRecord[] = []
		let k = this.lagFrom
		let moved = false

		this.retiring = retiring

		try {
			for (; k <= end; k++) {
				const entry = this.entries[k]
				const node = doc.child(k)

				if (entry === undefined || entry.node === node) continue
				if (pairs.length > 0 && due()) break

				// What it stands for again (formatting undone): the document's nodes, nothing written.
				if (entry.node.eq(node)) {
					this.adopt(entry, node)

					continue
				}

				const target = node.type === nodes.table && entry.node.type === nodes.table ? partlyAdvanced(entry.node, node) : node
				const fresh = this.entry(target, k, entry)

				fresh.section = entry.section
				this.entries[k] = fresh
				pairs.push([entry, fresh])

				if (!sameRefs(entry.base, fresh.base) || (entry.breaks?.length ?? 0) !== (fresh.breaks?.length ?? 0)) moved = true

				const caught = this.caught

				// A long table's later steps keep the rows its first step changed.
				if (caught === undefined || fresh.index < caught.first.index)
					this.caught = { first: fresh, cells: undefined, last: caught?.last ?? fresh }
				else if (caught.first === entry) caught.first = fresh

				const now = this.caught

				if (now !== undefined && (now.last === entry || fresh.index > now.last.index)) now.last = fresh

				// The rest of a long table in the next slice.
				if (target !== node) break
			}
		} finally {
			this.retiring = undefined
		}

		for (const record of retiring) this.edits.retire(record)

		if (k > end) {
			this.lagFrom = -1
			this.lagTo = -1
		} else {
			this.lagFrom = k
		}

		if (pairs.length > 0) {
			this.place()
			this.building.clear()
			this.sourcesValid = false

			if (moved) {
				this.structured = true
				this.publish()
			}

			for (const index of this.indexes) index.replace(pairs)

			const caught = this.caught

			// The changed rows of its first block, now laid out from their refs.
			if (caught !== undefined && caught.cells === undefined) {
				const first = caught.first

				caught.cells = first.laid.map(laid => first.cells?.get(laid))
			}
		}

		const caught = this.caught

		if (this.lagging || caught === undefined) return undefined

		this.caught = undefined

		const live = (entry: TopEntry): boolean => this.entries[entry.index] === entry
		const first = caught.first

		// Every block behind the last is (to the end when an edit meanwhile took it).
		const last = live(caught.last) ? caught.last : this.entries[this.entries.length - 1]
		const dirty: DirtyBlock[] = []

		if (last !== undefined) dirtyBlocks(last, dirty)

		// From the start when an edit meanwhile took the first.
		if (!live(first)) return { dirty, parts: new Set(), from: { section: 0, index: 0, rows: [] } }

		// Its index in its section's flow.
		let index = 0

		for (let j = 0; j < first.index; j++) {
			const entry = this.entries[j]

			if (entry === undefined) continue

			const breaks = entry.breaks ?? NO_BREAKS
			let section = entry.section
			let next = 0

			for (let r = 0; r < entry.base.length; r++) {
				while (next < breaks.length && (breaks[next] ?? 0) <= r) {
					section++
					next++
				}

				if (section === first.section) index++
			}
		}

		const rows: DirtyBlock[] = []

		dirtyBlocks(first, rows)

		const cells = caught.cells

		return {
			dirty,
			parts: new Set(),
			from: {
				section: first.section,
				index,
				rows: rows.map((block, k) => {
					const items = cells?.[k]

					return items === undefined ? block : { ...block, cells: items }
				})
			}
		}
	}

	// `entry` stands for `node`, a block the same as its own (other node objects): it and its records take them.
	private adopt(entry: TopEntry, node: Node): void {
		const same = new Map<Node, Node>()
		const pair = (a: Node, b: Node): void => {
			same.set(a, b)

			if (a.isTextblock || a.isLeaf) return

			for (let k = 0; k < a.childCount; k++) pair(a.child(k), b.child(k))
		}

		pair(entry.node, node)
		entry.node = node

		for (const record of entry.records) {
			record.node = same.get(record.node) ?? record.node

			if (record.holder !== undefined) record.holder = same.get(record.holder) ?? record.holder
		}

		for (const rows of entry.tables?.values() ?? NO_TABLES) rows.node = same.get(rows.node) ?? rows.node
	}

	// ---- merging overlays --------------------------------------------------------------------------------

	private formats: FormatResolver | undefined = undefined

	// One region's overlays of this story (body) written again into one part: parts every live block of which is
	// an edited paragraph of this story (a top-level one, or a cell's) and that show on nearby pages (`wide`: on
	// any), at least `minimum` of them. Their blocks are laid out from the merged part at once; the old records stay readable
	// (pages showing them) until the layout has laid those pages out again (`retired`).
	compactRegion(
		pages: ReadonlyMap<number, readonly [number, number]>,
		overlays: Iterable<readonly [number, readonly OverlayRecord[]]>,
		due: () => boolean = () => false,
		wide = false
	): (Compaction & { readonly retired: readonly OverlayRecord[] }) | undefined {
		const candidates: { part: number; first: number; last: number; records: readonly OverlayRecord[] }[] = []

		for (const [part, records] of overlays) {
			const shown = pages.get(part)

			if (shown === undefined || records.length > MERGE_RECORDS || !records.every(record => this.mergeable(record))) continue

			candidates.push({ part, first: shown[0], last: shown[1], records })
		}

		candidates.sort((a, b) => a.first - b.first)

		const minimum = this.edits.compaction.minimum
		const span = wide ? Infinity : MERGE_PAGES
		let chosen: typeof candidates = []

		for (let k = 0; k < candidates.length && chosen.length < minimum; k++) {
			const start = candidates[k]?.first ?? 0

			chosen = []

			for (let j = k; j < candidates.length && chosen.length < MERGE_PARTS; j++) {
				const candidate = candidates[j]

				if (candidate === undefined || candidate.first > start + span) break
				if (candidate.last <= start + span) chosen.push(candidate)
			}
		}

		if (chosen.length < minimum) return undefined

		// Written before anything changes: a block the writer refuses leaves the region as it is. Parts past the
		// slice's time are left for the next merge.
		const writes: { record: OverlayRecord; bytes: Uint8Array; cell: boolean }[] = []
		let taken = 0

		for (const candidate of chosen) {
			if (taken >= minimum && due()) break

			taken++

			for (const record of candidate.records) {
				const cell = record.entry.node !== record.node
				const src = (record.node.attrs["src"] as number | undefined) ?? -1
				const bytes = this.written(record.node, cell, !cell && record.base < 0 && src >= 0)

				if (bytes === undefined) return undefined

				writes.push({ record, bytes, cell })
			}
		}

		const retired: OverlayRecord[] = []
		const tops = new Set<TopEntry>()
		const cellBases = new Map<TopEntry, number[]>()

		for (const { record, bytes, cell } of writes) {
			const entry = record.entry
			const at = entry.records.indexOf(record)

			if (at >= 0) entry.records.splice(at, 1)

			retired.push(record)

			if (cell) {
				this.queued.push({
					entry,
					node: record.node,
					offset: record.offset,
					base: record.base,
					bytes,
					slot: -1,
					holder: record.holder
				})

				const bases = cellBases.get(entry) ?? []

				bases.push(record.base)
				cellBases.set(entry, bases)
			} else {
				this.queued.push({
					entry,
					node: record.node,
					offset: record.offset,
					base: record.base,
					bytes,
					slot: 0,
					holder: undefined
				})
				tops.add(entry)
			}
		}

		this.place()
		this.building.clear()

		// Blocks the editor made are laid out under their overlay's ref: the block list follows.
		if ([...tops].some(entry => (entry.base[0] ?? -1) === entry.laid[0])) this.publish()

		const dirty: DirtyBlock[] = []

		for (const entry of tops) dirtyBlocks(entry, dirty)

		// A cell's paragraph by what it stands for in its table's rows (see DirtyBlock.cells).
		for (const [entry, bases] of cellBases) dirty.push({ section: entry.section, ref: entry.laid[0] ?? -1, cells: bases })

		return { dirty, parts: new Set(chosen.slice(0, taken).map(candidate => candidate.part)), retired }
	}

	// Whether a merge can write `record` again: an edited paragraph of this story, as the document holds it now,
	// the only block of a top-level entry or a cell paragraph of a table that is one.
	private mergeable(record: OverlayRecord): boolean {
		const entry = record.entry

		if (record.story !== this || record.node.type !== nodes.paragraph || this.entries[entry.index] !== entry || entry.laid.length !== 1)
			return false

		// What layout numbers as it lays it out (a list item, a note reference) is counted under its items: written
		// into another part, a run laying out its page again would number it anew.
		let noted = false

		record.node.descendants(node => {
			if (node.type === nodes.note_ref) noted = true

			return !noted
		})

		if (noted || (this.formats ??= new FormatResolver(this.context, this.part)).listOf(record.node) !== undefined) return false

		if (entry.node === record.node) return record.offset === 0 && entry.laid[0] === ref(record.part.index, record.item)

		if (entry.node.type !== nodes.table || record.base < 0) return false

		const start = this.starts[entry.index] ?? 0

		return (
			this.edits.substitutes.get(record.base) === ref(record.part.index, record.item) &&
			this.doc.nodeAt(start + record.offset) === record.node
		)
	}

	// ---- lookups -------------------------------------------------------------------------------------------

	// The entry whose node holds position `pos`.
	entryAt(pos: number): number {
		const starts = this.starts
		let low = 0
		let high = this.entries.length - 1

		while (low < high) {
			const middle = (low + high + 1) >> 1

			if ((starts[middle] ?? 0) <= pos) low = middle
			else high = middle - 1
		}

		return low
	}

	// The entry a laid-out source (part, item) belongs to, or undefined.
	entryOf(part: number, item: number): TopEntry | undefined {
		const record = this.edits.recordAt(part, item)

		if (record !== undefined) return record.story === this ? record.entry : undefined

		if (part !== this.part.index) return undefined

		this.indexSources()

		const from = this.sourceFrom
		let low = 0
		let high = from.length - 1

		if (high < 0 || item < (from[0] ?? 0)) return undefined

		while (low < high) {
			const middle = (low + high + 1) >> 1

			if ((from[middle] ?? 0) <= item) low = middle
			else high = middle - 1
		}

		if (item >= (this.sourceTo[low] ?? 0)) return undefined

		return this.entries[this.sourceEntry[low] ?? -1]
	}

	private indexSources(): void {
		if (this.sourcesValid) return

		const part = this.part
		let count = 0

		for (const entry of this.entries) for (const value of entry.base) if (refPart(value) === part.index) count++

		const from = new Int32Array(count)
		const to = new Int32Array(count)
		const owner = new Int32Array(count)
		let at = 0
		let sorted = true

		this.entries.forEach((entry, index) => {
			for (const value of entry.base) {
				if (refPart(value) !== part.index) continue

				const item = refItem(value)

				if (at > 0 && item < (from[at - 1] ?? 0)) sorted = false

				from[at] = item
				to[at] = part.end(item)
				owner[at] = index
				at++
			}
		})

		// Blocks moved out of document order (dragged paragraphs) need sorting; most documents never do.
		if (!sorted) {
			const order = Array.from({ length: count }, (_, k) => k).sort((a, b) => (from[a] ?? 0) - (from[b] ?? 0))

			this.sourceFrom = Int32Array.from(order, k => from[k] ?? 0)
			this.sourceTo = Int32Array.from(order, k => to[k] ?? 0)
			this.sourceEntry = Int32Array.from(order, k => owner[k] ?? 0)
		} else {
			this.sourceFrom = from
			this.sourceTo = to
			this.sourceEntry = owner
		}

		this.sourcesValid = true
	}

	// The block a laid-out source paragraph (part, item) stands for in the editing document: its position
	// and node, with the paragraph as built from the part the layout read (`shadow`, the same node for an
	// unedited source paragraph). Undefined for paragraphs the editing document has no node for (inside locked
	// blocks).
	paragraphOf(part: number, item: number): { pos: number; node: Node; shadow: Node; layoutPart: StoryPart } | undefined {
		const entry = this.entryOf(part, item)

		if (entry === undefined) return undefined

		const start = this.starts[entry.index] ?? 0
		const record = this.edits.recordAt(part, item)

		if (record !== undefined) {
			const shadow = this.shadowOf(record)

			if (shadow === null) return undefined

			if (item === record.item && record.node.type === nodes.paragraph) {
				return { pos: start + record.offset, node: record.node, shadow, layoutPart: record.part }
			}

			// A paragraph inside an overlay table (or row): found in the shadow, at the same place in the table as
			// it is now (cells edited since keep the shape).
			const path = pathOfSource(shadow, item)
			const inner = path === undefined ? undefined : atPath(shadow, path)
			const table = record.offset === 0 ? entry.node : entry.node.nodeAt(record.offset - 1)
			const found = path === undefined || table === null ? undefined : offsetAtPath(table, path)

			return inner === undefined || found === undefined || !found.node.isTextblock
				? undefined
				: { pos: start + record.offset + found.offset, node: found.node, shadow: inner, layoutPart: record.part }
		}

		// A source paragraph (or one inside a source table): the editing node with that source item, laid out
		// from its overlay when it was edited.
		const found = findSource(entry.node, item, true)

		if (found === undefined) return undefined

		const pos = start + found.offset
		const substitute = this.edits.substitutes.get(ref(part, item))
		const overlay = substitute === undefined ? undefined : this.edits.recordAt(refPart(substitute), refItem(substitute))

		if (overlay !== undefined) {
			const shadow = this.shadowOf(overlay)

			return shadow === null ? undefined : { pos, node: found.node, shadow, layoutPart: overlay.part }
		}

		return { pos, node: found.node, shadow: found.node, layoutPart: this.part }
	}

	// The source key (part, item) the layout reports for the paragraph at `pos` (a textblock start inside the
	// story's document), or undefined.
	keyOf(pos: number, node: Node): { part: number; item: number } | undefined {
		const entry = this.entries[this.entryAt(pos)]

		if (entry === undefined) return undefined

		const start = this.starts[entry.index] ?? 0

		for (const record of entry.records) {
			if (record.node === node && start + record.offset === pos) return { part: record.part.index, item: record.item }
		}

		// Inside a table (or a row) laid out from an overlay: the shadow's paragraph at the same place.
		for (const record of entry.records) {
			if (record.node.type !== nodes.table && record.node.type !== nodes.table_row) continue

			const table = record.offset === 0 ? entry.node : entry.node.nodeAt(record.offset - 1)
			const offset = pos - start - record.offset - 1

			if (table === null || offset < 0 || offset >= table.content.size) continue

			const shadow = this.shadowOf(record)
			const path = pathAt(table, offset)
			const inner = shadow === null || path === undefined ? undefined : atPath(shadow, path)
			const src = inner?.attrs["src"]

			return typeof src === "number" && src >= 0 ? { part: record.part.index, item: src } : undefined
		}

		const src = node.attrs["src"]

		if (typeof src !== "number" || src < 0) return undefined

		const substitute = this.edits.substitutes.get(ref(this.part.index, src))

		return substitute === undefined ? { part: this.part.index, item: src } : { part: refPart(substitute), item: refItem(substitute) }
	}

	// The record's block as the editor builds it from the overlay part (sources = overlay items).
	shadowOf(record: OverlayRecord): Node | null {
		if (record.shadow !== undefined) return record.shadow

		const model = this.edits.model
		// A row written again: its row of the table it was written in.
		const row = record.part.kinds[record.item] === Item.Row
		const block = row ? record.part.parent(record.item) : record.item
		const story = model.storyOf(record.part, record.part.parent(block)) as Story | undefined
		let shadow: Node | null = null

		if (story !== undefined) {
			// A shadow gives the block's structure (maps, fields), never formatting a write or a command reads: it is
			// built with property containers and run bases of its own, which go with it. The document's would keep
			// every stamped container an overlay held, and a run base for each with the overlay's whole part.
			const store = new PropsStore()
			const context = { ...this.context, model, store, bases: new RunBases(store) }

			// Shadows are never pasted: their blocks record their origins as they are built rather than wait in a
			// list that would keep every shadow for as long as the context lives (origin.ts).
			knowOrigins(context)

			try {
				shadow = new DocxDocBuilder(context).buildBlock(story, block)
			} catch {
				shadow = null
			}
		}

		if (row && shadow !== null) {
			let found: Node | null = null

			shadow.forEach(child => {
				if (child.attrs["src"] === record.item) found = child
			})
			shadow = found
		}

		record.shadow = shadow

		return shadow
	}
}

// Index of the last record whose item is at or before `item` (0 when none is).
// An overlay part's records, those dropped taken out once they are half of them (linear over any number of
// drops); the rest are skipped by readers.
function compacted(overlay: OverlayPart): OverlayRecord[] {
	if (overlay.dropped.size * 2 > overlay.records.length) {
		overlay.records = overlay.records.filter(record => !overlay.dropped.has(record))
		overlay.dropped.clear()
	}

	return overlay.records
}

function recordIndex(records: readonly OverlayRecord[], item: number): number {
	let low = 0
	let high = records.length - 1

	while (low < high) {
		const middle = (low + high + 1) >> 1

		if ((records[middle]?.item ?? 0) <= item) low = middle
		else high = middle - 1
	}

	return low
}

// Whether the source item list of two entries is the same.
function sameRefs(a: readonly number[], b: readonly number[]): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

const NO_BREAKS: readonly number[] = []
const NO_ENTRIES: readonly TopEntry[] = []

// The blocks `entry` lays out, dirty, each in its section: one after a section break inside a content
// control is in the next.
function dirtyBlocks(entry: TopEntry, out: DirtyBlock[], cells = false): void {
	const breaks = entry.breaks ?? NO_BREAKS
	let section = entry.section
	let next = 0

	entry.laid.forEach((laid, k) => {
		while (next < breaks.length && (breaks[next] ?? 0) <= k) {
			section++
			next++
		}

		const items = cells ? entry.cells?.get(laid) : undefined

		out.push(
			items === undefined
				? { section, ref: laid }
				: entry.moved?.has(laid) === true
					? { section, ref: laid, cells: items, moved: true }
					: { section, ref: laid, cells: items }
		)
	})
}

// Whether nothing follows the section break a block ends with (no block, nor markup a content control
// closes with).
function endsLast(part: StoryPart, node: Node): boolean {
	if (node.type === nodes.sdt) {
		const end = node.attrs["end"]

		return (!Array.isArray(end) || end.length === 0) && node.lastChild !== null && endsLast(part, node.lastChild)
	}

	return endsSection(part, node)
}

// The section breaks a top-level block ends sections with, added to `out`.
function sectionEnds(part: StoryPart, node: Node, out: SectionEnd[]): void {
	if (node.type === nodes.sdt) node.forEach(child => sectionEnds(part, child, out))
	else if (endsSection(part, node)) out.push(sectionEndOf(node))
}

// Whether a block other than a content control ends a section: the break of a paragraph from a table cell
// is none (the save leaves it out).
function endsSection(part: StoryPart, node: Node): boolean {
	const sectPr = node.attrs["sectPr"]

	return typeof sectPr === "number" && sectionWritten(part, sectPr, false)
}

// Whether two tables have the same rows and cells (attributes included) and blocks of the same kinds and
// sources in each cell: only paragraph content differs.
function sameStructure(a: Node, b: Node): boolean {
	if (a === b) return true
	if (a.type !== b.type || a.childCount !== b.childCount) return false

	if (a.type === nodes.paragraph) return a.attrs["src"] === b.attrs["src"] && a.attrs["src"] !== -1 && a.sameMarkup(b)
	if (!a.sameMarkup(b)) return false

	for (let k = 0; k < a.childCount; k++) {
		const x = a.child(k)
		const y = b.child(k)

		if (x === y) continue

		if (x.type === nodes.paragraph && y.type === nodes.paragraph) {
			if (x.attrs["src"] !== y.attrs["src"] || (x.attrs["src"] as number) < 0) return false

			continue
		}

		if (!sameStructure(x, y)) return false
	}

	return true
}

// A paragraph changed inside a table: its position relative to the entry, its child indices from the table
// and the block (ref) it is laid out in place of (-1: its source paragraph).
interface ChangedParagraph {
	readonly node: Node
	readonly offset: number
	readonly path: readonly number[]
	base: number
}

// A block written by the edit being applied, waiting to be parsed with the others (slot: its index in the
// entry's lists, -1 for a paragraph inside a table).
interface QueuedBlock {
	readonly entry: TopEntry
	readonly node: Node
	readonly offset: number
	readonly base: number
	readonly bytes: Uint8Array
	readonly slot: number
	// The editing row holding a paragraph of a table laid out with rows of its own.
	readonly holder?: Node | undefined
	// Rows of a table written again, as a table of their own.
	readonly rows?: RowGroup | undefined
}

// Rows of a table (laid out from `table`) written again by an edit: their indices among the editing table's
// rows, their nodes and positions in the entry.
interface RowGroup {
	readonly table: number
	state: TableRows | undefined
	readonly indices: number[]
	readonly nodes: Node[]
	readonly offsets: number[]
}

const NO_RECORDS: readonly OverlayRecord[] = []
// An edit of marks over blocks this large is written for layout later (StoryEdits.catchUp), the paragraphs of
// a long table about STEP_PARAGRAPHS at a time.
const DEFER_SIZE = 16384
const STEP_PARAGRAPHS = 96

// Whether blocks `first`..`last` of `before` and `after` differ in marks alone.
function marksOnly(before: Node, after: Node, first: number, last: number): boolean {
	for (let k = first; k <= last; k++) if (!sameButMarks(before.child(k), after.child(k))) return false

	return true
}

function sameButMarks(a: Node, b: Node): boolean {
	if (a === b) return true
	if (a.content.size !== b.content.size || (a.childCount !== b.childCount && !a.inlineContent)) return false
	// The type and attributes (deeply), not the marks.
	if (!a.hasMarkup(b.type, b.attrs, a.marks)) return false
	if (a.isText) return a.text === b.text

	if (a.inlineContent) {
		if (a.textContent !== b.textContent) return false

		// Inline nodes other than text at the same offsets.
		const leaves: [number, Node][] = []

		a.forEach((child, offset) => {
			if (!child.isText) leaves.push([offset, child])
		})

		let at = 0
		let same = true

		b.forEach((child, offset) => {
			if (!same || child.isText) return

			const other = leaves[at++]

			same = other !== undefined && other[0] === offset && sameButMarks(other[1], child)
		})

		return same && at === leaves.length
	}

	for (let k = 0; k < a.childCount; k++) if (!sameButMarks(a.child(k), b.child(k))) return false

	return true
}

function spanSize(doc: Node, first: number, last: number): number {
	let size = 0

	for (let k = first; k <= last && size < DEFER_SIZE; k++) size += doc.child(k).nodeSize

	return size
}

// Table `node` (`old` as last laid out, the same rows otherwise) with its next rows that differ taken from
// `node`, about STEP_PARAGRAPHS paragraphs of them; `node` itself once that is all of them.
function partlyAdvanced(old: Node, node: Node): Node {
	const count = node.childCount

	if (old.childCount !== count) return node

	let start = 0

	while (start < count && old.child(start) === node.child(start)) start++

	let end = start
	let paragraphs = 0

	// Rows that changed count; those that did not cost nothing to lay out from their own refs.
	while (end < count && paragraphs < STEP_PARAGRAPHS) {
		const row = node.child(end)

		if (row !== old.child(end))
			row.descendants(child => {
				if (child.isTextblock) paragraphs++

				return !child.isTextblock
			})

		end++
	}

	let rest = end

	while (rest < count && old.child(rest) === node.child(rest)) rest++

	if (rest >= count) return node

	const rows: Node[] = []

	for (let k = 0; k < count; k++) rows.push(k < end ? node.child(k) : old.child(k))

	return node.copy(Fragment.fromArray(rows))
}

// A write this large outweighs the root's declarations: finding the prefixes it uses costs more than they do.
const FULL_ROOT_BYTES = 1 << 14
// A merge of overlays: the most parts and blocks per part it takes, and the pages a region spans.
const MERGE_PARTS = 64
const MERGE_RECORDS = 32
const MERGE_PAGES = 12
const NO_MOVED: ReadonlySet<OverlayRecord> = new Set()
const NO_TABLES: readonly TableRows[] = []
const NO_PARAGRAPHS: readonly ChangedParagraph[] = []

// Takes records `gone` out of the entry's.
function keepRecords(entry: TopEntry, gone: ReadonlySet<OverlayRecord>): void {
	const kept = entry.records.filter(record => !gone.has(record))

	entry.records.length = 0
	for (const record of kept) entry.records.push(record)
}

// Paragraphs of `b` that differ from `a` (same structure), with their positions relative to `offset`.
function changedParagraphs(a: Node, b: Node, offset: number, path: readonly number[], out: ChangedParagraph[]): void {
	b.forEach((child, childOffset, index) => {
		const before = a.child(index)

		if (before === child) return

		const at = offset + 1 + childOffset
		const here = [...path, index]

		if (child.type === nodes.paragraph) out.push({ node: child, offset: at, path: here, base: -1 })
		else changedParagraphs(before, child, at, here, out)
	})
}

// Whether two tables have the same rows, cells and blocks (attributes included): only paragraph content
// differs. Unlike sameStructure, blocks match by place, not by source.
function sameShape(a: Node, b: Node): boolean {
	if (a === b) return true
	if (!a.sameMarkup(b)) return false
	if (a.type === nodes.paragraph) return true
	if (a.childCount !== b.childCount) return false

	for (let k = 0; k < a.childCount; k++) if (!sameShape(a.child(k), b.child(k))) return false

	return true
}

// The node at child indices `path` from `node`.
function atPath(node: Node, path: readonly number[]): Node | undefined {
	let at: Node = node

	for (const index of path) {
		if (index >= at.childCount) return undefined

		at = at.child(index)
	}

	return at
}

// The node at child indices `path` from `node`, with its position relative to the position of `node`.
function offsetAtPath(node: Node, path: readonly number[]): { node: Node; offset: number } | undefined {
	let at: Node = node
	let offset = 0

	for (const index of path) {
		if (index >= at.childCount) return undefined

		offset += 1

		for (let k = 0; k < index; k++) offset += at.child(k).nodeSize

		at = at.child(index)
	}

	return { node: at, offset }
}

// Child indices of the textblock with source item `item` inside `node`, or undefined.
function pathOfSource(node: Node, item: number): number[] | undefined {
	for (let k = 0; k < node.childCount; k++) {
		const child = node.child(k)

		if (child.isTextblock) {
			if (child.attrs["src"] === item) return [k]

			continue
		}

		const inner = pathOfSource(child, item)

		if (inner !== undefined) return [k, ...inner]
	}

	return undefined
}

// Child indices of the textblock starting at `offset` inside the content of `node`, or undefined.
function pathAt(node: Node, offset: number): number[] | undefined {
	let pos = 0

	for (let k = 0; k < node.childCount; k++) {
		const child = node.child(k)

		if (offset < pos + child.nodeSize) {
			if (child.isTextblock) return pos === offset ? [k] : undefined

			const inner = pathAt(child, offset - pos - 1)

			return inner === undefined ? undefined : [k, ...inner]
		}

		pos += child.nodeSize
	}

	return undefined
}

// Where `target` sits inside `node` (whose start is `offset`), or undefined.
function offsetOf(node: Node, offset: number, target: Node): number | undefined {
	let found: number | undefined

	node.descendants((child, pos) => {
		if (found !== undefined) return false

		if (child === target) {
			found = offset + 1 + pos

			return false
		}

		return !child.isTextblock
	})

	return found
}

// The textblock with source item `item` inside `node` (itself included when `self`), with its position
// relative to the position of `node`.
function findSource(node: Node, item: number, self = false): { node: Node; offset: number } | undefined {
	if (self && node.isTextblock) return node.attrs["src"] === item ? { node, offset: 0 } : undefined

	let found: { node: Node; offset: number } | undefined

	node.descendants((child, pos) => {
		if (found !== undefined) return false

		if (child.isTextblock) {
			if (child.attrs["src"] === item) found = { node: child, offset: pos + 1 }

			return false
		}

		return true
	})

	return found
}

// Top-level child index at `pos`: the child holding it, or at a boundary the one after (`before`: the one
// before).
function childAt(doc: Node, pos: number, before: boolean): number {
	const clamped = Math.max(0, Math.min(pos, doc.content.size))
	const $pos = doc.resolve(clamped)

	if ($pos.depth > 0) return $pos.index(0)

	return before ? $pos.index(0) - 1 : Math.min($pos.index(0), doc.childCount - 1)
}

// The range of the final document a transaction changed (content, marks or attributes), or undefined when
// nothing changed; `whole` when a step changed the document node itself.
function changedSpan(tr: Transaction): { from: number; to: number; whole: boolean } | undefined {
	let from = Infinity
	let to = -Infinity
	let whole = false

	// Carried forward step by step through the maps that move positions (marks and attributes move none).
	tr.steps.forEach((step, index) => {
		const map = tr.mapping.maps[index]
		let a: number
		let b: number

		if (from !== Infinity && map !== undefined && map !== StepMap.empty) {
			from = map.map(from, -1)
			to = map.map(to, 1)
		}

		const parts = markStepsOf(step)

		if (step instanceof ReplaceStep) {
			a = step.from
			b = step.from + step.slice.size
		} else if (step instanceof ReplaceAroundStep) {
			a = step.from
			b = step.getMap().map(step.to, 1)
		} else if (parts !== undefined) {
			a = Infinity
			b = -Infinity

			for (const part of parts) {
				a = Math.min(a, part.from)
				b = Math.max(b, part.to)
			}
		} else if (step instanceof SetAttrsStep) {
			a = step.from
			b = step.to
		} else if (step instanceof AttrStep || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) {
			a = step.pos
			b = step.pos + 1
		} else {
			whole = true

			return
		}

		from = Math.min(from, a)
		to = Math.max(to, b)
	})

	if (whole) return { from: 0, to: tr.doc.content.size, whole: true }

	return from === Infinity ? undefined : { from, to, whole: false }
}

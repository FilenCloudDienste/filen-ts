import { NodeKind, XmlError, decodeUtf8, encodeUtf8, parseXml, type XmlDocument } from "../../xml/index"
import { Relationships, type Relationship } from "../../opc/index"
import type { DocxEditContext } from "../edit/context"
import type { DocxEditorSession } from "../edit/session"
import type { PagedEditor } from "../paged/editor"
import { Ns } from "../model/namespaces"
import { partReader, type PartReader } from "../model/reader"
import type { StoryPart } from "../model/index"
import { newControlId } from "../forms/controls"
import { planNested } from "../write/nested"
import { COPIED_RELATIONSHIP, cloneRevisionIds, ownedByCopy } from "../write/newStory"
import { namesRelationship, relationshipIdsIn } from "../write/parts/notes"
import { DocxWriteError, StoryWriter, type WriteEnvironment } from "../write/story"

// A header or footer copied into a part of its own, as Word copies the one a section showed when the section
// is unlinked from the previous one: everything it holds (pictures, drawings, fields, content controls,
// content kept as bytes) with the relationships they use. What must be unique in a document is made new
// (drawing ids, revision ids, content control ids, VML shape ids with the embedded objects naming them and
// their object ids, as Word renumbers a pasted object) or left out (paragraph ids, which Word makes again;
// bookmarks, comment anchors and permission ranges, which stay with the original).

// What a part made from another holds: its bytes and the relationships (ids as in the bytes) it keeps.
export interface StoryTemplate {
	readonly bytes: Uint8Array
	readonly relationships: Relationships
	// A copied note: the notes part it was copied from (the save asks whether that part still uses what the copy
	// owns, write/save.ts).
	readonly from?: StoryPart
}

// Left out of a copy (the original keeps them).
const LEFT_OUT: ReadonlySet<string> = new Set([
	"bookmarkStart",
	"bookmarkEnd",
	"commentRangeStart",
	"commentRangeEnd",
	"commentReference",
	"permStart",
	"permEnd"
])

// Revision elements whose w:id a copy makes new; ranges keep their start and end paired.
const REVISIONS: ReadonlySet<string> = new Set([
	"ins",
	"del",
	"moveFrom",
	"moveTo",
	"rPrChange",
	"pPrChange",
	"sectPrChange",
	"tblPrChange",
	"trPrChange",
	"tcPrChange",
	"tblGridChange",
	"tblPrExChange",
	"numberingChange",
	"cellIns",
	"cellDel",
	"cellMerge"
])
const RANGES = /^(moveFromRange|moveToRange|customXmlInsRange|customXmlDelRange|customXmlMoveFromRange|customXmlMoveToRange)(Start|End)$/

// Placeholders the writer leaves where a save still has to place something (stories/sections.ts, the layout's
// pictures and links): a story holding them cannot be written alone.
const PLACEHOLDERS = /filenStory\d|filenMedia\d|filenPlannedLink\d/

// VML elements that are shapes (a v:shapetype's id is what shapes name in their type: it stays).
const VML_SHAPES: ReadonlySet<string> = new Set([
	"shape",
	"rect",
	"roundrect",
	"oval",
	"line",
	"polyline",
	"curve",
	"arc",
	"image",
	"group"
])

// The largest numbers ending the VML shape ids (id, o:spid) and embedded object ids (o:OLEObject ObjectID) of a
// document, read once, then counted on as copies take new ones.
const VML_COUNTERS = new WeakMap<DocxEditContext, { shape: number; object: number }>()

function trailingNumber(value: string): number {
	const digits = /\d+$/.exec(value)?.[0]

	return digits === undefined || digits.length > 12 ? 0 : Number(digits)
}

function vmlCounters(context: DocxEditContext): { shape: number; object: number } {
	let found = VML_COUNTERS.get(context)

	if (found !== undefined) return found

	found = { shape: 0, object: 0 }

	for (const part of context.model.parts) {
		const document = part?.document

		if (document === undefined) continue

		const reader = part?.reader ?? partReader(document)

		for (let node = 0; node < document.count; node++) {
			if (document.kinds[node] !== NodeKind.Element) continue

			const group = reader.group(node)

			if (group === Ns.V && VML_SHAPES.has(document.localName(node))) {
				found.shape = Math.max(
					found.shape,
					trailingNumber(reader.attr(node, Ns.None, "id") ?? ""),
					trailingNumber(reader.attr(node, Ns.O, "spid") ?? "")
				)
			} else if (group === Ns.O && document.localName(node) === "OLEObject") {
				found.object = Math.max(found.object, trailingNumber(reader.attr(node, Ns.None, "ObjectID") ?? ""))
			}
		}
	}

	VML_COUNTERS.set(context, found)

	return found
}

// `value` with the number ending it (or a number added) made `next`.
function renumbered(value: string, next: number): string {
	return `${value.replace(/\d+$/, "")}${String(next)}`
}

interface Edit {
	readonly from: number
	readonly to: number
	readonly text: string
}

// The story's root element as a save would write it now: its source bytes where neither it nor a text box in
// it (`textboxes`, their sessions) is edited, else the writer's output, the text boxes written into it as a save
// writes them (undefined when it holds something only a save can place: a new picture, list or link).
function storyBytes(
	context: DocxEditContext,
	part: StoryPart,
	item: number,
	session: DocxEditorSession | undefined,
	textboxes: readonly DocxEditorSession[]
): Uint8Array | undefined {
	const document = part.document
	const node = part.node(item)
	const edited = (candidate: DocxEditorSession): boolean => candidate.state.doc !== candidate.story.doc

	if (session === undefined || (!edited(session) && !textboxes.some(edited)))
		return document.bytes.subarray(document.start(node), document.end(node))

	// Ids written here are made new below; these only keep them apart.
	let revision = Math.max(0, context.model.maxIds.revision) + 1_000_000
	const sessions = [session, ...textboxes]
	const nested = planNested(
		sessions.map(candidate => candidate.story),
		{ next: space => (space === "revision" ? ++revision : context.ids.next(space)) }
	)
	const env: WriteEnvironment = {
		context,
		nextRevisionId: () => ++revision,
		numId: () => {
			throw new DocxWriteError("unsupported", "A new list in a copied story")
		},
		hyperlink: () => {
			throw new DocxWriteError("unsupported", "A new hyperlink in a copied story")
		},
		...(nested === undefined ? {} : { nested: nested.nested })
	}

	try {
		// Text boxes first, innermost first: each takes the place of its container in what holds it.
		for (const index of nested?.order ?? []) {
			const inner = sessions[index]

			if (inner !== undefined && nested?.inner(index) === true)
				nested.record(index, new StoryWriter(env, inner.story).draftStorySync(inner.state.doc))
		}

		const bytes = new StoryWriter(env, session.story).draftStorySync(session.state.doc).out.finish()

		return PLACEHOLDERS.test(decodeUtf8(bytes)) ? undefined : bytes
	} catch (error) {
		if (error instanceof DocxWriteError) return undefined

		throw error
	}
}

// The value span of attribute {group}local of `node` with the span of the whole attribute (its leading space
// included), or undefined.
function attributeSpan(
	reader: PartReader,
	document: XmlDocument,
	node: number,
	group: Ns,
	local: string
): { readonly from: number; readonly to: number; readonly value: [number, number] } | undefined {
	const value = new Int32Array(2)

	if (!reader.find(node, group, local, value)) return undefined

	const spans = document.attributeSpans(node)
	const bytes = document.bytes

	for (let k = 0; k < spans.length; k += 4) {
		if (spans[k + 2] !== value[0]) continue

		let from = spans[k] ?? 0

		while (from > 0 && (bytes[from - 1] === 0x20 || bytes[from - 1] === 0x09 || bytes[from - 1] === 0x0a || bytes[from - 1] === 0x0d))
			from--

		return { from, to: (spans[k + 3] ?? 0) + 1, value: [value[0] ?? 0, value[1] ?? 0] }
	}

	return undefined
}

// What a copy changes in the story's markup, in document order.
// `relink`: relationship ids the copy names otherwise (a part it owns, copied with it), in every attribute that
// names a relationship as the save reads them (write/parts/notes.ts namesRelationship).
function cloneEdits(context: DocxEditContext, document: XmlDocument, relink?: ReadonlyMap<string, string>): Edit[] {
	const reader = partReader(document)
	const relinked = relink !== undefined && relink.size > 0 ? relink : undefined
	const edits: Edit[] = []
	const ranges = new Map<string, number>()
	// Move range names made new, old to new: a move's two halves in the copy share one, apart from the original's.
	const moves = new Map<string, string>()
	// VML shape ids made new, old to new: an embedded object names its shape by them.
	const shapes = new Map<string, string>()
	let skipTo = -1
	const replace = (node: number, group: Ns, local: string, text: (value: string) => string | undefined): void => {
		const span = attributeSpan(reader, document, node, group, local)
		const made = span === undefined ? undefined : text(decodeUtf8(document.bytes, span.value[0], span.value[1]))

		if (span !== undefined && made !== undefined) edits.push({ from: span.value[0], to: span.value[1], text: made })
	}

	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element || document.start(node) < skipTo) continue

		const group = reader.group(node)
		const local = document.localName(node)

		if (relinked !== undefined) {
			const spans = document.attributeSpans(node)

			for (let k = 0; k < spans.length; k += 4) {
				if (!namesRelationship(reader.namespaces, node, decodeUtf8(document.bytes, spans[k] ?? 0, spans[k + 1] ?? 0))) continue

				const from = spans[k + 2] ?? 0
				const to = spans[k + 3] ?? 0
				const made = relinked.get(decodeUtf8(document.bytes, from, to))

				if (made !== undefined) edits.push({ from, to, text: made })
			}
		}

		if (group === Ns.WP && local === "docPr") {
			const id = attributeSpan(reader, document, node, Ns.None, "id")

			if (id !== undefined) edits.push({ from: id.value[0], to: id.value[1], text: String(context.ids.next("docPr")) })

			continue
		}

		if (group === Ns.V && VML_SHAPES.has(local)) {
			const counters = vmlCounters(context)

			for (const [space, name] of [
				[Ns.None, "id"],
				[Ns.O, "spid"]
			] as const)
				replace(node, space, name, value => {
					const made = renumbered(value, ++counters.shape)

					shapes.set(value, made)

					return made
				})

			continue
		}

		if (group === Ns.O && local === "OLEObject") {
			const counters = vmlCounters(context)

			replace(node, Ns.None, "ShapeID", value => shapes.get(value))
			replace(node, Ns.None, "ObjectID", value => renumbered(value === "" ? "_" : value, ++counters.object))

			continue
		}

		if (group !== Ns.W) continue

		// A content control's w:id is the document's alone (Word gives a pasted control a new one).
		if (local === "id" && reader.is(document.parent(node), Ns.W, "sdtPr")) {
			const value = attributeSpan(reader, document, node, Ns.W, "val")

			if (value !== undefined) edits.push({ from: value.value[0], to: value.value[1], text: newControlId() })

			continue
		}

		if (LEFT_OUT.has(local)) {
			edits.push({ from: document.start(node), to: document.end(node), text: "" })
			skipTo = document.end(node)

			continue
		}

		if (local === "p" || local === "tr") {
			for (const name of ["paraId", "textId"]) {
				const attribute = attributeSpan(reader, document, node, Ns.W14, name)

				if (attribute !== undefined) edits.push({ from: attribute.from, to: attribute.to, text: "" })
			}

			continue
		}

		const range = RANGES.exec(local)

		if (range === null && !REVISIONS.has(local)) continue

		const id = attributeSpan(reader, document, node, Ns.W, "id")

		if (id === undefined) continue

		let next: number

		if (range === null) {
			next = cloneRevisionIds(context, 1)
		} else {
			// A range's end takes the id its start got.
			const key = `${range[1] ?? ""}:${decodeUtf8(document.bytes, id.value[0], id.value[1])}`
			const known = ranges.get(key)

			next = known ?? cloneRevisionIds(context, 1)
			ranges.set(key, next)

			// Named as the editor names a move it records (review/track.ts).
			if (range[2] === "Start" && (range[1] === "moveFromRange" || range[1] === "moveToRange"))
				replace(node, Ns.W, "name", value => {
					const made = moves.get(value) ?? `move${String(next)}`

					moves.set(value, made)

					return made
				})
		}

		edits.push({ from: id.value[0], to: id.value[1], text: String(next) })
	}

	// Attribute edits of one start tag come in attribute order; elements left out never overlap them.
	return edits.sort((a, b) => a.from - b.from)
}

function spliced(bytes: Uint8Array, edits: readonly Edit[]): Uint8Array {
	const pieces: Uint8Array[] = []
	let at = 0
	let length = 0

	for (const edit of edits) {
		if (edit.from < at) continue

		const kept = bytes.subarray(at, edit.from)
		const text = encodeUtf8(edit.text)

		pieces.push(kept, text)
		length += kept.length + text.length
		at = edit.to
	}

	const rest = bytes.subarray(at)

	pieces.push(rest)
	length += rest.length

	const out = new Uint8Array(length)
	let offset = 0

	for (const piece of pieces) {
		out.set(piece, offset)
		offset += piece.length
	}

	return out
}

// The part a copy of header or footer story `item` of `part` makes: the part's prolog and the story as it is
// now (`session`'s document when one edits it, with the sessions of the text boxes in it, `textboxes`), made new
// where a document needs it unique. Undefined when the story cannot be written alone (see storyBytes) or its
// markup does not read.
export function cloneStory(
	context: DocxEditContext,
	part: StoryPart,
	item: number,
	session: DocxEditorSession | undefined,
	textboxes: readonly DocxEditorSession[] = []
): StoryTemplate | undefined {
	const story = storyBytes(context, part, item, session, textboxes)

	if (story === undefined) return undefined

	const source = part.document
	const prolog = source.bytes.subarray(0, source.start(source.documentElement()))
	const whole = new Uint8Array(prolog.length + story.length)

	whole.set(prolog, 0)
	whole.set(story, prolog.length)

	let document: XmlDocument

	try {
		document = parseXml(whole)
	} catch (error) {
		if (error instanceof XmlError) return undefined

		throw error
	}

	return { bytes: spliced(whole, cloneEdits(context, document)), relationships: part.relationships }
}

const COPIED_RELATIONSHIPS = new WeakMap<DocxEditContext, number>()

// A copy of note story `item` of notes part `part`, as Word copies a pasted note's content: the part's root
// around the note (now note `id`), made new where a document needs it unique as cloneStory makes a header,
// what it holds as bytes kept; the parts it owns (charts, embedded objects) named by relationships of their own,
// which the save makes copies of. With `into` (another notes part: a note converted to `kind`), its root around
// the note, the note element of that kind, and a placeholder for each relationship the note names (the save
// relates `into` to the same targets). Undefined where the note cannot be written alone (see storyBytes) or `into` binds a prefix it uses
// otherwise.
export function cloneNote(
	context: DocxEditContext,
	part: StoryPart,
	item: number,
	id: string,
	session: DocxEditorSession | undefined,
	textboxes: readonly DocxEditorSession[] = [],
	into?: { readonly part: StoryPart; readonly kind: "footnote" | "endnote" }
): StoryTemplate | undefined {
	const story = storyBytes(context, part, item, session, textboxes)

	if (story === undefined) return undefined

	const own = wrapped(part, story)

	if (own === undefined) return undefined

	const target = into === undefined || into.part === part ? undefined : into
	const document = target === undefined ? own : wrapped(target.part, story)

	if (document === undefined || (target !== undefined && !sameBindings(own, document))) return undefined

	const pkg = context.model.package
	const relink = new Map<string, string>()
	const added: Relationship[] = []
	let counter = COPIED_RELATIONSHIPS.get(context) ?? 0

	// Only what the note names gets a copy's placeholder: a converted note relates `into` to those targets alone.
	for (const name of relationshipIdsIn(document)) {
		const relationship = part.relationships.byId(name)

		if (relationship === undefined || (target === undefined && !ownedByCopy(relationship, pkg))) continue

		const copy = `${COPIED_RELATIONSHIP}${String(++counter)}`

		relink.set(relationship.id, copy)
		added.push({ ...relationship, id: copy })
	}

	COPIED_RELATIONSHIPS.set(context, counter)

	const note = document.firstChildElement(document.documentElement())
	const reader = partReader(document)
	const ownId = note < 0 ? undefined : attributeSpan(reader, document, note, Ns.W, "id")

	if (ownId === undefined) return undefined

	const edits: Edit[] = [{ from: ownId.value[0], to: ownId.value[1], text: id }, ...cloneEdits(context, document, relink)]

	// A note converted: its element of the other kind.
	if (target !== undefined && document.localName(note) !== target.kind) {
		const name = document.name(note)
		const renamed = `${name.slice(0, name.length - document.localName(note).length)}${target.kind}`

		edits.push({ from: document.start(note) + 1, to: document.start(note) + 1 + name.length, text: renamed })

		if (!document.isSelfClosing(note)) edits.push({ from: document.contentEnd(note) + 2, to: document.end(note) - 1, text: renamed })
	}

	return {
		bytes: spliced(
			document.bytes,
			edits.sort((a, b) => a.from - b.from)
		),
		relationships: added.length === 0 ? part.relationships : new Relationships([...part.relationships.all, ...added]),
		from: part
	}
}

// Story markup `story` inside the root of `part` (its prolog and start tag), parsed; undefined where it does not
// read.
function wrapped(part: StoryPart, story: Uint8Array): XmlDocument | undefined {
	const source = part.document
	const root = source.documentElement()
	const open = source.bytes.subarray(0, source.openEnd(root))
	const close = encodeUtf8(`</${source.name(root)}>`)
	const whole = new Uint8Array(open.length + story.length + close.length)

	whole.set(open, 0)
	whole.set(story, open.length)
	whole.set(close, open.length + story.length)

	try {
		return parseXml(whole)
	} catch (error) {
		if (error instanceof XmlError) return undefined

		throw error
	}
}

// Whether the story under the root of `other` reads every prefix it uses as under the root of `own`.
function sameBindings(own: XmlDocument, other: XmlDocument): boolean {
	const a = partReader(own).namespaces
	const b = partReader(other).namespaces
	const ownNote = own.firstChildElement(own.documentElement())
	const otherNote = other.firstChildElement(other.documentElement())

	if (ownNote < 0 || otherNote < 0) return false

	// The two parse alike: the note's nodes are at the same offsets from its start.
	const shift = own.start(ownNote) - other.start(otherNote)

	for (let node = otherNote; node < other.count && other.start(node) < other.end(otherNote); node++) {
		if (other.kinds[node] !== NodeKind.Element) continue

		const mirror = nodeAtStart(own, other.start(node) + shift)

		if (mirror < 0) return false

		const prefixes = [other.prefix(node)]

		for (const attribute of other.attributes(node)) {
			const colon = attribute.name.indexOf(":")

			if (colon > 0) prefixes.push(attribute.name.slice(0, colon))
		}

		for (const prefix of prefixes)
			if (prefix !== "xmlns" && prefix !== "xml" && a.uri(mirror, prefix) !== b.uri(node, prefix)) return false
	}

	return true
}

// The element of `document` starting at byte `at`, or -1.
function nodeAtStart(document: XmlDocument, at: number): number {
	let low = 0
	let high = document.count

	while (low < high) {
		const middle = (low + high) >> 1

		if (document.start(middle) < at) low = middle + 1
		else high = middle
	}

	return low < document.count && document.start(low) === at ? low : -1
}

// The sessions a copy of story `story` is written from as it is now: its own (where it has one) and those of the
// text boxes in it; a text box edited is written into the story holding it, so that story's session writes it.
export function copySessions(
	editor: PagedEditor,
	story: number
): { readonly session: DocxEditorSession | undefined; readonly textboxes: readonly DocxEditorSession[] } {
	const stories = editor.edits.model.stories
	const within = (candidate: number): boolean => {
		for (let at = stories[candidate]?.parent ?? -1; at >= 0; at = stories[at]?.parent ?? -1) if (at === story) return true

		return false
	}
	const textboxes = editor.sessions.filter(candidate => candidate.story.story.kind === "textbox" && within(candidate.story.story.index))
	const edited = textboxes.some(candidate => candidate.state.doc !== candidate.story.doc)
	const session = edited ? editor.storySession(story) : editor.sessions.find(candidate => candidate.story.story.index === story)

	return { session, textboxes }
}

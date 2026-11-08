import type { Node } from "prosemirror-model"
import type { StoryDoc } from "../../edit/build"
import type { DocxEditContext } from "../../edit/context"
import { NO_SOURCE, docxSchema } from "../../edit/schema"
import type { DocxEditorSession } from "../../edit/session"
import { Item, type StoryPart } from "../../model/index"
import type { SliceClock } from "../../../opc/index"
import { NodeKind, decodeUtf8, encodeUtf8, parseXml } from "../../../xml/index"
import { partReader } from "../../model/reader"
import { W_NAMESPACE } from "../source"
import { DocxWriteError } from "../values"
import type { PartContributor, SaveParts, WrittenStories } from "./index"

// Footnotes and endnotes parts. A new note's w:footnote / w:endnote (its id) is appended to its part (the
// document's, or one the save makes from a template holding Word's separator notes); a source note whose
// every reference the edits deleted leaves its part, as Word deletes a note with its reference. Separator
// notes are never touched.

const nodes = docxSchema.nodes

type NoteKind = "footnote" | "endnote"

// Parts holding a copied note (stories/clone.ts cloneNote, laid out from a part of its own): the notes part the
// save writes the copy into, and the one it was copied from.
const NOTE_COPIES = new WeakMap<StoryPart, { readonly into: StoryPart; readonly from: StoryPart | undefined }>()

export function registerNoteCopy(copy: StoryPart, into: StoryPart, from: StoryPart | undefined): void {
	NOTE_COPIES.set(copy, { into, from })
}

// The notes part a copied note's part is written into, if `part` holds one.
export function noteCopyTarget(part: StoryPart): StoryPart | undefined {
	return NOTE_COPIES.get(part)?.into
}

// The notes part a copied note's part was copied from, if `part` holds one.
export function noteCopySource(part: StoryPart): StoryPart | undefined {
	return NOTE_COPIES.get(part)?.from
}

function prefixOf(part: StoryPart): string {
	const prefix = part.reader.namespaces.prefixFor(part.document.documentElement(), W_NAMESPACE)

	if (prefix === undefined) throw new DocxWriteError("unsupported", `${part.name} does not bind WordprocessingML`)

	return prefix
}

function qualified(prefix: string, local: string): string {
	return prefix === "" ? local : `${prefix}:${local}`
}

// A new note's container, appended to its part.
function container(story: StoryDoc) {
	const own = story.story
	const kind = own.kind

	// A copied note is a story of a part of its own (noteCopyTarget): new to the notes part it goes into.
	const target = noteCopyTarget(story.part)

	if ((kind !== "footnote" && kind !== "endnote") || (own.item >= 0 && target === undefined) || own.id === undefined) return undefined
	if (!/^\d{1,10}$/.test(own.id) || Number(own.id) < 1) throw new DocxWriteError("missingSource", `A new ${kind} without an id`)

	const part = target ?? story.part
	const document = part.document
	const prefix = prefixOf(part)
	const tag = qualified(prefix, kind)

	return {
		open: `<${tag} ${qualified(prefix, "id")}="${own.id}">`,
		close: `</${tag}>`,
		at: document.contentEnd(document.documentElement())
	}
}

const R_URIS: ReadonlySet<string> = new Set([
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	"http://purl.oclc.org/ooxml/officeDocument/relationships"
])
const O_URI = "urn:schemas-microsoft-com:office:office"

// Whether attribute `name` of element `node` names a relationship: one of the relationships namespace, or VML's
// o:relid (v:imagedata, v:fill).
function namesRelationship(namespaces: ReturnType<typeof partReader>["namespaces"], node: number, name: string): boolean {
	const colon = name.indexOf(":")

	if (colon <= 0 || name.startsWith("xmlns")) return false

	const uri = namespaces.uri(node, name.slice(0, colon)) ?? ""

	return R_URIS.has(uri) || (uri === O_URI && name.slice(colon + 1) === "relid")
}

// The values of attributes naming relationships (namesRelationship) in markup `bytes` written for `part` (whose root
// declares what it uses), each a relationship id, with the byte span of the value: [from, to] by id.
export function relationshipUses(part: StoryPart, bytes: Uint8Array): Map<string, number[]> {
	const document = part.document
	const root = document.documentElement()
	const open = document.bytes.subarray(document.start(root), document.openEnd(root))
	const close = encodeUtf8(`</${document.name(root)}>`)
	const whole = new Uint8Array(open.length + bytes.length + close.length)

	whole.set(open, 0)
	whole.set(bytes, open.length)
	whole.set(close, open.length + bytes.length)

	const parsed = parseXml(whole)
	const namespaces = partReader(parsed).namespaces
	const out = new Map<string, number[]>()

	for (let node = 0; node < parsed.count; node++) {
		if (parsed.kinds[node] !== NodeKind.Element) continue

		const spans = parsed.attributeSpans(node)

		for (let k = 0; k < spans.length; k += 4) {
			if (!namesRelationship(namespaces, node, decodeUtf8(whole, spans[k] ?? 0, spans[k + 1] ?? 0))) continue

			const from = (spans[k + 2] ?? 0) - open.length
			const to = (spans[k + 3] ?? 0) - open.length

			if (from < 0 || to > bytes.length) continue

			const id = decodeUtf8(bytes, from, to)
			const list = out.get(id)

			if (list === undefined) out.set(id, [from, to])
			else list.push(from, to)
		}
	}

	return out
}

// The relationship ids a whole part's markup `bytes` names (namesRelationship).
export function relationshipIdsOf(bytes: Uint8Array): Set<string> {
	const parsed = parseXml(bytes)
	const namespaces = partReader(parsed).namespaces
	const out = new Set<string>()

	for (let node = 0; node < parsed.count; node++) {
		if (parsed.kinds[node] !== NodeKind.Element) continue

		const spans = parsed.attributeSpans(node)

		for (let k = 0; k < spans.length; k += 4) {
			if (namesRelationship(namespaces, node, decodeUtf8(bytes, spans[k] ?? 0, spans[k + 1] ?? 0)))
				out.add(decodeUtf8(bytes, spans[k + 2] ?? 0, spans[k + 3] ?? 0))
		}
	}

	return out
}

type References = Readonly<Record<NoteKind, ReadonlyMap<string, readonly number[]>>>

// The note references among a story part's items, by kind and note id (read once per part).
const REFERENCES = new WeakMap<StoryPart, References>()

function referencesOf(part: StoryPart): References {
	const steps = referenceSteps(part)

	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value
	}
}

// Items looked at between looks at the clock.
const ITEM_STEP = 16_384

// referencesOf a step at a time.
function* referenceSteps(part: StoryPart): Generator<void, References> {
	const known = REFERENCES.get(part)

	if (known !== undefined) return known

	const footnote = new Map<string, number[]>()
	const endnote = new Map<string, number[]>()

	for (let item = 0; item < part.count; item++) {
		if (item % ITEM_STEP === ITEM_STEP - 1) yield

		const kind = part.kinds[item]
		const map = kind === Item.FootnoteReference ? footnote : kind === Item.EndnoteReference ? endnote : undefined
		const id = map === undefined ? undefined : part.id(item)

		if (map === undefined || id === undefined) continue

		const list = map.get(id)

		if (list === undefined) map.set(id, [item])
		else list.push(item)
	}

	const found = { footnote, endnote }

	REFERENCES.set(part, found)

	return found
}

// What a story document holds of note references: those its note_ref nodes make ("kind:id"), and the source
// ranges written as their bytes (atoms, locked blocks), which keep whatever reference is inside them.
interface HeldReferences {
	readonly ids: ReadonlySet<string>
	readonly ranges: readonly number[]
}

const HELD = new WeakMap<Node, HeldReferences>()

function heldBy(doc: Node, part: StoryPart): HeldReferences {
	const steps = heldSteps(doc, part)

	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value
	}
}

// Nodes looked at between looks at the clock.
const HELD_STEP = 2048

// heldBy a step at a time (a long document's body is long to walk).
function* heldSteps(doc: Node, part: StoryPart): Generator<void, HeldReferences> {
	const known = HELD.get(doc)

	if (known !== undefined) return known

	const ids = new Set<string>()
	const ranges: number[] = []
	const stack: Node[] = [doc]
	let seen = 0

	while (stack.length > 0) {
		const parent = stack.pop() as Node

		for (let k = 0; k < parent.childCount; k++) {
			const node = parent.child(k)

			if (node.type === nodes.note_ref) {
				ids.add(`${String(node.attrs["kind"])}:${String(node.attrs["id"])}`)

				continue
			}

			const own: unknown = node.attrs["src"]

			if ((node.isAtom || node.type === nodes.locked_block) && typeof own === "number" && own !== NO_SOURCE) {
				ranges.push(own, part.end(own))

				continue
			}

			if (!node.isLeaf) stack.push(node)
		}

		if (++seen % HELD_STEP === 0) yield
	}

	const held = { ids, ranges }

	HELD.set(doc, held)

	return held
}

// The written stories' note references read ahead in slices of `clock`, as orphanedNotes reads them.
export async function readNoteReferences(
	context: DocxEditContext,
	sessions: readonly DocxEditorSession[],
	docs: readonly Node[],
	clock: SliceClock
): Promise<void> {
	if (context.model.footnotes.size === 0 && context.model.endnotes.size === 0) return

	const drive = async (steps: Generator<void, unknown>): Promise<void> => {
		for (;;) {
			const step = steps.next()

			if (step.done === true) return
			if (clock.due) await clock.pause()
		}
	}

	for (const part of context.model.parts) if (part !== undefined) await drive(referenceSteps(part))

	for (const [k, session] of sessions.entries()) {
		const story = session.story.story

		if (story.kind === "footnote" || story.kind === "endnote" || story.kind === "comment" || story.item < 0) continue

		await drive(heldSteps(docs[k] ?? session.state.doc, session.story.part))
	}
}

function holds(held: HeldReferences, items: readonly number[]): boolean {
	for (const item of items) {
		for (let k = 0; k < held.ranges.length; k += 2) if (item >= (held.ranges[k] ?? 0) && item < (held.ranges[k + 1] ?? 0)) return true
	}

	return false
}

// Source notes the edits took every reference of (in the stories the save writes), by part: the save cuts them
// out. A reference a paste or an undo put back, anywhere the save writes, keeps its note.
export function orphanedNotes(
	context: DocxEditContext,
	sessions: readonly DocxEditorSession[],
	docs: readonly Node[]
): Map<StoryPart, number[]> {
	const out = new Map<StoryPart, number[]>()
	const model = context.model

	if (model.footnotes.size === 0 && model.endnotes.size === 0) return out

	// The stories that may hold references, written, by part.
	const written = new Map<number, { doc: Node; part: StoryPart }[]>()

	sessions.forEach((session, k) => {
		const story = session.story.story

		if (story.kind === "footnote" || story.kind === "endnote" || story.kind === "comment" || story.item < 0) return

		const list = written.get(story.part) ?? []

		list.push({ doc: docs[k] ?? session.state.doc, part: session.story.part })
		written.set(story.part, list)
	})

	const referencedAnywhere = (key: string): boolean => {
		for (const list of written.values()) for (const entry of list) if (heldBy(entry.doc, entry.part).ids.has(key)) return true

		return false
	}

	for (const kind of ["footnote", "endnote"] as const) {
		for (const [id, story] of kind === "footnote" ? model.footnotes : model.endnotes) {
			if (story.noteType !== "normal" || story.item < 0) continue

			const key = `${kind}:${id}`
			let found = false
			let referenced = false

			for (const [index, part] of model.parts.entries()) {
				const items = referencesOf(part)[kind].get(id)

				if (items === undefined) continue

				found = true

				// A part none of whose stories is written keeps its references; a written story keeps those in
				// bytes it copies.
				const entries = written.get(index)

				if (entries === undefined || entries.some(entry => holds(heldBy(entry.doc, entry.part), items))) {
					referenced = true

					break
				}
			}

			if (!found || referenced || referencedAnywhere(key)) continue

			const part = model.parts[story.part]

			if (part === undefined) continue

			const list = out.get(part)

			if (list === undefined) out.set(part, [story.item])
			else list.push(story.item)
		}
	}

	return out
}

export const noteParts: PartContributor = {
	container,
	removed: (parts: SaveParts, written: Omit<WrittenStories, "stories">) => orphanedNotes(parts.context, written.sessions, written.docs)
}

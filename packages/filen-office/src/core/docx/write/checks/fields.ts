import type { Node } from "prosemirror-model"
import { runSliced, type SliceClock } from "../../../slicing"
import { NodeKind, type XmlDocument } from "../../../xml/index"
import { NO_SOURCE, docxSchema } from "../../edit/schema"
import { MAX_BOOKMARK_NAME } from "../../fields/bookmarks"
import { FieldCharType, Item, type StoryPart } from "../../model/index"
import { Ns } from "../../model/namespaces"
import { partReader } from "../../model/reader"
import { DocxVerifyError } from "../failure"
import type { CheckedPart, CheckInput, DocxCheck } from "./index"

// Fields and bookmarks of a save hold together. In the markup a save rewrote: field characters pair up and
// field codes stay in their paragraph (no more of either fault than the source part had: a code over a
// paragraph mark hides the text after it), a new bookmark start has its end and a name of at most 40 characters
// that no other bookmark written has (a document's names are unique: ECMA-376 Part 1 §17.13.6.2), and a
// bookmark end the save added has its start written. A field character Word was asked to update (w:dirty)
// keeps the flag wherever the field it begins is still there: as many are
// written as the editor's documents still hold. A REF or PAGEREF naming a bookmark the document no longer has
// is let through: a user may delete a bookmark a field refers to, and Word keeps such a field (an update shows
// "Error! Bookmark not defined."); a bookmark the editor holds and the writer lost fails the paragraph
// read-back instead.

const nodes = docxSchema.nodes
const DIRTY = new Set(["true", "1", "on"])

interface Markup {
	readonly unmatched: number
	// Bookmark starts (lower-case name, w:id, name as written) and end ids.
	readonly starts: readonly (readonly [string, string, string])[]
	readonly ends: readonly string[]
	// fldChar begins with w:dirty.
	readonly dirty: number
	// Field codes running past their paragraph (a begin whose separate, or end without one, is in another).
	readonly spanning: number
}

// The field characters of a source part, by item (read once per part).
const SOURCE_CHARS = new WeakMap<StoryPart, Int32Array>()

// Items looked at between yields.
const ITEM_STEP = 65536

function* sourceChars(part: StoryPart): Generator<void, Int32Array> {
	let found = SOURCE_CHARS.get(part)

	if (found === undefined) {
		const out: number[] = []

		for (let item = 0; item < part.count; item++) {
			if (part.kinds[item] === Item.FieldChar) out.push(item)
			if (item % ITEM_STEP === ITEM_STEP - 1) yield
		}

		found = Int32Array.from(out)
		SOURCE_CHARS.set(part, found)
	}

	return found
}

// The source copies a skeleton's placeholders stand for, in order: `trusted` entries of the stories written
// (four numbers each, the source byte range at 2 and 3).
interface Copies {
	readonly part: StoryPart
	readonly trusted: readonly number[]
}

// What the markup of `document` holds. A skeleton's placeholders count the field characters of the source
// they copy (a field spanning paragraphs may be partly rewritten), nothing else of theirs.
function readMarkup(document: XmlDocument, copies?: Copies): Markup {
	const steps = readMarkupSteps(document, copies)

	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value
	}
}

// Nodes read between looks at the clock.
const MARKUP_STEP = 1024

// readMarkup a step at a time (a whole source part, read once, is long).
function* readMarkupSteps(document: XmlDocument, copies?: Copies): Generator<void, Markup> {
	const reader = partReader(document)
	// Per field open, its begin's paragraph while its code is still being read (no separate yet), else -1.
	const open: number[] = []
	const starts: [string, string, string][] = []
	const ends: string[] = []
	let unmatched = 0
	let dirty = 0
	let spanning = 0
	const paragraphOf = (node: number): number => {
		let at = document.parent(node)

		while (at >= 0 && !(reader.group(at) === Ns.W && document.localName(at) === "p")) at = document.parent(at)

		return at
	}

	// A field character in paragraph `paragraph` (a copied source paragraph's is told apart by its negative id).
	const fieldChar = (type: string | undefined, paragraph: number): void => {
		const last = open.length - 1

		if (type === "begin") {
			open.push(paragraph)
		} else if (type === "separate" && last >= 0 && (open[last] ?? -1) !== -1) {
			if (paragraph !== open[last]) spanning++

			open[last] = -1
		} else if (type === "end" && last >= 0) {
			if ((open[last] ?? -1) !== -1 && paragraph !== open[last]) spanning++

			open.pop()
		} else {
			unmatched++
		}
	}
	const chars = copies === undefined ? undefined : yield* sourceChars(copies.part)
	let copy = 0

	for (let node = 0; node < document.count; node++) {
		if (node % MARKUP_STEP === MARKUP_STEP - 1) yield

		if (document.kinds[node] !== NodeKind.Element) continue

		if (copies !== undefined && chars !== undefined && document.name(node) === "_") {
			const part = copies.part
			const from = copies.trusted[copy * 4 + 2] ?? 0
			const to = copies.trusted[copy * 4 + 3] ?? 0
			let low = 0
			let high = chars.length

			copy++

			while (low < high) {
				const mid = (low + high) >> 1

				if (part.start(chars[mid] ?? 0) < from) low = mid + 1
				else high = mid
			}

			for (let k = low; k < chars.length && part.start(chars[k] ?? 0) < to; k++) {
				const item = chars[k] ?? 0
				const type = part.fieldCharType(item)
				let paragraph = item

				while (paragraph >= 0 && part.kinds[paragraph] !== Item.Paragraph) paragraph = part.parent(paragraph)

				fieldChar(
					type === FieldCharType.Begin
						? "begin"
						: type === FieldCharType.Separate
							? "separate"
							: type === FieldCharType.End
								? "end"
								: undefined,
					-2 - paragraph
				)
			}

			continue
		}

		if (reader.group(node) !== Ns.W) continue

		switch (document.localName(node)) {
			case "fldChar": {
				const type = reader.attr(node, Ns.W, "fldCharType")

				fieldChar(type, paragraphOf(node))

				if (type === "begin" && DIRTY.has(reader.attr(node, Ns.W, "dirty") ?? "")) dirty++

				break
			}
			case "bookmarkStart": {
				const name = reader.attr(node, Ns.W, "name") ?? ""

				starts.push([name.toLowerCase(), reader.attr(node, Ns.W, "id") ?? "", name])

				break
			}
			case "bookmarkEnd":
				ends.push(reader.attr(node, Ns.W, "id") ?? "")

				break
		}
	}

	return { unmatched: unmatched + open.length, starts, ends, dirty, spanning }
}

// Every bookmark a source part's markup has (mc:Fallback branches included, which its bookmark table leaves
// out), read only when a written bookmark is in none of the tables.
const SOURCE_MARKUP = new WeakMap<XmlDocument, Markup>()

// sourceMarkup read in slices of `clock` (gate 2 reads it before it is needed).
async function sourceMarkupSliced(document: XmlDocument, clock: SliceClock | undefined): Promise<void> {
	if (!SOURCE_MARKUP.has(document)) SOURCE_MARKUP.set(document, await runSliced(readMarkupSteps(document), clock))
}

function sourceMarkup(document: XmlDocument): Markup {
	let markup = SOURCE_MARKUP.get(document)

	if (markup === undefined) {
		markup = readMarkup(document)
		SOURCE_MARKUP.set(document, markup)
	}

	return markup
}

// Field characters of a source part without partners: those that matched no field, and the begin and separate
// of a field without an end (read once per part).
const SOURCE_UNMATCHED = new WeakMap<StoryPart, number>()

function sourceUnmatched(part: StoryPart): number {
	let count = SOURCE_UNMATCHED.get(part)

	if (count === undefined) {
		count = 0

		for (let item = 0; item < part.count; item++) if (part.kinds[item] === Item.FieldChar && part.fieldOf(item) < 0) count++

		const fields = part.fields

		for (let field = 0; field < fields.count; field++) {
			if (fields.simple[field] === 1 || (fields.end[field] ?? -1) >= 0) continue
			if ((fields.begin[field] ?? -1) >= 0) count++
			if ((fields.separate[field] ?? -1) >= 0) count++
		}

		SOURCE_UNMATCHED.set(part, count)
	}

	return count
}

// Field codes of a source part running past their paragraph (read once per part).
const SOURCE_SPANNING = new WeakMap<StoryPart, number>()

function sourceSpanning(part: StoryPart): number {
	let count = SOURCE_SPANNING.get(part)

	if (count === undefined) {
		const paragraphOf = (item: number): number => {
			let at = item

			while (at >= 0 && part.kinds[at] !== Item.Paragraph) at = part.parent(at)

			return at
		}
		const fields = part.fields

		count = 0

		for (let field = 0; field < fields.count; field++) {
			const begin = fields.begin[field] ?? -1
			const separate = fields.separate[field] ?? -1
			const codeEnd = separate >= 0 ? separate : (fields.end[field] ?? -1)

			if (fields.simple[field] === 0 && begin >= 0 && codeEnd >= 0 && paragraphOf(begin) !== paragraphOf(codeEnd)) count++
		}

		SOURCE_SPANNING.set(part, count)
	}

	return count
}

interface SourceBookmarks {
	// "name\0id" of every source bookmark start (lower-case names), ids by name, and the ids of ends.
	readonly pairs: ReadonlySet<string>
	readonly names: ReadonlyMap<string, readonly string[]>
	readonly ends: ReadonlySet<string>
}

const SOURCE_BOOKMARKS = new WeakMap<object, SourceBookmarks>()

// The bookmarks of every story part of the source (read once per document, from its bookmark tables).
function sourceBookmarks(input: CheckInput): SourceBookmarks {
	const model = input.context.model
	let found = SOURCE_BOOKMARKS.get(model)

	if (found === undefined) {
		const pairs = new Set<string>()
		const names = new Map<string, string[]>()
		const ends = new Set<string>()

		for (const part of model.parts) {
			if (part === undefined) continue

			const table = part.bookmarks

			for (const [id, row] of table.ids) {
				const start = table.start[row] ?? -1

				if ((table.end[row] ?? -1) >= 0) ends.add(id)
				if (start < 0) continue

				const name = (part.reader.attr(part.node(start), Ns.W, "name") ?? "").toLowerCase()

				pairs.add(`${name}\u0000${id}`)
				names.set(name, [...(names.get(name) ?? []), id])
			}
		}

		found = { pairs, names, ends }
		SOURCE_BOOKMARKS.set(model, found)
	}

	return found
}

interface Written {
	readonly part: StoryPart | undefined
	readonly markup: Markup
	readonly skeleton: boolean
}

const STATES = new WeakMap<CheckInput, Written[]>()

function fail(reason: "duplicateId" | "danglingReference" | "content", message: string): never {
	throw new DocxVerifyError(reason, message)
}

// Field begins of `part` with w:dirty, by item, ascending.
function dirtyBegins(part: StoryPart): number[] {
	const out: number[] = []
	const fields = part.fields

	for (let field = 0; field < fields.count; field++) {
		const begin = fields.begin[field] ?? -1

		if (fields.simple[field] === 0 && begin >= 0 && part.fieldCharType(begin) === FieldCharType.Begin && part.fieldCharDirty(begin))
			out.push(begin)
	}

	return out.sort((a, b) => a - b)
}

// How many of `sorted` lie in [from, to).
function countIn(sorted: readonly number[], from: number, to: number): number {
	const lower = (value: number): number => {
		let low = 0
		let high = sorted.length

		while (low < high) {
			const mid = (low + high) >> 1

			if ((sorted[mid] ?? 0) < value) low = mid + 1
			else high = mid
		}

		return low
	}

	return to > from ? lower(to) - lower(from) : 0
}

// Dirty field begins the editor's document still holds: in field atoms and locked blocks of the source, and
// new field characters asking for an update.
function heldDirty(doc: Node, part: StoryPart, begins: readonly number[]): number {
	let count = 0

	doc.descendants(node => {
		if (node.type === nodes.field_char) {
			if (node.attrs["kind"] === "begin" && node.attrs["dirty"] === true) count++

			return false
		}

		const own = node.attrs["src"] as number | undefined

		if (begins.length > 0 && own !== undefined && own !== NO_SOURCE && own < part.count) {
			if (node.type === nodes.field) count += countIn(begins, own, part.end(node.attrs["end"] as number))
			else if (node.type === nodes.locked_block) count += countIn(begins, own, part.end(own))
		}

		return !node.isLeaf
	})

	return count
}

// Dirty begins in the source bytes a story copied as they were.
function copiedDirty(part: StoryPart, begins: readonly number[], trusted: readonly number[]): number {
	if (begins.length === 0) return 0

	const bytes = begins.map(item => part.start(item))
	let count = 0

	for (let k = 0; k < trusted.length; k += 4) count += countIn(bytes, trusted[k + 2] ?? 0, trusted[k + 3] ?? 0)

	return count
}

const FIELD_CHECK: DocxCheck = {
	async part(input: CheckInput, part: CheckedPart) {
		if (part.part === undefined) return

		let written = STATES.get(input)

		if (written === undefined) {
			written = []
			STATES.set(input, written)
		}

		const trusted: number[] = []

		if (part.skeleton)
			for (const story of input.changes.stories)
				if (story.part === part.part) for (const value of story.output.trusted) trusted.push(value)

		const markup = await runSliced(
			readMarkupSteps(part.document, part.skeleton ? { part: part.part, trusted } : undefined),
			input.clock
		)

		if (markup.unmatched > 0 && markup.unmatched > (input.original.has(part.name) ? sourceUnmatched(part.part) : 0))
			fail("content", `${part.name}: field characters without their partners`)

		// A field code over a paragraph mark hides the text after it (Word reads it all as the code).
		if (markup.spanning > 0 && markup.spanning > (input.original.has(part.name) ? sourceSpanning(part.part) : 0))
			fail("content", `${part.name}: a field code runs past its paragraph`)

		written.push({ part: part.part, markup, skeleton: part.skeleton })
	},
	async done(input: CheckInput) {
		const written = STATES.get(input)

		if (written === undefined || written.length === 0) return

		const source = sourceBookmarks(input)
		const seen = new Map<string, string>()

		// The source markup of a part whose written bookmarks the tables do not all know, read in slices first.
		for (const { part, markup } of written)
			if (
				part !== undefined &&
				input.original.has(part.name) &&
				(markup.starts.some(([name, id]) => !source.pairs.has(`${name}\u0000${id}`)) ||
					markup.ends.some(id => !source.ends.has(id) && input.ids(`bookmarkStart:${id}`) === 0))
			)
				await sourceMarkupSliced(part.document, input.clock)

		for (const { part, markup } of written) {
			const sourcePart = part !== undefined && input.original.has(part.name) ? part : undefined
			const sourcePair = (name: string, id: string): boolean =>
				source.pairs.has(`${name}\u0000${id}`) ||
				(sourcePart !== undefined &&
					sourceMarkup(sourcePart.document).starts.some(([other, otherId]) => other === name && otherId === id))

			for (const [name, id, raw] of markup.starts) {
				if (sourcePair(name, id)) continue
				if (raw === "" || raw.length > MAX_BOOKMARK_NAME) fail("content", `A bookmark named "${raw}"`)

				const other = seen.get(name)

				if (other !== undefined && other !== id) fail("duplicateId", `Two bookmarks named "${raw}"`)

				seen.set(name, id)

				// A source bookmark of the name (another id) still in the document.
				for (const sourceId of source.names.get(name) ?? []) {
					if (sourceId !== id && input.ids(`bookmarkStart:${sourceId}`) > 0) fail("duplicateId", `Two bookmarks named "${raw}"`)
				}
			}

			// A new start has its end (written, or the source's that it keeps).
			for (const [name, id, raw] of markup.starts) {
				if (sourcePair(name, id) || source.ends.has(id)) continue
				if (!written.some(other => other.markup.ends.includes(id))) fail("danglingReference", `A bookmark "${raw}" without its end`)
			}

			for (const id of markup.ends) {
				if (source.ends.has(id) || input.ids(`bookmarkStart:${id}`) > 0) continue
				if (sourcePart === undefined || !sourceMarkup(sourcePart.document).ends.includes(id))
					fail("danglingReference", `A bookmark end ${id} without its start`)
			}
		}

		// w:dirty kept on the fields the editor's documents still hold.
		const parts = new Map<StoryPart, number>()

		for (const { part, markup, skeleton } of written)
			if (part !== undefined && skeleton) parts.set(part, (parts.get(part) ?? 0) + markup.dirty)

		for (const [part, inMarkup] of parts) {
			const begins = dirtyBegins(part)

			// New field characters are written with their flag as the editor holds it.
			if (begins.length === 0) continue

			let expected = 0
			let copied = 0

			for (const story of input.changes.stories) {
				if (story.part !== part) continue

				expected += heldDirty(story.doc, part, begins)
				copied += copiedDirty(part, begins, story.output.trusted)
			}

			if (inMarkup + copied < expected) fail("content", `${part.name}: a field lost its request to be updated (w:dirty)`)
		}
	}
}

export const fieldChecks: readonly DocxCheck[] = [FIELD_CHECK]

import type { Node } from "prosemirror-model"
import { BytePieces, relativeTarget } from "../../../opc/index"
import { concatBytes } from "../../../xml/bytes"
import { XmlEditor, decodeCharacterData, encodeUtf8, escapeAttribute, type SliceClock, type XmlDocument } from "../../../xml/index"
import type { StoryDoc } from "../../edit/build"
import type { DocxEditContext } from "../../edit/context"
import { docxSchema } from "../../edit/schema"
import type { DocxEditorSession } from "../../edit/session"
import { COMMENT_NAMESPACES, COMMENT_PARTS, readCommentsIds, type CommentPartKind } from "../../model/comments"
import type { CommentInfo, StoryPart } from "../../model/index"
import { Ns } from "../../model/namespaces"
import { partReader } from "../../model/reader"
import { commentRecords, orphanedComments, type DocxCommentRecord } from "../../review/comments"
import { W_NAMESPACE } from "../source"
import { DocxWriteError, paraId as checkParaId } from "../values"
import type { PartContributor, RootDeclarations, SaveParts, WrittenStories } from "./index"

// The comments part family. A new comment's w:comment (id, author, date, initials from its own story's
// record) is appended to the comments part; commentsExtended gets an entry per new comment (its last
// paragraph's id, the comment it replies to, whether it is resolved) and the resolved state of source
// comments that changed; commentsIds, commentsExtensible and people get entries for new comments where the
// document has those parts (made only when missing: commentsExtended, which threads need). A deleted source
// comment (by the command, or with all of its anchors) leaves every part of the family; its replies answer
// their thread's first comment.

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const W15_URIS = [COMMENT_PARTS.commentsExtended.uri, "http://schemas.microsoft.com/office/word/2010/11/wordml"]

function prefixOf(document: XmlDocument, uris: readonly string[]): string | undefined {
	const root = document.documentElement()
	const namespaces = partReader(document).namespaces

	for (const uri of uris) {
		const prefix = namespaces.prefixFor(root, uri)

		if (prefix !== undefined) return prefix
	}

	return undefined
}

function qualified(prefix: string, local: string): string {
	return prefix === "" ? local : `${prefix}:${local}`
}

function attributes(prefix: string, values: readonly (readonly [string, string | undefined])[]): string {
	return values
		.filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
		.map(([name, value]) => ` ${qualified(prefix, name)}="${escapeAttribute(value)}"`)
		.join("")
}

// The id of a new comment's story (its w:id), when `story` is one.
function newCommentId(story: StoryDoc): string | undefined {
	return story.story.kind === "comment" && story.story.item < 0 ? story.story.id : undefined
}

function lastParagraphId(doc: Node): string | undefined {
	const last = doc.lastChild
	const id: unknown = last === null ? undefined : docxSchema.marks.para_id.isInSet(last.marks)?.attrs["id"]

	return typeof id === "string" ? id : undefined
}

// What a save knows of the comments: the records of every story it writes, each comment's own story.
interface Facts {
	readonly records: Map<string, DocxCommentRecord>
	// New comments the save writes, by id, with their documents.
	readonly added: Map<string, Node>
	// Sessions of comment stories by comment id, with their documents as written.
	readonly stories: Map<string, Node>
	readonly sources: Map<string, CommentInfo>
}

function factsOf(context: DocxEditContext, written: WrittenStories): Facts {
	const records = new Map<string, DocxCommentRecord>()
	const stories = new Map<string, Node>()
	const sources = new Map(context.model.comments.map(comment => [comment.id, comment]))
	const writtenSessions = new Set<DocxEditorSession>(written.stories.map(story => story.session))
	const added = new Map<string, Node>()

	written.sessions.forEach((session, k) => {
		const doc = written.docs[k] ?? session.state.doc
		const story = session.story.story

		if (story.kind === "comment") {
			if (story.id === undefined) return

			stories.set(story.id, doc)

			if (story.item < 0 && writtenSessions.has(session)) added.set(story.id, doc)

			return
		}

		for (const [id, record] of Object.entries(commentRecords(doc))) records.set(id, record)
	})

	return { records, added, stories, sources }
}

// Source comments whose last paragraph is written with another id than the file keys them on (edits that
// moved it there, a split), by the old id.
function movedParaIds(facts: Facts): Map<string, string> {
	const out = new Map<string, string>()

	for (const [id, doc] of facts.stories) {
		const before = facts.sources.get(id)?.paraId?.toUpperCase()
		const now = lastParagraphId(doc)?.toUpperCase()

		if (before !== undefined && now !== undefined && before !== now) out.set(before, now)
	}

	return out
}

function paraIdOf(facts: Facts, id: string): string | undefined {
	const doc = facts.stories.get(id)
	const own = doc === undefined ? undefined : lastParagraphId(doc)

	return own ?? facts.sources.get(id)?.paraId
}

// Random durable ids of the new comments, kept per document so saves agree.
const DURABLE_IDS = new WeakMap<DocxEditContext, Map<string, string>>()

function durableId(context: DocxEditContext, id: string, taken: ReadonlySet<string>): string {
	let ids = DURABLE_IDS.get(context)

	if (ids === undefined) {
		ids = new Map()
		DURABLE_IDS.set(context, ids)
	}

	let out = ids.get(id)

	if (out === undefined) {
		const used = new Set([...taken, ...ids.values()])

		out = context.ids.paraId(value => used.has(value.toString(16).toUpperCase().padStart(8, "0")))
		ids.set(id, out)
	}

	return out
}

// A part of the family the package has, with an editor over it.
interface FamilyPart {
	readonly name: string
	readonly document: XmlDocument
	readonly editor: XmlEditor
	readonly prefix: string
	// The namespace declaration the root gets when the part is written (it did not bind the namespace).
	readonly declaration: readonly [string, string] | undefined
	changed: boolean
}

async function familyPart(parts: SaveParts, kind: CommentPartKind): Promise<FamilyPart | undefined> {
	const name = parts.pkg.part(kind)
	const document = name === undefined ? undefined : await parts.xml(name)

	if (name === undefined || document === undefined) return undefined

	const info = COMMENT_PARTS[kind]
	const prefix = prefixOf(document, kind === "commentsExtended" || kind === "people" ? W15_URIS : [info.uri])

	if (prefix !== undefined) return { name, document, editor: new XmlEditor(document), prefix, declaration: undefined, changed: false }

	// A part that does not bind the namespace (an older writer's): its root declares it, under a prefix the
	// root does not use.
	const bound = partReader(document).namespaces.inScope(document.documentElement())
	let declared: string = info.prefix

	for (let n = 1; bound.has(declared); n++) declared = `${info.prefix}${String(n)}`

	return {
		name,
		document,
		editor: new XmlEditor(document),
		prefix: declared,
		declaration: [`xmlns:${declared}`, info.uri],
		changed: false
	}
}

// The root's children `local` of namespace group `ns`.
function children(document: XmlDocument, ns: Ns, local: string): number[] {
	const reader = partReader(document)
	const out: number[] = []

	for (let child = document.firstChildElement(document.documentElement()); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.is(child, ns, local)) out.push(child)
	}

	return out
}

function attribute(document: XmlDocument, node: number, ns: Ns, local: string): string | undefined {
	return partReader(document).attr(node, ns, local)?.toUpperCase()
}

// Writes what the family part holds now: the package's part edited, or a new part (with a relationship from
// the main part, unless one names a part the package lacks) when it has entries.
async function finish(parts: SaveParts, kind: CommentPartKind, part: FamilyPart | undefined, appended: readonly string[]): Promise<void> {
	const info = COMMENT_PARTS[kind]

	if (part !== undefined) {
		if (!part.changed && appended.length === 0) return

		const root = part.document.documentElement()

		if (part.declaration !== undefined) part.editor.setAttribute(root, part.declaration[0], part.declaration[1])
		if (appended.length > 0) part.editor.append(root, appended.join(""))

		parts.replace(part.name, part.editor.serialize())

		return
	}

	if (appended.length === 0) return

	const named = parts.pkg.part(kind)
	const name = named ?? parts.freeName(info.name)
	const root = qualified(info.prefix, info.root)

	parts.add(
		name,
		encodeUtf8(`${XML_DECLARATION}<${root} xmlns:${info.prefix}="${info.uri}">${appended.join("")}</${root}>`),
		info.contentType
	)

	if (named !== undefined) return

	await parts.loadRelationships(parts.pkg.mainPart)
	parts.relationship(parts.pkg.mainPart, { type: info.relationship, target: relativeTarget(parts.pkg.mainPart, name) })
}

async function contribute(parts: SaveParts, written: WrittenStories): Promise<void> {
	const context = parts.context
	const facts = factsOf(context, written)
	const sources = facts.sources
	// Source comments whose resolved state the edits changed, and those deleted.
	const resolved = new Map<string, boolean>()
	const deleted = new Set<string>()

	for (const [id, record] of facts.records) {
		const source = sources.get(id)

		if (source === undefined) continue
		if (record.deleted === true) deleted.add(id)
		else if (record.done !== undefined && record.done !== source.done) resolved.set(id, record.done)
	}

	const cut = deletedComments(parts, written)
	const moved = movedParaIds(facts)

	if (facts.added.size === 0 && resolved.size === 0 && deleted.size === 0 && cut.size === 0 && moved.size === 0) {
		// Accepting or rejecting an author's last changes leaves their person behind.
		if (written.stories.length > 0) await people(parts, written, facts, new Set(), cut)

		return
	}

	// A deleted comment leaves the comments part (the save cuts its w:comment out: removed below), and its
	// entries leave the other parts of the family.
	const removed = new Set<string>()

	for (const [part, items] of cut) {
		for (const story of context.model.stories)
			if (story.part === part.index && items.includes(story.item) && story.id !== undefined) removed.add(story.id)
	}

	for (const id of removed) resolved.delete(id)

	const removedParaIds = new Set(
		[...removed].map(id => sources.get(id)?.paraId?.toUpperCase()).filter((id): id is string => id !== undefined)
	)

	await extended(parts, facts, resolved, removed, removedParaIds, moved)

	const idsPart = await familyPart(parts, "commentsIds")
	const durable = new Map<string, string>()

	if (idsPart !== undefined) {
		const existing = readCommentsIds(idsPart.document)
		const taken = new Set(existing.values())
		const appended: string[] = []
		const removedDurable = new Set<string>()

		for (const node of children(idsPart.document, Ns.W16Cid, "commentId")) {
			const paraId = attribute(idsPart.document, node, Ns.W16Cid, "paraId")
			const now = paraId === undefined ? undefined : moved.get(paraId.toUpperCase())

			if (now !== undefined) {
				idsPart.editor.setAttribute(node, qualified(idsPart.prefix, "paraId"), now)
				idsPart.changed = true
			}

			if (paraId !== undefined && removedParaIds.has(paraId)) {
				idsPart.editor.remove(node)
				idsPart.changed = true

				const id = existing.get(paraId)

				if (id !== undefined) removedDurable.add(id)
			}
		}

		for (const [id, doc] of facts.added) {
			const paraId = lastParagraphId(doc)

			if (paraId === undefined) continue

			const value = durableId(context, id, taken)

			durable.set(id, value)
			appended.push(
				`<${qualified(idsPart.prefix, "commentId")}${attributes(idsPart.prefix, [
					["paraId", paraId],
					["durableId", value]
				])}/>`
			)
		}

		await finish(parts, "commentsIds", idsPart, appended)

		const extensible = await familyPart(parts, "commentsExtensible")

		if (extensible !== undefined) {
			const added: string[] = []

			for (const node of children(extensible.document, Ns.W16Cex, "commentExtensible")) {
				const id = attribute(extensible.document, node, Ns.W16Cex, "durableId")

				if (id !== undefined && removedDurable.has(id)) {
					extensible.editor.remove(node)
					extensible.changed = true
				}
			}

			for (const [id, value] of durable) {
				const record = commentRecords(facts.added.get(id) as Node)[id]
				const date = record?.dateUtc ?? record?.date

				added.push(
					`<${qualified(extensible.prefix, "commentExtensible")}${attributes(extensible.prefix, [
						["durableId", value],
						["dateUtc", date]
					])}/>`
				)
			}

			await finish(parts, "commentsExtensible", extensible, added)
		}
	}

	await people(parts, written, facts, removed, cut)
}

// people: a person for each new comment's author it lacks, and none for an author no comment or revision of
// the saved file names any more (MS-DOCX 2.5.3.5: w15:author MUST name the author of one).
async function people(
	parts: SaveParts,
	written: WrittenStories,
	facts: Facts,
	removed: ReadonlySet<string>,
	cut: ReadonlyMap<StoryPart, readonly number[]>
): Promise<void> {
	const part = await familyPart(parts, "people")

	if (part === undefined) return

	const reader = partReader(part.document)
	const persons = children(part.document, Ns.W15, "person")
	const known = new Set(persons.map(node => reader.attr(node, Ns.W15, "author")))
	const added: string[] = []
	// Authors of the comments the save writes.
	const named = new Set<string>()

	for (const comment of facts.sources.values()) if (!removed.has(comment.id) && comment.author !== undefined) named.add(comment.author)

	for (const [id, doc] of facts.added) {
		const author = commentRecords(doc)[id]?.author

		if (author === undefined) continue

		named.add(author)

		if (known.has(author)) continue

		known.add(author)
		added.push(`<${qualified(part.prefix, "person")}${attributes(part.prefix, [["author", author]])}/>`)
	}

	const unnamed = await revisionOnly(
		parts,
		written,
		cut,
		persons.map(node => reader.attr(node, Ns.W15, "author") ?? "").filter(author => !named.has(author))
	)

	for (const node of persons) {
		if (!unnamed.has(reader.attr(node, Ns.W15, "author") ?? "")) continue

		part.editor.remove(node)
		part.changed = true
	}

	await finish(parts, "people", part, added)
}

// Of `authors` (persons no written comment names), those no revision of the saved file names either: what the
// story parts hold as written (their rewritten stories, the rest of their source but removed comments), and the
// styles and numbering parts (their revisions as the source has them). Values are compared decoded (however a
// file quotes or escapes them); a part not in UTF-8 names them all. A source part is read once per document
// (SOURCE_AUTHORS), the rewritten stories' new markup each save, in slices.
async function revisionOnly(
	parts: SaveParts,
	written: WrittenStories,
	cut: ReadonlyMap<StoryPart, readonly number[]>,
	authors: readonly string[]
): Promise<Set<string>> {
	const left = new Set(authors.filter(author => author !== ""))
	const clock = parts.clock
	const named = (author: string): void => {
		left.delete(author)
	}

	if (left.size === 0) return left

	// Each story part: rewritten stories and removed comments out of its source, then what they were written as.
	const skipped = new Map<StoryPart, { from: number; to: number }[]>()

	for (const story of written.stories) {
		const document = story.part.document
		const node = story.range === undefined ? story.part.node(story.session.story.story.item) : -1
		const range = story.range ?? { from: document.start(node), to: document.end(node) }
		const list = skipped.get(story.part)

		if (list === undefined) skipped.set(story.part, [range])
		else list.push(range)

		if (utf16(document.bytes)) return new Set()

		await writtenAuthors(story.output.bytes, document.bytes, clock, named)

		if (left.size === 0) return left
	}

	for (const [part, items] of cut) {
		const list = skipped.get(part) ?? []

		for (const item of items) list.push({ from: part.document.start(part.node(item)), to: part.document.end(part.node(item)) })

		skipped.set(part, list)
	}

	for (const part of parts.context.model.parts) {
		if (part === undefined) continue

		const bytes = part.document.bytes

		if (utf16(bytes)) return new Set()

		const index = await authorIndex(bytes, clock)
		const ranges = (skipped.get(part) ?? []).sort((a, b) => a.from - b.from)
		let range = 0

		for (let k = 0; k < index.at.length && left.size > 0; k++) {
			const at = index.at[k] ?? 0

			while (range < ranges.length && (ranges[range]?.to ?? 0) <= at) range++

			if (range < ranges.length && (ranges[range]?.from ?? 0) <= at) continue

			named(index.who[k] ?? "")
		}

		if (left.size === 0) return left
	}

	for (const kind of ["styles", "numbering"] as const) {
		const name = parts.pkg.part(kind)
		const document = name === undefined ? undefined : await parts.xml(name)

		if (document === undefined) continue
		if (utf16(document.bytes)) return new Set()

		for (const author of (await authorIndex(document.bytes, clock)).who) named(author)
	}

	return left
}

function utf16(bytes: Uint8Array): boolean {
	return (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe)
}

// Where each author="..." of a source part is and the author it names (decoded).
interface AuthorIndex {
	readonly at: number[]
	readonly who: string[]
}

const SOURCE_AUTHORS = new WeakMap<Uint8Array, AuthorIndex>()

async function authorIndex(bytes: Uint8Array, clock: SliceClock | undefined): Promise<AuthorIndex> {
	let index = SOURCE_AUTHORS.get(bytes)

	if (index === undefined) {
		const at: number[] = []
		const who: string[] = []

		await scanAuthors(bytes, 0, bytes.length, clock, (position, author) => {
			at.push(position)
			who.push(author)
		})
		index = { at, who }
		SOURCE_AUTHORS.set(bytes, index)
	}

	return index
}

// The authors a story as written names: its copies of the source by the source's index, its new markup read.
async function writtenAuthors(
	bytes: Uint8Array | BytePieces,
	source: Uint8Array,
	clock: SliceClock | undefined,
	named: (author: string) => void
): Promise<void> {
	if (bytes instanceof Uint8Array) {
		await scanAuthors(bytes, 0, bytes.length, clock, (_at, author) => named(author))

		return
	}

	// Runs of new markup, and ranges of the source copied as they are.
	const runs: { readonly fresh: Uint8Array[] | undefined; readonly from: number; readonly to: number }[] = []

	bytes.visit(0, bytes.length, (piece, pieceFrom, count) => {
		const share = piece.subarray(pieceFrom, pieceFrom + count)

		if (
			share.buffer === source.buffer &&
			share.byteOffset >= source.byteOffset &&
			share.byteOffset + count <= source.byteOffset + source.length
		) {
			const from = share.byteOffset - source.byteOffset

			runs.push({ fresh: undefined, from, to: from + count })
		} else {
			const last = runs[runs.length - 1]

			if (last?.fresh !== undefined) last.fresh.push(share)
			else runs.push({ fresh: [share], from: 0, to: 0 })
		}

		return true
	})

	const index = await authorIndex(source, clock)

	for (const run of runs) {
		if (run.fresh === undefined) {
			for (let k = lowerBound(index.at, run.from); k < index.at.length && (index.at[k] ?? 0) < run.to; k++) named(index.who[k] ?? "")

			continue
		}

		const joined = run.fresh.length === 1 ? (run.fresh[0] as Uint8Array) : concatBytes(run.fresh)

		await scanAuthors(joined, 0, joined.length, clock, (_at, author) => named(author))
	}
}

function lowerBound(sorted: readonly number[], value: number): number {
	let low = 0
	let high = sorted.length

	while (low < high) {
		const middle = (low + high) >> 1

		if ((sorted[middle] ?? 0) < value) low = middle + 1
		else high = middle
	}

	return low
}

// Bytes read between looks at the clock.
const SCAN_STEP = 1 << 20
const AUTHOR = [0x61, 0x75, 0x74, 0x68, 0x6f, 0x72]

// Calls `found` for each attribute named author (any prefix) whose start lies in bytes [from, to), with its
// value decoded, pausing between megabytes.
async function scanAuthors(
	bytes: Uint8Array,
	from: number,
	to: number,
	clock: SliceClock | undefined,
	found: (at: number, author: string) => void
): Promise<void> {
	let next = from + SCAN_STEP

	for (let at = bytes.indexOf(0x61, from); at >= 0 && at < to; at = bytes.indexOf(0x61, at + 1)) {
		if (at >= next) {
			next = at + SCAN_STEP

			if (clock?.due === true) await clock.pause()
		}

		let k = 1

		while (k < AUTHOR.length && bytes[at + k] === AUTHOR[k]) k++

		if (k < AUTHOR.length) continue

		// The whole name, or its local part after a prefix, in a start tag (text, comments and processing
		// instructions say author= too).
		const before = at > 0 ? (bytes[at - 1] ?? 0) : 0x20

		if (before !== 0x3a && before !== 0x20 && before !== 0x09 && before !== 0x0a && before !== 0x0d) continue

		// (A run of new markup may start inside a tag: no "<" before it there is no "outside a tag" either.)
		const open = bytes.lastIndexOf(0x3c, at)
		const kind = open < 0 ? 0 : bytes[open + 1]

		if (bytes.lastIndexOf(0x3e, at) > open || kind === 0x21 || kind === 0x3f || kind === 0x2f) continue

		let p = at + AUTHOR.length

		while (bytes[p] === 0x20 || bytes[p] === 0x09 || bytes[p] === 0x0a || bytes[p] === 0x0d) p++

		if (bytes[p] !== 0x3d) continue

		p++

		while (bytes[p] === 0x20 || bytes[p] === 0x09 || bytes[p] === 0x0a || bytes[p] === 0x0d) p++

		const quote = bytes[p]

		if (quote !== 0x22 && quote !== 0x27) continue

		const end = bytes.indexOf(quote, p + 1)
		const tag = bytes.indexOf(0x3c, p + 1)

		// An attribute value holds no "<"; one no reference of which decodes is no author either.
		if (end < 0 || (tag >= 0 && tag < end)) continue

		let author: string | undefined

		try {
			author = decodeCharacterData(bytes, p + 1, end, true)
		} catch {
			author = undefined
		}

		if (author !== undefined) found(at, author)

		at = end
	}
}

const ORPHANS = {}

// Source comments the edits deleted (the command, or all of their anchors), and the comments part's items of
// those it holds.
function deletedComments(parts: SaveParts, written: Omit<WrittenStories, "stories">): Map<StoryPart, number[]> {
	const context = parts.context
	const sources = new Set(context.model.comments.map(comment => comment.id))
	const ids = new Set<string>(parts.state(ORPHANS, () => orphanedComments(context, written.sessions, written.docs)))
	const items = new Map<StoryPart, number[]>()

	written.sessions.forEach((session, k) => {
		if (session.story.story.kind === "comment") return

		for (const [id, record] of Object.entries(commentRecords(written.docs[k] ?? session.state.doc)))
			if (record.deleted === true && sources.has(id)) ids.add(id)
	})

	if (ids.size === 0) return items

	const model = context.model
	const commentsName = parts.pkg.part("comments")
	const part = commentsName === undefined ? undefined : model.parts.find(candidate => candidate.name === commentsName)

	if (part === undefined) return items

	for (const story of model.stories) {
		if (story.kind !== "comment" || story.part !== part.index || story.item < 0 || story.id === undefined || !ids.has(story.id))
			continue

		const list = items.get(part)

		if (list === undefined) items.set(part, [story.item])
		else list.push(story.item)
	}

	return items
}

// commentsExtended: an entry per new comment that has a paragraph id, the resolved state of source comments
// that changed (an entry added where they had none), deleted comments' entries removed.
async function extended(
	parts: SaveParts,
	facts: Facts,
	resolved: ReadonlyMap<string, boolean>,
	removedIds: ReadonlySet<string>,
	removed: ReadonlySet<string>,
	moved: ReadonlyMap<string, string>
): Promise<void> {
	const part = await familyPart(parts, "commentsExtended")
	const prefix = part?.prefix ?? COMMENT_PARTS.commentsExtended.prefix
	const entry = (paraId: string, parent: string | undefined, done: boolean): string =>
		`<${qualified(prefix, "commentEx")}${attributes(prefix, [
			["paraId", paraId],
			["paraIdParent", parent],
			["done", done ? "1" : "0"]
		])}/>`
	const appended: string[] = []
	const pending = new Map(resolved)

	if (part !== undefined) {
		const document = part.document
		const byParaId = new Map<string, string>()

		for (const [id] of resolved) {
			const paraId = paraIdOf(facts, id)?.toUpperCase()

			if (paraId !== undefined) byParaId.set(paraId, id)
		}

		const entries = children(document, Ns.W15, "commentEx")
		const parents = new Map<string, string>()

		if (removed.size > 0) {
			const reader = partReader(document)
			const root = document.documentElement()

			// Another element keyed on a removed comment's paragraph (one no schema has) goes with it.
			for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
				const paraId = attribute(document, child, Ns.W15, "paraId")

				if (paraId !== undefined && removed.has(paraId) && !reader.is(child, Ns.W15, "commentEx")) {
					part.editor.remove(child)
					part.changed = true
				}
			}

			for (const node of entries) {
				const paraId = attribute(document, node, Ns.W15, "paraId")
				const parent = attribute(document, node, Ns.W15, "paraIdParent")

				if (paraId !== undefined && parent !== undefined) parents.set(paraId, parent)
			}
		}

		for (const node of entries) {
			const was = attribute(document, node, Ns.W15, "paraId")

			if (was === undefined) continue

			// A comment whose id moved to its last paragraph (MS-DOCX 2.5.3.1): its entry, and its replies'
			// parent, follow it (removal and threads below go by the ids the file has).
			const paraId = moved.get(was.toUpperCase()) ?? was
			const answers = attribute(document, node, Ns.W15, "paraIdParent")
			const answered = answers === undefined ? undefined : moved.get(answers.toUpperCase())

			if (!removed.has(was) && paraId !== was) {
				part.editor.setAttribute(node, qualified(prefix, "paraId"), paraId)
				part.changed = true
			}

			if (answers !== undefined && answered !== undefined && !removed.has(answers)) {
				part.editor.setAttribute(node, qualified(prefix, "paraIdParent"), answered)
				part.changed = true
			}

			if (removed.has(was)) {
				part.editor.remove(node)
				part.changed = true

				continue
			}

			const parent = parents.get(was)

			// A reply to a removed comment answers its thread's first comment now (where that is kept).
			if (parent !== undefined && removed.has(parent)) {
				const root = survivingRoot(parents, parent, removed)

				if (root === undefined) part.editor.removeAttribute(node, qualified(prefix, "paraIdParent"))
				else part.editor.setAttribute(node, qualified(prefix, "paraIdParent"), moved.get(root.toUpperCase()) ?? root)

				part.changed = true
			}

			const id = byParaId.get(paraId)

			if (id === undefined || !pending.has(id)) continue

			part.editor.setAttribute(node, qualified(prefix, "done"), pending.get(id) === true ? "1" : "0")
			part.changed = true
			pending.delete(id)
		}
	}

	for (const [id, done] of pending) {
		const paraId = paraIdOf(facts, id)

		if (paraId === undefined) throw new DocxWriteError("missingSource", `Comment ${id} is resolved but has no paragraph id`)

		checkParaId(paraId)
		appended.push(entry(paraId, undefined, done))
	}

	for (const [id, doc] of facts.added) {
		const paraId = lastParagraphId(doc)
		const record = facts.records.get(id)

		if (paraId === undefined) {
			if (record?.parent !== undefined || record?.done === true)
				throw new DocxWriteError("missingSource", `Comment ${id} is in a thread or resolved but has no paragraph id`)

			continue
		}

		appended.push(
			entry(paraId, record?.parent === undefined ? undefined : writtenParent(facts, record.parent, removedIds), record?.done === true)
		)
	}

	await finish(parts, "commentsExtended", part, appended)
}

// The paragraph id a new reply to comment `parent` answers in the file: the topmost comment of its thread the
// save writes, as the comments' list shows the thread (review/comments.ts). Undefined when the save writes none
// of them (their anchors went): the reply is a thread of its own, as a source reply whose thread's comments the
// save removes is (MS-DOCX 2.5.3.1: w15:paraIdParent names a comment of the part).
function writtenParent(facts: Facts, parent: string, removed: ReadonlySet<string>): string | undefined {
	const seen = new Set<string>()
	let found: string | undefined

	for (let at: string | undefined = parent; at !== undefined && !seen.has(at);) {
		seen.add(at)

		const source = facts.sources.get(at)
		const paraId = (source !== undefined ? !removed.has(at) : facts.added.has(at)) ? paraIdOf(facts, at) : undefined

		if (paraId !== undefined) found = paraId

		at = source?.parentId ?? facts.records.get(at)?.parent
	}

	return found
}

// The first comment of the thread of paragraph `paraId` (it and its ancestors by `parents`) that is not
// removed, the thread's topmost; undefined when every one is.
function survivingRoot(parents: ReadonlyMap<string, string>, paraId: string, removed: ReadonlySet<string>): string | undefined {
	const seen = new Set<string>()
	let found: string | undefined

	for (let at: string | undefined = paraId; at !== undefined && !seen.has(at); at = parents.get(at)) {
		seen.add(at)

		if (!removed.has(at)) found = at
	}

	return found
}

// A new comment's w:comment, appended to its part.
function container(story: StoryDoc, doc: Node) {
	const id = newCommentId(story)

	if (id === undefined) return undefined

	const document = story.part.document
	const prefix = prefixOf(document, [W_NAMESPACE])
	const record = commentRecords(doc)[id]

	if (prefix === undefined) throw new DocxWriteError("unsupported", `${story.part.name} does not bind WordprocessingML`)
	if (record?.author === undefined) throw new DocxWriteError("missingSource", `A new comment ${id} without an author`)

	const tag = qualified(prefix, "comment")

	return {
		open: `<${tag}${attributes(prefix, [
			["id", id],
			["author", record.author],
			["date", record.date],
			["initials", record.initials]
		])}>`,
		close: `</${tag}>`,
		at: document.contentEnd(document.documentElement())
	}
}

const MARKUP_COMPATIBILITY = "http://schemas.openxmlformats.org/markup-compatibility/2006"

// The comments part's root as the save must write it when it lacks w14 and a paragraph of it gets a
// w14:paraId (a 2007-era part): w14 declared and marked ignorable (with mc declared where it is not), every
// other attribute as the source has it. Undefined when nothing needs declaring.
export function commentDeclarations(part: StoryPart, written: WrittenStories): RootDeclarations | undefined {
	const document = part.document
	const reader = partReader(document)
	const root = document.documentElement()

	if (!reader.is(root, Ns.W, "comments") || prefixOf(document, [COMMENT_NAMESPACES.w14]) !== undefined) return undefined

	const ids = written.sessions.some((session, k) => {
		const doc = written.docs[k] ?? session.state.doc
		let found = false

		if (session.story.part !== part) return false

		doc.forEach(block => {
			if (docxSchema.marks.para_id.isInSet(block.marks) !== undefined) found = true
		})

		return found
	})

	if (!ids) return undefined

	const bound = reader.namespaces.inScope(root)
	const free = (base: string): string => {
		let prefix = base

		for (let n = 1; bound.has(prefix); n++) prefix = `${base}${String(n)}`

		return prefix
	}
	const w14 = free("w14")
	const mc = prefixOf(document, [MARKUP_COMPATIBILITY]) ?? free("mc")
	const ignorable = `${mc}:Ignorable`
	let open = `<${document.name(root)}`
	let marked = false

	for (const attribute of document.attributes(root)) {
		const value = attribute.name === ignorable ? `${attribute.value} ${w14}`.trim() : attribute.value

		marked ||= attribute.name === ignorable
		open += ` ${attribute.name}="${escapeAttribute(value)}"`
	}

	open += ` xmlns:${w14}="${COMMENT_NAMESPACES.w14}"`

	if (!bound.has(mc)) open += ` xmlns:${mc}="${MARKUP_COMPATIBILITY}"`
	if (!marked) open += ` ${ignorable}="${w14}"`

	return { open: `${open}>`, prefixes: new Map([[COMMENT_NAMESPACES.w14, w14]]) }
}

const contributor: PartContributor = {
	attributes: ["comments"],
	container,
	contribute,
	removed: deletedComments,
	declarations: commentDeclarations
}

export const commentParts: PartContributor = contributor

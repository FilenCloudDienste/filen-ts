import { closeHistory } from "prosemirror-history"
import { Mark, Node } from "prosemirror-model"
import { Plugin, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { symbolTable, symbolToUnicode } from "../../fonts/symbols"
import { WORD_KANA, WORD_LETTER, WORD_NUMBER, wordSegments } from "../../text/index"
import type { DocxEditContext, NewStoryKind } from "../edit/context"
import { builtInStyleId } from "../edit/formats"
import { markInternal } from "../edit/invariants/index"
import { commentedPlaceholders } from "../edit/invariants/forms"
import { readOnlyReasons } from "../edit/readOnly"
import { NO_SOURCE, WRAPPER_MARKS, docxSchema, markerKey, type MarkerAttrs, type MarkerKind, type MarkerList } from "../edit/schema"
import type { DocxEditorSession } from "../edit/session"
import { COMMENT_NAMESPACES, commentParagraphTexts, declaresNamespace, plainComment } from "../model/comments"
import type { XmlDocument } from "../../xml/index"
import { Item, type DocxModel, type Story, type StoryPart } from "../model/index"
import { Ns } from "../model/namespaces"
import { partReader } from "../model/reader"
import type { RevertibleUnits } from "../edit/unsavable"
import { ReviewIndex, ReviewKind } from "./index"
import { minuteDate } from "./track"

// Comments as the editor holds them: what each story's document says about them (anchors, and the `comments`
// attribute with what commands changed), their text (a comment story's session once it was edited or made,
// else the source), and the commands that change them.
//
// A comment's anchors (w:commentRangeStart, w:commentRangeEnd, w:commentReference) sit in one story, the one
// holding its reference; what commands record about a comment (resolved, the comment it replies to, deleted)
// goes into the `comments` attribute of that story's document, so each command is one step of one story and
// undoes with it. A new comment's own author, initials and date are on its own story's document. The save
// writes a new comment only while a reference to it exists (undoing the step that added it leaves it out).
// Anchor and metadata steps are the session's own (never tracked as a change, as in Word).

// What the `comments` attribute of a story's document records per comment id.
export interface DocxCommentRecord {
	// Resolved (w15:done), overriding the source.
	readonly done?: boolean
	// The comment a new reply answers (w15:paraIdParent).
	readonly parent?: string
	// A source comment deleted with its anchors: the save removes it from the comments parts.
	readonly deleted?: true
	// On a new comment's own document: who wrote it and when (w:author, w:initials, w:date; w16cex:dateUtc).
	readonly author?: string
	readonly initials?: string
	readonly date?: string
	readonly dateUtc?: string
}

export type DocxCommentRecords = Readonly<Record<string, DocxCommentRecord>>

const NO_RECORDS: DocxCommentRecords = Object.freeze({})

// The records of a story's document.
export function commentRecords(doc: Node): DocxCommentRecords {
	const value: unknown = doc.attrs["comments"]

	return value !== null && typeof value === "object" ? (value as DocxCommentRecords) : NO_RECORDS
}

function withRecords(
	records: DocxCommentRecords,
	changes: Readonly<Record<string, DocxCommentRecord | undefined>>
): DocxCommentRecords | null {
	const out: Record<string, DocxCommentRecord> = { ...records }

	for (const [id, record] of Object.entries(changes)) {
		if (record === undefined || Object.keys(record).length === 0) delete out[id]
		else out[id] = Object.freeze({ ...record })
	}

	return Object.keys(out).length === 0 ? null : Object.freeze(out)
}

// ---- the headless view the app draws (margin balloons, a thread list) ---------------------------------------

export interface DocxComment {
	readonly id: string
	// The comment this one replies to (its thread's first comment).
	readonly parentId: string | undefined
	readonly author: string | undefined
	readonly initials: string | undefined
	// w:date as written: the writer's local wall-clock time, its "Z" notwithstanding (as Word writes it).
	readonly date: string | undefined
	// The same in UTC, where the file says it (w16cex:dateUtc) or the comment is new.
	readonly dateUtc: string | undefined
	readonly done: boolean
	// Plain text, paragraphs separated by line feeds, line breaks within one as U+2028.
	readonly text: string
	// The story its anchors are in (PagedEditor.enterStory takes it); see DocxComments.anchor.
	readonly story: number
	// Made in this editor (not yet in the file as opened).
	readonly added: boolean
	// What the ⋯ menu and the reply field may offer.
	readonly canEdit: boolean
	readonly canReply: boolean
	readonly canResolve: boolean
	readonly canDelete: boolean
}

// A comment and its replies, in document order of their anchors (threads by their first comment's).
export interface DocxCommentThread {
	readonly id: string
	readonly comment: DocxComment
	readonly replies: readonly DocxComment[]
	readonly done: boolean
}

// Where a comment is in its story's document now: the range it comments on (`from` = `to` for a point) and
// its reference, -1 where it has none.
export interface DocxCommentAnchor {
	readonly story: number
	readonly from: number
	readonly to: number
	readonly reference: number
}

// What a comments store edits: the paged editor, or any set of sessions of one document.
export interface CommentHost {
	readonly body: { readonly session: DocxEditorSession }
	// Every story's session made so far.
	readonly sessions: readonly DocxEditorSession[]
	// The story being edited.
	readonly session?: DocxEditorSession
	// The session of story `story`, made on first use (not entered).
	storySession(story: number): DocxEditorSession | undefined
	addStory?(kind: NewStoryKind, id?: string): DocxEditorSession | undefined
	enterStory?(story: number, page: number): boolean
}

// ---- text -------------------------------------------------------------------------------------------------

const nodes = docxSchema.nodes
const marks = docxSchema.marks
const WRAPPERS: ReadonlySet<unknown> = new Set(WRAPPER_MARKS.map(name => marks[name]))
const HIDDEN_TEXT: ReadonlySet<unknown> = new Set([marks.deletion, marks.move_from])

// A line break within a comment paragraph (w:br, w:cr) in DocxComment.text and command text.
export const LINE_BREAK = "\u2028"

function inlineText(node: Node): string {
	if (node.isText) return node.marks.some(mark => HIDDEN_TEXT.has(mark.type)) ? "" : (node.text ?? "")

	switch (node.type) {
		case nodes.tab:
			return "\t"
		case nodes.break:
			return LINE_BREAK
		case nodes.hyphen:
			return node.attrs["soft"] === true ? "" : "‑"
		case nodes.symbol: {
			const font = node.attrs["font"] as string | null
			const code = node.attrs["char"] as number
			const table = font === null ? undefined : symbolTable(font)
			const char = table === undefined ? code : symbolToUnicode(table, code) || code

			return char > 0 && char <= 0x10ffff ? String.fromCodePoint(char) : ""
		}
		default:
			return ""
	}
}

function paragraphText(paragraph: Node): string {
	let out = ""

	paragraph.forEach(child => {
		out += inlineText(child)
	})

	return out
}

const TEXTS = new WeakMap<Node, readonly string[]>()

// A comment story's text, one string per paragraph (see commentParagraphTexts for the source's).
export function storyParagraphTexts(doc: Node): readonly string[] {
	let out = TEXTS.get(doc)

	if (out === undefined) {
		const list: string[] = []

		doc.forEach(block => {
			if (block.isTextblock) list.push(paragraphText(block))
		})
		out = Object.freeze(list)
		TEXTS.set(doc, out)
	}

	return out
}

// Text that XML 1.0 cannot hold (C0 controls but tab, unpaired surrogates, U+FFFE and U+FFFF) is left out.
function writable(text: string): string {
	let out = ""

	for (let k = 0; k < text.length; k++) {
		const code = text.charCodeAt(k)

		if (code >= 0xd800 && code < 0xdc00) {
			const next = text.charCodeAt(k + 1)

			if (next >= 0xdc00 && next < 0xe000) {
				out += text.slice(k, k + 2)
				k++
			}

			continue
		}

		if ((code < 0x20 && code !== 0x09) || (code >= 0xdc00 && code < 0xe000) || code === 0xfffe || code === 0xffff) continue

		out += text.charAt(k)
	}

	return out
}

// Command text as paragraphs: line feeds (or CR LF, CR) separate them.
export function commentParagraphs(text: string): string[] {
	return text.split(/\r\n|\r|\n/).map(writable)
}

// A paragraph's inline content for plain text: text with tabs and line breaks.
function inlineContent(text: string, textMarks: readonly Mark[]): Node[] {
	const out: Node[] = []

	text.split(/(\t|\u2028)/).forEach(piece => {
		if (piece === "\t") out.push(nodes.tab.create(null, null, textMarks))
		else if (piece === LINE_BREAK) out.push(nodes.break.create(null, null, textMarks))
		else if (piece !== "") out.push(docxSchema.text(piece, textMarks))
	})

	return out
}

function newParagraph(text: string, styleId: string | null, paraId: string | undefined, lead: Node | undefined = undefined): Node {
	return nodes.paragraph.create(
		{ styleId },
		lead === undefined ? inlineContent(text, Mark.none) : [lead, ...inlineContent(text, Mark.none)],
		paraId === undefined ? Mark.none : [marks.para_id.create({ id: paraId })]
	)
}

// Word's annotation mark (w:annotationRef), which starts a comment's first paragraph.
function annotationMark(styleId: string): Node {
	return nodes.run_object.create({ src: NO_SOURCE, kind: "AnnotationMark" }, null, [marks.char_style.create({ styleId })])
}

function isAnnotationMark(node: Node | null): node is Node {
	return node !== null && node.type === nodes.run_object && node.attrs["kind"] === "AnnotationMark"
}

// Word's time stamps, to the minute: w:date is the local wall-clock time written with a "Z" (MS-OI29500
// 2.1.313 d: Word ignores the Z on load), w16cex:dateUtc the time in UTC (MS-DOCX 2.10.3.1).
function timestamps(now: number): { date: string; dateUtc: string } {
	return { date: minuteDate(now), dateUtc: `${new Date(Math.floor(now / 60_000) * 60_000).toISOString().slice(0, 19)}Z` }
}

// ---- ids ---------------------------------------------------------------------------------------------

// Whether paragraphs of a story part can take a w14:paraId: where the part declares w14, and in a comments
// part that does not (a 2007-era one), whose root the save then declares it on (write/parts/comments.ts
// commentDeclarations).
function paraIdsPossible(document: XmlDocument): boolean {
	return declaresNamespace(document, COMMENT_NAMESPACES.w14) || partReader(document).is(document.documentElement(), Ns.W, "comments")
}

const SOURCE_PARA_IDS = new WeakMap<DocxModel, Uint32Array>()

// The w14:paraId values of the source's paragraphs and rows, sorted (once per document, on the first new
// comment): new ids never take one. Read from the start tags' bytes (no strings decoded).
function sourceParaIds(model: DocxModel): Uint32Array {
	let out = SOURCE_PARA_IDS.get(model)

	if (out === undefined) {
		const found: number[] = []
		const span = new Int32Array(2)

		for (const part of model.parts) {
			const document = part.document
			const prefix = partReader(document).namespaces.prefixFor(document.documentElement(), COMMENT_NAMESPACES.w14)

			if (prefix === undefined) continue

			const name = prefix === "" ? "paraId" : `${prefix}:paraId`
			const bytes = document.bytes

			for (let item = 0; item < part.count; item++) {
				const kind = part.kinds[item]

				if ((kind !== Item.Paragraph && kind !== Item.Row) || !document.findAttribute(part.node(item), name, span)) continue

				let value = 0

				for (let at = span[0] ?? 0; at < (span[1] ?? 0); at++) value = value * 16 + hexDigit(bytes[at] ?? 0)

				found.push(value >>> 0)
			}
		}

		out = Uint32Array.from(found).sort()
		SOURCE_PARA_IDS.set(model, out)
	}

	return out
}

function hexDigit(byte: number): number {
	if (byte >= 48 && byte <= 57) return byte - 48
	if (byte >= 65 && byte <= 70) return byte - 55
	if (byte >= 97 && byte <= 102) return byte - 87

	return 0
}

function hasSorted(list: Uint32Array, value: number): boolean {
	let low = 0
	let high = list.length

	while (low < high) {
		const middle = (low + high) >> 1

		if ((list[middle] ?? 0) < value) low = middle + 1
		else high = middle
	}

	return list[low] === value
}

// A comment's paragraph id is its last paragraph's (commentsExtended and commentsIds key on it, MS-DOCX 2.5.3.1):
// an edit leaving another paragraph last (one added after it, a split) moves the id there, and a paragraph left
// holding it takes a new one. The comment commands keep the last paragraph; this keeps any other edit so. A
// plugin of comment stories' sessions.
export function commentParaIds(context: DocxEditContext, part: StoryPart): Plugin {
	// The w14:paraId each top-level paragraph of `doc` is written with (write/paragraph.ts, newStory.ts), by
	// offset: a feature's id, else its source's on the first occurrence of it; a later occurrence (a copy) takes
	// a feature's id unless the first is written with that id already.
	const written = (doc: Node): { offset: number; id: string | undefined; mark: string | undefined }[] => {
		const owners = new Map<number, string | undefined>()
		const out: { offset: number; id: string | undefined; mark: string | undefined }[] = []

		doc.forEach((child, offset) => {
			if (!child.isTextblock) return

			const found = marks.para_id.isInSet(child.marks)
			const mark = found === undefined ? undefined : (found.attrs["id"] as string).toUpperCase()
			const src = child.attrs["src"] as number
			const own = src >= 0 && part.kinds[src] === Item.Paragraph ? part.paragraphId(src)?.toUpperCase() : undefined
			let id: string | undefined

			if (src < 0) id = mark
			else if (!owners.has(src)) {
				id = mark ?? own
				owners.set(src, id)
			} else id = mark !== undefined && (mark !== own || owners.get(src) !== own) ? mark : undefined

			out.push({ offset, id, mark })
		})

		return out
	}

	return new Plugin({
		appendTransaction: (transactions, old, state) => {
			if (!transactions.some(tr => tr.docChanged)) return null

			const doc = state.doc
			const last = doc.lastChild

			if (old.doc.lastChild === null || last === null || !last.isTextblock) return null

			// Every change is checked (a comment story is a few paragraphs): what a paragraph is written with
			// depends on the others too (the first of two copies of a source paragraph is its source's).
			const id = written(old.doc).at(-1)?.id
			const now = written(doc)
			const end = now.at(-1)

			if (id === undefined || end === undefined) return null

			// A feature's id on the last paragraph is the comment's from now on (commentsExtended reads it there);
			// without one, the comment keeps the id it had.
			const target = end.mark ?? id

			if (end.id === target) return null

			const tr = state.tr
			const taken = sourceParaIds(context.model)

			for (const entry of now)
				if (entry !== end && entry.id === target)
					tr.addNodeMark(entry.offset, marks.para_id.create({ id: context.ids.paraId(value => hasSorted(taken, value)) }))

			return markInternal(end.mark === target ? tr : tr.addNodeMark(end.offset, marks.para_id.create({ id: target })))
		}
	})
}

// ---- anchors ----------------------------------------------------------------------------------------------

const COMMENT_KINDS: Readonly<Record<number, MarkerKind | undefined>> = {
	[ReviewKind.COMMENT_START]: "commentRangeStart",
	[ReviewKind.COMMENT_END]: "commentRangeEnd",
	[ReviewKind.COMMENT_REFERENCE]: "commentReference"
}

interface Found {
	start: number
	end: number
	reference: number
}

// Notes an anchor entry of the index in `found`, the first of each kind.
function noteAnchor(index: ReviewIndex, entry: number, found: Found): void {
	const kind = index.kindOf(entry)

	if (kind === ReviewKind.COMMENT_START && found.start < 0) found.start = index.fromOf(entry)
	else if (kind === ReviewKind.COMMENT_END && found.end < 0) found.end = index.fromOf(entry)
	else if (kind === ReviewKind.COMMENT_REFERENCE && found.reference < 0) found.reference = index.fromOf(entry)
}

// Comment anchors of an index by id, the first of each kind, in document order.
function indexAnchors(index: ReviewIndex): Map<string, Found> {
	const out = new Map<string, Found>()

	if (index.commentCount === 0) return out

	for (const entry of index.commentEntries()) {
		if (COMMENT_KINDS[index.kindOf(entry)] === undefined) continue

		const id = index.idOf(entry)
		let found = out.get(id)

		if (found === undefined) {
			found = { start: -1, end: -1, reference: -1 }
			out.set(id, found)
		}

		noteAnchor(index, entry, found)
	}

	return out
}

// The anchors of comment `id` alone (indexAnchors(index).get(id)).
function anchorsOf(index: ReviewIndex, id: string): Found | undefined {
	if (index.commentCount === 0) return undefined

	let found: Found | undefined

	for (const entry of index.commentEntries()) {
		if (COMMENT_KINDS[index.kindOf(entry)] === undefined || index.idOf(entry) !== id) continue

		found ??= { start: -1, end: -1, reference: -1 }
		noteAnchor(index, entry, found)
	}

	return found
}

// Where a marker of a story's document is held: an inline node of its own, a block's (or the story's)
// marker list, or the bytes of an atom or locked block (which the editor cannot change).
type Holder =
	| { readonly kind: "inline"; readonly pos: number; readonly node: Node }
	| { readonly kind: "list"; readonly pos: number; readonly attr: "before" | "end"; readonly list: MarkerList }
	| { readonly kind: "bytes" }

function listHas(list: unknown, key: string): list is MarkerList {
	return Array.isArray(list) && (list as MarkerList).some(marker => markerKey(marker) === key)
}

// The top-level block holding a position (its index and start), moved forward over positions given in order: each
// lookup starts from the previous block instead of from the document's first.
interface TopCursor {
	index: number
	offset: number
}

// The cursor at the block holding `pos` (offset <= pos < offset + nodeSize), undefined at the document's end.
function topAt(doc: Node, cursor: TopCursor, pos: number): TopCursor | undefined {
	if (pos < cursor.offset || pos >= doc.content.size) return undefined

	for (let size = doc.child(cursor.index).nodeSize; cursor.offset + size <= pos; size = doc.child(cursor.index).nodeSize) {
		cursor.offset += size
		cursor.index++
	}

	return cursor
}

// What holderOf() reads of a resolved position.
interface Depths {
	readonly depth: number
	end(depth: number): number
	node(depth: number): Node
	before(depth: number): number
}

const BETWEEN_BLOCKS: Depths = {
	depth: 0,
	end: () => 0,
	node: () => {
		throw new RangeError("No node between top-level blocks")
	},
	before: () => 0
}

// doc.resolve(pos) read through the block at `top` (pos inside it or at its start).
function depthsIn(doc: Node, pos: number, top: TopCursor): Depths {
	const start = top.offset

	if (pos === start) return BETWEEN_BLOCKS

	const base = start + 1
	const inner = doc.child(top.index).resolve(pos - base)

	return {
		depth: inner.depth + 1,
		end: depth => base + inner.end(depth - 1),
		node: depth => inner.node(depth - 1),
		before: depth => (depth === 1 ? start : base + inner.before(depth - 1))
	}
}

// `top`: the block holding `pos` (topAt()), so it is not looked up from the document's start.
function holderOf(doc: Node, pos: number, kind: MarkerKind, id: string, top?: TopCursor): Holder {
	const key = `${kind}:${id}`

	if (pos === doc.content.size) {
		const end = doc.attrs["end"]

		if (listHas(end, key)) return { kind: "list", pos: -1, attr: "end", list: end }
	}

	const node =
		pos >= doc.content.size
			? null
			: top === undefined
				? doc.nodeAt(pos)
				: pos === top.offset
					? doc.child(top.index)
					: doc.child(top.index).nodeAt(pos - top.offset - 1)

	if (node !== null) {
		if (node.isInline) {
			const own = node.type === nodes.marker || node.type === nodes.comment_ref

			if (
				own &&
				markerKey({
					src: NO_SOURCE,
					kind: node.type === nodes.comment_ref ? "commentReference" : (node.attrs["kind"] as MarkerKind),
					id: node.attrs["id"] as string | null
				}) === key
			)
				return { kind: "inline", pos, node }
		} else if (listHas(node.attrs["before"], key)) {
			return { kind: "list", pos, attr: "before", list: node.attrs["before"] as MarkerList }
		}
	}

	const $pos: Depths = top === undefined ? doc.resolve(pos) : depthsIn(doc, pos, top)

	for (let depth = $pos.depth; depth > 0; depth--) {
		if ($pos.end(depth) !== pos) break

		const end = $pos.node(depth).attrs["end"]

		if (listHas(end, key)) return { kind: "list", pos: $pos.before(depth), attr: "end", list: end }
	}

	return { kind: "bytes" }
}

// Steps taking markers out of lists (positions unchanged) and inline nodes out (from the back).
function removeMarkers(tr: Transaction, holders: readonly { holder: Holder; key: string }[]): void {
	const lists = new Map<string, { pos: number; attr: "before" | "end"; keys: Set<string>; list: MarkerList }>()
	const inline: number[] = []

	for (const { holder, key } of holders) {
		if (holder.kind === "inline") {
			inline.push(holder.pos)
		} else if (holder.kind === "list") {
			const slot = `${String(holder.pos)}:${holder.attr}`
			const entry = lists.get(slot) ?? { pos: holder.pos, attr: holder.attr, keys: new Set<string>(), list: holder.list }

			entry.keys.add(key)
			lists.set(slot, entry)
		}
	}

	for (const { pos, attr, keys, list } of lists.values()) {
		const kept = list.filter(marker => !keys.has(markerKey(marker)))

		if (pos < 0) tr.setDocAttribute(attr, kept)
		else tr.setNodeAttribute(pos, attr, kept)
	}

	for (const pos of [...new Set(inline)].sort((a, b) => b - a)) tr.delete(pos, pos + 1)
}

// Wrapper marks (links, revisions, content controls) both neighbours of `pos` share: a marker placed there
// stays inside them.
function wrappersAt(doc: Node, pos: number): readonly Mark[] {
	const $pos = doc.resolve(pos)
	const before = $pos.nodeBefore
	const after = $pos.nodeAfter

	if (before === null || after === null) return Mark.none

	return before.marks.filter(mark => WRAPPERS.has(mark.type) && mark.isInSet(after.marks))
}

function markerNode(kind: "commentRangeStart" | "commentRangeEnd", id: string, nodeMarks: readonly Mark[]): Node {
	return nodes.marker.create({ src: NO_SOURCE, kind, id, name: null }, null, nodeMarks)
}

// The word the caret is in or next to (Word anchors a comment there), else the caret.
function wordAround(state: EditorState): { from: number; to: number } {
	const $head = state.selection.$head
	const parent = $head.parent
	const head = $head.pos

	if (!parent.isTextblock) return { from: head, to: head }

	const text = parent.textBetween(0, parent.content.size, undefined, "￼")
	const offset = $head.parentOffset
	let found: { from: number; to: number } | undefined

	wordSegments(text, (start, end, flags) => {
		if (found !== undefined || (flags & (WORD_LETTER | WORD_NUMBER | WORD_KANA)) === 0) return
		if (start <= offset && offset <= end) found = { from: head - offset + start, to: head - offset + end }
	})

	return found ?? { from: head, to: head }
}

// The range a new comment anchors: the selection's text (from the first textblock position on), or the word
// at the caret.
function anchorRange(state: EditorState): { from: number; to: number } | undefined {
	const selection = state.selection

	if (selection.empty) return wordAround(state)

	const doc = state.doc
	const start = TextSelection.between(doc.resolve(selection.from), doc.resolve(selection.from), 1)
	const end = TextSelection.between(doc.resolve(selection.to), doc.resolve(selection.to), -1)

	if (!start.$from.parent.isTextblock || !end.$to.parent.isTextblock || start.from > end.to) return undefined

	return { from: start.from, to: end.to }
}

// The comment ids whose ranges hold `pos` (or whose reference is next to it) in a story, innermost first,
// from the story's review index: its comment entries before `pos` only, nothing allocated per entry.
export function commentsAt(index: ReviewIndex, pos: number): readonly string[] {
	if (index.commentCount === 0) return []

	const entries = index.commentEntries()
	const open: string[] = []

	for (let k = 0; k < entries.length; k++) {
		const entry = entries[k] ?? 0
		const from = index.fromOf(entry)

		if (from > pos) break

		const kind = index.kindOf(entry)
		const id = index.idOf(entry)

		if (kind === ReviewKind.COMMENT_START) {
			open.push(id)
		} else if (kind === ReviewKind.COMMENT_END && from < pos) {
			const at = open.lastIndexOf(id)

			if (at >= 0) open.splice(at, 1)
		} else if (kind === ReviewKind.COMMENT_REFERENCE && from + 1 >= pos && !open.includes(id)) {
			open.push(id)
		}
	}

	return open.reverse()
}

// ---- the store --------------------------------------------------------------------------------------------

interface SourceComment {
	readonly id: string
	readonly story: Story
	readonly part: StoryPart
	readonly author: string | undefined
	readonly initials: string | undefined
	readonly date: string | undefined
	readonly dateUtc: string | undefined
	readonly paraId: string | undefined
	readonly parentId: string | undefined
	readonly done: boolean
	readonly anchor: number
}

interface Live {
	readonly id: string
	readonly story: number
	// Positions in the story's document, or for a story without a session its source items (order only).
	readonly start: number
	readonly reference: number
	readonly session: DocxEditorSession | undefined
	// No anchor is held in bytes (an atom, a locked block): the anchors can be taken out.
	readonly deletable: boolean
	// The reference is a node of its own: a reply's anchors can go next to it.
	readonly referable: boolean
}

interface Access {
	deletable: boolean
	referable: boolean
}

// What the commands can do with the anchors of comments `anchors` of a story's document: their markers are looked
// up in document order, each from the block of the one before.
function anchorAccesses(doc: Node, anchors: ReadonlyMap<string, Found>): Map<string, Access> {
	const out = new Map<string, Access>()
	const markers: { pos: number; kind: MarkerKind; id: string; access: Access }[] = []

	for (const [id, found] of anchors) {
		const access: Access = { deletable: true, referable: false }

		out.set(id, access)

		if (found.start >= 0) markers.push({ pos: found.start, kind: "commentRangeStart", id, access })
		if (found.end >= 0) markers.push({ pos: found.end, kind: "commentRangeEnd", id, access })
		if (found.reference >= 0) markers.push({ pos: found.reference, kind: "commentReference", id, access })
	}

	markers.sort((a, b) => a.pos - b.pos)

	const cursor: TopCursor = { index: 0, offset: 0 }

	for (const { pos, kind, id, access } of markers) {
		const holder = holderOf(doc, pos, kind, id, topAt(doc, cursor, pos))

		if (holder.kind === "bytes") access.deletable = false
		if (kind === "commentReference" && holder.kind === "inline") access.referable = true
	}

	return out
}

const STORES = new WeakMap<CommentHost, DocxComments>()

// The comments of the document `host` edits (one store per host).
export function docxComments(host: CommentHost): DocxComments {
	let store = STORES.get(host)

	if (store === undefined) {
		store = new DocxComments(host)
		STORES.set(host, store)
	}

	return store
}

export class DocxComments {
	private readonly host: CommentHost
	private readonly context: DocxEditContext
	private readonly sources = new Map<string, SourceComment>()
	private readonly sourceTexts = new Map<string, readonly string[]>()
	private readonly plain = new Map<string, boolean>()
	private readonly listeners = new Set<() => void>()
	private readonly watched = new WeakSet<DocxEditorSession>()
	private signature: unknown[] = []
	private threadsValue: readonly DocxCommentThread[] = Object.freeze([])
	private byId = new Map<string, DocxComment>()
	private live = new Map<string, Live>()
	private versionValue = 0
	private notifying = false

	constructor(host: CommentHost) {
		this.host = host
		this.context = host.body.session.context

		const model = this.context.model

		for (const comment of model.comments) {
			const story = model.stories[comment.story]
			const part = story === undefined ? undefined : model.parts[story.part]

			if (story === undefined || part === undefined || comment.id === "") continue

			this.sources.set(comment.id, {
				id: comment.id,
				story,
				part,
				author: comment.author,
				initials: comment.initials,
				date: comment.date,
				dateUtc: comment.dateUtc,
				paraId: comment.paraId,
				parentId: comment.parentId,
				done: comment.done,
				anchor: comment.anchor
			})
		}
	}

	// Changes whenever threads() would answer differently.
	get version(): number {
		this.refresh()

		return this.versionValue
	}

	// Hears (a microtask after) every change of the threads.
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		this.refresh()

		return () => {
			this.listeners.delete(listener)
		}
	}

	// Every comment anchored in the document as edited, in threads, in document order (the body first): the
	// same objects while they are unchanged.
	threads(): readonly DocxCommentThread[] {
		this.refresh()

		return this.threadsValue
	}

	comment(id: string): DocxComment | undefined {
		this.refresh()

		return this.byId.get(id)
	}

	// The id of the thread `id` belongs to.
	threadOf(id: string): string | undefined {
		const comment = this.comment(id)

		return comment === undefined ? undefined : (comment.parentId ?? comment.id)
	}

	// Where comment `id` is in its story now (that story's session is made if it has none).
	anchor(id: string): DocxCommentAnchor | undefined {
		const comment = this.comment(id)

		if (comment === undefined) return undefined

		const session = this.host.storySession(comment.story)
		const found = session === undefined ? undefined : anchorsOf(session.reviewIndex, id)

		if (found === undefined) return undefined

		const from = found.start >= 0 ? found.start : found.reference
		const to = found.end >= 0 ? Math.max(from, found.end) : from

		return { story: comment.story, from, to, reference: found.reference }
	}

	// ---- commands -------------------------------------------------------------------------------------------

	// Whether the store can add a comment to the story being edited (an author is still needed to run it): the
	// main document's text only, as in Word (headers, footers, notes and text boxes keep the comments they have).
	canAdd(): boolean {
		const session = this.active()

		return (
			this.host.addStory !== undefined &&
			session !== undefined &&
			!session.readOnly &&
			!this.host.body.session.readOnly &&
			session.story.story.kind === "body"
		)
	}

	// A new comment on the selection (or the word at the caret) of the story being edited.
	add(text: string): boolean {
		const session = this.active()
		const author = this.context.identity.author

		if (author === undefined || session === undefined || !this.canAdd()) return false

		const range = anchorRange(session.state)

		if (range === undefined) return false

		const made = this.newComment(text, undefined)

		if (made === undefined) return false

		const { id } = made
		const tr = session.state.tr
		const doc = tr.doc
		const reference = this.referenceNode(id, wrappersAt(doc, range.to))

		tr.insert(range.to, [markerNode("commentRangeEnd", id, wrappersAt(doc, range.to)), reference])
		tr.insert(range.from, markerNode("commentRangeStart", id, wrappersAt(doc, range.from)))
		commentedPlaceholders(tr, session)

		return session.dispatch(markInternal(tr))
	}

	// A reply to the thread of comment `id`, anchored where its first comment is (it reopens a resolved
	// thread, as in Word).
	reply(id: string, text: string): boolean {
		this.withSession(this.threadOf(id) ?? id)

		const author = this.context.identity.author
		const root = this.comment(this.threadOf(id) ?? "")

		if (author === undefined || root === undefined || !root.canReply) return false

		const session = this.host.storySession(root.story)

		if (session === undefined || session.readOnly) return false

		const doc = session.state.doc
		const found = indexAnchors(session.reviewIndex)
		const anchors = found.get(root.id)

		if (anchors === undefined || anchors.reference < 0) return false

		// As Word places them: the range starts after the thread's starts, and ends with the reference after
		// the thread's last reference.
		const thread = this.threadsValue.find(candidate => candidate.id === root.id)
		const members = new Set([root.id, ...(thread?.replies.map(reply => reply.id) ?? [])])
		const member = (node: Node | null, kinds: readonly string[]): boolean =>
			node !== null &&
			members.has(node.attrs["id"] as string) &&
			(node.type === nodes.comment_ref
				? kinds.includes("commentReference")
				: node.type === nodes.marker && kinds.includes(node.attrs["kind"] as string))
		const referenceAt = holderOf(doc, anchors.reference, "commentReference", root.id)

		if (referenceAt.kind !== "inline") return false

		let after = anchors.reference + 1

		while (member(doc.nodeAt(after), ["commentReference", "commentRangeEnd"])) after++

		const start = anchors.start < 0 ? undefined : holderOf(doc, anchors.start, "commentRangeStart", root.id)

		if (!this.ensureParaId(root.id)) return false

		const made = this.newComment(text, root.id)

		if (made === undefined) return false

		const reply = made.id
		const tr = session.state.tr
		const wrappers = referenceAt.node.marks.filter(mark => WRAPPERS.has(mark.type))
		const ranged = start !== undefined && start.kind !== "bytes"
		const ending = [...(ranged ? [markerNode("commentRangeEnd", reply, wrappers)] : []), this.referenceNode(reply, wrappers)]
		let opening: { pos: number; node: Node } | undefined

		if (start?.kind === "inline") {
			let at = start.pos + 1

			while (member(doc.nodeAt(at), ["commentRangeStart"])) at++

			opening = {
				pos: at,
				node: markerNode(
					"commentRangeStart",
					reply,
					start.node.marks.filter(mark => WRAPPERS.has(mark.type))
				)
			}
		} else if (start?.kind === "list") {
			let at = start.list.findIndex(item => markerKey(item) === `commentRangeStart:${root.id}`)

			while (
				at + 1 < start.list.length &&
				start.list[at + 1]?.kind === "commentRangeStart" &&
				members.has(start.list[at + 1]?.id ?? "")
			)
				at++

			const marker: MarkerAttrs = { src: NO_SOURCE, kind: "commentRangeStart", id: reply }
			const list = [...start.list.slice(0, at + 1), marker, ...start.list.slice(at + 1)]

			if (start.pos < 0) tr.setDocAttribute(start.attr, list)
			else tr.setNodeAttribute(start.pos, start.attr, list)
		}

		tr.insert(after, ending)

		if (opening !== undefined) tr.insert(opening.pos, opening.node)

		const changes: Record<string, DocxCommentRecord | undefined> = {
			[reply]: { ...commentRecords(doc)[reply], parent: root.id }
		}

		// Replying reopens the thread.
		if (thread?.done === true) for (const member of members) changes[member] = this.withDone(commentRecords(doc), member, false)

		tr.setDocAttribute("comments", withRecords(commentRecords(doc), changes))

		return session.dispatch(markInternal(tr))
	}

	// New text for comment `id` (one undoable step of its story): only paragraphs whose text changed are
	// rewritten, so the others keep their bytes; the last paragraph stays the last (commentsExtended keys on it).
	edit(id: string, text: string): boolean {
		const comment = this.comment(id)

		if (this.context.identity.author === undefined || comment === undefined || !comment.canEdit) return false

		const session = this.commentSession(id)

		if (session === undefined || session.readOnly) return false

		// New paragraphs take the style of the comment's last (as Enter there would).
		const style = session.state.doc.lastChild?.attrs["styleId"]
		const tr = editText(session.state, commentParagraphs(text), typeof style === "string" ? style : null)

		if (tr === undefined) return false
		if (!tr.docChanged) return true

		return session.dispatch(closeHistory(markInternal(tr)))
	}

	// Resolves (or reopens) the thread of comment `id`: every comment of it that has a paragraph id.
	resolve(id: string, done: boolean): boolean {
		this.withSession(id)

		const thread = this.threads().find(candidate => candidate.id === this.threadOf(id))

		if (thread === undefined || !thread.comment.canResolve) return false

		const session = this.host.storySession(thread.comment.story)

		if (session === undefined || session.readOnly) return false

		const members = [thread.comment, ...thread.replies]

		if (members.every(member => member.done === done)) return true

		const changes: Record<string, DocxCommentRecord | undefined> = {}
		const records = commentRecords(session.state.doc)

		for (const member of members) {
			if (member.story !== thread.comment.story || !this.ensureParaId(member.id)) continue

			changes[member.id] = this.withDone(records, member.id, done)
		}

		const tr = session.state.tr.setDocAttribute("comments", withRecords(records, changes))

		return session.dispatch(markInternal(tr))
	}

	// Deletes comment `id` with its anchors; the first comment of a thread takes its replies with it.
	remove(id: string): boolean {
		this.withSession(id)

		const comment = this.comment(id)

		if (comment === undefined || !comment.canDelete) return false

		const thread = comment.parentId === undefined ? this.threadsValue.find(candidate => candidate.id === id) : undefined
		const members = [comment, ...(thread?.replies ?? [])]

		if (members.some(member => member.story !== comment.story)) return false

		const session = this.host.storySession(comment.story)

		if (session === undefined || session.readOnly) return false

		const doc = session.state.doc
		const found = indexAnchors(session.reviewIndex)
		const holders: { holder: Holder; key: string }[] = []

		for (const member of members) {
			const anchors = found.get(member.id)

			if (anchors === undefined) return false

			for (const [pos, kind] of [
				[anchors.start, "commentRangeStart"],
				[anchors.end, "commentRangeEnd"],
				[anchors.reference, "commentReference"]
			] as const) {
				if (pos < 0) continue

				const holder = holderOf(doc, pos, kind, member.id)

				if (holder.kind === "bytes") return false

				holders.push({ holder, key: `${kind}:${member.id}` })
			}
		}

		const tr = session.state.tr
		const changes: Record<string, DocxCommentRecord | undefined> = {}
		const records = commentRecords(doc)

		for (const member of members) {
			changes[member.id] = member.added ? records[member.id] : { ...records[member.id], deleted: true }
		}

		tr.setDocAttribute("comments", withRecords(records, changes))
		removeMarkers(tr, holders)

		return session.dispatch(markInternal(tr))
	}

	// Selects the anchor of the next (or previous) thread after the selection, across stories, wrapping
	// around; false without comments.
	step(forward: boolean): boolean {
		const threads = this.threads()
		const session = this.active()

		if (threads.length === 0 || session === undefined) return false

		const here = this.rank(session.story.story.index, session.state.selection.from)
		const ranked = threads.map(thread => ({ thread, rank: this.rankOf(thread.id) }))
		const ordered = forward ? ranked : [...ranked].reverse()
		const target = ordered.find(entry => (forward ? compare(entry.rank, here) > 0 : compare(entry.rank, here) < 0)) ?? ordered[0]

		return target !== undefined && this.select(target.thread.id)
	}

	// Selects comment `id`'s range (entering its story when it is another one on the pages).
	select(id: string): boolean {
		const anchor = this.anchor(id)

		if (anchor === undefined) return false

		const active = this.active()

		if (active?.story.story.index !== anchor.story && this.host.enterStory?.(anchor.story, -1) !== true) return false

		const session = this.host.storySession(anchor.story)

		if (session === undefined) return false

		const doc = session.state.doc

		return session.dispatch(session.state.tr.setSelection(TextSelection.between(doc.resolve(anchor.from), doc.resolve(anchor.to))))
	}

	// ---- for the handlers, the snapshot and the save ---------------------------------------------------------

	// Whether anything in the document is a comment (cheap: no index is built).
	any(): boolean {
		if (this.sources.size > 0) return true

		for (const story of this.context.newStories.values()) if (story.kind === "comment") return true

		return false
	}

	// ---- internals -----------------------------------------------------------------------------------------

	// Comment `id`'s story gets its session when it has none (a command on a comment of a note never shown):
	// what the commands can do there is read from its document.
	private withSession(id: string): void {
		const comment = this.comment(id)

		if (comment !== undefined && this.live.get(id)?.session === undefined) this.host.storySession(comment.story)
	}

	private active(): DocxEditorSession | undefined {
		return this.host.session ?? this.host.body.session
	}

	private withDone(records: DocxCommentRecords, id: string, done: boolean): DocxCommentRecord {
		const { done: _done, ...rest } = records[id] ?? {}
		const source = this.sources.get(id)

		return source !== undefined && source.done === done ? rest : { ...rest, done }
	}

	// The paragraph style of comment text: the document's, else Word's (10 pt), which the save then defines.
	private textStyle(): string {
		return builtInStyleId(this.context, "annotation text")
	}

	// The character style of comment marks: the document's, else Word's (8 pt).
	private referenceStyle(): string {
		return builtInStyleId(this.context, "annotation reference")
	}

	private referenceNode(id: string, wrappers: readonly Mark[]): Node {
		const nodeMarks = marks.char_style.create({ styleId: this.referenceStyle() }).addToSet(wrappers)

		return nodes.comment_ref.create({ src: NO_SOURCE, id }, null, nodeMarks)
	}

	// A new comment's story with its text, author and date (outside the undo history: the anchor step that
	// refers to it is what undoes). Its last paragraph gets a w14:paraId where its part can hold one.
	private newComment(text: string, parent: string | undefined): { id: string; session: DocxEditorSession } | undefined {
		const author = this.context.identity.author

		if (author === undefined || (parent !== undefined && !this.canThread())) return undefined

		const session = this.host.addStory?.("comment")
		const id = session === undefined ? undefined : this.context.newStories.get(session.story.story)?.id

		if (session === undefined || id === undefined) return undefined

		const paraId = paraIdsPossible(session.story.part.document) ? this.newParaId() : undefined
		const texts = commentParagraphs(text)
		const style = this.textStyle()
		const mark = annotationMark(this.referenceStyle())
		const blocks = texts.map((paragraph, k) =>
			newParagraph(paragraph, style, k === texts.length - 1 ? paraId : undefined, k === 0 ? mark : undefined)
		)
		const record: DocxCommentRecord = {
			author,
			...(this.context.identity.initials === undefined ? {} : { initials: this.context.identity.initials }),
			...timestamps(this.context.identity.now())
		}
		const tr = session.state.tr.replaceWith(0, session.state.doc.content.size, blocks)

		tr.setDocAttribute("comments", Object.freeze({ [id]: Object.freeze(record) }))

		if (!session.dispatch(markInternal(tr).setMeta("addToHistory", false))) return undefined

		return { id, session }
	}

	// Whether a new comment can carry a paragraph id (threads and resolved states key on it): the part new
	// comments go into (the document's comments part, or one made from the main document's namespaces)
	// declares w14.
	private canThread(): boolean {
		const model = this.context.model
		const added = [...this.context.newStories.keys()].find(story => story.kind === "comment")
		const name = model.package.part("comments")
		const part =
			added !== undefined
				? this.host.sessions.find(session => session.story.story === added)?.story.part
				: name !== undefined && model.package.has(name)
					? model.parts.find(candidate => candidate.name === name)
					: model.body === undefined
						? undefined
						: model.parts[model.body.part]

		return part !== undefined && paraIdsPossible(part.document)
	}

	private newParaId(): string {
		const taken = sourceParaIds(this.context.model)

		return this.context.ids.paraId(id => hasSorted(taken, id))
	}

	// The session of comment `id`'s own story (made on first use).
	private commentSession(id: string): DocxEditorSession | undefined {
		const source = this.sources.get(id)

		if (source !== undefined) return this.host.storySession(source.story.index)

		for (const [story, made] of this.context.newStories)
			if (made.kind === "comment" && made.id === id) return this.host.storySession(story.index)

		return undefined
	}

	// The paragraph id of comment `id`'s last paragraph, or undefined when it has none (ensureParaId gives one).
	private paraIdOf(id: string): string | undefined {
		const session = this.sessionOfComment(id)
		const doc = session?.state.doc
		const last = doc?.lastChild ?? null
		const mark = last === null ? undefined : marks.para_id.isInSet(last.marks)

		if (mark !== undefined) return mark.attrs["id"] as string

		return this.sources.get(id)?.paraId
	}

	private sessionOfComment(id: string): DocxEditorSession | undefined {
		const story = this.commentStoryIndex(id)

		return story === undefined ? undefined : this.host.sessions.find(session => session.story.story.index === story)
	}

	private commentStoryIndex(id: string): number | undefined {
		const source = this.sources.get(id)

		if (source !== undefined) return source.story.index

		for (const [story, made] of this.context.newStories) if (made.kind === "comment" && made.id === id) return story.index

		return undefined
	}

	// Gives comment `id`'s last paragraph a paragraph id (outside the undo history) when it has none; whether it
	// has one then.
	private ensureParaId(id: string): boolean {
		if (this.paraIdOf(id) !== undefined) return true

		const session = this.commentSession(id)
		const doc = session?.state.doc
		const last = doc?.lastChild ?? null

		if (session === undefined || doc === undefined || last === null || !last.isTextblock || session.readOnly) return false
		if (!paraIdsPossible(session.story.part.document)) return false

		const tr = session.state.tr.addNodeMark(doc.content.size - last.nodeSize, marks.para_id.create({ id: this.newParaId() }))

		return session.dispatch(markInternal(tr).setMeta("addToHistory", false))
	}

	private rank(story: number, pos: number): readonly [number, number] {
		return [story === this.host.body.session.story.story.index ? -1 : story, pos]
	}

	private rankOf(id: string): readonly [number, number] {
		const live = this.live.get(id)

		return live === undefined ? [Number.MAX_SAFE_INTEGER, 0] : this.rank(live.story, live.start >= 0 ? live.start : live.reference)
	}

	// What the threads depend on, compared item by item: each session's document attributes and review index
	// version (stories with anchors), or its document (comment stories).
	private currentSignature(): unknown[] {
		const out: unknown[] = [this.host.sessions.length, this.host.body.session.readOnly]

		for (const session of this.host.sessions) {
			out.push(session)

			if (session.story.story.kind === "comment") {
				out.push(session.state.doc)
			} else {
				out.push(session.state.doc.attrs["comments"], session.reviewIndex.commentVersion, session.readOnly)
			}
		}

		return out
	}

	private refresh(): void {
		// Neither the document nor the editor has a comment: no index is built for nothing.
		if (!this.any()) return

		const signature = this.currentSignature()

		if (signature.length === this.signature.length && signature.every((value, k) => value === this.signature[k])) return

		this.signature = signature
		this.compute()
	}

	private watch(session: DocxEditorSession): void {
		if (this.watched.has(session)) return

		this.watched.add(session)
		session.onApplied(() => this.changed())
	}

	private changed(): void {
		if (this.listeners.size === 0 || this.notifying) return

		this.notifying = true
		void Promise.resolve().then(() => {
			this.notifying = false

			const before = this.versionValue

			this.refresh()

			if (this.versionValue !== before) for (const listener of this.listeners) listener()
		})
	}

	private compute(): void {
		const context = this.context
		const model = context.model
		const bodyReadOnly = this.host.body.session.readOnly
		const sessions = new Map<number, DocxEditorSession>()
		const records = new Map<string, DocxCommentRecord>()
		const own = new Map<string, DocxCommentRecord>()
		const live = new Map<string, Live>()
		const anchors = model.commentAnchors
		const sourceStory = (source: SourceComment): number | undefined => anchorStory(model, source.anchor)
		// The body's comments are its session's; a comment in another story (a note, a header) is listed as the
		// file has it until that story gets its session (shown on the pages, entered, or a command needs it): a
		// document with comments in many notes makes none of their sessions to open.
		this.host.storySession(this.host.body.session.story.story.index)

		for (const session of this.host.sessions) {
			sessions.set(session.story.story.index, session)
			this.watch(session)

			const doc = session.state.doc

			for (const [id, record] of Object.entries(commentRecords(doc))) {
				if (session.story.story.kind === "comment") own.set(id, record)
				else records.set(id, record)
			}

			if (session.story.story.kind === "comment") continue

			const anchored = new Map<string, Found>()

			for (const [id, found] of indexAnchors(session.reviewIndex))
				if (found.reference >= 0 || found.start >= 0) anchored.set(id, found)

			for (const [id, access] of anchorAccesses(doc, anchored)) {
				const found = anchored.get(id)

				if (found === undefined) continue

				live.set(id, {
					id,
					story: session.story.story.index,
					start: found.start,
					reference: found.reference,
					session,
					...access
				})
			}
		}

		// Source comments in stories the host has no session for (a host of some sessions alone): listed as the
		// source has them; nothing can change their anchors.
		for (const source of this.sources.values()) {
			if (live.has(source.id) || source.anchor < 0) continue

			const story = sourceStory(source)

			if (story === undefined || sessions.has(story)) continue

			const referenceItem = anchors.referenceItem[source.anchor] ?? -1
			const startItem = anchors.startItem[source.anchor] ?? -1
			const sameStory = referenceItem < 0 || anchors.startPart[source.anchor] === anchors.referencePart[source.anchor]

			live.set(source.id, {
				id: source.id,
				story,
				start: sameStory ? startItem : -1,
				reference: referenceItem,
				session: undefined,
				deletable: false,
				referable: false
			})
		}

		const threadable = this.canThread()
		const comments = new Map<string, DocxComment>()

		for (const entry of live.values()) {
			const record = records.get(entry.id) ?? {}
			const source = this.sources.get(entry.id)
			const added = source === undefined

			if (record.deleted === true) continue

			const storyIndex = this.commentStoryIndex(entry.id)

			if (storyIndex === undefined) continue

			const commentSession = sessions.get(storyIndex)
			const meta = added ? (own.get(entry.id) ?? {}) : source
			const texts = commentSession !== undefined ? storyParagraphTexts(commentSession.state.doc) : this.sourceText(source)
			const anchorStory = model.stories[entry.story]
			const anchorReadOnly =
				bodyReadOnly ||
				(entry.session?.readOnly ?? (anchorStory === undefined ? true : readOnlyReasons(context, anchorStory, false).length > 0))
			const editable =
				!bodyReadOnly &&
				(commentSession === undefined
					? source !== undefined && this.plainSource(source)
					: !commentSession.readOnly && plainDoc(commentSession.state.doc))
			const paraId = this.paraIdOf(entry.id)
			const canThread =
				paraId !== undefined ||
				(commentSession !== undefined
					? paraIdsPossible(commentSession.story.part.document)
					: source !== undefined && paraIdsPossible(source.part.document))
			const comment: DocxComment = {
				id: entry.id,
				parentId: source?.parentId ?? record.parent,
				author: meta?.author,
				initials: meta?.initials,
				date: meta?.date,
				dateUtc: meta?.dateUtc,
				done: record.done ?? source?.done ?? false,
				text: texts.join("\n"),
				story: entry.story,
				added,
				canEdit: editable,
				canReply: !anchorReadOnly && canThread && threadable && entry.referable && this.host.addStory !== undefined,
				canResolve: !anchorReadOnly && entry.session !== undefined && canThread,
				canDelete: !anchorReadOnly && entry.deletable
			}

			comments.set(entry.id, comment)
		}

		// Threads: replies under their thread's first comment (a reply to a reply belongs to the same thread).
		// Through deleted comments too: a reply to a deleted reply stays in the thread (the save re-parents it).
		const rootOf = (id: string): string => {
			const seen = new Set<string>([id])
			let root = id

			for (let at = id; ;) {
				const parent = comments.get(at)?.parentId ?? this.sources.get(at)?.parentId

				if (parent === undefined || seen.has(parent)) return root

				seen.add(parent)
				at = parent

				if (comments.has(at)) root = at
			}
		}
		const order = (a: string, b: string): number => compare(this.rankIn(live, a), this.rankIn(live, b)) || compareIds(a, b)
		const groups = new Map<string, string[]>()

		for (const id of [...comments.keys()].sort(order)) {
			const root = rootOf(id)
			const group = groups.get(root)

			if (group === undefined) groups.set(root, [id])
			else group.push(id)
		}

		const previous = this.byId
		const byId = new Map<string, DocxComment>()
		const keep = (comment: DocxComment): DocxComment => {
			const before = previous.get(comment.id)
			const out = before !== undefined && sameComment(before, comment) ? before : Object.freeze(comment)

			byId.set(out.id, out)

			return out
		}
		const threads: DocxCommentThread[] = []
		const roots = [...groups.keys()].sort(order)
		const previousThreads = new Map(this.threadsValue.map(thread => [thread.id, thread]))

		for (const root of roots) {
			const ids = groups.get(root) ?? []
			const head = comments.get(root) as DocxComment
			const members = ids.map(id => comments.get(id) as DocxComment)
			// The first comment's delete takes the replies (all in its story); a reply goes to the first comment.
			const first = keep({
				...head,
				parentId: undefined,
				canDelete: head.canDelete && members.every(member => member.canDelete && member.story === head.story)
			})
			// Replies in the order of their references (Word appends each after the thread's last).
			const replies = ids
				.filter(id => id !== root)
				.sort((a, b) => compare(this.rankIn(live, a, true), this.rankIn(live, b, true)) || compareIds(a, b))
				.map(id => keep({ ...(comments.get(id) as DocxComment), parentId: root, canReply: head.canReply }))
			const before = previousThreads.get(root)
			const thread =
				before !== undefined &&
				before.comment === first &&
				before.replies.length === replies.length &&
				before.replies.every((reply, k) => reply === replies[k])
					? before
					: Object.freeze({ id: root, comment: first, replies: Object.freeze(replies), done: first.done })

			threads.push(thread)
		}

		const same = threads.length === this.threadsValue.length && threads.every((thread, k) => thread === this.threadsValue[k])

		this.live = live
		this.byId = byId

		if (!same) {
			this.threadsValue = Object.freeze(threads)
			this.versionValue++
		}
	}

	private rankIn(live: ReadonlyMap<string, Live>, id: string, byReference = false): readonly [number, number] {
		const entry = live.get(id)

		if (entry === undefined) return [Number.MAX_SAFE_INTEGER, 0]

		return this.rank(entry.story, (byReference ? entry.reference < 0 : entry.start >= 0) ? entry.start : entry.reference)
	}

	private sourceText(source: SourceComment | undefined): readonly string[] {
		if (source === undefined) return []

		let out = this.sourceTexts.get(source.id)

		if (out === undefined) {
			out = Object.freeze(commentParagraphTexts(source.part, source.story.item))
			this.sourceTexts.set(source.id, out)
		}

		return out
	}

	private plainSource(source: SourceComment): boolean {
		let out = this.plain.get(source.id)

		if (out === undefined) {
			out = plainComment(source.part, source.story.item)
			this.plain.set(source.id, out)
		}

		return out
	}
}

function compare(a: readonly [number, number], b: readonly [number, number]): number {
	return a[0] - b[0] || a[1] - b[1]
}

function compareIds(a: string, b: string): number {
	return Number(a) - Number(b)
}

function sameComment(a: DocxComment, b: DocxComment): boolean {
	return (
		a.id === b.id &&
		a.parentId === b.parentId &&
		a.author === b.author &&
		a.initials === b.initials &&
		a.date === b.date &&
		a.dateUtc === b.dateUtc &&
		a.done === b.done &&
		a.text === b.text &&
		a.story === b.story &&
		a.added === b.added &&
		a.canEdit === b.canEdit &&
		a.canReply === b.canReply &&
		a.canResolve === b.canResolve &&
		a.canDelete === b.canDelete
	)
}

// The source story of comment anchor row `anchor`: its reference's, else its range start's.
function anchorStory(model: DocxModel, anchor: number): number | undefined {
	const anchors = model.commentAnchors
	const referenceItem = anchors.referenceItem[anchor] ?? -1
	const part = referenceItem >= 0 ? (anchors.referencePart[anchor] ?? -1) : (anchors.startPart[anchor] ?? -1)

	return storyOfItem(model, part, referenceItem >= 0 ? referenceItem : (anchors.startItem[anchor] ?? -1))
}

const NO_IDS: ReadonlySet<string> = new Set()

// Source comments the edits took every anchor of (the text they comment on deleted or cut with their
// reference): the save removes them, as Word deletes them. Only stories among `sessions` are looked at
// (elsewhere the source's anchors stand); a comment whose anchors a paste put back is kept.
export function orphanedComments(
	context: DocxEditContext,
	sessions: readonly DocxEditorSession[],
	docs: readonly Node[]
): ReadonlySet<string> {
	const model = context.model

	if (model.comments.length === 0) return NO_IDS

	const stories = new Set<number>()

	for (const session of sessions) if (session.story.story.kind !== "comment") stories.add(session.story.story.index)

	const candidates: string[] = []

	for (const comment of model.comments) {
		const story = comment.anchor < 0 ? undefined : anchorStory(model, comment.anchor)

		if (story !== undefined && stories.has(story)) candidates.push(comment.id)
	}

	if (candidates.length === 0) return NO_IDS

	const present = new Set<string>()

	sessions.forEach((session, k) => {
		if (session.story.story.kind === "comment") return

		const doc = docs[k] ?? session.state.doc
		const index = doc === session.state.doc ? session.reviewIndex : new ReviewIndex(doc)

		if (index.commentCount === 0) return

		for (const id of indexAnchors(index).keys()) present.add(id)
	})

	const out = candidates.filter(id => !present.has(id))

	return out.length === 0 ? NO_IDS : new Set(out)
}

// The story of part `part` holding item `item` (the innermost: a text box in a header is its own story).
function storyOfItem(model: DocxModel, part: number, item: number): number | undefined {
	const storyPart = model.parts[part]

	if (storyPart === undefined || item < 0) return undefined

	let found: Story | undefined

	for (const story of model.stories) {
		if (story.part !== part || story.item > item || storyPart.end(story.item) <= item) continue
		if (found === undefined || story.item > found.item) found = story
	}

	return found?.index
}

// Inline nodes plain comment text may hold (what editing it keeps or replaces).
const PLAIN_INLINE: ReadonlySet<unknown> = new Set([
	nodes.text,
	nodes.tab,
	nodes.break,
	nodes.hyphen,
	nodes.symbol,
	nodes.proof_err,
	nodes.rendered_break
])

function plainInline(node: Node): boolean {
	return PLAIN_INLINE.has(node.type) || (node.type === nodes.run_object && node.attrs["kind"] === "AnnotationMark")
}

// Whether a comment story's document is plain paragraphs (see plainComment).
function plainDoc(doc: Node): boolean {
	let plain = true

	doc.forEach(block => {
		if (!plain) return
		if (block.type !== nodes.paragraph || (block.attrs["before"] as MarkerList).length > 0) {
			plain = false

			return
		}

		block.forEach(child => {
			if (!plainInline(child)) plain = false
		})
	})

	return plain
}

// The step giving a comment story's document the paragraphs `texts`: unchanged paragraphs at the start and
// the end are kept, the last paragraph stays (its text replaced in place, its id kept), the rest is replaced.
// Undefined when the document is not plain paragraphs.
export function editText(state: EditorState, texts: readonly string[], styleId: string | null): Transaction | undefined {
	const doc = state.doc

	if (!plainDoc(doc) || doc.childCount === 0 || texts.length === 0) return undefined

	const old = storyParagraphTexts(doc)
	const n = old.length
	const m = texts.length
	let suffix = 1

	while (suffix < n && suffix < m && old[n - 1 - suffix] === texts[m - 1 - suffix]) suffix++

	let prefix = 0

	while (prefix < n - suffix && prefix < m - suffix && old[prefix] === texts[prefix]) prefix++

	const tr = state.tr
	const last = doc.lastChild as Node
	const lastAt = doc.content.size - last.nodeSize

	// The last paragraph's text, between its first and last text-like node (an annotation mark before it stays).
	if (old[n - 1] !== texts[m - 1]) {
		let from = -1
		let to = -1
		let textMarks: readonly Mark[] = Mark.none

		last.forEach((child, offset) => {
			if (child.type === nodes.run_object || child.type === nodes.proof_err || child.type === nodes.rendered_break) return

			if (from < 0) {
				from = offset
				textMarks = child.marks.filter(mark => !WRAPPERS.has(mark.type))
			}

			to = offset + child.nodeSize
		})

		const start = lastAt + 1 + (from < 0 ? last.content.size : from)
		const end = lastAt + 1 + (from < 0 ? last.content.size : to)

		tr.replaceWith(start, end, inlineContent(texts[m - 1] ?? "", textMarks))
	}

	let from = 0

	for (let k = 0; k < prefix; k++) from += doc.child(k).nodeSize

	let to = from

	for (let k = prefix; k < n - suffix; k++) to += doc.child(k).nodeSize

	const blocks = texts.slice(prefix, m - suffix).map(text => newParagraph(text, styleId, undefined))
	const lead = doc.firstChild?.firstChild ?? null

	// The first paragraph goes: its annotation mark moves to the paragraph that is first now.
	if (prefix === 0 && n - suffix > 0 && isAnnotationMark(lead)) {
		const first = blocks[0]

		if (first !== undefined) blocks[0] = first.copy(first.content.addToStart(lead))
		else if (!isAnnotationMark(last.firstChild)) tr.insert(lastAt + 1, lead)
	}

	if (to > from || blocks.length > 0) tr.replaceWith(from, to, blocks)

	return tr
}

// ---- revertible units (a save writes what the writer refuses as last saved) ----------------------------------

// Comment ids anchored in `doc` (a scan: made at save time only, a session's index is not created for it).
function anchorIds(doc: Node): Set<string> {
	return new Set([...indexAnchors(new ReviewIndex(doc)).keys()])
}

function sameRecord(a: DocxCommentRecord | undefined, b: DocxCommentRecord | undefined): boolean {
	if (a === b) return true
	if (a === undefined || b === undefined) return false

	const keys = new Set([...Object.keys(a), ...Object.keys(b)])

	for (const key of keys) if (Reflect.get(a, key) !== Reflect.get(b, key)) return false

	return true
}

// Comments of a story (not a comment's own) changed since its last save: their records, or whether they are
// anchored there.
function editedComments(session: DocxEditorSession): string[] {
	if (session.story.story.kind === "comment") return []

	const saved = session.savedDoc
	const doc = session.state.doc

	if (saved === doc) return []

	const before = commentRecords(saved)
	const after = commentRecords(doc)
	const out = new Set<string>()

	for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) if (!sameRecord(before[id], after[id])) out.add(id)

	const was = anchorIds(saved)
	const is = anchorIds(doc)

	for (const id of is) if (!was.has(id)) out.add(id)
	for (const id of was) if (!is.has(id)) out.add(id)

	return [...out].filter(id => /^-?\d{1,10}$/.test(id))
}

// The step taking comments `ids` of a story back to how it was last saved: their records as saved, the
// anchors of those it did not have then taken out (anchors deleted since stay deleted: the save removes a
// source comment left without any, see orphanedComments).
function revertComments(session: DocxEditorSession, ids: readonly string[]): Transaction | null {
	const saved = session.savedDoc
	const doc = session.state.doc
	const before = commentRecords(saved)
	const tr = session.state.tr
	const was = anchorIds(saved)
	const found = indexAnchors(new ReviewIndex(doc))
	const holders: { holder: Holder; key: string }[] = []
	const changes: Record<string, DocxCommentRecord | undefined> = {}

	for (const id of ids) {
		changes[id] = before[id]

		const anchors = found.get(id)

		if (was.has(id) || anchors === undefined) continue

		for (const [pos, kind] of [
			[anchors.start, "commentRangeStart"],
			[anchors.end, "commentRangeEnd"],
			[anchors.reference, "commentReference"]
		] as const) {
			if (pos < 0) continue

			const holder = holderOf(doc, pos, kind, id)

			if (holder.kind !== "bytes") holders.push({ holder, key: `${kind}:${id}` })
		}
	}

	const records = withRecords(commentRecords(doc), changes)

	if (records !== doc.attrs["comments"]) tr.setDocAttribute("comments", records)

	removeMarkers(tr, holders)

	return tr.docChanged ? markInternal(tr) : null
}

function idsOf(session: DocxEditorSession, keys: readonly number[]): string[] {
	const wanted = new Set(keys)

	return editedComments(session).filter(id => wanted.has(Number(id)))
}

// A comment is a unit of its own: when the save refuses because of one, its anchors and records go back to
// their last-saved form and the rest saves.
export const COMMENT_UNITS: RevertibleUnits = {
	kind: "comment",
	edited: session => editedComments(session).map(Number),
	withReverted(session, keys) {
		const tr = revertComments(session, idsOf(session, keys))

		return tr === null ? session : session.withTransaction(tr)
	},
	revert(session, keys) {
		const ids = idsOf(session, keys)
		const tr = revertComments(session, ids)

		return tr !== null && session.dispatch(closeHistory(tr)) ? ids.length : 0
	}
}

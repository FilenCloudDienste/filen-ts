import type { Node } from "prosemirror-model"
import { TextSelection, type Transaction } from "prosemirror-state"
import type { DocxEditContext } from "../edit/context"
import { ANY_BOOKMARK_NAME } from "../edit/commands/fields"
import { markInternal } from "../edit/invariants/index"
import { NO_SOURCE, docxSchema, type MarkerAttrs, type MarkerList } from "../edit/schema"
import type { DocxEditorSession } from "../edit/session"
import { Item, type StoryPart } from "../model/index"
import { Ns } from "../model/namespaces"

// Bookmarks of a story as its editing document holds them, found by one walk per document state (a command
// reads them, never a keystroke), and the commands that add, rename and delete them. A bookmark is a pair of
// range markers with one w:id; its name is in the start's source bytes or, for a new one, on the marker node.
// Word's names are case-insensitive, at most 40 characters; those starting with "_" are hidden (_Toc for a
// table of contents' headings, _GoBack for Word's last edit, _Ref for cross-references).

const nodes = docxSchema.nodes

// Word's limit on a bookmark name (ECMA-376 Part 1 §17.13.6.2: ST_String; Word refuses longer names).
export const MAX_BOOKMARK_NAME = 40

// Where a range marker sits: an inline marker node (`inline`, the commands may move, rename or delete it), or
// inside bytes kept as they are (an atom, a locked block) or a block's marker list (`kept`).
export type BookmarkPlace = "inline" | "kept"

export interface DocxBookmark {
	readonly name: string
	readonly id: string
	// The bookmarked content: [from, to) of the story's document (from after the start, to at the end).
	readonly from: number
	readonly to: number
	// The start marker's position (an inline marker node's, else the holder's) and where it sits.
	readonly startPos: number
	readonly start: BookmarkPlace
	// The end marker's position, -1 when the bookmark has no end.
	readonly endPos: number
	readonly end: BookmarkPlace | undefined
	readonly hidden: boolean
	// The source items of its start and end markers (NO_SOURCE for new ones or none): where in the bytes of a
	// locked block it starts or ends.
	readonly startItem: number
	readonly endItem: number
}

export interface BookmarkIndex {
	readonly doc: Node
	readonly list: readonly DocxBookmark[]
	// By lower-case name; the first of duplicates.
	readonly byName: ReadonlyMap<string, DocxBookmark>
}

interface Found {
	name: string | undefined
	id: string
	startPos: number
	from: number
	start: BookmarkPlace
	endPos: number
	to: number
	end: BookmarkPlace | undefined
	startItem: number
	endItem: number
}

const INDEXES = new WeakMap<Node, BookmarkIndex>()

export function validBookmarkName(name: string): boolean {
	return ANY_BOOKMARK_NAME.test(name)
}

// A source bookmark start's w:name.
function sourceName(part: StoryPart, item: number): string | undefined {
	return item >= 0 && item < part.count && part.kinds[item] === Item.BookmarkStart
		? part.reader.attr(part.node(item), Ns.W, "name")
		: undefined
}

// The bookmarks of `doc`, a document of a story of `part`.
export function bookmarkIndex(doc: Node, part: StoryPart): BookmarkIndex {
	const cached = INDEXES.get(doc)

	if (cached !== undefined) return cached

	const byId = new Map<string, Found>()
	const order: Found[] = []
	const add = (marker: MarkerAttrs, name: string | null | undefined, pos: number, after: number, place: BookmarkPlace): void => {
		if (marker.id === null || (marker.kind !== "bookmarkStart" && marker.kind !== "bookmarkEnd")) return

		let found = byId.get(marker.id)

		if (found === undefined) {
			found = {
				name: undefined,
				id: marker.id,
				startPos: -1,
				from: -1,
				start: "kept",
				endPos: -1,
				to: -1,
				end: undefined,
				startItem: NO_SOURCE,
				endItem: NO_SOURCE
			}
			byId.set(marker.id, found)
		}

		if (marker.kind === "bookmarkStart") {
			if (found.startPos >= 0) return

			found.name = (marker.src === NO_SOURCE ? (name ?? undefined) : sourceName(part, marker.src)) ?? undefined
			found.startPos = pos
			found.from = after
			found.start = place
			found.startItem = marker.src
			order.push(found)
		} else if (found.endPos < 0) {
			found.endPos = pos
			found.to = pos
			found.end = place
			found.endItem = marker.src
		}
	}
	const list = (markers: unknown, pos: number, after: number): void => {
		if (!Array.isArray(markers)) return

		for (const marker of markers as MarkerList) add(marker, null, pos, after, "kept")
	}

	list(doc.attrs["end"], doc.content.size, doc.content.size)
	doc.descendants((node, pos) => {
		list(node.attrs["before"], pos, pos)

		if (node.type === nodes.marker) {
			add(node.attrs as MarkerAttrs, node.attrs["name"] as string | null, pos, pos + 1, "inline")

			return false
		}

		list(node.attrs["markers"], pos, pos)

		if (node.isLeaf) return false

		list(node.attrs["end"], pos + node.nodeSize - 1, pos + node.nodeSize - 1)

		return true
	})

	const bookmarks: DocxBookmark[] = []
	const byName = new Map<string, DocxBookmark>()

	for (const found of order) {
		if (found.name === undefined) continue

		const bookmark: DocxBookmark = Object.freeze({
			name: found.name,
			id: found.id,
			from: found.from,
			to: found.endPos < 0 ? found.from : Math.max(found.from, found.to),
			startPos: found.startPos,
			start: found.start,
			endPos: found.endPos,
			end: found.end,
			hidden: found.name.startsWith("_"),
			startItem: found.startItem,
			endItem: found.endItem
		})

		bookmarks.push(bookmark)

		const key = found.name.toLowerCase()

		if (!byName.has(key)) byName.set(key, bookmark)
	}

	const index: BookmarkIndex = Object.freeze({ doc, list: Object.freeze(bookmarks), byName })

	INDEXES.set(doc, index)

	return index
}

export function sessionBookmarks(session: DocxEditorSession): BookmarkIndex {
	return bookmarkIndex(session.state.doc, session.story.part)
}

// The bookmark rows of a source part by name (lower case), read once per part.
const PART_NAMES = new WeakMap<StoryPart, ReadonlyMap<string, readonly number[]>>()

// Whether a source bookmark named `name` encloses items `first` to `last` of `part` (a legacy form field's
// own bookmark: Word's around the field, which a copy of the field does not get).
export function enclosingBookmark(part: StoryPart, first: number, last: number, name: string): boolean {
	let names = PART_NAMES.get(part)
	const table = part.bookmarks

	if (names === undefined) {
		const out = new Map<string, number[]>()

		for (let row = 0; row < table.count; row++) {
			const key = sourceName(part, table.start[row] ?? -1)?.toLowerCase()

			if (key === undefined) continue

			const rows = out.get(key)

			if (rows === undefined) out.set(key, [row])
			else rows.push(row)
		}

		names = out
		PART_NAMES.set(part, names)
	}

	return (names.get(name.toLowerCase()) ?? []).some(row => (table.start[row] ?? -1) < first && (table.end[row] ?? -1) > last)
}

// Names of the bookmarks every part of the source has (lower case), read once per document.
const SOURCE_NAMES = new WeakMap<object, ReadonlySet<string>>()

function sourceNames(context: DocxEditContext): ReadonlySet<string> {
	let names = SOURCE_NAMES.get(context.model)

	if (names === undefined) {
		const out = new Set<string>()

		for (const part of context.model.parts) {
			if (part === undefined) continue

			const table = part.bookmarks

			for (let row = 0; row < table.count; row++) {
				const name = sourceName(part, table.start[row] ?? -1)

				if (name !== undefined) out.add(name.toLowerCase())
			}
		}

		names = out
		SOURCE_NAMES.set(context.model, names)
	}

	return names
}

// Whether `name` is taken by a bookmark of the document: in `sessions` (their documents as edited), or in a
// story of the source no session edits.
export function bookmarkNameTaken(context: DocxEditContext, sessions: readonly DocxEditorSession[], name: string): boolean {
	const key = name.toLowerCase()

	for (const session of sessions) if (sessionBookmarks(session).byName.has(key)) return true

	if (!sourceNames(context).has(key)) return false

	for (const part of context.model.parts) {
		if (part === undefined) continue

		const table = part.bookmarks

		for (let row = 0; row < table.count; row++) {
			const item = table.start[row] ?? -1

			if (sourceName(part, item)?.toLowerCase() !== key) continue

			// One in a story a session edits counts as that session's document has it (above).
			const edited = sessions.some(session => {
				const story = session.story.story

				return story.part === part.index && (story.item < 0 || (item > story.item && item < part.end(story.item)))
			})

			if (!edited) return true
		}
	}

	return false
}

function bookmarkMarker(kind: "bookmarkStart" | "bookmarkEnd", id: string, name: string | null): Node {
	return nodes.marker.create({ src: NO_SOURCE, kind, id, name: kind === "bookmarkStart" ? name : null })
}

// Puts a new bookmark's markers around [from, to) of `tr`'s document (inline positions). The start goes
// before the end, so an empty range keeps their order.
export function insertBookmark(tr: Transaction, from: number, to: number, id: string, name: string): void {
	tr.insert(to, bookmarkMarker("bookmarkEnd", id, null))
	tr.insert(from, bookmarkMarker("bookmarkStart", id, name))
}

// Positions where markers may go inline: the selection's ends when both are in paragraphs.
function inlineRange(session: DocxEditorSession): { from: number; to: number } | undefined {
	const selection = session.state.selection
	const { $from, $to } = selection

	if (!(selection instanceof TextSelection) || !$from.parent.inlineContent || !$to.parent.inlineContent) return undefined
	if ($from.parent.type !== nodes.paragraph || $to.parent.type !== nodes.paragraph) return undefined

	return { from: $from.pos, to: $to.pos }
}

export function canAddBookmark(session: DocxEditorSession): boolean {
	return !session.readOnly && inlineRange(session) !== undefined
}

// Removes a bookmark's inline markers (both must be inline).
function removeMarkers(tr: Transaction, bookmark: DocxBookmark): void {
	const positions = [bookmark.startPos, bookmark.endPos].filter(pos => pos >= 0).sort((a, b) => b - a)

	for (const pos of positions) tr.delete(pos, pos + 1)
}

function movable(bookmark: DocxBookmark): boolean {
	return bookmark.start === "inline" && (bookmark.end === undefined || bookmark.end === "inline")
}

// Word's Insert > Bookmark > Add: the selection is bookmarked as `name`; a bookmark of that name in this story
// moves there (one in bytes kept as they are, or in another story, cannot: refused). One step, never tracked
// (Word records no revision for bookmarks).
export function addBookmark(session: DocxEditorSession, sessions: readonly DocxEditorSession[], name: string): boolean {
	const range = inlineRange(session)

	if (session.readOnly || range === undefined || !validBookmarkName(name) || name.length > MAX_BOOKMARK_NAME) return false

	const existing = sessionBookmarks(session).byName.get(name.toLowerCase())

	if (existing !== undefined && !movable(existing)) return false
	if (existing === undefined && bookmarkNameTaken(session.context, sessions, name)) return false

	const tr = session.state.tr
	const id = existing?.id ?? String(session.context.ids.next("bookmark"))

	if (existing !== undefined) removeMarkers(tr, existing)

	insertBookmark(tr, tr.mapping.map(range.from, -1), tr.mapping.map(range.to, 1), id, existing?.name ?? name)

	return session.dispatch(markInternal(tr))
}

// Deletes a bookmark (its markers; the text stays). Refused for one kept in bytes.
export function deleteBookmark(session: DocxEditorSession, name: string): boolean {
	const bookmark = sessionBookmarks(session).byName.get(name.toLowerCase())

	if (session.readOnly || bookmark === undefined || !movable(bookmark)) return false

	const tr = session.state.tr

	removeMarkers(tr, bookmark)

	return session.dispatch(markInternal(tr))
}

// Gives a bookmark another name: its start becomes a new marker with the same id (the end keeps its bytes).
export function renameBookmark(session: DocxEditorSession, sessions: readonly DocxEditorSession[], name: string, to: string): boolean {
	const bookmark = sessionBookmarks(session).byName.get(name.toLowerCase())

	if (session.readOnly || bookmark === undefined || bookmark.start !== "inline" || !validBookmarkName(to)) return false
	if (to === bookmark.name) return true
	if (to.toLowerCase() !== name.toLowerCase() && bookmarkNameTaken(session.context, sessions, to)) return false

	const tr = session.state.tr

	tr.replaceWith(bookmark.startPos, bookmark.startPos + 1, bookmarkMarker("bookmarkStart", bookmark.id, to))

	return session.dispatch(markInternal(tr))
}

// A hidden bookmark name Word's way: a prefix and nine random digits ("_Toc123456789"), not taken.
export function hiddenBookmarkName(prefix: "_Toc" | "_Ref", taken: (name: string) => boolean, random: () => number = Math.random): string {
	for (;;) {
		const name = `${prefix}${String(100_000_000 + Math.floor(random() * 900_000_000))}`

		if (!taken(name)) return name
	}
}

// The hidden bookmark a link to the heading paragraph at `pos` of `tr`'s document goes to, as Word's Place in
// This Document links: the first _Toc bookmark starting in it (Word's, or a table of contents'), else a new one
// around its text, put in `tr` with a name of Word's form. Undefined when `pos` is no paragraph.
export function headingBookmark(tr: Transaction, session: DocxEditorSession, pos: number): string | undefined {
	const doc = tr.doc
	const node = pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null

	if (node?.type !== nodes.paragraph) return undefined

	const index = bookmarkIndex(doc, session.story.part)

	for (const bookmark of index.list) {
		if (!bookmark.name.startsWith("_Toc") || bookmark.start !== "inline") continue

		const $start = doc.resolve(bookmark.startPos)

		if ($start.parent.type === nodes.paragraph && $start.before() === pos) return bookmark.name
	}

	const name = hiddenBookmarkName(
		"_Toc",
		candidate => index.byName.has(candidate.toLowerCase()) || bookmarkNameTaken(session.context, [session], candidate)
	)

	insertBookmark(tr, pos + 1, pos + node.nodeSize - 1, String(session.context.ids.next("bookmark")), name)

	return name
}

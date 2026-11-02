import { appendAll } from "../arrays"
import { escapeText } from "../xml/index"
import { tooLarge } from "./refusal"
import type { CommentModel } from "./edit/ops"
import { PresentationError, type Author, type CommentRef, type Deck, type ShapeRef, type SlideNode, type SlideRef } from "./model"

// The comments of a deck as the session holds them: per slide, its comments and replies in thread order (a root, then
// its replies, then the next root), each kept as the element the file had until an op changes it, so a comment no op
// touched is written back as its own bytes and an undo after a save puts the bytes back exactly. Three forms:
//   modern: p188:cm in a slide's Comment part (MS-PPTX §2.1.5, §2.16), replies inside its p188:replyLst, authors in
//     the Author part (§2.1.6); a thread is resolved by its status;
//   legacy: p:cm in a slide's comments part (ECMA-376 Part 1 §19.4), authors in p:cmAuthorLst, a reply threaded by
//     p15:threadingInfo/p15:parentCm (MS-PPTX §2.4.3.2, .6); legacy comments have no resolved state;
//   odf: LibreOffice's officeooo:annotation inside draw:page (ODF 1.3 allows office:annotation only in text and table
//     cells, so draw pages carry the foreign element LibreOffice reads and writes), its author as dc:creator; no
//     replies or resolved state in the format: a reply is a new annotation at its parent's place.
// New comments take the deck's form: modern when the file has modern comments or none, legacy in a file with legacy
// comments only, odf in an ODF deck. Entries are immutable: an op replaces a slide's list, and its inverse puts the
// list it replaced back (entries and their bytes, shared, never copied).

export type CommentFormat = "legacy" | "modern" | "odf"

// One comment or reply.
export interface CommentEntry {
	readonly id: string
	readonly format: CommentFormat
	// The thread's root (a reply's parent).
	readonly parent?: string
	// An Author id of the deck (pptx), the author's name (odf).
	readonly author: string
	readonly text: string
	// ISO 8601 as written ("" when the file names no time).
	readonly created: string
	readonly resolved: boolean
	// EMU from the slide's top left (a modern comment anchored to a shape: from the shape's).
	readonly anchor?: CommentModel["anchor"]
	// The element as the file had it, while this entry's own fields are as read (the writer copies it).
	readonly source?: Uint8Array
	// Whether `source` still holds this entry as it is.
	readonly changed: boolean
	// Its text is all its content: editing it loses nothing (a modern body with fields, a mention, formatting is kept
	// as it is and never rewritten).
	readonly plain: boolean
	// legacy: the author's p:cmAuthor id and this comment's index (§19.4.1), and its parent's.
	readonly legacy?: {
		readonly authorId: number
		readonly idx: number
		readonly parent?: { readonly authorId: number; readonly idx: number }
	}
	// modern: the status as read when it is neither active nor resolved ("closed"), kept while the thread is not
	// resolved or reopened here; a root's replies in source order (its source holds them).
	readonly status?: string
	readonly sourceReplies?: readonly string[]
}

export interface SlideComments {
	readonly entries: readonly CommentEntry[]
	// The namespace declarations in scope of the source elements (prefix → URI), so held bytes parse alone.
	readonly scope: ReadonlyMap<string, string>
}

// What the page shows of one comment (protocol: review()).
export interface CommentView {
	readonly id: string
	// Its thread's form: only a modern thread resolves.
	readonly format: CommentFormat
	readonly parent?: string
	readonly author: string
	readonly authorId: string
	readonly initials?: string
	readonly text: string
	readonly created: string
	readonly resolved: boolean
	// The text can be edited without loss.
	readonly editable: boolean
}

// A slide's notes and comments as the review pane shows them.
export interface SlideReview {
	readonly slide: SlideRef
	// The form a new comment on the slide takes.
	readonly format: CommentFormat
	// Thread order: a root, its replies, the next root.
	readonly comments: readonly CommentView[]
	// The notes body the notes pane edits (absent: the slide has no notes slide yet; notes.setNotes makes one), and its
	// box on the notes page (px), which the pane shows it in.
	readonly notes?: ShapeRef
	readonly notesBox?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
	// The notes as text, as SlideRender.notesText has them ("" without a notes slide), current after every notes edit.
	readonly notesText: string
	// What the deck's form can hold.
	readonly can: { readonly reply: boolean; readonly resolve: boolean }
}

// Hostile-input bounds: comments per slide, characters per comment, and the characters of all comments read on one
// slide and in one deck (a small file whose text:s runs or comments add up refuses before it fills the worker).
export const MAX_COMMENTS_PER_SLIDE = 100_000
export const MAX_COMMENT_CHARACTERS = 1_000_000
export const MAX_SLIDE_COMMENT_CHARACTERS = 4_000_000
export const MAX_DECK_COMMENT_CHARACTERS = 16_000_000

// The characters of each slide's comments the session holds (or, for a duplicate not read yet, its source's), kept
// as each slide's list is replaced. A slide counts toward the deck's bound while the deck lists it: a deleted slide's
// characters are given back, and taken again when an undo puts it back (its comments stay held for that).
const CHARACTERS = new WeakMap<Deck, Map<SlideRef, number>>()

// The listed slides' total, for one slide list. Every op that changes which slides are listed either assigns a new
// list or inserts into it (so its length changes); a list of the same identity and length lists the same slides
// (reordering in place changes no membership). Rebuilt once per such change (O(slides), as the op that made it);
// every other step is O(1).
interface Tally {
	readonly list: readonly SlideRef[]
	readonly length: number
	readonly listed: ReadonlySet<SlideRef>
	total: number
}

const TALLIES = new WeakMap<Deck, Tally>()

function textCharacters(entries: readonly CommentEntry[]): number {
	let characters = 0

	for (const entry of entries) characters += entry.text.length

	return characters
}

function tallyOf(deck: Deck): Tally {
	const held = TALLIES.get(deck)

	if (held !== undefined && held.list === deck.slides && held.length === deck.slides.length) return held

	const counts = CHARACTERS.get(deck)
	const listed = new Set(deck.slides)
	let total = 0

	if (counts !== undefined) for (const slide of listed) total += counts.get(slide) ?? 0

	const tally: Tally = { list: deck.slides, length: deck.slides.length, listed, total }

	TALLIES.set(deck, tally)

	return tally
}

// The characters of the comments counted for the deck's slides, `except` one.
function deckCharacters(deck: Deck, except?: SlideRef): number {
	const tally = tallyOf(deck)

	return except !== undefined && tally.listed.has(except) ? tally.total - (CHARACTERS.get(deck)?.get(except) ?? 0) : tally.total
}

function countCharacters(deck: Deck, slide: SlideRef, characters: number): void {
	let counts = CHARACTERS.get(deck)

	if (counts === undefined) {
		counts = new Map()
		CHARACTERS.set(deck, counts)
	}

	const tally = TALLIES.get(deck)

	if (tally !== undefined && tally.list === deck.slides && tally.length === deck.slides.length && tally.listed.has(slide))
		tally.total += characters - (counts.get(slide) ?? 0)

	counts.set(slide, characters)
}

// A comment's text past `limit`: a comment's own bound, or what is left of its slide's or deck's (named by their
// bounds: the room left is no limit a reader can act on).
export function commentTextTooLarge(limit: number): never {
	if (limit === MAX_COMMENT_CHARACTERS) tooLarge("comment characters", limit)

	throw new PresentationError(
		"tooLarge",
		`comment characters over ${String(MAX_SLIDE_COMMENT_CHARACTERS)} on one slide or ${String(MAX_DECK_COMMENT_CHARACTERS)} in a deck`
	)
}

// The characters `slide`'s comments may read: the slide's bound, or what is left of the deck's beside its own.
export function commentCharacterRoom(deck: Deck, slide: SlideRef): number {
	return Math.min(MAX_SLIDE_COMMENT_CHARACTERS, MAX_DECK_COMMENT_CHARACTERS - deckCharacters(deck, slide))
}

// The characters a duplicate of `source` brings: its source's comments as counted (prepareReview reads them before a
// duplicate applies; undefined when they were not read: a deck that cannot read comments).
export function copiedCommentCharacters(deck: Deck, source: SlideRef): number | undefined {
	return CHARACTERS.get(deck)?.get(source)
}

// Whether a copy bringing `characters` fits the deck's bound.
export function copiedCommentsFit(deck: Deck, characters: number): boolean {
	return deckCharacters(deck) + characters <= MAX_DECK_COMMENT_CHARACTERS
}

// A slide's comments' characters, read only to be counted (a duplicate's source): counted, never held, so the slide's model and
// fingerprint stay as they were; a held or counted slide keeps its count.
export function countUnheldComments(deck: Deck, slide: SlideRef, characters: number): void {
	if (COMMENTS.get(deck)?.has(slide) !== true && CHARACTERS.get(deck)?.has(slide) !== true) countCharacters(deck, slide, characters)
}

// The characters of comments read (what countUnheldComments counts for them).
export function commentCharacters(comments: SlideComments): number {
	return textCharacters(comments.entries)
}

// Slides whose comments refused to read when counted (too large, too deep, malformed): they count 0, as a reopen holds
// none of them (its review refuses them and keeps nothing), and are not read again to be counted.
const UNREADABLE = new WeakMap<Deck, Set<SlideRef>>()

export function markUnreadableComments(deck: Deck, slide: SlideRef): void {
	let held = UNREADABLE.get(deck)

	if (held === undefined) {
		held = new Set()
		UNREADABLE.set(deck, held)
	}

	held.add(slide)
}

export function unreadableComments(deck: Deck, slide: SlideRef): boolean {
	return UNREADABLE.get(deck)?.has(slide) === true
}

// A duplicate counted with its source's characters until its own comments are read (a redone duplicate whose
// comments were read keeps their count).
export function countCopiedComments(deck: Deck, copy: SlideRef, characters: number): void {
	if (COMMENTS.get(deck)?.has(copy) !== true) countCharacters(deck, copy, characters)
}

// Whether `slide`'s comments may become `entries` within the slide's and the deck's bounds.
export function commentCharactersFit(deck: Deck, slide: SlideRef, entries: readonly CommentEntry[]): boolean {
	const characters = textCharacters(entries)

	return characters <= MAX_SLIDE_COMMENT_CHARACTERS && deckCharacters(deck, slide) + characters <= MAX_DECK_COMMENT_CHARACTERS
}

// What a deck's comments need beyond the model: the form new comments take, legacy authors' last indices, part names
// for slides that get their first comments.
export interface DeckReviewFacts {
	readonly format: CommentFormat
	// The package's part names, lower case without the leading slash (new parts never take one).
	readonly takenParts: ReadonlySet<string>
	// p:cmAuthor id → lastIdx as the file has it (legacy).
	readonly legacyLastIdx: ReadonlyMap<number, number>
	// Whether the package has a comments part at all (none: no slide has comments to count but the session's).
	readonly commented: boolean
}

const COMMENTS = new WeakMap<Deck, Map<SlideRef, SlideComments>>()
const FACTS = new WeakMap<Deck, DeckReviewFacts>()

export function reviewFacts(deck: Deck): DeckReviewFacts | undefined {
	return FACTS.get(deck)
}

export function setReviewFacts(deck: Deck, facts: DeckReviewFacts): void {
	FACTS.set(deck, facts)
}

// A slide's comments, when they were read (undefined: not read yet; the review capability reads them first).
export function slideComments(deck: Deck, slide: SlideRef): SlideComments | undefined {
	return COMMENTS.get(deck)?.get(slide)
}

export function setSlideComments(deck: Deck, slide: SlideRef, comments: SlideComments): void {
	let held = COMMENTS.get(deck)

	if (held === undefined) {
		held = new Map()
		COMMENTS.set(deck, held)
	}

	held.set(slide, comments)

	countCharacters(deck, slide, textCharacters(comments.entries))

	const node = deck.nodes.get(slide)

	if (node !== undefined) node.comments = commentRefs(node, comments)
}

function commentRefs(node: SlideNode, comments: SlideComments): CommentRef[] {
	return comments.entries.map(entry => ({ id: entry.id, part: node.part, kind: entry.format }))
}

// What the fingerprint of a slide's comments digests: every entry's own fields, and whether it is still its source.
export function commentsValue(deck: Deck, node: SlideNode): unknown {
	const held = slideComments(deck, node.ref)

	if (held === undefined) return undefined

	return held.entries.map(entry => ({
		id: entry.id,
		parent: entry.parent,
		author: entry.author,
		text: entry.text,
		created: entry.created,
		resolved: entry.resolved,
		anchor: entry.anchor,
		changed: entry.changed,
		source: entry.source?.length,
		status: entry.status,
		legacy: entry.legacy
	}))
}

// The roots and their replies, each root followed by its replies (entries out of thread order are put in it).
export function threadOrder(entries: readonly CommentEntry[]): CommentEntry[] {
	const roots: CommentEntry[] = []
	const replies = new Map<string, CommentEntry[]>()
	const ids = new Set(entries.map(entry => entry.id))

	for (const entry of entries) {
		if (entry.parent === undefined || !ids.has(entry.parent)) {
			roots.push(entry)
			continue
		}

		const list = replies.get(entry.parent)

		if (list === undefined) replies.set(entry.parent, [entry])
		else list.push(entry)
	}

	const out: CommentEntry[] = []

	for (const root of roots) {
		out.push(root)
		appendAll(out, replies.get(root.id) ?? [])
	}

	return out
}

// An author's initials: the first letter of up to three of their name's words.
export function initialsOf(name: string): string {
	const words = name
		.trim()
		.split(/\s+/u)
		.filter(word => word.length > 0)

	return words
		.slice(0, 3)
		.map(word => String.fromCodePoint(word.codePointAt(0) ?? 0x3f).toLocaleUpperCase())
		.join("")
}

// The deck's authors by id (the first of an id, as a search in order finds it). Ops only append authors or put back a
// list they replaced, each author a new or the same object, so the list's length and last author tell a held map
// still matches it.
interface AuthorIndex {
	readonly length: number
	readonly last: Author | undefined
	readonly byId: ReadonlyMap<string, Author>
}

const AUTHOR_INDEX = new WeakMap<readonly Author[], AuthorIndex>()

function authorIndex(authors: readonly Author[]): ReadonlyMap<string, Author> {
	const last = authors[authors.length - 1]
	const held = AUTHOR_INDEX.get(authors)

	if (held !== undefined && held.length === authors.length && held.last === last) return held.byId

	const byId = new Map<string, Author>()

	for (const author of authors) if (!byId.has(author.id)) byId.set(author.id, author)

	AUTHOR_INDEX.set(authors, { length: authors.length, last, byId })

	return byId
}

export function authorOf(deck: Deck, entry: CommentEntry): Author | undefined {
	return entry.format === "odf" ? undefined : authorIndex(deck.authors).get(entry.author)
}

// The page's view of a slide's comments.
export function commentViews(deck: Deck, comments: SlideComments | undefined): CommentView[] {
	if (comments === undefined) return []

	return threadOrder(comments.entries).map(entry => {
		const author = authorOf(deck, entry)
		const name = entry.format === "odf" ? entry.author : (author?.name ?? "")
		const initials = author?.initials

		return {
			id: entry.id,
			format: entry.format,
			...(entry.parent === undefined ? {} : { parent: entry.parent }),
			author: name,
			authorId: entry.author,
			...(initials === undefined || initials === "" ? {} : { initials }),
			text: entry.text,
			created: entry.created,
			resolved: entry.resolved,
			editable: entry.plain
		}
	})
}

export function canOf(format: CommentFormat): SlideReview["can"] {
	return { reply: true, resolve: format === "modern" }
}

// A comment's text as DrawingML paragraphs (a modern comment's p188:txBody): one a:p per line, the empty line as an
// empty paragraph.
export function drawingParagraphs(text: string): string {
	return text
		.split("\n")
		.map(line => (line === "" ? "<a:p/>" : `<a:p><a:r><a:t>${escapeText(line)}</a:t></a:r></a:p>`))
		.join("")
}

// A comment's text as ODF paragraphs (one text:p per line).
export function odfParagraphs(text: string): string {
	return text
		.split("\n")
		.map(line => (line === "" ? "<text:p/>" : `<text:p>${odfLine(line)}</text:p>`))
		.join("")
}

// Runs of spaces and tabs as ODF writes them (text:s, text:tab): a run of spaces collapses otherwise (ODF 1.3 §6.1.2).
function odfLine(line: string): string {
	let out = ""
	let spaces = 0
	const flush = (): void => {
		if (spaces === 0) return

		out += spaces === 1 ? " " : ` <text:s text:c="${String(spaces - 1)}"/>`
		spaces = 0
	}

	for (const char of line) {
		if (char === " ") {
			spaces++
			continue
		}

		flush()
		out += char === "\t" ? "<text:tab/>" : escapeText(char)
	}

	flush()

	return out
}

// Characters XML 1.0 cannot hold (§2.2), and a text past the bound: such text never enters the model.
export function commentTextProblem(text: string): string | undefined {
	if (text.length > MAX_COMMENT_CHARACTERS) return "comment text"

	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index)

		if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff)
			return "a character XML cannot hold"
	}

	return undefined
}

// A dateTime as the comment formats write it: UTC with milliseconds (xsd:dateTime).
export function commentTime(iso: string): string {
	const date = new Date(iso)

	return Number.isNaN(date.getTime()) ? "" : date.toISOString()
}

import { Fragment, Slice, type Node } from "prosemirror-model"
import { closeHistory } from "prosemirror-history"
import { TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { nfcWithMap, type NfcText } from "../../text/nfc"
import { findPattern, type DocxFindPatternOptions } from "../findPattern"
import { controlAround, controlOf, typeable } from "../forms/controls"
import { controlSpans } from "../forms/positions"
import { sessionOfDoc } from "../forms/sessions"
import { prebuiltTracking, trackedReplace } from "../review/track"
import type { StoryPart } from "../model/index"
import { RebuildStep, containment, type Replace } from "./invariants/core"
import { permissionRanges, protectionOf } from "./protection"
import { docxSchema } from "./schema"
import type { DocxEditorSession } from "./session"

// Find and replace in a story being edited, on the editing document itself (the viewer's find runs on laid-out
// pages, whose offsets a replace cannot use). Text is searched paragraph by paragraph: an inline atom counts as
// one character that matches nothing, so a match never spans a field, a tab or a drawing, and string offsets
// are document positions. Text is compared in NFC (as the viewer's find does), matches widened back to
// whole characters. Locked blocks are not searched (nothing in them can be replaced). Replacing leaves matches
// in content controls whose content cannot be typed into (locked, a checkbox...) as they are, as Word does, and
// those in deleted text (which stays as it is).

export type StoryFindOptions = DocxFindPatternOptions

export { findPattern }

export interface StoryMatch {
	readonly from: number
	readonly to: number
}

// Stands for an inline atom in a paragraph's text: one position, matched by no query (a lone surrogate).
const ATOM = "\uDFFF"
const nodes = docxSchema.nodes
const marks = docxSchema.marks

// Paragraph text by node (nodes are immutable: an edited paragraph is a new node), shared by every search.
const texts = new WeakMap<Node, NfcText>()

function paragraphText(node: Node): NfcText {
	let text = texts.get(node)

	if (text === undefined) {
		text = nfcWithMap(node.textBetween(0, node.content.size, undefined, ATOM))
		texts.set(node, text)
	}

	return text
}

// Matches a find shows at most (a counter shows "10,000+" beyond).
export const STORY_FIND_LIMIT = 10_000

// Every match of `query` in `doc`, in document order. `limit` bounds the matches returned.
export function findInStory(doc: Node, query: string, options: StoryFindOptions = {}, limit = STORY_FIND_LIMIT): StoryMatch[] {
	const pattern = findPattern(query, options)
	const out: StoryMatch[] = []

	if (pattern !== null) collect(doc, pattern, limit, out, (from, to) => ({ from, to }))

	return out
}

// A story Find goes through: its index and its document as it stands.
export interface StorySearch {
	readonly story: number
	readonly doc: Node
}

// A match in one of the document's stories.
export interface DocumentMatch extends StoryMatch {
	readonly story: number
}

// A search's matches, by what it searched (documents are immutable: an edited story is a new document): a
// story's for its last search, and a list's for its last search, so a search again (each render while typing
// pauses, each keystroke in one story) goes through only the documents that changed. `limit`: the bound the
// matches were collected under (fewer than it: all there are).
interface FoundIn<T> {
	readonly key: string
	readonly limit: number
	readonly matches: readonly T[]
}

const foundInStory = new WeakMap<Node, FoundIn<DocumentMatch>>()
const foundInStories = new WeakMap<readonly StorySearch[], FoundIn<DocumentMatch>>()

function foundFor<T>(found: FoundIn<T> | undefined, key: string, limit: number): readonly T[] | undefined {
	return found !== undefined && found.key === key && (found.limit >= limit || found.matches.length < found.limit)
		? found.matches
		: undefined
}

// Every match of `query` in `stories`, story by story in the order given (Word's Search: All goes through the
// main text, then the other stories), each tagged with its story. `limit` bounds the matches returned. The same
// list (never to be changed) is returned for the same stories and search.
export function findInStories(
	stories: readonly StorySearch[],
	query: string,
	options: StoryFindOptions = {},
	limit = STORY_FIND_LIMIT
): readonly DocumentMatch[] {
	const pattern = findPattern(query, options)

	if (pattern === null) return []

	const key = `${query}\u0000${String(options.caseSensitive === true)}\u0000${String(options.wholeWord === true)}`
	const listed = foundInStories.get(stories)

	if (listed !== undefined && listed.key === key && listed.limit === limit) return listed.matches

	const out: DocumentMatch[] = []

	for (const { story, doc } of stories) {
		if (out.length >= limit) break

		const storyKey = `${String(story)}\u0000${key}`
		let matches = foundFor(foundInStory.get(doc), storyKey, limit)

		if (matches === undefined) {
			const collected: DocumentMatch[] = []

			collect(doc, pattern, limit, collected, (from, to) => ({ story, from, to }))
			foundInStory.set(doc, { key: storyKey, limit, matches: collected })
			matches = collected
		}

		for (const match of matches) {
			if (out.length >= limit) break

			out.push(match)
		}
	}

	foundInStories.set(stories, { key, limit, matches: out })

	return out
}

function collect<T extends StoryMatch>(doc: Node, pattern: RegExp, limit: number, out: T[], make: (from: number, to: number) => T): void {
	doc.descendants((node, pos) => {
		if (out.length >= limit) return false
		if (node.type === nodes.locked_block) return false
		if (!node.isTextblock) return true

		const { text, starts, ends } = paragraphText(node)

		pattern.lastIndex = 0

		for (let match = pattern.exec(text); match !== null && out.length < limit; match = pattern.exec(text)) {
			const found = match.index
			const foundEnd = found + match[0].length

			if (foundEnd === found) {
				pattern.lastIndex++

				continue
			}

			// Back to the original text, widened to whole characters.
			const start = starts === null ? found : (starts[found] ?? found)
			const end = ends === null ? foundEnd : (ends[foundEnd - 1] ?? foundEnd)

			out.push(make(pos + 1 + start, pos + 1 + end))
		}

		return false
	})
}

// Whether a match still covers text equal to the query (the document may have changed since it was found).
export function matchHolds(doc: Node, match: StoryMatch, query: string, options: StoryFindOptions = {}): boolean {
	if (match.to > doc.content.size || match.from >= match.to) return false

	const $from = doc.resolve(match.from)

	if (!$from.parent.isTextblock || $from.end() < match.to) return false

	const pattern = findPattern(query, options)

	if (pattern === null) return false

	const text = nfcWithMap(doc.textBetween(match.from, match.to, undefined, ATOM)).text
	// A whole word is judged with the character on either side (two units: a surrogate pair is whole).
	const before = options.wholeWord === true ? doc.textBetween(Math.max($from.start(), match.from - 2), match.from, undefined, ATOM) : ""
	const after = options.wholeWord === true ? doc.textBetween(match.to, Math.min($from.end(), match.to + 2), undefined, ATOM) : ""

	pattern.lastIndex = before.length

	const found = pattern.exec(before + text + after)

	return found !== null && found.index === before.length && found[0].length === text.length
}

// What a node holds, for Replace All: a content control or a block keeping rules of its own (LOCKS: taken out
// and put back, its locks see a change), deleted text (DELETED: left as it is). Cached by node.
const LOCKS = 1
const DELETED = 2
const holdings = new WeakMap<Node, number>()

function inlineHoldings(node: Node): number {
	let flags = 0

	for (const mark of node.marks) {
		if (mark.type === marks.content_control) flags |= LOCKS
		else if (mark.type === marks.deletion || mark.type === marks.move_from) flags |= DELETED
	}

	return flags
}

function holdingsOf(node: Node): number {
	if (node.isInline) return inlineHoldings(node)

	let flags = holdings.get(node)

	if (flags === undefined) {
		flags = node.type === nodes.sdt || node.type === nodes.locked_block ? LOCKS : 0

		for (let k = 0; flags !== (LOCKS | DELETED) && k < node.childCount; k++) flags |= holdingsOf(node.child(k))

		holdings.set(node, flags)
	}

	return flags
}

// Whether a match lies outside deleted text and every content control whose content typing cannot change
// (`part`: the story's, undefined when the state is no session's: no control is known to be locked). `block`
// holds the match, its content starting at `offset`: positions resolve in it, not from the document's root.
function replaceableIn(part: StoryPart | undefined, block: Node, offset: number, match: StoryMatch): boolean {
	const from = match.from - offset
	const to = match.to - offset
	let deleted = false

	block.nodesBetween(from, to, node => {
		deleted ||= node.isInline && (inlineHoldings(node) & DELETED) !== 0

		return !deleted
	})

	if (deleted) return false
	if (part === undefined) return true

	const $from = block.resolve(from)

	for (let depth = $from.depth; depth >= 0; depth--) {
		const node = $from.node(depth)

		if (node.type === nodes.sdt) {
			const info = controlOf(part, node)

			if (info !== undefined && typeable(info) !== undefined) return false
		}
	}

	for (const span of controlSpans($from.parent, $from.start())) {
		if (from >= span.to || to <= span.from) continue

		const info = controlOf(part, span.mark)

		if (info !== undefined && typeable(info) !== undefined) return false
	}

	return true
}

function replaceable(part: StoryPart | undefined, doc: Node, match: StoryMatch): boolean {
	const { node, offset } = doc.childAfter(match.from)

	return node !== null && replaceableIn(part, node, offset + 1, match)
}

// Replaces matches (each keeping the formatting where it starts) in one step of the undo history; null when
// none still holds. Matches are applied from the end, so earlier positions stay valid.
export function replaceMatches(
	state: EditorState,
	matches: readonly StoryMatch[],
	query: string,
	replacement: string,
	options: StoryFindOptions = {}
): Transaction | null {
	const tr = state.tr
	const sorted = [...matches].sort((a, b) => b.from - a.from)
	let last = Number.POSITIVE_INFINITY

	const part = sessionOfDoc(state.doc)?.story.part

	for (const match of sorted) {
		// Overlapping matches (a query found again inside itself) are replaced once.
		if (match.to > last || !matchHolds(state.doc, match, query, options) || !replaceable(part, state.doc, match)) continue

		const marks = state.doc.resolve(match.from + 1).marks()

		if (replacement.length === 0) tr.delete(match.from, match.to)
		else tr.replaceWith(match.from, match.to, docxSchema.text(replacement, marks))

		last = match.from
	}

	return tr.docChanged ? tr : null
}

// Appends `node` to `out`, joined with text before it of the same formatting (as a replace joins them).
function pushInline(out: Node[], node: Node): void {
	const last = out[out.length - 1]

	if (last?.isText === true && node.isText && last.sameMarkup(node))
		out[out.length - 1] = docxSchema.text(`${last.text ?? ""}${node.text ?? ""}`, last.marks)
	else out.push(node)
}

// A replacement: its text with the formatting where its match starts (`pos` in `node`'s content).
function replacementText(node: Node, pos: number, replacement: string): Node {
	return docxSchema.text(replacement, node.resolve(pos + 1).marks())
}

// Unchanged content (positions) between two blocks with matches past which they are replaced apart: a replace
// copies its spine and every check walks what it spans, so a sparse Replace All costs what it changes.
const SPARSE = 4096

// Child slots Replace All's paragraph by paragraph replaces may copy (8 bytes each, kept by the transaction
// until it is applied): past it, the Replace All is refused before anything is built.
const MAX_COPIED_SLOTS = 16_000_000

export type ReplaceAllResult =
	| { readonly tr: Transaction; readonly count: number }
	// Matches found but none replaced: all in locked controls or deleted text, or paragraph by paragraph
	// replaces that would copy past MAX_COPIED_SLOTS.
	| { readonly refused: "unreplaceable" | "tooLarge" }

interface ChildMatches {
	readonly node: Node
	readonly pos: number
	// The matches [lo, hi) in it.
	readonly lo: number
	readonly hi: number
}

// Under protection limiting edits to ranges (read-only with ranges open to everyone, comments, forms): whether
// this user may change a match (in an open range, or under forms protection in a control typing may change),
// by a binary search over the ranges; undefined when protection limits nothing. Protection's own check of the
// transaction stays the backstop.
function editable(session: DocxEditorSession, doc: Node): ((match: StoryMatch) => boolean) | undefined {
	const mode = protectionOf(session.context).mode

	if (mode === "none" || mode === "trackedChanges" || (mode === "comments" && session.story.story.kind === "comment")) return undefined

	const open = containment(permissionRanges(session).of(doc))
	const part = session.story.part

	return match => {
		if (open(match.from, match.to)) return true
		if (mode !== "forms") return false

		const around = controlAround(part, doc, match.from, match.to)

		return around !== undefined && typeable(around.info) === undefined
	}
}

// How a match is replaced while changes are tracked (document positions): `real` goes, `marked` stays marked
// deleted, and the replacement goes after it (`kept`; else over all of it), as the change tracker records one
// replace of it.
interface TrackedMatch {
	readonly real: readonly (readonly [number, number])[]
	readonly marked: readonly (readonly [number, number])[]
	readonly kept: boolean
}

interface Planned {
	readonly matches: StoryMatch[]
	// For each match while tracking; undefined for all when one cannot be told so (each replaced on its own,
	// the change tracker recording each).
	readonly tracked: TrackedMatch[] | undefined
	// Child slots the matches replaced on their own copy.
	readonly copied: number
}

// The matches (in document order) replaceableIn() keeps, how each is tracked (`session` tracking), and the child
// slots the matches replaced on their own copy, by one walk of the blocks.
function plannedMatches(
	part: StoryPart | undefined,
	doc: Node,
	matches: readonly StoryMatch[],
	session: DocxEditorSession | undefined
): Planned {
	const tracking = session?.context.review.tracking === true
	const allowed = session === undefined ? undefined : editable(session, doc)
	const out: StoryMatch[] = []
	let tracked: TrackedMatch[] | undefined = tracking ? [] : undefined
	// What replacing every match on its own copies (when tracked one by one).
	let each = 0
	let k = 0

	doc.forEach((child, pos) => {
		const end = pos + child.nodeSize
		let flags: number | undefined

		for (let match = matches[k]; match !== undefined && match.from < end; match = matches[++k]) {
			flags ??= holdingsOf(child)

			if (flags !== 0 && !replaceableIn(part, child, pos + 1, match)) continue
			if (allowed !== undefined && !allowed(match)) continue

			out.push(match)

			if (!tracking) continue

			// Replaced on its own when not told as the change tracker records it: a step copying the children of
			// every node around the match.
			const $from = child.resolve(match.from - pos - 1)

			each += doc.childCount

			for (let depth = 0; depth < $from.depth; depth++) each += $from.node(depth).childCount

			if (tracked === undefined || session === undefined) continue

			const start = pos + 1 + $from.start()
			const how = trackedReplace($from.parent, match.from - start, match.to - start, session)
			const at = (range: readonly [number, number]): [number, number] => [range[0] + start, range[1] + start]

			if (how === undefined) tracked = undefined
			else tracked.push({ real: how.real.map(at), marked: how.marked.map(at), kept: how.kept })
		}
	})

	return { matches: out, tracked, copied: tracking && tracked === undefined ? each : 0 }
}

// The match each replace a plan makes is of.
const replaceMatch = new WeakMap<Replace, number>()

// Text a tracked replace leaves marked deleted (document positions before its step), of match `match`.
interface Kept {
	readonly from: number
	readonly to: number
	readonly match: number
}

// A range a tracked plan records ([from, to] after step `at`).
interface Recorded {
	readonly from: number
	readonly to: number
	readonly at: number
}

// Builds Replace All's steps over the matches it was given (in document order, all replaceable).
class ReplaceAllPlan {
	private readonly matches: readonly StoryMatch[]
	private readonly replacement: string
	// How each match is tracked; undefined untracked.
	private readonly tracked: readonly TrackedMatch[] | undefined
	// What each match's tracked replace records (by match).
	private readonly recorded: { deleted: Recorded[]; inserted: Recorded[] }[] = []

	constructor(matches: readonly StoryMatch[], replacement: string, tracked: readonly TrackedMatch[] | undefined) {
		this.matches = matches
		this.replacement = replacement
		this.tracked = tracked
	}

	// Steps for the matches [lo, hi) in `node`'s content (starting at `start`), from the end so earlier positions
	// stay valid (see run()).
	emit(tr: Transaction, node: Node, start: number, lo: number, hi: number): void {
		const children: ChildMatches[] = []
		let k = lo

		node.forEach((child, offset) => {
			const pos = start + offset
			let j = k

			while (j < hi && (this.matches[j]?.from ?? Number.POSITIVE_INFINITY) < pos + child.nodeSize) j++

			children.push({ node: child, pos, lo: k, hi: j })
			k = j
		})

		this.run(tr, children, 0, children.length)
	}

	// The children [first, end), from the end: one rebuild over children with matches no more than SPARSE
	// positions apart (the same nodes put back between them, an undo giving them back), and a child larger than
	// that gone into (its own rebuilds then span only what changed in it).
	private run(tr: Transaction, children: readonly ChildMatches[], first: number, end: number): void {
		let c = end - 1

		while (c >= first) {
			const last = children[c]

			if (last === undefined) return

			if (last.hi === last.lo) {
				c--

				continue
			}

			if (!last.node.isTextblock && last.node.nodeSize > SPARSE) {
				this.emit(tr, last.node, last.pos + 1, last.lo, last.hi)
				c--

				continue
			}

			let from = c
			let gap = 0

			for (let k = c - 1; k >= first; k--) {
				const child = children[k]

				if (child === undefined) break

				if (child.hi === child.lo) {
					gap += child.node.nodeSize

					if (gap > SPARSE) break

					continue
				}

				if (!child.node.isTextblock && child.node.nodeSize > SPARSE) break

				from = k
				gap = 0
			}

			const head = children[from]

			if (head === undefined) return

			const content: Node[] = []
			const replaces: Replace[] = []
			const kept: Kept[] = []

			for (let k = from; k <= c; k++) {
				const child = children[k]

				if (child !== undefined)
					content.push(
						child.hi > child.lo ? this.rebuilt(child.node, child.pos + 1, child.lo, child.hi, replaces, kept) : child.node
					)
			}

			// Read (mapped, judged) as the replaces of the matches it makes.
			tr.step(
				new RebuildStep(
					head.pos,
					last.pos + last.node.nodeSize,
					new Slice(Fragment.from(content), 0, 0),
					replaces,
					kept.flatMap(piece => [piece.from, piece.to])
				)
			)
			this.recordRebuild(replaces, kept, tr.steps.length)
			c = from - 1
		}
	}

	// Records, by match, where a rebuild's replaces and the text they leave marked deleted (`kept`, in order)
	// are in the document after it (step `at`).
	private recordRebuild(replaces: readonly Replace[], kept: readonly Kept[], at: number): void {
		if (this.tracked === undefined) return

		let shift = 0
		let r = 0
		const insertUpTo = (pos: number): void => {
			for (let replace = replaces[r]; replace !== undefined && replace.to <= pos; replace = replaces[++r]) {
				const from = replace.from + shift
				const match = replaceMatch.get(replace) ?? 0

				if (replace.slice.size > 0) this.record(match).inserted.push({ from, to: from + replace.slice.size, at })

				shift += replace.slice.size - (replace.to - replace.from)
			}
		}

		for (const piece of kept) {
			insertUpTo(piece.from)
			this.record(piece.match).deleted.push({ from: piece.from + shift, to: piece.to + shift, at })
		}

		insertUpTo(Number.POSITIVE_INFINITY)
	}

	private record(match: number): { deleted: Recorded[]; inserted: Recorded[] } {
		let entry = this.recorded[match]

		if (entry === undefined) {
			entry = { deleted: [], inserted: [] }
			this.recorded[match] = entry
		}

		return entry
	}

	// What the tracked replaces record, in the order the change tracker records one replace per match (the
	// last match first), in `tr`'s final document.
	finalRanges(tr: Transaction): { readonly deleted: number[]; readonly inserted: number[] } {
		const deleted: number[] = []
		const inserted: number[] = []
		const final = (range: Recorded, out: number[]): void => {
			const later = tr.mapping.slice(range.at)

			out.push(later.map(range.from, 1), later.map(range.to, -1))
		}

		for (let k = this.matches.length - 1; k >= 0; k--) {
			const entry = this.recorded[k]

			for (const range of entry?.deleted ?? []) final(range, deleted)
			for (const range of entry?.inserted ?? []) final(range, inserted)
		}

		return { deleted, inserted }
	}

	// `node` (content at `start`) with the matches [lo, hi) in it replaced, each replace added to `replaces` (and
	// the text it leaves marked deleted to `kept`).
	private rebuilt(node: Node, start: number, lo: number, hi: number, replaces: Replace[], kept: Kept[]): Node {
		if (node.isTextblock) return node.copy(this.paragraphContent(node, start, lo, hi, replaces, kept))

		const content: Node[] = []
		let k = lo

		node.forEach((child, offset) => {
			const pos = start + offset
			let j = k

			while (j < hi && (this.matches[j]?.from ?? Number.POSITIVE_INFINITY) < pos + child.nodeSize) j++

			content.push(j > k ? this.rebuilt(child, pos + 1, k, j, replaces, kept) : child)
			k = j
		})

		return node.copy(Fragment.from(content))
	}

	// The replaces match `k` (in paragraph `node`, content at `start`) makes, in order: over all of it, or
	// (tracked, something staying) its parts going for real and the replacement after it.
	private replacesOf(
		node: Node,
		start: number,
		k: number
	): { readonly replaces: Replace[]; readonly marked: readonly (readonly [number, number])[] } {
		const match = this.matches[k] as StoryMatch
		const text = this.replacement.length > 0 ? replacementText(node, match.from - start, this.replacement) : undefined
		const slice = text === undefined ? Slice.empty : new Slice(Fragment.from(text), 0, 0)
		const how = this.tracked?.[k]

		if (how === undefined || !how.kept) return { replaces: [{ from: match.from, to: match.to, slice }], marked: [] }

		const replaces: Replace[] = how.real.map(([from, to]) => ({ from, to, slice: Slice.empty }))

		replaces.push({ from: match.to, to: match.to, slice })

		return { replaces: replaces.filter(replace => replace.to > replace.from || replace.slice.size > 0), marked: how.marked }
	}

	// A paragraph's content with the matches [lo, hi) in it replaced, each keeping the formatting where it starts.
	private paragraphContent(node: Node, start: number, lo: number, hi: number, replaces: Replace[], kept: Kept[]): Fragment {
		const out: Node[] = []
		let at = 0

		for (let k = lo; k < hi; k++) {
			const made = this.replacesOf(node, start, k)

			for (const replace of made.replaces) {
				const from = replace.from - start

				if (from > at) node.content.cut(at, from).forEach(child => pushInline(out, child))

				replace.slice.content.forEach(child => pushInline(out, child))
				replaces.push(replace)
				replaceMatch.set(replace, k)
				at = Math.max(at, replace.to - start)
			}

			for (const [from, to] of made.marked) kept.push({ from, to, match: k })
		}

		if (at < node.content.size) node.content.cut(at).forEach(child => pushInline(out, child))

		return Fragment.fromArray(out)
	}
}

// Each match replaced on its own step (a tracked edit the change tracker records step by step).
function eachOnItsOwn(state: EditorState, matches: readonly StoryMatch[], replacement: string): ReplaceAllResult {
	const tr = state.tr

	for (let k = matches.length - 1; k >= 0; k--) {
		const match = matches[k] as StoryMatch

		if (replacement.length === 0) tr.delete(match.from, match.to)
		else tr.replaceWith(match.from, match.to, docxSchema.text(replacement, state.doc.resolve(match.from + 1).marks()))
	}

	return { tr: closeHistory(tr), count: matches.length }
}

// Replaces every match of `query` in `state`, however many (find shows at most STORY_FIND_LIMIT), in one step
// of the undo history, each replacement keeping the formatting where its match starts. Few replace steps
// rebuild the blocks holding matches (each step copies the document's spine, so a step per paragraph grows
// with the paragraphs times the blocks; the invariants read each as the replaces of its matches); in
// paragraphs holding a content control each match is replaced on its own. While changes are tracked, each
// replace is built as the change tracker records one of a match (its text marked deleted, the replacement
// inserted after it). Null when nothing matches.
export function replaceAll(
	state: EditorState,
	query: string,
	replacement: string,
	options: StoryFindOptions = {}
): ReplaceAllResult | null {
	const doc = state.doc
	const session = sessionOfDoc(doc)
	const found = findInStory(doc, query, options, Number.POSITIVE_INFINITY)

	if (found.length === 0) return null

	const planned = plannedMatches(session?.story.part, doc, found, session)

	if (planned.matches.length === 0) return { refused: "unreplaceable" }
	if (planned.copied > MAX_COPIED_SLOTS) return { refused: "tooLarge" }

	const tracking = session?.context.review.tracking === true

	// Tracked, but some match not told as the change tracker would: each replaced on its own, the tracker
	// recording each.
	if (tracking && planned.tracked === undefined) return eachOnItsOwn(state, planned.matches, replacement)

	const tr = state.tr
	const plan = new ReplaceAllPlan(planned.matches, replacement, planned.tracked)

	plan.emit(tr, doc, 0, 0, planned.matches.length)

	if (session !== undefined && tracking) {
		const ranges = plan.finalRanges(tr)

		if (!tr.docChanged || !prebuiltTracking(tr, session, ranges.deleted, ranges.inserted))
			return eachOnItsOwn(state, planned.matches, replacement)
	}

	// Its own undo step: typing after it never joins it.
	return tr.docChanged ? { tr: closeHistory(tr), count: planned.matches.length } : { refused: "unreplaceable" }
}

// Selects a match (as Word's find does), or null when it no longer lies in the document.
export function selectMatch(state: EditorState, match: StoryMatch): Transaction | null {
	if (match.from < 0 || match.to > state.doc.content.size || match.from > match.to) return null

	return state.tr.setSelection(TextSelection.create(state.doc, match.from, match.to))
}

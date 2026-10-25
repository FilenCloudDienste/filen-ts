import { Fragment, Slice, type Mark, type MarkType, type Node } from "prosemirror-model"
import { isHistoryTransaction } from "prosemirror-history"
import { Selection, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { AddMarkStep, AttrStep, Mapping, ReplaceAroundStep, ReplaceStep, StepMap, type Step } from "prosemirror-transform"
import { decodeUtf8, encodeUtf8, parseXml } from "../../xml/index"
import type { DocxEditContext, DocxIdentity } from "../edit/context"
import type { RunBase } from "../edit/formatting"
import {
	OrderedDoc,
	invariantViolation,
	isCommand,
	isInternal,
	markCommand,
	markInternal,
	markRemarking,
	markTyping
} from "../edit/invariants/core"
import { FORMATTING_MARKS, NO_SOURCE, docxSchema, inlineLevel, type IndentAttrs, type SpacingAttrs } from "../edit/schema"
import { SetAttrsStep } from "../edit/attrs"
import { MarkChanges, SetMarkSetsStep, SetMarksStep, markStepsOf, type MarkStep } from "../edit/marks"
import { rowOverrides, type RowOverrides, type TrackStamp } from "../edit/tables/map"
import type { DocxEditorSession } from "../edit/session"
import { Item, Revision, RevisionFlag, type StoryPart } from "../model/index"
import { simpleFieldRewritable } from "../fields/evaluate"
import { wantReviewIndex } from "./index"
import { equationDeleted, equationFault, trackedDeletion } from "../math/edit"
import type { ParagraphBordersProps } from "../props/index"
import { Names, Out } from "../write/markup"
import { sameFormatting, writeRunProperties } from "../write/runs"
import { W_NAMESPACE, sectionWritten } from "../write/source"

// Recording tracked changes. While a document's review.tracking is on, every user transaction is rewritten
// before it applies (trackTransaction, the session's transformer): text the author inserted earlier is really
// deleted, any other deleted content stays and is marked deleted, a deleted paragraph mark is flagged instead
// of joining, and inserted content goes after deleted content. The rewritten transaction is an ordinary user
// edit (the invariants repair it as any other); the marks themselves (insertion, deletion, format and paragraph
// changes) are added by the tracking invariant stage right after it, in the same undo step, which also keeps a
// paragraph mark's revision with the content that ends with it through splits and joins (tracking or not). The
// cost is the size of the steps: nothing walks the document; an edit touching many blocks has them rebuilt in
// one step.

const nodes = docxSchema.nodes
const marks = docxSchema.marks

// Who recorded a change and when: the date is truncated to the minute, so a burst of typing is one change.
// `id` names the change (one per change, kept through edits: what accept and reject by id act on); `element`
// is the source's own revision element (a node of the story part) a paragraph mark's revision moved with
// its content, written as it is.
export interface RevisionStamp {
	readonly author: string
	readonly date: string
	readonly id?: number
	readonly element?: number
}

// The direct paragraph properties a command changes (the attributes w:pPrChange records); `spacing` where the
// editing schema has it.
export interface ParagraphAttrs {
	readonly styleId: string | null
	readonly numId: number | null
	readonly ilvl: number | null
	readonly align: string | null
	readonly indent: IndentAttrs | null
	readonly spacing: SpacingAttrs | null
	readonly borders: ParagraphBordersProps | null
}

export const PARAGRAPH_ATTRS: readonly (keyof ParagraphAttrs)[] = ["styleId", "numId", "ilvl", "align", "indent", "spacing", "borders"]

// The value of a paragraph's paragraph_change node mark: what tracked changes recorded on it.
export interface ParagraphChange {
	// Properties changed while tracking (w:pPrChange): the attributes before the first change, who, when.
	readonly props?: { readonly before: ParagraphAttrs } & RevisionStamp
	// The paragraph mark inserted or deleted while tracking (w:ins / w:del in the mark's run properties).
	readonly inserted?: RevisionStamp
	readonly deleted?: RevisionStamp
	// The source's own w:pPrChange accepted (left out) or rejected (its properties written back).
	readonly source?: "accept" | "reject"
}

// Word writes a revision's w:date as the author's local wall-clock time followed by "Z" (the true instant
// goes in w16du:dateUtc, MS-DOCX 2.12.2.1, "defined to be in the UTC time zone" unlike w:date), and shows
// w:date as written; so do we.
export function minuteDate(ms: number): string {
	const date = new Date(ms)
	const two = (value: number): string => String(value).padStart(2, "0")

	return `${String(date.getFullYear()).padStart(4, "0")}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:00Z`
}

// The stamp of a change recorded now, or undefined while the document has no author name.
export function revisionStamp(identity: DocxIdentity): RevisionStamp | undefined {
	const author = identity.author

	return author === undefined || author === "" ? undefined : { author, date: minuteDate(identity.now()) }
}

// Whether a save writes the track switch into the file (w:trackRevisions), as Word does; a host may keep it to
// the session instead.
export function trackingPersisted(context: DocxEditContext): boolean {
	return context.review.persist
}

export function setTrackingPersisted(context: DocxEditContext, persisted: boolean): void {
	context.review.persist = persisted
}

export function paragraphChange(node: Node): ParagraphChange | undefined {
	return marks.paragraph_change.isInSet(node.marks)?.attrs["value"] as ParagraphChange | undefined
}

// Sets (or, when empty, removes) the paragraph_change mark of the paragraph at `pos`.
// `nodeMarks` with the paragraph_change mark holding `change` (none when it is empty).
export function withParagraphChange(nodeMarks: readonly Mark[], change: ParagraphChange): readonly Mark[] {
	const empty = change.props === undefined && change.inserted === undefined && change.deleted === undefined && change.source === undefined

	return empty ? marks.paragraph_change.removeFromSet(nodeMarks) : marks.paragraph_change.create({ value: change }).addToSet(nodeMarks)
}

export function setParagraphChange(tr: Transaction, pos: number, node: Node, change: ParagraphChange): void {
	const empty = change.props === undefined && change.inserted === undefined && change.deleted === undefined && change.source === undefined
	const existing = marks.paragraph_change.isInSet(node.marks)

	if (empty) {
		if (existing !== undefined) tr.removeNodeMark(pos, existing)

		return
	}

	tr.addNodeMark(pos, marks.paragraph_change.create({ value: change }))
}

export function paragraphAttrs(node: Node): ParagraphAttrs {
	const a = node.attrs

	return {
		styleId: a["styleId"] as string | null,
		numId: a["numId"] as number | null,
		ilvl: a["ilvl"] as number | null,
		align: a["align"] as string | null,
		indent: a["indent"] as IndentAttrs | null,
		spacing: a["spacing"] as SpacingAttrs | null,
		borders: a["borders"] as ParagraphBordersProps | null
	}
}

// Run-level content a tracked change marks: text and run atoms, not Word's bookkeeping, comment references,
// field characters or run children kept as bytes.
const UNMARKED: ReadonlySet<unknown> = new Set([nodes.rendered_break, nodes.comment_ref, nodes.run_object])

export function markable(node: Node): boolean {
	return node.isInline && (inlineLevel(node) === "run" || node.type === nodes.field) && !UNMARKED.has(node.type)
}

function untrackableField(node: Node, session: DocxEditorSession): boolean {
	if (node.type !== nodes.field) return false

	const own = node.attrs["src"] as number
	const part = session.story.part

	return own >= 0 && part.kinds[own] === Item.FieldSimple && !simpleFieldRewritable(part, own)
}

export function isDeleted(node: Node): boolean {
	return marks.deletion.isInSet(node.marks) !== undefined || marks.move_from.isInSet(node.marks) !== undefined
}

function ownInsertion(node: Node, author: string): boolean {
	for (const mark of node.marks) if (mark.type === marks.insertion && mark.attrs["author"] === author) return true

	return false
}

function ownParagraphMark(node: Node, author: string): boolean {
	return ((node.attrs["revision"] as number) & RevisionFlag.Inserted) !== 0 && paragraphChange(node)?.inserted?.author === author
}

const FORMATTING_TYPES: ReadonlySet<MarkType> = new Set(FORMATTING_MARKS.map(name => marks[name]))

// The direct formatting marks of a node (what w:rPr holds besides the run base and its change).
export function propertyMarks(nodeMarks: readonly Mark[]): Mark[] {
	return nodeMarks.filter(mark => FORMATTING_TYPES.has(mark.type))
}

// ---- the plan a rewritten transaction leaves for the tracking stage ----------------------------------------

// Positions are in the rewritten transaction's document after its step `at` (mapped to the end later).
interface Range {
	readonly from: number
	readonly to: number
	readonly at: number
}

interface FormatPiece extends Range {
	// The RunBases id of the formatting before (-1: none at all).
	readonly base: number
	// The run mark's attributes before (false: none) when the change replaces it, else null.
	readonly run: RunBefore
}

type RunBefore = { readonly src: number; readonly base: number } | false | null

function sameRunBefore(a: RunBefore, b: RunBefore): boolean {
	return a === b || (a !== null && b !== null && a !== false && b !== false && a.src === b.src && a.base === b.base)
}

interface PropsChange {
	readonly pos: number
	readonly at: number
	readonly before: ParagraphAttrs
}

export interface TrackPlan {
	readonly stamp: RevisionStamp
	readonly session: DocxEditorSession
	readonly inserted: Range[]
	readonly deleted: Range[]
	// Paragraphs (by position) whose mark the edit deleted, table rows it deleted whole.
	readonly marks: { readonly pos: number; readonly at: number }[]
	// Equations it deleted whole (marked inside them).
	readonly equations: { readonly pos: number; readonly at: number }[]
	readonly rows: { readonly pos: number; readonly at: number }[]
	readonly formats: FormatPiece[]
	// Ranges whose recorded formatting changes may have been undone by the edit.
	readonly settle: Range[]
	readonly props: PropsChange[]
	// Paragraphs (position and step) whose properties are recorded.
	readonly propsSeen: Set<string>
	// Typed during an IME composition: marked when it ends.
	readonly composing: boolean
}

const plans = new WeakMap<Transaction, TrackPlan>()
// The session of each user transaction (the stage moves paragraph mark revisions read from its part).
const sessions = new WeakMap<Transaction, DocxEditorSession>()
// Transactions refused because recording them needs the author's name first, or (`unsupported`) because what
// they would record could not be saved (the deletion of an equation nested too deep).
const refused = new WeakSet<Transaction>()
const unsupported = new WeakSet<Transaction>()

export function planOf(tr: Transaction): TrackPlan | undefined {
	return plans.get(tr)
}

export function refusedForAuthor(tr: Transaction): boolean {
	return refused.has(tr)
}

export function refusedUnsupported(tr: Transaction): boolean {
	return unsupported.has(tr)
}

// ---- IME composition ------------------------------------------------------------------------------------

// Text typed while composing, not marked yet (marking it would disturb the composition): ranges of `doc`,
// mapped through every transaction the session applies, marked with the next edit or flushComposition.
interface Pending {
	ranges: number[]
	doc: Node
	readonly stamp: RevisionStamp
}

const pending = new WeakMap<DocxEditorSession, Pending>()
const following = new WeakSet<DocxEditorSession>()

function follow(session: DocxEditorSession): void {
	if (following.has(session)) return

	following.add(session)
	session.onApplied(transactions => {
		const entry = pending.get(session)

		if (entry === undefined) return

		for (const tr of transactions) {
			if (tr.before !== entry.doc) continue

			const next: number[] = []

			for (let k = 0; k < entry.ranges.length; k += 2) {
				const from = tr.mapping.map(entry.ranges[k] ?? 0, 1)
				const to = tr.mapping.map(entry.ranges[k + 1] ?? 0, -1)

				if (to > from) next.push(from, to)
			}

			entry.ranges = next
			entry.doc = tr.doc
		}
	})
}

function addPending(
	session: DocxEditorSession,
	stamp: RevisionStamp,
	ranges: readonly number[],
	doc: Node,
	batch: readonly Transaction[]
): void {
	follow(session)

	const entry = pending.get(session)

	// Ranges from before this batch are brought up to it first.
	if (entry !== undefined) {
		for (const tr of batch) {
			if (tr.before !== entry.doc) continue

			const next: number[] = []

			for (let k = 0; k < entry.ranges.length; k += 2) {
				const from = tr.mapping.map(entry.ranges[k] ?? 0, 1)
				const to = tr.mapping.map(entry.ranges[k + 1] ?? 0, -1)

				if (to > from) next.push(from, to)
			}

			entry.ranges = next
			entry.doc = tr.doc
		}
	}

	if (entry !== undefined && entry.doc === doc) entry.ranges.push(...ranges)
	else pending.set(session, { ranges: [...ranges], doc, stamp })
}

// Ranges of the session's current document still waiting to be marked (none once they are stale).
function waiting(session: DocxEditorSession): Pending | undefined {
	const entry = pending.get(session)

	if (entry === undefined) return undefined
	if (entry.doc === session.state.doc && entry.ranges.length > 0) return entry

	pending.delete(session)

	return undefined
}

// Whether [from, to) of `doc` was all typed in a composition not marked yet: the ranges of its steps together
// (each step of a composition is a range of its own, side by side).
function inPending(session: DocxEditorSession, doc: Node, from: number, to: number): boolean {
	const entry = pending.get(session)

	if (entry === undefined || entry.doc !== doc) return false

	let covered = from
	let grew = true

	while (grew && covered < to) {
		grew = false

		for (let k = 0; k < entry.ranges.length; k += 2) {
			const start = entry.ranges[k] ?? 0
			const end = entry.ranges[k + 1] ?? 0

			if (start <= covered && end > covered) {
				covered = end
				grew = true
			}
		}
	}

	return covered >= to
}

// Marks what was typed during a composition that has ended (the host calls this at compositionend; the next
// edit does it too). True when something was marked.
export function flushComposition(session: DocxEditorSession): boolean {
	const tr = compositionMarking(session)

	if (tr === undefined) return false

	pending.delete(session)

	return tr.docChanged && session.dispatch(tr)
}

// The session's document with what an IME composition typed marked, nothing dispatched (a save while the
// composition goes on writes it; the session is marked when it ends). Undefined when nothing is waiting.
export function compositionMarked(session: DocxEditorSession): Node | undefined {
	const tr = compositionMarking(session)

	return tr === undefined || !tr.docChanged ? undefined : session.state.apply(tr).doc
}

function compositionMarking(session: DocxEditorSession): Transaction | undefined {
	const entry = waiting(session)

	if (entry === undefined) return undefined

	const tr = session.state.tr
	const marking: Marking = { marks: [], paragraphs: new Map(), rows: new Map() }

	let mark: Mark | undefined

	for (let k = 0; k < entry.ranges.length; k += 2)
		mark = addInsertion(tr.doc, marking, entry.ranges[k] ?? 0, entry.ranges[k + 1] ?? 0, entry.stamp, session.context, mark)

	applyMarking(tr, marking)

	return markInternal(tr.setMeta("addToHistory", false))
}

// ---- rewriting --------------------------------------------------------------------------------------------

// What a deleted range holds: inline pieces deleted for real (the author's own insertions), pieces to mark
// deleted, paragraph marks to flag, and whether anything stays.
interface Deletion {
	readonly real: [number, number][]
	readonly marked: [number, number][]
	readonly paragraphs: number[]
	// Table rows taken whole: flagged deleted.
	readonly rows: number[]
	// Equations taken whole: their runs and objects marked deleted inside them.
	readonly equations: number[]
	kept: boolean
	// An equation whose deletion could not be recorded (too deep, or markup that could not be saved): the
	// transaction is refused rather than the equation kept as it was.
	refused: boolean
}

function pushPiece(list: [number, number][], start: number, end: number): void {
	const last = list[list.length - 1]

	if (last !== undefined && last[1] === start) last[1] = end
	else list.push([start, end])
}

function classify(doc: Node, from: number, to: number, author: string, session: DocxEditorSession): Deletion {
	const result: Deletion = { real: [], marked: [], paragraphs: [], rows: [], equations: [], kept: false, refused: false }
	// Pieces to mark are one range across block boundaries until content that is not marked lies between.
	let broken = true
	// Comment anchors that stay by themselves (no revision of their own), and where other content stays.
	const anchors: { readonly pos: number; readonly key: string; readonly id: string }[] = []
	const stays: number[] = []

	doc.nodesBetween(from, to, (node, pos, parent, index) => {
		if (node.isInline) {
			const start = Math.max(from, pos)
			const end = Math.min(to, pos + node.nodeSize)

			if (end <= start) return false

			const anchor = commentAnchor(node)

			if (anchor !== undefined) anchors.push({ pos, ...anchor })

			// An equation records its deletion inside it (Word's w:del around its runs, in its objects' m:ctrlPr);
			// the author's own insertion of all of it goes for real.
			if (node.type === nodes.math) {
				const part = session.story.part

				const deleted = trackedDeletion(node, part, 0, { author, date: "" })

				if (deleted === null) {
					pushPiece(result.real, start, end)
				} else {
					if (anchor === undefined) stays.push(pos)

					if (!equationDeleted(node, part)) {
						result.equations.push(pos)

						if (deleted === undefined || equationFault(deleted, part) !== undefined) result.refused = true
					}

					result.kept = true
				}

				broken = true

				return false
			}

			if (ownInsertion(node, author) || inPending(session, doc, start, end)) {
				pushPiece(result.real, start, end)
				broken = true
			} else if (untrackableField(node, session)) {
				// A simple field with a drawing or a field in it: no tracked change holds it (a w:del holds runs
				// only, and it has no complex form), so it stays, as a locked block does.
				if (anchor === undefined) stays.push(pos)

				result.kept = true
				broken = true
			} else {
				if (anchor === undefined) stays.push(pos)

				result.kept = true

				if (!isDeleted(node) && markable(node)) {
					const last = result.marked[result.marked.length - 1]

					if (!broken && last !== undefined) last[1] = end
					else result.marked.push([start, end])

					broken = false
				} else {
					broken = true
				}
			}

			return false
		}

		const close = pos + node.nodeSize - 1
		const closes = close >= from && close < to

		if (node.type === nodes.locked_block) {
			// Kept as bytes: it stays whole.
			result.kept = true

			return false
		}

		if (node.type === nodes.paragraph) {
			if (!closes) return true

			const sectPr = node.attrs["sectPr"] as number
			// A body section break's mark is flagged as any (accepted, the sections combine), never deleted for real.
			const breaks = sectPr !== NO_SOURCE && bodyBreak(session, doc, pos, sectPr)

			// The author's own inserted mark goes for real (with the rest, when nothing else stays).
			if (!breaks && ownParagraphMark(node, author)) return true

			result.kept = true

			const next = parent !== null && index + 1 < parent.childCount ? parent.child(index + 1) : null

			// Only a mark followed by a paragraph or a table (accepted, it joins the paragraph after, or goes with
			// its paragraph emptied) and holding no section break in a table cell can be deleted.
			if (
				(next?.type === nodes.paragraph || next?.type === nodes.table) &&
				(sectPr === NO_SOURCE || breaks) &&
				((node.attrs["revision"] as number) & RevisionFlag.Deleted) === 0
			)
				result.paragraphs.push(pos)

			return true
		}

		const whole = pos >= from && closes

		// A table or row the author inserted while tracking (every row of it) goes for real when nothing in it
		// stays; other rows taken whole are flagged deleted (Word's w:trPr/w:del).
		if (whole && (node.type === nodes.table || node.type === nodes.table_row)) {
			let own = true

			if (node.type === nodes.table) for (let k = 0; k < node.childCount && own; k++) own = ownRow(node.child(k), author)
			else own = ownRow(node, author)

			if (own && !othersIn(doc, node, pos, author, session)) {
				pushPiece(result.real, pos, pos + node.nodeSize)
				broken = true

				return false
			}

			if (node.type === nodes.table_row && ((node.attrs["revision"] as number) & RevisionFlag.Deleted) === 0) result.rows.push(pos)
		}

		// Tables, rows, cells and content controls whose start or end the range takes stay.
		if (closes || pos >= from) result.kept = true

		return true
	})

	// The anchors right next to the range in its paragraphs go too when the range takes the comment's text.
	if (result.real.length > 0) {
		for (let $pos = doc.resolve(from); $pos.parent.inlineContent && $pos.nodeBefore !== null;) {
			const anchor = commentAnchor($pos.nodeBefore)

			if (anchor === undefined) break

			anchors.push({ pos: $pos.pos - 1, ...anchor })
			$pos = doc.resolve($pos.pos - 1)
		}

		for (let $pos = doc.resolve(to); $pos.parent.inlineContent && $pos.nodeAfter !== null;) {
			const anchor = commentAnchor($pos.nodeAfter)

			if (anchor === undefined) break

			anchors.push({ pos: $pos.pos, ...anchor })
			$pos = doc.resolve($pos.pos + 1)
		}
	}

	if (anchors.length >= 3 && realAnchors(result, anchors, stays) && result.real.some(([start, end]) => start < from || end > to))
		result.kept = true

	return result
}

// Whether the paragraph at `pos` ends a section of the body (its break written outside table cells).
function bodyBreak(session: DocxEditorSession, doc: Node, pos: number, sectPr: number): boolean {
	if (session.story.story.kind !== "body" || !sectionWritten(session.story.part, sectPr, false)) return false

	const $pos = doc.resolve(pos)

	for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type !== nodes.sdt) return false

	return true
}

// A comment anchor (range start or end, reference): its kind and comment id.
function commentAnchor(node: Node): { readonly key: string; readonly id: string } | undefined {
	const id = node.attrs["id"] as string | null | undefined

	if (id === null || id === undefined) return undefined
	if (node.type === nodes.comment_ref) return { key: "commentReference", id }
	if (node.type !== nodes.marker) return undefined

	const kind = node.attrs["kind"] as string

	return kind === "commentRangeStart" || kind === "commentRangeEnd" ? { key: kind, id } : undefined
}

// A comment whose range and reference the deletion takes, around nothing that stays (the author's own
// insertion, deleted for real), goes with it as an untracked deletion takes it: its anchors are deleted too.
function realAnchors(result: Deletion, anchors: readonly { pos: number; key: string; id: string }[], stays: readonly number[]): boolean {
	const byId = new Map<string, Map<string, number>>()

	for (const anchor of anchors) {
		const keys = byId.get(anchor.id) ?? new Map<string, number>()

		keys.set(anchor.key, anchor.pos)
		byId.set(anchor.id, keys)
	}

	const going: number[] = []

	for (const keys of byId.values()) {
		if (keys.size !== 3) continue

		const positions = [...keys.values()]
		const low = Math.min(...positions)
		const high = Math.max(...positions)

		if (!stays.some(pos => pos > low && pos < high)) going.push(...positions)
	}

	if (going.length === 0) return false

	const pieces: [number, number][] = [...result.real, ...going.map((pos): [number, number] => [pos, pos + 1])].sort((a, b) => a[0] - b[0])

	result.real.length = 0

	for (const [start, end] of pieces) {
		const last = result.real[result.real.length - 1]

		if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end)
		else pushPiece(result.real, start, end)
	}

	return true
}

// Whether a table or row the author inserted holds content that is not the author's own insertion.
function othersIn(doc: Node, node: Node, pos: number, author: string, session: DocxEditorSession): boolean {
	let found = false

	node.descendants((child, offset) => {
		if (found) return false

		if (child.isInline) {
			const at = pos + 1 + offset

			found = !ownInsertion(child, author) && !inPending(session, doc, at, at + child.nodeSize)

			return false
		}

		if (child.type === nodes.locked_block) found = true

		return !found
	})

	return found
}

// A row the author inserted while tracking.
function ownRow(row: Node, author: string): boolean {
	return ((row.attrs["revision"] as number) & RevisionFlag.Inserted) !== 0 && rowOverrides(row).ins?.author === author
}

// Where content may be inserted next to a deleted range (strictly inside deleted text it may not).
function insertionPoint(doc: Node, preferred: number, other: number): number {
	const inside = (pos: number): boolean => {
		const $pos = doc.resolve(pos)
		const before = $pos.nodeBefore
		const after = $pos.nodeAfter

		return before !== null && after !== null && before.isInline && after.isInline && isDeleted(before) && isDeleted(after)
	}

	return inside(preferred) && !inside(other) ? other : preferred
}

// A key deleting only deleted text deletes the next character beyond it (as Word does), in the same
// paragraph; undefined when there is none.
function beyondDeleted(doc: Node, from: number, to: number, backward: boolean): [number, number] | undefined {
	const $from = doc.resolve(from)

	if (!$from.parent.inlineContent || $from.parent !== doc.resolve(to).parent) return undefined

	let pos = backward ? from : to

	for (;;) {
		const $pos = doc.resolve(pos)
		const node = backward ? $pos.nodeBefore : $pos.nodeAfter

		if (node === null || !node.isInline) return undefined

		if (!isDeleted(node) && markable(node)) {
			const size = node.isText ? 1 : node.nodeSize

			return backward ? [pos - size, pos] : [pos, pos + size]
		}

		pos += backward ? -node.nodeSize : node.nodeSize
	}
}

function copyMeta(from: Transaction, to: Transaction): void {
	const meta: unknown = Reflect.get(from, "meta")

	if (typeof meta === "object" && meta !== null) for (const key in meta) to.setMeta(key, Reflect.get(meta, key))
}

// The run base of a piece's formatting (its direct property marks over its run's base): the run's own base
// when they are its, one of the document's when another run has them, else one made from the w:rPr the writer
// would write for them. -1 for no formatting at all.
const madeBases = new WeakMap<DocxEditContext, Map<string, number>>()

export function formattingBase(context: DocxEditContext, part: StoryPart, nodeMarks: readonly Mark[]): number {
	const run = marks.run.isInSet(nodeMarks)
	const baseId = (run?.attrs["base"] as number | undefined) ?? -1
	const base: RunBase | undefined = baseId < 0 ? undefined : context.bases.get(baseId)
	const own = propertyMarks(nodeMarks)
	const plain = marks.plain.isInSet(nodeMarks) !== undefined

	if (own.length === 0 && (base === undefined || plain)) return -1
	if (base !== undefined && !plain && base.props.change === undefined && sameFormatting(own, base)) return base.id

	let made = madeBases.get(context)

	if (made === undefined) {
		made = new Map()
		madeBases.set(context, made)
	}

	const key = `${String(baseId)}|${own.map(mark => JSON.stringify(mark.toJSON())).join("|")}`
	const known = made.get(key)

	if (known !== undefined) return known

	const prefix = part.reader.namespaces.prefixFor(part.document.documentElement(), W_NAMESPACE) ?? "w"
	const names = new Names(prefix, "")
	const out = new Out()

	// The properties alone: a change the run's base carries is not part of them.
	writeRunProperties(out, names, own, base, { kind: "strip" })

	const rPr = decodeUtf8(out.finish())
	const declaration = prefix === "" ? `xmlns="${W_NAMESPACE}"` : `xmlns:${prefix}="${W_NAMESPACE}"`
	const xml = parseXml(encodeUtf8(`<x ${declaration}>${rPr === "" ? `<${names.el("rPr")}/>` : rPr}</x>`))
	const node = xml.firstChildElement(xml.documentElement())
	const id = node < 0 ? -1 : (context.bases.of(xml, node)?.id ?? -1)

	made.set(key, id)

	return id
}

const KEPT_WHEN_TRACKED: ReadonlySet<string> = new Set(["sectionBreak", "lockedBlock", "lockedContentControl"])

// ---- tracked replaces built whole ---------------------------------------------------------------------------

// Transactions built in their tracked form already (Replace All): left as they are, their plan marked after.
const prebuilt = new WeakSet<Transaction>()

// How replacing [from, to] of `block` (positions in its content; text only) is tracked, as rewriteStep tracks a
// replace of it: `real` (the author's own insertion) goes for real, `marked` is marked deleted; undefined when
// it cannot be told this way (text being composed, a comment going with it, an equation, nothing to mark), the
// transaction then going step by step. The author is the session's stamp's.
export interface TrackedReplace {
	readonly real: readonly (readonly [number, number])[]
	readonly marked: readonly (readonly [number, number])[]
	// Whether anything stays (else the replace goes as it is).
	readonly kept: boolean
}

export function trackedReplace(block: Node, from: number, to: number, session: DocxEditorSession): TrackedReplace | undefined {
	const stamp = revisionStamp(session.context.identity)

	if (stamp === undefined || waiting(session) !== undefined) return undefined

	const deletion = classify(block, from, to, stamp.author, session)

	if (deletion.refused || deletion.paragraphs.length > 0 || deletion.rows.length > 0 || deletion.equations.length > 0) return undefined
	if (deletion.real.some(([start, end]) => start < from || end > to)) return undefined
	if (deletion.kept && deletion.marked.length === 0 && deletion.real.length === 0) return undefined

	return { real: deletion.real, marked: deletion.marked, kept: deletion.kept }
}

// Records `tr` (built from `state` in its tracked form, see trackedReplace) as the change tracker's own rewrite:
// `deleted` and `inserted` ([from, to] pairs of its final document, in the order the tracker records them, the
// last replace first) are marked as the tracker marks what it records. False without the author's name.
export function prebuiltTracking(
	tr: Transaction,
	session: DocxEditorSession,
	deleted: readonly number[],
	inserted: readonly number[]
): boolean {
	const stamp = revisionStamp(session.context.identity)

	if (stamp === undefined) return false

	const at = tr.steps.length
	const ranges = (flat: readonly number[]): Range[] => {
		const out: Range[] = []

		for (let k = 0; k < flat.length; k += 2) out.push({ from: flat[k] ?? 0, to: flat[k + 1] ?? 0, at })

		return out
	}

	plans.set(tr, {
		stamp,
		session,
		inserted: ranges(inserted),
		deleted: ranges(deleted),
		marks: [],
		equations: [],
		rows: [],
		formats: [],
		settle: [],
		props: [],
		propsSeen: new Set(),
		composing: false
	})
	sessions.set(tr, session)
	prebuilt.add(tr)

	return true
}

// Turns a user transaction into its tracked form (see the top of this file). Transactions of feature
// commands, undo and redo pass as they are; without the author's name a transaction is refused.
export function trackTransaction(tr: Transaction, session: DocxEditorSession): Transaction {
	const context = session.context

	sessions.set(tr, session)

	// What tracking records is counted from now on, whether a snapshot asked or not (commands record too).
	if (context.review.tracking && tr.docChanged) wantReviewIndex(session)

	if (prebuilt.has(tr)) return tr

	if (!context.review.tracking && tr.docChanged && !isCommand(tr) && !isInternal(tr) && tr.before === session.state.doc) {
		const closed = closedPaste(tr, session.state)

		if (closed !== undefined) return closed
	}

	if (!context.review.tracking || !tr.docChanged || isCommand(tr) || isInternal(tr) || session.readOnly) return tr

	const state = session.state

	if (tr.before !== state.doc) return tr

	// Section breaks, locked blocks and locked content controls only may not be deleted for real: tracked, they
	// stay (what is deleted for real is checked again as the rewritten transaction applies).
	const violation = invariantViolation(tr)

	if (violation !== undefined && !KEPT_WHEN_TRACKED.has(violation)) return tr

	const stamp = revisionStamp(context.identity)

	if (stamp === undefined) {
		refused.add(tr)

		return tr
	}

	const composing = tr.getMeta("composition") !== undefined

	// Formatting and paragraph properties alone (a toolbar command over a selection): applied as they are, only
	// recorded (a selection over a long document makes thousands of steps; nothing is copied for them).
	if (tr.steps.every(step => markStepsOf(step) !== undefined || step instanceof AttrStep || step instanceof SetAttrsStep)) {
		const plan: TrackPlan = {
			stamp,
			session,
			inserted: [],
			deleted: [],
			marks: [],
			equations: [],
			rows: [],
			formats: [],
			settle: [],
			props: [],
			propsSeen: new Set(),
			composing
		}

		tr.steps.forEach((step, index) => {
			const doc = tr.docs[index] as Node
			const parts = markStepsOf(step)

			if (parts !== undefined) for (const part of parts) recordMarkStep(doc, part, plan, index)
			else if (step instanceof AttrStep && (PARAGRAPH_ATTRS as readonly string[]).includes(step.attr)) {
				const node = doc.nodeAt(step.pos)

				if (node?.type === nodes.paragraph) recordProps(node, step.pos, plan, index)
			} else if (step instanceof SetAttrsStep) recordAttrsStep(doc, step, plan, index)
		})

		plans.set(tr, plan)

		return tr
	}

	const out = state.tr

	sessions.set(out, session)
	const plan: TrackPlan = {
		stamp,
		session,
		inserted: [],
		deleted: [],
		marks: [],
		equations: [],
		rows: [],
		formats: [],
		settle: [],
		props: [],
		propsSeen: new Set(),
		composing
	}
	const inverted: StepMap[] = []
	let mapping = new Mapping()
	let caret: number | undefined
	const alone = tr.steps.length === 1 ? state : undefined

	// What was typed during a composition that has ended goes with this edit.
	const typed = composing ? undefined : waiting(session)

	if (typed !== undefined) {
		for (let k = 0; k < typed.ranges.length; k += 2)
			plan.inserted.push({ from: typed.ranges[k] ?? 0, to: typed.ranges[k + 1] ?? 0, at: 0 })
	}

	// The user's step `index` is mapped onto `out` through the inverses of the user's steps before it and what
	// `out` made of them. While `out` took every step as it was, positions agree (no mapping at all: a long
	// transaction of mark steps stays linear).
	let same = true

	for (let index = 0; index < tr.steps.length; index++) {
		const step = tr.steps[index] as Step
		const mapped = same ? step : step.map(mapping)
		const before = out.steps.length

		if (mapped !== null) {
			const result = rewriteStep(mapped, out, plan, alone)

			if (result === false || result === UNSUPPORTED) {
				refused.add(tr)

				if (result === UNSUPPORTED) unsupported.add(tr)

				return tr
			}

			if (result !== undefined) caret = result
		}

		const map = tr.mapping.maps[index]

		if (map !== undefined) inverted.unshift(map.invert())

		if (same && mapped !== null && out.steps.length === before + 1 && out.steps[before] === mapped) continue

		same = false
		mapping = new Mapping([...inverted, ...out.mapping.maps])
	}

	// What the composition typed and this edit deleted went for real (the author's own, not marked yet).
	if (typed !== undefined) pending.delete(session)

	copyMeta(tr, out)
	out.setTime(tr.time)

	if (tr.storedMarksSet) out.setStoredMarks(tr.storedMarks)
	if (tr.scrolledIntoView) out.scrollIntoView()

	const doc = out.doc

	if (caret !== undefined) {
		const $caret = doc.resolve(Math.max(0, Math.min(doc.content.size, caret)))

		out.setSelection($caret.parent.inlineContent ? TextSelection.create(doc, $caret.pos) : Selection.near($caret))
	} else {
		try {
			out.setSelection(tr.selection.map(doc, mapping))
		} catch {
			// Left where the rewritten steps mapped it.
		}
	}

	if (!out.docChanged) {
		// Only marks to add (a deletion kept, a format or property change): they are the edit itself.
		const map = (pos: number, at: number, assoc: number): number => out.mapping.slice(at).map(pos, assoc)

		const bulk = applyPlan(out, plan, map, [])

		settleFormats(out, plan, map)

		// Blocks rebuilt whole are the session's own step (the invariants would read it as their deletion).
		return bulk ? markInternal(out) : markCommand(out)
	}

	plans.set(out, plan)

	return out
}

// The insertion mark text typed by `step` takes in the step itself, or undefined when the step is more than
// typing (a transaction of several steps, a composition, content outside a paragraph or not all marked as runs,
// text typed in a composition waiting to be marked with it).
function typedInsertion(step: ReplaceStep, doc: Node, plan: TrackPlan, alone: EditorState | undefined): Mark | undefined {
	if (alone === undefined || plan.composing || plan.inserted.length > 0 || step.from !== step.to) return undefined

	const slice = step.slice

	if (slice.openStart !== 0 || slice.openEnd !== 0 || !doc.resolve(step.from).parent.isTextblock) return undefined

	for (let k = 0; k < slice.content.childCount; k++) {
		const node = slice.content.child(k)

		if (!markable(node) || node.marks.some(mark => REVISION_TYPES.includes(mark.type))) return undefined
	}

	const stamp = plan.stamp

	return (
		continued(doc, step.from, step.to, marks.insertion, stamp) ??
		marks.insertion.create({ src: NO_SOURCE, id: newChange(plan.session.context), author: stamp.author, date: stamp.date })
	)
}

// What rewriteStep returns for a step whose tracked form could not be saved.
const UNSUPPORTED = "unsupported"

// Applies one (mapped) user step to `out` in its tracked form, recording what the stage marks. Returns the
// caret after a lone deletion or a replacement, false when the step cannot be applied (UNSUPPORTED: its record
// could not be saved), undefined otherwise.
function rewriteStep(
	step: Step,
	out: Transaction,
	plan: TrackPlan,
	alone: EditorState | undefined
): number | false | typeof UNSUPPORTED | undefined {
	const author = plan.stamp.author
	const session = plan.session

	if (step instanceof ReplaceStep) {
		let from = step.from
		let to = step.to
		const empty = step.slice.size === 0
		let deletion = to > from ? classify(out.doc, from, to, author, session) : undefined

		if (deletion?.refused === true) return UNSUPPORTED
		const lone = alone !== undefined && alone.selection.empty && empty
		const backward = lone && alone.selection.head >= step.to

		// A key deleting only deleted text deletes the character beyond it.
		if (
			lone &&
			deletion !== undefined &&
			deletion.kept &&
			deletion.marked.length === 0 &&
			deletion.real.length === 0 &&
			deletion.paragraphs.length === 0
		) {
			const beyond = beyondDeleted(out.doc, from, to, backward)

			if (beyond === undefined) return backward ? from : to

			from = beyond[0]
			to = beyond[1]
			deletion = classify(out.doc, from, to, author, session)

			if (deletion.refused) return UNSUPPORTED
		}

		// Text typed (the transaction's one step, inline content inserted in a paragraph): marked in the step
		// itself, as the typing of a change it continues or of a new one. The undo history then joins a run of
		// keys into one step, as it does untracked (Word undoes typing in runs too).
		const typedMark = deletion === undefined && !empty ? typedInsertion(step, out.doc, plan, alone) : undefined

		if (typedMark !== undefined) {
			const content: Node[] = []

			step.slice.content.forEach(node => content.push(node.mark(typedMark.addToSet(node.marks))))

			if (out.maybeStep(new ReplaceStep(from, to, new Slice(Fragment.from(content), 0, 0))).failed !== null) return false

			markTyping(out)

			return undefined
		}

		if (deletion === undefined || !deletion.kept) {
			// Nothing to keep (or nothing deleted): the step as it is.
			const at = out.steps.length
			const own = deletion === undefined || (from === step.from && to === step.to) ? step : new ReplaceStep(from, to, step.slice)

			if (out.maybeStep(own).failed !== null) return false

			if (!empty) {
				const range = insertedRange(out, at)

				if (range !== undefined) recordInsertion(plan, range[0], range[1], out.steps.length)
			}

			return undefined
		}

		const markAt = out.steps.length

		recordDeletion(plan, deletion, markAt)

		// The author's own insertions go for real, from the end.
		for (const [a, b] of [...deletion.real].reverse()) out.delete(a, b)

		const after = out.mapping.slice(markAt)

		// The empty paragraph a deletion of whole blocks leaves (a document holds one) is not needed: they stay.
		if (!empty && !filler(step.slice)) {
			const at = out.steps.length
			const end = after.map(to, -1)

			out.replace(insertionPoint(out.doc, end, after.map(from, 1)), undefined, step.slice)

			const range = insertedRange(out, at)

			if (range === undefined) return false

			recordInsertion(plan, range[0], range[1], out.steps.length)

			return range[1]
		}

		if (!lone) return filler(step.slice) ? after.map(from, -1) : undefined

		// Backspace leaves the caret before what it deleted, Delete after it.
		return backward ? after.map(from, -1) : after.map(to, 1)
	}

	const parts = markStepsOf(step)

	if (parts !== undefined) {
		// A MarkSetStep's parts all read the document before it: the formatting before the step is recorded.
		for (const part of parts) recordMarkStep(out.doc, part, plan, out.steps.length)

		return out.maybeStep(step).failed === null ? undefined : false
	}

	if (step instanceof SetAttrsStep) {
		recordAttrsStep(out.doc, step, plan, out.steps.length)

		return out.maybeStep(step).failed === null ? undefined : false
	}

	if (step instanceof AttrStep) {
		const node = out.doc.nodeAt(step.pos)

		if (node?.type === nodes.paragraph && (PARAGRAPH_ATTRS as readonly string[]).includes(step.attr))
			recordProps(node, step.pos, plan, out.steps.length)

		return out.maybeStep(step).failed === null ? undefined : false
	}

	if (step instanceof ReplaceAroundStep) {
		if (step.insert === 1 && step.gapFrom === step.from + 1 && step.gapTo === step.to - 1) {
			// setNodeMarkup: the same paragraph with other attributes.
			const node = out.doc.nodeAt(step.from)

			if (node?.type === nodes.paragraph) recordProps(node, step.from, plan, out.steps.length)
		} else {
			// Content deleted around what the step keeps (a selection deleted across blocks): it all stays, marked;
			// the new structure around the rest is not made. A step that only moves block boundaries applies.
			const before = classify(out.doc, step.from, step.gapFrom, author, session)
			const after = classify(out.doc, step.gapTo, step.to, author, session)

			if (before.refused || after.refused) return UNSUPPORTED

			if (before.kept || after.kept) {
				const markAt = out.steps.length
				const pasted = pastedBeforeGap(step, out.doc)
				// A paste only moving block boundaries around what follows deletes nothing: they stay as they are.
				const deletes = [before, after].some(part => part.marked.length > 0 || part.real.length > 0)

				if (pasted === undefined || deletes) {
					recordDeletion(plan, before, markAt)
					recordDeletion(plan, after, markAt)
				}

				for (const [a, b] of [...before.real, ...after.real].sort((x, y) => y[0] - x[0])) out.delete(a, b)

				const at = out.mapping.slice(markAt).map(step.from, -1)

				// A paste the step wraps around what follows it (a slice cut inside a table row, pasted into a
				// paragraph): what it brings is inserted on its own, closed, where it went; what follows stays.
				if (pasted !== undefined) {
					const start = out.steps.length

					out.replace(at, at, pasted)

					const range = insertedRange(out, start)

					if (range !== undefined) {
						recordInsertion(plan, range[0], range[1], out.steps.length)

						return alone === undefined ? undefined : range[1]
					}
				}

				return alone === undefined ? undefined : at
			}
		}
	}

	return out.maybeStep(step).failed === null ? undefined : false
}

// A paste of a slice cut inside table rows into a paragraph (ProseMirror wraps the rows around the text after
// the caret, which goes into the last pasted cell): the rows go in on their own, the text after the caret stays
// in a paragraph after them, as Word pastes them and as the tracked form records them. Undefined for anything
// else.
function closedPaste(tr: Transaction, state: EditorState): Transaction | undefined {
	const step = tr.steps[0]

	if (tr.steps.length !== 1 || !(step instanceof ReplaceAroundStep) || step.insert === 1) return undefined

	const pasted = pastedBeforeGap(step, state.doc)

	if (pasted === undefined) return undefined

	let content = false

	for (const [from, to] of [
		[step.from, step.gapFrom],
		[step.gapTo, step.to]
	] as const)
		if (to > from)
			state.doc.nodesBetween(from, to, (node, pos) => {
				if (node.isInline && pos < to && pos + node.nodeSize > from) content = true

				return !content
			})

	if (content) return undefined

	const out = state.tr.replace(step.from, step.from, pasted)
	const range = insertedRange(out, 0)

	copyMeta(tr, out)
	out.setTime(tr.time)

	if (tr.scrolledIntoView) out.scrollIntoView()
	if (range !== undefined) out.setSelection(Selection.near(out.doc.resolve(range[1]), -1))

	return out
}

// What a ReplaceAroundStep pastes before its gap, closed at the gap, when that is content and the slice after
// the gap only closes what holds the gap's content.
function pastedBeforeGap(step: ReplaceAroundStep, doc: Node): Slice | undefined {
	const slice = step.slice
	// The gap's place in the slice's content (slice positions start after its open tokens).
	const gap = step.insert + slice.openStart

	if (step.insert <= 0 || gap >= slice.content.size) return undefined

	const after = slice.content.cut(gap)
	let closesOnly = true

	after.descendants(node => {
		if (node.isInline || node.isLeaf) closesOnly = false

		return closesOnly
	})

	if (!closesOnly) return undefined

	const before = slice.content.cut(0, gap)
	let content = false

	before.descendants(node => {
		if (node.isInline || node.type === nodes.table) content = true

		return !content
	})

	return content ? new Slice(withOpenedCell(before, doc), slice.openStart, 0) : undefined
}

// The pasted content with the cell the slice was cut in the middle of (made by the fit around its first row,
// without properties) given those of that cell: the source cell of the paragraph that opens the slice when the
// document still holds it, else those of the cell below it in the pasted rows.
function withOpenedCell(content: Fragment, doc: Node): Fragment {
	const opening = content.firstChild
	const table = content.childCount > 1 ? content.child(1) : null

	if (opening?.type !== nodes.paragraph || table?.type !== nodes.table) return content

	const row = table.firstChild
	const cell = row?.firstChild

	if (row === null || row === undefined || cell === null || cell === undefined || cell.marks.length > 0 || row.childCount !== 1)
		return content

	const src = opening.attrs["src"] as number
	let model: { row: Node | undefined; cell: Node } | undefined

	if (src !== NO_SOURCE) {
		doc.descendants((node, pos) => {
			if (model !== undefined) return false
			if (node.type !== nodes.paragraph) return !node.isTextblock
			if ((node.attrs["src"] as number) !== src) return false

			const $pos = doc.resolve(pos)

			for (let depth = $pos.depth; depth > 0; depth--) {
				if ($pos.node(depth).type === nodes.table_cell) {
					model = { cell: $pos.node(depth), row: $pos.node(depth - 1) }

					break
				}
			}

			return false
		})
	}

	const below = table.childCount > 1 ? table.child(1).firstChild : null

	model ??= below === null ? undefined : { cell: below, row: undefined }

	if (model === undefined) return content

	const filled = model.cell.type.create(
		{ ...model.cell.attrs, colspan: cell.attrs["colspan"], vMerge: null },
		cell.content,
		model.cell.marks
	)
	const rowNode =
		model.row === undefined
			? row.copy(Fragment.from(filled))
			: model.row.type.create(model.row.attrs, Fragment.from(filled), model.row.marks)

	return content.replaceChild(1, table.copy(table.content.replaceChild(0, rowNode)))
}

function recordDeletion(plan: TrackPlan, deletion: Deletion, at: number): void {
	for (const [from, to] of deletion.marked) plan.deleted.push({ from, to, at })
	for (const pos of deletion.paragraphs) plan.marks.push({ pos, at })
	for (const pos of deletion.rows) plan.rows.push({ pos, at })
	for (const pos of deletion.equations) plan.equations.push({ pos, at })
}

// A closed slice of one empty paragraph: what a deletion of whole blocks puts in their place.
function filler(slice: Slice): boolean {
	const only = slice.content.firstChild

	return (
		slice.openStart === 0 &&
		slice.openEnd === 0 &&
		slice.content.childCount === 1 &&
		only?.type === nodes.paragraph &&
		only.content.size === 0
	)
}

function insertedRange(out: Transaction, at: number): [number, number] | undefined {
	let from = Number.MAX_SAFE_INTEGER
	let to = -1

	for (let k = at; k < out.steps.length; k++) {
		const later = out.mapping.slice(k + 1)

		out.mapping.maps[k]?.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
			if (newEnd <= newStart) return

			from = Math.min(from, later.map(newStart, -1))
			to = Math.max(to, later.map(newEnd, 1))
		})
	}

	return to > from ? [from, to] : undefined
}

function recordInsertion(plan: TrackPlan, from: number, to: number, at: number): void {
	plan.inserted.push({ from, to, at })
}

// What a mark step sets: ranges in document order, not overlapping, and whether a node's marks change there.
interface FormatRange {
	readonly from: number
	readonly to: number
	readonly changes: (nodeMarks: readonly Mark[]) => boolean
	// Whether the run mark changes there too.
	readonly run?: (nodeMarks: readonly Mark[]) => boolean
}

// A formatting mark step about to apply: what it changes is recorded (content it leaves as it is, inside a
// SetMarksStep's range or under a mark it already has, is no change).
function recordMarkStep(doc: Node, step: MarkStep, plan: TrackPlan, at: number): void {
	const mark = step.mark
	const type = mark.type

	if (step instanceof SetMarkSetsStep) {
		if (!step.types.some(other => FORMATTING_TYPES.has(other))) return

		const setsRun = step.types.includes(marks.run)

		recordFormats(
			doc,
			step.pieces.map(piece => ({
				from: piece.from,
				to: piece.to,
				changes: nodeMarks => step.changes(piece, nodeMarks),
				...(setsRun
					? {
							run: (nodeMarks: readonly Mark[]) => {
								const now = marks.run.isInSet(nodeMarks)
								const next = marks.run.isInSet(piece.marks)

								return now === undefined ? next !== undefined : next === undefined || !now.eq(next)
							}
						}
					: {})
			})),
			plan,
			at
		)

		return
	}

	if (!FORMATTING_TYPES.has(type)) return

	if (step instanceof SetMarksStep) {
		const ranges: FormatRange[] = []

		for (const piece of step.pieces) {
			const set = piece.mark

			ranges.push({
				from: piece.from,
				to: piece.to,
				changes: set === null ? nodeMarks => type.isInSet(nodeMarks) !== undefined : nodeMarks => !set.isInSet(nodeMarks)
			})
		}

		recordFormats(doc, ranges, plan, at)
	} else {
		const add = step instanceof AddMarkStep

		recordFormats(doc, [{ from: step.from, to: step.to, changes: nodeMarks => mark.isInSet(nodeMarks) !== add }], plan, at)
	}
}

// Formatting about to change on `ranges`: each piece's formatting before (runs with the same one are one
// range), unless it is an insertion or deleted. A piece with a change already keeps it (the oldest formatting
// is what a change keeps) and is only settled (a change back is none). One walk for all ranges.
function recordFormats(doc: Node, ranges: readonly FormatRange[], plan: TrackPlan, at: number): void {
	const first = ranges[0]
	const end = ranges[ranges.length - 1]?.to ?? 0

	if (first === undefined) return

	const session = plan.session
	let last: FormatPiece | undefined
	let k = 0

	for (const range of ranges) plan.settle.push({ from: range.from, to: range.to, at })

	doc.nodesBetween(first.from, end, (node, pos) => {
		const stop = pos + node.nodeSize

		while (k < ranges.length && (ranges[k]?.to ?? 0) <= pos) k++

		if (k >= ranges.length || (ranges[k]?.from ?? 0) >= stop) return false
		if (!node.isInline) return true

		const skipped =
			!markable(node) ||
			isDeleted(node) ||
			marks.insertion.isInSet(node.marks) !== undefined ||
			marks.format_change.isInSet(node.marks) !== undefined

		for (let j = k; j < ranges.length && (ranges[j]?.from ?? 0) < stop; j++) {
			const range = ranges[j] as FormatRange
			const start = Math.max(range.from, pos)
			const to = Math.min(range.to, stop)

			if (to <= start) continue

			if (skipped || !range.changes(node.marks)) {
				last = undefined

				continue
			}

			const base = formattingBase(session.context, session.story.part, node.marks)
			const runMark = range.run?.(node.marks) === true ? marks.run.isInSet(node.marks) : null
			const run: RunBefore =
				runMark === null
					? null
					: runMark === undefined
						? false
						: { src: runMark.attrs["src"] as number, base: runMark.attrs["base"] as number }

			if (last !== undefined && last.base === base && sameRunBefore(last.run, run) && last.to === start) {
				last = { ...last, to }
				plan.formats[plan.formats.length - 1] = last
			} else {
				last = { from: start, to, at, base, run }
				plan.formats.push(last)
			}
		}

		return false
	})
}

// The paragraphs whose properties a SetAttrsStep about to apply to `doc` changes (one walk).
function recordAttrsStep(doc: Node, step: SetAttrsStep, plan: TrackPlan, at: number): void {
	step.eachNode(doc, (node, pos, attrs) => {
		if (node.type !== nodes.paragraph) return

		for (const name of PARAGRAPH_ATTRS) {
			if (name in attrs) {
				recordProps(node, pos, plan, at)

				return
			}
		}
	})
}

// A paragraph's attributes about to change: the first change of a transaction records them (later steps
// over the same paragraph see what earlier ones made).
function recordProps(node: Node, pos: number, plan: TrackPlan, at: number): void {
	const key = `${String(pos)}@${String(at)}`

	if (plan.propsSeen.has(key)) return

	plan.propsSeen.add(key)

	if (paragraphChange(node)?.props !== undefined || ownParagraphMark(node, plan.stamp.author)) return
	if (sourceHasPropertyChange(plan.session, node)) return

	plan.props.push({ pos, at, before: paragraphAttrs(node) })
}

// Whether a paragraph's source properties hold a tracked change of their own (kept: it records older ones).
function sourceHasPropertyChange(session: DocxEditorSession, node: Node): boolean {
	const src = node.attrs["src"] as number

	if (src === NO_SOURCE) return false

	const part = session.story.part
	const row = part.aux[src] ?? -1
	const pPr = row < 0 ? -1 : (part.paragraphs.pPr[row] ?? -1)

	return (
		pPr >= 0 && session.context.store.paragraph(part.document, pPr).change !== undefined && paragraphChange(node)?.source === undefined
	)
}

// ---- marking (the tracking stage) -------------------------------------------------------------------------

const REVISION_TYPES: readonly MarkType[] = [marks.insertion, marks.deletion, marks.move_from, marks.move_to, marks.format_change]

// ---- marking: what a plan adds, as steps or (when it is large) as one rebuilt range ---------------------------

// Plans touching more ranges and paragraphs than this rebuild the blocks they touch in one step (a step per
// piece would copy the document's block list for each of thousands of pieces).
const BULK = 48

// Marks added over [from, to): an insertion (copies of other changes there go; inline atoms at paragraph level
// keep theirs), a deletion (on what is not deleted), a formatting change (where there is none). Only run content
// that tracked changes mark gets the mark.
interface MarkOp {
	readonly from: number
	readonly to: number
	readonly kind: "insert" | "delete" | "format"
	readonly mark: Mark
}

// What a paragraph's mark and property records become.
interface ParagraphUpdate {
	readonly or: number
	readonly andNot: number
	change(change: ParagraphChange): ParagraphChange
}

interface Marking {
	readonly marks: MarkOp[]
	readonly paragraphs: Map<number, ParagraphUpdate[]>
	// Table rows (by position) flagged deleted or inserted, with the stamp of the change.
	readonly rows: Map<number, RowChange>
}

interface RowChange {
	// RevisionFlag.Inserted or RevisionFlag.Deleted.
	readonly flag: number
	readonly stamp: TrackStamp
}

// A row with its insertion or deletion recorded (Word's w:trPr/w:ins or w:del).
function changedRow(row: Node, change: RowChange): { readonly revision: number; readonly overrides: RowOverrides } {
	const inserted = change.flag === RevisionFlag.Inserted

	return {
		revision: (row.attrs["revision"] as number) | change.flag,
		overrides: inserted ? { ...rowOverrides(row), ins: change.stamp } : { ...rowOverrides(row), del: change.stamp }
	}
}

function update(marking: Marking, pos: number, entry: ParagraphUpdate): void {
	const list = marking.paragraphs.get(pos)

	if (list === undefined) marking.paragraphs.set(pos, [entry])
	else list.push(entry)
}

function withoutStamps(change: ParagraphChange | undefined): ParagraphChange {
	if (change === undefined) return {}

	const { inserted: _inserted, deleted: _deleted, ...rest } = change

	return rest
}

// The insertion of [from, to) by `stamp`: its mark, and the paragraph marks in it flagged inserted.
// A mark of `type` by the stamp's author and minute on content next to [from, to) (or at its start): the change
// that content continues, whose id it keeps.
function continued(doc: Node, from: number, to: number, type: MarkType, stamp: RevisionStamp): Mark | undefined {
	const size = doc.content.size
	const $from = doc.resolve(Math.max(0, Math.min(size, from)))
	const $to = doc.resolve(Math.max(0, Math.min(size, to)))

	for (const node of [$from.nodeBefore, $to.nodeAfter, $from.nodeAfter]) {
		const mark = node?.isInline === true ? type.isInSet(node.marks) : undefined

		if (
			mark !== undefined &&
			mark.attrs["src"] === NO_SOURCE &&
			mark.attrs["id"] !== null &&
			mark.attrs["author"] === stamp.author &&
			mark.attrs["date"] === stamp.date
		)
			return mark
	}

	return undefined
}

// A change of its own: the next id of the document's revision ids (above every id in the file).
function newChange(context: DocxEditContext): number {
	return context.ids.next("revision")
}

// `same`: the mark of the transaction's other insertions (what one transaction inserts is one change).
function addInsertion(
	doc: Node,
	marking: Marking,
	from: number,
	to: number,
	stamp: RevisionStamp,
	context: DocxEditContext,
	same?: Mark,
	walk?: OrderedDoc
): Mark {
	const mark =
		same ??
		continued(doc, from, to, marks.insertion, stamp) ??
		marks.insertion.create({ src: NO_SOURCE, id: newChange(context), author: stamp.author, date: stamp.date })
	const own: RevisionStamp = { author: stamp.author, date: stamp.date, id: mark.attrs["id"] as number }

	const walker = walk ?? new OrderedDoc(doc)

	marking.marks.push({ from, to, kind: "insert", mark })
	walker.nodesBetween(from, to, (node, pos) => {
		if (node.isInline) return false

		const close = pos + node.nodeSize - 1

		if (node.type === nodes.paragraph && close >= from && close < to)
			update(marking, pos, {
				or: RevisionFlag.Inserted,
				andNot: RevisionFlag.Deleted,
				change: change => ({ ...withoutStamps(change), inserted: own })
			})

		// A row inserted whole (a pasted table) is an inserted row, as Word records it.
		if (
			node.type === nodes.table_row &&
			pos >= from &&
			close < to &&
			((node.attrs["revision"] as number) & RevisionFlag.Inserted) === 0
		)
			marking.rows.set(pos, { flag: RevisionFlag.Inserted, stamp: own })

		return node.type !== nodes.locked_block
	})

	return mark
}

// The marks of `node` under the mark operations covering it.
function markedWith(node: Node, ops: readonly MarkOp[]): readonly Mark[] {
	let set = node.marks

	for (const op of ops) {
		if (op.kind === "insert") {
			for (const mark of set) if (REVISION_TYPES.includes(mark.type) && !mark.eq(op.mark)) set = mark.removeFromSet(set)

			if (markable(node)) set = op.mark.addToSet(set)
		} else if (op.kind === "delete") {
			if (markable(node) && !isDeleted(node)) set = op.mark.addToSet(set)
		} else if (markable(node) && marks.format_change.isInSet(set) === undefined) {
			set = op.mark.addToSet(set)
		}
	}

	return set
}

function updated(node: Node, updates: readonly ParagraphUpdate[]): { revision: number; change: ParagraphChange | undefined } {
	let revision = node.attrs["revision"] as number
	let change = paragraphChange(node)

	for (const entry of updates) {
		revision = (revision | entry.or) & ~entry.andNot
		change = entry.change(change ?? {})
	}

	return { revision, change }
}

// The marking as steps: few ranges and paragraphs (an edit as typed).
function markSteps(tr: Transaction, marking: Marking): void {
	for (const op of marking.marks) {
		const runs: [number, number][] = []
		const removed = new Set<Mark>()

		tr.doc.nodesBetween(op.from, op.to, (node, pos) => {
			if (!node.isInline) return node.type !== nodes.locked_block

			const start = Math.max(op.from, pos)
			const end = Math.min(op.to, pos + node.nodeSize)

			if (end <= start) return false

			if (op.kind === "insert")
				for (const mark of node.marks) if (REVISION_TYPES.includes(mark.type) && !mark.eq(op.mark)) removed.add(mark)

			const wanted = markedWith(node, [op])

			if (wanted !== node.marks && op.mark.isInSet(wanted) && !op.mark.isInSet(node.marks)) {
				const last = runs[runs.length - 1]

				if (last !== undefined && last[1] === start) last[1] = end
				else runs.push([start, end])
			}

			return false
		})

		for (const mark of removed) tr.removeMark(op.from, op.to, mark)
		for (const [from, to] of runs) tr.addMark(from, to, op.mark)
	}

	for (const [pos, updates] of marking.paragraphs) {
		const node = tr.doc.nodeAt(pos)

		if (node?.type !== nodes.paragraph) continue

		const { revision, change } = updated(node, updates)

		if (revision !== node.attrs["revision"]) tr.setNodeAttribute(pos, "revision", revision)

		setParagraphChange(tr, pos, tr.doc.nodeAt(pos) ?? node, change ?? {})
	}

	for (const [pos, change] of marking.rows) {
		const row = tr.doc.nodeAt(pos)

		if (row?.type !== nodes.table_row) continue

		const { revision, overrides } = changedRow(row, change)

		tr.setNodeAttribute(pos, "revision", revision)
		tr.addNodeMark(pos, marks.row_props.create({ value: overrides }))
	}
}

// The marking as one step: the top-level blocks it touches, rebuilt with it.
function markBulk(tr: Transaction, marking: Marking): void {
	const doc = tr.doc
	const ops = [...marking.marks].sort((a, b) => a.from - b.from)
	const positions = [...marking.paragraphs.keys(), ...marking.rows.keys()].sort((a, b) => a - b)
	let low = Math.min(ops[0]?.from ?? Infinity, positions[0] ?? Infinity)
	let high = Math.max(...ops.map(op => op.to), (positions[positions.length - 1] ?? -1) + 1)

	if (!(high > low)) return

	low = Math.max(0, low)
	high = Math.min(doc.content.size, high)

	// Operations overlapping [from, to): per kind (the ranges of one kind do not overlap), by binary search on
	// their starts and the largest end so far.
	const kinds = (["insert", "delete", "format"] as const).map(kind => {
		const list = ops.filter(op => op.kind === kind)
		const ends: number[] = []
		let max = -1

		for (const op of list) ends.push((max = Math.max(max, op.to)))

		return { list, ends }
	})
	const covering = (from: number, to: number): MarkOp[] => {
		const out: MarkOp[] = []

		for (const { list, ends } of kinds) {
			let lo = 0
			let hi = ends.length

			while (lo < hi) {
				const middle = (lo + hi) >> 1

				if ((ends[middle] ?? 0) <= from) lo = middle + 1
				else hi = middle
			}

			for (let k = lo; k < list.length && (list[k]?.from ?? 0) < to; k++) {
				const op = list[k] as MarkOp

				if (op.to > from) out.push(op)
			}
		}

		return out
	}
	const touched = (from: number, to: number): boolean => {
		if (covering(from, to).length > 0) return true

		let lo = 0
		let hi = positions.length

		while (lo < hi) {
			const middle = (lo + hi) >> 1

			if ((positions[middle] ?? 0) < from) lo = middle + 1
			else hi = middle
		}

		return lo < positions.length && (positions[lo] ?? 0) < to
	}
	const inline = (paragraph: Node, start: number): Node[] => {
		const out: Node[] = []

		paragraph.forEach((child, offset) => {
			const pos = start + offset
			const end = pos + child.nodeSize
			const over = covering(pos, end)

			if (over.length === 0) {
				out.push(child)

				return
			}

			if (!child.isText) {
				out.push(
					child.mark(
						markedWith(
							child,
							over.filter(op => op.from <= pos && op.to >= end)
						)
					)
				)

				return
			}

			// Text cut where operations start or end inside it.
			const cuts = new Set<number>([pos, end])

			for (const op of over) {
				if (op.from > pos && op.from < end) cuts.add(op.from)
				if (op.to > pos && op.to < end) cuts.add(op.to)
			}

			const sorted = [...cuts].sort((a, b) => a - b)
			const text = child.text ?? ""

			for (let k = 0; k + 1 < sorted.length; k++) {
				const a = sorted[k] as number
				const b = sorted[k + 1] as number
				const piece = docxSchema.text(text.slice(a - pos, b - pos), child.marks)

				out.push(
					piece.mark(
						markedWith(
							piece,
							over.filter(op => op.from <= a && op.to >= b)
						)
					)
				)
			}
		})

		return out
	}
	const rebuild = (node: Node, pos: number): Node => {
		if (!touched(pos, pos + node.nodeSize)) return node

		let next = node

		if (node.isTextblock) next = node.copy(Fragment.fromArray(inline(node, pos + 1)))
		else if (!node.isLeaf) {
			const children: Node[] = []

			node.forEach((child, offset) => children.push(rebuild(child, pos + 1 + offset)))
			next = node.copy(Fragment.fromArray(children))
		}

		const row = marking.rows.get(pos)

		if (row !== undefined && next.type === nodes.table_row) {
			const { revision, overrides } = changedRow(next, row)

			next = next.type.create(
				{ ...next.attrs, revision },
				next.content,
				marks.row_props.create({ value: overrides }).addToSet(next.marks)
			)
		}

		const updates = marking.paragraphs.get(pos)

		if (updates !== undefined && next.type === nodes.paragraph) {
			const { revision, change } = updated(next, updates)
			const others = next.marks.filter(mark => mark.type !== marks.paragraph_change)
			const nodeMarks =
				change === undefined || Object.keys(change).length === 0
					? others
					: marks.paragraph_change.create({ value: change }).addToSet(others)

			next = next.type.create({ ...next.attrs, revision }, next.content, nodeMarks)
		}

		return next
	}
	const children: Node[] = []
	let from = -1
	let to = -1

	doc.forEach((child, offset) => {
		const end = offset + child.nodeSize

		if (end <= low || offset >= high) return

		if (from < 0) from = offset

		to = end
		children.push(rebuild(child, offset))
	})

	if (from < 0) return

	const first = tr.steps.length

	tr.replaceWith(from, to, children)

	if (ops.every(op => op.kind !== "format")) for (let k = first; k < tr.steps.length; k++) markRemarking(tr.steps[k] as Step)
}

// Applies `marking`; true when it rebuilt blocks in one step (no invariant may see that step as a deletion).
function applyMarking(tr: Transaction, marking: Marking): boolean {
	if (marking.marks.length + marking.paragraphs.size + marking.rows.size <= BULK) {
		markSteps(tr, marking)

		return false
	}

	markBulk(tr, marking)

	return true
}

// The tracking stage's repair: the marks the plans of `transactions` recorded, as one internal transaction.
export function trackingRepair(transactions: readonly Transaction[], state: EditorState): Transaction | null {
	let repair: Transaction | null = markFollows(transactions, state)

	transactions.forEach((trackTr, index) => {
		const plan = plans.get(trackTr)

		if (plan === undefined) return

		const later = transactions.slice(index + 1)
		const tr = (repair ??= state.tr)
		// Steps that move nothing (marks, attributes) are no mapping: past the last that moves, positions stand.
		const maps = trackTr.mapping.maps
		let moving = maps.length - 1

		while (moving >= 0 && maps[moving] === StepMap.empty) moving--

		const movers = later.filter(other => other.docChanged)
		const map = (pos: number, at: number, assoc: number): number => {
			let mapped = at > moving ? pos : trackTr.mapping.slice(at).map(pos, assoc)

			for (const other of movers) mapped = other.mapping.map(mapped, assoc)

			return mapped
		}

		applyPlan(tr, plan, map, transactions.slice(index))
		settleFormats(tr, plan, map)
	})

	if (repair === null) return null

	const tr: Transaction = repair

	return tr.docChanged ? markInternal(tr) : null
}

// Adds what `plan` recorded to `tr`; `map` takes a position recorded after step `at` of the rewritten
// transaction to `tr`'s document. `batch`: the transactions applied since the rewritten one (for text an IME
// is still composing, which waits).
function applyPlan(
	tr: Transaction,
	plan: TrackPlan,
	map: (pos: number, at: number, assoc: number) => number,
	batch: readonly Transaction[]
): boolean {
	const doc = tr.doc
	const size = doc.content.size
	const stamp = plan.stamp
	const context = plan.session.context
	const marking: Marking = { marks: [], paragraphs: new Map(), rows: new Map() }
	const mapped = (range: Range): [number, number] | undefined => {
		const from = Math.max(0, Math.min(size, map(range.from, range.at, 1)))
		const to = Math.max(0, Math.min(size, map(range.to, range.at, -1)))

		return to > from ? [from, to] : undefined
	}
	const inserted: number[] = []
	const equations: { pos: number; omml: string }[] = []

	for (const range of plan.inserted) {
		const at = mapped(range)

		if (at !== undefined) inserted.push(at[0], at[1])
	}

	if (plan.composing) {
		if (inserted.length > 0) addPending(plan.session, stamp, inserted, doc, batch)
	} else if (inserted.length > 0) {
		// One change for all of it, the one the first range continues (or a new one); the ranges marked in
		// document order, by one walk of it.
		const mark =
			continued(doc, inserted[0] ?? 0, inserted[1] ?? 0, marks.insertion, stamp) ??
			marks.insertion.create({ src: NO_SOURCE, id: newChange(context), author: stamp.author, date: stamp.date })
		const pairs: [number, number][] = []
		const walk = new OrderedDoc(doc)

		for (let k = 0; k < inserted.length; k += 2) pairs.push([inserted[k] ?? 0, inserted[k + 1] ?? 0])

		for (const [from, to] of pairs.sort((a, b) => a[0] - b[0])) addInsertion(doc, marking, from, to, stamp, context, mark, walk)
	}

	// What one transaction deletes is one change (text and paragraph marks, across blocks), continuing the
	// author's deletion it touches.
	let deletion: Mark | undefined

	for (const range of plan.deleted) {
		const at = mapped(range)

		if (at === undefined) continue

		deletion ??=
			continued(doc, at[0], at[1], marks.deletion, stamp) ??
			marks.deletion.create({ src: NO_SOURCE, id: newChange(context), author: stamp.author, date: stamp.date })
		marking.marks.push({ from: at[0], to: at[1], kind: "delete", mark: deletion })
	}

	// The blocks recorded by position, found in one walk (a node lookup per position is linear in the blocks
	// before it).
	const markAt = plan.marks.map(({ pos, at }) => map(pos, at, 1))
	const rowAt = plan.rows.map(({ pos, at }) => map(pos, at, 1))
	const propsAt = plan.props.map(change => map(change.pos, change.at, 1))
	const blocks = nodesAt(doc, [...markAt, ...rowAt, ...propsAt])
	const paragraphAt = (pos: number): Node | undefined => {
		const node = blocks.get(pos)

		return node?.type === nodes.paragraph ? node : undefined
	}

	for (const where of markAt) {
		const node = paragraphAt(where)

		if (node === undefined) continue

		// A deleted paragraph mark is part of the deletion of the text next to it.
		const close = where + node.nodeSize - 1
		const next = close + 2

		deletion ??=
			continued(doc, close, next, marks.deletion, stamp) ??
			marks.deletion.create({ src: NO_SOURCE, id: newChange(context), author: stamp.author, date: stamp.date })

		const own: RevisionStamp = { author: stamp.author, date: stamp.date, id: deletion.attrs["id"] as number }

		update(marking, where, { or: RevisionFlag.Deleted, andNot: 0, change: change => ({ ...change, deleted: own }) })
	}

	// Equations deleted whole: their deletion recorded inside them, as part of the deletion of the text next to them.
	for (const { pos, at } of plan.equations) {
		const where = map(pos, at, 1)
		const node = where >= 0 && where < size ? doc.nodeAt(where) : null

		if (node?.type !== nodes.math) continue

		deletion ??=
			continued(doc, where, where + 1, marks.deletion, stamp) ??
			marks.deletion.create({ src: NO_SOURCE, id: newChange(context), author: stamp.author, date: stamp.date })

		const omml = trackedDeletion(node, plan.session.story.part, deletion.attrs["id"] as number, stamp)

		// One that could not be saved refused the transaction as it was classified.
		if (omml !== undefined && omml !== null) equations.push({ pos: where, omml })
	}

	for (const where of rowAt) {
		if (blocks.get(where)?.type !== nodes.table_row) continue

		deletion ??= marks.deletion.create({ src: NO_SOURCE, id: newChange(context), author: stamp.author, date: stamp.date })
		marking.rows.set(where, {
			flag: RevisionFlag.Deleted,
			stamp: { author: stamp.author, date: stamp.date, id: deletion.attrs["id"] as number }
		})
	}

	// One formatting command is one change, one property change of a paragraph another.
	let formatId: number | undefined

	for (const piece of plan.formats) {
		const at = mapped(piece)

		if (at === undefined) continue

		formatId ??= newChange(context)
		marking.marks.push({
			from: at[0],
			to: at[1],
			kind: "format",
			mark: marks.format_change.create({ id: formatId, author: stamp.author, date: stamp.date, base: piece.base, run: piece.run })
		})
	}

	// The first record of a paragraph holds what it had before the transaction.
	const recorded = new Set<number>()

	plan.props.forEach((change, k) => {
		const where = propsAt[k] ?? -1
		const node = paragraphAt(where)

		if (node === undefined || recorded.has(where) || paragraphChange(node)?.props !== undefined) return

		recorded.add(where)

		const id = newChange(context)

		update(marking, where, { or: 0, andNot: 0, change: current => ({ ...current, props: { before: change.before, ...stamp, id } }) })
	})

	// Attributes move nothing: before the marking rebuilds what it marks.
	for (const { pos, omml } of equations) tr.setNodeAttribute(pos, "omml", omml)

	return applyMarking(tr, marking)
}

// The nodes starting at `positions` of `doc` (any order; positions where none starts are left out), in one walk.
function nodesAt(doc: Node, positions: readonly number[]): Map<number, Node> {
	const found = new Map<number, Node>()

	if (positions.length === 0) return found

	const sorted = [...new Set(positions)].sort((a, b) => a - b)
	let k = 0
	const visit = (node: Node, start: number): void => {
		node.forEach((child, offset) => {
			const pos = start + offset
			const end = pos + child.nodeSize

			while (k < sorted.length && (sorted[k] ?? 0) < pos) k++

			if (k >= sorted.length || (sorted[k] ?? 0) >= end) return

			if (sorted[k] === pos) {
				found.set(pos, child)
				k++
			}

			if (!child.isLeaf && k < sorted.length && (sorted[k] ?? 0) < end) visit(child, pos + 1)
		})
	}

	visit(doc, 0)

	return found
}

// A paragraph's mark stays with the content that ends with it: what an edit splits off before it (Enter, a
// paste of paragraphs) ends with new marks, and paragraphs it joins end with the mark of the last of them. Its
// revision (the RevisionFlag bits, and who and when as stamps) follows it there; marks the edit made are new
// (none until tracking flags them). Read from the source, a revision that moves becomes a stamp, so the
// writer writes it wherever it is.
interface MarkState {
	readonly flags: number
	readonly inserted: RevisionStamp | undefined
	readonly deleted: RevisionStamp | undefined
}

const MARK_FLAGS = RevisionFlag.Inserted | RevisionFlag.Deleted | RevisionFlag.MovedFrom | RevisionFlag.MovedTo

function sourceStamp(session: DocxEditorSession, src: number, kind: number): RevisionStamp | undefined {
	if (src === NO_SOURCE) return undefined

	const part = session.story.part
	const revisions = part.revisions
	const model = session.context.model

	for (let k = 0; k < revisions.count; k++) {
		if (revisions.item[k] !== src || revisions.kind[k] !== kind) continue

		const author = model.string(revisions.author[k] ?? -1) ?? ""
		const id = revisions.id[k] ?? -1

		return {
			author,
			date: model.string(revisions.date[k] ?? -1) ?? "",
			...(id >= 0 ? { id } : {}),
			element: revisions.node[k] ?? -1
		}
	}

	return undefined
}

// A paragraph split by a command (a section break): the half before it ends with a new mark (inserted while
// tracking: `stamp`), the half after keeps the paragraph's own mark, its revision stamps made explicit (as a
// moved mark's are). The revision attribute and paragraph change of each.
export interface SplitMark {
	readonly revision: number
	readonly change: ParagraphChange
}

export function splitParagraphMark(
	node: Node,
	session: DocxEditorSession,
	stamp: RevisionStamp | undefined
): { readonly first: SplitMark; readonly later: SplitMark } {
	const revision = node.attrs["revision"] as number
	const state = markState(node, session)
	const rest = withoutStamps(paragraphChange(node))

	return {
		first: {
			revision: (revision & ~MARK_FLAGS) | (stamp === undefined ? 0 : RevisionFlag.Inserted),
			change: stamp === undefined ? rest : { ...rest, inserted: stamp }
		},
		later: {
			revision,
			change: {
				...rest,
				...(state.inserted === undefined ? {} : { inserted: state.inserted }),
				...(state.deleted === undefined ? {} : { deleted: state.deleted })
			}
		}
	}
}

function markState(node: Node, session: DocxEditorSession | undefined): MarkState {
	const flags = (node.attrs["revision"] as number) & MARK_FLAGS
	const change = paragraphChange(node)
	const src = node.attrs["src"] as number
	const read = (flag: number, kind: number, own: RevisionStamp | undefined): RevisionStamp | undefined =>
		(flags & flag) === 0 ? undefined : (own ?? (session === undefined ? undefined : sourceStamp(session, src, kind)))

	return {
		flags,
		inserted: read(RevisionFlag.Inserted, Revision.ParagraphMarkInsertion, change?.inserted),
		deleted: read(RevisionFlag.Deleted, Revision.ParagraphMarkDeletion, change?.deleted)
	}
}

function sameStamp(a: RevisionStamp | undefined, b: RevisionStamp | undefined): boolean {
	return a === undefined
		? b === undefined
		: b !== undefined && a.author === b.author && a.date === b.date && a.id === b.id && a.element === b.element
}

// Whether the paragraph's mark is in `state` as its own: flags and stamps on the node (a revision read from
// the source is only the source paragraph's own where it stands, so a moved one is always written as a stamp).
function sameState(node: Node, state: MarkState): boolean {
	const change = paragraphChange(node)

	return (
		((node.attrs["revision"] as number) & MARK_FLAGS) === state.flags &&
		sameStamp(change?.inserted, state.inserted) &&
		sameStamp(change?.deleted, state.deleted)
	)
}

function setState(tr: Transaction, pos: number, node: Node, state: MarkState, copy = false): void {
	const revision = ((node.attrs["revision"] as number) & ~MARK_FLAGS) | state.flags
	const { inserted: _inserted, deleted: _deleted, ...rest } = paragraphChange(node) ?? {}

	if (revision !== node.attrs["revision"]) tr.setNodeAttribute(pos, "revision", revision)

	setParagraphChange(tr, pos, tr.doc.nodeAt(pos) ?? node, {
		...rest,
		// A copy of a paragraph whose source properties hold a tracked change is no part of that change.
		...(copy ? { source: "accept" as const } : {}),
		...(state.inserted === undefined ? {} : { inserted: state.inserted }),
		...(state.deleted === undefined ? {} : { deleted: state.deleted })
	})
}

const NEW_MARK: MarkState = { flags: 0, inserted: undefined, deleted: undefined }

// Whether a slice holds a paragraph whose mark has a revision.
function carriesMarkState(slice: Slice): boolean {
	let found = false

	slice.content.descendants(node => {
		if (found || node.isInline) return false
		if (node.type === nodes.paragraph && !sameState(node, NEW_MARK)) found = true

		return !found && !node.isTextblock
	})

	return found
}

function markFollows(transactions: readonly Transaction[], state: EditorState): Transaction | null {
	let repair: Transaction | null = null
	const doc = state.doc

	transactions.forEach((tr, index) => {
		if (!tr.docChanged || isInternal(tr) || isHistoryTransaction(tr)) return

		const session = sessions.get(tr)
		const later = transactions.slice(index + 1)
		const map = (pos: number, from: number, assoc: number): number => {
			let mapped = tr.mapping.slice(from).map(pos, assoc)

			for (const other of later) mapped = other.mapping.map(mapped, assoc)

			return mapped
		}

		tr.steps.forEach((step, k) => {
			if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return

			const before = tr.docs[k]

			if (before === undefined) return

			const $to = before.resolve(step.to)
			const $from = before.resolve(step.from)

			// Inside one paragraph and nothing split: no mark comes or goes.
			if (!$to.parent.isTextblock || ($from.parent === $to.parent && step.slice.openStart === 0 && step.slice.openEnd === 0)) return

			const tail = $to.parent

			// No mark state comes or goes (a split of a paragraph whose mark has no revision): nothing to look up.
			if ($from.parent === tail && sameState(tail, NEW_MARK) && !carriesMarkState(step.slice)) return

			const moved = markState(tail, session)
			const end = map($to.end(), k, 1)
			const $end = doc.resolve(Math.max(0, Math.min(doc.content.size, end)))

			if ($end.parent.type !== nodes.paragraph || $end.depth === 0 || $end.pos !== $end.end()) return

			const keeper = $end.before()
			// Marks the step made: the paragraphs ending inside what it inserted.
			const newFrom = map(step.from, k, -1)

			doc.nodesBetween(Math.max(0, newFrom), Math.min(doc.content.size, keeper), (node, pos) => {
				if (node.isInline) return false
				if (node.type !== nodes.paragraph) return true

				const close = pos + node.nodeSize - 1

				if (pos !== keeper && close >= newFrom && close < $end.pos && !sameState(node, NEW_MARK))
					setState((repair ??= state.tr), pos, node, NEW_MARK)

				return false
			})

			const node = doc.nodeAt(keeper)

			if (node !== null && !sameState(node, moved)) setState((repair ??= state.tr), keeper, node, moved)
		})
	})

	return repair
}

// A formatting change recorded here whose text has the formatting before again is no change.
function settleFormats(tr: Transaction, plan: TrackPlan, map: (pos: number, at: number, assoc: number) => number): void {
	if (plan.settle.length === 0) return

	const context = plan.session.context
	const part = plan.session.story.part
	const size = tr.doc.content.size
	// As one step (formatting a whole document settles tens of thousands of runs).
	const changes = new MarkChanges()
	const ranges: [number, number][] = []

	for (const piece of plan.settle) {
		const from = Math.max(0, Math.min(size, map(piece.from, piece.at, 1)))
		const to = Math.max(from, Math.min(size, map(piece.to, piece.at, -1)))

		if (to > from) ranges.push([from, to])
	}

	ranges.sort((a, b) => a[0] - b[0])

	// Merged, then read in one walk.
	const merged: [number, number][] = []

	for (const range of ranges) {
		const last = merged[merged.length - 1]

		if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
		else merged.push([range[0], range[1]])
	}

	const first = merged[0]

	if (first === undefined) return

	let sample: Mark | undefined
	let k = 0

	tr.doc.nodesBetween(first[0], merged[merged.length - 1]?.[1] ?? 0, (node, pos) => {
		const stop = pos + node.nodeSize

		while (k < merged.length && (merged[k]?.[1] ?? 0) <= pos) k++

		if (k >= merged.length || (merged[k]?.[0] ?? 0) >= stop) return false
		if (!node.isInline) return true

		const change = marks.format_change.isInSet(node.marks)
		const base = change?.attrs["base"] as number | null | undefined

		if (change !== undefined && typeof base === "number" && sameAsBase(context, part, node.marks, base)) {
			sample ??= change
			changes.add(pos, stop, null)
		}

		return false
	})

	if (sample !== undefined) changes.step(tr, sample)
}

// Whether content has the formatting `base` names (see formattingBase): the formatting before a change.
function sameAsBase(context: DocxEditContext, part: StoryPart, nodeMarks: readonly Mark[], base: number): boolean {
	const own = propertyMarks(nodeMarks)
	const run = marks.run.isInSet(nodeMarks)
	const runBase = (run?.attrs["base"] as number | undefined) ?? -1

	if (base < 0) return own.length === 0 && (runBase < 0 || marks.plain.isInSet(nodeMarks) !== undefined)
	if (base === runBase && marks.plain.isInSet(nodeMarks) === undefined) {
		const expected = context.bases.get(base)?.marks.filter(mark => mark.type !== marks.format_change) ?? []

		return own.length === expected.length && own.every((mark, k) => mark.eq(expected[k] as Mark))
	}

	// One made from the properties themselves: made again for them now.
	return formattingBase(context, part, nodeMarks) === base
}

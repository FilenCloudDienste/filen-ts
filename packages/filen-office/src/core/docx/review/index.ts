import type { Mark, Node } from "prosemirror-model"
import type { Transaction } from "prosemirror-state"
import { DocAttrStep, ReplaceAroundStep, ReplaceStep } from "prosemirror-transform"
import { changedRanges } from "../edit/invariants/core"
import { docxSchema, survivorsOf, type MarkerList } from "../edit/schema"
import { fieldUpdateOf } from "../fields/evaluate"
import { equationChanges } from "../math/edit"
import { RevisionFlag, type StoryPart } from "../model/index"
import type { CellOverrides, RowOverrides, TableOverrides } from "../edit/tables/map"
import type { ParagraphChange } from "./track"
import type { Slicing } from "../../slicing"

// Where a story's comments and tracked changes are, kept up to date edit by edit: positions are mapped
// through each transaction and only the paragraphs it changed are read again (as spelling does), so no
// feature walks the document per keystroke. Comments, tracked changes and their balloons read this.

export const ReviewKind = {
	// Comment anchors: w:commentRangeStart, w:commentRangeEnd, w:commentReference.
	COMMENT_START: 0,
	COMMENT_END: 1,
	COMMENT_REFERENCE: 2,
	// Text under a revision mark.
	INSERTION: 3,
	DELETION: 4,
	MOVE_FROM: 5,
	MOVE_TO: 6,
	FORMAT: 7,
	// A paragraph mark, row or cell inserted or deleted (RevisionFlag bits on the node).
	PARAGRAPH: 8,
	ROW: 9,
	CELL: 10,
	// Properties changed while tracking: a paragraph's (recorded by the editor, or its source's w:pPrChange),
	// or a source table's, row's, cell's or section's.
	PROPERTIES: 11,
	// A field's result updated while tracking (Word's deletion of the old result and insertion of the new one;
	// fields/result.ts FieldUpdate), one change.
	FIELD_UPDATE: 12
} as const

export type ReviewKind = (typeof ReviewKind)[keyof typeof ReviewKind]

export interface ReviewEntry {
	// [from, to) in the story's document; anchors and block revisions take one position.
	readonly from: number
	readonly to: number
	readonly kind: ReviewKind
	// The comment's w:id; for a tracked change the id naming exactly that change: the source's w:id, the id the
	// editor gave a change it recorded (above every id of the file; kept through edits), or "#" and the source
	// paragraph or row item for the revisions of a source paragraph mark, row or properties.
	readonly id: string
}

const nodes = docxSchema.nodes
const marks = docxSchema.marks
const MARK_KINDS = new Map<unknown, ReviewKind>([
	[marks.insertion, ReviewKind.INSERTION],
	[marks.deletion, ReviewKind.DELETION],
	[marks.move_from, ReviewKind.MOVE_FROM],
	[marks.move_to, ReviewKind.MOVE_TO],
	[marks.format_change, ReviewKind.FORMAT]
])
const PROPERTIES_MARK = marks.paragraph_change
const SECTION_MARK = marks.section_change
const TABLE_MARKS = [marks.row_props, marks.cell_props]
const MARKER_KINDS: Readonly<Record<string, ReviewKind | undefined>> = {
	commentRangeStart: ReviewKind.COMMENT_START,
	commentRangeEnd: ReviewKind.COMMENT_END,
	commentReference: ReviewKind.COMMENT_REFERENCE
}
const BLOCK_KINDS = new Map<unknown, ReviewKind>([
	[nodes.paragraph, ReviewKind.PARAGRAPH],
	[nodes.table_row, ReviewKind.ROW],
	[nodes.table_cell, ReviewKind.CELL]
])

function isComment(kind: number): boolean {
	return kind <= ReviewKind.COMMENT_REFERENCE
}

// The id a revision mark counts under (see ReviewEntry.id).
export function revisionMarkId(mark: Mark): string {
	const id: unknown = mark.attrs["id"]
	const src: unknown = mark.attrs["src"]

	if (typeof id === "string" || typeof id === "number") return String(id)
	if (typeof src === "number" && src >= 0) return `#${String(src)}`

	// Recorded by the editor: one typing burst of one author is one change.
	return `new:${String(mark.attrs["author"] ?? "")}:${String(mark.attrs["date"] ?? "")}`
}

// A change with neither id nor source (a block the editor recorded) counts on its own.
const ANONYMOUS = "#-1"

// Whether `id` names no change of its own (one the editor recorded, or a block without id or source): such
// entries are counted, accepted and rejected one by one, never by id.
export function anonymousChangeId(id: string): boolean {
	return id === ANONYMOUS || id.startsWith("new:")
}

// Entries found in a range, in document order.
class Found {
	readonly from: number[] = []
	readonly to: number[] = []
	readonly kinds: number[] = []
	readonly ids: string[] = []

	add(from: number, to: number, kind: number, id: string): void {
		const last = this.from.length - 1

		// Pieces of one revision next to each other are one range.
		if (last >= 0 && !isComment(kind) && this.kinds[last] === kind && this.ids[last] === id && this.to[last] === from) {
			this.to[last] = to

			return
		}

		this.from.push(from)
		this.to.push(to)
		this.kinds.push(kind)
		this.ids.push(id)
	}
}

// Sessions whose review index is kept (see review/accept.ts reviewIndexWanted): tracking recorded in them, or
// a comment was added.
const WANTED = new WeakSet<object>()

export function wantReviewIndex(session: object): void {
	WANTED.add(session)
}

export function reviewIndexKept(session: object): boolean {
	return WANTED.has(session)
}

// Scans of a story document made beforehand, in slices, with the sources the index attaches (see
// prepareReviewIndex): the index made for that very document takes its entries from here.
interface Scanned {
	readonly found: Found
	readonly sources: ReadonlySet<number>
	readonly links: ReadonlyMap<number, string> | undefined
	readonly part: StoryPart
}

const scanned = new WeakMap<Node, Scanned>()

// Reads `doc` for the index in slices, as attachSources would with these arguments, so a ReviewIndex made
// for it later (while it is still the story's document) costs no scan. False when closed meanwhile.
export async function prepareReviewIndex(
	doc: Node,
	sources: ReadonlySet<number>,
	links: ReadonlyMap<number, string> | undefined,
	part: StoryPart,
	equations: boolean,
	slicing: Slicing,
	closed: () => boolean
): Promise<boolean> {
	const found = new Found()
	const attached = sources.size > 0 || equations
	const steps = attached ? scanSteps(doc, 0, doc.content.size, found, sources, links, part) : scanSteps(doc, 0, doc.content.size, found)
	let started = slicing.now()

	while (steps.next().done !== true) {
		if (slicing.now() - started < slicing.sliceMs) continue

		await slicing.pause()

		if (closed()) return false

		started = slicing.now()
	}

	scanned.set(doc, { found, sources, links, part })

	return true
}

export class ReviewIndex {
	private from = new Int32Array(16)
	private to = new Int32Array(16)
	private kinds = new Uint8Array(16)
	private ids: string[] = []
	// What each entry counts under (a comment's id, a revision's kind and id).
	private keys: string[] = []
	private serial = 0
	private count = 0
	// Entries per comment id and per revision (kind and id): what the counts count.
	private readonly comments = new Map<string, number>()
	private readonly revisions = new Map<string, number>()
	private versionValue = 0
	// Bumped only when a comment's entry was read again (see commentVersion).
	private commentVersionValue = 0
	private doc: Node
	// Source paragraphs whose properties hold a tracked change (see attachSources).
	private sources: ReadonlySet<number> | undefined = undefined
	// Source section changes counted under another id (see attachSources).
	private links: ReadonlyMap<number, string> | undefined = undefined
	// The story's part: the tracked changes inside its source equations (see attachSources).
	private part: StoryPart | undefined = undefined
	private commentList: { readonly version: number; readonly count: number; readonly list: Int32Array } = {
		version: -1,
		count: 0,
		list: new Int32Array(0)
	}

	constructor(doc: Node) {
		const ready = scanned.get(doc)

		this.doc = doc

		if (ready !== undefined) {
			// Read in slices beforehand (prepareReviewIndex), its sources attached.
			scanned.delete(doc)
			this.sources = ready.sources
			this.links = ready.links
			this.part = ready.part
			this.insert(0, ready.found)

			return
		}

		const found = new Found()

		scan(doc, 0, doc.content.size, found)
		this.insert(0, found)
	}

	get sourcesAttached(): boolean {
		return this.sources !== undefined
	}

	// Counts the source paragraphs whose own w:pPrChange (item ids in `sources`) is a change too: the
	// document is read once more. `links`: source section changes (by item) counted as part of another change.
	// `part`: the story's, for the tracked changes inside its equations (`equations`: it has some).
	attachSources(sources: ReadonlySet<number>, links?: ReadonlyMap<number, string>, part?: StoryPart, equations = false): void {
		if (this.sources !== undefined) return

		this.sources = sources
		this.links = links
		this.part = part

		if (sources.size === 0 && !equations) return

		const found = new Found()

		for (let index = 0; index < this.count; index++) this.forget(index)

		this.count = 0
		this.ids.length = 0
		this.keys.length = 0
		scan(this.doc, 0, this.doc.content.size, found, sources, links, part)
		this.insert(0, found)
		this.versionValue++
		this.commentVersionValue++
	}

	// Changes with every transaction that changed an entry.
	get version(): number {
		return this.versionValue
	}

	// Changes with every transaction that changed a comment's entry (not when only tracked changes did, as each
	// keystroke typed while tracking does): what the comments read from the index is the same until then.
	get commentVersion(): number {
		return this.commentVersionValue
	}

	get size(): number {
		return this.count
	}

	// Comments with an anchor or reference in the story.
	get commentCount(): number {
		return this.comments.size
	}

	// Tracked changes in the story (an insertion or deletion as one, whatever its pieces).
	get revisionCount(): number {
		return this.revisions.size
	}

	entry(index: number): ReviewEntry | undefined {
		if (index < 0 || index >= this.count) return undefined

		return {
			from: this.from[index] ?? 0,
			to: this.to[index] ?? 0,
			kind: (this.kinds[index] ?? 0) as ReviewKind,
			id: this.ids[index] ?? ""
		}
	}

	// The tracked change at `pos`: of the entries starting there or covering it, the narrowest (a change inside
	// another's span, as a paragraph's property change inside a deletion across paragraphs), the first of equal
	// ones. Without a scan: entries before it that could still cover it sit in the same paragraph, a few back.
	changeAt(pos: number): ReviewEntry | undefined {
		let found: number | undefined
		let width = Infinity

		for (let index = this.lowerBound(pos + 1) - 1, seen = 0; index >= 0 && seen < 64; index--, seen++) {
			if ((this.kinds[index] ?? 0) <= ReviewKind.COMMENT_REFERENCE) continue

			const from = this.from[index] ?? 0
			const to = Math.max(this.to[index] ?? 0, from + 1)

			if (from <= pos && to >= pos && to - from <= width) {
				found = index
				width = to - from
			}

			if (from < pos && to < pos && found !== undefined) break
		}

		return found === undefined ? undefined : this.entry(found)
	}

	// Entries overlapping [from, to) (an anchor at `from` included), in document order. By binary search: an
	// entry starting before `from` and reaching past it is text of the paragraph holding `from` (block entries
	// take one position, text entries end in their paragraph).
	between(from: number, to: number): ReviewEntry[] {
		const out: ReviewEntry[] = []
		const end = Math.max(to, from + 1)
		const size = this.doc.content.size
		const $from = this.doc.resolve(Math.max(0, Math.min(size, from)))
		const first = $from.parent.inlineContent ? Math.min(from, $from.start()) : from

		for (let index = this.lowerBound(first); index < this.count && (this.from[index] ?? 0) < end; index++) {
			if (Math.max(this.to[index] ?? 0, (this.from[index] ?? 0) + 1) > from) {
				const entry = this.entry(index)

				if (entry !== undefined) out.push(entry)
			}
		}

		return out
	}

	// Allocation-free reads: the first entry starting at or after `pos`, and an entry's fields.
	firstAt(pos: number): number {
		return this.lowerBound(pos)
	}

	fromOf(index: number): number {
		return this.from[index] ?? 0
	}

	toOf(index: number): number {
		return this.to[index] ?? 0
	}

	kindOf(index: number): ReviewKind {
		return (this.kinds[index] ?? 0) as ReviewKind
	}

	idOf(index: number): string {
		return this.ids[index] ?? ""
	}

	// The comment entries (anchors and references), as entry indices in document order; made again (a pass over
	// the kinds) only after entries changed.
	commentEntries(): Int32Array {
		if (this.commentList.version === this.versionValue && this.commentList.count === this.count) return this.commentList.list

		let found = 0

		if (this.comments.size > 0) for (let index = 0; index < this.count; index++) if (isComment(this.kinds[index] ?? 0)) found++

		const list = new Int32Array(found)

		if (found > 0) for (let index = 0, k = 0; index < this.count; index++) if (isComment(this.kinds[index] ?? 0)) list[k++] = index

		this.commentList = { version: this.versionValue, count: this.count, list }

		return list
	}

	// The ranges of the tracked change `id` (all its pieces), in document order.
	changeRanges(id: string): [number, number][] {
		const out: [number, number][] = []

		for (let index = 0; index < this.count; index++) {
			if ((this.kinds[index] ?? 0) <= ReviewKind.COMMENT_REFERENCE || this.ids[index] !== id) continue

			const from = this.from[index] ?? 0

			out.push([from, Math.max(this.to[index] ?? 0, from + 1)])
		}

		return out
	}

	entries(): ReviewEntry[] {
		const out: ReviewEntry[] = []

		for (let index = 0; index < this.count; index++) {
			const entry = this.entry(index)

			if (entry !== undefined) out.push(entry)
		}

		return out
	}

	applyAll(transactions: readonly Transaction[]): void {
		for (const tr of transactions) this.apply(tr)
	}

	apply(tr: Transaction): void {
		this.doc = tr.doc

		if (!tr.docChanged) return

		const doc = tr.doc
		const mapping = tr.mapping
		const regions = changedRegions(doc, tr)
		// Entries wholly before the first change neither move nor are read again: the first one that may, by
		// binary search (entries before a changed paragraph end before it; see changedRegions).
		let first = regions[0] ?? doc.content.size + 1
		// An edit of one range (a keystroke): positions past it move by the same amount, mapped by adding that.
		let ranges = 0
		let past = 0
		let shift = 0

		for (const map of mapping.maps) {
			map.forEach((oldStart, oldEnd, newStart, newEnd) => {
				first = Math.min(first, oldStart)
				ranges++
				past = oldEnd
				shift = newEnd - newStart - (oldEnd - oldStart)
			})
		}

		if (ranges !== 1) past = Infinity

		let kept = this.lowerBound(first)

		while (kept > 0 && Math.max(this.to[kept - 1] ?? 0, (this.from[kept - 1] ?? 0) + 1) > first) kept--

		const start = kept

		// Entries outside the changed paragraphs move with the edit; those inside are read again. Entries and
		// regions are both in document order: one walk.
		let changed = false
		let comments = false
		let region = 0

		for (let index = start; index < this.count; index++) {
			const oldFrom = this.from[index] ?? 0
			const oldTo = this.to[index] ?? 0
			const from = oldFrom > past ? oldFrom + shift : mapping.map(oldFrom, 1)
			const to = Math.max(from, oldTo > past ? oldTo + shift : mapping.map(oldTo, -1))
			const end = Math.max(to, from + 1)
			let inside = false

			while (region < regions.length && (regions[region + 1] ?? 0) <= from) region += 2

			for (let k = region; k < regions.length && (regions[k] ?? 0) < end && !inside; k += 2) inside = from < (regions[k + 1] ?? 0)

			if (inside) {
				if (isComment(this.kinds[index] ?? 0)) comments = true

				this.forget(index)
				changed = true

				continue
			}

			this.from[kept] = from
			this.to[kept] = to
			this.kinds[kept] = this.kinds[index] ?? 0
			this.ids[kept] = this.ids[index] ?? ""
			this.keys[kept] = this.keys[index] ?? ""
			kept++
		}

		this.count = kept
		this.ids.length = kept
		this.keys.length = kept

		for (let k = 0; k < regions.length; k += 2) {
			const start = regions[k] ?? 0
			const end = regions[k + 1] ?? 0
			const found = new Found()

			scan(doc, start, end, found, this.sources, this.links, this.part)

			if (found.from.length === 0) continue

			changed = true
			comments ||= found.kinds.some(isComment)
			this.insert(this.lowerBound(start), found)
		}

		if (changed) this.versionValue++
		if (comments) this.commentVersionValue++
	}

	// ---- internals --------------------------------------------------------------------------------------

	// The first entry starting at or after `pos`.
	private lowerBound(pos: number): number {
		let low = 0
		let high = this.count

		while (low < high) {
			const middle = (low + high) >> 1

			if ((this.from[middle] ?? 0) < pos) low = middle + 1
			else high = middle
		}

		return low
	}

	private forget(index: number): void {
		const map = isComment(this.kinds[index] ?? 0) ? this.comments : this.revisions
		const key = this.keys[index] ?? ""
		const left = (map.get(key) ?? 1) - 1

		if (left <= 0) map.delete(key)
		else map.set(key, left)
	}

	// Inserts `found` at `at` (entries stay ordered by their start).
	private insert(at: number, found: Found): void {
		const added = found.from.length
		const size = this.count + added

		if (size > this.from.length) {
			const capacity = Math.max(size, this.from.length * 2)
			const from = new Int32Array(capacity)
			const to = new Int32Array(capacity)
			const kinds = new Uint8Array(capacity)

			from.set(this.from.subarray(0, this.count))
			to.set(this.to.subarray(0, this.count))
			kinds.set(this.kinds.subarray(0, this.count))
			this.from = from
			this.to = to
			this.kinds = kinds
		}

		this.from.copyWithin(at + added, at, this.count)
		this.to.copyWithin(at + added, at, this.count)
		this.kinds.copyWithin(at + added, at, this.count)
		// Moved up in place, from the end (no list made per insertion; splice(at, 0, ...list) would overflow the
		// call stack as arguments for a long one).
		const ids = this.ids
		const keys = this.keys

		for (let k = 0; k < added; k++) {
			ids.push("")
			keys.push("")
		}

		for (let k = this.count - 1; k >= at; k--) {
			ids[k + added] = ids[k] ?? ""
			keys[k + added] = keys[k] ?? ""
		}

		for (let k = 0; k < added; k++) {
			const kind = found.kinds[k] ?? 0
			const id = found.ids[k] ?? ""
			const map = isComment(kind) ? this.comments : this.revisions
			const key = isComment(kind)
				? id
				: anonymousChangeId(id)
					? `${String(kind)}:anonymous${String(++this.serial)}`
					: `${String(kind)}:${id}`

			ids[at + k] = id
			keys[at + k] = key
			this.from[at + k] = found.from[k] ?? 0
			this.to[at + k] = found.to[k] ?? 0
			this.kinds[at + k] = kind
			map.set(key, (map.get(key) ?? 0) + 1)
		}

		this.count = size
	}
}

// What a transaction changed, widened to what is read again, merged, as [from, to) pairs: the paragraphs
// (textblocks) it touched, every block it made or changed whole, and the story's end (its markers) when a range
// reaches it or the document's attributes changed.
// Past this many ranges (a command over a long selection), the span from the first to the last is read again
// as one: resolving each would cost more than the scan.
const MAX_RANGES = 64

function changedRegions(doc: Node, tr: Transaction): number[] {
	const size = doc.content.size
	let ranges = changedRanges(tr)

	if (ranges.length > MAX_RANGES * 2) {
		let low = Infinity
		let high = -Infinity

		for (let k = 0; k < ranges.length; k += 2) {
			low = Math.min(low, ranges[k] ?? 0)
			high = Math.max(high, ranges[k + 1] ?? 0)
		}

		ranges = [low, high]
	}

	const pieces: [number, number][] = []

	for (let k = 0; k < ranges.length; k += 2) {
		const $from = doc.resolve(Math.max(0, Math.min(size, ranges[k] ?? 0)))
		const $to = doc.resolve(Math.max(0, Math.min(size, ranges[k + 1] ?? 0)))
		const from = $from.parent.isTextblock && $from.depth > 0 ? $from.before() : $from.pos
		let to = $to.parent.isTextblock && $to.depth > 0 ? $to.after() : Math.min(size, $to.pos + 1)

		// Blocks the edit made (a split's half, rows and cells a paste opened, a node whose attributes changed)
		// are read whole: their end markers and revisions lie past the range.
		for (let depth = $to.depth; depth > 0; depth--) if ($to.before(depth) >= $from.pos) to = Math.max(to, $to.after(depth))

		pieces.push([from, Math.max(from + 1, to)])
	}

	// A deletion across block boundaries joins the blocks on each side: the blocks it ends in now close with
	// the end (markers, revision) of those it took out, so they are read whole.
	tr.steps.forEach((step, index) => {
		const before = tr.docs[index]

		if (step instanceof DocAttrStep) pieces.push([size, size + 1])
		if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep) || before === undefined || step.to <= step.from) return

		const shared = before.resolve(step.from).sharedDepth(step.to)
		const pos = tr.mapping.slice(index).map(step.from, -1)
		const $pos = doc.resolve(Math.max(0, Math.min(size, pos)))

		for (let depth = $pos.depth; depth > shared; depth--) pieces.push([pos, $pos.after(depth)])
	})

	pieces.sort((a, b) => a[0] - b[0])

	const out: number[] = []

	for (const [from, piece] of pieces) {
		// The story's end markers sit at its size: a region reaching it takes them in.
		const to = piece >= size ? size + 1 : piece
		const last = out.length - 1

		if (last > 0 && from <= (out[last] ?? 0)) out[last] = Math.max(out[last] ?? 0, to)
		else out.push(from, to)
	}

	return out
}

function markers(list: unknown, pos: number, found: Found): void {
	if (!Array.isArray(list)) return

	for (const marker of list as MarkerList) {
		const kind = MARKER_KINDS[marker.kind]

		if (kind !== undefined && marker.id !== null) found.add(pos, pos + 1, kind, marker.id)
	}
}

function changeId(stamp: { readonly id?: number } | undefined): string | undefined {
	return stamp?.id === undefined ? undefined : String(stamp.id)
}

// Keys of a paragraph change that are no property change (the mark's own revisions, a resolved source change).
const NOT_PROPERTIES: ReadonlySet<string> = new Set(["inserted", "deleted", "source"])

// Whether a paragraph has a property change: one recorded by the editor, or its source's own w:pPrChange
// (`sources`: the source paragraphs holding one) unless accepted or rejected since.
function propertyChange(node: Node, sources: ReadonlySet<number> | undefined): boolean {
	const value: unknown = PROPERTIES_MARK.isInSet(node.marks)?.attrs["value"]

	if (typeof value === "object" && value !== null && Object.keys(value).some(key => !NOT_PROPERTIES.has(key))) return true

	return (
		sources !== undefined &&
		(value as { readonly source?: unknown } | null | undefined)?.source === undefined &&
		sources.has(node.attrs["src"] as number)
	)
}

// Entries in [from, to) of `doc`, in document order (block-level ones only where they sit inside it).
function scan(
	doc: Node,
	from: number,
	to: number,
	found: Found,
	sources?: ReadonlySet<number>,
	links?: ReadonlyMap<number, string>,
	part?: StoryPart
): void {
	const steps = scanSteps(doc, from, to, found, sources, links, part)

	while (steps.next().done !== true);
}

// scan() yielding after each top-level block it reads, and in a table after each row.
function* scanSteps(
	doc: Node,
	from: number,
	to: number,
	found: Found,
	sources?: ReadonlySet<number>,
	links?: ReadonlyMap<number, string>,
	part?: StoryPart
): Generator<void, void> {
	const within = (pos: number): boolean => pos >= from && pos < to
	const visit = (node: Node, pos: number): void => {
		if (node.isInline) {
			if (!within(pos)) return

			markers(survivorsOf(node), pos, found)

			for (const mark of node.marks) {
				const kind = MARK_KINDS.get(mark.type)

				if (kind !== undefined) found.add(pos, pos + node.nodeSize, kind, revisionMarkId(mark))
			}

			const update = node.type === nodes.field ? fieldUpdateOf(node) : null

			if (update !== null) found.add(pos, pos + node.nodeSize, ReviewKind.FIELD_UPDATE, update.id)

			// Tracked changes inside an equation (Word's revisions of its runs and objects), by kind, author and date.
			if (node.type === nodes.math)
				for (const change of equationChanges(node, part))
					found.add(pos, pos + node.nodeSize, change.kind === "ins" ? ReviewKind.INSERTION : ReviewKind.DELETION, change.id)

			return
		}

		open(node, pos)
		children(node, pos + 1)
		close(node, pos)
	}
	// A block's own entries before its content, and after it.
	const open = (node: Node, pos: number): void => {
		if (!within(pos)) return

		markers(node.attrs["before"], pos, found)

		// A block kept as bytes holds its anchors in them.
		if (node.isLeaf) markers(node.attrs["markers"], pos, found)
	}
	const close = (node: Node, pos: number): void => {
		const end = pos + node.nodeSize - 1
		const kind = BLOCK_KINDS.get(node.type)
		const revision: unknown = node.attrs["revision"]

		if (!within(end)) return

		const own = `#${String(node.attrs["src"])}`
		const change = PROPERTIES_MARK.isInSet(node.marks)?.attrs["value"] as ParagraphChange | undefined
		// Rows and cells the table commands tracked carry their stamps in row_props / cell_props, tables in props.
		const tableProps = node.type === nodes.table ? ((node.attrs["props"] as TableOverrides | null) ?? undefined) : undefined
		const cellProps =
			node.type === nodes.table
				? undefined
				: (TABLE_MARKS.find(type => type.isInSet(node.marks) !== undefined)?.isInSet(node.marks)?.attrs["value"] as
						RowOverrides | CellOverrides | undefined)
		const table = tableProps ?? cellProps
		// A cell's w:cellMerge is a property change (below), no insertion or deletion of the cell.
		const flags = typeof revision === "number" ? (node.type === nodes.table_cell ? revision & ~RevisionFlag.Merged : revision) : 0

		if (kind !== undefined && flags !== 0)
			found.add(end, end + 1, kind, changeId(change?.inserted ?? change?.deleted ?? cellProps?.ins ?? cellProps?.del) ?? own)

		const section = node.type === nodes.paragraph ? sectionChange(SECTION_MARK.isInSet(node.marks)?.attrs["value"]) : undefined

		if (
			node.type === nodes.paragraph
				? section !== null && propertyChange(node, sources)
				: node.type !== nodes.locked_block && sources?.has(node.attrs["src"] as number) === true && table?.source === undefined
		)
			found.add(end, end + 1, ReviewKind.PROPERTIES, changeId(change?.props) ?? links?.get(node.attrs["src"] as number) ?? own)

		// A section property change the editor recorded (w:sectPrChange, stories/sections.ts).
		if (section !== undefined && section !== null) found.add(end, end + 1, ReviewKind.PROPERTIES, section)

		// Table, row and cell property changes the editor recorded (a table's grid change can be another).
		const recorded = changeId(table?.change)
		const grid = changeId(tableProps?.gridChange)

		if (recorded !== undefined) found.add(end, end + 1, ReviewKind.PROPERTIES, recorded)
		if (grid !== undefined && grid !== recorded) found.add(end, end + 1, ReviewKind.PROPERTIES, grid)

		markers(node.attrs["end"], end, found)
	}
	const children = (parent: Node, start: number): void => {
		parent.forEach((child, offset) => {
			const at = start + offset

			if (at < to && at + child.nodeSize > from) visit(child, at)
		})
	}

	for (let index = 0, at = 0; index < doc.childCount && at < to; index++) {
		const child = doc.child(index)

		if (at + child.nodeSize > from && child.type === nodes.table) {
			// A row at a time.
			open(child, at)

			for (let row = 0, rowAt = at + 1; row < child.childCount && rowAt < to; row++) {
				const node = child.child(row)

				if (rowAt + node.nodeSize > from) {
					visit(node, rowAt)

					yield
				}

				rowAt += node.nodeSize
			}

			close(child, at)

			yield
		} else if (at + child.nodeSize > from) {
			visit(child, at)

			yield
		}

		at += child.nodeSize
	}

	const size = doc.content.size

	// The body's own section properties: their change counts at the story's end (as its end markers).
	if (to >= size) {
		const final = sectionChange((doc.attrs["sectionChanges"] as { readonly final?: unknown } | null)?.final)
		const sourced = sources?.has(doc.attrs["sectPr"] as number) === true

		if (final !== undefined && final !== null) found.add(size, size + 1, ReviewKind.PROPERTIES, final)
		else if (final === undefined && sourced)
			found.add(size, size + 1, ReviewKind.PROPERTIES, links?.get(doc.attrs["sectPr"] as number) ?? `#${String(doc.attrs["sectPr"])}`)
	}

	if (to >= size) markers(doc.attrs["end"], size, found)
}

// What a section edit (a section_change value, or the doc's final one) says of the section's tracked change: the
// id of a change the editor recorded, null when the source's was accepted or rejected, undefined otherwise.
function sectionChange(value: unknown): string | null | undefined {
	if (typeof value !== "object" || value === null) return undefined

	const change = (value as { readonly change?: { readonly id?: number } | null; readonly rejected?: boolean }).change

	if (change === null) return null
	if (change === undefined) return (value as { readonly rejected?: boolean }).rejected === true ? null : undefined

	return change.id === undefined ? ANONYMOUS : String(change.id)
}

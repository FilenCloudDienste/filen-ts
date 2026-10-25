import { Fragment, Slice, type Mark, type MarkType, type Node, type NodeType, type ResolvedPos } from "prosemirror-model"
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state"
import {
	AddNodeMarkStep,
	AttrStep,
	DocAttrStep,
	MapResult,
	RemoveNodeMarkStep,
	ReplaceAroundStep,
	ReplaceStep,
	StepMap,
	dropPoint,
	type Step
} from "prosemirror-transform"
import { isAddMarkLike, markStepsOf } from "../marks"
import { isHistoryTransaction } from "prosemirror-history"
import { MAX_LEVEL } from "../../numbering/index"
import { SetAttrsStep } from "../attrs"
import { claimOrigin, originOf } from "../origin"
import { newControlId } from "../../forms/controls"
import { writableData, type ElementData } from "../copies"
import {
	BLOCK_NODE_MARKS,
	FORMATTING_MARKS,
	NO_MARKERS,
	NO_SOURCE,
	REVISION_MARKS,
	WRAPPER_MARKS,
	docxSchema,
	endsWithTable,
	inlineLevel,
	markerKey,
	survivorsOf,
	type MarkerAttrs,
	type MarkerList,
	type MarkerNodeAttrs
} from "../schema"

// Transactions the session makes itself (locking blocks, the repairs appended here) skip the invariants
// and the read-only gate. They are recorded by identity in a set private to this module (a meta key is a
// string any host could set), so no host can claim it.
const internal = new WeakSet<Transaction>()
// Transactions a feature's command handler (or the change tracker) made: they may set protected attributes
// and add identity marks (new comments, tracked changes), and every other rule still holds. Recorded the
// same way.
const commands = new WeakSet<Transaction>()

export function markInternal(tr: Transaction): Transaction {
	internal.add(tr)

	return tr
}

export function isInternal(tr: Transaction): boolean {
	return internal.has(tr)
}

export function markCommand(tr: Transaction): Transaction {
	commands.add(tr)

	return tr
}

export function isCommand(tr: Transaction): boolean {
	return commands.has(tr)
}

// Typing the change tracker marked as inserted in its own step: that mark is no copy of another revision.
const typing = new WeakSet<Transaction>()

export function markTyping(tr: Transaction): Transaction {
	typing.add(tr)

	return tr
}

// Steps that only rebuild blocks with tracking marks and records (a large tracked marking without format
// records, review/track.ts): they bring no content, field, control or formatting the blocks had not.
const remarkings = new WeakSet<Step>()

export function markRemarking(step: Step): void {
	remarkings.add(step)
}

// A step that rebuilds blocks putting back the same nodes around what it changes (Replace All): it declares the
// replaces it amounts to (in document order), maps positions as they do (RebuildMap), and every judgment of steps
// here reads them instead of its range.
export interface Replace {
	readonly from: number
	readonly to: number
	readonly slice: Slice
}

const NOWHERE = Object.freeze({ index: -1, shift: 0 })
// StepMap's deletion flags.
const DELETED_BEFORE = 1
const DELETED_AFTER = 2
const DELETED_ACROSS = 4
const DELETED_SIDE = 8

// A MapResult as StepMap makes one (its constructor is ProseMirror's own, not in its types).
function mapResult(pos: number, deleted: number, recover: number | null): MapResult {
	return Reflect.construct(MapResult, [pos, deleted, recover]) as MapResult
}

// A StepMap of many ranges ([start, oldSize, newSize] each, sorted), mapping a position by a binary search over
// them (a StepMap walks every range before it, which a rebuild of thousands of replaces makes quadratic).
// Results equal StepMap's, recovery values included.
class RebuildMap extends StepMap {
	private readonly source: readonly number[]
	private readonly flipped: boolean
	// By range, in the coordinates mapped from: where it starts, its size there and after, and the shift of what
	// comes before it.
	private readonly starts: Float64Array
	private readonly sizes: Float64Array
	private readonly results: Float64Array
	private readonly shifts: Float64Array
	private readonly total: number

	constructor(ranges: readonly number[], inverted = false) {
		super(ranges, inverted)
		this.source = ranges
		this.flipped = inverted

		const count = ranges.length / 3

		this.starts = new Float64Array(count)
		this.sizes = new Float64Array(count)
		this.results = new Float64Array(count)
		this.shifts = new Float64Array(count)

		let shift = 0

		for (let k = 0; k < count; k++) {
			const start = ranges[3 * k] ?? 0
			const oldSize = ranges[3 * k + 1] ?? 0
			const newSize = ranges[3 * k + 2] ?? 0

			this.starts[k] = inverted ? start + shift : start
			this.sizes[k] = inverted ? newSize : oldSize
			this.results[k] = inverted ? oldSize : newSize
			this.shifts[k] = inverted ? -shift : shift
			shift += newSize - oldSize
		}

		this.total = inverted ? -shift : shift
	}

	// The first range holding `pos` (-1: none), and the shift of what is before `pos` otherwise.
	private locate(pos: number): { readonly index: number; readonly shift: number } {
		const starts = this.starts
		let lo = 0
		let hi = starts.length - 1
		let last = -1

		while (lo <= hi) {
			const mid = (lo + hi) >> 1

			if ((starts[mid] ?? 0) <= pos) {
				last = mid
				lo = mid + 1
			} else hi = mid - 1
		}

		if (last < 0) return NOWHERE

		const sizes = this.sizes
		let index = last

		// Ranges touching one another (a deletion, then an insertion where it ends): the first holding it.
		while (index > 0 && (starts[index - 1] ?? 0) + (sizes[index - 1] ?? 0) >= pos) index--

		if ((starts[index] ?? 0) + (sizes[index] ?? 0) >= pos) return { index, shift: 0 }

		return { index: -1, shift: last + 1 < starts.length ? (this.shifts[last + 1] ?? 0) : this.total }
	}

	override map(pos: number, assoc = 1): number {
		const { index, shift } = this.locate(pos)

		if (index < 0) return pos + shift

		const start = this.starts[index] ?? 0
		const size = this.sizes[index] ?? 0
		const side = size === 0 ? assoc : pos === start ? -1 : pos === start + size ? 1 : assoc

		return start + (this.shifts[index] ?? 0) + (side < 0 ? 0 : (this.results[index] ?? 0))
	}

	// StepMap's result for the range holding `pos` (its deletion flags, and a recovery value indexing that range
	// in StepMap's encoding, which recover() and mirrored Mappings read), or for none.
	override mapResult(pos: number, assoc = 1): MapResult {
		const { index, shift } = this.locate(pos)

		if (index < 0) return mapResult(pos + shift, 0, null)

		const start = this.starts[index] ?? 0
		const size = this.sizes[index] ?? 0
		const end = start + size
		const side = size === 0 ? assoc : pos === start ? -1 : pos === end ? 1 : assoc
		const result = start + (this.shifts[index] ?? 0) + (side < 0 ? 0 : (this.results[index] ?? 0))
		const recover = pos === (assoc < 0 ? start : end) ? null : index + (pos - start) * 0x10000
		let deleted = 0

		if (size > 0) {
			deleted |= pos === start ? DELETED_AFTER : pos === end ? DELETED_BEFORE : DELETED_ACROSS

			if (assoc < 0 ? pos !== start : pos !== end) deleted |= DELETED_SIDE
		}

		return mapResult(result, deleted, recover)
	}

	override invert(): StepMap {
		return new RebuildMap(this.source, !this.flipped)
	}
}

export class RebuildStep extends ReplaceStep {
	readonly replaces: readonly Replace[]
	// What it edits beyond its replaces ([from, to] pairs before it): text a tracked replace leaves to be marked
	// deleted, which protection judges as any edit of it.
	readonly touched: readonly number[]

	constructor(from: number, to: number, slice: Slice, replaces: readonly Replace[], touched: readonly number[] = []) {
		super(from, to, slice)
		this.replaces = replaces
		this.touched = touched
	}

	override getMap(): StepMap {
		if (this.replaces.length === 0) return StepMap.empty

		return new RebuildMap(this.replaces.flatMap(replace => [replace.from, replace.to - replace.from, replace.slice.size]))
	}

	// The rebuild back: each replace's content where it put its own (sliced from the container holding it).
	override invert(doc: Node): ReplaceStep {
		let shift = 0
		const walk = new OrderedDoc(doc)
		const replaces = this.replaces.map(replace => {
			const from = replace.from + shift

			shift += replace.slice.size - (replace.to - replace.from)

			return { from, to: from + replace.slice.size, slice: walk.slice(replace.from, replace.to) }
		})

		return new RebuildStep(this.from, this.from + this.slice.size, doc.slice(this.from, this.to), replaces)
	}
}

// The replaces a replace step makes (in the document before it): its own range, or a rebuild's.
export function replacesOf(step: ReplaceStep): readonly Replace[] {
	return step instanceof RebuildStep ? step.replaces : [step]
}

// Where each of a step's replaces ends up in the document after it ([from, to] pairs).
export function replacedAfter(step: ReplaceStep): number[] {
	const out: number[] = []
	let shift = 0

	for (const replace of replacesOf(step)) {
		const from = replace.from + shift

		out.push(from, from + replace.slice.size)
		shift += replace.slice.size - (replace.to - replace.from)
	}

	return out
}

// Lookups in one document at positions met in growing order, each walking on from the last (ProseMirror's own
// walk down from the document's first child each time, which many ranges of a long document make quadratic).
// A position before the last one walks again from the start of the container it is in.
export class OrderedDoc {
	// The containers walked into, outermost first: content start, and the child last looked at (index, offset).
	private readonly path: { node: Node; start: number; index: number; offset: number }[]

	constructor(doc: Node) {
		this.path = [{ node: doc, start: 0, index: 0, offset: 0 }]
	}

	// Walks to the innermost container whose content holds [from, to] (no child of it holding all of it).
	private enclose(from: number, to: number): { node: Node; start: number; index: number; offset: number } {
		const path = this.path

		while (path.length > 1) {
			const top = path[path.length - 1] as (typeof path)[number]

			if (from >= top.start && to <= top.start + top.node.content.size) break

			path.pop()
		}

		for (;;) {
			const top = path[path.length - 1] as (typeof path)[number]
			const node = top.node

			if (from - top.start < top.offset) {
				top.index = 0
				top.offset = 0
			}

			while (top.index < node.childCount && top.offset + node.child(top.index).nodeSize <= from - top.start) {
				top.offset += node.child(top.index).nodeSize
				top.index++
			}

			const child = node.maybeChild(top.index)
			const at = top.start + top.offset

			if (child === null || child.isInline || child.content.size === 0 || from <= at || to >= at + child.nodeSize) return top

			path.push({ node: child, start: at + 1, index: 0, offset: 0 })
		}
	}

	// doc.nodesBetween(from, to, f).
	nodesBetween(from: number, to: number, f: (node: Node, pos: number, parent: Node | null, index: number) => boolean | void): void {
		const top = this.enclose(from, to)
		const path = this.path

		for (let k = 1; k < path.length; k++) {
			const level = path[k] as (typeof path)[number]
			const parent = path[k - 1] as (typeof path)[number]

			if (f(level.node, level.start - 1, parent.node, parent.index) === false) return
		}

		// From the child holding `from` (ProseMirror's walk counts from the first child).
		const node = top.node
		const local = from - top.start
		const localTo = to - top.start

		for (let index = top.index, offset = top.offset; index < node.childCount && offset < localTo; index++) {
			const child = node.child(index)
			const end = offset + child.nodeSize

			if (end > local && f(child, top.start + offset, node, index) !== false && child.content.size > 0)
				child.nodesBetween(
					Math.max(0, local - offset - 1),
					Math.min(child.content.size, localTo - offset - 1),
					f,
					top.start + offset + 1
				)

			offset = end
		}
	}

	// The content between `from` and `to`, sliced from the innermost container holding both (open no deeper).
	slice(from: number, to: number): Slice {
		const top = this.enclose(from, to)

		return top.node.slice(from - top.start, to - top.start)
	}

	// doc.resolve(pos), resolved in the innermost container holding it: depths count from that container, and
	// `ancestors` are the nodes around it (outermost first, the document left out).
	resolve(pos: number): { readonly $pos: ResolvedPos; readonly start: number; readonly ancestors: readonly Node[] } {
		const top = this.enclose(pos, pos)

		return { $pos: top.node.resolve(pos - top.start), start: top.start, ancestors: this.path.slice(1).map(level => level.node) }
	}
}

// [from, to] pairs sorted by `from` (a copy).
function sortedPairs(flat: readonly number[]): number[] {
	const pairs: [number, number][] = []

	for (let k = 0; k < flat.length; k += 2) pairs.push([flat[k] ?? 0, flat[k + 1] ?? 0])

	return pairs.sort((a, b) => a[0] - b[0]).flat()
}

// doc.nodesBetween over each of the [from, to] pairs `flat` lists, walked in order of `from` (one walk of the
// document however many there are); `f` returning false stops the walk below a node, as there.
export function nodesBetweenRanges(
	doc: Node,
	flat: readonly number[],
	f: (node: Node, pos: number, parent: Node | null, index: number) => boolean | void
): void {
	const sorted = sortedPairs(flat)
	const walk = new OrderedDoc(doc)
	const size = doc.content.size

	for (let k = 0; k < sorted.length; k += 2) {
		const from = Math.max(0, Math.min(size, sorted[k] ?? 0))

		walk.nodesBetween(from, Math.max(from, Math.min(size, sorted[k + 1] ?? 0)), f)
	}
}

const walkers = new WeakMap<Node, OrderedDoc>()

// doc.resolve(pos) in the innermost container holding it (see OrderedDoc.resolve), cheap for positions asked in
// growing order.
export function orderedResolve(doc: Node, pos: number): { readonly $pos: ResolvedPos; readonly start: number } {
	return ordered(doc).resolve(pos)
}

// The walker of `doc` (positions asked in growing order are cheap; others still correct).
function ordered(doc: Node): OrderedDoc {
	let walker = walkers.get(doc)

	if (walker === undefined) {
		walker = new OrderedDoc(doc)
		walkers.set(doc, walker)
	}

	return walker
}

// Where `pos` of `tr`'s final document was in the document it started from (a rebuild's replaces moving what is
// between them by their sizes alone).
export function positionBefore(tr: Transaction, pos: number): number {
	let out = pos

	for (let k = tr.steps.length - 1; k >= 0; k--) {
		const step = tr.steps[k]

		if (step instanceof RebuildStep) {
			let shift = 0

			for (const replace of step.replaces) {
				const from = replace.from + shift

				if (from >= out) break

				shift += replace.slice.size - (replace.to - replace.from)
			}

			out -= shift
		} else out = tr.mapping.maps[k]?.invert().map(out, -1) ?? out
	}

	return out
}

// Where `pos` (outside its replaces) of the document before a rebuild is after it.
function rebuiltPos(step: ReplaceStep, pos: number): number {
	let out = pos

	for (const replace of replacesOf(step)) if (replace.to <= pos) out += replace.slice.size - (replace.to - replace.from)

	return out
}

// What a replace step puts in: its slice, or a rebuild's new content alone.
export function insertedSlices(step: ReplaceStep | ReplaceAroundStep): readonly Slice[] {
	return step instanceof ReplaceStep ? replacesOf(step).map(replace => replace.slice) : [step.slice]
}

// Transactions the forms stage made commands for steps of its own appended to a user's edit: steps before the
// index are the user's, judged as any edit is (a copy of a revision in what they insert).
const userSteps = new WeakMap<Transaction, number>()

export function markCommandAfter(tr: Transaction, index: number): Transaction {
	userSteps.set(tr, index)

	return markCommand(tr)
}

export function isRemarking(step: Step): boolean {
	return remarkings.has(step)
}

const nodes = docxSchema.nodes
const revisionTypes: readonly MarkType[] = REVISION_MARKS.map(name => docxSchema.marks[name])
// Marks that tie content to a source element whose identity must not be duplicated.
const identityTypes: readonly MarkType[] = [...revisionTypes, docxSchema.marks.content_control, docxSchema.marks.wrapper]
const wrapperTypes: readonly MarkType[] = WRAPPER_MARKS.map(name => docxSchema.marks[name])
const fieldMarkTypes: readonly MarkType[] = [...FORMATTING_MARKS, "format_change" as const].map(name => docxSchema.marks[name])
const sectionChange = docxSchema.marks.section_change
// Node marks of blocks that feature commands set (like protected attributes).
const blockMarkTypes: readonly MarkType[] = BLOCK_NODE_MARKS.map(name => docxSchema.marks[name])
// Attributes that tie a node to its source or hold structure; only the session's own transactions change them.
const PROTECTED_ATTRS = new Set([
	"src",
	"end",
	"sectPr",
	"deletable",
	"kind",
	"reason",
	"markers",
	"before",
	"node",
	"story",
	"simple",
	"lock",
	"revision",
	// What feature commands set (see markCommand).
	"sectionChanges",
	"props",
	"state",
	"overrides",
	"omml",
	"name",
	"instruction",
	"dirty"
])
const CONTAINERS: ReadonlySet<NodeType> = new Set([nodes.table, nodes.table_row, nodes.table_cell, nodes.sdt])
const SOURCE_BLOCKS = new Set(["paragraph", "table", "table_row", "table_cell", "sdt", "locked_block"])
// Atoms that exist only as source bytes: a copy of one has nothing to be written from. A note reference is one
// too where a copy cannot stay (see KeptMarkers.notes): it would point at the same note.
const BYTES_ONLY = new Set([
	"drawing",
	"run_object",
	"math",
	"opaque_inline",
	"marker",
	"comment_ref",
	"note_ref",
	"locked_block",
	"proof_err",
	"rendered_break"
])

// A byte-only atom the editor made (src -1) that carries what the writer needs to write it new: a comment
// range, bookmark, comment or note reference with its id, a note's number mark, a picture with its media, an
// equation with its OMML. Anything else new of these kinds has nothing to be written from.
export function writableNew(node: Node): boolean {
	const attrs = node.attrs

	switch (node.type) {
		case nodes.marker: {
			const kind = attrs["kind"] as string

			if (attrs["id"] === null) return false
			if (kind === "bookmarkStart") return typeof attrs["name"] === "string"

			return kind === "bookmarkEnd" || kind === "commentRangeStart" || kind === "commentRangeEnd"
		}
		case nodes.comment_ref:
		case nodes.note_ref:
			return attrs["id"] !== null
		case nodes.drawing:
			return typeof (attrs["overrides"] as { media?: unknown } | null)?.media === "number"
		case nodes.math:
			return attrs["omml"] !== null
		// The number mark of a note the editor made (w:footnoteRef / w:endnoteRef).
		case nodes.run_object:
			return attrs["kind"] === "FootnoteMark" || attrs["kind"] === "EndnoteMark"
		default:
			return false
	}
}

// ---- paste ------------------------------------------------------------------------------------------------

// `fits`: whether a run base may stay (content from another part keeps one only when its bytes read the same
// there).
// `control`: what a run-level content control of a copy becomes (undefined: the control goes).
function freshMarks(marks: readonly Mark[], fits?: (base: number) => boolean, control?: (mark: Mark) => Mark | undefined): readonly Mark[] {
	let out = marks
	// A base holding a tracked formatting change carries its revision id: such text keeps only its
	// editable properties.
	const tracked = marks.some(mark => mark.type === docxSchema.marks.format_change)

	for (const mark of marks) {
		const type = mark.type

		const copy = type === docxSchema.marks.content_control ? control?.(mark) : undefined

		if (copy !== undefined) {
			out = copy.addToSet(mark.removeFromSet(out))
		} else if (
			identityTypes.includes(type) ||
			blockMarkTypes.includes(type) ||
			type === docxSchema.marks.format_change ||
			(tracked && type === docxSchema.marks.run)
		) {
			out = mark.removeFromSet(out)
		} else if ((type === docxSchema.marks.link || type === docxSchema.marks.run) && (mark.attrs["src"] as number) !== NO_SOURCE) {
			const base = mark.attrs["base"]
			const kept = type !== docxSchema.marks.run || fits === undefined || typeof base !== "number" || base < 0 || fits(base)

			out = type.create({ ...mark.attrs, src: NO_SOURCE, ...(kept ? {} : { base: -1 }) }).addToSet(mark.removeFromSet(out))
		}
	}

	return out
}

// What a copy keeps of its source that only the source's part holds (`part`: the part the source node was built
// from, when known).
export interface SourceCopies {
	// The `state` of a new copy of legacy form field `node` (its w:ffData), or undefined for other fields.
	readonly field: (node: Node, part: number | undefined) => unknown
	// The overrides standing for the properties of row or cell `node` of part `part` in a copy of another part,
	// and a cell's width in twips (its `colwidth`).
	readonly props: (node: Node, part: number) => Readonly<Record<string, unknown>> | undefined
	readonly width: (node: Node, part: number) => number | undefined
	// The property element of source item `item` of part `part` (a table's w:tblPr, a row's w:trPr, a cell's
	// w:tcPr, a content control's w:sdtPr) as a copy into another part keeps it (its `copy`, a control's
	// `properties`): without what the copy has of its own (tracked changes, its id, span and merge).
	readonly properties: (kind: CopiedElement, item: number, part: number) => ElementData | undefined
}

export type CopiedElement = "table" | "row" | "cell" | "control"

// Markers a repair keeps through freshNode (by key); those held in left-out atoms' bytes go to `orphans`.
interface KeptMarkers {
	readonly keys: ReadonlySet<string>
	readonly orphans: MarkerAttrs[]
	// Kept markers are made new too (content from another part: their source items are not this part's).
	readonly renew?: boolean
	readonly fits?: (base: number) => boolean
	readonly copies?: SourceCopies
	// The part the content was built from, where its nodes do not say (see origin.ts).
	readonly origin?: number
	// Only `copies`: no markers are kept (as a paste keeps none).
	readonly none?: boolean
	// The part the content goes into, when known.
	readonly target?: number
	// Note references stay, as references to the same notes (a story that can hold them, whose editor makes a
	// pasted copy a note of its own: see InvariantOptions.notes).
	readonly notes?: boolean
}

// The part `node` (or mark) was built from: recorded, else the one the copy says.
function sourcePart(node: Node | Mark, keep: KeptMarkers | undefined): number | undefined {
	return originOf(node) ?? keep?.origin
}

// Whether a copy built from part `origin` goes into another part: its source items are not that part's.
function foreignCopy(origin: number | undefined, keep: KeptMarkers | undefined): boolean {
	return keep?.renew === true || (keep?.target !== undefined && origin !== undefined && origin !== keep.target)
}

function freshContent(fragment: Fragment, keep?: KeptMarkers): Fragment {
	const out: Node[] = []

	fragment.forEach(node => {
		const fresh = freshNode(node, keep)

		if (fresh !== null) out.push(fresh)
	})

	return Fragment.fromArray(out)
}

function freshNode(node: Node, keep?: KeptMarkers): Node | null {
	const type = node.type
	const held = keep?.none === true ? undefined : keep

	if (node.isText) return node.mark(freshMarks(node.marks, keep?.fits, controlCopy(keep)))

	if (type === nodes.note_ref && keep?.notes === true && node.attrs["id"] !== null)
		return type.create({ ...node.attrs, src: NO_SOURCE }, null, freshMarks(node.marks, keep.fits))

	if (BYTES_ONLY.has(type.name)) {
		if (held !== undefined) {
			const survivors = survivorsOf(node)

			if ((type === nodes.marker || type === nodes.comment_ref) && survivors.every(marker => held.keys.has(markerKey(marker))))
				return held.renew === true ? type.create({ ...node.attrs, src: NO_SOURCE }, null, freshMarks(node.marks, held.fits)) : node

			for (const marker of survivors) if (held.keys.has(markerKey(marker))) held.orphans.push(marker)
		}

		// A locked paragraph comes back as its text; other byte-only content is left out.
		if (type === nodes.locked_block && node.attrs["kind"] === "paragraph" && node.attrs["text"] !== "") {
			return nodes.paragraph.create(null, docxSchema.text(node.attrs["text"] as string))
		}

		return null
	}

	const attrs: Record<string, unknown> = { ...node.attrs }
	const kept = (list: unknown): MarkerList => {
		if (held === undefined || !Array.isArray(list)) return NO_MARKERS

		const out = (list as MarkerList)
			.filter(marker => held.keys.has(markerKey(marker)))
			.map(marker => (held.renew === true ? { ...marker, src: NO_SOURCE } : marker))

		return out.length === 0 ? NO_MARKERS : out
	}

	if ("src" in attrs) attrs["src"] = NO_SOURCE
	if ("sectPr" in attrs) attrs["sectPr"] = NO_SOURCE
	if ("before" in attrs) attrs["before"] = kept(attrs["before"])
	if ("end" in attrs && type !== nodes.field) attrs["end"] = kept(attrs["end"])
	if (type === nodes.field) {
		// A new field has no bytes to hold markers: they go next to it.
		held?.orphans.push(...kept(attrs["markers"]))
		attrs["end"] = NO_SOURCE
		attrs["markers"] = NO_MARKERS

		// A legacy form field keeps its w:ffData.
		const state = node.attrs["src"] === NO_SOURCE ? undefined : keep?.copies?.field(node, sourcePart(node, keep))

		if (state !== undefined) attrs["state"] = state
	}
	if ("revision" in attrs) attrs["revision"] = 0
	if (type === nodes.sdt) attrs["state"] = copiedControl(node, keep)
	if (type === nodes.table_cell && attrs["colwidth"] === null && foreignCopy(sourcePart(node, keep), keep)) {
		const part = sourcePart(node, keep)
		const width = part === undefined || node.attrs["src"] === NO_SOURCE ? undefined : keep?.copies?.width(node, part)

		if (width !== undefined) attrs["colwidth"] = width
	}
	if (type === nodes.table) attrs["props"] = copiedTableProps(node, keep)

	if (node.isLeaf) return type.create(attrs, null, freshMarks(node.marks, keep?.fits, controlCopy(keep)))

	const content = freshContent(node.content, keep)
	const nodeMarks = modelledOn(node, keep) ?? freshMarks(node.marks, keep?.fits)

	// Containers that lost all their content are left out rather than made invalid.
	if (content.size === 0 && !type.validContent(content)) return type.createAndFill(attrs, null, nodeMarks)

	return type.create(attrs, content, nodeMarks)
}

// The `props` of a copy of a table: no change record of its own (the original keeps it); a copy of a table of
// the same part is modelled on it (its properties: w:tblBorders, w:tblLayout, ...), as rows and cells are; one
// into another part keeps them as data (`copy`).
function copiedTableProps(table: Node, keep: KeptMarkers | undefined): Record<string, unknown> | null {
	const value = (table.attrs["props"] ?? {}) as Record<string, unknown>
	const { change: _change, gridChange: _grid, source: _source, from, ...props } = value
	const own = table.attrs["src"] as number
	const model = typeof from === "number" ? from : own
	const origin = sourcePart(table, keep)
	let next: Record<string, unknown> = props

	if (model !== NO_SOURCE && !foreignCopy(origin, keep)) next = { ...props, from: model }
	else if (model !== NO_SOURCE) {
		const data = origin === undefined ? undefined : keep?.copies?.properties("table", model, origin)

		if (data !== undefined) next = { ...props, copy: data }
	}

	return Object.keys(next).length === 0 ? null : next
}

const controlCopies = new WeakMap<KeptMarkers, (mark: Mark) => Mark | undefined>()

// What the run-level content controls of a copy become: copies of them (one per control, with an identity of
// its own: w:id is left out), of a source control of the part it goes into by its item, of another part's with
// its properties as data; undefined (the control goes, its content stays) into a part not known.
function controlCopy(keep: KeptMarkers | undefined): ((mark: Mark) => Mark | undefined) | undefined {
	if (keep === undefined) return undefined

	let copy = controlCopies.get(keep)

	if (copy === undefined) {
		const made = new Map<string, Mark>()

		copy = mark => {
			const own = mark.attrs["src"] as number
			const state = (mark.attrs["state"] ?? null) as Readonly<Record<string, unknown>> | null
			const key = own === NO_SOURCE ? `m${JSON.stringify(state?.["made"] ?? state?.["id"] ?? null)}` : `s${String(own)}`
			const known = made.get(key)

			if (known !== undefined) return known

			const next = copiedState(own, state, sourcePart(mark, keep), keep)
			const fresh = next === undefined ? undefined : mark.type.create({ ...mark.attrs, src: NO_SOURCE, state: next })

			if (fresh !== undefined) made.set(key, fresh)

			return fresh
		}
		controlCopies.set(keep, copy)
	}

	return copy
}

// The state of a copy of content control `own` (its item, NO_SOURCE for one the editor made or a copy) with
// state `state`, built from part `origin`: a control the editor made carries its definition; a copy of a
// control of the part it goes into names it (`copy`); of another part's, its properties as data; undefined when
// it has none (into a part not known, or of a control whose properties are not known).
function copiedState(
	own: number,
	state: Readonly<Record<string, unknown>> | null,
	origin: number | undefined,
	keep: KeptMarkers | undefined
): Readonly<Record<string, unknown>> | undefined {
	const id = newControlId()

	if (own === NO_SOURCE && state?.["made"] !== undefined) return { ...state, made: { ...(state["made"] as object), id } }
	if (own === NO_SOURCE && state?.["properties"] !== undefined) return { ...state, id }

	const model = own === NO_SOURCE ? state?.["copy"] : own

	if (typeof model !== "number" || keep?.target === undefined) return undefined
	if (!foreignCopy(origin, keep)) return { ...state, copy: model, id }

	const data = origin === undefined ? undefined : keep.copies?.properties("control", model, origin)
	const { copy: _copy, ...rest } = state ?? {}

	return data === undefined ? undefined : { ...rest, properties: data, id }
}

// The state of a copy of block content control `node` (see copiedState); a control without properties (its
// content kept) when it has none.
function copiedControl(node: Node, keep: KeptMarkers | undefined): unknown {
	const own = node.attrs["src"] as number
	const state = (node.attrs["state"] ?? null) as Readonly<Record<string, unknown>> | null

	return copiedState(own, state, sourcePart(node, keep), keep) ?? (own === NO_SOURCE && state?.["copy"] === undefined ? state : null)
}

function propsType(node: Node): MarkType | undefined {
	return node.type === nodes.table_row
		? docxSchema.marks.row_props
		: node.type === nodes.table_cell
			? docxSchema.marks.cell_props
			: undefined
}

// A row's or cell's overrides without the tracked insertion, deletion and change record (the original's).
function untracked(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const { ins: _ins, del: _del, change: _change, ...rest } = value

	return rest
}

// A copy of a source row or cell keeps its properties (w:trPr, w:tcPr: grid offsets, widths, heights, fill) as a
// new row or cell modelled on the source one (its overrides' `from`, which the writer and the table map read),
// with no tracked insertion or deletion of its own: its marks, or undefined for other nodes. A copy into another
// part has no source in that part: it keeps its overrides, the properties its source had as data (`copy`) and
// those of them the editor reads as overrides (SourceCopies.props).
function modelledOn(node: Node, keep: KeptMarkers | undefined): readonly Mark[] | undefined {
	const type = propsType(node)
	const src = node.attrs["src"] as number | undefined

	if (type === undefined || src === undefined) return undefined

	const rest = untracked((type.isInSet(node.marks)?.attrs["value"] ?? {}) as Record<string, unknown>)
	const from = typeof rest["from"] === "number" ? rest["from"] : src
	const origin = sourcePart(node, keep)

	if (foreignCopy(origin, keep)) {
		const part = from === NO_SOURCE ? undefined : origin
		const { from: _from, ...own } = rest
		const data =
			part === undefined ? undefined : keep?.copies?.properties(type === docxSchema.marks.row_props ? "row" : "cell", from, part)
		const read = part === undefined ? undefined : keep?.copies?.props(node, part)
		// The data holds a cell's fill and alignment as they are (a theme fill too).
		const { shading: _shading, vAlign: _vAlign, ...structural } = read ?? {}
		const value = {
			...(data === undefined || type === docxSchema.marks.row_props ? read : structural),
			...own,
			...(data === undefined ? {} : { copy: data })
		}

		return Object.keys(value).length === 0
			? freshMarks(type.removeFromSet(node.marks))
			: type.create({ value }).addToSet(freshMarks(node.marks))
	}

	if (from === NO_SOURCE && Object.keys(rest).length === 0) return freshMarks(node.marks)

	return type.create({ value: from === NO_SOURCE ? rest : { ...rest, from } }).addToSet(freshMarks(node.marks))
}

// Content pasted or dropped into a story carries no source identity: blocks and fields become new
// elements, range markers, comment references and atoms that only exist as source bytes are left out,
// and revision, content-control and wrapper marks are removed. Formatting (run bases, properties) stays.
// `copies` (with `origin`, the part the content was built from, and `target`, the one it goes into) keeps what
// only the source's part holds.
// `notes`: note references stay (see KeptMarkers.notes).
export function freshSlice(slice: Slice, copies?: SourceCopies, origin?: number, target?: number, notes?: boolean): Slice {
	return new Slice(
		freshContent(
			slice.content,
			copies === undefined
				? undefined
				: {
						keys: NO_KEY_SET,
						orphans: [],
						none: true,
						copies,
						...(origin === undefined ? {} : { origin }),
						...(target === undefined ? {} : { target }),
						...(notes === true ? { notes } : {})
					}
		),
		slice.openStart,
		slice.openEnd
	)
}

const NO_KEY_SET: ReadonlySet<string> = new Set()

// freshSlice keeping the range markers and comment references of `keys` (markerKey), made new (a cut moved into
// another part).
export function freshSliceKeeping(
	slice: Slice,
	keys: ReadonlySet<string>,
	copies?: SourceCopies,
	origin?: number,
	target?: number,
	notes?: boolean
): Slice {
	return new Slice(
		freshContent(slice.content, {
			keys,
			orphans: [],
			renew: true,
			...(copies === undefined ? {} : { copies }),
			...(origin === undefined ? {} : { origin }),
			...(target === undefined ? {} : { target }),
			...(notes === true ? { notes } : {})
		}),
		slice.openStart,
		slice.openEnd
	)
}

// ---- helpers ----------------------------------------------------------------------------------------------

// Ranges of the final document that a transaction's steps touched, as [from, to] pairs (a node whose
// attributes changed counts as touched); without `marks`, steps that only set inline marks are left out; with
// `attrs`, a node counts only when one of those attributes changed.
export function changedRanges(tr: Transaction, marks = true, attrs?: ReadonlySet<string>): number[] {
	const out: number[] = []

	// Each step's range, carried through the steps after it that move positions (a step that only sets marks or
	// attributes moves none: a long transaction of them is one pass).
	tr.steps.forEach((step, index) => {
		const map = tr.mapping.maps[index] ?? StepMap.empty

		if (map !== StepMap.empty) {
			for (let k = 0; k < out.length; k += 2) {
				out[k] = map.map(out[k] ?? 0, -1)
				out[k + 1] = map.map(out[k + 1] ?? 0, 1)
			}
		}

		if (step instanceof SetAttrsStep) {
			for (const entry of step.entries) {
				if (attrs === undefined || Object.keys(entry.attrs).some(name => attrs.has(name))) out.push(entry.pos, entry.pos + 1)
			}
		} else if (step instanceof AttrStep) {
			if (attrs === undefined || attrs.has(step.attr)) out.push(step.pos, step.pos + 1)
		} else if (step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) out.push(step.pos, step.pos + 1)
		else if (step instanceof RebuildStep) out.push(...replacedAfter(step))
		else {
			const parts = markStepsOf(step)

			if (parts === undefined) map.forEach((_oldStart, _oldEnd, newStart, newEnd) => out.push(newStart, newEnd))
			else if (marks) for (const part of parts) out.push(part.from, part.to)
		}
	})

	return out
}

// What each replace step inserted, as [from, to] pairs in the final document (both sides of the gap of a
// ReplaceAroundStep).
// What the steps before `steps` inserted, in the transaction's final document.
function insertedRanges(tr: Transaction, steps = tr.steps.length): number[] {
	const maps = tr.mapping.maps
	const out: number[] = []

	tr.steps.forEach((step, index) => {
		if (index >= steps || !(step instanceof ReplaceStep || step instanceof ReplaceAroundStep) || step.slice.size === 0) return

		const push = (newStart: number, newEnd: number): void => {
			if (newEnd <= newStart) return

			let from = newStart
			let to = newEnd

			for (let later = index + 1; later < maps.length; later++) {
				from = maps[later]?.map(from, 1) ?? from
				to = maps[later]?.map(to, -1) ?? to
			}

			if (to > from) out.push(from, to)
		}

		if (step instanceof RebuildStep) {
			const after = replacedAfter(step)

			for (let k = 0; k < after.length; k += 2) push(after[k] ?? 0, after[k + 1] ?? 0)
		} else maps[index]?.forEach((_oldStart, _oldEnd, newStart, newEnd) => push(newStart, newEnd))
	})

	return out
}

const NO_RANGES: readonly number[] = Object.freeze([])

// For each transaction of `transactions` that the repair looks at, before each of its steps: the content an
// earlier step of theirs inserted, as [from, to] pairs in that step's document (a transformer rebuilding what a
// paste put in deletes it again).
function batchInsertions(transactions: readonly Transaction[]): Map<Transaction, (readonly number[])[]> {
	const out = new Map<Transaction, (readonly number[])[]>()
	let made: readonly number[] = NO_RANGES

	for (const tr of transactions) {
		const looked = !skips(tr)
		const steps: (readonly number[])[] = []

		tr.steps.forEach((step, index) => {
			if (looked) steps.push(made)

			const map = tr.mapping.maps[index] ?? StepMap.empty

			if (made.length > 0 && map !== StepMap.empty) {
				const next: number[] = []

				for (let k = 0; k < made.length; k += 2) {
					const from = map.map(made[k] ?? 0, 1)
					const to = map.map(made[k + 1] ?? 0, -1)

					if (to > from) next.push(from, to)
				}

				made = next
			}

			if (looked && (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) && step.slice.size > 0) {
				const next = [...made]

				if (step instanceof RebuildStep) {
					const after = replacedAfter(step)

					for (let k = 0; k < after.length; k += 2)
						if ((after[k + 1] ?? 0) > (after[k] ?? 0)) next.push(after[k] ?? 0, after[k + 1] ?? 0)
				} else {
					map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
						if (newEnd > newStart) next.push(newStart, newEnd)
					})
				}

				made = next
			}
		})

		if (looked) out.set(tr, steps)
	}

	return out
}

// Whether [from, to] lies inside one of `flat`'s ranges ([from, to] pairs), by a binary search over them
// sorted (a walk asking for each node of a range stays linear in the ranges).
export function containment(flat: readonly number[]): (from: number, to: number) => boolean {
	const pairs = sortedPairs(flat)
	const count = pairs.length / 2
	// The furthest end of the ranges up to each one.
	const reach = new Float64Array(count)

	for (let k = 0; k < count; k++) reach[k] = Math.max(k > 0 ? (reach[k - 1] ?? 0) : -Infinity, pairs[2 * k + 1] ?? 0)

	return (from, to) => {
		let lo = 0
		let hi = count - 1
		let last = -1

		while (lo <= hi) {
			const mid = (lo + hi) >> 1

			if ((pairs[2 * mid] ?? 0) <= from) {
				last = mid
				lo = mid + 1
			} else hi = mid - 1
		}

		return last >= 0 && (reach[last] ?? 0) >= to
	}
}

interface DeletedRange {
	readonly step: number
	readonly doc: Node
	readonly from: number
	readonly to: number
}

function deletedRanges(tr: Transaction): DeletedRange[] {
	const out: DeletedRange[] = []

	tr.steps.forEach((step, index) => {
		const doc = tr.docs[index]

		if (doc === undefined) return

		if (step instanceof ReplaceStep) {
			for (const replace of replacesOf(step))
				if (replace.to > replace.from) out.push({ step: index, doc, from: replace.from, to: replace.to })
		} else if (step instanceof ReplaceAroundStep) {
			if (step.gapFrom > step.from) out.push({ step: index, doc, from: step.from, to: step.gapFrom })
			if (step.to > step.gapTo) out.push({ step: index, doc, from: step.gapTo, to: step.to })
		}
	})

	return out
}

function skips(tr: Transaction): boolean {
	return !tr.docChanged || isInternal(tr) || isHistoryTransaction(tr)
}

// A mark no edit may add: revisions, content controls, wrappers, and links or runs that name a source
// element (copies of those would duplicate their identity).
function identityMark(mark: Mark): boolean {
	const type = mark.type

	if (identityTypes.includes(type)) return true

	return (type === docxSchema.marks.link || type === docxSchema.marks.run) && (mark.attrs["src"] as number) !== NO_SOURCE
}

function protectedChange(step: Step, doc: Node): boolean {
	if (step instanceof AttrStep) return PROTECTED_ATTRS.has(step.attr)
	if (step instanceof SetAttrsStep) return step.entries.some(entry => Object.keys(entry.attrs).some(name => PROTECTED_ATTRS.has(name)))
	if (step instanceof DocAttrStep) return true
	if (step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) return blockMarkTypes.includes(step.mark.type)

	// setNodeMarkup: the same node around the same content with other attributes.
	if (step instanceof ReplaceAroundStep && step.insert === 1 && step.gapFrom === step.from + 1 && step.gapTo === step.to - 1) {
		const before = doc.nodeAt(step.from)
		const after = step.slice.content.firstChild

		if (before === null || after === null || step.slice.content.childCount !== 1) return false

		for (const name of PROTECTED_ATTRS) {
			if (name in before.attrs && before.attrs[name] !== after.attrs[name]) return true
		}

		for (const type of blockMarkTypes) {
			const was = type.isInSet(before.marks)
			const is = type.isInSet(after.marks)

			if (was === undefined ? is !== undefined : is === undefined || !was.eq(is)) return true
		}
	}

	return false
}

// Attributes whose change the repair reads: marker lists, the section break, list numbering.
const REPAIRED_ATTRS: ReadonlySet<string> = new Set(["before", "end", "sectPr", "numId", "ilvl"])

// ---- filter -----------------------------------------------------------------------------------------------

// Why a transaction would break the document's structure, or undefined when it is acceptable.
export function invariantViolation(tr: Transaction): string | undefined {
	if (skips(tr)) return undefined

	const command = isCommand(tr)

	for (let index = 0; index < tr.steps.length; index++) {
		const step = tr.steps[index]
		const doc = tr.docs[index]

		if (step === undefined || doc === undefined) continue
		if (command) continue
		if (protectedChange(step, doc)) return "protectedAttribute"
		if (
			step instanceof AddNodeMarkStep
				? identityMark(step.mark)
				: markStepsOf(step)?.some(part => isAddMarkLike(part) && identityMark(part.mark))
		)
			return "identityMark"
	}

	// A copy of another part's properties that cannot be written in this one (a prefix its source does not bind)
	// is refused, not left to fail the save.
	for (const step of tr.steps)
		if (
			(step instanceof ReplaceStep || step instanceof ReplaceAroundStep) &&
			step.slice.size > 0 &&
			insertedSlices(step).some(slice => holdsUnwritableCopy(slice.content))
		)
			return "unwritableCopy"

	for (const range of deletedRanges(tr)) {
		let violation: string | undefined

		ordered(range.doc).nodesBetween(range.from, range.to, (node, pos) => {
			if (violation !== undefined) return false

			const type = node.type
			const close = pos + node.nodeSize - 1
			const opens = pos >= range.from && pos < range.to
			const closes = close >= range.from && close < range.to

			// The paragraph mark holding a section break goes only with its paragraph, moved whole (as in Word:
			// deleting into the paragraph keeps the break, on the paragraph its mark ends).
			if (type === nodes.paragraph) {
				const key = node.attrs["sectPr"] as number

				if (key !== NO_SOURCE && closes && !(opens && breakHolder(tr.doc, key) !== undefined)) violation = "sectionBreak"

				return false
			}

			if (type === nodes.locked_block) {
				if (opens && node.attrs["deletable"] !== true) violation = "lockedBlock"

				return false
			}

			if (type === nodes.sdt && opens && node.attrs["lock"] === "sdtLocked") violation = "lockedContentControl"

			return !node.isInline
		})

		if (violation !== undefined) return violation
	}

	// Nothing may be inserted strictly inside deleted (or moved-away) text: it is read-only.
	for (let index = 0; index < tr.steps.length; index++) {
		const step = tr.steps[index]
		const doc = tr.docs[index]

		if (doc === undefined || !(step instanceof ReplaceStep) || step.slice.size === 0) continue

		for (const replace of replacesOf(step)) {
			if (replace.slice.size === 0) continue

			const before = ordered(doc).resolve(replace.from).$pos.nodeBefore
			const after = ordered(doc).resolve(replace.to).$pos.nodeAfter

			if (before === null || after === null || !before.isInline || !after.isInline) continue

			for (const mark of before.marks) {
				if ((mark.type === docxSchema.marks.deletion || mark.type === docxSchema.marks.move_from) && mark.isInSet(after.marks)) {
					return "deletedText"
				}
			}
		}
	}

	return undefined
}

const writableCopies = new WeakMap<object, boolean>()

function writableCopy(data: unknown): boolean {
	if (typeof data !== "object" || data === null) return true

	let known = writableCopies.get(data)

	if (known === undefined) {
		known = writableData(data as ElementData)
		writableCopies.set(data, known)
	}

	return known
}

// Whether `fragment` holds a copy of another part's properties (copies.ts) that cannot be written.
function holdsUnwritableCopy(fragment: Fragment): boolean {
	let found = false
	const record = (value: unknown, key: string): void => {
		if (!found && typeof value === "object" && value !== null && !writableCopy((value as Record<string, unknown>)[key])) found = true
	}

	fragment.descendants(node => {
		if (found) return false
		if (node.type === nodes.table) record(node.attrs["props"], "copy")
		if (node.type === nodes.sdt) record(node.attrs["state"], "properties")

		for (const mark of node.marks) {
			if (mark.type === docxSchema.marks.content_control) record(mark.attrs["state"], "properties")
			else if (mark.type === docxSchema.marks.row_props || mark.type === docxSchema.marks.cell_props)
				record(mark.attrs["value"], "copy")
		}

		return !found
	})

	return found
}

// ---- repairs ----------------------------------------------------------------------------------------------

export interface ListAttrs {
	readonly numId: number | null
	readonly ilvl: number | null
}

// A hook that numbering features plug into: given a changed paragraph's list attributes, the attributes it
// should have instead (or undefined to keep them).
export type ListNormalizer = (attrs: ListAttrs, paragraph: Node) => ListAttrs | undefined

export function normalizeListAttrs(attrs: ListAttrs): ListAttrs | undefined {
	const ilvl = attrs.ilvl
	let next: ListAttrs | undefined

	if (attrs.numId === null && ilvl !== null) next = { numId: null, ilvl: null }
	// numId 0 takes the paragraph out of any list (ECMA-376 Part 1 §17.9.18): its level means nothing and stays
	// as the file has it.
	else if (ilvl !== null && attrs.numId !== 0 && (ilvl < 0 || ilvl > MAX_LEVEL || !Number.isInteger(ilvl)))
		next = { numId: attrs.numId, ilvl: Math.min(MAX_LEVEL, Math.max(0, Math.trunc(ilvl) || 0)) }

	return next
}

function keysIn(node: Node, keys: Set<string>): void {
	for (const marker of survivorsOf(node)) keys.add(markerKey(marker))

	if (node.isBlock) {
		for (const name of ["before", "end"]) {
			const list: unknown = node.attrs[name]

			if (Array.isArray(list)) for (const marker of list as MarkerList) keys.add(markerKey(marker))
		}
	}
}

function markersOf(node: Node, names: readonly string[], out: Map<string, MarkerAttrs>): void {
	for (const name of names) {
		const list: unknown = node.attrs[name]

		if (Array.isArray(list)) for (const marker of list as MarkerList) out.set(markerKey(marker), marker)
	}
}

function markerNode(marker: MarkerAttrs): Node {
	return marker.kind === "commentReference"
		? nodes.comment_ref.create({ src: marker.src, id: marker.id })
		: nodes.marker.create({
				src: marker.src,
				kind: marker.kind,
				id: marker.id,
				name: (marker as Partial<MarkerNodeAttrs>).name ?? null
			})
}

// Puts lost markers back at `pos`: inline where the position is in a paragraph, otherwise in the
// `before` list of the next block, the end of a container's last paragraph or the story's `end` list.
export function reinsert(tr: Transaction, pos: number, markers: readonly MarkerAttrs[]): void {
	const $pos = tr.doc.resolve(Math.max(0, Math.min(pos, tr.doc.content.size)))

	if ($pos.parent.inlineContent) {
		tr.insert($pos.pos, markers.map(markerNode))

		return
	}

	// A comment reference is run content: the markers go into the nearest paragraph, in their order.
	if (markers.some(marker => marker.kind === "commentReference")) {
		const at = textEnd(tr.doc, $pos.pos) ?? textStart(tr.doc, $pos.pos)

		if (at !== undefined) {
			tr.insert(at, markers.map(markerNode))

			return
		}
	}

	const after = $pos.nodeAfter

	if (after !== null && "before" in after.attrs) {
		tr.setNodeAttribute($pos.pos, "before", [...markers, ...(after.attrs["before"] as MarkerList)])

		return
	}

	const parent = $pos.parent
	const before = $pos.nodeBefore

	// Word wants a cell (or a content control's blocks) to end with a paragraph: the markers go into it.
	if ($pos.depth > 0 && after === null && before?.type === nodes.paragraph) {
		tr.insert($pos.pos - 1, markers.map(markerNode))

		return
	}

	if ($pos.depth === 0) {
		tr.setDocAttribute("end", [...(parent.attrs["end"] as MarkerList), ...markers])
	} else if ("end" in parent.attrs) {
		tr.setNodeAttribute($pos.before(), "end", [...(parent.attrs["end"] as MarkerList), ...markers])
	}
}

// The end of the content of the last paragraph before `pos`, and the start of the first after it (blocks
// kept as bytes are passed over only at their own level).
function textEnd(doc: Node, pos: number): number | undefined {
	let $at = doc.resolve(pos)

	for (;;) {
		let node = $at.nodeBefore
		let at = $at.pos

		while (node !== null && !node.isTextblock && !node.isLeaf) {
			at -= 1
			node = node.lastChild
		}

		if (node?.isTextblock === true) return at - 1
		if ($at.depth === 0) return undefined

		$at = doc.resolve($at.before())
	}
}

function textStart(doc: Node, pos: number): number | undefined {
	let $at = doc.resolve(pos)

	for (;;) {
		let node = $at.nodeAfter
		let at = $at.pos

		while (node !== null && !node.isTextblock && !node.isLeaf) {
			at += 1
			node = node.firstChild
		}

		if (node?.isTextblock === true) return at + 1
		if ($at.depth === 0) return undefined

		$at = doc.resolve($at.after())
	}
}

// Range ends (and comment references, which Word wants after their range's start) and the start each
// follows.
const RANGE_STARTS: ReadonlyMap<string, string> = new Map([
	["bookmarkEnd", "bookmarkStart"],
	["commentRangeEnd", "commentRangeStart"],
	["commentReference", "commentRangeStart"],
	["moveFromRangeEnd", "moveFromRangeStart"],
	["moveToRangeEnd", "moveToRangeStart"],
	["permissionEnd", "permissionStart"]
])

const RANGE_KINDS: ReadonlySet<string> = new Set([...RANGE_STARTS.keys(), ...RANGE_STARTS.values()])

function isRangeMarker(marker: MarkerAttrs): boolean {
	return RANGE_KINDS.has(marker.kind)
}

// Where a range marker sits: an inline marker node, inside an atom's bytes (its `markers`), or in a
// block's (or the story's, pos -1) `before`/`end` list.
interface MarkerPlace {
	readonly marker: MarkerAttrs
	readonly pos: number
	readonly node: Node
	readonly where: "inline" | "atom" | "before" | "end"
}

// Range markers by key, in document order. Loops, not a closure per node: on a long document of tables (a
// column deletion losing markers) this walk is most of the repair.
function rangePlaces(doc: Node): Map<string, MarkerPlace> {
	const places = new Map<string, MarkerPlace>()
	const add = (list: MarkerList, pos: number, node: Node, where: MarkerPlace["where"]): void => {
		for (const marker of list)
			if (isRangeMarker(marker) && marker.id !== null) places.set(markerKey(marker), { marker, pos, node, where })
	}
	const visit = (node: Node, pos: number): void => {
		const block = node.isBlock

		if (block && pos >= 0) {
			const before = node.attrs["before"] as MarkerList | undefined

			if (before !== undefined && before.length > 0) add(before, pos, node, "before")
		}

		if (node.isLeaf) {
			const survivors = survivorsOf(node)

			if (survivors.length > 0) add(survivors, pos, node, node.type === nodes.marker ? "inline" : "atom")
		} else {
			let at = pos < 0 ? 0 : pos + 1

			for (let index = 0, count = node.childCount; index < count; index++) {
				const child = node.child(index)

				if (!child.isText) visit(child, at)

				at += child.nodeSize
			}
		}

		if (block) {
			const end = node.attrs["end"] as MarkerList | undefined

			if (end !== undefined && end.length > 0) add(end, pos, node, "end")
		}
	}

	visit(doc, -1)

	return places
}

// Adds to `carried` the range ends in the `before` list of the block right after a deleted range whose starts
// the range held (`found`, its markers by key).
function carriedEnds(range: DeletedRange, found: ReadonlyMap<string, MarkerAttrs>, carried: Set<string>): void {
	const next = range.to < range.doc.content.size ? ordered(range.doc).resolve(range.to).$pos.nodeAfter : null
	const before = next?.isBlock === true ? (next.attrs["before"] as MarkerList | undefined) : undefined

	if (before === undefined) return

	for (const marker of before) {
		const start = RANGE_STARTS.get(marker.kind)

		if (start !== undefined && marker.id !== null && found.has(`${start}:${marker.id}`)) carried.add(markerKey(marker))
	}
}

// The keys of range ends in the `before` lists of blocks a deleted range takes whole whose starts it does not
// hold (`found`, its markers by key). A comment's range end goes with the block (its reference follows it).
function endsLeftBehind(range: DeletedRange, found: ReadonlyMap<string, MarkerAttrs>): string[] {
	const out: string[] = []

	ordered(range.doc).nodesBetween(range.from, range.to, (node, pos) => {
		if (node.isInline || pos < range.from || pos + node.nodeSize > range.to) return !node.isInline

		for (const marker of (node.attrs["before"] as MarkerList | undefined) ?? NO_MARKERS) {
			const start = RANGE_STARTS.get(marker.kind)

			if (start !== undefined && marker.kind !== "commentRangeEnd" && marker.id !== null && !found.has(`${start}:${marker.id}`))
				out.push(markerKey(marker))
		}

		return !node.isTextblock
	})

	return out
}

function setMarkerList(tr: Transaction, pos: number, name: string, list: MarkerList): void {
	if (pos < 0) tr.setDocAttribute(name, list)
	else tr.setNodeAttribute(pos, name, list)
}

// Moves `marker` out of its place (false when it is held in an atom's bytes).
function takeMarker(tr: Transaction, place: MarkerPlace, at: (pos: number) => number): boolean {
	if (place.where === "atom") return false

	const pos = place.pos < 0 ? -1 : at(place.pos)
	const key = markerKey(place.marker)

	if (place.where === "inline") {
		const node = tr.doc.nodeAt(pos)

		if (node === null || node.type !== nodes.marker || markerKey(survivorsOf(node)[0] as MarkerAttrs) !== key) return false

		tr.delete(pos, pos + 1)

		return true
	}

	const holder = pos < 0 ? tr.doc : tr.doc.nodeAt(pos)
	const list = (holder?.attrs[place.where] as MarkerList | undefined) ?? NO_MARKERS

	setMarkerList(
		tr,
		pos,
		place.where,
		list.filter(marker => markerKey(marker) !== key)
	)

	return true
}

// Puts `marker` right after (or before) `place`.
function placeMarker(
	tr: Transaction,
	marker: MarkerAttrs,
	place: MarkerPlace,
	after: boolean,
	at: (pos: number, assoc: number) => number
): void {
	if (place.where === "before" || place.where === "end") {
		const pos = place.pos < 0 ? -1 : at(place.pos, 1)
		const holder = pos < 0 ? tr.doc : tr.doc.nodeAt(pos)
		const list = [...((holder?.attrs[place.where] as MarkerList | undefined) ?? NO_MARKERS)]
		const index = list.findIndex(other => markerKey(other) === markerKey(place.marker))

		list.splice(index < 0 ? list.length : after ? index + 1 : index, 0, marker)
		setMarkerList(tr, pos, place.where, list)

		return
	}

	const pos = after ? at(place.pos + place.node.nodeSize, -1) : at(place.pos, 1)

	if (place.node.isInline) tr.insert(pos, markerNode(marker))
	else reinsert(tr, pos, [marker])
}

// A range whose end came before its start: when one side moved with inserted content the other follows it
// to that content's edge; otherwise the range closes at its start (Word drops a reversed range). Where the
// end cannot move (a comment reference, a marker in an atom's bytes) the start
// moves to just before it.
function orderRanges(
	tr: Transaction,
	moved: readonly [number, number][],
	carried: ReadonlySet<string> = new Set(),
	behind: ReadonlyMap<string, number> = new Map()
): void {
	const places = rangePlaces(tr.doc)
	const order = new Map<string, number>()
	let index = 0

	for (const key of places.keys()) order.set(key, index++)

	const fixes: [MarkerPlace, MarkerPlace][] = []
	const spanAt = (pos: number): [number, number] | undefined => moved.find(([from, to]) => pos >= from && pos < to)
	// Ends left where the block that held them was (see repairTransaction), their places taken first.
	const back: [MarkerPlace, number][] = []
	const handled = new Set<string>()

	for (const [key, pos] of behind) {
		const end = places.get(key)
		const kind = end === undefined ? undefined : RANGE_STARTS.get(end.marker.kind)
		const start = kind === undefined ? undefined : places.get(`${kind}:${end?.marker.id ?? ""}`)

		if (end === undefined || start === undefined || end.where !== "before" || spanAt(end.pos) === undefined) continue
		if (spanAt(start.pos) !== undefined || pos <= start.pos) continue

		back.push([end, pos])
		handled.add(key)
	}

	// Ends a move carries (see repairTransaction) whose start is in moved content they are not with: to its edge.
	for (const key of carried) {
		const end = places.get(key)
		const kind = end === undefined ? undefined : RANGE_STARTS.get(end.marker.kind)
		const start = kind === undefined ? undefined : places.get(`${kind}:${end?.marker.id ?? ""}`)

		if (end === undefined || start === undefined || (order.get(key) ?? 0) < (order.get(markerKey(start.marker)) ?? 0)) continue

		const span = spanAt(start.pos)

		if (span !== undefined && spanAt(end.pos) === undefined && !(end.where === "before" && end.pos === span[1]))
			fixes.push([start, end])
	}

	for (const [key, end] of places) {
		const kind = RANGE_STARTS.get(end.marker.kind)

		if (kind === undefined) continue

		const startKey = `${kind}:${end.marker.id ?? ""}`
		const start = places.get(startKey)

		if (start !== undefined && !handled.has(key) && (order.get(key) ?? 0) < (order.get(startKey) ?? 0)) fixes.push([start, end])
	}

	if (fixes.length === 0 && back.length === 0) return

	const from = tr.steps.length
	const at = (pos: number, assoc = 1): number => tr.mapping.slice(from).map(pos, assoc)
	const left = new Map<number, MarkerAttrs[]>()

	for (const [end, pos] of back) {
		if (!takeMarker(tr, end, at)) continue

		const list = left.get(pos)

		if (list === undefined) left.set(pos, [end.marker])
		else list.push(end.marker)
	}

	for (const [pos, markers] of [...left].sort((a, b) => b[0] - a[0])) {
		markers.sort((a, b) => (order.get(markerKey(a)) ?? 0) - (order.get(markerKey(b)) ?? 0))
		reinsert(tr, at(pos, -1), markers)
	}

	// Markers following moved content to its edge, by edge, in document order.
	const follow = new Map<number, MarkerAttrs[]>()
	const add = (edge: number, marker: MarkerAttrs): void => {
		const list = follow.get(edge)

		if (list === undefined) follow.set(edge, [marker])
		else list.push(marker)
	}

	for (const [start, end] of fixes) {
		const startSpan = spanAt(start.pos)
		const endSpan = spanAt(end.pos)

		// One side came with inserted content (a moved block): the other follows it to that content's edge,
		// so the range keeps covering what moved instead of closing.
		if (startSpan !== undefined && startSpan !== endSpan && takeMarker(tr, end, at)) {
			add(startSpan[1], end.marker)
		} else if (endSpan !== undefined && endSpan !== startSpan && takeMarker(tr, start, at)) {
			add(endSpan[0], start.marker)
		} else if (takeMarker(tr, end, at)) {
			placeMarker(tr, end.marker, start, true, at)
		} else if (takeMarker(tr, start, at)) {
			placeMarker(tr, start.marker, end, false, at)
		}
	}

	for (const [edge, markers] of [...follow].sort((a, b) => b[0] - a[0])) {
		markers.sort((a, b) => (order.get(markerKey(a)) ?? 0) - (order.get(markerKey(b)) ?? 0))
		reinsert(tr, at(edge, -1), markers)
	}
}

// `for (const [from, to] of spans) doc.nodesBetween(from, to, f)` with `f` deciding descent from the node
// alone: one walk in document order over the spans' union (spans sorted by from), each node once. A long
// transaction of mark steps (formatting a whole long document) has tens of thousands of spans; walking from
// the top for each would cost the document's top-level length each time.
// Whether a position lies in one of `flat`'s ranges ([from, to) pairs), for positions asked in growing order: the
// ranges ending before one are done with, so a walk of many positions over many ranges stays linear.
function inOrder(flat: readonly number[]): (pos: number) => boolean {
	const ranges: [number, number][] = []

	for (let k = 0; k < flat.length; k += 2) ranges.push([flat[k] ?? 0, flat[k + 1] ?? 0])

	ranges.sort((a, b) => a[0] - b[0])

	let at = 0

	return pos => {
		while (at < ranges.length && (ranges[at]?.[1] ?? 0) <= pos) at++

		for (let k = at; k < ranges.length && (ranges[k]?.[0] ?? 0) <= pos; k++) if (pos < (ranges[k]?.[1] ?? 0)) return true

		return false
	}
}

function nodesInSpans(doc: Node, spans: readonly (readonly [number, number])[], f: (node: Node, pos: number) => boolean): void {
	const union: [number, number][] = []

	for (const [from, to] of spans) {
		const last = union.at(-1)

		if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to)
		else union.push([from, to])
	}

	const end = union.at(-1)?.[1]

	if (end === undefined) return

	// Positions only grow along the walk: spans ending at or before one are done with. Children before the
	// next span are passed by their sizes alone (a keystroke's span is after most of a long document).
	let first = 0
	let next = union[0]?.[0] ?? 0
	const walk = (node: Node, start: number): void => {
		const count = node.childCount

		for (let index = 0, pos = start; index < count && pos < end; index++) {
			const child = node.child(index)
			const childEnd = pos + child.nodeSize

			if (childEnd > next) {
				while (first < union.length && (union[first]?.[1] ?? 0) <= pos) first++

				if (first >= union.length) return

				next = union[first]?.[0] ?? 0

				if (next < childEnd && f(child, pos) && child.content.size > 0) walk(child, pos + 1)
			}

			pos = childEnd
		}
	}

	walk(doc, 0)
}

// The textblock (of those walked, in document order) whose content holds `pos`.
function textblockAt(textblocks: readonly { node: Node; pos: number }[], pos: number): { node: Node; pos: number } | undefined {
	let low = 0
	let high = textblocks.length

	while (low < high) {
		const middle = (low + high) >> 1

		if ((textblocks[middle]?.pos ?? 0) < pos) low = middle + 1
		else high = middle
	}

	const found = textblocks[low - 1]

	return found !== undefined && pos < found.pos + found.node.nodeSize ? found : undefined
}

// Keys of the source identities a node carries: its own (a source block or atom) and its markers'.
function identityKeys(node: Node, own: boolean, out: string[]): void {
	if (own) {
		const src: unknown = node.attrs["src"]

		if (node.type === nodes.proof_err) out.push(`p${String(node.attrs["node"])}`)
		else if (typeof src === "number" && src !== NO_SOURCE && node.type !== nodes.marker && node.type !== nodes.comment_ref)
			out.push(`${node.isBlock ? "b" : "i"}${src}`)

		// One reference per note: a copy no editor made a note of its own is left out.
		if (node.type === nodes.note_ref && node.attrs["id"] !== null)
			out.push(`n${String(node.attrs["kind"])}:${String(node.attrs["id"])}`)
	}

	for (const marker of survivorsOf(node)) out.push(`m${markerKey(marker)}`)

	if (node.isBlock) {
		for (const name of ["before", "end"]) {
			const list: unknown = node.attrs[name]

			if (Array.isArray(list)) for (const marker of list as MarkerList) out.push(`m${markerKey(marker)}`)
		}
	}
}

interface DuplicateFix {
	readonly pos: number
	// Markers inside a node made fresh that exist nowhere else: they stay.
	readonly keep?: ReadonlySet<string>
	// Replace the node with a fresh copy (or remove it), make only the node itself new and drop duplicate
	// markers from its lists (a block the insertion opened, whose rest is the document's), or only drop
	// duplicate markers from its lists.
	readonly fresh: boolean
	readonly shallow?: boolean
	readonly drop: ReadonlySet<string>
	// Content of another part: what stays is made new (no source item) and keeps a run base only where it fits.
	readonly renew?: boolean
}

// Content inserted by a transaction that duplicates a source identity present elsewhere (a copy made
// without the paste sanitiser: a drag-copy, a host's own transaction): the copy becomes new content.
function duplicateFixes(
	doc: Node,
	inserted: readonly number[],
	removed: ReadonlyMap<string, number>,
	foreign: (key: string) => boolean = () => false,
	alien: (node: Node) => boolean = () => false
): DuplicateFix[] {
	const inside: { node: Node; pos: number; keys: string[] }[] = []
	const size = doc.content.size
	const pieces: [number, number][] = []

	for (let k = 0; k < inserted.length; k += 2) {
		const from = Math.max(0, Math.min(size, inserted[k] ?? 0))
		const to = Math.max(from, Math.min(size, inserted[k + 1] ?? 0))

		if (to > from) pieces.push([from, to])
	}

	pieces.sort((a, b) => a[0] - b[0])

	// Touching or overlapping insertions are one: a node inside their union is inserted content.
	const spans: [number, number][] = []

	for (const [from, to] of pieces) {
		const last = spans.at(-1)

		if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to)
		else spans.push([from, to])
	}

	const seenPos = new Set<number>()
	const walk = new OrderedDoc(doc)

	// Containers that start in inserted content and end in the document's: their identity came with the
	// insertion (an open slice end), their rest did not.
	const opened: { pos: number; own: string | undefined; markers: string[]; alien: boolean }[] = []

	for (const [from, to] of spans) {
		walk.nodesBetween(from, to, (node, pos) => {
			if (pos >= from && pos < to && pos + node.nodeSize > to && !seenPos.has(pos)) {
				const src: unknown = node.attrs["src"]
				const markers: string[] = []

				seenPos.add(pos)
				identityKeys(node, false, markers)

				// A paragraph may be repeated (its copies write its properties); a table structure may not.
				const own = CONTAINERS.has(node.type) && typeof src === "number" && src !== NO_SOURCE ? `b${src}` : undefined

				if (own !== undefined || markers.length > 0) opened.push({ pos, own, markers, alien: alien(node) })
			}

			if (pos < from || pos + node.nodeSize > to) return !node.isLeaf

			if (seenPos.has(pos)) return false

			seenPos.add(pos)

			const keys: string[] = []

			identityKeys(node, node.isInline || SOURCE_BLOCKS.has(node.type.name), keys)

			if (keys.length > 0) inside.push({ node, pos, keys })

			// What a block holds is judged too: a copy of a source block may hold copies of what is elsewhere (a
			// paste into a block it rebuilt).
			return !node.isLeaf
		})
	}

	if (inside.length === 0 && opened.length === 0) return []

	// Identities outside the inserted content. When the same edit took out every identity it inserts (a
	// rebuilt or moved block), none of them can be outside: only repeats within the insertion remain (`taken`
	// below), and the document is not walked.
	const outside = new Set<string>()
	const openedAt = new Set(opened.map(entry => entry.pos))
	const counts = new Map<string, number>()

	for (const entry of inside) for (const key of entry.keys) counts.set(key, (counts.get(key) ?? 0) + 1)
	for (const entry of opened) {
		for (const key of entry.own === undefined ? entry.markers : [entry.own, ...entry.markers])
			counts.set(key, (counts.get(key) ?? 0) + 1)
	}

	if (![...counts].every(([key, count]) => (removed.get(key) ?? 0) >= count)) {
		let span = 0

		doc.descendants((node, pos) => {
			while (span < spans.length && (spans[span]?.[1] ?? 0) <= pos) span++

			const current = spans[span]

			if (current !== undefined && pos >= current[0] && pos + node.nodeSize <= current[1]) return false

			const keys: string[] = []

			if (!openedAt.has(pos)) identityKeys(node, true, keys)

			for (const key of keys) outside.add(key)

			return !node.isLeaf
		})

		for (const key of doc.attrs["end"] as MarkerList) outside.add(`m${markerKey(key)}`)
	}

	const fixes: DuplicateFix[] = []
	const taken = new Set<string>()
	// The end of the last block made new whole: what it holds goes with it (see `keep`).
	let wholeTo = -1

	for (const { pos, own, markers, alien: renew } of opened) {
		const fresh = own !== undefined && (renew || outside.has(own) || taken.has(own))
		const drop = new Set(markers.filter(key => outside.has(key) || taken.has(key) || foreign(key)).map(key => key.slice(1)))

		if (own !== undefined) taken.add(own)
		for (const key of markers) taken.add(key)

		if (fresh || drop.size > 0 || renew) fixes.push({ pos, fresh, shallow: true, drop, renew })
	}

	for (const { node, pos, keys } of inside) {
		if (pos < wholeTo) continue

		const ownKey = keys[0]
		const ownIsSource = ownKey !== undefined && !ownKey.startsWith("m")
		const markerOnly = node.type === nodes.marker || node.type === nodes.comment_ref
		const duplicate = keys.filter(key => outside.has(key) || taken.has(key) || foreign(key))
		const renew = alien(node)

		for (const key of keys) taken.add(key)

		// Of another part: a marker stays as new content unless it is a copy; a source block or atom is made new.
		if (renew && markerOnly) {
			const copy = duplicate.length > 0 || survivorsOf(node).some(marker => marker.id === null)

			fixes.push(copy ? { pos, fresh: true, drop: new Set() } : { pos, fresh: false, drop: new Set(), renew })

			continue
		}

		if (duplicate.length === 0 && !(renew && ownIsSource)) continue

		if ((ownIsSource && (renew || duplicate.includes(ownKey))) || markerOnly) {
			// A source block is made new whole: what it holds that exists nowhere else stays with it.
			const keep = new Set<string>()

			if (!markerOnly) {
				const visit = (child: Node): void => {
					const held: string[] = []

					identityKeys(child, false, held)

					for (const key of held) {
						if (!outside.has(key) && !taken.has(key) && !foreign(key)) keep.add(key.slice(1))

						taken.add(key)
					}
				}

				for (const key of keys) if (key.startsWith("m") && !duplicate.includes(key)) keep.add(key.slice(1))

				node.descendants(child => (visit(child), true))
				wholeTo = pos + node.nodeSize
			}

			fixes.push({ pos, fresh: true, drop: new Set(), keep, renew })
		} else fixes.push({ pos, fresh: false, drop: new Set(duplicate.map(key => key.slice(1))) })
	}

	return fixes
}

function filterMarkers(list: unknown, drop: ReadonlySet<string>): MarkerList | undefined {
	if (!Array.isArray(list)) return undefined

	const kept = (list as MarkerList).filter(marker => !drop.has(markerKey(marker)))

	return kept.length === list.length ? undefined : kept.length === 0 ? NO_MARKERS : kept
}

function applyDuplicateFix(repair: Transaction, fix: DuplicateFix, options: InvariantOptions): void {
	const pos = repair.mapping.map(fix.pos, 1)
	const node = repair.doc.nodeAt(pos)

	if (node === null) return

	if (!fix.fresh) {
		if (fix.renew === true && "src" in node.attrs) repair.setNodeAttribute(pos, "src", NO_SOURCE)

		for (const name of ["before", "end", "markers"]) {
			const kept = filterMarkers(node.attrs[name], fix.drop)

			if (kept !== undefined) repair.setNodeAttribute(pos, name, kept)
		}

		return
	}

	// Content of another part says where it came from (its origins); a copy within the part is this part's.
	const copied = {
		...(options.copies === undefined ? {} : { copies: options.copies }),
		...(options.part === undefined
			? {}
			: fix.renew === true
				? { target: options.part }
				: { origin: options.part, target: options.part })
	}

	if (fix.shallow === true) {
		if (fix.fresh) {
			repair.setNodeAttribute(pos, "src", NO_SOURCE)

			const renew: KeptMarkers | undefined =
				fix.renew === true ? { keys: NO_KEY_SET, orphans: [], ...copied, renew: true } : undefined

			const kept = renew ?? { keys: NO_KEY_SET, orphans: [], ...copied }

			if (node.type === nodes.sdt) repair.setNodeAttribute(pos, "state", copiedControl(node, kept))
			if (node.type === nodes.table) repair.setNodeAttribute(pos, "props", copiedTableProps(node, kept))

			const model = modelledOn(node, kept)
			const part =
				renew === undefined || node.type !== nodes.table_cell || node.attrs["colwidth"] !== null
					? undefined
					: sourcePart(node, renew)
			const width = part === undefined ? undefined : options.copies?.width(node, part)

			if (width !== undefined) repair.setNodeAttribute(pos, "colwidth", width)

			if (model !== undefined) {
				const type = propsType(node)

				// Overrides of another part's row or cell that leave nothing: no model of this part either.
				if (type !== undefined && type.isInSet(model) === undefined && type.isInSet(node.marks) !== undefined)
					repair.removeNodeMark(pos, type)

				for (const mark of model) if (blockMarkTypes.includes(mark.type)) repair.addNodeMark(pos, mark)
			}
		}

		for (const name of ["before", "end"]) {
			const list = node.attrs[name]
			const kept = filterMarkers(list, fix.drop) ?? (Array.isArray(list) ? (list as MarkerList) : undefined)

			if (kept === undefined) continue

			const renewed =
				fix.renew === true ? kept.map(marker => (marker.src === NO_SOURCE ? marker : { ...marker, src: NO_SOURCE })) : kept

			if (renewed.length !== (list as MarkerList).length || renewed.some((marker, k) => marker !== (list as MarkerList)[k]))
				repair.setNodeAttribute(pos, name, renewed)
		}

		return
	}

	const keep: KeptMarkers = {
		keys: fix.keep ?? new Set(),
		orphans: [],
		...copied,
		...(fix.renew === true ? { renew: true, ...(options.baseFits === undefined ? {} : { fits: options.baseFits }) } : {})
	}
	const fresh = freshNode(node, keep)
	const $pos = repair.doc.resolve(pos)

	if (fresh !== null) {
		repair.replaceWith(pos, pos + node.nodeSize, fresh)
	} else if (node.isInline || $pos.parent.childCount > 1) {
		repair.delete(pos, pos + node.nodeSize)
	} else {
		repair.replaceWith(pos, pos + node.nodeSize, nodes.paragraph.create())
	}

	if (keep.orphans.length > 0) reinsert(repair, pos, keep.orphans)
}

// Characters a text node may not carry into XML: C0 controls (a tab and line ends become a tab or a break,
// the rest go), U+FFFE/U+FFFF (they go) and unpaired surrogates (left by deleting half a pair; U+FFFD).
const Char = { Keep: 0, Pair: 1, Tab: 2, Break: 3, Drop: 4, Replace: 5 } as const

function classify(text: string, index: number): number {
	const code = text.charCodeAt(index)

	if (code >= 0x20 && code < 0xd800) return Char.Keep
	if (code === 0x09) return Char.Tab
	if (code === 0x0a || code === 0x0b || code === 0x0d) return Char.Break
	if (code < 0x20 || code === 0xfffe || code === 0xffff) return Char.Drop

	if (code <= 0xdbff) {
		const next = text.charCodeAt(index + 1)

		return next >= 0xdc00 && next <= 0xdfff ? Char.Pair : Char.Replace
	}

	return code <= 0xdfff ? Char.Replace : Char.Keep
}

function unwritable(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const kind = classify(text, i)

		if (kind === Char.Pair) i++
		else if (kind !== Char.Keep) return true
	}

	return false
}

function applyTextFix(repair: Transaction, at: number, node: Node): void {
	const pos = repair.mapping.map(at, 1)
	const current = repair.doc.nodeAt(pos)

	if (current === null || !current.isText || current.text !== node.text) return

	const text = node.text ?? ""
	const out: Node[] = []
	let piece = ""
	const flush = (): void => {
		if (piece !== "") out.push(docxSchema.text(piece, node.marks))

		piece = ""
	}

	for (let i = 0; i < text.length; i++) {
		const kind = classify(text, i)

		if (kind === Char.Keep) {
			piece += text[i]
		} else if (kind === Char.Pair) {
			piece += text.slice(i, i + 2)
			i++
		} else if (kind === Char.Replace) {
			piece += "\ufffd"
		} else if (kind === Char.Tab || kind === Char.Break) {
			flush()
			out.push((kind === Char.Tab ? nodes.tab : nodes.break).create(null, null, node.marks))
		}
	}

	flush()
	repair.replaceWith(pos, pos + node.nodeSize, out)
}

export interface InvariantOptions {
	readonly readOnly?: () => boolean
	readonly normalizeList?: ListNormalizer
	// Whether the story may hold anchors of comment `id` (a comment lives in one story): pasted anchors of others
	// are left out.
	readonly commentAnchor?: (id: string) => boolean
	// The story's part (model part index): content holding source identities of another part, pasted in, is made
	// new (its item numbers are not this part's). `knowOrigins` records where built content came from (asked
	// before the first such check), `baseFits` whether a run base reads the same in this part.
	readonly part?: number
	readonly knowOrigins?: () => void
	readonly baseFits?: (base: number) => boolean
	// What copies keep that only their source's part holds (legacy form field data, rows' and cells' properties).
	readonly copies?: SourceCopies
	// Whether pasted note references stay (the body, whose editor makes each copy a note of its own; a cut
	// pasted keeps its note): elsewhere they are left out, as Word leaves them out of headers, footers, notes and
	// comments.
	readonly notes?: boolean
}

const COMMENT_ANCHOR_KEY = /^m(?:commentRangeStart|commentRangeEnd|commentReference):(.*)$/s

// An identity key of a comment anchor the story may not hold.
// A transaction moving comments (a cut pasted back, checked by its maker: the comments are anchored nowhere
// else): their ids. Their anchors may go into any story.
export const COMMENT_MOVE_META = "docxCommentMove"

// `moving`: comments whose anchors the transactions took out (a move) or that a paste moves.
function foreignAnchor(options: InvariantOptions, moving: ReadonlySet<string>): ((key: string) => boolean) | undefined {
	const allowed = options.commentAnchor

	if (allowed === undefined) return undefined

	return key => {
		const id = COMMENT_ANCHOR_KEY.exec(key)?.[1]

		return id !== undefined && !moving.has(id) && !allowed(id)
	}
}

function movingComments(transactions: readonly Transaction[], removed: ReadonlyMap<string, number>): Set<string> {
	const out = new Set<string>()

	for (const key of removed.keys()) {
		const id = COMMENT_ANCHOR_KEY.exec(key)?.[1]

		if (id !== undefined) out.add(id)
	}

	for (const tr of transactions) {
		const ids: unknown = tr.getMeta(COMMENT_MOVE_META)

		if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") out.add(id)
	}

	return out
}

// What appendTransaction adds after `transactions`: revision and stray marks off new or re-marked
// content, one holder per section break and marker, list attributes normalised, inserted copies of
// source identities made new, and lost markers put back. Null when nothing needs repair.
export function repairTransaction(
	transactions: readonly Transaction[],
	state: EditorState,
	options: InvariantOptions = {}
): Transaction | null {
	const relevant = transactions.filter(tr => !skips(tr))

	if (relevant.length === 0) return null

	const repair = state.tr
	const size = state.doc.content.size
	// Positions are in each transaction's final document; map them onto `state.doc`.
	const toState = (index: number, pos: number, assoc: number): number => {
		let mapped = pos

		for (let later = transactions.indexOf(relevant[index] as Transaction) + 1; later < transactions.length; later++) {
			mapped = transactions[later]?.mapping.map(mapped, assoc) ?? mapped
		}

		return Math.max(0, Math.min(size, mapped))
	}
	const lost = new Map<number, MarkerAttrs[]>()
	const changed: number[] = []
	// What changed other than marks: only there can an edit have made a node with attributes of its own, whose
	// origin is recorded below (a mark step keeps every node's attributes object).
	const remade: number[] = []
	const inserted: number[] = []
	// Inserted by transactions other than commands: revision marks there are copies (commands add their own).
	const insertedCopies: number[] = []
	// What the transactions' users inserted (a forms command's own steps aside): a revision there is a copy.
	const revisionCopies: number[] = []
	let insertsRevisions = false
	// Whether the transactions inserted content carrying a source run-level content control (a copy, text typed
	// into the control, its content rebuilt), and the controls whose content they took out.
	let insertsControls = false
	const removedControls = new Set<number>()
	// Source revisions in deleted content: inserted again (a move), they are not copies.
	const moved = new Set<number>()
	// Block node marks (paragraph ids...) in content non-command transactions deleted: inserted again by the
	// same edit (a move), they are no copies.
	const movedBlockMarks: Mark[] = []
	// Identities the transactions took out, counted (a rebuilt or moved block carries them back in).
	const removed = new Map<string, number>()

	// Whether some step put range markers back in another order or place than it took them out (a move): only
	// then can a range's markers have passed each other.
	let reorders = false
	// Whether some step inserted a block carrying node marks (typing, a split of a paragraph without them: no
	// block copy to look at).
	let insertsBlocks = false
	// Range ends standing right after content a move took (in the `before` list of the block after it) whose
	// start went with it: they go with it too (a paragraph moved away and back keeps its bookmark).
	const carried = new Set<string>()
	// Range ends a move took along in the `before` list of a block it moved while their start stayed: they stay
	// where the block was (by key, that place in `state.doc`), as a range does not grow or turn around by a move
	// of what follows it.
	const behind = new Map<string, number>()
	// Section breaks (by sectPr key) whose paragraph mark an edit left in another paragraph than the one holding
	// the break (a paste of paragraphs into the paragraph ending a section): where that mark ended up, in
	// `state.doc`. The break goes with the paragraph mark, as in Word.
	const breakOwners = new Map<number, { readonly pos: number; readonly change: Mark | undefined }>()
	// Content pasted from elsewhere holding source identities: where built content came from is asked for now.
	const part = options.part

	if (part !== undefined && options.knowOrigins !== undefined && relevant.some(tr => !isCommand(tr) && insertsSources(tr)))
		options.knowOrigins()

	const fresh = batchInsertions(transactions)

	relevant.forEach((tr, index) => {
		// A node's other attributes break nothing the walk below repairs (a paragraph command over a long
		// selection changes thousands).
		const ranges = changedRanges(tr, true, REPAIRED_ATTRS)
		const insertions = insertedRanges(tr)

		insertsBlocks ||= tr.steps.some(
			step => (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) && insertedSlices(step).some(holdsMarkedBlocks)
		)

		if (!reorders && insertions.length > 0) reorders = movesRangeMarkers(tr)

		for (let k = 0; k < ranges.length; k += 2) changed.push(toState(index, ranges[k] ?? 0, -1), toState(index, ranges[k + 1] ?? 0, 1))

		const others = changedRanges(tr, false, REPAIRED_ATTRS)

		for (let k = 0; k < others.length; k += 2) remade.push(toState(index, others[k] ?? 0, -1), toState(index, others[k + 1] ?? 0, 1))
		const command = isCommand(tr)
		const typed = typing.has(tr)
		// A user's edit the forms stage made a command of: what the user's own steps insert is judged still.
		const users = command ? (userSteps.get(tr) ?? 0) : tr.steps.length
		const copies = typed ? [] : users === tr.steps.length ? insertions : insertedRanges(tr, users)

		if (!command) breakMoves(tr, (key, pos, change) => breakOwners.set(key, { pos: toState(index, pos, 1), change }))

		for (let k = 0; k < insertions.length; k += 2) {
			const from = toState(index, insertions[k] ?? 0, 1)
			const to = toState(index, insertions[k + 1] ?? 0, -1)

			inserted.push(from, to)

			if (!command && !typed) insertedCopies.push(from, to)
		}

		// New content never carries a copy of a source revision, whatever else the transaction holds.
		for (let k = 0; k < copies.length; k += 2)
			revisionCopies.push(toState(index, copies[k] ?? 0, 1), toState(index, copies[k + 1] ?? 0, -1))

		insertsRevisions ||=
			!typed &&
			tr.steps.some(
				(step, at) =>
					at < users &&
					(step instanceof ReplaceStep || step instanceof ReplaceAroundStep) &&
					step.slice.size > 0 &&
					insertedSlices(step).some(slice => carries(slice.content, mark => revisionTypes.includes(mark.type)))
			)

		insertsControls ||= tr.steps.some(
			step =>
				(step instanceof ReplaceStep || step instanceof ReplaceAroundStep) &&
				step.slice.size > 0 &&
				insertedSlices(step).some(slice =>
					carries(slice.content, mark => mark.type === docxSchema.marks.content_control && mark.attrs["src"] !== NO_SOURCE)
				)
		)

		// Markers a deletion took out, by key, with where the deletion ended up.
		const candidates = new Map<string, { marker: MarkerAttrs; pos: number }>()

		// What earlier steps inserted, by step (asked for each node a deletion takes).
		const madeBy = new Map<number, ((from: number, to: number) => boolean) | undefined>()

		for (const range of deletedRanges(tr)) {
			const found = new Map<string, MarkerAttrs>()

			if (!madeBy.has(range.step)) {
				const made = fresh.get(tr)?.[range.step] ?? NO_RANGES

				madeBy.set(range.step, made.length > 0 ? containment(made) : undefined)
			}

			const madeHolds = madeBy.get(range.step)

			ordered(range.doc).nodesBetween(range.from, range.to, (node, pos) => {
				const end = pos + node.nodeSize
				const opens = pos >= range.from && pos < range.to

				// Content an earlier step of these transactions inserted takes out nothing the document had.
				if (madeHolds?.(pos, end) === true) return false

				if (insertions.length > 0 && opens && end <= range.to) {
					const keys: string[] = []

					identityKeys(node, node.isInline || SOURCE_BLOCKS.has(node.type.name), keys)
					for (const key of keys) removed.set(key, (removed.get(key) ?? 0) + 1)
				}

				if (node.isInline) {
					for (const mark of node.marks) {
						if (revisionTypes.includes(mark.type)) moved.add(mark.attrs["src"] as number)
						else if (mark.type === docxSchema.marks.content_control) removedControls.add(mark.attrs["src"] as number)
					}
				}

				if (!command && node.isBlock && opens)
					for (const mark of node.marks) if (blockMarkTypes.includes(mark.type)) movedBlockMarks.push(mark)

				if (node.isLeaf) {
					if (pos >= range.from && end <= range.to) for (const marker of survivorsOf(node)) found.set(markerKey(marker), marker)
				} else if (node.isBlock && opens) {
					// A block whose start token goes loses its attributes (a join keeps the first node's).
					markersOf(node, ["before", "end"], found)
				} else if (node.isBlock && end - 1 >= range.from && end - 1 < range.to) {
					markersOf(node, ["end"], found)
				}

				return true
			})

			let pos = range.from

			for (let later = range.step; later < tr.steps.length; later++) pos = tr.mapping.maps[later]?.map(pos, -1) ?? pos

			if (insertions.length > 0) {
				carriedEnds(range, found, carried)

				for (const key of endsLeftBehind(range, found)) behind.set(key, toState(index, pos, -1))
			}

			if (found.size === 0) continue

			for (const [key, marker] of found) candidates.set(key, { marker, pos })
		}

		// A comment whose range and reference the deletion took whole goes with them, as in Word (the save leaves
		// the comment out); one that keeps any of them keeps all.
		for (const [key, { marker }] of candidates) {
			if (marker.kind !== "commentReference" || marker.id === null) continue

			const start = `commentRangeStart:${marker.id}`
			const end = `commentRangeEnd:${marker.id}`

			if (candidates.has(start) && candidates.has(end)) {
				candidates.delete(key)
				candidates.delete(start)
				candidates.delete(end)
			}
		}

		if (candidates.size === 0) return

		const present = new Set<string>()
		const finalSize = tr.doc.content.size

		const walk = new OrderedDoc(tr.doc)
		const sorted = sortedPairs(ranges)

		for (let k = 0; k < sorted.length; k += 2) {
			const from = Math.max(0, Math.min(finalSize, (sorted[k] ?? 0) - 1))
			const to = Math.max(from, Math.min(finalSize, (sorted[k + 1] ?? 0) + 1))

			walk.nodesBetween(from, to, node => {
				keysIn(node, present)

				return true
			})
		}

		for (const marker of tr.doc.attrs["end"] as MarkerList) present.add(markerKey(marker))

		for (const [key, { marker, pos }] of candidates) {
			if (present.has(key)) continue

			const at = toState(index, pos, -1)
			const list = lost.get(at)

			if (list === undefined) lost.set(at, [marker])
			else list.push(marker)
		}
	})

	// 1. Marks. New content never carries a copy of a source revision: text typed inside someone's tracked
	// insertion is plain text (the insertion splits). Content moved whole keeps its revisions: their
	// originals are gone. Atoms at paragraph level carry wrapper marks only (a marker written inside a w:r
	// also its run).
	if (insertsRevisions) {
		for (const { from, to, mark } of copiedRevisions(state.doc, revisionCopies, moved)) repair.removeMark(from, to, mark)
	}

	// A copy of part of a source content control (one not next to the rest of it) is a copy of the control, with
	// an identity of its own.
	if (insertsControls) {
		for (const { from, to, mark, copy } of copiedControls(state.doc, inserted, part, removedControls)) {
			repair.removeMark(from, to, mark)
			repair.addMark(from, to, copy)
		}
	}

	const spans: [number, number][] = []

	for (let k = 0; k < changed.length; k += 2) {
		const from = Math.max(0, Math.min(size, changed[k] ?? 0))

		spans.push([from, Math.max(from, Math.min(size, changed[k + 1] ?? 0))])
	}

	spans.sort((a, b) => a[0] - b[0])

	// The walk below goes in document order.
	const isRemade = inOrder(remade)

	const holders = new Map<number, number[]>()
	const listFixes: { pos: number; attrs: ListAttrs }[] = []
	const markerFixes: { pos: number; name: string; list: MarkerList }[] = []
	const strayMarks: { pos: number; mark: Mark }[] = []
	const textFixes: { pos: number; node: Node }[] = []
	const orphans: { pos: number; node: Node }[] = []
	const cellEnds: number[] = []
	const emptyLinks: { from: number; to: number; mark: Mark }[] = []
	const listed = new Set<string>()
	// Asked in the document order of the walk below.
	const copied = inOrder(insertedCopies)
	const startsInserted = inOrder(inserted)
	const seen = new Set<number>()
	// Blocks carrying a section change: it belongs to the paragraph holding its break.
	const sectioned: { pos: number; node: Node }[] = []
	// Textblocks the walk visits, in document order: the text next to the spans' ends is in them.
	const textblocks: { node: Node; pos: number }[] = []

	nodesInSpans(state.doc, spans, (node, pos) => {
		if (seen.has(pos)) return !node.isLeaf && node.type !== nodes.locked_block

		seen.add(pos)

		// What an edit made here is this part's (a later paste into another part tells it by this); pasted
		// content is judged below.
		if (part !== undefined && !copied(pos) && isRemade(pos)) claimOrigin(node, part)

		if (node.isTextblock) textblocks.push({ node, pos })

		if (node.isInline) {
			if (node.isText && unwritable(node.text ?? "")) textFixes.push({ pos, node })

			// A new link goes somewhere: one with neither a target nor an anchor is no link.
			for (const mark of node.marks) {
				if (
					mark.type === docxSchema.marks.link &&
					mark.attrs["src"] === NO_SOURCE &&
					!mark.attrs["target"] &&
					!mark.attrs["anchor"]
				) {
					emptyLinks.push({ from: pos, to: pos + node.nodeSize, mark })
				}
			}

			// Content that exists only as source bytes cannot be new: nothing could write it.
			if (BYTES_ONLY.has(node.type.name) && node.attrs["src"] === NO_SOURCE && node.type !== nodes.proof_err && !writableNew(node))
				orphans.push({ pos, node })

			if (inlineLevel(node) === "paragraph") {
				for (const mark of node.marks) {
					if (wrapperTypes.includes(mark.type)) continue
					if (mark.type === docxSchema.marks.run && node.type === nodes.marker) continue
					// A field takes formatting as its runs do (the field writer gives them what changed).
					if (node.type === nodes.field && fieldMarkTypes.includes(mark.type)) continue

					strayMarks.push({ pos, mark })
				}
			}

			return false
		}

		// Word wants every cell to end with a paragraph.
		if (node.type === nodes.table_cell && endsWithTable(node)) cellEnds.push(pos + node.nodeSize - 1)

		// An edit that copies a block's marker lists into two blocks (a split): the first keeps them. Blocks
		// that start in inserted content are left to the duplicate repair below.
		for (const name of startsInserted(pos) ? [] : ["before", "end"]) {
			const list: unknown = node.attrs[name]

			if (!Array.isArray(list) || list.length === 0) continue

			const kept = (list as MarkerList).filter(marker => {
				const key = markerKey(marker)

				if (listed.has(key)) return false

				listed.add(key)

				return true
			})

			if (kept.length !== list.length) markerFixes.push({ pos, name, list: kept.length === 0 ? NO_MARKERS : kept })
		}

		const sectPr = node.attrs["sectPr"]

		if ((node.type === nodes.paragraph || node.type === nodes.locked_block) && typeof sectPr === "number" && sectPr !== NO_SOURCE) {
			const list = holders.get(sectPr)

			if (list === undefined) holders.set(sectPr, [pos])
			else list.push(pos)
		}

		if ((node.type === nodes.paragraph || node.type === nodes.locked_block) && sectionChange.isInSet(node.marks) !== undefined)
			sectioned.push({ pos, node })

		if (node.type === nodes.paragraph) {
			const attrs: ListAttrs = { numId: node.attrs["numId"] as number | null, ilvl: node.attrs["ilvl"] as number | null }
			const fixed = normalizeListAttrs(attrs)
			const hooked = options.normalizeList?.(fixed ?? attrs, node) ?? fixed

			if (hooked !== undefined && (hooked.numId !== attrs.numId || hooked.ilvl !== attrs.ilvl)) listFixes.push({ pos, attrs: hooked })
		}

		return node.type !== nodes.locked_block
	})

	// Text next to a change: a deletion can leave half a surrogate pair at the edge of a text node. Text is in
	// textblocks, and one holding a span's end was walked: resolved there, not from the top of the document.
	for (const [from, to] of spans) {
		for (const at of [from, to]) {
			const holder = textblockAt(textblocks, at)

			if (holder === undefined) continue

			const $at = holder.node.resolve(at - holder.pos - 1)
			const before = $at.nodeBefore
			const after = $at.nodeAfter

			if (before?.isText === true && !seen.has(at - before.nodeSize) && unwritable(before.text ?? "")) {
				seen.add(at - before.nodeSize)
				textFixes.push({ pos: at - before.nodeSize, node: before })
			}

			if (after?.isText === true && !seen.has(at) && unwritable(after.text ?? "")) {
				seen.add(at)
				textFixes.push({ pos: at, node: after })
			}
		}
	}

	for (const stray of strayMarks) repair.removeNodeMark(stray.pos, stray.mark)
	for (const link of emptyLinks) repair.removeMark(link.from, link.to, link.mark)

	// Blocks a non-command edit inserted (a pasted copy, the half a split made) carry no block node mark of
	// the block they came from (a paragraph id, a tracked property change): those belong to the original,
	// once. A section change goes with the paragraph mark, as the section break does: a split's later half
	// keeps it.
	const copyFixes = new Set<string>()

	for (const fix of insertsBlocks ? blockCopies(state.doc, insertedCopies, movedBlockMarks) : []) {
		const key = `${String(fix.pos)}:${fix.mark.type.name}`

		if (!copyFixes.has(key)) {
			repair.removeNodeMark(fix.pos, fix.mark)

			if (fix.replacement !== undefined) repair.addNodeMark(fix.pos, fix.replacement)
		}

		copyFixes.add(key)
	}

	// 2. Attributes (no position moves).
	for (const fix of markerFixes) repair.setNodeAttribute(fix.pos, fix.name, fix.list)

	// A split paragraph's halves both carry the break; it belongs to the last (the paragraph mark), or to where
	// the edit left the paragraph mark.
	const breakHolders = new Map<number, number>()
	const breakOf = new Map<number, number>()

	for (const [key, positions] of holders) {
		positions.sort((a, b) => a - b)

		let holder = positions.at(-1) ?? 0
		const owner = breakOwners.get(key)?.pos
		const $owner = owner === undefined ? undefined : state.doc.resolve(owner)

		if ($owner !== undefined && $owner.depth > 0 && $owner.parent.type === nodes.paragraph) {
			const at = $owner.before()
			const own = $owner.parent.attrs["sectPr"] as number

			if (own === NO_SOURCE) {
				repair.setNodeAttribute(at, "sectPr", key)
				breakOf.set(at, key)
				holder = at
			} else if (own === key) {
				holder = at
			}
		}

		breakHolders.set(key, holder)

		for (const pos of positions) {
			if (pos === holder) continue

			repair.setNodeAttribute(pos, "sectPr", NO_SOURCE)
			breakOf.set(pos, NO_SOURCE)
		}
	}

	// A paragraph joined to the one ending a section (whose start the edit deleted) holds its paragraph mark now:
	// the break and its section change go to it.
	for (const [key, { pos, change }] of breakOwners) {
		if (holders.has(key)) continue

		const $owner = state.doc.resolve(Math.max(0, Math.min(size, pos)))

		if ($owner.depth === 0 || $owner.parent.type !== nodes.paragraph || $owner.parent.attrs["sectPr"] !== NO_SOURCE) continue

		const at = $owner.before()

		repair.setNodeAttribute(at, "sectPr", key)
		breakOf.set(at, key)
		breakHolders.set(key, at)

		if (change !== undefined && sectionChange.isInSet($owner.parent.marks) === undefined) repair.addNodeMark(at, change)
	}

	// A section change goes with its break (the writer has nothing to write it on elsewhere).
	for (const { pos, node } of sectioned) {
		const mark = sectionChange.isInSet(node.marks)

		if (mark === undefined) continue

		const key = (mark.attrs["value"] as { section?: unknown } | null)?.section

		if (key === (breakOf.get(pos) ?? node.attrs["sectPr"])) continue

		const holder = typeof key !== "number" || key === NO_SOURCE ? undefined : (breakHolders.get(key) ?? breakHolder(state.doc, key))
		const held = holder === undefined ? null : state.doc.nodeAt(holder)

		// No paragraph holds its break: it goes with the paragraph mark (a split's later half keeps it).
		if (holder === undefined || held === null) {
			if (mark.isInSet(state.doc.nodeAt(pos + node.nodeSize)?.marks ?? [])) repair.removeNodeMark(pos, mark)

			continue
		}

		repair.removeNodeMark(pos, mark)

		const current = sectionChange.isInSet(held.marks)

		if (current !== undefined && (current.attrs["value"] as { section?: unknown } | null)?.section === key) continue

		repair.addNodeMark(holder, mark)
	}

	for (const fix of listFixes) {
		repair.setNodeAttribute(fix.pos, "numId", fix.attrs.numId)
		repair.setNodeAttribute(fix.pos, "ilvl", fix.attrs.ilvl)
	}

	// 3. Inserted copies of source identities become new content, and text XML cannot carry is made
	// writable, from the end.
	// Of another part than this story's (see InvariantOptions.part).
	const alien = (value: Node | Mark): boolean => {
		const origin = part === undefined ? undefined : originOf(value)

		return origin !== undefined && origin !== part
	}
	// Another part's run-level controls become copies of them (one per control in this repair).
	const alienControls = controlCopy({
		keys: NO_KEY_SET,
		orphans: [],
		renew: true,
		...(options.copies === undefined ? {} : { copies: options.copies }),
		...(part === undefined ? {} : { target: part })
	})
	const structural: { pos: number; apply: () => void }[] = [
		...duplicateFixes(state.doc, inserted, removed, foreignAnchor(options, movingComments(relevant, removed)), alien).map(fix => ({
			pos: fix.pos,
			apply: () => applyDuplicateFix(repair, fix, options)
		})),
		...alienRuns(state.doc, insertedCopies, alien).map(at => ({
			pos: at,
			apply: () => {
				const pos = repair.mapping.map(at, 1)
				const node = repair.doc.nodeAt(pos)

				if (node === null || !node.isInline) return

				const fresh = freshMarks(node.marks, options.baseFits, alienControls)

				for (const mark of node.marks) if (!mark.isInSet(fresh)) repair.removeMark(pos, pos + node.nodeSize, mark)
				for (const mark of fresh) if (!mark.isInSet(node.marks)) repair.addMark(pos, pos + node.nodeSize, mark)
			}
		})),
		...textFixes.map(fix => ({ pos: fix.pos, apply: () => applyTextFix(repair, fix.pos, fix.node) })),
		...cellEnds.map(at => ({ pos: at, apply: () => void repair.insert(repair.mapping.map(at, -1), nodes.paragraph.create()) })),
		...orphans.map(fix => ({
			pos: fix.pos,
			apply: () => {
				const pos = repair.mapping.map(fix.pos, 1)

				if (repair.doc.nodeAt(pos) === fix.node) repair.delete(pos, pos + fix.node.nodeSize)
			}
		}))
	]

	for (const fix of structural.sort((a, b) => b.pos - a.pos)) fix.apply()

	// 4. Lost markers last, from the end so earlier positions stay valid.
	for (const at of [...lost.keys()].sort((a, b) => b - a)) reinsert(repair, repair.mapping.map(at, -1), lost.get(at) ?? [])

	// 5. Ranges whose markers moved past each other.
	if ([...lost.values()].some(list => list.some(isRangeMarker)) || (reorders && insertsRange(state.doc, inserted))) {
		const moved: [number, number][] = []

		for (let k = 0; k < inserted.length; k += 2) {
			const from = repair.mapping.map(inserted[k] ?? 0, 1)
			const to = repair.mapping.map(inserted[k + 1] ?? 0, -1)

			if (to > from) moved.push([from, to])
		}

		const places = new Map<string, number>()

		for (const [key, pos] of behind) places.set(key, repair.mapping.map(pos, -1))

		orderRanges(repair, moved, carried, places)
	}

	if (!repair.docChanged) return null

	return markInternal(repair)
}

// For each step of `tr` that leaves the paragraph mark of the paragraph ending a section in another paragraph
// than the one holding the break (a paste of paragraphs into it, a deletion joining an earlier paragraph to
// it): the break's key, where its paragraph mark went (in `tr.doc`) and its section change.
function breakMoves(tr: Transaction, f: (key: number, pos: number, change: Mark | undefined) => void): void {
	tr.steps.forEach((step, index) => {
		const doc = tr.docs[index]

		if (doc === undefined || !(step instanceof ReplaceStep)) return

		const walk = ordered(doc)

		for (const replace of replacesOf(step)) {
			const from = walk.resolve(replace.from)
			const to = walk.resolve(replace.to)
			const $to = to.$pos
			const key = $to.parent.attrs["sectPr"]

			if (typeof key !== "number" || key === NO_SOURCE || !$to.parent.isTextblock) continue
			// Within the paragraph, only a slice of paragraphs splits it.
			if (from.start + from.$pos.start() === to.start + $to.start() && replace.slice.openEnd === 0) continue

			const end = to.start + $to.end()
			let pos = step instanceof RebuildStep ? rebuiltPos(step, end) : (tr.mapping.maps[index]?.map(end, 1) ?? end)

			for (let later = index + 1; later < tr.steps.length; later++) pos = tr.mapping.maps[later]?.map(pos, 1) ?? pos

			f(key, pos, sectionChange.isInSet($to.parent.marks))
		}
	})
}

// The block of `doc` holding section break `key` (a section change moving away from where the edit left it,
// to a break the edit did not touch).
function breakHolder(doc: Node, key: number): number | undefined {
	let found: number | undefined

	doc.descendants((node, pos) => {
		if (found !== undefined) return false
		if (node.attrs["sectPr"] === key && (node.type === nodes.paragraph || node.type === nodes.locked_block)) found = pos

		return found === undefined && !node.isTextblock && node.type !== nodes.locked_block
	})

	return found
}

interface CopyFix {
	readonly pos: number
	readonly mark: Mark
	// What the copy keeps in its place.
	readonly replacement?: Mark
}

// Whether a transaction inserts content holding source identities (items, marks or markers with a source) that
// did not come from where it went in: typing takes the marks at the caret, a split its paragraph's attributes
// (the very objects), which are this story's.
function insertsSources(tr: Transaction): boolean {
	return tr.steps.some((step, index) => {
		if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep) || step.slice.size === 0) return false

		const doc = tr.docs[index] ?? tr.doc

		return (step instanceof ReplaceStep ? replacesOf(step) : [step]).some(replace => {
			if (replace.slice.size === 0) return false

			let found = false
			let local: { readonly attrs: Set<object>; readonly marks: SourceMarks } | undefined
			const here = (): { readonly attrs: Set<object>; readonly marks: SourceMarks } => {
				if (local !== undefined) return local

				const attrs = new Set<object>()
				const marks = new SourceMarks(tr.storedMarks ?? [])

				for (const at of [replace.from, replace.to]) {
					const { $pos: $at, ancestors } = ordered(doc).resolve(Math.min(at, doc.content.size))

					for (const node of ancestors) attrs.add(node.attrs)
					for (let depth = 1; depth <= $at.depth; depth++) attrs.add($at.node(depth).attrs)

					// The textblock's own runs (text typed after a reference takes the formatting of the run before it).
					if ($at.parent.inlineContent) $at.parent.forEach(node => marks.addAll(node.marks))
					else for (const node of [$at.nodeBefore, $at.nodeAfter]) marks.addAll(node?.marks ?? [])
				}

				// What the step puts back of the range it replaces is the story's own (Replace All takes out the text
				// between a paragraph's matches and puts it back).
				ordered(doc).nodesBetween(replace.from, Math.min(replace.to, doc.content.size), node => {
					attrs.add(node.attrs)
					marks.addAll(node.marks)
				})

				local = { attrs, marks }

				return local
			}

			replace.slice.content.descendants(node => {
				if (found) return false

				const src = node.attrs["src"]

				found =
					(typeof src === "number" && src !== NO_SOURCE && !here().attrs.has(node.attrs)) ||
					node.marks.some(
						mark => typeof mark.attrs["src"] === "number" && mark.attrs["src"] !== NO_SOURCE && !here().marks.has(mark)
					)

				return !found
			})

			return found
		})
	})
}

// Marks naming a source, found by value: text typed at a run carries that run's mark, which the tracking
// transform may have made again (an equal mark, another object).
class SourceMarks {
	private readonly bySource = new Map<string, Mark[]>()

	constructor(marks: readonly Mark[]) {
		this.addAll(marks)
	}

	addAll(marks: readonly Mark[]): void {
		for (const mark of marks) {
			const src = mark.attrs["src"]

			if (typeof src !== "number" || src === NO_SOURCE) continue

			const key = `${mark.type.name}:${String(src)}`
			const list = this.bySource.get(key)

			if (list === undefined) this.bySource.set(key, [mark])
			else if (!list.some(other => other === mark || other.eq(mark))) list.push(mark)
		}
	}

	has(mark: Mark): boolean {
		return this.bySource.get(`${mark.type.name}:${String(mark.attrs["src"])}`)?.some(other => other === mark || other.eq(mark)) ?? false
	}
}

// Inline content inserted (by `inserted`, pairs) whose marks name a source of another part, outside blocks of
// another part (made new whole): their positions.
function alienRuns(doc: Node, inserted: readonly number[], alien: (value: Node | Mark) => boolean): number[] {
	const out: number[] = []
	const size = doc.content.size
	const ranges = sortedPairs(inserted)
	const walk = new OrderedDoc(doc)

	for (let k = 0; k < ranges.length; k += 2) {
		const from = Math.max(0, Math.min(size, ranges[k] ?? 0))
		const to = Math.max(from, Math.min(size, ranges[k + 1] ?? 0))

		if (to <= from) continue

		walk.nodesBetween(from, to, (node, pos) => {
			if (node.isInline) {
				if (pos >= from && node.marks.some(mark => alien(mark))) out.push(pos)

				return false
			}

			return !(pos >= from && alien(node))
		})
	}

	return out
}

// Whether a slice holds a block with node marks (blockCopies looks at nothing else).
function holdsMarkedBlocks(slice: Slice): boolean {
	let found = false

	slice.content.descendants(node => {
		if (found || node.isInline) return false
		if (node.marks.some(mark => blockMarkTypes.includes(mark.type))) found = true

		return !found && !node.isTextblock
	})

	return found
}

function blockCopies(doc: Node, inserted: readonly number[], movedMarks: readonly Mark[]): CopyFix[] {
	const out: CopyFix[] = []
	const size = doc.content.size
	const ranges = sortedPairs(inserted)
	const walk = new OrderedDoc(doc)

	for (let k = 0; k < ranges.length; k += 2) {
		const from = Math.max(0, Math.min(size, ranges[k] ?? 0))
		const to = Math.max(from, Math.min(size, ranges[k + 1] ?? 0))

		if (to <= from) continue

		// Text inside one paragraph (typing) inserts no block: nothing to look at.
		const { $pos: $from, start } = walk.resolve(from)

		if ($from.parent.isTextblock && to <= start + $from.end()) continue

		walk.nodesBetween(from, to, (node, pos) => {
			if (node.isInline) return false
			// Only blocks whose start the edit inserted.
			if (pos < from) return !node.isTextblock

			for (const mark of node.marks) {
				if (!blockMarkTypes.includes(mark.type) || movedMarks.some(moved => moved.eq(mark))) continue

				// A row's or cell's properties (fill, alignment, its model) are the copy's too; only its tracked
				// insertion, deletion and change record stay with the original.
				if (mark.type === propsType(node)) {
					const value = mark.attrs["value"] as Readonly<Record<string, unknown>>
					const rest = untracked(value)

					if (Object.keys(rest).length === Object.keys(value).length) continue

					out.push(Object.keys(rest).length === 0 ? { pos, mark } : { pos, mark, replacement: mark.type.create({ value: rest }) })

					continue
				}

				// A section change goes with its break (see repairTransaction).
				if (mark.type !== sectionChange) out.push({ pos, mark })
			}

			return !node.isTextblock
		})
	}

	return out
}

// The range markers of `fragment` (block lists and inline markers) as keys, in document order. A table cell's
// content keeps its keys (fragments do not change): a table rebuilt column by column keeps its cells' content.
const CELL_RANGE_KEYS = new WeakMap<Fragment, readonly string[]>()
const NO_KEYS: readonly string[] = Object.freeze([])

function rangeMarkerKeys(fragment: Fragment, out: string[]): string[] {
	const add = (list: unknown): void => {
		if (Array.isArray(list)) for (const marker of list as MarkerList) if (isRangeMarker(marker)) out.push(markerKey(marker))
	}

	fragment.forEach(node => {
		if (node.isBlock) add(node.attrs["before"])

		if (node.isLeaf) {
			for (const marker of survivorsOf(node)) if (isRangeMarker(marker)) out.push(markerKey(marker))
		} else if (node.type === nodes.table_cell) {
			let keys = CELL_RANGE_KEYS.get(node.content)

			if (keys === undefined) {
				const own = rangeMarkerKeys(node.content, [])

				keys = own.length === 0 ? NO_KEYS : own
				CELL_RANGE_KEYS.set(node.content, keys)
			}

			for (const key of keys) out.push(key)
		} else if (node.content.size > 0) {
			rangeMarkerKeys(node.content, out)
		}

		if (node.isBlock) add(node.attrs["end"])
	})

	return out
}

// Whether a step of `tr` inserts range markers other than the very ones it replaced, in their order, at their
// place (a block rebuilt where it stands keeps every range as it was; a move or a paste may not).
function movesRangeMarkers(tr: Transaction): boolean {
	return tr.steps.some((step, index) => {
		if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep) || step.slice.size === 0) return false

		const doc = tr.docs[index]

		if (step instanceof ReplaceAroundStep || doc === undefined) return rangeMarkerKeys(step.slice.content, []).length > 0

		return replacesOf(step).some(replace => {
			const inserted = rangeMarkerKeys(replace.slice.content, [])

			if (inserted.length === 0) return false

			const removed = rangeMarkerKeys(doc.slice(replace.from, replace.to).content, [])

			return removed.length !== inserted.length || removed.some((key, k) => key !== inserted[k])
		})
	})
}

function insertsRange(doc: Node, inserted: readonly number[]): boolean {
	let found = false
	const ranges = sortedPairs(inserted)
	const walk = new OrderedDoc(doc)

	for (let k = 0; k < ranges.length && !found; k += 2) {
		const from = ranges[k] ?? 0
		const to = ranges[k + 1] ?? 0

		if (to <= from) continue

		walk.nodesBetween(from, to, node => {
			if (found) return false
			if (survivorsOf(node).some(isRangeMarker)) found = true
			if (node.isBlock)
				for (const name of ["before", "end"])
					if (((node.attrs[name] as MarkerList | undefined) ?? NO_MARKERS).some(isRangeMarker)) found = true

			return !found
		})
	}

	return found
}

// Revision marks in inserted content that are copies: all but those of revisions the same edit deleted (a
// move) and that are nowhere else in the document (next to it, as typing inherits them, or anywhere).
function copiedRevisions(doc: Node, inserted: readonly number[], moved: ReadonlySet<number>): { from: number; to: number; mark: Mark }[] {
	const found: { from: number; to: number; mark: Mark }[] = []
	const size = doc.content.size
	const spans: [number, number][] = []
	const sorted = sortedPairs(inserted)
	const walk = new OrderedDoc(doc)

	for (let k = 0; k < sorted.length; k += 2) {
		const from = Math.max(0, Math.min(size, sorted[k] ?? 0))
		const to = Math.max(from, Math.min(size, sorted[k + 1] ?? 0))

		if (to > from) spans.push([from, to])
	}

	// Asked in document order (the walk of the whole document below).
	const insideSpan = inOrder(spans.flat())
	const adjacent = new Set<number>()

	for (const [from, to] of spans) {
		for (const node of [walk.resolve(from).$pos.nodeBefore, walk.resolve(to).$pos.nodeAfter]) {
			for (const mark of node?.marks ?? []) if (revisionTypes.includes(mark.type)) adjacent.add(mark.attrs["src"] as number)
		}

		walk.nodesBetween(from, to, (node, pos) => {
			if (!node.isInline) return true

			for (const mark of node.marks) {
				if (revisionTypes.includes(mark.type))
					found.push({ from: Math.max(from, pos), to: Math.min(to, pos + node.nodeSize), mark })
			}

			return false
		})
	}

	if (found.length === 0) return found

	const pending = found.filter(entry => {
		const own = entry.mark.attrs["src"] as number

		return moved.has(own) && !adjacent.has(own)
	})
	let outside: Set<number> | undefined

	if (pending.length > 0) {
		outside = new Set()

		const sources = outside

		doc.descendants((node, pos) => {
			if (!node.isInline) return true
			if (insideSpan(pos)) return false

			for (const mark of node.marks) if (revisionTypes.includes(mark.type)) sources.add(mark.attrs["src"] as number)

			return false
		})
	}

	return found.filter(entry => {
		const own = entry.mark.attrs["src"] as number

		return !moved.has(own) || adjacent.has(own) || outside?.has(own) === true
	})
}

// Source run-level content controls in inserted content (by `inserted`, pairs) that are copies: each run of a
// control's content not next to more of it, unless the edit took the control's content out (a move, a rebuild)
// or it has none elsewhere, once; with what it becomes (a copy of the control: its properties, an identity of its
// own). Another part's controls are left to the repair of alien runs.
function copiedControls(
	doc: Node,
	inserted: readonly number[],
	part: number | undefined,
	removed: ReadonlySet<number>
): { from: number; to: number; mark: Mark; copy: Mark }[] {
	const type = docxSchema.marks.content_control
	const size = doc.content.size
	const islands: { from: number; to: number; mark: Mark }[] = []
	const ranges = sortedPairs(inserted)
	const walk = new OrderedDoc(doc)

	for (let k = 0; k < ranges.length; k += 2) {
		const from = Math.max(0, Math.min(size, ranges[k] ?? 0))
		const to = Math.max(from, Math.min(size, ranges[k + 1] ?? 0))

		if (to <= from) continue

		walk.nodesBetween(from, to, (node, pos) => {
			if (!node.isInline) return true

			const start = Math.max(from, pos)
			const end = Math.min(to, pos + node.nodeSize)

			for (const mark of node.marks) {
				if (mark.type !== type || mark.attrs["src"] === NO_SOURCE) continue

				const origin = originOf(mark)

				if (part !== undefined && origin !== undefined && origin !== part) continue

				const last = islands.findLast(island => island.mark.eq(mark))

				if (last !== undefined && last.to === start) last.to = end
				else islands.push({ from: start, to: end, mark })
			}

			return false
		})
	}

	// Next to more of its control: typed into it, or a split of it.
	const copies = islands.filter(
		({ from, to, mark }) =>
			!mark.isInSet(walk.resolve(from).$pos.nodeBefore?.marks ?? []) && !mark.isInSet(walk.resolve(to).$pos.nodeAfter?.marks ?? [])
	)

	if (copies.length === 0) return []

	const wanted = new Set(copies.map(island => island.mark.attrs["src"] as number).filter(own => !removed.has(own)))
	// Asked in document order (the walk of the whole document below).
	const inCopies = inOrder(copies.flatMap(island => [island.from, island.to]))
	const elsewhere = new Set<number>()

	if (wanted.size > 0) {
		doc.descendants((node, pos) => {
			if (!node.isInline) return true

			for (const mark of node.marks) {
				const own = mark.attrs["src"] as number

				if (mark.type === type && wanted.has(own) && !inCopies(pos)) elsewhere.add(own)
			}

			return false
		})
	}

	const out: { from: number; to: number; mark: Mark; copy: Mark }[] = []
	const kept = new Set<number>()

	for (const { from, to, mark } of copies) {
		const own = mark.attrs["src"] as number

		// The control moved or was rebuilt here, or has no content elsewhere: it keeps its identity (once).
		if (!kept.has(own) && !elsewhere.has(own)) {
			kept.add(own)

			continue
		}

		const state = (mark.attrs["state"] ?? null) as Readonly<Record<string, unknown>> | null

		out.push({
			from,
			to,
			mark,
			copy: type.create({ ...mark.attrs, src: NO_SOURCE, state: { ...state, copy: own, id: newControlId() } })
		})
	}

	return out
}

function carries(fragment: Fragment, test: (mark: Mark) => boolean): boolean {
	let found = false

	fragment.descendants(node => {
		if (!found && node.marks.some(test)) found = true

		return !found
	})

	return found
}

export const docxInvariantsKey = new PluginKey("docxInvariants")

// The structural invariants of an editing document (see invariantViolation and repairTransaction), the
// read-only gate, and paste sanitising.
export function docxInvariants(options: InvariantOptions = {}): Plugin {
	return new Plugin({
		key: docxInvariantsKey,
		filterTransaction(tr) {
			if (tr.docChanged && !isInternal(tr) && options.readOnly?.() === true) return false

			return invariantViolation(tr) === undefined
		},
		appendTransaction(transactions, _old, state) {
			return repairTransaction(transactions, state, options)
		},
		props: {
			transformPasted(slice, view) {
				// A drag keeps its slice until the drop knows whether it moves (see handleDrop).
				return view.dragging === null ? freshSlice(slice, options.copies, options.part, options.part, options.notes) : slice
			},
			handleDrop(view, event, slice, moved) {
				// A move keeps identity (the original is deleted); a drop from outside was parsed from the
				// clipboard and has none. A copy inside the document goes in as new content.
				if (moved || view.dragging === null) return false

				const coords = view.posAtCoords({ left: Number(Reflect.get(event, "clientX")), top: Number(Reflect.get(event, "clientY")) })

				if (coords === null) return false

				const fresh = freshSlice(slice, options.copies, options.part, options.part, options.notes)
				const doc = view.state.doc
				const at = dropPoint(doc, coords.pos, fresh) ?? coords.pos

				view.dispatch(view.state.tr.replaceRange(at, at, fresh).setMeta("uiEvent", "drop"))

				return true
			}
		}
	})
}

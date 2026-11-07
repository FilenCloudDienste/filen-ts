import { Mark, type Node } from "prosemirror-model"
import type { BytePieces } from "../../opc/index"
import type { SliceClock } from "../../slicing"
import type { DocxEditContext } from "../edit/context"
import type { StoryDoc } from "../edit/build"
import { NO_SOURCE, docxSchema, type MarkerList } from "../edit/schema"
import type { StoryPart } from "../model/index"
import { finalSectionEdit } from "../stories/sections"
import { closeTag, copyNode, Names, openTag, Out, spliceChildren } from "./markup"
import { MARKER_ITEMS, writeListMarker } from "./markers"
import { copySource, type NestedStories } from "./nested"
import { writeNewStory, type NewStoryContainer } from "./newStory"
import { writeParagraph } from "./paragraph"
import { finalSectionMarkup } from "./sections"
import type { SaveParts } from "./parts/index"
import { writeSdt } from "./sdt"
import { R_NAMESPACE, W14_NAMESPACE, W_NAMESPACE, cellWithin, inCell, refuseBlockMarks, src } from "./source"
import { writeTable } from "./tables"
import { DocxWriteError } from "./values"

export { DocxWriteError, type WriteFailure } from "./values"
export { R_NAMESPACE, W_NAMESPACE, cellWithin, inCell, sectionWritten } from "./source"

// What a whole save shares across stories: new ids and the session-level registries resolved to file values.
export interface WriteEnvironment {
	readonly context: DocxEditContext
	// A new w:id for a revision wrapper written a second time.
	nextRevisionId(): number
	// The w:numId a command's new list (negative id) became.
	numId(id: number): number
	// A relationship id for a new external hyperlink from `part`.
	hyperlink(part: string, target: string): string
	// The parts of the save being written, for writers that add to them or reference new ones (pictures,
	// notes); absent where nothing new may be (gate 1, the layout of edited blocks).
	readonly parts?: SaveParts | undefined
	// Stories rewritten inside source bytes this story copies (see nested.ts).
	readonly nested?: NestedStories | undefined
}

export interface StoryWriteOptions {
	// Gate 1: write this block through the edit path even though it is unchanged (runs rebuilt from their
	// bases, containers from their parts).
	readonly force?: Node
	// A story the source does not have (its item is -1): the container it is written in.
	readonly container?: NewStoryContainer
	// Prefixes of namespaces the save declares on the part's root (by URI), where the source's root lacks them.
	readonly prefixes?: ReadonlyMap<string, string>
}

const nodes = docxSchema.nodes

// A story as written: the container element's bytes, the spans copied as whole source nodes (see Out),
// the paragraphs rebuilt through the edit path and the property elements of containers written as copies,
// each as a byte range of `bytes`.
export interface StoryOutput {
	// Joined (writeStory), or the pieces a save assembles a part from.
	readonly bytes: Uint8Array | BytePieces
	readonly trusted: readonly number[]
	readonly paragraphs: readonly WrittenParagraph[]
	readonly containers: readonly WrittenContainer[]
}

export interface WrittenParagraph {
	readonly node: Node
	readonly from: number
	readonly to: number
}

// Property elements (source nodes) of a container copy, written without the children named in `strip`.
export interface WrittenContainer {
	readonly properties: readonly number[]
	readonly strip: readonly string[]
	readonly from: number
	readonly to: number
}

// A story written but not yet joined into one byte array: the caller can compare it with its source cheaply
// (Out.equals) and assemble it with the rest of its part (Out.pieces).
export interface StoryDraft {
	readonly out: Out
	readonly paragraphs: readonly WrittenParagraph[]
	readonly containers: readonly WrittenContainer[]
}

const NO_SIBLINGS: readonly number[] = []

// A set of source items the writer keeps across a story's blocks (runs copied or started, wrappers opened,
// changes written) that can note which items one block's write looks at.
class TouchSet extends Set<number> {
	// While a block's write is noted: the items it looked at, and whether one was already there (another block's).
	touched: Set<number> | undefined = undefined
	before = false

	override has(item: number): boolean {
		const found = super.has(item)

		if (this.touched !== undefined) {
			if (found && !this.touched.has(item)) this.before = true

			this.touched.add(item)
		}

		return found
	}

	override add(item: number): this {
		if (this.touched !== undefined) {
			if (super.has(item) && !this.touched.has(item)) this.before = true

			this.touched.add(item)
		}

		return super.add(item)
	}
}

// What a top-level block wrote when nothing outside it shaped the write: its bytes (new markup and source copies,
// replayed as written), its paragraphs and containers, and the items it put in the writer's sets. A later save
// writes the very same node again the same way, so it replays this instead (see StoryWriting.writeTop).
interface WrittenBlock {
	readonly bytes: Uint8Array
	// [from, to, source from, source to] of each source copy, from relative to the block.
	readonly copies: readonly number[]
	readonly paragraphs: readonly WrittenParagraph[]
	readonly containers: readonly WrittenContainer[]
	// Per set (copiedRuns, startedRuns, openedWrappers, writtenChanges): the items the write looked at, and
	// those it added.
	readonly touched: readonly (readonly number[])[]
	readonly added: readonly (readonly number[])[]
}

// The blocks each story's last draft wrote (one generation: a draft keeps what it wrote or replayed), per way of
// writing (the prefixes the part binds, what the save writes alongside: a copied story's writer is not a save's).
const writtenBlocks = new WeakMap<StoryDoc, Map<string, WeakMap<Node, WrittenBlock>>>()

// Where source item `item` is among a container's children (items ascend in source order), or -1.
function indexOf(siblings: readonly number[], item: number): number {
	let low = 0
	let high = siblings.length - 1

	while (low <= high) {
		const middle = (low + high) >> 1
		const at = siblings[middle] ?? 0

		if (at === item) return middle
		if (at < item) low = middle + 1
		else high = middle - 1
	}

	return -1
}

// Runs a write to its end (without a clock nothing yields).
function complete<T>(steps: Generator<void, T>): T {
	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value
	}
}

async function drive<T>(steps: Generator<void, T>, clock: SliceClock): Promise<T> {
	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value

		await clock.pause()
	}
}

// The first block of each source item as the story was built (the story is never changed), looked up by
// descending through the blocks whose items enclose it (an item's descendants are the items up to its end), each
// level by binary search over that container's children with an item (in document order, items growing; built
// once per container of more than SCAN_CHILDREN children, 8 bytes a child; a smaller one, a table cell or row,
// is scanned): a keystroke's write looks up a few, a whole story's every one, and no map of them all is held.
const childItems = new WeakMap<Node, Int32Array>()
const SCAN_CHILDREN = 16

export function originalBlock(story: StoryDoc, item: number): Node | undefined {
	return item === NO_SOURCE ? undefined : descend(story, item)
}

// The top level of `story`'s index, ahead of the first write (DocxEditorSession.warmUp).
export function indexOriginals(story: StoryDoc): void {
	itemsOf(story.doc)
}

function itemsOf(container: Node): Int32Array {
	let items = childItems.get(container)

	if (items === undefined) {
		let count = 0

		for (let index = 0; index < container.childCount; index++) {
			const child = container.child(index)

			if (!child.isInline && src(child) !== NO_SOURCE) count++
		}

		items = new Int32Array(count * 2)

		for (let index = 0, at = 0; index < container.childCount; index++) {
			const child = container.child(index)
			const own = child.isInline ? NO_SOURCE : src(child)

			if (own === NO_SOURCE) continue

			items[at++] = own
			items[at++] = index
		}

		childItems.set(container, items)
	}

	return items
}

// The index among `container`'s children of the last one with an item of at most `item`, or -1.
function enclosing(container: Node, item: number): number {
	if (container.childCount <= SCAN_CHILDREN) {
		let at = -1

		for (let index = 0; index < container.childCount; index++) {
			const child = container.child(index)
			const own = child.isInline ? NO_SOURCE : src(child)

			if (own === NO_SOURCE) continue
			if (own > item) break

			at = index
		}

		return at
	}

	const items = itemsOf(container)
	let low = 0
	let high = items.length / 2 - 1
	let at = -1

	while (low <= high) {
		const middle = (low + high) >> 1

		if ((items[middle * 2] ?? 0) <= item) {
			at = middle
			low = middle + 1
		} else high = middle - 1
	}

	return at < 0 ? -1 : (items[at * 2 + 1] ?? -1)
}

function descend(story: StoryDoc, item: number): Node | undefined {
	const part = story.part

	for (let node = story.doc; ;) {
		const index = enclosing(node, item)

		if (index < 0) return undefined

		const child = node.child(index)
		const own = src(child)

		if (item >= part.end(own)) return undefined
		if (own === item) return child
		if (child.isTextblock || child.isLeaf) return undefined

		node = child
	}
}

// Writes one story (body, header, footer, note, comment) of an editing document back into its part:
// everything that can still be copied as source bytes is, the rest goes through the edit path described in
// StoryDoc. The output keeps the story container element and replaces only its content.
export class StoryWriter {
	readonly story: StoryDoc
	readonly part: StoryPart
	readonly names: Names
	private readonly writing: StoryWriting

	constructor(env: WriteEnvironment, story: StoryDoc, options: StoryWriteOptions = {}) {
		this.writing = new StoryWriting(env, story, options)
		this.story = story
		this.part = story.part
		this.names = this.writing.names
	}

	// The story container element (w:body, w:hdr, w:footnote...) written from `doc`, with what gate 2 needs
	// to check it without parsing it whole.
	writeStory(doc: Node): StoryOutput & { readonly bytes: Uint8Array } {
		const draft = complete(this.writing.draft(doc))

		return { bytes: draft.out.finish(), trusted: draft.out.trusted, paragraphs: draft.paragraphs, containers: draft.containers }
	}

	// writeStory without joining the output (see StoryDraft).
	draftStorySync(doc: Node): StoryDraft {
		return complete(this.writing.draft(doc))
	}

	// writeStory in slices: the clock's pause runs between them (a rejecting pause abandons the write). The
	// output is not joined yet (see StoryDraft).
	async draftStory(doc: Node, clock: SliceClock): Promise<StoryDraft> {
		this.writing.clock = clock

		try {
			return await drive(this.writing.draft(doc), clock)
		} finally {
			this.writing.clock = undefined
		}
	}

	// One block through the edit path, for gate 1: runs rebuilt from their bases, properties spliced,
	// containers rebuilt from their parts (a table's paragraphs are copied, each is proved on its own).
	// `copy`: an earlier block of the story holds the same source (a pasted copy), as writeStory finds it.
	// `cell`: whether the block is in a table cell (by default, where its source is).
	writeBlockAlone(node: Node, copy = false, cell?: boolean): Out {
		return complete(this.writing.blockAlone(node, copy, cell, undefined))
	}

	// writeBlockAlone yielding between the children it writes (a long table's rows and cells) when `due` says so.
	writeBlockAloneSteps(node: Node, due: () => boolean): Generator<void, Out> {
		return this.writing.blockAlone(node, false, undefined, due)
	}

	// Whether a paragraph is again the one the story was built with (an undo): its source bytes stand for it.
	isSource(node: Node): boolean {
		return (
			node.type === docxSchema.nodes.paragraph &&
			src(node) !== NO_SOURCE &&
			node.marks.length === 0 &&
			(this.story.pristine.has(node) || sameParagraph(this.original(node), node))
		)
	}

	private original(node: Node): Node | undefined {
		return originalBlock(this.story, src(node))
	}
}

// The state of one story's write, shared by the modules that write its parts (paragraph.ts, tables.ts,
// sdt.ts, wrappers.ts, markers.ts, atoms/): the walker and the containers live here.
export class StoryWriting {
	readonly story: StoryDoc
	readonly part: StoryPart
	readonly names: Names
	readonly env: WriteEnvironment
	readonly bytes: Uint8Array
	force: Node | undefined
	// A story the source does not have: the container it is written in.
	readonly container: NewStoryContainer | undefined
	// Table cells the block being written is in.
	cells = 0
	private readonly owners = new Map<number, Node>()
	// Source items whose owning node object stands at more than one place, those already written, and the
	// depth of later occurrences being written.
	private readonly shared = new Set<number>()
	private readonly claimed = new Set<number>()
	// Some source item stands on two different nodes (a copy).
	private duplicated = false
	private repeating = 0
	// Whether a block can be written as its source bytes, outside table cells and inside one.
	private readonly copyable = new Map<Node, boolean>()
	private readonly copyableInCell = new Map<Node, boolean>()
	private readonly siblings = new Map<number, number[]>()
	// Set while writing in slices.
	clock: SliceClock | undefined
	// Set while a block alone is written in steps: when to yield (see due()).
	private stepDue: (() => boolean) | undefined = undefined
	readonly copiedRuns: Set<number> = new TouchSet()
	readonly startedRuns: Set<number> = new TouchSet()
	readonly openedWrappers: Set<number> = new TouchSet()
	readonly paragraphs: WrittenParagraph[] = []
	// The w14:textId attribute's qualified name, and the w14 prefix the part binds ("" when it binds none).
	readonly textId: ReadonlySet<string> | undefined
	readonly w14: string
	private readonly containers: WrittenContainer[] = []
	// Bases whose w:rPrChange has been written (copied runs included).
	readonly writtenChanges: Set<number> = new TouchSet()
	// Calls on the save's environment (new ids, relationships, parts, stories spliced in) while a block is written.
	private effects = 0
	// The blocks this draft wrote alone, for the next draft of the story written the same way (see writeTop).
	private written: WeakMap<Node, WrittenBlock> | undefined = undefined
	private readonly config: string

	constructor(env: WriteEnvironment, story: StoryDoc, options: StoryWriteOptions) {
		const effect = (): void => {
			this.effects++
		}

		this.env = {
			context: env.context,
			nextRevisionId: () => {
				effect()

				return env.nextRevisionId()
			},
			numId: id => {
				effect()

				return env.numId(id)
			},
			hyperlink: (part, target) => {
				effect()

				return env.hyperlink(part, target)
			},
			get parts() {
				if (env.parts !== undefined) effect()

				return env.parts
			},
			get nested() {
				if (env.nested !== undefined) effect()

				return env.nested
			}
		}
		this.story = story
		this.part = story.part
		this.bytes = story.part.document.bytes
		this.force = options.force
		this.container = options.container

		const reader = story.part.reader
		const root = story.part.document.documentElement()

		const w14 = reader.namespaces.prefixFor(root, W14_NAMESPACE)

		this.w14 = w14 ?? options.prefixes?.get(W14_NAMESPACE) ?? ""
		this.textId = w14 === undefined || w14 === "" ? undefined : new Set([`${w14}:textId`])
		this.names = new Names(reader.namespaces.prefixFor(root, W_NAMESPACE) ?? "", reader.namespaces.prefixFor(root, R_NAMESPACE) ?? "")
		this.config = [
			this.names.w,
			this.names.r,
			this.w14,
			[...(this.textId ?? [])].join(" "),
			env.parts !== undefined,
			env.nested !== undefined
		].join("\u0001")
	}

	*draft(doc: Node): Generator<void, StoryDraft> {
		this.owners.clear()
		this.copyable.clear()
		this.copyableInCell.clear()
		this.shared.clear()
		this.claimed.clear()

		yield* this.findOwners(doc)
		this.paragraphs.length = 0
		this.containers.length = 0
		this.cells = 0

		// In slices, what can be copied is known before writing starts, children first: deciding it for a
		// large table while writing would be one long step. Nodes standing at two places are decided as they
		// are written (a claim changes the answer).
		if (this.clock !== undefined && this.shared.size === 0) yield* this.decideCopies(doc)

		const out = new Out()

		if (this.container !== undefined) {
			yield* writeNewStory(this, out, doc, this.container)

			return { out, paragraphs: [...this.paragraphs], containers: [...this.containers] }
		}

		const document = this.part.document
		const container = this.part.node(this.story.story.item)

		const sectPr = doc.attrs["sectPr"] as number
		// The body's own section properties as an edit changed them (sections.ts), else the source's.
		const final = finalSectionMarkup(this, doc)

		// A story without blocks, its empty paragraph untouched: as its source.
		if (untouchedEmpty(this.story, doc)) {
			this.copyWhole(out, container)

			return { out, paragraphs: [], containers: [] }
		}

		openTag(out, document, container)

		this.written = new WeakMap()

		const tail = yield* this.writeChildren(out, doc, this.story.story.item, (child, at) => this.writeTop(at, child), {
			from: document.openEnd(container),
			to: document.contentEnd(container),
			tail: sectPr === NO_SOURCE || final !== undefined ? [] : [sectPr]
		})

		if (final !== undefined) out.text(final)
		else if (!tail && sectPr !== NO_SOURCE) this.copyWhole(out, this.part.node(sectPr))

		closeTag(out, document, container)
		let generations = writtenBlocks.get(this.story)

		if (generations === undefined) {
			generations = new Map()
			writtenBlocks.set(this.story, generations)
		}

		generations.set(this.config, this.written)
		this.written = undefined

		return { out, paragraphs: [...this.paragraphs], containers: [...this.containers] }
	}

	*blockAlone(node: Node, copy: boolean, cell: boolean | undefined, due: (() => boolean) | undefined): Generator<void, Out> {
		this.force = node
		this.stepDue = undefined
		// Each block is written alone once (a proof keeps its writer): nothing of one is kept for the next.
		this.siblings.clear()
		this.owners.clear()
		this.copyable.clear()
		this.copyableInCell.clear()
		this.copiedRuns.clear()
		this.startedRuns.clear()
		this.openedWrappers.clear()
		this.writtenChanges.clear()
		this.owners.set(src(node), node)
		this.shared.clear()
		this.claimed.clear()
		complete(this.findOwners(node))
		this.cells = (cell ?? (node.type === nodes.paragraph && src(node) !== NO_SOURCE && inCell(this.part, src(node)))) ? 1 : 0

		// The earlier block owns the sources and wrote its runs first: this one is written as a copy.
		if (copy) {
			const other = copyOwner()

			for (const own of this.owners.keys()) this.owners.set(own, other)

			node.descendants(child => {
				const run = docxSchema.marks.run.isInSet(child.marks)

				if (run !== undefined && src(run) !== NO_SOURCE) this.copiedRuns.add(src(run))

				return true
			})
		}

		// Only a whole story's output reports these; a block alone would keep every node it wrote alive.
		this.paragraphs.length = 0
		this.containers.length = 0

		const out = new Out()

		this.stepDue = due

		try {
			yield* this.writeBlock(out, node)
		} finally {
			this.stepDue = undefined
		}

		return out
	}

	// ---- identity ----------------------------------------------------------------------------------------

	// The first node of each source item owns it. ProseMirror shares unchanged nodes, so one node object can
	// stand at two places (an unsanitised copy): its first occurrence owns, the later ones are copies.
	private *findOwners(doc: Node): Generator<void, void> {
		const visit = (node: Node): boolean => {
			if (node.isInline) return false

			const own = src(node)

			if (own !== NO_SOURCE) {
				const owner = this.owners.get(own)

				if (owner === undefined) this.owners.set(own, node)
				else if (owner === node) this.shared.add(own)
				else this.duplicated = true
			}

			return !node.isTextblock && node.type !== nodes.locked_block
		}

		this.duplicated = false

		for (let index = 0; index < doc.childCount; index++) {
			const child = doc.child(index)

			if (visit(child)) child.descendants(visit)

			if (this.due()) yield
		}
	}

	// Whether the write in progress should give the host a turn (only in slices or in steps).
	due(): boolean {
		return (this.stepDue !== undefined && this.stepDue()) || (this.clock !== undefined && this.clock.due)
	}

	// canCopy for every block, children before their container (each container then looks only at its
	// children's answers), in the cell context writing uses. A container still the very node the story was
	// built with, where its source was, is decided at once (see unchangedContainer).
	private *decideCopies(doc: Node): Generator<void, void> {
		const stack: { node: Node; cell: boolean; index: number }[] = []

		for (let top = 0; top < doc.childCount; top++) {
			stack.push({ node: doc.child(top), cell: this.cells > 0, index: 0 })

			while (stack.length > 0) {
				const frame = stack[stack.length - 1] as { node: Node; cell: boolean; index: number }
				const node = frame.node

				if (frame.index === 0 && this.unchangedContainer(node, frame.cell)) {
					stack.pop()
					this.canCopy(node, frame.cell)

					continue
				}

				if (!node.isTextblock && node.type !== nodes.locked_block && frame.index < node.childCount) {
					stack.push({ node: node.child(frame.index++), cell: frame.cell || node.type === nodes.table_cell, index: 0 })

					continue
				}

				stack.pop()
				this.canCopy(node, frame.cell)

				if (this.due()) yield
			}
		}
	}

	// The node source item `own` is written as (its first occurrence), if any.
	ownerOf(own: number): Node | undefined {
		return this.owners.get(own)
	}

	// Whether `node` is the first occurrence of its source item, which it is then written as.
	owns(node: Node): boolean {
		if (this.repeating > 0) return false

		const own = src(node)

		return own !== NO_SOURCE && this.owners.get(own) === node && !this.claimed.has(own)
	}

	// After an occurrence of `node` was written: later occurrences of shared nodes in it are copies.
	private claim(node: Node): void {
		if (this.shared.size === 0) return

		const own = src(node)

		if (own !== NO_SOURCE && this.shared.has(own)) this.claimed.add(own)

		if (!node.isTextblock && !node.isLeaf) node.descendants(child => (this.claim(child), false))
	}

	// The block the story was built with for `node`'s source item.
	original(node: Node): Node | undefined {
		return originalBlock(this.story, src(node))
	}

	// Whether a block can be written as its source bytes (see StoryDoc), in a table cell (`cell`) or not.
	private canCopy(node: Node, cell = this.cells > 0): boolean {
		if (this.repeating > 0 || this.claimed.has(src(node))) return false

		const memo = cell ? this.copyableInCell : this.copyable
		let result = memo.get(node)

		if (result !== undefined) return result

		// A block carrying node marks (what a feature recorded on it) is written through the edit path.
		if (node === this.force || !this.owns(node) || node.marks.length > 0) {
			result = false
		} else if (node.type === nodes.paragraph) {
			// An edited paragraph that is again what it was (an undo; markers before it are written apart) is
			// its bytes too, unless they hold a section break and it moved into or out of a table cell.
			const row = this.part.aux[src(node)] ?? -1

			result =
				(this.story.pristine.has(node) || sameParagraph(this.original(node), node)) &&
				((this.part.paragraphs.sectPr[row] ?? -1) < 0 || inCell(this.part, src(node)) === cell)
		} else if (node.type === nodes.locked_block) {
			// One whose section break moved into or out of a table cell is refused (see writeBlock).
			result = !this.lockedBreakMoved(node, cell)
		} else if (this.force !== undefined && this.force.type !== nodes.paragraph) {
			// A table under proof is rebuilt down to its paragraphs.
			result = false
		} else if (this.unchangedContainer(node, cell)) {
			result = true
		} else {
			const original = this.original(node)

			result =
				original !== undefined &&
				original.attrs === node.attrs &&
				original.childCount === node.childCount &&
				original.content.content.every(
					(child, index) =>
						src(child) === src(node.child(index)) && this.canCopy(node.child(index), cell || node.type === nodes.table_cell)
				)
		}

		memo.set(node, result)

		return result
	}

	// A container (table, row, cell, content control) that is still the very node the story was built with, so
	// is everything in it, written where its source was (in a table cell or not, as it was): its source bytes,
	// as canCopy would find child by child. Only while each source item stands at one place in the document
	// (then every node owns its source) and no block is forced through the edit path.
	private unchangedContainer(node: Node, cell: boolean): boolean {
		if (this.duplicated || this.shared.size > 0 || this.force !== undefined || this.repeating > 0) return false
		if (node.isInline || node.isTextblock || node.type === nodes.locked_block) return false

		const own = src(node)

		return own !== NO_SOURCE && this.owners.get(own) === node && this.original(node) === node && inCell(this.part, own) === cell
	}

	// Whether locked block `node`, in a table cell (`cell`) or not, has a section break that moved into or out
	// of one: a break in a cell of the block moves with it, one of the block itself only when the block did.
	private lockedBreakMoved(node: Node, cell: boolean): boolean {
		const sectPr = node.attrs["sectPr"] as number
		const own = src(node)

		return sectPr >= 0 && !cellWithin(this.part, sectPr, own) && inCell(this.part, own) !== cell
	}

	// ---- containers --------------------------------------------------------------------------------------

	private siblingsOf(container: number): number[] {
		let siblings = this.siblings.get(container)

		if (siblings === undefined) {
			siblings = []

			for (let item = container + 1; item < this.part.end(container); item = this.part.end(item)) siblings.push(item)

			this.siblings.set(container, siblings)
		}

		return siblings
	}

	// The children of a container: blocks that can be copied keep the bytes around them (whitespace,
	// comments, proofErr) when their source neighbours are also their neighbours here. `region` is the
	// container's content in the source and what must follow the last child there (the body's final
	// section properties); when everything after the last child is as it was, it is copied whole and true
	// returned.
	*writeChildren(
		out: Out,
		container: Node,
		sourceContainer: number,
		write: (child: Node, out: Out) => Generator<void, void>,
		region?: { readonly from: number; readonly to: number; readonly tail: readonly number[] }
	): Generator<void, boolean> {
		const siblings = sourceContainer === NO_SOURCE ? NO_SIBLINGS : this.siblingsOf(sourceContainer)
		let previous = -1

		for (let at = 0; at < container.childCount; at++) {
			const child = container.child(at)
			const before = (child.attrs["before"] as MarkerList | undefined) ?? []

			if (this.due()) yield

			if (this.canCopy(child)) {
				const own = src(child)
				const index = indexOf(siblings, own)
				const leading = index < 0 ? [] : this.leadingMarkers(siblings, index)
				const together = leading.length === before.length && leading.every((item, k) => before[k]?.src === item)
				const first = together && leading.length > 0 ? (leading[0] ?? own) : own

				if (!together) for (const marker of before) writeListMarker(this, out, marker)

				const firstIndex = indexOf(siblings, first)

				if (previous >= 0 && firstIndex > 0 && siblings[firstIndex - 1] === previous) {
					this.copySource(out, this.part.byteEnd(previous), this.part.start(first), true)
				} else if (previous === -1 && firstIndex === 0 && region !== undefined) {
					this.copySource(out, region.from, this.part.start(first), true)
				}

				this.copySource(out, this.part.start(first), this.part.byteEnd(own), true)
				this.claim(child)
				previous = own

				continue
			}

			for (const marker of before) writeListMarker(this, out, marker)

			// A later occurrence of a shared node is written as a copy, all the way down.
			const repeat = this.claimed.has(src(child))

			if (repeat) this.repeating++

			yield* write(child, out)

			if (repeat) this.repeating--
			else this.claim(child)

			previous = -2
		}

		const end = (container.attrs["end"] as MarkerList | undefined) ?? []

		if (region !== undefined && previous >= 0) {
			const rest = siblings.slice(indexOf(siblings, previous) + 1)
			const expected = [...end.map(marker => marker.src), ...region.tail]

			if (rest.length === expected.length && rest.every((item, k) => item === expected[k])) {
				this.copySource(out, this.part.byteEnd(previous), region.to, true)

				return true
			}
		}

		for (const marker of end) writeListMarker(this, out, marker)

		return false
	}

	private leadingMarkers(siblings: readonly number[], index: number): number[] {
		let start = index

		while (start > 0 && MARKER_ITEMS.has(this.part.kinds[siblings[start - 1] ?? -1] ?? 0)) start--

		return siblings.slice(start, index)
	}

	// A top-level block of the story. A paragraph standing alone (owned, no source item of it written elsewhere
	// in the story, no new ids, relationships or parts) is written as the story's last draft wrote that very node,
	// when nothing written before it this time touched what it touched; gate 2 checks it as any other.
	*writeTop(out: Out, node: Node): Generator<void, void> {
		const written = this.written

		if (
			written === undefined ||
			node.type !== nodes.paragraph ||
			this.duplicated ||
			this.shared.size > 0 ||
			this.repeating > 0 ||
			this.force !== undefined ||
			this.cells > 0
		) {
			yield* this.writeBlock(out, node)

			return
		}

		const sets = [this.copiedRuns, this.startedRuns, this.openedWrappers, this.writtenChanges] as TouchSet[]
		const last = writtenBlocks.get(this.story)?.get(this.config)?.get(node)

		if (last !== undefined && sets.every((set, k) => (last.touched[k] ?? []).every(item => !set.has(item)))) {
			this.replay(out, last, sets)
			written.set(node, last)

			return
		}

		const from = out.size
		const trusted = out.trusted.length
		const paragraphs = this.paragraphs.length
		const containers = this.containers.length
		const effects = this.effects

		for (const set of sets) {
			set.touched = new Set()
			set.before = false
		}

		try {
			yield* this.writeBlock(out, node)
		} finally {
			const touched = sets.map(set => set.touched ?? new Set<number>())
			// The block's first copy joined the copy before it (Out.copy joins adjacent ones): its `copies` would
			// miss that range, so it is not kept for replay. (A top-level paragraph starts with new markup.)
			const merged = trusted > 0 && (out.trusted[trusted - 3] ?? 0) > from
			const alone = !merged && this.effects === effects && sets.every(set => !set.before) && (out.trusted[trusted] ?? from) >= from

			for (const set of sets) set.touched = undefined

			if (alone) {
				const copies = out.trusted.slice(trusted)

				for (let k = 0; k < copies.length; k += 4) {
					copies[k] = (copies[k] ?? 0) - from
					copies[k + 1] = (copies[k + 1] ?? 0) - from
				}

				written.set(node, {
					bytes: out.slice(from, out.size),
					copies,
					paragraphs: this.paragraphs
						.slice(paragraphs)
						.map(record => ({ ...record, from: record.from - from, to: record.to - from })),
					containers: this.containers
						.slice(containers)
						.map(record => ({ ...record, from: record.from - from, to: record.to - from })),
					touched: touched.map(items => [...items]),
					// Nothing it touched was there before (`before`): what is there now, it added.
					added: sets.map((set, k) => [...(touched[k] ?? [])].filter(item => set.has(item)))
				})
			}
		}
	}

	// A block as an earlier draft wrote it: the same bytes, source copies as copies, and what it added to the sets.
	private replay(out: Out, block: WrittenBlock, sets: readonly TouchSet[]): void {
		const from = out.size
		let at = 0

		for (let k = 0; k < block.copies.length; k += 4) {
			const start = block.copies[k] ?? 0

			out.bytes(block.bytes, at, start)
			out.copy(this.bytes, block.copies[k + 2] ?? 0, block.copies[k + 3] ?? 0)
			at = block.copies[k + 1] ?? start
		}

		out.bytes(block.bytes, at, block.bytes.length)

		for (const record of block.paragraphs) this.paragraphs.push({ ...record, from: record.from + from, to: record.to + from })
		for (const record of block.containers) this.containers.push({ ...record, from: record.from + from, to: record.to + from })

		block.added.forEach((items, k) => {
			for (const item of items) sets[k]?.add(item)
		})
	}

	*writeBlock(out: Out, node: Node): Generator<void, void> {
		switch (node.type) {
			case nodes.paragraph:
				writeParagraph(this, out, node)

				return
			case nodes.table:
				refuseBlockMarks(node)
				yield* writeTable(this, out, node)

				return
			case nodes.sdt:
				refuseBlockMarks(node)
				yield* writeSdt(this, out, node)

				return
			case nodes.locked_block:
				refuseBlockMarks(node)

				if (!this.owns(node)) throw new DocxWriteError("missingSource", "A locked block appears twice")

				// Its bytes are all it can be written as: a section break in them must stay in or out of a table
				// cell as it was.
				if (this.lockedBreakMoved(node, this.cells > 0))
					throw new DocxWriteError("unsupported", "A locked section break moved into or out of a table cell")

				this.copyWhole(out, this.part.node(src(node)))

				return
			default:
				throw new DocxWriteError("unsupported", `Unexpected block ${node.type.name}`)
		}
	}

	// Source bytes [from, to) of the part: whole nodes copied as they are when `trusted` (see Out.copy), or
	// part of new markup; stories rewritten inside them are spliced in (env.nested).
	copySource(out: Out, from: number, to: number, trusted: boolean): void {
		copySource(out, this.part, from, to, trusted, this.env.nested)
	}

	// Source node `node` as part of new markup (a run, an atom), with stories rewritten inside it spliced in.
	copyNode(out: Out, node: number): void {
		if (this.env.nested === undefined) copyNode(out, this.part.document, node)
		else this.copySource(out, this.part.document.start(node), this.part.document.end(node), false)
	}

	copyWhole(out: Out, node: number): void {
		this.copySource(out, this.part.document.start(node), this.part.document.end(node), true)
	}

	// A container's property elements for a copy of it: everything but what carries an id of its own.
	copyProperties(out: Out, properties: readonly number[], strip: readonly string[]): void {
		const changes = new Map(strip.map(local => [local, ""]))
		const sorted = properties.filter(property => property >= 0).sort((a, b) => a - b)
		const from = out.size

		for (const property of sorted) spliceChildren(out, this.part.reader, property, changes, [])

		this.containers.push({ properties: sorted, strip, from, to: out.size })
	}

	// Container attributes no command changes yet: the writer has no way to express a change to them.
	checkUnchanged(node: Node, names: readonly string[], message: string): void {
		const original = this.original(node)

		if (original !== undefined && names.some(name => original.attrs[name] !== node.attrs[name]))
			throw new DocxWriteError("unsupported", message)
	}
}

function sameParagraph(original: Node | undefined, node: Node): boolean {
	if (original === undefined) return false
	if (original.eq(node)) return true
	if (!original.content.eq(node.content) || !Mark.sameSet(original.marks, node.marks)) return false

	for (const name of Object.keys(original.attrs)) {
		if (name !== "before" && original.attrs[name] !== node.attrs[name]) return false
	}

	return true
}

let copyOwnerNode: Node | undefined

// Stands for the block owning sources a copy is written without.
function copyOwner(): Node {
	copyOwnerNode ??= docxSchema.nodes.paragraph.create()

	return copyOwnerNode
}

// Whether `doc` is a story the source has no block in, holding only the builder's empty paragraph untouched (see
// StoryDoc.pristine) and nothing an edit added around it: the save copies its source, and layout lays out no block.
export function untouchedEmpty(story: StoryDoc, doc: Node): boolean {
	const only = doc.childCount === 1 ? doc.firstChild : null

	return (
		only !== null &&
		src(only) === NO_SOURCE &&
		story.pristine.has(only) &&
		((doc.attrs["end"] as MarkerList | undefined)?.length ?? 0) === 0 &&
		finalSectionEdit(doc) === undefined
	)
}

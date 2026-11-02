import { appendAll } from "../../arrays"
import type { Node } from "prosemirror-model"
import {
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_LEVEL_SHIFT,
	LINE_FLOATS,
	LINE_INTS,
	LineFlag,
	LineFloat,
	LineInt,
	nextCluster,
	type HitTester,
	type TextLayout
} from "../../text/index"
import { Region, SOURCE_INTS, SourceFlag, SourceInt, type PageDisplayList } from "../layout/index"
import type { StoryPart } from "../model/index"
import type { StoryEdits } from "./edits"
import { offsetMap, type OffsetMap } from "./maps"
import type { PageIndex } from "./pages"

// Caret, selection and pointer geometry of one story's editing document over its laid-out pages, from the
// display lists alone (no DOM): where a position is drawn, which position is under a point, the boxes a
// selection covers, and caret motion by lines. Coordinates are px in page space.

// Which side of a line break a position belongs to: -1 the end of the line before it, 1 the start of the
// line after it (positions where a line wraps are both).
export type Affinity = -1 | 1

export interface CaretBox {
	readonly page: number
	readonly line: number
	readonly x: number
	readonly top: number
	readonly height: number
	// The line's base direction is right to left.
	readonly rtl: boolean
}

export interface HitResult {
	readonly pos: number
	readonly affinity: Affinity
	readonly page: number
	readonly line: number
	// The point is over a block the editor keeps as one atom (a locked block): `pos` is the atom's position.
	readonly atom: boolean
}

export interface PageRect {
	readonly page: number
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

// The pages as currently shown, by index (a relayout under way may still show earlier pages).
export interface PageSource {
	page(index: number): PageDisplayList | undefined
}

interface Located {
	readonly pos: number
	readonly node: Node
	readonly shadow: Node
	readonly part: StoryPart
}

// The x extent of the column (or table cell column) a line stands in.
export interface ColumnBox {
	readonly left: number
	readonly right: number
}

// Room drawn for a selected paragraph mark at a line's end.
const MARK_WIDTH = 5
// Lines whose mark boxes are remembered before starting over.
const LINE_BOXES_LIMIT = 8192

// Boxes of many ranges (marks), four numbers per box (top, height, left, width) line by line in the page's
// order, and the index of each box's range. Grown as needed and reused draw after draw: drawing a page's
// marks on each keystroke allocates nothing.
export class MarkBoxes {
	values = new Float64Array(256)
	owners = new Int32Array(64)
	count = 0

	clear(): void {
		this.count = 0
	}

	// Room for one more box, of range `owner`: its index (its numbers are values[4 * index...]).
	add(owner: number): number {
		const count = this.count

		if (count === this.owners.length) {
			const owners = new Int32Array(count * 2)
			const values = new Float64Array(count * 8)

			owners.set(this.owners)
			values.set(this.values)
			this.owners = owners
			this.values = values
		}

		this.owners[count] = owner
		this.count = count + 1

		return count
	}
}

// What one line's marks measured: the line's identity (see lineIdentity) and text, the boxes (left, width
// pairs) of each part of it measured, and the next remembered line with the same hash.
interface LineMemo {
	readonly identity: Float64Array
	readonly text: string
	readonly parts: { readonly from: number; readonly to: number; readonly past: boolean; readonly boxes: Float64Array }[]
	next: LineMemo | undefined
}

const HASH_BITS = new Float64Array(1)
const HASH_WORDS = new Uint32Array(HASH_BITS.buffer)

export class PagedGeometry {
	readonly story: StoryEdits
	readonly index: PageIndex
	readonly pages: PageSource
	readonly tester: HitTester
	readonly region: Region
	private readonly maps = new WeakMap<
		Node,
		{ pool: Int32Array; start: number; end: number; text: string; shadow: Node; result: OffsetMap }
	>()
	private readonly columns = new WeakMap<PageDisplayList, { group: Int32Array; boxes: ColumnBox[] }>()
	private ranges = new WeakMap<PageDisplayList, { range: { from: number; to: number } | undefined }>()
	// Each page's sources located in the document as it is (null: none), filled as asked for.
	private locatedOn = new WeakMap<PageDisplayList, (Located | null)[]>()
	// The document both are of: an edit drops them all (a page's entries kept from an earlier document would keep
	// that document's nodes alive).
	private locatedIn: Node | undefined = undefined
	// Boxes rangesBoxes() measured, by what their line shows (lineIdentity and text, wherever it is and
	// whichever page holds it; keyed by their hash) and the marked part of it: a line laid out again as it was
	// (an edit in another line or on another page) is not measured again; measuring is most of the cost.
	private readonly lineBoxes = new Map<number, LineMemo>()
	private lineBoxesCount = 0
	// lineIdentity()'s scratch, and the part of the line's source text it covers.
	private identity = new Float64Array(64)
	private identityLow = 0
	private identityHigh = 0
	private readonly rectsScratch: PageRect[] = []
	// A story shown on many pages (a header) is located on this page first.
	private preferred = -1

	constructor(story: StoryEdits, index: PageIndex, pages: PageSource, tester: HitTester, region: Region = Region.BODY) {
		this.story = story
		this.index = index
		this.pages = pages
		this.tester = tester
		this.region = region
	}

	// Positions of a story drawn on several pages (a header, a footer) are located on `page` (-1: the first).
	preferPage(page: number): void {
		this.preferred = page
	}

	// ---- sources -----------------------------------------------------------------------------------------

	private storyLine(page: PageDisplayList, line: number): number {
		const source = page.text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1
		const at = source * SOURCE_INTS

		if (
			source < 0 ||
			page.sourceInts[at + SourceInt.REGION] !== this.region ||
			page.sourceInts[at + SourceInt.STORY] !== this.story.story.story.index
		)
			return -1

		return source
	}

	// Drops what was found in an earlier document.
	private current(): void {
		const doc = this.story.document

		if (doc === this.locatedIn) return

		this.locatedIn = doc
		this.ranges = new WeakMap()
		this.locatedOn = new WeakMap()
	}

	private located(page: PageDisplayList, source: number): Located | undefined {
		this.current()

		let values = this.locatedOn.get(page)

		if (values === undefined) {
			values = []
			this.locatedOn.set(page, values)
		}

		const cached = values[source]

		if (cached !== undefined) return cached ?? undefined

		const found = this.story.paragraphOf(page.sourceParts[source] ?? -1, page.sourceInts[source * SOURCE_INTS + SourceInt.ITEM] ?? -1)
		const located = found === undefined ? undefined : { pos: found.pos, node: found.node, shadow: found.shadow, part: found.layoutPart }

		values[source] = located ?? null

		return located
	}

	private mapOf(page: PageDisplayList, source: number, located: Located): OffsetMap {
		const pool = page.sourceMapPool
		const start = page.sourceMapRanges[source * 2] ?? 0
		const end = page.sourceMapRanges[source * 2 + 1] ?? 0
		const text = page.sourceTexts[source] ?? ""
		const cached = this.maps.get(located.node)

		if (cached !== undefined && cached.text === text && cached.shadow === located.shadow) {
			if (cached.pool === pool && cached.start === start) return cached.result

			// A page laid out again holds its paragraphs' maps in a new pool: one equal to the old is the same map.
			if (sameRange(cached.pool, cached.start, cached.end, pool, start, end)) {
				cached.pool = pool
				cached.start = start
				cached.end = end

				return cached.result
			}
		}

		const item = located.shadow.attrs["src"]
		const result = offsetMap(located.node, located.shadow, located.part, typeof item === "number" ? item : -1, text, {
			pool: end > start ? pool : undefined,
			start,
			end
		})

		this.maps.set(located.node, { pool, start, end, text, shadow: located.shadow, result })

		return result
	}

	// The textblock holding `pos` (its position) in the story's document, or the nearest one after it.
	private textblock(pos: number): { node: Node; pos: number } | undefined {
		const doc = this.story.document
		const clamped = Math.max(0, Math.min(pos, doc.content.size))
		const $pos = doc.resolve(clamped)

		if ($pos.parent.isTextblock) return { node: $pos.parent, pos: $pos.before() }

		let found: { node: Node; pos: number } | undefined

		doc.nodesBetween(clamped, doc.content.size, (node, at) => {
			if (found !== undefined) return false

			if (node.isTextblock) {
				found = { node, pos: at }

				return false
			}

			return true
		})

		return found
	}

	// A line of the paragraph at `block` on the pages shown: its page, source and located paragraph.
	private sourceOf(block: { node: Node; pos: number }): { page: PageDisplayList; source: number; located: Located } | undefined {
		const key = this.story.keyOf(block.pos, block.node)
		const entry = this.story.entries[this.story.entryAt(block.pos)]

		if (key === undefined || entry === undefined) return undefined

		for (const index of this.index.pagesOf(entry)) {
			const page = this.pages.page(index)

			if (page === undefined) continue

			for (let source = 0; source < page.sourceCount; source++) {
				const at = source * SOURCE_INTS

				if (
					page.sourceParts[source] !== key.part ||
					page.sourceInts[at + SourceInt.ITEM] !== key.item ||
					page.sourceInts[at + SourceInt.REGION] !== this.region ||
					page.sourceInts[at + SourceInt.STORY] !== this.story.story.story.index
				)
					continue

				const located = this.located(page, source)

				if (located !== undefined) return { page, source, located }
			}
		}

		return undefined
	}

	// The story positions page `pageIndex` shows: from its first paragraph's start to its last's end, or
	// undefined when it shows none of the story.
	pageRange(pageIndex: number): { readonly from: number; readonly to: number } | undefined {
		const page = this.pages.page(pageIndex)

		if (page === undefined) return undefined

		this.current()

		const cached = this.ranges.get(page)

		if (cached !== undefined) return cached.range

		const text = page.text
		let from = Infinity
		let to = -Infinity
		let previous = -1

		for (let line = 0; line < text.lineCount; line++) {
			const source = this.storyLine(page, line)

			if (source < 0 || source === previous) continue

			previous = source

			const located = this.located(page, source)

			if (located === undefined) continue

			from = Math.min(from, located.pos)
			to = Math.max(to, located.pos + located.node.nodeSize)
		}

		const range = from === Infinity ? undefined : { from, to }

		this.ranges.set(page, { range })

		return range
	}

	// The text a list marker draws before the paragraph holding `pos` ("1.\t"), or "" (none, or not laid out).
	markerText(pos: number): string {
		const block = this.textblock(pos)
		const found = block === undefined ? undefined : this.sourceOf(block)

		if (found === undefined) return ""

		const start = this.mapOf(found.page, found.source, found.located).toLayout[0] ?? 0

		return start > 0 ? (found.page.sourceTexts[found.source] ?? "").slice(0, start) : ""
	}

	// ---- positions -> boxes -------------------------------------------------------------------------------

	// Where position `pos` is drawn (with `affinity` choosing between a line's end and the next line's start).
	locate(pos: number, affinity: Affinity = 1): CaretBox | undefined {
		const block = this.textblock(pos)

		if (block === undefined) return undefined

		const key = this.story.keyOf(block.pos, block.node)
		const entry = this.story.entries[this.story.entryAt(block.pos)]

		if (key === undefined || entry === undefined) return undefined

		const offset = Math.max(0, Math.min(pos - block.pos - 1, block.node.content.size))
		let fallback: CaretBox | undefined

		const pages = this.index.pagesOf(entry)
		const order = this.preferred >= 0 && pages.includes(this.preferred) ? [this.preferred, ...pages] : pages

		for (const index of order) {
			const page = this.pages.page(index)

			if (page === undefined) continue

			const text = page.text

			for (let line = 0; line < text.lineCount; line++) {
				const source = this.storyLine(page, line)

				if (
					source < 0 ||
					page.sourceParts[source] !== key.part ||
					page.sourceInts[source * SOURCE_INTS + SourceInt.ITEM] !== key.item
				)
					continue

				const located = this.located(page, source)

				if (located === undefined) continue

				const at = this.mapOf(page, source, located).toLayout[offset] ?? 0
				const start = text.lineInts[line * LINE_INTS + LineInt.TEXT_START] ?? 0
				const end = text.lineInts[line * LINE_INTS + LineInt.TEXT_END] ?? 0
				const flags = text.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0

				if (at < start || at > end) continue

				const box = this.box(page, line, at)

				if (at < end || (flags & LineFlag.LAST) !== 0 || affinity < 0) return box

				fallback ??= box
			}
		}

		return fallback
	}

	private box(page: PageDisplayList, line: number, at: number): CaretBox {
		const text = page.text
		const source = text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1

		return {
			page: page.index,
			line,
			x: this.tester.xAtOffset(text, line, page.sourceTexts[source] ?? "", at),
			top: text.lineFloats[line * LINE_FLOATS + LineFloat.TOP] ?? 0,
			height: text.lineFloats[line * LINE_FLOATS + LineFloat.HEIGHT] ?? 0,
			rtl: ((text.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0) & LineFlag.RTL) !== 0
		}
	}

	// ---- points -> positions ------------------------------------------------------------------------------

	// The position under page point (x, y): on the story's line nearest to it.
	hitTest(pageIndex: number, x: number, y: number): HitResult | undefined {
		const page = this.pages.page(pageIndex)

		if (page === undefined) return undefined

		const text = page.text
		let best = -1
		let distance = Infinity

		for (let line = 0; line < text.lineCount; line++) {
			if (this.storyLine(page, line) < 0) continue

			const top = text.lineFloats[line * LINE_FLOATS + LineFloat.TOP] ?? 0
			const height = text.lineFloats[line * LINE_FLOATS + LineFloat.HEIGHT] ?? 0
			const left = text.lineFloats[line * LINE_FLOATS + LineFloat.X] ?? 0
			const width = text.lineFloats[line * LINE_FLOATS + LineFloat.WIDTH] ?? 0
			const dy = y < top ? top - y : y > top + height ? y - top - height : 0
			const dx = x < left ? left - x : x > left + width ? x - left - width : 0
			const d = dy * 1000 + dx

			if (d < distance) {
				distance = d
				best = line
			}
		}

		return best < 0 ? undefined : this.atLine(page, best, x)
	}

	// The position at x on `line` of `page`.
	atLine(page: PageDisplayList, line: number, x: number): HitResult | undefined {
		const source = this.storyLine(page, line)

		if (source < 0) return undefined

		const text = page.text
		const content = page.sourceTexts[source] ?? ""
		const at = this.tester.offsetAtX(text, line, content, x)
		const located = this.located(page, source)

		if (located === undefined) {
			// A paragraph the editor has no node for (inside a locked block): the block itself.
			const entry = this.story.entryOf(page.sourceParts[source] ?? -1, page.sourceInts[source * SOURCE_INTS + SourceInt.ITEM] ?? -1)

			return entry === undefined
				? undefined
				: { pos: this.story.starts[entry.index] ?? 0, affinity: 1, page: page.index, line, atom: true }
		}

		const map = this.mapOf(page, source, located)
		const end = text.lineInts[line * LINE_INTS + LineInt.TEXT_END] ?? 0
		const flags = text.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0

		return {
			pos: located.pos + 1 + (map.toPm[at] ?? 0),
			affinity: at === end && (flags & LineFlag.LAST) === 0 ? -1 : 1,
			page: page.index,
			line,
			atom: false
		}
	}

	// ---- motion -------------------------------------------------------------------------------------------

	// The position one line down (dir 1) or up (-1) from `pos`, nearest to `goalX`; undefined at the story's
	// ends.
	verticalMove(pos: number, affinity: Affinity, goalX: number, dir: 1 | -1): HitResult | undefined {
		const caret = this.locate(pos, affinity)

		if (caret === undefined) return undefined

		let page = this.pages.page(caret.page)
		let index = caret.page

		if (page === undefined) return undefined

		const next = this.nextLine(page, caret.line, goalX, dir)

		if (next >= 0) return this.atLine(page, next, goalX)

		// The first (last) line of the next (previous) page with a line of the story.
		for (;;) {
			index += dir
			page = this.pages.page(index)

			if (page === undefined) return undefined

			const edge = this.edgeLine(page, dir, goalX)

			if (edge >= 0) return this.atLine(page, edge, goalX)
		}
	}

	// The column `line` of `page` stands in (a text column, or a table's column of cells): the x extent of
	// the story's lines overlapping it, joined with lines beside it unless they stand side by side with it.
	columnBox(page: PageDisplayList, line: number): ColumnBox {
		const columns = this.columnsOf(page)
		const box = columns.boxes[columns.group[line] ?? -1]

		if (box !== undefined) return box

		const x = page.text.lineFloats[line * LINE_FLOATS + LineFloat.X] ?? 0

		return { left: x, right: x + (page.text.lineFloats[line * LINE_FLOATS + LineFloat.WIDTH] ?? 0) }
	}

	// The story's lines of a page grouped into columns, apart for lines in and out of tables: lines whose x
	// extents overlap are one column, and neighbouring groups too unless some of their lines are level with
	// each other (columns stand side by side; a short line alone, centred, is in the column around it).
	private columnsOf(page: PageDisplayList): { group: Int32Array; boxes: ColumnBox[] } {
		const cached = this.columns.get(page)

		if (cached !== undefined) return cached

		const text = page.text
		const floats = text.lineFloats
		const group = new Int32Array(text.lineCount).fill(-1)
		const boxes: ColumnBox[] = []
		const left = (line: number): number => floats[line * LINE_FLOATS + LineFloat.X] ?? 0
		const right = (line: number): number => left(line) + (floats[line * LINE_FLOATS + LineFloat.WIDTH] ?? 0)
		const level = (a: readonly number[], b: readonly number[]): boolean =>
			a.some(one => {
				const top = floats[one * LINE_FLOATS + LineFloat.TOP] ?? 0
				const bottom = top + (floats[one * LINE_FLOATS + LineFloat.HEIGHT] ?? 0)

				return b.some(other => {
					const otherTop = floats[other * LINE_FLOATS + LineFloat.TOP] ?? 0

					return otherTop < bottom - 0.5 && otherTop + (floats[other * LINE_FLOATS + LineFloat.HEIGHT] ?? 0) > top + 0.5
				})
			})
		const close = (column: { left: number; right: number; lines: number[] }): void => {
			for (const line of column.lines) group[line] = boxes.length

			boxes.push({ left: column.left, right: column.right })
		}

		for (const inTable of [false, true]) {
			const lines: number[] = []

			for (let line = 0; line < text.lineCount; line++) {
				if (this.storyLine(page, line) >= 0 && this.inTable(page, line) === inTable) lines.push(line)
			}

			lines.sort((a, b) => left(a) - left(b))

			const overlapping: { left: number; right: number; lines: number[] }[] = []

			for (const line of lines) {
				const last = overlapping[overlapping.length - 1]

				if (last !== undefined && left(line) <= last.right + 1) {
					last.right = Math.max(last.right, right(line))
					last.lines.push(line)
				} else {
					overlapping.push({ left: left(line), right: right(line), lines: [line] })
				}
			}

			let current: { left: number; right: number; lines: number[] } | undefined

			for (const next of overlapping) {
				if (current === undefined) {
					current = next
				} else if (level(current.lines, next.lines)) {
					close(current)
					current = next
				} else {
					current.right = Math.max(current.right, next.right)
					appendAll(current.lines, next.lines)
				}
			}

			if (current !== undefined) close(current)
		}

		const columns = { group, boxes }

		this.columns.set(page, columns)

		return columns
	}

	private inTable(page: PageDisplayList, line: number): boolean {
		const source = page.text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1

		return ((page.sourceInts[source * SOURCE_INTS + SourceInt.FLAGS] ?? 0) & SourceFlag.IN_TABLE) !== 0
	}

	// The story line below (above) `line` on `page`: the nearest by y in its column (x nearest to goalX
	// among lines level with each other), else the top (bottom) line of the next (previous) text column.
	private nextLine(page: PageDisplayList, line: number, goalX: number, dir: 1 | -1): number {
		const text = page.text
		const top = text.lineFloats[line * LINE_FLOATS + LineFloat.TOP] ?? 0
		const height = text.lineFloats[line * LINE_FLOATS + LineFloat.HEIGHT] ?? 0
		const { left, right } = this.columnBox(page, line)
		const inTable = this.inTable(page, line)
		let best = -1
		let bestDy = Infinity
		let bestDx = Infinity
		let column = -1
		let columnScore = Infinity

		for (let other = 0; other < text.lineCount; other++) {
			if (other === line || this.storyLine(page, other) < 0) continue

			const lineTop = text.lineFloats[other * LINE_FLOATS + LineFloat.TOP] ?? 0
			const lineHeight = text.lineFloats[other * LINE_FLOATS + LineFloat.HEIGHT] ?? 0
			const x = text.lineFloats[other * LINE_FLOATS + LineFloat.X] ?? 0
			const end = x + (text.lineFloats[other * LINE_FLOATS + LineFloat.WIDTH] ?? 0)

			if (end >= left - 1 && x <= right + 1) {
				const beyond = dir > 0 ? lineTop >= top + height - 0.5 : lineTop + lineHeight <= top + 0.5

				if (!beyond) continue

				const dy = dir > 0 ? lineTop - top : top - lineTop
				const dx = goalX < x ? x - goalX : goalX > end ? goalX - end : 0

				if (dy < bestDy - 0.5 || (dy <= bestDy + 0.5 && dx < bestDx)) {
					bestDy = dy
					bestDx = dx
					best = other
				}
			} else if (!inTable && !this.inTable(page, other) && (dir > 0 ? x > right + 1 : end < left - 1)) {
				// Another text column, in the direction of motion.
				const score = (dir > 0 ? lineTop : -lineTop) * 1000 + Math.abs(x - goalX)

				if (score < columnScore) {
					columnScore = score
					column = other
				}
			}
		}

		return best >= 0 ? best : column
	}

	private edgeLine(page: PageDisplayList, dir: 1 | -1, goalX: number): number {
		const text = page.text
		let best = -1
		let bestScore = Infinity

		for (let line = 0; line < text.lineCount; line++) {
			if (this.storyLine(page, line) < 0) continue

			const top = text.lineFloats[line * LINE_FLOATS + LineFloat.TOP] ?? 0
			const height = text.lineFloats[line * LINE_FLOATS + LineFloat.HEIGHT] ?? 0
			const x = text.lineFloats[line * LINE_FLOATS + LineFloat.X] ?? 0
			const width = text.lineFloats[line * LINE_FLOATS + LineFloat.WIDTH] ?? 0
			const dx = goalX < x ? x - goalX : goalX > x + width ? goalX - x - width : 0
			// Down: the top line (first column); up: the bottom line (last column).
			const score = (dir > 0 ? top : -(top + height)) * 1000 + (dir > 0 ? x : -x) * 0.001 + dx * 1e-6

			if (score < bestScore) {
				bestScore = score
				best = line
			}
		}

		return best
	}

	// The start (dir -1) or end (1) of the line `pos` is drawn on.
	lineBoundary(pos: number, affinity: Affinity, dir: 1 | -1): HitResult | undefined {
		const caret = this.locate(pos, affinity)
		const page = caret === undefined ? undefined : this.pages.page(caret.page)

		if (caret === undefined || page === undefined) return undefined

		const text = page.text
		const line = caret.line
		const source = this.storyLine(page, line)
		const located = source < 0 ? undefined : this.located(page, source)

		if (located === undefined) return undefined

		const map = this.mapOf(page, source, located)
		const start = text.lineInts[line * LINE_INTS + LineInt.TEXT_START] ?? 0
		const end = text.lineInts[line * LINE_INTS + LineInt.TEXT_END] ?? 0
		const last = ((text.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0) & LineFlag.LAST) !== 0
		const at = dir < 0 ? start : end

		return {
			pos: located.pos + 1 + (map.toPm[at] ?? 0),
			affinity: dir > 0 && !last ? -1 : 1,
			page: page.index,
			line,
			atom: false
		}
	}

	// Whether a line wraps at `pos` (it ends one line and starts the next).
	wrapsAt(pos: number): boolean {
		const before = this.locate(pos, -1)
		const after = this.locate(pos, 1)

		return before !== undefined && after !== undefined && (before.page !== after.page || before.line !== after.line)
	}

	// The caret one step left (dir -1) or right (1) on screen along a line with right-to-left text, or
	// undefined at the line's visual edge or on a line with none (logical order is visual order there).
	visualMove(pos: number, affinity: Affinity, dir: 1 | -1): HitResult | undefined {
		const caret = this.locate(pos, affinity)
		const page = caret === undefined ? undefined : this.pages.page(caret.page)

		if (caret === undefined || page === undefined) return undefined

		const text = page.text
		const line = caret.line

		if (!hasRightToLeft(text, line)) return undefined

		const source = this.storyLine(page, line)
		const located = source < 0 ? undefined : this.located(page, source)

		if (located === undefined) return undefined

		const map = this.mapOf(page, source, located)
		const content = page.sourceTexts[source] ?? ""
		const start = text.lineInts[line * LINE_INTS + LineInt.TEXT_START] ?? 0
		const end = text.lineInts[line * LINE_INTS + LineInt.TEXT_END] ?? 0
		const last = ((text.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0) & LineFlag.LAST) !== 0
		const current = pos - located.pos - 1
		let best = -1
		let bestX = dir > 0 ? Infinity : -Infinity

		for (let at = start; at <= end; at = at < end ? nextCluster(content, at, end) : end + 1) {
			const target = map.toPm[at] ?? 0

			if (target === current) continue

			const x = this.tester.xAtOffset(text, line, content, at)

			if (dir > 0 ? x > caret.x + 0.5 && x < bestX : x < caret.x - 0.5 && x > bestX) {
				bestX = x
				best = at
			}
		}

		if (best < 0) return undefined

		return {
			pos: located.pos + 1 + (map.toPm[best] ?? 0),
			affinity: best === end && !last ? -1 : 1,
			page: page.index,
			line,
			atom: false
		}
	}

	// ---- selection ----------------------------------------------------------------------------------------

	// Boxes covering [from, to) on page `pageIndex`, per line and, on lines with right-to-left text, per
	// fragment; a selection running past a line's end covers the rest of the line (and the paragraph mark).
	rects(from: number, to: number, pageIndex: number, out: PageRect[] = []): PageRect[] {
		const page = this.pages.page(pageIndex)

		if (page === undefined || to < from) return out

		const text = page.text

		for (let line = 0; line < text.lineCount; line++) {
			const source = this.storyLine(page, line)

			if (source < 0) continue

			const located = this.located(page, source)

			if (located === undefined) continue

			const content = located.pos + 1
			const size = located.node.content.size

			// Cheap reject before mapping: the paragraph is outside the range.
			if (content + size < from || content > to) continue

			const map = this.mapOf(page, source, located)
			const start = text.lineInts[line * LINE_INTS + LineInt.TEXT_START] ?? 0
			const end = text.lineInts[line * LINE_INTS + LineInt.TEXT_END] ?? 0
			const flags = text.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0
			const last = (flags & LineFlag.LAST) !== 0
			const lineFrom = content + (map.toPm[start] ?? 0)
			const lineTo = last ? content + size : content + (map.toPm[end] ?? 0)

			if (lineTo < from || lineFrom > to || (lineTo === from && from !== to && !last) || (from === to && from !== lineFrom)) continue

			const a = Math.max(from, lineFrom)
			const b = Math.min(to, lineTo)
			const la = map.toLayout[a - content] ?? start
			const lb = map.toLayout[b - content] ?? end
			// The selection continues past this line (its paragraph mark included at a paragraph's end).
			const past = to > lineTo || (last && to > content + size)

			this.lineRects(page, line, la, lb, past, last, out)
		}

		return out
	}

	// rects() of many ranges at once (marks), in one pass over the page's lines: `ranges` sorted by `from`,
	// none longer than `longest`. Each box goes to `out`, the index of its range to `owners`.
	rangesRects(
		ranges: readonly { readonly from: number; readonly to: number }[],
		longest: number,
		pageIndex: number,
		out: PageRect[] = [],
		owners: number[] = []
	): PageRect[] {
		const boxes = new MarkBoxes()

		this.rangesBoxes(ranges, longest, pageIndex, boxes)

		for (let b = 0; b < boxes.count; b++) {
			const at = b * 4

			out.push({
				page: pageIndex,
				x: boxes.values[at + 2] ?? 0,
				y: boxes.values[at] ?? 0,
				width: boxes.values[at + 3] ?? 0,
				height: boxes.values[at + 1] ?? 0
			})
			owners.push(boxes.owners[b] ?? -1)
		}

		return out
	}

	// rangesRects() as numbers (see MarkBoxes), added to `out`: for drawing many marks on each keystroke
	// without an object per box.
	rangesBoxes(
		ranges: readonly { readonly from: number; readonly to: number }[],
		longest: number,
		pageIndex: number,
		out: MarkBoxes
	): void {
		const page = this.pages.page(pageIndex)

		if (page === undefined || ranges.length === 0) return

		const text = page.text

		if (this.lineBoxesCount > LINE_BOXES_LIMIT) {
			this.lineBoxes.clear()
			this.lineBoxesCount = 0
		}

		for (let line = 0; line < text.lineCount; line++) {
			const source = this.storyLine(page, line)

			if (source < 0) continue

			const located = this.located(page, source)

			if (located === undefined) continue

			const content = located.pos + 1
			const size = located.node.content.size
			let k = firstFrom(ranges, content - longest)

			// Cheap reject before mapping: no range reaches the paragraph.
			if (k >= ranges.length || (ranges[k]?.from ?? 0) > content + size) continue

			const map = this.mapOf(page, source, located)
			const start = text.lineInts[line * LINE_INTS + LineInt.TEXT_START] ?? 0
			const end = text.lineInts[line * LINE_INTS + LineInt.TEXT_END] ?? 0
			const flags = text.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0
			const last = (flags & LineFlag.LAST) !== 0
			const lineFrom = content + (map.toPm[start] ?? 0)
			const lineTo = last ? content + size : content + (map.toPm[end] ?? 0)
			const top = text.lineFloats[line * LINE_FLOATS + LineFloat.TOP] ?? 0
			const height = text.lineFloats[line * LINE_FLOATS + LineFloat.HEIGHT] ?? 0
			let memo: LineMemo | undefined

			for (k = firstFrom(ranges, lineFrom - longest); k < ranges.length; k++) {
				const range = ranges[k]

				if (range === undefined) continue

				const { from, to } = range

				if (from > lineTo) break
				// As rects() decides for one range.
				if (to < from || content + size < from || content > to) continue
				if (lineTo < from || lineFrom > to || (lineTo === from && from !== to && !last) || (from === to && from !== lineFrom))
					continue

				const a = Math.max(from, lineFrom)
				const b = Math.min(to, lineTo)
				const la = (map.toLayout[a - content] ?? start) - start
				const lb = (map.toLayout[b - content] ?? end) - start
				const past = to > lineTo || (last && to > content + size)

				memo ??= this.lineMemo(page, line)

				let boxes: Float64Array | undefined

				for (let p = 0; p < memo.parts.length && boxes === undefined; p++) {
					const part = memo.parts[p]

					if (part?.from === la && part.to === lb && part.past === past) boxes = part.boxes
				}

				if (boxes === undefined) {
					const drawn = this.rectsScratch

					drawn.length = 0
					this.lineRects(page, line, la + start, lb + start, past, last, drawn)
					boxes = new Float64Array(drawn.length * 2)

					for (let at = 0; at < drawn.length; at++) {
						boxes[at * 2] = drawn[at]?.x ?? 0
						boxes[at * 2 + 1] = drawn[at]?.width ?? 0
					}

					memo.parts.push({ from: la, to: lb, past, boxes })
				}

				for (let at = 0; at + 1 < boxes.length; at += 2) {
					// Written in place: numbers passed to a call would each be allocated.
					const box = 4 * out.add(k)
					const values = out.values

					values[box] = top
					values[box + 1] = height
					values[box + 2] = boxes[at] ?? 0
					values[box + 3] = boxes[at + 1] ?? 0
				}
			}
		}
	}

	// What `line` measured before (or a new record): found by its identity and text.
	private lineMemo(page: PageDisplayList, line: number): LineMemo {
		const count = this.lineIdentity(page, line)
		const identity = this.identity
		const source = page.text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1
		const text = page.sourceTexts[source] ?? ""
		const low = this.identityLow
		const high = this.identityHigh
		let hash = 2166136261

		// FNV-1a over the numbers' bits and the text.
		for (let k = 0; k < count; k++) {
			HASH_BITS[0] = identity[k] ?? 0
			hash = Math.imul(Math.imul(hash ^ (HASH_WORDS[0] ?? 0), 16777619) ^ (HASH_WORDS[1] ?? 0), 16777619)
		}

		for (let k = low; k < high; k++) hash = Math.imul(hash ^ text.charCodeAt(k), 16777619)

		// A small integer: a key that allocates nothing.
		hash &= 0x3fffffff

		const first = this.lineBoxes.get(hash)

		for (let memo = first; memo !== undefined; memo = memo.next) {
			if (memo.identity.length !== count || memo.text.length !== high - low) continue

			let same = true

			for (let k = 0; k < count && same; k++) same = memo.identity[k] === identity[k]
			for (let k = 0; k < high - low && same; k++) same = memo.text.charCodeAt(k) === text.charCodeAt(low + k)

			if (same) return memo
		}

		const memo: LineMemo = { identity: identity.slice(0, count), text: text.slice(low, high), parts: [], next: first }

		this.lineBoxes.set(hash, memo)
		this.lineBoxesCount++

		return memo
	}

	// Writes what decides where marks on `line` are drawn across it into `identity` (its box, flags and
	// fragments, offsets relative to its text start) and returns how many numbers; the text it covers is
	// [identityLow, identityHigh) of its source's text. Lines with equal identities and text measure alike,
	// wherever they are.
	private lineIdentity(page: PageDisplayList, line: number): number {
		const text = page.text
		const ints = line * LINE_INTS
		const floats = line * LINE_FLOATS
		const first = text.lineInts[ints + LineInt.FIRST_FRAGMENT] ?? 0
		const count = text.lineInts[ints + LineInt.FRAGMENT_COUNT] ?? 0
		const start = text.lineInts[ints + LineInt.TEXT_START] ?? 0
		const size = 6 + count * (FRAGMENT_INTS + FRAGMENT_FLOATS)
		let low = start
		let high = text.lineInts[ints + LineInt.TEXT_END] ?? 0

		if (this.identity.length < size) this.identity = new Float64Array(Math.max(size, this.identity.length * 2))

		const out = this.identity
		let n = 0

		out[n++] = text.lineFloats[floats + LineFloat.X] ?? 0
		out[n++] = text.lineFloats[floats + LineFloat.WIDTH] ?? 0
		out[n++] = text.lineFloats[floats + LineFloat.HEIGHT] ?? 0
		out[n++] = text.lineInts[ints + LineInt.FLAGS] ?? 0
		out[n++] = high - start

		for (let f = first; f < first + count; f++) {
			const fi = f * FRAGMENT_INTS
			const ff = f * FRAGMENT_FLOATS
			const fragmentStart = text.fragmentInts[fi] ?? 0
			const fragmentEnd = text.fragmentInts[fi + 1] ?? 0

			low = Math.min(low, fragmentStart)
			high = Math.max(high, fragmentEnd)
			out[n++] = fragmentStart - start
			out[n++] = fragmentEnd - start

			for (let k = 2; k < FRAGMENT_INTS; k++) out[n++] = text.fragmentInts[fi + k] ?? 0
			for (let k = 0; k < FRAGMENT_FLOATS; k++) out[n++] = text.fragmentFloats[ff + k] ?? 0
		}

		out[n++] = low - start
		this.identityLow = low
		this.identityHigh = high

		return n
	}

	private lineRects(page: PageDisplayList, line: number, la: number, lb: number, past: boolean, last: boolean, out: PageRect[]): void {
		const text = page.text
		const source = text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1
		const content = page.sourceTexts[source] ?? ""
		const top = text.lineFloats[line * LINE_FLOATS + LineFloat.TOP] ?? 0
		const height = text.lineFloats[line * LINE_FLOATS + LineFloat.HEIGHT] ?? 0
		const lineX = text.lineFloats[line * LINE_FLOATS + LineFloat.X] ?? 0
		const lineEnd = lineX + (text.lineFloats[line * LINE_FLOATS + LineFloat.WIDTH] ?? 0)
		const flags = text.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0
		const rtl = (flags & LineFlag.RTL) !== 0
		const first = text.lineInts[line * LINE_INTS + LineInt.FIRST_FRAGMENT] ?? 0
		const count = text.lineInts[line * LINE_INTS + LineInt.FRAGMENT_COUNT] ?? 0
		const mixed = hasRightToLeft(text, line)

		const push = (x0: number, x1: number): void => {
			const left = Math.min(x0, x1)
			const right = Math.max(x0, x1)

			if (right - left > 0.01) out.push({ page: page.index, x: left, y: top, width: right - left, height })
		}

		if (!mixed) {
			const x0 = this.tester.xAtOffset(text, line, content, la)
			const x1 = this.tester.xAtOffset(text, line, content, lb)

			push(x0, past ? Math.max(x1, lineEnd) + (last ? MARK_WIDTH : 0) : x1)

			return
		}

		for (let f = first; f < first + count; f++) {
			const fs = text.fragmentInts[f * FRAGMENT_INTS] ?? 0
			const fe = text.fragmentInts[f * FRAGMENT_INTS + 1] ?? 0
			const s = Math.max(fs, la)
			const e = Math.min(fe, lb)

			if (e <= s) continue

			push(this.tester.xAtOffset(text, line, content, s), this.tester.xAtOffset(text, line, content, e))
		}

		// Past the end of a right-to-left line: its left edge.
		if (past) push(rtl ? lineX - (last ? MARK_WIDTH : 0) : lineEnd, rtl ? lineX : lineEnd + (last ? MARK_WIDTH : 0))
	}

	// ---- words and paragraphs -----------------------------------------------------------------------------

	// The word around `pos` (Intl.Segmenter word boundaries over the paragraph's text; atoms count as one
	// character each), or the position itself when there is none.
	wordRange(pos: number): { from: number; to: number } {
		const block = this.textblock(pos)

		if (block === undefined) return { from: pos, to: pos }

		const node = block.node
		const content = block.pos + 1
		const text = node.textBetween(0, node.content.size, undefined, "￼")
		const offset = Math.max(0, Math.min(pos - content, text.length))
		const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter

		if (Segmenter !== undefined) {
			for (const segment of new Segmenter(undefined, { granularity: "word" }).segment(text)) {
				const end = segment.index + segment.segment.length

				if (offset >= segment.index && (offset < end || (offset === end && end === text.length))) {
					return { from: content + segment.index, to: content + end }
				}
			}

			return { from: pos, to: pos }
		}

		let from = offset
		let to = offset

		while (from > 0 && /[\p{L}\p{N}_]/u.test(text.charAt(from - 1))) from--
		while (to < text.length && /[\p{L}\p{N}_]/u.test(text.charAt(to))) to++

		return { from: content + from, to: content + to }
	}

	paragraphRange(pos: number): { from: number; to: number } {
		const block = this.textblock(pos)

		return block === undefined ? { from: pos, to: pos } : { from: block.pos + 1, to: block.pos + 1 + block.node.content.size }
	}
}

function sameRange(a: Int32Array, aStart: number, aEnd: number, b: Int32Array, bStart: number, bEnd: number): boolean {
	if (aEnd - aStart !== bEnd - bStart) return false

	for (let k = 0; k < aEnd - aStart; k++) if (a[aStart + k] !== b[bStart + k]) return false

	return true
}

// Whether `line` is right to left or holds right-to-left text.
function hasRightToLeft(text: TextLayout, line: number): boolean {
	if (((text.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0) & LineFlag.RTL) !== 0) return true

	const first = text.lineInts[line * LINE_INTS + LineInt.FIRST_FRAGMENT] ?? 0
	const count = text.lineInts[line * LINE_INTS + LineInt.FRAGMENT_COUNT] ?? 0

	for (let f = first; f < first + count; f++) {
		if ((((text.fragmentInts[f * FRAGMENT_INTS + 3] ?? 0) >> FRAGMENT_LEVEL_SHIFT) & 1) === 1) return true
	}

	return false
}

// The first range whose `from` is at least `pos` (ranges sorted by `from`).
function firstFrom(ranges: readonly { readonly from: number }[], pos: number): number {
	let low = 0
	let high = ranges.length

	while (low < high) {
		const middle = (low + high) >> 1

		if ((ranges[middle]?.from ?? 0) < pos) low = middle + 1
		else high = middle
	}

	return low
}

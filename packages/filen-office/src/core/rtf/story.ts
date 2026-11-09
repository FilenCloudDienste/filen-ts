import { inflateSync } from "fflate"
import { crc32 } from "../opc/crc32"
import { SyncDeflate, type DeflatedPiece } from "../opc/zipWriter"
import { escapeText } from "../xml/index"
import { borderXml, clamp, newRow, shadingConflict, shadingXml, type CellDef, type PropsContext, type RowDef } from "./props"

// One story (the body, a header, a footnote...) as WordprocessingML blocks: paragraphs are assembled from
// runs as the reader meets them, and table rows are collected per nesting depth (\itapN) and laid on a
// shared grid when the table ends. Each paragraph keeps the source byte range it was read from. A finished
// paragraph's markup is held as UTF-8 in its story's XmlStore, not as a string.

// Footnote, endnote and comment references are written as markers (NUL, a kind letter, a value, NUL) the
// package resolves when it is written; NUL never reaches text (escaping replaces it).
export const MARK = String.fromCharCode(0)

export interface Paragraph {
	readonly kind: "p"
	// The paragraph's markup: `size` bytes at `at` in `store`.
	readonly store: XmlStore
	readonly at: number
	readonly size: number
	// No content (a w:p with properties at most).
	readonly blank: boolean
	// Holds markers.
	readonly marked: boolean
	// Source bytes [start, end) from the paragraph's first content to the end of the word ending it (\\par,
	// \\cell, \\sect...), which starts at `term`. [from, start) is what came between the previous block of the
	// story and this one (its properties, destinations, row definitions).
	readonly from: number
	readonly start: number
	readonly term: number
	// Past a {\\nonesttables ...} group right after the word (Story.extend).
	end: number
}

export interface Table {
	readonly kind: "tbl"
	readonly rows: Row[]
}

export type Block = Paragraph | Table

interface Row {
	readonly def: RowDef
	readonly cells: Block[][]
	// Source bytes [from, end): from the end of the block before the row to the end of its \\row (or of its
	// last paragraph, `closed` false, when no \\row ended it).
	readonly from: number
	// Past the {\\*\\nesttableprops ... \\nestrow} destination ending a nested row (Story.extend).
	end: number
	readonly closed: boolean
}

interface OpenTable {
	readonly table: Table
	cells: Block[][]
	current: Block[]
	// Where the open row's source begins (-1 until its first block).
	rowFrom: number
}

export interface StoryContext extends PropsContext {
	readonly xmlBudget: XmlBudget
	nextId(): number
	// A paragraph's source [start, end) holds words the translation cannot hold: written from its translation,
	// it would lose them.
	unread(names: string, start: number, end: number): void
}

// Where the blocks of a story's WordprocessingML came from in the source, element for element: what the RTF
// writer copies for a block it keeps and splices around one it writes.
export type SourceBlock = SourceParagraph | SourceTable

export interface SourceParagraph {
	readonly kind: "p"
	// -1 for a paragraph the translation added (a cell or story must end with one).
	readonly from: number
	readonly start: number
	readonly term: number
	readonly end: number
}

export interface SourceTable {
	readonly kind: "tbl"
	readonly from: number
	readonly end: number
	readonly rows: readonly SourceRow[]
}

export interface SourceRow {
	readonly from: number
	readonly end: number
	readonly closed: boolean
	// Cells horizontally merged (\\clmrg) into the one before: the row's cells are not the source's.
	readonly merged: boolean
	// Words of its definition the translation cannot hold (RowDef.unread): the row is kept as it is.
	readonly unread: string
	// Its \\trleftN and \\tblindN, \\tblindtypeN (RowDef.indent): what a row written into its table restates.
	readonly left: number
	readonly indent: number | undefined
	readonly indentType: number
	// Its \\tsN where the style sheet has no such table style (no w:tblStyle holds it), else -1.
	readonly danglingStyle: number
	readonly cells: readonly (readonly SourceBlock[])[]
}

const SYNTHETIC: SourceParagraph = { kind: "p", from: -1, start: -1, term: -1, end: -1 }

function blockFrom(block: Block): number {
	return block.kind === "p" ? block.from : (block.rows[0]?.from ?? -1)
}

function blockEnd(block: Block): number {
	return block.kind === "p" ? block.end : (block.rows.at(-1)?.end ?? -1)
}

// A relationship of the story's part (pictures, hyperlinks).
export interface PartRelationship {
	readonly id: string
	readonly type: string
	readonly target: string
	readonly external: boolean
}

// What text in a run is: plain text, field instructions, or either deleted.
export type TextKind = "t" | "instrText" | "delText" | "delInstrText"

// Tables past this many grid columns start a new table (layout cost grows with columns × rows).
const MAX_GRID = 512

// Markup is gathered into segments of about this many bytes; past the document's raw budget a sealed segment
// is deflated, so a long document holds its markup at a fraction of its size.
const SEGMENT = 256 * 1024
const RAW_BUDGET = 8 * 1024 * 1024
const encoder = new TextEncoder()

// Raw bytes the document's stores hold in sealed segments, against RAW_BUDGET.
export interface XmlBudget {
	raw: number
}

interface Segment {
	// Global offset of the segment's first byte.
	readonly start: number
	readonly size: number
	// Raw, or deflated (deflateSegment).
	readonly data: Uint8Array
	readonly deflated: boolean
	// CRC-32 of the raw bytes when deflated (0 otherwise).
	readonly crc: number
}

// An empty final block (fixed Huffman) after a sync flush.
const FINAL_EMPTY_BLOCK = [0x03, 0x00]

// Raw deflate ending in a sync flush, so the zip writer splices it into an entry's stream without inflating it,
// then an empty final block, so it also inflates on its own (the writer leaves those 2 bytes). Level 6: the
// package keeps these bytes for as long as the document is open, and fflate's level 1 holds about three times as
// much for little less work.
function deflateSegment(raw: Uint8Array): Uint8Array {
	const stream = new SyncDeflate(6)

	stream.push(raw)

	const { parts, size } = stream.end(false)
	const out = new Uint8Array(size + FINAL_EMPTY_BLOCK.length)
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	out.set(FINAL_EMPTY_BLOCK, at)

	return out
}

// Append-only UTF-8 markup, addressed by global offsets. Pieces never straddle segments.
export class XmlStore {
	private readonly segments: Segment[] = []
	private readonly budget: XmlBudget
	private pending: Uint8Array = new Uint8Array(0)
	private pendingLength = 0
	// Global offset of the pending segment.
	private pendingStart = 0
	// The last segment inflated for reading.
	private inflated: { readonly index: number; readonly bytes: Uint8Array } | undefined = undefined
	// Byte length of the last piece put.
	size = 0

	constructor(budget: XmlBudget) {
		this.budget = budget
	}

	// Appends `xml`; returns its offset (its length is `size`).
	put(xml: string): number {
		const most = xml.length * 3

		if (this.pendingLength > 0 && this.pendingLength + most > SEGMENT) this.seal()

		if (this.pendingLength + most > this.pending.length) {
			const grown = new Uint8Array(Math.max(this.pendingLength + most, Math.min(SEGMENT, this.pending.length * 2), 1024))

			grown.set(this.pending.subarray(0, this.pendingLength))
			this.pending = grown
		}

		const at = this.pendingStart + this.pendingLength
		const { written } = encoder.encodeInto(xml, this.pending.subarray(this.pendingLength))

		this.pendingLength += written
		this.size = written

		return at
	}

	private seal(): void {
		const raw = this.pending.subarray(0, this.pendingLength)
		const deflated = this.budget.raw + raw.length > RAW_BUDGET

		if (!deflated) this.budget.raw += raw.length

		this.segments.push({
			start: this.pendingStart,
			size: raw.length,
			data: deflated ? deflateSegment(raw) : raw.slice(),
			deflated,
			crc: deflated ? crc32(raw) : 0
		})
		this.pendingStart += this.pendingLength
		this.pendingLength = 0

		// One oversized piece does not keep its buffer.
		if (this.pending.length > SEGMENT * 2) this.pending = new Uint8Array(SEGMENT)
	}

	// Gives back the pending buffer's spare room (the story is finished).
	trim(): void {
		if (this.pending.length > this.pendingLength) this.pending = this.pending.slice(0, this.pendingLength)
	}

	// The bytes [at, at + size) of one piece or of consecutive pieces, a view per segment they lie in. Views of a
	// deflated segment are of a fresh inflated copy, never reused.
	*read(at: number, size: number): Generator<Uint8Array> {
		const end = at + size

		while (at < end) {
			const { bytes, start } = this.segmentAt(at)
			const stop = Math.min(end, start + bytes.length)

			yield bytes.subarray(at - start, stop - start)
			at = stop
		}
	}

	// The same bytes for a zip writer: a deflated segment wholly inside the range as it is held, the rest raw.
	*pieces(at: number, size: number): Generator<Uint8Array | DeflatedPiece> {
		const end = at + size

		while (at < end) {
			const segment = at < this.pendingStart ? this.segments[this.segmentIndex(at)] : undefined

			if (segment?.deflated === true && segment.start === at && segment.start + segment.size <= end) {
				yield {
					deflated: segment.data.subarray(0, segment.data.length - FINAL_EMPTY_BLOCK.length),
					crc: segment.crc,
					size: segment.size
				}
				at += segment.size

				continue
			}

			const { bytes, start } = this.segmentAt(at)
			const stop = Math.min(end, start + bytes.length)

			yield bytes.subarray(at - start, stop - start)
			at = stop
		}
	}

	// Drops what reading inflated.
	release(): void {
		this.inflated = undefined
	}

	private segmentIndex(at: number): number {
		let low = 0
		let high = this.segments.length - 1

		while (low < high) {
			const middle = (low + high + 1) >> 1

			if ((this.segments[middle] as Segment).start <= at) low = middle
			else high = middle - 1
		}

		return low
	}

	private segmentAt(at: number): { bytes: Uint8Array; start: number } {
		if (at >= this.pendingStart) return { bytes: this.pending.subarray(0, this.pendingLength), start: this.pendingStart }

		const low = this.segmentIndex(at)
		const segment = this.segments[low] as Segment

		if (!segment.deflated) return { bytes: segment.data, start: segment.start }
		if (this.inflated?.index !== low)
			this.inflated = { index: low, bytes: inflateSync(segment.data, { out: new Uint8Array(segment.size) }) }

		return { bytes: this.inflated.bytes, start: segment.start }
	}
}

// Where a part's markup goes as it is written: generated markup, and paragraphs held in their stores.
export interface XmlSink {
	text(xml: string): void
	paragraph(paragraph: Paragraph): void
}

export class Story {
	readonly blocks: Block[] = []
	readonly relationships: PartRelationship[] = []
	// Each picture's group in the source, by its relationship id.
	readonly pictures = new Map<string, { start: number; end: number }>()
	private readonly levels: OpenTable[] = []
	private readonly store: XmlStore
	// The paragraph being read: finished runs and wrappers, the open run, and the list label kept aside.
	private content = ""
	private runProps: string | undefined = undefined
	private runKind: TextKind = "t"
	private runInner = ""
	private runText = ""
	private openRevision = ""
	private label = ""
	private labelMode = false
	private beforeLabel = ""
	start = -1
	// The end of the story's last block: where the next block's source begins (-1 before the first).
	mark = -1
	// The last paragraph or row ended (Story.extend).
	private last: { end: number } | undefined = undefined

	// Words the open paragraph shows text under that the translation cannot hold (CharProps.unread).
	unread = ""

	readonly context: StoryContext

	constructor(context: StoryContext) {
		this.context = context
		this.store = new XmlStore(context.xmlBudget)
	}

	// A group that gives the paragraph content starts at `position` (its brace): the paragraph's source starts
	// there at the latest.
	touch(position: number): void {
		if (this.start < 0) this.start = position
	}

	get empty(): boolean {
		return this.content === "" && this.runProps === undefined && this.label === "" && !this.labelMode
	}

	// Text in the open run when it has the same properties, else in a new one.
	text(text: string, props: string, kind: TextKind, revision: string): void {
		if (text === "") return

		this.switchRun(props, kind, revision)
		this.runText += text
	}

	// An element inside a run (w:tab, w:br, w:fldChar, w:footnoteReference, w:drawing...).
	inline(xml: string, props: string, kind: TextKind, revision: string): void {
		this.switchRun(props, kind, revision)
		this.runInner += this.textXml() + xml
		this.runText = ""
	}

	// Markup between runs (bookmarks, comment ranges).
	markup(xml: string): void {
		this.closeRun()
		this.content += xml
	}

	// An equation (m:oMath, m:oMathPara) between runs, outside any tracked change.
	math(xml: string): void {
		this.closeRun()
		this.closeRevision()
		this.content += xml
	}

	// Content read for a \listtext or \pntext label goes aside until the paragraph says whether it is numbered.
	beginLabel(): void {
		this.closeRun()
		this.closeRevision()
		this.beforeLabel = this.content
		this.content = ""
		this.labelMode = true
	}

	endLabel(): void {
		if (!this.labelMode) return

		this.closeRun()
		this.closeRevision()
		this.label = this.content
		this.content = this.beforeLabel
		this.beforeLabel = ""
		this.labelMode = false
	}

	private switchRun(props: string, kind: TextKind, revision: string): void {
		if (this.runProps === props && this.runKind === kind && this.openRevision === revision) return

		this.closeRun()

		if (this.openRevision !== revision) {
			this.closeRevision()

			if (revision !== "") this.content += revision.replace(/^<w:(ins|del)/u, tag => `${tag} w:id="${this.context.nextId()}"`)
			this.openRevision = revision
		}

		this.runProps = props
		this.runKind = kind
	}

	private textXml(): string {
		const text = this.runText

		if (text === "") return ""

		const escaped = escapeText(text)
		const space = text.charCodeAt(0) === 0x20 || text.charCodeAt(text.length - 1) === 0x20 || text.includes("  ")

		return `<w:${this.runKind}${space ? ' xml:space="preserve"' : ""}>${escaped}</w:${this.runKind}>`
	}

	private closeRun(): void {
		if (this.runProps === undefined) return

		const inner = this.runInner + this.textXml()

		if (inner !== "") this.content += `<w:r>${this.runProps}${inner}</w:r>`

		this.runProps = undefined
		this.runInner = ""
		this.runText = ""
	}

	private closeRevision(): void {
		if (this.openRevision === "") return

		this.content += this.openRevision.startsWith("<w:ins") ? "</w:ins>" : "</w:del>"
		this.openRevision = ""
	}

	// Ends the paragraph. `withLabel`: show the \listtext/\pntext label (the paragraph has no list numbering).
	// `term`: where the word ending it starts.
	paragraph(pPr: string, depth: number, withLabel: boolean, end: number, term: number = end): void {
		this.closeRun()
		this.closeRevision()

		const body = (withLabel ? this.label : "") + this.content
		const xml = pPr === "" ? `<w:p>${body}</w:p>` : `<w:p><w:pPr>${pPr}</w:pPr>${body}</w:p>`
		const start = this.start < 0 ? term : Math.min(this.start, term)
		const from = this.mark < 0 ? start : Math.min(this.mark, start)
		const at = this.store.put(xml)
		const paragraph: Paragraph = {
			kind: "p",
			store: this.store,
			at,
			size: this.store.size,
			blank: body === "" && BLANK.test(xml),
			marked: body.includes(MARK),
			from,
			start,
			term,
			end
		}

		this.mark = end
		this.last = paragraph

		if (this.unread !== "") {
			this.context.unread(this.unread, start, end)
			this.unread = ""
		}

		this.content = ""
		this.label = ""
		this.start = -1
		this.place(paragraph, depth)
	}

	// Drops the open paragraph's content (a \row with nothing after the last \cell).
	discard(): void {
		this.unread = ""
		this.closeRun()
		this.closeRevision()
		this.content = ""
		this.label = ""
		this.start = -1
	}

	// A finished block from elsewhere (a drawing object's text box) before the open paragraph.
	insert(block: Block, depth: number): void {
		this.place(block, depth)
	}

	private place(block: Block, depth: number): void {
		this.closeDeeper(depth)

		if (depth === 0) {
			this.blocks.push(block)

			return
		}

		while (this.levels.length < depth) {
			const table: Table = { kind: "tbl", rows: [] }

			this.levels.push({ table, cells: [], current: [], rowFrom: -1 })
		}

		const from = blockFrom(block)

		for (const level of this.levels) if (level.rowFrom < 0) level.rowFrom = from

		this.levels[depth - 1]?.current.push(block)
	}

	// Finishes the tables nested deeper than `depth` and puts each into its parent cell (or the story).
	private closeDeeper(depth: number): void {
		while (this.levels.length > depth) {
			const open = this.levels.pop()

			if (open === undefined) break

			if (open.current.length > 0 || open.cells.length > 0) {
				if (open.current.length > 0) open.cells.push(open.current)

				const last = [...open.cells]
					.reverse()
					.find(cell => cell.length > 0)
					?.at(-1)

				open.table.rows.push({
					def: open.table.rows.at(-1)?.def ?? newRow(),
					cells: open.cells,
					from: open.rowFrom,
					end: last === undefined ? open.rowFrom : blockEnd(last),
					closed: false
				})
			}

			if (open.table.rows.length === 0) continue

			const parent = this.levels.at(-1)

			if (parent === undefined) this.blocks.push(open.table)
			else parent.current.push(open.table)
		}
	}

	// \cell (depth 1) or \nestcell: the open paragraph has been ended into the cell already.
	cell(depth: number): void {
		const open = this.levels[depth - 1]

		if (open === undefined) return

		this.closeDeeper(depth)
		open.cells.push(open.current)
		open.current = []
	}

	// \row or \nestrow: the row's cells so far, with the row definition.
	// `end`: the end of the \\row word.
	row(depth: number, def: RowDef, end: number): void {
		this.closeDeeper(depth)

		while (this.levels.length < depth) this.levels.push({ table: { kind: "tbl", rows: [] }, cells: [], current: [], rowFrom: -1 })

		const open = this.levels[depth - 1]

		if (open === undefined) return

		if (open.current.length > 0) {
			open.cells.push(open.current)
			open.current = []
		}

		const from = open.rowFrom < 0 ? (this.mark < 0 ? end : this.mark) : open.rowFrom

		const row: Row = { def, cells: open.cells, from, end, closed: true }

		open.table.rows.push(row)
		open.cells = []
		open.rowFrom = -1
		this.mark = end
		this.last = row
	}

	// The last paragraph or row ended reaches on to `end` when no content was read since it ended: a nested row's
	// source takes in the {\\*\\nesttableprops ... \\nestrow} destination it ends in, and a nested cell's or row's the
	// {\\nonesttables ...} group after it (RTF 1.9.1, "Tables"), so that they are copied, removed and written whole.
	extend(end: number): boolean {
		const last = this.last

		if (last === undefined || this.mark !== last.end || !this.empty || end <= last.end) return false

		last.end = end
		this.mark = end
		// A group opened in between (around the destination) gives the next paragraph nothing before `end`.
		if (this.start >= 0 && this.start < end) this.start = -1

		return true
	}

	// Ends the story: an open paragraph with content becomes a paragraph, open tables are finished.
	finish(pPr: string, end: number): void {
		if (!this.empty) this.paragraph(pPr, 0, true, end)

		this.closeDeeper(0)
		this.store.trim()
	}

	// The story's blocks as WordprocessingML into `out`; `map` receives where each element came from, in order.
	write(out: XmlSink, blocks: readonly Block[] = this.blocks, map?: SourceBlock[]): void {
		for (const block of blocks) {
			if (block.kind === "p") {
				out.paragraph(block)
				map?.push({ kind: "p", from: block.from, start: block.start, term: block.term, end: block.end })
			} else {
				tableXml(block, this.context, out, map)
			}
		}
	}
}

// A paragraph with no content: what a merged cell's paragraphs may be without being kept.
const BLANK = /^<w:p>(<w:pPr>.*<\/w:pPr>)?<\/w:p>$/

// A paragraph the translation adds where the source has none.
export function syntheticParagraph(): SourceParagraph {
	return SYNTHETIC
}

interface LaidCell {
	readonly right: number
	readonly def: CellDef | undefined
	readonly blocks: Block[]
	// The edges of cells merged into this one (\\clmrg): grid columns it spans.
	readonly inner: readonly number[]
}

// A row's cells with their right edges: content cells paired with the \cellx definitions in order, missing
// definitions continuing the last width, horizontally merged cells (\clmrg) folded into the cell before.
function layRow(row: Row): { left: number; cells: LaidCell[]; lastRight: number } {
	const defs = row.def.cells
	const left = row.def.left
	const cells: LaidCell[] = []
	let previous = left
	let lastWidth = 1440
	const count = Math.max(row.cells.length, 1)

	for (let index = 0; index < count && index < MAX_GRID; index++) {
		const def = defs[index]
		let right = def === undefined ? previous + lastWidth : def.right

		if (right <= previous) right = previous + 1

		lastWidth = right - previous

		const blocks = row.cells[index] ?? []
		const last = cells.at(-1)

		if (def?.merged === true && last !== undefined) {
			cells[cells.length - 1] = { right, def: last.def, blocks: mergeBlocks(last.blocks, blocks), inner: [...last.inner, previous] }
		} else {
			cells.push({ right, def, blocks, inner: [] })
		}

		previous = right
	}

	// Content past the grid limit joins the last cell.
	for (let index = MAX_GRID; index < row.cells.length; index++) {
		const last = cells.at(-1)

		if (last !== undefined) cells[cells.length - 1] = { ...last, blocks: mergeBlocks(last.blocks, row.cells[index] ?? []) }
	}

	// Definitions without content (fewer \cell than \cellx) only widen the grid: w:gridAfter covers them.
	let lastRight = previous

	for (let index = count; index < defs.length && index < MAX_GRID; index++) {
		const right = defs[index]?.right ?? lastRight

		if (right > lastRight) lastRight = right
	}

	return { left, cells, lastRight }
}

function mergeBlocks(into: Block[], from: Block[]): Block[] {
	const meaningful = from.some(block => block.kind === "tbl" || !block.blank)

	return meaningful ? [...into, ...from] : into
}

function tableXml(table: Table, context: PropsContext, out: XmlSink, map: SourceBlock[] | undefined): void {
	let rows: { row: Row; laid: ReturnType<typeof layRow> }[] = []
	let edges = new Set<number>()

	const flush = (): void => {
		if (rows.length > 0) gridTable(rows, edges, context, out, map)

		rows = []
		edges = new Set<number>()
	}

	for (const row of table.rows) {
		const laid = layRow(row)
		const added = gridEdges(laid).filter(edge => !edges.has(edge))

		if (rows.length > 0 && edges.size + new Set(added).size > MAX_GRID + 1) flush()

		for (const edge of added) edges.add(edge)

		rows.push({ row, laid })
	}

	flush()
}

function gridTable(
	rows: readonly { row: Row; laid: ReturnType<typeof layRow> }[],
	edgeSet: Set<number>,
	context: PropsContext,
	sink: XmlSink,
	map: SourceBlock[] | undefined
): void {
	const sourceRows: SourceRow[] = []
	const edges = [...edgeSet].sort((a, b) => a - b)
	const index = indexOf(edges)
	const firstRow = rows[0]
	const first = firstRow?.row.def ?? newRow()
	// Rows with old properties (\\oldtprops): laid out as they were, on the grid they had.
	const tracked = rows.some(({ row }) => row.def.old !== undefined)
	const oldLaid = tracked
		? rows.map(({ row, laid }) => (row.def.old === undefined ? laid : layRow({ ...row, def: row.def.old.props })))
		: []
	const oldEdges = tracked ? [...new Set(oldLaid.flatMap(gridEdges))].sort((a, b) => a - b) : edges
	const oldIndex = tracked ? indexOf(oldEdges) : index
	let tblPr = tblPrXml(first, firstRow?.laid.left ?? 0, context)

	if (first.old !== undefined) {
		const old = tblPrXml(first.old.props, oldLaid[0]?.left ?? 0, context)

		if (old !== tblPr)
			tblPr += `${context.change("tblPrChange", first.old.author, first.old.date)}<w:tblPr>${old}</w:tblPr></w:tblPrChange>`
	}

	let out = `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid>${gridXml(edges)}`

	if (tracked && oldEdges.join() !== edges.join())
		out += `<w:tblGridChange w:id="${context.nextId()}"><w:tblGrid>${gridXml(oldEdges)}</w:tblGrid></w:tblGridChange>`

	out += "</w:tblGrid>"

	// The table's shading is its first row's; a row shaded otherwise says so in w:tblPrEx (ECMA-376 Part 1 §17.4.61).
	const tableShading = rowShading(first, context)
	// Tracked rows give their old shading through the table's w:tblPrChange alone (no w:tblPrExChange is written).
	const oldShading = first.old === undefined ? tableShading : rowShading(first.old.props, context)
	const shadingUntracked =
		tracked &&
		rows.some(
			({ row }) =>
				rowShading(row.def, context) !== tableShading ||
				(row.def.old === undefined ? tableShading : rowShading(row.def.old.props, context)) !== oldShading
		)

	rows.forEach(({ row, laid }, rowIndex) => {
		const def = row.def
		const old = def.old
		const oldRow = oldLaid[rowIndex]
		const shading = rowShading(def, context)
		let trPr = trPrXml(def, laid, index, edges.length - 1)

		if (old !== undefined && oldRow !== undefined) {
			const previous = trPrXml(old.props, oldRow, oldIndex, oldEdges.length - 1)

			if (previous !== trPr)
				trPr += `${context.change("trPrChange", old.author, old.date)}<w:trPr>${previous}</w:trPr></w:trPrChange>`
		}

		out += "<w:tr>"
		if (shading !== tableShading) out += `<w:tblPrEx>${shading || '<w:shd w:val="clear" w:color="auto" w:fill="auto"/>'}</w:tblPrEx>`
		if (trPr !== "") out += `<w:trPr>${trPr}</w:trPr>`
		sink.text(out)
		out = ""

		const cells: SourceBlock[][] = []
		const spans = cellSpans(laid, index)
		const oldSpans = old !== undefined && oldRow !== undefined ? cellSpans(oldRow, oldIndex) : []

		laid.cells.forEach((cell, k) => {
			const content: SourceBlock[] | undefined = map === undefined ? undefined : []
			const { span, width } = spans[k] ?? { span: 1, width: 0 }
			const tcPr = tcPrXml(cell.def, span, width, context)
			const before = oldSpans[k]
			const oldCell = oldRow?.cells[k]
			let change = ""

			if (old !== undefined && before !== undefined && oldCell !== undefined) {
				const previous = tcPrXml(oldCell.def, before.span, before.width, context)

				if (previous !== tcPr)
					change = `${context.change("tcPrChange", old.author, old.date)}<w:tcPr>${previous}</w:tcPr></w:tcPrChange>`
			}

			cellXml(cell, tcPr, change, context, sink, content)
			if (content !== undefined) cells.push(content)
		})

		out += "</w:tr>"
		sourceRows.push({
			from: row.from,
			end: row.end,
			closed: row.closed,
			merged: row.def.cells.some(cell => cell.merged) || laid.cells.length !== row.cells.length,
			unread: rowUnread(def, shadingUntracked),
			left: def.left,
			indent: def.indent,
			indentType: def.indentType,
			danglingStyle: def.style >= 0 && context.tableStyleId(def.style) === undefined ? def.style : -1,
			cells
		})
	})

	map?.push({ kind: "tbl", from: sourceRows[0]?.from ?? -1, end: sourceRows.at(-1)?.end ?? -1, rows: sourceRows })
	sink.text(`${out}</w:tbl>`)
}

function indexOf(edges: readonly number[]): Map<number, number> {
	const index = new Map<number, number>()

	edges.forEach((edge, k) => index.set(edge, k))

	return index
}

// The grid edges a laid row brings: its left edge, every cell's (with those merged into it) and its last.
function gridEdges(laid: ReturnType<typeof layRow>): number[] {
	return [laid.left, ...laid.cells.flatMap(cell => [...cell.inner, cell.right]), laid.lastRight]
}

function gridXml(edges: readonly number[]): string {
	let out = ""

	for (let k = 1; k < edges.length; k++) out += `<w:gridCol w:w="${(edges[k] ?? 0) - (edges[k - 1] ?? 0)}"/>`

	return out
}

// A preferred width (CT_TblWidth) from a width and its RTF unit (RTF 1.9.1 \\trftsWidthN: 1 auto, 2 fiftieths of a
// percent, 3 twips; 0, or none, says nothing).
function widthXml(name: string, width: number, type: number): string {
	const unit = type === 1 ? "auto" : type === 2 ? "pct" : type === 3 ? "dxa" : undefined

	return unit === undefined ? "" : `<w:${name} w:w="${Math.max(0, width)}" w:type="${unit}"/>`
}

function cellSpans(laid: ReturnType<typeof layRow>, index: ReadonlyMap<number, number>): { span: number; width: number }[] {
	let previous = laid.left

	return laid.cells.map(cell => {
		const span = (index.get(cell.right) ?? 0) - (index.get(previous) ?? 0)
		const width = cell.right - previous

		previous = cell.right

		return { span: Math.max(1, span), width }
	})
}

// A row's w:shd, "" for none.
function rowShading(def: RowDef, context: PropsContext): string {
	return def.shading === undefined ? "" : shadingXml(def.shading, context)
}

// What a row's definition says that the translation cannot hold (SourceRow.unread).
function rowUnread(def: RowDef, shadingUntracked: boolean): string {
	let names = def.unread

	if (shadingConflict(def.shading)) names = `${names} trshdng`.trim()
	if (def.cells.some(cell => shadingConflict(cell.shading))) names = `${names} clshdng`.trim()
	if (shadingUntracked) names = `${names} trcbpat`.trim()

	return names
}

// The w:tblPr children of a table whose first row is `first`, laid from `left`.
function tblPrXml(first: RowDef, left: number, context: PropsContext): string {
	let out = ""
	const style = first.style >= 0 ? context.tableStyleId(first.style) : undefined

	if (style !== undefined) out += `<w:tblStyle w:val="${style}"/>`
	if (first.bidi) out += "<w:bidiVisual/>"

	out +=
		first.widthType === 3 && first.width > 0
			? `<w:tblW w:w="${first.width}" w:type="dxa"/>`
			: first.widthType === 2 && first.width > 0
				? `<w:tblW w:w="${first.width}" w:type="pct"/>`
				: '<w:tblW w:w="0" w:type="auto"/>'

	if (first.jc !== undefined) out += `<w:jc w:val="${first.jc}"/>`

	const marginLeft = first.padding.left ?? first.gap
	const marginRight = first.padding.right ?? first.gap

	// Before Word 2013 the indent is the first cell's text position: the row's left edge plus its margin.
	if (first.jc === undefined) out += `<w:tblInd w:w="${left + marginLeft}" w:type="dxa"/>`

	let tblBorders = ""

	for (const side of ["top", "left", "bottom", "right", "insideH", "insideV"] as const) {
		const border = first.borders[side]

		if (border !== undefined) tblBorders += borderXml(side, border, context)
	}

	if (tblBorders !== "") out += `<w:tblBorders>${tblBorders}</w:tblBorders>`
	if (first.shading !== undefined) out += shadingXml(first.shading, context)
	if (!first.autofit) out += '<w:tblLayout w:type="fixed"/>'

	out += "<w:tblCellMar>"
	if (first.padding.top !== undefined) out += `<w:top w:w="${first.padding.top}" w:type="dxa"/>`
	out += `<w:left w:w="${Math.max(0, marginLeft)}" w:type="dxa"/>`
	if (first.padding.bottom !== undefined) out += `<w:bottom w:w="${first.padding.bottom}" w:type="dxa"/>`
	out += `<w:right w:w="${Math.max(0, marginRight)}" w:type="dxa"/>`

	return `${out}</w:tblCellMar><w:tblLook w:val="0000"/>`
}

// The w:trPr children of a row (its grid offsets on `index`, `columns` grid columns in all).
function trPrXml(def: RowDef, laid: ReturnType<typeof layRow>, index: ReadonlyMap<number, number>, columns: number): string {
	const before = index.get(laid.left) ?? 0
	const lastEdge = index.get(laid.cells.at(-1)?.right ?? laid.left) ?? before
	const after = Math.max(0, columns - lastEdge)
	let trPr = ""

	if (before > 0) trPr += `<w:gridBefore w:val="${before}"/>`
	if (after > 0) trPr += `<w:gridAfter w:val="${after}"/>`
	trPr += widthXml("wBefore", def.widthBefore, def.widthBeforeType)
	trPr += widthXml("wAfter", def.widthAfter, def.widthAfterType)
	if (def.cantSplit) trPr += "<w:cantSplit/>"
	if (def.height !== 0) trPr += `<w:trHeight w:val="${Math.abs(def.height)}" w:hRule="${def.height < 0 ? "exact" : "atLeast"}"/>`
	if (def.header) trPr += "<w:tblHeader/>"

	return trPr
}

// The w:tcPr children of a cell, its tracked insertion or deletion left out.
function tcPrXml(def: CellDef | undefined, span: number, width: number, context: PropsContext): string {
	// The preferred width \\clwWidthN states (in its \\clftsWidthN unit), else the width the cell's edges give.
	let tcPr = (def === undefined ? "" : widthXml("tcW", def.width, def.widthType)) || `<w:tcW w:w="${Math.max(0, width)}" w:type="dxa"/>`

	if (span > 1) tcPr += `<w:gridSpan w:val="${span}"/>`

	if (def !== undefined) {
		if (def.vMergeFirst) tcPr += '<w:vMerge w:val="restart"/>'
		else if (def.vMerged) tcPr += "<w:vMerge/>"

		let borders = ""

		for (const side of ["top", "left", "bottom", "right"] as const) {
			const border = def.borders[side]

			if (border !== undefined) borders += borderXml(side, border, context)
		}

		if (borders !== "") tcPr += `<w:tcBorders>${borders}</w:tcBorders>`
		if (def.shading !== undefined) tcPr += shadingXml(def.shading, context)
		if (def.noWrap) tcPr += "<w:noWrap/>"

		let margins = ""

		for (const side of ["top", "left", "bottom", "right"] as const) {
			const value = def.padding[side]

			if (value !== undefined) margins += `<w:${side} w:w="${clamp(value, 0, 31680)}" w:type="dxa"/>`
		}

		if (margins !== "") tcPr += `<w:tcMar>${margins}</w:tcMar>`
		if (def.textDirection !== undefined) tcPr += `<w:textDirection w:val="${def.textDirection}"/>`
		if (def.vAlign !== undefined) tcPr += `<w:vAlign w:val="${def.vAlign}"/>`
	}

	return tcPr
}

// A cell: its properties (tcPr: tcPrXml's), then its tracked insertion or deletion and property change.
function cellXml(cell: LaidCell, tcPr: string, change: string, context: PropsContext, sink: XmlSink, map: SourceBlock[] | undefined): void {
	const def = cell.def

	if (def?.revision !== undefined) tcPr += context.cellRevision(def.revision)

	tcPr += change
	sink.text(`<w:tc><w:tcPr>${tcPr}</w:tcPr>`)

	for (const block of cell.blocks) {
		if (block.kind === "p") {
			sink.paragraph(block)
			map?.push({ kind: "p", from: block.from, start: block.start, term: block.term, end: block.end })
		} else {
			tableXml(block, context, sink, map)
		}
	}

	// A cell ends with a paragraph (ECMA-376 Part 1 §17.4.66).
	if (cell.blocks.length === 0 || cell.blocks.at(-1)?.kind === "tbl") {
		sink.text("<w:p/>")
		map?.push(SYNTHETIC)
	}

	sink.text("</w:tc>")
}

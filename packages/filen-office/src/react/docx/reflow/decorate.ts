import type { Node } from "prosemirror-model"
import { Decoration, DecorationSet } from "prosemirror-view"
import { DocxEditorSession, docxSchema } from "../../../core/docx/edit/index"
import type { RevisionView } from "../../../core/docx/model/kinds"
import { markerText, type StoryCounters } from "../../../core/docx/reflow/counters"
import { paragraphCss, runCss, type CssFaces } from "../../../core/docx/reflow/css"
import { cellTables, tableLook, type LaidTable } from "../../../core/docx/reflow/tables"
import { ReviewKind, reviewIndexKept } from "../../../core/docx/review/index"
import { SECTION_SHIFT, sectionBreakFlags } from "../../../core/docx/layout/output"
import { bodySections, endsSection, sectionNode } from "../../../core/docx/stories/sections"
import type { DocxEditorMark } from "../edit/surface"
import { gapRowCount, type StoryStarts } from "../edit/window"
import { LINE_BREAK_MARK, NBSP_MARK, SPACE_MARK, sectionLabel, type DocxMarkLabels } from "../paint/marks"

// What the reflowed view draws over a story's text: each run's look where it differs from its paragraph's,
// list markers and note marks (counted from the nearest checkpoint, never from the document's start on a
// keystroke), commented ranges, and the app's marks (spelling, find). Only for the blocks the view holds.

// A block's own decorations, relative to its start: kept per block node (an unchanged block reuses them).
// `node`: a node decoration (a table's, a cell's, a paragraph's), else inline (a run's look).
interface Local {
	readonly from: number
	readonly to: number
	readonly node: boolean
	readonly attrs: Readonly<Record<string, string>>
}

// A field atom or field character of a block, relative to its start.
interface FieldPlace {
	readonly pos: number
	readonly node: Node
}

interface BlockLooks {
	readonly faces: number
	// The revision view its tables were drawn for (-1: it has none).
	readonly view: number
	readonly locals: readonly Local[]
}

// The part and item a table is laid out from (undefined: drawn with the view's own borders).
export type TableSource = (table: Node, index: number) => LaidTable | undefined

// What the view reads of a story it shows: a session's, or a story only shown (made editable when it is used).
export type ReflowSource = Pick<DocxEditorSession, "formats" | "context" | "story" | "state">

const looks = new WeakMap<Node, BlockLooks>()
const nodes = docxSchema.nodes

// A table of shared values by key, emptied when it reaches `max` entries (a value made again is equal, only not
// the same object): decoration attributes are shared by content so the view keeps what it drew.
export class InternTable<T> {
	private readonly values = new Map<string, T>()
	private readonly max: number

	constructor(max: number) {
		this.max = max
	}

	get size(): number {
		return this.values.size
	}

	get(key: string, make: () => T): T {
		let value = this.values.get(key)

		if (value === undefined) {
			if (this.values.size >= this.max) this.values.clear()

			value = make()
			this.values.set(key, value)
		}

		return value
	}
}

const ATTRS = new InternTable<Readonly<Record<string, string>>>(4096)

function interned(key: string, make: () => Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	return ATTRS.get(key, make)
}

function styleAttrs(css: string): Readonly<Record<string, string>> {
	return interned(`style:${css}`, () => ({ style: css }))
}

// The CSS of a paragraph's element: its own look and its runs' common one (what the paragraph style gives).
export function paragraphStyle(session: ReflowSource, node: Node, faces: CssFaces): string {
	const formats = session.formats
	const format = formats.paragraph(node)
	const base = runCss(formats.styleRun(format, []), faces)
	const own = paragraphCss(format)

	return own.length === 0 ? base : base.length === 0 ? own : `${own}; ${base}`
}

// Contextual spacing (w:contextualSpacing) as the pages lay it out: between two paragraphs of the same style, the
// space after the first is dropped when it has it, the space before the second when the second has it.
function contextual(session: ReflowSource, a: Node, b: Node): readonly [boolean, boolean] {
	if (!a.isTextblock || !b.isTextblock) return [false, false]

	const first = session.formats.paragraph(a).props
	const second = session.formats.paragraph(b).props

	if (first.styleId !== second.styleId) return [false, false]

	return [first.contextualSpacing, second.contextualSpacing]
}

function contextualAttrs(top: boolean, bottom: boolean): Readonly<Record<string, string>> | undefined {
	if (!top && !bottom) return undefined

	const value = top && bottom ? "top bottom" : top ? "top" : "bottom"

	return interned(`contextual:${value}`, () => ({ "data-fo-contextual": value }))
}

// A paragraph's runs whose look differs from the paragraph's, relative to the paragraph: kept per paragraph node,
// so an edit looks at the paragraph it changed only.
const paragraphLooks = new WeakMap<Node, { readonly faces: number; readonly locals: readonly Local[] }>()

function runLooks(session: ReflowSource, paragraph: Node, faces: CssFaces, facesVersion: number): readonly Local[] {
	const cached = paragraphLooks.get(paragraph)

	if (cached !== undefined && cached.faces === facesVersion) return cached.locals

	const formats = session.formats
	const format = formats.paragraph(paragraph)
	const base = runCss(formats.styleRun(format, []), faces)
	const locals: Local[] = []

	paragraph.forEach((child, at) => {
		if (child.marks.length === 0 && child.isText) return

		const css = runCss(formats.resolvedRun(format, child.marks), faces)

		if (css !== base) locals.push({ from: 1 + at, to: 1 + at + child.nodeSize, node: false, attrs: styleAttrs(css) })
	})

	paragraphLooks.set(paragraph, { faces: facesVersion, locals })

	return locals
}

// What a block shows of its own, relative to its start: its runs' looks, its tables' borders and shading as the
// pages resolve them (`source`: where the top-level table is laid out from), contextual spacing between
// paragraphs inside it. A long table's gap rows (rows the view does not hold) are passed over.
function blockLooks(
	session: ReflowSource,
	block: Node,
	source: LaidTable | undefined,
	faces: CssFaces,
	facesVersion: number,
	view: RevisionView
): BlockLooks {
	const cached = looks.get(block)

	if (cached !== undefined && cached.faces === facesVersion && (cached.view < 0 || cached.view === view)) return cached

	const resolver = session.context.resolver
	const store = session.context.store
	const locals: Local[] = []
	let tabled = false
	const paragraph = (node: Node, pos: number): void => {
		for (const local of runLooks(session, node, faces, facesVersion))
			locals.push({ from: pos + local.from, to: pos + local.to, node: false, attrs: local.attrs })
	}
	// Blocks inside a container (a cell, a content control), and contextual spacing between them.
	const children = (parent: Node, pos: number, tablesOf: (k: number) => LaidTable | undefined): void => {
		let tableIndex = 0

		parent.forEach((child, at, k) => {
			const childPos = pos + 1 + at

			visit(child, childPos, child.type === nodes.table ? tablesOf(tableIndex++) : undefined)

			const top = k > 0 && contextual(session, parent.child(k - 1), child)[1]
			const bottom = k + 1 < parent.childCount && contextual(session, child, parent.child(k + 1))[0]
			const spacing = contextualAttrs(top, bottom)

			if (spacing !== undefined) locals.push({ from: childPos, to: childPos + child.nodeSize, node: true, attrs: spacing })
		})
	}
	const table = (node: Node, pos: number, from: LaidTable | undefined): void => {
		const grid = Array.isArray(node.attrs["grid"]) ? (node.attrs["grid"] as unknown[]).length : 0
		const look = from === undefined ? undefined : tableLook(from.part, from.item, grid, resolver, store, view, from.edited)

		tabled = true
		// The row of the table each row of the view stands for (a gap row stands for several).
		let r = 0

		if (look !== undefined && look.table.length > 0)
			locals.push({ from: pos, to: pos + node.nodeSize, node: true, attrs: styleAttrs(look.table) })

		node.forEach((row, rowAt) => {
			const gap = gapRowCount(row)

			if (gap !== undefined) {
				r += gap

				return
			}

			const rowPos = pos + 1 + rowAt
			const index = r++

			row.forEach((cell, cellAt, c) => {
				const cellPos = rowPos + 1 + cellAt
				const css = look?.cells[index]?.[c]
				const item = look?.items[index]?.[c]
				const inner = look === undefined || item === undefined ? [] : cellTables(look.parts?.[index] ?? look.part, item)

				if (css !== undefined) locals.push({ from: cellPos, to: cellPos + cell.nodeSize, node: true, attrs: styleAttrs(css) })

				children(cell, cellPos, k => {
					const at = inner[k]

					return look === undefined || at === undefined ? undefined : { part: look.parts?.[index] ?? look.part, item: at }
				})
			})
		})
	}
	const visit = (node: Node, pos: number, from: LaidTable | undefined): void => {
		if (node.isTextblock) paragraph(node, pos)
		else if (node.type === nodes.table) table(node, pos, from)
		else if (!node.isLeaf) children(node, pos, () => undefined)
	}

	visit(block, 0, source)

	const made = { faces: facesVersion, view: tabled ? view : -1, locals }

	looks.set(block, made)

	return made
}

const fieldLists = new WeakMap<Node, readonly FieldPlace[]>()
const NO_FIELDS: readonly FieldPlace[] = []

// The field atoms and field characters of a block, relative to its start, in document order: kept per node, so
// an edit inside a long table reads the row it changed only.
function fieldPlaces(block: Node): readonly FieldPlace[] {
	let list = fieldLists.get(block)

	if (list !== undefined) return list

	const found: FieldPlace[] = []

	if (block.isTextblock) {
		block.forEach((node, at) => {
			if (node.type === nodes.field || node.type === nodes.field_char) found.push({ pos: 1 + at, node })
		})
	} else if (!block.isLeaf) {
		block.forEach((child, at) => {
			for (const place of fieldPlaces(child)) found.push({ pos: 1 + at + place.pos, node: place.node })
		})
	}

	list = found.length === 0 ? NO_FIELDS : found
	fieldLists.set(block, list)

	return list
}

// Where fields shown as their codes are open at a block: found by walking back over the paragraphs before it
// (as the paged editor finds them, PagedEditor.withinCode), kept until the blocks before it or the code view change.
export class CodeScan {
	private found: { readonly index: number; readonly start: number } | undefined

	// Blocks from `index` on changed.
	invalidate(index: number): void {
		if (this.found !== undefined && index < this.found.index) this.found = undefined
	}

	reset(): void {
		this.found = undefined
	}

	// The block to count fields from for block `index`: that of the outermost begin before it whose field shows
	// its code and is still open there, else `index`.
	start(doc: Node, index: number, shown: (node: Node) => boolean): number {
		if (this.found?.index === index) return this.found.start

		let pending = 0
		let start = index

		for (let at = index - 1; at >= 0 && start === index; at--) {
			const block = doc.child(at)

			if (!block.isTextblock) break

			const places = fieldPlaces(block)

			for (let k = places.length - 1; k >= 0; k--) {
				const node = places[k]?.node

				if (node === undefined || node.type !== nodes.field_char) continue

				if (node.attrs["kind"] === "end") pending++
				else if (node.attrs["kind"] === "begin" && pending > 0) pending--
				else if (node.attrs["kind"] === "begin" && shown(node)) {
					start = at

					break
				}
			}
		}

		this.found = { index, start }

		return start
	}
}

interface CodeFrame {
	readonly code: boolean
	// Past its separator: its result is hidden (shown as its code).
	hiding: boolean
}

function codeAttrs(text: string): Readonly<Record<string, string>> {
	return interned(`code:${text}`, () => ({ "data-fo-code": text }))
}

const HIDDEN_RESULT: Readonly<Record<string, string>> = { class: "fo-docx-reflow-code-result" }

// Fields shown as their codes in blocks [from, to) as the pages show them (Alt+F9, Shift+F9): a field's code in
// braces in place of its result; a field spanning paragraphs shows "{", its instruction and "}" and hides its result.
function fieldCodes(
	doc: Node,
	from: number,
	to: number,
	positionOf: (index: number) => number,
	shown: (node: Node) => boolean,
	scan: CodeScan | undefined,
	ranges: readonly [number, number][],
	held: (pos: number) => boolean,
	out: Decoration[]
): void {
	const stack: CodeFrame[] = []
	let hiddenFrom = -1
	const hiding = (): boolean => stack.some(frame => frame.hiding)
	const hide = (start: number, end: number): void => {
		clipped(ranges, start, end, (a, b) => out.push(Decoration.inline(a, b, HIDDEN_RESULT)))
	}

	for (let index = scan === undefined ? from : scan.start(doc, from, shown); index < to; index++) {
		const places = fieldPlaces(doc.child(index))
		const start = positionOf(index)
		const visible = index >= from

		places.forEach((place, k) => {
			const node = place.node
			const pos = start + place.pos
			const draw = visible && !hiding() && held(pos)

			if (node.type === nodes.field) {
				if (draw && shown(node)) out.push(Decoration.node(pos, pos + 1, codeAttrs(`{${String(node.attrs["instruction"])}}`)))

				return
			}

			const kind = node.attrs["kind"]
			const top = stack[stack.length - 1]

			if (kind === "begin") {
				const code = shown(node)
				// The instruction is the file's own instruction characters when they follow.
				const pieces = places[k + 1]?.node.attrs["kind"] === "instruction"

				stack.push({ code, hiding: false })

				if (draw && code) out.push(Decoration.node(pos, pos + 1, codeAttrs(pieces ? "{" : `{${String(node.attrs["instruction"])}`)))
			} else if (kind === "instruction" || kind === "deletedInstruction") {
				if (draw && top?.code === true) out.push(Decoration.node(pos, pos + 1, codeAttrs(String(node.attrs["instruction"]))))
			} else if (kind === "separate") {
				if (top?.code === true && !top.hiding) {
					if (!hiding()) hiddenFrom = pos + 1

					top.hiding = true
				}
			} else if (kind === "end") {
				const frame = stack.pop()

				if (frame?.hiding === true && !hiding() && hiddenFrom >= 0) {
					hide(hiddenFrom, pos)
					hiddenFrom = -1
				}

				if (visible && frame?.code === true && !hiding() && held(pos)) out.push(Decoration.node(pos, pos + 1, codeAttrs("}")))
			}
		})
	}

	if (hiddenFrom >= 0) hide(hiddenFrom, positionOf(to))
}

// Where each top-level block of `doc` starts (from the editor's own list when it keeps one for `doc`).
export function blockPositions(doc: Node, starts: StoryStarts | undefined): (index: number) => number {
	const count = doc.childCount
	const own = starts !== undefined && starts.document === doc ? starts.starts : undefined
	let positions: number[] | undefined

	return index => {
		if (index >= count) return doc.content.size
		if (own !== undefined) return own[index] ?? 0

		if (positions === undefined) {
			positions = []

			let pos = 0

			for (let k = 0; k < count; k++) {
				positions.push(pos)
				pos += doc.child(k).nodeSize
			}
		}

		return positions[index] ?? 0
	}
}

export interface StoryDecorations {
	readonly session: ReflowSource
	// The story's document, and the view's of it (gaps for the blocks not held; the same positions).
	readonly doc: Node
	readonly shown?: Node
	// The top-level blocks the view holds ([from, to) index pairs), all when undefined.
	readonly windows: readonly number[] | undefined
	readonly starts: StoryStarts | undefined
	readonly counters: StoryCounters | undefined
	readonly faces: CssFaces
	readonly facesVersion: number
	// The revision view shown (tables' banding and edge rows count the rows it shows).
	readonly view: RevisionView
	// Sorted by `from` (the app's marks, for the body only).
	readonly marks: readonly DocxEditorMark[]
	// Where each top-level table is laid out from.
	readonly tables: TableSource
	// Whether a field (atom, or a field character beginning one) shows its code.
	readonly codeShown: (field: Node) => boolean
	readonly codeScan: CodeScan | undefined
	// Long tables the view holds some rows of, by top-level index, as it holds them.
	readonly shownTables?: ReadonlyMap<number, Node>
	// Word's formatting marks shown (Show/Hide ¶), with the words breaks are labelled with; undefined: hidden.
	readonly formattingMarks?: DocxMarkLabels | undefined
}

function spaceMark(text: string): () => HTMLElement {
	return () => {
		const element = document.createElement("span")

		element.className = "fo-docx-reflow-format-mark"
		element.contentEditable = "false"
		element.setAttribute("aria-hidden", "true")
		element.textContent = text

		return element
	}
}

const SPACE_WIDGET = spaceMark(SPACE_MARK)
const NBSP_WIDGET = spaceMark(NBSP_MARK)
const LINE_BREAK_WIDGET = spaceMark(LINE_BREAK_MARK)

// How the section after the one paragraph `node` ends starts, as its break is labelled; undefined when it ends none.
function sectionBreakLabel(session: ReflowSource, doc: Node, node: Node, labels: DocxMarkLabels): string | undefined {
	const part = session.story.part

	if (session.story.story.kind !== "body" || !endsSection(part, node)) return undefined

	const sections = bodySections(doc, part)
	const index = sections.findIndex(section => section.node === node)
	const next = index < 0 ? undefined : sections[index + 1]

	if (next === undefined) return undefined

	// An edit's type (null: none, a new page) stands for the source's.
	const edited = next.edit?.type
	const sectPr = edited === undefined ? sectionNode(part, next.key) : -1
	const type = edited !== undefined ? edited : sectPr < 0 ? undefined : session.context.store.section(part.document, sectPr).type

	return sectionLabel(labels, sectionBreakFlags(type) >> SECTION_SHIFT)
}

// Formatting marks in what the view holds: a dot on each space and a degree sign on each non-breaking space, an
// arrow at each line break, page and column breaks labelled, and a section break's paragraph its label (the
// paragraph, tab, end-of-cell and end-of-row marks and hidden text are the stylesheet's, under data-fo-marks).
function formattingMarks(
	session: ReflowSource,
	doc: Node,
	ranges: readonly [number, number][],
	labels: DocxMarkLabels,
	out: Decoration[]
): void {
	for (const [from, to] of ranges) {
		doc.nodesBetween(from, to, (node, pos) => {
			if (node.isText) {
				const text = node.text ?? ""

				for (let k = 0; k < text.length; k++) {
					const code = text.charCodeAt(k)
					const at = pos + k

					if (at < from || at >= to) continue

					if (code === 0x20 || code === 0x3000)
						out.push(Decoration.widget(at, SPACE_WIDGET, { side: 1, key: "s", marks: [], ignoreSelection: true }))
					else if (code === 0xa0 || code === 0x202f)
						out.push(Decoration.widget(at, NBSP_WIDGET, { side: 1, key: "n", marks: [], ignoreSelection: true }))
				}

				return false
			}

			if (node.type === nodes.break) {
				const type = node.attrs["type"]

				if (type === "page" || type === "column")
					out.push(Decoration.node(pos, pos + 1, breakAttrs(type === "page" ? labels.pageBreak : labels.columnBreak)))
				else out.push(Decoration.widget(pos, LINE_BREAK_WIDGET, { side: -1, key: "b", marks: [], ignoreSelection: true }))

				return false
			}

			if (node.type === nodes.paragraph) {
				const label = sectionBreakLabel(session, doc, node, labels)

				if (label !== undefined) out.push(Decoration.node(pos, pos + node.nodeSize, sectionAttrs(label)))
			}

			return true
		})
	}
}

function breakAttrs(label: string): Readonly<Record<string, string>> {
	return interned(`break:${label}`, () => ({ "data-fo-label": label }))
}

function sectionAttrs(label: string): Readonly<Record<string, string>> {
	return interned(`section:${label}`, () => ({ "data-fo-section": label }))
}

function markerElement(text: string, css: string): () => HTMLElement {
	return () => {
		const element = document.createElement("span")

		element.className = "fo-docx-reflow-marker"
		element.contentEditable = "false"
		element.textContent = text

		if (css.length > 0) element.setAttribute("style", css)

		return element
	}
}

// Everything the view draws over the blocks it holds of `doc`.
export function storyDecorations(input: StoryDecorations): DecorationSet {
	const { session, doc, starts, faces, counters } = input
	const count = doc.childCount
	const windows = input.windows ?? [0, count]
	const positionOf = blockPositions(doc, starts)
	const decorations: Decoration[] = []
	// The positions the view holds ([from, to), ascending): its blocks, of a long table the rows it holds.
	const ranges: [number, number][] = []
	const hold = (from: number, to: number): void => {
		const last = ranges[ranges.length - 1]

		if (last !== undefined && last[1] === from) last[1] = to
		else ranges.push([from, to])
	}
	const held = (pos: number): boolean => {
		let low = 0
		let high = ranges.length

		while (low < high) {
			const middle = (low + high) >> 1

			if ((ranges[middle]?.[1] ?? 0) <= pos) low = middle + 1
			else high = middle
		}

		const range = ranges[low]

		return range !== undefined && range[0] <= pos
	}
	// Whether the view holds any of [from, to).
	const holds = (from: number, to: number): boolean => {
		let low = 0
		let high = ranges.length

		while (low < high) {
			const middle = (low + high) >> 1

			if ((ranges[middle]?.[1] ?? 0) <= from) low = middle + 1
			else high = middle
		}

		const range = ranges[low]

		return range !== undefined && range[0] < to
	}

	for (let w = 0; w + 1 < windows.length; w += 2) {
		const from = windows[w] ?? 0
		const to = Math.min(count, windows[w + 1] ?? 0)

		for (let index = from; index < to; index++) {
			const start = positionOf(index)
			const block = doc.child(index)
			const shown = input.shownTables?.get(index) ?? block

			if (shown === block) hold(start, start + block.nodeSize)
			else
				shown.forEach((row, at) => {
					if (gapRowCount(row) === undefined) hold(start + 1 + at, start + 1 + at + row.nodeSize)
				})

			const source = block.type === nodes.table ? input.tables(block, index) : undefined

			for (const local of blockLooks(session, shown, source, faces, input.facesVersion, input.view).locals)
				decorations.push(
					local.node
						? Decoration.node(start + local.from, start + local.to, local.attrs)
						: Decoration.inline(start + local.from, start + local.to, local.attrs, { inclusiveEnd: true })
				)

			// Contextual spacing with the blocks beside it (inside a block, its looks have it).
			const top = index > 0 && contextual(session, doc.child(index - 1), block)[1]
			const bottom = index + 1 < count && contextual(session, block, doc.child(index + 1))[0]
			const spacing = contextualAttrs(top, bottom)

			if (spacing !== undefined) decorations.push(Decoration.node(start, start + block.nodeSize, spacing))
		}
	}

	for (let w = 0; w + 1 < windows.length; w += 2) {
		const from = windows[w] ?? 0
		const to = Math.min(count, windows[w + 1] ?? 0)

		fieldCodes(doc, from, to, positionOf, input.codeShown, input.codeScan, ranges, held, decorations)

		counters?.count(
			session,
			doc,
			from,
			to,
			positionOf,
			(pos, text, paragraph) => {
				if (!held(pos)) return

				const run = session.context.resolver.listMarker(session.formats.paragraph(paragraph))
				const shown = markerText(session, paragraph, text)
				const css = run === undefined ? "" : runCss(run, faces)

				decorations.push(
					Decoration.widget(pos, markerElement(shown, css), {
						side: -1,
						key: `m${shown}\u0000${css}`,
						marks: [],
						ignoreSelection: true
					})
				)
			},
			(pos, text) => {
				if (held(pos)) decorations.push(Decoration.node(pos, pos + 1, { "data-fo-note": text }, { note: text }))
			},
			holds
		)
	}

	// Commented ranges (their references are drawn by the reference's own view).
	if (
		session instanceof DocxEditorSession &&
		session.story.story.kind === "body" &&
		(session.context.model.comments.length > 0 || reviewIndexKept(session))
	) {
		const index = session.reviewIndex
		const entries = index.commentEntries()
		const open = new Map<string, number>()

		for (let k = 0; k < entries.length; k++) {
			const entry = entries[k] ?? 0
			const kind = index.kindOf(entry)
			const id = index.idOf(entry)

			if (kind === ReviewKind.COMMENT_START) open.set(id, index.fromOf(entry))
			else if (kind === ReviewKind.COMMENT_END) {
				const start = open.get(id)

				open.delete(id)

				if (start !== undefined)
					clipped(ranges, start, index.fromOf(entry), (from, to) =>
						decorations.push(Decoration.inline(from, to, commentAttrs(id)))
					)
			}
		}
	}

	if (input.formattingMarks !== undefined) formattingMarks(session, doc, ranges, input.formattingMarks, decorations)

	// The app's marks, those in the blocks held.
	const marks = input.marks

	if (marks.length > 0) {
		for (const [from, to] of ranges) {
			let low = 0
			let high = marks.length

			// The first mark starting at or after `from`, and those before it that reach into the range.
			while (low < high) {
				const middle = (low + high) >> 1

				if ((marks[middle]?.from ?? 0) < from) low = middle + 1
				else high = middle
			}

			while (low > 0 && (marks[low - 1]?.to ?? 0) > from) low--

			for (let k = low; k < marks.length; k++) {
				const mark = marks[k]

				if (mark === undefined || mark.from >= to) break
				if (mark.to <= from) continue

				decorations.push(Decoration.inline(Math.max(from, mark.from), Math.min(to, mark.to), markAttrs(mark.kind)))
			}
		}
	}

	return decorations.length === 0 ? DecorationSet.empty : DecorationSet.create(input.shown ?? doc, decorations)
}

// [from, to) within the ranges held, in pieces.
function clipped(ranges: readonly [number, number][], from: number, to: number, out: (from: number, to: number) => void): void {
	for (const [start, end] of ranges) {
		const a = Math.max(start, from)
		const b = Math.min(end, to)

		if (b > a) out(a, b)
	}
}

function commentAttrs(id: string): Readonly<Record<string, string>> {
	return interned(`comment:${id}`, () => ({ class: "fo-docx-reflow-comment", "data-fo-comment": id }))
}

function markAttrs(kind: string): Readonly<Record<string, string>> {
	return interned(`mark:${kind}`, () => ({ class: "fo-docx-reflow-mark", "data-fo-mark": kind }))
}

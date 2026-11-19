import {
	Item,
	Revision,
	RevisionView,
	SOURCE_INTS,
	SourceInt,
	revisionAuthors,
	type DocxModel,
	type PageDisplayList,
	type StoryPart
} from "../../core/docx/index"
import { MAX_COMMENT_CHARS, MAX_RECTS, dateOf, preview } from "../../core/docx/model/comments"
import { Ns } from "../../core/docx/model/namespaces"
import { FRAGMENT_FLOATS, FRAGMENT_INTS, HitTester, LINE_FLOATS, LINE_INTS, LineInt, type StyleTable } from "../../core/text/index"
import {
	EMPTY_ANNOTATIONS,
	type DocxAnnotations,
	type DocxComment,
	type DocxCommentRun,
	type DocxRevision,
	type DocxRevisionKind,
	type DocxRevisionTarget
} from "./annotations"

// Comments and tracked changes of a laid-out document, each with the boxes of its text on the pages.
// Layout reports which paragraph a line comes from and the line's offsets in the paragraph's text, not
// which items its characters come from: an anchor (a comment range marker, a revision wrapper) is placed
// by walking the paragraph's items as the view shows them, then moving that offset into the text the
// layout drew (which may differ by a list marker in front, or by computed fields). Positions inside a
// line are interpolated over the fragment holding them: boxes for balloons' anchors and change bars, not
// for drawing text.

const MAX_SPAN_PARAGRAPHS = 4096
const MAX_PROPERTIES = 12
const SEARCH_CONTEXT = 16

interface Walked {
	// The paragraph's text as the view shows it.
	readonly text: string
	// Offset in `text` reached at each item of the paragraph (index item - paragraph), and its length last.
	readonly offsets: Int32Array
}

interface SourceRef {
	readonly page: PageDisplayList
	readonly source: number
}

// A place in the text: the layout source (a paragraph, or the first of paragraphs joined by hidden marks)
// and an offset in the text the layout drew for it.
interface Position {
	readonly part: number
	readonly head: number
	readonly offset: number
}

const OFF_VALUES = new Set(["0", "false", "off", "none"])

function paragraphOf(part: StoryPart, item: number): number {
	for (let at = item; at >= 0; at = part.parent(at)) {
		const kind = part.kinds[at] ?? 0

		if (kind === Item.Paragraph) return at
		if (kind >= Item.Body && kind <= Item.Textbox) return -1
	}

	return -1
}

function isStoryRoot(kind: number): boolean {
	return kind >= Item.Body && kind <= Item.Textbox
}

// paragraphText (StoryPart) with the offset reached at every item kept.
function walkParagraph(part: StoryPart, paragraph: number, view: RevisionView): Walked {
	const offsets = new Int32Array(part.end(paragraph) - paragraph + 1)

	return { text: part.paragraphText(paragraph, view, offsets), offsets }
}

// A comment run's text as Word shows it: symbol-font characters (w:sym) as the Unicode characters they
// draw, as layout does; field codes left out.
function runText(part: StoryPart, run: number): string {
	const end = part.end(run)
	let out = ""

	for (let item = run + 1; item < end; item++) {
		switch (part.kinds[item]) {
			case Item.Text:
				out += part.text(item)

				break
			case Item.Tab:
			case Item.PositionalTab:
				out += "\t"

				break
			case Item.Break:
			case Item.CarriageReturn:
				out += "\n"

				break
			case Item.NoBreakHyphen:
				out += "\u2011"

				break
			case Item.Symbol: {
				const char = part.symbolChar(item)

				if (char > 0 && char <= 0x10ffff) out += String.fromCodePoint(char)

				break
			}
		}
	}

	return out
}

function toggle(part: StoryPart, rPr: number, name: string): boolean {
	if (rPr < 0) return false

	const element = part.reader.child(rPr, Ns.W, name)

	if (element < 0) return false

	const value = part.reader.attr(element, Ns.W, "val")

	return value === undefined || !OFF_VALUES.has(value.toLowerCase())
}

function commentRun(part: StoryPart, run: number, text: string): DocxCommentRun {
	const row = part.runRow(run)
	const rPr = row < 0 ? -1 : (part.runs.rPr[row] ?? -1)

	return {
		text,
		bold: toggle(part, rPr, "b"),
		italic: toggle(part, rPr, "i"),
		underline: toggle(part, rPr, "u"),
		strike: toggle(part, rPr, "strike") || toggle(part, rPr, "dstrike")
	}
}

function sameLook(a: DocxCommentRun, b: DocxCommentRun): boolean {
	return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike
}

// A comment's text: its paragraphs' runs as Word shows them (deletions left out), trailing empty
// paragraphs dropped.
function commentParagraphs(part: StoryPart, root: number): DocxCommentRun[][] {
	const out: DocxCommentRun[][] = []
	const end = part.end(root)
	let chars = 0

	for (let item = root + 1; item < end && chars < MAX_COMMENT_CHARS; item++) {
		if (part.kinds[item] !== Item.Paragraph) continue

		const runs: DocxCommentRun[] = []
		const paragraphEnd = part.end(item)

		for (let at = item + 1; at < paragraphEnd; at++) {
			const kind = part.kinds[at] ?? 0

			if (kind === Item.Paragraph || kind === Item.Textbox) {
				at = part.end(at) - 1

				continue
			}

			if (part.hidden(at, RevisionView.Final)) {
				at = part.end(at) - 1

				continue
			}

			if (kind !== Item.Run) continue

			const item = at
			const text = runText(part, item)

			at = part.end(item) - 1

			if (text.length === 0) continue

			const run = commentRun(part, item, text.slice(0, MAX_COMMENT_CHARS - chars))
			const last = runs[runs.length - 1]

			chars += run.text.length

			if (last !== undefined && sameLook(last, run)) runs[runs.length - 1] = { ...last, text: last.text + run.text }
			else runs.push(run)
		}

		out.push(runs)
	}

	while (out.length > 0 && (out[out.length - 1]?.length ?? 0) === 0) out.pop()

	return out
}

// Property elements of a rPr/pPr by local name, each with its attributes as one comparable string.
function propertySignatures(part: StoryPart, element: number): Map<string, string> {
	const out = new Map<string, string>()
	const document = part.document

	if (element < 0) return out

	for (let child = document.firstChildElement(element); child >= 0; child = document.nextSiblingElement(child)) {
		const name = document.localName(child)

		if (IGNORED_PROPERTIES.has(name) || name.endsWith("Change")) continue

		out.set(
			name,
			document
				.attributes(child)
				.map(attribute => `${attribute.name}=${attribute.value}`)
				.sort()
				.join(" ")
		)
	}

	return out
}

// Revision marks of the paragraph mark and nested property groups are not formatting (nor are the change
// elements, *Change).
const IGNORED_PROPERTIES = new Set(["rPr", "sectPr", "ins", "del", "moveFrom", "moveTo"])

// The properties a w:rPrChange / w:pPrChange records as changed: what differs between the properties it
// sits in and the earlier ones it holds.
function changedProperties(part: StoryPart, change: number): string[] {
	const document = part.document
	const current = change < 0 ? -1 : document.parent(change)
	let previous = -1

	if (change >= 0) {
		for (let child = document.firstChildElement(change); child >= 0; child = document.nextSiblingElement(child)) {
			const name = document.localName(child)

			if (name === "rPr" || name === "pPr") {
				previous = child

				break
			}
		}
	}

	const now = propertySignatures(part, current)
	const before = propertySignatures(part, previous)
	const out: string[] = []

	for (const [name, signature] of now) if (before.get(name) !== signature) out.push(name)
	for (const name of before.keys()) if (!now.has(name)) out.push(name)

	return out.slice(0, MAX_PROPERTIES)
}

function revisionKind(kind: number): { kind: DocxRevisionKind; target: DocxRevisionTarget } | undefined {
	switch (kind) {
		case Revision.Insertion:
			return { kind: "insertion", target: "text" }
		case Revision.Deletion:
			return { kind: "deletion", target: "text" }
		case Revision.MoveFrom:
			return { kind: "moveFrom", target: "text" }
		case Revision.MoveTo:
			return { kind: "moveTo", target: "text" }
		case Revision.ParagraphMarkInsertion:
			return { kind: "insertion", target: "paragraph" }
		case Revision.ParagraphMarkDeletion:
			return { kind: "deletion", target: "paragraph" }
		case Revision.ParagraphMarkMoveFrom:
			return { kind: "moveFrom", target: "paragraph" }
		case Revision.ParagraphMarkMoveTo:
			return { kind: "moveTo", target: "paragraph" }
		case Revision.RowInsertion:
		case Revision.CellInsertion:
			return { kind: "insertion", target: "table" }
		case Revision.RowDeletion:
		case Revision.CellDeletion:
			return { kind: "deletion", target: "table" }
		case Revision.RunProperties:
			return { kind: "formatting", target: "text" }
		case Revision.ParagraphProperties:
		case Revision.Numbering:
			return { kind: "formatting", target: "paragraph" }
		case Revision.TableProperties:
		case Revision.RowProperties:
		case Revision.CellProperties:
		case Revision.TableGrid:
		case Revision.TablePropertiesException:
		case Revision.CellMerge:
			return { kind: "formatting", target: "table" }
		case Revision.SectionProperties:
			return { kind: "formatting", target: "section" }
		default:
			// Move ranges only bracket the moveFrom/moveTo wrappers they contain.
			return undefined
	}
}

class Annotator {
	private readonly model: DocxModel
	private readonly view: RevisionView
	private readonly hit: HitTester | undefined
	// "part:paragraph" of every laid-out source -> where it is drawn, in page order.
	private readonly sources = new Map<string, SourceRef[]>()
	// Per part, the laid-out source paragraphs in item order.
	private readonly partParagraphs = new Map<number, number[]>()
	private readonly walked = new Map<string, Walked>()
	private readonly groups = new Map<string, { readonly text: string; readonly members: readonly number[] }>()
	// Per head: model text offset -> layout text offset, or null when the texts could not be matched whole.
	private readonly deltas = new Map<string, number | null>()
	readonly rectPages: number[] = []
	readonly rectFloats: number[] = []

	constructor(model: DocxModel, pages: readonly PageDisplayList[], view: RevisionView, styles: StyleTable | undefined) {
		this.model = model
		this.view = view
		this.hit = styles === undefined ? undefined : new HitTester(styles)

		for (const page of pages) {
			for (let source = 0; source < page.sourceCount; source++) {
				const at = source * SOURCE_INTS
				const story = model.stories[page.sourceInts[at + SourceInt.STORY] ?? -1]
				const item = page.sourceInts[at + SourceInt.ITEM] ?? -1

				if (story === undefined || item < 0) continue

				const key = `${story.part}:${item}`
				let refs = this.sources.get(key)

				if (refs === undefined) {
					refs = []
					this.sources.set(key, refs)

					let list = this.partParagraphs.get(story.part)

					if (list === undefined) {
						list = []
						this.partParagraphs.set(story.part, list)
					}

					list.push(item)
				}

				refs.push({ page, source })
			}
		}

		for (const list of this.partParagraphs.values()) list.sort((a, b) => a - b)
	}

	private walk(partIndex: number, paragraph: number): Walked | undefined {
		const key = `${partIndex}:${paragraph}`
		let walked = this.walked.get(key)

		if (walked === undefined) {
			const part = this.model.parts[partIndex]

			if (part === undefined || part.kinds[paragraph] !== Item.Paragraph) return undefined

			walked = walkParagraph(part, paragraph, this.view)
			this.walked.set(key, walked)
		}

		return walked
	}

	private previousParagraph(part: StoryPart, paragraph: number): number {
		const parent = part.parent(paragraph)

		for (let at = paragraph - 1; at > parent; at--) {
			const kind = part.kinds[at] ?? 0

			if (isStoryRoot(kind)) return -1
			if (kind === Item.Paragraph && part.end(at) <= paragraph) return part.parent(at) === parent ? at : -1
			if (kind === Item.Table) return -1
		}

		return -1
	}

	private nextParagraph(part: StoryPart, paragraph: number): number {
		const parent = part.parent(paragraph)
		const end = parent < 0 ? part.kinds.length : part.end(parent)

		for (let at = part.end(paragraph); at < end; at = part.end(at)) {
			const kind = part.kinds[at] ?? 0

			if (kind === Item.Paragraph) return part.parent(at) === parent ? at : -1
			if (kind === Item.Table || isStoryRoot(kind)) return -1
		}

		return -1
	}

	// The paragraph a laid-out source starts with, and how far into its text `paragraph` begins: a hidden
	// mark joins a paragraph to the next one, which layout draws as one source.
	private head(partIndex: number, paragraph: number): { head: number; base: number } | undefined {
		const part = this.model.parts[partIndex]

		if (part === undefined) return undefined

		let head = paragraph
		let base = 0

		for (let hops = 0; hops < 256; hops++) {
			if (this.sources.has(`${partIndex}:${head}`)) return { head, base }

			const previous = this.previousParagraph(part, head)

			if (previous < 0 || !part.paragraphMarkHidden(previous, this.view)) return undefined

			base += this.walk(partIndex, previous)?.text.length ?? 0
			head = previous
		}

		return undefined
	}

	private group(partIndex: number, head: number): { readonly text: string; readonly members: readonly number[] } {
		const key = `${partIndex}:${head}`
		let group = this.groups.get(key)

		if (group === undefined) {
			const part = this.model.parts[partIndex]
			const members: number[] = []
			let text = ""

			for (let at = head; at >= 0 && part !== undefined && members.length < 256;) {
				members.push(at)
				text += this.walk(partIndex, at)?.text ?? ""

				if (!part.paragraphMarkHidden(at, this.view)) break

				at = this.nextParagraph(part, at)
			}

			group = { text, members }
			this.groups.set(key, group)
		}

		return group
	}

	private layoutText(partIndex: number, head: number): string {
		const ref = this.sources.get(`${partIndex}:${head}`)?.[0]

		return ref?.page.sourceTexts[ref.source] ?? ""
	}

	// A model text offset of a source in the text the layout drew for it.
	private toLayout(partIndex: number, head: number, offset: number): number {
		const key = `${partIndex}:${head}`
		const model = this.group(partIndex, head).text
		const drawn = this.layoutText(partIndex, head)
		let delta = this.deltas.get(key)

		if (delta === undefined) {
			const inside = drawn.endsWith(model) ? drawn.length - model.length : drawn.indexOf(model)

			delta = inside >= 0 ? inside : null
			this.deltas.set(key, delta)
		}

		if (delta !== null) return Math.min(drawn.length, offset + delta)

		// Text drawn differently (computed fields, symbols): the nearest place the text around the offset
		// is found again, else the same share of the drawn text.
		const guess = model.length > 0 ? Math.round((offset * drawn.length) / model.length) : 0
		const after = model.slice(offset, offset + SEARCH_CONTEXT)
		const before = model.slice(Math.max(0, offset - SEARCH_CONTEXT), offset)
		const found = after.length > 0 ? nearest(drawn, after, guess) : -1

		if (found >= 0) return found

		const behind = before.length > 0 ? nearest(drawn, before, guess - before.length) : -1

		return behind >= 0 ? behind + before.length : Math.max(0, Math.min(drawn.length, guess))
	}

	// Where item `item` of part `partIndex` falls in the laid-out text. Between blocks, a start moves on to
	// the next paragraph's start and an end back to the previous one's end.
	position(partIndex: number, item: number, side: "start" | "end"): Position | undefined {
		const part = this.model.parts[partIndex]

		if (part === undefined || item < 0) return undefined

		let paragraph = item < part.kinds.length ? paragraphOf(part, item) : -1
		let offset: number | undefined

		if (paragraph < 0) {
			if (side === "start") {
				for (let at = item; at < part.kinds.length; at++) {
					const kind = part.kinds[at] ?? 0

					if (isStoryRoot(kind)) return undefined
					if (kind === Item.Paragraph) {
						paragraph = at
						offset = 0

						break
					}
				}
			} else {
				for (let at = Math.min(item, part.kinds.length) - 1; at >= 0; at--) {
					const kind = part.kinds[at] ?? 0

					if (isStoryRoot(kind)) return undefined
					if (kind === Item.Paragraph && part.end(at) <= item) {
						paragraph = at

						break
					}
				}
			}

			if (paragraph < 0) return undefined
		}

		const walked = this.walk(partIndex, paragraph)
		const head = this.head(partIndex, paragraph)

		if (walked === undefined || head === undefined) return undefined

		offset ??= item >= part.end(paragraph) ? walked.text.length : (walked.offsets[item - paragraph] ?? walked.text.length)

		return { part: partIndex, head: head.head, offset: this.toLayout(partIndex, head.head, head.base + offset) }
	}

	// Where an item's content starts and ends: within its paragraph, or from the first paragraph of a block
	// (table, row, cell, paragraph) to the end of its last.
	itemRange(partIndex: number, item: number): readonly [Position | undefined, Position | undefined] {
		const part = this.model.parts[partIndex]
		const paragraph = part === undefined ? -1 : paragraphOf(part, item)

		if (part === undefined || paragraph < 0 || paragraph === item) {
			return [
				this.position(partIndex, item, "start"),
				part === undefined ? undefined : this.position(partIndex, part.end(item), "end")
			]
		}

		const walked = this.walk(partIndex, paragraph)
		const head = this.head(partIndex, paragraph)

		if (walked === undefined || head === undefined) return [undefined, undefined]

		const at = (offset: number): Position => ({
			part: partIndex,
			head: head.head,
			offset: this.toLayout(partIndex, head.head, head.base + offset)
		})
		const end = Math.min(part.end(item), part.end(paragraph))

		return [at(walked.offsets[item - paragraph] ?? 0), at(walked.offsets[end - paragraph] ?? walked.text.length)]
	}

	// The laid-out place nearest to an item that is not laid out itself.
	nearest(partIndex: number, item: number): Position | undefined {
		const list = this.partParagraphs.get(partIndex) ?? []
		const next = list[upperBound(list, item)]

		if (next !== undefined) return { part: partIndex, head: next, offset: 0 }

		const previous = list[upperBound(list, item - 1) - 1]

		return previous === undefined ? undefined : { part: partIndex, head: previous, offset: this.layoutText(partIndex, previous).length }
	}

	// The end of a paragraph's laid-out text.
	paragraphEnd(partIndex: number, paragraph: number): Position | undefined {
		const head = this.head(partIndex, paragraph)
		const walked = this.walk(partIndex, paragraph)

		if (head === undefined || walked === undefined) return undefined

		return { part: partIndex, head: head.head, offset: this.toLayout(partIndex, head.head, head.base + walked.text.length) }
	}

	// Adds the boxes of [from, to) (collapsed: a zero-width box where it sits); returns the first box and count.
	rects(from: Position | undefined, to: Position | undefined): { first: number; count: number } {
		const first = this.rectPages.length

		if (from === undefined) return { first, count: 0 }

		const end = to !== undefined && to.part === from.part && to.head >= from.head ? to : from

		if (end.head === from.head) {
			this.sourceRects(from.part, from.head, from.offset, Math.max(from.offset, end.offset), first)
		} else {
			this.sourceRects(from.part, from.head, from.offset, Number.MAX_SAFE_INTEGER, first)

			const list = this.partParagraphs.get(from.part) ?? []
			let at = upperBound(list, from.head)

			for (let n = 0; at < list.length && n < MAX_SPAN_PARAGRAPHS; at++, n++) {
				const paragraph = list[at] ?? -1

				if (paragraph >= end.head) break

				this.sourceRects(from.part, paragraph, 0, Number.MAX_SAFE_INTEGER, first)
			}

			this.sourceRects(from.part, end.head, 0, end.offset, first)
		}

		return { first, count: this.rectPages.length - first }
	}

	private sourceRects(partIndex: number, head: number, start: number, end: number, first: number): void {
		const collapsed = start === end

		for (const { page, source } of this.sources.get(`${partIndex}:${head}`) ?? []) {
			const text = page.text

			for (let line = 0; line < text.lineCount; line++) {
				if (this.rectPages.length - first >= MAX_RECTS) return

				const li = line * LINE_INTS

				if (text.lineInts[li + LineInt.SOURCE] !== source) continue

				const lineStart = text.lineInts[li + LineInt.TEXT_START] ?? 0
				const lineEnd = text.lineInts[li + LineInt.TEXT_END] ?? 0

				if (collapsed ? start < lineStart || start > lineEnd : end <= lineStart || start >= lineEnd) continue

				const lf = line * LINE_FLOATS
				const x0 = this.xAt(page, source, line, Math.max(start, lineStart))
				const x1 = collapsed ? x0 : this.xAt(page, source, line, Math.min(end, lineEnd))

				this.rectPages.push(page.index)
				this.rectFloats.push(Math.min(x0, x1), text.lineFloats[lf] ?? 0, Math.abs(x1 - x0), text.lineFloats[lf + 1] ?? 0)

				if (collapsed) return
			}
		}
	}

	// Measured with the layout's own styles where it has them, else interpolated within the fragment.
	private xAt(page: PageDisplayList, source: number, line: number, offset: number): number {
		return this.hit?.xAtOffset(page.text, line, page.sourceTexts[source] ?? "", offset) ?? xAt(page, line, offset)
	}
}

// The first index whose value is above `value` in an ascending list.
function upperBound(list: readonly number[], value: number): number {
	let low = 0
	let high = list.length

	while (low < high) {
		const middle = (low + high) >> 1

		if ((list[middle] ?? 0) <= value) low = middle + 1
		else high = middle
	}

	return low
}

function nearest(text: string, needle: string, around: number): number {
	let best = -1

	for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
		if (best < 0 || Math.abs(at - around) < Math.abs(best - around)) best = at
		if (at > around) break
	}

	return best
}

// x (px on the page) of text offset `offset` on a line, interpolated within its fragment.
function xAt(page: PageDisplayList, line: number, offset: number): number {
	const text = page.text
	const li = line * LINE_INTS
	const lineX = text.lineFloats[line * LINE_FLOATS + 3] ?? 0
	const first = text.lineInts[li + LineInt.FIRST_FRAGMENT] ?? 0
	const count = text.lineInts[li + LineInt.FRAGMENT_COUNT] ?? 0
	let x = lineX

	for (let k = first; k < first + count; k++) {
		const start = text.fragmentInts[k * FRAGMENT_INTS] ?? 0
		const end = text.fragmentInts[k * FRAGMENT_INTS + 1] ?? 0
		const fx = text.fragmentFloats[k * FRAGMENT_FLOATS] ?? 0
		const width = text.fragmentFloats[k * FRAGMENT_FLOATS + 1] ?? 0

		if (offset <= start) return Math.min(x, fx)
		if (offset < end) return fx + (width * (offset - start)) / Math.max(1, end - start)

		x = fx + width
	}

	return x
}

// `styles`: the layout's text styles, to place positions inside lines exactly (by measuring).
export function collectAnnotations(
	model: DocxModel,
	pages: readonly PageDisplayList[],
	view: RevisionView,
	styles?: StyleTable
): DocxAnnotations {
	if (model.comments.length === 0 && model.parts.every(part => part.revisions.count === 0)) return EMPTY_ANNOTATIONS

	const annotator = new Annotator(model, pages, view, styles)
	// Numbered as the layout numbers them: an author's colour is the same in the text and in the margin.
	const { names: authors, index: author } = revisionAuthors(model)

	const anchors = model.commentAnchors
	const byId = new Map(model.comments.map((comment, index) => [comment.id, index]))
	const comments: DocxComment[] = model.comments.map(comment => {
		const story = model.stories[comment.story]
		const part = story === undefined ? undefined : model.parts[story.part]
		const row = comment.anchor
		let from: Position | undefined
		let to: Position | undefined

		if (row >= 0) {
			const startPart = anchors.startPart[row] ?? -1
			const endPart = anchors.endPart[row] ?? -1
			const referencePart = anchors.referencePart[row] ?? -1

			from =
				startPart >= 0
					? annotator.position(startPart, anchors.startItem[row] ?? -1, "start")
					: referencePart >= 0
						? annotator.position(referencePart, anchors.referenceItem[row] ?? -1, "start")
						: undefined
			to =
				endPart >= 0
					? annotator.position(endPart, anchors.endItem[row] ?? -1, "end")
					: referencePart >= 0
						? annotator.position(referencePart, anchors.referenceItem[row] ?? -1, "end")
						: undefined
		}

		const rects = annotator.rects(from, to)

		return {
			id: comment.id,
			author: author(comment.author),
			initials: comment.initials?.trim() ?? "",
			date: dateOf(comment.dateUtc ?? comment.date),
			paragraphs: part === undefined || story === undefined ? [] : commentParagraphs(part, story.item),
			parent: comment.parentId === undefined ? -1 : (byId.get(comment.parentId) ?? -1),
			done: comment.done,
			firstRect: rects.first,
			rectCount: rects.count
		}
	})

	const revisions: DocxRevision[] = []

	model.parts.forEach((part, partIndex) => {
		const table = part.revisions

		for (let row = 0; row < table.count; row++) {
			const described = revisionKind(table.kind[row] ?? 0)
			const item = table.item[row] ?? -1

			if (described === undefined || item < 0) continue

			const node = table.node[row] ?? -1
			const kind = part.kinds[item] ?? 0
			let rects: { first: number; count: number }

			if (described.target === "paragraph" && described.kind !== "formatting") {
				// A paragraph mark's change sits at the end of its paragraph.
				const end = annotator.paragraphEnd(partIndex, item)

				rects = annotator.rects(end, end)
			} else if (kind === Item.SectionProperties) {
				const end = annotator.position(partIndex, item, "end")

				rects = annotator.rects(end, end)
			} else {
				const [from, to] = annotator.itemRange(partIndex, item)

				rects = annotator.rects(from, to)
			}

			// Content the view leaves out (a deleted row or paragraph when changes show accepted): where it would
			// be, at the next laid-out paragraph's start, else the previous one's end.
			if (rects.count === 0) {
				const at = annotator.nearest(partIndex, item)

				rects = annotator.rects(at, at)
			}

			revisions.push({
				kind: described.kind,
				target: described.target,
				author: author(model.string(table.author[row] ?? -1)),
				date: dateOf(model.string(table.date[row] ?? -1)),
				text:
					described.kind === "formatting" || described.target !== "text"
						? ""
						: preview(part.paragraphText(item, RevisionView.Markup)),
				properties: described.kind === "formatting" && described.target !== "section" ? changedProperties(part, node) : [],
				firstRect: rects.first,
				rectCount: rects.count
			})
		}
	})

	return {
		authors,
		comments,
		revisions,
		rectPages: Int32Array.from(annotator.rectPages),
		rectFloats: Float32Array.from(annotator.rectFloats)
	}
}

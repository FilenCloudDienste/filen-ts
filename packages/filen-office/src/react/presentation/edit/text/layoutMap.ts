import type { Node } from "prosemirror-model"
import {
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FragmentKind,
	HitTester,
	LINE_FLOATS,
	LINE_INTS,
	LineFlag,
	LineInt,
	MeasureCache,
	StyleTable,
	TextLayout,
	type TextMeasurer
} from "../../../../core/text/index"
import {
	TEXT_STYLE_FLOATS,
	TEXT_STYLE_INTS,
	TextStyleFloat,
	TextStyleInt,
	type TransferableTextLayout
} from "../../../../core/presentation/output"
import type { Run, TextBody } from "../../../../core/presentation/model"

// Positions of the body being edited over the worker's layout of it (a TransferableTextLayout, in TextPage px):
// editor document position <-> (paragraph, offset in the paragraph's laid-out text), the caret's and the selection's
// boxes, the position at a point, and line moves. The laid-out text of a paragraph is its marker (bullet or number,
// and its tab) then its runs, where a field shows its current text and a break is one character; document positions
// count text by UTF-16 unit and every atom (break, field, kept content) as one. Carets are measured on this thread
// over the transferred lines through core/text's HitTester, so they sit where the worker placed the glyphs.

export interface CaretBox {
	readonly x: number
	readonly top: number
	readonly height: number
}

export interface SelectionBox {
	readonly x: number
	readonly top: number
	readonly width: number
	readonly height: number
}

const KIND_TEXT = 0
const KIND_ATOM = 1

// Per paragraph: its runs' starts and lengths in the document and in the laid-out text.
interface ParagraphMap {
	readonly docStart: number
	readonly size: number
	readonly prefix: number
	// [docOffset, docLength, layoutOffset, layoutLength, kind] per run.
	readonly runs: Int32Array
}

const RUN_INTS = 5

// What the worker adds to a layout when it can: the marker length and the run ends per paragraph, and each font
// key's kerning (absent: the editor takes the stored run lengths and kerning on).
type RunOffsets = TransferableTextLayout & {
	readonly prefixes?: Int32Array
	readonly runStarts?: Int32Array
	readonly runEnds?: Int32Array
	readonly kerning?: Uint8Array
}

function docLength(run: Run): number {
	return run.kind === "r" ? run.text.length : 1
}

// A run's laid-out length without the worker's run ends: text by its length, a break one, a field or kept content
// by the text the model holds.
function storedLength(run: Run): number {
	return run.kind === "br" ? 1 : run.text.length
}

// The measuring tables the HitTester reads, rebuilt from the transferred rows on `cache` (the fonts of this thread's
// realm, keyed in the transferred order).
function styleTableOf(layout: RunOffsets, cache: MeasureCache): StyleTable {
	const table = new StyleTable(cache)
	const count = Math.max(16, layout.styleCount)
	const keys = layout.fonts.map((css, key) => cache.font(css, (layout.kerning?.[key] ?? 1) === 1))

	table.fontKey = new Int32Array(count)
	table.smallFontKey = new Int32Array(count)
	table.caps = new Uint8Array(count)
	table.letterSpacing = new Float64Array(count)
	table.scaleX = new Float64Array(count)
	table.em = new Float64Array(count)
	table.ascent = new Float64Array(count)
	table.descent = new Float64Array(count)

	for (let id = 0; id < layout.styleCount; id++) {
		const ints = id * TEXT_STYLE_INTS
		const floats = id * TEXT_STYLE_FLOATS

		table.fontKey[id] = keys[layout.styleInts[ints + TextStyleInt.FONT] ?? 0] ?? 0
		table.smallFontKey[id] = keys[layout.styleInts[ints + TextStyleInt.SMALL_FONT] ?? 0] ?? 0
		table.caps[id] = layout.styleInts[ints + TextStyleInt.CAPS] ?? 0
		table.letterSpacing[id] = layout.styleFloats[floats + TextStyleFloat.LETTER_SPACING] ?? 0
		table.scaleX[id] = layout.styleFloats[floats + TextStyleFloat.SCALE_X] ?? 1
		table.em[id] = layout.styleFloats[floats + TextStyleFloat.EM] ?? 0
		table.ascent[id] = layout.styleFloats[floats + TextStyleFloat.ASCENT] ?? 0
		table.descent[id] = layout.styleFloats[floats + TextStyleFloat.DESCENT] ?? 0
	}

	return table
}

function textLayoutOf(layout: TransferableTextLayout): TextLayout {
	const out = new TextLayout()

	out.lineCount = layout.lineCount
	out.fragmentCount = layout.fragmentCount
	out.decorationCount = layout.decorationCount
	// Transferred buffers are plain ArrayBuffers (never shared): the layout's own array types.
	out.lineFloats = layout.lineFloats as Float32Array<ArrayBuffer>
	out.lineInts = layout.lineInts as Int32Array<ArrayBuffer>
	out.fragmentFloats = layout.fragmentFloats as Float32Array<ArrayBuffer>
	out.fragmentInts = layout.fragmentInts as Int32Array<ArrayBuffer>
	out.decorationFloats = layout.decorationFloats as Float32Array<ArrayBuffer>
	out.decorationInts = layout.decorationInts as Int32Array<ArrayBuffer>

	return out
}

// One measuring cache per page realm: prefix widths of the same fonts are asked for over and over while typing.
let sharedCache: { readonly measurer: TextMeasurer; readonly cache: MeasureCache } | undefined

export function measureCacheFor(measurer: TextMeasurer): MeasureCache {
	if (sharedCache?.measurer !== measurer) sharedCache = { measurer, cache: new MeasureCache(measurer) }

	return sharedCache.cache
}

export class LayoutMap {
	readonly layout: TextLayout
	readonly texts: readonly string[]
	private readonly tester: HitTester
	private readonly paragraphs: ParagraphMap[] = []
	// Per paragraph, its lines [first, end).
	private readonly lineStart: Int32Array
	private readonly lineEnd: Int32Array

	// `doc` and `body` are the document and the body that was laid out (body = docToBody(doc)).
	constructor(doc: Node, body: TextBody, transferred: RunOffsets, cache: MeasureCache) {
		this.layout = textLayoutOf(transferred)
		this.texts = transferred.texts
		this.tester = new HitTester(styleTableOf(transferred, cache))

		const count = body.paragraphs.length

		this.lineStart = new Int32Array(count).fill(-1)
		this.lineEnd = new Int32Array(count).fill(-1)

		let pos = 1

		body.paragraphs.forEach((paragraph, p) => {
			const node = doc.maybeChild(p)
			const size = node?.content.size ?? 0
			const text = transferred.texts[p] ?? ""
			const runs = new Int32Array(paragraph.runs.length * RUN_INTS)
			let stored = 0

			for (const run of paragraph.runs) stored += storedLength(run)

			const exact = transferred.runEnds !== undefined && transferred.runStarts !== undefined
			const prefix = transferred.prefixes?.[p] ?? Math.max(0, text.length - stored)
			const first = transferred.runStarts?.[p] ?? 0
			let docOffset = 0
			let layoutOffset = prefix

			paragraph.runs.forEach((run, r) => {
				const length = exact ? (transferred.runEnds?.[first + r] ?? layoutOffset) - layoutOffset : storedLength(run)
				const at = r * RUN_INTS

				runs[at] = docOffset
				runs[at + 1] = docLength(run)
				runs[at + 2] = layoutOffset
				runs[at + 3] = Math.max(0, length)
				runs[at + 4] = run.kind === "r" ? KIND_TEXT : KIND_ATOM
				docOffset += docLength(run)
				layoutOffset += Math.max(0, length)
			})

			this.paragraphs.push({ docStart: pos, size, prefix, runs })
			pos += size + 2
		})

		for (let line = 0; line < this.layout.lineCount; line++) {
			const source = this.layout.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? 0

			if (source < 0 || source >= count) continue
			if ((this.lineStart[source] ?? -1) < 0) this.lineStart[source] = line

			this.lineEnd[source] = line + 1
		}
	}

	get paragraphCount(): number {
		return this.paragraphs.length
	}

	// The paragraph holding document position `pos` and the offset in its laid-out text.
	toLayout(pos: number): { readonly paragraph: number; readonly offset: number } {
		let paragraph = this.paragraphs.length - 1

		for (let p = 0; p < this.paragraphs.length; p++) {
			const map = this.paragraphs[p] as ParagraphMap

			if (pos <= map.docStart + map.size) {
				paragraph = p
				break
			}
		}

		const map = this.paragraphs[paragraph]

		if (map === undefined) return { paragraph: 0, offset: 0 }

		const local = Math.max(0, Math.min(map.size, pos - map.docStart))
		const runs = map.runs

		for (let at = 0; at < runs.length; at += RUN_INTS) {
			const start = runs[at] ?? 0
			const length = runs[at + 1] ?? 0

			if (local > start + length || (local === start + length && at + RUN_INTS < runs.length && length > 0)) continue

			const layoutStart = runs[at + 2] ?? 0

			if (local <= start) return { paragraph, offset: layoutStart }
			if ((runs[at + 4] ?? 0) === KIND_ATOM) return { paragraph, offset: layoutStart + (runs[at + 3] ?? 0) }

			return { paragraph, offset: layoutStart + Math.min(local - start, runs[at + 3] ?? 0) }
		}

		const last = runs.length - RUN_INTS

		return { paragraph, offset: last < 0 ? map.prefix : (runs[last + 2] ?? 0) + (runs[last + 3] ?? 0) }
	}

	// The document position of laid-out offset `offset` of `paragraph` (inside an atom: its nearer edge; inside the
	// marker: the paragraph's start).
	toDoc(paragraph: number, offset: number): number {
		const map = this.paragraphs[Math.max(0, Math.min(this.paragraphs.length - 1, paragraph))]

		if (map === undefined) return 1

		const runs = map.runs

		for (let at = 0; at < runs.length; at += RUN_INTS) {
			const layoutStart = runs[at + 2] ?? 0
			const layoutLength = runs[at + 3] ?? 0

			if (offset > layoutStart + layoutLength) continue

			const docStart = runs[at] ?? 0

			if (offset <= layoutStart) return map.docStart + docStart

			if ((runs[at + 4] ?? 0) === KIND_ATOM) {
				return map.docStart + docStart + (offset - layoutStart >= layoutLength / 2 ? (runs[at + 1] ?? 1) : 0)
			}

			return map.docStart + docStart + Math.min(runs[at + 1] ?? 0, offset - layoutStart)
		}

		return map.docStart + map.size
	}

	private lineFloat(line: number, field: number): number {
		return this.layout.lineFloats[line * LINE_FLOATS + field] ?? 0
	}

	private lineInt(line: number, field: number): number {
		return this.layout.lineInts[line * LINE_INTS + field] ?? 0
	}

	// The line showing offset `offset` of `paragraph`: the first whose text holds it, a wrap's end going to the next
	// line's start (a caret after a line break is on the next line).
	lineOf(paragraph: number, offset: number): number {
		const from = this.lineStart[paragraph] ?? -1
		const to = this.lineEnd[paragraph] ?? -1

		if (from < 0) return -1

		for (let line = from; line < to; line++) {
			const end = this.lineInt(line, LineInt.TEXT_END)

			if (offset < end || line === to - 1) return line
			if (offset === end && (this.lineInt(line, LineInt.FLAGS) & LineFlag.LINE_BREAK) === 0 && line + 1 < to) {
				// At a soft wrap: the caret starts the next line.
				return line + 1
			}
		}

		return to - 1
	}

	caret(pos: number): CaretBox | undefined {
		const { paragraph, offset } = this.toLayout(pos)
		const line = this.lineOf(paragraph, offset)

		if (line < 0) return undefined

		const text = this.texts[paragraph] ?? ""

		return {
			x: this.tester.xAtOffset(this.layout, line, text, offset),
			top: this.lineFloat(line, 0),
			height: this.lineFloat(line, 1)
		}
	}

	// The boxes of [from, to): one per line it covers, from the start (or the line's start) to the end (or the line's
	// end, a paragraph's end showing the width of a space).
	selection(from: number, to: number): SelectionBox[] {
		if (from >= to) return []

		const start = this.toLayout(from)
		const end = this.toLayout(to)
		const out: SelectionBox[] = []

		for (let p = start.paragraph; p <= end.paragraph; p++) {
			const first = this.lineStart[p] ?? -1
			const last = this.lineEnd[p] ?? -1
			const text = this.texts[p] ?? ""

			if (first < 0) continue

			for (let line = first; line < last; line++) {
				const textStart = Math.max(this.lineInt(line, LineInt.TEXT_START), this.paragraphs[p]?.prefix ?? 0)
				const textEnd = this.lineInt(line, LineInt.TEXT_END)
				const a = p === start.paragraph ? Math.max(start.offset, textStart) : textStart
				const b = p === end.paragraph ? Math.min(end.offset, textEnd) : textEnd

				if (a > b || (a === b && !(p < end.paragraph && line === last - 1))) continue

				const x1 = this.tester.xAtOffset(this.layout, line, text, a)
				let x2 = this.tester.xAtOffset(this.layout, line, text, b)

				// A selected paragraph end shows as a sliver past the line.
				if (p < end.paragraph && line === last - 1) x2 = Math.max(x1, x2) + this.lineFloat(line, 1) * 0.25

				out.push({ x: Math.min(x1, x2), top: this.lineFloat(line, 0), width: Math.abs(x2 - x1), height: this.lineFloat(line, 1) })
			}
		}

		return out
	}

	// The line nearest (x, y): containing y, then nearest in x among them (columns), else nearest by distance.
	private lineAt(x: number, y: number): number {
		let best = -1
		let distance = Infinity

		for (let line = 0; line < this.layout.lineCount; line++) {
			const top = this.lineFloat(line, 0)
			const height = this.lineFloat(line, 1)
			const left = this.lineFloat(line, 3)
			const width = Math.max(this.lineFloat(line, 4), 1)
			const dy = y < top ? top - y : y > top + height ? y - top - height : 0
			const dx = x < left ? left - x : x > left + width ? x - left - width : 0
			const d = dy * 4 + dx

			if (d < distance) {
				distance = d
				best = line
			}
		}

		return best
	}

	// The document position nearest (x, y) in TextPage px.
	posAt(x: number, y: number): number {
		const line = this.lineAt(x, y)

		if (line < 0) return 1

		const paragraph = this.lineInt(line, LineInt.SOURCE)
		const text = this.texts[paragraph] ?? ""
		const offset = Math.max(this.paragraphs[paragraph]?.prefix ?? 0, this.tester.offsetAtX(this.layout, line, text, x))

		return this.toDoc(paragraph, offset)
	}

	// The position one line up or down from `pos` at `goalX` (undefined past the first or last line).
	lineMove(pos: number, direction: 1 | -1, goalX: number): number | undefined {
		const { paragraph, offset } = this.toLayout(pos)
		const line = this.lineOf(paragraph, offset)
		const target = line + direction

		if (line < 0 || target < 0 || target >= this.layout.lineCount) return undefined

		const targetParagraph = this.lineInt(target, LineInt.SOURCE)
		const text = this.texts[targetParagraph] ?? ""
		const at = Math.max(this.paragraphs[targetParagraph]?.prefix ?? 0, this.tester.offsetAtX(this.layout, target, text, goalX))
		// A soft wrap's end is the next line's start: stay on the line asked for.
		const end = this.lineInt(target, LineInt.TEXT_END)
		const wrapped = at === end && (this.lineInt(target, LineInt.FLAGS) & (LineFlag.LAST | LineFlag.LINE_BREAK)) === 0

		return this.toDoc(targetParagraph, wrapped ? Math.max(this.lineInt(target, LineInt.TEXT_START), end - 1) : at)
	}

	// The start or end of the line showing `pos` (Home, End).
	lineEdge(pos: number, edge: "start" | "end"): number {
		const { paragraph, offset } = this.toLayout(pos)
		const line = this.lineOf(paragraph, offset)

		if (line < 0) return pos

		if (edge === "start")
			return this.toDoc(paragraph, Math.max(this.lineInt(line, LineInt.TEXT_START), this.paragraphs[paragraph]?.prefix ?? 0))

		let end = this.lineInt(line, LineInt.TEXT_END)
		const flags = this.lineInt(line, LineInt.FLAGS)

		// Before the break character of a line break, and before a soft wrap's trailing space.
		if ((flags & LineFlag.LINE_BREAK) !== 0) end--
		else if ((flags & LineFlag.LAST) === 0 && /\s/u.test((this.texts[paragraph] ?? "")[end - 1] ?? "")) end--

		return this.toDoc(paragraph, end)
	}

	// Whether a line's fragments hold text (an empty paragraph's line has none): for tests and the caret's height.
	hasText(line: number): boolean {
		const first = this.lineInt(line, LineInt.FIRST_FRAGMENT)
		const count = this.lineInt(line, LineInt.FRAGMENT_COUNT)

		for (let f = first; f < first + count; f++) {
			if (((this.layout.fragmentInts[f * FRAGMENT_INTS + 3] ?? 0) & FRAGMENT_KIND_MASK) === FragmentKind.TEXT) return true
		}

		return count > 0 && (this.layout.fragmentFloats[first * FRAGMENT_FLOATS + 1] ?? 0) > 0
	}
}

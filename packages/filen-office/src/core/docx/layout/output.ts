import {
	DECORATION_FLOATS,
	DECORATION_INTS,
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	LINE_FLOATS,
	LINE_INTS,
	LineInt,
	TextLayout,
	type DecorationKind
} from "../../text/index"

// A page's display list: the text lines of every story on it (core/text layout), plus graphics (fills,
// borders, rules), placed objects and the paragraphs the lines come from, all in typed arrays. Coordinates
// are px from the page's top left corner.

// graphicFloats: x, y, width, height. graphicInts: kind, key, layer.
export const GRAPHIC_FLOATS = 4
export const GRAPHIC_INTS = 3

export const PageGraphic = {
	// A fill: key is a DecorationTable colour key.
	SHADING: 1,
	// A border line drawn as its box (width or height is the line's thickness): key is a border key.
	BORDER: 2,
	// The rule between columns (w:cols w:sep).
	COLUMN_SEPARATOR: 3,
	// A note separator drawn without a separator story.
	NOTE_SEPARATOR: 4,
	// A changed-line bar in the margin (tracked changes shown as markup).
	REVISION_BAR: 5,
	// A cell's diagonal border from the box's top left to its bottom right corner (w:tl2br), and from its top
	// right to its bottom left (w:tr2bl): key is a border key, the line's width the border's.
	DIAGONAL_DOWN: 6,
	DIAGONAL_UP: 7
} as const

export type PageGraphic = (typeof PageGraphic)[keyof typeof PageGraphic]

export const Layer = {
	// Behind the text: fills, floating objects with behindDoc.
	BEHIND: 0,
	// With the text: borders, inline and wrapped objects.
	TEXT: 1,
	// In front of the text.
	FRONT: 2
} as const

export type Layer = (typeof Layer)[keyof typeof Layer]

// Clip rectangles (rows of exact height cut their cells' content): clipFloats x, y, width, height; clipInts
// the lines [first, end) and objects [first, end) drawn through the clip.
export const CLIP_FLOATS = 4
export const CLIP_INTS = 4

// objectFloats: x, y, width, height. objectInts: object id (DocumentLayout.objects), layer, source.
export const OBJECT_FLOATS = 4
export const OBJECT_INTS = 3

// Where a source paragraph lives on the page.
export const Region = {
	BODY: 0,
	HEADER: 1,
	FOOTER: 2,
	FOOTNOTE: 3,
	ENDNOTE: 4,
	TEXTBOX: 5,
	// Line numbers in the margin (w:lnNumType); the source names no item.
	LINE_NUMBER: 6,
	// A list marker, a page number or other generated text with no paragraph of its own.
	GENERATED: 7
} as const

export type Region = (typeof Region)[keyof typeof Region]

export const SourceFlag = {
	// The paragraph sits in a table cell.
	IN_TABLE: 1,
	// The paragraph's text contains page-dependent fields.
	PAGE_FIELDS: 2,
	// The text depends on the document's page count (NUMPAGES, SECTIONPAGES).
	TOTAL_FIELDS: 4,
	// The paragraph's lines are neither numbered nor counted (w:suppressLineNumbers).
	NO_LINE_NUMBERS: 8
} as const

// sourceInts: region, story, item (the first paragraph of a joined group), flags. Line SOURCE values index
// these; the source's text is what the line's text offsets index.
export const SOURCE_INTS = 4

const NO_FOOTNOTES: readonly number[] = []

export const SourceInt = { REGION: 0, STORY: 1, ITEM: 2, FLAGS: 3 } as const

// What append() copies from: a growing output or a finished page.
export interface OutputView {
	readonly text: TextLayout
	readonly graphicCount: number
	readonly graphicFloats: Float32Array
	readonly graphicInts: Int32Array
	readonly objectCount: number
	readonly objectFloats: Float32Array
	readonly objectInts: Int32Array
	readonly sourceCount: number
	readonly sourceInts: Int32Array
	readonly sourceTexts: readonly string[]
	// The part each source's item belongs to (its paragraph may come from an overlay part), -1 without one.
	readonly sourceParts: Int32Array
	// The object (DocumentLayout.objects id) whose text box each source's paragraph is laid out in, -1 for none.
	readonly sourceOwners: Int32Array
	// Per source, when the layout records them, SOURCE_MAP_INTS per laid-out item of its paragraphs: all in
	// one pool per page, source s using [sourceMapRanges[2s], sourceMapRanges[2s + 1]) of it.
	readonly sourceMapPool: Int32Array
	readonly sourceMapRanges: Int32Array
	readonly clipCount: number
	readonly clipFloats: Float32Array
	readonly clipInts: Int32Array
}

// A source's map from items to its text: part, item, start and end offset of what the item laid out, in
// text order (items of one paragraph ascending). Items that laid out nothing have no entry.
export const SOURCE_MAP_INTS = 4

const PIN_INTS = 8

// A position in an output to roll back to or move content after.
export class OutputMark {
	lines = 0
	graphics = 0
	objects = 0
	sources = 0
	clips = 0

	copy(from: OutputMark): this {
		this.lines = from.lines
		this.graphics = from.graphics
		this.objects = from.objects
		this.sources = from.sources
		this.clips = from.clips

		return this
	}
}

function growF32(a: Float32Array, size: number): Float32Array<ArrayBuffer> {
	const out = new Float32Array(Math.max(size, a.length * 2))

	out.set(a)

	return out
}

function growI32(a: Int32Array, size: number): Int32Array<ArrayBuffer> {
	const out = new Int32Array(Math.max(size, a.length * 2))

	out.set(a)

	return out
}

// The copied range [first, last + 1) of source indices [from, to) under `map` (offset by `base`), or null.
function remap(map: Int32Array, base: number, from: number, to: number): [number, number] | null {
	let first = -1
	let last = -1

	for (let k = Math.max(from, base); k < to && k - base < map.length; k++) {
		const index = map[k - base] ?? -1

		if (index < 0) continue

		if (first < 0) first = index

		last = index
	}

	return first < 0 ? null : [first, last + 1]
}

// The growing output of one page (or of a story laid out off-page, then appended).
export class PageOutput {
	readonly text = new TextLayout()
	graphicCount = 0
	graphicFloats = new Float32Array(GRAPHIC_FLOATS * 32)
	graphicInts = new Int32Array(GRAPHIC_INTS * 32)
	objectCount = 0
	objectFloats = new Float32Array(OBJECT_FLOATS * 8)
	objectInts = new Int32Array(OBJECT_INTS * 8)
	sourceCount = 0
	sourceInts = new Int32Array(SOURCE_INTS * 64)
	sourceTexts: string[] = []
	sourceParts = new Int32Array(64)
	sourceOwners = new Int32Array(64)
	sourceMapPool = new Int32Array(0)
	sourceMapRanges = new Int32Array(128)
	private mapLength = 0
	clipCount = 0
	clipFloats = new Float32Array(CLIP_FLOATS * 4)
	clipInts = new Int32Array(CLIP_INTS * 4)
	// w:lastRenderedPageBreak offsets per source (body paragraphs only), for checks against Word's breaks.
	sourceBreaks: (readonly number[] | undefined)[] = []
	// Ranges that keep their place when the page's text moves (moveText): objects positioned on the page or
	// its margins. PIN_INTS each: from and to of lines, graphics, objects and clips.
	private pins: number[] = []

	reset(): void {
		this.pins.length = 0
		this.text.reset()
		this.graphicCount = 0
		this.objectCount = 0
		this.sourceCount = 0
		this.sourceTexts.length = 0
		this.mapLength = 0
		this.sourceBreaks.length = 0
		this.clipCount = 0
	}

	addClip(
		x: number,
		y: number,
		width: number,
		height: number,
		lineFrom: number,
		lineTo: number,
		objectFrom: number,
		objectTo: number
	): void {
		if (lineTo <= lineFrom && objectTo <= objectFrom) return

		const index = this.clipCount

		if ((index + 1) * CLIP_INTS > this.clipInts.length) {
			this.clipInts = growI32(this.clipInts, (index + 1) * CLIP_INTS)
			this.clipFloats = growF32(this.clipFloats, (index + 1) * CLIP_FLOATS)
		}

		const f = index * CLIP_FLOATS
		const i = index * CLIP_INTS

		this.clipFloats[f] = x
		this.clipFloats[f + 1] = y
		this.clipFloats[f + 2] = width
		this.clipFloats[f + 3] = height
		this.clipInts[i] = lineFrom
		this.clipInts[i + 1] = lineTo
		this.clipInts[i + 2] = objectFrom
		this.clipInts[i + 3] = objectTo
		this.clipCount++
	}

	addSource(
		region: Region,
		story: number,
		item: number,
		flags: number,
		text: string,
		breaks?: readonly number[],
		part = -1,
		map?: ArrayLike<number>,
		mapStart = 0,
		mapEnd: number = map?.length ?? 0
	): number {
		const source = this.sourceCount

		if ((source + 1) * SOURCE_INTS > this.sourceInts.length) this.sourceInts = growI32(this.sourceInts, (source + 1) * SOURCE_INTS)
		if (source + 1 > this.sourceParts.length) this.sourceParts = growI32(this.sourceParts, source + 1)
		if (source + 1 > this.sourceOwners.length) this.sourceOwners = growI32(this.sourceOwners, source + 1)
		if ((source + 1) * 2 > this.sourceMapRanges.length) this.sourceMapRanges = growI32(this.sourceMapRanges, (source + 1) * 2)

		const at = source * SOURCE_INTS

		this.sourceInts[at] = region
		this.sourceInts[at + 1] = story
		this.sourceInts[at + 2] = item
		this.sourceInts[at + 3] = flags
		this.sourceTexts[source] = text
		this.sourceParts[source] = part
		this.sourceOwners[source] = -1
		this.sourceMapRanges[source * 2] = this.mapLength

		if (map !== undefined && mapEnd > mapStart) {
			const length = mapEnd - mapStart

			if (this.mapLength + length > this.sourceMapPool.length)
				this.sourceMapPool = growI32(this.sourceMapPool, this.mapLength + length)

			for (let k = 0; k < length; k++) this.sourceMapPool[this.mapLength + k] = map[mapStart + k] ?? 0

			this.mapLength += length
		}

		this.sourceMapRanges[source * 2 + 1] = this.mapLength
		this.sourceBreaks[source] = breaks
		this.sourceCount++

		return source
	}

	// Sources [from, to) are text of object `id`'s text box; those of a box inside it keep theirs.
	ownSources(from: number, to: number, id: number): void {
		for (let s = from; s < to; s++) if (this.sourceOwners[s] === -1) this.sourceOwners[s] = id
	}

	sourceFlags(source: number): number {
		return this.sourceInts[source * SOURCE_INTS + SourceInt.FLAGS] ?? 0
	}

	addGraphic(kind: PageGraphic, key: number, layer: Layer, x: number, y: number, width: number, height: number): void {
		if (!(width > 0 && height > 0)) return

		const index = this.graphicCount

		if ((index + 1) * GRAPHIC_INTS > this.graphicInts.length) {
			this.graphicInts = growI32(this.graphicInts, (index + 1) * GRAPHIC_INTS)
			this.graphicFloats = growF32(this.graphicFloats, (index + 1) * GRAPHIC_FLOATS)
		}

		const f = index * GRAPHIC_FLOATS
		const i = index * GRAPHIC_INTS

		this.graphicFloats[f] = x
		this.graphicFloats[f + 1] = y
		this.graphicFloats[f + 2] = width
		this.graphicFloats[f + 3] = height
		this.graphicInts[i] = kind
		this.graphicInts[i + 1] = key
		this.graphicInts[i + 2] = layer
		this.graphicCount++
	}

	addObject(id: number, layer: Layer, source: number, x: number, y: number, width: number, height: number): void {
		const index = this.objectCount

		if ((index + 1) * OBJECT_INTS > this.objectInts.length) {
			this.objectInts = growI32(this.objectInts, (index + 1) * OBJECT_INTS)
			this.objectFloats = growF32(this.objectFloats, (index + 1) * OBJECT_FLOATS)
		}

		const f = index * OBJECT_FLOATS
		const i = index * OBJECT_INTS

		this.objectFloats[f] = x
		this.objectFloats[f + 1] = y
		this.objectFloats[f + 2] = width
		this.objectFloats[f + 3] = height
		this.objectInts[i] = id
		this.objectInts[i + 1] = layer
		this.objectInts[i + 2] = source
		this.objectCount++
	}

	// Puts the objects of each layer in paint order: ascending `z` (wp:anchor/@relativeHeight, ECMA-376 §20.4.2.3),
	// ties in the order they were placed. Each layer keeps its slots; objects a clip draws through keep theirs (clips
	// name ranges of objects).
	stackObjects(z: (id: number) => number): void {
		const count = this.objectCount
		let pinned: Uint8Array | undefined

		for (let c = 0; c < this.clipCount; c++) {
			const from = this.clipInts[c * CLIP_INTS + 2] ?? 0
			const to = Math.min(count, this.clipInts[c * CLIP_INTS + 3] ?? 0)

			if (to > from) pinned ??= new Uint8Array(count)

			for (let o = from; o < to; o++) if (pinned !== undefined) pinned[o] = 1
		}

		for (const layer of [Layer.BEHIND, Layer.TEXT, Layer.FRONT]) {
			const slots: number[] = []
			let ordered = true
			let last = -Infinity

			for (let o = 0; o < count; o++) {
				if (this.objectInts[o * OBJECT_INTS + 1] !== layer || pinned?.[o] === 1) continue

				const value = z(this.objectInts[o * OBJECT_INTS] ?? -1)

				if (value < last) ordered = false

				last = Math.max(last, value)
				slots.push(o)
			}

			if (ordered) continue

			const keys = slots.map(o => z(this.objectInts[o * OBJECT_INTS] ?? -1))
			const order = slots.map((_, k) => k).sort((a, b) => (keys[a] ?? 0) - (keys[b] ?? 0) || a - b)
			const floats = this.objectFloats.slice(0, count * OBJECT_FLOATS)
			const ints = this.objectInts.slice(0, count * OBJECT_INTS)

			for (let k = 0; k < slots.length; k++) {
				const to = slots[k] ?? 0
				const from = slots[order[k] ?? k] ?? 0

				this.objectFloats.set(floats.subarray(from * OBJECT_FLOATS, (from + 1) * OBJECT_FLOATS), to * OBJECT_FLOATS)
				this.objectInts.set(ints.subarray(from * OBJECT_INTS, (from + 1) * OBJECT_INTS), to * OBJECT_INTS)
			}
		}
	}

	mark(into: OutputMark = new OutputMark()): OutputMark {
		into.lines = this.text.lineCount
		into.graphics = this.graphicCount
		into.objects = this.objectCount
		into.sources = this.sourceCount
		into.clips = this.clipCount

		return into
	}

	rollback(mark: OutputMark): void {
		this.unpin(mark)
		this.text.truncate(mark.lines)
		this.graphicCount = Math.min(this.graphicCount, mark.graphics)
		this.objectCount = Math.min(this.objectCount, mark.objects)
		this.clipCount = Math.min(this.clipCount, mark.clips)

		if (mark.sources < this.sourceCount) {
			this.sourceCount = mark.sources
			this.sourceTexts.length = mark.sources
			this.mapLength = mark.sources > 0 ? (this.sourceMapRanges[mark.sources * 2 - 1] ?? 0) : 0
			this.sourceBreaks.length = mark.sources
		}
	}

	// Moves what was added between `from` and `to` (default: now) by (dx, dy).
	move(from: OutputMark, to: OutputMark | null, dx: number, dy: number): void {
		const text = this.text
		const lineEnd = to?.lines ?? text.lineCount

		if (dx === 0 && dy === 0) return

		for (let line = from.lines; line < lineEnd; line++) {
			const f = line * LINE_FLOATS
			const i = line * LINE_INTS

			text.lineFloats[f] = (text.lineFloats[f] ?? 0) + dy
			text.lineFloats[f + 2] = (text.lineFloats[f + 2] ?? 0) + dy
			text.lineFloats[f + 3] = (text.lineFloats[f + 3] ?? 0) + dx

			if (dx !== 0) {
				const first = text.lineInts[i + LineInt.FIRST_FRAGMENT] ?? 0
				const count = text.lineInts[i + LineInt.FRAGMENT_COUNT] ?? 0

				for (let k = first; k < first + count; k++)
					text.fragmentFloats[k * FRAGMENT_FLOATS] = (text.fragmentFloats[k * FRAGMENT_FLOATS] ?? 0) + dx
			}
		}

		if (from.lines < lineEnd) {
			const firstDecoration = text.lineInts[from.lines * LINE_INTS + LineInt.FIRST_DECORATION] ?? text.decorationCount
			const lastDecoration =
				lineEnd < text.lineCount ? (text.lineInts[lineEnd * LINE_INTS + LineInt.FIRST_DECORATION] ?? 0) : text.decorationCount

			for (let d = firstDecoration; d < lastDecoration; d++) {
				const f = d * DECORATION_FLOATS

				text.decorationFloats[f] = (text.decorationFloats[f] ?? 0) + dx
				text.decorationFloats[f + 1] = (text.decorationFloats[f + 1] ?? 0) + dy
			}
		}

		const graphicEnd = to?.graphics ?? this.graphicCount

		for (let g = from.graphics; g < graphicEnd; g++) {
			const f = g * GRAPHIC_FLOATS

			this.graphicFloats[f] = (this.graphicFloats[f] ?? 0) + dx
			this.graphicFloats[f + 1] = (this.graphicFloats[f + 1] ?? 0) + dy
		}

		const objectEnd = to?.objects ?? this.objectCount

		for (let o = from.objects; o < objectEnd; o++) {
			const f = o * OBJECT_FLOATS

			this.objectFloats[f] = (this.objectFloats[f] ?? 0) + dx
			this.objectFloats[f + 1] = (this.objectFloats[f + 1] ?? 0) + dy
		}

		const clipEnd = to?.clips ?? this.clipCount

		for (let c = from.clips; c < clipEnd; c++) {
			const f = c * CLIP_FLOATS

			this.clipFloats[f] = (this.clipFloats[f] ?? 0) + dx
			this.clipFloats[f + 1] = (this.clipFloats[f + 1] ?? 0) + dy
		}
	}

	// Something keeps its place (pin).
	get pinned(): boolean {
		return this.pins.length > 0
	}

	// What was added since `from` keeps its place when moveText moves the rest.
	pin(from: OutputMark): void {
		this.unpin(from)
		this.pins.push(
			from.lines,
			this.text.lineCount,
			from.graphics,
			this.graphicCount,
			from.objects,
			this.objectCount,
			from.clips,
			this.clipCount
		)
	}

	// Drops the pins recorded since `mark`: they start at or after it in every list.
	private unpin(mark: OutputMark): void {
		const pins = this.pins

		while (
			pins.length > 0 &&
			(pins[pins.length - PIN_INTS] ?? 0) >= mark.lines &&
			(pins[pins.length - PIN_INTS + 2] ?? 0) >= mark.graphics &&
			(pins[pins.length - PIN_INTS + 4] ?? 0) >= mark.objects &&
			(pins[pins.length - PIN_INTS + 6] ?? 0) >= mark.clips
		)
			pins.length -= PIN_INTS
	}

	// Moves everything but the pinned ranges by dy (section vertical alignment).
	moveText(dy: number): void {
		const pins = this.pins
		const from = new OutputMark()
		const to = new OutputMark()

		for (let at = 0; at < pins.length; at += PIN_INTS) {
			to.lines = pins[at] ?? 0
			to.graphics = pins[at + 2] ?? 0
			to.objects = pins[at + 4] ?? 0
			to.clips = pins[at + 6] ?? 0
			this.move(from, to, 0, dy)
			from.lines = pins[at + 1] ?? 0
			from.graphics = pins[at + 3] ?? 0
			from.objects = pins[at + 5] ?? 0
			from.clips = pins[at + 7] ?? 0
		}

		this.move(from, null, 0, dy)
	}

	// Bottom of the content added since `from` (lines, graphics and objects), or -Infinity.
	bottomSince(from: OutputMark): number {
		let bottom = -Infinity
		const text = this.text

		for (let line = from.lines; line < text.lineCount; line++) {
			bottom = Math.max(bottom, (text.lineFloats[line * LINE_FLOATS] ?? 0) + (text.lineFloats[line * LINE_FLOATS + 1] ?? 0))
		}

		for (let g = from.graphics; g < this.graphicCount; g++) {
			bottom = Math.max(bottom, (this.graphicFloats[g * GRAPHIC_FLOATS + 1] ?? 0) + (this.graphicFloats[g * GRAPHIC_FLOATS + 3] ?? 0))
		}

		return bottom
	}

	// Appends what `source` holds between `from` and `to` (default: all of it) whose top lies in
	// [clipTop, clipBottom), moved by (dx, dy). Sources come along whole (up to `to`), renumbered.
	append(
		source: OutputView,
		dx: number,
		dy: number,
		clipTop = -Infinity,
		clipBottom = Infinity,
		from: OutputMark | null = null,
		to: OutputMark | null = null
	): void {
		const sourceOffset = this.sourceCount
		const sourceEnd = Math.min(source.sourceCount, to?.sources ?? source.sourceCount)

		for (let s = 0; s < sourceEnd; s++) {
			const at = s * SOURCE_INTS

			this.addSource(
				(source.sourceInts[at] ?? 0) as Region,
				source.sourceInts[at + 1] ?? -1,
				source.sourceInts[at + 2] ?? -1,
				source.sourceInts[at + 3] ?? 0,
				source.sourceTexts[s] ?? "",
				undefined,
				source.sourceParts[s] ?? -1,
				source.sourceMapPool,
				source.sourceMapRanges[s * 2] ?? 0,
				source.sourceMapRanges[s * 2 + 1] ?? 0
			)
			this.sourceOwners[sourceOffset + s] = source.sourceOwners[s] ?? -1
		}

		const text = source.text
		const out = this.text
		const lineStart = from?.lines ?? 0
		const lineEnd = Math.min(text.lineCount, to?.lines ?? text.lineCount)
		// New index of each copied line (-1 when clipped away), for clip rectangles.
		const lineMap = source.clipCount > 0 ? new Int32Array(Math.max(0, lineEnd - lineStart)).fill(-1) : null

		for (let line = lineStart; line < lineEnd; line++) {
			const f = line * LINE_FLOATS
			const i = line * LINE_INTS
			const top = text.lineFloats[f] ?? 0

			if (top < clipTop - 1e-3 || top >= clipBottom - 1e-3) continue

			if (lineMap !== null) lineMap[line - lineStart] = out.lineCount

			out.addLine(
				top + dy,
				text.lineFloats[f + 1] ?? 0,
				(text.lineFloats[f + 2] ?? 0) + dy,
				(text.lineFloats[f + 3] ?? 0) + dx,
				text.lineFloats[f + 4] ?? 0,
				text.lineInts[i + LineInt.TEXT_START] ?? 0,
				text.lineInts[i + LineInt.TEXT_END] ?? 0,
				text.lineInts[i + LineInt.FLAGS] ?? 0,
				(text.lineInts[i + LineInt.SOURCE] ?? 0) + sourceOffset
			)

			const first = text.lineInts[i + LineInt.FIRST_FRAGMENT] ?? 0
			const count = text.lineInts[i + LineInt.FRAGMENT_COUNT] ?? 0

			for (let k = first; k < first + count; k++) {
				const ff = k * FRAGMENT_FLOATS
				const fi = k * FRAGMENT_INTS

				out.addFragment(
					(text.fragmentFloats[ff] ?? 0) + dx,
					text.fragmentFloats[ff + 1] ?? 0,
					text.fragmentFloats[ff + 2] ?? 0,
					text.fragmentFloats[ff + 3] ?? 0,
					text.fragmentInts[fi] ?? 0,
					text.fragmentInts[fi + 1] ?? 0,
					text.fragmentInts[fi + 2] ?? 0,
					text.fragmentInts[fi + 3] ?? 0,
					text.fragmentInts[fi + 4] ?? 0
				)
			}

			const firstDecoration = text.lineInts[i + LineInt.FIRST_DECORATION] ?? 0
			const lastDecoration =
				line + 1 < text.lineCount ? (text.lineInts[i + LINE_INTS + LineInt.FIRST_DECORATION] ?? 0) : text.decorationCount

			for (let d = firstDecoration; d < lastDecoration; d++) {
				const df = d * DECORATION_FLOATS
				const di = d * DECORATION_INTS

				out.addDecoration(
					(text.decorationInts[di] ?? 0) as DecorationKind,
					text.decorationInts[di + 1] ?? 0,
					(text.decorationFloats[df] ?? 0) + dx,
					(text.decorationFloats[df + 1] ?? 0) + dy,
					text.decorationFloats[df + 2] ?? 0,
					text.decorationFloats[df + 3] ?? 0
				)
			}
		}

		const graphicEnd = Math.min(source.graphicCount, to?.graphics ?? source.graphicCount)

		for (let g = from?.graphics ?? 0; g < graphicEnd; g++) {
			const f = g * GRAPHIC_FLOATS
			const i = g * GRAPHIC_INTS
			const y = source.graphicFloats[f + 1] ?? 0

			if (y < clipTop - 1e-3 || y >= clipBottom - 1e-3) continue

			this.addGraphic(
				(source.graphicInts[i] ?? 0) as PageGraphic,
				source.graphicInts[i + 1] ?? 0,
				(source.graphicInts[i + 2] ?? 0) as Layer,
				(source.graphicFloats[f] ?? 0) + dx,
				y + dy,
				source.graphicFloats[f + 2] ?? 0,
				source.graphicFloats[f + 3] ?? 0
			)
		}

		const objectStart = from?.objects ?? 0
		const objectEnd = Math.min(source.objectCount, to?.objects ?? source.objectCount)
		const objectMap = source.clipCount > 0 ? new Int32Array(Math.max(0, objectEnd - objectStart)).fill(-1) : null

		for (let o = objectStart; o < objectEnd; o++) {
			const f = o * OBJECT_FLOATS
			const i = o * OBJECT_INTS
			const y = source.objectFloats[f + 1] ?? 0

			if (y < clipTop - 1e-3 || y >= clipBottom - 1e-3) continue

			const objectSource = source.objectInts[i + 2] ?? -1

			if (objectMap !== null) objectMap[o - objectStart] = this.objectCount

			this.addObject(
				source.objectInts[i] ?? 0,
				(source.objectInts[i + 1] ?? 0) as Layer,
				objectSource < 0 ? -1 : objectSource + sourceOffset,
				(source.objectFloats[f] ?? 0) + dx,
				y + dy,
				source.objectFloats[f + 2] ?? 0,
				source.objectFloats[f + 3] ?? 0
			)
		}

		if (lineMap === null || objectMap === null) return

		const clipEnd = Math.min(source.clipCount, to?.clips ?? source.clipCount)

		for (let c = from?.clips ?? 0; c < clipEnd; c++) {
			const f = c * CLIP_FLOATS
			const i = c * CLIP_INTS
			const lines = remap(lineMap, lineStart, source.clipInts[i] ?? 0, source.clipInts[i + 1] ?? 0)
			const objects = remap(objectMap, objectStart, source.clipInts[i + 2] ?? 0, source.clipInts[i + 3] ?? 0)

			if (lines === null && objects === null) continue

			this.addClip(
				(source.clipFloats[f] ?? 0) + dx,
				(source.clipFloats[f + 1] ?? 0) + dy,
				source.clipFloats[f + 2] ?? 0,
				source.clipFloats[f + 3] ?? 0,
				lines?.[0] ?? this.text.lineCount,
				lines?.[1] ?? this.text.lineCount,
				objects?.[0] ?? this.objectCount,
				objects?.[1] ?? this.objectCount
			)
		}
	}
}

// A finished page: tight typed arrays, transferable to another thread.
export class PageDisplayList implements OutputView {
	readonly index: number
	// The page number fields show, and its text in the section's format.
	readonly number: number
	readonly numberText: string
	readonly section: number
	readonly width: number
	readonly height: number
	readonly text: TextLayout
	readonly graphicCount: number
	readonly graphicFloats: Float32Array
	readonly graphicInts: Int32Array
	readonly objectCount: number
	readonly objectFloats: Float32Array
	readonly objectInts: Int32Array
	readonly sourceCount: number
	readonly sourceInts: Int32Array
	readonly sourceTexts: readonly string[]
	readonly sourceParts: Int32Array
	readonly sourceOwners: Int32Array
	readonly sourceMapPool: Int32Array
	readonly sourceMapRanges: Int32Array
	readonly clipCount: number
	readonly clipFloats: Float32Array
	readonly clipInts: Int32Array
	// Body blocks on the page: the first and last body item (paragraph or table) with content here.
	readonly bodyFirst: number
	readonly bodyLast: number
	// Footnotes referenced on the page (by story), wherever they are placed.
	readonly footnotes: readonly number[]

	constructor(
		output: OutputView,
		info: {
			index: number
			number: number
			numberText: string
			section: number
			width: number
			height: number
			bodyFirst: number
			bodyLast: number
			footnotes?: readonly number[]
		},
		// Share the arrays of a finished page instead of copying them.
		shared = false
	) {
		this.index = info.index
		this.number = info.number
		this.numberText = info.numberText
		this.section = info.section
		this.width = info.width
		this.height = info.height
		this.bodyFirst = info.bodyFirst
		this.bodyLast = info.bodyLast
		this.footnotes = info.footnotes ?? NO_FOOTNOTES
		if (output instanceof PageDisplayList && shared) {
			this.text = output.text
			this.graphicCount = output.graphicCount
			this.graphicFloats = output.graphicFloats
			this.graphicInts = output.graphicInts
			this.objectCount = output.objectCount
			this.objectFloats = output.objectFloats
			this.objectInts = output.objectInts
			this.sourceCount = output.sourceCount
			this.sourceInts = output.sourceInts
			this.sourceTexts = output.sourceTexts
			this.sourceParts = output.sourceParts
			this.sourceOwners = output.sourceOwners
			this.sourceMapPool = output.sourceMapPool
			this.sourceMapRanges = output.sourceMapRanges
			this.clipCount = output.clipCount
			this.clipFloats = output.clipFloats
			this.clipInts = output.clipInts

			return
		}

		this.text = output.text.compact()
		this.graphicCount = output.graphicCount
		this.graphicFloats = output.graphicFloats.slice(0, output.graphicCount * GRAPHIC_FLOATS)
		this.graphicInts = output.graphicInts.slice(0, output.graphicCount * GRAPHIC_INTS)
		this.objectCount = output.objectCount
		this.objectFloats = output.objectFloats.slice(0, output.objectCount * OBJECT_FLOATS)
		this.objectInts = output.objectInts.slice(0, output.objectCount * OBJECT_INTS)
		this.sourceCount = output.sourceCount
		this.sourceInts = output.sourceInts.slice(0, output.sourceCount * SOURCE_INTS)
		this.sourceTexts = output.sourceTexts.slice(0, output.sourceCount)
		this.sourceParts = output.sourceParts.slice(0, output.sourceCount)
		this.sourceOwners = output.sourceOwners.slice(0, output.sourceCount)
		this.sourceMapRanges = output.sourceMapRanges.slice(0, output.sourceCount * 2)
		this.sourceMapPool = output.sourceMapPool.slice(0, this.sourceMapRanges[output.sourceCount * 2 - 1] ?? 0)
		this.clipCount = output.clipCount
		this.clipFloats = output.clipFloats.slice(0, output.clipCount * CLIP_FLOATS)
		this.clipInts = output.clipInts.slice(0, output.clipCount * CLIP_INTS)
	}

	// Bytes of the typed arrays. The source texts are not included: each is the laid-out text of a whole
	// paragraph (built once per layout of it, list markers and field results included), shared by the pages it
	// spans in this realm but copied with every page that is sent to another thread; see textLength.
	get byteLength(): number {
		return (
			this.text.byteLength +
			this.graphicFloats.byteLength +
			this.graphicInts.byteLength +
			this.objectFloats.byteLength +
			this.objectInts.byteLength +
			this.sourceInts.byteLength +
			this.sourceOwners.byteLength +
			this.clipFloats.byteLength +
			this.clipInts.byteLength
		)
	}

	// UTF-16 code units of the source texts (two bytes each when copied).
	get textLength(): number {
		let length = 0

		for (const text of this.sourceTexts) length += text.length

		return length
	}

	// The same page at another index or page number (a page kept from an earlier layout): the arrays are
	// shared, page number fields are not redone.
	moved(index: number, number: number, numberText: string): PageDisplayList {
		return new PageDisplayList(
			this,
			{
				index,
				number,
				numberText,
				section: this.section,
				width: this.width,
				height: this.height,
				bodyFirst: this.bodyFirst,
				bodyLast: this.bodyLast,
				footnotes: this.footnotes
			},
			true
		)
	}

	sourceRegion(source: number): Region {
		return (this.sourceInts[source * SOURCE_INTS] ?? 0) as Region
	}

	sourceItem(source: number): number {
		return this.sourceInts[source * SOURCE_INTS + SourceInt.ITEM] ?? -1
	}

	sourceStory(source: number): number {
		return this.sourceInts[source * SOURCE_INTS + SourceInt.STORY] ?? -1
	}

	sourcePart(source: number): number {
		return this.sourceParts[source] ?? -1
	}
}

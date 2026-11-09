import { BIDI_REMOVED, BidiResolver, hasRightToLeft, reorder } from "./bidi"
import { EAST_ASIAN_FLAG, LINE_BREAK_CLASS_MASK, LineBreakClass, PICTOGRAPHIC_FLAG } from "./classes"
import { DecorationKind, FRAGMENT_LEVEL_SHIFT, FragmentFlag, FragmentKind, LineFlag, type TextLayout } from "./displayList"
import { ClearSide, type Exclusions } from "./exclusions"
import { BREAK_ALLOWED, BREAK_HYPHEN, BREAK_MANDATORY, BREAK_NONE, BreakFinder, type Kinsoku } from "./lineBreak"
import { BreakKind, TabAlignment, TabLeader, type ParagraphText } from "./paragraph"
import { Caps, DECORATION_SLOTS, Strike, type StyleTable } from "./styles"
import { lineBreakTable, wordBreakTable } from "./unicode"

// Word-style paragraph layout: greedy line filling (no paragraph-wide optimisation), trailing spaces
// hanging past the line end, tabs, justification, indents, line spacing rules and text flowing around
// floats. Two phases: prepare() segments and measures a paragraph once (independent of geometry);
// layout() fits lines for a geometry and can stop at a bottom edge and resume, for pagination.

export const Alignment = { START: 0, CENTER: 1, END: 2, BOTH: 3, DISTRIBUTE: 4 } as const

export type Alignment = (typeof Alignment)[keyof typeof Alignment]

export const LineRule = { AUTO: 0, EXACT: 1, AT_LEAST: 2, GRID: 3 } as const

export type LineRule = (typeof LineRule)[keyof typeof LineRule]

export interface TabStop {
	// px from the column's start edge.
	readonly position: number
	readonly alignment: TabAlignment
	readonly leader: TabLeader
}

// A paragraph's tab stops (clear stops already removed by the caller), sorted; bar stops only draw.
export class TabStops {
	readonly count: number
	readonly positions: Float64Array
	readonly alignments: Uint8Array
	readonly leaders: Uint8Array
	readonly bars: Float64Array

	constructor(stops: readonly TabStop[]) {
		const sorted = stops.filter(stop => stop.alignment !== TabAlignment.BAR).sort((a, b) => a.position - b.position)

		this.count = sorted.length
		this.positions = Float64Array.from(sorted, stop => stop.position)
		this.alignments = Uint8Array.from(sorted, stop => stop.alignment)
		this.leaders = Uint8Array.from(sorted, stop => stop.leader)
		this.bars = Float64Array.from(
			stops.filter(stop => stop.alignment === TabAlignment.BAR),
			stop => stop.position
		)
	}
}

const NO_TABS = new TabStops([])

export interface ParagraphGeometry {
	// The column: physical left edge and width. Tab stops and indents count from its start edge (the
	// right edge in right-to-left paragraphs).
	readonly left: number
	readonly width: number
	readonly startIndent: number
	readonly endIndent: number
	// Added to startIndent on the first line; negative for a hanging indent.
	readonly firstLineIndent: number
	readonly rtl: boolean
	readonly alignment: Alignment
	readonly tabs: TabStops | null
	readonly defaultTabStop: number
	readonly lineRule: LineRule
	// AUTO: a multiple of the single line height (Word: w:line / 240); EXACT, AT_LEAST and GRID: px.
	readonly lineSpacing: number
	// GRID: the document grid's row in px. A line takes whole rows, at least lineSpacing (Word's snap to grid).
	readonly gridPitch?: number
	// Justify lines ending in a line break (Word does unless w:doNotExpandShiftReturn). Default true.
	readonly expandLineBreaks?: boolean
	// A hanging indent is also a tab stop on the first line (unless w:doNotUseIndentAsNumberingTabStop).
	// Default true.
	readonly hangingIndentTab?: boolean
	readonly exclusions?: Exclusions | null
	// Character a decimal tab aligns on. Default ".".
	readonly decimalSeparator?: number
	// The paragraph mark's font counts on a last line that holds only inline objects (Word). Default true; false:
	// only an empty line takes its height.
	readonly markSizesObjectLines?: boolean
	// Lines as LibreOffice sizes and spaces them (measured): the paragraph mark's font sizes only an empty line, a
	// proportional height's extra or shortfall goes under the text, an exact height's baseline sits at four fifths of
	// it. Default false: Word's, the mark on the last line and the difference above the text.
	readonly libreOfficeSpacing?: boolean
	// Lines as LibreOffice's EditEngine (Impress, Draw) sizes them (ImpEditEngine::CreateLines): the paragraph mark's
	// font sizes only an empty line; a proportional height above single puts its extra above the text, one below
	// single keeps the baseline at most four fifths of the reduced height. Default false. Ignored with
	// libreOfficeSpacing.
	readonly editEngineSpacing?: boolean
}

// Marks automatic hyphenation opportunities: sets breaks[i] = BREAK_HYPHEN for positions i inside the paragraph's
// words where breaks[i] is BREAK_NONE (breaks indexed by paragraph offset), each word in its style's language
// (StyleTable.language). See TextHyphenator.
export interface Hyphenator {
	hyphenate(paragraph: ParagraphText, styles: StyleTable, breaks: Uint8Array): void
}

export interface PrepareOptions {
	readonly rtl: boolean
	// Small kana and the like as non-starters (Japanese strict breaking). Default false (Word's standard).
	readonly strict?: boolean
	// Word's w:wordWrap, which Word applies to Korean text only (MS-OI29500 §17.3.1.45): true keeps
	// Hangul words whole and wraps Korean at spaces; false (w:wordWrap="0") breaks between Hangul
	// syllables. Default true, Word's default.
	readonly wordWrap?: boolean
	readonly kinsoku?: Kinsoku | null
	readonly hyphenator?: Hyphenator | null
	// With a hyphenator: a word is broken at one of its points only when moving it to the next line whole would
	// leave at least this much room at the line's end (px; Word's hyphenation zone, w:hyphenationZone). Default 0.
	readonly hyphenationZone?: number
	// With a hyphenator: the most consecutive lines that may end at one of its points (w:consecutiveHyphenLimit,
	// fo:hyphenation-ladder-count); lines ending at a soft hyphen count too. Default 0: any number.
	readonly hyphenLimit?: number
	// East Asian full stops and commas may hang past the line end (w:overflowPunct). Default false.
	readonly hangingPunctuation?: boolean
	// The caller's id for the paragraph, stored on every line.
	readonly source?: number
	// Ranges [start, end) as pairs of paragraph offsets that break only where nothing else fits: no opportunity
	// inside them, so a range that does not fit the rest of a line moves to the next whole and one longer than a
	// line breaks at the character that overflows.
	readonly keepTogether?: ArrayLike<number>
	// Ranges [start, end) as pairs of paragraph offsets, in text order, that start the next line when they do not fit
	// the rest of this one (a range at a line's start, or with no break allowed before it, stays): one longer than a
	// line then wraps inside as usual.
	readonly breakBefore?: ArrayLike<number>
}

const ItemKind = { TEXT: 0, TAB: 1, OBJECT: 2, BREAK: 3 } as const

// A small-caps item drawing lower-case letters.
const ITEM_SMALL = 1
// An item with East Asian (wide, fullwidth or halfwidth) characters: justified across characters.
const ITEM_EAST_ASIAN = 2
// A text item starting a breakBefore range; its aux holds the range's end.
const ITEM_BREAK_BEFORE = 4

const EPSILON = 1e-6

// A paragraph segmented into items (text between break opportunities, split at style, bidi level and
// small-caps changes; tabs, objects and breaks alone) and measured. Reusable via ParagraphLayouter.prepare.
export class PreparedParagraph {
	text = ""
	count = 0
	rtl = false
	bidi = false
	level = 0
	markStyle = 0
	source = 0
	// PrepareOptions.hyphenationZone and hyphenLimit (0 without a hyphenator).
	hyphenationZone = 0
	hyphenLimit = 0

	start = new Int32Array(32)
	end = new Int32Array(32)
	// End of the item before its trailing spaces.
	contentEnd = new Int32Array(32)
	style = new Int32Array(32)
	kind = new Uint8Array(32)
	levels = new Uint8Array(32)
	breakAfter = new Uint8Array(32)
	flags = new Uint8Array(32)
	// Object, tab or break index.
	aux = new Int32Array(32)
	// Advance of the content (letter spacing and horizontal scale included), of the trailing spaces, and
	// of hanging punctuation at the content's end.
	width = new Float64Array(32)
	space = new Float64Array(32)
	hang = new Float64Array(32)
	innerSpaces = new Int32Array(32)
	trailingSpaces = new Int32Array(32)
	clusters = new Int32Array(32)

	objectBox = new Float64Array(12)
	objectId = new Int32Array(4)
	breakKind = new Uint8Array(4)
	tabPosition = new Float64Array(4)
	tabAlignment = new Uint8Array(4)
	tabLeader = new Uint8Array(4)

	// Text items from `ready` on are measured for an older text and measured again as layout first reaches them:
	// `refresh(item)` brings them up to date to past `item` and moves `ready` on. prepare() measures every item.
	ready = Infinity
	refresh: ((item: number) => void) | null = null

	// Releases buffers far larger than a paragraph of `count` items needs (after a huge one).
	fit(count: number): void {
		if (!shrinks(this.start.length, count)) return

		const size = Math.max(32, count)

		this.start = new Int32Array(size)
		this.end = new Int32Array(size)
		this.contentEnd = new Int32Array(size)
		this.style = new Int32Array(size)
		this.kind = new Uint8Array(size)
		this.levels = new Uint8Array(size)
		this.breakAfter = new Uint8Array(size)
		this.flags = new Uint8Array(size)
		this.aux = new Int32Array(size)
		this.width = new Float64Array(size)
		this.space = new Float64Array(size)
		this.hang = new Float64Array(size)
		this.innerSpaces = new Int32Array(size)
		this.trailingSpaces = new Int32Array(size)
		this.clusters = new Int32Array(size)
	}

	ensure(count: number): void {
		if (count <= this.start.length) return

		const size = Math.max(count, this.start.length * 2)

		this.start = resizeInt(this.start, size)
		this.end = resizeInt(this.end, size)
		this.contentEnd = resizeInt(this.contentEnd, size)
		this.style = resizeInt(this.style, size)
		this.kind = resizeU8(this.kind, size)
		this.levels = resizeU8(this.levels, size)
		this.breakAfter = resizeU8(this.breakAfter, size)
		this.flags = resizeU8(this.flags, size)
		this.aux = resizeInt(this.aux, size)
		this.width = resizeF64(this.width, size)
		this.space = resizeF64(this.space, size)
		this.hang = resizeF64(this.hang, size)
		this.innerSpaces = resizeInt(this.innerSpaces, size)
		this.trailingSpaces = resizeInt(this.trailingSpaces, size)
		this.clusters = resizeInt(this.clusters, size)
	}
}

export const LayoutStatus = {
	// The paragraph is complete.
	DONE: 0,
	// The next line would cross `bottom`; resume with the cursor in the next area.
	OVERFLOW: 1,
	// After a page or column break; when it ended the paragraph, the next call returns DONE adding nothing.
	PAGE_BREAK: 2,
	COLUMN_BREAK: 3,
	// `force` was set but floats push the first row below `bottom`: nothing placed. Retry in the next area;
	// an area that never has room for it is laid out with `force` and no exclusions.
	NO_ROOM: 4
} as const

export type LayoutStatus = (typeof LayoutStatus)[keyof typeof LayoutStatus]

// Where layout of a paragraph continues.
export class LayoutCursor {
	item = 0
	// Text offset inside `item` where it continues after a break inside it, or -1.
	offset = -1
	// Rows laid out so far.
	rows = 0
	// The last row ended with a break item and the paragraph mark still needs its own line.
	pendingMark = false
	// Bottom of the last row; after NO_ROOM, where floats pushed the row.
	y = 0
	// Rows just laid out that ended in a hyphen, one after another (PrepareOptions.hyphenLimit).
	hyphens = 0

	reset(): void {
		this.item = 0
		this.offset = -1
		this.rows = 0
		this.pendingMark = false
		this.y = 0
		this.hyphens = 0
	}
}

// Why a segment's fill stopped.
const PEN_X = 0
const PEN_CONTENT = 1
const PEN_TABS = 2

const Fill = {
	// Broke at an opportunity or inside a word; more items follow.
	WRAP: 0,
	// At a forced break (break item or mandatory break).
	FORCED: 1,
	// The paragraph ended.
	END: 2,
	// Nothing fits this segment (it is narrowed by an obstacle).
	NONE: 3
} as const

type Fill = (typeof Fill)[keyof typeof Fill]

// Decoration geometry as fractions of the em size; fonts' own underline metrics are not read.
export const UNDERLINE_OFFSET = 0.12
export const UNDERLINE_THICKNESS = 0.06
export const STRIKE_OFFSET = 0.28

const HANGING_PUNCTUATION = new Set([0x3001, 0x3002, 0xff0c, 0xff0e, 0xff61, 0xff64])

export class ParagraphLayouter {
	readonly styles: StyleTable
	private readonly finder = new BreakFinder()
	private readonly resolver = new BidiResolver()
	private breaks = new Uint8Array(256)
	private charLevels = new Uint8Array(256)
	private pendingItems = new Int32Array(64)
	private pendingTickets = new Int32Array(64)
	private scratch = new PreparedParagraph()

	// Pieces of the row being fitted: items or parts of items, in logical order.
	private pieceCount = 0
	private pItem = new Int32Array(64)
	private pStart = new Int32Array(64)
	private pEnd = new Int32Array(64)
	private pContentEnd = new Int32Array(64)
	private pWidth = new Float64Array(64)
	private pSpace = new Float64Array(64)
	private pInner = new Int32Array(64)
	private pTrailing = new Int32Array(64)
	private pClusters = new Int32Array(64)
	private pFlags = new Uint8Array(64)
	private pStop = new Float64Array(64)
	private pAlign = new Uint8Array(64)
	private pLeader = new Uint8Array(64)
	// Final inline position and width, justification extras.
	private pU = new Float64Array(64)
	private pW = new Float64Array(64)
	private pWord = new Float64Array(64)
	private pLetter = new Float64Array(64)
	private pLevel = new Uint8Array(64)
	private order = new Int32Array(64)
	private sectionLevels = new Uint8Array(64)
	private sectionOrder = new Int32Array(64)

	// Segments of the row: inline start, end, first piece, piece end, fill result.
	private segCount = 0
	private segStart = new Float64Array(8)
	private segEnd = new Float64Array(8)
	private segFrom = new Int32Array(8)
	private segTo = new Int32Array(8)
	private segFill = new Uint8Array(8)
	// Where the last positioned segment's content starts after alignment: an empty line's position.
	private segAligned = 0
	// The least room left on a segment positioned since the caller last set it (Infinity): how much shorter lines
	// could have been and have laid out alike (the length sideways text needs).
	leastFree = Infinity
	private intervals = new Float64Array(16)
	private intervalsAgain = new Float64Array(16)

	// The fitted row.
	private rowHeight = 0
	private rowBaseline = 0
	private rowExtraBelow = 0
	// The proportional spacing the last row laid out put under its text (libreOfficeSpacing), which LibreOffice leaves
	// out after a header's or footer's last line.
	lastExtraBelow = 0
	private rowLast = false

	// Fill state.
	private nextItem = 0
	private nextOffset = -1
	// The row may not end at an automatic hyphenation point (PrepareOptions.hyphenLimit reached).
	private hyphenBlocked = false
	private tabPending = false
	private tabStart = 0
	private tabStop = 0
	private tabAlign = 0
	private tabDecimal = Number.NaN
	// nextStop() result.
	private foundStop = 0
	private foundAlign = 0
	private foundLeader = 0
	private foundDefault = false
	// fitPrefix() result.
	private fitWidth = 0
	// fill()'s and resolveTabs()' pens (see there).
	private readonly pen = new Float64Array(3)

	constructor(styles: StyleTable) {
		this.styles = styles
	}

	prepare(paragraph: ParagraphText, options: PrepareOptions, into: PreparedParagraph = this.scratch): PreparedParagraph {
		const p = into
		const text = paragraph.text
		const n = text.length
		const styles = this.styles
		const cache = styles.cache

		p.text = text
		p.count = 0
		p.rtl = options.rtl
		p.markStyle = paragraph.markStyle
		p.source = options.source ?? 0
		p.ready = Infinity
		p.refresh = null
		this.copyTables(paragraph, p)

		if (this.breaks.length < n + 1 || shrinks(this.breaks.length, n + 1))
			this.breaks = new Uint8Array(Math.max(n + 1, 256, Math.min(this.breaks.length * 2, 2 * (n + 1))))
		if (shrinks(this.pendingItems.length, 64)) {
			this.pendingItems = new Int32Array(64)
			this.pendingTickets = new Int32Array(64)
		}

		p.fit(n + 1)

		const breaks = this.breaks

		this.finder.find(text, 0, n, breaks, {
			strict: options.strict ?? false,
			kinsoku: options.kinsoku ?? null,
			keepHangul: options.wordWrap ?? true
		})

		const classes = this.finder.classes

		for (let i = 1; i < n; i++) {
			if (breaks[i] === BREAK_ALLOWED && text.charCodeAt(i - 1) === 0xad) breaks[i] = BREAK_HYPHEN
		}

		const hyphenator = options.hyphenator ?? null

		hyphenator?.hyphenate(paragraph, styles, breaks)
		p.hyphenationZone = hyphenator === null ? 0 : (options.hyphenationZone ?? 0)
		p.hyphenLimit = hyphenator === null ? 0 : (options.hyphenLimit ?? 0)

		const keep = options.keepTogether

		if (keep !== undefined) {
			for (let k = 0; k + 1 < keep.length; k += 2) {
				const end = Math.min(n, keep[k + 1] ?? 0)

				for (let i = Math.max(1, (keep[k] ?? 0) + 1); i < end; i++) if (breaks[i] !== BREAK_MANDATORY) breaks[i] = BREAK_NONE
			}
		}

		const levels = this.resolveLevels(text, n, p)
		const hanging = options.hangingPunctuation === true
		let run = 0
		let runEnd = paragraph.runCount > 1 ? (paragraph.runStart[1] ?? n) : n
		let style = paragraph.runStyle[0] ?? paragraph.markStyle
		let objects = 0
		let breakItems = 0
		let tabs = 0
		let pending = 0

		for (let i = 0; i < n;) {
			while (i >= runEnd && run + 1 < paragraph.runCount) {
				run++
				style = paragraph.runStyle[run] ?? style
				runEnd = run + 1 < paragraph.runCount ? (paragraph.runStart[run + 1] ?? n) : n
			}

			const c = text.charCodeAt(i)
			const level = levels === null ? p.level : (levels[i] ?? 0)
			const item = p.count

			p.ensure(item + 1)
			p.start[item] = i
			p.style[item] = style
			p.levels[item] = level
			p.flags[item] = 0
			p.width[item] = 0
			p.space[item] = 0
			p.hang[item] = 0
			p.innerSpaces[item] = 0
			p.trailingSpaces[item] = 0
			p.clusters[item] = 0
			p.aux[item] = 0

			if (c === 0x09 || c === 0x0b || c === 0xfffc) {
				p.end[item] = i + 1
				p.contentEnd[item] = i + 1
				p.breakAfter[item] = c === 0x0b ? BREAK_MANDATORY : (breaks[i + 1] ?? BREAK_NONE)

				if (c === 0x09) {
					p.kind[item] = ItemKind.TAB
					p.aux[item] = tabs++
				} else if (c === 0x0b) {
					p.kind[item] = ItemKind.BREAK
					p.aux[item] = breakItems++
				} else {
					p.kind[item] = ItemKind.OBJECT
					p.aux[item] = objects
					p.width[item] = p.objectBox[objects * 3] ?? 0
					objects++
				}

				p.count++
				i++

				continue
			}

			const caps = styles.caps[style] ?? Caps.NONE
			const small = caps === Caps.SMALL_CAPS && isLower(text, i)
			let j = i + 1

			while (j < n && j < runEnd && breaks[j] === BREAK_NONE) {
				const next = text.charCodeAt(j)

				if (next === 0x09 || next === 0x0b || next === 0xfffc) break
				if (levels !== null && levels[j] !== level) break
				if (caps === Caps.SMALL_CAPS && isLower(text, j) !== small && !isTrail(next)) break

				j++
			}

			let contentEnd = j

			while (contentEnd > i && text.charCodeAt(contentEnd - 1) === 0x20) contentEnd--

			let clusters = 0
			let inner = 0
			let eastAsian = false

			for (let k = i; k < contentEnd;) {
				const unit = text.charCodeAt(k)

				// NBSP too: CSS word-spacing widens it, so justification must count it.
				if (unit === 0x20 || unit === 0xa0) inner++
				if (((classes[k] ?? 0) & EAST_ASIAN_FLAG) !== 0) eastAsian = true

				clusters++
				k = clusterEnd(text, k, contentEnd, classes)
			}

			p.kind[item] = ItemKind.TEXT
			p.end[item] = j
			p.contentEnd[item] = contentEnd
			p.breakAfter[item] = j < n ? (breaks[j] ?? BREAK_NONE) : BREAK_MANDATORY
			p.flags[item] = (small ? ITEM_SMALL : 0) | (eastAsian ? ITEM_EAST_ASIAN : 0)
			p.clusters[item] = clusters
			p.innerSpaces[item] = inner
			p.trailingSpaces[item] = j - contentEnd
			p.space[item] = (j - contentEnd) * (styles.spaceWidth[style] ?? 0)

			const font = small ? (styles.smallFontKey[style] ?? 0) : (styles.fontKey[style] ?? 0)
			const raw = caps === Caps.NONE ? cache.request(font, text, i, contentEnd) : requestUpper(cache, font, text, i, contentEnd)
			const last = contentEnd - 1

			const ticket = cache.ticket

			p.width[item] = raw

			if (hanging && contentEnd > i && HANGING_PUNCTUATION.has(text.charCodeAt(last)))
				p.hang[item] = cache.request(font, text, last, contentEnd)

			if (Number.isNaN(raw) || Number.isNaN(p.hang[item] ?? 0)) {
				if (pending === this.pendingItems.length) {
					this.pendingItems = resizeInt(this.pendingItems, pending * 2)
					this.pendingTickets = resizeInt(this.pendingTickets, pending * 2)
				}

				this.pendingTickets[pending] = Number.isNaN(raw) ? ticket : -2
				this.pendingItems[pending++] = item
			}

			p.count++
			i = j
		}

		if (pending > 0) this.resolvePending(p, pending)

		for (let item = 0; item < p.count; item++) {
			if (p.kind[item] !== ItemKind.TEXT) continue

			const scale = this.scaleWidth(p, item)

			p.hang[item] = (p.hang[item] ?? 0) * scale
		}

		const before = options.breakBefore

		if (before !== undefined) markBreakBefore(p, before)

		return p
	}

	// Measures text items of `p` again (items[0, count)) whose characters changed but not their segmentation: a
	// page number shown in characters of the same kind. Widths, clusters and spaces come out as prepare() gives
	// them for the new text; hanging punctuation is unchanged.
	remeasure(p: PreparedParagraph, items: ArrayLike<number>, count: number): void {
		const styles = this.styles
		const cache = styles.cache
		const text = p.text
		let pending = 0

		for (let k = 0; k < count; k++) {
			const item = items[k] ?? 0
			const start = p.start[item] ?? 0
			const contentEnd = p.contentEnd[item] ?? 0
			const style = p.style[item] ?? 0
			let clusters = 0
			let inner = 0

			for (let at = start; at < contentEnd;) {
				const unit = text.charCodeAt(at)

				if (unit === 0x20 || unit === 0xa0) inner++

				clusters++
				at = clusterEnd(text, at, contentEnd, null)
			}

			p.clusters[item] = clusters
			p.innerSpaces[item] = inner

			const font = ((p.flags[item] ?? 0) & ITEM_SMALL) !== 0 ? (styles.smallFontKey[style] ?? 0) : (styles.fontKey[style] ?? 0)
			const raw =
				(styles.caps[style] ?? Caps.NONE) === Caps.NONE
					? cache.request(font, text, start, contentEnd)
					: requestUpper(cache, font, text, start, contentEnd)

			p.width[item] = raw

			if (Number.isNaN(raw)) {
				if (pending === this.pendingItems.length) {
					this.pendingItems = resizeInt(this.pendingItems, pending * 2)
					this.pendingTickets = resizeInt(this.pendingTickets, pending * 2)
				}

				this.pendingTickets[pending] = cache.ticket
				this.pendingItems[pending++] = item
			}
		}

		if (pending > 0) this.resolvePending(p, pending)

		for (let k = 0; k < count; k++) this.scaleWidth(p, items[k] ?? 0)
	}

	// Widths prepare() or remeasure() queued (pendingItems[0, pending)), once the cache has measured them.
	private resolvePending(p: PreparedParagraph, pending: number): void {
		const styles = this.styles
		const cache = styles.cache
		const text = p.text

		cache.flush()

		for (let k = 0; k < pending; k++) {
			const item = this.pendingItems[k] ?? 0
			const s = p.style[item] ?? 0
			const font = (p.flags[item] ?? 0) & ITEM_SMALL ? (styles.smallFontKey[s] ?? 0) : (styles.fontKey[s] ?? 0)
			const start = p.start[item] ?? 0
			const contentEnd = p.contentEnd[item] ?? 0
			const ticket = this.pendingTickets[k] ?? -1

			// Queued widths come back by queue position; strings queued twice or summed per character
			// are requested again (now cached).
			if (ticket >= 0) p.width[item] = cache.result(ticket)
			else if (ticket === -1)
				p.width[item] =
					(styles.caps[s] ?? 0) === Caps.NONE
						? cache.request(font, text, start, contentEnd)
						: requestUpper(cache, font, text, start, contentEnd)

			if (Number.isNaN(p.hang[item] ?? 0)) p.hang[item] = cache.request(font, text, contentEnd - 1, contentEnd)

			// Should the cache still miss, measure directly: a NaN width would poison every line.
			if (Number.isNaN(p.width[item] ?? 0)) p.width[item] = this.rawWidth(p, item, start, contentEnd)
			if (Number.isNaN(p.hang[item] ?? 0)) p.hang[item] = this.rawWidth(p, item, contentEnd - 1, contentEnd)
		}
	}

	// A text item's measured width with its style's letter spacing and horizontal scale; returns the scale.
	private scaleWidth(p: PreparedParagraph, item: number): number {
		const styles = this.styles
		const s = p.style[item] ?? 0
		const scale = styles.scaleX[s] ?? 1

		p.width[item] = advanceOf(p.width[item] ?? 0, styles.letterSpacing[s] ?? 0, p.clusters[item] ?? 0) * scale

		return scale
	}

	// Lays out rows of `p` from `cursor` starting at `top`, appending to `out`, until the paragraph ends,
	// a page or column break, or a row would end below `bottom`. With `force`, the first row is placed even
	// when it crosses `bottom` (an area's first line).
	layout(
		p: PreparedParagraph,
		g: ParagraphGeometry,
		out: TextLayout,
		cursor: LayoutCursor,
		top: number,
		bottom = Infinity,
		force = true
	): LayoutStatus {
		let y = top
		let placed = 0

		cursor.y = top

		if (shrinks(this.pItem.length, 64)) this.resizePieces(64)

		for (;;) {
			if (cursor.item >= p.count && cursor.rows > 0 && !cursor.pendingMark) return LayoutStatus.DONE

			const rowTop = this.fitRow(p, g, y, cursor)
			const rowBottom = rowTop + this.rowHeight

			// A forced row must start at the area's top: one pushed down by floats waits for the next area.
			if (rowBottom > bottom + EPSILON && (placed > 0 || !force || rowTop > top + EPSILON)) {
				if (placed > 0 || !force) return LayoutStatus.OVERFLOW

				cursor.y = rowTop

				return LayoutStatus.NO_ROOM
			}

			const ended = this.emitRow(p, g, out, rowTop, cursor.rows === 0)

			cursor.hyphens = this.rowHyphenated() ? cursor.hyphens + 1 : 0
			cursor.rows++
			cursor.item = this.nextItem
			cursor.offset = this.nextOffset
			// A paragraph ending in a text-wrapping break shows its mark on a line of its own; one ending in a
			// page or column break keeps the mark with the break (corpus: 345 Word paragraphs ending in a page
			// break, the next paragraph carries the new page's w:lastRenderedPageBreak in all but one).
			cursor.pendingMark = ended >= 0 && ended !== BreakKind.PAGE && ended !== BreakKind.COLUMN && cursor.item >= p.count
			placed++
			y = rowBottom
			cursor.y = y

			if (ended === BreakKind.PAGE) return LayoutStatus.PAGE_BREAK
			if (ended === BreakKind.COLUMN) return LayoutStatus.COLUMN_BREAK

			const exclusions = g.exclusions

			if (exclusions !== null && exclusions !== undefined && ended >= BreakKind.LINE_CLEAR_LEFT) {
				const side =
					ended === BreakKind.LINE_CLEAR_LEFT
						? ClearSide.LEFT
						: ended === BreakKind.LINE_CLEAR_RIGHT
							? ClearSide.RIGHT
							: ClearSide.ALL

				y = exclusions.clearance(y, side, g.left, g.left + g.width)
				cursor.y = y
			}
		}
	}

	private copyTables(paragraph: ParagraphText, p: PreparedParagraph): void {
		if (paragraph.objectCount === 0 && paragraph.breakCount === 0 && paragraph.tabCount === 0) return

		if (p.objectBox.length < paragraph.objectCount * 3) {
			p.objectBox = new Float64Array(paragraph.objectCount * 3)
			p.objectId = new Int32Array(paragraph.objectCount)
		}

		p.objectBox.set(paragraph.objectBox.subarray(0, paragraph.objectCount * 3))
		p.objectId.set(paragraph.objectId.subarray(0, paragraph.objectCount))

		if (p.breakKind.length < paragraph.breakCount) p.breakKind = new Uint8Array(paragraph.breakCount)

		p.breakKind.set(paragraph.breakKind.subarray(0, paragraph.breakCount))

		if (p.tabPosition.length < paragraph.tabCount) {
			p.tabPosition = new Float64Array(paragraph.tabCount)
			p.tabAlignment = new Uint8Array(paragraph.tabCount)
			p.tabLeader = new Uint8Array(paragraph.tabCount)
		}

		p.tabPosition.set(paragraph.tabPosition.subarray(0, paragraph.tabCount))
		p.tabAlignment.set(paragraph.tabAlignment.subarray(0, paragraph.tabCount))
		p.tabLeader.set(paragraph.tabLeader.subarray(0, paragraph.tabCount))
	}

	// Per-unit levels with X9-removed characters folded into their neighbours, or null when the paragraph
	// is left-to-right without right-to-left text.
	private resolveLevels(text: string, n: number, p: PreparedParagraph): Uint8Array | null {
		p.bidi = p.rtl || hasRightToLeft(text, 0, n)

		if (!p.bidi) {
			p.level = 0

			return null
		}

		if (this.charLevels.length < n || shrinks(this.charLevels.length, n))
			this.charLevels = new Uint8Array(Math.max(n, 256, Math.min(this.charLevels.length * 2, 2 * n)))

		const levels = this.charLevels

		p.level = this.resolver.resolve(text, 0, n, p.rtl ? "rtl" : "ltr", levels)

		let previous = p.level

		for (let i = 0; i < n; i++) {
			if (levels[i] === BIDI_REMOVED) levels[i] = previous
			else previous = levels[i] ?? previous
		}

		return levels
	}

	// Fits one row at `y` (moved down past floats when nothing fits beside them); returns the row's top.
	private fitRow(p: PreparedParagraph, g: ParagraphGeometry, y: number, cursor: LayoutCursor): number {
		const first = cursor.rows === 0
		const lineStart = g.startIndent + (first ? g.firstLineIndent : 0)
		const lineEnd = g.width - g.endIndent
		const exclusions = g.exclusions ?? null
		let top = y
		let height = this.estimateHeight(p, g, cursor.item)

		if (exclusions !== null && 2 * (exclusions.count + 1) > this.intervals.length) {
			this.intervals = new Float64Array(4 * (exclusions.count + 1))
			this.intervalsAgain = new Float64Array(4 * (exclusions.count + 1))
		}

		for (let attempt = 0; ; attempt++) {
			const intervalCount =
				exclusions === null || exclusions.count === 0
					? -1
					: this.freeIntervals(g, exclusions, top, top + height, lineStart, lineEnd, this.intervals)
			const narrowed =
				intervalCount >= 0 &&
				!(
					intervalCount === 1 &&
					Math.abs((this.intervals[0] ?? 0) - lineStart) < EPSILON &&
					Math.abs((this.intervals[1] ?? 0) - lineEnd) < EPSILON
				)

			this.fillRow(p, g, cursor, first, lineStart, lineEnd, intervalCount, narrowed)

			if (this.segCount === 0 && exclusions !== null) {
				const next = exclusions.nextBottom(top, top + height, g.left, g.left + g.width)

				if (Number.isFinite(next) && next > top) {
					top = next

					continue
				}

				this.fillRow(p, g, cursor, first, lineStart, lineEnd, -1, false)
			}

			this.measureRow(p, g)

			if (!narrowed && intervalCount < 0) return top

			if (exclusions === null || this.rowHeight <= height + EPSILON || attempt >= 3) return top

			const again = this.freeIntervals(g, exclusions, top, top + this.rowHeight, lineStart, lineEnd, this.intervalsAgain)

			if (again === intervalCount && sameIntervals(this.intervals, this.intervalsAgain, again)) return top

			height = this.rowHeight
		}
	}

	// Free inline intervals within [lineStart, lineEnd) beside obstacles, in inline order.
	private freeIntervals(
		g: ParagraphGeometry,
		exclusions: Exclusions,
		top: number,
		bottom: number,
		lineStart: number,
		lineEnd: number,
		out: Float64Array
	): number {
		const minX = g.rtl ? g.left + g.width - lineEnd : g.left + lineStart
		const maxX = g.rtl ? g.left + g.width - lineStart : g.left + lineEnd
		const n = exclusions.free(top, bottom, minX, maxX, out)

		if (g.rtl) {
			// Physical to inline, reversed so the start-most interval comes first.
			const right = g.left + g.width

			for (let k = 0; k < n; k++) {
				const a = out[2 * k] ?? 0
				const b = out[2 * k + 1] ?? 0

				out[2 * k] = right - b
				out[2 * k + 1] = right - a
			}

			for (let k = 0; k < n >> 1; k++) {
				swap(out, 2 * k, 2 * (n - 1 - k))
				swap(out, 2 * k + 1, 2 * (n - 1 - k) + 1)
			}
		} else {
			for (let k = 0; k < 2 * n; k++) out[k] = (out[k] ?? 0) - g.left
		}

		return n
	}

	private estimateHeight(p: PreparedParagraph, g: ParagraphGeometry, item: number): number {
		const style = item < p.count ? (p.style[item] ?? p.markStyle) : p.markStyle
		const styles = this.styles
		const natural =
			(styles.ascent[style] ?? 0) + (styles.descent[style] ?? 0) + (styles.markAbove[style] ?? 0) + (styles.markBelow[style] ?? 0)

		return lineHeightFor(g, natural)
	}

	// Fills the row's segments from the cursor. intervalCount < 0: the whole line is one segment.
	private fillRow(
		p: PreparedParagraph,
		g: ParagraphGeometry,
		cursor: LayoutCursor,
		first: boolean,
		lineStart: number,
		lineEnd: number,
		intervalCount: number,
		narrowed: boolean
	): void {
		this.pieceCount = 0
		this.segCount = 0
		this.nextItem = cursor.item
		this.nextOffset = cursor.offset
		this.hyphenBlocked = p.hyphenLimit > 0 && cursor.hyphens >= p.hyphenLimit

		const segments = intervalCount < 0 ? 1 : intervalCount

		for (let s = 0; s < segments; s++) {
			const start = intervalCount < 0 ? lineStart : (this.intervals[2 * s] ?? 0)
			const end = intervalCount < 0 ? lineEnd : (this.intervals[2 * s + 1] ?? 0)

			if (end - start <= EPSILON && intervalCount >= 0) continue

			const from = this.pieceCount
			const fill = this.fill(p, g, start, end, first && s === 0 && start === lineStart, narrowed)

			if (fill === Fill.NONE) continue

			if (this.segCount === this.segStart.length) this.growSegments()

			this.segStart[this.segCount] = start
			this.segEnd[this.segCount] = end
			this.segFrom[this.segCount] = from
			this.segTo[this.segCount] = this.pieceCount
			this.segFill[this.segCount] = fill
			this.segCount++

			if (fill !== Fill.WRAP) break
		}

		// A paragraph without items still has its mark's line: in the first gap beside floats, however narrow, and
		// below them where they leave none (as LibreOffice places it).
		if (this.segCount === 0 && (p.count === 0 || cursor.item >= p.count)) {
			let s = 0

			while (s < intervalCount && (this.intervals[2 * s + 1] ?? 0) - (this.intervals[2 * s] ?? 0) <= EPSILON) s++

			if (intervalCount >= 0 && s === intervalCount) return

			this.segStart[0] = intervalCount < 0 ? lineStart : (this.intervals[2 * s] ?? 0)
			this.segEnd[0] = intervalCount < 0 ? lineEnd : (this.intervals[2 * s + 1] ?? 0)
			this.segFrom[0] = 0
			this.segTo[0] = 0
			this.segFill[0] = Fill.END
			this.segCount = 1
		}
	}

	// Greedy fill of one segment [start, end) (inline coordinates), from nextItem/nextOffset.
	private fill(
		p: PreparedParagraph,
		g: ParagraphGeometry,
		segStart: number,
		segEnd: number,
		firstLine: boolean,
		narrowed: boolean
	): Fill {
		const styles = this.styles
		const savedItem = this.nextItem
		const savedOffset = this.nextOffset
		const savedPieces = this.pieceCount
		let item = this.nextItem
		let offset = this.nextOffset
		// The pen and where content ends, in a typed array: kept in locals, their sums would be allocated item by
		// item.
		const pen = this.pen

		pen[PEN_X] = segStart
		pen[PEN_CONTENT] = segStart
		let placed = false
		let candidatePieces = -1
		let candidateItem = 0
		let candidateHyphen = false
		// The candidate is a hyphenator's point, and the last candidate that is not (where the line ends instead when
		// breaking at the point would leave less than the hyphenation zone), with where content ended there.
		let candidateAutomatic = false
		let plainPieces = -1
		let plainItem = 0
		let plainHyphen = false
		let plainContent = 0

		this.tabPending = false

		while (item < p.count) {
			if (item >= p.ready) p.refresh?.(item)

			const kind = p.kind[item] ?? ItemKind.TEXT
			const style = p.style[item] ?? 0

			if (
				offset < 0 &&
				((p.flags[item] ?? 0) & ITEM_BREAK_BEFORE) !== 0 &&
				placed &&
				candidatePieces === this.pieceCount &&
				candidateItem === item &&
				!this.fitsRange(p, item, segEnd)
			) {
				this.nextItem = item
				this.nextOffset = -1

				if (candidateHyphen) this.pFlags[candidatePieces - 1] = (this.pFlags[candidatePieces - 1] ?? 0) | FragmentFlag.HYPHEN

				return Fill.WRAP
			}

			if (kind === ItemKind.TEXT || kind === ItemKind.OBJECT) {
				const itemStart = p.start[item] ?? 0
				const start = offset >= 0 ? offset : itemStart
				const partial = start !== itemStart
				const contentEnd = p.contentEnd[item] ?? 0
				const trailing = partial ? (p.end[item] ?? 0) - Math.max(start, contentEnd) : (p.trailingSpaces[item] ?? 0)
				const space = partial ? trailing * (styles.spaceWidth[style] ?? 0) : (p.space[item] ?? 0)
				// The rest of a word broken on an earlier line is fitted from its start instead of measured
				// whole, so a long unbreakable run costs about its line length per line.
				const split = partial && start < contentEnd ? this.fitPrefix(p, item, start, contentEnd, pen[PEN_X] ?? 0, segEnd) : -1
				const width = !partial ? (p.width[item] ?? 0) : split === contentEnd ? this.fitWidth : 0
				// Space-only items never overflow: line-end spaces hang.
				const overflows =
					split >= 0
						? split < contentEnd
						: (width > 0 || kind === ItemKind.OBJECT) &&
							(this.tabPending
								? this.extent((pen[PEN_X] ?? 0) + width - (p.hang[item] ?? 0))
								: (pen[PEN_X] ?? 0) + width - (p.hang[item] ?? 0)) >
								segEnd + EPSILON

				if (overflows) {
					if (placed && candidatePieces >= 0) {
						// The word moves to the next line whole when that leaves less room than the zone.
						const whole = candidateAutomatic && plainPieces >= 0 && segEnd - plainContent < p.hyphenationZone - EPSILON
						const pieces = whole ? plainPieces : candidatePieces

						this.pieceCount = pieces
						this.nextItem = whole ? plainItem : candidateItem
						this.nextOffset = -1

						if (whole ? plainHyphen : candidateHyphen)
							this.pFlags[pieces - 1] = (this.pFlags[pieces - 1] ?? 0) | FragmentFlag.HYPHEN

						return Fill.WRAP
					}

					if (!placed && narrowed) {
						this.pieceCount = savedPieces
						this.nextItem = savedItem
						this.nextOffset = savedOffset

						return Fill.NONE
					}

					// No opportunity: break inside the word, as Word does, keeping at least one character
					// on an otherwise empty line.
					let fit =
						kind !== ItemKind.TEXT
							? start
							: split >= 0
								? split
								: this.fitPrefix(p, item, start, contentEnd, pen[PEN_X] ?? 0, segEnd)
					let fitWidth = this.fitWidth

					if (fit === start && !placed && kind === ItemKind.TEXT) {
						fit = nextCluster(p.text, start, contentEnd)
						fitWidth = this.measurePart(p, item, start, fit)
					}

					if (fit > start && fit < contentEnd) {
						// The index first: adding a piece may replace pWidth (growing it).
						const piece = this.addPiece(p, item, start, fit, fit)

						this.pWidth[piece] = fitWidth
						this.pClusters[this.pieceCount - 1] = this.countClusters(p.text, start, fit)
						this.pInner[this.pieceCount - 1] = countSpaces(p.text, start, fit)
						this.nextItem = item
						this.nextOffset = fit

						return Fill.WRAP
					}

					if (placed) {
						this.nextItem = item
						this.nextOffset = offset

						return Fill.WRAP
					}
				}

				const piece = this.addPiece(p, item, start, p.end[item] ?? 0, contentEnd)

				this.pWidth[piece] = width
				this.pSpace[piece] = space
				this.pInner[this.pieceCount - 1] = partial ? countSpaces(p.text, start, contentEnd) : (p.innerSpaces[item] ?? 0)
				this.pTrailing[this.pieceCount - 1] = trailing
				this.pClusters[this.pieceCount - 1] = partial ? this.countClusters(p.text, start, contentEnd) : (p.clusters[item] ?? 0)

				if (this.tabPending && this.tabAlign === TabAlignment.DECIMAL && Number.isNaN(this.tabDecimal) && kind === ItemKind.TEXT) {
					const at = indexIn(p.text, g.decimalSeparator ?? 0x2e, start, contentEnd)

					if (at >= 0) this.tabDecimal = (pen[PEN_X] ?? 0) - this.tabStart + this.measurePart(p, item, start, at)
				}

				placed = true

				if (width > 0 || kind === ItemKind.OBJECT) pen[PEN_CONTENT] = (pen[PEN_X] ?? 0) + width

				pen[PEN_X] += width + space

				const after = p.breakAfter[item] ?? BREAK_NONE

				item++
				offset = -1

				if (after === BREAK_MANDATORY) {
					this.nextItem = item
					this.nextOffset = -1

					return item >= p.count ? Fill.END : Fill.FORCED
				}

				if (after !== BREAK_ALLOWED && after !== BREAK_HYPHEN) continue

				const content = this.tabPending ? this.extent(pen[PEN_CONTENT] ?? 0) : (pen[PEN_CONTENT] ?? 0)
				// A hyphenator's point, not a soft hyphen's.
				const automatic = after === BREAK_HYPHEN && p.text.charCodeAt((p.start[item] ?? 0) - 1) !== 0xad

				if (
					after === BREAK_ALLOWED ||
					(!(automatic && this.hyphenBlocked) && content + styles.hyphenWidth(style) <= segEnd + EPSILON)
				) {
					candidatePieces = this.pieceCount
					candidateItem = item
					candidateHyphen = after === BREAK_HYPHEN && (p.kind[item - 1] ?? 0) === ItemKind.TEXT
					candidateAutomatic = automatic

					if (!automatic) {
						plainPieces = candidatePieces
						plainItem = item
						plainHyphen = candidateHyphen
						plainContent = content
					}
				}

				continue
			}

			if (kind === ItemKind.BREAK) {
				this.addPiece(p, item, p.start[item] ?? 0, p.end[item] ?? 0, p.end[item] ?? 0)
				this.nextItem = item + 1
				this.nextOffset = -1

				// A page or column break ending the paragraph keeps the mark on its line: that line is the
				// paragraph's last (mark height included).
				const breakKind = p.breakKind[p.aux[item] ?? 0] ?? BreakKind.LINE

				return item + 1 >= p.count && (breakKind === BreakKind.PAGE || breakKind === BreakKind.COLUMN) ? Fill.END : Fill.FORCED
			}

			// A tab: earlier right, centre or decimal content takes its place first.
			if (this.tabPending) {
				pen[PEN_X] = this.extent(pen[PEN_X] ?? 0)
				pen[PEN_CONTENT] = this.extent(pen[PEN_CONTENT] ?? 0)
				this.tabPending = false
			}

			const tab = p.aux[item] ?? 0
			const explicit = p.tabPosition[tab] ?? Number.NaN
			let stop: number
			let align: number
			let leader: number

			if (!Number.isNaN(explicit)) {
				stop = explicit
				align = p.tabAlignment[tab] ?? TabAlignment.START
				leader = p.tabLeader[tab] ?? TabLeader.NONE
			} else {
				const found = this.nextStop(g, pen[PEN_X] ?? 0, firstLine)

				stop = found ? this.foundStop : (pen[PEN_X] ?? 0)
				align = found ? this.foundAlign : TabAlignment.START
				leader = found ? this.foundLeader : TabLeader.NONE

				// Past the last stop that fits (custom stops may reach into the end indent): the tab runs to
				// the line end and the text continues on the next line.
				if (stop > segEnd + EPSILON && (this.foundDefault || stop > g.width + EPSILON)) {
					// The index first: adding a piece may replace pWidth (growing it).
					const piece = this.addPiece(p, item, p.start[item] ?? 0, p.end[item] ?? 0, p.end[item] ?? 0)

					this.pWidth[piece] = Math.max(0, segEnd - (pen[PEN_X] ?? 0))
					this.pStop[this.pieceCount - 1] = Math.max(pen[PEN_X] ?? 0, segEnd)
					this.pAlign[this.pieceCount - 1] = TabAlignment.START
					this.pLeader[this.pieceCount - 1] = leader
					this.nextItem = item + 1
					this.nextOffset = -1

					return item + 1 >= p.count ? Fill.END : Fill.WRAP
				}
			}

			this.addPiece(p, item, p.start[item] ?? 0, p.end[item] ?? 0, p.end[item] ?? 0)
			this.pStop[this.pieceCount - 1] = stop
			this.pAlign[this.pieceCount - 1] = align
			this.pLeader[this.pieceCount - 1] = leader
			placed = true

			if (align === TabAlignment.START) {
				pen[PEN_X] = Math.max(pen[PEN_X] ?? 0, stop)
			} else {
				this.tabPending = true
				this.tabStart = pen[PEN_X] ?? 0
				this.tabStop = stop
				this.tabAlign = align
				this.tabDecimal = Number.NaN
			}

			pen[PEN_CONTENT] = pen[PEN_X] ?? 0
			item++
			offset = -1

			if ((p.breakAfter[item - 1] ?? BREAK_NONE) === BREAK_ALLOWED) {
				candidatePieces = this.pieceCount
				candidateItem = item
				candidateHyphen = false
				candidateAutomatic = false
				plainPieces = candidatePieces
				plainItem = item
				plainHyphen = false
				plainContent = pen[PEN_CONTENT] ?? 0
			}
		}

		this.nextItem = p.count
		this.nextOffset = -1

		return Fill.END
	}

	// Whether the breakBefore range starting at `item` fits the rest of the line from the pen (its last item's trailing
	// spaces hang). Adds only until it overflows, so a long range costs about a line.
	private fitsRange(p: PreparedParagraph, item: number, segEnd: number): boolean {
		const end = p.aux[item] ?? 0
		const room = segEnd + EPSILON - (this.tabPending ? this.extent(this.pen[PEN_X] ?? 0) : (this.pen[PEN_X] ?? 0))
		let width = 0

		for (let k = item; k < p.count && (p.start[k] ?? 0) < end; k++) {
			if (k >= p.ready) p.refresh?.(k)

			width += p.width[k] ?? 0

			if (width - (p.hang[k] ?? 0) > room) return false

			width += p.space[k] ?? 0
		}

		return true
	}

	// Where content ending at `x` (laid out as if left-aligned) ends once a pending tab aligns it.
	private extent(x: number): number {
		if (!this.tabPending) return x

		const width = x - this.tabStart
		const before =
			this.tabAlign === TabAlignment.CENTER
				? width / 2
				: this.tabAlign === TabAlignment.DECIMAL && !Number.isNaN(this.tabDecimal)
					? this.tabDecimal
					: width

		return Math.max(this.tabStart, this.tabStop - before) + width
	}

	// The first stop after x: custom stops, the hanging indent on the first line, then default stops.
	private nextStop(g: ParagraphGeometry, x: number, firstLine: boolean): boolean {
		const tabs = g.tabs ?? NO_TABS
		let best = Infinity

		this.foundDefault = false
		this.foundAlign = TabAlignment.START
		this.foundLeader = TabLeader.NONE

		for (let k = 0; k < tabs.count; k++) {
			const position = tabs.positions[k] ?? 0

			if (position > x + EPSILON) {
				best = position
				this.foundAlign = tabs.alignments[k] ?? TabAlignment.START
				this.foundLeader = tabs.leaders[k] ?? TabLeader.NONE
				break
			}
		}

		if (firstLine && (g.hangingIndentTab ?? true) && g.firstLineIndent < 0 && g.startIndent > x + EPSILON && g.startIndent < best) {
			best = g.startIndent
			this.foundAlign = TabAlignment.START
			this.foundLeader = TabLeader.NONE
		}

		if (best === Infinity) {
			const step = g.defaultTabStop

			if (!(step > 0)) return false

			const last = tabs.count > 0 ? (tabs.positions[tabs.count - 1] ?? 0) : -Infinity

			best = (Math.floor(Math.max(x, last) / step + EPSILON) + 1) * step
			this.foundDefault = true
		}

		this.foundStop = best

		return true
	}

	// The largest cluster boundary in [start, end] whose prefix fits before segEnd (start when not even
	// the first cluster fits), its width in fitWidth. Gallops 1, 2, 4... clusters from the start and bisects
	// the last step, so the probes measure about twice the fitting length, never the whole run.
	private fitPrefix(p: PreparedParagraph, item: number, start: number, end: number, x: number, segEnd: number): number {
		const text = p.text
		let low = start
		let lowWidth = 0
		let high = end
		let step = 1

		for (;;) {
			let probe = low

			for (let k = 0; k < step && probe < end; k++) probe = nextCluster(text, probe, end)

			const width = this.measurePart(p, item, start, probe)

			if (this.extent(x + width) > segEnd + EPSILON) {
				high = probe

				break
			}

			low = probe
			lowWidth = width

			if (probe >= end) {
				this.fitWidth = width

				return end
			}

			step *= 2
		}

		for (;;) {
			let middle = clusterStart(text, (low + high) >>> 1, low)

			if (middle <= low) middle = nextCluster(text, low, high)
			if (middle >= high) break

			const width = this.measurePart(p, item, start, middle)

			if (this.extent(x + width) <= segEnd + EPSILON) {
				low = middle
				lowWidth = width
			} else {
				high = middle
			}
		}

		this.fitWidth = lowWidth

		return low
	}

	// Width of text[start, end) of a text item without spacing or scale, measured now and not cached.
	private rawWidth(p: PreparedParagraph, item: number, start: number, end: number): number {
		const styles = this.styles
		const style = p.style[item] ?? 0
		const font = ((p.flags[item] ?? 0) & ITEM_SMALL) !== 0 ? (styles.smallFontKey[style] ?? 0) : (styles.fontKey[style] ?? 0)

		return (styles.caps[style] ?? Caps.NONE) === Caps.NONE
			? styles.cache.measure(font, p.text, start, end)
			: widthUpper(styles, font, p.text, start, end)
	}

	// Width of text[start, end) of a text item, measured now.
	private measurePart(p: PreparedParagraph, item: number, start: number, end: number): number {
		if (end <= start) return 0

		const styles = this.styles
		const style = p.style[item] ?? 0

		if ((p.kind[item] ?? 0) === ItemKind.OBJECT) return p.width[item] ?? 0

		const small = ((p.flags[item] ?? 0) & ITEM_SMALL) !== 0
		const font = small ? (styles.smallFontKey[style] ?? 0) : (styles.fontKey[style] ?? 0)
		const caps = styles.caps[style] ?? Caps.NONE
		const raw = caps === Caps.NONE ? styles.cache.measure(font, p.text, start, end) : widthUpper(styles, font, p.text, start, end)

		return advanceOf(raw, styles.letterSpacing[style] ?? 0, this.countClusters(p.text, start, end)) * (styles.scaleX[style] ?? 1)
	}

	private countClusters(text: string, start: number, end: number): number {
		let clusters = 0

		for (let k = start; k < end; k = nextCluster(text, k, end)) clusters++

		return clusters
	}

	// Adds a piece and returns its index; the caller writes its width and space (pWidth, pSpace) itself: a
	// fractional number passed to a call is allocated, one written to a typed array is not.
	private addPiece(p: PreparedParagraph, item: number, start: number, end: number, contentEnd: number): number {
		if (this.pieceCount === this.pItem.length) this.growPieces()

		const k = this.pieceCount++

		this.pItem[k] = item
		this.pStart[k] = start
		this.pEnd[k] = end
		this.pContentEnd[k] = contentEnd
		this.pWidth[k] = 0
		this.pSpace[k] = 0
		this.pInner[k] = 0
		this.pTrailing[k] = 0
		this.pClusters[k] = 0
		this.pFlags[k] = 0
		this.pStop[k] = 0
		this.pAlign[k] = 0
		this.pLeader[k] = 0
		this.pWord[k] = 0
		this.pLetter[k] = 0
		this.pLevel[k] = p.kind[item] === ItemKind.TAB || p.kind[item] === ItemKind.BREAK ? p.level : (p.levels[item] ?? 0)

		return k
	}

	// Row height and baseline from everything on it (and the paragraph mark on the last row).
	private measureRow(p: PreparedParagraph, g: ParagraphGeometry): void {
		const styles = this.styles
		let ascent = 0
		let descent = 0
		let any = false
		let objectsOnly = true

		for (let k = 0; k < this.pieceCount; k++) {
			const item = this.pItem[k] ?? 0
			const style = p.style[item] ?? 0
			const shift = styles.shift[style] ?? 0
			let a: number
			let d: number

			if (p.kind[item] === ItemKind.OBJECT) {
				const box = (p.aux[item] ?? 0) * 3

				a = (p.objectBox[box + 1] ?? 0) + shift
				d = (p.objectBox[box + 2] ?? 0) - shift
			} else {
				a = (styles.ascent[style] ?? 0) + (styles.markAbove[style] ?? 0) + shift
				d = (styles.descent[style] ?? 0) + (styles.markBelow[style] ?? 0) - shift
				objectsOnly = false
			}

			ascent = Math.max(ascent, a)
			descent = Math.max(descent, d)
			any = true
		}

		const last = this.segCount > 0 && this.segFill[this.segCount - 1] === Fill.END

		this.rowLast = last

		const markOnLastLine = g.libreOfficeSpacing !== true && g.editEngineSpacing !== true

		if (!any || (last && markOnLastLine && !(objectsOnly && g.markSizesObjectLines === false))) {
			ascent = Math.max(ascent, (styles.ascent[p.markStyle] ?? 0) + (styles.markAbove[p.markStyle] ?? 0))
			descent = Math.max(descent, (styles.descent[p.markStyle] ?? 0) + (styles.markBelow[p.markStyle] ?? 0))
		}

		this.rowHeight = lineHeightFor(g, ascent + descent)
		// Extra line spacing goes above the text (and a smaller exact height clips its top), or where LibreOffice puts it.
		this.rowBaseline =
			g.libreOfficeSpacing !== true || g.lineRule === LineRule.AT_LEAST || g.lineRule === LineRule.GRID
				? g.editEngineSpacing === true && g.lineRule === LineRule.AUTO && g.lineSpacing < 1
					? Math.min(ascent, (this.rowHeight * 4) / 5)
					: this.rowHeight - descent
				: g.lineRule === LineRule.EXACT
					? (this.rowHeight * 4) / 5
					: ascent
		this.rowExtraBelow =
			g.libreOfficeSpacing === true && g.lineRule === LineRule.AUTO ? Math.max(0, this.rowHeight - ascent - descent) : 0
	}

	// Whether the fitted row ends in a hyphen (its last segment's last piece shows one).
	private rowHyphenated(): boolean {
		const s = this.segCount - 1
		const last = (this.segTo[s] ?? 0) - 1

		return s >= 0 && last >= (this.segFrom[s] ?? 0) && ((this.pFlags[last] ?? 0) & FragmentFlag.HYPHEN) !== 0
	}

	// Positions the fitted row's pieces and appends its lines; returns the break kind the row ended with,
	// or -1.
	private emitRow(p: PreparedParagraph, g: ParagraphGeometry, out: TextLayout, top: number, firstRow: boolean): number {
		let ended = -1

		this.lastExtraBelow = this.rowExtraBelow

		for (let s = 0; s < this.segCount; s++) {
			const from = this.segFrom[s] ?? 0
			const to = this.segTo[s] ?? 0
			const fill = this.segFill[s] ?? Fill.END
			const lastPiece = to - 1
			const lastItem = lastPiece >= from ? (this.pItem[lastPiece] ?? 0) : -1

			if ((fill === Fill.FORCED || fill === Fill.END) && lastItem >= 0 && p.kind[lastItem] === ItemKind.BREAK)
				ended = p.breakKind[p.aux[lastItem] ?? 0] ?? BreakKind.LINE

			const justified = this.position(p, g, s, ended)
			let flags = 0

			if (firstRow) flags |= LineFlag.FIRST
			if (s === this.segCount - 1 && this.rowLast) flags |= LineFlag.LAST
			if (s < this.segCount - 1) flags |= LineFlag.CONTINUES
			if (justified) flags |= LineFlag.JUSTIFIED
			if (g.rtl) flags |= LineFlag.RTL
			if (lastPiece >= from && ((this.pFlags[lastPiece] ?? 0) & FragmentFlag.HYPHEN) !== 0) flags |= LineFlag.HYPHENATED
			if (s === this.segCount - 1 && ended >= 0) {
				flags |=
					ended === BreakKind.PAGE
						? LineFlag.PAGE_BREAK
						: ended === BreakKind.COLUMN
							? LineFlag.COLUMN_BREAK
							: LineFlag.LINE_BREAK
			}

			this.emitSegment(p, g, out, s, top, flags)
		}

		return ended
	}

	// Final inline positions of segment s's pieces: tab widths, line-end spaces, justification, alignment.
	// Returns whether the segment was justified.
	private position(p: PreparedParagraph, g: ParagraphGeometry, s: number, ended: number): boolean {
		const from = this.segFrom[s] ?? 0
		const to = this.segTo[s] ?? 0
		const segStart = this.segStart[s] ?? 0
		const segEnd = this.segEnd[s] ?? 0
		const fill = this.segFill[s] ?? Fill.END

		// Line-end whitespace hangs: the last piece with content loses its trailing spaces, later
		// space-only pieces are dropped from width.
		let lastContent = to - 1

		while (lastContent >= from && this.isSpaceOnly(p, lastContent)) lastContent--

		let lastTab = -1

		for (let k = from; k < to; k++) {
			const item = this.pItem[k] ?? 0
			const kind = p.kind[item] ?? 0

			if (kind === ItemKind.TAB) lastTab = k

			let w = (this.pWidth[k] ?? 0) + (k < lastContent ? (this.pSpace[k] ?? 0) : 0)

			if (k > lastContent) w = 0
			if (((this.pFlags[k] ?? 0) & FragmentFlag.HYPHEN) !== 0) w += this.styles.hyphenWidth(p.style[item] ?? 0)

			this.pW[k] = w
		}

		this.resolveTabs(p, g, from, to, segStart)

		let used = 0

		for (let k = from; k < to; k++) used += this.pW[k] ?? 0

		const free = segEnd - segStart - used
		let alignment: number = g.alignment

		if (free < this.leastFree) this.leastFree = free
		let justified = false

		if (alignment === Alignment.BOTH || alignment === Alignment.DISTRIBUTE) {
			const lineBreakEnd = ended === BreakKind.LINE || ended >= BreakKind.LINE_CLEAR_LEFT
			const lastRow = fill === Fill.END || (fill === Fill.FORCED && !lineBreakEnd) || (lineBreakEnd && g.expandLineBreaks === false)
			const tabAllows = lastTab < 0 || this.pAlign[lastTab] === TabAlignment.START

			if (free > EPSILON && tabAllows && (alignment === Alignment.DISTRIBUTE || !lastRow)) {
				justified = this.justify(p, alignment === Alignment.DISTRIBUTE, Math.max(from, lastTab + 1), lastContent, free)
			}

			alignment = Alignment.START
		}

		const shift = justified || free <= 0 ? 0 : alignment === Alignment.CENTER ? free / 2 : alignment === Alignment.END ? free : 0
		let u = segStart + shift

		this.segAligned = u

		for (let k = from; k < to; k++) {
			this.pU[k] = u
			u += this.pW[k] ?? 0
		}

		return justified
	}

	// Spreads `free` over pieces [from, last]: across spaces, or across the gaps between characters for
	// distribute and for East Asian lines without spaces. A Latin line without spaces stays as it is.
	// Lines mixing ideographs with spaced Latin words widen only the spaces: whether Word also spaces the
	// ideographs there is unverified (the corpus has no justified CJK paragraphs and no rendered output).
	private justify(p: PreparedParagraph, distribute: boolean, from: number, last: number, free: number): boolean {
		let spaces = 0
		let clusters = 0
		let eastAsian = false
		let lastText = -1

		for (let k = from; k <= last; k++) {
			const item = this.pItem[k] ?? 0

			if (p.kind[item] !== ItemKind.TEXT) continue

			spaces += (this.pInner[k] ?? 0) + (k < last ? (this.pTrailing[k] ?? 0) : 0)
			clusters += (this.pClusters[k] ?? 0) + (k < last ? (this.pTrailing[k] ?? 0) : 0)
			eastAsian ||= ((p.flags[item] ?? 0) & ITEM_EAST_ASIAN) !== 0
			lastText = k
		}

		if (!distribute && spaces > 0) {
			const extra = free / spaces

			for (let k = from; k <= last; k++) {
				if (p.kind[this.pItem[k] ?? 0] !== ItemKind.TEXT) continue

				this.pWord[k] = extra
				this.pW[k] = (this.pW[k] ?? 0) + extra * ((this.pInner[k] ?? 0) + (k < last ? (this.pTrailing[k] ?? 0) : 0))
			}

			return true
		}

		if ((!distribute && !eastAsian) || clusters < 2) return false

		const extra = free / (clusters - 1)

		for (let k = from; k <= last; k++) {
			if (p.kind[this.pItem[k] ?? 0] !== ItemKind.TEXT) continue

			// CSS letter-spacing also follows the last character; that space lies past the line end and is
			// not part of the width.
			const gaps = (this.pClusters[k] ?? 0) + (k < last ? (this.pTrailing[k] ?? 0) : 0) - (k === lastText ? 1 : 0)

			this.pLetter[k] = extra
			this.pW[k] = (this.pW[k] ?? 0) + extra * gaps
		}

		return true
	}

	// Tab widths: left stops reach their position; right, centre and decimal stops pull the following
	// group (up to the next tab) back so it ends, centres or has its decimal at the stop.
	private resolveTabs(p: PreparedParagraph, g: ParagraphGeometry, from: number, to: number, segStart: number): void {
		// In a typed array, as fill()'s pen.
		const pen = this.pen

		pen[PEN_TABS] = segStart

		for (let k = from; k < to; k++) {
			if (p.kind[this.pItem[k] ?? 0] !== ItemKind.TAB) {
				pen[PEN_TABS] += this.pW[k] ?? 0

				continue
			}

			const stop = this.pStop[k] ?? 0
			const align = this.pAlign[k] ?? TabAlignment.START

			if (align === TabAlignment.START) {
				this.pW[k] = Math.max(this.pW[k] ?? 0, stop - (pen[PEN_TABS] ?? 0))
			} else {
				let group = 0
				let before = Number.NaN
				let end = k + 1

				for (; end < to && p.kind[this.pItem[end] ?? 0] !== ItemKind.TAB; end++) {
					if (align === TabAlignment.DECIMAL && Number.isNaN(before) && p.kind[this.pItem[end] ?? 0] === ItemKind.TEXT) {
						const start = this.pStart[end] ?? 0
						const at = indexIn(p.text, g.decimalSeparator ?? 0x2e, start, this.pContentEnd[end] ?? 0)

						if (at >= 0) before = group + this.measurePart(p, this.pItem[end] ?? 0, start, at)
					}

					group += this.pW[end] ?? 0
				}

				const anchor =
					align === TabAlignment.CENTER ? group / 2 : align === TabAlignment.DECIMAL && !Number.isNaN(before) ? before : group

				this.pW[k] = Math.max(0, stop - anchor - (pen[PEN_TABS] ?? 0))
			}

			pen[PEN_TABS] += this.pW[k] ?? 0
		}
	}

	private isSpaceOnly(p: PreparedParagraph, k: number): boolean {
		const item = this.pItem[k] ?? 0

		return p.kind[item] === ItemKind.TEXT && (this.pContentEnd[k] ?? 0) <= (this.pStart[k] ?? 0)
	}

	// Emits segment s: visual order per tab-separated section, physical x, merged fragments, decorations.
	private emitSegment(p: PreparedParagraph, g: ParagraphGeometry, out: TextLayout, s: number, top: number, flags: number): void {
		const from = this.segFrom[s] ?? 0
		const to = this.segTo[s] ?? 0
		const right = g.left + g.width
		const baseline = top + this.rowBaseline
		let minX = Infinity
		let maxX = -Infinity

		if (to - from > this.order.length || shrinks(this.order.length, to - from)) this.growOrder(Math.max(64, to - from))

		// Visual order: tabs stay in place (L1 puts them at the paragraph level); the pieces between them
		// reorder by level.
		let count = 0

		for (let k = from; k < to;) {
			if (p.kind[this.pItem[k] ?? 0] === ItemKind.TAB || !p.bidi) {
				this.order[count++] = k++

				continue
			}

			let end = k

			while (end < to && p.kind[this.pItem[end] ?? 0] !== ItemKind.TAB) {
				this.sectionLevels[end - k] = this.pLevel[end] ?? 0
				end++
			}

			reorder(this.sectionLevels, 0, end - k, this.sectionOrder)

			for (let v = 0; v < end - k; v++) this.order[count + v] = (this.sectionOrder[v] ?? 0) + k

			// Sections run in inline order, which is right to left in RTL paragraphs: placed below.
			count += end - k
			k = end
		}

		// Physical x per piece: sections keep their inline extent, mirrored for RTL paragraphs; pieces in a
		// section are laid out left to right in visual order.
		for (let v = 0; v < count;) {
			const k = this.order[v] ?? 0

			if (p.kind[this.pItem[k] ?? 0] === ItemKind.TAB || !p.bidi) {
				const u = this.pU[k] ?? 0
				const w = this.pW[k] ?? 0

				this.pU[k] = g.rtl ? right - u - w : g.left + u
				v++

				continue
			}

			let end = v
			let uStart = Infinity
			let uEnd = -Infinity

			while (end < count && p.kind[this.pItem[this.order[end] ?? 0] ?? 0] !== ItemKind.TAB) {
				const piece = this.order[end] ?? 0

				uStart = Math.min(uStart, this.pU[piece] ?? 0)
				uEnd = Math.max(uEnd, (this.pU[piece] ?? 0) + (this.pW[piece] ?? 0))
				end++
			}

			let x = g.rtl ? right - uEnd : g.left + uStart

			for (let w = v; w < end; w++) {
				const piece = this.order[w] ?? 0

				this.pU[piece] = x
				x += this.pW[piece] ?? 0
			}

			v = end
		}

		const textStart = from < to ? (this.pStart[from] ?? 0) : this.segmentTextStart(p)
		const textEnd = from < to ? (this.pEnd[to - 1] ?? 0) : textStart

		for (let k = from; k < to; k++) {
			if ((this.pW[k] ?? 0) <= 0 && this.isSpaceOnly(p, k)) continue

			minX = Math.min(minX, this.pU[k] ?? 0)
			maxX = Math.max(maxX, (this.pU[k] ?? 0) + (this.pW[k] ?? 0))
		}

		// An empty line sits where its alignment puts content, as the caret does in Word, PowerPoint and LibreOffice.
		if (minX === Infinity) {
			minX = g.rtl ? right - this.segAligned : g.left + this.segAligned
			maxX = minX
		}

		out.addLine(top, this.rowHeight, baseline, minX, maxX - minX, textStart, textEnd, flags, p.source)

		// Fragments, merging neighbours that continue the same text in the same style.
		let lastContent = to - 1

		while (lastContent >= from && this.isSpaceOnly(p, lastContent)) lastContent--

		let open = false
		let fx = 0
		let fw = 0
		let fStart = 0
		let fEnd = 0
		let fStyle = 0
		let fInfo = 0
		let fAux = 0
		let fWord = 0
		let fLetter = 0

		for (let v = 0; v < count; v++) {
			const k = this.order[v] ?? 0

			if (k > lastContent && this.isSpaceOnly(p, k)) continue

			const item = this.pItem[k] ?? 0
			const kind = p.kind[item] ?? 0

			if (kind === ItemKind.BREAK) continue

			const style = p.style[item] ?? 0
			const caps = this.styles.caps[style] ?? Caps.NONE
			const small = ((p.flags[item] ?? 0) & ITEM_SMALL) !== 0
			const level = this.pLevel[k] ?? 0
			const fragmentKind =
				kind === ItemKind.TAB ? FragmentKind.TAB : kind === ItemKind.OBJECT ? FragmentKind.OBJECT : FragmentKind.TEXT
			let info = fragmentKind | (level << FRAGMENT_LEVEL_SHIFT) | ((this.pFlags[k] ?? 0) & FragmentFlag.HYPHEN)

			if (caps === Caps.CAPS || (caps === Caps.SMALL_CAPS && !small)) info |= caps === Caps.CAPS ? FragmentFlag.CAPS : 0
			if (small) info |= FragmentFlag.SMALL_CAPS

			const start = this.pStart[k] ?? 0
			const end = k === lastContent ? (this.pContentEnd[k] ?? 0) : (this.pEnd[k] ?? 0)
			const x = this.pU[k] ?? 0
			const w = this.pW[k] ?? 0
			const aux = kind === ItemKind.OBJECT ? (p.objectId[p.aux[item] ?? 0] ?? 0) : kind === ItemKind.TAB ? (this.pLeader[k] ?? 0) : 0
			const word = this.pWord[k] ?? 0
			const letter = this.pLetter[k] ?? 0
			const rtl = (level & 1) === 1
			const continues =
				open &&
				fragmentKind === FragmentKind.TEXT &&
				(fInfo & ~FragmentFlag.HYPHEN) === (info & ~FragmentFlag.HYPHEN) &&
				(fInfo & FragmentFlag.HYPHEN) === 0 &&
				fStyle === style &&
				fWord === word &&
				fLetter === letter &&
				Math.abs(fx + fw - x) < 0.01 &&
				(rtl ? end === fStart : start === fEnd)

			if (continues) {
				fw += w
				fStart = Math.min(fStart, start)
				fEnd = Math.max(fEnd, end)
				fInfo |= info & FragmentFlag.HYPHEN

				continue
			}

			if (open) out.addFragment(fx, fw, fWord, fLetter, fStart, fEnd, fStyle, fInfo, fAux)

			open = true
			fx = x
			fw = w
			fStart = start
			fEnd = end
			fStyle = style
			fInfo = info
			fAux = aux
			fWord = word
			fLetter = letter
		}

		if (open) out.addFragment(fx, fw, fWord, fLetter, fStart, fEnd, fStyle, fInfo, fAux)

		this.emitDecorations(p, g, out, s, count, lastContent, top, baseline)
	}

	private segmentTextStart(p: PreparedParagraph): number {
		const item = Math.min(this.nextItem, p.count)

		return item < p.count ? (p.start[item] ?? 0) : p.text.length
	}

	// Backgrounds, borders, underlines and strikes merged over neighbouring pieces with the same key, and
	// bar tab rules on the row's first segment.
	private emitDecorations(
		p: PreparedParagraph,
		g: ParagraphGeometry,
		out: TextLayout,
		s: number,
		count: number,
		lastContent: number,
		top: number,
		baseline: number
	): void {
		const styles = this.styles
		let any = false

		for (let v = 0; v < count && !any; v++) any = (styles.decorated[p.style[this.pItem[this.order[v] ?? 0] ?? 0] ?? 0] ?? 0) !== 0

		for (let pass = 0; pass < 5 && any; pass++) {
			let open = false
			let key = 0
			let x0 = 0
			let x1 = 0
			let y = 0
			let h = 0
			let kind: DecorationKind = DecorationKind.SHADING

			for (let v = 0; v <= count; v++) {
				const k = v < count ? (this.order[v] ?? 0) : -1
				let pieceKey = 0
				let words = false
				let a = 0
				let b = 0

				if (k >= 0 && !(k > lastContent && this.isSpaceOnly(p, k)) && p.kind[this.pItem[k] ?? 0] !== ItemKind.BREAK) {
					const style = p.style[this.pItem[k] ?? 0] ?? 0

					pieceKey = styles.decorations[style * DECORATION_SLOTS + pass] ?? 0
					words = (styles.underlineWords[style] ?? 0) !== 0
					a = this.pU[k] ?? 0
					b = a + (this.pW[k] ?? 0)

					// Word-only underlines skip the spaces after each word.
					if (pass === 3 && words && p.kind[this.pItem[k] ?? 0] === ItemKind.TEXT) {
						const content = this.pWidth[k] ?? 0
						const rtl = ((this.pLevel[k] ?? 0) & 1) === 1

						if (rtl) a = b - content
						else b = a + content
					}
				}

				const adjacent = open && pieceKey === key && Math.abs(a - x1) < 0.5 && !(pass === 3 && words)

				if (open && !adjacent) {
					out.addDecoration(kind, key, x0, y, x1 - x0, h)
					open = false
				}

				if (pieceKey === 0) continue

				if (adjacent) {
					x1 = b

					continue
				}

				const style = p.style[this.pItem[k] ?? 0] ?? 0
				const em = styles.em[style] ?? 0
				const shift = styles.shift[style] ?? 0
				const ascent = styles.ascent[style] ?? 0
				const descent = styles.descent[style] ?? 0

				open = true
				key = pieceKey
				x0 = a
				x1 = b

				if (pass <= 2) {
					kind = pass === 0 ? DecorationKind.SHADING : pass === 1 ? DecorationKind.HIGHLIGHT : DecorationKind.BORDER
					y = baseline - shift - ascent
					h = ascent + descent
				} else if (pass === 3) {
					kind = DecorationKind.UNDERLINE
					h = Math.max(1, em * UNDERLINE_THICKNESS)
					y = baseline - shift + em * UNDERLINE_OFFSET
				} else {
					kind = pieceKey === Strike.DOUBLE ? DecorationKind.DOUBLE_STRIKE : DecorationKind.STRIKE
					h = Math.max(1, em * UNDERLINE_THICKNESS)
					y = baseline - shift - em * STRIKE_OFFSET
				}
			}
		}

		const bars = g.tabs?.bars

		if (s === 0 && bars !== undefined) {
			for (let k = 0; k < bars.length; k++) {
				const u = bars[k] ?? 0

				out.addDecoration(DecorationKind.BAR, 0, g.rtl ? g.left + g.width - u : g.left + u, top, 0, this.rowHeight)
			}
		}
	}

	private growPieces(): void {
		this.resizePieces(this.pItem.length * 2)
	}

	private resizePieces(size: number): void {
		this.pItem = resizeInt(this.pItem, size)
		this.pStart = resizeInt(this.pStart, size)
		this.pEnd = resizeInt(this.pEnd, size)
		this.pContentEnd = resizeInt(this.pContentEnd, size)
		this.pWidth = resizeF64(this.pWidth, size)
		this.pSpace = resizeF64(this.pSpace, size)
		this.pInner = resizeInt(this.pInner, size)
		this.pTrailing = resizeInt(this.pTrailing, size)
		this.pClusters = resizeInt(this.pClusters, size)
		this.pFlags = resizeU8(this.pFlags, size)
		this.pStop = resizeF64(this.pStop, size)
		this.pAlign = resizeU8(this.pAlign, size)
		this.pLeader = resizeU8(this.pLeader, size)
		this.pU = resizeF64(this.pU, size)
		this.pW = resizeF64(this.pW, size)
		this.pWord = resizeF64(this.pWord, size)
		this.pLetter = resizeF64(this.pLetter, size)
		this.pLevel = resizeU8(this.pLevel, size)
	}

	private growOrder(size: number): void {
		this.order = new Int32Array(Math.max(size, Math.min(this.order.length * 2, 2 * size)))
		this.sectionLevels = new Uint8Array(this.order.length)
		this.sectionOrder = new Int32Array(this.order.length)
	}

	private growSegments(): void {
		const size = this.segStart.length * 2

		this.segStart = resizeF64(this.segStart, size)
		this.segEnd = resizeF64(this.segEnd, size)
		this.segFrom = resizeInt(this.segFrom, size)
		this.segTo = resizeInt(this.segTo, size)
		this.segFill = resizeU8(this.segFill, size)
	}
}

// A line's height for its natural (font) height under the paragraph's spacing rule.
export function lineHeightFor(g: Pick<ParagraphGeometry, "lineRule" | "lineSpacing" | "gridPitch">, natural: number): number {
	switch (g.lineRule) {
		case LineRule.EXACT:
			return g.lineSpacing
		case LineRule.AT_LEAST:
			return Math.max(g.lineSpacing, natural)
		case LineRule.GRID: {
			const pitch = g.gridPitch ?? 0

			// The tolerance keeps a line exactly a row tall from rounding up to two.
			return pitch > 0 ? Math.max(g.lineSpacing, Math.ceil(natural / pitch - 1e-6) * pitch) : Math.max(g.lineSpacing, natural)
		}
		default:
			return natural * g.lineSpacing
	}
}

// Scratch arrays above this many elements are released when the next use needs under a quarter of them.
const SHRINK_ABOVE = 1 << 16

export function shrinks(capacity: number, needed: number): boolean {
	return capacity > SHRINK_ABOVE && needed * 4 < capacity
}

// An advance with letter spacing, never below zero per character (condensed text cannot run backwards).
function advanceOf(raw: number, letterSpacing: number, clusters: number): number {
	return letterSpacing >= 0 || clusters === 0 ? raw + letterSpacing * clusters : Math.max(0, raw + letterSpacing * clusters)
}

function indexIn(text: string, char: number, start: number, end: number): number {
	for (let k = start; k < end; k++) if (text.charCodeAt(k) === char) return k

	return -1
}

function sameIntervals(a: Float64Array, b: Float64Array, n: number): boolean {
	for (let k = 0; k < 2 * n; k++) if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > EPSILON) return false

	return true
}

function swap(a: Float64Array, i: number, j: number): void {
	const t = a[i] ?? 0

	a[i] = a[j] ?? 0
	a[j] = t
}

function isTrail(unit: number): boolean {
	return unit >= 0xdc00 && unit < 0xe000
}

function countSpaces(text: string, start: number, end: number): number {
	let n = 0

	for (let k = start; k < end; k++) {
		const c = text.charCodeAt(k)

		if (c === 0x20 || c === 0xa0) n++
	}

	return n
}

// The end of the extended grapheme cluster (UAX #29) starting at `at`, a cluster boundary.
export function nextCluster(text: string, at: number, end: number): number {
	return clusterEnd(text, at, end, null)
}

// Grapheme_Cluster_Break Control in the BMP (the code units UAX #29 GB4/GB5 break around).
function isControl(unit: number): boolean {
	return (
		unit < 0x20 ||
		(unit >= 0x7f && unit <= 0x9f) ||
		unit === 0xad ||
		unit === 0x061c ||
		unit === 0x180e ||
		unit === 0x200b ||
		unit === 0x200e ||
		unit === 0x200f ||
		(unit >= 0x2028 && unit <= 0x202e) ||
		(unit >= 0x2060 && unit <= 0x206f) ||
		unit === 0xfeff ||
		(unit >= 0xfff0 && unit <= 0xfffb)
	)
}

// Grapheme_Cluster_Break Prepend in the BMP.
function isPrepend(unit: number): boolean {
	return (
		(unit >= 0x0600 && unit <= 0x0605) ||
		unit === 0x06dd ||
		unit === 0x070f ||
		unit === 0x0890 ||
		unit === 0x0891 ||
		unit === 0x08e2 ||
		unit === 0x0d4e
	)
}

const JAMO_L = 1
const JAMO_V = 2
const JAMO_T = 3
const JAMO_LV = 4
const JAMO_LVT = 5

// Hangul_Syllable_Type of a code unit (0 none), by range: classify() may rewrite the Hangul Line_Break classes.
function jamo(unit: number): number {
	if (unit < 0x1100) return 0
	if (unit <= 0x115f) return JAMO_L
	if (unit <= 0x11a7) return JAMO_V
	if (unit <= 0x11ff) return JAMO_T
	if (unit >= 0xa960 && unit <= 0xa97c) return JAMO_L
	if (unit >= 0xac00 && unit <= 0xd7a3) return (unit - 0xac00) % 28 === 0 ? JAMO_LV : JAMO_LVT
	if (unit >= 0xd7b0 && unit <= 0xd7c6) return JAMO_V
	if (unit >= 0xd7cb && unit <= 0xd7fb) return JAMO_T

	return 0
}

// GB6-GB8: whether jamo `next` continues a syllable ending in jamo `prev`.
function jamoJoins(prev: number, next: number): boolean {
	if (prev === JAMO_L) return next === JAMO_L || next === JAMO_V || next === JAMO_LV || next === JAMO_LVT
	if (prev === JAMO_V || prev === JAMO_LV) return next === JAMO_V || next === JAMO_T

	return (prev === JAMO_T || prev === JAMO_LVT) && next === JAMO_T
}

// The scripts with Indic_Conjunct_Break Linker (Devanagari, Bengali, Gujarati, Oriya, Telugu, Malayalam).
function conjunctScript(unit: number): boolean {
	const block = unit & ~0x7f

	return block === 0x0900 || block === 0x0980 || block === 0x0a80 || block === 0x0b00 || block === 0x0c00 || block === 0x0d00
}

// Indic_Conjunct_Break Consonant (gaps in the ranges are unassigned).
function isConsonant(unit: number): boolean {
	if (!conjunctScript(unit)) return false

	const offset = unit & 0x7f

	if (offset >= 0x15 && offset <= 0x39) return true

	switch (unit) {
		case 0x0d3a:
		case 0x09dc:
		case 0x09dd:
		case 0x09df:
		case 0x09f0:
		case 0x09f1:
		case 0x0af9:
		case 0x0b5c:
		case 0x0b5d:
		case 0x0b5f:
		case 0x0b71:
			return true
		default:
			return (unit >= 0x0958 && unit <= 0x095f) || (unit >= 0x0978 && unit <= 0x097f) || (unit >= 0x0c58 && unit <= 0x0c5a)
	}
}

function isPictographic(text: string, at: number): boolean {
	return (wordBreakTable().get(text.codePointAt(at) ?? 0) & PICTOGRAPHIC_FLAG) !== 0
}

// nextCluster() with Line_Break values per code unit already at hand (prepare's), so counting, splitting
// and hit testing agree on clusters. Extend and SpacingMark are Line_Break CM and ZWJ (but Control), plus EM;
// Hangul, regional indicators and conjunct consonants go by code point. Regional indicators pair from `at`,
// so `at` must be a boundary.
function clusterEnd(text: string, at: number, end: number, classes: Uint8Array | null): number {
	const first = text.charCodeAt(at)

	// GB3-GB5.
	if (first === 0x0d) return at + 1 < end && text.charCodeAt(at + 1) === 0x0a ? at + 2 : at + 1
	if (isControl(first)) return at + 1

	// GB9b.
	let base = at

	while (isPrepend(text.charCodeAt(base)) && base + 1 < end && !isControl(text.charCodeAt(base + 1))) base++

	const lead = text.charCodeAt(base)
	const pair = lead >= 0xd800 && lead < 0xdc00 && base + 1 < end && isTrail(text.charCodeAt(base + 1))
	let k = base + (pair ? 2 : 1)
	// The last code point not joined by GB9: its jamo type, and whether it starts a pair of regional indicators.
	let syllable = jamo(lead)
	let regional = pair && lead === 0xd83c && text.charCodeAt(base + 1) >= 0xdde6 && text.charCodeAt(base + 1) <= 0xddff
	// GB9c: the cluster ends in a consonant, and a linker follows it.
	let consonant = isConsonant(lead)
	let linked = false
	let table: ReturnType<typeof lineBreakTable> | null = null

	while (k < end) {
		const unit = text.charCodeAt(k)

		// Nothing below U+0300 extends a cluster.
		if (unit < 0x300) break

		const wide = unit >= 0xd800 && unit < 0xdc00 && k + 1 < end && isTrail(text.charCodeAt(k + 1))
		const size = wide ? 2 : 1

		if (unit === 0x200d) {
			// GB9, and GB11: a pictograph, extenders, ZWJ, then a pictograph.
			k++
			syllable = 0
			regional = false

			if (k < end && isPictographic(text, k) && isPictographic(text, base)) {
				const joined = text.charCodeAt(k)

				base = k
				k += joined >= 0xd800 && joined < 0xdc00 && k + 1 < end && isTrail(text.charCodeAt(k + 1)) ? 2 : 1
				consonant = false
			}

			continue
		}

		const cls =
			classes !== null
				? (classes[k] ?? 0) & LINE_BREAK_CLASS_MASK
				: (table ??= lineBreakTable()).get(wide ? (text.codePointAt(k) ?? unit) : unit) & LINE_BREAK_CLASS_MASK

		// GB9, GB9a: Extend, SpacingMark (Thai and Lao SARA AM are letters to Line_Break), emoji modifiers.
		if ((cls === LineBreakClass.CM && !isControl(unit)) || cls === LineBreakClass.EM || unit === 0x0e33 || unit === 0x0eb3) {
			if (consonant && conjunctScript(unit) && (unit & 0x7f) === 0x4d) linked = true

			syllable = 0
			regional = false
			k += size

			continue
		}

		const next = jamo(unit)

		if (syllable !== 0 && next !== 0 && jamoJoins(syllable, next)) {
			syllable = next
			consonant = false
		} else if (regional && wide && unit === 0xd83c && text.charCodeAt(k + 1) >= 0xdde6 && text.charCodeAt(k + 1) <= 0xddff) {
			// GB12, GB13: regional indicators pair.
			regional = false
		} else if (consonant && linked && isConsonant(unit)) {
			linked = false
		} else {
			break
		}

		base = k
		k += size
	}

	return Math.min(k, end)
}

// The start of the cluster containing `at` (not before `start`).
export function clusterStart(text: string, at: number, start: number): number {
	let k = start

	for (let next = nextCluster(text, k, text.length); next <= at; next = nextCluster(text, k, text.length)) {
		if (next === k) break

		k = next
	}

	return k
}

function isLower(text: string, at: number): boolean {
	const c = text.charCodeAt(at)

	if (c < 0x80) return c >= 0x61 && c <= 0x7a
	if (isTrail(c)) return false

	const char = text[at] ?? ""

	return char !== char.toUpperCase()
}

function requestUpper(cache: StyleTable["cache"], font: number, text: string, start: number, end: number): number {
	const upper = text.slice(start, end).toUpperCase()

	return cache.request(font, upper, 0, upper.length)
}

function widthUpper(styles: StyleTable, font: number, text: string, start: number, end: number): number {
	const upper = text.slice(start, end).toUpperCase()

	return styles.cache.measure(font, upper, 0, upper.length)
}

function resizeInt(a: Int32Array, size: number): Int32Array<ArrayBuffer> {
	const out = new Int32Array(size)

	out.set(a.subarray(0, Math.min(a.length, size)))

	return out
}

function resizeU8(a: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(size)

	out.set(a.subarray(0, Math.min(a.length, size)))

	return out
}

function resizeF64(a: Float64Array, size: number): Float64Array<ArrayBuffer> {
	const out = new Float64Array(size)

	out.set(a.subarray(0, Math.min(a.length, size)))

	return out
}

// Flags the text item each breakBefore range starts at (none where no item starts there: no break is allowed before
// it), with the range's end in its aux. Ranges and items both run in text order: one pass over each.
function markBreakBefore(p: PreparedParagraph, ranges: ArrayLike<number>): void {
	let item = 0

	for (let k = 0; k + 1 < ranges.length; k += 2) {
		const start = ranges[k] ?? 0

		while (item < p.count && (p.start[item] ?? 0) < start) item++

		if (item >= p.count) return
		if (p.start[item] !== start || p.kind[item] !== ItemKind.TEXT) continue

		p.flags[item] = (p.flags[item] ?? 0) | ITEM_BREAK_BEFORE
		p.aux[item] = Math.max(p.aux[item] ?? 0, ranges[k + 1] ?? 0)
	}
}

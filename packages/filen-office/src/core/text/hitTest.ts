import {
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FRAGMENT_LEVEL_SHIFT,
	FragmentFlag,
	FragmentKind,
	LINE_FLOATS,
	LINE_INTS,
	LineFlag,
	LineInt,
	type TextLayout
} from "./displayList"
import { clusterStart, nextCluster } from "./layout"
import { Caps, type StyleTable } from "./styles"

// Caret positions on laid-out lines: text offset <-> x. Positions inside a fragment are measured on demand
// per cluster prefix (bisected over cluster boundaries), so nothing is stored per character. Prefix widths
// asked for are remembered in a small cache of their own (two generations, the layout's width cache is left
// alone): marks and carets drawn again after an edit ask for the same prefixes.
// Prefix widths per cache generation, and the longest prefix remembered (characters).
const PREFIX_LIMIT = 2048
const PREFIX_LONGEST = 256

export class HitTester {
	readonly styles: StyleTable
	private prefixes = new Map<string, number>()
	private olderPrefixes = new Map<string, number>()

	constructor(styles: StyleTable) {
		this.styles = styles
	}

	// The line whose box contains y among lines [from, to), clamped to the first or last.
	lineAtY(layout: TextLayout, y: number, from = 0, to = layout.lineCount): number {
		for (let line = from; line < to; line++) {
			const top = layout.lineFloats[line * LINE_FLOATS] ?? 0
			const height = layout.lineFloats[line * LINE_FLOATS + 1] ?? 0

			if (y < top + height) return line
		}

		return Math.max(from, to - 1)
	}

	// x of the caret before `offset` on `line` (`text` is the line's paragraph text). Offsets outside the
	// line's fragments go to the line's end edge (start edge when before them); in the spaces hanging past
	// its last text, they move on through those spaces, as typing them shows.
	xAtOffset(layout: TextLayout, line: number, text: string, offset: number): number {
		const ints = line * LINE_INTS
		const first = layout.lineInts[ints + LineInt.FIRST_FRAGMENT] ?? 0
		const count = layout.lineInts[ints + LineInt.FRAGMENT_COUNT] ?? 0
		const rtl = ((layout.lineInts[ints + LineInt.FLAGS] ?? 0) & LineFlag.RTL) !== 0
		const lineX = layout.lineFloats[line * LINE_FLOATS + 3] ?? 0
		const lineEnd = lineX + (layout.lineFloats[line * LINE_FLOATS + 4] ?? 0)
		let bestAfter = -1
		let last = -1
		let lastEnd = -1

		for (let f = first; f < first + count; f++) {
			const start = layout.fragmentInts[f * FRAGMENT_INTS] ?? 0
			const end = layout.fragmentInts[f * FRAGMENT_INTS + 1] ?? 0

			if (offset >= start && offset < end) return this.xInFragment(layout, f, text, offset)
			if (offset === end) bestAfter = f

			if (end > lastEnd) {
				last = f
				lastEnd = end
			}
		}

		if (bestAfter >= 0) return this.xInFragment(layout, bestAfter, text, offset)

		const textStart = layout.lineInts[ints + LineInt.TEXT_START] ?? 0
		const textEnd = layout.lineInts[ints + LineInt.TEXT_END] ?? 0

		if (offset <= textStart) return rtl ? lineEnd : lineX

		if (
			last >= 0 &&
			offset > lastEnd &&
			offset <= textEnd &&
			((layout.fragmentInts[last * FRAGMENT_INTS + 3] ?? 0) & FRAGMENT_KIND_MASK) === FragmentKind.TEXT &&
			/^[ \u00a0]+$/u.test(text.slice(lastEnd, offset))
		)
			return this.xInFragment(layout, last, text, offset, true)

		return rtl ? lineX : lineEnd
	}

	// The caret offset nearest to x on `line`.
	offsetAtX(layout: TextLayout, line: number, text: string, x: number): number {
		const ints = line * LINE_INTS
		const first = layout.lineInts[ints + LineInt.FIRST_FRAGMENT] ?? 0
		const count = layout.lineInts[ints + LineInt.FRAGMENT_COUNT] ?? 0
		const textStart = layout.lineInts[ints + LineInt.TEXT_START] ?? 0
		const textEnd = layout.lineInts[ints + LineInt.TEXT_END] ?? 0

		if (count === 0) return textStart

		let nearest = first
		let distance = Infinity

		for (let f = first; f < first + count; f++) {
			const fx = layout.fragmentFloats[f * FRAGMENT_FLOATS] ?? 0
			const fw = layout.fragmentFloats[f * FRAGMENT_FLOATS + 1] ?? 0
			const d = x < fx ? fx - x : x > fx + fw ? x - fx - fw : 0

			if (d < distance) {
				distance = d
				nearest = f
			}
		}

		const offset = this.offsetInFragment(layout, nearest, text, x)

		// Past the end edge of the logically last fragment (its right edge left to right, its left edge
		// right to left): the line's end, which includes hanging spaces.
		const end = layout.fragmentInts[nearest * FRAGMENT_INTS + 1] ?? 0
		let logicalEnd = 0

		for (let f = first; f < first + count; f++) logicalEnd = Math.max(logicalEnd, layout.fragmentInts[f * FRAGMENT_INTS + 1] ?? 0)

		if (offset === end && end === logicalEnd) {
			const fx = layout.fragmentFloats[nearest * FRAGMENT_FLOATS] ?? 0
			const fw = layout.fragmentFloats[nearest * FRAGMENT_FLOATS + 1] ?? 0
			const fragmentRtl = (((layout.fragmentInts[nearest * FRAGMENT_INTS + 3] ?? 0) >> FRAGMENT_LEVEL_SHIFT) & 1) === 1

			if (fragmentRtl ? x < fx : x > fx + fw) return textEnd
		}

		return offset
	}

	// `beyond`: offset may lie past the fragment's end (the spaces hanging after it), measured on.
	private xInFragment(layout: TextLayout, f: number, text: string, offset: number, beyond = false): number {
		const fx = layout.fragmentFloats[f * FRAGMENT_FLOATS] ?? 0
		const fw = layout.fragmentFloats[f * FRAGMENT_FLOATS + 1] ?? 0
		const start = layout.fragmentInts[f * FRAGMENT_INTS] ?? 0
		const info = layout.fragmentInts[f * FRAGMENT_INTS + 3] ?? 0
		const rtl = ((info >> FRAGMENT_LEVEL_SHIFT) & 1) === 1

		if ((info & FRAGMENT_KIND_MASK) !== FragmentKind.TEXT) return offset <= start ? (rtl ? fx + fw : fx) : rtl ? fx : fx + fw

		const advance = this.advance(layout, f, text, offset, beyond)

		return rtl ? fx + fw - advance : fx + advance
	}

	private offsetInFragment(layout: TextLayout, f: number, text: string, x: number): number {
		const fx = layout.fragmentFloats[f * FRAGMENT_FLOATS] ?? 0
		const fw = layout.fragmentFloats[f * FRAGMENT_FLOATS + 1] ?? 0
		const start = layout.fragmentInts[f * FRAGMENT_INTS] ?? 0
		const end = layout.fragmentInts[f * FRAGMENT_INTS + 1] ?? 0
		const info = layout.fragmentInts[f * FRAGMENT_INTS + 3] ?? 0
		const rtl = ((info >> FRAGMENT_LEVEL_SHIFT) & 1) === 1
		const along = rtl ? fx + fw - x : x - fx

		if ((info & FRAGMENT_KIND_MASK) !== FragmentKind.TEXT) return along < fw / 2 ? start : end

		if (along <= 0) return start
		if (along >= fw) return end

		// Advances grow with the offset: bisect cluster boundaries for low <= x < high.
		let low = start
		let lowAdvance = 0
		let high = end
		let highAdvance = fw

		for (;;) {
			let middle = clusterStart(text, (low + high) >>> 1, low)

			if (middle <= low) middle = nextCluster(text, low, high)
			if (middle >= high) break

			const advance = this.advance(layout, f, text, middle)

			if (advance <= along) {
				low = middle
				lowAdvance = advance
			} else {
				high = middle
				highAdvance = advance
			}
		}

		return along - lowAdvance < highAdvance - along ? low : high
	}

	// Advance from a text fragment's start to `offset`, with the fragment's spacing.
	private advance(layout: TextLayout, f: number, text: string, offset: number, beyond = false): number {
		const styles = this.styles
		const start = layout.fragmentInts[f * FRAGMENT_INTS] ?? 0
		const style = layout.fragmentInts[f * FRAGMENT_INTS + 2] ?? 0
		const info = layout.fragmentInts[f * FRAGMENT_INTS + 3] ?? 0
		const word = layout.fragmentFloats[f * FRAGMENT_FLOATS + 2] ?? 0
		const letter = layout.fragmentFloats[f * FRAGMENT_FLOATS + 3] ?? 0
		const end = Math.max(start, offset)

		if (end === start) return 0

		const small = (info & FragmentFlag.SMALL_CAPS) !== 0
		const font = small ? (styles.smallFontKey[style] ?? 0) : (styles.fontKey[style] ?? 0)
		const caps = (styles.caps[style] ?? Caps.NONE) !== Caps.NONE
		const prefix = caps ? text.slice(start, end).toUpperCase() : text.slice(start, end)
		let raw: number

		if (prefix.length > PREFIX_LONGEST) {
			raw = styles.cache.measure(font, prefix, 0, prefix.length)
		} else {
			const key = `${String(font)}\u0000${prefix}`
			const known = this.prefixes.get(key)

			if (known === undefined) {
				raw = this.olderPrefixes.get(key) ?? styles.cache.measure(font, prefix, 0, prefix.length)

				if (this.prefixes.size >= PREFIX_LIMIT) {
					this.olderPrefixes = this.prefixes
					this.prefixes = new Map()
				}

				this.prefixes.set(key, raw)
			} else {
				raw = known
			}
		}

		let clusters = 0
		let spaces = 0

		for (let k = start; k < end; k = nextCluster(text, k, end)) {
			const c = text.charCodeAt(k)

			clusters++

			if (c === 0x20 || c === 0xa0) spaces++
		}

		const letterSpacing = styles.letterSpacing[style] ?? 0
		const own = letterSpacing < 0 ? Math.max(0, raw + letterSpacing * clusters) : raw + letterSpacing * clusters
		const advance = own * (styles.scaleX[style] ?? 1) + word * spaces + letter * clusters

		if (beyond) return advance

		// Justification's letter spacing after the line's last character is not part of the fragment.
		return Math.min(advance, layout.fragmentFloats[f * FRAGMENT_FLOATS + 1] ?? advance)
	}
}

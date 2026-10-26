// Layout output as struct-of-arrays in typed arrays: lines, the fragments drawn on them and decorations.
// Grow-only and reusable; compact() returns tight copies to transfer to another thread.
//
// Coordinates are px in the space of the geometry passed to layout; text offsets index the paragraph text.

export const LINE_FLOATS = 5
export const LINE_INTS = 7
export const FRAGMENT_FLOATS = 4
export const FRAGMENT_INTS = 5
export const DECORATION_FLOATS = 4
export const DECORATION_INTS = 3

// lineFloats: top, height, baseline, x, width (the content after alignment).
export const LineFloat = { TOP: 0, HEIGHT: 1, BASELINE: 2, X: 3, WIDTH: 4 } as const

// lineInts: first fragment, fragment count, text start, text end, flags, source (the caller's paragraph
// id), first decoration.
export const LineInt = {
	FIRST_FRAGMENT: 0,
	FRAGMENT_COUNT: 1,
	TEXT_START: 2,
	TEXT_END: 3,
	FLAGS: 4,
	SOURCE: 5,
	FIRST_DECORATION: 6
} as const

export const LineFlag = {
	// The paragraph's last line.
	LAST: 1,
	JUSTIFIED: 2,
	// Ends at a soft hyphen or hyphenation point; its last fragment shows a hyphen.
	HYPHENATED: 4,
	// Another segment of the same row follows (text continuing past a float).
	CONTINUES: 8,
	LINE_BREAK: 16,
	PAGE_BREAK: 32,
	COLUMN_BREAK: 64,
	RTL: 128,
	// The first line of the paragraph.
	FIRST: 256
} as const

// fragmentFloats: x, width, word spacing and letter spacing added by justification (px, for CSS
// word-spacing / letter-spacing on top of the style's own).
export const FragmentFloat = { X: 0, WIDTH: 1, WORD_SPACING: 2, LETTER_SPACING: 3 } as const

// fragmentInts: text start, text end, style, info (kind | flags | bidi level << 8), aux (object id for
// objects, TabLeader for tabs).
export const FragmentInt = { TEXT_START: 0, TEXT_END: 1, STYLE: 2, INFO: 3, AUX: 4 } as const

export const FragmentKind = { TEXT: 0, TAB: 1, OBJECT: 2 } as const

export const FRAGMENT_KIND_MASK = 0x0f

export const FragmentFlag = {
	// Draw the text upper-cased.
	CAPS: 0x10,
	// Upper-cased at SMALL_CAPS_SCALE of the size.
	SMALL_CAPS: 0x20,
	// Append a hyphen (the line breaks at a soft hyphen or hyphenation point).
	HYPHEN: 0x40,
	// One cluster drawn upright in text that runs sideways (East Asian characters of vertical text): turned 90°
	// counter-clockwise about the centre of its cell, x + width / 2 along the line and (ascent − descent) / 2 of the
	// drawn font above the baseline (0.38 em, the ideographic em box's, where a painter has no font extents).
	UPRIGHT: 0x80
} as const

export const FRAGMENT_LEVEL_SHIFT = 8

// decorationFloats: x, y, width, height. decorationInts: kind, key (the style's decoration key), line.
export const DecorationKind = {
	SHADING: 1,
	HIGHLIGHT: 2,
	BORDER: 3,
	UNDERLINE: 4,
	STRIKE: 5,
	DOUBLE_STRIKE: 6,
	// A bar tab stop: a vertical rule over the line's height.
	BAR: 7
} as const

export type DecorationKind = (typeof DecorationKind)[keyof typeof DecorationKind]

export class TextLayout {
	lineCount = 0
	fragmentCount = 0
	decorationCount = 0
	lineFloats = new Float32Array(LINE_FLOATS * 16)
	lineInts = new Int32Array(LINE_INTS * 16)
	fragmentFloats = new Float32Array(FRAGMENT_FLOATS * 64)
	fragmentInts = new Int32Array(FRAGMENT_INTS * 64)
	decorationFloats = new Float32Array(DECORATION_FLOATS * 16)
	decorationInts = new Int32Array(DECORATION_INTS * 16)

	reset(): void {
		// Buffers grown by a huge paragraph are released.
		if (this.fragmentInts.length > 1 << 18) {
			this.fragmentFloats = new Float32Array(FRAGMENT_FLOATS * 64)
			this.fragmentInts = new Int32Array(FRAGMENT_INTS * 64)
		}

		if (this.lineInts.length > 1 << 18) {
			this.lineFloats = new Float32Array(LINE_FLOATS * 16)
			this.lineInts = new Int32Array(LINE_INTS * 16)
		}

		if (this.decorationInts.length > 1 << 18) {
			this.decorationFloats = new Float32Array(DECORATION_FLOATS * 16)
			this.decorationInts = new Int32Array(DECORATION_INTS * 16)
		}

		this.lineCount = 0
		this.fragmentCount = 0
		this.decorationCount = 0
	}

	// Drops lines from `lineCount` on, with their fragments and decorations.
	truncate(lineCount: number): void {
		if (lineCount >= this.lineCount) return

		this.fragmentCount = this.lineInts[lineCount * LINE_INTS + LineInt.FIRST_FRAGMENT] ?? 0
		this.decorationCount = this.lineInts[lineCount * LINE_INTS + LineInt.FIRST_DECORATION] ?? 0
		this.lineCount = lineCount
	}

	addLine(
		top: number,
		height: number,
		baseline: number,
		x: number,
		width: number,
		textStart: number,
		textEnd: number,
		flags: number,
		source: number
	): number {
		const line = this.lineCount

		if ((line + 1) * LINE_INTS > this.lineInts.length) {
			this.lineFloats = grow32(this.lineFloats)
			this.lineInts = growInt(this.lineInts)
		}

		const f = line * LINE_FLOATS
		const i = line * LINE_INTS

		this.lineFloats[f] = top
		this.lineFloats[f + 1] = height
		this.lineFloats[f + 2] = baseline
		this.lineFloats[f + 3] = x
		this.lineFloats[f + 4] = width
		this.lineInts[i] = this.fragmentCount
		this.lineInts[i + 1] = 0
		this.lineInts[i + 2] = textStart
		this.lineInts[i + 3] = textEnd
		this.lineInts[i + 4] = flags
		this.lineInts[i + 5] = source
		this.lineInts[i + 6] = this.decorationCount
		this.lineCount++

		return line
	}

	// Adds a fragment to the last line.
	addFragment(
		x: number,
		width: number,
		wordSpacing: number,
		letterSpacing: number,
		textStart: number,
		textEnd: number,
		style: number,
		info: number,
		aux: number
	): void {
		const fragment = this.fragmentCount

		if ((fragment + 1) * FRAGMENT_INTS > this.fragmentInts.length) {
			this.fragmentFloats = grow32(this.fragmentFloats)
			this.fragmentInts = growInt(this.fragmentInts)
		}

		const f = fragment * FRAGMENT_FLOATS
		const i = fragment * FRAGMENT_INTS

		this.fragmentFloats[f] = x
		this.fragmentFloats[f + 1] = width
		this.fragmentFloats[f + 2] = wordSpacing
		this.fragmentFloats[f + 3] = letterSpacing
		this.fragmentInts[i] = textStart
		this.fragmentInts[i + 1] = textEnd
		this.fragmentInts[i + 2] = style
		this.fragmentInts[i + 3] = info
		this.fragmentInts[i + 4] = aux
		this.fragmentCount++
		const count = (this.lineCount - 1) * LINE_INTS + 1

		this.lineInts[count] = (this.lineInts[count] ?? 0) + 1
	}

	addDecoration(kind: DecorationKind, key: number, x: number, y: number, width: number, height: number): void {
		const decoration = this.decorationCount

		if ((decoration + 1) * DECORATION_INTS > this.decorationInts.length) {
			this.decorationFloats = grow32(this.decorationFloats)
			this.decorationInts = growInt(this.decorationInts)
		}

		const f = decoration * DECORATION_FLOATS
		const i = decoration * DECORATION_INTS

		this.decorationFloats[f] = x
		this.decorationFloats[f + 1] = y
		this.decorationFloats[f + 2] = width
		this.decorationFloats[f + 3] = height
		this.decorationInts[i] = kind
		this.decorationInts[i + 1] = key
		this.decorationInts[i + 2] = this.lineCount - 1
		this.decorationCount++
	}

	// Moves lines [from, lineCount) down by dy.
	offset(from: number, dy: number): void {
		for (let line = from; line < this.lineCount; line++) {
			const f = line * LINE_FLOATS

			this.lineFloats[f] = (this.lineFloats[f] ?? 0) + dy
			this.lineFloats[f + 2] = (this.lineFloats[f + 2] ?? 0) + dy
		}

		const first = this.lineInts[from * LINE_INTS + LineInt.FIRST_DECORATION] ?? this.decorationCount

		for (let d = first; d < this.decorationCount; d++) {
			const f = d * DECORATION_FLOATS + 1

			this.decorationFloats[f] = (this.decorationFloats[f] ?? 0) + dy
		}
	}

	lineTop(line: number): number {
		return this.lineFloats[line * LINE_FLOATS] ?? 0
	}

	lineHeight(line: number): number {
		return this.lineFloats[line * LINE_FLOATS + 1] ?? 0
	}

	lineBaseline(line: number): number {
		return this.lineFloats[line * LINE_FLOATS + 2] ?? 0
	}

	lineFlags(line: number): number {
		return this.lineInts[line * LINE_INTS + LineInt.FLAGS] ?? 0
	}

	// Tight copies of the used parts, for transfer.
	compact(): TextLayout {
		const out = new TextLayout()

		out.lineCount = this.lineCount
		out.fragmentCount = this.fragmentCount
		out.decorationCount = this.decorationCount
		out.lineFloats = this.lineFloats.slice(0, this.lineCount * LINE_FLOATS)
		out.lineInts = this.lineInts.slice(0, this.lineCount * LINE_INTS)
		out.fragmentFloats = this.fragmentFloats.slice(0, this.fragmentCount * FRAGMENT_FLOATS)
		out.fragmentInts = this.fragmentInts.slice(0, this.fragmentCount * FRAGMENT_INTS)
		out.decorationFloats = this.decorationFloats.slice(0, this.decorationCount * DECORATION_FLOATS)
		out.decorationInts = this.decorationInts.slice(0, this.decorationCount * DECORATION_INTS)

		return out
	}

	get byteLength(): number {
		return (
			this.lineFloats.byteLength +
			this.lineInts.byteLength +
			this.fragmentFloats.byteLength +
			this.fragmentInts.byteLength +
			this.decorationFloats.byteLength +
			this.decorationInts.byteLength
		)
	}
}

function grow32(a: Float32Array): Float32Array<ArrayBuffer> {
	const out = new Float32Array(a.length * 2)

	out.set(a)

	return out
}

function growInt(a: Int32Array): Int32Array<ArrayBuffer> {
	const out = new Int32Array(a.length * 2)

	out.set(a)

	return out
}

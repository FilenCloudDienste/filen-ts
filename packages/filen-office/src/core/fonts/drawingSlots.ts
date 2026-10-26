// Which of a DrawingML run's fonts (a:latin, a:ea, a:cs, a:sym; ECMA-376 §21.1.2.3.1, .3, .7, .10) draws each
// character. DrawingML names no table of its own (MS-OI29500 is silent), so the script of each character decides,
// as PowerPoint and LibreOffice draw slides: East Asian scripts take ea, complex scripts (right-to-left and the
// South and Southeast Asian scripts) take cs, the symbol area of the private use plane (U+F000–U+F0FF, where
// symbol fonts map their glyphs) takes sym when the run names one, everything else latin. Characters of no
// script (spaces, digits, punctuation, marks) take the slot of the text before them, at the start the slot of
// the text after them (LibreOffice's weak-script rule).

export type DrawingSlot = "latin" | "ea" | "cs" | "sym"

const LATIN = 0
const EA = 1
const CS = 2
const SYM = 3
const WEAK = 4

const SLOTS: readonly DrawingSlot[] = ["latin", "ea", "cs", "sym"]

// [first, last, class], ascending; code points outside every range are latin.
const RANGES: readonly (readonly [number, number, number])[] = [
	[0x0000, 0x0040, WEAK], // controls, space, digits, ASCII punctuation
	[0x005b, 0x0060, WEAK],
	[0x007b, 0x00bf, WEAK], // ASCII punctuation, Latin-1 punctuation and signs
	[0x00d7, 0x00d7, WEAK],
	[0x00f7, 0x00f7, WEAK],
	[0x02b0, 0x036f, WEAK], // spacing modifiers, combining diacritics
	[0x0590, 0x08ff, CS], // Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic extended
	[0x0900, 0x0dff, CS], // Devanagari through Sinhala
	[0x0e00, 0x0eff, CS], // Thai, Lao
	[0x0f00, 0x0fff, CS], // Tibetan
	[0x1000, 0x109f, CS], // Myanmar
	[0x1100, 0x11ff, EA], // Hangul Jamo
	[0x1780, 0x17ff, CS], // Khmer
	[0x1800, 0x18af, CS], // Mongolian
	[0x19e0, 0x19ff, CS], // Khmer symbols
	[0x2000, 0x206f, WEAK], // general punctuation
	[0x2070, 0x20cf, WEAK], // super/subscripts, currency
	[0x2100, 0x2bff, WEAK], // letterlike symbols, arrows, maths, technical, boxes, shapes, dingbats
	[0x2e80, 0x2fdf, EA], // CJK radicals, Kangxi
	[0x2ff0, 0x303f, EA], // ideographic description, CJK symbols and punctuation
	[0x3040, 0x9fff, EA], // kana, Bopomofo, Hangul compatibility Jamo, Kanbun, CJK extension A, unified ideographs
	[0xa000, 0xa4cf, EA], // Yi
	[0xa960, 0xa97f, EA], // Hangul Jamo extended A
	[0xac00, 0xd7ff, EA], // Hangul syllables, Jamo extended B
	[0xf000, 0xf0ff, SYM], // symbol-font private use area
	[0xf900, 0xfaff, EA], // CJK compatibility ideographs
	[0xfb1d, 0xfdff, CS], // Hebrew and Arabic presentation forms A
	[0xfe30, 0xfe4f, EA], // CJK compatibility forms
	[0xfe50, 0xfe6f, EA], // small form variants
	[0xfe70, 0xfeff, CS], // Arabic presentation forms B
	[0xff00, 0xffef, EA], // halfwidth and fullwidth forms
	[0x20000, 0x3ffff, EA] // CJK extensions B and later
]

function classOf(code: number): number {
	let low = 0
	let high = RANGES.length - 1

	while (low <= high) {
		const mid = (low + high) >> 1
		const range = RANGES[mid]

		if (range === undefined) break

		if (code < range[0]) high = mid - 1
		else if (code > range[1]) low = mid + 1
		else return range[2]
	}

	return LATIN
}

// The script slot of one code point, before the weak-character rule (WEAK for characters of no script).
export function drawingSlotOf(code: number, hasSymbolFont: boolean): DrawingSlot | undefined {
	const cls = classOf(code)

	if (cls === WEAK) return undefined
	if (cls === SYM && !hasSymbolFont) return "latin"

	return SLOTS[cls]
}

// Calls `visit(start, end, slot)` for each maximal piece of `text` drawn with one slot, in order. `fallback` is
// the slot of text with no script at all (the run's own, from its neighbours or its language).
export function forEachDrawingSlotRun(
	text: string,
	hasSymbolFont: boolean,
	fallback: DrawingSlot,
	visit: (start: number, end: number, slot: DrawingSlot) => void
): void {
	const length = text.length

	if (length === 0) return

	// The first strong slot, for the weak characters before it.
	let current = -1

	for (let at = 0; at < length && current < 0;) {
		const code = text.codePointAt(at) ?? 0
		const cls = classOf(code)

		if (cls !== WEAK) current = cls === SYM && !hasSymbolFont ? LATIN : cls

		at += code > 0xffff ? 2 : 1
	}

	if (current < 0) current = SLOTS.indexOf(fallback)

	let start = 0

	for (let at = 0; at < length;) {
		const code = text.codePointAt(at) ?? 0
		const step = code > 0xffff ? 2 : 1
		let cls = classOf(code)

		if (cls === SYM && !hasSymbolFont) cls = LATIN

		if (cls !== WEAK && cls !== current) {
			if (at > start) visit(start, at, SLOTS[current] ?? "latin")

			start = at
			current = cls
		}

		at += step
	}

	visit(start, length, SLOTS[current] ?? "latin")
}

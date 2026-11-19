// Which of a run's four fonts (w:rFonts ascii, hAnsi, eastAsia, cs) draws a character, as Word decides it
// (MS-OI29500 on ISO/IEC 29500-1 §17.3.2.26): w:cs or w:rtl on the run selects cs for everything;
// otherwise a table of Unicode blocks applies, some blocks following w:hint="eastAsia" and, for Latin
// letters, also a Chinese run language or a Chinese eastAsia font. Unlisted blocks use hAnsi.

export type FontSlot = "ascii" | "hAnsi" | "eastAsia" | "cs"

// w:hint. Word's table only consults "eastAsia"; "cs" is accepted and changes nothing.
export type FontHint = "default" | "eastAsia" | "cs"

export interface SlotContext {
	readonly hint: FontHint
	// The run carries w:cs or w:rtl.
	readonly complexScript: boolean
	// The run's w:lang eastAsia language is Chinese (isChineseLanguage).
	readonly chineseLanguage: boolean
	// The eastAsia font's character set is GB2312 or Big5 (isChineseCharset).
	readonly chineseFontCharset: boolean
}

export function isChineseLanguage(lang: string | undefined): boolean {
	return lang !== undefined && /^zh(?:-|$)/i.test(lang)
}

// w:charset values of GB2312 (Simplified) and Chinese5/Big5 (Traditional).
export function isChineseCharset(charset: number | undefined): boolean {
	return charset === 134 || charset === 136
}

// Word draws the whole run with the ascii font when the eastAsia font is "Times New Roman" (its default)
// and ascii equals hAnsi. Pass the names after theme fonts are resolved.
export function eastAsiaUsesAscii(ascii: string, hAnsi: string, eastAsia: string): boolean {
	return eastAsia.toLowerCase() === "times new roman" && ascii.toLowerCase() === hAnsi.toLowerCase()
}

const ASCII = 0
const H_ANSI = 1
const EAST_ASIA = 2
// hAnsi, or eastAsia under the eastAsia hint.
const HINTED = 3
// Latin-1: symbols as HINTED; some letters also need a Chinese language.
const LATIN1 = 4
// hAnsi, or eastAsia under the hint with a Chinese language or a Chinese eastAsia font.
const CHINESE_LATIN = 5
// As CHINESE_LATIN, but only the language counts.
const CHINESE_LANGUAGE_LATIN = 6

// [first, last, class], ascending.
const TABLE: readonly (readonly [number, number, number])[] = [
	[0x0000, 0x007f, ASCII],
	[0x00a0, 0x00ff, LATIN1],
	[0x0100, 0x02af, CHINESE_LATIN], // Latin Extended-A and -B, IPA
	[0x02b0, 0x03cf, HINTED], // spacing modifiers, combining diacritics, Greek
	[0x0400, 0x04ff, HINTED], // Cyrillic
	[0x0590, 0x07bf, ASCII], // Hebrew, Arabic, Syriac, Arabic Supplement, Thaana
	[0x1100, 0x11ff, EAST_ASIA], // Hangul Jamo
	[0x1e00, 0x1eff, CHINESE_LANGUAGE_LATIN], // Latin Extended Additional
	[0x2000, 0x27bf, HINTED], // general punctuation through dingbats
	[0x2e80, 0x2eff, HINTED], // CJK radicals supplement
	[0x2f00, 0x2fdf, EAST_ASIA], // Kangxi radicals
	[0x2ff0, 0x4dbf, EAST_ASIA], // ideographic description through CJK extension A
	[0x4e00, 0x9faf, EAST_ASIA], // CJK unified ideographs
	[0xa000, 0xa4cf, EAST_ASIA], // Yi
	[0xac00, 0xd7af, EAST_ASIA], // Hangul syllables
	[0xd800, 0xdfff, EAST_ASIA], // surrogates
	[0xe000, 0xf8ff, HINTED], // private use area
	[0xf900, 0xfaff, EAST_ASIA], // CJK compatibility ideographs
	[0xfb00, 0xfb1c, HINTED], // alphabetic presentation forms (Latin, Armenian)
	[0xfb1d, 0xfdff, ASCII], // Hebrew and Arabic presentation forms A
	[0xfe30, 0xfe6f, EAST_ASIA], // CJK compatibility forms, small form variants
	[0xfe70, 0xfefe, ASCII], // Arabic presentation forms B
	[0xff00, 0xffef, EAST_ASIA] // halfwidth and fullwidth forms
]

// Latin-1 symbols the eastAsia hint alone moves.
function isLatin1Symbol(c: number): boolean {
	return (
		c === 0xa1 ||
		c === 0xa4 ||
		c === 0xa7 ||
		c === 0xa8 ||
		c === 0xaa ||
		c === 0xad ||
		c === 0xaf ||
		(c >= 0xb0 && c <= 0xb4) ||
		(c >= 0xb6 && c <= 0xba) ||
		(c >= 0xbc && c <= 0xbf) ||
		c === 0xd7 ||
		c === 0xf7
	)
}

// Latin-1 letters that move under the hint when the run language is Chinese.
function isLatin1ChineseLetter(c: number): boolean {
	return (
		c === 0xe0 ||
		c === 0xe1 ||
		(c >= 0xe8 && c <= 0xea) ||
		c === 0xec ||
		c === 0xed ||
		c === 0xf2 ||
		c === 0xf3 ||
		c === 0xf9 ||
		c === 0xfa ||
		c === 0xfc
	)
}

function classOf(c: number): number {
	let low = 0
	let high = TABLE.length - 1

	while (low <= high) {
		const middle = (low + high) >>> 1
		const [first, last, kind] = TABLE[middle] ?? [0, 0, H_ANSI]

		if (c < first) high = middle - 1
		else if (c > last) low = middle + 1
		else return kind
	}

	return H_ANSI
}

// A supplementary-plane code point counts as its surrogates do: eastAsia.
export function fontSlot(codePoint: number, context: SlotContext): FontSlot {
	if (context.complexScript) return "cs"
	if (codePoint > 0xffff) return "eastAsia"

	const hinted = context.hint === "eastAsia"

	switch (classOf(codePoint)) {
		case ASCII:
			return "ascii"
		case EAST_ASIA:
			return "eastAsia"
		case HINTED:
			return hinted ? "eastAsia" : "hAnsi"
		case LATIN1:
			return hinted && (isLatin1Symbol(codePoint) || (context.chineseLanguage && isLatin1ChineseLetter(codePoint)))
				? "eastAsia"
				: "hAnsi"
		case CHINESE_LATIN:
			return hinted && (context.chineseLanguage || context.chineseFontCharset) ? "eastAsia" : "hAnsi"
		case CHINESE_LANGUAGE_LATIN:
			return hinted && context.chineseLanguage ? "eastAsia" : "hAnsi"
		default:
			return "hAnsi"
	}
}

// Joiners, variation selectors and combining marks for symbols (the keycap U+20E3) stay with the character
// before them, unlike in Word's table: splitting an emoji or keycap sequence across fonts breaks its
// shaping. Combining marks for letters (U+0300-036F) follow the table as Word does, since the letters
// they sit on usually take the same font.
function attaches(c: number): boolean {
	return c === 0x200c || c === 0x200d || (c >= 0x20d0 && c <= 0x20ff) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef)
}

// Calls `run` for each maximal stretch of `text` (UTF-16 offsets, end exclusive) drawn by one slot.
export function forEachSlotRun(text: string, context: SlotContext, run: (start: number, end: number, slot: FontSlot) => void): void {
	if (text.length === 0) return

	if (context.complexScript) {
		run(0, text.length, "cs")

		return
	}

	let start = 0
	let current: FontSlot | null = null

	for (let i = 0; i < text.length;) {
		const codePoint = text.codePointAt(i) ?? 0
		const slot: FontSlot = current !== null && attaches(codePoint) ? current : fontSlot(codePoint, context)

		if (slot !== current) {
			if (current !== null) run(start, i, current)

			current = slot
			start = i
		}

		i += codePoint > 0xffff ? 2 : 1
	}

	if (current !== null) run(start, text.length, current)
}

// Excel's sort order ("Sort data in a workbook in the browser", support.microsoft.com, "Default sort orders"): in an
// ascending sort numbers (dates are numbers) come first, from the smallest negative to the largest positive, then
// text, then logical values (FALSE before TRUE), then errors (all equal); blank cells are last whatever the
// direction, and a descending sort reverses everything else. Text sorts left to right, character by character, in
// the order 0-9, space ! " # $ % & ( ) * , . / : ; ? @ [ \ ] ^ _ ` { | } ~ + < = >, then the letters; apostrophes
// and hyphens are ignored, except that of two texts equal but for a hyphen the one with the hyphen sorts last. A
// sort is case-insensitive unless asked: then a lowercase letter sorts before its uppercase one (a A b B ...).
//
// The page is silent on letters outside A-Z: accented Latin letters sort with their base letter, after it when the
// texts are otherwise equal (as Windows sorts them); letters of other scripts after Z, by code point; other
// symbols after the listed ones, by code point.

export const SortType = {
	NUMBER: 0,
	TEXT: 1,
	BOOLEAN: 2,
	ERROR: 3,
	BLANK: 4
} as const

export type SortType = (typeof SortType)[keyof typeof SortType]

// One cell as a sort reads it: numbers and booleans by `number` (0 or 1), text by its key (textSortKey).
export interface SortValue {
	readonly type: SortType
	readonly number: number
	readonly key: string
}

export const BLANK_SORT_VALUE: SortValue = { type: SortType.BLANK, number: 0, key: "" }

const SYMBOLS = ' !"#$%&()*,./:;?@[\\]^_`{|}~+<=>'
// Weights: the separator 1, digits 2-11, the listed symbols next, other symbols, then letters. Every weight is a
// single UTF-16 unit below the surrogates, so the keys compare as plain strings.
const SEPARATOR = "\u0001"
const DIGIT_BASE = 2
const SYMBOL_BASE = DIGIT_BASE + 10
const OTHER_SYMBOL_BASE = SYMBOL_BASE + SYMBOLS.length
// Other symbols by code point, folded into 0x0800 weights (a collision only ties them).
const OTHER_SYMBOL_SPAN = 0x0800
const LETTER_BASE = OTHER_SYMBOL_BASE + OTHER_SYMBOL_SPAN
// Other scripts' letters by the code point they fold to (their lower case), ranked in code point order above the
// ASCII letters. Not every code point fits below the surrogates, so these [start, end) runs of eight or more that no
// letter folds to are left out (the symbol blocks, upper case letters, the surrogates, the Latin letters folded
// above), and the private use area ties: every other code point of the BMP keeps a weight of its own, in order. One
// in a run ties with the first after it (a letter a later Unicode version adds there); astral letters tie last.
const OTHER_LETTER_BASE = LETTER_BASE + 26
const UNRANKED = Uint32Array.of(
	0x0,
	0x6b,
	0x6c,
	0xb5,
	0xb6,
	0xdf,
	0xe6,
	0x180,
	0x391,
	0x3a2,
	0x3a3,
	0x3ac,
	0x3fd,
	0x430,
	0x531,
	0x557,
	0x10a0,
	0x10c6,
	0x13a0,
	0x13f6,
	0x1c90,
	0x1cbb,
	0x1f08,
	0x1f10,
	0x1f28,
	0x1f30,
	0x1f38,
	0x1f40,
	0x1f68,
	0x1f70,
	0x1f88,
	0x1f90,
	0x1f98,
	0x1fa0,
	0x1fa8,
	0x1fb0,
	0x2000,
	0x214e,
	0x214f,
	0x2170,
	0x2185,
	0x24d0,
	0x24ea,
	0x2c30,
	0x3000,
	0x3040,
	0xd800,
	0xf8ff,
	0xfe30,
	0xfe50,
	0xff00,
	0xff10,
	0xff21,
	0xff3b
)
// Code points left out before each run, and in all (the last entry).
const UNRANKED_BEFORE = new Uint32Array(UNRANKED.length / 2 + 1)

for (let run = 0; run < UNRANKED.length / 2; run++)
	UNRANKED_BEFORE[run + 1] = (UNRANKED_BEFORE[run] ?? 0) + (UNRANKED[run * 2 + 1] ?? 0) - (UNRANKED[run * 2] ?? 0)

const ASTRAL_LETTER_RANK = 0x10000 - (UNRANKED_BEFORE[UNRANKED.length / 2] ?? 0)

// A folded letter's rank among the other scripts' letters: never decreasing with the code point, below
// ASTRAL_LETTER_RANK + 1.
function letterRank(code: number): number {
	if (code > 0xffff) return ASTRAL_LETTER_RANK

	// The last run starting at or before `code` (the first starts at 0).
	let low = 0
	let high = UNRANKED.length / 2

	while (low < high) {
		const mid = (low + high) >>> 1

		if ((UNRANKED[mid * 2] ?? 0) <= code) low = mid + 1
		else high = mid
	}

	const run = low - 1
	const start = UNRANKED[run * 2] ?? 0
	const end = UNRANKED[run * 2 + 1] ?? 0

	return (code < end ? start : code - (end - start)) - (UNRANKED_BEFORE[run] ?? 0)
}

const ASCII = new Uint16Array(128)

for (let code = 0; code < 128; code++) {
	if (code >= 48 && code <= 57) ASCII[code] = DIGIT_BASE + code - 48
	else if (code >= 65 && code <= 90) ASCII[code] = LETTER_BASE + code - 65
	else if (code >= 97 && code <= 122) ASCII[code] = LETTER_BASE + code - 97
	else {
		const at = SYMBOLS.indexOf(String.fromCharCode(code))

		ASCII[code] = at >= 0 ? SYMBOL_BASE + at : OTHER_SYMBOL_BASE + code
	}
}

// Accented Latin letters (Latin-1 Supplement and Latin Extended-A) by base letter: "a" for à, with the accent's rank.
// (× and ÷ are symbols: "*" and "/" mark them.)
const LATIN_BASES = [
	// U+00C0-U+00FF
	"AAAAAAA",
	"C",
	"EEEE",
	"IIII",
	"DN",
	"OOOOO*O",
	"UUUU",
	"YTs",
	"aaaaaaa",
	"c",
	"eeee",
	"iiii",
	"dn",
	"ooooo/o",
	"uuuu",
	"yty",
	// U+0100-U+017F
	"AaAaAa",
	"CcCcCcCc",
	"DdDd",
	"EeEeEeEeEe",
	"GgGgGgGg",
	"HhHh",
	"IiIiIiIiIiIi",
	"Jj",
	"Kkk",
	"LlLlLlLlLl",
	"NnNnNnn",
	"Nn",
	"OoOoOoOo",
	"RrRrRr",
	"SsSsSsSs",
	"TtTtTt",
	"UuUuUuUuUuUu",
	"Ww",
	"YyY",
	"ZzZzZz",
	"s"
].join("")

// Each accented Latin letter's accent rank (1 up): its lower case's code point, which its upper case shares (Ÿ the
// rank of ÿ), so accents never tie and neither does case alone; İ, ß, ĸ, ŉ and ſ, with no pair in the block, rank
// alone.
const LATIN_ACCENTS = new Uint8Array(0x180 - 0xc0)

for (let code = 0xc0; code < 0x180; code++) {
	const lower = String.fromCharCode(code).toLowerCase()
	const paired = lower.length === 1 && lower.charCodeAt(0) >= 0xc0 && lower.charCodeAt(0) < 0x180 ? lower.charCodeAt(0) : code

	LATIN_ACCENTS[code - 0xc0] = 1 + paired - 0xc0
}

interface Folded {
	// The primary weight, 0 for a character the order ignores (apostrophe, hyphen).
	readonly primary: number
	// 0 unaccented, else an accent's rank.
	readonly accent: number
	readonly upper: boolean
}

function isUpper(char: string): boolean {
	return char !== char.toLowerCase() && char === char.toUpperCase()
}

function fold(code: number, char: string): Folded {
	if (code < 128) {
		if (code === 39 || code === 45) return { primary: 0, accent: 0, upper: false }

		return { primary: ASCII[code] ?? 0, accent: 0, upper: code >= 65 && code <= 90 }
	}

	if (code >= 0xc0 && code <= 0x17f) {
		const base = LATIN_BASES.charCodeAt(code - 0xc0)

		// × and ÷ are symbols.
		if (base !== 42 && base !== 47) return { primary: ASCII[base] ?? 0, accent: LATIN_ACCENTS[code - 0xc0] ?? 0, upper: isUpper(char) }
	}

	// The right single quotation mark and the hyphens of General Punctuation read as the ASCII ones.
	if (code === 0x2019 || code === 0x2010 || code === 0x2011) return { primary: 0, accent: 0, upper: false }

	// A character with no case is a letter when it is outside the punctuation and symbol blocks.
	const cased = char.toLowerCase() !== char.toUpperCase()
	const symbol =
		!cased &&
		((code >= 0x80 && code <= 0xbf) ||
			code === 0xd7 ||
			code === 0xf7 ||
			(code >= 0x2000 && code <= 0x2bff) ||
			(code >= 0x3000 && code <= 0x303f) ||
			(code >= 0xfe30 && code <= 0xfe4f) ||
			(code >= 0xff00 && code <= 0xff0f))

	if (symbol) return { primary: OTHER_SYMBOL_BASE + 128 + ((code - 128) % (OTHER_SYMBOL_SPAN - 128)), accent: 0, upper: false }

	const lower = cased ? (char.toLowerCase().codePointAt(0) ?? code) : code

	return { primary: OTHER_LETTER_BASE + letterRank(lower), accent: 0, upper: cased && isUpper(char) }
}

// A text's sort key: compared as plain strings, two keys order as Excel orders their texts (case-insensitive unless
// `caseSensitive`). Primary weights, then accents, then (when case counts) case, then the ignored characters.
export function textSortKey(text: string, caseSensitive: boolean): string {
	let primary = ""
	let accents = ""
	let cases = ""
	let ignored = 0
	let accented = false

	for (let i = 0; i < text.length; i++) {
		let code = text.charCodeAt(i)
		let char = text[i] as string

		// A surrogate pair is one character.
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const low = text.charCodeAt(i + 1)

			if (low >= 0xdc00 && low <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
				char = text.slice(i, i + 2)
				i++
			}
		}

		const folded = fold(code, char)

		if (folded.primary === 0) {
			ignored++

			continue
		}

		primary += String.fromCharCode(folded.primary)
		accents += String.fromCharCode(1 + folded.accent)
		cases += folded.upper ? "\u0002" : "\u0001"
		accented ||= folded.accent !== 0
	}

	// Each part ends in the separator, so a text that is a prefix of another sorts first.
	return (
		primary +
		SEPARATOR +
		(accented ? accents : "") +
		SEPARATOR +
		(caseSensitive ? cases : "") +
		SEPARATOR +
		String.fromCharCode(1 + Math.min(ignored, 0xd000))
	)
}

// -1, 0 or 1 for a before, equal to, or after b, ascending; blanks last in either direction.
export function compareSortValues(a: SortValue, b: SortValue, descending: boolean): number {
	if (a.type === SortType.BLANK || b.type === SortType.BLANK) return a.type === b.type ? 0 : a.type === SortType.BLANK ? 1 : -1

	let order = 0

	if (a.type !== b.type) order = a.type < b.type ? -1 : 1
	else if (a.type === SortType.TEXT) order = a.key < b.key ? -1 : a.key > b.key ? 1 : 0
	else if (a.type !== SortType.ERROR) order = a.number < b.number ? -1 : a.number > b.number ? 1 : 0

	return descending ? -order : order
}

// The order of `count` items by their keys (the first key first), stable: items equal on every key keep their order.
// `value(key, item)` reads one key of one item.
export function sortOrder(
	count: number,
	keys: readonly { readonly descending: boolean }[],
	value: (key: number, item: number) => SortValue
): Int32Array {
	const values: SortValue[][] = keys.map((_, key) => {
		const column: SortValue[] = new Array<SortValue>(count)

		for (let item = 0; item < count; item++) column[item] = value(key, item)

		return column
	})
	const order: number[] = new Array<number>(count)

	for (let item = 0; item < count; item++) order[item] = item

	order.sort((a, b) => {
		for (let key = 0; key < keys.length; key++) {
			const column = values[key] as SortValue[]
			const compared = compareSortValues(
				column[a] as SortValue,
				column[b] as SortValue,
				(keys[key] as { descending: boolean }).descending
			)

			if (compared !== 0) return compared
		}

		return a - b
	})

	return Int32Array.from(order)
}

// Automatic numbering of DrawingML paragraphs (a:buAutoNum, ECMA-376 §21.1.2.4.1) for every
// ST_TextAutonumberScheme value (§20.1.10.61), and the counters PowerPoint keeps per text body: one per level,
// starting at startAt; a paragraph at a lower level (a shallower outline level) or a paragraph without
// automatic numbering at the same or a lower level ends the run, so the next numbered paragraph starts again; a
// deeper paragraph leaves the outer counters as they are.

const LOWER = "abcdefghijklmnopqrstuvwxyz"
const ROMAN: readonly (readonly [number, string])[] = [
	[1000, "m"],
	[900, "cm"],
	[500, "d"],
	[400, "cd"],
	[100, "c"],
	[90, "xc"],
	[50, "l"],
	[40, "xl"],
	[10, "x"],
	[9, "ix"],
	[5, "v"],
	[4, "iv"],
	[1, "i"]
]
const CJK_DIGITS = "〇一二三四五六七八九"
// Arabic letters in alphabetical (hija'i) and abjad order, Hebrew letters with their numeric values.
const ARABIC_ALPHA = "أبتثجحخدذرزسشصضطظعغفقكلمنهوي"
const ARABIC_ABJAD = "أبجدهوزحطيكلمنسعفصقرشتثخذضظغ"
const HEBREW_UNITS = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"]
const HEBREW_TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"]
const HEBREW_HUNDREDS = ["", "ק", "ר", "ש", "ת"]
const THAI_ALPHA = "กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮ"
const HINDI_ALPHA = "कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह"

export const AUTONUMBER_SCHEMES = [
	"alphaLcParenBoth",
	"alphaUcParenBoth",
	"alphaLcParenR",
	"alphaUcParenR",
	"alphaLcPeriod",
	"alphaUcPeriod",
	"arabicParenBoth",
	"arabicParenR",
	"arabicPeriod",
	"arabicPlain",
	"romanLcParenBoth",
	"romanUcParenBoth",
	"romanLcParenR",
	"romanUcParenR",
	"romanLcPeriod",
	"romanUcPeriod",
	"circleNumDbPlain",
	"circleNumWdBlackPlain",
	"circleNumWdWhitePlain",
	"arabicDbPeriod",
	"arabicDbPlain",
	"ea1ChsPeriod",
	"ea1ChsPlain",
	"ea1ChtPeriod",
	"ea1ChtPlain",
	"ea1JpnChsDbPeriod",
	"ea1JpnKorPlain",
	"ea1JpnKorPeriod",
	"arabic1Minus",
	"arabic2Minus",
	"hebrew2Minus",
	"thaiAlphaPeriod",
	"thaiAlphaParenR",
	"thaiAlphaParenBoth",
	"thaiNumPeriod",
	"thaiNumParenR",
	"thaiNumParenBoth",
	"hindiAlphaPeriod",
	"hindiNumPeriod",
	"hindiNumParenR",
	"hindiAlpha1Period"
] as const

export type AutonumberScheme = (typeof AUTONUMBER_SCHEMES)[number]

const SCHEME_SET: ReadonlySet<string> = new Set(AUTONUMBER_SCHEMES)

// The largest number formatted (PowerPoint's startAt maximum, ST_TextBulletStartAtNum).
const MAX_NUMBER = 32767

function alphabetic(value: number, letters: string): string {
	// Repeated letters past the alphabet: a…z, aa…zz, aaa… (PowerPoint and LibreOffice).
	const count = Array.from(letters).length
	const glyphs = Array.from(letters)
	const index = (value - 1) % count
	const repeat = Math.floor((value - 1) / count) + 1

	return (glyphs[index] ?? "").repeat(Math.min(repeat, 64))
}

function roman(value: number): string {
	let rest = value
	let out = ""

	for (const [amount, text] of ROMAN) {
		while (rest >= amount) {
			out += text
			rest -= amount
		}
	}

	return out
}

function digits(value: number, zero: number): string {
	let out = ""

	for (const char of String(value)) out += String.fromCodePoint(zero + (char.charCodeAt(0) - 0x30))

	return out
}

// Chinese and Japanese counting numerals (一, 十, 二十一, 一百…), as PowerPoint writes the ea1 schemes.
function cjk(value: number): string {
	if (value < 10) return CJK_DIGITS[value] ?? ""

	const units: readonly (readonly [number, string])[] = [
		[10000, "万"],
		[1000, "千"],
		[100, "百"],
		[10, "十"]
	]
	let rest = value
	let out = ""

	for (const [amount, mark] of units) {
		const count = Math.floor(rest / amount)

		if (count > 0) {
			out += (count === 1 && amount === 10 && out === "" ? "" : cjk(count)) + mark
			rest -= count * amount
		}
	}

	return rest > 0 ? out + (CJK_DIGITS[rest] ?? "") : out
}

function hebrew(value: number): string {
	let rest = value % 1000 || value
	let out = ""

	while (rest >= 400) {
		out += "ת"
		rest -= 400
	}

	out += HEBREW_HUNDREDS[Math.floor(rest / 100)] ?? ""
	rest %= 100

	// 15 and 16 are written ט״ו and ט״ז, never with the letters of a divine name.
	if (rest === 15 || rest === 16) return out + "ט" + (HEBREW_UNITS[rest - 9] ?? "")

	return out + (HEBREW_TENS[Math.floor(rest / 10)] ?? "") + (HEBREW_UNITS[rest % 10] ?? "")
}

function circled(value: number, first: number, count: number): string | undefined {
	return value >= 1 && value <= count ? String.fromCodePoint(first + value - 1) : undefined
}

// The text of number `value` in `scheme` (an unknown scheme is arabicPeriod, as PowerPoint reads it).
export function autonumberText(scheme: string, value: number): string {
	const n = Math.max(1, Math.min(MAX_NUMBER, Math.trunc(value)))
	const known = (SCHEME_SET.has(scheme) ? scheme : "arabicPeriod") as AutonumberScheme

	switch (known) {
		case "alphaLcParenBoth":
			return `(${alphabetic(n, LOWER)})`
		case "alphaUcParenBoth":
			return `(${alphabetic(n, LOWER).toUpperCase()})`
		case "alphaLcParenR":
			return `${alphabetic(n, LOWER)})`
		case "alphaUcParenR":
			return `${alphabetic(n, LOWER).toUpperCase()})`
		case "alphaLcPeriod":
			return `${alphabetic(n, LOWER)}.`
		case "alphaUcPeriod":
			return `${alphabetic(n, LOWER).toUpperCase()}.`
		case "arabicParenBoth":
			return `(${n})`
		case "arabicParenR":
			return `${n})`
		case "arabicPeriod":
			return `${n}.`
		case "arabicPlain":
			return String(n)
		case "romanLcParenBoth":
			return `(${roman(n)})`
		case "romanUcParenBoth":
			return `(${roman(n).toUpperCase()})`
		case "romanLcParenR":
			return `${roman(n)})`
		case "romanUcParenR":
			return `${roman(n).toUpperCase()})`
		case "romanLcPeriod":
			return `${roman(n)}.`
		case "romanUcPeriod":
			return `${roman(n).toUpperCase()}.`
		// Circled numbers exist up to 20 (double-byte) and 10 (dingbats); past them, plain numbers.
		case "circleNumDbPlain":
			return circled(n, 0x2460, 20) ?? String(n)
		case "circleNumWdBlackPlain":
			return circled(n, 0x278a, 10) ?? String(n)
		case "circleNumWdWhitePlain":
			return circled(n, 0x2780, 10) ?? String(n)
		case "arabicDbPeriod":
			return `${digits(n, 0xff10)}．`
		case "arabicDbPlain":
			return digits(n, 0xff10)
		case "ea1ChsPeriod":
		case "ea1ChtPeriod":
			return `${cjk(n)}.`
		case "ea1ChsPlain":
		case "ea1ChtPlain":
		case "ea1JpnKorPlain":
			return cjk(n)
		case "ea1JpnChsDbPeriod":
			return `${cjk(n)}．`
		case "ea1JpnKorPeriod":
			return `${cjk(n)}.`
		case "arabic1Minus":
			return `${alphabetic(n, ARABIC_ALPHA)}-`
		case "arabic2Minus":
			return `${alphabetic(n, ARABIC_ABJAD)}-`
		case "hebrew2Minus":
			return `${hebrew(n)}-`
		case "thaiAlphaPeriod":
			return `${alphabetic(n, THAI_ALPHA)}.`
		case "thaiAlphaParenR":
			return `${alphabetic(n, THAI_ALPHA)})`
		case "thaiAlphaParenBoth":
			return `(${alphabetic(n, THAI_ALPHA)})`
		case "thaiNumPeriod":
			return `${digits(n, 0x0e50)}.`
		case "thaiNumParenR":
			return `${digits(n, 0x0e50)})`
		case "thaiNumParenBoth":
			return `(${digits(n, 0x0e50)})`
		case "hindiAlphaPeriod":
		case "hindiAlpha1Period":
			return `${alphabetic(n, HINDI_ALPHA)}.`
		case "hindiNumPeriod":
			return `${digits(n, 0x0966)}.`
		case "hindiNumParenR":
			return `${digits(n, 0x0966)})`
	}
}

// Counters over the paragraphs of one text body, in order: `next` gives the number of a paragraph.
export class AutonumberCounters {
	// Per level: the next value, or 0 when the level has no run in progress; the scheme and startAt of the run.
	private readonly values = new Int32Array(9)
	private readonly schemes: string[] = new Array<string>(9).fill("")
	private readonly starts = new Int32Array(9)

	// A paragraph at `level` with automatic numbering: its number.
	next(level: number, scheme: string, startAt: number): number {
		const at = clampLevel(level)

		this.endDeeper(at)

		// A different scheme or start at the same level starts a new run (PowerPoint renumbers from startAt).
		if (this.values[at] === 0 || this.schemes[at] !== scheme || this.starts[at] !== startAt) {
			this.values[at] = startAt
			this.schemes[at] = scheme
			this.starts[at] = startAt
		}

		const value = this.values[at] ?? startAt

		this.values[at] = value + 1

		return value
	}

	// A paragraph at `level` without automatic numbering: the runs at its level and deeper end.
	skip(level: number): void {
		const at = clampLevel(level)

		for (let k = at; k < 9; k++) this.values[k] = 0
	}

	private endDeeper(level: number): void {
		for (let k = level + 1; k < 9; k++) this.values[k] = 0
	}
}

function clampLevel(level: number): number {
	return Math.max(0, Math.min(8, Math.trunc(level)))
}

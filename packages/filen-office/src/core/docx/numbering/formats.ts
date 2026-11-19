// Portions derived from SuperDoc 1.46.3 (shared/common/list-numbering), copyright Harbour and the SuperDoc
// contributors, licensed under the GNU Affero General Public License v3.0. Modified for @filen/office.

// Number formats of ST_NumberFormat (ECMA-376 Part 1 §17.18.59). Formats without a dedicated rule fall
// back to decimal, as Word does for formats a locale cannot display; so do the English word and ordinal formats
// (ordinal, cardinalText, ordinalText) in a language other than English, which has no rule here.

const ROMAN: readonly (readonly [number, string])[] = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"]
]

// Beyond these, Word's sequences stop being readable; hostile start values could also build huge strings.
const MAX_ROMAN = 3999
const MAX_REPEATS = 30

function roman(value: number): string {
	if (value < 1 || value > MAX_ROMAN) return String(value)

	let out = ""
	let rest = value

	for (const [amount, numeral] of ROMAN) {
		while (rest >= amount) {
			out += numeral
			rest -= amount
		}
	}

	return out
}

// Word's alphabetic numbering repeats the letter instead of counting in base 26: Z, AA, BB, ..., ZZ, AAA.
function repeatedLetter(value: number, alphabet: readonly string[]): string {
	if (value < 1 || alphabet.length === 0) return ""

	const repeats = Math.floor((value - 1) / alphabet.length) + 1

	return repeats > MAX_REPEATS ? String(value) : (alphabet[(value - 1) % alphabet.length] ?? "").repeat(repeats)
}

// Cycles through a sequence without repeating (kana and Hangul sequences wrap around).
function cycled(value: number, sequence: readonly string[]): string {
	if (value < 1 || sequence.length === 0) return String(value)

	return sequence[(value - 1) % sequence.length] ?? ""
}

function chars(text: string): readonly string[] {
	return Array.from(text)
}

const LATIN = chars("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
const RUSSIAN = chars("абвгдежзиклмнопрстуфхцчшщэюя")
const HEBREW_LETTERS = chars("אבגדהוזחטיכלמנסעפצקרשת")
const ARABIC_ALPHA = chars("أبتثجحخدذرزسشصضطظعغفقكلمنهوي")
const ARABIC_ABJAD = chars("أبجدهوزحطيكلمنسعفصقرشتثخذضظغ")
const AIUEO_FULL = chars("アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン")
const AIUEO_HALF = chars("ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ")
const IROHA_FULL = chars("イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセスン")
const IROHA_HALF = chars("ｲﾛﾊﾆﾎﾍﾄﾁﾘﾇﾙｦﾜｶﾖﾀﾚｿﾂﾈﾅﾗﾑｳヰﾉｵｸﾔﾏｹﾌｺｴﾃｱｻｷﾕﾒﾐｼヱﾋﾓｾｽﾝ")
const GANADA = chars("가나다라마바사아자차카타파하")
const CHOSUNG = chars("ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ")
const CHICAGO = ["*", "†", "‡", "§"]

function digits(value: number, zero: number): string {
	let out = ""

	for (const digit of String(value)) {
		const code = digit.charCodeAt(0)

		out += code >= 48 && code <= 57 ? String.fromCodePoint(zero + code - 48) : digit
	}

	return out
}

function mappedDigits(value: number, table: readonly string[]): string {
	let out = ""

	for (const digit of String(value)) {
		const code = digit.charCodeAt(0)

		out += code >= 48 && code <= 57 ? (table[code - 48] ?? digit) : digit
	}

	return out
}

const IDEOGRAPH_DIGITS = chars("〇一二三四五六七八九")
const KOREAN_DIGITS = chars("영일이삼사오육칠팔구")

// Positional counting with unit characters (十 百 千, and 万 above 9999).
function counting(value: number, numerals: readonly string[], units: readonly string[], myriad: string, omitLeadingOne: boolean): string {
	if (value === 0) return numerals[0] ?? "0"
	if (value < 0) return String(value)

	const belowMyriad = (n: number): string => {
		let out = ""
		let zeroPending = false

		for (let place = 3; place >= 0; place--) {
			const digit = Math.floor(n / 10 ** place) % 10

			if (digit === 0) {
				if (out !== "") zeroPending = true

				continue
			}

			if (zeroPending) {
				out += numerals[0] ?? ""
				zeroPending = false
			}

			if (!(digit === 1 && place > 0 && omitLeadingOne)) out += numerals[digit] ?? ""

			out += units[place] ?? ""
		}

		return out
	}

	if (value < 10000) return belowMyriad(value)

	const high = Math.floor(value / 10000)
	const low = value % 10000

	return (
		(high < 10000 ? belowMyriad(high) : String(high)) +
		myriad +
		(low === 0 ? "" : (low < 1000 ? (numerals[0] ?? "") : "") + belowMyriad(low))
	)
}

const CJK_UNITS = ["", "十", "百", "千"]
const KOREAN_UNITS = ["", "십", "백", "천"]

// Hebrew numerals (gematria) for 1..999, with 15 and 16 written as 9+6 and 9+7; decimal beyond.
const HEBREW_HUNDREDS = ["", "ק", "ר", "ש", "ת", "תק", "תר", "תש", "תת", "תתק"]
const HEBREW_TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"]
const HEBREW_UNITS = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"]

function hebrewNumeral(value: number): string {
	if (value < 1 || value > 999) return String(value)

	let out = ""
	let rest = value

	out += HEBREW_HUNDREDS[Math.floor(rest / 100)] ?? ""
	rest %= 100

	if (rest === 15) return `${out}טו`
	if (rest === 16) return `${out}טז`

	return out + (HEBREW_TENS[Math.floor(rest / 10)] ?? "") + (HEBREW_UNITS[rest % 10] ?? "")
}

const ONES = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen"
]
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
const SCALES: readonly (readonly [number, string])[] = [
	[1_000_000_000, "billion"],
	[1_000_000, "million"],
	[1000, "thousand"],
	[100, "hundred"]
]

export function englishCardinal(value: number): string {
	if (value < 0) return `minus ${englishCardinal(-value)}`
	if (value < 20) return ONES[value] ?? String(value)

	if (value < 100) {
		const unit = value % 10

		return (TENS[Math.floor(value / 10)] ?? "") + (unit === 0 ? "" : `-${ONES[unit] ?? ""}`)
	}

	for (const [scale, word] of SCALES) {
		if (value >= scale) {
			const rest = value % scale
			const head = `${englishCardinal(Math.floor(value / scale))} ${word}`

			return rest === 0 ? head : `${head} ${englishCardinal(rest)}`
		}
	}

	return String(value)
}

const ORDINAL_WORDS: Readonly<Record<string, string>> = {
	one: "first",
	two: "second",
	three: "third",
	five: "fifth",
	eight: "eighth",
	nine: "ninth",
	twelve: "twelfth"
}

export function englishOrdinal(value: number): string {
	const cardinal = englishCardinal(value)
	const match = /([a-z]+)$/.exec(cardinal)
	const last = match?.[1] ?? ""
	const head = cardinal.slice(0, cardinal.length - last.length)
	const special = ORDINAL_WORDS[last]

	if (special !== undefined) return head + special
	if (last.endsWith("y")) return `${head}${last.slice(0, -1)}ieth`

	return `${head}${last}th`
}

function capitalize(text: string): string {
	return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1)
}

function ordinalSuffix(value: number): string {
	const lastTwo = Math.abs(value) % 100
	const last = lastTwo % 10

	if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`
	if (last === 1) return `${value}st`
	if (last === 2) return `${value}nd`
	if (last === 3) return `${value}rd`

	return `${value}th`
}

function enclosed(value: number, ranges: readonly (readonly [number, number, number])[]): string {
	for (const [first, last, codePoint] of ranges) {
		if (value >= first && value <= last) return String.fromCodePoint(codePoint + value - first)
	}

	return String(value)
}

// w:numFmt w:val="custom" w:format="001, 002, 003, ...": zero padding is the form documents use.
function custom(value: number, format: string | undefined): string {
	const first = format?.split(",")[0]?.trim()

	if (first !== undefined && /^0+[0-9]$/.test(first)) return String(value).padStart(first.length, "0")

	return String(value)
}

// Whether a w:lang value is English; text without one is.
export function englishLanguage(language: string | undefined): boolean {
	return language === undefined || /^en(?:-|$)/i.test(language)
}

// `language`: the w:lang the number is written in (English without one).
export function formatNumber(value: number, format: string, customFormat?: string, language?: string): string {
	switch (format) {
		case "decimal":
		case "decimalHalfWidth":
			return String(value)
		case "decimalZero":
			return value >= 0 && value < 10 ? `0${value}` : String(value)
		case "upperRoman":
			return roman(value)
		case "lowerRoman":
			return roman(value).toLowerCase()
		case "upperLetter":
			return repeatedLetter(value, LATIN)
		case "lowerLetter":
			return repeatedLetter(value, LATIN).toLowerCase()
		case "ordinal":
			return englishLanguage(language) ? ordinalSuffix(value) : String(value)
		case "cardinalText":
			return englishLanguage(language) ? capitalize(englishCardinal(value)) : String(value)
		case "ordinalText":
			return englishLanguage(language) ? capitalize(englishOrdinal(value)) : String(value)
		case "hex":
			return value.toString(16).toUpperCase()
		case "chicago":
			return repeatedLetter(value, CHICAGO)
		case "numberInDash":
			return `- ${value} -`
		case "decimalEnclosedCircle":
		case "decimalEnclosedCircleChinese":
			return enclosed(value, [
				[1, 20, 0x2460],
				[21, 35, 0x3251],
				[36, 50, 0x32b1]
			])
		case "decimalEnclosedFullstop":
			return enclosed(value, [[1, 20, 0x2488]])
		case "decimalEnclosedParen":
			return enclosed(value, [[1, 20, 0x2474]])
		case "decimalFullWidth":
		case "decimalFullWidth2":
			return digits(value, 0xff10)
		case "ideographDigital":
		case "japaneseDigitalTenThousand":
			return mappedDigits(value, IDEOGRAPH_DIGITS)
		case "japaneseCounting":
		case "chineseCounting":
		case "taiwaneseCounting":
			return counting(value, IDEOGRAPH_DIGITS, CJK_UNITS, "万", true)
		case "chineseCountingThousand":
		case "taiwaneseCountingThousand":
			return counting(value, IDEOGRAPH_DIGITS, CJK_UNITS, "万", false)
		case "koreanDigital":
		case "koreanDigital2":
			return mappedDigits(value, KOREAN_DIGITS)
		case "koreanCounting":
			return counting(value, KOREAN_DIGITS, KOREAN_UNITS, "만", true)
		case "ganada":
			return cycled(value, GANADA)
		case "chosung":
			return cycled(value, CHOSUNG)
		case "aiueo":
			return cycled(value, AIUEO_HALF)
		case "aiueoFullWidth":
			return cycled(value, AIUEO_FULL)
		case "iroha":
			return cycled(value, IROHA_HALF)
		case "irohaFullWidth":
			return cycled(value, IROHA_FULL)
		case "hebrew1":
			return hebrewNumeral(value)
		case "hebrew2":
			return repeatedLetter(value, HEBREW_LETTERS)
		case "arabicAlpha":
			return repeatedLetter(value, ARABIC_ALPHA)
		case "arabicAbjad":
			return repeatedLetter(value, ARABIC_ABJAD)
		case "hindiNumbers":
			return digits(value, 0x0966)
		case "thaiNumbers":
			return digits(value, 0x0e50)
		case "russianLower":
			return repeatedLetter(value, RUSSIAN)
		case "russianUpper":
			return repeatedLetter(value, RUSSIAN).toUpperCase()
		case "custom":
			return custom(value, customFormat)
		case "none":
		case "bullet":
			return ""
		default:
			return String(value)
	}
}

import type { SheetLocale } from "../protocol"
import { TERRITORY_CURRENCIES } from "./currencies.generated"

// Entries as typed in the user's locale, and the file's own syntax shown back in it. Files always store en-US syntax
// and English function names (ECMA-376 Part 1 §18.17: the formula grammar's "," between arguments, "." in numbers);
// the app injects the locale (the core reads no Intl). A locale with "." and "," and "," between arguments is en-US's
// and changes nothing.
//
// In a formula typed with ";" between arguments, an array constant separates its columns with "\" and its rows with
// ";" (as Excel does where "," is the decimal point); with "," between arguments, as en-US: "," and ";".

const QUOTE = 34
const APOSTROPHE = 39
const BRACKET_OPEN = 91
const BRACKET_CLOSE = 93

export const EN_US_LOCALE: SheetLocale = { decimal: ".", group: ",", argument: ",", dateOrder: "mdy" }

// Whether the locale types formulas and numbers as en-US does.
export function plainLocale(locale: SheetLocale | undefined): boolean {
	return locale === undefined || (locale.decimal === "." && locale.argument === ",")
}

// The end of a quoted run (string or sheet name) starting at `start`, its doubled quotes inside.
function quotedEnd(text: string, start: number, quote: number): number {
	let index = start + 1

	while (index < text.length) {
		if (text.charCodeAt(index) === quote) {
			if (text.charCodeAt(index + 1) === quote) {
				index += 2
				continue
			}

			return index + 1
		}

		index++
	}

	return text.length
}

function bracketEnd(text: string, start: number): number {
	let depth = 0

	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index)

		if (code === BRACKET_OPEN) depth++
		else if (code === BRACKET_CLOSE && --depth === 0) return index + 1
	}

	return text.length
}

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57
}

function isWordChar(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36 || code > 127
}

// Rewrites a formula's separators outside strings, quoted sheet names and structured references: `argument` for the
// argument separator, `decimal` for a decimal point between digits (in a number, not a name such as LOG10.2 or a
// sheet's Q1.2024), and in array constants `column` and `row`.
function mapSeparators(
	formula: string,
	from: { argument: string; decimal: string; column: string; row: string },
	to: { argument: string; decimal: string; column: string; row: string }
): string {
	let out = ""
	let braces = 0
	let index = 0

	while (index < formula.length) {
		const code = formula.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			const end = quotedEnd(formula, index, code)

			out += formula.slice(index, end)
			index = end

			continue
		}

		if (code === BRACKET_OPEN) {
			const end = bracketEnd(formula, index)

			out += formula.slice(index, end)
			index = end

			continue
		}

		// A run of word characters (a name, a cell, a function): copied whole, so a point in it is never a decimal.
		if (isWordChar(code)) {
			let end = index + 1

			while (
				end < formula.length &&
				(isWordChar(formula.charCodeAt(end)) || isDigit(formula.charCodeAt(end)) || formula[end] === ".")
			)
				end++

			out += formula.slice(index, end)
			index = end

			continue
		}

		const char = formula[index] ?? ""

		if (code === 123) braces++
		else if (code === 125) braces = Math.max(0, braces - 1)

		if (
			char === from.decimal &&
			isDigit(formula.charCodeAt(index + 1)) &&
			(index === 0 || !isWordChar(formula.charCodeAt(index - 1)))
		) {
			// A decimal point: a number's digits on its right, its own digits (or nothing) on its left.
			out += to.decimal
		} else if (braces > 0 && char === from.column) out += to.column
		else if (braces > 0 && char === from.row) out += to.row
		else if (braces === 0 && char === from.argument) out += to.argument
		else out += char

		index++
	}

	return out
}

function separators(locale: SheetLocale): { argument: string; decimal: string; column: string; row: string } {
	return locale.argument === ";"
		? { argument: ";", decimal: locale.decimal, column: "\\", row: ";" }
		: { argument: locale.argument, decimal: locale.decimal, column: ",", row: ";" }
}

const EN_US_SEPARATORS = { argument: ",", decimal: ".", column: ",", row: ";" }

// A formula as typed in the locale (without its "="), in the file's syntax.
export function delocalizeFormula(formula: string, locale: SheetLocale | undefined): string {
	if (locale === undefined || plainLocale(locale)) return formula

	return mapSeparators(formula, separators(locale), EN_US_SEPARATORS)
}

// A formula in the file's syntax (without its "="), as the locale types it.
export function localizeFormula(formula: string, locale: SheetLocale | undefined): string {
	if (locale === undefined || plainLocale(locale)) return formula

	return mapSeparators(formula, EN_US_SEPARATORS, separators(locale))
}

function escaped(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const ARABIC_DECIMAL = "\u066b"

// The locale's decimal point as a pattern: where it is U+066B (Intl's ar-EG, ar-SA, fa-IR, ps-AF), "." too, as a
// keyboard there types it and LibreOffice 7.5 reads it in ar-EG and fa-IR.
function decimalPattern(decimal: string): string {
	return decimal === ARABIC_DECIMAL ? "[.\u066b]" : escaped(decimal)
}

// Digits with the locale's decimal point as JavaScript reads them.
function withPoint(text: string, decimal: string): string {
	return decimal === ARABIC_DECIMAL ? text.replace(ARABIC_DECIMAL, ".") : decimal === "." ? text : text.replace(decimal, ".")
}

interface NumberReader {
	readonly plain: RegExp
	readonly grouped: RegExp
	readonly percent: RegExp
	readonly point: RegExp
	readonly decimal: string
	readonly group: string
}

const readers = new Map<string, NumberReader>()

function numberReader(locale: SheetLocale): NumberReader {
	const key = `${locale.decimal}\u0000${locale.group}`
	let reader = readers.get(key)

	if (reader === undefined) {
		const point = decimalPattern(locale.decimal)
		// A space group separator (fr-FR's narrow no-break space too) also accepts a plain space as typed.
		const group = /\s/u.test(locale.group) ? "[\\s\\u00a0\\u202f]" : escaped(locale.group)

		reader = {
			plain: new RegExp(`^[-+]?(\\d+${point}?\\d*|${point}\\d+)(e[-+]?\\d+)?$`, "i"),
			grouped: new RegExp(`^[-+]?\\d{1,3}(${group}\\d{3})+(${point}\\d+)?$`),
			percent: new RegExp(`^[-+]?(\\d+${point}?\\d*|${point}\\d+)%$`),
			point: new RegExp(point),
			decimal: locale.decimal,
			group: locale.group
		}
		readers.set(key, reader)
	}

	return reader
}

// A number as typed in the locale: its value, and the format a grouped or percent entry implies. Null when it reads
// as no number.
export function localizedNumber(text: string, locale: SheetLocale): { value: number; impliedFormat?: string } | null {
	const reader = numberReader(locale)
	const canonical = (digits: string): number =>
		Number(
			withPoint(
				digits
					.replace(/[\s\u00a0\u202f]/gu, "")
					.split(reader.group)
					.join(""),
				reader.decimal
			)
		)

	if (reader.plain.test(text)) return { value: Number(withPoint(text, reader.decimal)) }

	if (reader.grouped.test(text)) {
		return { value: canonical(text), impliedFormat: reader.point.test(text) ? "#,##0.00" : "#,##0" }
	}

	if (reader.percent.test(text)) {
		return {
			value: Number(withPoint(text.slice(0, -1), reader.decimal)) / 100,
			impliedFormat: reader.point.test(text) ? "0.00%" : "0%"
		}
	}

	return null
}

interface TextNumberReader {
	readonly number: RegExp
	readonly grouped: RegExp
	readonly decimal: string
	readonly decimalCode: number
	readonly group: RegExp
	// Longest first, so "US$" is read before "$".
	readonly currencies: readonly string[]
	readonly currencyCodes: readonly number[]
}

const textReaders = new Map<string, TextNumberReader>()

const SPACE = 32
const PLUS = 43
const MINUS = 45
const PAREN = 40
const POINT = 46

function isSpace(code: number): boolean {
	return code === SPACE || code === 0xa0 || code === 0x202f || (code >= 9 && code <= 13)
}

function textNumberReader(locale: SheetLocale): TextNumberReader {
	const currencies = (locale.currencies ?? (locale.decimal === "." ? ["$"] : []))
		.filter(symbol => symbol !== "")
		.sort((a, z) => z.length - a.length)
	const key = `${locale.decimal}\u0000${locale.group}\u0000${currencies.join("\u0000")}`
	let reader = textReaders.get(key)

	if (reader === undefined) {
		const point = decimalPattern(locale.decimal)
		const group = /\s/u.test(locale.group) ? "[\\s\\u00a0\\u202f]" : escaped(locale.group)

		reader = {
			number: new RegExp(`^(\\d+(${point}\\d*)?|${point}\\d+)(e[-+]?\\d+)?$`, "i"),
			grouped: new RegExp(`^\\d{1,3}(${group}\\d{3})+(${point}\\d*)?$`),
			decimal: locale.decimal,
			decimalCode: locale.decimal.charCodeAt(0),
			group: new RegExp(group, "g"),
			currencies,
			currencyCodes: currencies.map(symbol => symbol.charCodeAt(0))
		}
		textReaders.set(key, reader)
	}

	return reader
}

// The digits of a number as the locale writes them (no sign): plain, with an exponent, grouped, or a whole number
// and a fraction ("1 1/2"). Undefined for anything else.
function unsignedNumber(text: string, reader: TextNumberReader): number | undefined {
	if (reader.number.test(text)) return Number(withPoint(text, reader.decimal))
	if (reader.grouped.test(text)) return Number(withPoint(text.replace(reader.group, ""), reader.decimal))

	const space = text.indexOf(" ")
	const slash = text.indexOf("/")

	if (space > 0 && slash > space) {
		const whole = text.slice(0, space)
		const numerator = text.slice(space + 1, slash)
		const denominator = text.slice(slash + 1)

		if (DIGITS.test(whole) && DIGITS.test(numerator) && DIGITS.test(denominator) && Number(denominator) !== 0) {
			return Number(whole) + Number(numerator) / Number(denominator)
		}
	}

	return undefined
}

const DIGITS = /^\d+$/

// A number given as text where a formula takes a number ("1,000"*1, ABS("$4.00")), read as Excel reads text "that
// looks like an accepted number format" (support.microsoft.com "Calculation operators and precedence in Excel":
// ="1"+"2" is 3, =1+"$4.00" is 5) in the locale: its decimal point and grouping, a sign before or after (5- is -5),
// one of the locale's currency symbols before or after the number, with the sign on either side of it, a percent sign after,
// parentheses around a negative number, an exponent and a whole number with a fraction; surrounding spaces are
// ignored. Where the page is silent, as LibreOffice 7.5 reads text in en-US and de-DE. Dates and times are read
// apart (formula/textDates.ts). Undefined when the text reads as no number, most of it at its first character.
export function textNumber(text: string, locale: SheetLocale): number | undefined {
	return readTextNumber(text, textNumberReader(locale))
}

// textNumber for one locale, its reader resolved once (the engine reads every text operand through it).
export function textNumberParser(locale: SheetLocale): (text: string) => number | undefined {
	const reader = textNumberReader(locale)

	return text => readTextNumber(text, reader)
}

function readTextNumber(text: string, reader: TextNumberReader): number | undefined {
	let start = 0
	let end = text.length

	while (start < end && isSpace(text.charCodeAt(start))) start++
	while (end > start && isSpace(text.charCodeAt(end - 1))) end--

	if (start === end) return undefined

	const first = text.charCodeAt(start)
	let whole = true

	for (let index = start; whole && index < end; index++) whole = isDigit(text.charCodeAt(index))

	if (whole) {
		const value = Number(start === 0 && end === text.length ? text : text.slice(start, end))

		// Digits past what a number holds are no number: #VALUE!, not an overflow.
		return Number.isFinite(value) ? value : undefined
	}

	if (
		!isDigit(first) &&
		first !== PLUS &&
		first !== MINUS &&
		first !== PAREN &&
		first !== reader.decimalCode &&
		!(first === POINT && reader.decimal === ARABIC_DECIMAL) &&
		!reader.currencyCodes.includes(first)
	) {
		return undefined
	}

	let body = text.slice(start, end)
	let negative = false
	let signed = false

	// (1,000) and ($5): a negative number, with no sign or percent inside.
	const parenthesised = first === PAREN

	if (parenthesised) {
		if (body.charCodeAt(body.length - 1) !== 41) return undefined

		body = body.slice(1, -1).trim()
		negative = true
		signed = true
	}

	const sign = (): boolean => {
		const code = body.charCodeAt(0)

		if (code !== PLUS && code !== MINUS) return true
		if (signed) return false

		signed = true
		negative = code === MINUS
		body = body.slice(1)

		return true
	}

	if (!sign()) return undefined

	let currency = false
	const leading = reader.currencies.find(symbol => body.startsWith(symbol))

	if (leading !== undefined) {
		currency = true
		body = body.slice(leading.length).trimStart()

		if (!sign()) return undefined
	}

	if (!parenthesised && body.charCodeAt(body.length - 1) === MINUS) {
		if (signed) return undefined

		signed = true
		negative = true
		body = body.slice(0, -1).trimEnd()
	}

	let percent = false

	const trailing = currency ? undefined : reader.currencies.find(symbol => body.endsWith(symbol))

	if (trailing !== undefined) {
		currency = true
		body = body.slice(0, -trailing.length).trimEnd()
	} else if (!parenthesised && !currency && body.endsWith("%")) {
		percent = true
		body = body.slice(0, -1).trimEnd()
	}

	const value = unsignedNumber(body, reader)

	if (value === undefined) return undefined

	if (!Number.isFinite(value)) return undefined

	const scaled = percent ? value / 100 : value

	return negative ? -scaled : scaled
}

const SCIENTIFIC = "0.00E+00"

function hasExponent(text: string): boolean {
	return text.includes("e") || text.includes("E")
}

// A number typed into a cell, as Excel reads one there, and the format it implies for a cell that has none: the
// locale's plain, grouped and percent numbers (localizedNumber), an exponent (0.00E+00), one of the locale's currency
// symbols before or after the number ($#,##0.00), parentheses around a negative number, a percent sign after a grouped
// number (#,##0%), and a whole number with a fraction of a one- or two-digit denominator (1 1/2: # ?/?). A sign after
// the number (5-) leaves it text, as Excel's entry does. Null when it reads as no number.
export function entryNumber(text: string, locale: SheetLocale): { value: number; impliedFormat?: string } | null {
	const simple = localizedNumber(text, locale)

	if (simple !== null) {
		return simple.impliedFormat === undefined && hasExponent(text) ? { value: simple.value, impliedFormat: SCIENTIFIC } : simple
	}

	const reader = textNumberReader(locale)
	const first = text.charCodeAt(0)

	if (
		!isDigit(first) &&
		first !== PLUS &&
		first !== MINUS &&
		first !== PAREN &&
		first !== reader.decimalCode &&
		!(first === POINT && reader.decimal === ARABIC_DECIMAL) &&
		!reader.currencyCodes.includes(first)
	) {
		return null
	}

	let body = text
	let negative = false
	let signed = false
	const parenthesised = first === PAREN

	if (parenthesised) {
		if (body.charCodeAt(body.length - 1) !== 41) return null

		body = body.slice(1, -1).trim()
		negative = true
		signed = true
	}

	const sign = (): boolean => {
		const code = body.charCodeAt(0)

		if (code !== PLUS && code !== MINUS) return true
		if (signed) return false

		signed = true
		negative = code === MINUS
		body = body.slice(1)

		return true
	}

	if (!sign()) return null

	let symbol = ""
	let leading = false
	let spaced = false
	const before = reader.currencies.find(currency => body.startsWith(currency))

	if (before !== undefined) {
		const rest = body.slice(before.length)

		body = rest.trimStart()
		symbol = before
		leading = true
		spaced = body.length !== rest.length

		if (!sign()) return null
	} else {
		const after = reader.currencies.find(currency => body.endsWith(currency))

		if (after !== undefined) {
			const rest = body.slice(0, -after.length)

			body = rest.trimEnd()
			symbol = after
			spaced = body.length !== rest.length
		}
	}

	let percent = false

	if (!parenthesised && symbol === "" && body.endsWith("%")) {
		percent = true
		body = body.slice(0, -1).trimEnd()
	}

	const magnitude = unsignedNumber(body, reader)

	if (magnitude === undefined || !Number.isFinite(magnitude)) return null

	const grouped = reader.grouped.test(body)
	const fraction = !grouped && !reader.number.test(body)
	const scaled = percent ? magnitude / 100 : magnitude
	const value = negative ? -scaled : scaled
	const decimals = body.includes(reader.decimal) || (reader.decimal === ARABIC_DECIMAL && body.includes(".")) ? ".00" : ""

	if (fraction) {
		const width = body.length - body.indexOf("/") - 1

		return symbol !== "" || percent || width > 2 ? null : { value, impliedFormat: width === 1 ? "# ?/?" : "# ??/??" }
	}

	if (symbol !== "") {
		const literal = symbol === "$" ? "$" : `"${symbol}"`
		const space = spaced ? "\\ " : ""
		const number = `#,##0${decimals}`

		return { value, impliedFormat: leading ? `${literal}${space}${number}` : `${number}${space}${literal}` }
	}

	if (percent) return { value, impliedFormat: `${grouped ? "#,##0" : "0"}${decimals}%` }
	if (hasExponent(body)) return { value, impliedFormat: SCIENTIFIC }
	if (grouped) return { value, impliedFormat: `#,##0${decimals}` }

	return { value }
}

const DATE = /^(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})$/
// Two numbers without a year: "/" or "-" between them ("1.5" stays a number's, or no date, in every locale).
const DAY_MONTH = /^(\d{1,4})[/-](\d{1,4})$/
// d-mmm, d mmm yyyy, 5/Jan/24: the day before a month name, the year after it optional.
const NAMED_DAY_FIRST = /^(\d{1,2})[-/ ]([a-z]+)\.?(?:[-/ ](\d{1,4}))?$/i
// Jan-24, January 5, 2024, Jan 5 2024, Jan-2024: the month name first.
const NAMED_MONTH_FIRST = /^([a-z]+)\.?[-/ ](\d{1,4})(?:(?:, ?|[-/ ])(\d{1,4}))?$/i

const MONTH_NAMES = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december"
]

export interface LocalizedDate {
	readonly year: number
	readonly month: number
	readonly day: number
}

// A month's English name, in full or its first three letters ("Sept" too), any case; 0 for none.
function monthNamed(word: string): number {
	const lower = word.toLowerCase()

	if (lower.length < 3) return 0
	if (lower === "sept") return 9

	for (let index = 0; index < MONTH_NAMES.length; index++) {
		const name = MONTH_NAMES[index] ?? ""

		if (lower === name || lower === name.slice(0, 3)) return index + 1
	}

	return 0
}

// A two- or four-digit year as Excel reads it: a two-digit one is 1930-2029 (support.microsoft.com "How Excel
// works with two-digit year numbers"). NaN for any other length.
function yearOf(text: string): number {
	if (text.length === 4) return Number(text)
	if (text.length !== 2) return Number.NaN

	const short = Number(text)

	return short < 30 ? 2000 + short : 1900 + short
}

// Whether a day of a month exists from 1900 on; `leap1900` takes 1900-02-29, the day the 1900 date system counts
// (serial 60).
function validDate(year: number, month: number, day: number, leap1900: boolean): boolean {
	if (!(year >= 1900 && year <= 9999) || month < 1 || month > 12 || day < 1) return false
	if (leap1900 && year === 1900 && month === 2) return day <= 29

	return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function numericDate(text: string, locale: SheetLocale, leap1900: boolean): LocalizedDate | null {
	const match = DATE.exec(text)

	if (match === null) return null

	const [, first = "", separator = "", second = "", third = ""] = match
	const order = first.length === 4 ? "ymd" : locale.dateOrder

	// A "." separator with "." as the decimal point is a number's, not a date's.
	if (separator === "." && locale.decimal === ".") return null

	const parts = order === "ymd" ? [first, second, third] : order === "dmy" ? [third, second, first] : [third, first, second]
	const [yearText = "", monthText = "", dayText = ""] = parts

	if (order !== "ymd" && first.length > 2) return null

	const year = yearOf(yearText)
	const month = Number(monthText)
	const day = Number(dayText)

	return validDate(year, month, day, leap1900) ? { year, month, day } : null
}

// A date as typed in the locale's order (day, month and year separated by "/", "-" or "."; a two-digit year is
// 1930-2029, as Excel reads one). ISO dates (yyyy-mm-dd) read in every locale. Null for anything else.
export function localizedDate(text: string, locale: SheetLocale): LocalizedDate | null {
	return numericDate(text, locale, false)
}

// A month and a number after or before it: the day of `year` when it is one (two digits at most), else the month's
// first day of the year it reads as. Excel reads Jan-24 as 24 January this year and Jan-32 as January 1932.
function dayOrYear(month: number, text: string, year: number, leap1900: boolean): LocalizedDate | null {
	const day = Number(text)

	if (text.length <= 2 && validDate(year, month, day, leap1900)) return { year, month, day }

	const read = yearOf(text)

	return validDate(read, month, 1, leap1900) ? { year: read, month, day: 1 } : null
}

// A date as text in a formula reads (DATEVALUE, "5-Jan-2024"+0), as Excel reads one by the system's settings
// (support.microsoft.com "DATEVALUE function": "22-MAY-2011", "5-JUL" in the clock's year): the locale's numeric
// order with a year, or without one (m/d, or d/m where the day comes first) in `currentYear`, a month and year (1/2024),
// and an English month name with the day before or after it (d-mmm-yy, d mmm yyyy, mmmm d, yyyy, mmm-yy, d-mmm).
// `leap1900` reads 1900-02-29, as the 1900 date system does. Null for anything else.
export function formulaTextDate(text: string, locale: SheetLocale, currentYear: () => number, leap1900: boolean): LocalizedDate | null {
	const first = text.charCodeAt(0)

	if (isDigit(first)) {
		const full = numericDate(text, locale, leap1900)

		if (full !== null) return full

		const pair = DAY_MONTH.exec(text)

		if (pair !== null) {
			const [, head = "", tail = ""] = pair

			// yyyy-m: the month's first day.
			if (head.length === 4) return dayOrYear(Number(tail), head, 0, leap1900)
			if (head.length > 2) return null

			if (locale.dateOrder !== "dmy") return dayOrYear(Number(head), tail, currentYear(), leap1900)

			// d/m in the clock's year, else m/yy.
			const year = currentYear()

			if (tail.length <= 2 && validDate(year, Number(tail), Number(head), leap1900)) {
				return { year, month: Number(tail), day: Number(head) }
			}

			const read = yearOf(tail)

			return validDate(read, Number(head), 1, leap1900) ? { year: read, month: Number(head), day: 1 } : null
		}

		const named = NAMED_DAY_FIRST.exec(text)

		if (named === null) return null

		const [, dayText = "", name = "", yearText] = named
		const month = monthNamed(name)
		const year = yearText === undefined ? currentYear() : yearOf(yearText)
		const day = Number(dayText)

		return month > 0 && validDate(year, month, day, leap1900) ? { year, month, day } : null
	}

	const named = NAMED_MONTH_FIRST.exec(text)

	if (named === null) return null

	const [, name = "", second = "", third] = named
	const month = monthNamed(name)

	if (month === 0) return null
	if (third === undefined) return dayOrYear(month, second, currentYear(), leap1900)

	const year = yearOf(third)
	const day = Number(second)

	return second.length <= 2 && validDate(year, month, day, leap1900) ? { year, month, day } : null
}

// The format a date typed in the locale implies: Excel's short date for the locale. Where the session shows built-in
// 14 in the locale's short date (SheetLocale.numFmt), that id; else its order with four-digit years as a code of its
// own.
export function localizedDateFormat(locale: SheetLocale): string {
	return locale.numFmt === undefined ? orderedDateFormat(locale) : "m/d/yyyy"
}

// The locale's order with four-digit years, as a code.
export function orderedDateFormat(locale: SheetLocale): string {
	switch (locale.dateOrder) {
		case "dmy":
			return "dd/mm/yyyy"
		case "ymd":
			return "yyyy-mm-dd"
		default:
			return "m/d/yyyy"
	}
}

// A cell's input (as the session shows it to edit, in the file's syntax) as the locale types it: a formula's
// separators, a plain number's decimal point. Text and anything else as it is.
export function localizedInput(input: string, locale: SheetLocale | undefined): string {
	if (locale === undefined || plainLocale(locale)) return input
	if (input.startsWith("=")) return `=${localizeFormula(input.slice(1), locale)}`
	if (/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(input)) return input.replace(".", locale.decimal)

	return input
}

// A territory's current currency (ISO 3166-1 alpha-2 → ISO 4217, Unicode CLDR: currencies.generated.ts), for the
// app to name the locale's currency symbols. Undefined for a territory without one.
export function territoryCurrency(territory: string): string | undefined {
	if (territory.length !== 2) return undefined

	const key = territory.toUpperCase()
	let low = 0
	let high = TERRITORY_CURRENCIES.length / 5 - 1

	while (low <= high) {
		const middle = (low + high) >> 1
		const at = TERRITORY_CURRENCIES.slice(middle * 5, middle * 5 + 2)

		if (at === key) return TERRITORY_CURRENCIES.slice(middle * 5 + 2, middle * 5 + 5)
		if (at < key) low = middle + 1
		else high = middle - 1
	}

	return undefined
}

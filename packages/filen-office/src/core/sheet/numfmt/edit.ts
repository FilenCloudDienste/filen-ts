import { numFmt } from "./format"
import { SectionKind, Tok, type NumFmt, type NumFmtSection } from "./parse"

// What the toolbar and the Format Cells dialog do with number format codes: name a code's category, offer Excel's
// Home tab formats, and add or take away a decimal place (Increase and Decrease Decimal). Codes are en-US syntax,
// as files hold them (MS-OI29500 §2.1.712 b).

export type NumFmtCategory =
	"general" | "number" | "currency" | "accounting" | "date" | "time" | "percentage" | "fraction" | "scientific" | "text" | "custom"

// The Number Format list of Excel's Home tab (en-US), in its order; built-in codes where Excel uses them (ECMA-376
// Part 1 §18.8.30: 14 short date, 44 accounting; MS-OI29500 §2.1.712 a).
export const NUMBER_FORMAT_PRESETS: readonly { readonly category: Exclude<NumFmtCategory, "custom">; readonly code: string }[] = [
	{ category: "general", code: "General" },
	{ category: "number", code: "0.00" },
	{ category: "currency", code: '"$"#,##0.00' },
	{ category: "accounting", code: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)' },
	{ category: "date", code: "m/d/yyyy" },
	{ category: "date", code: "[$-F800]dddd, mmmm dd, yyyy" },
	{ category: "time", code: "[$-F400]h:mm:ss AM/PM" },
	{ category: "percentage", code: "0.00%" },
	{ category: "fraction", code: "# ?/?" },
	{ category: "scientific", code: "0.00E+00" },
	{ category: "text", code: "@" }
]

// The Comma Style button's code: accounting without the currency symbol (built-in 43).
export const COMMA_STYLE = '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'
// The Percent Style button's: no decimals (built-in 9).
export const PERCENT_STYLE = "0%"

function hasToken(section: NumFmtSection, kind: number): boolean {
	return section.tokens.some(token => token.kind === kind)
}

function hasCurrency(code: string, section: NumFmtSection): boolean {
	return /\[\$[^-\]]/u.test(code) || section.tokens.some(token => token.kind === Tok.LITERAL && /[$€£¥₹₩₽¤]/u.test(token.text))
}

function showsDay(section: NumFmtSection): boolean {
	return hasToken(section, Tok.YEAR) || hasToken(section, Tok.MONTH) || hasToken(section, Tok.DAY)
}

// A date format showing no year, month or day: the Time category.
export function isTimeFormat(format: NumFmt): boolean {
	const first = format.sections[0]

	return format.isDate && first !== undefined && !showsDay(first)
}

// The category a code falls in, as the Format Cells dialog lists it; "custom" when none fits.
export function numFmtCategory(code: string): NumFmtCategory {
	if (code.trim().toLowerCase() === "general") return "general"

	const format = numFmt(code)
	const first = format.sections[0]

	if (format.isText) return "text"
	if (first === undefined) return "custom"

	switch (first.kind) {
		case SectionKind.GENERAL:
			return "general"
		case SectionKind.TEXT:
			return "text"
		case SectionKind.SCIENTIFIC:
			return "scientific"
		case SectionKind.FRACTION:
			return "fraction"
		case SectionKind.DATE:
			return showsDay(first) ? "date" : "time"
		case SectionKind.NUMBER:
			if (first.percent > 0) return "percentage"
			if (hasToken(first, Tok.REPEAT)) return "accounting"
			if (hasCurrency(code, first)) return "currency"

			return "number"
		default:
			return "custom"
	}
}

// --- Decimal places ---

interface Span {
	readonly start: number
	readonly end: number
}

// The parts of a code a decimal edit may touch: unquoted, unescaped and outside brackets, per section.
function sections(code: string): Span[] {
	const spans: Span[] = []
	let start = 0
	let i = 0

	while (i < code.length) {
		const c = code[i]

		if (c === '"') {
			const close = code.indexOf('"', i + 1)

			i = close < 0 ? code.length : close + 1
		} else if (c === "\\" || c === "_" || c === "*") {
			i += 2
		} else if (c === "[") {
			const close = code.indexOf("]", i + 1)

			i = close < 0 ? code.length : close + 1
		} else if (c === ";") {
			spans.push({ start, end: i })
			i++
			start = i
		} else {
			i++
		}
	}

	spans.push({ start, end: code.length })

	return spans
}

// Whether the character at `i` is a format character (not quoted, escaped or bracketed) within `span`.
function plainAt(code: string, span: Span): boolean[] {
	const plain: boolean[] = []
	let i = span.start

	while (i < span.end) {
		const c = code[i]
		const from = i

		if (c === '"') {
			const close = code.indexOf('"', i + 1)

			i = close < 0 || close >= span.end ? span.end : close + 1
		} else if (c === "\\" || c === "_" || c === "*") {
			i = Math.min(span.end, i + 2)
		} else if (c === "[") {
			const close = code.indexOf("]", i + 1)

			i = close < 0 || close >= span.end ? span.end : close + 1
		} else {
			plain[i - span.start] = true
			i++
		}

		for (let k = from; k < i; k++) plain[k - span.start] ??= false
	}

	return plain
}

const PLACEHOLDER = /[0#?]/u

// One number section with a decimal place more (delta 1) or fewer (-1): after the last fraction placeholder, or
// a new ".0" after the last integer one; the point goes with the last fraction place. A section without number
// placeholders is left as it is.
function sectionDecimals(code: string, span: Span, delta: 1 | -1): string {
	const text = code.slice(span.start, span.end)
	const plain = plainAt(code, span)
	let point = -1
	let exponent = text.length
	let last = -1

	for (let i = 0; i < text.length; i++) {
		if (plain[i] !== true) continue

		const c = text[i] ?? ""

		if ((c === "E" || c === "e") && (text[i + 1] === "+" || text[i + 1] === "-")) {
			exponent = i
			break
		}

		if (c === "." && point < 0) point = i
		else if (PLACEHOLDER.test(c)) last = i
	}

	if (last < 0) return text

	// Only "?": room for the places other sections show (accounting's zero, "-"??), one more or fewer.
	if (
		point < 0 &&
		!/[0#]/u.test(
			text
				.split("")
				.filter((_, i) => plain[i] === true)
				.join("")
		)
	) {
		if (delta > 0) return `${text.slice(0, last + 1)}?${text.slice(last + 1)}`

		return text.slice(0, last) + text.slice(last + 1)
	}

	if (point < 0 || point > last) {
		if (delta < 0) return text

		return `${text.slice(0, last + 1)}.0${text.slice(last + 1)}`
	}

	// The fraction places run from the point to the last placeholder before the exponent.
	let end = point

	for (let i = point + 1; i < exponent; i++) if (plain[i] === true && PLACEHOLDER.test(text[i] ?? "")) end = i

	if (delta > 0) {
		const kind = end > point ? (text[end] ?? "0") : "0"

		return `${text.slice(0, end + 1)}${kind}${text.slice(end + 1)}`
	}

	if (end === point) return text

	const places = end - point
	// The point goes with the last place, unless placeholders follow it as an integer part would not.
	const cut = places === 1 ? point : end

	return text.slice(0, cut) + text.slice(end + 1)
}

// Decimals in a General text as shown ("1.25": 2, "1.2E+05": 1).
function shownDecimals(shown: string, decimal: string): { places: number; exponent: boolean } {
	const exponent = /E[+-]\d+$/u.test(shown)
	const mantissa = exponent ? shown.slice(0, shown.search(/E[+-]/u)) : shown
	const at = mantissa.lastIndexOf(decimal)

	return { places: at < 0 ? 0 : mantissa.length - at - decimal.length, exponent }
}

// The code Increase (delta 1) or Decrease (-1) Decimal gives a cell of `code` showing `shown`: General starts from
// the places it shows; text, dates and fractions keep their code (null).
export function changedDecimals(code: string, delta: 1 | -1, shown = "", decimal = "."): string | null {
	const category = numFmtCategory(code)

	if (category === "text" || category === "date" || category === "time" || category === "fraction") return null

	if (category === "general") {
		const { places, exponent } = shownDecimals(shown, decimal)
		const next = Math.max(0, places + delta)
		const digits = next > 0 ? `0.${"0".repeat(next)}` : "0"

		return exponent ? `${digits}E+00` : digits
	}

	const parts = sections(code)
	let changed = false
	let out = ""

	parts.forEach((span, index) => {
		const kind = numFmt(code).sections[index]?.kind
		const before = code.slice(span.start, span.end)
		const after =
			kind === SectionKind.NUMBER || kind === SectionKind.SCIENTIFIC || kind === undefined
				? sectionDecimals(code, span, delta)
				: before

		if (after !== before) changed = true

		out += (index > 0 ? ";" : "") + after
	})

	return changed ? out : null
}

// Whether text holds a character XML 1.0 cannot carry (§2.2 Char), so no part of the file can (a font name, a
// code): a C0 control but tab and line ends, a lone surrogate, U+FFFE or U+FFFF.
export function unwritableText(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)

		if (code < 0x20) {
			if (code !== 9 && code !== 10 && code !== 13) return true
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1)

			if (!(next >= 0xdc00 && next <= 0xdfff)) return true

			i++
		} else if ((code >= 0xdc00 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
			return true
		}
	}

	return false
}

// Excel's limits on a code typed in the Format Cells dialog: at most 255 characters and four sections, every quote
// and bracket closed, and a character after each \, _ and * ("Review guidelines for customizing a number format",
// support.microsoft.com); and only characters the styles part can hold. Null when the code is one Excel takes.
// format.apply refuses what this refuses, so the dialog and the session agree.
export type NumFmtProblem = "empty" | "tooLong" | "sections" | "unclosed" | "characters"

export const MAX_NUMFMT_LENGTH = 255

export function numFmtProblem(code: string): NumFmtProblem | null {
	if (code.trim() === "") return "empty"
	if (code.length > MAX_NUMFMT_LENGTH) return "tooLong"
	if (unwritableText(code)) return "characters"

	let sectionsSeen = 1
	let i = 0

	while (i < code.length) {
		const c = code[i]

		if (c === '"') {
			const close = code.indexOf('"', i + 1)

			if (close < 0) return "unclosed"

			i = close + 1
		} else if (c === "[") {
			const close = code.indexOf("]", i + 1)

			if (close < 0) return "unclosed"

			i = close + 1
		} else if (c === "\\" || c === "_" || c === "*") {
			if (i + 1 >= code.length) return "unclosed"

			i += 2
		} else {
			if (c === ";") sectionsSeen++

			i++
		}
	}

	return sectionsSeen > 4 ? "sections" : null
}

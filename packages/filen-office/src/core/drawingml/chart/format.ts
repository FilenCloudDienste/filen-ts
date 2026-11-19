// Number formats for chart labels: the subset of SpreadsheetML format codes charts use (General, fixed
// decimals, thousands separators and scaling, percent, scientific, literal prefixes/suffixes, simple dates).

import { MAX_NUMFMT_LENGTH } from "../../sheet/numfmt/edit"

const MS_PER_DAY = 86400000
// Serial 0 of the 1900 date system is 1899-12-30 once Excel's phantom 1900-02-29 is accounted for.
const EPOCH_1900 = Date.UTC(1899, 11, 30)
const EPOCH_1904 = Date.UTC(1904, 0, 1)
// toFixed and toExponential take at most 100 digits.
const MAX_DECIMALS = 100
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

function general(value: number): string {
	if (value === 0) return "0"

	const magnitude = Math.abs(value)

	if (magnitude >= 1e11 || magnitude < 1e-9) {
		return value
			.toExponential(5)
			.replace(/\.?0+e/, "E")
			.replace(/E([+-])(\d)$/, "E$10$2")
	}

	// Ten significant digits, trailing zeros dropped, as Excel's General shows them.
	const text = Number(value.toPrecision(10)).toString()

	return text.includes("e") ? value.toFixed(Math.max(0, 10 - Math.ceil(Math.log10(magnitude)))).replace(/\.?0+$/, "") : text
}

function groupThousands(integer: string): string {
	let out = ""

	for (let k = 0; k < integer.length; k++) {
		if (k > 0 && (integer.length - k) % 3 === 0) out += ","

		out += integer[k]
	}

	return out
}

// Literal text of a format section: quoted strings, escaped characters, and the characters Excel shows
// as themselves. Bracket tags are already stripped (see stripTags).
function literal(text: string): string {
	return text.replace(
		/"([^"]*)"|\\(.)|_.|\*./g,
		(_match, quoted: string | undefined, escaped: string | undefined) => quoted ?? escaped ?? ""
	)
}

function isDateCode(code: string): boolean {
	const bare = code.replace(/"[^"]*"|\\./g, "")

	return /[yd]/i.test(bare) || (/m/i.test(bare) && !/[0#?]/.test(bare))
}

// Removes the bracket tags of a section in one linear pass: locale/currency tags ([$€-407]) become their quoted
// symbol, colours and conditions ([Red], [>100]) disappear. A "[" with no "]" after it, and everything past it,
// stays as text; no later "[" can close either, so the scan stops there.
function stripTags(section: string): string {
	let out = ""
	let from = 0

	for (;;) {
		const open = section.indexOf("[", from)

		if (open === -1) break

		const close = section.indexOf("]", open + 1)

		if (close === -1) break

		out += section.slice(from, open)

		if (section[open + 1] === "$") {
			const tag = section.slice(open + 2, close)
			const dash = tag.indexOf("-")

			out += `"${(dash === -1 ? tag : tag.slice(0, dash)).replace(/"/g, "")}"`
		}

		from = close + 1
	}

	return out + section.slice(from)
}

function formatDate(value: number, code: string, date1904: boolean): string {
	const time = (date1904 ? EPOCH_1904 : EPOCH_1900) + Math.round(value * MS_PER_DAY)

	if (!Number.isFinite(time)) return general(value)

	const date = new Date(time)
	const year = date.getUTCFullYear()
	const month = date.getUTCMonth()
	const day = date.getUTCDate()

	return code.replace(
		/"([^"]*)"|\\(.)|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|h+|s+|AM\/PM/gi,
		(token: string, quoted: string | undefined, escaped: string | undefined) => {
			if (quoted !== undefined) return quoted
			if (escaped !== undefined) return escaped

			switch (token.toLowerCase()) {
				case "yyyy":
					return String(year)
				case "yy":
					return String(year % 100).padStart(2, "0")
				case "mmmmm":
					return (MONTHS[month] ?? "").slice(0, 1)
				case "mmmm":
					return MONTHS[month] ?? ""
				case "mmm":
					return (MONTHS[month] ?? "").slice(0, 3)
				case "mm":
					return String(month + 1).padStart(2, "0")
				case "m":
					return String(month + 1)
				case "dd":
					return String(day).padStart(2, "0")
				case "d":
					return String(day)
				default:
					// Times and weekday names are rare on chart axes and shown as nothing.
					return ""
			}
		}
	)
}

// One section of a format code, parsed once per code so formatting a point is arithmetic and a few slices.
type Section =
	| { kind: "general" }
	| { kind: "date"; code: string }
	| { kind: "literal"; text: string }
	| {
			kind: "number"
			prefix: string
			suffix: string
			// Divisor from the commas after the last digit placeholder (a thousand each).
			divisor: number
			percent: boolean
			decimals: number
			exponent: boolean
			// "#" among the decimals: trailing zeros are dropped.
			optional: boolean
			grouped: boolean
			// An integer part without a "0" placeholder ("#", "??") shows no zero.
			showZero: boolean
	  }

function trailingCommas(text: string): number {
	let count = 0

	while (count < text.length && text[text.length - 1 - count] === ",") count++

	return count
}

function parseSection(section: string): Section {
	const trimmed = stripTags(section).trim()

	if (trimmed === "" || /^general$/i.test(trimmed) || trimmed === "@") return { kind: "general" }
	if (isDateCode(trimmed)) return { kind: "date", code: trimmed }

	// Commas after the last digit placeholder (of the integer part or of the decimals) scale by 1000 each.
	const placeholders = /[0#?][0#?,]*(?:\.[0#?]*,*)?(?:[eE][+-][0#]+)?%?/.exec(
		trimmed.replace(/"[^"]*"|\\./g, match => " ".repeat(match.length))
	)

	if (placeholders === null) return { kind: "literal", text: literal(trimmed) }

	const number = placeholders[0]
	const integerSpec = /^[0#?,]*/.exec(number)?.[0] ?? ""
	const decimalsMatch = /\.([0#?]*)(,*)/.exec(number)
	const decimalsSpec = decimalsMatch?.[1] ?? ""
	const start = placeholders.index

	return {
		kind: "number",
		prefix: literal(trimmed.slice(0, start)),
		suffix: literal(trimmed.slice(start + number.length)).replace(/%/g, ""),
		divisor: 1000 ** (trailingCommas(integerSpec) + (decimalsMatch?.[2]?.length ?? 0)),
		percent: trimmed.includes("%"),
		decimals: Math.min(MAX_DECIMALS, decimalsSpec.length),
		exponent: /[eE][+-]/.test(number),
		optional: decimalsSpec.includes("#"),
		// Only a comma between two digit placeholders groups thousands.
		grouped: /[0#?],+[0#?]/.test(integerSpec),
		showZero: integerSpec.includes("0")
	}
}

type Parsed = {
	count: number
	positive: Section
	negative: Section | undefined
	zero: Section | undefined
}

function parse(code: string): Parsed {
	const sections = code.split(";", 3)
	// The section count decides whether negatives and zero have their own section; a split capped at 3 still
	// tells 1, 2 and "3 or more" apart.
	const count = sections.length

	return {
		count,
		positive: parseSection(sections[0] ?? "General"),
		negative: count > 1 ? parseSection(sections[1] ?? "") : undefined,
		zero: count > 2 ? parseSection(sections[2] ?? "") : undefined
	}
}

// Parsed codes by code. A chart formats every point with one or two codes; the bound keeps a chart that names a
// different code per point from growing it without limit.
const MAX_PARSED = 64
const parsed = new Map<string, Parsed>()

function parsedCode(code: string): Parsed {
	const hit = parsed.get(code)

	if (hit !== undefined) return hit

	if (parsed.size >= MAX_PARSED) parsed.clear()

	const entry = parse(code)

	parsed.set(code, entry)

	return entry
}

// Formats `value` with an Excel number format code. `date1904` selects the workbook's date system. A code
// longer than Excel allows reads as General; a code's sections are parsed once (in time linear in its length)
// and reused for every value.
export function formatNumber(value: number, code: string, date1904: boolean): string {
	if (!Number.isFinite(value)) return ""

	const format = parsedCode(code.length > MAX_NUMFMT_LENGTH ? "General" : code)
	const negative = value < 0 && format.negative !== undefined
	let section = negative && format.negative !== undefined ? format.negative : format.positive

	if (value === 0 && format.zero !== undefined) section = format.zero

	switch (section.kind) {
		case "general":
			return general(value)
		case "date":
			return formatDate(value, section.code, date1904)
		case "literal":
			return section.text
	}

	const magnitude = Math.abs(value)
	const scaled = (section.percent ? magnitude * 100 : magnitude) / section.divisor
	let digits: string

	if (section.exponent) {
		digits = scaled.toExponential(section.decimals).toUpperCase()
		digits = digits.replace(/E([+-])(\d)$/, "E$10$2")
	} else {
		const fixed = scaled.toFixed(section.decimals)
		const [integer = "0", fraction] = fixed.split(".")
		let fractionText = fraction ?? ""

		if (section.optional) fractionText = fractionText.replace(/0+$/, "")

		const grouped = section.grouped ? groupThousands(integer) : integer
		const leading = !section.showZero && integer === "0" ? "" : grouped

		digits = fractionText === "" ? leading : `${leading}.${fractionText}`
	}

	const sign = value < 0 && !negative ? "-" : ""

	return `${sign}${section.prefix}${digits}${section.percent ? "%" : ""}${section.suffix}`
}

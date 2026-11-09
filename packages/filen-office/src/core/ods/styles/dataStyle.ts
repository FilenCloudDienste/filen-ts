import type { OdfElement } from "../../odf/tree"
import type { OdfDataStyle, OdfStyleSheet, StyleScope } from "../../odf/styles"
import { DEFAULT_PALETTE } from "../../sheet/style/palette"
import { lcidTag, odsLocale } from "./locale"

// An ODF data style (ODF 1.3 Part 3 §16.29) as a SpreadsheetML number format code (ECMA-376 Part 1 §18.8.31), the
// grammar the number formatter reads. What a code cannot say is approximated and named in `held` (quarters, weeks,
// eras, colours off the palette, more than two conditions), so the cell still shows its value.
export interface DataStyleCode {
	readonly code: string
	readonly held: readonly string[]
}

// Characters a code shows as themselves (§18.8.31): anything else in a literal is quoted.
const PLAIN = /^[ $\-+/():!^&'~{}<>=]*$/

function literal(text: string): string {
	if (text === "") return ""
	if (PLAIN.test(text)) return text

	return `"${text.replaceAll('"', '"\\""')}"`
}

const NAMED_COLORS: ReadonlyMap<number, string> = new Map([
	[0x000000, "Black"],
	[0x0000ff, "Blue"],
	[0x00ffff, "Cyan"],
	[0x00ff00, "Green"],
	[0xff00ff, "Magenta"],
	[0xff0000, "Red"],
	[0xffffff, "White"],
	[0xffff00, "Yellow"]
])

// [Red] for a named colour, [ColorN] for another of the default palette; undefined for a colour off it.
function colorTag(color: string): string | undefined {
	if (!/^#[0-9a-fA-F]{6}$/.test(color)) return undefined

	const rgb = Number.parseInt(color.slice(1), 16)
	const named = NAMED_COLORS.get(rgb)

	if (named !== undefined) return `[${named}]`

	// [Color1]..[Color56] index the palette from its 9th entry (the first 8 are the fixed EGA colours).
	const index = DEFAULT_PALETTE.indexOf(rgb, 8)

	return index >= 8 && index < 64 ? `[Color${index - 7}]` : undefined
}

function intAttribute(element: OdfElement, name: string, fallback: number): number {
	const value = Number(element.attributes.get(name))

	return Number.isInteger(value) && value >= 0 ? value : fallback
}

// The most digits one part of a code asks for, and the furthest left an embedded text sits: LibreOffice limits
// decimal places and exponent digits to this on import (NF_MAX_FORMAT_SYMBOLS); the same bound keeps a hostile count
// of integer, fraction or position digits from building a code of millions of characters. Past it the style is held.
const MAX_DIGITS = 100

function digitsAttribute(element: OdfElement, name: string, fallback: number, held: string[]): number {
	const value = intAttribute(element, name, fallback)

	if (value <= MAX_DIGITS) return value

	if (!held.includes("digits")) held.push("digits")

	return MAX_DIGITS
}

function isLong(element: OdfElement): boolean {
	return element.attributes.get("number:style") === "long"
}

// number:number: digits, grouping, decimals, display factor and embedded text.
function numberCode(element: OdfElement, held: string[]): string {
	const attributes = element.attributes
	const places = attributes.get("number:decimal-places")
	const decimals = digitsAttribute(element, "number:decimal-places", 0, held)
	const minimum = Math.min(
		decimals,
		intAttribute(element, "number:min-decimal-places", intAttribute(element, "loext:min-decimal-places", decimals))
	)
	const integers = digitsAttribute(element, "number:min-integer-digits", 0, held)
	const grouping = attributes.get("number:grouping") === "true"
	const factor = Number(attributes.get("number:display-factor") ?? "1")

	// No decimal places given: LibreOffice's "General" ("Standard", written as min-integer-digits alone).
	if (places === undefined && !grouping) return "General"

	let integer: string

	if (grouping) {
		const digits = "0".repeat(integers).padStart(4, "#")

		integer = `${digits.slice(0, -3)},${digits.slice(-3)}`
	} else {
		integer = integers > 0 ? "0".repeat(integers) : "#"
	}

	if (attributes.has("number:decimal-replacement")) held.push("decimalReplacement")

	// Embedded texts by position, those at one position joined in order (§16.29.4), as LibreOffice reads them.
	let texts: Map<number, string> | undefined

	for (const embedded of element.children) {
		if (embedded.name !== "number:embedded-text") continue

		const position = digitsAttribute(embedded, "number:position", 0, held)

		texts ??= new Map()
		texts.set(position, (texts.get(position) ?? "") + embedded.text)
	}

	if (texts !== undefined) integer = embed(integer, texts)

	let code = integer + (decimals > 0 ? `.${"0".repeat(minimum)}${"#".repeat(decimals - minimum)}` : "")

	if (factor === 1000) code += ","
	else if (factor === 1_000_000) code += ",,"
	else if (factor !== 1 && Number.isFinite(factor)) held.push("displayFactor")

	return code
}

// An integer part's placeholders ("0", "#", grouping ",") with each text `position` digits left of the decimal
// separator. A digit stays left of the leftmost text so it is embedded, not leading: digits the part lacks are
// optional ones ("#"), as LibreOffice adds them on import.
function embed(integer: string, texts: ReadonlyMap<number, string>): string {
	let digits = 0

	for (const c of integer) if (c !== ",") digits++

	let furthest = 0

	for (const position of texts.keys()) furthest = Math.max(furthest, position)

	const padded = digits > furthest ? integer : "#".repeat(furthest + 1 - digits) + integer
	let out = literal(texts.get(0) ?? "")
	let counted = 0

	for (let at = padded.length - 1; at >= 0; at--) {
		const c = padded[at] ?? ""

		out = c + out

		if (c === ",") continue

		counted++

		const text = texts.get(counted)

		if (text !== undefined) out = literal(text) + out
	}

	return out
}

// One section: the format elements of one style in order. `general`: a style with none shows as General.
function sectionCode(style: OdfDataStyle, held: string[], general: boolean): { code: string; locale: number | undefined } {
	const elapsed = style.attributes.get("number:truncate-on-overflow") === "false"
	let code = ""
	let elapsedDone = false
	const language = style.attributes.get("number:language")
	const country = style.attributes.get("number:country")
	const languageSource = style.attributes.get("number:format-source") === "language"

	// number:format-source="language": the language's own date format, not the parts written. Without a language,
	// LibreOffice takes its system locale's; the core has none and takes en-US's (Excel's default).
	if (languageSource && style.kind === "date") {
		const facts = odsLocale(language, country)
		const fallback = facts === undefined ? odsLocale("en", "US") : undefined
		const textual = style.parts.some(part => part.name === "number:month" && part.attributes.get("number:textual") === "true")
		const weekday = style.parts.some(part => part.name === "number:day-of-week")
		const chosen = facts ?? fallback

		if (chosen !== undefined) {
			const hasTime = style.parts.some(part => part.name === "number:hours")
			const time = hasTime ? ` hh:mm${style.parts.some(part => part.name === "number:seconds") ? ":ss" : ""}` : ""

			return { code: (textual || weekday ? chosen.longDate : chosen.shortDate) + time, locale: facts?.lcid }
		}
	}

	for (const part of style.parts) {
		switch (part.name) {
			case "number:number":
				code += numberCode(part, held)
				break
			case "number:scientific-number": {
				const decimals = digitsAttribute(part, "number:decimal-places", 0, held)
				const integers = Math.max(1, digitsAttribute(part, "number:min-integer-digits", 1, held))
				const exponent = Math.max(1, digitsAttribute(part, "number:min-exponent-digits", 2, held))
				// Engineering notation: the exponent a multiple of the interval (§19.355), "##0" in a code.
				const interval = digitsAttribute(part, "number:exponent-interval", 1, held)
				const mantissa = interval > integers ? "#".repeat(interval - integers) + "0".repeat(integers) : "0".repeat(integers)
				// A sign for positive exponents too unless number:forced-exponent-sign says otherwise (§19.356).
				const sign = part.attributes.get("number:forced-exponent-sign") === "false" ? "E-" : "E+"

				code += `${mantissa}${decimals > 0 ? `.${"0".repeat(decimals)}` : ""}${sign}${"0".repeat(exponent)}`
				break
			}
			case "number:fraction": {
				const integers = part.attributes.has("number:min-integer-digits")
					? digitsAttribute(part, "number:min-integer-digits", 0, held)
					: undefined
				const numerator = Math.max(1, digitsAttribute(part, "number:min-numerator-digits", 1, held))
				const denominator = Math.max(1, digitsAttribute(part, "number:min-denominator-digits", 1, held))
				const fixed = part.attributes.get("number:denominator-value")
				const whole = integers === undefined ? "" : `${integers > 0 ? "0".repeat(integers) : "#"} `
				const fixedOk = fixed !== undefined && /^\d{1,9}$/.test(fixed)

				if (fixed !== undefined && !fixedOk) held.push("denominator")

				code += `${whole}${"?".repeat(numerator)}/${fixedOk ? fixed : "?".repeat(denominator)}`
				break
			}
			case "number:text":
				// A percent sign in a percentage style is the percent (the value shows times 100); anywhere else, text.
				code += style.kind === "percentage" ? part.text.split("%").map(literal).join("%") : literal(part.text)
				break
			case "number:text-content":
				code += "@"
				break
			// The symbol's own language names the currency, not the separators (the style's number:language does).
			case "number:currency-symbol":
				code += part.text === "" ? "" : `[$${part.text.replaceAll("]", "")}]`
				break
			case "number:fill-character":
				code += `*${part.text === "" ? " " : (part.text[0] ?? " ")}`
				break
			case "number:boolean":
				code += '"TRUE";"TRUE";"FALSE"'
				break
			case "number:day":
				code += isLong(part) ? "dd" : "d"
				break
			case "number:day-of-week":
				code += isLong(part) ? "dddd" : "ddd"
				break
			case "number:month": {
				const textual = part.attributes.get("number:textual") === "true"

				code += textual ? (isLong(part) ? "mmmm" : "mmm") : isLong(part) ? "mm" : "m"
				break
			}
			case "number:year":
				code += isLong(part) ? "yyyy" : "yy"
				break
			case "number:era":
				held.push("era")
				break
			case "number:quarter":
				held.push("quarter")
				break
			case "number:week-of-year":
				held.push("weekOfYear")
				break
			case "number:hours": {
				const hours = isLong(part) ? "hh" : "h"

				code += elapsed && !elapsedDone ? `[${hours}]` : hours
				elapsedDone = true
				break
			}
			case "number:minutes": {
				const minutes = isLong(part) ? "mm" : "m"

				code += elapsed && !elapsedDone ? `[${minutes}]` : minutes
				elapsedDone = true
				break
			}
			case "number:seconds": {
				const decimals = digitsAttribute(part, "number:decimal-places", 0, held)
				const seconds = isLong(part) ? "ss" : "s"

				code += `${elapsed && !elapsedDone ? `[${seconds}]` : seconds}${decimals > 0 ? `.${"0".repeat(decimals)}` : ""}`
				elapsedDone = true
				break
			}
			case "number:am-pm":
				code += "AM/PM"
				break
			default:
				held.push(part.name)
		}
	}

	if (style.kind === "percentage" && !code.includes("%")) code += "%"

	const color = style.textProperties?.attributes.get("fo:color")
	let tag = ""

	if (color !== undefined) {
		const found = colorTag(color.toLowerCase())

		if (found === undefined) held.push("color")
		else tag = found
	}

	// No content elements (§16.29.2): a style alone shows as General, a condition's or a main style with conditions
	// is an empty section that shows nothing (Excel's "0;-0;;@"), its colour and language moot.
	if (code === "") {
		if (!general) return { code: "", locale: undefined }

		code = "General"
	}

	const facts = odsLocale(language, country)

	return { code: tag + code, locale: facts?.lcid }
}

// The text section of a text style: its literals around "@".
function textSection(code: string): string {
	return code.includes("@") ? code : `${code}@`
}

const CONDITION = /^value\(\)\s*(>=|<=|!=|<>|>|<|=)\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/

// The style with its style:map conditions (§16.3) as the sections of one code: Excel's default sections where the
// conditions are theirs (>= 0; > 0 and < 0), bracketed conditions otherwise (two at most).
export function dataStyleCode(sheet: OdfStyleSheet, style: OdfDataStyle, scope: StyleScope): DataStyleCode {
	const held: string[] = []
	// Each section with its own language's tag, as the formatter reads a tag per section.
	const tagged = (section: { code: string; locale: number | undefined }): string =>
		section.locale === undefined ? section.code : lcidTag(section.locale) + section.code
	const main = { code: tagged(sectionCode(style, held, style.maps.length === 0)) }
	const conditions: { operator: string; value: string; code: string }[] = []

	for (const map of style.maps) {
		const target = sheet.dataStyle(map.applyStyleName, scope)
		const match = CONDITION.exec(map.condition.trim())

		if (match === null) {
			held.push("condition")

			continue
		}

		// A condition naming a style the file lacks takes the main style, as LibreOffice reads it (the specification is
		// silent); a text style's literals without its text.
		conditions.push({
			operator: match[1] === "!=" ? "<>" : (match[1] ?? ""),
			value: match[2] ?? "",
			code:
				target === undefined
					? style.kind === "text"
						? main.code.replace("@", "")
						: main.code
					: tagged(sectionCode(target, held, false))
		})
	}

	const zeroBased = conditions.length > 0 && conditions.every(entry => Number(entry.value) === 0 && entry.operator !== "<>")
	const find = (...operators: string[]): string | undefined => {
		for (const operator of operators) {
			const found = conditions.find(entry => entry.operator === operator)

			if (found !== undefined) return found.code
		}

		return undefined
	}
	let code: string

	if (conditions.length === 0) {
		code = style.kind === "text" ? textSection(main.code) : main.code
	} else if (zeroBased) {
		// Conditions on the sign: Excel's positive, negative and zero sections (and the text one), the main style
		// taking what no condition does. A number section in Excel's second place shows the value without its sign.
		const text = style.kind === "text" ? textSection(main.code) : undefined
		// A number no condition takes shows through the main style: a text style's literals alone (LibreOffice).
		const literals = text === undefined ? main.code : text.replace("@", "")
		const positive = find(">", ">=") ?? literals
		const negative = find("<", "<=") ?? literals
		const zero = find("=", ">=", "<=") ?? literals

		code = `${positive};${negative};${zero}${text === undefined ? "" : `;${text}`}`
	} else {
		if (conditions.length > 2) held.push("conditions")

		code = [...conditions.slice(0, 2).map(entry => `[${entry.operator}${entry.value}]${entry.code}`), main.code].join(";")
	}

	return { code, held }
}

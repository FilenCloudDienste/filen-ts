import { OdfNs } from "../../odf/namespaces"
import { OdfStyleSheet } from "../../odf/styles"
import { formatValue } from "../../sheet/numfmt/format"
import { LCID_SYSTEM_DATE, LCID_SYSTEM_TIME, SectionKind, Tok, parseNumFmt, type NumFmtSection, type Token } from "../../sheet/numfmt/parse"
import { DEFAULT_PALETTE } from "../../sheet/style/palette"
import { encodeUtf8, escapeAttribute, escapeText, parseXml } from "../../xml/index"
import { dataStyleCode } from "../styles/dataStyle"
import { localeOfLcid } from "../styles/locale"

// A SpreadsheetML number format code (ECMA-376 Part 1 §18.8.31) as ODF data styles (ODF 1.3 Part 3 §16.29), the
// inverse of styles/dataStyle.ts: one number:*-style per section, the main one carrying the others as style:map
// conditions (§16.3), as LibreOffice writes them. A code a data style cannot say (eras, Buddhist years, hair-width
// padding the formatter draws otherwise) is refused with a reason; the caller checks what it writes reads back as the
// code it was.

export type DataStyleResult = { readonly styles: readonly DataStyleElement[] } | { readonly refused: string }

export interface DataStyleElement {
	readonly name: string
	readonly markup: string
}

// "#RRGGBB".
function hex(rgb: number): string {
	return `#${rgb.toString(16).padStart(6, "0")}`
}

function text(value: string): string {
	return `<number:text>${escapeText(value)}</number:text>`
}

interface Section {
	readonly kind: "number" | "currency" | "percentage" | "date" | "time" | "boolean" | "text"
	readonly attributes: string
	readonly body: string
}

// The digit placeholders of a number section, written as number:number (§16.29.3), its embedded texts inside.
function numberElement(section: NumFmtSection, embedded: string): string {
	const fraction = section.patterns.fraction
	const integer = section.patterns.integer
	const decimals = fraction.length
	const minimumDecimals = fraction.replace(/[#?]+$/, "").length
	const integers = integer.replace(/^[#?,]+/, "").replaceAll(",", "").length
	const factor = section.thousands > 0 ? 1000 ** section.thousands : 1
	const attributes = [
		`number:decimal-places="${decimals}"`,
		minimumDecimals !== decimals ? `number:min-decimal-places="${minimumDecimals}"` : "",
		`number:min-integer-digits="${integers}"`,
		section.grouping ? 'number:grouping="true"' : "",
		factor !== 1 ? `number:display-factor="${factor}"` : ""
	]

	const tag = `number:number ${attributes.filter(attribute => attribute !== "").join(" ")}`

	return embedded === "" ? `<${tag}/>` : `<${tag}>${embedded}</number:number>`
}

// One section's elements, or the reason it cannot be written. `palette`: the workbook's, for [ColorN].
function sectionMarkup(section: NumFmtSection, palette: readonly number[]): Section | { refused: string } {
	if (section.nativeDigits) return { refused: "native digits" }

	const parts: string[] = []
	let pending = ""
	const flush = (): void => {
		if (pending !== "") parts.push(text(pending))

		pending = ""
	}
	// Literals between integer digits (Zip Code + 4, Phone Number, Social Security Number), placed by the integer
	// digits right of them (§16.29.4), and where number:number sits in `parts`.
	let embedded = ""
	let numberAt = -1
	let integersLeft = section.integerDigits
	let pointSeen = false
	let kind: Section["kind"] = "number"
	let elapsed = false
	let digitsWritten = false
	const tokens = section.tokens

	switch (section.kind) {
		case SectionKind.DATE:
			kind = tokens.some(token => token.kind === Tok.YEAR || token.kind === Tok.MONTH || token.kind === Tok.DAY) ? "date" : "time"
			break
		case SectionKind.TEXT:
			kind = "text"
			break
		default:
			kind = section.percent > 0 ? "percentage" : "number"
	}

	// A fraction's whole part, the space after it, its numerator and its denominator are one element (§16.29.6).
	const fraction = section.kind === SectionKind.FRACTION ? section.fraction : null
	const firstDigit = tokens.findIndex(token => token.kind === Tok.DIGIT)
	const fractionStart = fraction === null ? -1 : firstDigit
	const fractionEnd = fraction === null ? -1 : fraction.denominatorEnd

	for (let k = 0; k < tokens.length; k++) {
		const token = tokens[k] as Token

		if (fraction !== null && k >= fractionStart && k <= fractionEnd) {
			if (k === fraction.slash) {
				flush()

				const whole = section.patterns.integer
				const attributes = [
					whole === "" ? "" : `number:min-integer-digits="${whole.replace(/^[#?]+/, "").length}"`,
					`number:min-numerator-digits="${Math.max(1, section.patterns.numerator.length)}"`,
					fraction.fixed > 0
						? `number:denominator-value="${fraction.fixed}"`
						: `number:min-denominator-digits="${Math.max(1, section.patterns.denominator.length)}"`
				]

				parts.push(`<number:fraction ${attributes.filter(attribute => attribute !== "").join(" ")}/>`)
				digitsWritten = true
			}

			continue
		}

		switch (token.kind) {
			case Tok.LITERAL:
				// A currency symbol ([$€-407] gives a literal and a language) is the style's currency.
				pending += token.text
				break
			case Tok.DIGIT:
			case Tok.POINT:
			case Tok.COMMA:
				if (section.kind === SectionKind.FRACTION || section.kind === SectionKind.SCIENTIFIC) break

				if (!digitsWritten) {
					flush()
					numberAt = parts.length
					parts.push(numberElement(section, ""))
					digitsWritten = true
				} else if (pending !== "") {
					// A literal before an integer digit is embedded text; one in the fraction part, before the point or
					// holding a percentage's "%" (embedded, a literal) has no element. Before a trailing comma it shows after
					// the digits, as written.
					if (pointSeen || token.kind === Tok.POINT || (section.percent > 0 && pending.includes("%")) || numberAt < 0)
						return { refused: "embedded text" }

					if (integersLeft > 0) {
						embedded += `<number:embedded-text number:position="${integersLeft}">${escapeText(pending)}</number:embedded-text>`
						pending = ""
					}
				}

				if (token.kind === Tok.POINT) pointSeen = true
				else if (token.kind === Tok.DIGIT && !pointSeen) integersLeft--
				break
			case Tok.PERCENT:
				pending += "%"
				break
			case Tok.EXPONENT: {
				flush()

				const decimals = section.patterns.fraction.length
				const integer = section.patterns.integer
				const integers = Math.max(1, integer.replaceAll("#", "").length)
				// Engineering notation: the exponent a multiple of the integer digits (§19.355 number:exponent-interval).
				const interval = integer.length > 1 && integers === 1 ? ` number:exponent-interval="${integer.length}"` : ""
				const sign = token.text.endsWith("-") ? ' number:forced-exponent-sign="false"' : ""

				parts.push(
					`<number:scientific-number number:decimal-places="${decimals}" number:min-integer-digits="${integers}" number:min-exponent-digits="${section.patterns.exponent.length}"${interval}${sign}/>`
				)
				digitsWritten = true
				break
			}
			case Tok.SLASH:
				pending += "/"
				break
			case Tok.GENERAL:
				flush()
				parts.push('<number:number number:min-integer-digits="1"/>')
				digitsWritten = true
				break
			case Tok.TEXT:
				flush()
				parts.push("<number:text-content/>")
				break
			case Tok.REPEAT:
				flush()
				parts.push(`<number:fill-character>${escapeText(token.text)}</number:fill-character>`)
				break
			case Tok.YEAR:
				flush()
				parts.push(token.count > 2 ? '<number:year number:style="long"/>' : "<number:year/>")
				break
			case Tok.MONTH:
				flush()

				if (token.count > 4) return { refused: "month initial" }

				parts.push(
					token.count >= 3
						? `<number:month number:textual="true"${token.count === 4 ? ' number:style="long"' : ""}/>`
						: token.count === 2
							? '<number:month number:style="long"/>'
							: "<number:month/>"
				)
				break
			case Tok.DAY:
				flush()
				parts.push(
					token.count >= 3
						? `<number:day-of-week${token.count >= 4 ? ' number:style="long"' : ""}/>`
						: token.count === 2
							? '<number:day number:style="long"/>'
							: "<number:day/>"
				)
				break
			case Tok.HOUR:
			case Tok.ELAPSED_HOUR:
				flush()
				elapsed ||= token.kind === Tok.ELAPSED_HOUR
				parts.push(token.count >= 2 ? '<number:hours number:style="long"/>' : "<number:hours/>")
				break
			case Tok.MINUTE:
			case Tok.ELAPSED_MINUTE:
				flush()
				elapsed ||= token.kind === Tok.ELAPSED_MINUTE
				parts.push(token.count >= 2 ? '<number:minutes number:style="long"/>' : "<number:minutes/>")
				break
			case Tok.SECOND:
			case Tok.ELAPSED_SECOND: {
				flush()
				elapsed ||= token.kind === Tok.ELAPSED_SECOND

				const next = tokens[k + 1]
				const decimals = next?.kind === Tok.SUBSECOND ? next.count : 0

				if (decimals > 0) k++

				parts.push(
					`<number:seconds${token.count >= 2 ? ' number:style="long"' : ""}${decimals > 0 ? ` number:decimal-places="${decimals}"` : ""}/>`
				)
				break
			}
			case Tok.SUBSECOND:
				return { refused: "subseconds" }
			case Tok.AMPM:
				flush()

				if (token.text !== "") return { refused: "A/P" }

				parts.push("<number:am-pm/>")
				break
			default:
				return { refused: "date part" }
		}
	}

	flush()

	if (embedded !== "") parts[numberAt] = numberElement(section, embedded)

	const attributes: string[] = []

	if (elapsed) attributes.push('number:truncate-on-overflow="false"')
	// Excel's system long date ([$-F800]) is the language's own long date (§19.348 number:format-source).
	if (section.lcid === LCID_SYSTEM_DATE && kind === "date") attributes.push('number:format-source="language"')

	if (section.lcid >= 0 && section.lcid !== LCID_SYSTEM_DATE && section.lcid !== LCID_SYSTEM_TIME) {
		const locale = localeOfLcid(section.lcid)

		if (locale === undefined) return { refused: "language" }

		attributes.push(`number:language="${locale.language}"`, `number:country="${locale.country}"`)
	}

	// [ColorN] as the workbook's palette shows it (the formatter's sectionColor).
	const color = section.color >= 0 || section.colorIndex < 0 ? section.color : (palette[section.colorIndex] ?? -1)

	if (color < 0 && section.colorIndex >= 0) return { refused: "colour index" }

	// style:text-properties first (§16.29.2 content order).
	const body = (color >= 0 ? `<style:text-properties fo:color="${hex(color)}"/>` : "") + parts.join("")

	return { kind, attributes: attributes.join(" "), body }
}

function element(section: Section, name: string, maps: string): string {
	const tag = `number:${section.kind}-style`
	const attributes = section.attributes === "" ? "" : ` ${section.attributes}`

	return `<${tag} style:name="${escapeAttribute(name)}"${attributes}>${section.body}${maps}</${tag}>`
}

function map(condition: string, name: string): string {
	return `<style:map style:condition="${escapeAttribute(condition)}" style:apply-style-name="${escapeAttribute(name)}"/>`
}

// The data styles of a code: the main one named `name`, the conditions' ones after it with `name` and a suffix
// (P0, P1, ...), each listed before the style naming it, as §16.3 requires of style:apply-style-name.
// `palette`: the workbook's indexed one, which [ColorN] names an entry of.
export function dataStyles(code: string, name: string, palette: readonly number[] = DEFAULT_PALETTE): DataStyleResult {
	const format = parseNumFmt(code)
	const numeric = format.sections
	const textSection = format.text
	const written: (Section | { refused: string })[] = numeric.map(section => sectionMarkup(section, palette))
	const text = textSection === null ? null : sectionMarkup(textSection, palette)

	for (const section of [...written, ...(text === null ? [] : [text])]) if ("refused" in section) return section

	const sections = written as Section[]
	const out: DataStyleElement[] = []
	const sub = (section: Section): string => {
		const subName = `${name}P${out.length}`

		out.push({ name: subName, markup: element(section, subName, "") })

		return subName
	}
	const conditional = numeric.some(section => section.condition !== null)

	if (conditional) {
		const maps: string[] = []
		let main: Section | undefined

		numeric.forEach((section, k) => {
			const markup = sections[k] as Section

			if (section.condition === null) main = markup
			else
				maps.push(
					map(
						`value()${section.condition.operator === "<>" ? "!=" : section.condition.operator}${section.condition.value}`,
						sub(markup)
					)
				)
		})

		if (maps.length > 2) return { refused: "conditions" }

		const last = main ?? (text === null ? undefined : (text as Section))

		if (last === undefined) return { refused: "conditions" }

		out.push({ name, markup: element(last, name, maps.join("")) })

		return { styles: out }
	}

	const [positive, negative, zero] = sections

	if (positive === undefined) return { refused: "empty" }

	if (text !== null) {
		// A reader takes the first map whose condition holds (§16.3): with a zero section the positive one is for more
		// than zero, as Excel's sections are.
		const maps = [
			map(zero === undefined ? "value()>=0" : "value()>0", sub(positive)),
			map("value()<0", sub(negative ?? { ...positive, body: `<number:text>-</number:text>${positive.body}` }))
		]

		if (zero !== undefined) maps.push(map("value()=0", sub(zero)))

		out.push({ name, markup: element(text as Section, name, maps.join("")) })

		return { styles: out }
	}

	if (negative === undefined) {
		out.push({ name, markup: element(positive, name, "") })
	} else if (zero === undefined) {
		const maps = map("value()<0", sub(negative))

		out.push({ name, markup: element(positive, name, maps) })
	} else {
		const maps = map("value()>0", sub(positive)) + map("value()<0", sub(negative))

		out.push({ name, markup: element(zero, name, maps) })
	}

	return { styles: out }
}

// Values a code is tried with: what it shows for each must not change by writing it.
const PROBES: readonly (number | string)[] = [-1234.5678, -1, -0.25, 0, 0.25, 1, 7, 1234.5678, 45000.75, 0.000123, 1e10, "text"]

// Text as compared: runs of white space as one and none at the ends. A "?" placeholder and "_x" padding are blanks
// a data style has no element for (LibreOffice 7.5 writes Excel's accounting formats without them too).
export function shownKey(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

// Whether two codes show every probe alike (the text, its colour and its fill character). `optionsB`: b's, when its
// workbook differs (a palette [ColorN] reads through).
export function sameShown(
	a: string,
	b: string,
	options: Parameters<typeof formatValue>[2] = {},
	optionsB: Parameters<typeof formatValue>[2] = options
): boolean {
	for (const value of PROBES) {
		const left = formatValue(value, a, options)
		const right = formatValue(value, b, optionsB)

		if (shownKey(left.text) !== shownKey(right.text) || left.color !== right.color || left.repeat?.char !== right.repeat?.char)
			return false
	}

	return true
}

// The code dataStyles' `styles` (the main one named `name`) read back as, as styles/dataStyle.ts reads a file.
export function readBack(styles: readonly DataStyleElement[], name: string): string {
	const xml = `<office:document-styles xmlns:office="${OdfNs.office}" xmlns:style="${OdfNs.style}" xmlns:number="${OdfNs.number}" xmlns:fo="${OdfNs.fo}"><office:styles>${styles.map(style => style.markup).join("")}</office:styles></office:document-styles>`
	const sheet = new OdfStyleSheet(parseXml(encodeUtf8(xml)), undefined)
	const style = sheet.dataStyle(name, "styles")

	return style === undefined ? "General" : dataStyleCode(sheet, style, "styles").code
}

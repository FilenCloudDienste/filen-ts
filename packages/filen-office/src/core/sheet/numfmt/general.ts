import { decompose, integerDigits, roundDigits, type Digits } from "./decimal"
import { SectionKind, Tok, type NumFmt } from "./parse"

// General in a cell too narrow for it. Excel's General shows a number in at most 11 characters (ECMA-376 Part 1
// §18.8.30), and in a narrower cell it "rounds the numbers with decimals" and "uses scientific (exponential)
// notation for large numbers" (support.microsoft.com, "Available number formats in Excel") rather than "#": the
// same rules over fewer characters, the widest that fits the cell's width chosen. Only a number nothing fits shows
// as "#" across the cell.

declare module "../protocol" {
	interface SheetTileLayerMap {
		// The values of a tile's numbers shown in General, so a cell narrower than the text rounds them as Excel
		// does: entries[i] holds values[i]; `decimal` is the locale's point the text uses.
		readonly general: {
			readonly entries: Uint16Array
			readonly values: Float64Array
			readonly decimal: string
		}
	}
}

// The characters General has in a cell wide enough (the sign excluded).
export const GENERAL_CHARS = 11
// The mantissa's significant digits General shows at most in exponential form (1.23457E+11).
const MANTISSA_DIGITS = 6

const scratch: Digits = { digits: "", point: 0 }

// The format is General and nothing else: no colour, condition or literal changes what General shows.
export function isPlainGeneral(format: NumFmt): boolean {
	if (format.sections.length !== 1) return false

	const section = format.sections[0]

	return (
		section !== undefined &&
		section.kind === SectionKind.GENERAL &&
		section.condition === null &&
		section.color < 0 &&
		section.colorIndex < 0 &&
		section.tokens.length === 1 &&
		section.tokens[0]?.kind === Tok.GENERAL
	)
}

// The digits as a decimal number, every digit shown, with `decimal` as the point.
export function plainDigits(d: Digits, decimal: string): string {
	const integer = integerDigits(d) || "0"
	const fraction = d.point >= 0 ? d.digits.slice(d.point + 1) : "0".repeat(-d.point - 1) + d.digits

	return fraction === "" ? integer : integer + decimal + fraction
}

function exponential(value: number, chars: number, decimal: string): string | null {
	for (let mantissa = Math.min(MANTISSA_DIGITS, chars); mantissa >= 1; mantissa--) {
		const d = roundDigits(decompose(value, scratch), mantissa)
		const exponent = d.point < 0 ? -d.point : d.point
		const power = exponent < 10 ? `0${String(exponent)}` : String(exponent)
		const digits = d.digits === "" ? "0" : d.digits
		const text = `${digits.length > 1 ? `${digits[0] ?? "0"}${decimal}${digits.slice(1)}` : digits}E${d.point < 0 ? "-" : "+"}${power}`

		if (text.length <= chars) return text
	}

	return null
}

// |value| in General within `chars` characters, or null when not even its exponential form fits. At GENERAL_CHARS
// it is formatGeneral's text.
export function generalWithin(value: number, chars: number, decimal = "."): string | null {
	const d = decompose(value, scratch)

	if (d.digits === "") return "0"

	const point = d.point

	if (point >= 0) {
		// The integer digits, and one character for the point when a fraction digit fits after them.
		if (point < chars && point < GENERAL_CHARS) {
			const text = plainDigits(roundDigits(d, point + 1 === chars ? chars : chars - 1), decimal)

			if (text.length <= chars) return text
		}

		return exponential(value, chars, decimal)
	}

	// "0.", the zeros after the point, then the digits: below 1e-4 only when all of them fit, as General does.
	const keep = chars - 1 + point

	if (keep >= 1 && (point >= -4 || d.digits.length <= keep)) {
		const rounded = roundDigits(d, keep)

		if (rounded.digits !== "") {
			const text = plainDigits(rounded, decimal)

			if (text.length <= chars) return text
		}
	}

	// Too narrow for a digit after the point or an exponent: rounded to a whole number, as a fraction rounds away.
	return exponential(value, chars, decimal) ?? (roundDigits(decompose(value, scratch), point + 1).digits === "" ? "0" : "1")
}

// The widest General text of `value` that `fits` takes (the sign included), from GENERAL_CHARS characters down;
// null when none does.
export function fitGeneral(value: number, decimal: string, fits: (text: string) => boolean): string | null {
	const sign = value < 0 ? "-" : ""
	let last = ""

	for (let chars = GENERAL_CHARS; chars >= 1; chars--) {
		const text = generalWithin(value, chars, decimal)

		if (text === null) return null
		if (text === last) continue

		last = text

		const shown = text === "0" ? text : sign + text

		if (fits(shown)) return shown
	}

	return null
}

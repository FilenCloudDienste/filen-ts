import { DEFAULT_PALETTE } from "../style/palette"
import { MAX_SERIAL_1900, MAX_SERIAL_1904, serialDate, type DateBase, type DateParts } from "./date"
import { decompose, fractionDigits, integerDigits, roundDigits, type Digits } from "./decimal"
import { NUMFMT_EN_US, type NumFmtLocale } from "./locale"
import {
	LCID_SYSTEM_DATE,
	LCID_SYSTEM_DATE_TIME,
	LCID_SYSTEM_SHORT_DATE,
	LCID_SYSTEM_TIME,
	SectionKind,
	Tok,
	parseNumFmt,
	systemLcid,
	type NumFmt,
	type NumFmtSection,
	type Token
} from "./parse"

export interface NumFmtOptions {
	// The workbook's date system (workbookPr date1904; ISO_1900 for a Strict workbook's 1900 date base).
	readonly date1904?: DateBase
	readonly locale?: NumFmtLocale
	// The language data a [$-xxxx] tag names (its low 16 bits), when the app has it; else `locale`'s.
	readonly localeFor?: (lcid: number) => NumFmtLocale | undefined
	// Numbers too take the separators of their section's [$-xxxx] language (OpenDocument data styles carry their
	// language's separators; Excel's show the system's whatever the tag).
	readonly lcidSeparators?: boolean
	// General as LibreOffice's "Standard" format shows it (OpenDocument sources), instead of Excel's 11 characters: at
	// most this many decimals, trailing zeros dropped; negative: up to 15 significant digits.
	readonly standardPrecision?: number
	// The workbook's indexed palette (0xRRGGBB) for [ColorN].
	readonly palette?: readonly number[]
}

// What a value shows. Reused between calls (formatInto) so formatting a cell allocates only its text.
export class NumFmtOutput {
	text = ""
	// The section's colour (0xRRGGBB), or -1.
	color = -1
	// "*x": the character repeated to fill the cell and where in `text` it goes; -1 for none. A value the format
	// cannot show (a date out of range) is "" with "#" repeated over the cell, as Excel draws it.
	repeatOffset = -1
	repeatChar = ""
}

const DEFAULT_OPTIONS: NumFmtOptions = {}
const MAX_CACHE = 4096
const cache = new Map<string, NumFmt>()

// The compiled format of a code; each code is compiled once.
export function numFmt(code: string): NumFmt {
	let compiled = cache.get(code)

	if (compiled === undefined) {
		if (cache.size >= MAX_CACHE) cache.clear()

		compiled = parseNumFmt(code)
		cache.set(code, compiled)
	}

	return compiled
}

// Built-in 14 and 22 (ECMA-376 Part 1 §18.8.30) as Excel shows them: in the system's short date ("Date formats that
// begin with an asterisk (*) respond to changes in regional date and time settings", support.microsoft.com "Format
// numbers as dates or times"). Their code stays the table's, which is what files keep.
function systemFormat(code: string, lcid: number): NumFmt {
	const format = parseNumFmt(code)
	const [first, ...rest] = format.sections

	return first === undefined ? format : { ...format, sections: [{ ...first, lcid }, ...rest] }
}

export const SYSTEM_SHORT_DATE: NumFmt = systemFormat("m/d/yyyy", LCID_SYSTEM_SHORT_DATE)
export const SYSTEM_DATE_TIME: NumFmt = systemFormat("m/d/yyyy h:mm", LCID_SYSTEM_DATE_TIME)

// The sections a locale's system patterns compile to, for the last locale asked (sessions hold one).
let systemLocale: NumFmtLocale | null = null
const systemSections: (NumFmtSection | null | undefined)[] = []

function systemSection(lcid: number, locale: NumFmtLocale): NumFmtSection | null {
	if (systemLocale !== locale) {
		systemLocale = locale
		systemSections.length = 0
	}

	const slot = lcid === LCID_SYSTEM_DATE ? 0 : lcid === LCID_SYSTEM_TIME ? 1 : lcid === LCID_SYSTEM_SHORT_DATE ? 2 : 3
	let section = systemSections[slot]

	if (section === undefined) {
		const code =
			slot === 0 ? locale.longDate : slot === 1 ? locale.longTime : slot === 2 ? locale.shortDate : `${locale.shortDate} h:mm`
		const first = parseNumFmt(code).sections[0]

		section = first !== undefined && first.kind === SectionKind.DATE ? first : null
		systemSections[slot] = section
	}

	return section
}

const digitsScratch: Digits = { digits: "", point: 0 }
const dateScratch: DateParts = { year: 0, month: 0, day: 0, weekday: 0 }

function pad(value: number, width: number): string {
	const text = String(value)

	return text.length >= width ? text : "0".repeat(width - text.length) + text
}

// --- General (ECMA-376 Part 1 §18.8.30: at most 11 characters, sign excluded; exponential when a number does
// not fit, or when it shows more digits than the decimal form below 1e-4) ---

function plain(d: Digits, decimal: string): string {
	const integer = integerDigits(d) || "0"
	const fraction = d.point >= 0 ? d.digits.slice(d.point + 1) : "0".repeat(-d.point - 1) + d.digits

	return fraction === "" ? integer : integer + decimal + fraction
}

function exponential(d: Digits, decimal: string): string {
	roundDigits(d, 6)

	const mantissa = d.digits.length > 1 ? d.digits[0] + decimal + d.digits.slice(1) : (d.digits[0] ?? "0")
	const exponent = d.point

	return `${mantissa}E${exponent < 0 ? "-" : "+"}${pad(exponent < 0 ? -exponent : exponent, 2)}`
}

// |value| in General.
export function formatGeneral(value: number, decimal = "."): string {
	const d = decompose(value, digitsScratch)

	if (d.digits === "") return "0"

	const point = d.point

	if (point >= 11) return exponential(d, decimal)

	if (point >= 0) {
		roundDigits(d, point === 10 ? 11 : 10)

		return d.point >= 11 ? exponential(d, decimal) : plain(d, decimal)
	}

	// "0." and the zeros before the first digit leave 10 + point digits.
	const keep = 10 + point

	if (point >= -4) return plain(roundDigits(d, keep), decimal)

	return d.digits.length <= keep ? plain(d, decimal) : exponential(d, decimal)
}

// --- Sections ---

// Which numeric section shows a value, and whether a "-" goes before it.
let pickedMinus = false

function compare(operator: string, left: number, right: number): boolean {
	switch (operator) {
		case "<":
			return left < right
		case "<=":
			return left <= right
		case ">":
			return left > right
		case ">=":
			return left >= right
		case "=":
			return left === right
		default:
			return left !== right
	}
}

// Sections (ECMA-376 Part 1 §18.8.31; MS-OI29500 §2.1.713 a): one for every number, "-" added to negatives; two
// for positives and zero, then negatives; three for positives, negatives, zero. The second and third show the
// absolute value. With conditions ([cond1];[cond2];else, or [cond1];else) the sections are tested in order, an
// unconditioned second of three taking the negatives; a value no section takes shows in General. Only the first
// section adds "-", and not when its condition selects negatives against a second that takes the rest
// ([<0]0;0, [<=0]0;[>0]0.0), as LibreOffice reads them (Excel's documentation does not say).
function pick(format: NumFmt, value: number): NumFmtSection | null {
	const { sections } = format
	const first = sections[0] as NumFmtSection

	pickedMinus = false

	if (!format.conditional) {
		if (sections.length === 1) {
			pickedMinus = value < 0

			return first
		}

		if (value < 0) return sections[1] as NumFmtSection
		if (value === 0 && sections.length === 3) return sections[2] as NumFmtSection

		return first
	}

	for (let i = 0; i < sections.length; i++) {
		const section = sections[i] as NumFmtSection
		const condition = section.condition

		if (condition === null) {
			if (i === 1 && sections.length === 3 && sections[2]?.condition === null && !(value < 0)) continue

			return section
		}

		if (compare(condition.operator, value, condition.value)) {
			if (i === 0) pickedMinus = value < 0 && !firstTakesNegatives(sections)

			return section
		}
	}

	return null
}

// Whether the section `value` shows in scales it by 100 ("%" in a number, scientific or fraction section).
export function showsPercent(format: NumFmt, value: number): boolean {
	const section = pick(format, value)

	return (
		section !== null &&
		section.percent > 0 &&
		(section.kind === SectionKind.NUMBER || section.kind === SectionKind.SCIENTIFIC || section.kind === SectionKind.FRACTION)
	)
}

function firstTakesNegatives(sections: readonly NumFmtSection[]): boolean {
	const first = sections[0]?.condition
	const second = sections[1]?.condition

	if (first === null || first === undefined || first.value !== 0 || (first.operator !== "<" && first.operator !== "<=")) return false

	return sections.length === 1 || (sections.length === 2 && second === null) || (second?.operator === ">" && second.value === 0)
}

// --- Number sections ---

// "?" holds a digit's width: a figure space (U+2007), as LibreOffice shows it, so columns of numbers align.
const DIGIT_SPACE = "\u2007"

// Whether the last number written shows zero (no "-" goes before it, as LibreOffice shows it).
let shownZero = false

function groupDigits(piece: string, count: number, separator: string): { text: string; count: number } {
	let text = ""

	for (let i = piece.length - 1; i >= 0; i--) {
		const ch = piece[i] as string

		text = (count > 0 && count % 3 === 0 ? ch + (ch === DIGIT_SPACE ? " " : separator) : ch) + text
		count++
	}

	return { text, count }
}

// The integer part through its placeholders: digits fill them from the right; what does not fit goes into the
// leftmost one; an empty position shows "0" for "0", a digit's space for "?" and nothing for "#".
function integerPieces(integer: string, pattern: string, grouping: boolean, separator: string): string[] {
	const count = pattern.length
	const pieces = new Array<string>(count)
	const length = integer.length
	let emitted = 0

	for (let j = count - 1; j >= 0; j--) {
		const r = count - 1 - j
		const placeholder = pattern[j]
		let piece = r < length ? (integer[length - 1 - r] as string) : placeholder === "0" ? "0" : placeholder === "?" ? DIGIT_SPACE : ""

		if (j === 0 && length > count) piece = integer.slice(0, length - count) + piece

		if (grouping && piece !== "") {
			const grouped = groupDigits(piece, emitted, separator)

			piece = grouped.text
			emitted = grouped.count
		}

		pieces[j] = piece
	}

	return pieces
}

// The fraction's digits through its placeholders: trailing zeros show as "0", a space or nothing.
function fractionPieces(fraction: string, pattern: string): string[] {
	let last = fraction.length - 1

	while (last >= 0 && fraction.charCodeAt(last) === 48) last--

	const pieces = new Array<string>(pattern.length)

	for (let i = 0; i < pattern.length; i++) {
		const placeholder = pattern[i]

		pieces[i] = i <= last ? (fraction[i] as string) : placeholder === "0" ? "0" : placeholder === "?" ? DIGIT_SPACE : ""
	}

	return pieces
}

interface Builder {
	text: string
	repeatOffset: number
	repeatChar: string
}

const builder: Builder = { text: "", repeatOffset: -1, repeatChar: "" }

function literalOrRepeat(t: Token): void {
	if (t.kind === Tok.REPEAT) {
		if (builder.repeatOffset < 0) {
			builder.repeatOffset = builder.text.length
			builder.repeatChar = t.text
		}
	} else builder.text += t.text
}

function nativeDigits(text: string): string {
	let out = ""

	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i)

		out += c >= 48 && c <= 57 ? String.fromCharCode(0x0e50 + c - 48) : text[i]
	}

	return out
}

// The power of ten "%" and trailing commas scale by: "%" multiplies by 100 however often it appears, as
// LibreOffice reads it; each trailing comma divides by 1000.
function scale(section: NumFmtSection): number {
	return (section.percent > 0 ? 2 : 0) - 3 * section.thousands
}

// The point shows only when a fraction digit or a digit's space follows it (LibreOffice shows 5 through "0." and
// "#.##" as "5").
function point(fraction: readonly string[], decimal: string): string {
	for (const piece of fraction) if (piece !== "") return decimal

	return ""
}

function writeNumber(section: NumFmtSection, value: number, locale: NumFmtLocale): void {
	const d = decompose(value, digitsScratch)

	if (d.digits !== "") d.point += scale(section)

	roundDigits(d, d.point + 1 + section.fractionDigits)
	shownZero = d.digits === ""

	const integer = integerPieces(integerDigits(d), section.patterns.integer, section.grouping, locale.group)
	const fraction = fractionPieces(fractionDigits(d, section.fractionDigits), section.patterns.fraction)
	let integerAt = 0
	let fractionAt = 0
	let afterPoint = false

	for (const t of section.tokens)
		if (t.kind === Tok.DIGIT) builder.text += afterPoint ? fraction[fractionAt++] : integer[integerAt++]
		else if (t.kind === Tok.POINT) {
			afterPoint = true
			builder.text += point(fraction, locale.decimal)
		} else literalOrRepeat(t)
}

function writeScientific(section: NumFmtSection, value: number, locale: NumFmtLocale): void {
	const d = decompose(value, digitsScratch)
	const integerCount = section.integerDigits
	let exponent = 0

	if (d.digits !== "") {
		d.point += scale(section)

		// Two or more integer placeholders put exponents at their multiples ("##0.0E+0": engineering notation).
		const exponentOf = (point: number): number =>
			integerCount > 1 ? Math.floor(point / integerCount) * integerCount : integerCount > 0 ? point - (integerCount - 1) : point + 1

		exponent = exponentOf(d.point)

		const point = d.point

		roundDigits(d, point - exponent + 1 + section.fractionDigits)

		if (d.point !== point) exponent = exponentOf(d.point)

		d.point -= exponent
	}

	shownZero = d.digits === ""

	const integer = integerPieces(integerDigits(d), section.patterns.integer, section.grouping, locale.group)
	const fraction = fractionPieces(fractionDigits(d, section.fractionDigits), section.patterns.fraction)
	const exponentPattern = section.patterns.exponent
	const exponentDigits = integerPieces(String(exponent < 0 ? -exponent : exponent), exponentPattern, false, "")
	let integerAt = 0
	let fractionAt = 0
	let exponentAt = 0
	let part = 0

	for (const t of section.tokens)
		if (t.kind === Tok.DIGIT)
			builder.text += part === 0 ? integer[integerAt++] : part === 1 ? fraction[fractionAt++] : exponentDigits[exponentAt++]
		else if (t.kind === Tok.POINT) {
			part = 1
			builder.text += point(fraction, locale.decimal)
		} else if (t.kind === Tok.EXPONENT) {
			part = 2
			builder.text += (t.text[0] === "e" ? "e" : "E") + (exponent < 0 ? "-" : t.text[1] === "+" ? "+" : "")
		} else literalOrRepeat(t)
}

// The closest p/q with q <= max (continued fractions with the last semiconvergent; the smaller denominator on a
// tie).
function approximate(x: number, max: number): [number, number] {
	let p0 = 0
	let q0 = 1
	let p1 = 1
	let q1 = 0
	let y = x

	for (let step = 0; step < 64; step++) {
		const a = Math.floor(y)
		const p2 = a * p1 + p0
		const q2 = a * q1 + q0

		if (q2 > max) {
			if (q1 === 0) return [Math.round(x), 1]

			const k = Math.floor((max - q0) / q1)
			const pk = p0 + k * p1
			const qk = q0 + k * q1

			return Math.abs(x - pk / qk) < Math.abs(x - p1 / q1) ? [pk, qk] : [p1, q1]
		}

		p0 = p1
		q0 = q1
		p1 = p2
		q1 = q2

		const rest = y - a

		if (rest < 1e-10 || Math.abs(x - p1 / q1) < 1e-15) break

		y = 1 / rest
	}

	return [p1, q1]
}

// Fractions: "?" numerators pad on the left and "?" denominators on the right with digits' spaces. When nothing
// is left after the integer part, the fraction's place stays blank (its placeholders as spaces, a fixed
// denominator dropped), as LibreOffice shows it.
function writeFraction(section: NumFmtSection, value: number, locale: NumFmtLocale): void {
	const shape = section.fraction as NonNullable<NumFmtSection["fraction"]>
	const scaled = ((section.percent > 0 ? 100 : 1) * value) / Math.pow(1000, section.thousands)
	const hasInteger = shape.integerEnd >= 0
	let whole = hasInteger ? Math.floor(scaled) : 0
	const rest = scaled - whole
	let numerator: number
	let denominator: number

	if (shape.fixed > 0) {
		denominator = shape.fixed
		numerator = Math.round(rest * denominator)
	} else [numerator, denominator] = approximate(rest, Math.pow(10, Math.max(1, shape.denominatorDigits)) - 1)

	if (hasInteger && numerator === denominator) {
		whole++
		numerator = 0
	}

	const blank = hasInteger && numerator === 0
	const integer = integerPieces(
		whole === 0 ? (blank ? "0" : "") : String(whole),
		section.patterns.integer,
		section.grouping,
		locale.group
	)
	const numeratorPieces = blank ? [] : integerPieces(String(numerator), section.patterns.numerator, false, "")
	const denominatorText = blank
		? ""
		: shape.fixed > 0
			? String(shape.fixed)
			: denominatorPadded(String(denominator), section.patterns.denominator)
	let integerAt = 0
	let numeratorAt = 0

	shownZero = whole === 0 && numerator === 0

	section.tokens.forEach((t, i) => {
		if (i >= shape.numeratorStart && i < shape.denominatorEnd) {
			if (blank) builder.text += t.kind === Tok.SLASH ? " " : t.kind === Tok.DIGIT && t.text !== "#" ? DIGIT_SPACE : ""
			else if (i < shape.slash) builder.text += t.kind === Tok.DIGIT ? (numeratorPieces[numeratorAt++] as string) : t.text
			else if (i === shape.slash) builder.text += "/"
			else if (i === shape.slash + 1) builder.text += denominatorText

			return
		}

		if (t.kind === Tok.DIGIT) builder.text += integer[integerAt++]
		else literalOrRepeat(t)
	})
}

// A denominator is left-aligned: "?" pads after it with digits' spaces, "0" before it with zeros.
function denominatorPadded(text: string, pattern: string): string {
	let out = text

	for (let i = pattern.length - text.length - 1; i >= 0; i--) {
		const placeholder = pattern[pattern.length - 1 - i]

		if (placeholder === "?") out += DIGIT_SPACE
		else if (placeholder === "0") out = "0" + out
	}

	return out
}

function writeGeneral(section: NumFmtSection, value: number, locale: NumFmtLocale, options: NumFmtOptions): void {
	const text = general(value, locale.decimal, options)

	shownZero = text === "0"

	for (const t of section.tokens)
		if (t.kind === Tok.GENERAL) builder.text += text
		else literalOrRepeat(t)
}

function general(value: number, decimal: string, options: NumFmtOptions): string {
	return options.standardPrecision === undefined
		? formatGeneral(value, decimal)
		: formatStandard(value, options.standardPrecision, decimal)
}

// LibreOffice's "Standard" format (svl SvNumberformat::ImpGetOutputStandard over rtl::math::doubleToUString): with a
// precision, that many decimals with trailing zeros dropped, exponential past 1e15; without one (negative), fifteen
// significant digits, exponential for exponents of 15 and more or -15 and less.
export function formatStandard(value: number, precision: number, decimal = "."): string {
	if (value === 0 || !Number.isFinite(value)) return "0"

	const exponent = Math.floor(Math.log10(Math.abs(value)))
	let text: string

	if (precision >= 0) {
		text = Math.abs(value) > 1e15 ? scientific(value, Math.min(precision, 14)) : stripZeros(value.toFixed(Math.min(precision, 100)))
	} else if (exponent <= -15 || exponent >= 15) {
		text = scientific(value, 14)
	} else {
		const rounded = Number(value.toPrecision(15))

		text = stripZeros(rounded.toFixed(Math.max(0, Math.min(100, 14 - exponent))))
	}

	if (/^-0(\.0*)?$/.test(text)) text = "0"

	return decimal === "." ? text : text.replace(".", decimal)
}

function stripZeros(text: string): string {
	return text.includes(".") ? text.replace(/\.?0+$/, "") : text
}

function scientific(value: number, decimals: number): string {
	const [mantissa = "0", power = "0"] = value.toExponential(decimals).split("e")
	const exponent = Number(power)
	const digits = Math.abs(exponent) < 10 ? `0${String(Math.abs(exponent))}` : String(Math.abs(exponent))

	return `${stripZeros(mantissa)}E${exponent < 0 ? "-" : "+"}${digits}`
}

// --- Dates and times ---

function localeOf(section: NumFmtSection, options: NumFmtOptions, locale: NumFmtLocale): NumFmtLocale {
	if (section.lcid < 0 || systemLcid(section.lcid) || options.localeFor === undefined) return locale

	return options.localeFor(section.lcid) ?? locale
}

// Writes a date section; false when the value is outside the dates the system can show.
function writeDate(section: NumFmtSection, value: number, options: NumFmtOptions, locale: NumFmtLocale): boolean {
	const date1904 = options.date1904 ?? false

	if (!(value >= 0)) return false

	let elapsedUnit = 0

	for (const t of section.tokens)
		if (t.kind === Tok.ELAPSED_HOUR) elapsedUnit = Math.max(elapsedUnit, 3)
		else if (t.kind === Tok.ELAPSED_MINUTE) elapsedUnit = Math.max(elapsedUnit, 2)
		else if (t.kind === Tok.ELAPSED_SECOND) elapsedUnit = Math.max(elapsedUnit, 1)

	// Settled once at the smallest unit shown (the second, or its decimals), then every part comes from that.
	// Elapsed time is rounded (support.microsoft.com "Number format codes": 3735.8 seconds show 62:16 through
	// [mm]:ss). A clock's seconds are cut down (4:36:03.75 PM shows 4:36:03 PM through h:mm:ss A/P); its decimals
	// are rounded unless that reaches the next second, as LibreOffice shows them. A serial means its 15 significant
	// digits, so a time within half of the last of them below a second is that second (23:20 stored as
	// 42123.97222222222 shows 23:20).
	const unit = Math.pow(10, section.subsecond)
	let ticks: number

	if (elapsedUnit > 0) ticks = Math.round(value * 86400 * unit)
	else {
		const exact = value * 86400
		const tolerance = 43200 * Math.pow(10, (value >= 1 ? Math.floor(Math.log10(value)) + 1 : 0) - 15)
		let whole = Math.floor(exact)

		if (exact - whole > 1 - tolerance) whole++

		const fraction = Math.max(0, exact - whole)
		let decimals = fraction > 0 ? Math.round(fraction * unit) : 0

		if (decimals >= unit) decimals = Math.floor(fraction * unit)

		ticks = whole * unit + decimals
	}

	const ticksPerDay = 86400 * unit
	const day = Math.floor(ticks / ticksPerDay)

	if (day > (date1904 === true ? MAX_SERIAL_1904 : MAX_SERIAL_1900)) return false

	const ofDay = ticks - day * ticksPerDay
	const seconds = Math.floor(ofDay / unit)
	const subsecond = ofDay - seconds * unit
	const hour = Math.floor(seconds / 3600)
	const minute = Math.floor((seconds % 3600) / 60)
	const second = seconds % 60
	const date = serialDate(day, date1904, dateScratch)
	const names = localeOf(section, options, locale)

	for (const t of section.tokens)
		switch (t.kind) {
			case Tok.YEAR:
				builder.text += t.count <= 2 ? pad(date.year % 100, 2) : pad(date.year, 4)
				break
			case Tok.BUDDHIST_YEAR:
				builder.text += t.count <= 2 ? pad((date.year + 543) % 100, 2) : String(date.year + 543)
				break
			case Tok.ERA:
				break
			case Tok.MONTH:
				builder.text +=
					t.count === 1
						? String(date.month)
						: t.count === 2
							? pad(date.month, 2)
							: t.count === 3
								? names.monthsShort[date.month - 1]
								: t.count === 4
									? names.months[date.month - 1]
									: (names.months[date.month - 1] ?? "").slice(0, 1)
				break
			case Tok.DAY:
				builder.text +=
					t.count === 1
						? String(date.day)
						: t.count === 2
							? pad(date.day, 2)
							: t.count === 3
								? names.daysShort[date.weekday]
								: names.days[date.weekday]
				break
			case Tok.HOUR: {
				const shown = section.twelveHour ? hour % 12 || 12 : hour

				builder.text += t.count === 1 ? String(shown) : pad(shown, 2)
				break
			}
			case Tok.MINUTE:
				builder.text += t.count === 1 ? String(minute) : pad(minute, 2)
				break
			case Tok.SECOND:
				builder.text += t.count === 1 ? String(second) : pad(second, 2)
				break
			case Tok.ELAPSED_HOUR:
				builder.text += pad(Math.floor(ticks / (3600 * unit)), t.count)
				break
			case Tok.ELAPSED_MINUTE:
				builder.text += pad(elapsedUnit > 2 ? minute : Math.floor(ticks / (60 * unit)), t.count)
				break
			case Tok.ELAPSED_SECOND:
				builder.text += pad(elapsedUnit > 1 ? second : Math.floor(ticks / unit), t.count)
				break
			case Tok.SUBSECOND:
				builder.text += locale.decimal + pad(Math.floor(subsecond / Math.pow(10, section.subsecond - t.count)), t.count)
				break
			case Tok.AMPM:
				builder.text +=
					t.count === 2
						? hour < 12
							? "上午"
							: "下午"
						: t.text.length === 2
							? (t.text[hour < 12 ? 0 : 1] as string)
							: hour < 12
								? names.am
								: names.pm
				break
			default:
				literalOrRepeat(t)
		}

	return true
}

// --- Entry points ---

function begin(out: NumFmtOutput): void {
	builder.text = ""
	builder.repeatOffset = -1
	builder.repeatChar = ""
	out.color = -1
}

function finish(out: NumFmtOutput): NumFmtOutput {
	out.text = builder.text
	out.repeatOffset = builder.repeatOffset
	out.repeatChar = builder.repeatChar

	return out
}

function overflow(out: NumFmtOutput): NumFmtOutput {
	out.text = ""
	out.repeatOffset = 0
	out.repeatChar = "#"

	return out
}

function sectionColor(section: NumFmtSection, options: NumFmtOptions): number {
	if (section.color >= 0) return section.color
	if (section.colorIndex >= 0) return (options.palette ?? DEFAULT_PALETTE)[section.colorIndex] ?? -1

	return -1
}

// A number through a format.
export function formatNumberInto(format: NumFmt, value: number, out: NumFmtOutput, options: NumFmtOptions = DEFAULT_OPTIONS): NumFmtOutput {
	begin(out)

	if (!Number.isFinite(value)) {
		out.text = "#NUM!"
		out.repeatOffset = -1
		out.repeatChar = ""

		return out
	}

	let section = pick(format, value)
	const absolute = value < 0 ? -value : value
	const locale = options.locale ?? NUMFMT_EN_US

	if (section === null) {
		builder.text = general(absolute, locale.decimal, options)

		return finish(out)
	}

	out.color = sectionColor(section, options)

	if (section.kind === SectionKind.DATE && systemLcid(section.lcid)) section = systemSection(section.lcid, locale) ?? section

	const minus = pickedMinus
	const separators = options.lcidSeparators === true ? localeOf(section, options, locale) : locale

	shownZero = true

	switch (section.kind) {
		case SectionKind.DATE:
			if (value < 0 || !writeDate(section, value, options, locale)) return overflow(out)
			break
		case SectionKind.NUMBER:
			writeNumber(section, absolute, separators)
			break
		case SectionKind.SCIENTIFIC:
			writeScientific(section, absolute, separators)
			break
		case SectionKind.FRACTION:
			writeFraction(section, absolute, separators)
			break
		case SectionKind.GENERAL:
			writeGeneral(section, absolute, separators, options)
			break
		default:
			for (const t of section.tokens) if (t.kind !== Tok.TEXT) literalOrRepeat(t)
	}

	if (section.nativeDigits) builder.text = nativeDigits(builder.text)

	// "-" goes first, before any literal ("-$5"); a value shown as zero and a section without a number take none.
	if (minus && !shownZero) {
		builder.text = "-" + builder.text

		if (builder.repeatOffset >= 0) builder.repeatOffset++
	}

	return finish(out)
}

// Text through a format: its text section, if any ("@" is the text); else the text as it is.
export function formatTextInto(format: NumFmt, text: string, out: NumFmtOutput, options: NumFmtOptions = DEFAULT_OPTIONS): NumFmtOutput {
	begin(out)

	const section = format.text

	if (section === null) {
		builder.text = text

		return finish(out)
	}

	out.color = sectionColor(section, options)

	if (section.kind !== SectionKind.TEXT && section.kind !== SectionKind.LITERAL) {
		builder.text = text

		return finish(out)
	}

	for (const t of section.tokens)
		if (t.kind === Tok.TEXT) builder.text += text
		else literalOrRepeat(t)

	return finish(out)
}

export interface NumFmtResult {
	readonly text: string
	readonly color?: number
	readonly repeat?: { readonly offset: number; readonly char: string }
}

// A value through a code (or a compiled format), as a new result. Booleans show TRUE or FALSE whatever the format.
export function formatValue(
	value: number | string | boolean,
	code: string | NumFmt,
	options: NumFmtOptions = DEFAULT_OPTIONS
): NumFmtResult {
	const format = typeof code === "string" ? numFmt(code) : code
	const out = new NumFmtOutput()

	if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE" }

	if (typeof value === "number") formatNumberInto(format, value, out, options)
	else formatTextInto(format, value, out, options)

	return {
		text: out.text,
		...(out.color >= 0 && { color: out.color }),
		...(out.repeatOffset >= 0 && { repeat: { offset: out.repeatOffset, char: out.repeatChar } })
	}
}

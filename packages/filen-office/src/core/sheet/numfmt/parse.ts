// Number format codes (ECMA-376 Part 1 §18.8.31; Excel's grammar: MS-OI29500 §2.1.712 b) compiled once into
// sections of tokens. One left-to-right scan over the code splits the sections and tokenizes them; each section
// is then classified and resolved in passes over its tokens, so compiling is linear in the code's length and no
// regular expression runs over it.

export const Tok = {
	// A literal: quoted text, an escaped or unreserved character, a space for "_x".
	LITERAL: 0,
	// A digit placeholder: "0", "#" or "?" in `text`.
	DIGIT: 1,
	POINT: 2,
	// "," before classification; grouping commas and scaling commas are removed by it.
	COMMA: 3,
	PERCENT: 4,
	// "E+" or "E-" (`text` as written).
	EXPONENT: 5,
	SLASH: 6,
	GENERAL: 7,
	TEXT: 8,
	// "*x": `text` is x.
	REPEAT: 9,
	YEAR: 10,
	// "m" before it is known to be minutes.
	MONTH: 11,
	MINUTE: 12,
	DAY: 13,
	HOUR: 14,
	SECOND: 15,
	// [h], [m], [s]; `count` the letters (the minimum width).
	ELAPSED_HOUR: 16,
	ELAPSED_MINUTE: 17,
	ELAPSED_SECOND: 18,
	// ".0" to ".000" after seconds; `count` the decimals.
	SUBSECOND: 19,
	// AM/PM (`text` "" ) or A/P (`text` the two letters as written, "A" + "P").
	AMPM: 20,
	// "b", "bb", "bbbb": the Buddhist year (Gregorian + 543).
	BUDDHIST_YEAR: 21,
	// "g": the era name (Japanese calendars only; nothing elsewhere).
	ERA: 22
} as const

export type TokKind = (typeof Tok)[keyof typeof Tok]

export interface Token {
	kind: TokKind
	text: string
	// Letters in a date token (yy: 2), decimals in SUBSECOND; for AMPM 1 when written in lower case.
	count: number
}

export const SectionKind = {
	// Literals only (or nothing): shown as written.
	LITERAL: 0,
	NUMBER: 1,
	SCIENTIFIC: 2,
	FRACTION: 3,
	DATE: 4,
	GENERAL: 5,
	TEXT: 6
} as const

export type SectionKindValue = (typeof SectionKind)[keyof typeof SectionKind]

export type ConditionOperator = "<" | "<=" | ">" | ">=" | "=" | "<>"

export interface NumFmtSection {
	readonly kind: SectionKindValue
	readonly tokens: readonly Token[]
	readonly condition: { readonly operator: ConditionOperator; readonly value: number } | null
	// A colour name's 0xRRGGBB, or -1.
	readonly color: number
	// [ColorN]: the palette index (N + 7), or -1.
	readonly colorIndex: number
	// The [$-xxxx] locale id (low 16 bits: the language), or -1.
	readonly lcid: number
	// "t" before the first placeholder (Thai digits).
	readonly nativeDigits: boolean
	// NUMBER, SCIENTIFIC, FRACTION: scale by 100 per "%" and by 1/1000 per trailing ",".
	readonly percent: number
	readonly thousands: number
	readonly grouping: boolean
	// Placeholders in the integer part (mantissa for SCIENTIFIC) and after the point.
	readonly integerDigits: number
	readonly fractionDigits: number
	// FRACTION: the token indexes of the integer part's placeholders, the numerator's and the denominator's
	// (-1 when absent), and a fixed denominator (0 when the denominator is placeholders).
	readonly fraction: {
		readonly integerEnd: number
		readonly numeratorStart: number
		readonly slash: number
		readonly denominatorEnd: number
		readonly denominatorDigits: number
		readonly fixed: number
	} | null
	// The placeholders ("0", "#", "?") of each part, in order.
	readonly patterns: {
		readonly integer: string
		readonly fraction: string
		readonly exponent: string
		readonly numerator: string
		readonly denominator: string
	}
	// DATE: the smallest unit shown is rounded to (0: seconds, 1-3: subsecond decimals); 12-hour clock.
	readonly subsecond: number
	readonly twelveHour: boolean
}

export interface NumFmt {
	readonly code: string
	// The numeric sections (one to three), then the text section when there is one.
	readonly sections: readonly NumFmtSection[]
	readonly text: NumFmtSection | null
	readonly conditional: boolean
	// The first section shows dates or times: an entry typed into the cell is read as a date.
	readonly isDate: boolean
	// The first section is text ("@"): an entry typed into the cell is kept as text.
	readonly isText: boolean
}

const NAMED_COLORS: Readonly<Record<string, number>> = {
	black: 0x000000,
	blue: 0x0000ff,
	cyan: 0x00ffff,
	green: 0x00ff00,
	magenta: 0xff00ff,
	red: 0xff0000,
	white: 0xffffff,
	yellow: 0xffff00
}

// The system long date and time locale ids (Excel writes [$-F800] or [$-x-sysdate], [$-F400] or [$-x-systime]).
export const LCID_SYSTEM_DATE = 0xf800
export const LCID_SYSTEM_TIME = 0xf400
// Built-in 14 and 22 as SheetStyles hands them out: the system short date (and time). Past 16 bits, so no code can
// name them.
export const LCID_SYSTEM_SHORT_DATE = 0x10000
export const LCID_SYSTEM_DATE_TIME = 0x10001

// A locale id the system's patterns stand for.
export function systemLcid(lcid: number): boolean {
	return lcid === LCID_SYSTEM_DATE || lcid === LCID_SYSTEM_TIME || lcid === LCID_SYSTEM_SHORT_DATE || lcid === LCID_SYSTEM_DATE_TIME
}

// Thai date letters (the th-TH built-ins): day, month, year, hour, minute, second.
const THAI_DATE: Readonly<Record<string, TokKind>> = {
	ว: Tok.DAY,
	ด: Tok.MONTH,
	ป: Tok.YEAR,
	ช: Tok.HOUR,
	น: Tok.MINUTE,
	ท: Tok.SECOND
}

const MAX_SECTIONS = 4

interface SectionDraft {
	tokens: Token[]
	condition: { operator: ConditionOperator; value: number } | null
	color: number
	colorIndex: number
	lcid: number
	nativeDigits: boolean
}

function draft(): SectionDraft {
	return { tokens: [], condition: null, color: -1, colorIndex: -1, lcid: -1, nativeDigits: false }
}

function token(kind: TokKind, text = "", count = 0): Token {
	return { kind, text, count }
}

function lower(code: number): number {
	return code >= 65 && code <= 90 ? code + 32 : code
}

function isHex(text: string): boolean {
	if (text.length === 0 || text.length > 8) return false

	for (let i = 0; i < text.length; i++) {
		const c = lower(text.charCodeAt(i))

		if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false
	}

	return true
}

// The contents of one [...] (without brackets).
function bracket(content: string, section: SectionDraft): void {
	if (content.length === 0) return

	const first = content[0]

	if (first === "$") {
		const body = content.slice(1)
		const extension = body.toLowerCase().indexOf("-x-")

		// BCP 47 private-use tags (Excel 2016 on): [$-x-sysdate], [$-x-systime], [$€-x-euro2].
		if (extension >= 0) {
			const tag = body.slice(extension + 3).toLowerCase()

			if (tag === "sysdate") section.lcid = LCID_SYSTEM_DATE
			else if (tag === "systime") section.lcid = LCID_SYSTEM_TIME

			if (extension > 0) section.tokens.push(token(Tok.LITERAL, body.slice(0, extension)))

			return
		}

		const dash = body.lastIndexOf("-")
		let currency = body

		if (dash >= 0 && isHex(body.slice(dash + 1))) {
			section.lcid = parseInt(body.slice(dash + 1), 16) & 0xffff
			currency = body.slice(0, dash)
		}

		if (currency !== "") section.tokens.push(token(Tok.LITERAL, currency))

		return
	}

	if (first === "<" || first === ">" || first === "=") {
		let operator: ConditionOperator = first
		let at = 1
		const second = content[1]

		if (first === "<" && (second === "=" || second === ">")) {
			operator = second === "=" ? "<=" : "<>"
			at = 2
		} else if (first === ">" && second === "=") {
			operator = ">="
			at = 2
		}

		const value = Number(content.slice(at).trim())

		if (!Number.isNaN(value)) section.condition = { operator, value }

		return
	}

	const name = content.toLowerCase()
	const named = NAMED_COLORS[name]

	if (named !== undefined) {
		section.color = named

		return
	}

	if (name.startsWith("color")) {
		const index = Number(name.slice(5))

		if (Number.isInteger(index) && index >= 1 && index <= 56) section.colorIndex = index + 7

		return
	}

	const letter = name[0]
	let same = true

	for (let i = 1; i < name.length; i++) if (name[i] !== letter) same = false

	if (same && (letter === "h" || letter === "m" || letter === "s"))
		section.tokens.push(
			token(letter === "h" ? Tok.ELAPSED_HOUR : letter === "m" ? Tok.ELAPSED_MINUTE : Tok.ELAPSED_SECOND, "", name.length)
		)
	else if (content === "ช") section.tokens.push(token(Tok.ELAPSED_HOUR, "", 1))
	// Other bracketed codes (DBNum, NatNum, calendars) change digits or calendars this formatter does not show.
}

function startsWithIgnoringCase(code: string, at: number, word: string): boolean {
	if (at + word.length > code.length) return false

	for (let i = 0; i < word.length; i++) if (lower(code.charCodeAt(at + i)) !== word.charCodeAt(i)) return false

	return true
}

// Splits and tokenizes in one pass.
function scan(code: string): SectionDraft[] {
	const sections: SectionDraft[] = [draft()]
	let section = sections[0] as SectionDraft
	const length = code.length
	let i = 0
	let hasDigit = false
	// No "]" at or after this index: an unclosed "[" is then a literal without searching again.
	let unclosedFrom = length + 1

	const push = (kind: TokKind, text = "", count = 0): void => {
		section.tokens.push(token(kind, text, count))
	}

	// A run of one letter, case-insensitively.
	const run = (letter: number): number => {
		let end = i + 1

		while (end < length && lower(code.charCodeAt(end)) === letter) end++

		return end - i
	}

	while (i < length) {
		const ch = code[i] as string
		const c = lower(code.charCodeAt(i))

		switch (ch) {
			case ";":
				if (sections.length >= MAX_SECTIONS) return sections
				section = draft()
				sections.push(section)
				hasDigit = false
				i++
				continue
			case '"': {
				const close = code.indexOf('"', i + 1)
				const end = close < 0 ? length : close

				push(Tok.LITERAL, code.slice(i + 1, end))
				i = end + 1
				continue
			}
			case "\\":
				if (i + 1 < length) push(Tok.LITERAL, code[i + 1])
				i += 2
				continue
			case "_":
				if (i + 1 < length) push(Tok.LITERAL, " ")
				i += 2
				continue
			case "*":
				if (i + 1 < length) push(Tok.REPEAT, code[i + 1])
				i += 2
				continue
			case "[": {
				const close = i + 1 >= unclosedFrom ? -1 : code.indexOf("]", i + 1)

				if (close < 0) {
					unclosedFrom = i + 1
					push(Tok.LITERAL, "[")
					i++
					continue
				}

				bracket(code.slice(i + 1, close), section)
				i = close + 1
				continue
			}
			case "0":
			case "#":
			case "?":
				push(Tok.DIGIT, ch)
				hasDigit = true
				i++
				continue
			case ".":
				push(Tok.POINT)
				i++
				continue
			case ",":
				push(Tok.COMMA)
				i++
				continue
			case "%":
				push(Tok.PERCENT)
				i++
				continue
			case "/":
				push(Tok.SLASH)
				i++
				continue
			case "@":
				push(Tok.TEXT)
				i++
				continue
		}

		// Letters: codes are case-insensitive, except that AM/PM and A/P show as written.
		if (c === 101 && (code[i + 1] === "+" || code[i + 1] === "-") && hasDigit) {
			push(Tok.EXPONENT, code.slice(i, i + 2))
			i += 2
			continue
		}

		if (c === 103 && startsWithIgnoringCase(code, i, "general")) {
			push(Tok.GENERAL)
			i += 7
			continue
		}

		if (c === 97) {
			if (startsWithIgnoringCase(code, i, "am/pm")) {
				push(Tok.AMPM, "", code.charCodeAt(i) === 97 ? 1 : 0)
				i += 5
				continue
			}

			if (startsWithIgnoringCase(code, i, "a/p")) {
				push(Tok.AMPM, (code[i] as string) + (code[i + 2] as string), 0)
				i += 3
				continue
			}
		}

		if (ch === "上" && code.startsWith("上午/下午", i)) {
			push(Tok.AMPM, "上下", 2)
			i += 5
			continue
		}

		if (ch === "t" && section.tokens.length === 0 && (code[i + 1] === "0" || code[i + 1] === "#" || code[i + 1] === "?")) {
			section.nativeDigits = true
			i++
			continue
		}

		if (c === 121 || c === 109 || c === 100 || c === 104 || c === 115) {
			const count = run(c)
			const kind = c === 121 ? Tok.YEAR : c === 109 ? Tok.MONTH : c === 100 ? Tok.DAY : c === 104 ? Tok.HOUR : Tok.SECOND

			push(kind, "", count)
			i += count
			continue
		}

		if (c === 101) {
			// "e": the era's year; Gregorian outside Japanese and Taiwanese calendars (MS-OI29500 §2.1.713 f).
			const count = run(c)

			push(Tok.YEAR, "", 4)
			i += count
			continue
		}

		if (c === 98) {
			if (code[i + 1] === "1" || code[i + 1] === "2") {
				// B1 / B2: the Gregorian or Hijri calendar.
				i += 2
				continue
			}

			const count = run(c)

			push(Tok.BUDDHIST_YEAR, "", count <= 2 ? 2 : 4)
			i += count
			continue
		}

		if (c === 103) {
			const count = run(c)

			push(Tok.ERA, "", count)
			i += count
			continue
		}

		const thai = THAI_DATE[ch]

		if (thai !== undefined) {
			let end = i + 1

			while (end < length && code[end] === ch) end++

			push(thai, "", end - i)
			i = end
			continue
		}

		push(Tok.LITERAL, ch)
		i++
	}

	return sections
}

const DATE_KINDS: ReadonlySet<TokKind> = new Set<TokKind>([
	Tok.YEAR,
	Tok.MONTH,
	Tok.MINUTE,
	Tok.DAY,
	Tok.HOUR,
	Tok.SECOND,
	Tok.ELAPSED_HOUR,
	Tok.ELAPSED_MINUTE,
	Tok.ELAPSED_SECOND,
	Tok.BUDDHIST_YEAR,
	Tok.ERA
])

function literal(tokenOf: Token): Token {
	switch (tokenOf.kind) {
		case Tok.DIGIT:
			return token(Tok.LITERAL, tokenOf.text)
		case Tok.POINT:
			return token(Tok.LITERAL, ".")
		case Tok.COMMA:
			return token(Tok.LITERAL, ",")
		case Tok.PERCENT:
			return token(Tok.LITERAL, "%")
		case Tok.SLASH:
			return token(Tok.LITERAL, "/")
		case Tok.EXPONENT:
			return token(Tok.LITERAL, tokenOf.text)
		default:
			return tokenOf
	}
}

// Dates: "m" after an hour or before a second is minutes (support.microsoft.com "Number format codes"); a point
// followed by zeros after seconds is a fraction of a second; placeholders and the rest show as written.
function resolveDate(tokens: Token[]): { tokens: Token[]; subsecond: number; twelveHour: boolean } {
	const out: Token[] = []
	let subsecond = 0
	let twelveHour = false

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i] as Token

		if (t.kind === Tok.POINT) {
			const previous = out.length > 0 ? (out[out.length - 1] as Token) : undefined
			let zeros = 0

			while (i + 1 + zeros < tokens.length && tokens[i + 1 + zeros]?.kind === Tok.DIGIT && tokens[i + 1 + zeros]?.text === "0")
				zeros++

			if (previous !== undefined && (previous.kind === Tok.SECOND || previous.kind === Tok.ELAPSED_SECOND) && zeros > 0) {
				const count = Math.min(zeros, 3)

				out.push(token(Tok.SUBSECOND, "", count))

				for (let extra = count; extra < zeros; extra++) out.push(token(Tok.LITERAL, "0"))

				subsecond = Math.max(subsecond, count)
				i += zeros
				continue
			}
		}

		if (t.kind === Tok.AMPM) twelveHour = true

		out.push(DATE_KINDS.has(t.kind) || t.kind === Tok.AMPM || t.kind === Tok.LITERAL || t.kind === Tok.REPEAT ? t : literal(t))
	}

	// Minutes: an "m" or "mm" whose previous date part is an hour, or whose next is a second.
	let previous = -1

	for (let i = 0; i < out.length; i++) {
		const t = out[i] as Token

		if (!DATE_KINDS.has(t.kind)) continue

		if (t.kind === Tok.MONTH && t.count <= 2) {
			const before = previous < 0 ? undefined : (out[previous] as Token).kind
			let next: TokKind | undefined

			for (let j = i + 1; j < out.length; j++) {
				const kind = (out[j] as Token).kind

				if (DATE_KINDS.has(kind)) {
					next = kind
					break
				}
			}

			if (
				before === Tok.HOUR ||
				before === Tok.ELAPSED_HOUR ||
				next === Tok.SECOND ||
				next === Tok.ELAPSED_SECOND ||
				(next === undefined && before === Tok.ELAPSED_MINUTE)
			)
				t.kind = Tok.MINUTE
		}

		previous = i
	}

	return { tokens: out, subsecond, twelveHour }
}

interface NumberShape {
	tokens: Token[]
	percent: number
	thousands: number
	grouping: boolean
	integerDigits: number
	fractionDigits: number
}

// Commas: a run right after a placeholder and not before one divides by 1000 per comma (after the integer part or
// the fraction: "#,", "0.0,,"); one inside the integer part's placeholders groups thousands. Other commas, points
// after the first and anything after the exponent's placeholders show as written.
function resolveNumber(tokens: readonly Token[], scientific: boolean): NumberShape {
	const out: Token[] = []
	let percent = 0
	let thousands = 0
	let grouping = false
	let integerDigits = 0
	let fractionDigits = 0
	let seenPoint = false
	let seenExponent = false
	// Whether a placeholder of the integer part follows index i (before a point or the exponent).
	const digitAfter = new Uint8Array(tokens.length + 1)

	for (let i = tokens.length - 1; i >= 0; i--) {
		const kind = (tokens[i] as Token).kind

		digitAfter[i] = kind === Tok.POINT || kind === Tok.EXPONENT ? 0 : kind === Tok.DIGIT ? 1 : (digitAfter[i + 1] as number)
	}

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i] as Token

		switch (t.kind) {
			case Tok.DIGIT:
				if (seenExponent) out.push(t)
				else if (seenPoint) {
					fractionDigits++
					out.push(t)
				} else {
					integerDigits++
					out.push(t)
				}
				break
			case Tok.POINT:
				if (seenPoint || seenExponent) out.push(literal(t))
				else {
					seenPoint = true
					out.push(t)
				}
				break
			case Tok.COMMA: {
				let end = i

				while (tokens[end + 1]?.kind === Tok.COMMA) end++

				const afterDigit = tokens[i - 1]?.kind === Tok.DIGIT
				const beforeDigit = tokens[end + 1]?.kind === Tok.DIGIT

				if (seenExponent) for (let k = i; k <= end; k++) out.push(token(Tok.LITERAL, ","))
				else if (afterDigit && !beforeDigit) thousands += end - i + 1
				else if (!seenPoint && integerDigits > 0 && digitAfter[end + 1] === 1) grouping = true
				else for (let k = i; k <= end; k++) out.push(token(Tok.LITERAL, ","))

				i = end
				break
			}
			case Tok.PERCENT:
				percent++
				out.push(token(Tok.LITERAL, "%"))
				break
			case Tok.EXPONENT:
				if (scientific && !seenExponent) {
					seenExponent = true
					out.push(t)
				} else out.push(literal(t))
				break
			case Tok.SLASH:
				out.push(literal(t))
				break
			default:
				out.push(t)
		}
	}

	return { tokens: out, percent, thousands, grouping, integerDigits, fractionDigits }
}

// "/" is a fraction when a placeholder precedes it and a placeholder or a digit follows (MS-OI29500 §2.1.713 d).
function fractionSlash(tokens: readonly Token[]): number {
	for (let i = 1; i < tokens.length - 1; i++) {
		if ((tokens[i] as Token).kind !== Tok.SLASH || (tokens[i - 1] as Token).kind !== Tok.DIGIT) continue

		const next = tokens[i + 1] as Token

		if (next.kind === Tok.DIGIT || (next.kind === Tok.LITERAL && next.text >= "1" && next.text <= "9" && next.text.length === 1))
			return i
	}

	return -1
}

interface FractionShape {
	tokens: Token[]
	percent: number
	thousands: number
	grouping: boolean
	integerDigits: number
	fraction: NonNullable<NumFmtSection["fraction"]>
}

function resolveFraction(tokens: readonly Token[], slash: number): FractionShape {
	// Numerator: the placeholders right before the slash; integer part: placeholders before those, apart from them.
	let numeratorStart = slash

	while (numeratorStart > 0 && (tokens[numeratorStart - 1] as Token).kind === Tok.DIGIT) numeratorStart--

	let integerEnd = -1

	for (let i = numeratorStart - 1; i >= 0; i--)
		if ((tokens[i] as Token).kind === Tok.DIGIT) {
			integerEnd = i + 1
			break
		}

	// Denominator: placeholders, or a fixed number (literal digits, its zeros scanned as placeholders).
	let denominatorEnd = slash + 1
	let fixed = 0
	const first = tokens[slash + 1] as Token

	if (first.kind === Tok.LITERAL) {
		let text = ""

		while (denominatorEnd < tokens.length) {
			const t = tokens[denominatorEnd] as Token
			const digit = t.kind === Tok.LITERAL && t.text.length === 1 && t.text >= "0" && t.text <= "9"

			if (!digit && !(t.kind === Tok.DIGIT && t.text === "0")) break

			text += t.text
			denominatorEnd++
		}

		fixed = Number(text)
	} else while (denominatorEnd < tokens.length && (tokens[denominatorEnd] as Token).kind === Tok.DIGIT) denominatorEnd++

	const out: Token[] = []
	// Old token index -> index in `out` (tokens.length maps to out.length).
	const map = new Int32Array(tokens.length + 1)
	let percent = 0
	let thousands = 0
	let grouping = false
	let integerDigits = 0

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i] as Token

		map[i] = out.length

		if (i >= numeratorStart && i < denominatorEnd) {
			out.push(t.kind === Tok.DIGIT || t.kind === Tok.SLASH ? t : literal(t))
			continue
		}

		switch (t.kind) {
			case Tok.DIGIT:
				if (i < integerEnd) {
					integerDigits++
					out.push(t)
				} else out.push(literal(t))
				break
			case Tok.COMMA:
				if (i < integerEnd && integerDigits > 0) grouping = true
				else if ((tokens[i - 1]?.kind === Tok.DIGIT || tokens[i - 1]?.kind === Tok.COMMA) && i >= denominatorEnd) thousands++
				else out.push(literal(t))
				break
			case Tok.PERCENT:
				percent++
				out.push(token(Tok.LITERAL, "%"))
				break
			default:
				out.push(literal(t))
		}
	}

	map[tokens.length] = out.length

	return {
		tokens: out,
		percent,
		thousands,
		grouping,
		integerDigits,
		fraction: {
			integerEnd: integerEnd < 0 ? -1 : (map[integerEnd] as number),
			numeratorStart: map[numeratorStart] as number,
			slash: map[slash] as number,
			denominatorEnd: map[denominatorEnd] as number,
			denominatorDigits: fixed > 0 ? 0 : denominatorEnd - slash - 1,
			fixed
		}
	}
}

const NO_PATTERNS: NumFmtSection["patterns"] = { integer: "", fraction: "", exponent: "", numerator: "", denominator: "" }

function numberPatterns(tokens: readonly Token[]): NumFmtSection["patterns"] {
	let integer = ""
	let fraction = ""
	let exponent = ""
	let part = 0

	for (const t of tokens)
		if (t.kind === Tok.POINT && part === 0) part = 1
		else if (t.kind === Tok.EXPONENT) part = 2
		else if (t.kind === Tok.DIGIT)
			if (part === 0) integer += t.text
			else if (part === 1) fraction += t.text
			else exponent += t.text

	return { integer, fraction, exponent, numerator: "", denominator: "" }
}

function fractionPatterns(tokens: readonly Token[], fraction: NonNullable<NumFmtSection["fraction"]>): NumFmtSection["patterns"] {
	let integer = ""
	let numerator = ""
	let denominator = ""

	tokens.forEach((t, i) => {
		if (t.kind !== Tok.DIGIT) return
		if (i < fraction.numeratorStart) integer += t.text
		else if (i < fraction.slash) numerator += t.text
		else if (i < fraction.denominatorEnd) denominator += t.text
	})

	return { integer, fraction: "", exponent: "", numerator, denominator: fraction.fixed > 0 ? "" : denominator }
}

function compileSection(section: SectionDraft): NumFmtSection {
	const { tokens } = section
	let date = false
	let general = false
	let text = false
	let digits = false
	let exponent = false

	for (const t of tokens) {
		if (DATE_KINDS.has(t.kind)) date = true
		else if (t.kind === Tok.GENERAL) general = true
		else if (t.kind === Tok.TEXT) text = true
		else if (t.kind === Tok.DIGIT) digits = true
		else if (t.kind === Tok.EXPONENT) exponent = true
	}

	const base = {
		condition: section.condition,
		color: section.color,
		colorIndex: section.colorIndex,
		lcid: section.lcid,
		nativeDigits: section.nativeDigits,
		percent: 0,
		thousands: 0,
		grouping: false,
		integerDigits: 0,
		fractionDigits: 0,
		fraction: null,
		patterns: NO_PATTERNS,
		subsecond: 0,
		twelveHour: false
	}

	if (date) {
		const resolved = resolveDate(tokens)

		return { ...base, kind: SectionKind.DATE, ...resolved }
	}

	if (general)
		return {
			...base,
			kind: SectionKind.GENERAL,
			tokens: tokens.map(t => (t.kind === Tok.AMPM ? token(Tok.LITERAL, "AM/PM") : literal(t)))
		}

	if (text) return { ...base, kind: SectionKind.TEXT, tokens: tokens.map(t => (t.kind === Tok.TEXT ? t : literal(t))) }

	if (!digits)
		return {
			...base,
			kind: SectionKind.LITERAL,
			tokens: tokens.map(t => (t.kind === Tok.REPEAT ? t : t.kind === Tok.AMPM ? token(Tok.LITERAL, "AM/PM") : literal(t)))
		}

	const slash = exponent ? -1 : fractionSlash(tokens)

	if (slash >= 0) {
		const shape = resolveFraction(tokens, slash)

		return {
			...base,
			kind: SectionKind.FRACTION,
			tokens: shape.tokens,
			percent: shape.percent,
			thousands: shape.thousands,
			grouping: shape.grouping,
			integerDigits: shape.integerDigits,
			fraction: shape.fraction,
			patterns: fractionPatterns(shape.tokens, shape.fraction)
		}
	}

	const shape = resolveNumber(tokens, exponent)

	return {
		...base,
		kind: exponent ? SectionKind.SCIENTIFIC : SectionKind.NUMBER,
		tokens: shape.tokens.map(t => (t.kind === Tok.AMPM ? token(Tok.LITERAL, "AM/PM") : t)),
		percent: shape.percent,
		thousands: shape.thousands,
		grouping: shape.grouping,
		integerDigits: shape.integerDigits,
		fractionDigits: shape.fractionDigits,
		patterns: numberPatterns(shape.tokens)
	}
}

// Compiles a code. Never throws: anything it does not know shows as written.
export function parseNumFmt(code: string): NumFmt {
	const drafts = scan(code)
	const compiled = drafts.map(compileSection)
	let text: NumFmtSection | null = null
	let sections = compiled

	// The fourth section is text's; so is a last section that shows "@" (MS-OI29500 §2.1.712 b: NFText).
	if (compiled.length === 4) {
		text = compiled[3] as NumFmtSection
		sections = compiled.slice(0, 3)
	} else if (compiled.length > 1 && compiled[compiled.length - 1]?.kind === SectionKind.TEXT) {
		text = compiled[compiled.length - 1] as NumFmtSection
		sections = compiled.slice(0, -1)
	} else if (compiled.length === 1 && compiled[0]?.kind === SectionKind.TEXT) {
		text = compiled[0]
		sections = [{ ...compiled[0], kind: SectionKind.GENERAL, tokens: [token(Tok.GENERAL)] }]
	}

	const first = compiled[0] as NumFmtSection

	return {
		code,
		sections,
		text,
		conditional: sections.some(section => section.condition !== null),
		isDate: first.kind === SectionKind.DATE,
		isText: first.kind === SectionKind.TEXT
	}
}

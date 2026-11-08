import { languageTag, pictureDate } from "../forms/dates"

// Field codes (ECMA-376 Part 1 §17.16.1): the instruction parsed into its type, arguments and switches, the
// general formatting switches \* that change case (§17.16.4.3) and DATE/TIME results under a \@ date-time picture
// (§17.16.4.1). Shared by field updates (evaluate.ts) and layout (layout/fields.ts), which draws DATE and TIME
// from the clock as Word does on open.

// ---- field codes ------------------------------------------------------------------------------------------

export interface FieldSwitch {
	// The switch character: "*", "#", "@", "!" or a letter as written.
	readonly name: string
	readonly arg: string | undefined
}

export interface FieldCode {
	// Upper case ("PAGEREF"); "" when the instruction is empty.
	readonly type: string
	readonly args: readonly string[]
	readonly switches: readonly FieldSwitch[]
}

// Field-specific switches that take an argument, per field type (the general ones always do).
const ARGUMENT_SWITCHES: Readonly<Record<string, string>> = {
	TOC: "abcdflnopst",
	SEQ: "rs",
	REF: "d",
	HYPERLINK: "lmot",
	STYLEREF: "",
	PAGEREF: "",
	NOTEREF: "",
	DATE: "",
	TIME: ""
}

interface Token {
	readonly value: string
	readonly quoted: boolean
	readonly switch: boolean
}

function tokenize(instruction: string): Token[] {
	const out: Token[] = []
	const length = instruction.length
	let at = 0

	while (at < length) {
		const char = instruction[at] ?? ""

		if (/\s/.test(char)) {
			at++

			continue
		}

		if (char === '"') {
			let value = ""

			at++

			while (at < length && instruction[at] !== '"') {
				const next = instruction[at + 1]

				// Inside quotes a backslash escapes a quote or a backslash (§17.16.1).
				if (instruction[at] === "\\" && (next === '"' || next === "\\")) {
					value += next
					at += 2
				} else {
					value += instruction[at] ?? ""
					at++
				}
			}

			at++
			out.push({ value, quoted: true, switch: false })

			continue
		}

		if (char === "\\" && at + 1 < length) {
			out.push({ value: instruction[at + 1] ?? "", quoted: false, switch: true })
			at += 2

			continue
		}

		let end = at

		while (end < length && !/\s/.test(instruction[end] ?? "")) end++

		out.push({ value: instruction.slice(at, end), quoted: false, switch: false })
		at = end
	}

	return out
}

const CODES = new Map<string, FieldCode>()

export function parseFieldCode(instruction: string): FieldCode {
	const cached = CODES.get(instruction)

	if (cached !== undefined) return cached

	const tokens = tokenize(instruction)
	const first = tokens[0]
	const type = first === undefined || first.switch ? "" : first.value.toUpperCase()
	const own = ARGUMENT_SWITCHES[type] ?? ""
	const args: string[] = []
	const switches: FieldSwitch[] = []

	for (let index = type === "" ? 0 : 1; index < tokens.length; index++) {
		const token = tokens[index] as Token

		if (!token.switch) {
			args.push(token.value)

			continue
		}

		const name = token.value
		const next = tokens[index + 1]
		const takes = name === "*" || name === "#" || name === "@" || own.includes(name.toLowerCase())

		if (takes && next !== undefined && !next.switch) {
			switches.push({ name, arg: next.value })
			index++
		} else {
			switches.push({ name, arg: undefined })
		}
	}

	const code: FieldCode = Object.freeze({ type, args: Object.freeze(args), switches: Object.freeze(switches) })

	if (CODES.size > 4096) CODES.clear()

	CODES.set(instruction, code)

	return code
}

// A switch by its character (letters match in either case).
export function switchOf(code: FieldCode, name: string): FieldSwitch | undefined {
	const lower = name.toLowerCase()

	return code.switches.find(item => item.name.toLowerCase() === lower)
}

export function hasSwitch(code: FieldCode, name: string): boolean {
	return switchOf(code, name) !== undefined
}

// The \* arguments, in order.
export function generalSwitches(code: FieldCode): string[] {
	return code.switches.filter(item => item.name === "*" && item.arg !== undefined).map(item => item.arg as string)
}

// Whether a \* MERGEFORMAT switch asks for the previous result's formatting (§17.16.4.3).
export function mergeFormat(code: FieldCode): boolean {
	return generalSwitches(code).some(name => name.toUpperCase() === "MERGEFORMAT")
}

// ---- formatting -------------------------------------------------------------------------------------------

// \* Upper, Lower, FirstCap and Caps (§17.16.4.3), applied to a result in the order written.
export function caseFormat(text: string, code: FieldCode): string {
	let out = text

	for (const name of generalSwitches(code)) {
		switch (name.toLowerCase()) {
			case "upper":
				out = out.toUpperCase()

				break
			case "lower":
				out = out.toLowerCase()

				break
			case "firstcap":
				out = out.replace(/\p{L}/u, letter => letter.toUpperCase())

				break
			case "caps":
				out = out.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_match, before: string, letter: string) => before + letter.toUpperCase())

				break
		}
	}

	return out
}

// Word's defaults when no \@ is given: the en-US short date and time.
export const DEFAULT_DATE_PICTURE = "M/d/yyyy"
export const DEFAULT_TIME_PICTURE = "h:mm am/pm"

// A date under a \@ date-time picture (§17.16.4.1), read as a date control's picture is (forms/dates.ts
// pictureDate): `date`'s local day and time, month and day names in `language` (the field's w:lang), in `calendar`
// (\h hijri, \s saka; Gregorian without), AM/PM as the user's regional settings have it. Era items (g, e, aaa) are
// the Japanese imperial calendar's in a Japanese field (`eastAsia`, its w:lang/@w:eastAsia, else `language`, is
// ja); in any other, they and B are literal characters.
export function datePicture(date: Date, picture: string, language?: string, calendar?: string, eastAsia?: string): string {
	const japanese = /^ja(?:-|$)/i.test(languageTag(eastAsia ?? language ?? "") ?? "")

	return pictureDate(
		new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())),
		{ hours: date.getHours(), minutes: date.getMinutes(), seconds: date.getSeconds() },
		picture,
		language ?? null,
		calendar ?? null,
		japanese ? "japanese" : "literal"
	)
}

// The calendar a DATE or TIME field shows its date in: \h Hijri, \s Saka (§17.16.4.1), else Gregorian.
function fieldCalendar(code: FieldCode): string | undefined {
	return hasSwitch(code, "h") ? "hijri" : hasSwitch(code, "s") ? "saka" : undefined
}

// A DATE or TIME field's result at `now` (§17.16.5.16, §17.16.5.69): its \@ picture (else the en-US default), \h or
// \s calendar and \* case switches, in the field's language (`language`, `eastAsia`: its w:lang).
export function dateTimeResult(code: FieldCode, now: Date, language: string | undefined, eastAsia: string | undefined): string {
	const picture = switchOf(code, "@")?.arg ?? (code.type === "TIME" ? DEFAULT_TIME_PICTURE : DEFAULT_DATE_PICTURE)

	return caseFormat(datePicture(now, picture, language, fieldCalendar(code), eastAsia), code)
}

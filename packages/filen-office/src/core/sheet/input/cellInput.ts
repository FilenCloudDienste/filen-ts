import type { SheetLocale } from "../protocol"
import { wellFormedFormula } from "../refs/formulaRefs"
import { delocalizeFormula, entryNumber, formulaTextDate, localizedDateFormat, orderedDateFormat, type LocalizedDate } from "./locale"

// What a typed entry becomes, the way spreadsheets read it: a leading "=" starts a formula, a leading "'"
// keeps the rest as text whatever it looks like, and otherwise numbers, times, TRUE/FALSE and dates are recognised,
// with the format they imply for a cell that has none. Anything else is text, as typed. A date's time of day is
// its UTC time.
export type ParsedInput =
	| { type: "empty" }
	| { type: "formula"; formula: string }
	| { type: "value"; value: string | number | boolean | Date; impliedFormat?: string }

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i
const GROUPED = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/
const PERCENT = /^[-+]?(\d+\.?\d*|\.\d+)%$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](.+)$/
// 13:30, 25:00 (hours past a day), 9:05:30.
const TIME = /^(\d{1,4}):(\d{2})(?::(\d{2}))?$/
// 2:30 PM, 9:30am, 2 p.
const HALF_DAY_TIME = /^(\d{1,2})(?::(\d{2})(?::(\d{2}))?)? ?([ap])m?$/i
const DATE_TOKENS = /\d+|[a-z]+/gi
const SECONDS_PER_DAY = 86_400
// Excel's largest elapsed time typed (9999:59:59).
const MAX_HOURS = 9999

interface TimeEntry {
	readonly seconds: number
	readonly format: string
	// More hours than a day holds: a duration, never after a date.
	readonly elapsed: boolean
}

// A time as Excel reads one typed (support.microsoft.com "Enter a time"): hours and minutes, seconds optional, on a
// 24-hour clock (h:mm), with more hours than a day as an elapsed time ([h]:mm:ss), or with AM/PM, A or P after it
// (h:mm AM/PM). Null for anything else.
function timeEntry(text: string): TimeEntry | null {
	const clock = TIME.exec(text)

	if (clock !== null) {
		const [, hourText = "", minuteText = "", secondText] = clock
		const hours = Number(hourText)
		const minutes = Number(minuteText)
		const seconds = secondText === undefined ? 0 : Number(secondText)

		if (hours > MAX_HOURS || minutes > 59 || seconds > 59) return null

		const elapsed = hours > 23

		return {
			seconds: hours * 3600 + minutes * 60 + seconds,
			format: elapsed ? "[h]:mm:ss" : secondText === undefined ? "h:mm" : "h:mm:ss",
			elapsed
		}
	}

	const halfDay = HALF_DAY_TIME.exec(text)

	if (halfDay === null) return null

	const [, hourText = "", minuteText, secondText, half = ""] = halfDay
	const hours = Number(hourText)
	const minutes = minuteText === undefined ? 0 : Number(minuteText)
	const seconds = secondText === undefined ? 0 : Number(secondText)

	if (hours > 12 || minutes > 59 || seconds > 59) return null

	const format = minuteText === undefined ? "h AM/PM" : secondText === undefined ? "h:mm AM/PM" : "h:mm:ss AM/PM"

	return { seconds: ((hours % 12) + (half.toLowerCase() === "p" ? 12 : 0)) * 3600 + minutes * 60 + seconds, format, elapsed: false }
}

function utcDate(date: LocalizedDate, seconds = 0): Date {
	return new Date(Date.UTC(date.year, date.month - 1, date.day) + seconds * 1000)
}

function validIsoDate(year: number, month: number, day: number): LocalizedDate | null {
	const value = new Date(Date.UTC(year, month - 1, day))

	return value.getUTCMonth() === month - 1 && value.getUTCDate() === day ? { year, month, day } : null
}

// A time alone (on the epoch day), or an ISO date with a time after it ("2024-03-05 14:30"), as editing a time or
// date-time cell starts from. Null for anything else.
function timeValue(text: string): ParsedInput | null {
	const time = timeEntry(text)

	if (time !== null) return { type: "value", value: time.seconds / SECONDS_PER_DAY, impliedFormat: time.format }

	const dateTime = ISO_DATE_TIME.exec(text)

	if (dateTime === null) return null

	const [, year = "", month = "", day = "", clockText = ""] = dateTime
	const date = validIsoDate(Number(year), Number(month), Number(day))
	const clock = date === null ? null : timeEntry(clockText)

	if (date === null || clock === null || clock.elapsed) return null

	const format = clock.format.endsWith("AM/PM") ? clock.format : `h${clock.format}`

	return { type: "value", value: utcDate(date, clock.seconds), impliedFormat: `yyyy-mm-dd ${format}` }
}

//
// With the app's locale, numbers read with its decimal point and grouping, dates in its order (ISO dates in any),
// and a formula with its separators, given back in the file's syntax (input/locale.ts). `year` is the clock's, for a
// date typed without one (3/15, 1-Jan); without it such an entry is text.
export function parseCellInput(input: string, locale?: SheetLocale, year?: number): ParsedInput {
	if (input === "") {
		return { type: "empty" }
	}

	if (input.startsWith("=") && input.length > 1) {
		return { type: "formula", formula: delocalizeFormula(input.slice(1), locale) }
	}

	if (input.startsWith("'")) {
		return { type: "value", value: input.slice(1) }
	}

	const trimmed = input.trim()
	const time = timeValue(trimmed)

	if (time !== null) return time

	if (locale !== undefined) return localizedValue(input, trimmed, locale, year)

	if (NUMBER.test(trimmed)) {
		return { type: "value", value: Number(trimmed) }
	}

	if (GROUPED.test(trimmed)) {
		return { type: "value", value: Number(trimmed.replaceAll(",", "")), impliedFormat: trimmed.includes(".") ? "#,##0.00" : "#,##0" }
	}

	if (PERCENT.test(trimmed)) {
		return { type: "value", value: Number(trimmed.slice(0, -1)) / 100, impliedFormat: trimmed.includes(".") ? "0.00%" : "0%" }
	}

	const upper = trimmed.toUpperCase()

	if (upper === "TRUE" || upper === "FALSE") {
		return { type: "value", value: upper === "TRUE" }
	}

	const date = ISO_DATE.exec(trimmed)

	if (date !== null) {
		const [, year = "", month = "", day = ""] = date
		const valid = validIsoDate(Number(year), Number(month), Number(day))

		if (valid !== null) return { type: "value", value: utcDate(valid), impliedFormat: "yyyy-mm-dd" }
	}

	return { type: "value", value: input }
}

// The format a date typed in the locale implies, as Excel gives one: a day, month and year in numbers, the locale's
// short date (yyyy-mm-dd for an ISO date); with a month name, d-mmm-yy; a day and month without a year, d-mmm; a
// month and year without a day, mmm-yy.
function impliedDateFormat(text: string, date: LocalizedDate, locale: SheetLocale): string {
	const tokens = text.match(DATE_TOKENS) ?? []
	const named = tokens.some(token => !/^\d/.test(token))

	if (tokens.length === 3) return named ? "d-mmm-yy" : ISO_DATE.test(text) ? "yyyy-mm-dd" : localizedDateFormat(locale)

	const [head = "", tail = ""] = tokens
	let dayMonth: boolean

	if (named) {
		const number = /^\d/.test(head) ? head : tail

		dayMonth = number.length <= 2 && Number(number) === date.day
	} else if (head.length > 2) {
		dayMonth = false
	} else if (locale.dateOrder === "dmy") {
		dayMonth = Number(head) === date.day && Number(tail) === date.month
	} else {
		dayMonth = tail.length <= 2 && Number(head) === date.month && Number(tail) === date.day
	}

	return dayMonth ? "d-mmm" : "mmm-yy"
}

// A date typed in the locale (formulaTextDate reads it as Excel does), with the format it implies. A day and month
// without a year takes `year`; without one, null.
function localizedDay(text: string, locale: SheetLocale, year: number | undefined): { date: LocalizedDate; format: string } | null {
	let undated = false
	const date = formulaTextDate(
		text,
		locale,
		() => {
			undated = true

			return year ?? Number.NaN
		},
		false
	)

	if (date === null || (undated && year === undefined)) return null

	return { date, format: impliedDateFormat(text, date, locale) }
}

// A date with a time after it, the date as the locale types it (12/31/2025 14:30, 15-Mar-2025 2:30 PM).
function localizedDateTime(text: string, locale: SheetLocale, year: number | undefined): ParsedInput | null {
	const colon = text.indexOf(":")
	const space = colon < 0 ? -1 : text.lastIndexOf(" ", colon)

	if (space <= 0) return null

	const clock = timeEntry(text.slice(space + 1))
	const day = clock === null || clock.elapsed ? null : localizedDay(text.slice(0, space).trimEnd(), locale, year)

	if (clock === null || day === null) return null

	// The short date takes built-in 22 (the system's short date and h:mm); with another time, its order as a code.
	const date = day.format === "m/d/yyyy" && clock.format !== "h:mm" ? orderedDateFormat(locale) : day.format

	return { type: "value", value: utcDate(day.date, clock.seconds), impliedFormat: `${date} ${clock.format}` }
}

// A value typed in the app's locale (en-US's included: its dates are month first).
function localizedValue(input: string, trimmed: string, locale: SheetLocale, year: number | undefined): ParsedInput {
	const number = entryNumber(trimmed, locale)

	if (number !== null) return { type: "value", ...number }

	const upper = trimmed.toUpperCase()

	if (upper === "TRUE" || upper === "FALSE") return { type: "value", value: upper === "TRUE" }

	const day = localizedDay(trimmed, locale, year)

	if (day !== null) return { type: "value", value: utcDate(day.date), impliedFormat: day.format }

	return localizedDateTime(trimmed, locale, year) ?? { type: "value", value: input }
}

// Whether an entry would be stored as a formula that does not read as one (a parenthesis left open, ";"
// between arguments): refused rather than written to the file, where Excel would drop it. A Text ("@")
// cell takes it as text.
export function malformedFormula(input: string, textFormat = false, locale?: SheetLocale): boolean {
	if (textFormat) {
		return false
	}

	const parsed = parseCellInput(input, locale)

	return parsed.type === "formula" && !wellFormedFormula(parsed.formula)
}

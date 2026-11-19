import { dayPeriodName, languageTag } from "../forms/dates"

// Date pictures (Word's \@ date-time picture, ECMA-376 Part 1 §17.16.4.1) for a language's own conventions: its
// dates and times as Intl (CLDR) writes them, read back into picture items. A picture formats a Gregorian date in
// Latin digits (fields/evaluate.ts datePicture, forms/dates.ts), so the language is read with Latin digits and the
// Gregorian calendar whatever its default (Persian, Bengali, Marathi, Arabic, Thai), and the bidi marks Arabic
// and Hebrew put around date parts are left out.

// Word's Date and Time dialog's formats for English (United States).
const US_DATE_PICTURES: readonly string[] = [
	"M/d/yyyy",
	"dddd, MMMM d, yyyy",
	"MMMM d, yyyy",
	"M/d/yy",
	"yyyy-MM-dd",
	"d-MMM-yy",
	"M.d.yyyy",
	"MMM. d, yy",
	"d MMMM yyyy",
	"MMMM yy",
	"MMM-yy",
	"M/d/yyyy h:mm am/pm",
	"M/d/yyyy h:mm:ss am/pm",
	"h:mm am/pm",
	"h:mm:ss am/pm",
	"HH:mm",
	"HH:mm:ss"
]

const US = "M/d/yyyy"
const US_TIME = "h:mm am/pm"
// A day, month and hour below ten: padding shows in what a format writes.
const SAMPLE = new Date(Date.UTC(2026, 2, 4, 5, 6, 7))
const BIDI_MARKS = /[؜‎‏‪-‮⁦-⁩]/g
// What a picture may hold as literal text (what insert.date takes).
const PICTURE = /^[\p{L}\p{N} .,:/\-']{1,64}$/u

function english(language: string | undefined): boolean {
	return language === undefined || language.toLowerCase() === "en-us"
}

// `language` with Latin digits and the Gregorian calendar, or undefined when Intl cannot read it.
function latinGregorian(language: string): string | undefined {
	try {
		return new Intl.Locale(language, { numberingSystem: "latn", calendar: "gregory" }).toString()
	} catch {
		return undefined
	}
}

// The date picture of what Intl writes for `language` with `options`, or undefined where a part has no picture
// item or a character cannot stand in a picture.
export function intlDatePicture(language: string, options: Intl.DateTimeFormatOptions): string | undefined {
	const locale = latinGregorian(language)

	if (locale === undefined) return undefined

	let parts: Intl.DateTimeFormatPart[]

	try {
		parts = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).formatToParts(SAMPLE)
	} catch {
		return undefined
	}

	const longMonth = options.month === "long" || options.dateStyle === "long" || options.dateStyle === "full"
	const twelve = parts.some(part => part.type === "dayPeriod")
	let out = ""

	for (const part of parts) {
		const value = part.value.replace(BIDI_MARKS, "")
		const padded = value.length === 2 && value.startsWith("0")

		switch (part.type) {
			case "year":
				out += value.length === 2 ? "yy" : "yyyy"
				break
			case "month":
				out += /^\d+$/.test(value) ? (padded ? "MM" : "M") : longMonth ? "MMMM" : "MMM"
				break
			case "day":
				out += padded ? "dd" : "d"
				break
			case "weekday":
				out += options.weekday === "short" ? "ddd" : "dddd"
				break
			case "hour":
				out += twelve ? (padded ? "hh" : "h") : padded ? "HH" : "H"
				break
			case "minute":
				out += "mm"
				break
			case "second":
				out += "ss"
				break
			// Where the language puts it: shown as the language's own day period (forms/dates.ts dayPeriodName).
			case "dayPeriod":
				out += "am/pm"
				break
			case "literal":
				// Letters are written as they are, in quotes; any space is a plain one.
				out += value.replace(/\s/gu, " ").replace(/\p{L}+/gu, letters => `'${letters}'`)
				break
			default:
				return undefined
		}
	}

	return PICTURE.test(out) ? out : undefined
}

// The language's numeric short date with a four-digit year (Word's default date picture for a language: a date
// control's, the date dialog's first entry).
export function numericDatePicture(lang: string | undefined): string {
	const language = lang === undefined ? undefined : languageTag(lang)

	if (language === undefined || english(language)) return US

	return intlDatePicture(language, { year: "numeric", month: "2-digit", day: "2-digit" }) ?? US
}

// The language's short time (Word's default time picture for a language): en-US's "h:mm am/pm" for English (United
// States), a language Intl cannot read or one without a picture of it.
export function shortTimePicture(lang: string | undefined): string {
	const language = lang === undefined ? undefined : languageTag(lang)

	if (language === undefined || english(language)) return US_TIME

	return intlDatePicture(language, { timeStyle: "short" }) ?? US_TIME
}

// The formats a date dialog offers for `language` (the caret's w:lang): Word's own for English (United States),
// else the language's numeric short date first, then its short to full dates, ISO, its times and its date with
// time.
export function datePictures(lang: string | undefined): readonly string[] {
	// A Windows language identifier (ST_Lang in hex) as its tag.
	const language = lang === undefined ? undefined : languageTag(lang)

	if (language === undefined || english(language)) return US_DATE_PICTURES

	const shapes: Intl.DateTimeFormatOptions[] = [
		{ dateStyle: "short" },
		{ dateStyle: "medium" },
		{ dateStyle: "long" },
		{ dateStyle: "full" },
		{ year: "numeric", month: "long" },
		{ timeStyle: "short" },
		{ timeStyle: "medium" },
		{ dateStyle: "short", timeStyle: "short" }
	]
	const out = new Set<string>([numericDatePicture(language)])

	for (const shape of shapes) {
		const picture = intlDatePicture(language, shape)

		if (picture !== undefined) out.add(picture)
		if (shape.dateStyle === "short" && shape.timeStyle === undefined) out.add("yyyy-MM-dd")
	}

	// A language with a day period of its own (Chinese, Japanese, Korean, Arabic) offers its 12-hour time too,
	// shown in its words, where its usual time is 24-hour.
	if (/[^\x20-\x7e]/.test(dayPeriodName(9, language))) {
		const twelve = intlDatePicture(language, { hour: "numeric", minute: "2-digit", hour12: true })

		if (twelve !== undefined) out.add(twelve)
	}

	return [...out]
}

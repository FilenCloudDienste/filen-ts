import { NUMFMT_EN_US, type NumFmtLocale } from "@filen/office/core/sheet"

// What numbers and dates show in, from the browser's formatting locale, as Excel shows them in the system's
// regional settings: its numeric date for built-in 14 (and 22), its full date for [$-F800] and its time for [$-F400]
// as format codes, month and day names, AM and PM, and the separators. Gregorian dates in Latin digits whatever the
// locale's own calendar and digits, as the codes count them.

// Sunday 2 January 2000, 09:05:09: every number one digit, so a pattern's padding shows.
const SAMPLE = Date.UTC(2000, 0, 2, 9, 5, 9)
const BASE = { timeZone: "UTC", calendar: "gregory", numberingSystem: "latn" } as const

function formatter(language: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(language, { ...BASE, ...options })
}

function partOf(format: Intl.DateTimeFormat, time: number, type: Intl.DateTimeFormatPartTypes): string | undefined {
	return format.formatToParts(time).find(part => part.type === type)?.value
}

// Twelve names, January first, as a date writes them (some languages decline a month after a day); where that is a
// number with its unit apart ("1" and "月"), the name alone ("1月").
function monthNames(language: string, month: "long" | "short"): string[] {
	const inDate = formatter(language, { day: "numeric", month })
	const alone = formatter(language, { month })

	return Array.from({ length: 12 }, (_, i) => {
		const time = Date.UTC(2000, i, 15)
		const name = partOf(inDate, time, "month") ?? ""

		return /^\d*$/.test(name) ? alone.format(time) : name
	})
}

// Seven names, Sunday first.
function dayNames(language: string, weekday: "long" | "short"): string[] {
	const format = formatter(language, { weekday })

	return Array.from({ length: 7 }, (_, i) => partOf(format, Date.UTC(2000, 0, 2 + i), "weekday") ?? "")
}

// Text a code shows as it is: quoted, or each character escaped where it holds a quote. CLDR's narrow no-break space
// (before AM and PM) as the plain space the system patterns have.
function literal(raw: string): string {
	const text = raw.replaceAll(" ", " ")

	if (text === "") return ""

	return text.includes('"') ? Array.from(text, ch => `\\${ch}`).join("") : `"${text}"`
}

function padded(value: string, one: string, two: string): string {
	return value.length >= 2 ? two : one
}

type Names = Pick<NumFmtLocale, "months" | "monthsShort" | "days" | "daysShort">

// The code letters of a name: the short ones where it is the short name and not the full one.
function named(value: string, full: string | undefined, short: string | undefined, letters: string): string {
	return value !== full && value === short ? letters.slice(1) : letters
}

// A pattern as a format code: each field the code letter that shows it the same way.
function codeOf(format: Intl.DateTimeFormat, names: Names): string {
	let code = ""

	for (const part of format.formatToParts(SAMPLE))
		switch (part.type) {
			case "year":
				code += part.value.length <= 2 ? "yy" : "yyyy"
				break
			case "month":
				code += /^\d+$/.test(part.value)
					? padded(part.value, "m", "mm")
					: named(part.value, names.months[0], names.monthsShort[0], "mmmm")
				break
			case "day":
				code += padded(part.value, "d", "dd")
				break
			case "weekday":
				code += named(part.value, names.days[0], names.daysShort[0], "dddd")
				break
			case "hour":
				code += padded(part.value, "h", "hh")
				break
			case "minute":
				code += "mm"
				break
			case "second":
				code += "ss"
				break
			case "dayPeriod":
				code += "AM/PM"
				break
			default:
				code += literal(part.value)
		}

	return code
}

// The short date is the locale's numeric date (CLDR yMd), the long date its full date and the time its medium time,
// as Intl writes them.
export function numFmtLocaleOf(language: string, decimal: string, group: string): NumFmtLocale {
	try {
		const names: Names = {
			months: monthNames(language, "long"),
			monthsShort: monthNames(language, "short"),
			days: dayNames(language, "long"),
			daysShort: dayNames(language, "short")
		}
		const clock = formatter(language, { hour: "numeric", hour12: true })

		return {
			...NUMFMT_EN_US,
			decimal,
			group,
			...names,
			am: partOf(clock, SAMPLE, "dayPeriod") ?? NUMFMT_EN_US.am,
			pm: partOf(clock, SAMPLE + 12 * 3_600_000, "dayPeriod") ?? NUMFMT_EN_US.pm,
			shortDate: codeOf(formatter(language, { year: "numeric", month: "numeric", day: "numeric" }), names),
			longDate: codeOf(formatter(language, { dateStyle: "full" }), names),
			longTime: codeOf(formatter(language, { timeStyle: "medium" }), names)
		}
	} catch {
		// An unknown language tag: en-US's names and patterns.
		return { ...NUMFMT_EN_US, decimal, group }
	}
}

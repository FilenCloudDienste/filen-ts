import type { ConfigParams } from "hyperformula"
import { EN_US_LOCALE, formulaTextDate } from "../input/locale"
import type { SheetLocale } from "../protocol"

// Text read as a date or time inside formulas (DATEVALUE("8/22/2011"), MONTH("5/1/2020"), "22-MAY-2011"+1): the
// locale's day, month and year order, ISO dates in every locale, English month names (input/locale.ts
// formulaTextDate), and a time of hours and minutes (seconds optional, AM/PM optional) alone or after the date.
// Excel reads text dates by the system's date settings (support.microsoft.com "DATEVALUE function"); the engine's
// own default is day first.

type TextDateTime = ReturnType<ConfigParams["parseDateTime"]>

const TIME = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?(?: ?([ap])m?)?$/i

function timeOf(text: string): TextDateTime {
	const match = TIME.exec(text)

	if (match === null) return undefined

	const [, hourText = "", minuteText = "", secondText, half] = match
	const hours = Number(hourText)
	const minutes = Number(minuteText)
	const seconds = secondText === undefined ? 0 : Number(secondText)

	if (minutes > 59 || seconds >= 60) return undefined

	if (half === undefined) return { hours, minutes, seconds }
	if (hours > 12) return undefined

	return { hours: (hours % 12) + (half.toLowerCase() === "p" ? 12 : 0), minutes, seconds }
}

// The locale each parser reads in, for the engine's other readings of text (functions/plugin.ts reads numbers in it).
const parserLocales = new WeakMap<ConfigParams["parseDateTime"], SheetLocale>()

export function parserLocale(parser: ConfigParams["parseDateTime"]): SheetLocale {
	return parserLocales.get(parser) ?? EN_US_LOCALE
}

// `now` gives the year of a date without one ("5-JUL"), the clock TODAY() reads.
export function textDateParser(locale: SheetLocale = EN_US_LOCALE, now: () => number = Date.now): ConfigParams["parseDateTime"] {
	const currentYear = (): number => new Date(now()).getFullYear()
	// 1900-02-29 is offered in every date system: the engine's own validation keeps it only where leapYear1900 is set.
	const dateOf = (text: string): TextDateTime => formulaTextDate(text, locale, currentYear, true) ?? undefined

	const parser = (text: string): TextDateTime => {
		const trimmed = text.trim().replace(/\s+/g, " ")
		const date = dateOf(trimmed)

		if (date !== undefined) return date

		const time = timeOf(trimmed)

		if (time !== undefined) return time

		// The time is the run from the last space before its first ":" ("5 Jan 2024 6:35 AM").
		const colon = trimmed.indexOf(":")
		const space = colon < 0 ? -1 : trimmed.lastIndexOf(" ", colon)

		if (space < 0) return undefined

		const day = dateOf(trimmed.slice(0, space))
		const clock = timeOf(trimmed.slice(space + 1))

		return day === undefined || clock === undefined ? undefined : { ...day, ...clock }
	}

	parserLocales.set(parser, locale)

	return parser
}

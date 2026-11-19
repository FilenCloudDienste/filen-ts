// Text fields (a:fld, ECMA-376 §21.1.2.2.4) as PowerPoint shows them: slidenum is the slide's number, datetime and
// datetime1–datetime13 the current date and time in the thirteen formats PowerPoint's Date and Time dialog lists,
// in the order, punctuation and names of the field's language when the host can format it (Intl), else as US English
// writes them. Every other field type (header and footer text, custom fields, unknown types) shows the text the file
// stores, as it was last shown.

export interface FieldContext {
	// The number the slide shows (the deck's firstSlideNumber counted in).
	readonly slideNumber?: number
	// The moment date and time fields show (the host's clock; tests pass a fixed one).
	readonly now?: Date
	// BCP 47 of the deck's text (a:rPr@lang of the field), the language dates and times are written in.
	readonly locale?: string
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const DATE: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" }
const CLOCK_12: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", hour12: true }
const CLOCK_12_SECONDS: Intl.DateTimeFormatOptions = { ...CLOCK_12, second: "2-digit" }
const CLOCK_24: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", hourCycle: "h23" }

// datetime1–datetime13 as Intl options (index 0 unused): the language orders the parts and spells the names, month-year
// and day-month sets letting it pick the grammatical case (Slavic languages).
const FORMAT_OPTIONS: readonly Intl.DateTimeFormatOptions[] = [
	{},
	DATE,
	{ weekday: "long", year: "numeric", month: "long", day: "numeric" },
	{ day: "numeric", month: "long", year: "numeric" },
	{ month: "long", day: "numeric", year: "numeric" },
	{ day: "numeric", month: "short", year: "2-digit" },
	{ month: "long", year: "2-digit" },
	{ month: "short", year: "2-digit" },
	{ ...DATE, ...CLOCK_12 },
	{ ...DATE, ...CLOCK_12_SECONDS },
	CLOCK_24,
	{ ...CLOCK_24, second: "2-digit" },
	CLOCK_12,
	CLOCK_12_SECONDS
]

// The formats of each language a deck's fields name (a few per deck), each made when a field first needs it; a layout
// per field reuses them. null: the host cannot format the language.
const localeFormats = new Map<string, (Intl.DateTimeFormat | undefined)[] | null>()
const MAX_FORMAT_LOCALES = 32

// Format `n` (1–13) of `locale`; undefined: written as US English instead (no Intl, or a language it cannot format).
function formatOf(locale: string, n: number): Intl.DateTimeFormat | undefined {
	const intl: unknown = Reflect.get(globalThis, "Intl")

	if (typeof intl !== "object" || intl === null) return undefined

	let formats = localeFormats.get(locale)

	if (formats === null) return undefined

	if (formats === undefined) {
		if (localeFormats.size >= MAX_FORMAT_LOCALES) localeFormats.clear()

		formats = []
		localeFormats.set(locale, formats)
	}

	const held = formats[n]

	if (held !== undefined) return held

	try {
		const made = new Intl.DateTimeFormat(locale, FORMAT_OPTIONS[n])

		formats[n] = made

		return made
	} catch {
		localeFormats.set(locale, null)

		return undefined
	}
}

function two(value: number): string {
	return String(value).padStart(2, "0")
}

function clock12(date: Date, seconds: boolean): string {
	const hours = date.getHours() % 12 === 0 ? 12 : date.getHours() % 12

	return `${hours}:${two(date.getMinutes())}${seconds ? `:${two(date.getSeconds())}` : ""} ${date.getHours() < 12 ? "AM" : "PM"}`
}

function clock24(date: Date, seconds: boolean): string {
	return `${date.getHours()}:${two(date.getMinutes())}${seconds ? `:${two(date.getSeconds())}` : ""}`
}

// The text a field shows; `stored` is the a:t the file holds, `locale` the field run's language (else the context's).
export function fieldText(type: string, stored: string, context: FieldContext, locale = context.locale): string {
	if (type === "slidenum") return context.slideNumber === undefined ? stored : String(context.slideNumber)

	const match = /^datetime(1[0-3]|[1-9])?$/.exec(type)

	if (match === null) return stored

	const date = context.now

	if (date === undefined || Number.isNaN(date.getTime())) return stored

	const n = match[1] === undefined ? 1 : Number(match[1])
	// US English (and a run with no language) keeps the patterns as ECMA-376 lists them; en-GB and the like go
	// through Intl for their day-first order.
	const format = locale === undefined || /^en(?:-US)?$/i.test(locale) ? undefined : formatOf(locale, n)

	if (format !== undefined) return format.format(date)

	const day = date.getDate()
	const month = date.getMonth() + 1
	const year = date.getFullYear()
	const monthName = MONTHS[date.getMonth()] ?? ""
	const monthShort = monthName.slice(0, 3)
	const dayName = DAYS[date.getDay()] ?? ""

	switch (n) {
		case 1:
			return `${month}/${day}/${year}`
		case 2:
			return `${dayName}, ${monthName} ${day}, ${year}`
		case 3:
			return `${day} ${monthName} ${year}`
		case 4:
			return `${monthName} ${day}, ${year}`
		case 5:
			return `${day}-${monthShort}-${two(year % 100)}`
		case 6:
			return `${monthName} ${two(year % 100)}`
		case 7:
			return `${monthShort}-${two(year % 100)}`
		case 8:
			return `${month}/${day}/${year} ${clock12(date, false)}`
		case 9:
			return `${month}/${day}/${year} ${clock12(date, true)}`
		case 10:
			return clock24(date, false)
		case 11:
			return clock24(date, true)
		case 12:
			return clock12(date, false)
		default:
			return clock12(date, true)
	}
}

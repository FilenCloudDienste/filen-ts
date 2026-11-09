// Text fields (a:fld, ECMA-376 §21.1.2.2.4) as PowerPoint shows them: slidenum is the slide's number, datetime and
// datetime1–datetime13 the current date and time in the thirteen formats PowerPoint's Date and Time dialog lists,
// in the deck's language when the host can format it (Intl), else in English. Every other field type (header and
// footer text, custom fields, unknown types) shows the text the file stores, as it was last shown.

export interface FieldContext {
	// The number the slide shows (the deck's firstSlideNumber counted in).
	readonly slideNumber?: number
	// The moment date and time fields show (the host's clock; tests pass a fixed one).
	readonly now?: Date
	// BCP 47 of the deck's text (a:rPr@lang of the field), for month and day names.
	readonly locale?: string
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

function names(date: Date, locale: string | undefined): { month: string; monthShort: string; day: string } {
	const fallback = {
		month: MONTHS[date.getMonth()] ?? "",
		monthShort: (MONTHS[date.getMonth()] ?? "").slice(0, 3),
		day: DAYS[date.getDay()] ?? ""
	}
	const intl: unknown = Reflect.get(globalThis, "Intl")

	if (locale === undefined || /^en(?:-|$)/i.test(locale) || typeof intl !== "object" || intl === null) return fallback

	const formats = formatsOf(locale)

	return formats === null
		? fallback
		: { month: formats.month.format(date), monthShort: formats.monthShort.format(date), day: formats.day.format(date) }
}

interface NameFormats {
	readonly month: Intl.DateTimeFormat
	readonly monthShort: Intl.DateTimeFormat
	readonly day: Intl.DateTimeFormat
}

// The name formats of each language a deck's fields name (a few per deck): made once, a layout per field reuses them.
// null: the host cannot format the language.
const nameFormats = new Map<string, NameFormats | null>()
const MAX_NAME_FORMATS = 32

function formatsOf(locale: string): NameFormats | null {
	const held = nameFormats.get(locale)

	if (held !== undefined) return held

	let made: NameFormats | null

	try {
		made = {
			month: new Intl.DateTimeFormat(locale, { month: "long" }),
			monthShort: new Intl.DateTimeFormat(locale, { month: "short" }),
			day: new Intl.DateTimeFormat(locale, { weekday: "long" })
		}
	} catch {
		made = null
	}

	if (nameFormats.size >= MAX_NAME_FORMATS) nameFormats.clear()

	nameFormats.set(locale, made)

	return made
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

	const match = /^datetime(\d{0,2})$/.exec(type)

	if (match === null) return stored

	const date = context.now

	if (date === undefined || Number.isNaN(date.getTime())) return stored

	const day = date.getDate()
	const month = date.getMonth() + 1
	const year = date.getFullYear()
	const { month: monthName, monthShort, day: dayName } = names(date, locale)

	switch (match[1]) {
		case "":
		case "1":
			return `${month}/${day}/${year}`
		case "2":
			return `${dayName}, ${monthName} ${day}, ${year}`
		case "3":
			return `${day} ${monthName} ${year}`
		case "4":
			return `${monthName} ${day}, ${year}`
		case "5":
			return `${day}-${monthShort}-${two(year % 100)}`
		case "6":
			return `${monthName} ${two(year % 100)}`
		case "7":
			return `${monthShort}-${two(year % 100)}`
		case "8":
			return `${month}/${day}/${year} ${clock12(date, false)}`
		case "9":
			return `${month}/${day}/${year} ${clock12(date, true)}`
		case "10":
			return clock24(date, false)
		case "11":
			return clock24(date, true)
		case "12":
			return clock12(date, false)
		case "13":
			return clock12(date, true)
		default:
			return stored
	}
}

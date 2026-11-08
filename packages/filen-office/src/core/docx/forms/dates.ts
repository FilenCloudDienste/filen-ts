// The text a date content control shows for its date (ECMA-376 Part 1 §17.5.2.7 w:date): w:dateFormat is a
// Word date-time picture (the same syntax as a field's \@ switch, §17.16.4.1) read in w:lid's language and
// w:calendar's calendar.
//
// Picture items: d, dd (day), ddd, dddd (weekday name), M, MM (month), MMM, MMMM (month name; with a day in the
// picture the name as a date has it, the genitive of Slavic languages), y, yy (two-digit year), yyy, yyyy (year),
// g (the era's short name), gg (its first character), ggg (its name), e, ee (the year of the era), B, BB, BBBB (the
// Thai Buddhist year), h, hh, H, HH, m, mm, s, ss (a date control's time is midnight), AM/PM, am/pm, A/P, a/p;
// 'quoted' text is literal, as is anything else.

// Word's w:calendar values as Intl calendars (Korea counts the Tangun era on the Gregorian calendar).
const CALENDARS: Readonly<Record<string, string>> = {
	gregorian: "gregory",
	gregorianUs: "gregory",
	gregorianMeFrench: "gregory",
	gregorianArabic: "gregory",
	gregorianXlitEnglish: "gregory",
	gregorianXlitFrench: "gregory",
	hijri: "islamic",
	hebrew: "hebrew",
	japan: "japanese",
	taiwan: "roc",
	thai: "buddhist",
	saka: "indian",
	korea: "gregory"
}

const TANGUN_OFFSET = 2333
const BUDDHIST_OFFSET = 543

interface Parts {
	readonly year: number
	readonly month: number
	readonly day: number
}

const formats = new Map<string, Intl.DateTimeFormat>()

function format(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${locale}|${JSON.stringify(options)}`
	let found = formats.get(key)

	if (found === undefined) {
		found = new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options })
		formats.set(key, found)
	}

	return found
}

// Windows language identifiers (MS-LCID) ST_Lang may give as four hex digits, by their language tags.
const LCIDS: Readonly<Record<number, string>> = {
	0x0401: "ar-SA",
	0x0402: "bg-BG",
	0x0403: "ca-ES",
	0x0404: "zh-TW",
	0x0405: "cs-CZ",
	0x0406: "da-DK",
	0x0407: "de-DE",
	0x0408: "el-GR",
	0x0409: "en-US",
	0x040a: "es-ES",
	0x040b: "fi-FI",
	0x040c: "fr-FR",
	0x040d: "he-IL",
	0x040e: "hu-HU",
	0x040f: "is-IS",
	0x0410: "it-IT",
	0x0411: "ja-JP",
	0x0412: "ko-KR",
	0x0413: "nl-NL",
	0x0414: "nb-NO",
	0x0415: "pl-PL",
	0x0416: "pt-BR",
	0x0418: "ro-RO",
	0x0419: "ru-RU",
	0x041a: "hr-HR",
	0x041b: "sk-SK",
	0x041c: "sq-AL",
	0x041d: "sv-SE",
	0x041e: "th-TH",
	0x041f: "tr-TR",
	0x0420: "ur-PK",
	0x0421: "id-ID",
	0x0422: "uk-UA",
	0x0423: "be-BY",
	0x0424: "sl-SI",
	0x0425: "et-EE",
	0x0426: "lv-LV",
	0x0427: "lt-LT",
	0x0429: "fa-IR",
	0x042a: "vi-VN",
	0x042b: "hy-AM",
	0x042c: "az-Latn-AZ",
	0x042d: "eu-ES",
	0x042f: "mk-MK",
	0x0436: "af-ZA",
	0x0437: "ka-GE",
	0x0439: "hi-IN",
	0x043e: "ms-MY",
	0x043f: "kk-KZ",
	0x0441: "sw-KE",
	0x0443: "uz-Latn-UZ",
	0x0445: "bn-IN",
	0x0446: "pa-IN",
	0x0447: "gu-IN",
	0x0449: "ta-IN",
	0x044a: "te-IN",
	0x044b: "kn-IN",
	0x044c: "ml-IN",
	0x044e: "mr-IN",
	0x0450: "mn-MN",
	0x0456: "gl-ES",
	0x0461: "ne-NP",
	0x0463: "ps-AF",
	0x0464: "fil-PH",
	0x0801: "ar-IQ",
	0x0804: "zh-CN",
	0x0807: "de-CH",
	0x0809: "en-GB",
	0x080a: "es-MX",
	0x080c: "fr-BE",
	0x0810: "it-CH",
	0x0813: "nl-BE",
	0x0814: "nn-NO",
	0x0816: "pt-PT",
	0x081d: "sv-FI",
	0x0845: "bn-BD",
	0x0c01: "ar-EG",
	0x0c04: "zh-HK",
	0x0c07: "de-AT",
	0x0c09: "en-AU",
	0x0c0a: "es-ES",
	0x0c0c: "fr-CA",
	0x1004: "zh-SG",
	0x1009: "en-CA",
	0x100c: "fr-CH",
	0x1401: "ar-DZ",
	0x1409: "en-NZ",
	0x1801: "ar-MA",
	0x1809: "en-IE",
	0x1c09: "en-ZA",
	0x2c01: "ar-JO",
	0x3001: "ar-LB",
	0x3401: "ar-KW",
	0x3801: "ar-AE",
	0x4001: "ar-QA",
	0x4009: "en-IN"
}

// A language tag for a w:lang or w:lid value (ST_Lang: a tag, or a Windows language identifier in hex); undefined
// for an identifier this does not know.
export function languageTag(lid: string): string | undefined {
	const hex = /^(?:0x)?([0-9A-Fa-f]{4})$/.exec(lid)

	return hex === null ? lid : LCIDS[Number.parseInt(hex[1] ?? "", 16)]
}

let identifiers: Map<string, number> | undefined

// The Windows language identifier of a w:lang value (four hex digits, or a tag this knows); undefined otherwise.
export function languageIdentifier(lang: string): number | undefined {
	const hex = /^(?:0x)?([0-9A-Fa-f]{4})$/.exec(lang)

	if (hex !== null) return Number.parseInt(hex[1] ?? "", 16)

	if (identifiers === undefined) {
		identifiers = new Map()

		for (const [lcid, tag] of Object.entries(LCIDS)) {
			const key = tag.toLowerCase()

			if (!identifiers.has(key)) identifiers.set(key, Number(lcid))
		}
	}

	return identifiers.get(lang.toLowerCase())
}

// A BCP 47 tag Intl accepts for w:lid (ST_Lang: a language tag or a hex LCID; one it cannot read as English).
export function dateLocale(raw: string | null): string {
	const lid = raw === null ? undefined : languageTag(raw)

	if (lid === undefined || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lid)) return "en-US"

	try {
		return Intl.DateTimeFormat.supportedLocalesOf([lid]).length > 0 ? lid : "en-US"
	} catch {
		return "en-US"
	}
}

function calendarOf(calendar: string | null): string {
	return calendar === null ? "gregory" : (CALENDARS[calendar] ?? "gregory")
}

function partsIn(date: Date, locale: string, calendar: string, korea: boolean): Parts {
	if (calendar === "gregory") {
		const year = date.getUTCFullYear()

		return { year: korea ? year + TANGUN_OFFSET : year, month: date.getUTCMonth() + 1, day: date.getUTCDate() }
	}

	const parts = format(tagOf(locale, calendar), { year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date)
	const number = (type: string): number => {
		const value =
			parts.find(part => (part.type as string) === type || (type === "year" && (part.type as string) === "relatedYear"))?.value ?? ""
		const parsed = Number.parseInt(value.replace(/[^\d]/g, ""), 10)

		return Number.isFinite(parsed) ? parsed : 0
	}

	// The Hebrew calendar names its months even as numbers: Word numbers them from Tishri (1 to 12, 13 in a leap year).
	return { year: number("year"), month: calendar === "hebrew" ? hebrewMonth(date) : number("month"), day: number("day") }
}

// The month of `date` in the Hebrew year, from 1 (Tishri): counted back a month at a time (stepping back by the
// day of the month lands on the previous month's last day) until the year changes. At most 14 Intl calls.
function hebrewMonth(date: Date): number {
	const days = format(tagOf("en", "hebrew"), { year: "numeric", month: "numeric", day: "numeric" })
	const at = (time: number): { year: string; day: number } => {
		const parts = days.formatToParts(new Date(time))

		return {
			year: parts.find(part => part.type === "year")?.value ?? "",
			day: Number.parseInt(parts.find(part => part.type === "day")?.value ?? "", 10)
		}
	}
	const start = at(date.getTime())
	let time = date.getTime()
	let day = start.day
	let index = 1

	// A Hebrew year has at most 13 months; a day of month that does not parse ends the walk.
	while (index < 13 && day >= 1 && day <= 30) {
		time -= day * 86_400_000

		const previous = at(time)

		if (previous.year !== start.year) break

		day = previous.day
		index++
	}

	return index
}

// `locale` in `calendar` with Latin digits, whatever the language's own default calendar (Persian for fa and ps,
// Buddhist for th) and digits: a picture's numbers are Latin, its names those of the calendar it is read in.
function tagOf(locale: string, calendar: string): string {
	try {
		return new Intl.Locale(locale, { calendar, numberingSystem: "latn" }).toString()
	} catch {
		return `${locale}-u-ca-${calendar}-nu-latn`
	}
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// A month name as a date shows it (`dated`: next to a day, the genitive form Slavic languages use), or a weekday's,
// of `date` (its UTC fields) in `calendar`. English names are Word's own (three letters short: "Sep", not "Sept").
function name(date: Date, locale: string, calendar: string, field: "month" | "weekday", style: "long" | "short", dated = false): string {
	if (calendar === "gregory" && /^en(?:-|$)/i.test(locale)) {
		const full = (field === "month" ? MONTHS[date.getUTCMonth()] : DAYS[date.getUTCDay()]) ?? ""

		return style === "long" ? full : full.slice(0, 3)
	}

	if (field === "month" && dated) {
		const parts = format(tagOf(locale, calendar), { day: "numeric", month: style }).formatToParts(date)
		const at = parts.findIndex(entry => entry.type === "month")
		const value = parts[at]?.value

		// A number with its unit where the language writes the month so (Japanese and Chinese 3月): the unit after it.
		if (value !== undefined && /^\d+$/.test(value)) {
			const unit = parts[at + 1]?.type === "literal" ? (parts[at + 1]?.value.trim() ?? "") : ""

			if (/^\p{L}+$/u.test(unit)) return `${value}${unit}`
		} else if (value !== undefined) return value
	}

	const options: Intl.DateTimeFormatOptions = field === "month" ? { month: style } : { weekday: style }

	return format(tagOf(locale, calendar), options).format(date)
}

// Whether a date picture shows the day of the month (d, dd): month names then take a date's form.
export function picturesDay(picture: string): boolean {
	return /(^|[^dD])[dD]{1,2}(?![dD])/.test(picture.replace(/'[^']*'?/g, ""))
}

const DAY_PERIOD_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

// The regional settings of the person reading, as the runtime (the browser, or its worker) reports them.
export function regionalLocale(): string | undefined {
	const language: unknown = (globalThis as { navigator?: { language?: unknown } }).navigator?.language

	return typeof language === "string" && language !== "" ? language : undefined
}

// What the AM/PM picture item (and A/P: Word shows the whole symbol for both) shows at hour `hours` (0-23): the
// symbol of the user's regional settings, not the field's language (Microsoft's "Format field results": the A.M.
// and P.M. symbols are changed in the regional settings): Korean 오전/오후, Chinese 上午/下午, Japanese 午前/午後,
// Arabic ص/م; Latin AM/PM, upper case, for English and where Intl has none. Shared by date fields and date
// content controls (and the date dialog's choice of 12-hour times, for a language).
export function dayPeriodName(hours: number, locale: string | null | undefined = regionalLocale()): string {
	const latin = hours >= 12 ? "PM" : "AM"
	const tag = dateLocale(locale ?? null)

	if (/^en(?:-|$)/i.test(tag)) return latin

	const period = format(tag, { hour: "numeric", hour12: true })
		.formatToParts(new Date(Date.UTC(2001, 0, 1, hours)))
		.find(part => part.type === "dayPeriod")
		?.value.replace(DAY_PERIOD_BIDI, "")
		.trim()

	return period === undefined || period === "" ? latin : period
}

// The era of a date in a calendar (its name, short name) and the year within it.
function eraOf(date: Date, locale: string, calendar: string, style: "long" | "narrow"): { name: string; year: number } {
	const parts = format(tagOf(locale, calendar), { era: style, year: "numeric" }).formatToParts(date)
	const year = Number.parseInt((parts.find(part => part.type === "year")?.value ?? "").replace(/[^\d]/g, ""), 10)

	return { name: parts.find(part => part.type === "era")?.value ?? "", year: Number.isFinite(year) ? year : date.getUTCFullYear() }
}

function pad(value: number, width: number): string {
	return String(value).padStart(width, "0")
}

// Runs of one picture letter (case-sensitive for M and m; y, d, h, s either case).
function run(picture: string, at: number): number {
	const letter = picture[at]
	let end = at + 1

	while (end < picture.length && picture[end] === letter) end++

	return end - at
}

// What a picture's era items (g, e, B; aaa) are: those of the picture's calendar (a date control's w:calendar),
// the Japanese imperial calendar's (a field in Japanese), or literal characters (a field in any other language:
// §17.16.4.1, other characters are output as they are).
export type PictureEras = "calendar" | "japanese" | "literal"

const JAPANESE = "ja-JP"

// The time of day a picture shows (a date control's is midnight).
export interface PictureTime {
	readonly hours: number
	readonly minutes: number
	readonly seconds: number
}

const MIDNIGHT: PictureTime = { hours: 0, minutes: 0, seconds: 0 }

// A date under a Word date-time picture (§17.16.4.1): `day` the Gregorian day (its UTC fields), shown in `calendar`
// (a w:calendar value: a date control's, or a field's \h hijri and \s saka) with month, weekday and era names in
// language `lid`, `time` its time of day. Shared by date fields (fields/evaluate.ts datePicture) and date content
// controls.
export function pictureDate(
	day: Date,
	time: PictureTime,
	picture: string,
	lid: string | null,
	calendar: string | null = null,
	eras: PictureEras = "calendar"
): string {
	const locale = dateLocale(lid)
	const cal = calendarOf(calendar)
	const parts = partsIn(day, locale, cal, calendar === "korea")
	const dated = picturesDay(picture)
	let out = ""

	for (let at = 0; at < picture.length;) {
		const char = picture[at] ?? ""

		if (char === "'") {
			const close = picture.indexOf("'", at + 1)

			out += close < 0 ? picture.slice(at + 1) : picture.slice(at + 1, close)
			at = close < 0 ? picture.length : close + 1

			continue
		}

		const ampm = /^(AM\/PM|am\/pm|A\/P|a\/p)/.exec(picture.slice(at))

		if (ampm !== null) {
			out += dayPeriodName(time.hours)
			at += (ampm[1] ?? "").length

			continue
		}

		const count = run(picture, at)

		switch (char) {
			case "d":
			case "D":
				out += count <= 2 ? pad(parts.day, count) : name(day, locale, cal, "weekday", count === 3 ? "short" : "long")
				break
			case "M":
				out += count <= 2 ? pad(parts.month, count) : name(day, locale, cal, "month", count === 3 ? "short" : "long", dated)
				break
			case "y":
			case "Y":
				out += count <= 2 ? pad(parts.year % 100, 2) : String(parts.year)
				break
			case "g": {
				if (eras === "literal") {
					out += picture.slice(at, at + count)
					break
				}

				// g the narrow era (R), ggg its name (令和), gg the name's first character.
				const era =
					eras === "japanese"
						? eraOf(day, JAPANESE, "japanese", count === 1 ? "narrow" : "long")
						: eraOf(day, locale, cal, count === 1 ? "narrow" : "long")

				out += count === 2 ? [...era.name].slice(0, 1).join("") : era.name
				break
			}
			case "e": {
				if (eras === "literal") {
					out += picture.slice(at, at + count)
					break
				}

				const year = (eras === "japanese" ? eraOf(day, JAPANESE, "japanese", "long") : eraOf(day, locale, cal, "long")).year

				out += eras === "japanese" ? pad(year, Math.min(count, 2)) : count === 1 ? String(year) : pad(year % 100, 2)
				break
			}
			case "B": {
				if (eras !== "calendar") {
					out += picture.slice(at, at + count)
					break
				}

				const year = day.getUTCFullYear() + BUDDHIST_OFFSET

				out += count <= 2 ? pad(year % 100, 2) : String(year)
				break
			}
			// The Japanese weekday: aaa short (木), aaaa long (木曜日).
			case "a":
				out +=
					eras === "japanese" && count >= 3
						? name(day, JAPANESE, "gregory", "weekday", count === 3 ? "short" : "long")
						: picture.slice(at, at + count)
				break
			case "h":
				out += pad(time.hours % 12 === 0 ? 12 : time.hours % 12, Math.min(count, 2))
				break
			case "H":
				out += pad(time.hours, Math.min(count, 2))
				break
			case "m":
				out += pad(time.minutes, Math.min(count, 2))
				break
			case "s":
			case "S":
				out += pad(time.seconds, Math.min(count, 2))
				break
			default:
				out += picture.slice(at, at + count)
		}

		at += count
	}

	return out
}

// `iso` (yyyy-mm-dd) as Word shows it with `picture` (Word's default short date of the language without one).
export function formatControlDate(iso: string, picture: string | null, lid: string | null, calendar: string | null = null): string {
	const date = new Date(`${iso}T00:00:00Z`)

	if (Number.isNaN(date.getTime())) return iso

	if (picture === null || picture === "")
		return format(dateLocale(lid), { year: "numeric", month: "numeric", day: "numeric" }).format(date)

	return pictureDate(date, MIDNIGHT, picture, lid, calendar)
}

// The value a date bound to custom XML stores (w:storeMappedDataAs).
export function storedDate(iso: string, storeAs: "dateTime" | "date" | "text", shown: string): string {
	return storeAs === "date" ? iso : storeAs === "text" ? shown : `${iso}T00:00:00`
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g

function names(locale: string, field: "month" | "weekday"): string[] {
	const out: string[] = []

	for (let k = 0; k < (field === "month" ? 12 : 7); k++) {
		const date = new Date(Date.UTC(2026, field === "month" ? k : 0, field === "month" ? 1 : 4 + k))

		for (const style of ["long", "short"] as const)
			out.push(name(date, locale, "gregory", field, style, false), name(date, locale, "gregory", field, style, true))
	}

	return out
}

// Fields a picture may name before it is not read back. Adjacent numeric fields make the pattern backtrack
// exponentially in their number; Word's pictures name at most four (weekday, day, month, year).
const MAX_DATE_FIELDS = 8

// The date (yyyy-mm-dd) text typed into a date control means, read with its picture in its language, or null:
// what Word cannot read as a date it keeps as text (ECMA-376 Part 1 §17.5.2.40: a binding stores the shown text
// when there is no date to translate). Gregorian pictures only; an ISO date is read too.
export function parseControlDate(text: string, picture: string | null, lid: string | null, calendar: string | null = null): string | null {
	const trimmed = text.trim()
	const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)

	if (iso !== null) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
	if (picture === null || picture === "" || calendarOf(calendar) !== "gregory" || calendar === "korea") return null

	const locale = dateLocale(lid)
	const months = names(locale, "month")
	const groups: ("day" | "month" | "monthName" | "year2" | "year")[] = []
	let pattern = ""
	let fields = 0

	for (let at = 0; at < picture.length;) {
		const char = picture[at] ?? ""

		if (char === "'") {
			const close = picture.indexOf("'", at + 1)

			// Quoted spaces are spaces too: every run of them, quoted or not, is one \s* (literal spaces next to a
			// \s* would let a run of spaces in the text split in every way, which backtracks exponentially).
			for (const piece of (close < 0 ? picture.slice(at + 1) : picture.slice(at + 1, close)).split(/(\s+)/u))
				if (/^\s+$/u.test(piece)) pattern = withSpace(pattern)
				else pattern += piece.replace(ESCAPE, "\\$&")

			at = close < 0 ? picture.length : close + 1

			continue
		}

		const count = run(picture, at)

		if ("dDMyY".includes(char) && ++fields > MAX_DATE_FIELDS) return null

		switch (char) {
			case "d":
			case "D":
				if (count <= 2) {
					pattern += "(\\d{1,2})"
					groups.push("day")
				} else
					pattern += `(?:${names(locale, "weekday")
						.map(entry => entry.replace(ESCAPE, "\\$&"))
						.join("|")})`
				break
			case "M":
				if (count <= 2) {
					pattern += "(\\d{1,2})"
					groups.push("month")
				} else {
					pattern += `(${[...months]
						.sort((a, b) => b.length - a.length)
						.map(entry => entry.replace(ESCAPE, "\\$&"))
						.join("|")})`
					groups.push("monthName")
				}
				break
			case "y":
			case "Y":
				pattern += count <= 2 ? "(\\d{2})" : "(\\d{4})"
				groups.push(count <= 2 ? "year2" : "year")
				break
			default:
				if (/\s/.test(char)) pattern = withSpace(pattern)
				else if (/[A-Za-z]/.test(char)) return null
				else pattern += picture.slice(at, at + count).replace(ESCAPE, "\\$&")
		}

		at += count
	}

	const match = new RegExp(`^\\s*${pattern}\\s*$`, "iu").exec(trimmed)

	if (match === null) return null

	let day = Number.NaN
	let month = Number.NaN
	let year = Number.NaN

	groups.forEach((group, k) => {
		const value = match[k + 1] ?? ""

		if (group === "day") day = Number(value)
		else if (group === "month") month = Number(value)
		else if (group === "year") year = Number(value)
		else if (group === "year2") year = Number(value) + (Number(value) < 30 ? 2000 : 1900)
		else {
			const found = months.findIndex(entry => entry.toLocaleLowerCase(locale) === value.toLocaleLowerCase(locale))

			month = found < 0 ? Number.NaN : Math.floor(found / 4) + 1
		}
	})

	return validDate(year, month, day)
}

// `pattern` and one run of whitespace, as one \s* however many runs meet.
function withSpace(pattern: string): string {
	return pattern.endsWith("\\s*") ? pattern : `${pattern}\\s*`
}

function validDate(year: number, month: number, day: number): string | null {
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || year < 1 || month < 1 || month > 12 || day < 1)
		return null

	const date = new Date(Date.UTC(year, month - 1, day))

	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null

	return `${String(year).padStart(4, "0")}-${pad(month, 2)}-${pad(day, 2)}`
}

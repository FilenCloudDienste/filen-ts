import { NUMFMT_EN_US, type NumFmtLocale } from "../../sheet/numfmt/locale"

// The languages an ODF data style names (number:language, number:country: ISO 639 and 3166 codes), as the Windows
// locale ids a number format's [$-xxxx] tag carries, with what the number formatter shows for each: separators and
// the short and long date LibreOffice's locale data defines (i18npool/source/localedata/data/<locale>.xml,
// FormatCode of DATE_SYS_DDMMYY / DATE_SYSTEM_SHORT and DATE_SYSTEM_LONG). A language not listed keeps the app's.

interface LocaleFacts {
	readonly lcid: number
	readonly decimal: string
	readonly group: string
	// The locale's short and long date as format codes (a date style with number:format-source="language").
	readonly shortDate: string
	readonly longDate: string
}

const NBSP = " "
const NNBSP = " "

const LOCALES: ReadonlyMap<string, LocaleFacts> = new Map([
	["en-US", { lcid: 0x409, decimal: ".", group: ",", shortDate: "m/d/yy", longDate: "dddd, mmmm d, yyyy" }],
	["en-GB", { lcid: 0x809, decimal: ".", group: ",", shortDate: "dd/mm/yyyy", longDate: "dddd, d mmmm yyyy" }],
	["en-AU", { lcid: 0xc09, decimal: ".", group: ",", shortDate: "d/mm/yy", longDate: "dddd, d mmmm yyyy" }],
	["en-CA", { lcid: 0x1009, decimal: ".", group: ",", shortDate: "yyyy-mm-dd", longDate: "dddd, mmmm d, yyyy" }],
	["en-IE", { lcid: 0x1809, decimal: ".", group: ",", shortDate: "dd/mm/yyyy", longDate: "dddd d mmmm yyyy" }],
	["en-NZ", { lcid: 0x1409, decimal: ".", group: ",", shortDate: "d/mm/yy", longDate: "dddd, d mmmm yyyy" }],
	["en-ZA", { lcid: 0x1c09, decimal: ".", group: NBSP, shortDate: "yyyy/mm/dd", longDate: "dddd, dd mmmm yyyy" }],
	["en-IN", { lcid: 0x4009, decimal: ".", group: ",", shortDate: "dd/mm/yy", longDate: "dddd, d mmmm, yyyy" }],
	["de-DE", { lcid: 0x407, decimal: ",", group: ".", shortDate: "dd.mm.yy", longDate: "dddd, d. mmmm yyyy" }],
	["de-AT", { lcid: 0xc07, decimal: ",", group: NBSP, shortDate: "dd.mm.yy", longDate: "dddd, d. mmmm yyyy" }],
	["de-CH", { lcid: 0x807, decimal: ".", group: "'", shortDate: "dd.mm.yy", longDate: "dddd, d. mmmm yyyy" }],
	["fr-FR", { lcid: 0x40c, decimal: ",", group: NNBSP, shortDate: "dd/mm/yy", longDate: "dddd d mmmm yyyy" }],
	["fr-BE", { lcid: 0x80c, decimal: ",", group: ".", shortDate: "dd/mm/yy", longDate: "dddd d mmmm yyyy" }],
	["fr-CA", { lcid: 0xc0c, decimal: ",", group: NBSP, shortDate: "yy-mm-dd", longDate: "dddd d mmmm yyyy" }],
	["fr-CH", { lcid: 0x100c, decimal: ".", group: "'", shortDate: "dd.mm.yy", longDate: "dddd, d mmmm yyyy" }],
	["it-IT", { lcid: 0x410, decimal: ",", group: ".", shortDate: "dd/mm/yy", longDate: "dddd d mmmm yyyy" }],
	["es-ES", { lcid: 0xc0a, decimal: ",", group: ".", shortDate: "dd/mm/yy", longDate: "dddd, d \\de mmmm \\de yyyy" }],
	["es-MX", { lcid: 0x80a, decimal: ".", group: ",", shortDate: "dd/mm/yy", longDate: "dddd, d \\de mmmm \\de yyyy" }],
	["nl-NL", { lcid: 0x413, decimal: ",", group: ".", shortDate: "dd-mm-yy", longDate: "dddd d mmmm yyyy" }],
	["nl-BE", { lcid: 0x813, decimal: ",", group: ".", shortDate: "dd/mm/yy", longDate: "dddd d mmmm yyyy" }],
	["pt-PT", { lcid: 0x816, decimal: ",", group: NBSP, shortDate: "dd/mm/yy", longDate: "dddd, d \\de mmmm \\de yyyy" }],
	["pt-BR", { lcid: 0x416, decimal: ",", group: ".", shortDate: "dd/mm/yy", longDate: "dddd, d \\de mmmm \\de yyyy" }],
	["da-DK", { lcid: 0x406, decimal: ",", group: ".", shortDate: "dd-mm-yy", longDate: "dddd \\d\\e\\n d. mmmm yyyy" }],
	["sv-SE", { lcid: 0x41d, decimal: ",", group: NBSP, shortDate: "yyyy-mm-dd", longDate: "dddd d mmmm yyyy" }],
	["nb-NO", { lcid: 0x414, decimal: ",", group: NBSP, shortDate: "dd.mm.yy", longDate: "dddd d. mmmm yyyy" }],
	["fi-FI", { lcid: 0x40b, decimal: ",", group: NBSP, shortDate: "d.m.yy", longDate: "dddd d. mmmm yyyy" }],
	["pl-PL", { lcid: 0x415, decimal: ",", group: NBSP, shortDate: "dd.mm.yy", longDate: "dddd, d mmmm yyyy" }],
	["cs-CZ", { lcid: 0x405, decimal: ",", group: NBSP, shortDate: "dd.mm.yy", longDate: "dddd d. mmmm yyyy" }],
	["ru-RU", { lcid: 0x419, decimal: ",", group: NBSP, shortDate: "dd.mm.yy", longDate: "dddd, d mmmm yyyy" }],
	["tr-TR", { lcid: 0x41f, decimal: ",", group: ".", shortDate: "dd.mm.yyyy", longDate: "d mmmm yyyy dddd" }],
	["hu-HU", { lcid: 0x40e, decimal: ",", group: NBSP, shortDate: "yyyy. mm. dd.", longDate: "yyyy. mmmm d., dddd" }],
	["ja-JP", { lcid: 0x411, decimal: ".", group: ",", shortDate: "yy/mm/dd", longDate: "yyyy/mm/dd" }],
	["zh-CN", { lcid: 0x804, decimal: ".", group: ",", shortDate: "yy-mm-dd", longDate: "yyyy/mm/dd" }]
])

// A language alone (no country) takes its main country's facts.
const MAIN_COUNTRY: ReadonlyMap<string, string> = new Map([
	["en", "US"],
	["de", "DE"],
	["fr", "FR"],
	["it", "IT"],
	["es", "ES"],
	["nl", "NL"],
	["pt", "PT"],
	["da", "DK"],
	["sv", "SE"],
	["nb", "NO"],
	["fi", "FI"],
	["pl", "PL"],
	["cs", "CZ"],
	["ru", "RU"],
	["tr", "TR"],
	["hu", "HU"],
	["ja", "JP"],
	["zh", "CN"]
])

export interface OdsLocale extends LocaleFacts {
	readonly tag: string
}

// The facts for a language and country as an ODF data style names them; undefined for one not listed (and for none).
export function odsLocale(language: string | undefined, country: string | undefined): OdsLocale | undefined {
	if (language === undefined || language === "" || language === "zxx") return undefined

	const lang = language.toLowerCase()
	const exact = country === undefined || country === "" ? undefined : `${lang}-${country.toUpperCase()}`
	const tag = exact !== undefined && LOCALES.has(exact) ? exact : `${lang}-${MAIN_COUNTRY.get(lang) ?? ""}`
	const facts = LOCALES.get(tag)

	return facts === undefined ? undefined : { ...facts, tag }
}

// Sunday 2 January 2000, 09:00 UTC: a day period's sample, and the first of the weekdays.
const SAMPLE = Date.UTC(2000, 0, 2, 9)
const BASE = { timeZone: "UTC", calendar: "gregory", numberingSystem: "latn" } as const

type Names = Pick<NumFmtLocale, "months" | "monthsShort" | "days" | "daysShort" | "am" | "pm">

function partOf(format: Intl.DateTimeFormat, time: number, type: Intl.DateTimeFormatPartTypes): string | undefined {
	return format.formatToParts(time).find(part => part.type === type)?.value
}

// Twelve names, January first, as a date writes them (some languages decline a month after a day); where that is a
// number with its unit apart ("1" and "月"), the name alone ("1月").
function monthNames(tag: string, month: "long" | "short"): string[] {
	const inDate = new Intl.DateTimeFormat(tag, { ...BASE, day: "numeric", month })
	const alone = new Intl.DateTimeFormat(tag, { ...BASE, month })

	return Array.from({ length: 12 }, (_, i) => {
		const time = Date.UTC(2000, i, 15)
		const name = partOf(inDate, time, "month") ?? ""

		return /^\d*$/.test(name) ? alone.format(time) : name
	})
}

// Seven names, Sunday first.
function dayNames(tag: string, weekday: "long" | "short"): string[] {
	const format = new Intl.DateTimeFormat(tag, { ...BASE, weekday })

	return Array.from({ length: 7 }, (_, i) => partOf(format, Date.UTC(2000, 0, 2 + i), "weekday") ?? "")
}

// The month and day names and AM and PM of a language, as a [$-xxxx] tag means them in Excel and LibreOffice (the
// tag's language, whatever the app's); en-US's where the host cannot format the language.
function namesOf(tag: string): Names {
	try {
		if (Intl.DateTimeFormat.supportedLocalesOf([tag]).length === 0) return NUMFMT_EN_US

		const clock = new Intl.DateTimeFormat(tag, { ...BASE, hour: "numeric", hour12: true })

		return {
			months: monthNames(tag, "long"),
			monthsShort: monthNames(tag, "short"),
			days: dayNames(tag, "long"),
			daysShort: dayNames(tag, "short"),
			am: partOf(clock, SAMPLE, "dayPeriod") ?? NUMFMT_EN_US.am,
			pm: partOf(clock, SAMPLE + 12 * 3_600_000, "dayPeriod") ?? NUMFMT_EN_US.pm
		}
	} catch {
		return NUMFMT_EN_US
	}
}

// The number formatter's language data for a locale id the converted codes carry: separators, month and day names
// and AM and PM of the locale.
// Asked for every formatted value: one answer per locale id, built once (the first listing of an id wins).
const NUMFMT_LOCALES = new Map<number, NumFmtLocale | undefined>()

export function numFmtLocaleFor(lcid: number): NumFmtLocale | undefined {
	if (NUMFMT_LOCALES.has(lcid)) return NUMFMT_LOCALES.get(lcid)

	let locale: NumFmtLocale | undefined

	for (const [tag, facts] of LOCALES) {
		if (facts.lcid === lcid) {
			const { months, monthsShort, days, daysShort, am, pm } = namesOf(tag)

			locale = { ...NUMFMT_EN_US, decimal: facts.decimal, group: facts.group, months, monthsShort, days, daysShort, am, pm }

			break
		}
	}

	NUMFMT_LOCALES.set(lcid, locale)

	return locale
}

// A [$-xxxx] tag for a locale id.
export function lcidTag(lcid: number): string {
	return `[$-${lcid.toString(16).toUpperCase()}]`
}

// The language and country of a locale id, as a data style names them (number:language, number:country); undefined
// for one not listed.
export function localeOfLcid(lcid: number): { readonly language: string; readonly country: string } | undefined {
	for (const [tag, facts] of LOCALES) {
		if (facts.lcid !== (lcid & 0xffff)) continue

		const [language = "", country = ""] = tag.split("-")

		return { language, country }
	}

	return undefined
}

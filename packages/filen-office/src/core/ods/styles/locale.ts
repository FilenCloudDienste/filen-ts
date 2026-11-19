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

// The number formatter's language data for a locale id the converted codes carry: separators of the locale, names
// as en-US (LibreOffice's localized month and day names are not carried).
// Asked for every formatted value: one answer per locale id, built once (the first listing of an id wins).
const NUMFMT_LOCALES = new Map<number, NumFmtLocale | undefined>()

export function numFmtLocaleFor(lcid: number): NumFmtLocale | undefined {
	if (NUMFMT_LOCALES.has(lcid)) return NUMFMT_LOCALES.get(lcid)

	let locale: NumFmtLocale | undefined

	for (const facts of LOCALES.values()) {
		if (facts.lcid === lcid) {
			locale = { ...NUMFMT_EN_US, decimal: facts.decimal, group: facts.group }

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

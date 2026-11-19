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

// Windows language identifiers ST_Lang may give as four hex digits, by their language tags: the language ID table
// of [MS-LCID] §2.2 (neutral identifiers too: they name the language of the regional ones without a row of their
// own), minus LOCALE_CUSTOM_UNSPECIFIED (0x1000). 0x040A (traditional sort, "es-ES_tradnl") is given as es-ES.
const LCIDS: Readonly<Record<number, string>> = {
	0x0001: "ar",
	0x0002: "bg",
	0x0003: "ca",
	0x0004: "zh-Hans",
	0x0005: "cs",
	0x0006: "da",
	0x0007: "de",
	0x0008: "el",
	0x0009: "en",
	0x000a: "es",
	0x000b: "fi",
	0x000c: "fr",
	0x000d: "he",
	0x000e: "hu",
	0x000f: "is",
	0x0010: "it",
	0x0011: "ja",
	0x0012: "ko",
	0x0013: "nl",
	0x0014: "no",
	0x0015: "pl",
	0x0016: "pt",
	0x0017: "rm",
	0x0018: "ro",
	0x0019: "ru",
	0x001a: "hr",
	0x001b: "sk",
	0x001c: "sq",
	0x001d: "sv",
	0x001e: "th",
	0x001f: "tr",
	0x0020: "ur",
	0x0021: "id",
	0x0022: "uk",
	0x0023: "be",
	0x0024: "sl",
	0x0025: "et",
	0x0026: "lv",
	0x0027: "lt",
	0x0028: "tg",
	0x0029: "fa",
	0x002a: "vi",
	0x002b: "hy",
	0x002c: "az",
	0x002d: "eu",
	0x002e: "hsb",
	0x002f: "mk",
	0x0030: "st",
	0x0031: "ts",
	0x0032: "tn",
	0x0033: "ve",
	0x0034: "xh",
	0x0035: "zu",
	0x0036: "af",
	0x0037: "ka",
	0x0038: "fo",
	0x0039: "hi",
	0x003a: "mt",
	0x003b: "se",
	0x003c: "ga",
	0x003e: "ms",
	0x003f: "kk",
	0x0040: "ky",
	0x0041: "sw",
	0x0042: "tk",
	0x0043: "uz",
	0x0044: "tt",
	0x0045: "bn",
	0x0046: "pa",
	0x0047: "gu",
	0x0048: "or",
	0x0049: "ta",
	0x004a: "te",
	0x004b: "kn",
	0x004c: "ml",
	0x004d: "as",
	0x004e: "mr",
	0x004f: "sa",
	0x0050: "mn",
	0x0051: "bo",
	0x0052: "cy",
	0x0053: "km",
	0x0054: "lo",
	0x0055: "my",
	0x0056: "gl",
	0x0057: "kok",
	0x0059: "sd",
	0x005a: "syr",
	0x005b: "si",
	0x005c: "chr",
	0x005d: "iu",
	0x005e: "am",
	0x005f: "tzm",
	0x0060: "ks",
	0x0061: "ne",
	0x0062: "fy",
	0x0063: "ps",
	0x0064: "fil",
	0x0065: "dv",
	0x0067: "ff",
	0x0068: "ha",
	0x006a: "yo",
	0x006b: "quz",
	0x006c: "nso",
	0x006d: "ba",
	0x006e: "lb",
	0x006f: "kl",
	0x0070: "ig",
	0x0072: "om",
	0x0073: "ti",
	0x0074: "gn",
	0x0075: "haw",
	0x0077: "so",
	0x0078: "ii",
	0x007a: "arn",
	0x007c: "moh",
	0x007e: "br",
	0x0080: "ug",
	0x0081: "mi",
	0x0082: "oc",
	0x0083: "co",
	0x0084: "gsw",
	0x0085: "sah",
	0x0086: "quc",
	0x0087: "rw",
	0x0088: "wo",
	0x008c: "prs",
	0x0091: "gd",
	0x0092: "ku",
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
	0x0417: "rm-CH",
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
	0x0428: "tg-Cyrl-TJ",
	0x0429: "fa-IR",
	0x042a: "vi-VN",
	0x042b: "hy-AM",
	0x042c: "az-Latn-AZ",
	0x042d: "eu-ES",
	0x042e: "hsb-DE",
	0x042f: "mk-MK",
	0x0430: "st-ZA",
	0x0431: "ts-ZA",
	0x0432: "tn-ZA",
	0x0433: "ve-ZA",
	0x0434: "xh-ZA",
	0x0435: "zu-ZA",
	0x0436: "af-ZA",
	0x0437: "ka-GE",
	0x0438: "fo-FO",
	0x0439: "hi-IN",
	0x043a: "mt-MT",
	0x043b: "se-NO",
	0x043d: "yi-001",
	0x043e: "ms-MY",
	0x043f: "kk-KZ",
	0x0440: "ky-KG",
	0x0441: "sw-KE",
	0x0442: "tk-TM",
	0x0443: "uz-Latn-UZ",
	0x0444: "tt-RU",
	0x0445: "bn-IN",
	0x0446: "pa-IN",
	0x0447: "gu-IN",
	0x0448: "or-IN",
	0x0449: "ta-IN",
	0x044a: "te-IN",
	0x044b: "kn-IN",
	0x044c: "ml-IN",
	0x044d: "as-IN",
	0x044e: "mr-IN",
	0x044f: "sa-IN",
	0x0450: "mn-MN",
	0x0451: "bo-CN",
	0x0452: "cy-GB",
	0x0453: "km-KH",
	0x0454: "lo-LA",
	0x0455: "my-MM",
	0x0456: "gl-ES",
	0x0457: "kok-IN",
	0x045a: "syr-SY",
	0x045b: "si-LK",
	0x045c: "chr-Cher-US",
	0x045d: "iu-Cans-CA",
	0x045e: "am-ET",
	0x045f: "tzm-Arab-MA",
	0x0460: "ks-Arab",
	0x0461: "ne-NP",
	0x0462: "fy-NL",
	0x0463: "ps-AF",
	0x0464: "fil-PH",
	0x0465: "dv-MV",
	0x0467: "ff-NG",
	0x0468: "ha-Latn-NG",
	0x046a: "yo-NG",
	0x046b: "quz-BO",
	0x046c: "nso-ZA",
	0x046d: "ba-RU",
	0x046e: "lb-LU",
	0x046f: "kl-GL",
	0x0470: "ig-NG",
	0x0471: "kr-Latn-NG",
	0x0472: "om-ET",
	0x0473: "ti-ET",
	0x0474: "gn-PY",
	0x0475: "haw-US",
	0x0476: "la-VA",
	0x0477: "so-SO",
	0x0478: "ii-CN",
	0x047a: "arn-CL",
	0x047c: "moh-CA",
	0x047e: "br-FR",
	0x0480: "ug-CN",
	0x0481: "mi-NZ",
	0x0482: "oc-FR",
	0x0483: "co-FR",
	0x0484: "gsw-FR",
	0x0485: "sah-RU",
	0x0486: "quc-Latn-GT",
	0x0487: "rw-RW",
	0x0488: "wo-SN",
	0x048c: "prs-AF",
	0x0491: "gd-GB",
	0x0492: "ku-Arab-IQ",
	0x0501: "qps-ploc",
	0x05fe: "qps-ploca",
	0x0801: "ar-IQ",
	0x0803: "ca-ES-valencia",
	0x0804: "zh-CN",
	0x0807: "de-CH",
	0x0809: "en-GB",
	0x080a: "es-MX",
	0x080c: "fr-BE",
	0x0810: "it-CH",
	0x0813: "nl-BE",
	0x0814: "nn-NO",
	0x0816: "pt-PT",
	0x0818: "ro-MD",
	0x0819: "ru-MD",
	0x081a: "sr-Latn-CS",
	0x081d: "sv-FI",
	0x0820: "ur-IN",
	0x082c: "az-Cyrl-AZ",
	0x082e: "dsb-DE",
	0x0832: "tn-BW",
	0x083b: "se-SE",
	0x083c: "ga-IE",
	0x083e: "ms-BN",
	0x0843: "uz-Cyrl-UZ",
	0x0845: "bn-BD",
	0x0846: "pa-Arab-PK",
	0x0849: "ta-LK",
	0x0850: "mn-Mong-CN",
	0x0859: "sd-Arab-PK",
	0x085d: "iu-Latn-CA",
	0x085f: "tzm-Latn-DZ",
	0x0860: "ks-Deva-IN",
	0x0861: "ne-IN",
	0x0867: "ff-Latn-SN",
	0x086b: "quz-EC",
	0x0873: "ti-ER",
	0x09ff: "qps-plocm",
	0x0c01: "ar-EG",
	0x0c04: "zh-HK",
	0x0c07: "de-AT",
	0x0c09: "en-AU",
	0x0c0a: "es-ES",
	0x0c0c: "fr-CA",
	0x0c1a: "sr-Cyrl-CS",
	0x0c3b: "se-FI",
	0x0c50: "mn-Mong-MN",
	0x0c51: "dz-BT",
	0x0c6b: "quz-PE",
	0x1001: "ar-LY",
	0x1004: "zh-SG",
	0x1007: "de-LU",
	0x1009: "en-CA",
	0x100a: "es-GT",
	0x100c: "fr-CH",
	0x101a: "hr-BA",
	0x103b: "smj-NO",
	0x1401: "ar-DZ",
	0x1404: "zh-MO",
	0x1407: "de-LI",
	0x1409: "en-NZ",
	0x140a: "es-CR",
	0x140c: "fr-LU",
	0x141a: "bs-Latn-BA",
	0x143b: "smj-SE",
	0x1801: "ar-MA",
	0x1809: "en-IE",
	0x180a: "es-PA",
	0x180c: "fr-MC",
	0x181a: "sr-Latn-BA",
	0x183b: "sma-NO",
	0x1c01: "ar-TN",
	0x1c09: "en-ZA",
	0x1c0a: "es-DO",
	0x1c0c: "fr-029",
	0x1c1a: "sr-Cyrl-BA",
	0x1c3b: "sma-SE",
	0x2001: "ar-OM",
	0x2009: "en-JM",
	0x200a: "es-VE",
	0x200c: "fr-RE",
	0x201a: "bs-Cyrl-BA",
	0x203b: "sms-FI",
	0x2401: "ar-YE",
	0x2409: "en-029",
	0x240a: "es-CO",
	0x240c: "fr-CD",
	0x241a: "sr-Latn-RS",
	0x243b: "smn-FI",
	0x2801: "ar-SY",
	0x2809: "en-BZ",
	0x280a: "es-PE",
	0x280c: "fr-SN",
	0x281a: "sr-Cyrl-RS",
	0x2c01: "ar-JO",
	0x2c09: "en-TT",
	0x2c0a: "es-AR",
	0x2c0c: "fr-CM",
	0x2c1a: "sr-Latn-ME",
	0x3001: "ar-LB",
	0x3009: "en-ZW",
	0x300a: "es-EC",
	0x300c: "fr-CI",
	0x301a: "sr-Cyrl-ME",
	0x3401: "ar-KW",
	0x3409: "en-PH",
	0x340a: "es-CL",
	0x340c: "fr-ML",
	0x3801: "ar-AE",
	0x380a: "es-UY",
	0x380c: "fr-MA",
	0x3c01: "ar-BH",
	0x3c09: "en-HK",
	0x3c0a: "es-PY",
	0x3c0c: "fr-HT",
	0x4001: "ar-QA",
	0x4009: "en-IN",
	0x400a: "es-BO",
	0x4409: "en-MY",
	0x440a: "es-SV",
	0x4809: "en-SG",
	0x480a: "es-HN",
	0x4c09: "en-AE",
	0x4c0a: "es-NI",
	0x500a: "es-PR",
	0x540a: "es-US",
	0x580a: "es-419",
	0x5c0a: "es-CU",
	0x641a: "bs-Cyrl",
	0x681a: "bs-Latn",
	0x6c1a: "sr-Cyrl",
	0x701a: "sr-Latn",
	0x703b: "smn",
	0x742c: "az-Cyrl",
	0x743b: "sms",
	0x7804: "zh",
	0x7814: "nn",
	0x781a: "bs",
	0x782c: "az-Latn",
	0x783b: "sma",
	0x7843: "uz-Cyrl",
	0x7850: "mn-Cyrl",
	0x785d: "iu-Cans",
	0x7c04: "zh-Hant",
	0x7c14: "nb",
	0x7c1a: "sr",
	0x7c28: "tg-Cyrl",
	0x7c2e: "dsb",
	0x7c3b: "smj",
	0x7c43: "uz-Latn",
	0x7c46: "pa-Arab",
	0x7c50: "mn-Mong",
	0x7c59: "sd-Arab",
	0x7c5c: "chr-Cher",
	0x7c5d: "iu-Latn",
	0x7c5f: "tzm-Latn",
	0x7c67: "ff-Latn",
	0x7c68: "ha-Latn",
	0x7c92: "ku-Arab"
}

// The language tag of a Windows language identifier with a row of its own; undefined otherwise.
export function lcidTag(lcid: number): string | undefined {
	return LCIDS[lcid]
}

// A Windows language identifier as ST_Lang's four hex digits.
export function lcidHex(lcid: number): string {
	return lcid.toString(16).toUpperCase().padStart(4, "0")
}

// A language tag for a w:lang or w:lid value (ST_Lang: a tag, or a Windows language identifier in hex). An
// identifier without a row of its own gives its primary language's tag (the low 10 bits); undefined when that is
// unknown too.
export function languageTag(lid: string): string | undefined {
	const hex = /^(?:0x)?([0-9A-Fa-f]{4})$/.exec(lid)

	if (hex === null) return lid

	const lcid = Number.parseInt(hex[1] ?? "", 16)

	return LCIDS[lcid] ?? LCIDS[lcid & 0x3ff]
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

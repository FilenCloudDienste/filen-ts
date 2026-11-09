import { territoryCurrency, type SheetLocale } from "@filen/office/core/sheet"
import { numFmtLocaleOf } from "@/features/spreadsheet/formulaBar/numFmtLocale"

// The locale entries are typed in, from the browser's formatting locale (the core reads no Intl locale; the app
// injects it): its decimal point and grouping, its date order, ";" between arguments where "," is the decimal
// point, as Excel types formulas there, and the currency symbols text in formulas reads as a number with. Files keep
// en-US syntax whatever it is. With it, numFmt: the patterns and names numbers and dates show in (numFmtLocale.ts).
// Built once per language: every grid, dialog and export shares the same object.
const built = new Map<string, SheetLocale>()

export function sheetLocaleOf(language: string): SheetLocale {
	let locale = built.get(language)

	if (locale === undefined) {
		locale = buildSheetLocale(language)
		built.set(language, locale)
	}

	return locale
}

function buildSheetLocale(language: string): SheetLocale {
	let decimal = "."
	let group = ","
	let dateOrder: SheetLocale["dateOrder"] = "mdy"

	try {
		for (const part of new Intl.NumberFormat(language).formatToParts(12345.6)) {
			if (part.type === "decimal") decimal = part.value
			else if (part.type === "group") group = part.value
		}

		const order = new Intl.DateTimeFormat(language, { year: "numeric", month: "2-digit", day: "2-digit" })
			.formatToParts(new Date(2000, 10, 22))
			.map(part => part.type)
			.filter(type => type === "year" || type === "month" || type === "day")
			.map(type => type.charAt(0))
			.join("")

		if (order === "dmy" || order === "ymd" || order === "mdy") dateOrder = order
	} catch {
		// An unknown language tag: en-US's.
	}

	const currencies = currencySymbols(language)

	return {
		decimal,
		group,
		argument: decimal === "," ? ";" : ",",
		dateOrder,
		...(currencies.length > 0 && { currencies }),
		numFmt: numFmtLocaleOf(language, decimal, group)
	}
}

// The symbols of the locale's region's currency (Unicode CLDR's territory currency, territoryCurrency): the one the
// locale writes ("￥" in ja-JP) and the currency's narrow one ("¥"). Either may stand before or after the number, so
// the side the locale writes it on is not needed.
function currencySymbols(language: string): string[] {
	try {
		const region = new Intl.Locale(language).maximize().region
		const currency = region === undefined ? undefined : territoryCurrency(region)

		if (currency === undefined) return []

		const symbols = new Set<string>()

		for (const [tag, display] of [
			[language, "symbol"],
			[language, "narrowSymbol"],
			["en", "narrowSymbol"]
		] as const) {
			for (const part of new Intl.NumberFormat(tag, { style: "currency", currency, currencyDisplay: display }).formatToParts(1)) {
				if (part.type === "currency") symbols.add(part.value)
			}
		}

		return [...symbols]
	} catch {
		return []
	}
}

// The browser's formatting language.
export function browserLanguage(): string {
	return typeof navigator === "undefined" ? "en-US" : (navigator.languages[0] ?? navigator.language)
}

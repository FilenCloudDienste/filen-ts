import { territoryCurrency, type SheetLocale } from "@filen/office/core/sheet"
import type { SheetShortcut } from "@filen/office/react/sheet"
import { numFmtLocaleOf, shortcutDateTimeCodes } from "@/features/spreadsheet/formulaBar/numFmtLocale"

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
function currencyOf(language: string): string | undefined {
	const region = new Intl.Locale(language).maximize().region

	return region === undefined ? undefined : territoryCurrency(region)
}

function currencySymbols(language: string): string[] {
	try {
		const currency = currencyOf(language)

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

// Text a format code shows as it is, quoted (each character escaped where it holds a quote); no-break spaces as plain
// ones, as the system patterns have them.
function quotedText(raw: string): string {
	const text = raw.replace(/[\u00a0\u202f]/gu, " ")

	if (text === "") return ""

	return text.includes('"') ? Array.from(text, ch => `\\${ch}`).join("") : `"${text}"`
}

// One section of a currency code from how the locale writes an amount: the number as `number`, the symbol and the
// text around it quoted, the minus sign and an accounting negative's parentheses as they are.
function currencySection(parts: readonly Intl.NumberFormatPart[], number: string): string {
	let code = ""
	let text = ""
	let numbered = false

	const flush = (): void => {
		code += quotedText(text)
		text = ""
	}

	for (const part of parts) {
		switch (part.type) {
			case "integer":
			case "group":
			case "decimal":
			case "fraction":
				if (!numbered) {
					flush()
					code += number
					numbered = true
				}

				break
			case "minusSign":
				flush()
				code += "-"
				break
			case "literal":
				if (part.value === "(" || part.value === ")") {
					flush()
					code += part.value
				} else {
					text += part.value
				}

				break
			default:
				text += part.value
		}
	}

	flush()

	return code
}

// Excel's currency shortcut (Ctrl+Shift+$) in the locale's currency, as Excel follows the system's: two decimals (the
// currency's own count), the symbol where the locale writes it and the locale's negative (en-US's parentheses, a minus
// sign elsewhere), as Intl's accounting style writes them. Null where the locale names no currency.
function currencyShortcutCode(language: string): string | null {
	try {
		const currency = currencyOf(language)

		if (currency === undefined) return null

		const format = new Intl.NumberFormat(language, { style: "currency", currency, currencySign: "accounting", numberingSystem: "latn" })
		const digits = format.resolvedOptions().maximumFractionDigits ?? 2
		const number = digits > 0 ? `#,##0.${"0".repeat(digits)}` : "#,##0"
		const positive = currencySection(format.formatToParts(1_234_567.5), number)
		const negative = currencySection(format.formatToParts(-1_234_567.5), number)

		// Room for the parenthesis, so positives and negatives line up (Excel's "_)").
		return negative.endsWith(")") && !positive.endsWith(")") ? `${positive}_);${negative}` : `${positive};${negative}`
	} catch {
		return null
	}
}

const shortcutFormats = new Map<string, Readonly<Partial<Record<SheetShortcut, string>>>>()

// The number formats Excel's format shortcuts apply where they follow the locale (the grid's SHORTCUT_FORMATS has
// en-US's): the currency, the date and the time. Built once per language.
export function sheetShortcutFormats(language: string): Readonly<Partial<Record<SheetShortcut, string>>> {
	let formats = shortcutFormats.get(language)

	if (formats === undefined) {
		const currency = currencyShortcutCode(language)
		const dateTime = shortcutDateTimeCodes(language, sheetLocaleOf(language).numFmt ?? numFmtLocaleOf(language, ".", ","))

		formats = {
			...(currency !== null && { formatCurrency: currency }),
			...(dateTime !== null && { formatDate: dateTime.date, formatTime: dateTime.time })
		}
		shortcutFormats.set(language, formats)
	}

	return formats
}

// The browser's formatting language.
export function browserLanguage(): string {
	return typeof navigator === "undefined" ? "en-US" : (navigator.languages[0] ?? navigator.language)
}

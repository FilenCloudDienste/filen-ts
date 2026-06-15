import * as ExpoLocalization from "expo-localization"
import { type TFunction } from "i18next"

export let intlLanguage: string = "en-US"

try {
	intlLanguage =
		ExpoLocalization.getLocales()
			.filter(lang => lang.languageTag)
			.at(0)?.languageTag ?? "en-US"
} catch (e) {
	console.error(e)
}

// Keeps date/time formatting aligned with a runtime language switch. Resets the cached
// locale info so the next format call re-derives MDY/DMY/YMD + 12h/24h from the new language.
// Known limitation (Risk 5): already-mounted date displays won't re-render until their next
// render — they'll keep the old format until then.
export function setIntlLanguage(lang: string): void {
	intlLanguage = lang
	cachedLocaleInfo = null
}

/**
 * Fast date formatting functions optimized for Hermes JS engine
 * Replaces slow Intl.DateTimeFormat calls with manual implementations
 * Automatically detects and uses user's locale for formatting
 */

/**
 * Detect user's locale and date formatting preferences
 * This is called once and cached for performance
 */
let cachedLocaleInfo: {
	locale: string
	dateFormat: "MDY" | "DMY" | "YMD"
	dateSeparator: string
	timeSeparator: string
	use24Hour: boolean
} | null = null

function detectLocaleInfo() {
	if (cachedLocaleInfo) {
		return cachedLocaleInfo
	}

	// Get user's locale
	const locale = intlLanguage

	// Determine date format based on locale
	// Most European countries: DD/MM/YYYY or DD.MM.YYYY
	// US, Philippines, some others: MM/DD/YYYY
	// China, Japan, Korea, Iran, etc.: YYYY-MM-DD
	let dateFormat: "MDY" | "DMY" | "YMD" = "MDY"
	let dateSeparator = "/"
	const timeSeparator = ":"
	let use24Hour = true
	const lang = locale.toLowerCase()

	// YMD format (YYYY-MM-DD)
	if (
		lang.startsWith("zh") ||
		lang.startsWith("ja") ||
		lang.startsWith("ko") ||
		lang.startsWith("fa") ||
		lang.startsWith("hu") ||
		lang.startsWith("lt") ||
		lang.startsWith("mn")
	) {
		dateFormat = "YMD"
		dateSeparator = "-"
	}
	// MDY format (MM/DD/YYYY) + 12-hour time
	else if (lang.startsWith("en-us") || lang.startsWith("en-ph") || lang.startsWith("en-ca") || lang.startsWith("es-us")) {
		dateFormat = "MDY"
		dateSeparator = "/"
		use24Hour = false
	}
	// DMY format (DD/MM/YYYY) - Most of the world
	else {
		dateFormat = "DMY"
		// Some locales use dots instead of slashes
		if (
			lang.startsWith("de") ||
			lang.startsWith("da") ||
			lang.startsWith("no") ||
			lang.startsWith("nb") ||
			lang.startsWith("nn") ||
			lang.startsWith("fi") ||
			lang.startsWith("ru") ||
			lang.startsWith("cs") ||
			lang.startsWith("sk") ||
			lang.startsWith("sl")
		) {
			dateSeparator = "."
		} else {
			dateSeparator = "/"
		}

		// English DMY locales still use 12-hour time
		if (
			lang.startsWith("en-gb") ||
			lang.startsWith("en-au") ||
			lang.startsWith("en-nz") ||
			lang.startsWith("en-ie") ||
			lang.startsWith("en-za") ||
			lang.startsWith("en-in")
		) {
			use24Hour = false
		}
	}

	cachedLocaleInfo = {
		locale,
		dateFormat,
		dateSeparator,
		timeSeparator,
		use24Hour
	}

	return cachedLocaleInfo
}

/**
 * Pads a number with leading zero if needed
 */
function pad2(num: number): string {
	return num < 10 ? "0" + num : "" + num
}

/**
 * Converts various timestamp formats to Date object
 */
function toDate(timestamp: number | Date): Date {
	if (timestamp instanceof Date) {
		return timestamp
	}

	// Handle both seconds and milliseconds timestamps
	// If timestamp is less than year 2100 in seconds (4102444800), treat as seconds
	if (timestamp < 4102444800) {
		return new Date(timestamp * 1000)
	}

	return new Date(timestamp)
}

/**
 * Format date according to locale preferences
 */
function formatDatePart(year: number, month: string, day: string): string {
	const info = detectLocaleInfo()

	switch (info.dateFormat) {
		case "YMD": {
			return `${year}${info.dateSeparator}${month}${info.dateSeparator}${day}`
		}

		case "DMY": {
			return `${day}${info.dateSeparator}${month}${info.dateSeparator}${year}`
		}

		case "MDY":
		default: {
			return `${month}${info.dateSeparator}${day}${info.dateSeparator}${year}`
		}
	}
}

/**
 * Format time according to locale preferences (12h vs 24h)
 */
function formatTimePart(hours: number, minutes: string, seconds: string): string {
	const info = detectLocaleInfo()

	if (info.use24Hour) {
		return `${pad2(hours)}${info.timeSeparator}${minutes}${info.timeSeparator}${seconds}`
	} else {
		// 12-hour format with AM/PM
		const hours12 = hours % 12 || 12
		const ampm = hours < 12 ? "AM" : "PM"

		return `${pad2(hours12)}${info.timeSeparator}${minutes}${info.timeSeparator}${seconds} ${ampm}`
	}
}

/**
 * Fast replacement for Intl.DateTimeFormat with full date and time
 * Automatically uses user's locale for formatting
 *
 * @param timestamp - Unix timestamp (seconds or milliseconds) or Date object
 * @returns Formatted string according to user's locale
 *
 * @example
 * // US locale: "01/15/2025, 02:30:45 PM"
 * // EU locale: "15/01/2025, 14:30:45"
 * // Asian locale: "2025-01-15, 14:30:45"
 */
export function simpleDate(timestamp: number | Date): string {
	const date = toDate(timestamp)
	const year = date.getFullYear()
	const month = pad2(date.getMonth() + 1)
	const day = pad2(date.getDate())
	const hours = date.getHours()
	const minutes = pad2(date.getMinutes())
	const seconds = pad2(date.getSeconds())
	const datePart = formatDatePart(year, month, day)
	const timePart = formatTimePart(hours, minutes, seconds)

	return `${datePart}, ${timePart}`
}

/**
 * Fast replacement for Intl.DateTimeFormat with date only (no time)
 * Automatically uses user's locale for formatting
 *
 * @param timestamp - Unix timestamp (seconds or milliseconds) or Date object
 * @returns Formatted string according to user's locale
 *
 * @example
 * // US locale: "01/15/2025"
 * // EU locale: "15/01/2025"
 * // Asian locale: "2025-01-15"
 */
export function simpleDateNoTime(timestamp: number | Date): string {
	const date = toDate(timestamp)
	const year = date.getFullYear()
	const month = pad2(date.getMonth() + 1)
	const day = pad2(date.getDate())

	return formatDatePart(year, month, day)
}

/**
 * Fast replacement for Intl.DateTimeFormat with time only (no date)
 * Automatically uses user's locale for 12h/24h format
 *
 * @param timestamp - Unix timestamp (seconds or milliseconds) or Date object
 * @returns Formatted string according to user's locale
 *
 * @example
 * // US locale: "02:30:45 PM"
 * // EU locale: "14:30:45"
 */
export function simpleDateNoDate(timestamp: number | Date): string {
	const date = toDate(timestamp)
	const hours = date.getHours()
	const minutes = pad2(date.getMinutes())
	const seconds = pad2(date.getSeconds())

	return formatTimePart(hours, minutes, seconds)
}

// Number of days after which formatRelativeTime falls back to the absolute date.
const RELATIVE_TIME_CUTOFF_DAYS = 7

/**
 * Formats a timestamp as a relative time ("Just now", "5 minutes ago", "2 hours ago",
 * "3 days ago") for the recent past, falling back to the locale-aware full date
 * (`simpleDate`) once it is older than `RELATIVE_TIME_CUTOFF_DAYS`. Hermes-safe (no Intl)
 * and localized via the i18next plural pipeline. `t` is passed in — time.ts must not import
 * the i18n module, since i18n.ts already depends on this module for `setIntlLanguage`.
 *
 * @param timestamp - Unix timestamp (seconds or milliseconds) or Date object
 * @param t - the i18next translation function (component `t` or module-level `i18n.t`)
 * @param options.absolute - formatter used past the cutoff (default `simpleDate`); pass
 *   `simpleDateNoTime` for compact surfaces such as chat list rows
 */
export function formatRelativeTime(
	timestamp: number | Date,
	t: TFunction,
	options?: {
		absolute?: (timestamp: number | Date) => string
	}
): string {
	const date = toDate(timestamp)
	const diffSeconds = Math.floor((Date.now() - date.getTime()) / 1000)

	// Clock skew / future timestamps collapse to "just now" rather than a negative count.
	if (diffSeconds < 60) {
		return t("relative_just_now")
	}

	const diffMinutes = Math.floor(diffSeconds / 60)

	if (diffMinutes < 60) {
		return t("relative_minutes_ago", { count: diffMinutes })
	}

	const diffHours = Math.floor(diffMinutes / 60)

	if (diffHours < 24) {
		return t("relative_hours_ago", { count: diffHours })
	}

	const diffDays = Math.floor(diffHours / 24)

	if (diffDays < RELATIVE_TIME_CUTOFF_DAYS) {
		return t("relative_days_ago", { count: diffDays })
	}

	return (options?.absolute ?? simpleDate)(timestamp)
}

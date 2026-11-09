/**
 * The UI languages every Filen app ships, their native names and the resolver from locale tags to one of them.
 * Import-free and reachable only through "@filen/shared/languages", so it costs nothing on a boot path and loads in
 * any plain Node context. filen-mobile keeps its own literal copy for app.config.ts (a test holds the two equal):
 * changing this list changes the mobile app's declared localizations, which needs a native release.
 */

export const SUPPORTED_LANGUAGES = [
	"en",
	"de",
	"es",
	"fr",
	"it",
	"pt-BR",
	"pt-PT",
	"ru",
	"ja",
	"zh",
	"zh-TW",
	"bn",
	"cs",
	"da",
	"fi",
	"hi",
	"hu",
	"id",
	"ko",
	"nl",
	"no",
	"pl",
	"ro",
	"sv",
	"th",
	"tr",
	"uk",
	"vi"
] as const

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export type TargetLanguage = Exclude<SupportedLanguage, "en">

export const DEFAULT_LANGUAGE: SupportedLanguage = "en"

// Native names, never translated.
export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
	en: "English",
	de: "Deutsch",
	es: "Español",
	fr: "Français",
	it: "Italiano",
	"pt-BR": "Português (Brasil)",
	"pt-PT": "Português (Portugal)",
	ru: "Русский",
	ja: "日本語",
	zh: "简体中文",
	"zh-TW": "繁體中文",
	bn: "বাংলা",
	cs: "Čeština",
	da: "Dansk",
	fi: "Suomi",
	hi: "हिन्दी",
	hu: "Magyar",
	id: "Bahasa Indonesia",
	ko: "한국어",
	nl: "Nederlands",
	no: "Norsk",
	pl: "Polski",
	ro: "Română",
	sv: "Svenska",
	th: "ไทย",
	tr: "Türkçe",
	uk: "Українська",
	vi: "Tiếng Việt"
}

export function isSupportedLanguage(value: string | null | undefined): value is SupportedLanguage {
	return value !== null && value !== undefined && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

const TRADITIONAL_CHINESE_REGIONS = new Set(["TW", "HK", "MO"])

// Norwegian arrives as Bokmål or Nynorsk; the catalog is one "no".
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { nb: "no", nn: "no" }

function findSupported<L extends string>(candidate: string, supported: readonly L[]): L | undefined {
	const lower = candidate.toLowerCase()

	return supported.find(lang => lang.toLowerCase() === lower)
}

// One BCP-47 tag (or a POSIX-style "pt_BR") to a supported language, or undefined. Subtags are split by hand:
// Hermes has no Intl.Locale.
function resolveTag<L extends string>(tag: string, supported: readonly L[]): L | undefined {
	const parts = tag.trim().replaceAll("_", "-").split("-")
	const rawLanguage = parts[0]?.toLowerCase() ?? ""

	if (rawLanguage.length === 0) {
		return undefined
	}

	const language = LANGUAGE_ALIASES[rawLanguage] ?? rawLanguage
	const script = parts.slice(1).find(part => part.length === 4)?.toLowerCase()
	const region = parts.slice(1).find(part => part.length === 2 || /^\d{3}$/.test(part))?.toUpperCase()
	const exact = findSupported(tag.trim().replaceAll("_", "-"), supported)

	if (exact !== undefined) {
		return exact
	}

	if (language === "zh") {
		// An explicit script wins over the region (zh-Hans-HK is Simplified).
		const traditional = script === "hant" || (script !== "hans" && region !== undefined && TRADITIONAL_CHINESE_REGIONS.has(region))

		return traditional ? (findSupported("zh-TW", supported) ?? findSupported("zh", supported)) : findSupported("zh", supported)
	}

	if (region !== undefined) {
		const regional = findSupported(`${language}-${region}`, supported)

		if (regional !== undefined) {
			return regional
		}
	}

	const base = findSupported(language, supported)

	if (base !== undefined) {
		return base
	}

	// Portuguese ships only as regional catalogs; any other Portuguese reads Brazilian (the larger user base).
	if (language === "pt") {
		return findSupported("pt-BR", supported)
	}

	return undefined
}

/**
 * The first of `tags` (most preferred first, e.g. navigator.languages) that maps to one of `supported`, or null.
 * Traditional Chinese (script Hant, or region TW/HK/MO without an explicit Hans) maps to zh-TW, Norwegian Bokmål and
 * Nynorsk to no, and a Portuguese without a supported region to pt-BR; otherwise the full tag, then language plus
 * region, then the bare language.
 */
export function resolveLanguage<L extends string>(tags: readonly string[], supported: readonly L[]): L | null {
	for (const tag of tags) {
		const match = resolveTag(tag, supported)

		if (match !== undefined) {
			return match
		}
	}

	return null
}

/**
 * The non-English catalogs a language reads through, most specific first: the language and its supported base
 * (zh-TW reads zh before English), as i18next resolves them.
 */
export function languageChain<L extends string>(language: L, supported: readonly L[]): L[] {
	if (language === "en") {
		return []
	}

	const chain = [language]
	const base = supported.find(lang => lang === language.split("-")[0])

	if (base !== undefined && base !== language && base !== "en") {
		chain.push(base)
	}

	return chain
}

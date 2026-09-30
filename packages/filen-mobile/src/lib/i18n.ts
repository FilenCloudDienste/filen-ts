import "intl-pluralrules"

import i18n, { type Resource } from "i18next"
import { initReactI18next } from "react-i18next"
import * as ExpoLocalization from "expo-localization"
import secureStore from "@/lib/secureStore"
import { setIntlLanguage } from "@/lib/time"
import { SUPPORTED_LANGUAGES } from "@/locales/languages"
import { DEFAULT_LANGUAGE, LANGUAGE_SECURE_STORE_KEY, type Language } from "@/lib/language"

import { en } from "@/locales/en"
import { CATALOG_LOADERS } from "@/locales/catalogs"

function isSupportedLanguage(value: string | null | undefined): value is Language {
	return value !== null && value !== undefined && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

// Catalogs i18next resolves `lang` through besides `en`: itself plus its supported base language
// (zh-TW → zh), mirroring toResolveHierarchy under the unchanged supportedLngs.
function catalogChain(lang: Language): Exclude<Language, "en">[] {
	const chain: Exclude<Language, "en">[] = []

	if (lang !== "en") {
		chain.push(lang)
	}

	const base = lang.split("-")[0]

	if (base !== lang && isSupportedLanguage(base) && base !== "en") {
		chain.push(base)
	}

	return chain
}

// Resolves the language to boot with. Precedence: persisted (secureStore) → device locale
// → DEFAULT_LANGUAGE. Reads via the async `get` (not the sync cache) so it doesn't couple to
// cache internals — initI18n is async anyway.
export async function getInitialLanguage(): Promise<Language> {
	const persisted = await secureStore.get<Language>(LANGUAGE_SECURE_STORE_KEY)

	if (isSupportedLanguage(persisted)) {
		return persisted
	}

	const locale = ExpoLocalization.getLocales()[0]

	// Prefer the full BCP-47 tag so region-qualified locales ("pt-PT", "pt-BR") match a
	// region-specific catalog before the bare code is tried. Languages without a region
	// variant fall through to the bare languageCode below, so detection does not regress.
	const deviceTag = locale?.languageTag

	if (isSupportedLanguage(deviceTag)) {
		return deviceTag
	}

	const deviceLanguage = locale?.languageCode

	const deviceRegion = locale?.languageRegionCode ?? locale?.regionCode
	const normalizedTag = deviceTag?.toLowerCase()
	const isTraditionalChinese =
		deviceLanguage === "zh" &&
		// An explicit Simplified script wins over a Traditional-majority region (zh-Hans-HK).
		locale?.languageScriptCode !== "Hans" &&
		(locale?.languageScriptCode === "Hant" ||
			deviceRegion === "TW" ||
			deviceRegion === "HK" ||
			deviceRegion === "MO" ||
			normalizedTag === "zh-hant" ||
			normalizedTag?.startsWith("zh-hant-") === true ||
			normalizedTag === "zh-tw" ||
			normalizedTag === "zh-hk" ||
			normalizedTag === "zh-mo")

	if (isTraditionalChinese) {
		return "zh-TW"
	}

	if (isSupportedLanguage(deviceLanguage)) {
		return deviceLanguage
	}

	// Portuguese now ships only as region variants; a generic "pt" device whose tag did not
	// match a region catalog above defaults to Brazilian Portuguese (the larger user base).
	if (deviceLanguage === "pt") {
		return "pt-BR"
	}

	return DEFAULT_LANGUAGE
}

export async function initI18n(): Promise<void> {
	const lng = await getInitialLanguage()
	const resources: Resource = {
		en: {
			translation: en
		}
	}

	for (const code of catalogChain(lng)) {
		resources[code] = {
			translation: CATALOG_LOADERS[code]()
		}
	}

	await i18n.use(initReactI18next).init({
		resources,
		lng,
		fallbackLng: "en",
		supportedLngs: [...SUPPORTED_LANGUAGES],
		keySeparator: false,
		nsSeparator: false,
		interpolation: {
			escapeValue: false
		},
		react: {
			useSuspense: false
		}
	})

	// Use the full BCP-47 device tag (e.g. "en-US") so detectLocaleInfo region guards
	// (startsWith("en-us"), "en-gb", etc.) resolve correctly. The bare Language code from
	// i18next ("en", "de", …) intentionally does NOT replace this — date/clock format is
	// a device-region concern, not a UI-language concern.
	const deviceTag = ExpoLocalization.getLocales()[0]?.languageTag

	setIntlLanguage(deviceTag ?? lng)
}

// Side-effects ONLY. Persistence is owned by `setLanguage`/`useSecureStore` (Risk 4) — calling
// this must NOT write to secureStore, or the language double-persists.
export async function changeAppLanguage(lang: Language): Promise<void> {
	// Registered before changeLanguage, which then resolves exactly as with preloaded bundles.
	// skipCopy skips i18next's JSON round-trip copy of the catalog.
	for (const code of catalogChain(lang)) {
		if (!i18n.hasResourceBundle(code, "translation")) {
			i18n.addResourceBundle(code, "translation", CATALOG_LOADERS[code](), false, true, {
				silent: true,
				skipCopy: true
			})
		}
	}

	await i18n.changeLanguage(lang)

	// Keep intlLanguage sourced from the device's full BCP-47 tag so region-sensitive
	// date/clock guards (e.g. startsWith("en-us")) remain reachable after a language
	// switch. If the device provides no tag, fall back to the bare language code.
	const deviceTag = ExpoLocalization.getLocales()[0]?.languageTag

	setIntlLanguage(deviceTag ?? lang)
}

// Whether a language actually ships any translations yet. `en` is always true (it's the
// source). A target language is true only once its `<lang>.json` catalog has ≥1 key — until
// the CI pipeline fills the empty stubs, the picker must not offer a fake option that would
// just fall back to English. Reads the catalog through its loader (not i18n.getResourceBundle,
// which only holds the languages registered so far).
export function hasTranslations(lang: Language): boolean {
	return lang === "en" || Object.keys(CATALOG_LOADERS[lang]()).length > 0
}

export const t = i18n.t.bind(i18n)

export default i18n

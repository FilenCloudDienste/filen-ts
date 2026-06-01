import "intl-pluralrules"

import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import * as ExpoLocalization from "expo-localization"
import secureStore from "@/lib/secureStore"
import { setIntlLanguage } from "@/lib/time"
import { SUPPORTED_LANGUAGES } from "@/locales/languages"
import { DEFAULT_LANGUAGE, LANGUAGE_SECURE_STORE_KEY, type Language } from "@/lib/language"

import { en } from "@/locales/en"

const resources = {
	en: {
		translation: en
	}
}

function isSupportedLanguage(value: string | null | undefined): value is Language {
	return value !== null && value !== undefined && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

// Resolves the language to boot with. Precedence: persisted (secureStore) → device locale
// → DEFAULT_LANGUAGE. Reads via the async `get` (not the sync cache) so it doesn't couple to
// cache internals — initI18n is async anyway.
export async function getInitialLanguage(): Promise<Language> {
	const persisted = await secureStore.get<Language>(LANGUAGE_SECURE_STORE_KEY)

	if (isSupportedLanguage(persisted)) {
		return persisted
	}

	const deviceLanguage = ExpoLocalization.getLocales()[0]?.languageCode

	if (isSupportedLanguage(deviceLanguage)) {
		return deviceLanguage
	}

	return DEFAULT_LANGUAGE
}

export async function initI18n(): Promise<void> {
	const lng = await getInitialLanguage()

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

	setIntlLanguage(lng)
}

// Side-effects ONLY. Persistence is owned by `setLanguage`/`useSecureStore` (Risk 4) — calling
// this must NOT write to secureStore, or the language double-persists.
export async function changeAppLanguage(lang: Language): Promise<void> {
	await i18n.changeLanguage(lang)

	setIntlLanguage(lang)
}

export const t = i18n.t.bind(i18n)

export default i18n

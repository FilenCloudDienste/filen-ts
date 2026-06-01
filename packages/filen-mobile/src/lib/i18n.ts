import "intl-pluralrules"

import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import * as ExpoLocalization from "expo-localization"
import secureStore from "@/lib/secureStore"
import { setIntlLanguage } from "@/lib/time"
import { SUPPORTED_LANGUAGES } from "@/locales/languages"
import { DEFAULT_LANGUAGE, LANGUAGE_SECURE_STORE_KEY, type Language } from "@/lib/language"

import { en } from "@/locales/en"

// Target-language catalogs are plain JSON value maps, filled by the CI translation pipeline
// (scripts/translate-i18n.ts). They start out as empty `{}` stubs and i18next falls back to
// `en` for any missing key. Only `en` is type-checked (via the `typeof en` augmentation in
// src/i18next.d.ts); the others are untyped value maps keyed off the English key set.
import deJson from "@/locales/de.json"
import esJson from "@/locales/es.json"
import frJson from "@/locales/fr.json"
import itJson from "@/locales/it.json"
import ptJson from "@/locales/pt.json"
import ruJson from "@/locales/ru.json"
import jaJson from "@/locales/ja.json"
import zhJson from "@/locales/zh.json"
import bnJson from "@/locales/bn.json"
import csJson from "@/locales/cs.json"
import daJson from "@/locales/da.json"
import fiJson from "@/locales/fi.json"
import hiJson from "@/locales/hi.json"
import huJson from "@/locales/hu.json"
import idJson from "@/locales/id.json"
import koJson from "@/locales/ko.json"
import nlJson from "@/locales/nl.json"
import noJson from "@/locales/no.json"
import plJson from "@/locales/pl.json"
import roJson from "@/locales/ro.json"
import svJson from "@/locales/sv.json"
import thJson from "@/locales/th.json"
import trJson from "@/locales/tr.json"
import ukJson from "@/locales/uk.json"
import viJson from "@/locales/vi.json"

const resources = {
	en: {
		translation: en
	},
	de: {
		translation: deJson
	},
	es: {
		translation: esJson
	},
	fr: {
		translation: frJson
	},
	it: {
		translation: itJson
	},
	pt: {
		translation: ptJson
	},
	ru: {
		translation: ruJson
	},
	ja: {
		translation: jaJson
	},
	zh: {
		translation: zhJson
	},
	bn: {
		translation: bnJson
	},
	cs: {
		translation: csJson
	},
	da: {
		translation: daJson
	},
	fi: {
		translation: fiJson
	},
	hi: {
		translation: hiJson
	},
	hu: {
		translation: huJson
	},
	id: {
		translation: idJson
	},
	ko: {
		translation: koJson
	},
	nl: {
		translation: nlJson
	},
	no: {
		translation: noJson
	},
	pl: {
		translation: plJson
	},
	ro: {
		translation: roJson
	},
	sv: {
		translation: svJson
	},
	th: {
		translation: thJson
	},
	tr: {
		translation: trJson
	},
	uk: {
		translation: ukJson
	},
	vi: {
		translation: viJson
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

// Whether a language actually ships any translations yet. `en` is always true (it's the
// source). A target language is true only once its `<lang>.json` catalog has ≥1 key — until
// the CI pipeline fills the empty stubs, the picker must not offer a fake option that would
// just fall back to English. Reads the imported value maps directly (not i18n.getResourceBundle,
// which only works after init); the resource objects are the same ones registered above.
export function hasTranslations(lang: Language): boolean {
	if (lang === "en") {
		return true
	}

	const bundle = resources[lang]?.translation as Record<string, unknown> | undefined

	return bundle !== undefined && Object.keys(bundle).length > 0
}

export const t = i18n.t.bind(i18n)

export default i18n

import { useSecureStore } from "@/lib/secureStore"

import { SUPPORTED_LANGUAGES } from "@/locales/languages"

export const LANGUAGE_SECURE_STORE_KEY = "appearance.language"

export type Language = (typeof SUPPORTED_LANGUAGES)[number]

export const DEFAULT_LANGUAGE: Language = "en"

// Native names — NEVER translated, never t() keys. Typed by Language so a new
// language forces a label (compile error if missing).
export const LANGUAGE_LABELS: Record<Language, string> = {
	en: "English",
	de: "Deutsch",
	es: "Español",
	fr: "Français",
	it: "Italiano",
	"pt-BR": "Português (Brasil)",
	"pt-PT": "Português (Portugal)",
	ru: "Русский",
	ja: "日本語",
	zh: "中文",
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

export function useLanguage(): [Language, (next: Language | ((prev: Language) => Language)) => void] {
	return useSecureStore<Language>(LANGUAGE_SECURE_STORE_KEY, DEFAULT_LANGUAGE)
}

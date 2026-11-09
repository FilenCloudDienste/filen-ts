import { useSecureStore } from "@/lib/secureStore"

import { SUPPORTED_LANGUAGES } from "@/locales/languages"
import { LANGUAGE_LABELS as SHARED_LANGUAGE_LABELS } from "@filen/shared/languages"

export const LANGUAGE_SECURE_STORE_KEY = "appearance.language"

export type Language = (typeof SUPPORTED_LANGUAGES)[number]

export const DEFAULT_LANGUAGE: Language = "en"

// Native names — NEVER translated, never t() keys; one list shared with the web app. Typed by Language so a new
// language forces a label (compile error if missing).
export const LANGUAGE_LABELS: Record<Language, string> = SHARED_LANGUAGE_LABELS

export function useLanguage(): [Language, (next: Language | ((prev: Language) => Language)) => void] {
	return useSecureStore<Language>(LANGUAGE_SECURE_STORE_KEY, DEFAULT_LANGUAGE)
}

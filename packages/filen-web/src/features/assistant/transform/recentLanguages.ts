import { useEffect, useSyncExternalStore } from "react"
import { type } from "arktype"
import type { TransformLanguage } from "@filen/shared/assistant"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"
import { RECENT_LANGUAGES, TRANSFORM_LANGUAGE_CODES, withRecentLanguage } from "@/features/assistant/transform/transform.logic"

// The translation targets last picked, newest first, kept on this device for the Translate submenu. Read the first
// time a rewrite menu shows, not at boot: nothing needs it before.
const preference = preloadedPreference<readonly TransformLanguage[]>({
	key: "assistant.v1.transformLanguages",
	schema: type.enumerated(...TRANSFORM_LANGUAGE_CODES).array(),
	fallback: [],
	scope: "assistant",
	same: (a, b) => a.length === b.length && a.every((language, index) => language === b[index]),
	normalize: languages => [...new Set(languages)].slice(0, RECENT_LANGUAGES)
})

export function useRecentTransformLanguages(): readonly TransformLanguage[] {
	useEffect(() => {
		void preference.load()
	}, [])

	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export function noteTransformLanguage(language: TransformLanguage): void {
	preference.set(withRecentLanguage(preference.get(), language))
}

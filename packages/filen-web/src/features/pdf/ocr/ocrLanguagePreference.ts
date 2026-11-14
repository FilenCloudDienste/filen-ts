import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { isSupportedLanguage } from "@filen/shared/languages"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"
import { defaultOcrLanguages, isOcrLanguage, type OcrLanguage } from "@/features/pdf/ocr/languages"

// The text recognition languages picked on this device (Settings › Office and the Recognise text dialog), and which
// models this device already downloaded (their size is not shown again; the browser holds them). Read during boot
// (lib/sdk/boot.ts). Nothing picked: the UI language's model, then English.

export interface OcrLanguagePreference {
	// Null: never picked (the default applies).
	readonly languages: readonly string[] | null
	readonly downloaded: readonly string[]
}

const FALLBACK: OcrLanguagePreference = { languages: null, downloaded: [] }

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
	return a === b || (a !== null && b !== null && a.length === b.length && a.every((value, index) => value === b[index]))
}

const preference = preloadedPreference<OcrLanguagePreference>({
	key: "pdf.ocrLanguages.v1",
	schema: type({ languages: "string[] | null", downloaded: "string[]" }),
	fallback: FALLBACK,
	scope: "pdf",
	same: (a, b) => sameList(a.languages, b.languages) && sameList(a.downloaded, b.downloaded)
})

export const loadOcrLanguages = preference.load

export function useOcrLanguagePreference(): OcrLanguagePreference {
	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

// The languages to recognise: the picked ones still offered, else the default for the UI language.
export function pickedOcrLanguages(value: OcrLanguagePreference, uiLanguage: string): OcrLanguage[] {
	const picked = (value.languages ?? []).filter(isOcrLanguage)

	if (picked.length > 0) return [...new Set(picked)]

	return defaultOcrLanguages(isSupportedLanguage(uiLanguage) ? uiLanguage : "en")
}

export function setOcrLanguages(languages: readonly OcrLanguage[]): void {
	const current = preference.get()

	preference.set({ ...current, languages: [...languages] })
}

// After a run loaded these models.
export function markOcrLanguagesDownloaded(languages: readonly OcrLanguage[]): void {
	const current = preference.get()
	const downloaded = [...new Set([...current.downloaded, ...languages])]

	preference.set({ ...current, downloaded })
}

// The models among these not downloaded on this device yet.
export function ocrLanguagesToDownload(value: OcrLanguagePreference, languages: readonly OcrLanguage[]): OcrLanguage[] {
	return languages.filter(language => !value.downloaded.includes(language))
}

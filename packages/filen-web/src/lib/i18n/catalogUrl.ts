import type { SupportedLanguage } from "@filen/shared/languages"

// The translated catalogs are static JSON files, emitted as hashed assets and fetched by URL, so only the active
// language is ever downloaded and parsed; English is in the bundle. Vite turns this template into an eager map of
// asset URLs (no code, nothing lazy); it skips dotfiles (the snapshot and the manifest). Only languages the manifest
// lists are requested, and the pipeline writes the manifest with their files.
export function catalogUrl(lang: SupportedLanguage): string {
	return new URL(`../../locales/${lang}.json`, import.meta.url).href
}

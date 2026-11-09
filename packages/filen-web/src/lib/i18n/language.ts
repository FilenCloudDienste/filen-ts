import { SUPPORTED_LANGUAGES, isSupportedLanguage, languageChain, resolveLanguage, type SupportedLanguage } from "@filen/shared/languages"
import manifest from "@/locales/.catalogs.json"
import { EN_CATALOGS, EN_NAMESPACES } from "@/lib/i18n/catalog"
import { catalogUrl } from "@/lib/i18n/catalogUrl"
import { i18n } from "@/lib/i18n"

// The language pick, in this browser's localStorage. Absent = follow the browser's preferred languages.
export const LANGUAGE_STORAGE_KEY = "filen.language"

// Below this share of the English keys a catalog is not offered: a partial run would show a half-English UI.
const COMPLETENESS_THRESHOLD = 0.95

// How long the first render waits for the active language's catalog before showing English.
export const FIRST_RENDER_WAIT_MS = 2500

const COVERAGE: Readonly<Record<string, number | undefined>> = manifest.languages

function englishKeyCount(): number {
	return EN_NAMESPACES.reduce((sum, ns) => sum + Object.keys(EN_CATALOGS[ns]).length, 0)
}

// Languages whose catalog holds nearly every English key. The manifest is written with the catalogs, so a language
// it lists has a file.
export function offeredLanguages(coverage: Readonly<Record<string, number | undefined>>, total: number): SupportedLanguage[] {
	return SUPPORTED_LANGUAGES.filter(lang => lang === "en" || (coverage[lang] ?? 0) >= total * COMPLETENESS_THRESHOLD)
}

/** English plus every language with a near-complete catalog, in the shared list's order. */
export const AVAILABLE_LANGUAGES: readonly SupportedLanguage[] = offeredLanguages(COVERAGE, englishKeyCount())

function isAvailable(value: string | null): value is SupportedLanguage {
	return isSupportedLanguage(value) && AVAILABLE_LANGUAGES.includes(value)
}

function storedValue(): string | null {
	try {
		return localStorage.getItem(LANGUAGE_STORAGE_KEY)
	} catch {
		return null
	}
}

/** The stored pick, or null when there is none (or it names a language no longer offered). */
export function readStoredLanguage(): SupportedLanguage | null {
	const stored = storedValue()

	return isAvailable(stored) ? stored : null
}

function browserLanguages(): readonly string[] {
	if (typeof navigator === "undefined") {
		return []
	}

	return navigator.languages.length > 0 ? navigator.languages : [navigator.language]
}

/** The stored pick, else the first of the browser's languages that is offered, else English. */
export function detectLanguage(): SupportedLanguage {
	return readStoredLanguage() ?? resolveLanguage(browserLanguages(), AVAILABLE_LANGUAGES) ?? "en"
}

type NestedCatalog = Record<string, Record<string, string>>

// The fetched file must be namespace → key → string; anything else is dropped whole.
export function parseCatalog(value: unknown): NestedCatalog | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null
	}

	const catalog: NestedCatalog = {}

	for (const [ns, entries] of Object.entries(value)) {
		if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
			return null
		}

		for (const text of Object.values(entries as Record<string, unknown>)) {
			if (typeof text !== "string") {
				return null
			}
		}

		catalog[ns] = entries as Record<string, string>
	}

	return catalog
}

async function fetchCatalog(lang: SupportedLanguage): Promise<NestedCatalog | null> {
	try {
		const response = await fetch(catalogUrl(lang), { credentials: "same-origin" })

		return response.ok ? parseCatalog(await response.json()) : null
	} catch {
		return null
	}
}

function registerCatalog(lang: string, catalog: NestedCatalog): void {
	for (const ns of EN_NAMESPACES) {
		// skipCopy: i18next would otherwise deep-copy the whole namespace through JSON.
		i18n.addResourceBundle(lang, ns, catalog[ns] ?? {}, false, true, { silent: true, skipCopy: true })
	}
}

function unregisterCatalog(lang: string): void {
	for (const ns of EN_NAMESPACES) {
		i18n.removeResourceBundle(lang, ns)
	}
}

let registered: readonly SupportedLanguage[] = []
let generation = 0

/**
 * Switches the UI to `lang`: fetches its catalog and its base's (zh-TW reads zh before English) unless held already,
 * drops the previous language's, then changes i18next's language. A catalog that cannot be loaded leaves English.
 * A later call supersedes one still loading.
 */
export async function applyLanguage(lang: SupportedLanguage): Promise<void> {
	const current = ++generation
	const chain = languageChain(lang, AVAILABLE_LANGUAGES)
	const loaded = await Promise.all(
		chain.map(async code => ({ code, catalog: registered.includes(code) ? null : await fetchCatalog(code) }))
	)

	if (current !== generation) {
		return
	}

	const usable = loaded.filter(entry => registered.includes(entry.code) || entry.catalog !== null).map(entry => entry.code)
	const target = usable.includes(lang) ? lang : "en"
	const keep = target === "en" ? [] : usable

	for (const { code, catalog } of loaded) {
		if (catalog !== null && keep.includes(code)) {
			registerCatalog(code, catalog)
		}
	}

	for (const code of registered) {
		if (!keep.includes(code)) {
			unregisterCatalog(code)
		}
	}

	registered = keep

	await i18n.changeLanguage(target)
}

const preferenceListeners = new Set<() => void>()

/** Calls back whenever the stored pick may have changed (here or in another tab). Returns the unsubscribe. */
export function subscribeLanguagePreference(listener: () => void): () => void {
	preferenceListeners.add(listener)

	return () => {
		preferenceListeners.delete(listener)
	}
}

function notifyPreference(): void {
	for (const listener of preferenceListeners) {
		listener()
	}
}

/** Stores the pick (null = follow the browser) and applies it. */
export async function setLanguagePreference(lang: SupportedLanguage | null): Promise<void> {
	try {
		if (lang === null) {
			localStorage.removeItem(LANGUAGE_STORAGE_KEY)
		} else {
			localStorage.setItem(LANGUAGE_STORAGE_KEY, lang)
		}
	} catch {
		// Private mode or a full quota: the pick still applies to this tab.
	}

	notifyPreference()

	await applyLanguage(lang ?? detectLanguage())
}

let started = false

/**
 * Applies the detected language and follows picks made in other tabs. Resolves once the language is in place, or
 * after FIRST_RENDER_WAIT_MS with English still showing; a catalog arriving later still switches the UI.
 */
export function startLanguage(waitMs = FIRST_RENDER_WAIT_MS): Promise<void> {
	if (started) {
		return Promise.resolve()
	}

	started = true

	// Another tab's pick; null is a cleared storage.
	window.addEventListener("storage", event => {
		if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) {
			notifyPreference()
			void applyLanguage(detectLanguage())
		}
	})

	const lang = detectLanguage()

	if (lang === "en") {
		return Promise.resolve()
	}

	return new Promise(resolve => {
		const timer = setTimeout(resolve, waitMs)

		void applyLanguage(lang).finally(() => {
			clearTimeout(timer)
			resolve()
		})
	})
}

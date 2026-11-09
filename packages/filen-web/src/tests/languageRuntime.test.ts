// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// de, zh and zh-TW ship near-complete catalogs; fr has a partial one.
vi.mock("@/locales/.catalogs.json", () => ({ default: { languages: { de: 1e9, zh: 1e9, "zh-TW": 1e9, fr: 1 } } }))
// The real map only holds catalog files that exist on disk.
vi.mock("@/lib/i18n/catalogUrl", () => ({ catalogUrl: (lang: string) => `/assets/${lang}.json` }))

const { i18n } = await import("@/lib/i18n")
const language = await import("@/lib/i18n/language")

const CATALOGS: Record<string, unknown> = {
	de: { common: { cancel: "Abbrechen" } },
	zh: { common: { cancel: "取消", reset: "重設" } },
	"zh-TW": { common: { cancel: "取消(TW)" } }
}

const fetchMock = vi.fn((url: string) => {
	const lang = /\/([A-Za-z-]+)\.json$/.exec(url)?.[1] ?? ""
	const catalog = CATALOGS[lang]

	return Promise.resolve(catalog === undefined ? new Response(null, { status: 404 }) : Response.json(catalog))
})

function setBrowserLanguages(languages: string[]): void {
	vi.spyOn(navigator, "languages", "get").mockReturnValue(languages)
}

beforeEach(async () => {
	vi.stubGlobal("fetch", fetchMock)
	localStorage.clear()
	setBrowserLanguages(["en-US"])
	await language.applyLanguage("en")
	fetchMock.mockClear()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("offered languages", () => {
	it("are English plus the languages whose catalog is near-complete", () => {
		expect(language.AVAILABLE_LANGUAGES).toEqual(["en", "de", "zh", "zh-TW"])
		expect(language.offeredLanguages({ de: 95, fr: 94 }, 100)).toEqual(["en", "de"])
	})
})

describe("detectLanguage", () => {
	it("prefers the stored pick", () => {
		setBrowserLanguages(["zh-TW"])
		localStorage.setItem(language.LANGUAGE_STORAGE_KEY, "de")

		expect(language.detectLanguage()).toBe("de")
	})

	it("ignores a stored language that is not offered and follows the browser", () => {
		localStorage.setItem(language.LANGUAGE_STORAGE_KEY, "fr")
		setBrowserLanguages(["fr-FR", "zh-HK", "de"])

		expect(language.readStoredLanguage()).toBeNull()
		expect(language.detectLanguage()).toBe("zh-TW")
	})

	it("falls back to English", () => {
		setBrowserLanguages(["fr-FR", "ja"])

		expect(language.detectLanguage()).toBe("en")
	})
})

describe("applyLanguage", () => {
	it("fetches the language and its base, sets the page language, and resolves through the chain", async () => {
		await language.applyLanguage("zh-TW")

		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(i18n.language).toBe("zh-TW")
		expect(document.documentElement.lang).toBe("zh-TW")
		expect(i18n.t("common:cancel")).toBe("取消(TW)")
		expect(i18n.t("common:reset")).toBe("重設")
	})

	it("drops the previous language's catalogs on a switch", async () => {
		await language.applyLanguage("zh-TW")
		await language.applyLanguage("de")

		expect(i18n.hasResourceBundle("zh-TW", "common")).toBe(false)
		expect(i18n.hasResourceBundle("zh", "common")).toBe(false)
		expect(i18n.t("common:cancel")).toBe("Abbrechen")

		await language.applyLanguage("en")

		expect(i18n.hasResourceBundle("de", "common")).toBe(false)
		expect(document.documentElement.lang).toBe("en")
	})

	it("stays in English when the catalog cannot be loaded", async () => {
		fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("offline")))

		await language.applyLanguage("de")

		expect(i18n.language).toBe("en")
		expect(i18n.hasResourceBundle("de", "common")).toBe(false)
	})

	it("lets a later pick win over one still loading", async () => {
		const first = language.applyLanguage("de")
		const second = language.applyLanguage("zh")

		await Promise.all([first, second])

		expect(i18n.language).toBe("zh")
		expect(i18n.hasResourceBundle("de", "common")).toBe(false)
	})
})

describe("parseCatalog", () => {
	it("accepts namespace → key → string only", () => {
		expect(language.parseCatalog({ common: { a: "b" } })).toEqual({ common: { a: "b" } })
		expect(language.parseCatalog({ common: { a: 1 } })).toBeNull()
		expect(language.parseCatalog({ common: ["a"] })).toBeNull()
		expect(language.parseCatalog([])).toBeNull()
	})
})

describe("setLanguagePreference", () => {
	it("stores a pick, and removes it to follow the browser again", async () => {
		const listener = vi.fn()
		const unsubscribe = language.subscribeLanguagePreference(listener)

		await language.setLanguagePreference("de")

		expect(localStorage.getItem(language.LANGUAGE_STORAGE_KEY)).toBe("de")
		expect(i18n.language).toBe("de")

		setBrowserLanguages(["zh-CN"])
		await language.setLanguagePreference(null)

		expect(localStorage.getItem(language.LANGUAGE_STORAGE_KEY)).toBeNull()
		expect(i18n.language).toBe("zh")
		expect(listener).toHaveBeenCalledTimes(2)

		unsubscribe()
	})
})

describe("startLanguage", () => {
	it("renders in English after the wait when the catalog is late, then switches when it arrives", async () => {
		vi.useFakeTimers()
		localStorage.setItem(language.LANGUAGE_STORAGE_KEY, "de")

		let release: (response: Response) => void = () => undefined

		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>(resolve => {
					release = resolve
				})
		)

		const ready = language.startLanguage(100)

		await vi.advanceTimersByTimeAsync(100)
		await ready

		expect(i18n.language).toBe("en")

		release(Response.json(CATALOGS["de"]))
		await vi.waitFor(() => {
			expect(i18n.language).toBe("de")
		})

		// Another tab's pick.
		localStorage.setItem(language.LANGUAGE_STORAGE_KEY, "zh")
		window.dispatchEvent(new StorageEvent("storage", { key: language.LANGUAGE_STORAGE_KEY, newValue: "zh" }))

		await vi.waitFor(() => {
			expect(i18n.language).toBe("zh")
		})
	})
})

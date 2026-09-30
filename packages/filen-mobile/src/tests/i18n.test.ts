import { vi, describe, it, expect, beforeEach } from "vitest"
import type { createInstance as CreateInstance } from "i18next"

const {
	mockSecureStoreGet,
	mockSecureStoreSet,
	mockGetLocales,
	mockSetIntlLanguage,
	mockI18nInit,
	mockI18nChangeLanguage,
	mockI18nHasResourceBundle,
	mockI18nAddResourceBundle,
	mockLoadCatalog
} = vi.hoisted(() => {
	const mockI18nInit = vi.fn().mockResolvedValue(undefined)
	const mockI18nChangeLanguage = vi.fn().mockResolvedValue(undefined)
	return {
		mockSecureStoreGet: vi.fn(),
		mockSecureStoreSet: vi.fn(),
		mockGetLocales: vi.fn(),
		mockSetIntlLanguage: vi.fn(),
		mockI18nInit,
		mockI18nChangeLanguage,
		mockI18nHasResourceBundle: vi.fn(),
		mockI18nAddResourceBundle: vi.fn(),
		mockLoadCatalog: vi.fn()
	}
})

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: mockSecureStoreGet,
		set: mockSecureStoreSet
	}
}))

vi.mock("expo-localization", () => ({
	getLocales: mockGetLocales
}))

vi.mock("@/lib/time", () => ({
	setIntlLanguage: mockSetIntlLanguage
}))

// Mock i18next and its chaining API so initI18n / changeAppLanguage tests do not
// couple to i18next internals or trip over "already initialized" state.
vi.mock("i18next", () => {
	const useReturn = { init: mockI18nInit }
	const i18nMock = {
		use: vi.fn().mockReturnValue(useReturn),
		changeLanguage: mockI18nChangeLanguage,
		hasResourceBundle: mockI18nHasResourceBundle,
		addResourceBundle: mockI18nAddResourceBundle,
		t: vi.fn((key: string) => key)
	}
	return { default: i18nMock }
})

// react-i18next only needs to provide the initReactI18next plugin object; its identity
// is irrelevant to the tests (it is passed to i18n.use() and we only assert that .use()
// was called).
vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: vi.fn() }
}))

// The real loaders are Metro inline requires, which Node's resolver cannot follow through the
// "@/" alias. Each mocked loader records which catalog was evaluated; vi stands in for an empty
// stub catalog (the "no translations yet" branch of hasTranslations).
vi.mock("@/locales/catalogs", async () => {
	const { SUPPORTED_LANGUAGES } = await import("@/locales/languages")

	return {
		CATALOG_LOADERS: Object.fromEntries(SUPPORTED_LANGUAGES.filter(lang => lang !== "en").map(lang => [lang, () => mockLoadCatalog(lang)]))
	}
})

import { getInitialLanguage, initI18n, changeAppLanguage, hasTranslations } from "@/lib/i18n"
import { LANGUAGE_SECURE_STORE_KEY } from "@/lib/language"
import { SUPPORTED_LANGUAGES } from "@/locales/languages"

beforeEach(() => {
	vi.clearAllMocks()
	mockSecureStoreGet.mockResolvedValue(null)
	mockGetLocales.mockReturnValue([])
	mockI18nInit.mockResolvedValue(undefined)
	mockI18nChangeLanguage.mockResolvedValue(undefined)
	mockI18nHasResourceBundle.mockReturnValue(false)
	mockLoadCatalog.mockImplementation((lang: string) => (lang === "vi" ? {} : { key: `${lang}-value` }))
})

describe("getInitialLanguage", () => {
	it("returns the persisted language when it is supported", async () => {
		mockSecureStoreGet.mockResolvedValue("en")
		mockGetLocales.mockReturnValue([{ languageCode: "de" }])

		const result = await getInitialLanguage()

		expect(result).toBe("en")
		expect(mockSecureStoreGet).toHaveBeenCalledWith(LANGUAGE_SECURE_STORE_KEY)
	})

	it("ignores an unsupported persisted language and falls back to the device locale", async () => {
		// "ar" (Arabic) is intentionally NOT in SUPPORTED_LANGUAGES (RTL, excluded) — a stand-in
		// for any unsupported code, so this exercises the persisted-rejection path, not a real locale.
		mockSecureStoreGet.mockResolvedValue("ar")
		mockGetLocales.mockReturnValue([{ languageCode: "en" }])

		const result = await getInitialLanguage()

		expect(result).toBe("en")
	})

	it("uses the device locale when no language is persisted", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([{ languageCode: "en" }])

		const result = await getInitialLanguage()

		expect(result).toBe("en")
	})

	it("falls back to 'en' when the device locale is unsupported", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		// "ar" (Arabic) is intentionally NOT in SUPPORTED_LANGUAGES (RTL, excluded) — exercises the
		// device-locale-rejection path that falls through to DEFAULT_LANGUAGE.
		mockGetLocales.mockReturnValue([{ languageCode: "ar" }])

		const result = await getInitialLanguage()

		expect(result).toBe("en")
	})

	it("falls back to 'en' when there is neither a persisted nor a device language", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([])

		const result = await getInitialLanguage()

		expect(result).toBe("en")
	})

	it("falls back to 'en' when the device locale languageCode is null", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([{ languageCode: null }])

		const result = await getInitialLanguage()

		expect(result).toBe("en")
	})

	it("prefers a supported persisted language over a supported device locale and does not read device locales", async () => {
		mockSecureStoreGet.mockResolvedValue("en")

		const result = await getInitialLanguage()

		expect(result).toBe("en")
		// When persisted language is valid the function must short-circuit before
		// touching the device locale — getLocales must never be called.
		expect(mockGetLocales).not.toHaveBeenCalled()
	})

	it("falls back to 'en' when the persisted value is undefined (not just null)", async () => {
		mockSecureStoreGet.mockResolvedValue(undefined)
		mockGetLocales.mockReturnValue([{ languageCode: "de" }])

		const result = await getInitialLanguage()

		// undefined must be treated as "no persisted language" — falls through to device locale.
		expect(result).toBe("de")
	})

	it("uses the region tag for Portuguese — a pt-PT device resolves to pt-PT", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([{ languageCode: "pt", languageTag: "pt-PT" }])

		const result = await getInitialLanguage()

		expect(result).toBe("pt-PT")
	})

	it("uses the region tag for Portuguese — a pt-BR device resolves to pt-BR", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([{ languageCode: "pt", languageTag: "pt-BR" }])

		const result = await getInitialLanguage()

		expect(result).toBe("pt-BR")
	})

	it("uses zh-TW for a Taiwan Traditional Chinese device locale", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([{ languageCode: "zh", languageTag: "zh-TW" }])

		const result = await getInitialLanguage()

		expect(result).toBe("zh-TW")
	})

	it.each([
		["generic Traditional Chinese", { languageCode: "zh", languageTag: "zh-Hant" }],
		["script-qualified Taiwan Chinese", { languageCode: "zh", languageTag: "zh-Hant-TW" }],
		["Hong Kong Chinese", { languageCode: "zh", languageTag: "zh-HK" }],
		["Macau Chinese", { languageCode: "zh", languageTag: "zh-MO" }],
		["explicit Hant script", { languageCode: "zh", languageTag: "zh-CN", languageScriptCode: "Hant", regionCode: "CN" }]
	])("maps %s to zh-TW", async (_label, locale) => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([locale])

		const result = await getInitialLanguage()

		expect(result).toBe("zh-TW")
	})

	it("keeps a Simplified-script device in a Traditional-majority region on zh", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([{ languageCode: "zh", languageTag: "zh-Hans-HK", languageScriptCode: "Hans", regionCode: "HK" }])

		const result = await getInitialLanguage()

		expect(result).toBe("zh")
	})

	it("keeps Simplified Chinese devices on the existing zh catalog", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([{ languageCode: "zh", languageTag: "zh-CN" }])

		const result = await getInitialLanguage()

		expect(result).toBe("zh")
	})

	it("defaults a generic Portuguese device with an unrecognised region tag to pt-BR", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([{ languageCode: "pt", languageTag: "pt-AO" }])

		const result = await getInitialLanguage()

		expect(result).toBe("pt-BR")
	})

	it("does not regress bare-code languages — a de-DE device still resolves to de", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([{ languageCode: "de", languageTag: "de-DE" }])

		const result = await getInitialLanguage()

		expect(result).toBe("de")
	})
})

describe("initI18n", () => {
	it("initialises i18next with the language resolved by getInitialLanguage", async () => {
		mockSecureStoreGet.mockResolvedValue("de")

		await initI18n()

		// i18n.use() must be called to wire in the react-i18next plugin
		const i18nMock = (await import("i18next")).default
		expect(i18nMock.use).toHaveBeenCalledTimes(1)

		// init() must be called with the language that getInitialLanguage returned
		expect(mockI18nInit).toHaveBeenCalledTimes(1)
		const initArg: Record<string, unknown> = mockI18nInit.mock.calls[0]?.[0]
		expect(initArg["lng"]).toBe("de")
	})

	it("passes fallbackLng:'en' so missing keys fall back to English", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([])

		await initI18n()

		const initArg: Record<string, unknown> = mockI18nInit.mock.calls[0]?.[0]
		expect(initArg["fallbackLng"]).toBe("en")
	})

	it("disables key and namespace separators so flat translation keys work", async () => {
		mockSecureStoreGet.mockResolvedValue(null)

		await initI18n()

		const initArg: Record<string, unknown> = mockI18nInit.mock.calls[0]?.[0]
		expect(initArg["keySeparator"]).toBe(false)
		expect(initArg["nsSeparator"]).toBe(false)
	})

	it.each([
		["en", ["en"]],
		["de", ["en", "de"]],
		["pt-BR", ["en", "pt-BR"]],
		["zh", ["en", "zh"]],
		["zh-TW", ["en", "zh-TW", "zh"]]
	])("registers only en plus the resolve chain of %s at init", async (lng, expected) => {
		mockSecureStoreGet.mockResolvedValue(lng)

		await initI18n()

		const initArg: Record<string, unknown> = mockI18nInit.mock.calls[0]?.[0]
		const resources = initArg["resources"] as Record<string, { translation: unknown }>

		expect(Object.keys(resources).sort()).toEqual([...expected].sort())
		expect(mockLoadCatalog.mock.calls.map(call => call[0]).sort()).toEqual(expected.filter(lang => lang !== "en").sort())

		for (const lang of expected.filter(lang => lang !== "en")) {
			expect(resources[lang]?.translation).toEqual({ key: `${lang}-value` })
		}
	})

	it("keeps supportedLngs as the full language list", async () => {
		await initI18n()

		const initArg: Record<string, unknown> = mockI18nInit.mock.calls[0]?.[0]

		expect(initArg["supportedLngs"]).toEqual([...SUPPORTED_LANGUAGES])
	})

	it("calls setIntlLanguage with the device languageTag (not the bare language code) after init", async () => {
		// Bug #16: setIntlLanguage must receive the full BCP-47 tag so region guards
		// (startsWith("en-us"), "en-gb", etc.) inside detectLocaleInfo remain reachable.
		mockSecureStoreGet.mockResolvedValue("fr")
		mockGetLocales.mockReturnValue([{ languageCode: "fr", languageTag: "fr-FR" }])

		await initI18n()

		expect(mockSetIntlLanguage).toHaveBeenCalledTimes(1)
		expect(mockSetIntlLanguage).toHaveBeenCalledWith("fr-FR")
	})

	it("falls back to the bare language code in setIntlLanguage when no device languageTag is available", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([])

		await initI18n()

		const initArg: Record<string, unknown> = mockI18nInit.mock.calls[0]?.[0]
		expect(initArg["lng"]).toBe("en")
		// No languageTag available — falls back to the resolved Language code
		expect(mockSetIntlLanguage).toHaveBeenCalledWith("en")
	})
})

describe("changeAppLanguage", () => {
	it("calls i18n.changeLanguage with the supplied language", async () => {
		await changeAppLanguage("de")

		const i18nMock = (await import("i18next")).default
		expect(i18nMock.changeLanguage).toHaveBeenCalledTimes(1)
		expect(i18nMock.changeLanguage).toHaveBeenCalledWith("de")
	})

	it("registers the target catalog and its supported base before changeLanguage (zh-TW → zh-TW, zh)", async () => {
		await changeAppLanguage("zh-TW")

		expect(mockI18nAddResourceBundle).toHaveBeenCalledTimes(2)
		expect(mockI18nAddResourceBundle).toHaveBeenNthCalledWith(1, "zh-TW", "translation", { key: "zh-TW-value" }, false, true, {
			silent: true,
			skipCopy: true
		})
		expect(mockI18nAddResourceBundle).toHaveBeenNthCalledWith(2, "zh", "translation", { key: "zh-value" }, false, true, {
			silent: true,
			skipCopy: true
		})

		const lastAdd = Math.max(...mockI18nAddResourceBundle.mock.invocationCallOrder)

		expect(mockI18nChangeLanguage.mock.invocationCallOrder[0]).toBeGreaterThan(lastAdd)
	})

	it("does not reload a catalog that is already registered", async () => {
		mockI18nHasResourceBundle.mockImplementation((lng: string) => lng === "zh")

		await changeAppLanguage("zh-TW")

		expect(mockLoadCatalog).toHaveBeenCalledTimes(1)
		expect(mockLoadCatalog).toHaveBeenCalledWith("zh-TW")
		expect(mockI18nAddResourceBundle).toHaveBeenCalledTimes(1)
	})

	it("registers nothing when switching to en", async () => {
		await changeAppLanguage("en")

		expect(mockLoadCatalog).not.toHaveBeenCalled()
		expect(mockI18nAddResourceBundle).not.toHaveBeenCalled()
		expect(mockI18nChangeLanguage).toHaveBeenCalledWith("en")
	})

	it("a catalog chain registered before changeLanguage resolves exactly like preloaded resources (real i18next)", async () => {
		const { createInstance } = await vi.importActual<{ createInstance: typeof CreateInstance }>("i18next")
		const keys = ["name", "message", "error"] as const
		const catalogs = {
			en: { name: "A", message: "B", error: "C" },
			zh: { name: "zhA", message: "zhB" },
			"zh-TW": { name: "twA" }
		}
		const options = {
			fallbackLng: "en",
			supportedLngs: ["en", "zh", "zh-TW"],
			keySeparator: false as const,
			nsSeparator: false as const,
			interpolation: {
				escapeValue: false
			}
		}
		const preloaded = createInstance()

		await preloaded.init({
			...options,
			lng: "zh-TW",
			resources: {
				en: { translation: catalogs.en },
				zh: { translation: catalogs.zh },
				"zh-TW": { translation: catalogs["zh-TW"] }
			}
		})

		const lazy = createInstance()

		await lazy.init({
			...options,
			lng: "en",
			resources: {
				en: { translation: catalogs.en }
			}
		})

		lazy.addResourceBundle("zh-TW", "translation", catalogs["zh-TW"], false, true, { silent: true, skipCopy: true })
		lazy.addResourceBundle("zh", "translation", catalogs.zh, false, true, { silent: true, skipCopy: true })

		await lazy.changeLanguage("zh-TW")

		expect(lazy.languages).toEqual(preloaded.languages)

		for (const key of keys) {
			expect(lazy.t(key)).toBe(preloaded.t(key))
		}

		expect(keys.map(key => lazy.t(key))).toEqual(["twA", "zhB", "C"])
	})

	it("calls setIntlLanguage with the device languageTag (not the bare language code) as a side effect", async () => {
		// Bug #16: after a language switch the device region tag must be preserved so
		// date/clock format is not silently downgraded to a region-agnostic bare code.
		mockGetLocales.mockReturnValue([{ languageCode: "ja", languageTag: "ja-JP" }])

		await changeAppLanguage("ja")

		expect(mockSetIntlLanguage).toHaveBeenCalledTimes(1)
		expect(mockSetIntlLanguage).toHaveBeenCalledWith("ja-JP")
	})

	it("does NOT write to secureStore (persistence is owned by setLanguage/useSecureStore)", async () => {
		// No languageTag available — getLocales returns [] via beforeEach — so the
		// fallback bare code is used. This also exercises the no-tag fallback path.
		mockGetLocales.mockReturnValue([])

		await changeAppLanguage("fr")

		// secureStore.set must never be called — changeAppLanguage must not double-persist
		// the language (that is the caller's responsibility via setLanguage/useSecureStore).
		expect(mockSecureStoreSet).not.toHaveBeenCalled()
		// The important invariant: only the time module is notified (with the fallback
		// bare code since no device tag is present), not the store.
		expect(mockSetIntlLanguage).toHaveBeenCalledWith("fr")
	})
})

describe("Bug #16 — setIntlLanguage receives full BCP-47 tag, not bare language code", () => {
	it("initI18n passes 'en-US' to setIntlLanguage when device locale is en-US, regardless of resolved Language 'en'", async () => {
		mockSecureStoreGet.mockResolvedValue("en")
		mockGetLocales.mockReturnValue([{ languageCode: "en", languageTag: "en-US" }])

		await initI18n()

		// Must be the full tag — bare "en" would break detectLocaleInfo's MDY+12h guard
		expect(mockSetIntlLanguage).toHaveBeenCalledWith("en-US")
		expect(mockSetIntlLanguage).not.toHaveBeenCalledWith("en")
	})

	it("changeAppLanguage passes 'en-GB' to setIntlLanguage when device locale is en-GB", async () => {
		mockGetLocales.mockReturnValue([{ languageCode: "en", languageTag: "en-GB" }])

		await changeAppLanguage("en")

		// Must be the full tag — bare "en" would break DMY+12h guard for en-GB
		expect(mockSetIntlLanguage).toHaveBeenCalledWith("en-GB")
		expect(mockSetIntlLanguage).not.toHaveBeenCalledWith("en")
	})

	it("initI18n falls back to bare language code when device returns no languageTag", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([])

		await initI18n()

		// No device tag — graceful fallback to the resolved Language
		expect(mockSetIntlLanguage).toHaveBeenCalledWith("en")
	})
})

describe("hasTranslations", () => {
	it("always returns true for 'en' (source language)", () => {
		expect(hasTranslations("en")).toBe(true)
	})

	it("returns true for a target language whose catalog has at least one key (de)", () => {
		expect(hasTranslations("de")).toBe(true)
		expect(mockLoadCatalog).toHaveBeenCalledWith("de")
	})

	it("returns false for a target language whose catalog is an empty stub (vi mocked as {})", () => {
		// Simulates the CI pipeline pre-filling a new-language stub. The picker must not offer it.
		expect(hasTranslations("vi")).toBe(false)
	})
})

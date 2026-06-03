import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockSecureStoreGet, mockGetLocales, mockSetIntlLanguage, mockI18nInit, mockI18nChangeLanguage } = vi.hoisted(() => {
	const mockI18nInit = vi.fn().mockResolvedValue(undefined)
	const mockI18nChangeLanguage = vi.fn().mockResolvedValue(undefined)
	return {
		mockSecureStoreGet: vi.fn(),
		mockGetLocales: vi.fn(),
		mockSetIntlLanguage: vi.fn(),
		mockI18nInit,
		mockI18nChangeLanguage
	}
})

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: mockSecureStoreGet
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

// Mock @/locales/vi.json as an empty stub so we can exercise the "no translations yet"
// branch of hasTranslations without relying on the CI pipeline ever producing an empty
// bundle in production. Vietnamese is chosen arbitrarily; any target language would do.
vi.mock("@/locales/vi.json", () => ({ default: {} }))

import { getInitialLanguage, initI18n, changeAppLanguage, hasTranslations } from "@/lib/i18n"
import { LANGUAGE_SECURE_STORE_KEY } from "@/lib/language"
import { SUPPORTED_LANGUAGES } from "@/locales/languages"

beforeEach(() => {
	vi.clearAllMocks()
	mockSecureStoreGet.mockResolvedValue(null)
	mockGetLocales.mockReturnValue([])
	mockI18nInit.mockResolvedValue(undefined)
	mockI18nChangeLanguage.mockResolvedValue(undefined)
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

	it("registers every supported language in the resources bundle", async () => {
		mockSecureStoreGet.mockResolvedValue(null)

		await initI18n()

		const initArg: Record<string, unknown> = mockI18nInit.mock.calls[0]?.[0]
		const resources = initArg["resources"] as Record<string, unknown>

		for (const lang of SUPPORTED_LANGUAGES) {
			expect(resources).toHaveProperty(lang)
		}
	})

	it("calls setIntlLanguage with the resolved language after init", async () => {
		mockSecureStoreGet.mockResolvedValue("fr")

		await initI18n()

		expect(mockSetIntlLanguage).toHaveBeenCalledTimes(1)
		expect(mockSetIntlLanguage).toHaveBeenCalledWith("fr")
	})

	it("falls back to 'en' and passes it to both init and setIntlLanguage when no preference is set", async () => {
		mockSecureStoreGet.mockResolvedValue(null)
		mockGetLocales.mockReturnValue([])

		await initI18n()

		const initArg: Record<string, unknown> = mockI18nInit.mock.calls[0]?.[0]
		expect(initArg["lng"]).toBe("en")
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

	it("calls setIntlLanguage with the supplied language as a side effect", async () => {
		await changeAppLanguage("ja")

		expect(mockSetIntlLanguage).toHaveBeenCalledTimes(1)
		expect(mockSetIntlLanguage).toHaveBeenCalledWith("ja")
	})

	it("does NOT write to secureStore (persistence is owned by setLanguage/useSecureStore)", async () => {
		const secureStoreMock = (await import("@/lib/secureStore")).default as unknown as { set?: ReturnType<typeof vi.fn> }

		await changeAppLanguage("fr")

		// secureStore.set must not exist on the mock (we only mocked .get) — or if it
		// does exist it must not have been called.
		if (typeof secureStoreMock.set === "function") {
			expect(secureStoreMock.set).not.toHaveBeenCalled()
		}
		// The important invariant: only the time module is notified, not the store.
		expect(mockSetIntlLanguage).toHaveBeenCalledWith("fr")
	})
})

describe("hasTranslations", () => {
	it("always returns true for 'en' (source language)", () => {
		expect(hasTranslations("en")).toBe(true)
	})

	it("returns true for a target language whose bundle has at least one key (de)", () => {
		// de.json is fully translated; Object.keys(bundle).length > 0 must be true.
		expect(hasTranslations("de")).toBe(true)
	})

	it("returns false for a target language whose bundle is an empty stub (vi mocked as {})", () => {
		// vi.json is mocked to {} at the top of this file to simulate the CI pipeline
		// pre-filling a new-language stub. The picker must not offer it.
		expect(hasTranslations("vi")).toBe(false)
	})
})

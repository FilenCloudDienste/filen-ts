import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockSecureStoreGet, mockGetLocales, mockSetIntlLanguage } = vi.hoisted(() => {
	return {
		mockSecureStoreGet: vi.fn(),
		mockGetLocales: vi.fn(),
		mockSetIntlLanguage: vi.fn()
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

import { getInitialLanguage } from "@/lib/i18n"
import { LANGUAGE_SECURE_STORE_KEY } from "@/lib/language"

beforeEach(() => {
	vi.clearAllMocks()
	mockSecureStoreGet.mockResolvedValue(null)
	mockGetLocales.mockReturnValue([])
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

	it("prefers a supported persisted language over a supported device locale", async () => {
		mockSecureStoreGet.mockResolvedValue("en")
		mockGetLocales.mockReturnValue([{ languageCode: "en" }])

		const result = await getInitialLanguage()

		expect(result).toBe("en")
		expect(mockGetLocales).not.toHaveBeenCalled()
	})
})

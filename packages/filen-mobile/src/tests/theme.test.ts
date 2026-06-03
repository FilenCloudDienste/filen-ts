import { vi, describe, it, expect } from "vitest"

// Mock boundaries only — never mock the unit under test (theme.ts).
// secureStore is a boundary (async KV).
// uniwind is a boundary (native theme applier).

const { mockSecureStoreGet } = vi.hoisted(() => ({
	mockSecureStoreGet: vi.fn()
}))

vi.mock("@/lib/secureStore", () => ({
	default: {
		get: mockSecureStoreGet
	},
	useSecureStore: vi.fn()
}))

// Uniwind.setTheme is called by changeAppTheme / initTheme — mock so it doesn't crash.
vi.mock("uniwind", () => ({
	Uniwind: {
		setTheme: vi.fn()
	}
}))

import { getInitialThemeSetting, DEFAULT_THEME_SETTING, THEME_SECURE_STORE_KEY } from "@/lib/theme"

describe("getInitialThemeSetting", () => {
	it("returns 'light' when secureStore has 'light'", async () => {
		mockSecureStoreGet.mockResolvedValueOnce("light")

		const result = await getInitialThemeSetting()

		expect(result).toBe("light")
	})

	it("returns 'dark' when secureStore has 'dark'", async () => {
		mockSecureStoreGet.mockResolvedValueOnce("dark")

		const result = await getInitialThemeSetting()

		expect(result).toBe("dark")
	})

	it("returns 'system' when secureStore has 'system'", async () => {
		mockSecureStoreGet.mockResolvedValueOnce("system")

		const result = await getInitialThemeSetting()

		expect(result).toBe("system")
	})

	it("returns DEFAULT_THEME_SETTING when secureStore returns null", async () => {
		mockSecureStoreGet.mockResolvedValueOnce(null)

		const result = await getInitialThemeSetting()

		expect(result).toBe(DEFAULT_THEME_SETTING)
	})

	it("returns DEFAULT_THEME_SETTING when secureStore returns undefined", async () => {
		mockSecureStoreGet.mockResolvedValueOnce(undefined)

		const result = await getInitialThemeSetting()

		expect(result).toBe(DEFAULT_THEME_SETTING)
	})

	it("returns DEFAULT_THEME_SETTING when secureStore returns an unrecognised string", async () => {
		mockSecureStoreGet.mockResolvedValueOnce("sepia")

		const result = await getInitialThemeSetting()

		expect(result).toBe(DEFAULT_THEME_SETTING)
	})

	it("returns DEFAULT_THEME_SETTING when secureStore returns an empty string", async () => {
		mockSecureStoreGet.mockResolvedValueOnce("")

		const result = await getInitialThemeSetting()

		expect(result).toBe(DEFAULT_THEME_SETTING)
	})

	it("reads from THEME_SECURE_STORE_KEY ('appearance.theme') and not any other key", async () => {
		mockSecureStoreGet.mockResolvedValueOnce("dark")

		await getInitialThemeSetting()

		expect(mockSecureStoreGet).toHaveBeenCalledWith(THEME_SECURE_STORE_KEY)
		expect(THEME_SECURE_STORE_KEY).toBe("appearance.theme")
	})
})

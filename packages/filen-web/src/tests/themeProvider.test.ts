import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_THEME_SETTING } from "@filen/shared"
import { readStoredTheme, storeTheme, syncThemeColor, THEME_COLORS } from "@/providers/themeProvider"

function stubStorage(storage: Partial<Storage>): void {
	vi.stubGlobal("localStorage", storage)
}

// The provider renders above BootGate, so blocked site data must not crash it before /no-opfs can show.
describe("theme storage", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("reads a stored theme", () => {
		stubStorage({ getItem: () => "dark" })

		expect(readStoredTheme()).toBe("dark")
	})

	it("falls back to the default when reading throws", () => {
		stubStorage({
			getItem: () => {
				throw new DOMException("blocked", "SecurityError")
			}
		})

		expect(readStoredTheme()).toBe(DEFAULT_THEME_SETTING)
	})

	it("falls back to the default when the access itself throws", () => {
		vi.stubGlobal("localStorage", undefined)

		expect(readStoredTheme()).toBe(DEFAULT_THEME_SETTING)
	})

	it("does not throw when writing throws", () => {
		const setItem = vi.fn(() => {
			throw new DOMException("full", "QuotaExceededError")
		})

		stubStorage({ setItem })

		expect(() => {
			storeTheme("light")
		}).not.toThrow()
		expect(setItem).toHaveBeenCalledWith("theme", "light")
	})
})

// The browser chrome follows the theme the app shows, which the user can set apart from the OS appearance.
describe("theme-color", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("sets the meta to the resolved theme's canvas", () => {
		const setAttribute = vi.fn()

		vi.stubGlobal("document", {
			querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? { setAttribute } : null)
		})

		syncThemeColor("dark")
		expect(setAttribute).toHaveBeenLastCalledWith("content", THEME_COLORS.dark)

		syncThemeColor("light")
		expect(setAttribute).toHaveBeenLastCalledWith("content", THEME_COLORS.light)
	})

	it("does nothing without the meta", () => {
		vi.stubGlobal("document", { querySelector: () => null })

		expect(() => {
			syncThemeColor("dark")
		}).not.toThrow()
	})
})

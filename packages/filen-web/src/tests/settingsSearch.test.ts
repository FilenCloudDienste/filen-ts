// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

const desktop = vi.hoisted(() => ({ app: false }))

vi.mock("@/lib/desktop", () => ({ isDesktopApp: () => desktop.app, desktopBridge: () => undefined }))

const { i18n } = await import("@/lib/i18n")
const { pageSearchClaimed, searchSettings, SETTINGS_SEARCH_RESULTS, usePageSearchClaim } =
	await import("@/features/settings/lib/settingsSearch")

function ids(query: string, language = "en"): string[] {
	return searchSettings(query, language).map(entry => entry.id)
}

afterEach(async () => {
	await i18n.changeLanguage("en")
})

describe("searchSettings", () => {
	it("finds a setting by its title, first", () => {
		expect(ids("theme")[0]).toBe("theme")
	})

	it("finds a setting by words of its description only", () => {
		// "Choose how Filen looks on this device": no word of the title "Theme".
		expect(ids("looks")).toContain("theme")
	})

	it("finds nothing for words too short to count or matching nothing", () => {
		expect(ids("th")).toEqual([])
		expect(ids("zzzqqq")).toEqual([])
	})

	it("returns at most SETTINGS_SEARCH_RESULTS rows", () => {
		expect(searchSettings("the and you your for", "en").length).toBeLessThanOrEqual(SETTINGS_SEARCH_RESULTS)
	})

	it("leaves out the desktop app's rows on the web", () => {
		expect(searchSettings("export logs", "en").some(entry => entry.platform === "desktop")).toBe(false)
	})

	it("searches in the app's language and in English, built anew for a new language", async () => {
		// The app fetches a language's catalog; the test holds the two strings it reads.
		i18n.addResourceBundle("de", "settings", {
			settingsThemeTitle: "Design",
			settingsThemeDescription: "Wähle, wie Filen auf diesem Gerät aussieht"
		})
		await i18n.changeLanguage("de")

		expect(ids("design", "de")[0]).toBe("theme")
		expect(ids("gerät", "de")).toContain("theme")
		expect(ids("theme", "de")[0]).toBe("theme")
	})
})

describe("usePageSearchClaim", () => {
	it("claims Mod+F while a page with its own search is mounted and active", () => {
		expect(pageSearchClaimed()).toBe(false)

		const inactive = renderHook(() => {
			usePageSearchClaim(false)
		})

		expect(pageSearchClaimed()).toBe(false)

		const claimed = renderHook(() => {
			usePageSearchClaim(true)
		})

		expect(pageSearchClaimed()).toBe(true)

		claimed.unmount()
		inactive.unmount()

		expect(pageSearchClaimed()).toBe(false)
	})
})

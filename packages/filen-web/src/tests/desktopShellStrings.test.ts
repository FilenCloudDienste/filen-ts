import { describe, expect, it, vi } from "vitest"
import { DESKTOP_SHELL_STRINGS } from "@filen/shared/desktopShellStrings"

const app = vi.hoisted(() => ({ setShellStrings: vi.fn() }))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => ({ app }) }))

const { i18n } = await import("@/lib/i18n")
const { shellStringsFor, syncDesktopShellStrings } = await import("@/lib/i18n/desktopShell")

describe("desktop shell strings", () => {
	it("are the English templates, placeholders unfilled", () => {
		const strings = shellStringsFor("en")

		expect(strings["shellOpen"]).toBe(DESKTOP_SHELL_STRINGS.shellOpen)
		expect(strings["shellTrayDriveMounted"]).toBe("Network drive: mounted at {{path}}")
		expect(strings["shellSignOutUploadingDetail_one"]).toBe(DESKTOP_SHELL_STRINGS.shellSignOutUploadingDetail_one)
	})

	it("send every plural form the language selects, falling back to English", () => {
		i18n.addResourceBundle(
			"ru",
			"settings",
			{ shellOpen: "Открыть Filen", shellSignOutUploadingDetail_few: "{{count}} файла" },
			true,
			true
		)

		const strings = shellStringsFor("ru")

		expect(strings["shellOpen"]).toBe("Открыть Filen")
		expect(strings["shellQuit"]).toBe(DESKTOP_SHELL_STRINGS.shellQuit)
		expect(strings["shellSignOutUploadingDetail_few"]).toBe("{{count}} файла")
		expect(strings["shellSignOutUploadingDetail_many"]).toBe(DESKTOP_SHELL_STRINGS.shellSignOutUploadingDetail_other)

		i18n.removeResourceBundle("ru", "settings")
	})

	it("reach main now and on every language change", async () => {
		syncDesktopShellStrings()

		expect(app.setShellStrings).toHaveBeenCalledWith({ language: "en", strings: shellStringsFor("en") })

		await i18n.changeLanguage("de")
		await i18n.changeLanguage("en")

		expect(app.setShellStrings).toHaveBeenCalledTimes(3)
		expect(app.setShellStrings).toHaveBeenNthCalledWith(2, { language: "de", strings: shellStringsFor("de") })
	})
})

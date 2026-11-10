import { describe, expect, it, vi } from "vitest"
import { memoryFile } from "./fileFakes.ts"

// Module state (the current language) is per test file; each test loads a fresh copy.
async function load() {
	vi.resetModules()

	return {
		strings: await import("../main/shellStrings.ts"),
		tray: await import("../main/tray.ts"),
		menu: await import("../main/menu.ts")
	}
}

const german = {
	language: "de",
	strings: {
		shellOpen: "Filen öffnen",
		shellTrayDriveMounted: "Netzlaufwerk: eingehängt unter {{path}}",
		shellNotifyDriveStopped: "Das Netzlaufwerk wurde beendet.",
		shellMenuSettings: "Einstellungen…",
		shellSignOutUploadingDetail_one: "{{count}} Datei fehlt noch.",
		shellSignOutUploadingDetail_other: "{{count}} Dateien fehlen noch."
	}
}

describe("shell strings", () => {
	it("shows English until the page reports a language", async () => {
		const { strings, tray } = await load()

		expect(strings.shellText("shellOpen")).toBe("Open Filen")
		expect(strings.shellPlural("shellSignOutUploadingDetail", 1)).toBe(
			"1 file is not uploaded yet. If you sign out now, it finishes uploading when you sign in again."
		)
		expect(tray.roleFailureMessage(["drive", "s3"])).toBe("Mounts stopped. Open Filen to see why.")
	})

	it("adopts the page's text, fills placeholders and falls back to English per key", async () => {
		const { strings, tray, menu } = await load()
		const file = memoryFile()

		expect(strings.applyShellStrings(german, file, vi.fn())).toBe(true)
		expect(strings.shellLanguage()).toBe("de")
		expect(strings.shellText("shellOpen")).toBe("Filen öffnen")
		expect(strings.shellText("shellQuit")).toBe("Quit Filen")
		expect(tray.roleFailureMessage(["drive"])).toBe("Das Netzlaufwerk wurde beendet.")
		expect(tray.trayStatusLines("idle", "idle", { state: "running" } as never, "/mnt/filen")).toContain(
			"Netzlaufwerk: eingehängt unter /mnt/filen"
		)
		expect(strings.shellPlural("shellSignOutUploadingDetail", 3)).toBe("3 Dateien fehlen noch.")

		const appMenu = menu.menuTemplate({
			shortcuts: {},
			devTools: false,
			transport: "none",
			onAction: vi.fn(),
			onLock: null,
			onClose: vi.fn(),
			onWebsite: vi.fn()
		})[0]

		expect(JSON.stringify(appMenu)).toContain("Einstellungen…")
	})

	it("picks the plural form the language selects", async () => {
		const { strings } = await load()

		strings.applyShellStrings(
			{
				language: "ru",
				strings: {
					shellSignOutUploadingDetail_one: "{{count}} файл",
					shellSignOutUploadingDetail_few: "{{count}} файла",
					shellSignOutUploadingDetail_many: "{{count}} файлов",
					shellSignOutUploadingDetail_other: "{{count}} файла (other)"
				}
			},
			memoryFile(),
			vi.fn()
		)

		expect(strings.shellPlural("shellSignOutUploadingDetail", 1)).toBe("1 файл")
		expect(strings.shellPlural("shellSignOutUploadingDetail", 3)).toBe("3 файла")
		expect(strings.shellPlural("shellSignOutUploadingDetail", 5)).toBe("5 файлов")
	})

	it("ignores malformed payloads, unknown keys and an unchanged repeat", async () => {
		const { strings } = await load()
		const file = memoryFile()

		expect(strings.applyShellStrings({ language: "de" }, file, vi.fn())).toBe(false)
		expect(strings.applyShellStrings({ language: "de", strings: { shellOpen: 1 } }, file, vi.fn())).toBe(false)
		expect(strings.applyShellStrings({ language: "de", strings: { shellOpen: "x".repeat(600) } }, file, vi.fn())).toBe(false)
		expect(strings.applyShellStrings({ language: "not a tag!", strings: {} }, file, vi.fn())).toBe(false)
		expect(strings.applyShellStrings({ language: "de", strings: { injected: "x", shellOpen: "" } }, file, vi.fn())).toBe(true)
		expect(strings.shellText("shellOpen")).toBe("Open Filen")
		expect(strings.applyShellStrings({ language: "de", strings: { injected: "x" } }, file, vi.fn())).toBe(false)
	})

	it("stores the text and reads it back on the next start", async () => {
		const file = memoryFile()
		const first = await load()

		first.strings.applyShellStrings(german, file, vi.fn())
		await vi.waitFor(() => {
			expect(file.writes).toBe(1)
		})

		const second = await load()

		await second.strings.loadShellStrings(file, vi.fn())

		expect(second.strings.shellLanguage()).toBe("de")
		expect(second.strings.shellText("shellOpen")).toBe("Filen öffnen")
	})

	it("starts in English when the stored copy is unreadable", async () => {
		const { strings } = await load()
		const warn = vi.fn()

		await strings.loadShellStrings(memoryFile(Buffer.from("{not json")), warn)

		expect(strings.shellText("shellOpen")).toBe("Open Filen")
		expect(warn).toHaveBeenCalledOnce()
	})
})

import { describe, expect, it } from "vitest"
import { APP_HELP, appHelpAnchor, openRoute } from "@filen/shared/assistant"

describe("app_help registry", () => {
	it("names every row, anchor and key once", () => {
		expect(new Set(APP_HELP.map(entry => entry.id)).size).toBe(APP_HELP.length)
		expect(new Set(APP_HELP.map(entry => entry.anchor)).size).toBe(APP_HELP.length)
		expect(new Set(APP_HELP.map(entry => entry.descriptionKey)).size).toBe(APP_HELP.length)
	})

	it("anchors each row by its namespaced id", () => {
		for (const entry of APP_HELP) {
			expect(entry.anchor).toBe(appHelpAnchor(entry.id))
			expect(entry.anchor).toMatch(/^help-[a-zA-Z]+$/)
		}
	})

	it("opens each row's section", () => {
		const routes: readonly string[] = openRoute.input.route.values

		for (const entry of APP_HELP) {
			expect(entry.route).toBe(`settings_${entry.section}`)

			// The desktop section exists in the desktop app only.
			if (entry.section !== "desktop") {
				expect(routes, entry.id).toContain(entry.route)
			}
		}
	})

	it("marks the desktop section desktop-only", () => {
		for (const entry of APP_HELP.filter(row => row.section === "desktop")) {
			expect(entry.platform, entry.id).toBe("desktop")
		}
	})
})

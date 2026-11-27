import { describe, expect, it } from "vitest"
import { APP_HELP, APP_HELP_RESULTS, appHelpAnchor, appHelpWords, openRoute, rankAppHelp } from "@filen/shared/assistant"

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

	it("ranks rows by the query's words, title words first, in the best of their languages", () => {
		const rows = [
			{ id: "theme", texts: [appHelpWords("Theme", "Light, dark or the system's")] },
			{ id: "twoFactor", texts: [appHelpWords("Two-factor authentication", "Ask for a code at sign-in")] },
			{ id: "password", texts: [appHelpWords("Password", "Change the password you sign in with")] },
			{ id: "language", texts: [appHelpWords("Sprache", "Die Sprache der App"), appHelpWords("Language", "The app's language")] }
		]
		const ids = (query: string) => rankAppHelp(rows, query, row => row.texts).map(row => row.id)

		expect(ids("How do I turn on two-factor authentication?")).toEqual(["twoFactor"])
		// "passwords" folds to "password"; the title outranks a description that only mentions signing in.
		expect(ids("change my passwords sign")).toEqual(["password", "twoFactor"])
		expect(ids("Sprache ändern")).toEqual(["language"])
		expect(ids("app language")).toEqual(["language"])
		// Words of one or two Latin letters match nearly everything.
		expect(ids("on to a")).toEqual([])
	})

	it("puts the preferred of rows that score alike first, keeping registry order otherwise", () => {
		const rows = ["drive", "notes", "chats"].map(screen => ({ screen, texts: [appHelpWords("Rename", screen)] }))
		const screens = (query: string, on: string) =>
			rankAppHelp(
				rows,
				query,
				row => row.texts,
				row => row.screen === on
			).map(row => row.screen)

		expect(screens("rename", "chats")).toEqual(["chats", "drive", "notes"])
		// Naming a screen outscores the preference.
		expect(screens("rename notes", "chats")).toEqual(["notes", "chats", "drive"])
		expect(rankAppHelp(rows, "rename", row => row.texts).map(row => row.screen)).toEqual(["drive", "notes", "chats"])
	})

	it("returns at most APP_HELP_RESULTS rows", () => {
		const rows = Array.from({ length: 8 }, (_, index) => ({ id: index, texts: [appHelpWords(`Cache ${String(index)}`, "")] }))

		expect(rankAppHelp(rows, "cache", row => row.texts).map(row => row.id)).toEqual([0, 1, 2, 3, 4].slice(0, APP_HELP_RESULTS))
		expect(rankAppHelp(rows, "cache", row => row.texts, undefined, 7)).toHaveLength(7)
	})

	it("matches words of scripts written without spaces inside longer ones", () => {
		const rows = [{ id: "language", texts: [appHelpWords("言語", "アプリの表示言語")] }]

		expect(rankAppHelp(rows, "表示言語を変えたい", row => row.texts).map(row => row.id)).toEqual(["language"])
	})

	it("marks the desktop section desktop-only", () => {
		for (const entry of APP_HELP.filter(row => row.section === "desktop")) {
			expect(entry.platform, entry.id).toBe("desktop")
		}
	})
})

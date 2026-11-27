import { describe, expect, it } from "vitest"
import {
	DRIVE_SEARCH_KEY,
	flattenSections,
	GROUP_LIMITS,
	paletteScore,
	rankPalette,
	withRecent,
	type PaletteItem
} from "@/features/palette/lib/palette.logic"
import { searchTokens } from "@filen/shared/assistant"

function action(id: string, title: string, detail = "Everywhere"): PaletteItem {
	return { key: `action:${id}`, group: "actions", title, detail, actionId: id, target: { kind: "action", id } }
}

function place(id: string, title: string): PaletteItem {
	return { key: `action:${id}`, group: "navigation", title, actionId: id, target: { kind: "action", id } }
}

function file(uuid: string, title: string): PaletteItem {
	return { key: `drive:${uuid}`, group: "files", title, detail: "In Cloud Drive", target: { kind: "file", uuid, splat: "" } }
}

function note(uuid: string, title: string): PaletteItem {
	return { key: `note:${uuid}`, group: "notes", title, target: { kind: "note", uuid } }
}

const ITEMS: PaletteItem[] = [
	place("app.openDrive", "Cloud Drive"),
	place("app.openNotes", "Notes"),
	action("app.toggleTheme", "Switch between light and dark theme"),
	action("drive.newDirectory", "New directory", "Cloud Drive"),
	file("f1", "Invoice 2024.pdf"),
	file("f2", "Holiday photos"),
	note("n1", "Shopping list"),
	{
		key: "setting:twoFactor",
		group: "navigation",
		title: "Two-factor authentication",
		queryOnly: true,
		target: { kind: "action", id: "unused" }
	}
]

function keys(query: string, recent: readonly string[] = [], driveSearch = false): string[] {
	return flattenSections(rankPalette(ITEMS, query, { recent, driveSearch })).map(item => item.key)
}

describe("paletteScore", () => {
	it("ranks a whole word over a prefix over a substring, and a title over the detail", () => {
		const item = action("x", "Rename file", "Cloud Drive")

		expect(paletteScore(item, searchTokens("rename"))).toBe(6)
		expect(paletteScore(item, searchTokens("ren"))).toBe(4)
		expect(paletteScore(item, searchTokens("nam"))).toBe(2)
		expect(paletteScore(item, searchTokens("cloud"))).toBe(3)
	})

	it("needs every word to match somewhere", () => {
		expect(paletteScore(action("x", "Rename file"), searchTokens("rename directory"))).toBe(0)
	})

	it("folds case and accents as the settings search does", () => {
		expect(paletteScore(note("n", "Café Menü"), searchTokens("cafe menu"))).toBeGreaterThan(0)
	})

	it("takes the best of the row's languages", () => {
		const item: PaletteItem = {
			...action("x", "Neuer Ordner"),
			texts: [
				{ title: "Neuer Ordner", description: "" },
				{ title: "New directory", description: "" }
			]
		}

		expect(paletteScore(item, searchTokens("new dir"))).toBeGreaterThan(0)
	})
})

describe("rankPalette", () => {
	it("lists the places and the actions for an empty query, settings only through their sections", () => {
		expect(keys("")).toEqual(["action:app.openDrive", "action:app.openNotes", "action:app.toggleTheme", "action:drive.newDirectory"])
	})

	it("puts the recent rows first for an empty query, files and notes included", () => {
		expect(keys("", ["note:n1", "action:app.toggleTheme", "drive:gone"]).slice(0, 3)).toEqual([
			"note:n1",
			"action:app.toggleTheme",
			"action:app.openDrive"
		])
	})

	it("matches across groups, the group holding the best match first", () => {
		const sections = rankPalette(ITEMS, "invoice", { recent: [], driveSearch: false })

		expect(sections.map(section => section.group)).toEqual(["files"])
		// A title match ranks over a detail match ("In Cloud Drive").
		expect(keys("drive")).toEqual(["action:app.openDrive", "action:drive.newDirectory", "drive:f1", "drive:f2"])
	})

	it("finds a setting by its words once typed", () => {
		expect(keys("two")).toContain("setting:twoFactor")
	})

	it("breaks a tie by recency", () => {
		const twins = [file("a", "Report"), file("b", "Report")]
		const ranked = rankPalette(twins, "report", { recent: ["drive:b"], driveSearch: false })

		expect(flattenSections(ranked).map(item => item.key)).toEqual(["drive:b", "drive:a"])
	})

	it("caps each group", () => {
		const many = Array.from({ length: 30 }, (_, index) => file(String(index), `Report ${String(index)}`))

		expect(flattenSections(rankPalette(many, "report", { recent: [], driveSearch: false }))).toHaveLength(GROUP_LIMITS.files)
	})

	it("offers the hand-off to the drive search last among the files for typed words only", () => {
		expect(keys("invoice", [], true)).toEqual(["drive:f1", DRIVE_SEARCH_KEY])
		expect(keys("nothing like it", [], true)).toEqual([DRIVE_SEARCH_KEY])
		expect(keys("", [], true)).not.toContain(DRIVE_SEARCH_KEY)
	})
})

describe("withRecent", () => {
	it("moves a picked row to the front, once, within the limit", () => {
		expect(withRecent(["a", "b", "c"], "c", 3)).toEqual(["c", "a", "b"])
		expect(withRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"])
	})

	it("never remembers the drive search hand-off", () => {
		expect(withRecent(["a"], DRIVE_SEARCH_KEY)).toEqual(["a"])
	})
})

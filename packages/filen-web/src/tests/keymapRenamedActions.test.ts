import { describe, expect, it, vi } from "vitest"
import { UNBOUND_COMBO } from "@filen/shared/keymap"

// The spreadsheet's and the presentation's print became one office.print: a key a user set for either moves to it
// when the stored keymap loads.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const { migrateOverrides } = await import("@/lib/keymap/registry")
const { ALL_ACTIONS } = await import("@/lib/keymap/actions")

describe("renamed keymap actions", () => {
	it("moves the spreadsheet's print key to office.print", () => {
		expect(migrateOverrides({ "sheet.print": "mod+shift+p", "sheet.wrap": "mod+alt+w" })).toEqual({
			"office.print": "mod+shift+p",
			"sheet.wrap": "mod+alt+w"
		})
	})

	it("moves the presentation's print key, an unbound one included", () => {
		expect(migrateOverrides({ "presentation.print": UNBOUND_COMBO })).toEqual({ "office.print": UNBOUND_COMBO })
	})

	it("keeps a key already set for office.print, then the spreadsheet's over the presentation's", () => {
		expect(migrateOverrides({ "office.print": "f9", "sheet.print": "mod+shift+p", "presentation.print": "mod+alt+p" })).toEqual({
			"office.print": "f9"
		})
		expect(migrateOverrides({ "presentation.print": "mod+alt+p", "sheet.print": "mod+shift+p" })).toEqual({
			"office.print": "mod+shift+p"
		})
	})

	it("leaves no old id registered", () => {
		const ids = ALL_ACTIONS.map(def => def.id)

		expect(ids).toContain("office.print")
		expect(ids).not.toContain("sheet.print")
		expect(ids).not.toContain("presentation.print")
	})
})

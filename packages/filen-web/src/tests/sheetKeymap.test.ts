import { afterEach, describe, expect, it, vi } from "vitest"
import { SHEET_SHORTCUTS, shortcutOf, type ShortcutKey } from "@filen/office/react/sheet/keys"

// The spreadsheet grid's shortcuts as keymap actions: their defaults are the grid's table, Settings → Keyboard lists
// them under Spreadsheet, and the combos in effect reach the grid's matcher.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const { registerAllActions } = await import("@/lib/keymap/actions")
const { bindingsOf, clearUserCombo, currentKeymapRecord, defaultComboOn, setUserCombo, unbindAction } =
	await import("@/lib/keymap/registry")
const { SHEET_ACTIONS, sheetActionId, sheetBindings } = await import("@/features/spreadsheet/lib/keymap")

registerAllActions()

function press(init: Partial<ShortcutKey> & { readonly code: string }): ShortcutKey {
	return { key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }
}

function live(): ReturnType<typeof sheetBindings> {
	return sheetBindings(bindingsOf(currentKeymapRecord()))
}

afterEach(async () => {
	await Promise.all(["sheet.wrap", "sheet.fillDown", "preview.save"].map(id => clearUserCombo(id)))
})

describe("the spreadsheet's keymap actions", () => {
	it("registers every grid shortcut but save, in the Spreadsheet group, with the table's keys", () => {
		const ids = SHEET_ACTIONS.map(def => def.id)

		expect(ids).not.toContain("sheet.save")
		expect(ids).toHaveLength(SHEET_SHORTCUTS.length - 1)

		for (const entry of SHEET_SHORTCUTS) {
			const action = entry.action

			if (action === "save") continue

			const def = SHEET_ACTIONS.find(candidate => candidate.id === sheetActionId(action))

			expect(def?.scope, entry.action).toBe("editor")
			expect(def?.section, entry.action).toBe("sheet")
			expect(def === undefined ? null : defaultComboOn(def, { mac: false, desktop: false }), entry.action).toBe(entry.windows)
			expect(def === undefined ? null : defaultComboOn(def, { mac: true, desktop: false }), entry.action).toBe(entry.mac)
		}
	})

	it("ships the ribbon's commands unbound, and no Control+Space where the macOS app refuses it", () => {
		const wrap = SHEET_ACTIONS.find(def => def.id === "sheet.wrap")
		const columns = SHEET_ACTIONS.find(def => def.id === "sheet.selectColumns")

		expect(wrap?.defaultCombo).toBe("")
		expect(columns === undefined ? null : defaultComboOn(columns, { mac: true, desktop: true })).toBe("")
		expect(columns === undefined ? null : defaultComboOn(columns, { mac: true, desktop: false })).toBe("ctrl+space")
	})

	it("hands the grid one bindings object per keymap change", async () => {
		const before = live()

		expect(live()).toBe(before)

		await setUserCombo("sheet.wrap", "mod+alt+w")

		const after = live()

		expect(after).not.toBe(before)
		expect(after.wrap).toBe("mod+alt+w")
		expect(shortcutOf(press({ code: "KeyW", ctrlKey: true, altKey: true }), false, after)).toBe("wrap")
	})

	it("frees a key the user moves an action off, and turns one off", async () => {
		await setUserCombo("sheet.fillDown", "mod+shift+d")

		expect(shortcutOf(press({ code: "KeyD", ctrlKey: true }), false, live())).toBeNull()
		expect(shortcutOf(press({ code: "KeyD", ctrlKey: true, shiftKey: true }), false, live())).toBe("fillDown")

		await unbindAction("sheet.fillDown")

		expect(shortcutOf(press({ code: "KeyD", ctrlKey: true, shiftKey: true }), false, live())).toBeNull()
	})

	it("takes preview.save's keys as the grid's save, and Mod+S with them", async () => {
		expect(live().save).toBe("mod+s")

		await setUserCombo("preview.save", "mod+shift+e")

		expect(live().save).toBe("mod+shift+e,mod+s")
		expect(shortcutOf(press({ code: "KeyE", ctrlKey: true, shiftKey: true }), false, live())).toBe("save")
		expect(shortcutOf(press({ code: "KeyS", metaKey: true }), true, live())).toBe("save")

		await unbindAction("preview.save")

		expect(live().save).toBe("mod+s")
	})
})

import { describe, expect, it } from "vitest"
import type { ActionScope, ResolvedAction } from "@/lib/keymap/registry"
import { groupShortcuts, SHORTCUT_SCOPE_LABEL_KEYS, SHORTCUT_SCOPE_ORDER } from "@/lib/keymap/shortcutsCatalog"

function action(id: string, scope: ActionScope, combo: string): ResolvedAction {
	return { id, scope, combo, defaultCombo: combo, descriptionKey: "common:toggleTheme" }
}

// Every ActionScope the union admits, so widening it without extending the order/label data fails
// here rather than silently dropping a whole group out of both shortcut surfaces.
const ALL_SCOPES: readonly ActionScope[] = ["global", "drive", "editor", "notes", "chats", "audio", "photos", "contacts"]

describe("groupShortcuts", () => {
	it("emits groups in SHORTCUT_SCOPE_ORDER regardless of input order", () => {
		const groups = groupShortcuts([action("audio.a", "audio", "x"), action("drive.a", "drive", "y"), action("app.a", "global", "z")])

		expect(groups.map(group => group.scope)).toEqual(["global", "drive", "audio"])
	})

	it("sorts actions inside a group by id", () => {
		const groups = groupShortcuts([action("drive.z", "drive", "z"), action("drive.a", "drive", "a")])

		expect(groups[0]?.actions.map(entry => entry.id)).toEqual(["drive.a", "drive.z"])
	})

	it("keeps an unbound action — the rebind row is exactly where a user makes it reachable", () => {
		const groups = groupShortcuts([action("app.openSettings", "global", "")])

		expect(groups[0]?.actions.map(entry => entry.id)).toEqual(["app.openSettings"])
	})

	it("drops a scope with no actions", () => {
		const groups = groupShortcuts([action("drive.a", "drive", "a")])

		expect(groups.map(group => group.scope)).toEqual(["drive"])
	})

	it("labels each group from SHORTCUT_SCOPE_LABEL_KEYS", () => {
		const groups = groupShortcuts([action("drive.a", "drive", "a")])

		expect(groups[0]?.labelKey).toBe(SHORTCUT_SCOPE_LABEL_KEYS.drive)
	})

	it("carries the override-derived combo, not the default", () => {
		const groups = groupShortcuts([{ ...action("drive.a", "drive", "mod+a"), combo: "mod+j" }])

		expect(groups[0]?.actions[0]?.combo).toBe("mod+j")
	})
})

describe("shortcut scope metadata", () => {
	it("labels every scope", () => {
		for (const scope of ALL_SCOPES) {
			expect(SHORTCUT_SCOPE_LABEL_KEYS[scope]).toBeTruthy()
		}
	})

	it("orders every scope, with no duplicates", () => {
		expect(new Set(SHORTCUT_SCOPE_ORDER)).toEqual(new Set(ALL_SCOPES))
		expect(new Set(SHORTCUT_SCOPE_ORDER).size).toBe(SHORTCUT_SCOPE_ORDER.length)
	})
})

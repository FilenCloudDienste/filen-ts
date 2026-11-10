import { describe, expect, it } from "vitest"
import type { ActionScope, ResolvedAction } from "@/lib/keymap/registry"
import type { ShortcutSection } from "@/lib/keymap/registry"
import {
	filterCounts,
	groupShortcuts,
	searchShortcuts,
	SHORTCUT_SCOPE_LABEL_KEYS,
	SHORTCUT_SCOPE_ORDER,
	SHORTCUT_SECTION_LABEL_KEYS,
	SHORTCUT_SECTION_ORDER,
	type ShortcutGroup
} from "@/lib/keymap/shortcutsCatalog"

function action(id: string, scope: ActionScope, combo: string, extra: Partial<ResolvedAction> = {}): ResolvedAction {
	return {
		id,
		scope,
		combo,
		defaultCombo: combo,
		platformDefault: combo,
		overridden: false,
		descriptionKey: "common:toggleTheme",
		...extra
	}
}

// Every ActionScope the union admits, so widening it without extending the order/label data fails
// here rather than silently dropping a whole group out of both shortcut surfaces.
const ALL_SCOPES: readonly ActionScope[] = [
	"global",
	"drive",
	"editor",
	"notes",
	"chats",
	"audio",
	"photos",
	"contacts",
	"videos",
	"playlists",
	"transfers",
	"sync",
	"mounts",
	"publicLinks",
	"settings"
]

describe("groupShortcuts", () => {
	it("emits groups in SHORTCUT_SCOPE_ORDER regardless of input order", () => {
		const groups = groupShortcuts([action("audio.a", "audio", "x"), action("drive.a", "drive", "y"), action("app.a", "global", "z")])

		expect(groups.map(group => group.scope)).toEqual(["global", "drive", "audio"])
	})

	it("keeps the feature's task order inside a group, not the id order", () => {
		const groups = groupShortcuts([action("drive.z", "drive", "z"), action("drive.a", "drive", "a")])

		expect(groups[0]?.actions.map(entry => entry.id)).toEqual(["drive.z", "drive.a"])
	})

	it("splits a scope into its sections, the section-less actions first, then SHORTCUT_SECTION_ORDER", () => {
		const groups = groupShortcuts([
			action("presentation.show.next", "editor", "n", { section: "slideshow" }),
			action("editor.find", "editor", "mod+f"),
			action("presentation.undo", "editor", "mod+z", { section: "presentation" }),
			action("preview.pdfZoomIn", "editor", "mod+equal", { section: "viewer" })
		])

		expect(groups.map(group => group.key)).toEqual(["editor", "editor.viewer", "editor.presentation", "editor.slideshow"])
		expect(groups[3]?.sectionLabelKey).toBe("keyboardSectionSlideshow")
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

describe("shortcut section metadata", () => {
	// Word and Spreadsheet slot in before any action names them.
	const ALL_SECTIONS: readonly ShortcutSection[] = [
		"viewer",
		"imageEditor",
		"code",
		"presentation",
		"presentationObjects",
		"presentationText",
		"slideshow",
		"word",
		"sheet"
	]

	it("orders and labels every section", () => {
		expect(new Set(SHORTCUT_SECTION_ORDER)).toEqual(new Set(ALL_SECTIONS))

		for (const section of ALL_SECTIONS) {
			expect(SHORTCUT_SECTION_LABEL_KEYS[section]).toBeTruthy()
		}
	})
})

describe("searchShortcuts and filters", () => {
	const actions = [
		action("drive.rename", "drive", "f2", { overridden: true }),
		action("drive.trash", "drive", "delete,backspace"),
		action("drive.newDirectory", "drive", ""),
		action("presentation.zoomIn", "editor", "mod+equal", { section: "presentation" })
	]
	const groups = groupShortcuts(actions)
	const conflicts = new Map([["drive.trash", []]])
	const names: Record<string, string> = {
		"drive.rename": "rename",
		"drive.trash": "move to trash",
		"drive.newDirectory": "new directory",
		"presentation.zoomIn": "zoom in"
	}
	const label = (entry: ResolvedAction): string => names[entry.id] ?? ""
	const groupLabel = (group: ShortcutGroup): string => (group.section === null ? group.scope : `editor › presentation`)
	const found = (text: string, keys: string | null, filter: "all" | "changed" | "conflicts" | "unset" = "all", mac = false) =>
		searchShortcuts(groups, { text, keys, filter }, conflicts, label, groupLabel, mac).flatMap(group =>
			group.actions.map(entry => entry.id)
		)

	it("returns the groups untouched with no query", () => {
		expect(searchShortcuts(groups, { text: "", keys: null, filter: "all" }, conflicts, label, groupLabel, false)).toBe(groups)
	})

	it("matches the name and the group's name", () => {
		expect(found("trash", null)).toEqual(["drive.trash"])
		expect(found("presentation", null)).toEqual(["presentation.zoomIn"])
	})

	it("matches by pressed keys through the token model, per platform", () => {
		expect(found("", "backspace")).toEqual(["drive.trash"])
		expect(found("", "ctrl+=")).toEqual(["presentation.zoomIn"])
		expect(found("", "ctrl+equal", "all", true)).toEqual([])
		expect(found("", "meta+equal", "all", true)).toEqual(["presentation.zoomIn"])
	})

	it("filters changed, conflicting and unset actions, and counts them", () => {
		expect(found("", null, "changed")).toEqual(["drive.rename"])
		expect(found("", null, "conflicts")).toEqual(["drive.trash"])
		expect(found("", null, "unset")).toEqual(["drive.newDirectory"])
		expect(filterCounts(actions, conflicts)).toEqual({ changed: 1, conflicts: 1, unset: 1 })
	})
})

import { describe, expect, it } from "vitest"
import type { ActionScope, ResolvedAction } from "@/lib/keymap/registry"
import { comboWithout, conflictingActions, conflictsByAction, reassignChanges, scopesCanCollide, swapChanges } from "@/lib/keymap/conflicts"

function action(id: string, scope: ActionScope, combo: string, overridden = false): ResolvedAction {
	return { id, scope, combo, defaultCombo: combo, platformDefault: combo, overridden, descriptionKey: "common:toggleTheme" }
}

function ids(actions: readonly ResolvedAction[]): string[] {
	return actions.map(entry => entry.id)
}

describe("scopesCanCollide", () => {
	it("is reflexive — two actions in the same scope always co-mount", () => {
		expect(scopesCanCollide("drive", "drive")).toBe(true)
		expect(scopesCanCollide("notes", "notes")).toBe(true)
	})

	it("keeps route-exclusive scopes apart", () => {
		expect(scopesCanCollide("drive", "notes")).toBe(false)
		expect(scopesCanCollide("photos", "chats")).toBe(false)
		expect(scopesCanCollide("contacts", "drive")).toBe(false)
	})

	it("co-mounts editor with the surfaces that host the preview overlay, and with the notes editors", () => {
		expect(scopesCanCollide("editor", "drive")).toBe(true)
		expect(scopesCanCollide("editor", "photos")).toBe(true)
		expect(scopesCanCollide("editor", "chats")).toBe(true)
		expect(scopesCanCollide("editor", "notes")).toBe(true)
		expect(scopesCanCollide("notes", "editor")).toBe(true)
	})

	it("co-mounts global and audio with everything, in either argument order", () => {
		for (const scope of ["drive", "editor", "notes", "chats", "photos", "contacts", "videos"] as const) {
			expect(scopesCanCollide("global", scope)).toBe(true)
			expect(scopesCanCollide(scope, "global")).toBe(true)
			expect(scopesCanCollide("audio", scope)).toBe(true)
			expect(scopesCanCollide(scope, "audio")).toBe(true)
		}
	})
})

describe("conflictingActions", () => {
	it("matches per alternative, not by string equality", () => {
		const actions = [action("drive.trash", "drive", "delete,backspace"), action("drive.other", "drive", "")]

		expect(ids(conflictingActions(actions, "delete", "drive.other"))).toEqual(["drive.trash"])
	})

	it("matches in the other direction too — a recorded multi-alternative combo against a stored single one", () => {
		const actions = [action("drive.back", "drive", "backspace"), action("drive.other", "drive", "")]

		expect(ids(conflictingActions(actions, "delete,backspace", "drive.other"))).toEqual(["drive.back"])
	})

	it("does not report an unrelated combo", () => {
		const actions = [action("drive.search", "drive", "mod+f"), action("drive.download", "drive", "mod+s")]

		expect(ids(conflictingActions(actions, "mod+s", "drive.search"))).toEqual(["drive.download"])
		expect(ids(conflictingActions(actions, "mod+k", "drive.search"))).toEqual([])
	})

	it("ignores token order inside a chord", () => {
		const actions = [action("drive.a", "drive", "mod+shift+a"), action("drive.b", "drive", "")]

		expect(ids(conflictingActions(actions, "shift+mod+a", "drive.b"))).toEqual(["drive.a"])
	})

	it("reports a same-scope collision", () => {
		const actions = [action("drive.selectAll", "drive", "mod+a"), action("drive.rename", "drive", "f2")]

		expect(ids(conflictingActions(actions, "mod+a", "drive.rename"))).toEqual(["drive.selectAll"])
	})

	it("does not report a route-exclusive scope", () => {
		const actions = [action("notes.selectAll", "notes", "mod+a"), action("drive.rename", "drive", "f2")]

		expect(ids(conflictingActions(actions, "mod+a", "drive.rename"))).toEqual([])
	})

	it("reports an editor action against the surfaces it co-mounts with", () => {
		const preview = action("preview.save", "editor", "mod+s")

		for (const scope of ["drive", "photos", "chats"] as const) {
			const actions = [preview, action(`${scope}.subject`, scope, "")]

			expect(ids(conflictingActions(actions, "mod+s", `${scope}.subject`))).toEqual(["preview.save"])
		}
	})

	it("reports global and audio actions against every scope", () => {
		const actions = [
			action("app.toggleTheme", "global", "d"),
			action("audio.playPause", "audio", "d"),
			action("notes.subject", "notes", "")
		]

		expect(ids(conflictingActions(actions, "d", "notes.subject"))).toEqual(["app.toggleTheme", "audio.playPause"])
	})

	// The recorder emits canonical tokens from event.code ("arrowright"), while the shipped audio
	// transport defaults are written in react-hotkeys-hook's alias form ("right") — the library matches
	// both on the same physical key, so the checker has to as well or it hands out a binding that fires
	// two actions at once.
	it("reports an alias-form default against a canonically recorded chord", () => {
		const actions = [action("audio.next", "audio", "mod+shift+right"), action("drive.rename", "drive", "f2")]

		expect(ids(conflictingActions(actions, "mod+shift+arrowright", "drive.rename"))).toEqual(["audio.next"])
	})

	it("reports one key across its spellings: a character, a recorded token, an older escaped comma", () => {
		const actions = [
			action("preview.zoomOut", "editor", "mod+-"),
			action("preview.shrink", "editor", "mod+shift+,"),
			action("preview.pointer", "editor", "a,="),
			action("drive.rename", "drive", "f2")
		]

		expect(ids(conflictingActions(actions, "mod+minus", "drive.rename", false))).toEqual(["preview.zoomOut"])
		expect(ids(conflictingActions(actions, "shift+mod+comma", "drive.rename", false))).toEqual(["preview.shrink"])
		expect(ids(conflictingActions(actions, "equal", "drive.rename", false))).toEqual(["preview.pointer"])
	})

	it("compares keystrokes on the given platform: Mod is Ctrl off a Mac, Cmd on one", () => {
		const actions = [action("preview.zoomIn", "editor", "mod+equal"), action("preview.subscript", "editor", "")]

		expect(ids(conflictingActions(actions, "mod+ctrl+=", "preview.subscript", false))).toEqual(["preview.zoomIn"])
		expect(ids(conflictingActions(actions, "mod+ctrl+=", "preview.subscript", true))).toEqual([])
		expect(ids(conflictingActions(actions, "ctrl+equal", "preview.subscript", false))).toEqual(["preview.zoomIn"])
		expect(ids(conflictingActions(actions, "meta+equal", "preview.subscript", true))).toEqual(["preview.zoomIn"])
	})

	it("never reports the action being rebound against itself", () => {
		const actions = [action("drive.selectAll", "drive", "mod+a")]

		expect(ids(conflictingActions(actions, "mod+a", "drive.selectAll"))).toEqual([])
	})

	it("still reports a different action holding the excluded action's combo", () => {
		const actions = [action("drive.selectAll", "drive", "mod+a"), action("drive.rename", "drive", "mod+a")]

		expect(ids(conflictingActions(actions, "mod+a", "drive.selectAll"))).toEqual(["drive.rename"])
	})

	it("treats an empty combo as unbound in both directions", () => {
		const actions = [action("app.openSettings", "global", ""), action("app.openPhotos", "global", "")]

		expect(conflictingActions(actions, "", "app.openSettings")).toEqual([])
		expect(conflictingActions(actions, "mod+k", "app.openSettings")).toEqual([])
	})

	it("reports every real collision, including an allowlisted pair", () => {
		// RESOLVED_COLLISIONS records defaults that already collide and are guarded at runtime. Honoring
		// it here would let a user create a SECOND, unguarded mod+s binding and have it accepted.
		const actions = [action("drive.download", "drive", "mod+s"), action("preview.save", "editor", "mod+s")]

		expect(ids(conflictingActions(actions, "mod+s", "preview.save"))).toEqual(["drive.download"])
	})

	it("falls back to reporting every combo match when the excluded id names no known action", () => {
		const actions = [action("notes.selectAll", "notes", "mod+a"), action("drive.selectAll", "drive", "mod+a")]

		expect(ids(conflictingActions(actions, "mod+a", "app.unknown"))).toEqual(["notes.selectAll", "drive.selectAll"])
	})
})

describe("conflictsByAction", () => {
	it("lists every action sharing a keystroke with each other one, both ways", () => {
		const conflicts = conflictsByAction(
			[
				action("drive.a", "drive", "mod+k", true),
				action("drive.b", "drive", "mod+k,f2", true),
				action("app.c", "global", "f2", true)
			],
			false
		)

		expect(ids(conflicts.get("drive.a") ?? [])).toEqual(["drive.b"])
		expect(ids(conflicts.get("drive.b") ?? []).sort()).toEqual(["app.c", "drive.a"])
		expect(ids(conflicts.get("app.c") ?? [])).toEqual(["drive.b"])
	})

	it("skips scopes that never co-mount", () => {
		expect(conflictsByAction([action("drive.a", "drive", "n", true), action("notes.b", "notes", "n", true)], false).size).toBe(0)
	})

	it("skips a shipped, guarded pair until the user rebinds either side", () => {
		const shipped = [action("drive.download", "drive", "mod+s"), action("preview.save", "editor", "mod+s")]

		expect(conflictsByAction(shipped, false).size).toBe(0)
		expect(
			conflictsByAction([shipped[0] ?? action("x", "drive", ""), action("preview.save", "editor", "mod+s", true)], false).size
		).toBe(2)
	})

	it("compares per platform: mod is Ctrl off a Mac", () => {
		const actions = [action("drive.a", "drive", "mod+k", true), action("drive.b", "drive", "ctrl+k", true)]

		expect(conflictsByAction(actions, false).size).toBe(2)
		expect(conflictsByAction(actions, true).size).toBe(0)
	})
})

describe("reassign and swap", () => {
	const actions = [action("drive.a", "drive", "f2"), action("drive.b", "drive", "mod+k,delete"), action("drive.c", "drive", "mod+k")]

	it("comboWithout drops the chords on that keystroke, leaving the unbound marker when nothing is left", () => {
		expect(comboWithout("mod+k,delete", "ctrl+k", false)).toBe("delete")
		expect(comboWithout("mod+k", "mod+k", false)).toBe("none")
	})

	it("reassign takes the chord off every action holding it", () => {
		expect(reassignChanges(actions, "drive.a", "mod+k", "mod+k", false)).toEqual({
			"drive.a": "mod+k",
			"drive.b": "delete",
			"drive.c": "none"
		})
	})

	it("swap hands the other action the chord this one gave up", () => {
		expect(swapChanges(actions, "drive.a", "mod+k", "mod+k", "f2", "drive.c", false)).toEqual({ "drive.a": "mod+k", "drive.c": "f2" })
		expect(swapChanges(actions, "drive.a", "delete", "delete", "f2", "drive.b", false)).toEqual({
			"drive.a": "delete",
			"drive.b": "mod+k,f2"
		})
	})
})

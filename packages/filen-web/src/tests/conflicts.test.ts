import { describe, expect, it } from "vitest"
import type { ActionScope, ResolvedAction } from "@/lib/keymap/registry"
import { conflictingActions, scopesCanCollide } from "@/lib/keymap/conflicts"

function action(id: string, scope: ActionScope, combo: string): ResolvedAction {
	return { id, scope, combo, defaultCombo: combo, descriptionKey: "common:toggleTheme" }
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

	it("co-mounts editor with the surfaces that host the preview overlay", () => {
		expect(scopesCanCollide("editor", "drive")).toBe(true)
		expect(scopesCanCollide("editor", "photos")).toBe(true)
		expect(scopesCanCollide("editor", "chats")).toBe(true)
		expect(scopesCanCollide("editor", "notes")).toBe(false)
	})

	it("co-mounts global and audio with everything, in either argument order", () => {
		for (const scope of ["drive", "editor", "notes", "chats", "photos", "contacts"] as const) {
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

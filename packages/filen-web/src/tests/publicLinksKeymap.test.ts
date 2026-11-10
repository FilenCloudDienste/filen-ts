import { describe, expect, it } from "vitest"
import { withoutCharacterChords } from "@filen/shared/keymap"
import { defaultComboOn } from "@/lib/keymap/registry"
import { PUBLIC_LINKS_ACTIONS } from "@/features/publicLinks/lib/keymap"

const PLATFORM = { mac: true, desktop: false }

describe("PUBLIC_LINKS_ACTIONS", () => {
	it("ship download, save, back, up and filter", () => {
		const combos = Object.fromEntries(PUBLIC_LINKS_ACTIONS.map(action => [action.id, defaultComboOn(action, PLATFORM)]))

		expect(combos).toEqual({
			"links.download": "mod+s",
			"links.saveToDrive": "mod+shift+s",
			"links.back": "escape",
			"links.up": "alt+arrowup",
			"links.filter": "slash"
		})

		for (const action of PUBLIC_LINKS_ACTIONS) expect(action.scope, action.id).toBe("publicLinks")
	})

	// "/" is a single character: switching single-key shortcuts off drops it, and the chords stay.
	it("drop only the filter's / with single-key shortcuts off", () => {
		const filter = PUBLIC_LINKS_ACTIONS.find(action => action.id === "links.filter")
		const download = PUBLIC_LINKS_ACTIONS.find(action => action.id === "links.download")

		expect(withoutCharacterChords(filter?.defaultCombo ?? "")).toBe("")
		expect(withoutCharacterChords(download?.defaultCombo ?? "")).toBe("mod+s")
	})
})

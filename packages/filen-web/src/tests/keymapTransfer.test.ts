import { describe, expect, it } from "vitest"
import { parseCombo } from "@filen/shared/keymap"
import type { ResolvedAction } from "@/lib/keymap/registry"
import { reservedBlocks, reservedOwner } from "@/lib/keymap/reserved"
import { keymapExport, planKeymapImport } from "@/lib/keymap/transfer"

function action(id: string, combo: string): ResolvedAction {
	return {
		id,
		scope: "drive",
		combo,
		defaultCombo: combo,
		platformDefault: combo,
		overridden: false,
		descriptionKey: "common:toggleTheme"
	}
}

const ACTIONS = [action("drive.rename", "f2"), action("drive.trash", "delete,backspace"), action("app.toggleTheme", "d")]
const CURRENT = { overrides: {}, characterKeys: true }

describe("keymap export and import", () => {
	it("round-trips the user's overrides and the single-key switch", () => {
		const text = keymapExport({ overrides: { "drive.rename": "f6", "app.toggleTheme": "none" }, characterKeys: false })
		const plan = planKeymapImport(text, ACTIONS, CURRENT)

		expect(plan).toEqual({
			overrides: { "drive.rename": "f6", "app.toggleTheme": "none" },
			changes: [
				{ id: "drive.rename", before: "f2", after: "f6" },
				{ id: "app.toggleTheme", before: "d", after: "" }
			],
			skipped: 0,
			characterKeys: false
		})
	})

	it("drops unknown ids and combos that hold no chord, and leaves out what already matches", () => {
		const text = JSON.stringify({
			kind: "filen-keymap",
			version: 1,
			overrides: { "drive.gone": "f9", "drive.trash": "a>b", "drive.rename": "f2", "app.toggleTheme": "shift+=" }
		})

		expect(planKeymapImport(text, ACTIONS, CURRENT)).toEqual({
			overrides: { "app.toggleTheme": "shift+equal" },
			changes: [{ id: "app.toggleTheme", before: "d", after: "shift+equal" }],
			skipped: 2,
			characterKeys: undefined
		})
	})

	it("refuses anything that is not an export", () => {
		expect(planKeymapImport("not json", ACTIONS, CURRENT)).toBeNull()
		expect(planKeymapImport(JSON.stringify({ "drive.rename": "f6" }), ACTIONS, CURRENT)).toBeNull()
		expect(planKeymapImport(JSON.stringify({ kind: "filen-keymap", version: 2, overrides: {} }), ACTIONS, CURRENT)).toBeNull()
		expect(
			planKeymapImport(JSON.stringify({ kind: "filen-keymap", version: 1, overrides: { "drive.rename": "" } }), ACTIONS, CURRENT)
		).toBeNull()
	})
})

describe("reserved keys", () => {
	const chord = (combo: string) => {
		const [parsed] = parseCombo(combo)

		if (parsed === undefined) {
			throw new Error(combo)
		}

		return parsed
	}
	const WEB = { mac: false, desktop: false }
	const MAC_WEB = { mac: true, desktop: false }
	const DESKTOP = { mac: false, desktop: true }
	const MAC_DESKTOP = { mac: true, desktop: true }

	it("knows the browser's tab and window keys on the web only", () => {
		expect(reservedOwner(chord("mod+w"), WEB)).toBe("browser")
		expect(reservedOwner(chord("mod+5"), MAC_WEB)).toBe("browser")
		expect(reservedOwner(chord("ctrl+tab"), WEB)).toBe("browser")
		expect(reservedOwner(chord("mod+t"), DESKTOP)).toBeUndefined()
	})

	it("knows Firefox's keys, the system's per OS, and the macOS app's menu", () => {
		expect(reservedOwner(chord("mod+shift+p"), WEB)).toBe("firefox")
		expect(reservedOwner(chord("mod+q"), MAC_WEB)).toBe("system")
		expect(reservedOwner(chord("ctrl+space"), MAC_DESKTOP)).toBe("system")
		expect(reservedOwner(chord("ctrl+space"), WEB)).toBeUndefined()
		expect(reservedOwner(chord("alt+f4"), DESKTOP)).toBe("system")
		expect(reservedOwner(chord("meta+e"), WEB)).toBe("system")
		expect(reservedOwner(chord("mod+ctrl+f"), MAC_DESKTOP)).toBe("appMenu")
		// Close is the page's own desktop.close.
		expect(reservedOwner(chord("mod+w"), MAC_DESKTOP)).toBeUndefined()
		expect(reservedOwner(chord("mod+k"), WEB)).toBeUndefined()
	})

	it("refuses only in the desktop app, and never the browser's keys", () => {
		expect(reservedBlocks("system", MAC_DESKTOP)).toBe(true)
		expect(reservedBlocks("appMenu", MAC_DESKTOP)).toBe(true)
		expect(reservedBlocks("system", WEB)).toBe(false)
		expect(reservedBlocks("browser", WEB)).toBe(false)
	})
})

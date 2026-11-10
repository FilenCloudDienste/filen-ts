import { beforeEach, describe, expect, it, vi } from "vitest"
import { DRIVE_ACTIONS } from "@/features/drive/lib/keymap"
import { PHOTOS_ACTIONS } from "@/features/photos/lib/keymap"

// The drive and photos list actions as the real defs register them. registry.ts is a module singleton, so each test
// re-imports it fresh; the mock boundary is the kv adapter lib/keymap/storage.ts calls, as in registry.test.ts.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	},
	kvEntriesJson: (prefix: string) => Promise.resolve([...kvStore.entries()].filter(([key]) => key.startsWith(prefix)))
}))

async function freshRegistry() {
	vi.resetModules()

	return import("@/lib/keymap/registry")
}

const DEFS = [...DRIVE_ACTIONS, ...PHOTOS_ACTIONS]

function def(id: string) {
	const found = DEFS.find(action => action.id === id)

	if (found === undefined) {
		throw new Error(`no ${id} action`)
	}

	return found
}

const MAC = { mac: true, desktop: false }
const OTHER = { mac: false, desktop: false }

beforeEach(() => {
	kvStore.clear()
})

describe("drive and photos list actions — defaults", () => {
	it.each([
		["drive.open", "enter,mod+arrowdown", "enter"],
		["drive.goUp", "mod+arrowup", "alt+arrowup"],
		["drive.openItemMenu", "shift+f10", "shift+f10"],
		["drive.info", "mod+i", "alt+enter"],
		["drive.restore", "mod+backspace", ""],
		["drive.toggleHiddenItems", "mod+shift+period", "mod+shift+period"],
		["drive.deletePermanently", "mod+alt+backspace", "shift+delete"],
		["photos.open", "enter,mod+arrowdown", "enter"],
		["photos.openItemMenu", "shift+f10", "shift+f10"],
		["photos.previousMonth", "shift+pageup", "shift+pageup"],
		["photos.nextMonth", "shift+pagedown", "shift+pagedown"],
		["photos.rename", "f2", "f2"],
		["photos.info", "mod+i", "alt+enter"],
		["photos.download", "mod+s", "mod+s"],
		["drive.downloadAs", "mod+shift+s", "mod+shift+s"],
		["drive.copyLink", "mod+alt+c", "mod+alt+c"],
		["drive.openContainingDirectory", "shift+enter", "shift+enter"]
	])("%s is %s on a Mac and %s elsewhere", async (id, mac, other) => {
		const { defaultComboOn } = await freshRegistry()

		expect(defaultComboOn(def(id), MAC)).toBe(mac)
		expect(defaultComboOn(def(id), OTHER)).toBe(other)
	})

	// No sensible free default: a bare digit is the media players' seek key, Mod+digit the browser's tab switch.
	it.each([
		"photos.share",
		"photos.filterAll",
		"photos.filterImages",
		"photos.filterVideos",
		"photos.filterRaw",
		"photos.manageDirectories",
		"drive.invertSelection",
		"drive.focusListing",
		"drive.openAsText",
		"drive.newDocx",
		"drive.newXlsx",
		"drive.newPptx",
		"drive.newOdt",
		"drive.newOds",
		"drive.newOdp",
		"drive.versions",
		"drive.color",
		"drive.share",
		"drive.clearClipboard",
		"drive.compress",
		"drive.extract",
		"drive.emptyTrash",
		"drive.listView",
		"drive.gridView",
		"drive.cycleSort",
		"drive.upload",
		"drive.uploadDirectory",
		"drive.newTextFile",
		"drive.toggleFavorite",
		"drive.move",
		"drive.copyTo",
		"drive.toggleView",
		"photos.toggleFavorite",
		"photos.favoritesFilter",
		"photos.densityIncrease",
		"photos.densityDecrease"
	])("%s ships unbound and resolves to no combo", async id => {
		const { registerAction, comboFor } = await freshRegistry()

		registerAction(def(id))

		expect(comboFor(id)).toBe("")
	})

	// Finder's and Explorer's New Folder key opens a private window in a browser.
	it("binds New directory in the desktop app alone", async () => {
		const { defaultComboOn } = await freshRegistry()
		const newDirectory = def("drive.newDirectory")

		expect(defaultComboOn(newDirectory, MAC)).toBe("")
		expect(defaultComboOn(newDirectory, OTHER)).toBe("")
		expect(defaultComboOn(newDirectory, { mac: true, desktop: true })).toBe("mod+shift+n")
		expect(defaultComboOn(newDirectory, { mac: false, desktop: true })).toBe("mod+shift+n")
	})

	// Type-ahead owns every printable key in the listing and the grid, Shift+letter included.
	it.each([MAC, OTHER, { mac: true, desktop: true }, { mac: false, desktop: true }])(
		"ships no bare printable key (mac $mac, desktop $desktop)",
		async platform => {
			const { defaultComboOn } = await freshRegistry()
			const { parseCombo } = await import("@filen/shared/keymap")

			for (const action of DEFS) {
				for (const chord of parseCombo(defaultComboOn(action, platform))) {
					const printable =
						chord.key.length === 1 ||
						[
							"equal",
							"minus",
							"period",
							"comma",
							"slash",
							"semicolon",
							"quote",
							"backquote",
							"bracketleft",
							"bracketright",
							"backslash",
							"space"
						].includes(chord.key)

					expect(printable && !chord.mod && !chord.ctrl && !chord.meta && !chord.alt, `${action.id} ${chord.key}`).toBe(false)
				}
			}
		}
	)

	// The browser's own reload keys reload the app; only the desktop app has them free.
	it("binds Refresh in the desktop app alone", async () => {
		const { defaultComboOn } = await freshRegistry()
		const refresh = def("drive.refresh")

		expect(defaultComboOn(refresh, MAC)).toBe("")
		expect(defaultComboOn(refresh, OTHER)).toBe("")
		expect(defaultComboOn(refresh, { mac: true, desktop: true })).toBe("mod+r")
		expect(defaultComboOn(refresh, { mac: false, desktop: true })).toBe("f5")
	})
})

describe("nextSortOrder", () => {
	it("steps through the sort menu's orders, wrapping round", async () => {
		const { DRIVE_SORT_BY, nextSortOrder } = await import("@/features/drive/lib/sort")

		expect(nextSortOrder("nameAsc")).toBe("nameDesc")
		expect(nextSortOrder(DRIVE_SORT_BY[DRIVE_SORT_BY.length - 1] ?? "nameAsc")).toBe(DRIVE_SORT_BY[0])
		expect(new Set(DRIVE_SORT_BY.map(nextSortOrder)).size).toBe(DRIVE_SORT_BY.length)
	})
})

describe("drive and photos list actions — overrides", () => {
	it("a rebind replaces the default, and a reset restores it", async () => {
		const { registerAction, comboFor, setUserCombo, clearUserCombo, CURRENT_PLATFORM, defaultComboOn } = await freshRegistry()

		registerAction(def("drive.goUp"))
		await setUserCombo("drive.goUp", "backspace")

		expect(comboFor("drive.goUp")).toBe("backspace")

		await clearUserCombo("drive.goUp")

		expect(comboFor("drive.goUp")).toBe(defaultComboOn(def("drive.goUp"), CURRENT_PLATFORM))
	})

	it("an unbound open leaves Enter to the focused control", async () => {
		const { registerAction, comboFor, unbindAction } = await freshRegistry()

		registerAction(def("photos.open"))
		await unbindAction("photos.open")

		expect(comboFor("photos.open")).toBe("")
	})

	// Single-key shortcuts off strips the bare keys, the chords stay.
	it("drops the bare keys with single-key shortcuts off, keeping the chords", async () => {
		const { registerAction, comboFor, setCharacterKeys, CURRENT_PLATFORM, defaultComboOn } = await freshRegistry()

		for (const id of ["drive.toggleFavorite", "drive.move", "photos.densityIncrease", "drive.info"]) {
			registerAction(def(id))
		}

		await setCharacterKeys(false)

		expect(comboFor("drive.toggleFavorite")).toBe("")
		expect(comboFor("drive.move")).toBe("")
		expect(comboFor("photos.densityIncrease")).toBe("")
		expect(comboFor("drive.info")).toBe(defaultComboOn(def("drive.info"), CURRENT_PLATFORM))
	})
})

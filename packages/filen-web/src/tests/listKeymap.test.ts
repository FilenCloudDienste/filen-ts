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
		["drive.upload", "u", "u"],
		["drive.uploadDirectory", "shift+u", "shift+u"],
		["drive.info", "mod+i", "alt+enter"],
		["drive.toggleFavorite", "s", "s"],
		["drive.move", "m", "m"],
		["drive.restore", "r", "r"],
		["drive.deletePermanently", "mod+alt+backspace", "shift+delete"],
		["photos.open", "enter,mod+arrowdown", "enter"],
		["photos.openItemMenu", "shift+f10", "shift+f10"],
		["photos.previousMonth", "shift+pageup", "shift+pageup"],
		["photos.nextMonth", "shift+pagedown", "shift+pagedown"],
		["photos.rename", "f2", "f2"],
		["photos.info", "mod+i", "alt+enter"],
		["photos.toggleFavorite", "f", "f"],
		["photos.favoritesFilter", "shift+f", "shift+f"],
		["photos.download", "mod+s", "mod+s"],
		["photos.densityIncrease", "equal", "equal"],
		["photos.densityDecrease", "minus", "minus"]
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
		"photos.manageDirectories"
	])("%s ships unbound and resolves to no combo", async id => {
		const { registerAction, comboFor } = await freshRegistry()

		registerAction(def(id))

		expect(comboFor(id)).toBe("")
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

import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve()
}))

const { ALL_ACTIONS, shortcutCatalog } = await import("@/lib/keymap/actions")
const { availableOn, defaultComboOn, resolveAction } = await import("@/lib/keymap/registry")
const { panesFrom } = await import("@/features/shell/lib/paneCycle")
const { mediaTransportOf } = await import("@/features/desktop/lib/mediaTransport")

const MAC_WEB = { mac: true, desktop: false }
const WEB = { mac: false, desktop: false }
const MAC_DESKTOP = { mac: true, desktop: true }
const DESKTOP = { mac: false, desktop: true }

function def(id: string) {
	const found = ALL_ACTIONS.find(action => action.id === id)

	if (found === undefined) {
		throw new Error(`no action ${id}`)
	}

	return found
}

function defaults(id: string): readonly string[] {
	return [MAC_WEB, WEB, MAC_DESKTOP, DESKTOP].map(platform => defaultComboOn(def(id), platform))
}

describe("shell actions", () => {
	it("opens Settings with Mod+, everywhere but a Mac browser, which keeps Cmd+, for itself", () => {
		expect(defaults("app.openSettings")).toEqual(["", "mod+comma", "mod+comma", "mod+comma"])
	})

	it("goes to the modules with Mod+1..6 in the desktop app only, where no tabs hold them", () => {
		expect(defaults("app.openDrive")).toEqual(["", "", "mod+1", "mod+1"])
		expect(defaults("app.openContacts")).toEqual(["", "", "mod+4", "mod+4"])
		expect(defaults("app.openMounts")).toEqual(["", "", "mod+6", "mod+6"])
	})

	it("ships the sidebar, focus-area and notification keys", () => {
		expect(defaultComboOn(def("app.toggleSidebar"), WEB)).toBe("mod+backslash")
		expect(defaultComboOn(def("app.nextPane"), WEB)).toBe("f6")
		expect(defaultComboOn(def("app.previousPane"), WEB)).toBe("shift+f6")
		expect(defaultComboOn(def("app.focusNotifications"), WEB)).toBe("alt+t")
	})

	it("leaves the actions without a free key unassigned", () => {
		for (const id of [
			"app.openRecents",
			"app.openTrash",
			"app.dismissNotifications",
			"app.themeLight",
			"app.themeDark",
			"app.themeSystem",
			"app.openAccountMenu",
			"app.signOut"
		]) {
			expect(defaults(id), id).toEqual(["", "", "", ""])
		}
	})

	it("gives the desktop app its window keys, a Mac's being its menu bar's", () => {
		expect(defaults("app.lock")).toEqual(["", "", "mod+alt+l", "mod+alt+l"])
		expect(defaults("desktop.close")).toEqual(["", "", "mod+w", "mod+w"])
		expect(defaults("desktop.back")).toEqual(["", "", "mod+bracketleft", "alt+arrowleft"])
		expect(defaults("desktop.forward")).toEqual(["", "", "mod+bracketright", "alt+arrowright"])
		expect(defaults("desktop.zoomIn")).toEqual(["", "", "", "mod+equal"])
		expect(defaults("desktop.fullScreen")).toEqual(["", "", "", "f11"])
		expect(defaults("desktop.quit")).toEqual(["", "", "", "mod+q"])
	})

	it("lists the desktop app's actions only where they exist", () => {
		const record = { overrides: {}, characterKeys: true }
		const ids = (platform: typeof WEB) => new Set(shortcutCatalog(record, platform).actions.map(action => action.id))

		expect(ids(WEB).has("app.openSync")).toBe(false)
		expect(ids(WEB).has("desktop.close")).toBe(false)
		expect(ids(MAC_DESKTOP).has("desktop.close")).toBe(true)
		expect(ids(MAC_DESKTOP).has("desktop.zoomIn")).toBe(false)
		expect(ids(DESKTOP).has("desktop.zoomIn")).toBe(true)
		expect(availableOn(def("app.openDrive"), WEB)).toBe(true)
	})

	it("takes a user's binding over the default", () => {
		const resolved = resolveAction(def("app.openNotes"), { "app.openNotes": "alt+n" }, WEB)

		expect(resolved).toMatchObject({ combo: "alt+n", platformDefault: "", overridden: true })
	})
})

describe("panesFrom", () => {
	const rail = { contains: (node: unknown) => node === "in-rail" } as unknown as Element
	const sidebar = { contains: (node: unknown) => node === "in-sidebar" } as unknown as Element
	const main = { contains: (node: unknown) => node === "in-main" } as unknown as Element
	const panes = [rail, sidebar, main]

	it("goes on from the area holding focus, wrapping, never back to it", () => {
		expect(panesFrom(panes, "in-sidebar" as unknown as Element, 1)).toEqual([main, rail])
		expect(panesFrom(panes, "in-sidebar" as unknown as Element, -1)).toEqual([rail, main])
		expect(panesFrom(panes, "in-main" as unknown as Element, 1)).toEqual([rail, sidebar])
	})

	it("starts at the first area (or the last, backwards) from outside all of them", () => {
		expect(panesFrom(panes, null, 1)).toEqual([rail, sidebar, main])
		expect(panesFrom(panes, null, -1)).toEqual([main, sidebar, rail])
	})
})

describe("mediaTransportOf", () => {
	it("offers nothing without a queue, Pause while playing or loading, Play otherwise", () => {
		expect(mediaTransportOf(0, "playing")).toBe("none")
		expect(mediaTransportOf(3, "playing")).toBe("playing")
		expect(mediaTransportOf(3, "loading")).toBe("playing")
		expect(mediaTransportOf(3, "paused")).toBe("paused")
		expect(mediaTransportOf(3, "idle")).toBe("paused")
	})
})

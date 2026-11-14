import type { MenuItemConstructorOptions } from "electron"
import { describe, expect, it, vi } from "vitest"
import { isDevToolsKey, isMenuAction, type MenuOptions, menuTemplate, toAccelerator, transportItems, zoomLevelAfter } from "../main/menu.ts"

describe("toAccelerator", () => {
	it.each([
		["mod+shift+k", "CmdOrCtrl+Shift+K"],
		["ctrl+alt+arrowup", "Ctrl+Alt+Up"],
		["mod+comma", "CmdOrCtrl+,"],
		["f5", "F5"],
		["Mod+K", "CmdOrCtrl+K"],
		["mod+bracketleft", "CmdOrCtrl+["],
		["mod+add", "CmdOrCtrl+numadd"],
		// Older spellings: a key by its character, a "," where a key belongs.
		["mod+=", "CmdOrCtrl+="],
		["mod+shift+,", "CmdOrCtrl+Shift+,"],
		["shift+mod+k,mod+j", "CmdOrCtrl+Shift+K"]
	])("%s → %s", (combo, accelerator) => {
		expect(toAccelerator(combo)).toBe(accelerator)
	})

	it("shows nothing for an unassigned or turned-off combo, or a key Electron cannot name", () => {
		expect(toAccelerator("")).toBeUndefined()
		// The marker a user's "Turn off" stores (@filen/shared/keymap UNBOUND_COMBO).
		expect(toAccelerator("none")).toBeUndefined()
		expect(toAccelerator("mod+intlbackslash")).toBeUndefined()
	})

	// macOS fires a menu key equivalent even while a text field has focus.
	it.each(["d", "shift+slash", "delete,backspace", "shift+k"])("shows nothing for %s, which a text field would take", combo => {
		expect(toAccelerator(combo)).toBeUndefined()
	})
})

describe("isMenuAction", () => {
	it("knows the menu's web actions only", () => {
		expect(isMenuAction("app.openSettings")).toBe(true)
		expect(isMenuAction("drive.delete")).toBe(false)
	})
})

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
	return template.flatMap(item => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])])
}

function template(options: Partial<MenuOptions> = {}): MenuItemConstructorOptions[] {
	return menuTemplate({
		shortcuts: {},
		devTools: false,
		transport: "none",
		smoothTransitions: false,
		onAction: vi.fn(),
		onLock: null,
		onClose: vi.fn(),
		onWebsite: vi.fn(),
		...options
	})
}

function find(menu: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined {
	return items(menu).find(item => item.label === label)
}

describe("menuTemplate", () => {
	const onAction = vi.fn()
	const standard = template({ shortcuts: { "app.openSettings": "mod+comma", "app.toggleTheme": "" }, onAction })

	it("has the standard macOS menus, and Controls after View", () => {
		expect(standard.map(item => item.role ?? item.label)).toEqual([
			"appMenu",
			"fileMenu",
			"editMenu",
			"viewMenu",
			"Controls",
			"windowMenu",
			"help"
		])
	})

	it("displays the web's combos without registering them", () => {
		expect(find(standard, "Settings…")).toMatchObject({ accelerator: "CmdOrCtrl+,", registerAccelerator: false })
		expect(find(standard, "Toggle Theme")?.accelerator).toBeUndefined()
	})

	it("sends the action id on click", () => {
		;(find(standard, "Settings…")?.click as () => void)()
		expect(onAction).toHaveBeenCalledWith("app.openSettings")
	})

	it("never registers an accelerator for a web action", () => {
		expect(
			items(standard).filter(item => item.accelerator !== undefined && item.role === undefined && item.registerAccelerator !== false)
		).toEqual([])
	})

	it("offers the dev tools only when asked", () => {
		expect(items(standard).some(item => item.role === "toggleDevTools")).toBe(false)
		expect(items(template({ devTools: true })).some(item => item.role === "toggleDevTools")).toBe(true)
	})

	it("offers Lock only when given a handler, with the page's combo", () => {
		const onLock = vi.fn()

		expect(find(standard, "Lock Filen")).toBeUndefined()

		const lock = find(template({ shortcuts: { "app.lock": "mod+alt+l" }, onLock }), "Lock Filen")

		expect(lock).toMatchObject({ accelerator: "CmdOrCtrl+Alt+L", registerAccelerator: false })
		;(lock?.click as () => void)()
		expect(onLock).toHaveBeenCalled()
	})

	it("closes through main with the page's combo, Cmd+W until the page reports one", () => {
		const onClose = vi.fn()
		const close = find(template({ onClose }), "Close")

		expect(close).toMatchObject({ accelerator: "CmdOrCtrl+W", registerAccelerator: false })
		;(close?.click as () => void)()
		expect(onClose).toHaveBeenCalled()
		expect(find(template({ shortcuts: { "desktop.close": "" } }), "Close")?.accelerator).toBeUndefined()
		expect(find(template({ shortcuts: { "desktop.close": "mod+shift+w" } }), "Close")?.accelerator).toBe("CmdOrCtrl+Shift+W")
	})

	it("zooms the window with the View menu's roles, Cmd+= included", () => {
		const roles = items(standard).filter(item => item.role === "zoomIn" || item.role === "zoomOut" || item.role === "resetZoom")

		expect(roles.map(item => item.role)).toEqual(["resetZoom", "zoomIn", "zoomIn", "zoomOut"])
		expect(roles[2]).toMatchObject({ accelerator: "CommandOrControl+=", visible: false })
	})

	it("disables the Controls menu while nothing is queued", () => {
		const controls = standard.find(item => item.label === "Controls")?.submenu as MenuItemConstructorOptions[]

		expect(controls.map(item => [item.label, item.enabled])).toEqual([
			["Play", false],
			["Next Track", false],
			["Previous Track", false],
			["Shuffle", false],
			["Repeat", false],
			["Smooth Transitions", false]
		])
	})

	it("offers Pause while audio plays and sends the transport actions", () => {
		const onTransport = vi.fn()
		const playing = template({ transport: "playing", shortcuts: { "audio.next": "mod+shift+arrowright" }, onAction: onTransport })

		expect(find(playing, "Pause")?.enabled).toBe(true)
		expect(find(playing, "Next Track")?.accelerator).toBe("CmdOrCtrl+Shift+Right")
		;(find(playing, "Pause")?.click as () => void)()
		expect(onTransport).toHaveBeenCalledWith("audio.playPause")
	})

	it("checks Smooth Transitions while tracks blend", () => {
		expect(find(template({ transport: "playing" }), "Smooth Transitions")).toMatchObject({ type: "checkbox", checked: false })
		expect(find(template({ transport: "playing", smoothTransitions: true }), "Smooth Transitions")).toMatchObject({
			type: "checkbox",
			checked: true,
			enabled: true
		})
		expect(find(template({ smoothTransitions: true }), "Smooth Transitions")).toMatchObject({ checked: true, enabled: false })
	})
})

describe("transportItems", () => {
	it("offers nothing without a queue", () => {
		expect(transportItems("none", true)).toEqual([])
	})

	it("checks Smooth Transitions only, as the shell's state says", () => {
		expect(transportItems("paused", true).filter(item => item.type === "checkbox")).toEqual([
			{ action: "audio.smoothTransitions", label: "Smooth Transitions", type: "checkbox", checked: true }
		])
		expect(transportItems("paused", false).at(-1)?.checked).toBe(false)
	})

	it("plays a paused queue and pauses a playing one", () => {
		expect(transportItems("paused", false).map(item => item.label)).toEqual([
			"Play",
			"Next Track",
			"Previous Track",
			"Shuffle",
			"Repeat",
			"Smooth Transitions"
		])
		expect(transportItems("playing", false)[0]).toEqual({ action: "audio.playPause", label: "Pause" })
	})
})

describe("isDevToolsKey", () => {
	const key = { type: "keyDown", key: "", code: "", control: false, shift: false, alt: false, meta: false }

	it("takes F12 and Ctrl+Shift+I", () => {
		expect(isDevToolsKey({ ...key, key: "F12", code: "F12" })).toBe(true)
		expect(isDevToolsKey({ ...key, key: "I", code: "KeyI", control: true, shift: true })).toBe(true)
	})

	it("leaves other keys and key-ups alone", () => {
		expect(isDevToolsKey({ ...key, type: "keyUp", key: "F12", code: "F12" })).toBe(false)
		expect(isDevToolsKey({ ...key, key: "F12", code: "F12", control: true })).toBe(false)
		expect(isDevToolsKey({ ...key, key: "i", code: "KeyI", control: true })).toBe(false)
		expect(isDevToolsKey({ ...key, key: "I", code: "KeyI", control: true, shift: true, alt: true })).toBe(false)
	})
})

describe("zoomLevelAfter", () => {
	it("steps half a level and resets to 100%", () => {
		expect(zoomLevelAfter(0, "in")).toBe(0.5)
		expect(zoomLevelAfter(0.5, "out")).toBe(0)
		expect(zoomLevelAfter(3, "reset")).toBe(0)
	})

	it("stays within Chromium's zoom range", () => {
		expect(zoomLevelAfter(8.5, "in")).toBe(8.5)
		expect(zoomLevelAfter(-7.5, "out")).toBe(-7.5)
	})
})

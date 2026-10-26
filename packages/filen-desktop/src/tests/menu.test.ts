import type { MenuItemConstructorOptions } from "electron"
import { describe, expect, it, vi } from "vitest"
import { isMenuAction, menuTemplate, toAccelerator } from "../main/menu.ts"

describe("toAccelerator", () => {
	it.each([
		["mod+shift+k", "CmdOrCtrl+Shift+K"],
		["shift+slash", "Shift+/"],
		["d", "D"],
		["ctrl+alt+arrowup", "Ctrl+Alt+Up"],
		["mod+comma", "CmdOrCtrl+,"],
		["f5", "F5"],
		["delete,backspace", "Delete"],
		["Mod+K", "CmdOrCtrl+K"]
	])("%s → %s", (combo, accelerator) => {
		expect(toAccelerator(combo)).toBe(accelerator)
	})

	it("shows nothing for an unassigned combo or a key Electron cannot name", () => {
		expect(toAccelerator("")).toBeUndefined()
		expect(toAccelerator("mod+intlbackslash")).toBeUndefined()
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

describe("menuTemplate", () => {
	const onAction = vi.fn()
	const template = menuTemplate({
		shortcuts: { "app.openSettings": "mod+comma", "app.toggleTheme": "" },
		devTools: false,
		onAction,
		onLock: null,
		onWebsite: vi.fn()
	})

	it("has the standard macOS menus", () => {
		expect(template.map(item => item.role)).toEqual(["appMenu", "fileMenu", "editMenu", "viewMenu", "windowMenu", "help"])
	})

	it("displays the web's combos without registering them", () => {
		const settings = items(template).find(item => item.label === "Settings…")

		expect(settings).toMatchObject({ accelerator: "CmdOrCtrl+,", registerAccelerator: false })
		expect(items(template).find(item => item.label === "Toggle Theme")?.accelerator).toBeUndefined()
	})

	it("sends the action id on click", () => {
		const settings = items(template).find(item => item.label === "Settings…")

		;(settings?.click as () => void)()
		expect(onAction).toHaveBeenCalledWith("app.openSettings")
	})

	it("never registers an accelerator for a web action", () => {
		expect(items(template).filter(item => item.accelerator !== undefined && item.registerAccelerator !== false)).toEqual([])
	})

	it("offers the dev tools only when asked", () => {
		expect(items(template).some(item => item.role === "toggleDevTools")).toBe(false)
		expect(
			items(menuTemplate({ shortcuts: {}, devTools: true, onAction, onLock: null, onWebsite: vi.fn() })).some(
				item => item.role === "toggleDevTools"
			)
		).toBe(true)
	})

	it("offers Lock only when given a handler", () => {
		const onLock = vi.fn()

		expect(items(template).some(item => item.label === "Lock Filen")).toBe(false)

		const lock = items(menuTemplate({ shortcuts: {}, devTools: false, onAction, onLock, onWebsite: vi.fn() })).find(
			item => item.label === "Lock Filen"
		)

		;(lock?.click as () => void)()
		expect(onLock).toHaveBeenCalled()
	})
})

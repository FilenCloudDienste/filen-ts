import type { MenuItemConstructorOptions } from "electron"
import type { DesktopMenuAction } from "@filen/shared/desktop"

export type MenuShortcuts = Partial<Record<DesktopMenuAction, string>>

const ACTION_LABELS: Record<DesktopMenuAction, string> = {
	"app.openSettings": "Settings…",
	"app.openShortcuts": "Keyboard Shortcuts",
	"app.toggleTheme": "Toggle Theme",
	"app.toggleAssistant": "Toggle Assistant",
	"app.openTransfers": "Transfers"
}

export const MENU_ACTIONS = new Set(Object.keys(ACTION_LABELS)) as ReadonlySet<DesktopMenuAction>

export function isMenuAction(value: string): value is DesktopMenuAction {
	return (MENU_ACTIONS as ReadonlySet<string>).has(value)
}

// Web keymap tokens (react-hotkeys-hook's vocabulary, lowercased) that differ from Electron's accelerator names.
const KEY_NAMES: Record<string, string> = {
	mod: "CmdOrCtrl",
	meta: "Command",
	ctrl: "Ctrl",
	control: "Ctrl",
	alt: "Alt",
	option: "Alt",
	shift: "Shift",
	slash: "/",
	backslash: "\\",
	comma: ",",
	period: ".",
	minus: "-",
	equal: "=",
	semicolon: ";",
	quote: "'",
	backquote: "`",
	bracketleft: "[",
	bracketright: "]",
	escape: "Esc",
	esc: "Esc",
	enter: "Enter",
	return: "Enter",
	space: "Space",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
	arrowup: "Up",
	up: "Up",
	arrowdown: "Down",
	down: "Down",
	arrowleft: "Left",
	left: "Left",
	arrowright: "Right",
	right: "Right"
}

// The display accelerator for a web combo: its first alternative, or none when it is unassigned or uses a key Electron
// cannot name. Display only; the menu never registers it.
export function toAccelerator(combo: string): string | undefined {
	const keys = (combo.split(",")[0] ?? "")
		.toLowerCase()
		.split("+")
		.map(key => key.trim())
		.filter(key => key.length > 0)

	if (keys.length === 0) {
		return undefined
	}

	const names: string[] = []

	for (const key of keys) {
		const name = KEY_NAMES[key] ?? (/^([a-z0-9]|f([1-9]|1[0-9]|2[0-4]))$/.test(key) ? key.toUpperCase() : undefined)

		if (name === undefined) {
			return undefined
		}

		names.push(name)
	}

	return names.join("+")
}

export interface MenuOptions {
	shortcuts: MenuShortcuts
	devTools: boolean
	onAction: (action: DesktopMenuAction) => void
	onWebsite: () => void
}

// The macOS application menu. Edit and window management use roles; web actions show the web's combo without
// registering it, so the page's own key handling stays the only dispatcher.
export function menuTemplate({ shortcuts, devTools, onAction, onWebsite }: MenuOptions): MenuItemConstructorOptions[] {
	const action = (id: DesktopMenuAction): MenuItemConstructorOptions => {
		const accelerator = toAccelerator(shortcuts[id] ?? "")

		return {
			label: ACTION_LABELS[id],
			...(accelerator === undefined ? {} : { accelerator, registerAccelerator: false }),
			click: () => {
				onAction(id)
			}
		}
	}

	return [
		{
			role: "appMenu",
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				action("app.openSettings"),
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" }
			]
		},
		{ role: "fileMenu", submenu: [{ role: "close" }] },
		{ role: "editMenu" },
		{
			role: "viewMenu",
			submenu: [
				action("app.openTransfers"),
				{ type: "separator" },
				action("app.toggleTheme"),
				action("app.toggleAssistant"),
				{ type: "separator" },
				...(devTools ? ([{ role: "toggleDevTools" }, { type: "separator" }] as const) : []),
				{ role: "togglefullscreen" }
			]
		},
		{ role: "windowMenu" },
		{
			role: "help",
			submenu: [action("app.openShortcuts"), { type: "separator" }, { label: "Filen Website", click: onWebsite }]
		}
	]
}

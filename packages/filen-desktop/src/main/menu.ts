import type { MenuItemConstructorOptions } from "electron"
import type { DesktopMenuAction } from "@filen/shared/desktop"
import type { DesktopShellStringKey } from "@filen/shared/desktopShellStrings"
import { canonicalKey, chordModifiers, parseCombo, usCharacterOf, type ModifierToken } from "@filen/shared/keymap"
import { shellText } from "./shellStrings.ts"

export type MenuShortcuts = Partial<Record<DesktopMenuAction, string>>

const ACTION_LABELS: Record<DesktopMenuAction, DesktopShellStringKey> = {
	"app.openSettings": "shellMenuSettings",
	"app.openShortcuts": "shellMenuShortcuts",
	"app.toggleTheme": "shellMenuToggleTheme",
	"app.toggleAssistant": "shellMenuToggleAssistant",
	"app.openTransfers": "shellMenuTransfers"
}

export const MENU_ACTIONS = new Set(Object.keys(ACTION_LABELS)) as ReadonlySet<DesktopMenuAction>

export function isMenuAction(value: string): value is DesktopMenuAction {
	return (MENU_ACTIONS as ReadonlySet<string>).has(value)
}

// Electron's names for a chord's modifiers and for the keys that are no character (@filen/shared/keymap's tokens).
const MODIFIER_NAMES: Record<ModifierToken, string> = {
	mod: "CmdOrCtrl",
	meta: "Command",
	ctrl: "Ctrl",
	alt: "Alt",
	shift: "Shift"
}

const KEY_NAMES: Record<string, string> = {
	escape: "Esc",
	enter: "Enter",
	space: "Space",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	insert: "Insert",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
	add: "numadd",
	subtract: "numsub",
	multiply: "nummult",
	divide: "numdiv",
	decimal: "numdec"
}

// A combo's Cmd/Ctrl/Alt modifiers, the keys that keep it from typing or editing text.
const COMMAND_MODIFIERS = new Set<ModifierToken>(["mod", "meta", "ctrl", "alt"])

// Electron's name for a key: its own name, a function key's, or the US character a writing-system key types (the
// renderer has already renamed keys for the user's layout, keymap's comboForLayout). A key no US character names
// (the ISO key) has none.
function keyName(key: string): string | undefined {
	const named = KEY_NAMES[key]

	if (named !== undefined) {
		return named
	}

	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) {
		return key.toUpperCase()
	}

	const character = usCharacterOf(key)

	return character !== undefined && canonicalKey(character) === key ? character.toUpperCase() : undefined
}

// The menu accelerator for a web combo: its first alternative, or none when it is unassigned or uses a key Electron
// cannot name. macOS runs a menu's key equivalents itself whatever has focus (registerAccelerator only applies on
// Windows and Linux), so a combo that a text field would take as typing, "d" or Shift+/ or Delete, gets none and
// stays the page's alone; a function key needs no modifier.
export function toAccelerator(combo: string): string | undefined {
	const [chord] = parseCombo(combo)
	const key = chord === undefined ? undefined : keyName(chord.key)

	if (chord === undefined || key === undefined) {
		return undefined
	}

	const modifiers = chordModifiers(chord)

	if (!/^F\d+$/.test(key) && !modifiers.some(modifier => COMMAND_MODIFIERS.has(modifier))) {
		return undefined
	}

	return [...modifiers.map(modifier => MODIFIER_NAMES[modifier]), key].join("+")
}

export interface MenuOptions {
	shortcuts: MenuShortcuts
	devTools: boolean
	onAction: (action: DesktopMenuAction) => void
	// Offered only while a PIN is set and the app is unlocked.
	onLock: (() => void) | null
	onWebsite: () => void
}

// The macOS application menu. Edit and window management use roles; a web action's combo runs from the menu as
// macOS dispatches key equivalents, through the same handler the page's keys run.
export function menuTemplate({ shortcuts, devTools, onAction, onLock, onWebsite }: MenuOptions): MenuItemConstructorOptions[] {
	const action = (id: DesktopMenuAction): MenuItemConstructorOptions => {
		const accelerator = toAccelerator(shortcuts[id] ?? "")

		return {
			label: shellText(ACTION_LABELS[id]),
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
				...(onLock === null ? [] : ([{ label: shellText("shellLock"), click: onLock }] as const)),
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
			submenu: [action("app.openShortcuts"), { type: "separator" }, { label: shellText("shellWebsite"), click: onWebsite }]
		}
	]
}

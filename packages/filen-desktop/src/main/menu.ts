import type { Input, MenuItemConstructorOptions } from "electron"
import type { DesktopMediaTransport, DesktopMenuAction, DesktopZoomStep } from "@filen/shared/desktop"
import type { DesktopShellStringKey } from "@filen/shared/desktopShellStrings"
import { canonicalKey, chordModifiers, parseCombo, usCharacterOf, type ModifierToken } from "@filen/shared/keymap"
import { shellText } from "./shellStrings.ts"

export type MenuShortcuts = Partial<Record<DesktopMenuAction, string>>

const ACTION_LABELS: Record<DesktopMenuAction, DesktopShellStringKey> = {
	"app.openSettings": "shellMenuSettings",
	"app.openShortcuts": "shellMenuShortcuts",
	"app.toggleTheme": "shellMenuToggleTheme",
	"app.toggleAssistant": "shellMenuToggleAssistant",
	"app.openTransfers": "shellMenuTransfers",
	"app.lock": "shellLock",
	"desktop.close": "shellMenuClose",
	"audio.playPause": "shellPlay",
	"audio.next": "shellNextTrack",
	"audio.previous": "shellPreviousTrack",
	"audio.shuffle": "shellShuffle",
	"audio.loop": "shellRepeat",
	"audio.smoothTransitions": "shellSmoothTransitions"
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

// Close's combo until the page reports one (its default), so Cmd+W closes the window before the page has loaded too.
const CLOSE_DEFAULT = "mod+w"

export const TRANSPORT_ACTIONS: ReadonlySet<DesktopMenuAction> = new Set([
	"audio.playPause",
	"audio.next",
	"audio.previous",
	"audio.shuffle",
	"audio.loop",
	"audio.smoothTransitions"
])

// The audio player's transport while something is queued: play or pause, the track skips, then shuffle, repeat and
// smooth transitions.
// The Controls menu and the tray offer these.
export function transportItems(transport: DesktopMediaTransport): { action: DesktopMenuAction; label: string }[] {
	if (transport === "none") {
		return []
	}

	return [
		{ action: "audio.playPause", label: shellText(transport === "playing" ? "shellPause" : "shellPlay") },
		{ action: "audio.next", label: shellText("shellNextTrack") },
		{ action: "audio.previous", label: shellText("shellPreviousTrack") },
		{ action: "audio.shuffle", label: shellText("shellShuffle") },
		{ action: "audio.loop", label: shellText("shellRepeat") },
		{ action: "audio.smoothTransitions", label: shellText("shellSmoothTransitions") }
	]
}

export interface MenuOptions {
	shortcuts: MenuShortcuts
	devTools: boolean
	transport: DesktopMediaTransport
	onAction: (action: DesktopMenuAction) => void
	// Offered only while a PIN is set and the app is unlocked.
	onLock: (() => void) | null
	// File > Close: the page closes its open dialog first, the window otherwise.
	onClose: () => void
	onWebsite: () => void
}

type MenuKeys = Pick<MenuItemConstructorOptions, "accelerator" | "registerAccelerator">

function menuKeys(combo: string | undefined): MenuKeys {
	const accelerator = toAccelerator(combo ?? "")

	return accelerator === undefined ? {} : { accelerator, registerAccelerator: false }
}

// The macOS application menu. Edit and window management use roles; a web action's combo runs from the menu as
// macOS dispatches key equivalents, through the same handler the page's keys run. Lock and Close are main's own, with
// the combos the page reports, so they work while the page is locked or still loading.
export function menuTemplate({
	shortcuts,
	devTools,
	transport,
	onAction,
	onLock,
	onClose,
	onWebsite
}: MenuOptions): MenuItemConstructorOptions[] {
	const action = (id: DesktopMenuAction, label: string = shellText(ACTION_LABELS[id])): MenuItemConstructorOptions => ({
		label,
		...menuKeys(shortcuts[id]),
		click: () => {
			onAction(id)
		}
	})
	const controls = transportItems(transport)

	return [
		{
			role: "appMenu",
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				action("app.openSettings"),
				...(onLock === null ? [] : [{ label: shellText("shellLock"), ...menuKeys(shortcuts["app.lock"]), click: onLock }]),
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
		{
			role: "fileMenu",
			submenu: [{ label: shellText("shellMenuClose"), ...menuKeys(shortcuts["desktop.close"] ?? CLOSE_DEFAULT), click: onClose }]
		},
		{ role: "editMenu" },
		{
			role: "viewMenu",
			submenu: [
				action("app.openTransfers"),
				{ type: "separator" },
				action("app.toggleTheme"),
				action("app.toggleAssistant"),
				{ type: "separator" },
				// The page's document viewers take these keys first (a PDF zooms itself); the window zooms otherwise. Zoom
				// In's own key is Cmd+Plus, which a US keyboard types with Shift: the hidden twin takes Cmd+=.
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomIn", accelerator: "CommandOrControl+=", visible: false },
				{ role: "zoomOut" },
				{ type: "separator" },
				...(devTools ? ([{ role: "toggleDevTools" }, { type: "separator" }] as const) : []),
				{ role: "togglefullscreen" }
			]
		},
		// Disabled while nothing is queued; the first item says Pause while audio plays.
		{
			label: shellText("shellMenuControls"),
			submenu: (controls.length === 0 ? transportItems("paused") : controls).map(item => ({
				...action(item.action, item.label),
				enabled: controls.length > 0
			}))
		},
		{ role: "windowMenu" },
		{
			role: "help",
			submenu: [action("app.openShortcuts"), { type: "separator" }, { label: shellText("shellWebsite"), click: onWebsite }]
		}
	]
}

// The window's development keys off macOS (whose View menu has the item): F12 and Ctrl+Shift+I.
export function isDevToolsKey(input: Pick<Input, "type" | "key" | "code" | "control" | "shift" | "alt" | "meta">): boolean {
	if (input.type !== "keyDown" || input.alt || input.meta) {
		return false
	}

	return (input.key === "F12" && !input.control && !input.shift) || (input.control && input.shift && input.code === "KeyI")
}

// The zoom level a window key steps to: half a level a step, as the View menu's roles step, within Chromium's limits
// (25% to 500%).
export function zoomLevelAfter(level: number, step: DesktopZoomStep): number {
	if (step === "reset") {
		return 0
	}

	return Math.min(8.5, Math.max(-7.5, level + (step === "in" ? 0.5 : -0.5)))
}

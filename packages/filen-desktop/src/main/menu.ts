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

export type TransportItem = { action: DesktopMenuAction; label: string } & Pick<MenuItemConstructorOptions, "type" | "checked">

// The audio player's transport while something is queued: play or pause, the track skips, then shuffle, repeat and
// smooth transitions, checked while tracks blend.
// The Controls menu and the tray offer these.
export function transportItems(transport: DesktopMediaTransport, smoothTransitions: boolean): TransportItem[] {
	if (transport === "none") {
		return []
	}

	return [
		{ action: "audio.playPause", label: shellText(transport === "playing" ? "shellPause" : "shellPlay") },
		{ action: "audio.next", label: shellText("shellNextTrack") },
		{ action: "audio.previous", label: shellText("shellPreviousTrack") },
		{ action: "audio.shuffle", label: shellText("shellShuffle") },
		{ action: "audio.loop", label: shellText("shellRepeat") },
		{
			action: "audio.smoothTransitions",
			label: shellText("shellSmoothTransitions"),
			type: "checkbox",
			checked: smoothTransitions
		}
	]
}

export interface MenuActionDelivery {
	// Sent to the page now.
	send: DesktopMenuAction | null
	pending: readonly DesktopMenuAction[]
}

// A menu click reaches a page that listens; otherwise it waits, once, for the page to report it listens. The lock screen
// takes no web actions: the click is dropped and only brings the window up.
export function deliverMenuAction(
	action: DesktopMenuAction,
	pending: readonly DesktopMenuAction[],
	{ locked, listening }: { locked: boolean; listening: boolean }
): MenuActionDelivery {
	if (locked) {
		return { send: null, pending }
	}

	if (listening) {
		return { send: action, pending }
	}

	return { send: null, pending: pending.includes(action) ? pending : [...pending, action] }
}

// The page now listens: what waited is sent once, in click order.
export function flushMenuActions(pending: readonly DesktopMenuAction[]): {
	send: readonly DesktopMenuAction[]
	pending: readonly DesktopMenuAction[]
} {
	return { send: pending, pending: [] }
}

export interface MenuOptions {
	shortcuts: MenuShortcuts
	devTools: boolean
	transport: DesktopMediaTransport
	// Whether tracks blend now: Smooth Transitions' check.
	smoothTransitions: boolean
	// The user hid the assistant: Toggle Assistant is left out.
	assistantHidden: boolean
	onAction: (action: DesktopMenuAction) => void
	// Offered only while a PIN is set and the app is unlocked.
	onLock: (() => void) | null
	// File > Close: the page closes its open dialog first, the window otherwise.
	onClose: () => void
	onWebsite: () => void
}

// A role item labelled in the UI language: Electron's own role labels are English. The role keeps its accelerator,
// enablement and what macOS adds to it.
function role(name: NonNullable<MenuItemConstructorOptions["role"]>, key: DesktopShellStringKey): MenuItemConstructorOptions {
	return { role: name, label: shellText(key) }
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
	smoothTransitions,
	assistantHidden,
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
	const controls = transportItems(transport, smoothTransitions)

	return [
		{
			role: "appMenu",
			submenu: [
				role("about", "shellMenuAbout"),
				{ type: "separator" },
				action("app.openSettings"),
				...(onLock === null ? [] : [{ label: shellText("shellLock"), ...menuKeys(shortcuts["app.lock"]), click: onLock }]),
				{ type: "separator" },
				role("services", "shellMenuServices"),
				{ type: "separator" },
				role("hide", "shellMenuHide"),
				role("hideOthers", "shellMenuHideOthers"),
				role("unhide", "shellMenuShowAll"),
				{ type: "separator" },
				role("quit", "shellQuit")
			]
		},
		{
			...role("fileMenu", "shellMenuFile"),
			submenu: [{ label: shellText("shellMenuClose"), ...menuKeys(shortcuts["desktop.close"] ?? CLOSE_DEFAULT), click: onClose }]
		},
		// Electron's own macOS Edit menu, item by item so each is labelled; the role keeps the system's dictation and
		// emoji items.
		{
			...role("editMenu", "shellMenuEdit"),
			submenu: [
				role("undo", "shellMenuUndo"),
				role("redo", "shellMenuRedo"),
				{ type: "separator" },
				role("cut", "shellMenuCut"),
				role("copy", "shellMenuCopy"),
				role("paste", "shellMenuPaste"),
				role("pasteAndMatchStyle", "shellMenuPasteAndMatchStyle"),
				role("delete", "shellMenuDelete"),
				role("selectAll", "shellMenuSelectAll"),
				{ type: "separator" },
				{
					label: shellText("shellMenuSubstitutions"),
					submenu: [
						role("showSubstitutions", "shellMenuShowSubstitutions"),
						{ type: "separator" },
						role("toggleSmartQuotes", "shellMenuSmartQuotes"),
						role("toggleSmartDashes", "shellMenuSmartDashes"),
						role("toggleTextReplacement", "shellMenuTextReplacement")
					]
				},
				{
					label: shellText("shellMenuSpeech"),
					submenu: [role("startSpeaking", "shellMenuStartSpeaking"), role("stopSpeaking", "shellMenuStopSpeaking")]
				}
			]
		},
		{
			...role("viewMenu", "shellMenuView"),
			submenu: [
				action("app.openTransfers"),
				{ type: "separator" },
				action("app.toggleTheme"),
				...(assistantHidden ? [] : [action("app.toggleAssistant")]),
				{ type: "separator" },
				// The page's document viewers take these keys first (a PDF zooms itself); the window zooms otherwise. Zoom
				// In's own key is Cmd+Plus, which a US keyboard types with Shift: the hidden twin takes Cmd+=.
				role("resetZoom", "shellMenuActualSize"),
				role("zoomIn", "shellMenuZoomIn"),
				{ ...role("zoomIn", "shellMenuZoomIn"), accelerator: "CommandOrControl+=", visible: false },
				role("zoomOut", "shellMenuZoomOut"),
				{ type: "separator" },
				// Development builds only: left in English.
				...(devTools ? ([{ role: "toggleDevTools" }, { type: "separator" }] as const) : []),
				role("togglefullscreen", "shellMenuToggleFullScreen")
			]
		},
		// Disabled while nothing is queued; the first item says Pause while audio plays.
		{
			label: shellText("shellMenuControls"),
			submenu: (controls.length === 0 ? transportItems("paused", smoothTransitions) : controls).map(
				({ action: id, label, ...item }) => ({
					...action(id, label),
					...item,
					enabled: controls.length > 0
				})
			)
		},
		// Electron's own macOS Window menu; the role keeps the list of open windows.
		{
			...role("windowMenu", "shellMenuWindow"),
			submenu: [
				role("minimize", "shellMenuMinimize"),
				role("zoom", "shellMenuZoom"),
				{ type: "separator" },
				role("front", "shellMenuBringAllToFront")
			]
		},
		{
			...role("help", "shellMenuHelp"),
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

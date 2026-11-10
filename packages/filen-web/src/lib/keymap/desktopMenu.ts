import { useEffect } from "react"
import type { HotkeyCallback } from "react-hotkeys-hook"
import type { DesktopMenuAction } from "@filen/shared/desktop"
import { comboForLayout, matchesCombo } from "@filen/shared/keymap"
import { desktopBridge } from "@/lib/desktop"
import { keyboardLayout, subscribeKeyboardLayout } from "@/lib/keymap/layout"
import { comboFor, subscribeOverrides } from "@/lib/keymap/registry"

// The macOS desktop menu (D18) offers a few keymap actions. Main shows each with the combo in effect here and
// sends the id back on click; the action then runs the same handler its keys run, so this page stays the only
// key dispatcher. Exhaustive over the shell's union, so a menu action without a keymap entry fails to compile.
const MENU_ACTIONS = Object.keys({
	"app.openSettings": true,
	"app.openShortcuts": true,
	"app.toggleTheme": true,
	"app.toggleAssistant": true,
	"app.openTransfers": true
} satisfies Record<DesktopMenuAction, true>) as DesktopMenuAction[]

// A click can arrive before the component owning its handler mounts (the menu opened the window, the shell
// is still booting); it runs once the handler registers, unless that takes longer than this.
const PENDING_TTL_MS = 15_000

const bridge = desktopBridge()
const handlers = new Map<string, () => void>()
let pending: { action: DesktopMenuAction; at: number } | null = null
let subscribed = false

// Whether this app's menu bar offers an action (the macOS desktop app only): what useMenuAction returns, and what the
// shortcuts list says on the action's row.
export function inAppMenu(id: string): boolean {
	return bridge?.platform === "darwin" && isMenuAction(id)
}

function isMenuAction(id: string): id is DesktopMenuAction {
	return (MENU_ACTIONS as string[]).includes(id)
}

// macOS matches a menu's key equivalents by character, the page matches keys by physical key: each combo goes to main
// renamed for the user's layout, so the menu fires on the key the page does (a German Z is the page's "y").
function pushShortcuts(): void {
	const layout = keyboardLayout()

	bridge?.app.setMenuShortcuts(Object.fromEntries(MENU_ACTIONS.map(action => [action, comboForLayout(comboFor(action), layout)])))
}

function dispatch(action: DesktopMenuAction): void {
	const handler = handlers.get(action)

	if (handler === undefined) {
		pending = { action, at: Date.now() }

		return
	}

	handler()
}

// macOS gives the menu only a key the page left unhandled. The page runs a menu action's keys once, and cancels
// their default so the menu does not run it again (useAction); it never runs them on autorepeat, so neither may the
// menu. In a text field the page leaves them alone and the menu runs them, once.
export function cancelMenuRepeat(event: KeyboardEvent): void {
	if (event.repeat && !event.defaultPrevented && MENU_ACTIONS.some(action => matchesCombo(event, comboFor(action), true))) {
		event.preventDefault()
	}
}

// Subscribing is what tells main the page takes menu actions, so it waits for the first handler.
function subscribe(): void {
	if (subscribed || bridge === undefined) {
		return
	}

	subscribed = true
	bridge.app.onMenuAction(dispatch)
	pushShortcuts()
	subscribeOverrides(pushShortcuts)
	subscribeKeyboardLayout(pushShortcuts)
	document.addEventListener("keydown", cancelMenuRepeat)
}

function registerMenuHandler(action: DesktopMenuAction, handler: () => void): () => void {
	handlers.set(action, handler)
	subscribe()

	if (pending?.action === action) {
		const { at } = pending

		pending = null

		if (Date.now() - at <= PENDING_TTL_MS) {
			handler()
		}
	}

	return () => {
		if (handlers.get(action) === handler) {
			handlers.delete(action)
		}
	}
}

// A click passes the guard the action's keys pass (an open dialog or menu), so the two never disagree.
function useMenuActionOnMac(id: string, handler: HotkeyCallback, guard?: (event: KeyboardEvent) => boolean): boolean {
	const owned = inAppMenu(id)

	useEffect(() => {
		if (!isMenuAction(id)) {
			return
		}

		return registerMenuHandler(id, () => {
			const event = new KeyboardEvent("keydown")

			if (guard?.(event) !== true) {
				handler(event, { hotkey: comboFor(id) })
			}
		})
	}, [id, handler, guard])

	return owned
}

function noMenu(): boolean {
	return false
}

// Whether the menu offers the action, after wiring its clicks to `handler`. Only the macOS shell has a menu; everywhere
// else this is a no-op hook. The choice is fixed for the page's life, so every render calls the same hooks.
export const useMenuAction: (id: string, handler: HotkeyCallback, guard?: (event: KeyboardEvent) => boolean) => boolean =
	bridge?.platform === "darwin" ? useMenuActionOnMac : noMenu

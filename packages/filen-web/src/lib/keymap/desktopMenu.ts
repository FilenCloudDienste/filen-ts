import { useEffect } from "react"
import type { HotkeyCallback } from "react-hotkeys-hook"
import type { DesktopMenuAction } from "@filen/shared/desktop"
import { desktopBridge } from "@/lib/desktop"
import { comboFor, subscribeOverrides } from "@/lib/keymap/registry"
import { noop } from "@/lib/utils"

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

function isMenuAction(id: string): id is DesktopMenuAction {
	return (MENU_ACTIONS as string[]).includes(id)
}

function pushShortcuts(): void {
	bridge?.app.setMenuShortcuts(Object.fromEntries(MENU_ACTIONS.map(action => [action, comboFor(action)])))
}

function dispatch(action: DesktopMenuAction): void {
	const handler = handlers.get(action)

	if (handler === undefined) {
		pending = { action, at: Date.now() }

		return
	}

	handler()
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

function useMenuActionOnMac(id: string, handler: HotkeyCallback): void {
	useEffect(() => {
		if (!isMenuAction(id)) {
			return
		}

		return registerMenuHandler(id, () => {
			handler(new KeyboardEvent("keydown"), { hotkey: comboFor(id) })
		})
	}, [id, handler])
}

// Only the macOS shell has a menu; everywhere else this is a no-op hook. The choice is fixed for the page's
// life, so every render calls the same hooks.
export const useMenuAction: (id: string, handler: HotkeyCallback) => void = bridge?.platform === "darwin" ? useMenuActionOnMac : noop

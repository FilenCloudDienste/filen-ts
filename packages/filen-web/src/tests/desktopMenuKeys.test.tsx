// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

// macOS hands the menu every key the page leaves unhandled: a menu action the page ran must not run again from its
// menu accelerator, nor from autorepeat.

const desktop = vi.hoisted(() => {
	const state = { listener: null as ((action: string) => void) | null }
	const app = {
		setMenuShortcuts: vi.fn(),
		onMenuAction: vi.fn((listener: (action: string) => void) => {
			state.listener = listener

			return () => undefined
		})
	}

	return { state, bridge: { platform: "darwin", app } }
})

const THEME_COMBO = "mod+shift+d"

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => desktop.bridge }))
vi.mock("@/lib/keymap/registry", () => ({
	isRecordingCombo: () => false,
	useComboFor: (id: string) => (id === "app.toggleTheme" ? THEME_COMBO : ""),
	comboFor: (id: string) => (id === "app.toggleTheme" ? THEME_COMBO : ""),
	subscribeBindings: () => () => undefined
}))
vi.mock("@/lib/keymap/layout", () => ({ keyboardLayout: () => null, subscribeKeyboardLayout: () => () => undefined }))

// A Mac, where Mod is Cmd for the page's matcher as for the menu's.
Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", configurable: true })

const { OUTSIDE_OVERLAYS, useAction } = await import("@/lib/keymap/useAction")

function press(init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

	document.body.dispatchEvent(event)

	return event
}

const THEME_KEY = { key: "d", code: "KeyD", metaKey: true, shiftKey: true }

afterEach(() => {
	document.body.replaceChildren()
})

describe("menu actions on the macOS desktop", () => {
	it("cancel the key the page runs, so the menu does not run it again", () => {
		const handler = vi.fn()

		renderHook(() => useAction("app.toggleTheme", handler, OUTSIDE_OVERLAYS))

		expect(press(THEME_KEY).defaultPrevented).toBe(true)
		expect(handler).toHaveBeenCalledOnce()
	})

	it("cancel an autorepeat of the menu's key, which runs nothing", () => {
		const handler = vi.fn()

		renderHook(() => useAction("app.toggleTheme", handler, OUTSIDE_OVERLAYS))

		expect(press({ ...THEME_KEY, repeat: true }).defaultPrevented).toBe(true)
		expect(handler).not.toHaveBeenCalled()
	})

	it("cancel only the repeats of a menu action's key", () => {
		renderHook(() => useAction("app.toggleTheme", vi.fn(), OUTSIDE_OVERLAYS))

		expect(press({ ...THEME_KEY, repeat: true }).defaultPrevented).toBe(true)
		expect(press({ key: "e", code: "KeyE", metaKey: true, shiftKey: true, repeat: true }).defaultPrevented).toBe(false)
	})

	// A click passes the guard the keys pass: under a dialog neither runs the action.
	it("run a menu click behind the action's own guard", () => {
		const handler = vi.fn()

		renderHook(() => useAction("app.toggleTheme", handler, OUTSIDE_OVERLAYS))

		desktop.state.listener?.("app.toggleTheme")
		expect(handler).toHaveBeenCalledOnce()

		const dialog = document.createElement("div")

		dialog.setAttribute("role", "dialog")
		dialog.setAttribute("data-open", "")
		document.body.append(dialog)

		desktop.state.listener?.("app.toggleTheme")
		expect(handler).toHaveBeenCalledOnce()
	})
})

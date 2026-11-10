// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { createElement } from "react"

// The Windows and Linux desktop app, whose window keys are the page's (no menu bar).
const desktop = vi.hoisted(() => {
	const state = { listener: null as ((action: string) => void) | null, shortcutsPushed: false }
	const bridge = {
		platform: "linux",
		app: {
			quit: vi.fn(),
			setMenuShortcuts: () => {
				state.shortcutsPushed = true
			},
			onMenuAction: vi.fn((listener: (action: string) => void) => {
				state.listener = listener

				return () => undefined
			})
		},
		window: { zoom: vi.fn(), toggleFullScreen: vi.fn(), close: vi.fn() },
		lock: { lock: vi.fn() }
	}

	return { state, bridge }
})

const history = vi.hoisted(() => ({ back: vi.fn(), forward: vi.fn(), canGoBack: () => true }))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => desktop.bridge }))
vi.mock("@/lib/storage/adapter", () => ({ kvGetJson: () => Promise.resolve(null), kvSetJson: () => Promise.resolve() }))
vi.mock("@/lib/storage/kvBestEffort", () => ({ kvLoadOnce: () => () => Promise.resolve(), kvSetJsonQuiet: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ history }) }))

const { registerAllActions } = await import("@/lib/keymap/actions")
const { keymapOverridesLoaded, setUserCombo, clearUserCombo, unbindAction } = await import("@/lib/keymap/registry")
const { DesktopWindowKeys } = await import("@/features/desktop/components/desktopWindowKeys")

registerAllActions()

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

	target.dispatchEvent(event)

	return event
}

function openDialog(): HTMLElement {
	const dialog = document.createElement("div")

	dialog.setAttribute("role", "dialog")
	dialog.setAttribute("data-open", "")
	document.body.append(dialog)

	return dialog
}

// Ctrl with the key a German keyboard types "+" with: BracketRight.
const GERMAN_PLUS = { key: "+", code: "BracketRight", ctrlKey: true }

beforeEach(async () => {
	render(createElement(DesktopWindowKeys))
	await keymapOverridesLoaded()
})

afterEach(async () => {
	vi.clearAllMocks()
	document.body.replaceChildren()
	await act(() => clearUserCombo("desktop.zoomIn"))
})

describe("the desktop app's window keys", () => {
	it("zooms on the zoom characters wherever the layout puts them", () => {
		expect(press(GERMAN_PLUS).defaultPrevented).toBe(true)
		press({ key: "-", code: "Slash", ctrlKey: true })
		press({ key: "0", code: "Digit0", ctrlKey: true })

		expect(desktop.bridge.window.zoom.mock.calls).toEqual([["in"], ["out"], ["reset"]])
	})

	it("leaves a zoom key a document viewer took", () => {
		const viewer = document.createElement("div")

		document.body.append(viewer)
		viewer.addEventListener("keydown", event => {
			event.preventDefault()
		})
		press(GERMAN_PLUS, viewer)

		expect(desktop.bridge.window.zoom).not.toHaveBeenCalled()
	})

	it("zooms on exactly the keys a user bound instead, and not at all once turned off", async () => {
		await act(() => setUserCombo("desktop.zoomIn", "mod+shift+u"))
		press(GERMAN_PLUS)
		expect(desktop.bridge.window.zoom).not.toHaveBeenCalled()

		press({ key: "U", code: "KeyU", ctrlKey: true, shiftKey: true })
		expect(desktop.bridge.window.zoom).toHaveBeenCalledWith("in")

		vi.clearAllMocks()
		await act(() => unbindAction("desktop.zoomIn"))
		press(GERMAN_PLUS)
		press({ key: "U", code: "KeyU", ctrlKey: true, shiftKey: true })
		expect(desktop.bridge.window.zoom).not.toHaveBeenCalled()
	})

	it("closes the open dialog as Escape would, and the window when none is open", () => {
		const dialog = openDialog()
		const escapes: string[] = []

		document.addEventListener("keydown", event => {
			if (event.key === "Escape") {
				escapes.push(event.code)
			}
		})
		press({ key: "w", code: "KeyW", ctrlKey: true })
		expect(escapes).toEqual(["Escape"])
		expect(desktop.bridge.window.close).not.toHaveBeenCalled()

		dialog.remove()
		expect(press({ key: "w", code: "KeyW", ctrlKey: true }).defaultPrevented).toBe(true)
		expect(desktop.bridge.window.close).toHaveBeenCalledOnce()
	})

	it("closes from the menu path too", () => {
		act(() => {
			desktop.state.listener?.("desktop.close")
		})

		expect(desktop.bridge.window.close).toHaveBeenCalledOnce()
	})

	it("works in a text field: close, quit, full screen and lock", () => {
		const field = document.createElement("input")

		document.body.append(field)
		press({ key: "w", code: "KeyW", ctrlKey: true }, field)
		press({ key: "q", code: "KeyQ", ctrlKey: true }, field)
		press({ key: "F11", code: "F11" }, field)
		press({ key: "l", code: "KeyL", ctrlKey: true, altKey: true }, field)

		expect(desktop.bridge.window.close).toHaveBeenCalledOnce()
		expect(desktop.bridge.app.quit).toHaveBeenCalledOnce()
		expect(desktop.bridge.window.toggleFullScreen).toHaveBeenCalledOnce()
		expect(desktop.bridge.lock.lock).toHaveBeenCalledOnce()
	})

	it("goes back and forward, but never from under a dialog", () => {
		press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true })
		press({ key: "ArrowRight", code: "ArrowRight", altKey: true })
		expect(history.back).toHaveBeenCalledOnce()
		expect(history.forward).toHaveBeenCalledOnce()

		openDialog()
		press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true })
		expect(history.back).toHaveBeenCalledOnce()
	})

	it("runs the tray's transport through the page's handlers off a Mac too", () => {
		expect(desktop.state.listener).not.toBeNull()
		// Only a Mac's menu bar shows combos.
		expect(desktop.state.shortcutsPushed).toBe(false)
	})
})

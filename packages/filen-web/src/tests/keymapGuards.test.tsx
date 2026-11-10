// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

// One combo per action, as the registry resolves them, without loading the registry's storage.
vi.mock("@/lib/keymap/registry", () => ({
	isRecordingCombo: () => false,
	useComboFor: (id: string) => (id === "drive.newDirectory" ? "n" : id === "drive.selectAll" ? "mod+a" : "escape"),
	comboFor: () => "",
	subscribeBindings: () => () => undefined
}))

const { OUTSIDE_OVERLAYS, useAction, shouldIgnoreEvent } = await import("@/lib/keymap/useAction")
const { isOverlayOpenBesides } = await import("@/lib/keymap/dialogGuard")
const { assistantKeyIgnored, ASSISTANT_PANEL_ID } = await import("@/features/assistant/components/assistantFocus")
const { transportKeyIgnored } = await import("@/features/audio/lib/transportKeys")
const { MediaSessionOwners } = await import("@/lib/media/mediaSessionOwner")
const { toggledTheme } = await import("@/providers/themeProvider")
const { settingsRoute } = await import("@/features/shell/lib/railGroups.logic")
const { itemKeyDialog, pagerDelta, pagerIntent, previewOverlayKey } = await import("@/features/preview/components/previewOverlay.logic")
const { PREVIEW_OVERLAY_ACTIONS } = await import("@/features/preview/lib/keymap")

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

	target.dispatchEvent(event)

	return event
}

function overlay(role: "dialog" | "alertdialog" | "menu", open = true): HTMLElement {
	const element = document.createElement("div")

	element.setAttribute("role", role)

	if (open) {
		element.setAttribute("data-open", "")
	}

	document.body.append(element)

	return element
}

const PLAIN = { repeat: false, key: "n", isComposing: false, keyCode: 78, getModifierState: () => false }

afterEach(() => {
	document.body.replaceChildren()
})

describe("OUTSIDE_OVERLAYS", () => {
	it("runs the action and cancels its default with nothing open", () => {
		const handler = vi.fn((event: KeyboardEvent) => {
			event.preventDefault()
		})

		renderHook(() => useAction("drive.selectAll", handler, OUTSIDE_OVERLAYS))

		expect(press({ key: "a", code: "KeyA", ctrlKey: true, metaKey: true }).defaultPrevented).toBe(true)
		expect(handler).toHaveBeenCalledOnce()
	})

	// The guard runs before preventDefault: the open layer keeps the key, default included.
	it.each(["dialog", "alertdialog", "menu"] as const)("stands down under an open %s and leaves the default alone", role => {
		const handler = vi.fn((event: KeyboardEvent) => {
			event.preventDefault()
		})

		overlay(role)
		renderHook(() => useAction("drive.newDirectory", handler, OUTSIDE_OVERLAYS))

		expect(press({ key: "n", code: "KeyN" }).defaultPrevented).toBe(false)
		expect(handler).not.toHaveBeenCalled()
	})

	it("ignores a closed overlay", () => {
		const handler = vi.fn()

		overlay("menu", false)
		renderHook(() => useAction("drive.newDirectory", handler, OUTSIDE_OVERLAYS))
		press({ key: "n", code: "KeyN" })

		expect(handler).toHaveBeenCalledOnce()
	})
})

describe("useAction and input methods", () => {
	it("never runs an action on a key an input method composes with", () => {
		const handler = vi.fn()

		renderHook(() => useAction("drive.clearSelection", handler))

		expect(press({ key: "Escape", code: "Escape", isComposing: true }).defaultPrevented).toBe(false)
		expect(handler).not.toHaveBeenCalled()

		press({ key: "Escape", code: "Escape" })
		expect(handler).toHaveBeenCalledOnce()
	})

	it("treats Safari's confirming keyCode 229 and the Process key as the input method's", () => {
		expect(shouldIgnoreEvent({ ...PLAIN, keyCode: 229 })).toBe(true)
		expect(shouldIgnoreEvent({ ...PLAIN, key: "Process" })).toBe(true)
		expect(shouldIgnoreEvent(PLAIN)).toBe(false)
	})
})

describe("isOverlayOpenBesides", () => {
	it("skips the overlay holding the node, and nothing else", () => {
		const drawer = overlay("dialog")
		const panel = document.createElement("aside")

		drawer.append(panel)
		expect(isOverlayOpenBesides(panel)).toBe(false)

		overlay("alertdialog")
		expect(isOverlayOpenBesides(panel)).toBe(true)
	})

	it("counts every open overlay without a node", () => {
		expect(isOverlayOpenBesides(null)).toBe(false)
		overlay("menu")
		expect(isOverlayOpenBesides(null)).toBe(true)
	})
})

// The narrow drawer the assistant is shown in is a dialog: its own key closes it.
describe("app.toggleAssistant's guard", () => {
	it("lets the key close the drawer holding the panel", () => {
		const drawer = overlay("dialog")
		const panel = document.createElement("aside")

		panel.id = ASSISTANT_PANEL_ID
		drawer.append(panel)

		expect(assistantKeyIgnored(PLAIN)).toBe(false)
	})

	it("stands down under any other dialog or menu, the inline panel shown or not", () => {
		const panel = document.createElement("aside")

		panel.id = ASSISTANT_PANEL_ID
		document.body.append(panel)
		overlay("menu")

		expect(assistantKeyIgnored(PLAIN)).toBe(true)
	})
})

describe("the audio bar's transport keys", () => {
	it("stand down while a video player holds the Media Session, and under a dialog", () => {
		const owners = new MediaSessionOwners(null)
		const audio = owners.create("audio")
		const video = owners.create("video")

		audio.acquire()
		expect(transportKeyIgnored(PLAIN, audio)).toBe(false)

		video.acquire()
		expect(transportKeyIgnored(PLAIN, audio)).toBe(true)

		video.release()
		expect(transportKeyIgnored(PLAIN, audio)).toBe(false)

		overlay("dialog")
		expect(transportKeyIgnored(PLAIN, audio)).toBe(true)
	})
})

describe("toggledTheme", () => {
	it("flips the look shown and goes back to following the system when that is the system's", () => {
		expect(toggledTheme("system", "light")).toBe("dark")
		expect(toggledTheme("dark", "light")).toBe("system")
		expect(toggledTheme("system", "dark")).toBe("light")
		expect(toggledTheme("light", "dark")).toBe("system")
		expect(toggledTheme("light", "light")).toBe("dark")
		expect(toggledTheme("dark", "dark")).toBe("light")
	})
})

describe("settingsRoute", () => {
	it("leads to Security while the master keys are not exported, as the rail and account menu do", () => {
		expect(settingsRoute(true)).toBe("/settings/security")
		expect(settingsRoute(false)).toBe("/settings/account")
	})
})

describe("the preview overlay's keys", () => {
	const key = (
		name: string,
		init: Partial<{
			defaultPrevented: boolean
			altKey: boolean
			ctrlKey: boolean
			metaKey: boolean
			shiftKey: boolean
			code: string
		}> = {}
	) => ({
		key: name,
		code: name,
		defaultPrevented: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		...init
	})
	const defaults = (mac: boolean): Record<string, string> =>
		Object.fromEntries(
			PREVIEW_OVERLAY_ACTIONS.map(def => [
				def.id,
				def.platformDefaults?.find(({ on }) => on.mac === mac && on.desktop === undefined)?.combo ?? def.defaultCombo
			])
		)
	const off = defaults(false)

	it("steps on plain ArrowLeft and ArrowRight, and to the ends on Home and End", () => {
		expect(previewOverlayKey(key("ArrowLeft"), off, false)).toBe("preview.prev")
		expect(previewOverlayKey(key("ArrowRight"), off, false)).toBe("preview.next")
		expect(previewOverlayKey(key("Home"), off, false)).toBe("preview.first")
		expect(previewOverlayKey(key("End"), off, false)).toBe("preview.last")
		expect(previewOverlayKey(key("ArrowUp"), off, false)).toBeUndefined()
		expect(pagerDelta("preview.prev", 2, 5)).toBe(-1)
		expect(pagerDelta("preview.first", 3, 5)).toBe(-3)
		expect(pagerDelta("preview.last", 1, 5)).toBe(3)
		// At an end, or for a key that does not page, nothing moves.
		expect(pagerDelta("preview.next", 4, 5)).toBeNull()
		expect(pagerDelta("preview.first", 0, 5)).toBeNull()
		expect(pagerDelta("preview.rename", 1, 5)).toBeNull()
		expect(pagerIntent("preview.last")).toBe("last")
	})

	// A ribbon's roving focus cancels the arrow without stopping it: the file must not change under it.
	it("never steps on a key something inside already took, nor on a chord", () => {
		expect(previewOverlayKey(key("ArrowRight", { defaultPrevented: true }), off, false)).toBeUndefined()
		expect(previewOverlayKey(key("ArrowLeft", { ctrlKey: true }), off, false)).toBeUndefined()
		expect(previewOverlayKey(key("ArrowLeft", { altKey: true }), off, false)).toBeUndefined()
		expect(previewOverlayKey(key("ArrowLeft", { metaKey: true }), off, false)).toBeUndefined()
	})

	it("takes the item menu's keys, per platform, and follows the user's bindings", () => {
		const mac = defaults(true)

		expect(previewOverlayKey(key("F2"), off, false)).toBe("preview.rename")
		expect(previewOverlayKey(key("Delete"), off, false)).toBe("preview.trash")
		expect(previewOverlayKey(key("Backspace", { metaKey: true }), mac, true)).toBe("preview.trash")
		expect(previewOverlayKey(key("Enter", { altKey: true }), off, false)).toBe("preview.info")
		expect(previewOverlayKey(key("i", { metaKey: true, code: "KeyI" }), mac, true)).toBe("preview.info")
		expect(previewOverlayKey(key("F10", { shiftKey: true }), off, false)).toBe("preview.openMenu")
		expect(previewOverlayKey(key("Escape"), off, false)).toBe("preview.close")

		const rebound = { ...off, "preview.next": "pagedown", "preview.move": "mod+m" }

		expect(previewOverlayKey(key("ArrowRight"), rebound, false)).toBeUndefined()
		expect(previewOverlayKey(key("PageDown"), rebound, false)).toBe("preview.next")
		expect(previewOverlayKey(key("m", { ctrlKey: true, code: "KeyM" }), rebound, false)).toBe("preview.move")
	})

	it("ships favorite unassigned, and takes it once bound", () => {
		expect(off["preview.favorite"]).toBe("")
		expect(previewOverlayKey(key("f"), off, false)).toBeUndefined()
		expect(previewOverlayKey(key("b", { ctrlKey: true, code: "KeyB" }), { ...off, "preview.favorite": "mod+b" }, false)).toBe(
			"preview.favorite"
		)
	})

	// A key reaches only what the file's own menu offers, enabled.
	it("opens an item-menu dialog only where the menu offers that entry", () => {
		const rename = { id: "rename", run: "dialog", dialogKind: "rename" } as const
		const trash = { id: "trash", run: "dialog", dialogKind: "trash", enabled: false } as const

		expect(itemKeyDialog("preview.rename", [rename])).toBe("rename")
		expect(itemKeyDialog("preview.trash", [rename, trash])).toBeNull()
		expect(itemKeyDialog("preview.info", [rename])).toBeNull()
		expect(itemKeyDialog("preview.close", [rename])).toBeNull()
	})
})

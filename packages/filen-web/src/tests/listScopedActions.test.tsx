// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

// drive.open's and drive.openItemMenu's defaults, as the registry resolves them, without loading its storage.
vi.mock("@/lib/keymap/registry", () => ({
	isRecordingCombo: () => false,
	useComboFor: (id: string) => (id === "drive.open" ? "enter" : id === "drive.openItemMenu" ? "shift+f10" : ""),
	comboFor: () => "",
	subscribeBindings: () => () => undefined
}))

const { OUTSIDE_OVERLAYS, useAction } = await import("@/lib/keymap/useAction")
const { listboxKeyTargetIsInteractive, openOptionContextMenu } = await import("@/features/drive/lib/listbox")

function press(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

	target.dispatchEvent(event)

	return event
}

// A listbox holding one row with its ⋯ trigger, and a button outside it, as the drive listing renders them.
function listing() {
	const outside = document.body.appendChild(document.createElement("button"))
	const listbox = document.body.appendChild(document.createElement("div"))
	const row = listbox.appendChild(document.createElement("div"))
	const trigger = row.appendChild(document.createElement("button"))

	listbox.setAttribute("role", "listbox")
	row.setAttribute("role", "option")
	row.tabIndex = 0

	return { outside, listbox, row, trigger }
}

// The listing's own open handler (directoryListing.tsx), against a spy.
function renderOpen(listbox: HTMLElement, open: () => void) {
	const { result } = renderHook(() =>
		useAction(
			"drive.open",
			event => {
				if (listboxKeyTargetIsInteractive(event.target)) {
					return
				}

				event.preventDefault()
				open()
			},
			OUTSIDE_OVERLAYS
		)
	)

	act(() => {
		result.current(listbox)
	})
}

afterEach(() => {
	document.body.replaceChildren()
})

describe("drive.open, scoped to the listbox", () => {
	it("opens on Enter pressed on a focused row", () => {
		const { listbox, row } = listing()
		const open = vi.fn()

		renderOpen(listbox, open)
		row.focus()

		expect(press(row, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(true)
		expect(open).toHaveBeenCalledOnce()
	})

	it("leaves Enter on any other control alone", () => {
		const { outside, listbox } = listing()
		const open = vi.fn()

		renderOpen(listbox, open)
		outside.focus()

		expect(press(outside, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(false)
		expect(open).not.toHaveBeenCalled()
	})

	it("leaves Enter on a row's ⋯ trigger to the button, whose click opens its menu", () => {
		const { listbox, trigger } = listing()
		const open = vi.fn()

		renderOpen(listbox, open)
		trigger.focus()

		expect(press(trigger, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(false)
		expect(open).not.toHaveBeenCalled()
	})

	it("stands down under an open menu", () => {
		const { listbox, row } = listing()
		const menu = document.body.appendChild(document.createElement("div"))
		const open = vi.fn()

		menu.setAttribute("role", "menu")
		menu.setAttribute("data-open", "")
		renderOpen(listbox, open)
		row.focus()

		expect(press(row, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(false)
		expect(open).not.toHaveBeenCalled()
	})

	it("is modifier-exact: Shift+Enter is some other shortcut's", () => {
		const { listbox, row } = listing()
		const open = vi.fn()

		renderOpen(listbox, open)
		row.focus()
		press(row, { key: "Enter", code: "Enter", shiftKey: true })

		expect(open).not.toHaveBeenCalled()
	})
})

describe("openOptionContextMenu", () => {
	it("right-clicks the option holding the target, over its leading edge", () => {
		const { row, trigger } = listing()
		const received: MouseEvent[] = []

		row.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 50, width: 600, height: 40 })
		row.addEventListener("contextmenu", event => {
			received.push(event)
		})

		expect(openOptionContextMenu(trigger)).toBe(true)
		expect(received).toHaveLength(1)
		expect(received[0]).toMatchObject({ button: 2, clientX: 120, clientY: 70, bubbles: true, cancelable: true })
	})

	it("opens nothing outside an option", () => {
		const { outside } = listing()

		expect(openOptionContextMenu(outside)).toBe(false)
		expect(openOptionContextMenu(null)).toBe(false)
	})
})

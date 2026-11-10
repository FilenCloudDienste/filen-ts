// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { hasCommandModifier, isActivationKey, onActivateKey } from "@/lib/rowKeys"

afterEach(() => {
	cleanup()
})

function key(name: string, modifiers: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) {
	return { key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers }
}

describe("isActivationKey", () => {
	it("accepts Enter and Space only", () => {
		expect(isActivationKey(key("Enter"))).toBe(true)
		expect(isActivationKey(key(" "))).toBe(true)
		expect(isActivationKey(key("ArrowDown"))).toBe(false)
		expect(isActivationKey(key("Spacebar"))).toBe(false)
	})

	// A chord with Enter or Space is some shortcut's, never a row's activation.
	it("is modifier-exact", () => {
		for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"] as const) {
			expect(isActivationKey(key("Enter", { [modifier]: true }))).toBe(false)
			expect(isActivationKey(key(" ", { [modifier]: true }))).toBe(false)
		}
	})
})

describe("hasCommandModifier", () => {
	it("is Ctrl, Cmd or Alt, never Shift alone", () => {
		expect(hasCommandModifier(key("ArrowDown", { shiftKey: true }))).toBe(false)
		expect(hasCommandModifier(key("ArrowDown", { ctrlKey: true }))).toBe(true)
		expect(hasCommandModifier(key("ArrowDown", { metaKey: true }))).toBe(true)
		expect(hasCommandModifier(key("ArrowDown", { altKey: true }))).toBe(true)
	})
})

describe("onActivateKey", () => {
	function renderRow(activate: () => void): void {
		render(
			createElement(
				"div",
				{ role: "option", "aria-selected": false, tabIndex: 0, onKeyDown: onActivateKey(activate) },
				createElement("button", { type: "button" }, "inner")
			)
		)
	}

	it("activates and cancels the default on Enter/Space pressed on the row itself", () => {
		const activate = vi.fn()

		renderRow(activate)

		const row = screen.getByRole("option")

		expect(fireEvent.keyDown(row, { key: "Enter" })).toBe(false)
		expect(fireEvent.keyDown(row, { key: " " })).toBe(false)
		expect(activate).toHaveBeenCalledTimes(2)
	})

	it("leaves a chord with Enter or Space to its shortcut", () => {
		const activate = vi.fn()

		renderRow(activate)

		const row = screen.getByRole("option")

		expect(fireEvent.keyDown(row, { key: "Enter", ctrlKey: true })).toBe(true)
		expect(fireEvent.keyDown(row, { key: " ", shiftKey: true })).toBe(true)
		expect(activate).not.toHaveBeenCalled()
	})

	it("ignores other keys and keys bubbled from a control inside the row", () => {
		const activate = vi.fn()

		renderRow(activate)

		expect(fireEvent.keyDown(screen.getByRole("option"), { key: "a" })).toBe(true)
		expect(fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" })).toBe(true)
		expect(activate).not.toHaveBeenCalled()
	})
})

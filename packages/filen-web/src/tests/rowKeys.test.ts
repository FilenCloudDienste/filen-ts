// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { isActivationKey, onActivateKey } from "@/lib/rowKeys"

afterEach(() => {
	cleanup()
})

describe("isActivationKey", () => {
	it("accepts Enter and Space only", () => {
		expect(isActivationKey("Enter")).toBe(true)
		expect(isActivationKey(" ")).toBe(true)
		expect(isActivationKey("ArrowDown")).toBe(false)
		expect(isActivationKey("Spacebar")).toBe(false)
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

	it("ignores other keys and keys bubbled from a control inside the row", () => {
		const activate = vi.fn()

		renderRow(activate)

		expect(fireEvent.keyDown(screen.getByRole("option"), { key: "a" })).toBe(true)
		expect(fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" })).toBe(true)
		expect(activate).not.toHaveBeenCalled()
	})
})

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cyclePane } from "@/features/shell/lib/paneCycle"

// jsdom lays nothing out: an element counts as on screen unless it is inside a `hidden` one.
beforeEach(() => {
	vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
		return (this.closest("[hidden]") === null ? [{}] : []) as unknown as DOMRectList
	})
})

afterEach(() => {
	vi.restoreAllMocks()
	document.body.replaceChildren()
})

function pane(name: string, ...children: string[]): HTMLElement {
	const element = document.createElement("div")

	element.setAttribute("data-shell-pane", name)

	for (const label of children) {
		const button = document.createElement("button")

		button.textContent = label
		element.append(button)
	}

	document.body.append(element)

	return element
}

function focused(): string | null | undefined {
	return document.activeElement?.textContent
}

describe("cyclePane", () => {
	it("moves through the areas in order and wraps", () => {
		pane("rail", "drive")
		pane("sidebar", "recents")
		pane("main", "first row")

		cyclePane(1)
		expect(focused()).toBe("drive")
		cyclePane(1)
		expect(focused()).toBe("recents")
		cyclePane(1)
		expect(focused()).toBe("first row")
		cyclePane(1)
		expect(focused()).toBe("drive")
		cyclePane(-1)
		expect(focused()).toBe("first row")
	})

	it("comes back to where focus was in an area", () => {
		pane("rail", "drive")
		const main = pane("main", "first row", "second row")

		main.querySelectorAll("button")[1]?.focus()
		cyclePane(1)
		expect(focused()).toBe("drive")
		cyclePane(1)
		expect(focused()).toBe("second row")
	})

	it("skips an area that is hidden or has nothing to focus", () => {
		pane("rail", "drive")
		pane("sidebar", "recents").hidden = true
		pane("assistant")
		pane("main", "first row")

		cyclePane(1)
		cyclePane(1)
		expect(focused()).toBe("first row")
		expect(cyclePane(1)).toBe(true)
		expect(focused()).toBe("drive")
	})
})

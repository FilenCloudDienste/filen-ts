// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { isFocusReturn } from "@/components/ui/tooltip.logic"

function element(html: string): HTMLElement {
	document.body.insertAdjacentHTML("beforeend", html)

	const last = document.body.lastElementChild

	if (!(last instanceof HTMLElement)) {
		throw new Error("no element")
	}

	return last
}

afterEach(() => {
	document.body.replaceChildren()
})

describe("isFocusReturn", () => {
	it("takes focus from a closing menu or dialog for a return", () => {
		const trigger = element("<button>More</button>")
		const menu = element('<div role="menu"><button>Trash</button></div>')
		const dialog = element('<div role="dialog"><input /></div>')

		expect(isFocusReturn(new FocusEvent("focus", { relatedTarget: menu.querySelector("button") }), trigger)).toBe(true)
		expect(isFocusReturn(new FocusEvent("focus", { relatedTarget: dialog.querySelector("input") }), trigger)).toBe(true)
	})

	it("takes focus from nowhere (the popup already gone) for a return", () => {
		expect(isFocusReturn(new FocusEvent("focus", { relatedTarget: null }), element("<button>More</button>"))).toBe(true)
	})

	it("keeps focus the user moved: from the page, or within the dialog that holds the trigger", () => {
		const previous = element("<button>Before</button>")
		const trigger = element("<button>More</button>")
		const dialog = element('<div role="dialog"><button>Close</button><button>More</button></div>')
		const [close, inner] = dialog.querySelectorAll("button")

		expect(isFocusReturn(new FocusEvent("focus", { relatedTarget: previous }), trigger)).toBe(false)
		expect(isFocusReturn(new FocusEvent("focus", { relatedTarget: close ?? null }), inner)).toBe(false)
	})

	it("ignores an event that is not a focus event", () => {
		expect(isFocusReturn(new Event("focus"), undefined)).toBe(false)
	})
})

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeToolContext } from "@/tests/support/pdfToolContext"

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const { pdfToolSurfaceKey } = await import("@/features/pdf/session/toolSession")
const { PDF_TOOLS } = await import("@/features/pdf/tools")

// A tool letter on the page surface in the preview overlay: the overlay is an open dialog itself, which never keeps the
// letter from the tools; a dialog or menu opened over it does.

afterEach(() => {
	document.body.replaceChildren()
})

// The preview overlay (an open dialog) holding the page surface with a focusable page column.
function overlaySurface(): { surface: HTMLElement; scroller: HTMLElement } {
	const overlay = document.createElement("div")
	const surface = document.createElement("div")
	const scroller = document.createElement("div")

	overlay.setAttribute("role", "dialog")
	overlay.setAttribute("data-open", "")
	scroller.tabIndex = -1
	surface.append(scroller)
	overlay.append(surface)
	document.body.append(overlay)

	return { surface, scroller }
}

// Presses `key` on `target` and returns what the surface's key handling made of it, and the tool it chose.
function press(target: HTMLElement, surface: HTMLElement, key: string): { took: boolean; activated: (string | null)[] } {
	const activated: (string | null)[] = []
	let took = false

	target.addEventListener(
		"keydown",
		event => {
			took = pdfToolSurfaceKey(event, surface, 0, {
				tools: PDF_TOOLS,
				combos: {},
				activeTool: null,
				policy: { editable: true, online: true, tools: null },
				context: fakeToolContext(),
				activate: tool => {
					activated.push(tool)
				}
			})
		},
		{ once: true }
	)
	target.dispatchEvent(new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, bubbles: true }))

	return { took, activated }
}

describe("tool letters on the page surface", () => {
	it("pick their tool inside the preview overlay", () => {
		const { surface, scroller } = overlaySurface()

		expect(press(scroller, surface, "t")).toEqual({ took: true, activated: ["annotations.textBox"] })
	})

	it("stand down while a dialog or menu is open over the overlay", () => {
		const { surface, scroller } = overlaySurface()
		const menu = document.createElement("div")

		menu.setAttribute("role", "menu")
		menu.setAttribute("data-open", "")
		document.body.append(menu)

		expect(press(scroller, surface, "t")).toEqual({ took: false, activated: [] })
	})
})

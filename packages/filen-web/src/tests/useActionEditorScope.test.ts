// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

vi.mock("@/lib/keymap/registry", () => ({ isRecordingCombo: () => false, useComboFor: () => "mod+s" }))

const { IN_EDITORS, IN_EDITORS_AND_FIELDS, useAction } = await import("@/lib/keymap/useAction")

function pressModS(target: HTMLElement): void {
	target.focus()
	target.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, metaKey: true, bubbles: true }))
}

function field(tag: "input" | "textarea"): HTMLElement {
	const element = document.createElement(tag)

	document.body.append(element)

	return element
}

afterEach(() => {
	document.body.replaceChildren()
})

// A plain <input>/<textarea> has no role, so the "textbox" entry editors rely on never matches it.
describe("useAction editor scopes", () => {
	it("fires a save from a plain input and textarea with IN_EDITORS_AND_FIELDS", () => {
		const handler = vi.fn()

		renderHook(() => useAction("preview.save", handler, IN_EDITORS_AND_FIELDS))
		pressModS(field("input"))
		pressModS(field("textarea"))

		expect(handler).toHaveBeenCalledTimes(2)
	})

	it("leaves a plain input's keys to it with IN_EDITORS", () => {
		const handler = vi.fn()

		renderHook(() => useAction("editor.togglePreview", handler, IN_EDITORS))
		pressModS(field("input"))

		expect(handler).not.toHaveBeenCalled()
	})
})

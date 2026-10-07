// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

vi.mock("@/lib/keymap/registry", () => ({
	isRecordingCombo: () => false,
	useComboFor: (id: string) => (id === "drive.newDirectory" ? "n" : id === "drive.copy" ? "mod+c" : "escape")
}))

const { useAction } = await import("@/lib/keymap/useAction")

function press(init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

	document.body.dispatchEvent(event)

	return event
}

afterEach(() => {
	document.body.replaceChildren()
})

// A handler that opens an autofocused field would otherwise receive the very letter that triggered it.
describe("useAction text-input default", () => {
	it("cancels a matched bare letter's default", () => {
		const handler = vi.fn()

		renderHook(() => useAction("drive.newDirectory", handler))
		const event = press({ key: "n", code: "KeyN" })

		expect(handler).toHaveBeenCalledTimes(1)
		expect(event.defaultPrevented).toBe(true)
	})

	it("leaves modifier combos and named keys to their own handling", () => {
		const copy = vi.fn()
		const clear = vi.fn()

		renderHook(() => useAction("drive.copy", copy))
		renderHook(() => useAction("drive.clearSelection", clear))
		const copyEvent = press({ key: "c", code: "KeyC", ctrlKey: true, metaKey: true })
		const escapeEvent = press({ key: "Escape", code: "Escape" })

		expect(copy).toHaveBeenCalledTimes(1)
		expect(clear).toHaveBeenCalledTimes(1)
		expect(copyEvent.defaultPrevented).toBe(false)
		expect(escapeEvent.defaultPrevented).toBe(false)
	})

	it("leaves an unmatched letter alone", () => {
		renderHook(() => useAction("drive.newDirectory", vi.fn()))

		expect(press({ key: "m", code: "KeyM" }).defaultPrevented).toBe(false)
	})
})

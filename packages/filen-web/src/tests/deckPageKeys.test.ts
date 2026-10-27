// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import type { KeyboardEvent } from "react"
import { onPageKey } from "@/features/presentation/components/deckChrome.logic"

// The deck's paging keys on its root: plain arrows page slides; Ctrl, Alt or Cmd with an arrow pages nothing and does
// not reach the browser either (WebKit's Cmd+ArrowLeft goes back a page), except in a text field, where it moves the
// caret.

function key(init: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; target?: EventTarget }) {
	const event = {
		key: init.key,
		metaKey: init.metaKey ?? false,
		ctrlKey: init.ctrlKey ?? false,
		altKey: init.altKey ?? false,
		shiftKey: false,
		target: init.target ?? document.createElement("div"),
		defaultPrevented: false,
		preventDefault: vi.fn(() => {
			event.defaultPrevented = true
		}),
		stopPropagation: vi.fn()
	}

	return event
}

describe("deck page keys", () => {
	it("keeps a modified arrow from the browser outside text fields, and pages nothing", () => {
		const page = vi.fn()

		for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const) {
			for (const name of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
				const event = key({ key: name, [modifier]: true })

				onPageKey(event as unknown as KeyboardEvent<HTMLElement>, false, page)
				expect(event.preventDefault).toHaveBeenCalled()
			}
		}

		expect(page).not.toHaveBeenCalled()
	})

	it("leaves a modified arrow in a text field to the caret", () => {
		const event = key({ key: "ArrowLeft", metaKey: true, target: document.createElement("input") })

		onPageKey(event as unknown as KeyboardEvent<HTMLElement>, false, vi.fn())
		expect(event.preventDefault).not.toHaveBeenCalled()
	})

	it("pages on a plain arrow", () => {
		const page = vi.fn()

		onPageKey(key({ key: "ArrowRight" }) as unknown as KeyboardEvent<HTMLElement>, false, page)
		expect(page).toHaveBeenCalledWith(1)
	})
})

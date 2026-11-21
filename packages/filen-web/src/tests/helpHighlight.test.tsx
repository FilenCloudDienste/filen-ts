// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import {
	HELP_HIGHLIGHT_ATTRIBUTE,
	HELP_HIGHLIGHT_MS,
	highlightWhenRendered,
	useHelpHighlight
} from "@/features/settings/hooks/useHelpHighlight"
import { HELP_HIGHLIGHT_WAIT_MS, requestSettingsHighlight, takeSettingsHighlight } from "@/lib/settingsHighlight"

const scrollIntoView = vi.fn()

function row(id: string, slot = "settings-row"): HTMLElement {
	const element = document.createElement("div")

	element.id = id
	element.dataset["slot"] = slot
	element.scrollIntoView = scrollIntoView

	return element
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({ matches: false }))
	)
	scrollIntoView.mockClear()
})

afterEach(() => {
	takeSettingsHighlight()
	document.body.replaceChildren()
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe("highlightWhenRendered", () => {
	it("scrolls a rendered row to the centre and rings it for the pulse only", () => {
		const target = row("help-theme")

		document.body.append(target)
		highlightWhenRendered("help-theme", HELP_HIGHLIGHT_WAIT_MS)

		expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" })
		expect(target.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(true)

		vi.advanceTimersByTime(HELP_HIGHLIGHT_MS)

		expect(target.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(false)
	})

	it("jumps without smooth scrolling under reduced motion", () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: true }))
		)
		document.body.append(row("help-theme"))
		highlightWhenRendered("help-theme", HELP_HIGHLIGHT_WAIT_MS)

		expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" })
	})

	it("waits for a row that renders later", async () => {
		highlightWhenRendered("help-twoFactor", HELP_HIGHLIGHT_WAIT_MS)

		const target = row("help-twoFactor")

		document.body.append(target)
		// MutationObserver callbacks are microtasks.
		await Promise.resolve()

		expect(target.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(true)
	})

	it("stops waiting after the wait", async () => {
		highlightWhenRendered("help-lockNow", HELP_HIGHLIGHT_WAIT_MS)
		vi.advanceTimersByTime(HELP_HIGHLIGHT_WAIT_MS)

		const target = row("help-lockNow")

		document.body.append(target)
		await Promise.resolve()

		expect(target.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(false)
		expect(scrollIntoView).not.toHaveBeenCalled()
	})

	it("rings a group on its panel", () => {
		const group = row("help-logs", "settings-group")
		const panel = document.createElement("div")

		panel.dataset["slot"] = "settings-panel"
		group.append(panel)
		document.body.append(group)
		highlightWhenRendered("help-logs", HELP_HIGHLIGHT_WAIT_MS)

		expect(panel.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(true)
		expect(group.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(false)
	})

	it("cancels a pulse in progress", () => {
		const target = row("help-theme")

		document.body.append(target)
		highlightWhenRendered("help-theme", HELP_HIGHLIGHT_WAIT_MS)()

		expect(target.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(false)
	})
})

describe("useHelpHighlight", () => {
	it("takes a request made before Settings opened", () => {
		const target = row("help-language")

		document.body.append(target)
		requestSettingsHighlight("language")
		renderHook(() => {
			useHelpHighlight()
		})

		expect(target.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(true)
	})

	it("takes a request made while Settings is open, replacing the last", () => {
		const first = row("help-language")
		const second = row("help-theme")

		document.body.append(first, second)
		renderHook(() => {
			useHelpHighlight()
		})
		requestSettingsHighlight("language")
		requestSettingsHighlight("theme")

		expect(first.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(false)
		expect(second.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(true)
	})

	it("drops a request no page took up in time", () => {
		const target = row("help-language")

		document.body.append(target)
		requestSettingsHighlight("language")
		vi.advanceTimersByTime(HELP_HIGHLIGHT_WAIT_MS)
		renderHook(() => {
			useHelpHighlight()
		})

		expect(target.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(false)
	})

	it("ends the pulse when Settings closes", () => {
		const target = row("help-language")

		document.body.append(target)

		const { unmount } = renderHook(() => {
			useHelpHighlight()
		})

		requestSettingsHighlight("language")
		unmount()

		expect(target.hasAttribute(HELP_HIGHLIGHT_ATTRIBUTE)).toBe(false)
	})
})

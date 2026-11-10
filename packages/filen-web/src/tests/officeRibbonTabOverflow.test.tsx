// @vitest-environment jsdom

import "@/tests/support/officeKeys"
import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"

// The ribbon's tab row on a narrow screen: tabs it has no room for scroll, and the clipped side fades out so the user
// sees there are more.

afterEach(() => {
	cleanup()
})

function layout(element: HTMLElement, scroll: { scrollWidth: number; clientWidth: number; scrollLeft: number }): void {
	Object.defineProperty(element, "scrollWidth", { configurable: true, get: () => scroll.scrollWidth })
	Object.defineProperty(element, "clientWidth", { configurable: true, get: () => scroll.clientWidth })
	Object.defineProperty(element, "scrollLeft", { configurable: true, get: () => scroll.scrollLeft })
}

describe("office ribbon tab row", () => {
	it("marks the side with tabs scrolled out of view", () => {
		const tabs = ["Home", "Insert", "Design", "View", "Arrange"].map(label => ({ id: label.toLowerCase(), label }))

		render(
			<OfficeRibbon
				label="Ribbon"
				commandsLabel="Commands"
				tabs={tabs}
				tab="home"
				onTab={() => undefined}
				file={null}
				groups={[]}
			/>
		)

		const list = screen.getByRole("tablist", { name: "Ribbon" })
		const scroll = { scrollWidth: 243, clientWidth: 160, scrollLeft: 0 }

		layout(list, scroll)
		act(() => {
			fireEvent.scroll(list)
		})
		expect(list.hasAttribute("data-overflow-end")).toBe(true)
		expect(list.hasAttribute("data-overflow-start")).toBe(false)

		scroll.scrollLeft = 83
		act(() => {
			fireEvent.scroll(list)
		})
		expect(list.hasAttribute("data-overflow-end")).toBe(false)
		expect(list.hasAttribute("data-overflow-start")).toBe(true)
	})
})

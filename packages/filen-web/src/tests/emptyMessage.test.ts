// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement } from "react"
import { UsersIcon } from "lucide-react"
import "@/lib/i18n"
import { EmptyMessage, NoResultsMessage } from "@/components/emptyMessage"

afterEach(() => {
	cleanup()
})

describe("EmptyMessage", () => {
	it("forwards root props and renders the header without optional slots", () => {
		// Spread: a data-* key in the literal trips createElement's excess-property check, not JSX's.
		const testId = { "data-testid": "x" }
		const { container } = render(createElement(EmptyMessage, { icon: UsersIcon, title: "Nobody", role: "alert", ...testId }))
		const root = container.querySelector('[data-slot="empty"]')

		expect(root?.getAttribute("role")).toBe("alert")
		expect(root?.getAttribute("data-testid")).toBe("x")
		expect(container.querySelector('[data-slot="empty-title"]')?.textContent).toBe("Nobody")
		expect(container.querySelector('[data-slot="empty-description"]')).toBeNull()
		expect(container.querySelector('[data-slot="empty-content"]')).toBeNull()
	})

	it("renders the description and the children as the content row", () => {
		const { container } = render(createElement(EmptyMessage, { icon: UsersIcon, title: "Nobody", description: "Add one" }, "action"))

		expect(container.querySelector('[data-slot="empty-description"]')?.textContent).toBe("Add one")
		expect(container.querySelector('[data-slot="empty-content"]')?.textContent).toBe("action")
	})
})

describe("NoResultsMessage", () => {
	it("renders the shared no-matches title", () => {
		const { container } = render(createElement(NoResultsMessage))

		expect(container.querySelector('[data-slot="empty-title"]')?.textContent).toBe("No matches")
	})
})

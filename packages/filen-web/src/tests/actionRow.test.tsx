// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { createElement } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { ActionRow } from "@/features/desktop/components/actionRow"

afterEach(() => {
	cleanup()
})

describe("ActionRow", () => {
	it("names its button by the visible action and describes it by the row label", () => {
		render(
			createElement(ActionRow, {
				label: "Pause syncing",
				description: "Stops the pair until resumed",
				action: "Resume",
				run: () => Promise.resolve()
			})
		)

		expect(screen.getByRole("button", { name: "Resume", description: "Pause syncing" })).toBeDefined()
		expect(screen.queryByRole("button", { name: "Pause syncing" })).toBeNull()
	})
})

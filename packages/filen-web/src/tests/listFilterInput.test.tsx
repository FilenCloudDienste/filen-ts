// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { ListFilterInput } from "@/components/listFilterInput"

afterEach(() => {
	cleanup()
})

describe("ListFilterInput", () => {
	it("names the clear button for what it does, not after the field", () => {
		const onChange = vi.fn()

		render(
			<ListFilterInput
				value="ali"
				onChange={onChange}
				placeholder="Search contacts"
				ariaLabel="Search contacts"
			/>
		)

		expect(screen.getAllByLabelText("Search contacts")).toHaveLength(1)

		fireEvent.click(screen.getByRole("button", { name: "Clear filter" }))

		expect(onChange).toHaveBeenCalledWith("")
	})
})

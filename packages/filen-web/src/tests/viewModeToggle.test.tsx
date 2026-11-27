// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { drive as EN } from "@/locales/en/drive"
import { ViewModeToggle } from "@/features/drive/components/viewModeToggle"

// The drive toolbar's Display menu: the details panel's kept open/closed choice beside the hidden-items filter.

afterEach(() => {
	cleanup()
})

function openMenu(): void {
	fireEvent.click(screen.getByRole("button", { name: EN.driveDisplay }))
}

describe("ViewModeToggle", () => {
	it("offers the details panel as a checkbox reflecting its state, and reports a change", async () => {
		const onChange = vi.fn()

		render(createElement(ViewModeToggle, { value: "list", onChange: vi.fn(), detailsPanel: { show: true, onChange } }))
		openMenu()

		const item = await screen.findByRole("menuitemcheckbox", { name: EN.driveShowDetailsPanel })

		expect(item.getAttribute("aria-checked")).toBe("true")

		fireEvent.click(item)

		expect(onChange).toHaveBeenCalledWith(false, expect.anything())
	})

	it("leaves the checkbox out where the listing mounts no panel", async () => {
		render(createElement(ViewModeToggle, { value: "grid", onChange: vi.fn() }))
		openMenu()

		await screen.findByRole("menuitemradio", { name: EN.driveViewGrid })

		expect(screen.queryByRole("menuitemcheckbox", { name: EN.driveShowDetailsPanel })).toBeNull()
	})
})

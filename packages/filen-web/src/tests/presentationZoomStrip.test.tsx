// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { ReactElement, ReactNode } from "react"
import "@/lib/i18n"

// The presentation viewer's compact zoom (− / percentage / + / Fit): the editor's pieces on a zoom view, each step
// handed to the view, the limits the editor's, the tooltips naming the editor's zoom keys.

vi.mock("@/lib/storage/adapter", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/storage/adapter")>()),
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve()
}))
// The tooltip's parts, flattened: its content renders in place, so a test reads what it would show.
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: (props: { children: ReactNode }) => props.children,
	TooltipTrigger: (props: { render: ReactElement }) => props.render,
	TooltipContent: (props: { children: ReactNode }) => <div data-testid="tooltip">{props.children}</div>
}))

const { PresentationZoomStrip } = await import("@/features/presentation/components/ribbon/view")
const { registerAllActions } = await import("@/lib/keymap/actions")

registerAllActions()

afterEach(() => {
	cleanup()
})

function strip(scale: number, fit: boolean) {
	const set = vi.fn()

	render(<PresentationZoomStrip zoom={{ scale, fit, set }} />)

	return { set, group: screen.getByRole("group", { name: "Zoom" }) }
}

describe("<PresentationZoomStrip>", () => {
	it("hands each step to the zoom, the percentage shown", () => {
		const { set, group } = strip(1.5, false)

		fireEvent.click(within(group).getByRole("button", { name: "Zoom out" }))
		fireEvent.click(within(group).getByRole("button", { name: "Zoom in" }))
		fireEvent.click(within(group).getByRole("button", { name: "Fit to Window" }))

		expect(set.mock.calls).toEqual([["out"], ["in"], ["fit"]])
		expect(within(group).getByRole("button", { name: /^Zoom level/u }).textContent).toContain("150")
		expect(within(group).getByRole("button", { name: "Fit to Window" }).getAttribute("aria-pressed")).toBe("false")
	})

	it("stops at the editor's limits, and while the slide is not measured", () => {
		const { group } = strip(4, true)

		expect(within(group).getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(true)
		expect(within(group).getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(false)
		expect(within(group).getByRole("button", { name: "Fit to Window" }).getAttribute("aria-pressed")).toBe("true")
		cleanup()

		const unmeasured = strip(0, true).group

		expect(within(unmeasured).getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(true)
	})

	it("names the editor's zoom keys in the tooltips", () => {
		strip(1, false)

		const keys = screen.getAllByTestId("tooltip").map(tooltip => tooltip.textContent)

		expect(keys.find(text => text.startsWith("Zoom out"))).toMatch(/Ctrl/u)
		expect(keys.find(text => text.startsWith("Zoom in"))).toMatch(/Ctrl/u)
		expect(keys.find(text => text.startsWith("Fit to Window"))).toMatch(/Ctrl.*Alt.*O/u)
	})
})

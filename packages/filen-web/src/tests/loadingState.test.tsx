// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { render, cleanup } from "@testing-library/react"
import "@/lib/i18n"
import { LoadingState } from "@/components/loadingState"

const TIERS = [
	["sm", "size-4"],
	["md", "size-6"],
	["lg", "size-8"]
] as const

afterEach(() => {
	cleanup()
})

describe("LoadingState", () => {
	it.each(TIERS)("renders exactly one localized status element at %s", size => {
		const { container, getByRole } = render(<LoadingState size={size} />)

		expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
		expect(getByRole("status", { name: "Loading" }).getAttribute("data-slot")).toBe("spinner")
	})

	it.each(TIERS)("sizes the %s spinner with %s", (size, sizeClass) => {
		const { getByRole } = render(<LoadingState size={size} />)
		const classes = getByRole("status").getAttribute("class")?.split(" ") ?? []

		expect(classes).toContain(sizeClass)
		expect(classes.some(name => name.startsWith("text-"))).toBe(false)
		expect(classes.filter(name => /^size-\d+$/.test(name))).toEqual([sizeClass])
	})

	it("centers the spinner on both axes in a wrapper that fills its container", () => {
		const { container } = render(<LoadingState size="md" />)
		const wrapper = container.firstElementChild
		const classes = wrapper?.className.split(" ") ?? []

		expect(wrapper?.getAttribute("role")).toBeNull()

		for (const name of [
			"flex",
			"items-center",
			"justify-center",
			"flex-1",
			"self-stretch",
			"w-full",
			"h-full",
			"min-h-0",
			"text-muted-foreground"
		]) {
			expect(classes).toContain(name)
		}
	})

	it("lets className replace the color the spinner inherits", () => {
		const { container } = render(
			<LoadingState
				size="lg"
				className="text-white"
			/>
		)
		const classes = container.firstElementChild?.className.split(" ") ?? []

		expect(classes).toContain("text-white")
		expect(classes).not.toContain("text-muted-foreground")
	})

	it("lets className reserve a minimum height over the fill defaults", () => {
		const { container } = render(
			<LoadingState
				size="sm"
				className="min-h-40"
			/>
		)
		const classes = container.firstElementChild?.className.split(" ") ?? []

		expect(classes).toContain("min-h-40")
		expect(classes).not.toContain("min-h-0")
	})
})

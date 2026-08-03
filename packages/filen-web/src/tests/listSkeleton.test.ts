// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { ListSkeleton } from "@/components/listSkeleton"
import { ListingSkeleton } from "@/features/drive/components/listingSkeleton"

// The counts ListingSkeleton renders per branch — module-private there, pinned here so a silent
// change to either shows up as a failing expectation rather than an unnoticed layout shift.
const GRID_TILE_COUNT = 12
const LIST_ROW_COUNT = 8

afterEach(() => {
	cleanup()
})

describe("ListSkeleton", () => {
	it("renders exactly `count` placeholder bars", () => {
		const { container } = render(
			createElement(ListSkeleton, { count: 5, itemClassName: "h-10 w-full", className: "flex flex-col gap-1" })
		)

		expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(5)
	})

	it("announces once through a role=status wrapper carrying the localized Loading name", () => {
		const { getByRole } = render(
			createElement(ListSkeleton, { count: 3, itemClassName: "h-10 w-full", className: "flex flex-col gap-1" })
		)

		expect(getByRole("status", { name: "Loading" })).not.toBeNull()
	})

	it("puts itemClassName on every bar and className on the wrapper", () => {
		const { container, getByRole } = render(
			createElement(ListSkeleton, { count: 2, itemClassName: "h-14 w-full rounded-xl", className: "flex flex-1 flex-col p-4" })
		)

		expect(getByRole("status").className).toBe("flex flex-1 flex-col p-4")

		for (const bar of container.querySelectorAll('[data-slot="skeleton"]')) {
			expect(bar.className).toContain("h-14 w-full rounded-xl")
		}
	})

	it("still announces at count 0 — the live region must not depend on how many bars render", () => {
		const { container, getByRole } = render(
			createElement(ListSkeleton, { count: 0, itemClassName: "h-10 w-full", className: "flex flex-col" })
		)

		expect(getByRole("status", { name: "Loading" })).not.toBeNull()
		expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0)
	})
})

describe("ListingSkeleton", () => {
	it("announces the grid branch — the state /photos and drive's grid view render", () => {
		const { container, getByRole } = render(createElement(ListingSkeleton, { viewMode: "grid" }))

		expect(getByRole("status", { name: "Loading" })).not.toBeNull()
		expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(GRID_TILE_COUNT)
	})

	it("announces the list branch — the state the listing and the four directory pickers render", () => {
		const { container, getByRole } = render(createElement(ListingSkeleton, { viewMode: "list" }))

		expect(getByRole("status", { name: "Loading" })).not.toBeNull()
		expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(LIST_ROW_COUNT)
	})

	it("exposes exactly one live region per branch — a nested one would announce twice", () => {
		const grid = render(createElement(ListingSkeleton, { viewMode: "grid" }))

		expect(grid.container.querySelectorAll('[role="status"]')).toHaveLength(1)

		cleanup()

		const list = render(createElement(ListingSkeleton, { viewMode: "list" }))

		expect(list.container.querySelectorAll('[role="status"]')).toHaveLength(1)
	})
})

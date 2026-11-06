// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { forwardRef, type ComponentPropsWithoutRef } from "react"
import { ImagePlayIcon, ImagesIcon } from "lucide-react"
import "@/lib/i18n"
import { RailGroup } from "@/features/shell/components/railGroup"

// A rail group's icon navigates on click. Its menu trigger is not a native button, and Base UI then stamps
// role="button" on it, so it announced as a button and the e2e helpers that reach it by its link role found
// nothing.
vi.mock("@tanstack/react-router", () => ({
	Link: forwardRef<HTMLAnchorElement, ComponentPropsWithoutRef<"a"> & { to: string }>(function Link({ to, ...props }, ref) {
		return (
			<a
				ref={ref}
				href={to}
				{...props}
			/>
		)
	})
}))

vi.mock("@/features/shell/lib/lastOpened", () => ({
	useLastOpened: () => null,
	rememberLastOpened: vi.fn()
}))

describe("RailGroup", () => {
	it("exposes the group icon as a link named by the group", () => {
		render(
			<RailGroup
				group="media"
				label="Media"
				icon={ImagePlayIcon}
				items={[{ id: "photos", label: "Photos", icon: ImagesIcon, dot: null }]}
				pathname="/drive"
				reordering={false}
			/>
		)

		expect(screen.getByRole("link", { name: "Media" }).getAttribute("href")).toBe("/photos")
		expect(screen.queryByRole("button", { name: "Media" })).toBeNull()
	})
})

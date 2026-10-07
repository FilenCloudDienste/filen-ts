// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const { SignOutOverlay } = await import("@/features/shell/components/signOutOverlay")
const { showSignOutOverlay } = await import("@/features/shell/lib/signOutOverlay")

afterEach(cleanup)

describe("SignOutOverlay", () => {
	it("covers the app once a sign-out starts wiping, as an indeterminate progress bar", () => {
		render(<SignOutOverlay />)

		expect(screen.queryByRole("progressbar")).toBeNull()

		act(() => {
			showSignOutOverlay()
		})

		const bar = screen.getByRole("progressbar", { name: "signingOut" })

		expect(bar.getAttribute("aria-valuenow")).toBeNull()
	})
})

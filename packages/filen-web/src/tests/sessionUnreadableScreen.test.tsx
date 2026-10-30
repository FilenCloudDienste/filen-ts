// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"

// The recovery screen's two ways out: Try again re-reads the session, Sign in again confirms first and then discards.
// Either way, once through, it routes from the root again (to sign-in when no session is left).
const boot = vi.hoisted(() => ({ retrySessionResume: vi.fn<(discard: boolean) => Promise<boolean>>() }))
const navigate = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock("@/lib/sdk/boot", () => boot)
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))
vi.mock("@/lib/bootSplash", () => ({ useDismissBootSplash: () => undefined }))

import "@/lib/i18n"
import { SessionUnreadableScreen } from "@/features/shell/components/sessionUnreadableScreen"

describe("SessionUnreadableScreen", () => {
	it("shows the message, and Try again reads the session again", async () => {
		boot.retrySessionResume.mockResolvedValue(false)
		render(createElement(SessionUnreadableScreen))

		expect(screen.getByText("Couldn't read your saved sign-in")).toBeTruthy()
		expect(screen.queryByText(/Still couldn't read it/)).toBeNull()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Try again" }))
			await Promise.resolve()
		})

		expect(boot.retrySessionResume).toHaveBeenCalledExactlyOnceWith(false)
		expect(screen.getByText(/Still couldn't read it/)).toBeTruthy()
		expect(navigate).not.toHaveBeenCalled()

		boot.retrySessionResume.mockResolvedValue(true)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Try again" }))
			await Promise.resolve()
		})

		expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true })
	})

	it("Sign in again discards only after the confirm", async () => {
		boot.retrySessionResume.mockResolvedValue(true)
		render(createElement(SessionUnreadableScreen))

		fireEvent.click(screen.getByRole("button", { name: "Sign in again" }))
		expect(boot.retrySessionResume).not.toHaveBeenCalled()

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).toContain("Files in your account are not affected")

		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: "Sign in again" }))
			await Promise.resolve()
		})

		expect(boot.retrySessionResume).toHaveBeenCalledExactlyOnceWith(true)
		expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true })
	})

	it("Cancel leaves the session alone", async () => {
		render(createElement(SessionUnreadableScreen))

		fireEvent.click(screen.getByRole("button", { name: "Sign in again" }))
		await screen.findByRole("alertdialog")
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(boot.retrySessionResume).not.toHaveBeenCalled()
		expect(navigate).not.toHaveBeenCalled()
	})
})

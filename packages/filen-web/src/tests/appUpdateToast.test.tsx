// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Toaster, toast } from "sonner"

// Real sonner: Reload on the update prompt, then the active worker (awake, as it streams a download)
// answers within milliseconds that the update is held back. The note must replace the prompt and stay.
const { applyUpdate } = vi.hoisted(() => ({ applyUpdate: vi.fn() }))

vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }))
vi.mock("@/lib/sw/register", () => ({ applyUpdate }))
vi.mock("@/lib/unloadGuard", () => ({ hasUnloadHold: () => false }))
vi.mock("@/lib/desktop", () => ({ desktopPlatform: () => undefined }))

const { showUpdateDeferredToast, showUpdateReadyToast } = await import("@/lib/appUpdate")

// Past sonner's 200 ms removal of a dismissed toast.
const PAST_REMOVAL_MS = 400

function wait(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms)
	})
}

afterEach(async () => {
	act(() => {
		toast.dismiss()
	})
	await waitFor(() => {
		expect(document.querySelector("[data-sonner-toast]")).toBeNull()
	})
})

describe("update toast (real sonner)", () => {
	it("a held-back update answered right after Reload leaves the note up, without the Reload button", async () => {
		render(<Toaster theme="light" />)

		act(() => {
			showUpdateReadyToast()
		})

		const reload = await screen.findByRole("button", { name: "reload" })

		applyUpdate.mockImplementationOnce(() => {
			setTimeout(showUpdateDeferredToast, 5)
		})

		fireEvent.click(reload)
		expect(applyUpdate).toHaveBeenCalledTimes(1)

		await act(() => wait(PAST_REMOVAL_MS))

		const shown = document.querySelector("[data-sonner-toast]")

		expect(shown).not.toBeNull()
		expect(shown?.getAttribute("data-removed")).toBe("false")
		expect(screen.getByText("updateAfterDownload")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "reload" })).toBeNull()
	})

	it("Reload with nothing held back leaves the prompt up until the page reloads", async () => {
		render(<Toaster theme="light" />)

		act(() => {
			showUpdateReadyToast()
		})
		fireEvent.click(await screen.findByRole("button", { name: "reload" }))

		await act(() => wait(PAST_REMOVAL_MS))

		expect(screen.getByText("updateReadyBody")).toBeTruthy()
		expect(screen.getByRole("button", { name: "reload" })).toBeTruthy()
	})
})

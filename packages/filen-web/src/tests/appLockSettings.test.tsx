// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import type { DesktopLockAttempt, DesktopLockStatus } from "@filen/shared/desktop"
import "@/lib/i18n"

const desktop = vi.hoisted(() => ({
	bridge: {
		platform: "darwin",
		lock: {
			set: vi.fn<(pin: string, currentPin: string | null) => Promise<DesktopLockAttempt>>(),
			clear: vi.fn(),
			lock: vi.fn()
		}
	}
}))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => desktop.bridge }))

const { useDesktopLock } = await import("@/features/desktop/lib/lock")
const { AppLockSettings } = await import("@/features/desktop/components/appLockSettings")

const NONE: DesktopLockStatus = { enabled: false, locked: false, unreadable: false, retryAt: null, waitingForSecureStorage: false }
const WAITING = "Your PIN is kept in this computer's keychain or keyring, which Filen can't use right now."

beforeEach(() => {
	desktop.bridge.lock.set.mockReset()
})

afterEach(() => {
	cleanup()
	useDesktopLock.setState({ status: null, revealed: false, signingOut: false })
})

describe("app lock settings", () => {
	it("explains why no PIN can be set while one waits for secure storage", () => {
		useDesktopLock.setState({ status: { ...NONE, waitingForSecureStorage: true } })
		render(createElement(AppLockSettings))

		expect(screen.getByText(new RegExp(`^${WAITING}.*A new PIN can't be set until then\\.$`))).toBeTruthy()
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Set PIN" }).disabled).toBe(true)
	})

	it("offers setting a PIN otherwise", () => {
		useDesktopLock.setState({ status: NONE })
		render(createElement(AppLockSettings))

		expect(screen.queryByText(new RegExp(WAITING))).toBeNull()
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Set PIN" }).disabled).toBe(false)
	})

	it("says why main refused a first PIN, never that it was wrong", async () => {
		useDesktopLock.setState({ status: NONE })
		desktop.bridge.lock.set.mockResolvedValue({ ok: false, retryAt: null })
		render(createElement(AppLockSettings))

		fireEvent.click(screen.getByRole("button", { name: "Set PIN" }))
		fireEvent.change(await screen.findByLabelText("New PIN"), { target: { value: "1234" } })
		fireEvent.change(screen.getByLabelText("Confirm PIN"), { target: { value: "1234" } })
		fireEvent.click(screen.getByRole("button", { name: "Save PIN" }))

		await waitFor(() => {
			expect(screen.getByText(new RegExp(`^${WAITING}`))).toBeTruthy()
		})
		expect(desktop.bridge.lock.set).toHaveBeenCalledWith("1234", null)
		expect(screen.queryByText("Wrong PIN")).toBeNull()
	})
})

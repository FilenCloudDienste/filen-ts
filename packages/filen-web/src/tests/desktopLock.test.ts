import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopLockStatus } from "@filen/shared/desktop"

const desktop = vi.hoisted(() => {
	const state = { listener: null as ((status: DesktopLockStatus) => void) | null, calls: [] as string[] }
	const lock = {
		status: vi.fn<() => Promise<DesktopLockStatus>>(),
		onChanged: vi.fn((listener: (status: DesktopLockStatus) => void) => {
			state.listener = listener

			return () => undefined
		}),
		reset: vi.fn(() => {
			state.calls.push("reset")

			return Promise.resolve()
		})
	}

	return { state, bridge: { platform: "darwin", lock } }
})

const logout = vi.hoisted(() => ({
	performLogout: vi.fn((options: unknown) => {
		desktop.state.calls.push(`logout ${JSON.stringify(options)}`)

		return Promise.resolve(true)
	})
}))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => desktop.bridge }))
vi.mock("@/features/shell/lib/performLogout", () => logout)

const { isDesktopLocked, refreshDesktopLock, signOutFromLock, useDesktopLock } = await import("@/features/desktop/lib/lock")

const LOCKED: DesktopLockStatus = { enabled: true, locked: true, unreadable: false, retryAt: null }
const UNLOCKED: DesktopLockStatus = { ...LOCKED, locked: false }

beforeEach(() => {
	useDesktopLock.setState({ status: null, revealed: false, signingOut: false })
	desktop.state.calls = []
})

describe("desktop app lock mirror", () => {
	it("keeps the content unmounted until the first unlock, then only covers it", async () => {
		desktop.bridge.lock.status.mockResolvedValueOnce(LOCKED)
		await refreshDesktopLock()

		expect(useDesktopLock.getState()).toMatchObject({ status: LOCKED, revealed: false })
		expect(isDesktopLocked()).toBe(true)

		desktop.state.listener?.(UNLOCKED)
		expect(useDesktopLock.getState().revealed).toBe(true)
		expect(isDesktopLocked()).toBe(false)

		desktop.state.listener?.(LOCKED)
		expect(useDesktopLock.getState()).toMatchObject({ revealed: true, status: LOCKED })
	})

	it("fails closed when main does not answer", async () => {
		desktop.bridge.lock.status.mockRejectedValueOnce(new Error("ipc"))
		await refreshDesktopLock()

		expect(useDesktopLock.getState().status).toEqual({ enabled: true, locked: true, unreadable: true, retryAt: null })
	})

	it("signs out after main dropped the PIN, without revealing the content in between", async () => {
		desktop.bridge.lock.reset.mockImplementationOnce(() => {
			desktop.state.calls.push("reset")
			// Main reports the PIN gone before the reset resolves.
			desktop.state.listener?.({ enabled: false, locked: false, unreadable: false, retryAt: null })

			return Promise.resolve()
		})

		await signOutFromLock()

		expect(desktop.state.calls).toEqual(["reset", 'logout {"forced":true,"discardUnsaved":true}'])
		expect(useDesktopLock.getState()).toMatchObject({ revealed: false, signingOut: true })
		expect(isDesktopLocked()).toBe(true)
	})

	it("stays locked and signs nothing out when main cannot reset", async () => {
		desktop.bridge.lock.reset.mockRejectedValueOnce(new Error("vault"))

		await expect(signOutFromLock()).rejects.toThrow("vault")
		expect(logout.performLogout).not.toHaveBeenCalled()
		expect(useDesktopLock.getState().signingOut).toBe(false)
	})
})

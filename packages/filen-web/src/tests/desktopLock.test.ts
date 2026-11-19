// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
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
vi.mock("@/lib/storage/adapter", () => ({ kvGetJson: () => Promise.resolve(null), kvSetJson: () => Promise.resolve() }))
vi.mock("@/lib/storage/kvBestEffort", () => ({ kvLoadOnce: () => () => Promise.resolve(), kvSetJsonQuiet: vi.fn() }))
vi.mock("react-i18next", async importOriginal => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({
		t: (key: string, options?: { time?: string }) => (options?.time === undefined ? key : `${key} ${options.time}`)
	})
}))

const { isDesktopLocked, refreshDesktopLock, signOutFromLock, useDesktopLock } = await import("@/features/desktop/lib/lock")
const { DesktopLockGate } = await import("@/features/desktop/components/desktopLock")
const { registerAllActions } = await import("@/lib/keymap/actions")
const { clearUserCombo, keymapOverridesLoaded, setUserCombo, unbindAction } = await import("@/lib/keymap/registry")

// The lock screen lets the window's keys through by their combos in the registry.
registerAllActions()

const LOCKED: DesktopLockStatus = { enabled: true, locked: true, unreadable: false, retryAt: null, waitingForSecureStorage: false }
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

		expect(useDesktopLock.getState().status).toEqual({
			enabled: true,
			locked: true,
			unreadable: true,
			retryAt: null,
			waitingForSecureStorage: false
		})
	})

	it("signs out after main dropped the PIN, without revealing the content in between", async () => {
		desktop.bridge.lock.reset.mockImplementationOnce(() => {
			desktop.state.calls.push("reset")
			// Main reports the PIN gone before the reset resolves.
			desktop.state.listener?.({ enabled: false, locked: false, unreadable: false, retryAt: null, waitingForSecureStorage: false })

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

describe("desktop lock screen", () => {
	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	async function mountLocked(): Promise<void> {
		desktop.bridge.lock.status.mockResolvedValue(LOCKED)
		useDesktopLock.setState({ status: LOCKED })
		render(createElement(DesktopLockGate, null, null))

		await act(async () => {
			await Promise.resolve()
		})
	}

	function pushStatus(status: DesktopLockStatus): void {
		act(() => {
			desktop.state.listener?.(status)
		})
	}

	it("counts a backoff from the present, keeps its announcement still, and stops ticking at the deadline", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
		await mountLocked()

		// Minutes on the lock screen before the wrong PINs.
		act(() => {
			vi.advanceTimersByTime(5 * 60_000)
		})

		const baseline = vi.getTimerCount()

		pushStatus({ ...LOCKED, retryAt: Date.now() + 30_000 })

		expect(screen.getByRole("timer").textContent).toBe("lockRetryClock 0:30")

		const live = document.querySelector("[aria-live='polite']")

		expect(live?.textContent).toBe("lockTooManyPins")

		act(() => {
			vi.advanceTimersByTime(3_000)
		})

		expect(screen.getByRole("timer").textContent).toBe("lockRetryClock 0:27")
		expect(document.querySelector("[aria-live='polite']")).toBe(live)
		expect(live?.textContent).toBe("lockTooManyPins")

		act(() => {
			vi.advanceTimersByTime(30_000)
		})

		expect(screen.queryByRole("timer")).toBeNull()
		expect(live?.textContent).toBe("")
		expect(vi.getTimerCount()).toBe(baseline)
	})

	it("lets the window keys reach the document from the PIN field, and nothing else", async () => {
		await mountLocked()

		const input = screen.getByLabelText("lockPinLabel")
		const heard: string[] = []
		const listener = (event: KeyboardEvent) => {
			heard.push(`${event.ctrlKey ? "ctrl+" : ""}${event.altKey ? "alt+" : ""}${event.key}`)
		}

		document.addEventListener("keydown", listener)
		input.focus()

		const press = (init: KeyboardEventInit) => {
			input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
		}

		press({ key: "q", code: "KeyQ", ctrlKey: true })
		press({ key: "F11", code: "F11" })
		press({ key: "=", code: "Equal", ctrlKey: true })
		press({ key: "-", code: "Minus", ctrlKey: true })
		press({ key: "0", code: "Digit0", ctrlKey: true })
		// A layout whose "+" is another physical key: the zoom character still counts.
		press({ key: "+", code: "BracketRight", ctrlKey: true })
		press({ key: "5", code: "Digit5" })
		press({ key: "l", code: "KeyL", ctrlKey: true, altKey: true })
		press({ key: "w", code: "KeyW", ctrlKey: true })

		document.removeEventListener("keydown", listener)

		expect(heard).toEqual(["ctrl+q", "F11", "ctrl+=", "ctrl+-", "ctrl+0", "ctrl++"])
	})

	it("ends a backoff by the wall clock, as after a sleep past its deadline", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
		await mountLocked()

		fireEvent.change(screen.getByLabelText("lockPinLabel"), { target: { value: "1234" } })
		pushStatus({ ...LOCKED, retryAt: Date.now() + 60 * 60_000 })

		const unlock = screen.getByRole("button", { name: "lockUnlock" })
		const live = document.querySelector("[aria-live='polite']")

		expect(unlock).toHaveProperty("disabled", true)

		// The wall clock passes the deadline while the timers stood still; one tick after waking ends it.
		vi.setSystemTime(Date.now() + 61 * 60_000)
		act(() => {
			vi.advanceTimersByTime(1_000)
		})

		expect(unlock).toHaveProperty("disabled", false)
		expect(live?.textContent).toBe("")
		expect(screen.queryByRole("timer")).toBeNull()
	})

	it("keeps a zoom character the user bound to another action, or turned off, from the document", async () => {
		await keymapOverridesLoaded()
		await mountLocked()

		const input = screen.getByLabelText("lockPinLabel")
		const heard: string[] = []
		const listener = (event: KeyboardEvent) => {
			heard.push(`${event.ctrlKey ? "ctrl+" : ""}${event.shiftKey ? "shift+" : ""}${event.key}`)
		}
		const press = (init: KeyboardEventInit) => {
			input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
		}
		const zoomIn = { key: "=", code: "Equal", ctrlKey: true }

		document.addEventListener("keydown", listener)
		input.focus()

		try {
			await act(() => setUserCombo("office.print", "mod+equal"))
			press(zoomIn)
			expect(heard).toEqual([])
			await act(() => clearUserCombo("office.print"))

			await act(() => unbindAction("desktop.zoomIn"))
			press(zoomIn)
			expect(heard).toEqual([])

			// Rebound: exactly the user's keys, not the character.
			await act(() => setUserCombo("desktop.zoomIn", "mod+shift+u"))
			press(zoomIn)
			press({ key: "U", code: "KeyU", ctrlKey: true, shiftKey: true })
			expect(heard).toEqual(["ctrl+shift+U"])
		} finally {
			document.removeEventListener("keydown", listener)
			await act(() => clearUserCombo("office.print"))
			await act(() => clearUserCombo("desktop.zoomIn"))
		}
	})
})

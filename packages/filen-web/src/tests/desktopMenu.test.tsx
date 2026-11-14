// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { DesktopMenuAction } from "@filen/shared/desktop"

const desktop = vi.hoisted(() => {
	const state = { listener: null as ((action: string) => void) | null }
	const app = {
		setMenuShortcuts: vi.fn(),
		setSmoothTransitions: vi.fn(),
		onMenuAction: vi.fn((listener: (action: string) => void) => {
			state.listener = listener

			return () => undefined
		})
	}

	return { state, bridge: { platform: "darwin", app } }
})

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => desktop.bridge }))
vi.mock("@/lib/storage/kvBestEffort", () => ({ kvLoadOnce: () => () => Promise.resolve(), kvSetJsonQuiet: vi.fn() }))
vi.mock("@/lib/storage/preference", () => ({
	kvPreference: () => ({ get: () => new Promise(() => undefined), set: () => Promise.resolve() })
}))

const toast = vi.hoisted(() => ({ info: vi.fn() }))

vi.mock("sonner", () => ({ toast }))

const { registerAllActions } = await import("@/lib/keymap/actions")
const { useMenuAction } = await import("@/lib/keymap/desktopMenu")
const { useSmoothTransitionsStore } = await import("@/features/audio/store/useSmoothTransitionsStore")
const { toggleSmoothTransitionsByUser } = await import("@/features/audio/lib/smoothTransitionsUi")
const { reportSmoothTransitions } = await import("@/features/desktop/lib/mediaTransport")
const { DEFAULT_SMOOTH_TRANSITIONS_PREFS } = await import("@/features/audio/lib/smoothTransitions.types")

registerAllActions()

function click(action: DesktopMenuAction): void {
	desktop.state.listener?.(action)
}

describe("desktop menu actions", () => {
	it("subscribes with the first handler and reports the menu actions' combos", () => {
		renderHook(() => {
			useMenuAction("app.toggleTheme", vi.fn())
		})

		expect(desktop.bridge.app.onMenuAction).toHaveBeenCalledOnce()
		expect(desktop.bridge.app.setMenuShortcuts).toHaveBeenCalledWith({
			"app.openSettings": "mod+comma",
			"app.openShortcuts": "shift+slash",
			"app.toggleTheme": "d",
			"app.toggleAssistant": "",
			"app.openTransfers": "",
			"app.lock": "mod+alt+l",
			"desktop.close": "mod+w",
			"audio.playPause": "mod+alt+p",
			"audio.next": "mod+shift+arrowright",
			"audio.previous": "mod+shift+arrowleft",
			"audio.shuffle": "alt+shift+s",
			"audio.loop": "alt+shift+r",
			"audio.smoothTransitions": ""
		})
	})

	it("runs the handler of a clicked action", () => {
		const handler = vi.fn()

		renderHook(() => {
			useMenuAction("app.openSettings", handler)
		})
		click("app.openSettings")

		expect(handler).toHaveBeenCalledOnce()
	})

	it("ignores keymap actions the menu does not offer", () => {
		const handler = vi.fn()

		renderHook(() => {
			useMenuAction("drive.newDirectory", handler)
		})
		click("drive.newDirectory" as DesktopMenuAction)

		expect(handler).not.toHaveBeenCalled()
	})

	it("holds a click that arrives before its handler, briefly", () => {
		const handler = vi.fn()

		click("app.openTransfers")
		renderHook(() => {
			useMenuAction("app.openTransfers", handler)
		})

		expect(handler).toHaveBeenCalledOnce()
	})

	it("drops a held click once it is stale", () => {
		vi.useFakeTimers()

		const handler = vi.fn()

		click("app.toggleAssistant")
		vi.advanceTimersByTime(60_000)
		renderHook(() => {
			useMenuAction("app.toggleAssistant", handler)
		})

		expect(handler).not.toHaveBeenCalled()
		vi.useRealTimers()
	})

	it("holds every click that arrives before its handler, not only the last", () => {
		const settings = vi.fn()
		const shortcuts = vi.fn()

		click("app.openSettings")
		click("app.openShortcuts")
		renderHook(() => {
			useMenuAction("app.openSettings", settings)
			useMenuAction("app.openShortcuts", shortcuts)
		})

		expect(settings).toHaveBeenCalledOnce()
		expect(shortcuts).toHaveBeenCalledOnce()
	})
})

describe("desktop menu Smooth Transitions", () => {
	type Unavailable = ReturnType<typeof useSmoothTransitionsStore.getState>["unavailable"]

	function setSmooth(enabled: boolean, unavailable: Unavailable): void {
		useSmoothTransitionsStore.setState({ prefs: { ...DEFAULT_SMOOTH_TRANSITIONS_PREFS, enabled }, unavailable })
	}

	afterEach(() => {
		setSmooth(DEFAULT_SMOOTH_TRANSITIONS_PREFS.enabled, null)
		vi.clearAllMocks()
	})

	it("reports whether tracks blend now, only on a change, and off when stopped", () => {
		setSmooth(false, null)

		const stop = reportSmoothTransitions()

		setSmooth(true, null)
		setSmooth(true, null)
		setSmooth(true, "degraded")
		setSmooth(false, "degraded")
		setSmooth(true, null)
		stop()

		expect(desktop.bridge.app.setSmoothTransitions.mock.calls).toEqual([[true], [false], [true], [false]])
	})

	it("says why a click cannot turn it on, and keeps it off", () => {
		setSmooth(false, "degraded")
		renderHook(() => {
			useMenuAction("audio.smoothTransitions", toggleSmoothTransitionsByUser)
		})
		click("audio.smoothTransitions")

		expect(useSmoothTransitionsStore.getState().prefs.enabled).toBe(false)
		expect(toast.info).toHaveBeenCalledWith("Off until you reload: this device stopped the audio mixer.", {
			id: "smooth-transitions-unavailable"
		})
	})

	it("turns the stored pref off while unavailable, without a notice", () => {
		setSmooth(true, "sourceIneligible")
		renderHook(() => {
			useMenuAction("audio.smoothTransitions", toggleSmoothTransitionsByUser)
		})
		click("audio.smoothTransitions")

		expect(useSmoothTransitionsStore.getState().prefs.enabled).toBe(false)
		expect(toast.info).not.toHaveBeenCalled()
	})
})

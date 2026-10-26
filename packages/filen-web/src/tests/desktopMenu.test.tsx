// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { DesktopMenuAction } from "@filen/shared/desktop"

const desktop = vi.hoisted(() => {
	const state = { listener: null as ((action: string) => void) | null }
	const app = {
		setMenuShortcuts: vi.fn(),
		onMenuAction: vi.fn((listener: (action: string) => void) => {
			state.listener = listener

			return () => undefined
		})
	}

	return { state, bridge: { platform: "darwin", app } }
})

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => desktop.bridge }))
vi.mock("@/lib/storage/kvBestEffort", () => ({ kvLoadOnce: () => () => Promise.resolve(), kvSetJsonQuiet: vi.fn() }))

const { registerAllActions } = await import("@/lib/keymap/actions")
const { useMenuAction } = await import("@/lib/keymap/desktopMenu")

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
			"app.openSettings": "",
			"app.openShortcuts": "shift+slash",
			"app.toggleTheme": "d",
			"app.toggleAssistant": "",
			"app.openTransfers": ""
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
})

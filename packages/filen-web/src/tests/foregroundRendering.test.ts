// @vitest-environment jsdom

import type { DesktopBridge } from "@filen/shared/desktop"
import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
	vi.resetModules()
	Reflect.deleteProperty(window, "desktop")
})

describe("holdForegroundRendering", () => {
	it("is a no-op in a browser", async () => {
		const { holdForegroundRendering } = await import("@/lib/desktop")
		const release = holdForegroundRendering()

		expect(() => {
			release()
			release()
		}).not.toThrow()
	})

	it("reports every hold count change and counts a release once", async () => {
		const setForegroundRenderingHolds = vi.fn<DesktopBridge["app"]["setForegroundRenderingHolds"]>()

		Object.defineProperty(window, "desktop", {
			configurable: true,
			value: { platform: "darwin", app: { setForegroundRenderingHolds }, onWindowState: () => () => undefined }
		})

		const { holdForegroundRendering } = await import("@/lib/desktop")
		const releaseFirst = holdForegroundRendering()
		const releaseSecond = holdForegroundRendering()

		releaseFirst()
		releaseFirst()
		releaseSecond()

		expect(setForegroundRenderingHolds.mock.calls).toEqual([[1], [2], [1], [0]])
	})
})

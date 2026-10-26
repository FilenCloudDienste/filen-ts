import { describe, expect, it } from "vitest"
import { initialColors, TITLE_BAR_OVERLAY_HEIGHT, windowOptions } from "../main/window.ts"

const colors = initialColors(true)

describe("windowOptions", () => {
	it("keeps native traffic lights on macOS and draws no overlay", () => {
		const options = windowOptions("darwin", colors, "/p.cjs", false)

		expect(options.titleBarStyle).toBe("hidden")
		expect(options.trafficLightPosition).toEqual({ x: 14, y: 14 })
		expect(options.titleBarOverlay).toBeUndefined()
	})

	it.each(["win32", "linux"] as const)("uses the themed controls overlay on %s", platform => {
		const options = windowOptions(platform, colors, "/p.cjs", false)

		expect(options.titleBarOverlay).toEqual({ ...colors, height: TITLE_BAR_OVERLAY_HEIGHT })
		expect(options.trafficLightPosition).toBeUndefined()
	})

	it("always sandboxes the renderer", () => {
		expect(windowOptions("linux", colors, "/p.cjs", true).webPreferences).toMatchObject({
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false
		})
	})
})

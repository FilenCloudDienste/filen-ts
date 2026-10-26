import { describe, expect, it } from "vitest"
import { drawsOwnBorder, initialColors, TITLE_BAR_OVERLAY_HEIGHT, windowOptions } from "../main/window.ts"

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

		expect(options.titleBarOverlay).toEqual({ color: colors.color, symbolColor: colors.symbolColor, height: TITLE_BAR_OVERLAY_HEIGHT })
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

describe("drawsOwnBorder", () => {
	it.each([
		["win32", "10.0.19045", true],
		["win32", "10.0.22000", false],
		["win32", "10.0.26100", false],
		["darwin", "15.0.0", false],
		["linux", "6.8.0", false]
	] as const)("%s %s → %s", (platform, version, expected) => {
		expect(drawsOwnBorder(platform, version)).toBe(expected)
	})
})

describe("windowOptions accent colour", () => {
	it("tints the Windows 11 border only on Windows", () => {
		expect(windowOptions("win32", colors, "/p.cjs", false).accentColor).toBe(colors.border)
		expect(windowOptions("linux", colors, "/p.cjs", false).accentColor).toBeUndefined()
	})
})

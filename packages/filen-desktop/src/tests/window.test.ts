import { describe, expect, it } from "vitest"
import { type } from "arktype"
import { drawsOwnBorder, initialColors, TITLE_BAR_OVERLAY_HEIGHT, titleBarColorsSchema, windowOptions } from "../main/window.ts"

const colors = initialColors(true)

describe("windowOptions", () => {
	it("keeps native traffic lights on macOS and draws no overlay", () => {
		const options = windowOptions("darwin", colors, "/p.cjs", false, "4.0.0")

		expect(options.titleBarStyle).toBe("hidden")
		expect(options.trafficLightPosition).toEqual({ x: 14, y: 14 })
		expect(options.titleBarOverlay).toBeUndefined()
	})

	it.each(["win32", "linux"] as const)("uses the themed controls overlay on %s", platform => {
		const options = windowOptions(platform, colors, "/p.cjs", false, "4.0.0")

		expect(options.titleBarOverlay).toEqual({ color: colors.color, symbolColor: colors.symbolColor, height: TITLE_BAR_OVERLAY_HEIGHT })
		expect(options.trafficLightPosition).toBeUndefined()
	})

	it("always sandboxes the renderer", () => {
		expect(windowOptions("linux", colors, "/p.cjs", true, "4.0.0").webPreferences).toMatchObject({
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false
		})
	})
})

describe("windowOptions version", () => {
	it("hands the app version to the preload", () => {
		expect(windowOptions("darwin", colors, "/p.cjs", false, "4.0.0").webPreferences?.additionalArguments).toEqual([
			"--filen-app-version=4.0.0"
		])
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
		expect(windowOptions("win32", colors, "/p.cjs", false, "4.0.0").accentColor).toBe(colors.border)
		expect(windowOptions("linux", colors, "/p.cjs", false, "4.0.0").accentColor).toBeUndefined()
	})
})

describe("titleBarColorsSchema", () => {
	it("takes the colours the window and the page use", () => {
		for (const dark of [true, false]) {
			expect(titleBarColorsSchema(initialColors(dark))).toEqual(initialColors(dark))
		}

		expect(
			titleBarColorsSchema({ color: "rgb(0, 0, 0)", symbolColor: "rgb(255, 255, 255)", border: "rgb(9, 99, 199)" })
		).not.toBeInstanceOf(type.errors)
	})

	it.each(["rgb(256, 0, 0)", "rgb(0,0,0)", "rgb(01, 0, 0)", "rgba(0, 0, 0, 0.5)", "#000000", "red", "rgb(0, 0, 0) ", ""])(
		"refuses %j",
		color => {
			expect(titleBarColorsSchema({ ...initialColors(true), border: color })).toBeInstanceOf(type.errors)
		}
	)
})

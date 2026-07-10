import { describe, expect, it } from "vitest"
import { deriveSystemStripLayout, deriveMaximizeIconState } from "@/features/shell/lib/systemStrip.logic"

describe("deriveSystemStripLayout", () => {
	it("reserves the native traffic-light inset and renders no custom controls on darwin", () => {
		expect(deriveSystemStripLayout("darwin")).toEqual({ leftInsetPx: 72, showWindowControls: false })
	})

	it("renders custom window controls with no left inset on win32", () => {
		expect(deriveSystemStripLayout("win32")).toEqual({ leftInsetPx: 0, showWindowControls: true })
	})

	it("renders custom window controls with no left inset on linux", () => {
		expect(deriveSystemStripLayout("linux")).toEqual({ leftInsetPx: 0, showWindowControls: true })
	})
})

describe("deriveMaximizeIconState", () => {
	it("shows the maximize icon while not maximized", () => {
		expect(deriveMaximizeIconState(false)).toBe("maximize")
	})

	it("shows the restore icon once maximized", () => {
		expect(deriveMaximizeIconState(true)).toBe("restore")
	})
})

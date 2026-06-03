import { vi, describe, it, expect } from "vitest"

// quillTheme.ts imports Quill (browser-only) and Platform from react-native.
// Both are mocked here.
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("quill", () => ({
	default: class Quill {}
}))

import { getThemeOptions } from "@/components/textEditor/richText/quillTheme"
import type { Colors } from "@/components/textEditor"

function makeColors(overrides: Partial<{ foreground: string; muted: string; primary: string; primaryBg: string; secondaryBg: string }> = {}): Colors {
	return {
		text: {
			foreground: overrides.foreground ?? "#111111",
			muted: overrides.muted ?? "#888888",
			primary: overrides.primary ?? "#0000ff"
		},
		background: {
			primary: overrides.primaryBg ?? "#ffffff",
			secondary: overrides.secondaryBg ?? "#f0f0f0"
		}
	}
}

describe("getThemeOptions", () => {
	it("platform='ios' returns editorFontSize '14px' when font.size=14", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			readOnly: false,
			font: { size: 14 }
		})

		expect(result.editorFontSize).toBe("14px")
	})

	it("platform='android' returns a structurally identical shape (both branches share the same return shape)", () => {
		const iosResult = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			readOnly: false
		})

		const androidResult = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "android",
			readOnly: false
		})

		// Both must have the same keys
		expect(Object.keys(iosResult).sort()).toEqual(Object.keys(androidResult).sort())
	})

	it("font fallback: when font is undefined, editorFontFamily falls back to the system font stack string", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			readOnly: false
			// font intentionally omitted
		})

		expect(result.editorFontFamily).toBe("-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif")
	})

	it("font.lineHeight number is stringified correctly: 1.5 -> '1.5'", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			readOnly: false,
			font: { lineHeight: 1.5 }
		})

		expect(result.editorLineHeight).toBe("1.5")
	})

	it("font.lineHeight 2.0 -> '2'", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			readOnly: false,
			font: { lineHeight: 2.0 }
		})

		expect(result.editorLineHeight).toBe("2")
	})

	it("readOnly=true is forwarded as true into the returned object", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			readOnly: true
		})

		expect(result.readOnly).toBe(true)
	})

	it("readOnly=false is forwarded as false", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "android",
			readOnly: false
		})

		expect(result.readOnly).toBe(false)
	})

	it("colors.text.foreground maps to editorTextColor", () => {
		const colors = makeColors({ foreground: "#abcdef" })
		const result = getThemeOptions({ darkMode: false, colors, platform: "ios", readOnly: false })

		expect(result.editorTextColor).toBe("#abcdef")
	})

	it("colors.background.secondary maps to codeBackground", () => {
		const colors = makeColors({ secondaryBg: "#222222" })
		const result = getThemeOptions({ darkMode: false, colors, platform: "android", readOnly: false })

		expect(result.codeBackground).toBe("#222222")
	})

	it("font.size defaults to 14 when font is provided but size is missing", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			readOnly: false,
			font: { family: "monospace" }
		})

		expect(result.editorFontSize).toBe("14px")
	})

	it("font.family is forwarded as editorFontFamily when provided", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			readOnly: false,
			font: { family: "JetBrains Mono" }
		})

		expect(result.editorFontFamily).toBe("JetBrains Mono")
	})

	it("font.weight number is stringified correctly: 700 -> '700'", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			readOnly: false,
			font: { weight: 700 }
		})

		expect(result.editorFontWeight).toBe("700")
	})

	it("colors.text.primary maps to toolbarActiveColor", () => {
		const colors = makeColors({ primary: "#ff0000" })
		const result = getThemeOptions({ darkMode: false, colors, platform: "ios", readOnly: false })

		expect(result.toolbarActiveColor).toBe("#ff0000")
	})
})

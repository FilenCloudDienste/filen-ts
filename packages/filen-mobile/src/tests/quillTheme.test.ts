// @vitest-environment happy-dom

import { vi, describe, it, expect } from "vitest"

// quillTheme.ts imports Quill (browser-only) and Platform from react-native.
// Both are mocked here.
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("quill", () => ({
	default: class Quill {}
}))

import { getThemeOptions, QuillThemeCustomizer } from "@/components/textEditor/richText/quillTheme"
import type { Colors } from "@/components/textEditor"
import type Quill from "quill"

function makeColors(
	overrides: Partial<{
		foreground: string
		muted: string
		primary: string
		primaryBg: string
		secondaryBg: string
		accentBg: string
	}> = {}
): Colors {
	return {
		text: {
			foreground: overrides.foreground ?? "#111111",
			muted: overrides.muted ?? "#888888",
			primary: overrides.primary ?? "#0000ff"
		},
		background: {
			primary: overrides.primaryBg ?? "#ffffff",
			secondary: overrides.secondaryBg ?? "#f0f0f0",
			accent: overrides.accentBg ?? "#5e5ce6"
		}
	}
}

describe("getThemeOptions", () => {
	it("platform='ios' returns editorFontSize '14px' when font.size=14", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			font: { size: 14 }
		})

		expect(result.editorFontSize).toBe("14px")
	})

	it("platform='android' returns a structurally identical shape (both branches share the same return shape)", () => {
		const iosResult = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios"
		})

		const androidResult = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "android"
		})

		// Both must have the same keys
		expect(Object.keys(iosResult).sort()).toEqual(Object.keys(androidResult).sort())
	})

	it("font fallback: when font is undefined, editorFontFamily falls back to the system font stack string", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios"
			// font intentionally omitted
		})

		expect(result.editorFontFamily).toBe("-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif")
	})

	it("font.lineHeight number is stringified correctly: 1.5 -> '1.5'", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			font: { lineHeight: 1.5 }
		})

		expect(result.editorLineHeight).toBe("1.5")
	})

	it("font.lineHeight 2.0 -> '2'", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			font: { lineHeight: 2.0 }
		})

		expect(result.editorLineHeight).toBe("2")
	})

	it("colors.text.foreground maps to editorTextColor", () => {
		const colors = makeColors({ foreground: "#abcdef" })
		const result = getThemeOptions({ darkMode: false, colors, platform: "ios" })

		expect(result.editorTextColor).toBe("#abcdef")
	})

	it("colors.background.secondary maps to codeBackground", () => {
		const colors = makeColors({ secondaryBg: "#222222" })
		const result = getThemeOptions({ darkMode: false, colors, platform: "android" })

		expect(result.codeBackground).toBe("#222222")
	})

	it("font.size defaults to 14 when font is provided but size is missing", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			font: { family: "monospace" }
		})

		expect(result.editorFontSize).toBe("14px")
	})

	it("font.family is forwarded as editorFontFamily when provided", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			font: { family: "JetBrains Mono" }
		})

		expect(result.editorFontFamily).toBe("JetBrains Mono")
	})

	it("font.weight number is stringified correctly: 700 -> '700'", () => {
		const result = getThemeOptions({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			font: { weight: 700 }
		})

		expect(result.editorFontWeight).toBe("700")
	})

	it("keeps the code-block surface and the blockquote mark on separate colours", () => {
		// The code block sits on a neutral surface; the blockquote is a 4px border that has to stay
		// visible against an OLED-black background, so it uses the accent. Feeding both from one value
		// is what made code blocks render indigo.
		const colors = makeColors({ secondaryBg: "#1c1c1e", accentBg: "#5e5ce6" })

		for (const platform of ["ios", "android"] as const) {
			const result = getThemeOptions({ darkMode: true, colors, platform })

			expect(result.codeBackground).toBe("#1c1c1e")
			expect(result.blockquoteBorderColor).toBe("#5e5ce6")
		}
	})

	it("colors.text.primary maps to toolbarActiveColor", () => {
		const colors = makeColors({ primary: "#ff0000" })
		const result = getThemeOptions({ darkMode: false, colors, platform: "ios" })

		expect(result.toolbarActiveColor).toBe("#ff0000")
	})

	it("carries the host's padding on BOTH platforms", () => {
		// Duplicated return objects: a padding wired into one branch and not the other would leave
		// exactly one platform with a document that cannot clear the keyboard (#102).
		for (const platform of ["ios", "android"] as const) {
			const result = getThemeOptions({
				darkMode: false,
				colors: makeColors(),
				platform,
				paddingTop: 96,
				paddingBottom: 34
			})

			expect(result.editorPaddingTop).toBe("96px")
			expect(result.editorPaddingBottom).toBe("34px")
		}
	})

	it("omits padding longhands when the host supplies none", () => {
		const result = getThemeOptions({ darkMode: false, colors: makeColors(), platform: "ios" })

		expect(result.editorPaddingTop).toBeUndefined()
		expect(result.editorPaddingBottom).toBeUndefined()
		expect(result.editorPadding).toBe("16px")
	})
})

describe("QuillThemeCustomizer padding placement (#102)", () => {
	// .ql-editor IS the scroller (quill.snow.css: height 100%, overflow-y auto). Padding there scrolls
	// with the document; padding on the container around it is a strip the text can never move
	// through, which is what left the caret stranded under the keyboard.
	function css(options: Parameters<typeof getThemeOptions>[0]): string {
		document.head.replaceChildren()

		new QuillThemeCustomizer(getThemeOptions(options)).apply({} as unknown as Quill)

		return document.getElementById("quill-custom-styles")?.textContent ?? ""
	}

	it("puts the host's padding on .ql-editor, never on .ql-container", () => {
		const generated = css({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			paddingTop: 96,
			paddingBottom: 34
		})

		expect(generated).toContain(".ql-editor { padding-top: 96px !important; }")
		expect(generated).toContain(".ql-editor { padding-bottom: 34px !important; }")

		for (const rule of generated.split("}")) {
			if (/padding-(top|bottom)\s*:/.test(rule)) {
				expect(rule).toContain(".ql-editor")
				expect(rule).not.toContain(".ql-container")
			}
		}
	})

	it("emits the longhands AFTER the shorthand so they win", () => {
		// Both carry !important at equal specificity, so source order is the only thing deciding
		// which one applies.
		const generated = css({
			darkMode: false,
			colors: makeColors(),
			platform: "ios",
			paddingBottom: 34
		})

		expect(generated.indexOf("padding: 16px")).toBeLessThan(generated.indexOf("padding-bottom: 34px"))
	})
})

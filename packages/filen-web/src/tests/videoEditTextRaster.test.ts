import { describe, expect, it } from "vitest"
import {
	layoutText,
	parseHexColor,
	pillColor,
	textDirection,
	textFont,
	textRasterKey,
	wrapLines,
	type Segmenters
} from "@/features/preview/videoEdit/gl/textRaster.logic"
import type { TextOverlay } from "@/features/preview/videoEdit/types"

const words = new Intl.Segmenter("en", { granularity: "word" })
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" })
const SEGMENTERS: Segmenters = {
	words: text => Array.from(words.segment(text), part => part.segment),
	graphemes: text => Array.from(graphemes.segment(text), part => part.segment)
}

// Every grapheme is 10 px wide.
function measure(text: string): number {
	return Array.from(graphemes.segment(text)).length * 10
}

describe("textDirection", () => {
	it("follows the first strong letter", () => {
		expect(textDirection("Hello")).toBe("ltr")
		expect(textDirection("שלום world")).toBe("rtl")
		expect(textDirection("123 مرحبا")).toBe("rtl")
		expect(textDirection("  42 hello مرحبا")).toBe("ltr")
		expect(textDirection("😀 123")).toBe("ltr")
	})
})

describe("wrapLines", () => {
	it("breaks at word boundaries and drops the space a line breaks at", () => {
		expect(wrapLines("the quick brown fox", 110, measure, SEGMENTERS)).toEqual(["the quick", "brown fox"])
	})

	it("keeps explicit line breaks, empty lines included", () => {
		expect(wrapLines("one\n\ntwo", 1000, measure, SEGMENTERS)).toEqual(["one", "", "two"])
	})

	it("breaks a word wider than a line between graphemes, never inside an emoji sequence", () => {
		const family = "👨‍👩‍👧"

		expect(wrapLines(`abcdef${family}gh`, 40, measure, SEGMENTERS)).toEqual(["abcd", `ef${family}`, "gh"])
		expect(wrapLines(`abc${family}${family}${family}${family}${family}`, 40, measure, SEGMENTERS)).toEqual([
			`abc${family}`,
			`${family}${family}${family}${family}`
		])
	})

	it("wraps scripts written without spaces where their words break", () => {
		const lines = wrapLines("今日はいい天気ですね", 40, measure, SEGMENTERS)

		expect(lines.join("")).toBe("今日はいい天気ですね")
		expect(lines.every(line => measure(line) <= 40)).toBe(true)
	})
})

describe("layoutText", () => {
	it("sizes the font from the output height and the box from its lines", () => {
		const layout = layoutText({ text: "hello world", size: 0.05 }, { width: 1920, height: 1080 }, measure, SEGMENTERS)

		expect(layout.fontPx).toBe(54)
		expect(layout.lines).toEqual(["hello world"])
		expect(layout.width).toBe(110 + 2 * layout.padX)
		expect(layout.height).toBe(layout.lineHeight + 2 * layout.padY)
		expect(layout.direction).toBe("ltr")
	})

	it("wraps to the frame's width", () => {
		const layout = layoutText({ text: "aaaa bbbb cccc", size: 0.1 }, { width: 120, height: 100 }, measure, SEGMENTERS)

		expect(layout.lines.length).toBeGreaterThan(1)
		expect(layout.width).toBeLessThanOrEqual(120)
	})
})

describe("textRasterKey", () => {
	const base = { id: "a", text: "hi", startSec: 0, endSec: 1, x: 0.5, y: 0.5, size: 0.1, color: "#ffffff", background: true }

	it("changes with the content, the look and the output size", () => {
		const key = textRasterKey(base, { width: 1920, height: 1080 })

		expect(textRasterKey({ ...base, text: "ho" }, { width: 1920, height: 1080 })).not.toBe(key)
		expect(textRasterKey({ ...base, color: "#000000" }, { width: 1920, height: 1080 })).not.toBe(key)
		expect(textRasterKey({ ...base, background: false }, { width: 1920, height: 1080 })).not.toBe(key)
		expect(textRasterKey(base, { width: 1280, height: 720 })).not.toBe(key)
	})

	it("ignores position and timing", () => {
		const moved: TextOverlay = { ...base, x: 0.1, y: 0.9, startSec: 4, endSec: 9 }

		expect(textRasterKey(moved, { width: 1920, height: 1080 })).toBe(textRasterKey(base, { width: 1920, height: 1080 }))
	})
})

describe("colours", () => {
	it("parses hex colours", () => {
		expect(parseHexColor("#fff")).toEqual([1, 1, 1])
		expect(parseHexColor("#00ff0080")).toEqual([0, 1, 0])
		expect(parseHexColor("red")).toBeNull()
	})

	it("puts a dark pill under light text and a light one under dark text", () => {
		expect(pillColor("#ffffff")).toBe("rgba(0, 0, 0, 0.6)")
		expect(pillColor("#ffd400")).toBe("rgba(0, 0, 0, 0.6)")
		expect(pillColor("#000000")).toBe("rgba(255, 255, 255, 0.85)")
		expect(pillColor("#1a237e")).toBe("rgba(255, 255, 255, 0.85)")
	})

	it("names the system font stack with emoji faces", () => {
		expect(textFont(40)).toMatch(/^600 40px system-ui,.*"Apple Color Emoji"/)
	})
})

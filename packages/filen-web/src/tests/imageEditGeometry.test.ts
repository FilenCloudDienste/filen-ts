// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { textBox } from "@/features/preview/imageEdit/components/editorGeometry"
import { markupFontSpec, measureMarkupText } from "@/features/preview/imageEdit/components/markupStyle"

// A markup text item's box on screen (its hit box for re-editing and erasing) is as wide as its glyphs measure, and
// the page measures in the face the render worker draws with.

// One em a grapheme, as CJK and emoji draw; 0.5 em for anything ASCII.
function measure(text: string, px: number): number {
	let width = 0

	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		width += (segment.codePointAt(0) ?? 0) < 0x80 ? px * 0.5 : px
	}

	return width
}

describe("textBox", () => {
	it("is as wide as the measure says, so wide glyphs give a wider box", () => {
		const latin = textBox([10, 20], "abcd", 20, measure)
		const cjk = textBox([10, 20], "日本語の", 20, measure)

		expect(latin).toEqual({ left: 10, top: 20, width: 40, height: 24 })
		expect(cjk.width).toBe(80)
	})

	it("counts an emoji as the measure does, not by its UTF-16 length", () => {
		expect(textBox([0, 0], "👍", 20, measure).width).toBe(20)
	})

	it("keeps an empty item 0.6 em wide", () => {
		expect(textBox([0, 0], "", 20, measure).width).toBe(12)
	})
})

describe("measureMarkupText", () => {
	it("measures with the worker's font at the size asked", () => {
		const fonts: string[] = []
		const context = {
			font: "",
			measureText: vi.fn((text: string) => {
				fonts.push(context.font)

				return { width: text.length * 7 } as TextMetrics
			})
		}

		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D)

		expect(measureMarkupText("WWW", 30)).toBe(21)
		expect(measureMarkupText("i", 12)).toBe(7)
		expect(fonts).toEqual([markupFontSpec(30), markupFontSpec(12)])
		expect(markupFontSpec(30)).toBe('600 30px "Inter Variable", sans-serif')
	})
})

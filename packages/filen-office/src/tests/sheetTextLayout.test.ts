import { describe, expect, it } from "vitest"
import type { SheetRenderStyle } from "../core/sheet/protocol"
import { layoutText, TextMeasurer, type LayoutOptions, type TextLine } from "../react/sheet/paint/text"
import { RecordingCanvas, fontPx } from "./sheetGridCanvas"

// Widths that differ per character, so a break point cannot be guessed from a count.
class UnevenCanvas extends RecordingCanvas {
	override measureText(text: string): { readonly width: number } {
		this.measured++

		let width = 0

		for (const char of text) width += (char === "i" ? 0.3 : char === "W" ? 1.1 : char === "😀" ? 1.4 : 0.6) * fontPx(this.font)

		return { width }
	}
}

const STYLE: SheetRenderStyle = {}

function options(width: number): LayoutOptions {
	return { wrap: true, width, base: STYLE, fallback: "sans-serif", scale: 1 }
}

function texts(lines: readonly TextLine[]): string[] {
	return lines.map(line => line.fragments.map(fragment => fragment.text).join(""))
}

// The break a character-by-character walk finds: the longest prefix that fits, at least one code point.
function naiveBreak(canvas: RecordingCanvas, word: string, width: number): string[] {
	const out: string[] = []
	let chunk = ""

	for (const char of word) {
		if (chunk !== "" && canvas.measureText(chunk + char).width > width) {
			out.push(chunk)
			chunk = ""
		}

		chunk += char
	}

	out.push(chunk)

	return out
}

describe("sheet text layout of a word longer than the line", () => {
	it("breaks where a character-by-character walk breaks, never inside a surrogate pair", () => {
		const unit = "abcWiiiW😀xyzWWiq"
		const word = unit.repeat(40)
		const reference = new UnevenCanvas()

		reference.font = "14.67px sans-serif"

		const expected = naiveBreak(reference, word, 61)
		const canvas = new UnevenCanvas()
		const lines = layoutText(new TextMeasurer(canvas), word, null, STYLE, options(61))

		expect(texts(lines)).toEqual(expected)

		for (const line of lines) {
			expect(line.width).toBeCloseTo(canvas.measureText(line.fragments[0]?.text ?? "").width, 6)
		}
	})

	it("keeps the spaces after a broken word on its last line", () => {
		const canvas = new RecordingCanvas()
		const lines = layoutText(new TextMeasurer(canvas), `${"a".repeat(28)}   b`, null, STYLE, options(82))

		expect(texts(lines)).toEqual(["a".repeat(10), "a".repeat(10), "aaaaaaaa   ", "b"])
	})

	it("measures a 32k-character word in a few calls per line and keeps other widths cached", () => {
		const canvas = new RecordingCanvas()
		const measurer = new TextMeasurer(canvas)
		const font = "14.67px sans-serif"
		const others = Array.from({ length: 200 }, (_, i) => `cell ${String(i)}`)

		for (const text of others) measurer.width(font, text)

		// Pseudo-random letters, so no line's text repeats another's.
		let seed = 1
		const word = Array.from({ length: 32767 }, () => {
			seed = (seed * 1103515245 + 12345) % 2147483648

			return String.fromCharCode(97 + (seed % 26))
		}).join("")
		const before = canvas.measured
		const lines = layoutText(measurer, word, null, STYLE, options(120))
		const calls = canvas.measured - before

		expect(lines.length).toBeGreaterThan(2000)
		expect(texts(lines).join("")).toBe(word)
		expect(calls).toBeLessThanOrEqual(lines.length * 3 + 16)

		const kept = canvas.measured

		for (const text of others) measurer.width(font, text)

		expect(canvas.measured).toBe(kept)
	})
})

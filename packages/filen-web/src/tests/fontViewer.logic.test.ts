import { describe, expect, it } from "vitest"
import type { FontInfo } from "@filen/office/core/fonts"
import {
	codePointAt,
	codePointLabel,
	defaultSample,
	displayableRuns,
	fontEmbedding,
	glyphIndex,
	variationSettings
} from "@/features/preview/components/fontViewer.logic"

function info(names: FontInfo["names"]): FontInfo {
	return {
		container: "sfnt",
		outlines: "trueType",
		glyphCount: 1,
		unitsPerEm: 1000,
		weight: 400,
		italic: false,
		fsType: 0,
		names,
		axes: [],
		codePoints: new Uint32Array(0),
		codePointCount: 0
	}
}

describe("font viewer logic", () => {
	it("drops controls and surrogates from the runs, splitting a run around them", () => {
		expect([...displayableRuns(Uint32Array.of(0x0, 0x41, 0x7e, 0xa0, 0xd000, 0xe000))]).toEqual([
			0x20, 0x41, 0x7e, 0x7e, 0xa0, 0xa0, 0xd000, 0xd7ff, 0xe000, 0xe000
		])
	})

	it("finds the code point at a flattened index", () => {
		const index = glyphIndex(Uint32Array.of(0x41, 0x43, 0x61, 0x61, 0x4e00, 0x4e01))

		expect(index.count).toBe(6)
		expect([0, 2, 3, 4, 5].map(at => codePointAt(index, at))).toEqual([0x41, 0x43, 0x61, 0x4e00, 0x4e01])
		expect(codePointAt(index, 6)).toBe(-1)
		expect(codePointAt(index, -1)).toBe(-1)
	})

	it("defaults the specimen to the font's sample text, the pangram it draws, else its first glyphs", () => {
		const latin = glyphIndex(Uint32Array.of(0x20, 0x7e))
		const han = glyphIndex(Uint32Array.of(0x4e00, 0x4e02))
		const pangram = "The quick brown fox"

		expect(defaultSample(info([{ id: 19, value: "Own sample" }]), latin, pangram)).toBe("Own sample")
		expect(defaultSample(info([]), latin, pangram)).toBe(pangram)
		expect(defaultSample(info([]), han, pangram)).toBe("一丁丂")
		expect(defaultSample(null, han, pangram)).toBe(pangram)
	})

	it("labels code points and builds variation settings", () => {
		expect(codePointLabel(0x41)).toBe("U+0041")
		expect(codePointLabel(0x1f600)).toBe("U+1F600")
		expect(variationSettings(new Map())).toBe("normal")
		expect(
			variationSettings(
				new Map([
					["wght", 700],
					["wdth", 87.5]
				])
			)
		).toBe('"wght" 700, "wdth" 87.5')
	})

	it("reads the most restrictive embedding bit", () => {
		expect(fontEmbedding(0)).toBe("installable")
		expect(fontEmbedding(0x2 | 0x8)).toBe("restricted")
		expect(fontEmbedding(0x4)).toBe("previewPrint")
		expect(fontEmbedding(0x8)).toBe("editable")
	})
})

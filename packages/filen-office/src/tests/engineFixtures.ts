import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import type { DocxEngineServices } from "@filen/office/dom/docx"

// The text measurer and engine services of tests without font files: every font measures half its size per
// character, ascends 0.8 and descends 0.2 of it. Free of node imports, so DOM tests may use it too.

function sizeOf(font: string): number {
	return Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")
}

export const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = sizeOf(font)

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = sizeOf(font)

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

// Engine services over `measurer` with no fonts to load; by default every slice runs to its end without a pause.
// A suite that counts or spaces its pauses passes its own `yield` and `sliceMs`.
export function engineServices(overrides: Partial<DocxEngineServices> = {}): DocxEngineServices {
	return {
		fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
		replayFonts: false,
		fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
		measurer,
		yield: () => Promise.resolve(),
		sliceMs: Infinity,
		...overrides
	}
}

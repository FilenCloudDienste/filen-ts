import { DEFAULT_BODY_PR } from "../presentation/inherit"
import type { RunProps } from "../presentation/model"
import { fontRequests, layoutBody, type TextEnvironment } from "../presentation/text/body"
import type { ResolvedBody, TextFonts } from "../presentation/text/resolve"
import type { FontRequest } from "../fonts/index"
import { LINE_FLOATS, LineFloat, type TextLayout } from "../text/index"

// Text measurement for the tx algorithm. The layout engine sizes text only to choose font sizes and to know when a
// node overflows, so it measures through a narrow interface; the presentation worker backs it with the slide text
// adapter (core/presentation/text layoutBody), so the sizes the diagram settles on are the ones the slide draws.

// The height in EMU of `text` (paragraphs joined by "\n") set at `fontPt` and wrapped at `width` EMU, and its widest
// line or unbreakable word, whichever is wider (a word wider than the box does not fit even when the line breaker
// splits it).
export interface TextMeasurer {
	measure(text: string, fontPt: number, width: number): { readonly width: number; readonly height: number }
}

const EMU_PX = 9525
// Widest words are measured once per text at this size and scaled: advances are linear in the size.
const REFERENCE_PT = 100
const MAX_WORD_CACHE = 4096
const MAX_ANSWERS = 16384

export interface SmartArtTextOptions {
	// The run properties diagram text takes (the style's typeface, bold): the minor theme font when absent.
	readonly rPr?: RunProps
}

function body(text: string, fontPt: number, wrap: boolean, fonts: TextFonts, rPr: RunProps): ResolvedBody {
	const run: RunProps = {
		latin: { typeface: "+mn-lt" },
		ea: { typeface: "+mn-ea" },
		cs: { typeface: "+mn-cs" },
		...rPr,
		sz: Math.round(fontPt * 100)
	}
	const paragraphs = text.split("\n").map(line => ({
		level: 0,
		pPr: { algn: "ctr" as const },
		runs: line === "" ? [] : [{ kind: "r" as const, text: line, rPr: run }],
		endRPr: run,
		defRPr: run
	}))

	return {
		bodyPr: { ...DEFAULT_BODY_PR, insets: { left: 0, top: 0, right: 0, bottom: 0 }, wrap, autofit: "none" },
		paragraphs,
		fonts
	}
}

// The fonts a diagram's texts draw with, to prepare before layout (TextEnvironment.fonts resolves synchronously).
export function smartArtFontRequests(texts: readonly string[], fonts: TextFonts, options: SmartArtTextOptions = {}): FontRequest[] {
	const out = new Map<string, FontRequest>()

	for (const text of texts) {
		for (const request of fontRequests(body(text, 18, true, fonts, options.rPr ?? {}))) out.set(JSON.stringify(request), request)
	}

	return [...out.values()]
}

function widestLine(layout: TextLayout, start: number): number {
	let widest = start

	for (let line = 0; line < layout.lineCount; line++)
		widest = Math.max(widest, layout.lineFloats[line * LINE_FLOATS + LineFloat.WIDTH] ?? 0)

	return widest
}

// A measurer over the slide text adapter.
export function textAdapterMeasurer(env: TextEnvironment, fonts: TextFonts, options: SmartArtTextOptions = {}): TextMeasurer {
	const rPr = options.rPr ?? {}
	const words = new Map<string, number>()

	const widestWord = (text: string): number => {
		let width = words.get(text)

		if (width === undefined) {
			// One word per paragraph, unwrapped: the widest line is the widest word.
			const list = text.split(/\s+/u).filter(word => word !== "")
			const laid = layoutBody(body(list.join("\n"), REFERENCE_PT, false, fonts, rPr), { width: 1e7, height: 1e7 }, env).layout

			width = widestLine(laid, 0)

			if (words.size >= MAX_WORD_CACHE) words.clear()

			words.set(text, width)
		}

		return width
	}

	// Rule relaxation and font fitting ask the same questions again as they bisect: the answers are kept.
	const answers = new Map<string, { readonly width: number; readonly height: number }>()

	return {
		measure(text, fontPt, width) {
			const key = `${fontPt}\u0000${Math.round(width)}\u0000${text}`
			let answer = answers.get(key)

			if (answer === undefined) {
				const box = { width: Math.max(0, width / EMU_PX), height: 1e7 }
				const result = layoutBody(body(text, fontPt, true, fonts, rPr), box, env)
				const widest = widestLine(result.layout, (widestWord(text) * fontPt) / REFERENCE_PT)

				answer = { width: widest * EMU_PX, height: result.height * EMU_PX }

				if (answers.size >= MAX_ANSWERS) answers.clear()

				answers.set(key, answer)
			}

			return answer
		}
	}
}

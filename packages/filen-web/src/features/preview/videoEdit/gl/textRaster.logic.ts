import type { TextOverlay } from "@/features/preview/videoEdit/types"

// A text box's layout, canvas-free: its font size in output pixels, its writing direction, its lines wrapped to the
// frame, the box around them and the raster's cache key. textRaster.ts draws what this lays out.

// The platform's own UI faces, then its colour emoji faces, so any script and emoji the system can show render.
export const TEXT_FONT_STACK =
	'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"'

export const TEXT_FONT_WEIGHT = 600

// Line pitch, and the pill's padding, as multiples of the font size.
const LINE_HEIGHT = 1.25
const PAD_X = 0.6
const PAD_Y = 0.3

// A box may span this fraction of the frame's width before its text wraps.
const MAX_WIDTH_FRACTION = 0.9

// A raster never exceeds this edge, whatever the output (a texture every GPU takes).
export const MAX_RASTER_EDGE = 4096

export interface TextLayout {
	fontPx: number
	direction: "ltr" | "rtl"
	lines: string[]
	lineHeight: number
	padX: number
	padY: number
	width: number
	height: number
}

// Scripts written right to left (Unicode bidi class R / AL).
const RTL_LETTER =
	/[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u
const LETTER = /\p{L}/u

// The direction of the first strong letter (UAX #9 rule P2), left to right when there is none.
export function textDirection(text: string): "ltr" | "rtl" {
	for (const char of text) {
		if (RTL_LETTER.test(char)) {
			return "rtl"
		}

		if (LETTER.test(char)) {
			return "ltr"
		}
	}

	return "ltr"
}

export function textFontPx(size: number, outHeight: number): number {
	return Math.max(1, Math.round(size * outHeight))
}

export function textFont(fontPx: number): string {
	return `${String(TEXT_FONT_WEIGHT)} ${String(fontPx)}px ${TEXT_FONT_STACK}`
}

export interface Segmenters {
	// Break opportunities between words (spaces kept with the word before).
	words: (text: string) => Iterable<string>
	// User-perceived characters, for a word wider than a line.
	graphemes: (text: string) => Iterable<string>
}

// Greedy wrapping of each paragraph to `maxWidth` at word boundaries (Intl.Segmenter, so scripts without spaces
// break where their words do); a word longer than a line is broken between graphemes, never inside one (an emoji
// sequence stays whole). Trailing spaces do not count toward a line's width.
export function wrapLines(text: string, maxWidth: number, measure: (text: string) => number, segmenters: Segmenters): string[] {
	const lines: string[] = []

	for (const paragraph of text.split(/\r\n|\r|\n/)) {
		let line = ""

		const push = (): void => {
			lines.push(line.trimEnd())
			line = ""
		}

		for (const word of segmenters.words(paragraph)) {
			const candidate = line + word

			if (measure(candidate.trimEnd()) <= maxWidth) {
				line = candidate

				continue
			}

			if (line !== "") {
				push()
			}

			// A new line starts at the word, not at the space before it.
			const start = word.trimStart()

			if (measure(start.trimEnd()) <= maxWidth) {
				line = start

				continue
			}

			// A word wider than a whole line: broken between graphemes.
			for (const grapheme of segmenters.graphemes(start)) {
				if (line !== "" && measure((line + grapheme).trimEnd()) > maxWidth) {
					push()
				}

				line += grapheme
			}
		}

		push()
	}

	return lines
}

export function layoutText(
	overlay: Pick<TextOverlay, "text" | "size">,
	out: { width: number; height: number },
	measure: (text: string, fontPx: number) => number,
	segmenters: Segmenters
): TextLayout {
	const fontPx = textFontPx(overlay.size, out.height)
	const padX = Math.round(fontPx * PAD_X)
	const padY = Math.round(fontPx * PAD_Y)
	const lineHeight = Math.round(fontPx * LINE_HEIGHT)
	const maxWidth = Math.max(fontPx, out.width * MAX_WIDTH_FRACTION - 2 * padX)
	const lines = wrapLines(overlay.text, maxWidth, text => measure(text, fontPx), segmenters)
	const textWidth = Math.max(0, ...lines.map(line => measure(line, fontPx)))

	return {
		fontPx,
		direction: textDirection(overlay.text),
		lines,
		lineHeight,
		padX,
		padY,
		width: Math.min(MAX_RASTER_EDGE, Math.ceil(textWidth) + 2 * padX),
		height: Math.min(MAX_RASTER_EDGE, lines.length * lineHeight + 2 * padY)
	}
}

// What the raster depends on: the box's content and look, and the output it is sized for. Position and timing are not
// part of it, so dragging or retiming a box never re-rasterises it.
export function textRasterKey(
	overlay: Pick<TextOverlay, "text" | "size" | "color" | "background">,
	out: { width: number; height: number }
): string {
	return JSON.stringify([overlay.text, overlay.size, overlay.color, overlay.background, out.width, out.height])
}

// A colour from `#rgb`, `#rrggbb` or `#rrggbbaa`, as 0..1 channels; null for anything else.
export function parseHexColor(color: string): [number, number, number] | null {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim())?.[1]

	if (hex === undefined) {
		return null
	}

	const full = hex.length === 3 ? hex.replace(/./g, digit => digit + digit) : hex.slice(0, 6)

	return [0, 2, 4].map(at => Number.parseInt(full.slice(at, at + 2), 16) / 255) as [number, number, number]
}

// The pill behind a box: dark under light text, light under dark text (relative luminance, WCAG 2.x), translucent.
export function pillColor(textColor: string): string {
	const rgb = parseHexColor(textColor)

	if (rgb === null) {
		return "rgba(0, 0, 0, 0.6)"
	}

	const linear = rgb.map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
	const luminance = 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)

	return luminance > 0.18 ? "rgba(0, 0, 0, 0.6)" : "rgba(255, 255, 255, 0.85)"
}

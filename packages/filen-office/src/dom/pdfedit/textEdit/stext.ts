import type * as Mupdf from "mupdf"
import type { PdfFontTraits } from "../../../core/pdfedit/fontMatch"

// A page's structured text (content streams only: annotations and form fields are not part of the page's text) as
// plain arrays, for hit-testing and for comparing the text before and after an edit. Spaces are only the document's
// own (inhibit-spaces): the comparison must not see spaces MuPDF invents from gaps, which change with the neighbours.

// MuPDF quad order: upper-left, upper-right, lower-left, lower-right (x, y each), display space.
export type PdfQuad = readonly [number, number, number, number, number, number, number, number]

export type PdfRect = readonly [number, number, number, number]

export interface StextChar {
	readonly c: string
	// Pen position on the baseline, display space.
	readonly x: number
	readonly y: number
	readonly quad: PdfQuad
	readonly size: number
	// Index into StextPage.fonts.
	readonly font: number
	// 0xRRGGBB.
	readonly color: number
	// Bidi level MuPDF resolved (odd: right to left).
	readonly bidi: number
}

export interface StextLine {
	readonly wmode: number
	readonly dir: readonly [number, number]
	readonly bbox: PdfRect
	readonly chars: StextChar[]
}

export interface StextBlock {
	readonly bbox: PdfRect
	readonly lines: StextLine[]
}

export interface StextVector {
	readonly bbox: PdfRect
	readonly rectangle: boolean
}

export interface StextPage {
	readonly blocks: StextBlock[]
	readonly fonts: PdfFontTraits[]
	readonly vectors: StextVector[]
}

const TEXT_OPTIONS = "preserve-whitespace,inhibit-spaces"

export function readStext(page: Mupdf.PDFPage, vectors: boolean = false): StextPage {
	const list = page.toDisplayList(false)
	const stext = list.toStructuredText(vectors ? `${TEXT_OPTIONS},vectors` : TEXT_OPTIONS)
	const blocks: StextBlock[] = []
	const fonts: PdfFontTraits[] = []
	const fontIndex = new Map<string, number>()
	const found: StextVector[] = []
	let block: StextBlock | null = null
	let line: StextLine | null = null

	try {
		stext.walk({
			beginTextBlock: bbox => {
				block = { bbox: rect(bbox), lines: [] }
				blocks.push(block)
			},
			beginLine: (bbox, wmode, dir) => {
				line = { wmode, dir: [dir[0], dir[1]], bbox: rect(bbox), chars: [] }
				;(block ?? pushBlock(blocks, bbox)).lines.push(line)
			},
			onChar: (c, origin, font, size, quad, color, bidi) => {
				const name = font.getName()
				let index = fontIndex.get(name)

				if (index === undefined) {
					index = fonts.length
					fonts.push({ name, bold: font.isBold(), italic: font.isItalic(), serif: font.isSerif(), mono: font.isMono() })
					fontIndex.set(name, index)
				}

				line?.chars.push({
					c,
					x: origin[0],
					y: origin[1],
					quad: [quad[0], quad[1], quad[2], quad[3], quad[4], quad[5], quad[6], quad[7]],
					size,
					font: index,
					color: rgb(color),
					bidi
				})
			},
			endLine: () => {
				line = null
			},
			endTextBlock: () => {
				block = null
			},
			onVector: (bbox, flags: unknown) => {
				found.push({
					bbox: rect(bbox),
					rectangle: typeof flags === "object" && flags !== null && Reflect.get(flags, "isRectangle") === true
				})
			}
		})
	} finally {
		stext.destroy()
		list.destroy()
	}

	return { blocks, fonts, vectors: found }
}

function pushBlock(blocks: StextBlock[], bbox: Mupdf.Rect): StextBlock {
	const block: StextBlock = { bbox: rect(bbox), lines: [] }

	blocks.push(block)

	return block
}

function rect(r: Mupdf.Rect): PdfRect {
	return [r[0], r[1], r[2], r[3]]
}

// MuPDF hands stext colours as sRGB components 0-1 (one for gray, four for CMYK as stored).
function rgb(color: Mupdf.Color): number {
	const channel = (value: number | undefined): number => Math.max(0, Math.min(255, Math.round((value ?? 0) * 255)))

	if (color.length === 1) {
		const gray = channel(color[0])

		return (gray << 16) | (gray << 8) | gray
	}

	if (color.length === 4) {
		const k = color[3] ?? 0
		const [r, g, b] = [0, 1, 2].map(index => channel((1 - (color[index] ?? 0)) * (1 - k)))

		return ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0)
	}

	return (channel(color[0]) << 16) | (channel(color[1]) << 8) | channel(color[2])
}

// Identity of a glyph across two readings of the same page: its character and pen position (to 1/100 pt).
export function charKey(char: { readonly c: string; readonly x: number; readonly y: number }): string {
	return `${char.c}@${String(Math.round(char.x * 100))},${String(Math.round(char.y * 100))}`
}

export function allChars(page: StextPage): StextChar[] {
	const chars: StextChar[] = []

	for (const block of page.blocks) for (const line of block.lines) for (const char of line.chars) chars.push(char)

	return chars
}

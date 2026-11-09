import type { PageDisplayList } from "../../../core/docx/layout/index"
import {
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FragmentFloat,
	FragmentInt,
	FragmentKind,
	LINE_FLOATS,
	LINE_INTS,
	LineFloat,
	LineInt
} from "../../../core/text/index"

// A page's thumbnail (Word's navigation pane, Pages), painted on a canvas from the page's display list: each run
// of text a bar along its line, objects and shading as boxes. No text, fonts or media are drawn, so a page costs
// one pass over its lines, in the colour the caller gives (the canvas's own, so it follows the theme).

const GRAPHIC_FLOATS = 4
const GRAPHIC_INTS = 3
const GRAPHIC_SHADING = 1
const OBJECT_FLOATS = 4
// Of a line's height, where a text bar starts and how much of it it covers (an x-height's band).
const BAR_TOP = 0.35
const BAR_HEIGHT = 0.4
const TEXT_ALPHA = 0.55
const BOX_ALPHA = 0.15

// What is painted on: a canvas element (or an offscreen one), as far as the painter uses it.
export interface ThumbnailContext {
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
	clearRect(x: number, y: number, width: number, height: number): void
	fillRect(x: number, y: number, width: number, height: number): void
	fillStyle: unknown
	globalAlpha: number
}

export interface ThumbnailCanvas {
	width: number
	height: number
	getContext(id: "2d"): ThumbnailContext | null
}

// Paints `page` in `color` scaled to `width` CSS px wide on `canvas` (sized here, for `dpr` device pixels per px).
export function paintThumbnail(canvas: ThumbnailCanvas, page: PageDisplayList, width: number, dpr: number, color: string): void {
	const scale = width / page.width
	const height = Math.round(page.height * scale)
	const pixelWidth = Math.max(1, Math.round(width * dpr))
	const pixelHeight = Math.max(1, Math.round(height * dpr))

	if (canvas.width !== pixelWidth) canvas.width = pixelWidth
	if (canvas.height !== pixelHeight) canvas.height = pixelHeight

	const context = canvas.getContext("2d")

	if (context === null) return

	context.setTransform(1, 0, 0, 1, 0, 0)
	context.clearRect(0, 0, pixelWidth, pixelHeight)
	context.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0)
	context.fillStyle = color
	context.globalAlpha = BOX_ALPHA

	for (let graphic = 0; graphic < page.graphicCount; graphic++) {
		if (page.graphicInts[graphic * GRAPHIC_INTS] !== GRAPHIC_SHADING) continue

		const f = graphic * GRAPHIC_FLOATS

		context.fillRect(
			page.graphicFloats[f] ?? 0,
			page.graphicFloats[f + 1] ?? 0,
			page.graphicFloats[f + 2] ?? 0,
			page.graphicFloats[f + 3] ?? 0
		)
	}

	for (let object = 0; object < page.objectCount; object++) {
		const f = object * OBJECT_FLOATS

		context.fillRect(
			page.objectFloats[f] ?? 0,
			page.objectFloats[f + 1] ?? 0,
			page.objectFloats[f + 2] ?? 0,
			page.objectFloats[f + 3] ?? 0
		)
	}

	const text = page.text

	context.globalAlpha = TEXT_ALPHA

	for (let line = 0; line < text.lineCount; line++) {
		const lf = line * LINE_FLOATS
		const li = line * LINE_INTS
		const lineHeight = text.lineFloats[lf + LineFloat.HEIGHT] ?? 0
		const top = (text.lineFloats[lf + LineFloat.TOP] ?? 0) + lineHeight * BAR_TOP
		const barHeight = Math.max(1 / scale, lineHeight * BAR_HEIGHT)
		const first = text.lineInts[li + LineInt.FIRST_FRAGMENT] ?? 0
		const count = text.lineInts[li + LineInt.FRAGMENT_COUNT] ?? 0

		for (let fragment = first; fragment < first + count; fragment++) {
			const ff = fragment * FRAGMENT_FLOATS
			const fi = fragment * FRAGMENT_INTS

			if (((text.fragmentInts[fi + FragmentInt.INFO] ?? 0) & FRAGMENT_KIND_MASK) !== FragmentKind.TEXT) continue
			if ((text.fragmentInts[fi + FragmentInt.TEXT_END] ?? 0) <= (text.fragmentInts[fi + FragmentInt.TEXT_START] ?? 0)) continue

			context.fillRect(
				text.fragmentFloats[ff + FragmentFloat.X] ?? 0,
				top,
				text.fragmentFloats[ff + FragmentFloat.WIDTH] ?? 0,
				barHeight
			)
		}
	}

	context.globalAlpha = 1
}

// The height of a thumbnail `width` px wide of a page `pageWidth` by `pageHeight`.
export function thumbnailHeight(pageWidth: number, pageHeight: number, width: number): number {
	return Math.round((pageHeight * width) / pageWidth)
}

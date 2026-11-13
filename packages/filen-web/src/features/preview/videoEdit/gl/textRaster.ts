import type { TextOverlay } from "@/features/preview/videoEdit/types"
import {
	layoutText,
	pillColor,
	textFont,
	textRasterKey,
	type Segmenters,
	type TextLayout
} from "@/features/preview/videoEdit/gl/textRaster.logic"

// Rasterises a text box once, with a 2D OffscreenCanvas: the platform's text shaping (complex scripts, bidi through
// the canvas `direction`, colour emoji from the system faces), wrapped to the output frame, sized relative to the
// output height. The frame pass uploads the bitmap to a texture and composites it on every frame it shows; only a
// change of the key (content, look or output size) rasterises it again.

export interface TextRaster {
	key: string
	bitmap: ImageBitmap
	// Output pixels.
	width: number
	height: number
}

// One canvas for every raster in this thread, sized per box; transferToImageBitmap hands its pixels off.
let canvas: OffscreenCanvas | null = null
let segmenters: Segmenters | null = null

function context(): OffscreenCanvasRenderingContext2D {
	canvas ??= new OffscreenCanvas(1, 1)

	const ctx = canvas.getContext("2d")

	if (ctx === null) {
		throw new Error("no 2D context")
	}

	return ctx
}

function textSegmenters(): Segmenters {
	if (segmenters !== null) {
		return segmenters
	}

	const words = new Intl.Segmenter(undefined, { granularity: "word" })
	const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

	segmenters = {
		words: text => Array.from(words.segment(text), part => part.segment),
		graphemes: text => Array.from(graphemes.segment(text), part => part.segment)
	}

	return segmenters
}

function draw(ctx: OffscreenCanvasRenderingContext2D, overlay: Pick<TextOverlay, "color" | "background">, layout: TextLayout): void {
	ctx.clearRect(0, 0, layout.width, layout.height)

	if (overlay.background) {
		ctx.fillStyle = pillColor(overlay.color)
		ctx.beginPath()
		// A stadium for one line; rounded corners of half a line for more.
		ctx.roundRect(0, 0, layout.width, layout.height, Math.min(layout.height / 2, layout.lineHeight / 2))
		ctx.fill()
	}

	ctx.font = textFont(layout.fontPx)
	ctx.direction = layout.direction
	ctx.textAlign = "center"
	ctx.textBaseline = "middle"
	ctx.fillStyle = overlay.color

	for (const [index, line] of layout.lines.entries()) {
		ctx.fillText(line, layout.width / 2, layout.padY + layout.lineHeight * (index + 0.5))
	}
}

// The box rasterised for an output of `out`; null when it has nothing to show.
export function rasterizeText(
	overlay: Pick<TextOverlay, "text" | "size" | "color" | "background">,
	out: { width: number; height: number }
): TextRaster | null {
	if (overlay.text.trim() === "") {
		return null
	}

	const ctx = context()
	let font = ""
	const layout = layoutText(
		overlay,
		out,
		(text, fontPx) => {
			const wanted = textFont(fontPx)

			if (font !== wanted) {
				ctx.font = wanted
				font = wanted
			}

			return ctx.measureText(text).width
		},
		textSegmenters()
	)
	const target = ctx.canvas

	// Resizing resets the context's state; draw() sets all of it again.
	target.width = layout.width
	target.height = layout.height
	draw(ctx, overlay, layout)

	return { key: textRasterKey(overlay, out), bitmap: target.transferToImageBitmap(), width: layout.width, height: layout.height }
}

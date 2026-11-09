import interCyrillicExt from "@fontsource-variable/inter/files/inter-cyrillic-ext-wght-normal.woff2?url"
import interCyrillic from "@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2?url"
import interGreekExt from "@fontsource-variable/inter/files/inter-greek-ext-wght-normal.woff2?url"
import interGreek from "@fontsource-variable/inter/files/inter-greek-wght-normal.woff2?url"
import interVietnamese from "@fontsource-variable/inter/files/inter-vietnamese-wght-normal.woff2?url"
import interLatinExt from "@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url"
import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url"
import type { MarkupItem } from "@/features/preview/imageEdit/types"
import { transformPoint, type Matrix3 } from "@/features/preview/imageEdit/lib/recipe"
import { composeMatrix3, matrixScale } from "@/features/preview/imageEdit/worker/tiles"

// Markup rasterised on a 2D canvas for the GPU passes to composite. Strokes and arrows are drawn in SOURCE pixel
// space through the full source→canvas map (turns, flips, straighten and zoom included), so widths scale with
// the picture and no point is mapped in JS; text is drawn upright, at its anchor's mapped position.

// The app's own face, so exported text matches the editor's. These are the very files index.css's
// @fontsource-variable/inter import emits (same content hash, so the page's cached copy answers), with that
// package's unicode-range per subset: a face is fetched only once text needs one of its characters.
const INTER_FAMILY = "Inter Variable"
const INTER_FACES: readonly (readonly [string, string])[] = [
	[interCyrillicExt, "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F"],
	[interCyrillic, "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116"],
	[interGreekExt, "U+1F00-1FFF"],
	[interGreek, "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF"],
	[
		interVietnamese,
		"U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB"
	],
	[
		interLatinExt,
		"U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"
	],
	[
		interLatin,
		"U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
	]
]

export const TEXT_WEIGHT = 600
export const TEXT_LINE_HEIGHT = 1.2

// Workers expose a FontFaceSet as `self.fonts` (CSS Font Loading §2.4); an engine without it draws text in its
// default sans-serif.
const scope: { fonts?: FontFaceSet } = globalThis
let facesAdded = false

function workerFonts(): FontFaceSet | null {
	const fonts = scope.fonts ?? null

	if (fonts !== null && !facesAdded) {
		facesAdded = true

		for (const [url, unicodeRange] of INTER_FACES) {
			fonts.add(new FontFace(INTER_FAMILY, `url(${url}) format("woff2")`, { weight: "100 900", unicodeRange }))
		}
	}

	return fonts
}

function fontSpec(px: number): string {
	return `${String(TEXT_WEIGHT)} ${String(px)}px "${INTER_FAMILY}", sans-serif`
}

function textItems(items: readonly MarkupItem[]): string {
	let text = ""

	for (const item of items) {
		if (item.kind === "text") {
			text += item.text
		}
	}

	return text
}

// Whether every face the markup's text needs is loaded; when not, starts the loads and calls `onLoaded` once
// they land, so the preview redraws with the real glyphs.
export function markupFontsReady(items: readonly MarkupItem[], onLoaded: () => void): boolean {
	const text = textItems(items)
	const fonts = text.length === 0 ? null : workerFonts()

	if (fonts === null || fonts.check(fontSpec(16), text)) {
		return true
	}

	void fonts.load(fontSpec(16), text).then(onLoaded, () => undefined)

	return false
}

// Resolves once the markup's text faces are loaded (or failed to load: text then falls back).
export async function loadMarkupFonts(items: readonly MarkupItem[]): Promise<void> {
	const text = textItems(items)
	const fonts = text.length === 0 ? null : workerFonts()

	if (fonts !== null) {
		await fonts.load(fontSpec(16), text).catch(() => undefined)
	}
}

export function hasLayer(items: readonly MarkupItem[], layer: "ink" | "highlight"): boolean {
	return items.some(item => (item.kind === "highlighter") === (layer === "highlight"))
}

function setTransform(ctx: OffscreenCanvasRenderingContext2D, m: Matrix3): void {
	ctx.setTransform(m[0], m[1], m[3], m[4], m[6], m[7])
}

function strokePath(ctx: OffscreenCanvasRenderingContext2D, points: readonly number[]): void {
	ctx.beginPath()

	const x0 = points[0]
	const y0 = points[1]

	if (x0 === undefined || y0 === undefined) {
		return
	}

	ctx.moveTo(x0, y0)

	if (points.length < 4) {
		// A tap: a dot of the stroke's width.
		ctx.lineTo(x0 + 0.01, y0)
	}

	for (let i = 2; i + 1 < points.length; i += 2) {
		ctx.lineTo(points[i] ?? x0, points[i + 1] ?? y0)
	}

	ctx.stroke()
}

function drawArrow(ctx: OffscreenCanvasRenderingContext2D, item: Extract<MarkupItem, { kind: "arrow" }>): void {
	const [x0, y0] = item.from
	const [x1, y1] = item.to
	const length = Math.hypot(x1 - x0, y1 - y0)

	if (length === 0) {
		return
	}

	const ux = (x1 - x0) / length
	const uy = (y1 - y0) / length
	// Head length and half-width in the stroke's widths, the shaft stopping where the head begins.
	const head = Math.min(length, item.width * 4)
	const half = item.width * 2.5
	const bx = x1 - ux * head
	const by = y1 - uy * head

	ctx.beginPath()
	ctx.moveTo(x0, y0)
	ctx.lineTo(bx, by)
	ctx.stroke()

	ctx.beginPath()
	ctx.moveTo(x1, y1)
	ctx.lineTo(bx - uy * half, by + ux * half)
	ctx.lineTo(bx + uy * half, by - ux * half)
	ctx.closePath()
	ctx.fill()
}

// Draws one layer of `items` onto `ctx` (cleared first): "highlight" takes the highlighter strokes, "ink"
// everything else, in order. `sourceToOutput` maps upright source pixels to output pixels; `outputToCanvas`
// places output pixels on this canvas (a tile's offset, or the preview's fit).
export function rasterizeMarkup(
	ctx: OffscreenCanvasRenderingContext2D,
	items: readonly MarkupItem[],
	layer: "ink" | "highlight",
	sourceToOutput: Matrix3,
	outputToCanvas: Matrix3
): void {
	const toCanvas = composeMatrix3(outputToCanvas, sourceToOutput)
	// The output is a similarity of the source (turns, flips, one zoom): its lengths scale by this.
	const zoom = matrixScale(sourceToOutput)

	ctx.setTransform(1, 0, 0, 1, 0, 0)
	ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
	ctx.lineCap = "round"
	ctx.lineJoin = "round"

	for (const item of items) {
		if ((item.kind === "highlighter") !== (layer === "highlight")) {
			continue
		}

		ctx.strokeStyle = item.color
		ctx.fillStyle = item.color

		if (item.kind === "text") {
			const [x, y] = transformPoint(sourceToOutput, item.at[0], item.at[1])
			const px = item.size * zoom

			setTransform(ctx, outputToCanvas)
			ctx.font = fontSpec(px)
			ctx.textAlign = "left"
			ctx.textBaseline = "top"

			const lines = item.text.split("\n")

			for (let i = 0; i < lines.length; i++) {
				ctx.fillText(lines[i] ?? "", x, y + i * px * TEXT_LINE_HEIGHT)
			}

			continue
		}

		setTransform(ctx, toCanvas)
		ctx.lineWidth = item.width

		if (item.kind === "arrow") {
			drawArrow(ctx, item)
		} else {
			strokePath(ctx, item.points)
		}
	}

	ctx.setTransform(1, 0, 0, 1, 0, 0)
}

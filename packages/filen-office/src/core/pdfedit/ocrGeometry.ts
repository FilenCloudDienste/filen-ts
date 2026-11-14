// Text recognition's page rules and geometry, engine-free. Matrices are PDF/MuPDF row-vector affine transforms
// [a, b, c, d, e, f]: a point (x, y) maps to (a x + c y + e, b x + d y + f), and concat(m, n) applies m, then n.
//
// Spaces, in the order a recognised word travels back:
//   overlay: the one-page text-only PDF the recogniser writes for an image (points, y up, origin bottom left;
//            its page is the image's size at the recognition resolution);
//   image:   pixels of the image the recogniser read (y down), possibly the rendered page turned by quarter turns;
//   pixel:   pixels of the page as rendered (y down, origin at the pixmap's top left);
//   page:    the page's default user space (what its content stream draws in, before /Rotate, /UserUnit and the
//            CropBox offset are applied).
// The overlay → page matrix is what grafting the overlay onto the page takes.

import { concatMatrix, IDENTITY_MATRIX, invertMatrix, type PdfMatrix } from "./matrix"

export type QuarterTurns = 0 | 1 | 2 | 3

function invertible(m: PdfMatrix): PdfMatrix {
	const inverse = invertMatrix(m)

	if (inverse === null) throw new RangeError("the matrix is not invertible")

	return inverse
}

// Clockwise quarter turns of an image `width` × `height` pixels: its pixel space → the turned image's.
export function quarterTurnMatrix(turns: QuarterTurns, width: number, height: number): PdfMatrix {
	switch (turns) {
		case 0:
			return IDENTITY_MATRIX
		case 1:
			return [0, 1, -1, 0, height, 0]
		case 2:
			return [-1, 0, 0, -1, width, height]
		case 3:
			return [0, -1, 1, 0, 0, width]
	}
}

export function turnedSize(turns: QuarterTurns, width: number, height: number): readonly [number, number] {
	return turns % 2 === 0 ? [width, height] : [height, width]
}

// The recogniser's overlay page for an image of `width` × `height` pixels read at `dpi`: points, y up.
export function overlayToImage(height: number, dpi: number): PdfMatrix {
	const scale = dpi / 72

	return [scale, 0, 0, -scale, 0, height]
}

// The graft's matrix: overlay → page, for an overlay recognised on the rendered page (`width` × `height` pixels at
// `dpi`, `pixelToPage` from the render) turned clockwise by `turns` first.
export function ocrOverlayMatrix(pixelToPage: PdfMatrix, width: number, height: number, dpi: number, turns: QuarterTurns): PdfMatrix {
	const [, turnedHeight] = turnedSize(turns, width, height)
	const imageToPixel = invertible(quarterTurnMatrix(turns, width, height))

	return concatMatrix(concatMatrix(overlayToImage(turnedHeight, dpi), imageToPixel), pixelToPage)
}

// A render's pixel space → page space: `pageTransform` is the page's user space → its view space (MuPDF's page
// transform: CropBox origin at the top left, /Rotate and /UserUnit applied), `renderMatrix` the view space → device
// pixels the render used, `origin` the pixmap's top left in device pixels.
export function pixelToPageMatrix(pageTransform: PdfMatrix, renderMatrix: PdfMatrix, origin: readonly [number, number]): PdfMatrix {
	const pageToPixel = concatMatrix(concatMatrix(pageTransform, renderMatrix), [1, 0, 0, 1, -origin[0], -origin[1]])

	return invertible(pageToPixel)
}

// The view space → device pixels matrix of a render at `dpi`, turned clockwise by `turns` (rotation about the
// origin; the pixmap's origin absorbs the offset).
export function ocrRenderMatrix(dpi: number, turns: QuarterTurns): PdfMatrix {
	const scale = dpi / 72
	const quarter: Readonly<Record<QuarterTurns, PdfMatrix>> = {
		0: [scale, 0, 0, scale, 0, 0],
		1: [0, scale, -scale, 0, 0, 0],
		2: [-scale, 0, 0, -scale, 0, 0],
		3: [0, -scale, scale, 0, 0, 0]
	}

	return quarter[turns]
}

// What text recognition needs to know about a page (dom/pdfedit/ocr/page.ts reads it), in view space units.
export interface OcrPageSummary {
	readonly width: number
	readonly height: number
	// Characters the page already draws, visible or not (an earlier recognition layer is invisible text).
	readonly chars: number
	readonly images: readonly OcrImageUse[]
}

export interface OcrImageUse {
	// The part of the page it covers.
	readonly area: number
	// Pixels per inch along its own width as drawn.
	readonly dpi: number
	// Clockwise quarter turns that make it upright in view space.
	readonly upright: QuarterTurns
}

// A page drawing at most this many characters counts as having none (a stamped page number, a scanner's footer).
export const OCR_NEAR_NO_CHARS = 20
// The share of the page one image must cover for the page to be a scan.
export const OCR_IMAGE_SHARE = 0.5
export const OCR_DEFAULT_DPI = 300
export const OCR_MAX_DPI = 400
// Below this the glyphs are too small to recognise; a smaller scan is rendered larger (interpolated).
export const OCR_MIN_DPI = 150
// Pages rendered between store flushes.
export const OCR_BATCH_PAGES = 4
// A page whose recognised words average below this confidence is tried on its side and upside down.
export const OCR_ORIENTATION_CONFIDENCE = 50
// The orientation retries' resolution.
export const OCR_STRIP_DPI = 150

function largestImage(summary: OcrPageSummary): OcrImageUse | undefined {
	let best: OcrImageUse | undefined

	for (const image of summary.images) if (best === undefined || image.area > best.area) best = image

	return best
}

// A scanned page: (near) no characters and one image covering at least half of it.
export function isOcrCandidate(summary: OcrPageSummary): boolean {
	const area = summary.width * summary.height
	const image = largestImage(summary)

	return summary.chars <= OCR_NEAR_NO_CHARS && area > 0 && image !== undefined && image.area >= OCR_IMAGE_SHARE * area
}

// The render resolution: the largest image's own (no detail exists above it), within [OCR_MIN_DPI, OCR_MAX_DPI];
// OCR_DEFAULT_DPI without an image.
export function ocrRenderDpi(summary: OcrPageSummary): number {
	const image = largestImage(summary)

	if (image === undefined || !(image.dpi > 0)) return OCR_DEFAULT_DPI

	return Math.round(Math.min(OCR_MAX_DPI, Math.max(OCR_MIN_DPI, image.dpi)))
}

// Quarter turns that render the page with its largest image upright (a scan placed on its side).
export function ocrUprightTurns(summary: OcrPageSummary): QuarterTurns {
	return largestImage(summary)?.upright ?? 0
}

// How an image's drawing matrix (unit square → view space) turns it: the quarter turns that make it upright, or 0
// for a sheared or mirrored drawing.
export function imageUprightTurns(ctm: PdfMatrix): QuarterTurns {
	const det = ctm[0] * ctm[3] - ctm[1] * ctm[2]

	if (det <= 0) return 0

	const angle = Math.atan2(ctm[1], ctm[0])
	const turns = Math.round(angle / (Math.PI / 2))

	if (Math.abs(angle - (turns * Math.PI) / 2) > Math.PI / 36) return 0

	// Drawn turned `turns` clockwise (view space is y down): undo it.
	return ((((4 - turns) % 4) + 4) % 4) as QuarterTurns
}

// Tesseract's text-only page writes each word as `<stretch> Tz [ <UTF-16BE> ] TJ` in a font whose glyphs all have one
// width, stretched so the word's glyphs, its trailing space included, fill the word's box: a selection of the word
// then misses a glyph's width of it. Stretched by n / (n - 1) instead, the n - 1 letters fill the box and the space
// falls in the gap after it, so selections cover the scanned words.
const OCR_WORD = /(\d+(?:\.\d+)?) Tz \[ <((?:[0-9A-Fa-f]{4})+)> \] TJ/g

export function fitOcrWords(content: string): string {
	return content.replace(OCR_WORD, (word: string, stretch: string, hex: string) => {
		const glyphs = hex.length / 4

		if (glyphs < 2 || hex.slice(-4) !== "0020") return word

		return `${String(Math.round(((Number(stretch) * glyphs) / (glyphs - 1)) * 1000) / 1000)} Tz [ <${hex}> ] TJ`
	})
}

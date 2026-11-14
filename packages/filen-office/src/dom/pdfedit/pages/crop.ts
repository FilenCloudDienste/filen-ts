import type * as Mupdf from "mupdf"
import type { PDFDocument } from "mupdf"
import { cropRectFromMargins, outsideRects, paddedContent, type CropMargins, type CropRect } from "../../../core/pdfedit/crop"
import { selectionPages } from "../../../core/pdfedit/pageOrder"
import type { MupdfModule } from "../protocol"

// Cropping writes /CropBox (setPageBox); the content outside stays in the file. Rects are in the page's view space
// (core/pdfedit/crop.ts): MuPDF's page bounds, rotation applied, y down, the current crop box at 0,0.

export interface CropResult {
	// Pages whose crop box changed (0-based).
	readonly touched: readonly number[]
}

// The visible box of a page in view space.
export function pageBounds(doc: PDFDocument, page: number): CropRect {
	const [x0, y0, x1, y1] = doc.loadPage(page).getBounds()

	return [x0, y0, x1, y1]
}

// Crops pages by `margins` (points off each side of each page's visible box, as the page shows). Pages the margins
// would leave smaller than MIN_CROP_SIDE are left as they are.
export function cropPages(doc: PDFDocument, pages: Iterable<number>, margins: CropMargins): CropResult {
	const touched: number[] = []

	for (const index of selectionPages(doc.countPages(), pages)) {
		const page = doc.loadPage(index)
		const [x0, y0, x1, y1] = page.getBounds()
		const rect = cropRectFromMargins([x0, y0, x1, y1], margins)

		if (rect === null) continue

		page.setPageBox("CropBox", [rect[0], rect[1], rect[2], rect[3]])
		touched.push(index)
	}

	return { touched }
}

// Crops each page to its content's bounds (contentBounds) grown by `padding` points: "Remove white margins". Blank
// pages keep their box.
export function cropPagesToContent(mupdf: MupdfModule, doc: PDFDocument, pages: Iterable<number>, padding = 0): CropResult {
	const touched: number[] = []

	for (const index of selectionPages(doc.countPages(), pages)) {
		const page = doc.loadPage(index)
		const [x0, y0, x1, y1] = page.getBounds()
		const bounds: CropRect = [x0, y0, x1, y1]
		const rect = paddedContent(bounds, contentBounds(mupdf, page), padding)

		if (rect === null || rect.every((value, at) => Math.abs(value - (bounds[at] ?? 0)) < 0.01)) continue

		page.setPageBox("CropBox", [rect[0], rect[1], rect[2], rect[3]])
		touched.push(index)
	}

	return { touched }
}

// Paints that leave the page white: no ink in a margin search.
function isWhite(colorspace: Mupdf.ColorSpace, color: readonly number[]): boolean {
	const n = colorspace.getNumberOfComponents()

	if (colorspace.isCMYK() || n === 4) return color.every(value => value <= 0.01)

	return color.length > 0 && color.every(value => value >= 0.99)
}

function intersect(a: CropRect, b: CropRect): CropRect | null {
	const x0 = Math.max(a[0], b[0])
	const y0 = Math.max(a[1], b[1])
	const x1 = Math.min(a[2], b[2])
	const y1 = Math.min(a[3], b[3])

	return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null
}

// The bounds of a path's points (curve control points included: a little generous, never short) through `ctm`; null
// for an empty path.
function pathBounds(path: Mupdf.Path, ctm: Mupdf.Matrix): CropRect | null {
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity
	const point = (x: number, y: number): void => {
		const px = ctm[0] * x + ctm[2] * y + ctm[4]
		const py = ctm[1] * x + ctm[3] * y + ctm[5]

		x0 = Math.min(x0, px)
		y0 = Math.min(y0, py)
		x1 = Math.max(x1, px)
		y1 = Math.max(y1, py)
	}

	path.walk({
		moveTo: point,
		lineTo: point,
		curveTo: (ax, ay, bx, by, cx, cy) => {
			point(ax, ay)
			point(bx, by)
			point(cx, cy)
		}
	})

	return x1 >= x0 && y1 >= y0 ? [x0, y0, x1, y1] : null
}

function transformUnit(ctm: Mupdf.Matrix): CropRect {
	const points = [
		[ctm[4], ctm[5]],
		[ctm[0] + ctm[4], ctm[1] + ctm[5]],
		[ctm[2] + ctm[4], ctm[3] + ctm[5]],
		[ctm[0] + ctm[2] + ctm[4], ctm[1] + ctm[3] + ctm[5]]
	]
	const xs = points.map(point => point[0] ?? 0)
	const ys = points.map(point => point[1] ?? 0)

	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

// The bounds of what a page draws (text, images, non-white vector paint, shadings, annotations' appearances), clipped
// by the clips in force and by the page's visible box; null for a page that draws nothing. One run of the page
// through a bounding device: no rasterising.
export function contentBounds(mupdf: MupdfModule, page: Mupdf.Page): CropRect | null {
	const [px0, py0, px1, py1] = page.getBounds()
	const pageBox: CropRect = [px0, py0, px1, py1]
	const clips: (CropRect | null)[] = []
	let content: CropRect | null = null
	// Inside a soft mask's drawing nothing shows.
	let masking = 0
	const clipNow = (): CropRect | null => {
		const top = clips.at(-1)

		return top === undefined ? pageBox : top
	}
	const add = (rect: CropRect): void => {
		if (masking > 0) return

		const clip = clipNow()
		const visible = clip === null ? null : intersect(rect, clip)

		if (visible === null) return

		content =
			content === null
				? visible
				: [
						Math.min(content[0], visible[0]),
						Math.min(content[1], visible[1]),
						Math.max(content[2], visible[2]),
						Math.max(content[3], visible[3])
					]
	}
	const pushClip = (rect: CropRect | null): void => {
		const clip = clipNow()

		clips.push(clip === null || rect === null ? null : intersect(clip, rect))
	}
	const rectOf = (bounds: Mupdf.Rect): CropRect => [bounds[0], bounds[1], bounds[2], bounds[3]]
	// Text is bounded as a zero-width stroke (MuPDF pads that by half a point); paths by their points.
	const hairline = new mupdf.StrokeState({ lineCap: "Butt", lineJoin: "Miter", lineWidth: 0, miterLimit: 10 })
	const device = new mupdf.Device({
		fillPath: (path, _evenOdd, ctm, colorspace, color) => {
			const bounds = isWhite(colorspace, color) ? null : pathBounds(path, ctm)

			if (bounds !== null) add(bounds)
		},
		strokePath: (path, stroke, ctm, colorspace, color) => {
			if (!isWhite(colorspace, color)) add(rectOf(path.getBounds(stroke, ctm)))
		},
		fillText: (text, ctm, colorspace, color) => {
			if (!isWhite(colorspace, color)) add(rectOf(text.getBounds(hairline, ctm)))
		},
		strokeText: (text, stroke, ctm, colorspace, color) => {
			if (!isWhite(colorspace, color)) add(rectOf(text.getBounds(stroke, ctm)))
		},
		fillShade: shadeAdd,
		fillImage: (_image, ctm) => {
			add(transformUnit(ctm))
		},
		fillImageMask: (_image, ctm, colorspace, color) => {
			if (!isWhite(colorspace, color)) add(transformUnit(ctm))
		},
		clipPath: (path, _evenOdd, ctm) => {
			pushClip(pathBounds(path, ctm))
		},
		clipStrokePath: (path, stroke, ctm) => {
			pushClip(rectOf(path.getBounds(stroke, ctm)))
		},
		clipText: (text, ctm) => {
			pushClip(rectOf(text.getBounds(hairline, ctm)))
		},
		clipStrokeText: (text, stroke, ctm) => {
			pushClip(rectOf(text.getBounds(stroke, ctm)))
		},
		clipImageMask: (_image, ctm) => {
			pushClip(transformUnit(ctm))
		},
		popClip: () => {
			clips.pop()
		},
		beginMask: () => {
			masking++
		},
		endMask: () => {
			masking = Math.max(0, masking - 1)
		}
	})

	function shadeAdd(): void {
		// A shading fills its clip.
		const clip = clipNow()

		if (clip !== null) add(clip)
	}

	try {
		page.run(device, mupdf.Matrix.identity)
		device.close()
	} finally {
		device.destroy()
		hairline.destroy()
	}

	return content
}

// The regions of each page outside a crop, in view space before cropping, for "Remove content outside the crop": the
// whole media box (which a crop box may already hide part of) minus the new crop. The redaction tool marks and applies
// them; cropping itself removes nothing.
export function outsideCropRects(doc: PDFDocument, pages: Iterable<number>, margins: CropMargins): Map<number, CropRect[]> {
	const out = new Map<number, CropRect[]>()

	for (const index of selectionPages(doc.countPages(), pages)) {
		const page = doc.loadPage(index)
		const [x0, y0, x1, y1] = page.getBounds()
		const [mx0, my0, mx1, my1] = page.getBounds("MediaBox")
		const rect = cropRectFromMargins([x0, y0, x1, y1], margins)

		if (rect !== null) out.set(index, outsideRects([mx0, my0, mx1, my1], rect))
	}

	return out
}
